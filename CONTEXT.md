# Workout tracking

This context describes the records used to capture strength-training activity in Gymdex.

## Language

**Exercise Variation**:
A performable form of an Exercise with one fixed Tracking Type, its own Muscle Groups, and whether it is Assisted, such as Close-Grip Bench Press, Front Lever Hold, or Assisted Pull-up.
_Avoid_: Exercise type

**Assisted**:
A fixed property of an Exercise Variation whose recorded Weight is a machine counterweight that reduces the load, such as Assisted Pull-up or Assisted Dip. The user enters a positive "Assist kg" amount, and every Weight for the Variation is stored as a negative value.
_Avoid_: Assistance toggle, assisted set

**Equipment**:
A single apparatus classification selected for a Workout Exercise, such as Barbell, Dumbbell, Machine, or Rope. Each Exercise offers only its relevant Equipment values, and Equipment does not list every physical component required to perform the movement.
_Avoid_: Gear, variation

**Exercise Catalog**:
The collection of Exercises available to add to a Workout.
_Avoid_: Exercise library

**Muscle Group**:
A body area that an Exercise Variation is intentionally selected to train. Incidental muscle involvement does not qualify a Variation for that Muscle Group.
_Avoid_: Category, body part

**Tracking Type**:
The kind of result recorded for each Set of an Exercise Variation. The initial Tracking Types are Repetitions and Duration.
_Avoid_: Exercise type, measurement mode

**Archived**:
The state of a used Gym, Exercise Configuration or Custom Exercise Variation that is no longer offered for new Workouts but remains in everything already recorded. It can be restored. Never-used items are deleted instead.
_Avoid_: Hidden, inactive, soft-deleted

**Routine**:
A saved plan for one Gym: an ordered list of Exercise Configurations, each with a number of Sets to start with. It stores no Weights, Repetitions, Durations or Notes. Starting a Routine creates an Active Workout with that many empty Sets per Workout Exercise; Workouts do not refer back to it.
_Avoid_: Template, plan, program

**Workout**:
A time-bounded record of performed exercises and their sets.
_Avoid_: Training, session

**Active Workout**:
The single Workout currently being recorded. At most one Active Workout may exist.

**Completed Workout**:
A finished Workout retained in history. Its recorded Sets may still be corrected, added, or deleted, and the whole Completed Workout may be deleted. New Workout Exercises cannot be added to it.

**Note**:
Optional free text attached to one Workout or one Workout Exercise, recording what its sets do not, such as how the session felt or why a load dropped. A Note describes only that occurrence and is never copied to another Workout. Also make sure the notes in the UI are always above the exercise, not under it.
_Avoid_: Comment, remark, memo

**Set**:
A recorded effort of one Exercise Variation within a Workout. A Set records the result required by the Variation's Tracking Type, may record weight, and counts as performed only after the user marks it complete.

**Effort**:
The optional record of how hard a Set was: Failure, meaning another repetition was attempted and missed, or the repetitions left in reserve: 0, 1, 2, 3 or 4+. Duration Sets record only Failure.

**Weight**:
The optional load recorded for a Set in kilograms, in addition to its repetitions or duration. Positive values represent added resistance. Negative values represent assistance: they are recorded for Assisted Variations, and Sets recorded before assistance became a Variation property may also be negative. Negative values are displayed as "N kg assistance".
