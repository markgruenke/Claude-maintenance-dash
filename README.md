# Maintenance Tracker

Track maintenance work as you do it, on a tablet, and turn it into the
reports people need:

- **End of the day:** a list of everything you did (WO#, machine, time, what was
  done, parts) to retype into Plex. Tick each one off ("Entered in Plex") as you
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

## Two ways to run it

- **Tablet only** (no server, no IT approval needed): everything runs in the
  tablet's browser and your data stays on the tablet. See
  [docs/tablet-app.md](docs/tablet-app.md).
- **Shared server** (the multi-person system): one PC runs `node server.js`,
  everyone signs in from tablets/PCs. Instructions below.

Both use the same code (`lib/`, `public/`), and a backup from the tablet can
be loaded into the server later.

## Quick start (server)

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
| **Today** (tablet) | One big **microphone** button: say what you did, it's logged. **Assigned to you**: open work orders put in on the Work Orders tab (or by email / PM), with a 🎤 **Log** button that puts the entry straight onto that order. Today's entries (time of day, machine, time spent, status, parts) with an **Entered in Plex** checkbox. Orders with no Plex WO# are numbered NO_WO#001, NO_WO#002… |
| **Work Orders** | Every order with filters (open / in progress / waiting parts / overdue / completed), search, and a detail view to edit everything, add parts and notes, see full history. **Yesterday / This weekend / Last weekend** boxes at the top show just the orders worked on (or created, finished, due) then; weekends are Fri–Sun |
| **Parts** | Need to order → on order → received → installed. **Copy order list** for purchasing |
| **Reports** | *Work list* (end of day) and *Handoff report* for Today, Yesterday, Fri–Sun, Sat–Sun, last 7 days or any dates, for everyone or one person |
| **Schedule** | Due dates (overdue / today / next 7 days), workload per person, PM schedules |
| **Dashboard** | Hours and work orders per machine, weekly trend, attention flags (machines breaking down often, repeat issues, stale orders, parts not ordered) |
| **Team** | Accounts and PINs, machines list, backup download (supervisor) |

### Logging work (the tablet flow)

Tap the mic and talk, the way you'd tell a coworker:

> "Press two, replaced the drive belt, about an hour and a half, parts used
> drive belt, parts needed belt guard."

Tap again (or just stop talking) and it's saved: **Press 2 · 1.5 h · waiting
on parts**, with *drive belt* used and *belt guard* added to the parts list.
**Undo** is on the confirmation if it misheard; **Edit** fixes any entry later.

What it picks up from what you say (all optional):
- **Machine**: names it already knows ("CNC three", "cnc3" → CNC 3), or
  things like "press 4", "line 3", "robot cell 2" (added automatically).
- **Time spent**: "45 minutes", "an hour and a half", "a couple hours". No
  time said is fine; the entry just has no duration.
- **Company WO#**: "work order 10288", only if you say one.
- **Parts used / parts needed**: only what follows the words **"parts
  used"** or **"parts needed"** ("part used", "part needed", "needed parts"
  work too), e.g. "parts used drive belt and two clamps, parts needed seal
  kit". A list ends at the end of the sentence or when you move on ("…,
  about an hour", "…, back up and running", or the other parts phrase). A
  leading number is the quantity. Without the phrase nothing is added, so
  "replaced the guard" or "need to check the wiring" never creates a part.
- **Status**: listing parts needed or "waiting on parts" = waiting on parts;
  "still / not fixed / coming back / need to order" = still open; otherwise
  it counts as done.

Behind the scenes each entry is attached to a job: the WO# you said, an open
job on that machine about the same thing ("hydraulic", "coolant"…), or a new
job made for it. You never fill in work-order forms; the jobs are what feed the
"still open" and "parts" parts of the weekend report.

**About the mic button:** browsers only allow speech recognition on a secure
(`https://`) page or on the PC itself (`localhost`). On the shop Wi-Fi address
(`http://192.168…`) the big button falls back to your **keyboard's
microphone key**, which works anywhere: tap the box, tap the keyboard 🎤, talk,
tap Save. Once it's online with HTTPS ([docs/going-online.md](docs/going-online.md)),
the big button works directly. Chrome's built-in recognition sends audio to
Google to transcribe, so it needs internet; the keyboard mic depends on the
keyboard's own settings.

**Photos.** Tap **📷 Photo** next to Save (camera or photo library), then talk
or type as usual: the photos go on that entry as "work done". Each entry also
has a 📷 button to add one later. On a work order, **📷 Add photo** asks what
it shows first: **Work done**, **Needs doing** or **Part needed**. Tap any
thumbnail for full size, to change what it shows, add a caption (e.g. a part
number) or delete it. Photos are shrunk on the device (longest side 1600 px,
a few hundred KB) and are included in backups.

**Detailed entry** (all fields as a form) and **Paste notes** are still there
for when you want them.

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
lib/api.js           the API logic, shared by server and tablet
scripts/build-tablet.js  builds tablet/ (the no-server tablet app)
tablet/              generated tablet app (static files, host anywhere)
public/local/        tablet-only pieces: engine glue, boot, service worker
test/                API + tablet tests (node --test)
docs/                Windows setup, no-admin Node, email, going online
```

## API (all JSON, sign-in cookie required)

| Endpoint | |
|---|---|
| `GET /api/auth/status`, `POST /api/auth/setup|login|logout` | accounts |
| `GET /api/bootstrap` | machines, people, enums for the UI |
| `GET/POST /api/work-logs`, `PATCH/DELETE /api/work-logs/:id` | work entries (DELETE also removes parts and a job the entry created) |
| `GET/POST /api/work-orders`, `GET/PATCH/DELETE /api/work-orders/:id`, `POST …/:id/notes` | work orders |
| `GET/POST /api/parts`, `PATCH/DELETE /api/parts/:id` | parts |
| `GET/POST /api/pm`, `PATCH/DELETE /api/pm/:id`, `POST /api/pm/run` | preventive maintenance |
| `GET /api/reports?from&to&technician&tz`, `PUT /api/reports/notes` | reports |
| `GET/POST /api/users`, `PATCH /api/users/:id` | people (supervisor) |
| `POST /api/ingest/email` | work order from an email; also accepts `X-Ingest-Token` without sign-in when `INGEST_TOKEN` is set |
| `POST /api/ingest/notes[/preview]` | voice / typed / pasted entries (`{text, date, clientId, source}`) |
| `GET /api/dashboard`, `GET /api/export`, `POST /api/import` | analytics, backup download, restore a backup |

Environment: `PORT`, `DATA_DIR`, `TZ`, `INGEST_TOKEN`, `SECURE_COOKIES`,
`TRUST_PROXY`. See [docs/going-online.md](docs/going-online.md).
