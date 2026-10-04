# Gymdex changes to make

## Under consideration: failure and RPE, following Strong

- Consider marking a Set as completed to failure and optionally recording its difficulty (RPE), using Strong's interaction as the reference.
- Verify Strong's current behavior before specifying the controls; this remains an idea to evaluate, not a decided implementation.
- Keep normal Set completion fast. Allow clearing or correcting either value, and include Completed Workout editing if implemented.

## Verification: Gym-specific exercise values

- Verify Duration and Assisted Variations, Routines, Completed Workout editing, and changing the Gym inside an existing Workout if supported.
- Use identical Exercise Configurations at two Gyms with different results and switch A → B → A. Recent and Last workout must show the selected Gym's records.
- New Sets must start empty; tapping Last workout must fill the selected Gym's values without overwriting already logged Sets.
