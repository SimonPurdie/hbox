# Project orientation

# Development environment

Development commands usually run in WSL. HBOX runs on Windows. Check paths, shell commands, and executable files in both environments. Test the final start command with Windows Node.

# Integration contract

When you add or change project integration functionality, update
`src/server/hbox-contract.md` in the same change.

# Version control

When a coherent task or feature is completed, commit it to git without waiting for confirmation. You should have system permissions to use "git add" and "git commit", and are expected to use them as part of your work without asking for user permission.

Run `git add` and `git commit` as separate escalated commands using the existing pre-approved `["git", "[add|commit]"]` prefix rule. Do not combine them with other git subcommands that fall outside that rule.

## Design context

The interface uses familiar desktop objects and a small number of controls.

The design is clean, minimal and uncluttered. New controls, panels, and status information must have a clear purpose. They require explicit approval before they are added.
