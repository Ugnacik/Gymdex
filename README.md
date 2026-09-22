# Gymdex

Gymdex is a mobile-first workout tracker designed to run on a Raspberry Pi and
stay private inside a Tailscale network.

The first working slice supports:

- creating gyms;
- starting and finishing one active workout;
- adding recent gym-specific exercise configurations in one tap;
- searching a small starter exercise catalog;
- remembering equipment and machine details separately for each gym;
- logging sets with optional weight, repetitions or duration, and completion;
- showing completed sets from the last matching workout;
- browsing completed workouts by gym and date.

## Workout history

Open History from the start screen or during a workout. Completed workouts appear
newest first, with 20 per page. Filter by gym and workout start date. History dates
and times use UTC, including both ends of the date filter.

Select a workout to see its saved exercise names, equipment, machine details,
and every recorded set. Unfinished sets are labeled Not completed and do not
count toward the completed-set total. Empty completed workouts also appear.
History is read-only and requires a connection. Opening it leaves your active
workout and local drafts intact. Close it to return to your workout.

## Log sets

Each newly added exercise starts with one empty set. Enter kilograms and reps,
or seconds for duration exercises. Weight is optional. Enter a positive amount
and check Assistance for assisted weight; Gymdex stores it as a negative value.
Checking Set completed saves the set as completed; Save changes also saves an unfinished set.
Valid edits save automatically after a short typing pause. Add set creates
another row, and Remove deletes a row after confirmation. Sets can be edited
while the workout is active.

Outstanding set edits must reach the server before adding another exercise or
finishing the workout. Every input change also saves a draft on the current
device. Reloading restores those drafts, including unfinished entries. The page
shows whether changes are saved to the server or waiting on the phone.

If the server cannot be reached, keep editing existing sets. Pending saves retry
when the connection returns, when you return to the page, and every 15 seconds
while the page is visible. Invalid values require correction; server-rejected
sets stay on the phone and require review and a manual Save changes retry.

After one online visit over HTTPS, the app caches its files and last loaded
workout so it can reopen offline. Localhost also supports this for development;
a plain HTTP LAN address does not support offline reopening. Creating gyms,
starting or finishing workouts, adding exercises or sets, and removing sets
still require the server. Drafts belong to this browser and site address, do not
sync in the background while the app is closed, and disappear if browser site
data is cleared. Use one device at a time when editing a workout.

If browser storage is unavailable, the page warns you to keep it open until
changes reach the server. Local drafts are a recovery aid, not a database backup.

Exercise names include the variation throughout the catalog, recent choices,
and workout, for example Bench Press and Incline Bench Press.
Finish workout is available above and below the exercise list. Cancel workout
asks for confirmation, then discards the active workout and all its exercises
and sets, including unsaved edits. Saved gym equipment configurations and
completed workouts are kept.

Last workout values come from the most recent completed workout with the same
gym, exercise variation, equipment, manufacturer, and machine label. If that
combination occurred more than once, its last occurrence supplies the reference.
Only completed sets are shown, in order; reference values do not fill in or
complete the new workout's sets.

## Run locally

Gymdex has no third-party runtime dependencies. It needs Python 3.11 or newer.

```bash
python3 -m gymdex.server --port 8080
```

Open <http://127.0.0.1:8080>. The SQLite database is created at
`data/gymdex.sqlite3` by default. Override it with `GYMDEX_DB_PATH`.

Restart a running server after updating the Python code. Database migrations
run automatically at startup and preserve existing workouts. Exercises recorded
before set logging was added start with no sets; use Add set to begin logging.

Run the tests with:

```bash
python3 -m unittest discover -s tests -v
```

The mobile saving and cache regression tests use Node.js 18 or newer, with no
additional packages. Node.js is only needed for these tests:

```bash
node tests/mobile.test.mjs
```

For a phone smoke test, open Gymdex online, add an exercise and a few sets, then
disconnect the phone. Edit an existing set and reload. Confirm the values are
restored, reconnect, and wait for the saved-to-server status. Check Assistance,
editing the middle of an exercise search, and scrolling with the keyboard open.
When changing cached app assets, also bump the cache version in `static/sw.js`
so a newly installed worker refreshes the offline copy. Close existing app tabs
and reopen to activate a waiting worker update.

## Raspberry Pi and Tailscale

Copy this repository to the Pi, run the service on localhost, then expose it
only to your tailnet:

```bash
python3 -m gymdex.server --host 127.0.0.1 --port 8080
sudo tailscale serve --bg 8080
```

Tailscale prints the private HTTPS address. Open that address on a phone that is
connected to the same tailnet. Add it to the home screen for app-like access.

For a persistent installation at `~/apps/gymdex`, copy
[deploy/gymdex.service](deploy/gymdex.service) to
`~/.config/systemd/user/gymdex.service`, then enable it as a systemd user service.

## Data model

Exercise configurations belong to a gym. A configuration can record equipment,
a manufacturer, and a machine label. When it is added to a workout, Gymdex
copies those details into the workout record so old workouts do not change when
the gym configuration is edited later.
