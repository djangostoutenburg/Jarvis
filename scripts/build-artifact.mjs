// Bouwt één losse HTML-pagina van Jarvis voor publicatie als Artifact op claude.ai.
// Gebruik: node scripts/build-artifact.mjs  →  dist/jarvis-artifact.html
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => fs.readFileSync(path.join(root, f), "utf8");

const indexHtml = read("public/index.html");
const css = read("public/style.css");
const app = read("public/app.js");
// brain.mjs als gewoon script: alleen de helpers die de Artifact-versie nodig heeft.
const brain = read("public/brain.mjs")
  .replace(/^export /gm, "")
  .replace(/^const GEMINI_MODEL.*$/m, "");

const body = indexHtml
  .slice(indexHtml.indexOf("<body>") + 6, indexHtml.indexOf("</body>"))
  .replace(/<script[^>]*src=[^>]*><\/script>\s*/g, "");

const out = `<title>J.A.R.V.I.S.</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Orbitron:wght@400;600;800&family=Rajdhani:wght@400;500;600&display=swap">
<style>
${css}
/* Artifact: bewust één donkere look, past binnen de veilige marges van de viewer */
:root { color-scheme: dark; }
html, body { height: 100%; background: var(--bg); }
#hud { height: 100%; }
#logout-btn { display: none; }
@media (max-width: 900px) { #hud { height: auto; min-height: 100%; } }
</style>
${body}
<script>
window.JarvisBrain = (() => {
${brain}
return { systemPrompt, sanitizeHistory, contextNote };
})();
</script>
<script>
${app}
</script>
`;

fs.mkdirSync(path.join(root, "dist"), { recursive: true });
fs.writeFileSync(path.join(root, "dist/jarvis-artifact.html"), out);
console.log("dist/jarvis-artifact.html", (out.length / 1024).toFixed(0) + " KB");
