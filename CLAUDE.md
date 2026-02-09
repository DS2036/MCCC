# MCCC — My Claude Control Center

## PROJECT OVERVIEW
MCCC is de evolutie van Claude-Ecosystem-Dashboard (CCC v4.23.0), samengevoegd met de sterke features van _Brain App v1.7.0. Het is DS2036's persoonlijk command center voor zijn hele AI/development ecosysteem.

## CRITICAL RULES
1. **NOOIT bestaande werkende code/interfaces verwijderen** — "Great" = BEHOUDEN. Alleen TOEVOEGEN.
2. **ALTIJD backup maken VOOR elke code aanpassing** — Format: `BACKUPS/backup-vX.X.X-YYYYMMDD-HHMM/`
3. **Git commit na elke werkende versie**
4. **Versienummer verhogen bij elke update** — Start op v5.0.0 (MCCC era)
5. **GEEN muziek referenties** — dit is SOFTWARE DEVELOPMENT
6. **Test op iPhone Safari** — DS gebruikt dit onderweg, responsive is KRITIEK
7. **Behoud DeviceContext** — isPhone prop drilling is geëlimineerd via Context

## TECH STACK
- **Frontend**: React 18 + Vite 5 (single App.jsx file, ~5664 regels)
- **Backend**: Cloudflare Worker (worker/index.js) met KV storage
- **Deployment**: Cloudflare Pages → `my-claude-control-center.pages.dev`
- **API endpoint**: Worker op `claude-control-center.franky-f29.workers.dev` (hernoemd naar MCCC)

## CURRENT STATE (CCC v4.23.0)
21 tabs in één App.jsx:
1. 🗺️ Ecosystem — Mind map van hele systeem
2. ⚠️ Issues — Problemen gesorteerd op ernst
3. 🧠 Memory — Memory lagen overzicht
4. 📂 Git — 29 repos status
5. 📸 Versions — Snapshots
6. 📜 Activity — Logging van alle acties
7. 🌐 Staging — Deploy status
8. 🔄 Cross-Sync — Syncthing + GitHub sync
9. 🕸️ InfraNodus — Knowledge graphs
10. 👥 Agents — Sub-agents overzicht
11. 🧠 Knowledge — Knowledge base
12. 📡 Updates — Claude updates
13. 🤖 OpenClaw — Bot monitoring
14. 🧠 SDK-HRM — Model documentatie
15. 📊 Benchmarks — Training resultaten
16. 🪙 Crypto — Intelligence hub
17. 💰 Revenue — Revenue streams
18. 🎯 Use Cases — Roadmap
19. 🧰 All Tools — Tooling overzicht
20. 🔒 GDPR Artes — Compliance
21. 🤖 Advisor — AI advisor met multi-turn chat
+ DumpBar (floating inbox met cloud sync)

## MERGE PLAN: BRAIN APP → MCCC

### Wat Brain App goed doet (BRAIN-APP-REFERENCE/main.js):
1. **Video Analysis Pipeline**: YouTube URL → download → chunk → Gemini AI analyse → structured output
2. **Document Analysis**: Files uploaden → AI categorisatie → gestructureerde insights
3. **Claude CLI Integration**: Agents spawnen vanuit de app, live output streaming
4. **Auto-categorisatie**: Content automatisch taggen (fact/pattern/learning/skill/decision)
5. **Obsidian Export**: Geanalyseerde data naar markdown exporteren
6. **Backup System**: Automatische versie backups

### Nieuwe features voor MCCC v5.0.0:
1. **🧠 Brain Tab** (NIEUW) — Data collection + auto-categorisatie
   - Input: URL, text, file upload
   - AI analyse: categoriseer als fact/pattern/learning/skill/decision
   - Opslaan in Cloudflare KV met timestamp en bron
   - Doorzoekbaar en filterbaar
   - Geïnspireerd op Brain App's analyze → split → categorize flow

