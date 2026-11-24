// J.A.R.V.I.S. — lokale server
// Serveert de interface en praat met Claude als "brein".
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { MODEL, streamReply, errorMessage } from "./public/brain.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// .env inlezen (Node 20.12+ heeft dit ingebouwd)
if (fs.existsSync(path.join(__dirname, ".env"))) {
  process.loadEnvFile(path.join(__dirname, ".env"));
}

const PORT = Number(process.env.PORT) || 3000;
const USER_NAME = process.env.JARVIS_USER_NAME || "meneer";
const hasKey = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
const client = hasKey ? new Anthropic() : null;

// ---------------------------------------------------------------------------
// Inloggen met wachtwoord (actief zodra JARVIS_PASSWORD is ingesteld)
// ---------------------------------------------------------------------------
const PASSWORD = process.env.JARVIS_PASSWORD || "";
const SESSION_DAYS = Number(process.env.JARVIS_SESSION_DAYS) || 30;
// Sessiesleutel afgeleid van het wachtwoord: blijft geldig na een herstart,
// en wie het wachtwoord wijzigt logt automatisch iedereen uit.
const SESSION_SECRET = crypto
  .createHmac("sha256", process.env.SESSION_SECRET || "jarvis-session-v1")
  .update(PASSWORD)
  .digest();
const COOKIE = "jarvis_session";
const LOGIN_PAGE = fs.readFileSync(path.join(__dirname, "login.html"), "utf8");
const failures = new Map(); // ip -> { count, until }

function sign(value) {
  return crypto.createHmac("sha256", SESSION_SECRET).update(value).digest("base64url");
}
function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}
function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function isLoggedIn(req) {
  if (!PASSWORD) return true;
  const token = parseCookies(req)[COOKIE];
  if (!token) return false;
  const [exp, sig] = token.split(".");
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  return safeEqual(sig, sign(exp));
}
function clientIp(req) {
  return (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "?";
}
function isHttps(req) {
  return req.headers["x-forwarded-proto"] === "https" || req.socket.encrypted;
}
function sendLogin(res, message = "", status = 200) {
  const html = LOGIN_PAGE.replace("{{MESSAGE}}", message ? `<p class="err">${message}</p>` : "");
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  res.end(html);
}

async function handleLogin(req, res) {
  const ip = clientIp(req);
  const f = failures.get(ip);
  if (f && f.until > Date.now()) {
    const min = Math.ceil((f.until - Date.now()) / 60000);
    return sendLogin(res, `Te veel pogingen. Probeer het over ${min} minuten opnieuw.`, 429);
  }
  const body = new URLSearchParams(await readBody(req).catch(() => ""));
  if (PASSWORD && safeEqual(body.get("password") || "", PASSWORD)) {
    failures.delete(ip);
    const exp = String(Date.now() + SESSION_DAYS * 86400_000);
    const cookie = [
      `${COOKIE}=${exp}.${sign(exp)}`, "Path=/", "HttpOnly", "SameSite=Lax",
      `Max-Age=${SESSION_DAYS * 86400}`, isHttps(req) ? "Secure" : "",
    ].filter(Boolean).join("; ");
    res.writeHead(303, { "Set-Cookie": cookie, Location: "/" });
    return res.end();
  }
  const count = (f?.count || 0) + 1;
  failures.set(ip, { count, until: count >= 5 ? Date.now() + 15 * 60000 : 0 });
  await new Promise((r) => setTimeout(r, 800)); // raden vertragen
  sendLogin(res, "Toegang geweigerd. Onjuist wachtwoord.", 401);
}

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

  res.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-cache",
  });
  const send = (obj) => res.write(JSON.stringify(obj) + "\n");
  const controller = new AbortController();
  res.on("close", () => controller.abort());

  try {
    await streamReply(client, {
      history: body.history,
      userName: USER_NAME,
      timeZone: body.timeZone,
      location: body.location,
      signal: controller.signal,
      onText: (text) => send({ type: "text", text }),
      onStatus: (text) => send({ type: "status", text }),
    });
    send({ type: "done" });
  } catch (err) {
    if (controller.signal.aborted) return;
    console.error("Fout bij Claude-aanroep:", err?.status ?? "", err?.message ?? err);
    send({ type: "error", text: err?.message === "Lege vraag" ? "Ik heb geen vraag ontvangen." : errorMessage(err, USER_NAME) });
  } finally {
    res.end();
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x").pathname;
  if (url === "/healthz") return res.writeHead(200).end("ok");
  if (url === "/login") {
    if (req.method === "POST") return handleLogin(req, res);
    return isLoggedIn(req) || !PASSWORD ? res.writeHead(303, { Location: "/" }).end() : sendLogin(res);
  }
  if (url === "/logout") {
    res.writeHead(303, { "Set-Cookie": `${COOKIE}=; Path=/; Max-Age=0`, Location: "/login" });
    return res.end();
  }
  if (!isLoggedIn(req)) {
    if (url.startsWith("/api/")) return res.writeHead(401, { "Content-Type": "application/json" }).end('{"error":"login"}');
    return res.writeHead(303, { Location: "/login" }).end();
  }
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
  console.log(PASSWORD
    ? "  Inloggen: wachtwoord vereist"
    : "  Inloggen: UIT (zet JARVIS_PASSWORD om met wachtwoord te beveiligen)");
  console.log("  Open de link in Google Chrome of Microsoft Edge.\n");
});
