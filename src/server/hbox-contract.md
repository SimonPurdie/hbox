# HBOX project contract

## Contents

- Project files
- Entry metadata
- Tags and icons
- Actions
- Process Sessions
- Custom SVG icons
- Verification and registration

## Project files

A project can contain these portable files:

```text
.hbox/
|-- entry.json
`-- icon.svg
```

`entry.json` defines the Entry. `icon.svg` is optional. HBOX keeps
machine-specific registration outside the project.

## Entry metadata

`entry.json` must contain one JSON object. All fields are optional to the HBOX
runtime, but the integration helper requires this file.

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
      "stopCommand": ["npm", "run", "stop"],
      "readyUrl": "http://127.0.0.1:5173",
      "openUrl": "http://127.0.0.1:5173",
      "singleInstance": true
    }
  }
}
```

- `name` must be a non-empty string after trim. HBOX otherwise uses the folder
  name.
- `tags` must be an array. HBOX keeps string items, trims them, converts them
  to lowercase, removes empty values, and removes duplicates.
- `defaultAction` can be `folder`, `terminal`, or an accepted custom action ID.
  HBOX uses no default action when the value is invalid. An Entry with an
  accepted default action uses the active green folder and icon treatment.
- Unknown fields have no effect.

## Tags and icons

Tags are searchable and can describe project purpose, platform, domain, or
workflow. Keep the list short. Avoid tags that add no useful search term.

These tags have built-in icons. HBOX uses this global priority:

1. `agent`
2. `gamedev`
3. `browser-extension`
4. `desktop`
5. `web`
6. `script`
7. `data`

The order of tags in `entry.json` has no effect on icon choice. Tags outside
this list remain valid search terms. A valid custom icon takes priority over
all tag icons. HBOX uses the fallback icon when no custom or tag icon applies.

## Actions

Every Entry always has the built-in `folder` and `terminal` actions. Current
custom actions can only start declared process Sessions.

`actions` must be an object. Each key is an action ID.

- An ID must match `[a-z0-9][a-z0-9_-]*`.
- An ID cannot be `folder` or `terminal`.
- `label` must be a non-empty string after trim.
- `starts` must be the ID of an accepted Session in the same file.

HBOX omits an action when any requirement fails.

## Process Sessions

Process Sessions are available for Windows and WSL Entries. `sessions` must
be an object. Each key is a Session definition ID.

- An ID must match `[a-z0-9][a-z0-9_-]*`.
- `type` must be `process`.
- `label` must be a non-empty string after trim.
- `command` must be a non-empty array of non-empty strings.
- `stopCommand` is optional. When present, it must be a non-empty array of
  non-empty strings.
- `readyUrl` is optional. When present, it must be an HTTP or HTTPS URL.
- `openUrl` is optional. When present, it must be an HTTP or HTTPS URL.
- `singleInstance` defaults to `true`. Only the value `false` disables it.

Command arrays keep the executable and each argument separate. Do not put a
full command in one string. HBOX starts each command from the Entry folder.
WSL commands use an interactive Bash environment. Windows commands use
Windows executable search rules. HBOX resolves executable extensions such as
`.cmd`, so a command can use `npm` instead of `npm.cmd`.

The managed program must stay in the foreground. A program that detaches from
its process cannot use this Session type.

When `stopCommand` is present, HBOX runs it as a separate, short-lived request
to stop the managed program. If HBOX cannot start it, HBOX uses the native
graceful signal. Without `stopCommand`, HBOX sends SIGTERM on WSL or a
best-effort Ctrl+Break signal on Windows. HBOX force-stops the managed process
tree when it is still running after the grace period.

When `readyUrl` is present, HBOX waits until the Windows host can reach it.
HBOX then opens `openUrl` when that URL is present. Without `readyUrl`, HBOX
treats a verified running process as ready.

When `singleInstance` is true, a second start does not create a duplicate.
HBOX opens the existing `openUrl` when the Session is ready.

HBOX keeps Session state across its own restarts. For WSL, it verifies the WSL
boot, process start time, process group, and Session token. For Windows, a
native Session runner owns the process tree and verifies the runner, process,
Job Object, and Session token. An identity mismatch makes the Session
disconnected. HBOX then disables destructive actions.

## Custom SVG icons

Store a custom icon at `.hbox/icon.svg`. The source must be 256 KiB or smaller.
HBOX normalizes accepted icons to a 24 by 24 display area and preserves the
source aspect ratio.

The root must be `svg`. It must have a valid `viewBox` with four finite numbers
and positive dimensions. A positive numeric or `px` width and height can define
the view box when `viewBox` is absent.

The icon can contain these elements:

- `g`
- `path`
- `rect`
- `circle`
- `ellipse`
- `line`
- `polyline`
- `polygon`

HBOX removes `defs`, `metadata`, `namedview`, `title`, and `desc` with their
contents. It rejects other elements, nested `svg` elements, text, CDATA,
DOCTYPE declarations, and non-XML processing instructions.

Shape attributes can define geometry, `pathLength`, presentation, and
transforms. Common accepted presentation attributes are:

- `fill`, `fill-opacity`, and `fill-rule`
- `stroke`, `stroke-width`, `stroke-opacity`, line caps, line joins, miter
  limits, and dash settings
- `opacity`, `paint-order`, `transform`, `vector-effect`, `visibility`, and
  `display`
- equivalent supported declarations in a `style` attribute

HBOX removes IDs and common editor metadata. It rejects classes, event
attributes, unsupported namespaces, unsupported style properties, and values
that contain `url()`, `var()`, `javascript:`, or `data:`.

HBOX changes every non-transparent fill or stroke to `#cf8f00`. It changes
`transparent` to `none`. Use `none` to preserve an unpainted fill or stroke.

The icon can contain at most 1,000 processed elements, 64 levels of nesting,
and 64 KiB in one attribute. The normalized output must remain within the
256 KiB limit.

## Verification and registration

Run `scripts/integrate-project.ps1` from this skill. The helper asks the
running HBOX server to apply its real metadata parser and SVG normalizer.

The helper fails when:

- the project folder or `entry.json` is unavailable;
- `entry.json` is invalid or unreadable;
- HBOX omits a declared action or Session;
- HBOX rejects the declared default action; or
- the custom icon is invalid or unreadable.

The helper registers the project only after verification succeeds. Use
`-VerifyOnly` to inspect without registration.