2. **📡 Claude Intelligence Feed** (UPGRADE van Updates tab)
   - Elke 24u automatisch checken: wat is nieuw bij Claude/Anthropic?
   - Nieuwe features detecteren en uitleggen
   - Suggesties: "Dit zou nuttig zijn voor jouw [project X]"
   - Activeerbare features markeren
   - Changelog van Claude API, Claude.ai, Claude Code, MCP

3. **🧠 Brain inside Dump** (UPGRADE van Dump tab)
   - Bestaande Dump functionaliteit BEHOUDEN
   - Toevoegen: AI auto-categorisatie van dump items
   - Smart suggestions: "Dit lijkt op een SKILL, wil je het naar Brain?"
   - Context linking: relateer dump items aan projecten

4. **🔧 Claude Features Tab** (NIEUW)
   - Alle Claude capabilities in één overzicht
   - Per feature: beschikbaar? actief? hoe activeren?
   - MCP servers, plugins, tools, slash commands
   - Quick-activate knoppen

## FILE STRUCTURE
```
MCCC/
├── CLAUDE.md              ← Dit bestand
├── README.md              ← Project documentatie
├── index.html             ← Vite entry point
├── vite.config.js         ← Vite configuratie
├── package.json           ← Dependencies
├── src/
│   └── App.jsx            ← HELE dashboard (single file)
│   └── main.jsx           ← React entry
├── worker/
│   ├── index.js           ← Cloudflare Worker API
│   └── wrangler.toml      ← Worker config
├── LEARNINGS/             ← Project learnings markdown files
├── BRAIN-APP-REFERENCE/   ← Originele Brain App code (READ ONLY reference)
│   ├── main.js            ← Electron main process (2828 regels)
│   ├── preload.js         ← IPC bridge
│   └── renderer/          ← Frontend
└── BACKUPS/               ← Versie backups
```

## DEPLOYMENT
```bash
# Local development
npm install
npm run dev
# → http://localhost:5173

# Build voor Cloudflare Pages
npm run build
# → dist/ folder deployen

# Worker deployment
cd worker
npx wrangler deploy
```

## CLOUDFLARE PAGES RENAME
Huidige naam: claude-ecosystem-dashboard.pages.dev
Nieuwe naam: my-claude-control-center.pages.dev
→ Maak NIEUW Cloudflare Pages project aan, link aan deze repo

## WORKER API ENDPOINTS
- POST /api/log — Log een actie
- GET /api/logs?limit=N — Haal logs op
- POST /api/snapshot — Maak snapshot
- GET /api/snapshots — Haal snapshots op
- POST /api/ai — AI advisor vraag
- GET /api/dump — Haal dump items op
- POST /api/dump — Sla dump items op

## HARDWARE CONTEXT
DS heeft 3 Macs:
- **MM4**: Mac Mini M4 (hoofd development machine, 8TB externe schijf)
- **MBA**: MacBook Air M3 (mobiel, huidige machine)
- **MM2**: Mac Mini M2 (backup/secondary)

## STIJL REGELS
- Donker thema (niet te donker, lichter dan #0a0a0a)
- Kleurcodes per status: groen=OK, oranje=warn, rood=error, blauw=info, paars=pending
- iPhone-first responsive design
- Collapsible secties met datum-metadata
- DumpBar altijd zichtbaar (floating)
- GEEN bullet points in UI teksten tenzij nodig

## GIT WORKFLOW
```bash
git add -A
git commit -m "MCCC v5.0.0 - Initial merge from CCC v4.23.0 + Brain App features"
git remote add origin https://github.com/DS2036/MCCC.git
git push -u origin main
```

## PRIORITEIT VOLGORDE
1. Eerst: Bestaande CCC 100% werkend onder nieuwe naam
2. Dan: Brain Tab toevoegen
3. Dan: Claude Intelligence Feed upgraden
4. Dan: Dump verrijken met Brain AI
5. Dan: Claude Features Tab
