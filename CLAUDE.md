# MCCC — My Claude Control Center

## PROJECT OVERVIEW
MCCC is een VOLLEDIG NIEUW project — een heropgebouwde merge van:
- **CCC** (Claude-Ecosystem-Dashboard v4.23.0) — het dashboard framework, 21 tabs, Cloudflare backend
- **Brain App** (_Brain-App v1.7.0) — data collection, analyse pipeline, Claude CLI integratie

MCCC vervangt GEEN van beide — de originele projecten blijven ONAANGERAAKT:
- `/Users/franky13m3/Projects/Claude-Ecosystem-Dashboard/` → NIET AANRAKEN
- `/Users/franky13m3/Projects/ClaudeBrainAppCLI/_Brain-App/` → NIET AANRAKEN

De code in `BRAIN-APP-REFERENCE/` is een READ-ONLY kopie als referentie.

## CRITICAL RULES
1. **NOOIT de originele CCC of Brain App projecten wijzigen** — alleen MCCC bewerken
2. **NOOIT bestaande werkende code/interfaces verwijderen** — "Great" = BEHOUDEN. Alleen TOEVOEGEN.
3. **ALTIJD backup maken VOOR elke code aanpassing** — Format: `BACKUPS/backup-vX.X.X-YYYYMMDD-HHMM/`
4. **Git commit na elke werkende versie**
5. **Versienummer verhogen bij elke update** — Start op v5.0.0 (MCCC era)
6. **GEEN muziek referenties** — dit is SOFTWARE DEVELOPMENT
7. **Test op iPhone Safari** — DS gebruikt dit onderweg, responsive is KRITIEK
8. **Behoud DeviceContext** — isPhone prop drilling is geëlimineerd via Context
9. **Moet ONLINE werken** — deployed op Cloudflare Pages als `my-claude-control-center.pages.dev`
10. **Moet werken op GSM** — iPhone Safari is primair gebruik

## BUILD APPROACH
### Fase 1: CCC overnemen (EERST)
- Alle 21 tabs 1-op-1 overnemen van CCC v4.23.0
- Worker API volledig overnemen
- DumpBar met cloud sync overnemen
- Verifiëren dat ALLES werkt op localhost EN op Cloudflare Pages
- Versie header updaten naar "MCCC v5.0.0"
- Worker API endpoint: nieuw Cloudflare Workers project aanmaken voor MCCC

### Fase 2: Brain App sterktes incorporeren (DAARNA)
Analyseer BRAIN-APP-REFERENCE/main.js en selecteer de features die waardevol zijn:

**Brain App sterktes om te incorporeren:**
1. **Video Analysis Pipeline**: YouTube URL → download → chunk → AI analyse → structured output
2. **Document Analysis**: Files uploaden → AI categorisatie → gestructureerde insights
3. **Auto-categorisatie**: Content automatisch taggen (fact/pattern/learning/skill/decision)
4. **Claude CLI Integration**: Agents spawnen, live output streaming
5. **Obsidian Export**: Geanalyseerde data naar markdown exporteren
6. **Backup System**: Automatische versie backups

**Nieuwe tabs/features voor MCCC:**
1. **🧠 Brain Tab** — Data collection + auto-categorisatie via Cloudflare Worker
2. **📡 Claude Intelligence Feed** — Elke 24u checken wat nieuw is bij Claude/Anthropic
3. **🧠 Brain inside Dump** — Dump tab verrijken met intelligente categorisatie
4. **🔧 Claude Features Tab** — Alle Claude capabilities in één overzicht

## TECH STACK
- **Frontend**: React 18 + Vite 5 (single App.jsx file)
- **Backend**: Cloudflare Worker met KV storage
- **Deployment**: Cloudflare Pages → `my-claude-control-center.pages.dev`
- **Development**: Claude Code CLI vanuit `/Users/franky13m3/Projects/MCCC/`

## CURRENT CCC TABS (alle 21 overnemen)
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

## FILE STRUCTURE
```
MCCC/
├── CLAUDE.md              ← Dit bestand (projectcontext voor Claude Code CLI)
├── README.md              ← Project documentatie
├── .gitignore
├── index.html             ← Vite entry point
├── vite.config.js         ← Vite configuratie
├── package.json           ← Dependencies (v5.0.0)
├── src/
│   ├── App.jsx            ← HELE dashboard (single file, ~5664 regels)
│   └── main.jsx           ← React entry
├── worker/
│   ├── index.js           ← Cloudflare Worker API
│   └── wrangler.toml      ← Worker config
├── LEARNINGS/             ← Project learnings (6 markdown files)
├── BRAIN-APP-REFERENCE/   ← READ-ONLY Brain App code als referentie
│   ├── main.js            ← Electron main process (2828 regels)
│   ├── preload.js         ← IPC bridge
│   └── renderer/          ← Frontend HTML
└── BACKUPS/               ← Versie backups voor elke wijziging
```

## CLOUDFLARE SETUP
### Pages (nieuw project aanmaken)
- Project naam: `my-claude-control-center`
- Build command: `npm run build`
- Output dir: `dist`
- Link aan GitHub repo: DS2036/MCCC

### Worker (nieuw of hergebruik)
- Huidige endpoint: `claude-control-center.franky-f29.workers.dev`
- KV Namespaces nodig: logs, snapshots, dump items
- WORKER_API constant in App.jsx moet updaten naar nieuwe endpoint

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
- Donker thema (lichter dan #0a0a0a, niet te donker)
- Kleurcodes: groen=OK, oranje=warn, rood=error, blauw=info, paars=pending
- iPhone-first responsive design
- Collapsible secties met datum-metadata
- DumpBar altijd zichtbaar (floating)
- DeviceContext voor phone/desktop detection

## GIT WORKFLOW
```bash
git add -A
git commit -m "MCCC vX.X.X - [beschrijving]"
git push origin main
```

## PRIORITEIT
1. ✅ Project opgezet, git init, GitHub repo aangemaakt
2. → Fase 1: CCC 100% werkend onder MCCC naam + Cloudflare deploy
3. → Fase 2: Brain App features incorporeren
4. → Fase 3: Claude Intelligence Feed (24u auto-updates)
