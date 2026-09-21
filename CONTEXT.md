# Workout tracking

This context describes the records used to capture strength-training activity in Gymdex.

## Language

**Exercise**:
A named family of related physical movements, such as Bench Press or Front Lever. An Exercise contains one or more Exercise Variations.
_Avoid_: Movement, base exercise

**Exercise Variation**:
A performable form of an Exercise with one fixed Tracking Type and its own Muscle Groups, such as Close-Grip Bench Press or Front Lever Hold.
_Avoid_: Exercise type

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

**Workout**:
A time-bounded record of performed exercises and their sets.
_Avoid_: Training, session

**Active Workout**:
The single Workout currently being recorded. At most one Active Workout may exist.

**Completed Workout**:
A finished Workout retained in history. Its recorded details may still be corrected.

**Workout Exercise**:
A particular Exercise Variation and one relevant Equipment value recorded at one position within a Workout. The same combination may appear more than once, and each occurrence preserves the details used in that Workout even when the catalog changes later.
_Avoid_: Archived Exercise, logged exercise

**Set**:
A recorded effort of one Exercise Variation within a Workout. A Set records the result required by the Variation's Tracking Type, may record weight, and counts as performed only after the user marks it complete.

**Repetition**:
One completed instance of an exercise within a set. "Rep" and "reps" are accepted abbreviations in the interface.
_Avoid_: Count

**Duration**:
The length of a Set whose Tracking Type is Duration, recorded in seconds.

**Weight**:
The optional load recorded for a Set in kilograms, in addition to its repetitions or duration. Positive values may represent added resistance and negative values may represent assistance.
