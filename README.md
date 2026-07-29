# HBOX

HBOX, short for Hitbutton Omni Executor, is a local Windows web hub for
organising and launching personal folders and projects. It registers Windows
and WSL folders, searches them by name or tag, opens them in Explorer or
Windows Terminal, and manages project-defined WSL process Sessions.

## Run

HBOX requires Node.js 24 or newer and is intended to run from Windows:

```powershell
npm install
npm start
```

Open <http://127.0.0.1:4269>. HBOX does not install startup integration or open
the browser automatically. `npm start` performs a fresh production build before
starting the server.

The Config menu can rebuild and restart the running server without access to
its original terminal. Running project Sessions persist through this restart.

Right-click an Entry and select **Manage Entry** to view its location, metadata,
and other diagnostics. **Remove Entry** unregisters it from HBOX without
changing the folder or its `.hbox` contents.

Use **Pin to top** in an Entry's context menu to add it to the ordered Pinned
section. Pinned Entries remain in All and can be dragged within Pinned to
change their order.

Registered locations and last-known display metadata are stored in
`%LOCALAPPDATA%\HBOX`. The registry is local to the machine.

## Entry metadata

A registered folder can contain `.hbox/entry.json`:

```json
{
  "name": "My project",
  "tags": ["desktop", "git"],
  "defaultAction": "terminal"
}
```

All fields are optional. `defaultAction` can be `folder`, `terminal`, or the ID
of a declared custom action. A custom `.hbox/icon.svg` takes precedence over a
built-in tag icon.

Built-in tag icons use this global priority, regardless of the order of an
Entry's tags. Entries without a custom or applicable tag icon use the fallback
icon.

1. `agent`
2. `gamedev`
3. `browser-extension`
4. `desktop`
5. `web`
6. `script`
7. `data`

To add a WSL-native folder, browse to its
`\\wsl.localhost\<distribution>\...` location in the Add dialog.

## Process Sessions

A WSL Entry can declare an action that starts a process Session:

```json
{
  "name": "My web app",
  "tags": ["web"],
  "defaultAction": "start-app",
  "actions": {
    "start-app": {
      "label": "Start app",
      "starts": "dev-server"
    }
  },
  "sessions": {
    "dev-server": {
      "type": "process",
      "label": "Development server",
      "command": ["npm", "run", "dev"],
      "readyUrl": "http://127.0.0.1:5173",
      "openUrl": "http://127.0.0.1:5173",
      "singleInstance": true
    }
  }
}
```

The command array keeps the executable and each argument separate. HBOX starts
it from an interactive Bash environment in the Entry folder, without parsing
the array as a shell command string. This makes tools installed by WSL shell
initialisation available while preserving argument boundaries. HBOX opens
`openUrl` after `readyUrl` responds. Starting a running single-instance Session
opens its URL instead of creating a duplicate.

The Sessions button opens the bottom pane. Clean stops disappear. Failed or
disconnected Sessions remain until they are restarted or forgotten. HBOX
verifies the WSL boot, process start time, process group, and Session token
before it sends a stop signal. If it cannot verify that identity, it marks the
Session as disconnected and disables destructive actions.

Process commands must remain in the foreground. Programs that detach themselves
need a different Session type and are not supported by this first
implementation.

## Development

```powershell
npm run dev
npm test
```

`dev` performs a fresh build and starts the server; restart it after changing
TypeScript or static assets.

The runtime application has no third-party package dependencies. TypeScript and
Node type definitions are development-only dependencies.
