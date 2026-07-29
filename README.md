# Hitbutton Omni-Executor (HBOX)

HBOX is a local Windows web hub for personal tools, scripts, apps, agent environments, and development projects.

It gives each project a small desktop-style Entry. An Entry can open its folder, open the correct terminal, or start a project-defined process.

The agent skill in `skills/hbox-integration` defines the portable project contract and the workflow for verification and registration.

## Start automatically on Windows login

Run this command from the project directory in a Windows terminal:

```powershell
npm run startup:install
```

This builds HBOX and adds a hidden launcher to the current user's Startup
folder. The launcher records the current project directory and Windows Node.js
executable. The project remains portable, but after moving it, run the command
again from its new location to refresh the launcher.

To stop launching HBOX at login:

```powershell
npm run startup:uninstall
```
