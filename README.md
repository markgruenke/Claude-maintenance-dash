# Maintenance Dashboard

A self-hosted dashboard for tracking maintenance work: open work orders,
time spent per machine, parts needed, and automatic "this machine keeps
breaking" flags. Built to start as a one-person tool and grow into a team
one — every record already carries a technician field, so adding coworkers
later is just them picking a name.

**Zero dependencies.** Everything runs on plain Node.js — no `npm install`,
no build step, no database server. Data lives in a single `data/db.json`
file you can back up by copying.

## Quick start

```bash
node server.js
# open http://localhost:3000
```

Want to see it populated first? Seed demo data, poke around, then wipe it:

```bash
node scripts/seed.js          # fake machines/orders/parts so charts render
node server.js
node scripts/seed.js --clear  # start fresh for real use
```

Runs anywhere Node ≥ 18 runs — a spare PC in the shop, a Raspberry Pi, a
work laptop. `PORT=8080 node server.js` to change the port.

**Running it always-on on a Windows shop computer?** Double-click
`start-dashboard.bat` to run it, or right-click `install-autostart.bat` ▸ Run
as administrator to have it start on every boot and stay up on its own. Full
walkthrough (including viewing it from other shop PCs and backing up your data)
in [docs/windows-setup.md](docs/windows-setup.md).

## What it does

- **Work orders** — from three sources: typed in manually, pasted from a
  Plex notification email (the parser pulls out the WO#, machine, and
  priority), or posted automatically by an email forwarder
  (see [docs/email-setup.md](docs/email-setup.md)).
- **Log work from your notes** — hit **Log work**, paste the note you
  already wrote in chat ("Spent 2 hrs on CNC 3, replaced the spindle belt,
  need to order a coolant pump"), and it extracts the machine, time spent,
  parts used, and parts needed. You get a preview to correct before it
  saves. The note attaches to the machine's open work order (or opens one),
  logs the time, files the parts, and updates the order status when the note
  says it's fixed or waiting on parts.
- **Parts tracking** — needed → ordered → received → installed, changed
  right in the table.
- **Analytics that watch your back** (computed live, nothing to maintain):
  - hours logged per machine
  - work orders per machine (who breaks down the most)
  - work orders per week trend
  - **attention flags**: a machine with 3+ orders in 30 days, the same
    issue recurring on one machine, an order sitting open 14+ days, a part
    stuck on "needed" 7+ days. Thresholds live in `lib/analytics.js`
    (`FLAG_RULES`) — tune to taste.
- **Filters** — date range, machine, technician; every number and chart on
  the page follows the same filter. Dark mode follows your system setting.

## How data flows

```
Plex email ──(forwarder or paste)──▶ POST /api/ingest/email ──▶ work order
chat notes ──(paste into Log work)─▶ POST /api/ingest/notes ──▶ work log
                                                              + parts used/needed
                                                              + order status update
                    dashboard reads GET /api/dashboard ◀── flags & stats derived live
```

## Project layout

```
server.js                 HTTP server + REST API (plain Node, no deps)
lib/store.js              JSON-file data store (swap for SQLite later; API is the contract)
lib/parser.js             email + notes text parsers
lib/analytics.js          per-machine stats, trends, attention flags (FLAG_RULES)
public/                   the dashboard (vanilla JS + hand-built SVG charts)
scripts/seed.js           demo data in / out
scripts/email-poller.js   optional IMAP watcher (the only thing needing npm packages)
docs/email-setup.md       three ways to get emails in automatically
data/db.json              your data (created on first write; gitignored)
```

## API

All JSON. The interesting ones:

| Endpoint | What it does |
|---|---|
| `GET /api/dashboard?from&to&machineId&technician` | everything the UI shows, one call |
| `POST /api/ingest/email` | `{subject, body}` → parsed → work order (idempotent by WO#) |
| `POST /api/ingest/notes/preview` | `{text}` → what the parser found, writes nothing |
| `POST /api/ingest/notes` | `{text, technician, date}` → work log + parts + status |
| `POST/PATCH /api/work-orders[/:id]` | create / update orders |
| `POST/PATCH /api/parts[/:id]` | create / update parts |
| `POST /api/work-logs`, `POST /api/machines` | manual entry |

Set `INGEST_TOKEN=secret` when starting the server to require an
`X-Ingest-Token` header on the ingest endpoints (do this before pointing an
email forwarder at it).

## Growing it later

- **More technicians:** they just use their name in "Log work" — the
  technician filter picks them up automatically.
- **Projects, PMs, downtime cost:** add a collection in `lib/store.js`, a
  route in `server.js`, a card in `public/` — each layer is a small plain
  file.
- **Real database:** `lib/store.js` is the only file that knows data lives
  in JSON; port those functions to SQLite/Postgres when the team outgrows a
  file.
