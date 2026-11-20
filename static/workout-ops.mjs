// The Active Workout changes the outbox queues (see outbox.mjs): how each is applied to the
// phone's copy of the workout (data, the bootstrap model), sent, and settled with the server's
// answer. apply() must be safe to run again on server data that already has the change, since
// the queue is replayed onto every fresh bootstrap until the server acknowledges it.

const OTHER_SIDE = { left: "right", right: "left" };

const entryOf = (data, id) => data.workout_exercises.find((entry) => entry.id === id);
const setOf = (data, id) => {
  for (const entry of data.workout_exercises) {
    const set = entry.sets.find((item) => item.id === id);
    if (set) return { entry, set };
  }
  return null;
};
const activeFor = (data, op) => data.active_workout?.id === op.workoutId;
const renumber = (items) => items.forEach((item, index) => { item.position = index + 1; });
const blankSet = (id, position, values = {}) => ({ id, position, weight: null, result: null, completed: false,
  effort: null, side: null, set_type: null, ...values });

// The set Add set shows at once: like the server's copy of the set above (weight, result, Set
// Type, the other Side), not completed and without effort.
export function copiedSetValues(above) {
  if (!above) return {};
  return { weight: above.weight ?? null, result: above.result ?? null,
    side: OTHER_SIDE[above.side] ?? null, set_type: above.set_type ?? null };
}

// Renames an Entry or Set id everywhere in data (a temporary id becoming the server's).
export function renameId(data, type, from, to) {
  if (type === "entry") {
    const entry = entryOf(data, from);
    if (!entry) return;
    // A copy the server already had (its answer was lost, then a reload showed it) is replaced by ours.
    data.workout_exercises = data.workout_exercises.filter((item) => item.id !== to);
    entry.id = to;
  } else {
    const found = setOf(data, from);
    if (!found) return;
    found.entry.sets = found.entry.sets.filter((item) => item.id !== to);
    found.set.id = to;
  }
}

// Server fields of an answer's entry the phone could not know offline.
function adoptEntry(data, entry) {
  const local = entry && entryOf(data, entry.id);
  if (!local) return;
  for (const key of ["variation_id", "exercise_name", "variation_name", "equipment", "manufacturer", "label",
    "tracking_type", "assisted", "previous_sets", "record_bests"]) if (key in entry) local[key] = entry[key];
}

// Data, drafts and screen follow the server id first; then the outbox maps it for later changes.
function remap(outbox, type, from, to) {
  outbox.context.remap?.(type, from, to);
  outbox.map(from, to);
}

