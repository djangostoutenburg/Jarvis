// Versleutelt/ontsleutelt de API-sleutel met een wachtwoord (Web Crypto: PBKDF2 + AES-GCM).
// Zo kan de sleutel veilig in een openbare GitHub Pages-site staan: zonder wachtwoord is hij onleesbaar.

const ITERATIONS = 600000;
const enc = new TextEncoder();
const dec = new TextDecoder();

const toB64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function deriveKey(password, salt, iterations) {
  const base = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encryptSecret(secret, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt, ITERATIONS);
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(secret));
  return { v: 1, iter: ITERATIONS, salt: toB64(salt), iv: toB64(iv), data: toB64(data) };
}

// Gooit een fout bij een onjuist wachtwoord.
export async function decryptSecret(vault, password) {
  const key = await deriveKey(password, fromB64(vault.salt), vault.iter || ITERATIONS);
  const data = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(vault.iv) }, key, fromB64(vault.data));
  return dec.decode(data);
}
