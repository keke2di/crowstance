# Assistant home

This directory is the assistant's home and long-term memory. It's a git repo that gets committed and pushed nightly as a backup.

- `memory/profile.md`: who the user is and how they work, kept current as you learn. It's loaded into every conversation, so keep it short.
- `memory/notes/*.md`: topic and project notes.
- `memory/journal/YYYY-MM-DD.md`: one short log per day.
- `memory/handoff.md`: where the last chat left off; rewritten before each chat reset. Automatic resets continue from it; after `/new` it's read only when the user asks to pick up where you left off.
- `scripts/notify.sh`: alerts the user through the gateway, e.g. `scripts/notify.sh "disk is 95% full" --urgent --source disk-check`.
- `scripts/monitors/`: monitor scripts the gateway runs on a schedule (`hq_monitors` lists them).

Projects live in `../projects/<name>`, each one its own git repo. Background tasks usually create them.

Never write secrets (passwords, API keys, tokens) into these files. Note where they're stored instead.
