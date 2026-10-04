# Gymdex changes to make

## Exercise Configurations: one removal action

- Use **Delete** consistently instead of making the user distinguish Delete from Archive. Preserve recorded Workouts when removing a used Exercise Configuration; unused ones can be permanently deleted.
- Explain the result briefly where needed: removing a saved choice does not delete its recorded Sets or history.
- Keep a clear way to restore a used configuration. Choosing the same configuration again currently restores it; check that this remains obvious with the new wording.

## Settings and rest defaults

- Add a Settings tab for user-controlled defaults, starting with the rest timer.
- Make the default rest interval **2 minutes** (currently 90 seconds).
- Keep changing the interval during a Workout quick. Define whether an existing saved preference takes precedence over the new default.

## Filter exercises by Muscle Group

- In Add exercise, offer a Muscle Group dropdown and match Muscle Groups in the existing search field.
- Searching `Back` should find Exercises that train Back, rather than only names containing that word, such as Back Squat.
- Make search and dropdown work together, with an obvious way to clear the filter. Include Exercise Variations' Muscle Groups.

## Make manufacturer editing discoverable

- An Exercise just added to an Active Workout must offer an obvious way to change its Manufacturer and Machine label.
- Editing already exists under **Change machine** in Exercise options. Review the label and placement: the current wording did not make manufacturer editing apparent.
- Preserve Sets and Notes when changing the Exercise Configuration, and refresh Last workout values for the chosen configuration.

## Reuse previously entered choices

- When creating or adding an Exercise, offer previously used Manufacturers, Machine labels, and Variation names in dropdowns, while allowing a new value.
- Offer these choices for new Exercises too. For example, after creating a Variation named `Boy`, offer `Boy` when creating another Exercise Variation.
- Current Manufacturer and Machine label suggestions span Gyms but are limited to the same Exercise. Current Variation creation avoids offering names already taken within that Exercise.
- Reusing a Variation name on another Exercise must remain possible. Choosing an existing Variation for the same Exercise should select it rather than create a duplicate.

## Keep Create custom exercise visible

- Make **Create custom exercise** reachable without scrolling to the bottom of the Exercise Catalog.
- Keep it accessible with a long list, active filters, and the phone keyboard open, without covering list items or adding taps to ordinary exercise selection.

## Exercise order, following Strong

- Offer the same style of exercise reordering as Strong. Verify its current interaction before choosing the design.
- Current Active Workout controls include **Move up** and **Move down**. Replace or supplement these with the requested interaction, keeping one-handed use practical.
- Check order changes in Active Workouts and Routines, preserve Sets and Notes, and prevent accidental reordering while scrolling or logging.

## Under consideration: failure and RPE, following Strong

- Consider marking a Set as completed to failure and optionally recording its difficulty (RPE), using Strong's interaction as the reference.
- Verify Strong's current behavior before specifying the controls; this remains an idea to evaluate, not a decided implementation.
- Keep normal Set completion fast. Allow clearing or correcting either value, and include Completed Workout editing if implemented.

## Verification: Gym-specific exercise values

- Visually verify that selecting another Gym changes Recent Exercise Configurations and Last workout suggestions to that Gym's records.
- Use the same Exercise Variation and identical Equipment, Manufacturer, and Machine label at two Gyms with different recorded values. Switch A → B → A to detect cross-Gym leakage.
- Distinguish suggestions from current Set values: a new Set should start empty, and tapping Last workout should fill that Gym's values. Switching context must not overwrite already logged Sets.
- **Verified on 2026-10-04:** phone-sized Chromium (390 × 844), using a consistent read-only snapshot of the live database with test records added only to the copy. Gym A showed 40 kg × 8, Gym B showed 70 kg × 12, and returning to A showed 40 kg × 8. Equipment, Manufacturer, and Machine label were identical at both Gyms. Saved choices belonged to the selected Gym, new Set inputs started empty, and tapping Last workout filled the correct values. Manufacturer editing opened successfully under Change machine. No browser JavaScript errors.
- Scope: Active Workouts, Repetitions, and selecting a Gym before starting a Workout. This pass did not visually retest Duration, Assisted Variations, Routines, Completed Workout editing, or changing a Gym inside an existing Workout. Android/iOS emulators were unavailable; this was a phone-sized browser test. No product behavior changed.
- Previous UI comparison tests did not specifically establish this Gym-switching behavior. Evidence is saved outside the repository at `/home/gejpes/.local/share/gymdex-gym-review/2026-10-04/`.
