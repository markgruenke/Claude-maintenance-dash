# Running the dashboard always-on, on a Windows shop computer

Goal: the dashboard runs by itself on one shop PC, starts back up whenever
that PC reboots, and any computer on the shop network can open it in a
browser. Do this once on the shop computer.

## 1. Get Node.js (one time)

Download the **LTS** installer from <https://nodejs.org> and run it with the
default options. That's the only thing this app needs — no database, no other
software. Verify it worked: open **Command Prompt** and type `node --version`
— you should see a version number.

> **No admin rights on the work PC?** You don't have to install anything — Node
> also comes as a plain ZIP you unzip into a `node` folder next to the scripts,
> and the launcher finds it automatically. See
> [no-admin-node.md](no-admin-node.md).

## 2. Get the files onto the shop PC (one time)

**Easiest — download a ZIP (no Git needed):**
1. On the shop PC, go to the project's GitHub page while signed in.
2. Switch to the branch **`claude/maintenance-dashboard-wx0eue`**.
3. Click **Code ▸ Download ZIP**, then unzip it somewhere permanent, e.g.
   `C:\MaintenanceDashboard`.

**Or with Git**, if it's installed:
```
git clone -b claude/maintenance-dashboard-wx0eue https://github.com/markgruenke/Claude-maintenance-dash.git C:\MaintenanceDashboard
```

Once the files are on the shop PC, GitHub is no longer involved in running it —
everything runs locally from that folder. (You only need GitHub again if you
want to pull a future update.)

## 3. Try it out

Double-click **`start-dashboard.bat`**. A black window opens and shows a
"running" banner. Open a browser to <http://localhost:3000>.

Want to see it full of example data first?
Open Command Prompt in the folder and run `node scripts\seed.js`, then refresh.
When you're ready to track *real* work, wipe the demo data with
`node scripts\seed.js --clear`.

Closing the black window stops the dashboard. That's fine for testing — the
next steps make it easy to open and keep it running on its own.

## 4. Put an icon on the desktop

Double-click **`create-desktop-icon.bat`** once. It drops a **Maintenance
Dashboard** icon on the desktop. From then on, just **double-click that icon**
to open the dashboard — it starts the server if it isn't already running and
opens your browser to it. No admin rights needed, and it never launches a
second copy.

That icon is all most people need day to day. Step 5 is only if you also want
it to come back automatically after a reboot with nobody logging in.

## 5. (Optional) Make it start automatically after every reboot

Right-click **`install-autostart.bat`** and choose **Run as administrator**.
That does three things:
- registers the dashboard to launch every time the PC boots (even before
  anyone logs in),
- opens firewall port 3000 so other shop computers can view it,
- starts it right now.

The launcher also **restarts the server automatically** if it ever crashes, so
it stays up on its own.

To undo all of that later, right-click **`uninstall-autostart.bat`** ▸ Run as
administrator. Your data is never touched.

## 6. View it from other shop computers

On the shop PC, open Command Prompt and run `ipconfig`. Note the **IPv4
Address** (something like `192.168.1.50`). From any other computer on the shop
network, open `http://192.168.1.50:3000` (use your actual number). Bookmark it.

That IPv4 address is also how coworkers will reach it when you add their work
later — the app already tracks who did what, so they just start using their
own name in "Log work."

## Backing up your data

Everything you enter lives in one file: **`data\db.json`** inside the folder.
To back up, copy that file somewhere safe (a network drive, a USB stick) on a
schedule. To move the dashboard to a different PC, copy the whole folder —
`data\db.json` comes with it.

## Troubleshooting

- **`start-dashboard.bat` flashes and closes** — Node.js isn't installed or the
  PC needs a reboot after installing it. Re-run step 1.
- **Other PCs can't reach it** — re-run `install-autostart.bat` as admin (it
  adds the firewall rule), and confirm you used the shop PC's IPv4 address and
  port `:3000`.
- **Port 3000 is already in use** — set a different port. Edit
  `start-dashboard.bat` and change `set PORT=3000` to e.g. `set PORT=8080`, and
  use that port in the browser. (Re-run the autostart installer if you changed
  it, so the firewall rule matches — or just change the rule's port.)
- **See what happened** — run `start-dashboard.bat` by hand (double-click); the
  black window shows the server's messages.
