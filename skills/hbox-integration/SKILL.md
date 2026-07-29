---
name: hbox-integration
description: Create, review, repair, verify, and register portable HBOX project integrations. Use when an agent must add or update a project .hbox folder, choose HBOX names or tags, define HBOX actions or WSL process Sessions, prepare a custom SVG icon, check how HBOX interprets project metadata, or register the project with a running local HBOX instance.
---

# HBOX integration

Make the project useful in HBOX with the smallest meaningful configuration.

## Workflow

1. Fetch the current contract from the running HBOX instance. Read the complete
   output before you inspect or edit project files:

   ```powershell
   pwsh -NoLogo -NoProfile -File <skill-folder>\scripts\integrate-project.ps1 -ShowContract
   ```

   Treat this output as the source of truth. Do not rely on a copied contract.
2. Inspect the project README, package scripts, and main entry points. Identify
   the project purpose and the actions that a user will need.
3. Inspect an existing `.hbox` folder before you edit it. Preserve intentional
   fields and project-specific behavior.
4. Create or update `.hbox/entry.json`.
   - Use the project title for `name`. Replace filename separators with spaces
     when that matches the title.
   - Use a small set of purpose-based tags. Do not add `code` only because the
     project contains code.
   - Set a default action only when one action is the clear normal entry point.
   - Add a process Session only when HBOX must own its lifecycle.
5. Add `.hbox/icon.svg` only when the project has a deliberate custom identity
   or the user requests one. Prefer a built-in tag icon or the fallback icon in
   other cases.
6. Run the bundled helper from the project folder. It verifies the effective
   metadata and custom icon before it registers the project:

   ```powershell
   pwsh -NoLogo -NoProfile -File <skill-folder>\scripts\integrate-project.ps1
   ```

   Use `-VerifyOnly` when the user does not want local registration. Use
   `-Path <folder>` when the current folder is not the project folder.
7. Treat helper issues as failures. Fix the project files and run the helper
   again. Do not edit the HBOX registry file.
8. Report the effective name, tags, default action, custom actions, Sessions,
   icon result, and registration result.

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
