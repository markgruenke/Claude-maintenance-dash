# Tablet-only version (no server, no IT)

The `tablet/` folder is the tracker as a self-contained web app that runs
entirely in your tablet's browser:

- **Your data stays on the tablet**, in the browser's built-in database
  (IndexedDB). Nothing you log is sent anywhere.
- **Works offline** once it has been opened once (it keeps its own copy of the
  app's files).
- **Opens like an app** from a home-screen icon.
- **Same features** as the server version: voice/typed entries, end-of-day
  list with "Entered" checkboxes, weekend handoff report, parts, PM schedule,
  dashboard. Just no accounts: it's your log.
- **The big mic button works** (the page is served over https). Chrome's
  speech recognition sends audio to Google to transcribe, so it needs a
  connection; offline, use the keyboard's mic key.

## How it gets onto the tablet

The app's *files* have to be downloaded from a web address once (after that
they're cached on the tablet). That needs a free static web host that serves
`https://`. Your *data* never goes to that host.

Options (pick one):

| Option | What you do | Notes |
|---|---|---|
| **GitHub Pages** | Make this repo public, then Settings → Pages | Free. Only the app's code becomes public, never your data. GitHub's free plan only publishes Pages from public repos |
| **GitHub Pages, repo stays private** | Upgrade to GitHub Pro, then Settings → Pages | Paid plan |
| **Netlify or Cloudflare Pages** | Free account, connect this repo (it can stay private), publish folder `tablet` | Works from a home computer's browser; nothing to install |

## Using it

1. Open the address on the tablet in **Chrome** (Android) or **Safari** (iPad).
2. Enter your name.
3. **Add it to the home screen** (Chrome menu → *Add to Home screen*; Safari
   Share → *Add to Home Screen*) and from then on open it from that icon.
   Browsers are much less likely to clear data for home-screen apps.

## Keep backups

The log lives only on the tablet. If the tablet is lost, reset, or someone
clears the browser's site data, the log is gone. So:

- **Settings → Save backup file** (or **Send backup** to email it to yourself
  or put it in Drive). Today reminds you when it's been a week.
- **Settings → Restore from a backup** loads a backup file, e.g. onto a new
  tablet.
- The same backup file can later be loaded into the shared server version
  (Team → Restore) when IT approves it, so nothing you log now is wasted.

## Updating

When a new version is published, the tablet picks it up automatically the
next time the app is opened with a connection (and uses it from the launch
after that). Your data isn't touched by updates.

## For developers

`tablet/` is generated. After changing anything in `lib/` or `public/`, run:

```bash
node scripts/build-tablet.js
```

and commit `tablet/`. (`node --test` fails if you forget.) The build bundles
the same `lib/*.js` the server uses, with `public/local/engine-glue.js`
answering the app's `/api/...` calls in-process and storing data in IndexedDB.
To try it locally, serve the folder over http on localhost, e.g.
`cd tablet && python3 -m http.server 4100`, and open http://localhost:4100.
