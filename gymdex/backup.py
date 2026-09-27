"""Make and restore consistent SQLite snapshots of a Gymdex database.

The `daily` and `prune` commands back the scheduled, dated backups in deploy/.
"""

from __future__ import annotations

import argparse
from contextlib import closing
from dataclasses import dataclass
import datetime
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import tempfile
from typing import Callable, Optional


DEFAULT_DB = Path(os.environ.get(
    "GYMDEX_DB_PATH", Path(__file__).resolve().parent.parent / "data" / "gymdex.sqlite3"
))

REQUIRED_COLUMNS = {
    "gyms": {"id", "name"},
    "exercises": {"id", "name"},
    "exercise_variations": {"id", "exercise_id", "name", "tracking_type"},
    "variation_equipment": {"variation_id", "equipment", "position"},
    "gym_exercise_profiles": {"id", "gym_id", "variation_id", "equipment", "manufacturer", "label"},
    "workouts": {"id", "gym_id", "started_at", "completed_at"},
    "workout_exercises": {"id", "workout_id", "variation_id", "position",
                          "exercise_name_snapshot", "variation_name_snapshot", "equipment_snapshot",
                          "manufacturer_snapshot", "label_snapshot", "tracking_type_snapshot"},
    "workout_sets": {"id", "workout_exercise_id", "position", "weight", "result", "completed"},
}


def _assert_no_sidecars(path: Path) -> None:
    """Replacing a SQLite file with a live or uncheckpointed journal can mix data."""
    sidecars = [Path(f"{path}{suffix}") for suffix in ("-wal", "-shm", "-journal")]
    existing = [item for item in sidecars if item.exists()]
    if existing:
        raise ValueError(
            f"Cannot replace {path} while SQLite journal files exist: "
            + ", ".join(str(item) for item in existing)
            + ". Stop Gymdex and let SQLite close or checkpoint the database first."
        )


def _source(path: Path) -> sqlite3.Connection:
    if not path.is_file():
        raise ValueError(f"Database does not exist: {path}")
    connection = sqlite3.connect(f"{path.resolve().as_uri()}?mode=ro", uri=True)
    try:
        if connection.execute("PRAGMA quick_check").fetchone()[0] != "ok":
            raise ValueError(f"Database failed integrity check: {path}")
        for table, required in REQUIRED_COLUMNS.items():
            columns = {row[1] for row in connection.execute(f"PRAGMA table_info({table})")}
            if not required <= columns:
                raise ValueError(f"Not a compatible Gymdex database: {path} ({table} schema)")
        if connection.execute("PRAGMA foreign_key_check").fetchone():
            raise ValueError(f"Database has broken references: {path}")
    except Exception:
        connection.close()
        raise
    return connection


