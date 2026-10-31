# Going online later (the "main system")

**Nothing here is needed yet.** While you're setting things up, run the
tracker on one shop PC (or your laptop) and open it from your tablet over the
shop Wi-Fi. This page is the plan for when you want it reachable from
anywhere, by everyone.

## Stage 1 — now: one PC, your tablet on the same Wi-Fi

1. Run it on the shop PC ([windows-setup.md](windows-setup.md)).
2. Find that PC's address (`ipconfig` → IPv4, e.g. `192.168.1.50`).
3. On the tablet, open `http://192.168.1.50:3000` and sign in.
4. Use the browser's **Add to Home Screen** so it opens like an app.

If the Wi-Fi drops while you're logging work, the entry is kept on the tablet
and sent automatically when the connection is back (a yellow bar shows how many
are waiting).

You act as everyone: you're the supervisor, and the **Logging as** picker on
the Today screen lets you log work for any technician. Add pretend techs under
**Team** to try the multi-person views (Schedule → Workload, report filters).

## Stage 2 — before going online: talk to IT

This holds company maintenance data. Before it's reachable from outside the
building, ask IT/your supervisor. They may already have a server or a
preferred way to do it, and some companies forbid running services on shop
PCs or sending data to outside hosts. Their answer picks the option below.

## Stage 3 — pick one way to put it online

| Option | What it is | Good when |
|---|---|---|
| **A. IT hosts it** | IT runs `node server.js` on a company server; reachable on the company network/VPN | Best for company data, if IT agrees |
| **B. Tunnel from the shop PC** | Cloudflare Tunnel: the PC makes an *outbound* connection, Cloudflare gives it an `https://` address. No ports opened on the shop network | It should stay on the shop PC but be reachable from anywhere |
| **C. Small cloud server** | A rented Linux VM running the tracker behind Caddy (automatic HTTPS) | You want it off company hardware entirely (needs IT's OK) |

A private-network tool such as Tailscale is another route: only devices you
sign into your private network can reach the PC at all. Note its free
*Personal* plan is described by Tailscale as non-commercial, so a business
setup needs a paid plan. Check current terms before choosing.

Cloudflare's free "Quick Tunnel" (`cloudflared tunnel --url http://localhost:3000`)
is fine for a **test** only: Cloudflare says it's for testing, the address
changes every time it restarts, and there's no uptime guarantee. For real use,
create a named tunnel on a Cloudflare account with your own domain.

## Settings checklist when it's online

Set these environment variables wherever the server runs:

| Setting | Why |
|---|---|
| `SECURE_COOKIES=1` | Sign-in cookie only sent over HTTPS |
| `TRUST_PROXY=1` | Only behind a tunnel/proxy (B or C). It makes the wrong-PIN lockout see each person's real address instead of the proxy's. **Don't set it** when the server is reached directly |
| `TZ=America/Chicago` (your zone) | Cloud servers usually run on UTC; this keeps "today", PM due dates, and daily backups on shop time |
| `INGEST_TOKEN=<long random string>` | Only if you set up email forwarding ([email-setup.md](email-setup.md)) |

And:

- **Never expose plain `http://` to the internet.** Options B and C both give
  you HTTPS. Without it, PINs cross the network readable.
- Supervisor password: 8+ characters (enforced). Give technicians **6+ digit
  PINs** once it's online (4 is the minimum). Five wrong tries locks a name for
  15 minutes.
- Turn off anyone who leaves: **Team → Edit → Deactivated** signs them out
  everywhere immediately.
- Backups: the server keeps 30 days of daily copies in `data/backups/`, but
  that's on the same machine. Regularly copy `data/` somewhere else too (or use
  **Team → Download backup**).

## Growing past one file

All data lives in `data/db.json`, which is fine for a department (thousands of
work orders). If it ever needs a real database, `lib/store.js` is the only file
that touches storage. The API and screens don't change.

Sources checked for this page (Oct 2026): Cloudflare's Quick Tunnels docs
(developers.cloudflare.com/tunnel/get-started/quick-tunnels/) and Tailscale's
pricing FAQ (tailscale.com/kb/1251/pricing-faq). Plans and terms change; check
them again when you're ready.
