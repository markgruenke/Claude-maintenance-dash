# Running it with no admin rights (portable Node.js)

Your work PC won't let you *install* Node.js without IT approval. That's fine —
you don't have to install anything. Node.js also comes as a plain **ZIP** that
you just unzip into a folder and run. No installer, no admin, nothing written to
Program Files or the registry.

## Steps

1. **Download the ZIP build** (not the installer):
   - Go to <https://nodejs.org/en/download>
   - Choose **Windows**, and pick the **`.zip`** download (labeled a *binary*
     or *standalone* — it is **not** the `.msi` installer).
   - You'll get a file like `node-v22.x.x-win-x64.zip`.

2. **Unzip it.** Right-click the downloaded file ▸ **Extract All**. You'll get a
   folder like `node-v22.x.x-win-x64` containing `node.exe` (plus some other
   files).

3. **Put it next to the dashboard.** Inside your `MaintenanceDashboard` folder,
   make a new folder named exactly **`node`**, and copy **`node.exe`** into it.
   You should end up with:

   ```
   MaintenanceDashboard\
     node\
       node.exe          <-- this is what matters
     start-dashboard.bat
     open-dashboard.bat
     server.js
     ...
   ```

   (Copying the whole extracted folder's contents into `node\` is fine too — the
   dashboard only needs `node\node.exe`.)

4. **Run it.** Double-click `create-desktop-icon.bat` to make the desktop icon,
   then double-click the **Maintenance Dashboard** icon. The launcher finds
   `node\node.exe` automatically — you're done.

That's it. Everything else in [windows-setup.md](windows-setup.md) works the
same; the dashboard just uses this local copy of Node instead of an installed
one.

## If even the ZIP is blocked

Some companies use application whitelisting (AppLocker / “only approved programs
may run”), which can stop `node.exe` from running even out of a folder. If you
double-click `start-dashboard.bat` and Windows says the program is blocked by
policy, that's this. Two options:

- **Ask IT to approve it** — usually an easy yes. A short note you can send:

  > I'd like to run a small internal maintenance-tracking tool on the shop PC.
  > It uses **Node.js** (the standard, widely-used JavaScript runtime from
  > nodejs.org) as a local web server — it only listens on this PC and the shop
  > network, makes no outside connections, and stores its data in a single local
  > file. Could you approve installing Node.js LTS, or allow running the portable
  > `node.exe`?

- **No-runtime version.** There's a fallback that needs *nothing* installed —
  it runs entirely inside the web browser and saves data in the browser itself.
  It's more limited (data lives on that one PC, in that one browser), but it
  works with zero approvals. Ask and it can be set up.
