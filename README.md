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
- showing completed sets from the last matching workout.

## Log sets

Each newly added exercise starts with one empty set. Enter kilograms and reps,
or seconds for duration exercises. Weight is optional and can be negative for
assistance. Checking Done saves the set as completed; Save set also saves an
unfinished set. Add set creates another row, and Remove deletes a row after
confirmation. Sets can be edited while the workout is active.

Outstanding set edits are saved before adding another exercise or finishing the
workout. Failed saves keep the inputs visible with a retry message. Reloading
restores saved values; unsaved edits trigger the browser's leave-page warning.
This requires a connection to the server and does not provide offline storage.

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
