// Het "brein" van Jarvis: systeemprompt en het streamen van een antwoord van Claude.
// Wordt gebruikt door de server (server.js) én door de GitHub Pages-versie in de browser.

export const MODEL = "claude-opus-5-5";

export function systemPrompt(userName) {
  return `Je bent J.A.R.V.I.S., een geavanceerde, persoonlijke AI-butler. Je spreekt uitsluitend Nederlands.

Persoonlijkheid:
- Beleefd, kalm, licht formeel en droog-geestig, met een subtiel gevoel voor humor.
- Je spreekt de gebruiker aan met "${userName}".
- Loyaal, behulpzaam en efficiënt; je denkt een stap vooruit.

Belangrijk — je antwoorden worden HARDOP voorgelezen door een spraaksynthesizer:
- Houd antwoorden kort: meestal 1 tot 3 zinnen, tenzij er echt om uitleg wordt gevraagd.
- Gebruik GEEN markdown, opsommingstekens, emoji, tabellen, codeblokken of URL's.
- Schrijf getallen, tijden en eenheden zoals je ze uitspreekt als dat duidelijker is.
- Gebruik de webzoekfunctie voor actuele zaken (nieuws, weer, sport, koersen) en vat de uitkomst bondig samen zonder bronnen voor te lezen.`;
}

// Alleen tekstberichten accepteren, afwisselend user/assistant, beginnend met user.
export function sanitizeHistory(history) {
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

export function contextNote({ timeZone, location }) {
  const now = new Date().toLocaleString("nl-NL", {
    timeZone: timeZone || "Europe/Amsterdam",
    dateStyle: "full",
    timeStyle: "short",
  });
  return `Huidige datum en tijd bij de gebruiker: ${now}.` +
    (location ? ` Locatie van de gebruiker (bij benadering): ${location}.` : "");
}

/**
 * Streamt een antwoord. `client` is een Anthropic-client (SDK).
 * Callbacks: onText(tekst), onStatus(tekst). Geeft { refused } terug.
 */
export async function streamReply(client, { history, userName, timeZone, location, signal, onText, onStatus }) {
  const base = sanitizeHistory(history);
  if (!base.length || base[base.length - 1].role !== "user") throw new Error("Lege vraag");

  // Context als los systeembericht achteraan, zodat de vaste systeemprompt cachebaar blijft.
  let convo = [...base, { role: "system", content: contextNote({ timeZone, location }) }];

  for (let i = 0; i < 4; i++) {
    const stream = client.beta.messages.stream(
      {
        model: MODEL,
        max_tokens: 4000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort: "low" },
        system: [{ type: "text", text: systemPrompt(userName), cache_control: { type: "ephemeral" } }],
        tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 3 }],
        messages: convo,
      },
      { signal },
    );

    for await (const event of stream) {
      if (event.type === "content_block_start" && event.content_block.type === "server_tool_use") {
        onStatus?.("Ik zoek het even op…");
      } else if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        onText?.(event.delta.text);
      }
    }
    const final = await stream.finalMessage();
    if (final.stop_reason === "pause_turn") {
      // Webzoeken is gepauzeerd: hervatten met hetzelfde gesprek.
      convo = [...base, { role: "assistant", content: final.content }];
      continue;
    }
    if (final.stop_reason === "refusal") {
      onText?.("Mijn excuses, daar kan ik u helaas niet mee helpen.");
      return { refused: true };
    }
    return { refused: false };
  }
  return { refused: false };
}

// Vriendelijke foutmelding op basis van de HTTP-status van de API-fout.
export function errorMessage(err, userName) {
  const s = err?.status;
  if (s === 401 || s === 403) return "Mijn API-sleutel lijkt ongeldig te zijn.";
  if (s === 429) return "Ik krijg even te veel verzoeken. Probeer het zo nog eens.";
  if (s === 529 || (s >= 500 && s < 600)) return "De AI-servers zijn even overbelast. Probeer het zo nog eens.";
  if (!s) return "Ik kan de servers niet bereiken. Controleer de internetverbinding.";
  return `Er ging iets mis met mijn verbinding, ${userName}.`;
}
