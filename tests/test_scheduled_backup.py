import datetime
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from gymdex import db
from gymdex.backup import copy_database, daily_backup, prune_backups


class ScheduledBackupTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.database = self.root / "gymdex.sqlite3"
        self.backups = self.root / "backups"
        connection = db.connect(self.database)
        db.initialize(connection)
        db.create_gym(connection, "Home")
        connection.close()

    def tearDown(self):
        self.directory.cleanup()

    def gyms_in(self, path):
        restored = self.root / "restored.sqlite3"
        copy_database(path, restored, replace=True)
        connection = db.connect(restored)
        try:
            return [gym["name"] for gym in db.bootstrap(connection)["gyms"]]
        finally:
            connection.close()

    def test_daily_backup_writes_a_restorable_file_named_after_the_day(self):
        result = daily_backup(self.database, self.backups, today=datetime.date(2026, 9, 27))

        self.assertEqual(result.backup, self.backups / "gymdex-2026-09-27.sqlite3")
        self.assertEqual(self.gyms_in(result.backup), ["Home"])

    def test_daily_backup_keeps_only_the_newest_days_and_leaves_other_files_alone(self):
        self.backups.mkdir()
        for day in range(1, 20):
            (self.backups / f"gymdex-2026-09-{day:02d}.sqlite3").write_text("old")
        unrelated = ["notes.txt", "gymdex.sqlite3", "gymdex-latest.sqlite3", ".gymdex-tmp.sqlite3"]
        for name in unrelated:
            (self.backups / name).write_text("keep me")

        result = daily_backup(self.database, self.backups, keep=3,
                              today=datetime.date(2026, 9, 27))

        self.assertEqual(sorted(path.name for path in self.backups.iterdir()), sorted(unrelated + [
            "gymdex-2026-09-18.sqlite3",
            "gymdex-2026-09-19.sqlite3",
            "gymdex-2026-09-27.sqlite3",
        ]))
        self.assertEqual(len(result.removed), 17)

    def test_daily_backup_sends_the_new_file_to_the_target_only_when_one_is_set(self):
        sent = []

        def send(path, target):
            sent.append((path.name, target))

        daily_backup(self.database, self.backups, today=datetime.date(2026, 9, 26), send=send)
        daily_backup(self.database, self.backups, today=datetime.date(2026, 9, 27),
                     target="rhel-thinkpad", send=send)

        self.assertEqual(sent, [("gymdex-2026-09-27.sqlite3", "rhel-thinkpad")])

    def test_a_failed_send_keeps_the_local_backup_and_reports_the_error(self):
        self.backups.mkdir()
        (self.backups / "gymdex-2026-09-01.sqlite3").write_text("old")

        def send(path, target):
            raise OSError("rhel-thinkpad is offline")

        result = daily_backup(self.database, self.backups, keep=1, target="rhel-thinkpad",
                              send=send, today=datetime.date(2026, 9, 27))

        self.assertIn("rhel-thinkpad is offline", result.send_error)
        self.assertEqual([path.name for path in self.backups.iterdir()],
                         ["gymdex-2026-09-27.sqlite3"])
        self.assertEqual(self.gyms_in(result.backup), ["Home"])

    def test_a_failed_backup_prunes_and_sends_nothing(self):
        self.backups.mkdir()
        old = [f"gymdex-2026-09-{day:02d}.sqlite3" for day in (1, 2, 3)]
        for name in old:
            (self.backups / name).write_text("old")
        sent = []

        with self.assertRaisesRegex(ValueError, "does not exist"):
            daily_backup(self.root / "missing.sqlite3", self.backups, keep=1,
                         target="rhel-thinkpad", send=lambda path, target: sent.append(path),
                         today=datetime.date(2026, 9, 27))

        self.assertEqual(sorted(path.name for path in self.backups.iterdir()), old)
        self.assertEqual(sent, [])

    def test_pruning_received_backups_counts_renamed_copies_as_the_same_day(self):
        received = self.root / "received"
        received.mkdir()
        names = [
            "gymdex-2026-09-25 (1).sqlite3",
            "gymdex-2026-09-25.sqlite3",
            "gymdex-2026-09-26.sqlite3",
            "gymdex-2026-09-27.sqlite3",
            "gymdex-2026-09-27 (1).sqlite3",
            "gymdex-2026-09-27 (2).sqlite3",
        ]
        for name in names:
            (received / name).write_text("backup")

        removed = prune_backups(received, keep=2)

        self.assertEqual(sorted(path.name for path in removed), sorted(names[:2]))
        self.assertEqual(sorted(path.name for path in received.iterdir()), sorted(names[2:]))

    def test_pruning_before_any_backup_arrived_removes_nothing(self):
        self.assertEqual(prune_backups(self.root / "not-created-yet"), [])



