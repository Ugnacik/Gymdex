// New bests, modeled on the Strong app's personal records. Mirrors gymdex/records.py, which
// explains the rules; keep the two in step. The server sends each Active Workout exercise's
// earlier bests (record_bests), so the phone can mark a set the moment it is completed,
// offline too, and unmark it when the set is edited or uncompleted.

export const E1RM_MAX_REPS = 12;
export const RECORD_TYPES = ["weight", "e1rm", "volume", "reps", "duration"];
const EPSILON = 1e-9;

export function e1rm(weight, reps) { return weight * 36 / (37 - reps); }

export function recordValues(set, trackingType) {
  if (!set.completed || set.set_type === "warmup") return {};
  const { result, weight } = set;
  if (result === null || result === undefined || result < 1) return {};
  if (trackingType === "duration") return { duration: result };
  if (weight === null || weight === undefined || weight === 0) return { reps: result };
  if (weight < 0) return { weight };
  const values = { weight, volume: weight * result };
  if (result <= E1RM_MAX_REPS) values.e1rm = e1rm(weight, result);
  return values;
}

const sideKey = (set) => set.side || "";

// New bests among one Workout Exercise's sets against its earlier bests: only the workout's
// best set per Side and record type (the first on a tie), and only when it beats an earlier one.
export function findRecords(previous, sets, trackingType) {
  const top = new Map();
  for (const set of sets) {
    for (const [type, value] of Object.entries(recordValues(set, trackingType))) {
      const key = `${sideKey(set)}\u0000${type}`;
      if (!top.has(key) || value > top.get(key).value + EPSILON) top.set(key, { value, set, type });
    }
  }
  const order = new Map(sets.map((set, index) => [set.id, index]));
  const found = [];
  for (const { value, set, type } of top.values()) {
    const before = previous?.[sideKey(set)]?.[type];
    if (before !== undefined && before !== null && value > before + EPSILON) {
      found.push({ set_id: set.id, type, side: set.side || null, value, previous: before });
    }
  }
  return found.sort((a, b) => order.get(a.set_id) - order.get(b.set_id) || RECORD_TYPES.indexOf(a.type) - RECORD_TYPES.indexOf(b.type));
}

const round = (value) => Math.round(value * 10) / 10;

// "Weight", or "Least assistance" for assisted sets (whose weight is negative).
export function recordName(record) {
  if (record.type === "weight") return record.value < 0 ? "Least assistance" : "Weight";
  return { e1rm: "Est. 1RM", volume: "Set volume", reps: "Most reps", duration: "Longest time" }[record.type];
}

export function recordValueText(record, value = record.value) {
  if (record.type === "reps") return `${value} reps`;
  if (record.type === "duration") return `${value} sec`;
  if (value < 0) return `${round(-value)} kg assist`;
  return `${round(value)} kg`;
}

// "Weight 105 kg (was 100 kg)".
export function recordText(record) {
  return `${recordName(record)} ${recordValueText(record)} (was ${recordValueText(record, record.previous)})`;
}
