# Gymdex

Gymdex is a personal strength-training log. A small Python server keeps workouts in SQLite and serves a vanilla JavaScript web app that I use on my phone at the gym over Tailscale.

## What we never compromise on

### 1. Fast logging during a workout

Picking an exercise and recording a set must take as few taps and as little thought as possible. When a change trades speed of logging for anything else, logging wins unless I say otherwise.

### 2. Phone first

The phone is the main surface. Design and test for a phone-sized screen held in one hand, touch targets and the on-screen keyboard included. Desktop only needs to keep working.

## A note from me

I like ambitious ideas, simple systems, and software that feels obvious. Do not preserve complexity just because it already exists. Do not introduce machinery because it looks architecturally impressive. Understand the real constraint, then fight for the smallest model that makes the correct behavior unsurprising.

Channel both "measure twice, cut once" and "yagni". Fight scope creep. Try to honor my intent in both a minimal and realistic fashion. Not every problem you notice is worth fixing; mention it and let me decide.

The rest of this document is meant to help you navigate the codebase and make changes effectively. Think of these instructions less as "hard rules", more as "good defaults". My preferences in the conversation override anything here.

## Language

Use the vocabulary in [CONTEXT.md](CONTEXT.md) when you talk, name things, and write UI text: an Exercise Configuration, not a "profile"; a Workout, not a "session". **You** means the agent reading this file. **I** am the developer and the only user. `CONTEXT.md` is vocabulary, not a feature index: change it only when the domain language changes.

## The three ways to hurt yourself

1. **Killing by pattern.** Never `pkill -f`, `pgrep | kill`, or `kill $(pgrep ...)`. The pattern also matches your own shell's command line, so you kill yourself, and this machine runs other servers that are not yours. Kill only a PID you captured when you started the process, or the owner of your port from `ss -H -ltnp` after confirming `/proc/<pid>/cwd` is your checkout.
2. **Writing to the live database.** `data/gymdex.sqlite3` holds my real workouts, and the server on port 8080 is the one my phone uses. Reading it and copying from it are fine (see Test data). Never point a test or preview server at it, never open it read-write, never clean it up, and never restart or stop the 8080 server unless I ask.
3. **Forgetting the service worker cache.** The phone serves the app shell from the service worker cache. Whenever you change a file in `static/`, bump `CACHE` in `static/sw.js`, and add new static files to its `SHELL` list. Otherwise my phone keeps running the old version and the change looks broken.

## Hit every surface

The most common defect is a change that works on the path you tested and is missing everywhere else. Before calling work done, walk this list and say which entries applied:

