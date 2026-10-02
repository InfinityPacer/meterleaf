import json
from contextlib import closing
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch
from io import BytesIO

from bridge import Bridge, convert


def event(model="gpt-6-astra", **tokens):
    return json.dumps(dict(model=model, timestamp="2026-10-02T19:50:54.997092967+08:00",
                           source="secret-account@example.test", failed=False,
                           tokens=dict(input_tokens=100, output_tokens=20, cache_read_tokens=60,
                                       cache_creation_tokens=0, reasoning_tokens=5, **tokens)))


class ConversionTests(unittest.TestCase):
    def test_openai_buckets_and_privacy(self):
        account, usage = convert(event(), "stable")
        self.assertEqual(usage["tokens"]["input"], 40)
        self.assertEqual(sum(usage["tokens"][key] for key in ("input", "output", "cacheRead", "cacheWrite")), 120)
        self.assertEqual(usage["tokens"]["reasoning"], 5)
        self.assertNotIn("secret-account", json.dumps([account, usage]))
        self.assertEqual(usage["occurredAt"], "2026-10-02T11:50:54.997092+00:00")

    def test_claude_input_excludes_cache(self):
        self.assertIsNone(convert(event("claude-opus-5"), "x"))
        _, usage = convert(event("claude-opus-5"), "x", "all")
        self.assertEqual(usage["tokens"]["input"], 100)
        self.assertIsNone(usage["tokens"]["cacheWrite5m"])

    def test_unknown_and_invalid_tokens(self):
        with self.assertRaises(ValueError):
            convert(event("mystery-model"), "x", "all")
        payload = json.loads(event())
        payload["tokens"]["cache_read_tokens"] = 101
        with self.assertRaises(ValueError):
            convert(json.dumps(payload), "x")
        payload["tokens"].pop("input_tokens")
        self.assertIsNone(convert(json.dumps(payload), "x")[1]["tokens"]["input"])


class SyncTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.source = self.root / "source.sqlite"
        with closing(sqlite3.connect(self.source)) as db, db:
            db.execute("CREATE TABLE usage_events (id INTEGER PRIMARY KEY, dedup TEXT, payload TEXT)")
            db.execute("INSERT INTO usage_events VALUES (1,?,?)", ("one", event()))
        self.accepted = {}
        self.calls = 0

    def tearDown(self):
        self.temp.cleanup()

    def send(self, batch):
        self.calls += 1
        self.assertLessEqual(len(batch["accounts"]), 100)
        for item in batch["usage"]:
            self.accepted[item["externalId"]] = item

    def bridge(self, send=None, mode="all"):
        b = Bridge(self.source, self.root / "state.sqlite", "test", mode, send or self.send)
        self.addCleanup(b.db.close)
        return b

    def test_restart_and_no_source_mutation(self):
        before = self.source.read_bytes()
        b = self.bridge()
        b.cycle()
        self.assertEqual(len(self.accepted), 1)
        self.bridge().cycle()
        self.assertEqual(self.calls, 1)
        self.assertEqual(before, self.source.read_bytes())

    def test_lost_ack_retry_is_idempotent(self):
        def fail(batch):
            self.send(batch)
            raise TimeoutError()
        b = self.bridge(fail)
        with self.assertRaises(TimeoutError):
            b.cycle()
        self.assertEqual(b.get("cursor", "0"), "0")
        b.send = self.send
        b.cycle()
        self.assertEqual(len(self.accepted), 1)
        self.assertEqual(b.get("cursor"), "1")

    def test_database_replacement_and_append(self):
        b = self.bridge()
        b.cycle()
        with closing(sqlite3.connect(self.source)) as db, db:
            db.execute("UPDATE usage_events SET dedup='replacement' WHERE id=1")
            db.execute("INSERT INTO usage_events VALUES(2,?,?)", ("next", event()))
        b.cycle()
        self.assertEqual(len(self.accepted), 3)

    def test_bad_row_does_not_block_good_rows(self):
        with closing(sqlite3.connect(self.source)) as db, db:
            db.execute("INSERT INTO usage_events VALUES(2,'bad','invalid-json')")
            db.execute("INSERT INTO usage_events VALUES(3,?,?)", ("next", event()))
        b = self.bridge()
        b.cycle()
        self.assertEqual(len(self.accepted), 2)
        self.assertEqual(b.db.execute("SELECT count(*) FROM rejected").fetchone()[0], 1)

    def test_scope_change_recovers_filtered_history(self):
        with closing(sqlite3.connect(self.source)) as db, db:
            db.execute("INSERT INTO usage_events VALUES(2,?,?)", ("claude", event("claude-sonnet-5")))
        self.bridge(mode="gpt").cycle()
        self.assertEqual(len(self.accepted), 1)
        self.bridge(mode="all").cycle()
        self.assertEqual(len(self.accepted), 2)

    def test_wal_rows_are_visible(self):
        with closing(sqlite3.connect(self.source)) as writer, writer:
            writer.execute("PRAGMA journal_mode=WAL")
            writer.execute("INSERT INTO usage_events VALUES(2,?,?)", ("wal", event()))
            writer.commit()
            self.bridge().cycle()
            self.assertEqual(len(self.accepted), 2)

    def test_null_dedup_does_not_repeat_scan(self):
        with closing(sqlite3.connect(self.source)) as db, db:
            db.execute("UPDATE usage_events SET dedup=NULL")
        b = self.bridge()
        self.assertEqual(b.cycle(), 1)
        self.assertEqual(b.cycle(), 0)

    def test_daily_rescan_detects_old_id_changes(self):
        with closing(sqlite3.connect(self.source)) as db, db:
            db.execute("INSERT INTO usage_events VALUES(2,?,?)", ("last", event()))
        b = self.bridge()
        b.cycle()
        with closing(sqlite3.connect(self.source)) as db, db:
            db.execute("UPDATE usage_events SET dedup='replaced' WHERE id=1")
        b.put("rescan", "0")
        b.db.commit()
        b.cycle()
        self.assertEqual(len(self.accepted), 3)

    def test_invalid_http_ack_does_not_save_cursor(self):
        b = self.bridge()
        key = self.root / "key"
        key.write_text("mlk_test")
        b.send = b.post
        with patch.dict("os.environ", {"METERLEAF_URL": "http://example.test", "METERLEAF_KEY_FILE": str(key)}):
            with patch("urllib.request.build_opener") as opener:
                opener.return_value.open.return_value = BytesIO(b'{"accepted":{}}')
                with self.assertRaises(ValueError):
                    b.cycle()
        self.assertEqual(b.get("cursor", "0"), "0")


if __name__ == "__main__":
    unittest.main()
