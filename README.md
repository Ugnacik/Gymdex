# Gymdex

Gymdex is a mobile-first workout tracker designed to run on a Raspberry Pi and
stay private inside a Tailscale network.

Gymdex supports:

- creating gyms;
- starting and finishing one active workout, with its elapsed time shown and a
  reminder to finish it after 3 hours;
- adding recent gym-specific exercise configurations in one tap;
- searching a starter exercise catalog of common movements;
- remembering equipment and machine details separately for each gym;
- logging sets with optional weight, repetitions or duration, and completion;
- removing and reordering exercises in the active workout;
- showing completed sets from the last matching workout and copying one in a tap;
- prefilling each added set from the set above it;
- browsing completed workouts by gym and date;
- creating exercise variations with custom tracking and equipment choices;
- repeating a completed workout with fresh, empty set slots;
- correcting sets in completed workouts;
- viewing exercise progress across completed workouts;
- using an optional rest timer;
- exporting workout data as CSV and backing up the SQLite database.

## Workout history

Open History from the start screen or during a workout. Completed workouts appear
newest first, with 20 per page. Filter by gym and workout start date. Dates and
times in history, progress, and the active workout use the phone's time zone.
From and To are whole local days: a workout started at 00:30 belongs to that
day, not the previous one. Gymdex stores times in UTC, so changing the phone's
time zone changes how existing times are shown but not the stored workouts.

Select a workout to see its saved exercise names, equipment, machine details,
and every recorded set. Unfinished sets are labeled Not completed and do not
count toward the completed-set total. Empty completed workouts also appear.
History requires a connection. Opening it leaves your active
workout and local drafts intact. Close it to return to your workout.
Open a completed workout to correct an existing set's weight, reps or duration,
and completion state. A corrected set immediately affects progress and future
"Last workout" reference values. Existing sets can be corrected; completed
workouts cannot gain or lose exercises or sets.

With no active workout, **Repeat this workout** starts a new workout at the same
gym. It copies the exercise configurations and number of set slots, but clears
all results, weights, and completion marks. The source stays in history.

Use **Progress** to choose an exercise and optional gym. The chart and table
show the best completed result and best weight for each workout. From a workout
exercise or history detail, **View progress** starts with its exact gym,
equipment, manufacturer, and machine label, so different machines are not
mixed. These two best values can come from different sets in the same workout.

## Exercise catalog

The starter Exercise Catalog covers common gym movements: presses, squats,
deadlifts including Romanian Deadlift, rows and pulldowns, leg press, leg
curls and extensions, lunges, hip thrusts, raises, flies, curls, pushdowns,
face pulls, core work such as Crunch and Hanging Leg Raise, and bodyweight
Pull-up, Dip, and Push-up alongside their Assisted variations. Each variation
offers only its relevant equipment. For bodyweight variations, weight is
optional and records added load, such as a dip belt.

When Gymdex starts, it adds any starter variations missing from an existing
database. It does not change existing catalog entries, custom variations with
the same name, or recorded workouts.

## Custom exercises

During a workout, open Add exercise and choose **Create custom exercise**.
Enter an exercise name, optional variation name, and tracking type. Add
equipment choices one at a time: type one, then tap Add or press Enter. Each
choice appears as a chip you can remove with its ×. An empty variation name
becomes Standard.
Check Assisted when the variation's weight is a machine counterweight.
Using an existing exercise name adds another variation. The resulting catalog
entry is available at every gym; machine details are still recorded for the
gym when you add it to a workout. Created variations cannot yet be renamed or
deleted in the app.

## Rest timer

Turn on Rest timer during an active workout and choose a rest interval. Marking
a valid set complete starts the countdown, including when the phone is offline.
The timer can be started, paused, resumed, or reset manually. Its enabled state
and interval are kept in this browser; a running countdown is not restored after
the page closes. The timer does not send notifications when the app is closed.

When the countdown finishes, Gymdex plays a short double beep and vibrates the
phone where the browser supports it. Phones only allow the sound after a tap, so
the beep is enabled by checking Done or tapping Start or Resume; a silent switch
or muted media volume can still mute it. iPhones and iPads do not vibrate
because Safari has no vibration support. If the countdown ends while the app is
in the background or the screen is locked, the cue can be late or wait until
you return to the app.

## Log sets

Each newly added exercise starts with one empty, not completed set for every
set in its Last workout reference (see below), or one empty set when there is
none. The rows already exist on the server, so they can be filled in by typing
or by tapping "Last workout" even if the gym signal drops. Enter kilograms and
reps, or seconds for duration exercises. Weight is optional. Assisted variations,
such as Assisted Pull-up, label the weight Assist kg: enter the machine's
counterweight as a positive amount and Gymdex stores it as a negative value.
Checking Done beside the inputs saves the set as completed right away.
Valid edits, including unfinished sets, save automatically after a short typing
pause, and pressing Enter in a field saves immediately. Add set creates another
row that copies the weight and reps or seconds of the set above it, saved but
not completed; Gymdex saves any edit to the set above first. The × in a set's
corner deletes it after confirmation. Sets can be edited while the workout is
active.

Below each exercise's sets, **Move up** and **Move down** change its place in
the workout, and **Remove** deletes the exercise with all its sets after
confirmation. Both actions first save outstanding set edits to the server;
removing an exercise also discards any unsaved drafts for its sets on this
phone.