- **Entry points.** The exercise picker, set editing, and configuration choices are shared between the Active Workout, Completed Workouts in history, and Routines. Fixing one is not fixing the feature.
- **Workout states.** An Active Workout and a Completed Workout allow different edits.
- **Tracking Types.** Repetitions and Duration Variations record different results.
- **Reverse states.** If you added a way in, add the way out and the way to see it. Archive needs restore. A one-way door is a bug.
- **Server and client.** A change to an API response needs the server, the client, and their tests to agree.
- **Docs.** Check whether the change makes existing guidance inaccurate. Apply the [documentation rules](#documentation) before adding anything.

## Dev servers

- The server is `python3 -m gymdex.server --host 127.0.0.1 --port <port>`. `GYMDEX_DB_PATH` chooses the database; without it the server uses the live one (see rule 2).
- Port 8080, shared on the tailnet as `https://cachyos-desktop.tail1ecd6b.ts.net:8443/`, is my live app. Leave it alone.
- For a preview, use a port in the 9091–9099 range with a copy of the database, and share it with `tailscale serve --bg --https=<port> http://127.0.0.1:<port>`. Remove it afterwards with `tailscale serve --https=<port> off`. Other `tailscale serve` entries, such as :443 and :10000, belong to other apps; never change them.
- Stop what you started. Before you finish, shut down every preview server, `tailscale serve` entry, and emulator you started, using the PID you recorded (rule 1), and tell me if you leave any running on purpose.

## Test data

An empty database is a bad test. Seed a preview with a copy of the real data:

```bash
mkdir -p /tmp/gymdex-preview
rm -f /tmp/gymdex-preview/gymdex.sqlite3   # VACUUM INTO refuses to overwrite
python3 -c "import sqlite3; sqlite3.connect('file:data/gymdex.sqlite3?mode=ro', uri=True).execute(\"VACUUM INTO '/tmp/gymdex-preview/gymdex.sqlite3'\")"
GYMDEX_DB_PATH=/tmp/gymdex-preview/gymdex.sqlite3 python3 -m gymdex.server --port 9091
```

`VACUUM INTO` is safe while the live server has the file open and yields one consistent copy. A plain `cp` of a database in use is a corrupt copy. Data flows one way: into your copy, never back out.

## Verifying

- Smallest proof that the change works. Run the tests for what you touched:
  - Python: `python3 -m unittest discover -s tests` (or one module, such as `python3 -m unittest tests.test_routines`)
  - JavaScript: `node tests/<name>.test.mjs`
  - Browser smoke test: `GYMDEX_PLAYWRIGHT_PATH=$HOME/.cache/gymdex-browser/node_modules/playwright node tests/browser-smoke.mjs`
- If the system `node` fails to start, use the copy in `~/.local/opt/node/bin`.
- Test meaningful logic or observable behavior. Do not add tests that merely assert callback wiring or mirror the implementation.
- Backend behavior changes ship with focused tests for that behavior.
- With permission, user-visible frontend changes get one pass in a real client after the work is integrated.
- After every user-visible frontend change, show me what it looks like: phone-sized screenshots of each changed screen and state, plus a short video when the change is an interaction. Take them from a preview on copied data, save them in `~/gymdex-screenshots/<date>-<topic>/` (not `/tmp`, which may be cleared before I look), and list the paths in your report.

## Branches and worktrees

I find branches and worktrees easy to lose track of. Whenever you create, switch, merge, or delete one, tell me in plain words:

- which branch and folder the work is in, and which branch the main checkout (`~/Projects/Gymdex`) is on,
- what my phone is running now, since the 8080 server serves whatever the main checkout has checked out,
- what is still unmerged or unpushed, and what you suggest doing with it.

The workflow:

- Work on a feature branch off `main`, one concern per branch. If the description says "also", split it.
- Use a separate worktree when the main checkout is busy, so the live app does not change under me. Put it where your tool keeps worktrees (`.claude/worktrees/` for Claude Code, Codex's own folder for Codex).
- I also work with other agents, such as Codex. Run `git worktree list` before you start and include every worktree in your report, but leave worktrees and branches you did not create alone.
- Merge into `main` with `git merge --no-ff`, message `Merge <branch> into main`. Commit messages are plain sentences.
- Delete merged branches and their worktrees when I agree the work is done. Since this app's code is small, there isn't much risk to deleting worktrees and branches.

## Documentation

Most code changes do not need a documentation change. Agents can read the code.

- `docs/adr/` records architectural and product decisions and their reasons, constraints that span the server and client, and traps that are hard to discover from the source. Before adding to it, ask what I would get wrong without it. If reading the relevant code answers the question, leave it out.
- Do not document every feature, enumerate fields or endpoints, narrate control flow, maintain file catalogs, or append change summaries. Types, tests, and code already record the implementation.
- Keep a local implementation explanation in a nearby code comment. Use an ADR when the reasoning crosses boundaries or needs context the code cannot carry well. Link to the source instead of copying it.
- When a documented decision or constraint changes, rewrite or remove the affected text. Do not append another account of the new behavior.
- The feature sections of `README.md` help me use Gymdex. Give each major feature a concise section explaining what it does, how to start, and anything unintuitive. Descriptions of visible buttons, layouts, animations, or every UI state are not useful. A UI tweak does not need a documentation entry.
- The setup sections of `README.md` (running locally, Raspberry Pi and Tailscale, backups) hold setup and operating procedures.

## Plans and work artifacts

- Do not commit implementation plans, research notes, screenshots, or scratch files. Keep temporary material outside the repository, for example in `/tmp`; screenshots and videos for me go in `~/gymdex-screenshots/` (see Verifying).
- `docs/backlog.md` is the only to-do list. When work from it lands, remove the item.

## Where code lives

- `gymdex/` is the server: `server.py` handles HTTP and `db.py` the SQLite schema and queries.
- `static/` is the web app: plain ES modules, `styles.css`, the service worker, and self-hosted fonts.
- `tests/` holds Python `unittest` modules, Node tests for the client, and the Playwright smoke test.
- `deploy/` holds the systemd units for the Raspberry Pi and backups.

## Taste

- Gymdex loads nothing from third-party servers: fonts, icons, and scripts are served by Gymdex itself, and the Content Security Policy enforces it.
- So far the client has no framework or build step and the server uses only the Python standard library. Ask me before adding a dependency, a framework, or a build step.
- Follow the existing look: graphite surfaces, the orange accent, pill buttons, the Geist font, and bottom sheets for secondary screens.
- Comments describe how a thing is used, and move when the code moves. Use them mostly to describe functions, not to annotate every line of behavior.
- No continuously repainting animations; they drain the phone's battery and stutter.
- If a rule here fights the task in front of you, say so loudly and get my sign-off before breaking it.

## Agent skills

### Issue tracker

Work items live in `docs/backlog.md`, the only to-do list. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary, written as inline tags on backlog items. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` and `docs/adr/` at the root. See `docs/agents/domain.md`.
