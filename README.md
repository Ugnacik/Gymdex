# Gymdex

Gymdex is a mobile-first workout tracker designed to run on a Raspberry Pi and
stay private inside a Tailscale network.

Gymdex supports:

- creating, renaming, archiving, and deleting gyms;
- starting and finishing one active workout, with its elapsed time shown and a
  reminder to finish it after 3 hours;
- adding recent gym-specific exercise configurations in one tap;
- searching a starter exercise catalog of common exercises, together with the
  exercise configurations saved at the gym;
- remembering equipment and machine details separately for each gym;
- logging sets with optional weight, repetitions or duration, and completion;
- removing and reordering exercises in the active workout, and changing the
  machine an exercise was added with;
- adding an optional note to a workout and to each of its exercises;
- showing completed sets from the last matching workout and copying one in a tap;
- prefilling each added set from the set above it;
- browsing completed workouts by gym and date;
- creating exercise variations with custom tracking and equipment choices;
- repeating a completed workout with fresh, empty set slots;
- saving routines, per gym, and starting a workout from one in a tap;
- correcting sets and notes, and adding and deleting sets, in completed workouts,
  and deleting a completed workout;
- viewing exercise progress across completed workouts, with dated charts and selectable points;
- showing a finish summary with duration, completed sets, and routine/history shortcuts;
- using an optional rest timer;
- exporting workout data as CSV and backing up the SQLite database.

## Workout history

Open History from the start screen or during a workout. Completed workouts appear
newest first, with 20 per page. Filter by gym and workout start date. Dates and
times in history, progress, and the active workout use the phone's time zone.
From and To are whole local days: a workout started at 00:30 belongs to that
day, not the previous one. Gymdex stores times in UTC, so changing the phone's
time zone changes how existing times are shown but not the stored workouts.

The History header keeps Close and Back to history visible while you scroll.

Select a workout to see its saved exercise names, equipment, machine details,
and every recorded set. Unfinished sets are labeled Not completed and do not
count toward the completed-set total. Empty completed workouts also appear.
History requires a connection. Opening it leaves your active
workout and local drafts intact. Close it to return to your workout.
Open a completed workout to correct an existing set's weight, reps or duration,
and completion state. **Add set** appends a set to that exercise, copying the
weight and reps or duration of the set above, and opens it for correction; it
is Not completed until you mark it completed and save. **Delete set** removes a
set after a confirmation, and the remaining sets are renumbered. **Delete
workout** at the bottom removes the whole completed workout with its exercises
and sets; type DELETE to confirm. History then returns to the list, or to the
newer page if that was the last workout on an older one. An active workout cannot be deleted from
history (use Cancel workout instead). Every correction, added or deleted set,
and deleted workout immediately affects progress and future "Last workout"
reference values. Adding exercises to a completed workout is not supported.

The workout's note appears under its start and finish times, and each
exercise's note above its heading. **Add workout note**, **Edit workout note**,
**Add note** and **Edit note** open a text box; **Save note** saves it, and
saving an empty box removes the note.

