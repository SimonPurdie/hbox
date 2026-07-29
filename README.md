# HBOX

HBOX, short for Hitbutton Omni Executor, is a local Windows web hub for
personal tools, scripts, apps, agent environments, and development projects.
It gives each project a small desktop-style Entry. An Entry can open its
folder, open the correct terminal, or start a project-defined process.

## Design context

HBOX runs on one trusted personal machine. It trusts registered folders and
their project metadata. It is not a sandbox for unknown code.

Each Entry has one canonical Windows or WSL folder. A project can keep portable
HBOX metadata in its own `.hbox` folder. Machine-specific registration and
runtime state stay in `%LOCALAPPDATA%\HBOX`.

The interface uses familiar desktop objects and a small number of controls.
New controls, panels, and status information must have a clear purpose. They
require explicit approval before they are added.

HBOX does not hide a registered Entry when its folder is missing. It keeps the
last known presentation, dims the Entry, and rejects its actions.

Tags support search and built-in icon selection. The order of tags in one
Entry has no meaning. HBOX uses one global icon priority instead.

Process Sessions can continue across an HBOX restart. HBOX checks persisted
process identity before it sends a stop signal. If it cannot confirm identity,
it keeps the Session visible and disables unsafe actions.

Development usually occurs in WSL, but the application runs with Windows Node.
Changes must work with paths, commands, and executable files in both
environments.

The versioned agent skill in `skills/hbox-integration` defines the portable
project contract and the workflow for verification and registration.