export const workoutOps = {
  addExercise: {
    describe: (op) => `adding ${op.entry.exercise_name}`,
    apply(data, op, outbox) {
      if (!activeFor(data, op)) return;
      const id = outbox.resolve(op.entryId);
      if (entryOf(data, id)) return;
      data.workout_exercises.push({ ...op.entry, id, position: data.workout_exercises.length + 1, note: "",
        previous_sets: [], record_bests: {},
        sets: op.setIds.map((setId, index) => blankSet(outbox.resolve(setId), index + 1)) });
    },
    request: (op) => ({ method: "POST", path: `/api/workouts/${op.workoutId}/exercises`, body: { ...op.body, request_id: op.request_id } }),
    done(op, answer, outbox) {
      const { context } = outbox;
      const entry = answer?.entry;
      // An older server answers with the id only: map that, and the sets follow on the next reload.
      if (!entry) { if (answer?.id) remap(outbox, "entry", op.entryId, answer.id); context.changed?.(); return; }
      remap(outbox, "entry", op.entryId, entry.id);
      const data = context.data();
      const local = entryOf(data, entry.id);
      const sets = entry.sets ?? [];
      op.setIds.forEach((setId, index) => {
        if (index < sets.length) remap(outbox, "set", setId, sets[index].id);
        // The server made fewer slots than the phone showed: add the rest, in order, before later changes.
        else outbox.enqueue({ kind: "addSet", workoutId: op.workoutId, entryId: entry.id, setId,
          values: {}, creates: [setId], uses: [entry.id] }, { next: true });
      });
      if (local) {
        // Slots the server made from Last workout: blank ones keep its Sides and Set Types unless edited here.
        for (const [index, server] of sets.entries()) {
          const mine = local.sets.find((item) => item.id === server.id);
          if (mine && !context.edited?.(server.id)) Object.assign(mine, { side: server.side, set_type: server.set_type });
          else if (!mine && index >= op.setIds.length) local.sets.push(server);
        }
        renumber(local.sets);
      }
      adoptEntry(data, entry);
      context.changed?.();
    },
  },
  addSet: {
    describe: () => "adding a set",
    apply(data, op, outbox) {
      if (!activeFor(data, op)) return;
      const entry = entryOf(data, outbox.resolve(op.entryId));
      const id = outbox.resolve(op.setId);
      if (!entry || setOf(data, id)) return;
      entry.sets.push(blankSet(id, entry.sets.length + 1, op.values));
    },
    request: (op, outbox) => ({ method: "POST", path: `/api/workout-exercises/${outbox.resolve(op.entryId)}/sets`,
      body: { ...op.values, request_id: op.request_id } }),
    done(op, answer, outbox) {
      if (answer?.id) remap(outbox, "set", op.setId, answer.id);
      outbox.context.changed?.();
    },
  },
  removeSet: {
    describe: () => "removing a set",
    apply(data, op, outbox) {
      const found = setOf(data, outbox.resolve(op.setId));
      if (!found) return;
      found.entry.sets = found.entry.sets.filter((item) => item !== found.set);
      renumber(found.entry.sets);
    },
    request: (op, outbox) => ({ method: "DELETE", path: `/api/sets/${outbox.resolve(op.setId)}` }),
    ok: (error) => error.status === 404,
  },
  removeExercise: {
    describe: () => "removing an exercise",
    apply(data, op, outbox) {
      const id = outbox.resolve(op.entryId);
      if (!entryOf(data, id)) return;
      data.workout_exercises = data.workout_exercises.filter((item) => item.id !== id);
      renumber(data.workout_exercises);
    },
    request: (op, outbox) => ({ method: "DELETE", path: `/api/workout-exercises/${outbox.resolve(op.entryId)}` }),
    ok: (error) => error.status === 404,
  },
  moveExercise: {
    describe: () => "reordering exercises",
    apply(data, op, outbox) {
      const entry = entryOf(data, outbox.resolve(op.entryId));
      if (!entry) return;
      const others = data.workout_exercises.filter((item) => item !== entry);
      others.splice(Math.min(Math.max(op.position - 1, 0), others.length), 0, entry);
      data.workout_exercises = others;
      renumber(others);
    },
    request: (op, outbox) => ({ method: "PUT", path: `/api/workout-exercises/${outbox.resolve(op.entryId)}`, body: { position: op.position } }),
  },
  replaceExercise: {
    describe: (op) => `replacing with ${op.entry.exercise_name}`,
    apply(data, op, outbox) {
      const entry = entryOf(data, outbox.resolve(op.entryId));
      if (!entry || entry.variation_id === op.entry.variation_id && entry.equipment === op.entry.equipment
        && entry.manufacturer === op.entry.manufacturer && entry.label === op.entry.label) return;
      const clears = entry.tracking_type !== op.entry.tracking_type || Boolean(entry.assisted) !== Boolean(op.entry.assisted);
      Object.assign(entry, op.entry, { previous_sets: [], record_bests: {} });
      if (clears) entry.sets = entry.sets.map((set) => ({ ...set, weight: null, result: null, effort: null, completed: false }));
    },
    request: (op, outbox) => ({ method: "PUT", path: `/api/workouts/${op.workoutId}/exercises/${outbox.resolve(op.entryId)}/replace`, body: op.body }),
    done(op, answer, outbox) { adoptEntry(outbox.context.data(), answer?.entry); outbox.context.changed?.(); },
  },
  changeMachine: {
    describe: () => "changing the machine",
    apply(data, op, outbox) {
      const entry = entryOf(data, outbox.resolve(op.entryId));
      if (entry) Object.assign(entry, op.body);
    },
    request: (op, outbox) => ({ method: "PUT", path: `/api/workouts/${op.workoutId}/exercises/${outbox.resolve(op.entryId)}/configuration`, body: op.body }),
    done(op, answer, outbox) { adoptEntry(outbox.context.data(), answer?.entry); outbox.context.changed?.(); },
  },
  // Set and note drafts handed over when a workout is finished before they reached the server.
  saveSet: {
    describe: () => "saving a set",
    apply(data, op, outbox) {
      const found = setOf(data, outbox.resolve(op.setId));
      if (found) Object.assign(found.set, op.body);
    },
    request: (op, outbox) => ({ method: "PUT", path: `/api/sets/${outbox.resolve(op.setId)}`, body: op.body }),
  },
  saveNote: {
    describe: () => "saving a note",
    apply(data, op, outbox) {
      if (op.target === "workout") { if (activeFor(data, op)) data.active_workout.note = op.note; return; }
      const entry = entryOf(data, outbox.resolve(Number(op.target.slice("exercise:".length))));
      if (entry) entry.note = op.note;
    },
    request: (op, outbox) => ({ method: "PUT", body: { note: op.note }, path: op.target === "workout"
      ? `/api/workouts/${op.workoutId}/note`
      : `/api/workout-exercises/${outbox.resolve(Number(op.target.slice("exercise:".length)))}/note` }),
  },
  finish: {
    describe: () => "finishing the workout",
    apply(data, op) {
      if (!activeFor(data, op)) return;
      data.active_workout = null;
      data.workout_exercises = [];
    },
    request: (op) => ({ method: "POST", path: `/api/workouts/${op.workoutId}/complete`, body: {} }),
  },
};
