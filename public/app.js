/* J.A.R.V.I.S. — Nederlandstalige interface
 * Spraakherkenning & -synthese via de Web Speech API (Chrome/Edge),
 * vrije gesprekken via de lokale server (/api/chat → Claude).
 */
(() => {
  "use strict";

  // ---------------------------------------------------------------------------
  // Hulpjes
  // ---------------------------------------------------------------------------
  const $ = (id) => document.getElementById(id);
  const store = {
    get(k, d) { try { const v = localStorage.getItem("jarvis." + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem("jarvis." + k, JSON.stringify(v)); } catch { /* niets */ } },
  };
  const pad = (n) => String(n).padStart(2, "0");
  // Draait Jarvis als Artifact op claude.ai? Dan gebruikt hij Claude via het account van de kijker.
  const inArtifact = () => Boolean(window.claude && typeof window.claude.use === "function");
  let sampleFn = null;   // claude.use("sample")
  let dict = null;       // claude.use("dictation")

  const state = {
    mode: "idle",            // idle | listening | thinking | speaking
    aiAvailable: false,
    userName: "meneer",
    history: store.get("history", []),
    wakeEnabled: store.get("wake", true),
    soundEnabled: store.get("sound", true),
    rate: store.get("rate", 1),
    pitch: store.get("pitch", 0.9),
    voiceName: store.get("voice", null),
    awaitingCommand: false,  // na "Jarvis" wachten op een opdracht
    location: null,          // { lat, lon, name }
    level: 0,                // audioniveau voor de reactor (0..1)
    startTime: Date.now(),
    timers: [],
  };

  // ---------------------------------------------------------------------------
  // Interface-geluiden (WebAudio)
  // ---------------------------------------------------------------------------
  let audioCtx = null;
  function ensureAudio() {
    if (!audioCtx) {
      try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch { /* geen audio */ }
    }
    if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();
  }
  function beep(freq = 880, dur = 0.08, type = "sine", vol = 0.06, delay = 0) {
    if (!state.soundEnabled || !audioCtx) return;
    const t = audioCtx.currentTime + delay;
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(audioCtx.destination);
    o.start(t); o.stop(t + dur + 0.02);
  }
  const sfx = {
    activate() { beep(660, 0.07); beep(990, 0.09, "sine", 0.06, 0.08); },
    listen() { beep(1200, 0.06, "triangle", 0.05); },
    done() { beep(880, 0.05, "sine", 0.04); beep(660, 0.07, "sine", 0.04, 0.06); },
    error() { beep(220, 0.2, "sawtooth", 0.04); },
    boot() { [440, 554, 659, 880].forEach((f, i) => beep(f, 0.12, "sine", 0.05, i * 0.1)); },
  };

  // ---------------------------------------------------------------------------
  // Status & logboek
  // ---------------------------------------------------------------------------
  const pill = $("status-pill");
  const LABELS = { idle: "STAND-BY", listening: "LUISTERT", thinking: "ANALYSEERT", speaking: "SPREEKT", error: "STORING" };
  function setMode(mode) {
    state.mode = mode;
    pill.className = "pill " + mode;
    pill.textContent = LABELS[mode] || mode.toUpperCase();
    $("mic-btn").classList.toggle("active", mode === "listening" && (state.awaitingCommand || manualListen));
  }

  function addLog(who, text) {
    const el = document.createElement("div");
    el.className = "msg " + who;
    const label = who === "user" ? state.userName.toUpperCase() : who === "jarvis" ? "J.A.R.V.I.S." : "SYSTEEM";
    el.innerHTML = `<span class="who">${label}</span>`;
    const body = document.createElement("span");
    body.textContent = text;
    el.appendChild(body);
    $("log").appendChild(el);
    $("log").scrollTop = $("log").scrollHeight;
    return body;
  }
  function addLink(text, url) {
    const body = addLog("system", text + " ");
    const a = document.createElement("a");
    a.href = url; a.target = "_blank"; a.rel = "noopener";
    a.textContent = "Openen ↗"; a.style.color = "var(--gold)";
    body.appendChild(a);
  }
  const caption = $("caption");
  const transcriptEl = $("transcript");

  // ---------------------------------------------------------------------------
  // Spraaksynthese
  // ---------------------------------------------------------------------------
  const synth = window.speechSynthesis;
  let voices = [];
  let speakQueue = 0;
  let onSpeechDone = null;

  function pickVoice() {
    voices = synth ? synth.getVoices() : [];
    const nl = voices.filter((v) => /^nl/i.test(v.lang));
    const sel = $("voice-select");
    sel.innerHTML = "";
    (nl.length ? nl : voices).forEach((v) => {
      const o = document.createElement("option");
      o.value = v.name; o.textContent = `${v.name} (${v.lang})`;
      sel.appendChild(o);
    });
    if (state.voiceName && voices.some((v) => v.name === state.voiceName)) {
      sel.value = state.voiceName;
      return;
    }
    // Voorkeur: natuurlijk klinkende mannelijke Nederlandse stemmen
    const prefs = [/maarten/i, /arnaud/i, /frank/i, /online.*natural/i, /google.*nederlands/i, /nl-NL/i];
    for (const p of prefs) {
      const v = nl.find((x) => p.test(x.name) || p.test(x.lang));
      if (v) { sel.value = v.name; state.voiceName = v.name; return; }
    }
    if (nl[0]) { sel.value = nl[0].name; state.voiceName = nl[0].name; }
  }
  if (synth) {
    pickVoice();
    synth.onvoiceschanged = pickVoice;
  }

  function cleanForSpeech(text) {
    return text
      .replace(/https?:\/\/\S+/g, "")
      .replace(/[*_#`>|~]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function speak(text) {
    const t = cleanForSpeech(text);
    if (!t || !synth) return;
    const u = new SpeechSynthesisUtterance(t);
    u.lang = "nl-NL";
    const v = voices.find((x) => x.name === state.voiceName);
    if (v) { u.voice = v; u.lang = v.lang; }
    u.rate = state.rate; u.pitch = state.pitch;
    speakQueue++;
    stopRecognition();
    setMode("speaking");
    u.onboundary = () => { state.level = 1; };
    let done = false;
    const finish = () => {
      if (done) return; done = true;
      clearTimeout(watchdog);
      speakQueue = Math.max(0, speakQueue - 1);
      if (speakQueue === 0 && !streaming) {
        setMode("idle");
        const cb = onSpeechDone; onSpeechDone = null;
        if (cb) cb();
        resumeListening();
      }
    };
    u.onend = finish;
    u.onerror = finish;
    // Sommige browsers (o.a. in claude.ai) melden het einde nooit: na de geschatte duur toch afsluiten.
    const watchdog = setTimeout(finish, 2500 + t.length * 90 / (state.rate || 1));
    synth.speak(u);
  }

  function stopSpeaking() {
    if (synth) synth.cancel();
    speakQueue = 0;
    if (currentRequest) currentRequest.abort();
  }

  // Chrome pauzeert soms lange spraak; dit houdt hem wakker.
  setInterval(() => { if (synth && synth.speaking && !synth.paused) { synth.pause(); synth.resume(); } }, 10000);

  // ---------------------------------------------------------------------------
  // Spraakherkenning
  // ---------------------------------------------------------------------------
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let rec = null;
  let recRunning = false;
  let manualListen = false;
  let commandTimeout = null;

  let dictBuf = "", dictTimer = null;
  function initDictation() {
    // Claude-spraakherkenning: luistert tot 60 minuten na één klik.
    dict.onState(({ state: st, reason }) => {
      recRunning = st !== "idle";
      if (st === "listening" && state.mode === "idle") setMode("listening");
      if (st === "idle") {
        if (state.mode === "listening") setMode("idle");
        if (reason === "not_granted" || reason === "unavailable" || reason === "upstream_error") {
          transcriptEl.textContent = "Microfoon staat uit (" + reason + "). Typ je opdracht hieronder.";
          addLog("system", "Spraakherkenning is niet beschikbaar of niet toegestaan. Typ je opdrachten, of sta de microfoon toe via Machtigingen.");
        } else if (reason === "hidden") {
          transcriptEl.textContent = "Klik op de microfoon om weer te luisteren.";
        }
      }
    });
    const flush = () => {
      const text = dictBuf.trim(); dictBuf = "";
      if (text) handleHeard(text);
    };
    dict.onPartial(({ text }) => {
      clearTimeout(dictTimer);
      if (text) transcriptEl.textContent = "Gehoord: “" + (dictBuf + " " + text).trim() + "”";
      dictTimer = setTimeout(flush, 1300);
    });
    dict.onFinal(({ text }) => {
      clearTimeout(dictTimer);
      if (state.mode === "speaking" || state.mode === "thinking") { dictBuf = ""; return; } // eigen stem negeren
      dictBuf += text;
      transcriptEl.textContent = "Gehoord: “" + dictBuf.trim() + "”";
      dictTimer = setTimeout(flush, 1100);
    });
    startRecognition();
  }

  function initRecognition() {
    if (dict) { initDictation(); return; }
    if (state.serverMode === "artifact") {
      addLog("system", "Spraakherkenning werkt hier niet. Op een computer in Chrome of Edge (of de Claude-desktopapp) kun je wel praten. Typ je opdrachten hieronder.");
      transcriptEl.textContent = "Praten werkt niet op dit apparaat. Typ je opdracht hieronder.";
      return;
    }
    if (!SR) {
      addLog("system", "Spraakherkenning wordt niet ondersteund in deze browser. Gebruik Chrome of Edge, of typ je opdrachten.");
      transcriptEl.textContent = "Typ een opdracht hieronder.";
      return;
    }
    rec = new SR();
    rec.lang = "nl-NL";
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    rec.onstart = () => { recRunning = true; if (state.mode === "idle") setMode("listening"); };
    rec.onend = () => {
      recRunning = false;
      if (state.mode === "listening") setMode("idle");
      // Automatisch herstarten in wake-modus
      setTimeout(resumeListening, 250);
    };
    rec.onerror = (e) => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        state.wakeEnabled = false;
        $("wake-toggle").checked = false;
        addLog("system", "Geen toegang tot de microfoon. Sta microfoongebruik toe in de browser (slotje in de adresbalk).");
      } else if (e.error === "network") {
        addLog("system", "Spraakherkenning heeft een internetverbinding nodig.");
      }
    };
    rec.onresult = (e) => {
      let interim = "", final = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) final += r[0].transcript; else interim += r[0].transcript;
      }
      const shown = (final || interim).trim();
      if (shown && (state.awaitingCommand || manualListen || WAKE_RE.test(shown))) {
        transcriptEl.textContent = "“" + shown + "”";
      }
      if (final.trim()) handleHeard(final.trim());
    };
  }

  const WAKE_RE = /(?:^|\s|[,.!?])(?:hey |hé |hoi |oké |ok |hallo )?(?:j\.a\.r\.v\.i\.s\.?|d?[jcsh]h?[ae]r ?[vfw][iye]e?[sz]|jarvi|jervi)(?=$|[\s,.!?'’])[,.!?]?\s*/i;

  function handleHeard(text) {
    if (state.mode === "speaking" || state.mode === "thinking") return;

    if (manualListen || state.awaitingCommand) {
      manualListen = false;
      state.awaitingCommand = false;
      clearTimeout(commandTimeout);
      const cmd = text.replace(WAKE_RE, "").trim();
      if (cmd) runCommand(cmd);
      return;
    }

    const m = text.match(WAKE_RE);
    if (!m) return; // geen wake-woord: negeren
    const cmd = text.slice(m.index + m[0].length).trim();
    sfx.activate();
    if (cmd.length > 1) {
      runCommand(cmd);
    } else {
      const replies = [`Ja, ${state.userName}?`, "Tot uw dienst.", "Ik luister.", `Wat kan ik voor u doen, ${state.userName}?`];
      const reply = replies[Math.floor(Math.random() * replies.length)];
      onSpeechDone = () => armCommand();
      say(reply);
    }
  }

  function armCommand() {
    state.awaitingCommand = true;
    sfx.listen();
    transcriptEl.textContent = "Ik luister…";
    startRecognition();
    setMode("listening");
    clearTimeout(commandTimeout);
    commandTimeout = setTimeout(() => {
      state.awaitingCommand = false;
      transcriptEl.innerHTML = 'Zeg <b>"Jarvis"</b> of klik op de microfoon.';
      setMode("idle");
      if (!state.wakeEnabled) stopRecognition();
    }, 9000);
  }

  function startRecognition() {
    if (dict) {
      if (!dict.active()) dict.start().catch(() => {});
      return;
    }
    if (!rec || recRunning) return;
    try { rec.start(); } catch { /* al gestart */ }
  }
  function stopRecognition() {
    if (dict) return; // blijft luisteren; eigen stem wordt genegeerd
    if (!rec || !recRunning) return;
    try { rec.abort(); } catch { /* niets */ }
  }
  function resumeListening() {
    if (state.mode === "speaking" || state.mode === "thinking" || speakQueue > 0) return;
    if (state.wakeEnabled || state.awaitingCommand || manualListen) startRecognition();
  }

  function toggleMic() {
    ensureAudio();
    if (state.mode === "speaking" || state.mode === "thinking") {
      stopSpeaking();
      streaming = false;
      setMode("idle");
      setTimeout(armCommand, 200);
      return;
    }
    if (state.awaitingCommand || manualListen) {
      manualListen = false; state.awaitingCommand = false;
      clearTimeout(commandTimeout);
      setMode("idle");
      if (!state.wakeEnabled) stopRecognition();
      return;
    }
    armCommand();
  }

  // ---------------------------------------------------------------------------
  // Opdrachten
  // ---------------------------------------------------------------------------
  function say(text) {
    addLog("jarvis", text);
    caption.textContent = text;
    speak(text);
  }

  function greeting() {
    const h = new Date().getHours();
    if (h < 6) return "Goedenacht";
    if (h < 12) return "Goedemorgen";
    if (h < 18) return "Goedemiddag";
    return "Goedenavond";
  }

  const NUMBERS = { een: 1, één: 1, twee: 2, drie: 3, vier: 4, vijf: 5, zes: 6, zeven: 7, acht: 8, negen: 9, tien: 10, elf: 11, twaalf: 12, vijftien: 15, twintig: 20, dertig: 30, veertig: 40, vijftig: 50, zestig: 60, half: 0.5, halve: 0.5 };
  const toNum = (w) => (/^\d+([.,]\d+)?$/.test(w) ? parseFloat(w.replace(",", ".")) : NUMBERS[w]);

  const SITES = {
    youtube: "https://www.youtube.com", google: "https://www.google.com", gmail: "https://mail.google.com",
    netflix: "https://www.netflix.com", spotify: "https://open.spotify.com", maps: "https://maps.google.com",
    "google maps": "https://maps.google.com", wikipedia: "https://nl.wikipedia.org", nu: "https://www.nu.nl",
    "nu.nl": "https://www.nu.nl", nos: "https://nos.nl", buienradar: "https://www.buienradar.nl",
    instagram: "https://www.instagram.com", whatsapp: "https://web.whatsapp.com", chatgpt: "https://claude.ai", claude: "https://claude.ai",
    twitter: "https://x.com", x: "https://x.com", facebook: "https://www.facebook.com", linkedin: "https://www.linkedin.com",
    github: "https://github.com", outlook: "https://outlook.live.com", bol: "https://www.bol.com", "bol.com": "https://www.bol.com",
  };

  function openUrl(url, label) {
    const w = window.open(url, "_blank", "noopener");
    if (!w) addLink(`${label} staat klaar:`, url);
  }

  const JOKES = [
    "Waarom nam de computer een jas mee? Omdat hij Windows had openstaan.",
    "Ik zou een grap over UDP vertellen, maar ik weet niet of u hem ontvangt.",
    "Mijn wachtwoord is 'onjuist'. Als ik het vergeet, zegt de computer het vanzelf.",
    "Er zijn tien soorten mensen: zij die binair begrijpen, en zij die dat niet doen.",
  ];

  // Lokale opdrachten: geeft true terug als de opdracht is afgehandeld.
  function localCommand(raw) {
    const t = raw.toLowerCase().replace(/[?!.,]+$/g, "").trim();

    if (/^(stop|stil|zwijg|hou je mond|genoeg|laat maar|annuleer)$/.test(t)) {
      stopSpeaking(); setMode("idle"); return true;
    }
    if (/(hoe laat is het|hoe laat|wat is de tijd|hoeveel uur)/.test(t)) {
      const d = new Date();
      say(`Het is ${d.getHours()} uur ${d.getMinutes() ? d.getMinutes() : ""}, ${state.userName}.`.replace(" ,", ","));
      return true;
    }
    if (/(welke dag|wat is de datum|welke datum|de hoeveelste)/.test(t)) {
      const d = new Date().toLocaleDateString("nl-NL", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
      say(`Het is vandaag ${d}.`);
      return true;
    }
    let m = t.match(/(?:zet|start|maak)?\s*(?:een\s+)?(?:timer|wekker|alarm)\s+(?:van|voor|op)?\s*(\S+)\s*(seconde|seconden|minuut|minuten|uur|uren)/) ||
            t.match(/(?:timer|wekker)\s*(?:van|voor)?\s*(\S+)\s*(seconde|seconden|minuut|minuten|uur)/);
    if (m) {
      const n = toNum(m[1]);
      if (n) {
        const unit = m[2].startsWith("sec") ? 1 : m[2].startsWith("min") ? 60 : 3600;
        startTimer(n * unit, `${m[1]} ${m[2]}`);
        return true;
      }
    }
    if (/(annuleer|stop|verwijder).*(timer|wekker)/.test(t)) {
      state.timers.forEach(clearTimeout); state.timers = [];
      say("Alle timers zijn geannuleerd."); return true;
    }
    if (/^(wat is het weer|hoe is het weer|weerbericht|het weer|wat voor weer|gaat het regenen)/.test(t)) {
      speakWeather(); return true;
    }
    m = t.match(/^(?:open|start|ga naar|navigeer naar)\s+(.+)$/);
    if (m) {
      const key = m[1].replace(/^(de|het)\s+/, "").replace(/\s*(website|site|app)$/, "").trim();
      const url = SITES[key] || (/\.\w{2,}$/.test(key) ? "https://" + key.replace(/\s+/g, "") : null);
      if (url) { say(`Ik open ${key}.`); openUrl(url, key); return true; }
    }
    m = t.match(/^(?:speel|zet)\s+(.+?)\s+(?:af\s+)?(?:op|via)\s+youtube(?:\s+af)?$/) || t.match(/^zoek\s+(.+)\s+op\s+youtube$/);
    if (m) {
      say(`Ik zoek ${m[1]} op YouTube.`);
      openUrl("https://www.youtube.com/results?search_query=" + encodeURIComponent(m[1]), "YouTube");
      return true;
    }
    m = t.match(/^(?:google|zoek op google naar|zoek op internet naar|google naar)\s+(.+)$/);
    if (m) {
      say(`Ik zoek naar ${m[1]}.`);
      openUrl("https://www.google.com/search?q=" + encodeURIComponent(m[1]), "Zoekresultaten");
      return true;
    }
    if (/(wis|vergeet|reset).*(geheugen|gesprek|alles)/.test(t)) {
      state.history = []; store.set("history", []);
      say("Gespreksgeheugen gewist. We beginnen met een schone lei."); return true;
    }
    if (/(ga slapen|slaapstand|slaapmodus|tot ziens|doei|welterusten|systeem uit)/.test(t)) {
      say(`Uiteraard, ${state.userName}. Ik blijf op de achtergrond paraat. Zeg Jarvis als u me nodig heeft.`);
      return true;
    }
    if (/(stille modus|niet meer luisteren|stop met luisteren)/.test(t)) {
      setWake(false); say("Ik luister niet meer automatisch. Klik op de microfoon als u me nodig heeft."); return true;
    }
    if (/(luister weer|ga weer luisteren|wake ?modus aan)/.test(t)) {
      setWake(true); say("Ik luister weer naar mijn naam."); return true;
    }
    if (!state.aiAvailable) {
      if (/(grap|mop)/.test(t)) { say(JOKES[Math.floor(Math.random() * JOKES.length)]); return true; }
      if (/(hoe gaat het|alles goed)/.test(t)) { say(`Alle systemen functioneren naar behoren, ${state.userName}. Dank voor het vragen.`); return true; }
      if (/(wie ben jij|wat ben jij|wie ben je)/.test(t)) { say("Ik ben Jarvis, uw persoonlijke digitale assistent."); return true; }
      if (/(dank|bedankt)/.test(t)) { say(`Graag gedaan, ${state.userName}.`); return true; }
      if (/(weer)/.test(t)) { speakWeather(); return true; }
    }
    return false;
  }

  function startTimer(seconds, label) {
    say(`Timer van ${label} gestart.`);
    const id = setTimeout(() => {
      sfx.boot(); sfx.boot();
      say(`${state.userName}, uw timer van ${label} is afgelopen.`);
      state.timers = state.timers.filter((x) => x !== id);
    }, seconds * 1000);
    state.timers.push(id);
  }

  function runCommand(text) {
    ensureAudio();
    addLog("user", text);
    transcriptEl.textContent = "“" + text + "”";
    if (localCommand(text)) return;
    if (state.aiAvailable) askAI(text);
    else say(`Mijn excuses, ${state.userName}. Mijn AI-kern is niet actief, dus ik ken alleen basisopdrachten zoals de tijd, het weer, timers en websites openen.`);
  }

  // ---------------------------------------------------------------------------
  // AI (via lokale server)
  // ---------------------------------------------------------------------------
  let streaming = false;
  let currentRequest = null;
  let browserClient = null; // Anthropic-client in GitHub Pages-modus

  async function askAI(text) {
    state.history.push({ role: "user", content: text });
    setMode("thinking");
    stopRecognition();
    caption.textContent = "";
    const bodyEl = addLog("jarvis", "…");
    let full = "", spoken = 0;
    streaming = true;
    currentRequest = new AbortController();

    const flushSentences = (force) => {
      const rest = full.slice(spoken);
      const re = /[^.!?…]+[.!?…]+["”')]*\s+/g;
      let m, lastEnd = 0;
      while ((m = re.exec(rest))) lastEnd = m.index + m[0].length;
      if (force) lastEnd = rest.length;
      if (lastEnd > 0) {
        const chunk = rest.slice(0, lastEnd);
        spoken += lastEnd;
        if (chunk.trim()) speak(chunk);
      }
    };

    const handleEvent = (ev) => {
      if (ev.type === "text") {
        full += ev.text;
        bodyEl.textContent = full;
        caption.textContent = full.length > 220 ? "…" + full.slice(-220) : full;
        $("log").scrollTop = $("log").scrollHeight;
        flushSentences(false);
      } else if (ev.type === "status") {
        caption.textContent = ev.text;
        if (!full) bodyEl.textContent = ev.text;
      } else if (ev.type === "error") {
        full += (full ? " " : "") + ev.text;
        bodyEl.textContent = full;
        sfx.error();
      }
    };
    const signal = currentRequest.signal;

    try {
      if (state.serverMode === "artifact") {
        await askViaArtifact(signal, handleEvent);
      } else if (state.serverMode) {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            history: state.history,
            timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            location: state.location?.name || null,
          }),
          signal,
        });
        if (res.status === 401) { location.href = "/login"; return; }
        if (!res.ok || !res.body) throw new Error("HTTP " + res.status);
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let nl;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
            if (line.trim()) handleEvent(JSON.parse(line));
          }
        }
      } else {
        // GitHub Pages-modus: rechtstreeks vanuit de browser met de ontgrendelde sleutel.
        const brain = await import("./brain.mjs");
        try {
          const opts = {
            history: state.history,
            userName: state.userName,
            timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            location: state.location?.name || null,
            signal,
            onText: (text) => handleEvent({ type: "text", text }),
            onStatus: (text) => handleEvent({ type: "status", text }),
          };
          if (browserClient.provider === "gemini") await brain.streamReplyGemini(browserClient.apiKey, opts);
          else await brain.streamReply(browserClient.client, opts);
        } catch (err) {
          if (signal.aborted) { const e = new Error("afgebroken"); e.name = "AbortError"; throw e; }
          console.error(err);
          handleEvent({ type: "error", text: brain.errorMessage(err, state.userName) });
        }
      }
      streaming = false;
      flushSentences(true);
      if (full.trim()) state.history.push({ role: "assistant", content: full.trim() });
      else bodyEl.textContent = "(geen antwoord)";
      store.set("history", state.history.slice(-30));
      if (speakQueue === 0) { setMode("idle"); resumeListening(); }
    } catch (err) {
      streaming = false;
      if (err.name === "AbortError") { bodyEl.textContent = full || "(onderbroken)"; return; }
      state.history.pop();
      bodyEl.textContent = "Verbinding met mijn AI-kern mislukt.";
      sfx.error();
      setMode("error");
      speak(`Mijn excuses, ${state.userName}, ik kan mijn AI-kern niet bereiken.`);
      checkServer();
    } finally {
      currentRequest = null;
    }
  }

  // Claude via claude.ai (Artifact): geen sleutel nodig, gebruikt het account van de kijker.
  async function askViaArtifact(signal, handleEvent) {
    const B = window.JarvisBrain;
    const msgs = B.sanitizeHistory(state.history);
    const instructions = B.systemPrompt(state.userName) + "\n\n" +
      B.contextNote({ timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, location: state.location?.name || null }) +
      "\nJe kunt in deze versie niet op internet zoeken; zeg dat eerlijk als iemand om actueel nieuws of het weer vraagt." +
      "\n\nHieronder volgt het gesprek. Antwoord alleen als Jarvis op het laatste bericht.\n\n";
    msgs[0] = { role: "user", content: instructions + msgs[0].content };
    try {
      await sampleFn(msgs, {
        signal,
        cache: false,
        onText: ({ delta }) => handleEvent({ type: "text", text: delta }),
      });
    } catch (err) {
      if (err?.code === "cancelled" || signal.aborted) { const e = new Error("afgebroken"); e.name = "AbortError"; throw e; }
      const msgs2 = {
        not_granted: "Ik heb geen toestemming om Claude te gebruiken. Sta het toe via het menu Machtigingen van deze pagina.",
        rate_limited: "Ik krijg even te veel verzoeken. Probeer het over een minuutje opnieuw.",
        refused: "Mijn excuses, daar kan ik u helaas niet mee helpen.",
        session_expired: "Uw claude.ai-sessie is verlopen. Herlaad de pagina en log opnieuw in.",
        prompt_too_large: "Ons gesprek is te lang geworden. Wis mijn geheugen via de instellingen.",
      };
      handleEvent({ type: "error", text: msgs2[err?.code] || `Er ging iets mis met mijn verbinding, ${state.userName}.` });
    }
  }

  async function checkServer() {
    if (inArtifact() || state.serverMode === "artifact") {
      state.serverMode = "artifact";
      if (!sampleFn) {
        [sampleFn, dict] = await Promise.all([
          window.claude.use("sample").catch(() => null),
          window.claude.use("dictation").catch(() => null),
        ]);
      }
      state.aiAvailable = Boolean(sampleFn);
    } else if (state.serverMode === false) {
      state.aiAvailable = Boolean(browserClient);
    } else {
      try {
        const r = await fetch("api/status", { cache: "no-store" });
        if (r.status === 401) { location.href = "/login"; return; }
        if (!r.ok) throw new Error("geen server");
        const j = await r.json();
        state.serverMode = true;
        state.aiAvailable = !!j.ai;
        if (j.userName) state.userName = j.userName;
      } catch {
        // Geen server (bijv. GitHub Pages): browsermodus
        state.serverMode = false;
        state.aiAvailable = Boolean(browserClient);
      }
    }
    $("ai-indicator").classList.toggle("on", state.aiAvailable);
    $("ai-label").textContent = state.aiAvailable ? "AI-KERN ONLINE" : "AI-KERN OFFLINE";
  }

  // ---------------------------------------------------------------------------
  // Weer (Open-Meteo, geen sleutel nodig)
  // ---------------------------------------------------------------------------
  const WMO = {
    0: "onbewolkt", 1: "overwegend helder", 2: "half bewolkt", 3: "bewolkt", 45: "mist", 48: "rijpmist",
    51: "lichte motregen", 53: "motregen", 55: "dichte motregen", 61: "lichte regen", 63: "regen", 65: "zware regen",
    66: "ijzel", 67: "zware ijzel", 71: "lichte sneeuw", 73: "sneeuw", 75: "zware sneeuw", 77: "korrelsneeuw",
    80: "lichte buien", 81: "regenbuien", 82: "zware buien", 85: "sneeuwbuien", 86: "zware sneeuwbuien",
    95: "onweer", 96: "onweer met hagel", 99: "zwaar onweer met hagel",
  };
  let weather = null;

  function locate() {
    return new Promise((resolve) => {
      const fallback = () => resolve({ lat: 52.37, lon: 4.89, name: "Amsterdam" });
      if (!navigator.geolocation) return fallback();
      navigator.geolocation.getCurrentPosition(async (p) => {
        const loc = { lat: p.coords.latitude, lon: p.coords.longitude, name: null };
        try {
          const r = await fetch(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${loc.lat}&longitude=${loc.lon}&localityLanguage=nl`);
          const j = await r.json();
          loc.name = j.city || j.locality || j.principalSubdivision || null;
        } catch { /* naam onbekend */ }
        resolve(loc);
      }, fallback, { timeout: 8000, maximumAge: 3600000 });
    });
  }

  async function updateWeather() {
    if (inArtifact()) {
      $("weather").closest(".panel").hidden = true;
      return;
    }
    try {
      if (!state.location) state.location = await locate();
      const { lat, lon } = state.location;
      const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m,relative_humidity_2m&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&forecast_days=1`);
      const j = await r.json();
      weather = {
        temp: Math.round(j.current.temperature_2m),
        feels: Math.round(j.current.apparent_temperature),
        desc: WMO[j.current.weather_code] || "onbekend",
        wind: Math.round(j.current.wind_speed_10m),
        hum: j.current.relative_humidity_2m,
        max: Math.round(j.daily.temperature_2m_max[0]),
        min: Math.round(j.daily.temperature_2m_min[0]),
        rain: j.daily.precipitation_probability_max[0],
      };
      $("weather").innerHTML =
        `<div class="temp">${weather.temp}°C</div>` +
        `<div>${weather.desc}${state.location.name ? " · " + state.location.name : ""}</div>` +
        `<div style="opacity:.7;font-size:13px">min ${weather.min}° / max ${weather.max}° · wind ${weather.wind} km/u · regenkans ${weather.rain ?? 0}%</div>`;
    } catch {
      $("weather").textContent = "Weergegevens niet beschikbaar.";
    }
  }

  function speakWeather() {
    if (!weather && state.serverMode === "artifact" && state.aiAvailable) { askAI("Wat is het weer?"); return; }
    if (!weather) { say("Ik heb op dit moment geen weergegevens beschikbaar."); return; }
    const place = state.location?.name ? ` in ${state.location.name}` : "";
    say(`Het is momenteel ${weather.temp} graden${place} en ${weather.desc}. Vandaag wordt het tussen de ${weather.min} en ${weather.max} graden, met ${weather.rain ?? 0} procent kans op neerslag.`);
  }

  // ---------------------------------------------------------------------------
  // Klok & systeempanelen
  // ---------------------------------------------------------------------------
  let lastFrame = performance.now(), lagAvg = 0;
  function tickPanels() {
    const d = new Date();
    $("clock").textContent = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    $("seconds").textContent = pad(d.getSeconds());
    $("date").textContent = d.toLocaleDateString("nl-NL", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
    const up = Math.floor((Date.now() - state.startTime) / 1000);
    $("sys-up").textContent = `${pad(Math.floor(up / 3600))}:${pad(Math.floor(up / 60) % 60)}:${pad(up % 60)}`;

    const cores = navigator.hardwareConcurrency || "?";
    const load = Math.min(100, Math.round(8 + lagAvg * 4 + Math.random() * 6));
    $("sys-cpu").textContent = `${cores} KERNEN · ${load}%`;
    $("bar-cpu").style.width = load + "%";

    if (performance.memory) {
      const used = performance.memory.usedJSHeapSize, lim = performance.memory.jsHeapSizeLimit;
      $("sys-mem").textContent = `${Math.round(used / 1048576)} MB`;
      $("bar-mem").style.width = Math.max(2, (used / lim) * 100 * 10) + "%";
    } else if (navigator.deviceMemory) {
      $("sys-mem").textContent = `${navigator.deviceMemory} GB`;
      $("bar-mem").style.width = "35%";
    }
    const c = navigator.connection;
    $("sys-net").textContent = navigator.onLine
      ? (c && c.effectiveType ? `ONLINE · ${c.effectiveType.toUpperCase()}${c.downlink ? " · " + c.downlink + " MB/S" : ""}` : "ONLINE")
      : "OFFLINE";
  }
  async function initBattery() {
    if (!navigator.getBattery) { $("sys-bat").textContent = "NETSTROOM"; $("bar-bat").style.width = "100%"; return; }
    try {
      const b = await navigator.getBattery();
      const upd = () => {
        const p = Math.round(b.level * 100);
        $("sys-bat").textContent = `${p}%${b.charging ? " · LADEN" : ""}`;
        $("bar-bat").style.width = p + "%";
      };
      upd(); b.onlevelchange = upd; b.onchargingchange = upd;
    } catch { /* niets */ }
  }

  // ---------------------------------------------------------------------------
  // Microfoonniveau voor de visualisatie (optioneel)
  // ---------------------------------------------------------------------------
  let analyser = null, analyserData = null;
  async function initMicLevel() {
    try {
      ensureAudio();
      if (!audioCtx || !navigator.mediaDevices) return;
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      const src = audioCtx.createMediaStreamSource(stream);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      analyserData = new Uint8Array(analyser.frequencyBinCount);
      src.connect(analyser);
    } catch { /* geen toegang: dan zonder visualisatie */ }
  }
  function micLevel() {
    if (!analyser) return 0;
    analyser.getByteTimeDomainData(analyserData);
    let sum = 0;
    for (const v of analyserData) { const x = (v - 128) / 128; sum += x * x; }
    return Math.min(1, Math.sqrt(sum / analyserData.length) * 4);
  }

  // ---------------------------------------------------------------------------
  // Reactor-visualisatie
  // ---------------------------------------------------------------------------
  const canvas = $("reactor");
  const ctx = canvas.getContext("2d");
  let W = 0, H = 0, DPR = 1;
  function resize() {
    DPR = Math.min(2, window.devicePixelRatio || 1);
    const r = canvas.getBoundingClientRect();
    W = r.width; H = r.height;
    canvas.width = W * DPR; canvas.height = H * DPR;
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  }
  window.addEventListener("resize", resize);

  const COLORS = {
    idle: [62, 233, 255], listening: [255, 181, 71], thinking: [183, 139, 255],
    speaking: [62, 233, 255], error: [255, 77, 94],
  };
  let col = [62, 233, 255];
  const bars = new Array(96).fill(0);

  function ring(cx, cy, r, w, a0, a1, alpha) {
    ctx.beginPath();
    ctx.arc(cx, cy, r, a0, a1);
    ctx.lineWidth = w;
    ctx.strokeStyle = `rgba(${col[0]},${col[1]},${col[2]},${alpha})`;
    ctx.stroke();
  }

  function draw(now) {
    const dt = now - lastFrame; lastFrame = now;
    lagAvg = lagAvg * 0.95 + Math.max(0, dt - 16.7) * 0.05;
    const t = now / 1000;

    // Kleur vloeiend laten overgaan
    const target = COLORS[state.mode] || COLORS.idle;
    col = col.map((c, i) => c + (target[i] - c) * 0.08);

    // Niveau bepalen
    let lvl = 0;
    if (state.mode === "speaking") lvl = 0.35 + 0.35 * Math.abs(Math.sin(t * 9)) * (0.6 + Math.random() * 0.4);
    else if (state.mode === "listening") lvl = micLevel();
    else if (state.mode === "thinking") lvl = 0.15 + 0.1 * Math.sin(t * 4);
    else lvl = 0.05 + 0.03 * Math.sin(t * 1.5);
    state.level = state.level * 0.8 + lvl * 0.2;
    const L = state.level;

    ctx.clearRect(0, 0, W, H);
    const cx = W / 2, cy = H / 2;
    const R = Math.min(W, H) * 0.42;
    const speed = state.mode === "thinking" ? 3 : 1;

    // Gloed achtergrond
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 1.1);
    g.addColorStop(0, `rgba(${col[0]},${col[1]},${col[2]},${0.18 + L * 0.25})`);
    g.addColorStop(0.5, `rgba(${col[0]},${col[1]},${col[2]},0.04)`);
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    ctx.save();
    ctx.shadowBlur = 12;
    ctx.shadowColor = `rgb(${col[0]},${col[1]},${col[2]})`;

    // Buitenste ring met maatstreepjes
    ring(cx, cy, R, 1.2, 0, Math.PI * 2, 0.5);
    for (let i = 0; i < 120; i++) {
      const a = (i / 120) * Math.PI * 2 + t * 0.05 * speed;
      const long = i % 10 === 0;
      const r1 = R + 4, r2 = R + (long ? 16 : 8);
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
      ctx.lineTo(cx + Math.cos(a) * r2, cy + Math.sin(a) * r2);
      ctx.lineWidth = long ? 2 : 1;
      ctx.strokeStyle = `rgba(${col[0]},${col[1]},${col[2]},${long ? 0.8 : 0.35})`;
      ctx.stroke();
    }

    // Roterende segmentringen
    const segs = [
      { r: 0.9, w: 3, n: 3, len: 0.7, sp: 0.4 },
      { r: 0.82, w: 8, n: 6, len: 0.35, sp: -0.25 },
      { r: 0.74, w: 1.5, n: 2, len: 1.2, sp: 0.7 },
      { r: 0.66, w: 5, n: 12, len: 0.18, sp: -0.5 },
    ];
    for (const s of segs) {
      for (let i = 0; i < s.n; i++) {
        const a0 = (i / s.n) * Math.PI * 2 + t * s.sp * speed;
        ring(cx, cy, R * s.r, s.w, a0, a0 + s.len, 0.55 + L * 0.4);
      }
    }

    // Radiale audiobalken
    const inner = R * 0.42;
    for (let i = 0; i < bars.length; i++) {
      const noise = Math.sin(i * 0.7 + t * 6) * 0.5 + Math.sin(i * 1.9 - t * 4) * 0.5;
      const targetH = L * (0.4 + 0.6 * Math.abs(noise)) * R * 0.2;
      bars[i] += (targetH - bars[i]) * 0.3;
      const a = (i / bars.length) * Math.PI * 2 - Math.PI / 2;
      const r1 = inner + 6, r2 = r1 + 2 + bars[i];
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
      ctx.lineTo(cx + Math.cos(a) * r2, cy + Math.sin(a) * r2);
      ctx.lineWidth = 2.2;
      ctx.strokeStyle = `rgba(${col[0]},${col[1]},${col[2]},${0.5 + L * 0.5})`;
      ctx.stroke();
    }

    // Driehoekige kern (reactor-stijl)
    ring(cx, cy, inner, 2, 0, Math.PI * 2, 0.9);
    ctx.beginPath();
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2 - Math.PI / 2 + t * 0.15 * speed;
      const x = cx + Math.cos(a) * inner * 0.82, y = cy + Math.sin(a) * inner * 0.82;
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    ctx.closePath();
    ctx.lineWidth = 2;
    ctx.strokeStyle = `rgba(${col[0]},${col[1]},${col[2]},0.8)`;
    ctx.stroke();

    // Gloeiende kern
    const coreR = inner * (0.42 + L * 0.18);
    const cg = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR);
    cg.addColorStop(0, "rgba(255,255,255,0.95)");
    cg.addColorStop(0.35, `rgba(${col[0]},${col[1]},${col[2]},0.9)`);
    cg.addColorStop(1, `rgba(${col[0]},${col[1]},${col[2]},0)`);
    ctx.fillStyle = cg;
    ctx.beginPath(); ctx.arc(cx, cy, coreR, 0, Math.PI * 2); ctx.fill();
    ctx.restore();

    // Tekst in de kern
    ctx.fillStyle = `rgba(${col[0]},${col[1]},${col[2]},0.9)`;
    ctx.font = `600 ${Math.max(10, R * 0.045)}px Orbitron, sans-serif`;
    ctx.textAlign = "center";
    ctx.fillText(LABELS[state.mode] || "", cx, cy + inner + R * 0.12);

    requestAnimationFrame(draw);
  }

  // ---------------------------------------------------------------------------
  // Instellingen
  // ---------------------------------------------------------------------------
  function setWake(on) {
    state.wakeEnabled = on;
    store.set("wake", on);
    $("wake-toggle").checked = on;
    if (on) startRecognition(); else if (!state.awaitingCommand) stopRecognition();
  }
  function initSettings() {
    $("wake-toggle").checked = state.wakeEnabled;
    $("sound-toggle").checked = state.soundEnabled;
    $("rate").value = state.rate;
    $("pitch").value = state.pitch;
    $("settings-btn").onclick = () => $("settings").showModal();
    $("voice-select").onchange = (e) => { state.voiceName = e.target.value; store.set("voice", state.voiceName); };
    $("rate").oninput = (e) => { state.rate = +e.target.value; store.set("rate", state.rate); };
    $("pitch").oninput = (e) => { state.pitch = +e.target.value; store.set("pitch", state.pitch); };
    $("wake-toggle").onchange = (e) => setWake(e.target.checked);
    $("sound-toggle").onchange = (e) => { state.soundEnabled = e.target.checked; store.set("sound", state.soundEnabled); };
    $("test-voice").onclick = () => speak(`Goedendag ${state.userName}. Dit is mijn stem. Alle systemen zijn operationeel.`);
    $("clear-memory").onclick = () => {
      state.history = []; store.set("history", []);
      $("log").innerHTML = ""; addLog("system", "Gespreksgeheugen gewist.");
    };
  }

  // ---------------------------------------------------------------------------
  // Opstarten
  // ---------------------------------------------------------------------------
  const BOOT_LINES = [
    "> Kernsystemen initialiseren............ OK",
    "> Neurale taalmodule laden (nl-NL)...... OK",
    "> Spraaksynthese kalibreren............. OK",
    "> Akoestische sensoren.................. " + (SR ? "OK" : "NIET BESCHIKBAAR"),
    "> Verbinding met AI-kern................ ",
    "> Holografische interface renderen...... OK",
    "> Alle systemen operationeel.",
  ];

  // ---------------------------------------------------------------------------
  // GitHub Pages-modus: sleutel ontgrendelen met wachtwoord
  // ---------------------------------------------------------------------------
  const CONFIG = window.JARVIS_CONFIG || null;
  const UNLOCK_KEY = "unlocked";

  async function makeBrowserClient(apiKey) {
    if (/^sk-ant-/.test(apiKey)) {
      const { default: Anthropic } = await import("./vendor/anthropic.mjs");
      browserClient = { provider: "claude", client: new Anthropic({ apiKey, dangerouslyAllowBrowser: true }) };
    } else {
      browserClient = { provider: "gemini", apiKey }; // gratis Google Gemini-sleutel
    }
  }

  function askPassword() {
    return new Promise((resolve) => {
      const gate = $("gate");
      gate.hidden = false;
      $("gate-pw").focus();
      gate.onsubmit = async (e) => {
        e.preventDefault();
        const btn = gate.querySelector("button");
        btn.disabled = true; $("gate-err").textContent = "Identiteit verifiëren…";
        try {
          const { decryptSecret } = await import("./vault.mjs");
          const apiKey = await decryptSecret(CONFIG.vault, $("gate-pw").value);
          if ($("gate-remember").checked) store.set(UNLOCK_KEY, { apiKey, exp: Date.now() + 30 * 86400000 });
          gate.hidden = true;
          sfx.activate();
          resolve(apiKey);
        } catch {
          await new Promise((r) => setTimeout(r, 800));
          $("gate-err").textContent = "Toegang geweigerd. Onjuist wachtwoord.";
          $("gate-pw").value = ""; $("gate-pw").focus();
          ensureAudio(); sfx.error();
        } finally {
          btn.disabled = false;
        }
      };
    });
  }

  async function unlockIfNeeded() {
    await checkServer();
    if (state.serverMode || !CONFIG?.vault) return;
    if (CONFIG.userName) state.userName = CONFIG.userName;
    const saved = store.get(UNLOCK_KEY, null);
    const apiKey = saved && saved.exp > Date.now() ? saved.apiKey : await askPassword();
    await makeBrowserClient(apiKey);
    await checkServer();
  }

  function logout() {
    if (state.serverMode) { location.href = "/logout"; return; }
    store.set(UNLOCK_KEY, null);
    location.reload();
  }

  async function bootSequence() {
    const log = $("boot-log");
    await unlockIfNeeded();
    const statusP = checkServer();
    for (let i = 0; i < BOOT_LINES.length; i++) {
      let line = BOOT_LINES[i];
      if (i === 4) { await statusP; line += state.aiAvailable ? "OK" : "OFFLINE (basismodus)"; }
      for (const ch of line) { log.textContent += ch; await new Promise((r) => setTimeout(r, 6)); }
      log.textContent += "\n";
      await new Promise((r) => setTimeout(r, 120));
    }
    $("boot-btn").hidden = false;
    $("boot-btn").focus();
  }

  async function activate() {
    ensureAudio();
    sfx.boot();
    $("boot").classList.add("hide");
    setTimeout(() => $("boot").remove(), 900);
    resize();
    // Vorig gesprek tonen
    state.history.slice(-8).forEach((m) => addLog(m.role === "user" ? "user" : "jarvis", m.content));
    initRecognition();
    await initMicLevel();
    const h = greeting();
    const intro = state.aiAvailable
      ? `${h}, ${state.userName}. Alle systemen zijn online. Waarmee kan ik u van dienst zijn?`
      : `${h}, ${state.userName}. Ik draai in basismodus; mijn AI-kern is niet verbonden. Ik kan u wel helpen met de tijd, het weer, timers en het openen van websites.`;
    if (!state.aiAvailable && state.serverMode === false && !CONFIG?.vault) {
      addLink("AI-kern nog niet ingesteld. Ga naar de installatiepagina:", "setup.html");
    }
    onSpeechDone = () => { if (state.wakeEnabled) startRecognition(); };
    say(intro);
    if (!synth) { if (state.wakeEnabled) startRecognition(); }
  }

  // Event-listeners
  $("boot-btn").onclick = activate;
  $("logout-btn").onclick = logout;
  $("mic-btn").onclick = toggleMic;
  $("text-form").onsubmit = (e) => {
    e.preventDefault();
    const v = $("text-input").value.trim();
    if (!v) return;
    $("text-input").value = "";
    if (state.mode === "speaking" || state.mode === "thinking") { stopSpeaking(); streaming = false; setMode("idle"); }
    runCommand(v);
  };
  document.addEventListener("keydown", (e) => {
    if (e.code === "Space" && document.activeElement.tagName !== "INPUT" && !$("settings").open && (!$("boot") || $("boot").classList.contains("hide"))) {
      e.preventDefault(); toggleMic();
    }
    if (e.key === "Escape") { stopSpeaking(); streaming = false; setMode("idle"); }
  });

  initSettings();
  initBattery();
  tickPanels();
  setInterval(tickPanels, 1000);
  updateWeather();
  setInterval(updateWeather, 15 * 60 * 1000);
  resize();
  requestAnimationFrame(draw);
  bootSequence();
})();
