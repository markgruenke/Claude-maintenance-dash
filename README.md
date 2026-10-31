# Maintenance Tracker

Track maintenance work as you do it, on a tablet, and turn it into the
reports people need:

- **End of the day:** a list of everything you did (WO#, machine, time, what was
  done, parts) to retype into the company system. Tick each one off as you
  enter it.
- **End of the weekend:** a handoff report for your supervisor and day shift:
  what got done, what's still open and where it stands, which parts are needed
  or on order, plus your notes. Copy as text, email, or print/PDF.
- **Control center** (PC or tablet): add/edit/assign work orders, due dates,
  parts, preventive-maintenance schedules, the team, and analytics.

Built to start with one person (you, playing every role) and grow to the whole
department on one shared system.

**Zero dependencies.** Plain Node.js, no `npm install`, no database server.
Data lives in `data/db.json`, with automatic daily copies in `data/backups/`.

## Quick start

```bash
node server.js
# open http://localhost:3000. The first visit creates your supervisor account.
```

On Windows, double-click `start-dashboard.bat` (or make a desktop icon with
`create-desktop-icon.bat`). See [docs/windows-setup.md](docs/windows-setup.md).

On your **tablet**, on the same Wi-Fi, open `http://<that-PC's-IP>:3000`,
sign in, and **Add to Home Screen**.

Want to look around first? Close the server, run `node scripts/seed.js`
(demo data), start it again. When you're done: close it, run
`node scripts/seed.js --clear` (wipes work data, **keeps your login**).

## The screens

| Screen | What it's for |
|---|---|
| **Today** (tablet) | Big **Log work** / **Start job timer** / **Paste notes** buttons; running timers; today's entries with an **Entered** checkbox; your open work orders |
| **Work Orders** | Every order with filters (open / in progress / waiting parts / overdue / completed), search, and a detail view to edit everything, add parts and notes, see full history |
| **Parts** | Need to order → on order → received → installed. **Copy order list** for purchasing |
| **Reports** | *Work list* (end of day) and *Handoff report* for Today, Yesterday, Fri–Sun, Sat–Sun, last 7 days or any dates, for everyone or one person |
| **Schedule** | Due dates (overdue / today / next 7 days), workload per person, PM schedules |
| **Dashboard** | Hours and work orders per machine, weekly trend, attention flags (machines breaking down often, repeat issues, stale orders, parts not ordered) |
| **Team** | Accounts and PINs, machines list, backup download (supervisor) |

### Logging work (the tablet flow)

1. **Log work** → pick the machine (recent ones are one tap) → pick its open
   job or **+ New job** → say what you did (the keyboard mic works for
   dictation) → tap a time (15m … 4h) → **Still working / Waiting on parts /
   Fixed** → parts used / needed (`belt, 2x bearing`) → Save.
2. Or **Start job timer** when you begin, then **Stop & log** when done; time
   is filled in for you.
3. Work orders, statuses and the parts list update themselves from what you log.

### People and roles

- **Supervisor**: everything, including people, PM schedules, deleting orders,
  and **logging work on anyone's behalf** ("Logging as" on Today). That's how one
  person can act as the whole crew while setting up.
- **Technician**: logs their own work, creates/updates orders and parts, sees
  everything, edits only their own entries.

## Going online later

Not needed now. When you're ready for everyone to use one shared system from
anywhere, follow [docs/going-online.md](docs/going-online.md) (talk to IT first;
three ways to do it; HTTPS and settings checklist).

## Tests

```bash
node --test
```

Runs the API end-to-end against a throwaway data folder.

## Project layout

```
server.js            HTTP server + REST API + background chores (PM, backups)
lib/store.js         JSON-file data store (the only file that touches storage)
lib/auth.js          accounts, scrypt-hashed PINs, sessions, lockout
lib/reports.js       end-of-day and handoff reports (data + plain text)
lib/pm.js            preventive maintenance → work orders
lib/parser.js        email + free-text notes parsers
lib/analytics.js     per-machine stats, trends, attention flags (FLAG_RULES)
public/              the app (vanilla JS modules, no build step)
scripts/seed.js      demo data in / out
scripts/email-poller.js  optional IMAP watcher (needs npm packages)
test/                API tests (node --test)
docs/                Windows setup, no-admin Node, email, going online
```

## API (all JSON, sign-in cookie required)

| Endpoint | |
|---|---|
| `GET /api/auth/status`, `POST /api/auth/setup|login|logout` | accounts |
| `GET /api/bootstrap` | machines, people, enums for the UI |
| `GET/POST /api/work-logs`, `PATCH/DELETE /api/work-logs/:id` | work entries (POST finds/creates the order, files parts, moves status) |
| `POST /api/work-logs/start`, `POST /api/work-logs/:id/stop` | job timer |
| `GET/POST /api/work-orders`, `GET/PATCH/DELETE /api/work-orders/:id`, `POST …/:id/notes` | work orders |
| `GET/POST /api/parts`, `PATCH/DELETE /api/parts/:id` | parts |
| `GET/POST /api/pm`, `PATCH/DELETE /api/pm/:id`, `POST /api/pm/run` | preventive maintenance |
| `GET /api/reports?from&to&technician&tz`, `PUT /api/reports/notes` | reports |
| `GET/POST /api/users`, `PATCH /api/users/:id` | people (supervisor) |
| `POST /api/ingest/email` | work order from an email; also accepts `X-Ingest-Token` without sign-in when `INGEST_TOKEN` is set |
| `POST /api/ingest/notes[/preview]` | log from pasted notes |
| `GET /api/dashboard`, `GET /api/export` | analytics, backup download |

Environment: `PORT`, `DATA_DIR`, `TZ`, `INGEST_TOKEN`, `SECURE_COOKIES`,
`TRUST_PROXY`. See [docs/going-online.md](docs/going-online.md).
