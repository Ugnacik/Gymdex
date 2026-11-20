"""New bests ("records"), modeled on the Strong app's personal records.

Strong tracks, per exercise, the heaviest weight, the best estimated one-rep max (Brzycki,
only from sets of 12 reps or fewer) and the best single-set volume (weight × reps), and
leaves warm-up sets out of all metrics. Gymdex keeps those three for loaded sets and adds
the obvious equivalents where they do not apply:

- assisted sets (negative weight = assistance): less assistance is better, so the record is
  the highest weight, i.e. the least assistance; 1RM and volume make no sense and are skipped;
- unloaded sets (no weight or 0 kg): most reps;
- duration-tracked exercises: longest duration.

Records are kept per Exercise Configuration at a Gym (the same key as "Last workout"),
since machines at different gyms are not comparable, and per Side, so each side of a
one-sided exercise has its own bests. A set is a new best when it beats every earlier
completed, non-warm-up set of that key in completed workouts. The first time a record
type has data there is nothing to beat, so it is not a record. Within a workout only the
workout's best set for each record type carries it (the first one on a tie).

This module is pure and mirrored by static/records.mjs; keep the two in step.
"""
from __future__ import annotations

from typing import Any, Iterable

E1RM_MAX_REPS = 12
RECORD_TYPES = ("weight", "e1rm", "volume", "reps", "duration")
EPSILON = 1e-9


def e1rm(weight: float, reps: int) -> float:
    """Brzycki estimate of a one-rep max, as Strong uses."""
    return weight * 36 / (37 - reps)


def record_values(item: dict[str, Any], tracking_type: str) -> dict[str, float]:
    """The record values one set offers: none unless it is completed, not a warm-up, and has a result."""
    if not item.get("completed") or item.get("set_type") == "warmup":
        return {}
    result, weight = item.get("result"), item.get("weight")
    if result is None or result < 1:
        return {}
    if tracking_type == "duration":
        return {"duration": float(result)}
    if weight is None or weight == 0:
        return {"reps": float(result)}
    if weight < 0:
        return {"weight": float(weight)}
    values = {"weight": float(weight), "volume": float(weight) * result}
    if result <= E1RM_MAX_REPS:
        values["e1rm"] = e1rm(float(weight), result)
    return values


def side_key(item: dict[str, Any]) -> str:
    return item.get("side") or ""


def bests(sets: Iterable[dict[str, Any]], tracking_type: str) -> dict[str, dict[str, float]]:
    """Best value per Side ("" when none) and record type over these sets."""
    found: dict[str, dict[str, float]] = {}
    for item in sets:
        side = found.setdefault(side_key(item), {})
        for kind, value in record_values(item, tracking_type).items():
            if kind not in side or value > side[kind]:
                side[kind] = value
    return {side: values for side, values in found.items() if values}


def records(previous: dict[str, dict[str, float]], sets: list[dict[str, Any]],
            tracking_type: str) -> list[dict[str, Any]]:
    """The new bests among these sets of one Workout Exercise, in set order then RECORD_TYPES order."""
    top: dict[tuple[str, str], tuple[float, dict[str, Any]]] = {}
    for item in sets:
        for kind, value in record_values(item, tracking_type).items():
            key = (side_key(item), kind)
            if key not in top or value > top[key][0] + EPSILON:
                top[key] = (value, item)
    found = []
    for (side, kind), (value, item) in top.items():
        before = previous.get(side, {}).get(kind)
        if before is not None and value > before + EPSILON:
            found.append({"set_id": item["id"], "type": kind, "side": side or None,
                          "value": value, "previous": before})
    order = {item["id"]: index for index, item in enumerate(sets)}
    found.sort(key=lambda record: (order[record["set_id"]], RECORD_TYPES.index(record["type"])))
    return found