Outstanding set edits must reach the server before adding, moving or removing an
exercise, or finishing the workout. Every input change also saves a draft on the current
device. Reloading restores those drafts, including unfinished entries. The page
shows whether changes are saved to the server or waiting on the phone.

If the server cannot be reached, keep editing existing sets. Pending saves retry
when the connection returns, when you return to the page, and every 15 seconds
while the page is visible. Invalid values require correction; server-rejected
sets stay on the phone and show a Retry button for a manual retry after review.

After one online visit over HTTPS, the app caches its files and last loaded
workout so it can reopen offline. Localhost also supports this for development;
a plain HTTP LAN address does not support offline reopening. Creating gyms,
starting or finishing workouts, adding, removing or reordering exercises, and
adding or removing sets still require the server. Drafts belong to this browser and site address, do not
sync in the background while the app is closed, and disappear if browser site
data is cleared. Use one device at a time when editing a workout.

If browser storage is unavailable, the page warns you to keep it open until
changes reach the server. Local drafts are a recovery aid, not a database backup.

Exercise names include the variation throughout the catalog, recent choices,
and workout, for example Bench Press and Incline Bench Press.
The workout header shows the start time and how long the workout has been
running; the elapsed time updates every 30 seconds while the page is open.
Finish workout is below the exercise list. Cancel workout
asks for confirmation, then discards the active workout and all its exercises
and sets, including unsaved edits. Saved gym equipment configurations and
completed workouts are kept.

If the active workout started more than 3 hours ago, a "Still training?" banner
appears when the workout opens. **Finish it** uses the normal Finish workout
flow. **Keep going** hides the banner for that workout; this browser remembers
the choice, so reopening the app does not ask again.

Last workout values come from the most recent completed workout with the same
gym, exercise variation, equipment, manufacturer, and machine label. If that
combination occurred more than once, its last occurrence supplies the reference.
Only completed sets are shown, in order. Tap a set's "Last workout" line to
copy those values into the set and save them like any other edit; this does not
mark the set completed.

## Run locally

Gymdex has no third-party runtime dependencies. It needs Python 3.11 or newer.

```bash
./run.sh
```

Open <http://127.0.0.1:8080>. The SQLite database is created at
`data/gymdex.sqlite3` by default. Override it with `GYMDEX_DB_PATH`.
Keep the terminal open while using the app. Press Ctrl+C in that terminal to
stop the server.

Restart a running server after updating the Python code. Database migrations
run automatically at startup and preserve existing workouts. Exercises recorded
before set logging was added start with no sets; use Add set to begin logging.

Run the tests with:

```bash
python3 -m unittest discover -s tests -v
```

The browser behavior, workout editing, and cache regression tests use Node.js
18 or newer, with no additional packages. Node.js is only needed for these tests:

```bash
node tests/app.test.mjs
node tests/mobile.test.mjs
node tests/workout-editor.test.mjs
node tests/rest-timer.test.mjs
```

For a phone smoke test, open Gymdex online, add an exercise and a few sets, then
disconnect the phone. Edit an existing set and reload. Confirm the values are
restored, reconnect, and wait for the saved-to-server status. Check Assist kg
on an assisted variation, editing the middle of an exercise search, and
scrolling with the keyboard open.
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
connected to the same tailnet. Once it loads over HTTPS, use **Add to Home Screen**
(Safari's Share menu on iPhone, or the browser menu on Android) for app-like
access: Gymdex then opens full screen with its own dumbbell icon. Use the HTTPS
address, not plain `http://`, because the offline app shell only works over HTTPS.

The icons are PNGs in `static/`. To change them, edit and run
`python3 scripts/make_icons.py`, which regenerates them with the standard
library only.

For a persistent installation at `~/apps/gymdex`, copy
[deploy/gymdex.service](deploy/gymdex.service) to
`~/.config/systemd/user/gymdex.service`, then enable it as a systemd user service.

## Export and database backup

Use **Export CSV** in Workout history to download workout, exercise, and set rows.
The CSV includes empty workouts and unfinished sets. It is for spreadsheets and
analysis; it does not contain the full catalog or gym configurations. Unlike the
app, the export keeps timestamps in UTC, as its `started_at_utc` and
`completed_at_utc` column names say. Text fields that could be interpreted as
spreadsheet formulas are prefixed with an apostrophe.

For a complete, restorable copy, use SQLite's online backup API through the
included command. It can safely snapshot a running Gymdex database:

```bash
python3 -m gymdex.backup backup ~/gymdex-backup.sqlite3
```

Copy the backup somewhere other than the Pi and verify you can restore it. To
restore, stop the Gymdex service first and keep a copy of the current database.
Then run:

```bash
systemctl --user stop gymdex
python3 -m gymdex.backup backup ~/gymdex-before-restore.sqlite3
python3 -m gymdex.backup restore ~/gymdex-backup.sqlite3 --replace
systemctl --user start gymdex
```

The command uses `data/gymdex.sqlite3` by default, or `GYMDEX_DB_PATH` when set.
Pass `--db PATH` to choose a different database. Backup refuses to replace an
existing output unless you pass `--replace`. Restore checks that the source is a
readable Gymdex database and requires `--replace` for the destination. A restore
also refuses to write beside leftover SQLite journal files; stop the service
and let SQLite close or checkpoint the database before retrying.

## Data model

Exercise configurations belong to a gym. A configuration can record equipment,
a manufacturer, and a machine label. When it is added to a workout, Gymdex
copies those details into the workout record so old workouts do not change when
the gym configuration is edited later.
