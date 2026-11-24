# J.A.R.V.I.S. — jouw Nederlandstalige AI-assistent

![Jarvis interface](docs/preview.png)

Een pratende assistent met een futuristische HUD-interface, in de stijl van een film-AI.
Jarvis luistert naar zijn naam, verstaat Nederlands, praat terug met een Nederlandse stem
en kan met Claude als "brein" over van alles een gesprek voeren en actuele informatie opzoeken.

## Wat kan hij?

- **Luistert naar "Jarvis"**: zeg bijvoorbeeld *"Jarvis, hoe laat is het?"* of eerst *"Jarvis"*, en dan je vraag.
- **Praat terug** in het Nederlands (met een stem die je zelf kunt kiezen).
- **Vrije gesprekken** via Claude: vragen, uitleg, ideeën, en actuele zaken zoals nieuws en sport (met webzoeken).
- **Ingebouwde opdrachten** (werken ook zonder AI-sleutel):
  - *"Hoe laat is het?"*, *"Welke dag is het?"*
  - *"Wat is het weer?"*
  - *"Zet een timer van 5 minuten"*, *"Annuleer de timers"*
  - *"Open YouTube"*, *"Open nu.nl"*, *"Speel Doe Maar af op YouTube"*, *"Google naar pannenkoekenrecept"*
  - *"Wis je geheugen"*, *"Stop"*, *"Stop met luisteren"* / *"Luister weer"*
- **HUD-interface**: animerende "reactor" die reageert op je stem, klok, weer, systeemstatus en een gesprekslog.

## Installeren

1. Installeer [Node.js](https://nodejs.org) (versie 20 of nieuwer).
2. Download deze map en open een terminal erin.
3. Installeer de onderdelen:
   ```bash
   npm install
   ```
4. Maak een API-sleutel aan op <https://console.anthropic.com> (voor het slimme brein).
5. Kopieer `.env.example` naar `.env` en vul je sleutel in:
   ```
   ANTHROPIC_API_KEY=sk-ant-...
   JARVIS_USER_NAME=meneer
   ```
   Met `JARVIS_USER_NAME` bepaal je hoe Jarvis jou aanspreekt (bijv. `Django` of `baas`).
6. Start Jarvis:
   ```bash
   npm start
   ```
7. Open **http://localhost:3000** in **Google Chrome** of **Microsoft Edge**, klik op
   **SYSTEEM ACTIVEREN** en sta het gebruik van de microfoon toe.

> Zonder API-sleutel start Jarvis in *basismodus*: de ingebouwde opdrachten werken dan wel,
> vrije gesprekken niet.

## Bediening

| Actie | Hoe |
|---|---|
| Iets vragen | Zeg **"Jarvis …"**, klik op de microfoon, of druk op de **spatiebalk** |
| Typen | Gebruik het tekstvak onderaan |
| Jarvis onderbreken | Klik op de microfoon, druk op **Esc** of zeg **"stop"** |
| Stem, snelheid, toonhoogte | Tandwiel ⚙ rechtsboven |

## Tips

- **Mooiere stem**: in Microsoft Edge zitten zeer natuurlijke Nederlandse stemmen
  (bijv. *Microsoft Maarten Online (Natural)*). Kies die via ⚙.
- **Websites openen met je stem**: de browser blokkeert soms pop-ups. Sta pop-ups toe voor
  `localhost`, of klik op de link die Jarvis dan in het logboek zet.
- **Weer**: gebruikt je locatie (als je toestemming geeft), anders Amsterdam.
- Spraakherkenning in Chrome/Edge gebruikt een internetverbinding.

## Kosten

De AI-kern gebruikt het model `claude-opus-5-5` via de Anthropic API; je betaalt per gebruik
op je eigen API-account. Jarvis is ingesteld op korte, gesproken antwoorden, dus een gesprek kost
doorgaans maar een fractie van een cent per vraag (webzoekopdrachten kosten iets extra).

## Bestanden

- `server.js` — kleine lokale server; praat met Claude en houdt je API-sleutel buiten de browser.
- `public/index.html`, `public/style.css` — de HUD-interface.
- `public/app.js` — spraakherkenning, spraak, opdrachten, weer, systeempanelen en de reactor-animatie.
