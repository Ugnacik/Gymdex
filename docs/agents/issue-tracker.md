# Issue tracker: docs/backlog.md

Work items for this repo live in `docs/backlog.md`, the only to-do list. There is no GitHub Issues workflow.

## Conventions

- **Create an item**: append a numbered line to `docs/backlog.md`. Keep it to a sentence or two; if it needs more, indent a short body beneath it.
- **Read an item**: open `docs/backlog.md` and find it by number or wording.
- **List items**: read the file. Open items are the ones present.
- **Comment on an item**: add an indented note beneath it.
- **Triage state**: a trailing inline tag such as `[ready-for-agent]` (see `triage-labels.md`). No tag means `needs-triage`.
- **Close**: remove the item once the work lands (AGENTS.md rule). A `wontfix` item is removed too, with the reason in the commit message.

## When a skill says "publish to the issue tracker"

Append an item to `docs/backlog.md`.

## When a skill says "fetch the relevant ticket"

Read the matching item in `docs/backlog.md`.

## Wayfinding operations

Not supported by this tracker: a flat backlog has no map, children, or blocking edges. Keep wayfinding material outside the repo (for example `/tmp`), per the AGENTS.md rule against committing plans and scratch files.
