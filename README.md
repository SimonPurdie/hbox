# HBOX

HBOX, short for Hitbutton Omni Executor, is a local Windows web hub for
organising and launching personal folders and projects. This first vertical
slice registers Windows and WSL folders, searches them by name or tag, and
opens them in Explorer or Windows Terminal.

## Run

HBOX requires Node.js 24 or newer and is intended to run from Windows:

```powershell
npm install
npm start
```

Open <http://127.0.0.1:4269>. HBOX does not install startup integration or open
the browser automatically. `npm start` performs a fresh production build before
starting the server.

Registered locations and last-known display metadata are stored in
`%LOCALAPPDATA%\HBOX`. The registry is local to the machine.

## Entry metadata

A registered folder can contain `.hbox/entry.json`:

```json
{
  "name": "My project",
  "tags": ["code", "tool"],
  "defaultAction": "terminal"
}
```

All fields are optional. `defaultAction` can be `folder` or `terminal`. A custom
`.hbox/icon.svg` takes precedence over a built-in tag icon.

Built-in tag icons use this global priority, regardless of the order of an
Entry's tags:

1. `agent`
2. `app`
3. `code`
4. `script`
5. `tool`
6. `web`

To add a WSL-native folder, browse to its
`\\wsl.localhost\<distribution>\...` location in the Add dialog.

## Development

```powershell
npm run dev
npm test
```

`dev` performs a fresh build and starts the server; restart it after changing
TypeScript or static assets.

The runtime application has no third-party package dependencies. TypeScript and
Node type definitions are development-only dependencies.