class ScheduledBackupCommandTests(unittest.TestCase):
    """The command lines the systemd units run, with a fake `tailscale` on PATH."""

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.database = self.root / "gymdex.sqlite3"
        self.backups = self.root / "backups"
        connection = db.connect(self.database)
        db.initialize(connection)
        connection.close()
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.calls = self.root / "tailscale-calls"

    def tearDown(self):
        self.directory.cleanup()

    def fake_tailscale(self, exit_code):
        script = self.bin / "tailscale"
        script.write_text(f'#!/bin/sh\nprintf "%s\\n" "$@" >> "{self.calls}"\nexit {exit_code}\n')
        script.chmod(0o755)

    def run_backup(self, *args, target=None):
        environment = {**os.environ, "PATH": f"{self.bin}{os.pathsep}{os.environ['PATH']}"}
        environment.pop("GYMDEX_BACKUP_TARGET", None)
        if target is not None:
            environment["GYMDEX_BACKUP_TARGET"] = target
        return subprocess.run([sys.executable, "-m", "gymdex.backup", *args],
                              cwd=Path(__file__).resolve().parent.parent, env=environment,
                              capture_output=True, text=True)

    def test_daily_command_sends_the_dated_backup_with_tailscale(self):
        self.fake_tailscale(0)

        completed = self.run_backup("daily", str(self.backups), "--db", str(self.database),
                                    target="rhel-thinkpad")

        self.assertEqual(completed.returncode, 0, completed.stderr)
        [backup] = self.backups.iterdir()
        self.assertRegex(backup.name, r"^gymdex-\d{4}-\d{2}-\d{2}\.sqlite3$")
        self.assertEqual(self.calls.read_text().splitlines(),
                         ["file", "cp", str(backup), "rhel-thinkpad:"])

    def test_daily_command_without_a_target_only_backs_up_locally(self):
        self.fake_tailscale(0)

        completed = self.run_backup("daily", str(self.backups), "--db", str(self.database))

        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(len(list(self.backups.iterdir())), 1)
        self.assertFalse(self.calls.exists())

    def test_daily_command_fails_visibly_but_keeps_the_backup_when_sending_fails(self):
        self.fake_tailscale(1)

        completed = self.run_backup("daily", str(self.backups), "--db", str(self.database),
                                    target="rhel-thinkpad")

        self.assertNotEqual(completed.returncode, 0)
        self.assertIn("Could not send", completed.stderr)
        self.assertEqual(len(list(self.backups.iterdir())), 1)

    def test_prune_command_keeps_the_newest_days(self):
        self.backups.mkdir()
        for day in range(1, 5):
            (self.backups / f"gymdex-2026-09-{day:02d}.sqlite3").write_text("backup")

        completed = self.run_backup("prune", str(self.backups), "--keep", "2")

        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(sorted(path.name for path in self.backups.iterdir()),
                         ["gymdex-2026-09-03.sqlite3", "gymdex-2026-09-04.sqlite3"])


if __name__ == "__main__":
    unittest.main()