With no active workout, **Repeat this workout** starts a new workout at the same
gym. It copies the exercise configurations and number of set slots, but clears
all results, weights, and completion marks, and it does not copy notes. Exercise
and variation names are the current ones, so a renamed exercise appears under
its new name. The
source stays in history. A workout at an archived gym cannot be repeated until
the gym is restored in [Manage](#manage-gyms-and-exercises). Exercises whose
exercise configuration or custom variation is archived are left out, and the
confirmation says how many, for example "1 archived exercise skipped".

**Save as routine**, below Repeat this workout, saves the workout's exercise
configurations as a [routine](#routines) at its gym. It works while another
workout is active, but not for a workout at an archived gym. Name the routine
in the sheet that opens; it suggests the gym and date. Each exercise gets as
many sets as it had completed sets, at least 1 and at most 20. Exercises whose
configuration or custom variation is archived are left out, and the message
says how many.

## Routines

A routine is a saved plan for one gym: an ordered list of exercise
configurations, each with a number of sets. It does not store weights, reps or
notes. When a gym is selected on the start screen, its routines appear under
**Routines** as **Start …** buttons. One tap starts a workout at that gym with
the routine's exercises, each with that many empty, not completed sets. Last
workout values appear and can be copied in a tap, exactly as for added
exercises. **Start workout** still starts an empty workout in one tap. Starting
a routine needs a connection and no active workout. Exercises whose
configuration or custom variation is archived are left out, and the message
says how many. The routines of an archived gym are not offered; restoring the
gym brings them back.

**Edit** beside Routines opens the Routines screen for the selected gym:

- **New routine** asks for a name, then opens the empty routine.
- Select a routine to change it. **Add exercise** opens the same picker as a
  workout: Recent at this gym, the exercise catalog, and custom-exercise
  creation. Searching lists matching configurations saved at this gym (one tap
  adds one) above matching catalog exercises, so there is one search for both.
  Choosing a catalog exercise asks for equipment and machine details; **Add to
  routine** saves the configuration and adds it to the plan together, so you can
  build a routine before your first workout. Added exercises start with 3 sets.
- **Sets** chooses 1 to 20 sets for an exercise. Hold an exercise name or use
  **Reorder exercises** to open a compact list, then drag its handle or use the
  arrows. Each move saves immediately. **Move up** and **Move down** also remain
  available; the × removes the exercise after a confirmation.
- **Rename** changes the name. Routine names are unique within a gym,
  regardless of capitalization.
- **Delete** removes the routine after a confirmation. Workouts started from it
  stay in history; they do not refer to the routine.

Every change saves right away and needs a connection. An archived exercise stays
listed with a note, so restoring it in Manage puts it back into the routine.
Repeat this workout is unchanged: it copies one completed workout, and set slots
follow that workout's sets.

Use **Progress** to choose an exercise and optional gym. The chart and table
show the best completed result and best weight for each workout. From a workout
exercise or history detail, **View progress** starts with its exact gym,
equipment, manufacturer, and machine label, so different machines are not
mixed. These two best values can come from different sets in the same workout. The
chart includes dates; tap a point or focus it and press Enter/Space to see the
actual completed sets, with their paired weights and reps or duration. Machine
filters also apply to these details.

## Exercise catalog

The starter Exercise Catalog covers common gym exercises: presses, squats,
deadlifts including Romanian Deadlift, rows and pulldowns, leg press, leg
curls and extensions, lunges, hip thrusts, raises, flies, curls, pushdowns,
face pulls, core work such as Crunch and Hanging Leg Raise, and bodyweight
Pull-up, Dip, and Push-up alongside their Assisted variations. Each variation
offers only its relevant equipment. For bodyweight variations, weight is
optional and records added load, such as a dip belt.

When Gymdex starts, it adds any starter variations missing from an existing
database. It does not change existing catalog entries, custom variations with
the same name, or recorded workouts. So a later catalog change that adds
equipment to an existing starter variation reaches only new databases.

## Custom exercises

During a workout, open Add exercise and choose **Create custom exercise**.
Enter an exercise name, a variation name, and choose Repetitions or Duration
in seconds under Track by. Add equipment choices one at a time: pick one from
the list, or choose **Other…** and type a new one, then tap Add (or press
Enter while typing). Each choice appears as a chip you can remove with its ×,
and an added choice leaves the list. An empty variation name becomes Standard.
Check Assisted when the variation's weight is a machine counterweight.
Using an existing exercise name with a new variation name adds another variation.
Choosing a variation that Exercise already has uses it with its existing tracking,
equipment and Assisted settings. The resulting catalog
entry is available at every gym; machine details are still recorded for the
gym when you add it to a workout. Rename, edit the equipment of, or remove
created variations in [Manage](#manage-gyms-and-exercises).

### Suggested values

Variation names, Manufacturers and Machine labels can be reused across Exercises
and Gyms, including when creating a new Exercise. Choose **Other…** to enter a
new value. Variation defaults to Standard; choosing an existing Variation for
the same Exercise uses it instead of creating another one. Manufacturer and
Machine label remain optional and start as None.

Equipment options offers the starter catalog's equipment plus equipment of the
named Exercise's Variations, including values you entered.

Suggestions come from what is recorded, so there is nothing separate to manage:
archiving or deleting a variation or exercise configuration in
[Manage](#manage-gyms-and-exercises) removes the values only it provided, and
values differing only in capitalization are offered once. Values are sorted
alphabetically.
New values appear the next time you open Add exercise.

## Manage gyms and exercises

On the start screen, **Manage** beside Your gyms opens three sections: Gyms,
Exercise Configurations, and Custom Exercise Variations. Manage is not
available during a workout, so nothing in the workout you are recording changes
underneath you.

**Rename** changes a gym's name everywhere, including completed workouts in
history and progress. Gym names must be unique regardless of capitalization,
archived gyms included, and cannot be blank.

The remove button says what it will do, and asks before doing it:

- **Delete** appears for a gym that has never had a workout. It removes the gym,
  its saved exercise configurations and its routines permanently.
- **Archive** appears for a gym with workouts. An archived gym disappears from
  the start screen, and new workouts cannot be started or repeated there. Its
  workouts stay in history, progress, and the CSV export, and the gym filters in
  history and progress still offer it, marked "(archived)". The active workout's
  gym cannot be archived: finish or cancel the workout first.

Archived gyms are listed under **Archived** at the end of the Gyms section, and
**Restore** brings one back everywhere. A new gym cannot reuse an archived gym's
name; restore the archived gym instead.

Exercise Configurations lists the equipment and machine details saved for each
gym, grouped by gym. **Delete** removes a saved choice without deleting its
recorded Sets or history. A configuration used in a workout stays under
**Archived** but disappears from Recent; Repeat this workout and starting a
routine leave it out. History, progress, "Last workout", and the CSV export
keep it. A configuration that no workout uses is removed permanently, also
from any routine that lists it.

Archived configurations are listed under **Archived** with their gym, and
**Restore** offers one under Recent again. Choosing the same exercise,
equipment, manufacturer, and label in the picker also restores it. A
configuration whose custom variation is archived stays listed but says that
Recent hides it until the variation is restored.

Custom Exercise Variations lists the variations you created, grouped by exercise. Starter
catalog exercises are not listed and cannot be changed, because Gymdex adds
missing starter variations back when it starts.

- **Rename** on an exercise or variation changes the name in the exercise
  picker, Recent, progress, and new workouts, including repeated ones. Completed
  workouts keep the name they were recorded with. Exercise names must be unique, and a variation name must be
  unique within its exercise, archived variations included, regardless of
  capitalization. An exercise that also has starter variations, such as Bench
  Press with your own Close Grip variation, cannot be renamed; its variations
  can.
- **Equipment** opens the variation's equipment chips. Add any new choice one at
  a time. The × appears only on choices no workout has recorded, and never on
  the last one. Removing a choice also removes saved exercise configurations
  that use it, which no workout uses either. Tracking type and Assisted stay as
  created.
- **Delete** appears for a variation no workout uses. It removes the variation,
  its equipment and saved configurations, and the exercise too once it has no
  variations left.
- **Archive** appears for a variation used in a workout. It disappears from the
  exercise picker and Recent, but history, progress, and the CSV export keep
  it, and Progress still offers it, marked "(archived)". If another phone still
  has the picker open, adding the archived variation there is refused with
  "… is archived. Restore it in Manage to add it."

Archived variations are listed under **Archived** at the end of the Custom
Exercise Variations section, and **Restore** offers one in the picker again. Creating a
custom exercise with an archived variation's name is refused; restore the
archived variation instead.

## Settings

Open **Settings** from the header to choose whether the rest timer starts after
each completed set and how long it runs. The initial interval is 2 minutes;
your existing saved interval and enabled choice take precedence. Preferences
stay in this browser. Returning to your workout keeps unfinished Sets, Notes,
and the current countdown.

## Rest timer

Turn on Rest timer during an active workout and choose a rest interval. Marking
a valid set complete starts the countdown, including when the phone is offline.
The timer can be started, paused, resumed, or reset manually; before it starts
and after a reset, it shows the chosen interval. Its enabled state
and interval are kept in this browser; a running countdown is not restored after
the page closes. The timer does not send notifications when the app is closed.

When the countdown finishes, Gymdex plays a short double beep and vibrates the
phone where the browser supports it. Phones only allow the sound after a tap, so
the beep is enabled by checking Done or tapping Start or Resume; a silent switch
or muted media volume can still mute it. iPhones and iPads do not vibrate
because Safari has no vibration support. If the countdown ends while the app is
in the background or the screen is locked, the cue can be late or wait until
you return to the app. When you return more than 30 seconds after the countdown
ended, the timer shows it finished without the cue.

## Log sets

Each newly added exercise starts with one empty, not completed set for every
set in its Last workout reference (see below), or one empty set when there is
none. The rows already exist on the server, so they can be filled in by typing
or by tapping "Last workout" even if the gym signal drops. Enter kilograms and
reps, or seconds for duration exercises. Weight is optional and takes a decimal
point or comma (62.5 or 62,5). Assisted variations,
such as Assisted Pull-up, label the weight Assist kg: enter the machine's
counterweight as a positive amount and Gymdex stores it as a negative value.
Checking Done beside the inputs saves the set as completed right away.
Valid edits, including unfinished sets, save automatically after a short typing
pause, and pressing Enter in a field saves immediately. Add set creates another
row that copies the weight and reps or seconds of the set above it, saved but
not completed; Gymdex saves any edit to the set above first. The × in a set's
corner deletes it after confirmation, and the remaining sets are renumbered, as
in history. Sets can be edited while the workout is active.

Hold an exercise name or choose **Reorder exercises** in Exercise options to
open a compact list. Drag the handles or use the arrows; each move saves
immediately. **Move up** and **Move down** also change its place in the workout.
The × in the exercise's top-right corner deletes the exercise with
all its sets after confirmation. Both actions first save outstanding set edits to the server;
removing an exercise also discards any unsaved drafts for its sets and note on
this phone.

**Change machine**, beside an exercise's equipment and machine details, fixes
them without adding the exercise again, for example when you picked the wrong
manufacturer. It opens the same equipment, Manufacturer and Machine label
choices as adding an exercise, starting from the current ones; **Save** switches
the exercise to that configuration at this gym, and **Cancel** leaves it as it
was. The exercise keeps its sets and note, and its "Last workout" values then
come from the last workout with the new configuration. Choosing an archived
configuration's details restores it. The previous configuration is deleted when
no workout and no routine uses it any more, so a mistaken machine does not stay
under Recent. Change machine is only on the active workout, not in history.

Notes are optional free text, up to 1,000 characters, for anything the numbers
don't capture. They stay collapsed so they never get in the way of logging sets:
tap **Add note** under an exercise's name and equipment, above its sets, or **Add workout note** under the
workout's gym and start time, to open a text box. A collapsed note shows its first words. Notes save
like sets: automatically after a short typing pause or when you leave the box,
with a draft kept on this phone until the server has it, so a note typed without
signal is not lost. A note still waiting to save opens when the page reloads.

Outstanding set and note edits must reach the server before adding, moving,
removing an exercise or changing its machine, or finishing the workout. If one cannot be saved, the page
scrolls to it and a message says why the action waited. Every input change also saves a draft on the current
device. Reloading restores those drafts, including unfinished entries. The page
shows whether changes are saved to the server or waiting on the phone.

If the server cannot be reached, keep editing existing sets and notes. Pending saves retry
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

Every confirmation (finishing or canceling a workout, removing a set or
exercise, deleting a set from history, deleting or archiving in Manage, and
removing an exercise from or deleting a routine) appears
in Gymdex's own sheet rather than the browser's confirmation box, so it also
works in in-app browsers that suppress that box. The action button names the
action, for example **Remove** or **Finish**, and is red when it deletes,
archives or discards something. **Keep** or **Back**, Escape, or a tap outside
the sheet leaves everything as it was.
Naming a routine uses the same kind of sheet with a text box instead of the
browser's prompt. A name the server refuses, such as a duplicate, shows its
reason in the sheet so it can be corrected.

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

## Compact workout view and finish summary

Tap an exercise heading to collapse or expand its sets. Completion counts stay
visible, and collapsing keeps input values and drafts. **Exercise options**
holds notes, View progress, Change machine, reordering, and removal. Options
stay open when changing a machine or reordering. A pending note opens its
options after an offline reload, and a draft blocking Finish expands so it
can be corrected.

The rest timer keeps its clock and Start/Pause controls compact. Open **Timer
settings** to change the interval or reset it. The timer still starts after a
completed set when enabled. Exercise picker sheets support Escape, keep Tab
focus inside the sheet, and return focus to the opening control.

Finishing shows a summary with elapsed time, exercises with completed sets,
and completed-set count. **Save as routine** saves that workout as a plan;
**View workout** opens its history detail. **Done** dismisses the summary.
The summary is shown for the current page session, while the workout itself
remains in History.

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
node tests/keyboard.test.mjs
node tests/confirm-sheet.test.mjs
node tests/choice-field.test.mjs
```

The optional browser regression test uses Playwright, a separate headless
Chromium browser, a temporary database, and an OS-assigned loopback port. It
stops its own server/browser afterward. Install the test dependency outside
the repository and run:

```bash
npm install --prefix /tmp/gymdex-browser playwright
/tmp/gymdex-browser/node_modules/.bin/playwright install chromium
GYMDEX_PLAYWRIGHT_PATH=/tmp/gymdex-browser/node_modules/playwright node tests/browser-smoke.mjs
```

It prints the screenshot/result directory. Set `GYMDEX_BROWSER_ARTIFACTS` to
choose a new directory for its test database and artifacts. This does not add
runtime dependencies to Gymdex.

For a phone smoke test, open Gymdex online, add an exercise and a few sets, then
disconnect the phone. Edit an existing set and reload. Confirm the values are
restored, reconnect, and wait for the saved-to-server status. Check Assist kg
on an assisted variation, editing the middle of an exercise search, and
scrolling with the keyboard open. Sheets and dialogs shrink to the part of the
screen above the keyboard and keep the field you are typing in visible; check
Equipment options in Create custom exercise, a rename in Manage, and naming a
routine.

Without a phone, use the Android emulator (it needs the Android SDK in
`~/Android/Sdk` with an AVD named `gymdex_pixel`; override with `ANDROID_HOME`
and `AVD`):

```bash
scripts/android-emulator.sh
```

It boots the emulator, starts Gymdex on `data/emulator.sqlite3` if nothing is
listening on port 8080, and opens it in the emulator's Chrome at
`http://localhost:8080` through `adb reverse`, so the service worker registers
as it does over HTTPS. The emulator's own network toggle does not cut this
connection; for the offline check run `adb reverse --remove tcp:8080`, and
`adb reverse tcp:8080 tcp:8080` to reconnect. Inspect the page from desktop Chrome at
`chrome://inspect`.

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
To keep daily backups on the Pi and on a second machine, see
[Daily backups](#daily-backups).

## Export and database backup

Use **Export CSV** in Workout history to download workout, exercise, and set rows.
The CSV includes empty workouts and unfinished sets. The `workout_note` and
`exercise_note` columns hold the notes; a note repeats on every row of its
workout or exercise. It is for spreadsheets and
analysis; it does not contain the full catalog or gym configurations. Unlike the
app, the export keeps timestamps in UTC, as its `started_at_utc` and
`completed_at_utc` column names say. Text fields that could be interpreted as
spreadsheet formulas are prefixed with an apostrophe.

For a complete, restorable copy, use SQLite's online backup API through the
included command. It can safely snapshot a running Gymdex database:

```bash
python3 -m gymdex.backup backup ~/gymdex-backup.sqlite3
```

Copy the backup somewhere other than the Pi and verify you can restore it.
[Daily backups](#daily-backups) makes the off-device copy automatically; verify
a restore by hand now and then (see
[Verify a restore from a received backup](#verify-a-restore-from-a-received-backup)).
To restore, stop the Gymdex service first and keep a copy of the current
database. Then run:

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

### Daily backups

Two sets of systemd user units in [deploy/](deploy/) keep 14 days of backups on
the Pi and send a copy to a second machine on your tailnet with Taildrop
(`tailscale file cp`):

- On the Pi, `gymdex-backup.timer` runs `gymdex-backup.service` every night at
  about 03:30, or at the next boot if the Pi was off. It writes
  `~/gymdex-backups/gymdex-YYYY-MM-DD.sqlite3`, deletes dated backups older than
  the newest 14 days, and sends the new file to the device named in
  `~/.config/gymdex/backup.env`. Without that file the backup stays on the Pi.
- On the backup machine, `gymdex-backup-receive.service` moves arriving files
  into `~/gymdex-backups`, and `gymdex-backup-prune.timer` keeps the newest
  14 days there.

Each backup is a full copy of the database, so the newest one is enough to
restore. If the backup machine is off or asleep, the send fails. The local
backup is kept, the service is marked failed, and systemd retries the whole
backup every hour until a send works. Only the newest backup is sent; days
missed while the backup machine was away are not sent later. If the same day is
sent twice, the backup machine keeps both, and the copy with the highest number
in `gymdex-YYYY-MM-DD (N).sqlite3` is the latest.

The same commands work by hand:

```bash
python3 -m gymdex.backup daily ~/gymdex-backups --keep 14 --send-to rhel-thinkpad
python3 -m gymdex.backup prune ~/gymdex-backups --keep 14
```

`daily` reads the target from `GYMDEX_BACKUP_TARGET` when `--send-to` is not
given. Running it again on the same day replaces that day's backup. `prune`
only deletes files named `gymdex-YYYY-MM-DD.sqlite3` or
`gymdex-YYYY-MM-DD (N).sqlite3`.

#### One-time setup on both machines

Taildrop only sends between devices signed in to the same Tailscale account.
Let your user run `tailscale file` without `sudo`, and make sure user services
run while you are logged out:

```bash
sudo tailscale set --operator=$USER
loginctl show-user $USER --property=Linger   # needs Linger=yes
sudo loginctl enable-linger $USER             # only if it said Linger=no
```

#### Backup machine (for example `rhel-thinkpad`)

Set this up first so the Pi's first send has somewhere to go. The prune step
needs a copy of this repository at `~/apps/gymdex`, as on the Pi. The backup
commands work with Python 3.9, the default `python3` on RHEL 9.

```bash
git clone <this repository> ~/apps/gymdex    # or copy it, as on the Pi
mkdir -p ~/.config/systemd/user
cp ~/apps/gymdex/deploy/gymdex-backup-receive.service \
   ~/apps/gymdex/deploy/gymdex-backup-prune.service \
   ~/apps/gymdex/deploy/gymdex-backup-prune.timer ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now gymdex-backup-receive.service gymdex-backup-prune.timer
systemctl --user status gymdex-backup-receive.service   # should be active (running)
```

The receiver moves every file sent to this machine with Taildrop into
`~/gymdex-backups`, not only Gymdex backups. Pruning leaves other files alone.

#### Raspberry Pi

Update `~/apps/gymdex` to this version, then install the timer and name the
backup machine as it appears in `tailscale status`:

```bash
tailscale file cp --targets                  # the backup machine must be listed
mkdir -p ~/.config/systemd/user ~/.config/gymdex
cp ~/apps/gymdex/deploy/gymdex-backup.service \
   ~/apps/gymdex/deploy/gymdex-backup.timer ~/.config/systemd/user/
printf 'GYMDEX_BACKUP_TARGET=rhel-thinkpad\n' > ~/.config/gymdex/backup.env
systemctl --user daemon-reload
systemctl --user enable --now gymdex-backup.timer
systemctl --user start gymdex-backup.service  # first backup now
```

The backup uses the same database as the app, `data/gymdex.sqlite3` inside
`~/apps/gymdex`. If you set `GYMDEX_DB_PATH` for the app, add the same line to
`~/.config/gymdex/backup.env`.

#### Check that the timer ran

On the Pi:

```bash
systemctl --user list-timers gymdex-backup.timer   # LAST and NEXT run times
systemctl --user status gymdex-backup.service      # result and the last log lines
journalctl --user -u gymdex-backup.service -n 20
ls -l ~/gymdex-backups
```

A successful run logs `Backed up …` and `Sent gymdex-YYYY-MM-DD.sqlite3 to …`
and the service is `inactive (dead)`. After a failed send it shows
`activating (auto-restart)` and `Could not send …` until the hourly retry
works. On the backup machine, `ls -l ~/gymdex-backups` shows the received
files, and `systemctl --user list-timers gymdex-backup-prune.timer` shows the
prune runs.

#### Verify a restore from a received backup

On the backup machine, restore the newest backup into a scratch database. The
restore checks that the file is an intact Gymdex database; a damaged or wrong
file fails with an error:

```bash
cd ~/apps/gymdex
ls ~/gymdex-backups
python3 -m gymdex.backup restore ~/gymdex-backups/gymdex-YYYY-MM-DD.sqlite3 \
  --db /tmp/gymdex-restore-check.sqlite3 --replace
python3 -c "import sqlite3; print(sqlite3.connect('/tmp/gymdex-restore-check.sqlite3').execute('SELECT count(*), max(completed_at) FROM workouts').fetchone())"
```

The last command prints the number of workouts and when the latest one was
completed, in UTC. To look through the restored data in the app, start a
second server on the copy (Gymdex needs Python 3.11 or newer; on RHEL 9 install
`python3.11` and use it here), open <http://127.0.0.1:8099>, and check Workout
history. Press Ctrl+C when done and delete the scratch file:

```bash
GYMDEX_DB_PATH=/tmp/gymdex-restore-check.sqlite3 python3.11 -m gymdex.server --port 8099
rm /tmp/gymdex-restore-check.sqlite3
```

To restore the Pi from a received backup, send it back
(`tailscale file cp ~/gymdex-backups/gymdex-YYYY-MM-DD.sqlite3 <pi>:`), fetch
it on the Pi with `tailscale file get ~/`, and follow the restore steps above.

## Data model

Exercise configurations belong to a gym. A configuration can record equipment,
a manufacturer, and a machine label. When it is added to a workout, Gymdex
copies those details into the workout record so old workouts do not change when
the gym configuration is edited later. Change machine on the active workout
updates that copy and the configuration it refers to. A routine refers to a gym's configurations
and stores only their order and set counts.
