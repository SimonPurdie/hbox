---
name: hbox-integration
description: Create, review, repair, verify, and register portable HBOX project integrations. Use when an agent works with a project .hbox folder, Entry metadata, tags, actions, Sessions, custom SVG icons, effective HBOX metadata, or local HBOX registration.
---

# HBOX integration

HBOX represents a project as an Entry tied to one canonical folder. Project
integration is portable in `.hbox`. Local registration connects that folder to
the running HBOX instance.

## Integration surfaces

### Entry metadata

`.hbox/entry.json` describes how the Entry appears and behaves. Its main
concepts are:

- A display name identifies the Entry.
- Tags support search and built-in icon selection.
- A default action gives the Entry its direct activation behavior.

### Actions

An Action is a discrete operation that a user can request from an Entry.
Built-in Actions open the canonical folder or its terminal. Project-defined
Actions connect the Entry to capabilities described in its metadata.

### Sessions

A Session represents ongoing activity managed through HBOX. It can model a
process, service, or another unit of work that continues beyond one Action.
Session definitions describe how HBOX starts or discovers the activity, checks
its identity and readiness, reconciles saved state, and offers suitable
lifecycle Actions.

The current contract lists the implemented Session types and their environment
constraints.

### Icons

`.hbox/icon.svg` gives an Entry a project-specific icon. HBOX can also select a
built-in icon from the Entry tags or use its fallback icon.

## Live contract and helper

The running HBOX instance supplies the current file formats, accepted values,
normalization rules, and implementation limits:

```powershell
pwsh -NoLogo -NoProfile -File <skill-folder>\scripts\integrate-project.ps1 -ShowContract
```

The same helper applies HBOX's metadata parser and SVG normalizer to a project:

```powershell
pwsh -NoLogo -NoProfile -File <skill-folder>\scripts\integrate-project.ps1
```

`-Path <folder>` selects a project folder. `-VerifyOnly` returns the effective
integration without local registration. A successful default invocation
registers the Entry after verification.

## WSL invocation

HBOX listens on Windows loopback. Run the PowerShell helper with Windows
PowerShell 7, not Linux PowerShell. Convert the skill script path before use:

```bash
"/mnt/c/Program Files/PowerShell/7/pwsh.exe" \
  -NoLogo -NoProfile \
  -File "$(wslpath -w <skill-folder>/scripts/integrate-project.ps1)"
```

Run this command from the target project folder. Windows PowerShell receives
that folder as a Windows path or a WSL UNC path.
