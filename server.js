// J.A.R.V.I.S. — lokale server
// Serveert de interface en praat met Claude als "brein".
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// .env inlezen (Node 20.12+ heeft dit ingebouwd)
if (fs.existsSync(path.join(__dirname, ".env"))) {
  process.loadEnvFile(path.join(__dirname, ".env"));
}

const PORT = Number(process.env.PORT) || 3000;
const USER_NAME = process.env.JARVIS_USER_NAME || "meneer";
const MODEL = "claude-opus-5-5";
const hasKey = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
const client = hasKey ? new Anthropic() : null;

const SYSTEM_PROMPT = `Je bent J.A.R.V.I.S., een geavanceerde, persoonlijke AI-butler. Je spreekt uitsluitend Nederlands.

Persoonlijkheid:
- Beleefd, kalm, licht formeel en droog-geestig, met een subtiel gevoel voor humor.
- Je spreekt de gebruiker aan met "${USER_NAME}".
- Loyaal, behulpzaam en efficiënt; je denkt een stap vooruit.

Belangrijk — je antwoorden worden HARDOP voorgelezen door een spraaksynthesizer:
- Houd antwoorden kort: meestal 1 tot 3 zinnen, tenzij er echt om uitleg wordt gevraagd.
- Gebruik GEEN markdown, opsommingstekens, emoji, tabellen, codeblokken of URL's.
- Schrijf getallen, tijden en eenheden zoals je ze uitspreekt als dat duidelijker is.
- Gebruik de webzoekfunctie voor actuele zaken (nieuws, weer, sport, koersen) en vat de uitkomst bondig samen zonder bronnen voor te lezen.`;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function serveStatic(req, res) {
  const urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
  const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  const publicDir = path.join(__dirname, "public");
  const file = path.normalize(path.join(publicDir, rel));
  if (!file.startsWith(publicDir)) {
    res.writeHead(403).end();
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" }).end("Niet gevonden");
      return;
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 1_000_000) reject(new Error("Te groot"));
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

// Alleen tekstberichten van de browser accepteren, afwisselend user/assistant.
function sanitizeHistory(history) {
  if (!Array.isArray(history)) return [];
  const out = [];
  for (const m of history.slice(-30)) {
    if (!m || (m.role !== "user" && m.role !== "assistant")) continue;
    if (typeof m.content !== "string" || !m.content.trim()) continue;
    if (out.length && out[out.length - 1].role === m.role) {
      out[out.length - 1].content += "\n" + m.content;
    } else {
      out.push({ role: m.role, content: m.content.slice(0, 8000) });
    }
  }
  while (out.length && out[0].role !== "user") out.shift();
  return out;
}

async function handleChat(req, res) {
  if (!client) {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Geen ANTHROPIC_API_KEY ingesteld." }));
    return;
  }
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    res.writeHead(400).end();
    return;
  }
  const messages = sanitizeHistory(body.history);
  if (!messages.length || messages[messages.length - 1].role !== "user") {
    res.writeHead(400).end();
    return;
  }

  // Context (tijd/locatie) als los systeembericht achteraan, zodat de vaste
  // systeemprompt cachebaar blijft.
  const now = new Date().toLocaleString("nl-NL", {
    timeZone: body.timeZone || "Europe/Amsterdam",
    dateStyle: "full",
    timeStyle: "short",
  });
  const contextNote = `Huidige datum en tijd bij de gebruiker: ${now}.` +
    (body.location ? ` Locatie van de gebruiker (bij benadering): ${body.location}.` : "");
  messages.push({ role: "system", content: contextNote });

  res.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-cache",
  });
  const send = (obj) => res.write(JSON.stringify(obj) + "\n");

  const controller = new AbortController();
  res.on("close", () => controller.abort());

  try {
    let convo = messages;
    for (let i = 0; i < 4; i++) {
      const stream = client.beta.messages.stream(
        {
          model: MODEL,
          max_tokens: 4000,
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          output_config: { effort: "low" },
          system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
          tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 3 }],
          messages: convo,
        },
        { signal: controller.signal },
      );

      for await (const event of stream) {
        if (event.type === "content_block_start" && event.content_block.type === "server_tool_use") {
          send({ type: "status", text: "Ik zoek het even op…" });
        } else if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          send({ type: "text", text: event.delta.text });
        }
      }
      const final = await stream.finalMessage();
      if (final.stop_reason === "pause_turn") {
        // Server-tool loop is gepauzeerd: hervatten met dezelfde context.
        convo = [...messages.filter((m) => m.role !== "system"), { role: "assistant", content: final.content }];
        continue;
      }
      if (final.stop_reason === "refusal") {
        send({ type: "text", text: "Mijn excuses, daar kan ik u helaas niet mee helpen." });
      }
      break;
    }
    send({ type: "done" });
  } catch (err) {
    if (controller.signal.aborted) return;
    console.error("Fout bij Claude-aanroep:", err?.status ?? "", err?.message ?? err);
    let msg = "Er ging iets mis met mijn verbinding, " + USER_NAME + ".";
    if (err instanceof Anthropic.AuthenticationError) msg = "Mijn API-sleutel lijkt ongeldig te zijn.";
    else if (err instanceof Anthropic.RateLimitError) msg = "Ik krijg even te veel verzoeken. Probeer het zo nog eens.";
    else if (err instanceof Anthropic.APIConnectionError) msg = "Ik kan de servers niet bereiken. Controleer de internetverbinding.";
    send({ type: "error", text: msg });
  } finally {
    res.end();
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/api/status") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ai: Boolean(client), userName: USER_NAME, model: MODEL }));
    return;
  }
  if (req.method === "POST" && req.url === "/api/chat") return handleChat(req, res);
  if (req.method === "GET") return serveStatic(req, res);
  res.writeHead(405).end();
});

server.listen(PORT, () => {
  console.log(`\n  J.A.R.V.I.S. is online → http://localhost:${PORT}`);
  console.log(hasKey
    ? "  AI-brein: actief"
    : "  AI-brein: UIT (zet ANTHROPIC_API_KEY in .env voor vrije gesprekken)");
  console.log("  Open de link in Google Chrome of Microsoft Edge.\n");
});