def copy_database(source: Path, destination: Path, *, replace: bool = False) -> None:
    """Copy through SQLite's online backup API, then atomically install the result."""
    source = source.resolve()
    destination = destination.resolve()
    if source == destination:
        raise ValueError("Source and destination must differ.")
    if destination.exists() and not replace:
        raise ValueError(f"Destination already exists: {destination}. Use --replace to overwrite it.")
    _assert_no_sidecars(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(prefix=".gymdex-", suffix=".sqlite3",
                                     dir=destination.parent, delete=False) as temporary:
        temporary_path = Path(temporary.name)
    try:
        with closing(_source(source)) as original, closing(sqlite3.connect(temporary_path)) as copy:
            original.backup(copy)
        with closing(sqlite3.connect(temporary_path)) as copied:
            if copied.execute("PRAGMA quick_check").fetchone()[0] != "ok":
                raise ValueError("Copied database failed integrity check.")
        _assert_no_sidecars(destination)
        if replace:
            temporary_path.replace(destination)
        else:
            # link() installs only when the destination does not exist, even if
            # another backup process created it after our earlier check.
            try:
                os.link(temporary_path, destination)
            except FileExistsError:
                raise ValueError(
                    f"Destination already exists: {destination}. Use --replace to overwrite it."
                ) from None
    finally:
        temporary_path.unlink(missing_ok=True)


DEFAULT_KEEP = 14

# Taildrop's --conflict=rename saves a second copy as "gymdex-YYYY-MM-DD (1).sqlite3".
DATED_BACKUP = re.compile(r"gymdex-(\d{4}-\d{2}-\d{2})(?: \(\d+\))?\.sqlite3")


@dataclass
class DailyBackupResult:
    backup: Path
    removed: list[Path]
    send_error: Optional[str] = None


def backup_name(day: datetime.date) -> str:
    return f"gymdex-{day.isoformat()}.sqlite3"


def prune_backups(directory: Path, *, keep: int = DEFAULT_KEEP) -> list[Path]:
    """Delete dated backups outside the newest `keep` days; ignore every other file."""
    if keep < 1:
        raise ValueError("Keep at least one backup.")
    if not directory.is_dir():
        return []
    by_day: dict[str, list[Path]] = {}
    for path in directory.iterdir():
        match = DATED_BACKUP.fullmatch(path.name)
        if match and path.is_file():
            by_day.setdefault(match.group(1), []).append(path)
    removed = [path for day in sorted(by_day, reverse=True)[keep:] for path in sorted(by_day[day])]
    for path in removed:
        path.unlink()
    return removed


def send_with_taildrop(path: Path, target: str) -> None:
    """Push a file to another tailnet device with `tailscale file cp`."""
    subprocess.run(["tailscale", "file", "cp", str(path), f"{target}:"], check=True)


def daily_backup(database: Path, directory: Path, *, today: datetime.date,
                 keep: int = DEFAULT_KEEP, target: Optional[str] = None,
                 send: Callable[[Path, str], None] = send_with_taildrop) -> DailyBackupResult:
    """Snapshot the database into a file named after the day, apply retention,
    then send the new file off-device when a target is set."""
    backup = directory / backup_name(today)
    copy_database(database, backup, replace=True)
    result = DailyBackupResult(backup=backup, removed=prune_backups(directory, keep=keep))
    if target:
        try:
            send(backup, target)
        except (OSError, subprocess.SubprocessError) as error:
            result.send_error = f"Could not send {backup.name} to {target}: {error}"
    return result


def _positive(value: str) -> int:
    number = int(value)
    if number < 1:
        raise argparse.ArgumentTypeError("must be at least 1")
    return number


def main() -> None:
    parser = argparse.ArgumentParser(description="Back up or restore a Gymdex database.")
    actions = parser.add_subparsers(dest="action", required=True)
    backup = actions.add_parser("backup", help="Create a consistent SQLite backup.")
    backup.add_argument("output", type=Path)
    backup.add_argument("--db", type=Path, default=DEFAULT_DB)
    backup.add_argument("--replace", action="store_true")
    restore = actions.add_parser("restore", help="Restore a backup while Gymdex is stopped.")
    restore.add_argument("input", type=Path)
    restore.add_argument("--db", type=Path, default=DEFAULT_DB)
    restore.add_argument("--replace", action="store_true", required=True,
                         help="Required to replace the current database.")
    daily = actions.add_parser(
        "daily", help="Write today's dated backup, keep the newest days, and send it off-device.")
    daily.add_argument("directory", type=Path)
    daily.add_argument("--db", type=Path, default=DEFAULT_DB)
    daily.add_argument("--keep", type=_positive, default=DEFAULT_KEEP,
                       help=f"Number of days to keep (default {DEFAULT_KEEP}).")
    daily.add_argument("--send-to", default=os.environ.get("GYMDEX_BACKUP_TARGET") or None,
                       help="Tailscale device to send the backup to with Taildrop "
                            "(default: GYMDEX_BACKUP_TARGET; unset means no send).")
    prune = actions.add_parser("prune", help="Delete dated backups outside the newest days.")
    prune.add_argument("directory", type=Path)
    prune.add_argument("--keep", type=_positive, default=DEFAULT_KEEP,
                       help=f"Number of days to keep (default {DEFAULT_KEEP}).")
    args = parser.parse_args()
    try:
        if args.action == "backup":
            copy_database(args.db, args.output, replace=args.replace)
            print(f"Backed up {args.db} to {args.output}")
        elif args.action == "restore":
            copy_database(args.input, args.db, replace=args.replace)
            print(f"Restored {args.input} to {args.db}")
        elif args.action == "daily":
            result = daily_backup(args.db, args.directory, today=datetime.date.today(),
                                  keep=args.keep, target=args.send_to)
            print(f"Backed up {args.db} to {result.backup}")
            for path in result.removed:
                print(f"Removed old backup {path}")
            if result.send_error:
                parser.exit(1, f"gymdex backup: {result.send_error}. "
                               f"The local backup was kept.\n")
            if args.send_to:
                print(f"Sent {result.backup.name} to {args.send_to}")
        else:
            for path in prune_backups(args.directory, keep=args.keep):
                print(f"Removed old backup {path}")
    except (ValueError, sqlite3.DatabaseError, OSError) as error:
        parser.exit(1, f"gymdex backup: {error}\n")


if __name__ == "__main__":
    main()
