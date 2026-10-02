"""Read CPA usage-report SQLite without modifying it; push idempotent Meterleaf batches."""
import hashlib
from contextlib import closing
import json
import logging
import os
import re
from pathlib import Path
import signal
import sqlite3
import sys
import threading
import time
import urllib.request
import uuid
from datetime import datetime, timezone

VERSION = "0.1.0"
MAX_INTEGER = 2**53 - 1


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


def count(tokens, key):
    value = tokens.get(key)
    if value is None:
        return None
    if type(value) is not int or not 0 <= value <= MAX_INTEGER:
        raise ValueError("invalid_token_count")
    return value


def convert(payload, identity, mode="gpt"):
    event = json.loads(payload)
    model = event["model"]
    if not isinstance(model, str) or not 1 <= len(model) <= 128:
        raise ValueError("invalid_model")
    lower = model.lower()
    gpt = lower.startswith(("gpt-", "o1", "o3", "o4", "codex"))
    claude = lower.startswith("claude-")
    if mode == "gpt" and not gpt:
        return None
    if not (gpt or claude):
        raise ValueError("unknown_token_semantics")
    timestamp = datetime.fromisoformat(event["timestamp"].replace("Z", "+00:00"))
    if timestamp.tzinfo is None:
        raise ValueError("missing_timezone")
    t = event["tokens"]
    inp, out = count(t, "input_tokens"), count(t, "output_tokens")
    read = count(t, "cache_read_tokens")
    # CPA's legacy executors populated cached_tokens only.
    cached = count(t, "cached_tokens")
    if not read and cached:
        read = cached
    write = count(t, "cache_creation_tokens")
    reasoning = count(t, "reasoning_tokens")
    if gpt:
        # OpenAI input includes cached tokens; Meterleaf input must exclude them.
        inp = inp - read - write if None not in (inp, read, write) else None
    if inp is not None and inp < 0:
        raise ValueError("cache_exceeds_input")
    if reasoning is not None and out is not None and reasoning > out:
        raise ValueError("reasoning_exceeds_output")
    source = event.get("source") or event.get("api_key") or "unknown"
    account_id = "cpa-" + digest(str(source))[:24]
    account = dict(externalId=account_id, name="CPA · " + account_id[-8:],
                   platform="openai" if gpt else "anthropic", kind="unknown",
                   plan=None, subjectKey=None)
    metadata = {"origin": "cpa", "failed": bool(event.get("failed", False)),
                "token_semantics": "openai_subset" if gpt else "anthropic_independent"}
    for key in ("latency_ms", "ttft_ms"):
        value = event.get(key)
        if type(value) in (int, float) and 0 <= value < MAX_INTEGER:
            metadata[key] = value
    usage = dict(externalId="cpa-" + digest(identity),
                 occurredAt=timestamp.astimezone(timezone.utc).isoformat(),
                 accountExternalId=account_id, model=model, tier=None,
                 tokens=dict(input=inp, output=out, cacheRead=read, cacheWrite=write,
                             cacheWrite5m=None, cacheWrite1h=None, reasoning=reasoning),
                 metadata=metadata)
    return account, usage


class Bridge:
    def __init__(self, source, state, source_id, mode="gpt", send=None):
        if mode not in ("gpt", "all"):
            raise ValueError("invalid_model_scope")
        if not re.fullmatch(r"[a-zA-Z0-9_-]{1,64}", source_id):
            raise ValueError("invalid_source_id")
        self.source, self.source_id, self.mode = Path(source), source_id, mode
        self.send = send or self.post
        self.db = sqlite3.connect(state)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
            CREATE TABLE IF NOT EXISTS delivered (identity TEXT PRIMARY KEY);
            CREATE TABLE IF NOT EXISTS rejected (identity TEXT PRIMARY KEY, reason TEXT);
        """)
        if self.get("mode") != mode:
            self.put("cursor", "0")
            self.put("mode", mode)
            self.db.commit()

    def get(self, key, default=""):
        row = self.db.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
        return row[0] if row else default

    def put(self, key, value):
        self.db.execute("INSERT OR REPLACE INTO meta VALUES (?,?)", (key, str(value)))

    def post(self, batch):
        url = os.environ["METERLEAF_URL"].rstrip("/") + "/api/ingest/v1/batches"
        key = Path(os.environ["METERLEAF_KEY_FILE"]).read_text().strip()
        req = urllib.request.Request(url, data=json.dumps(batch).encode(), headers={
            "Content-Type": "application/json", "Authorization": "Bearer " + key})
        # The LAN source/destination must not be routed through system proxies.
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(req, timeout=45) as response:
            result = json.load(response)
        expected = {"usage": len(batch["usage"]), "accounts": len(batch["accounts"]), "quotas": 0}
        if result.get("batchId") != batch["batchId"] or result.get("accepted") != expected:
            raise ValueError("invalid_acknowledgement")

    def cycle(self):
        # Reopen on every cycle so CPA database replacement does not leave an old inode open.
        with closing(sqlite3.connect(self.source.resolve().as_uri() + "?mode=ro", uri=True, timeout=10)) as src:
            src.execute("PRAGMA query_only=ON")
            cursor = int(self.get("cursor", "0"))
            anchor = src.execute("SELECT dedup,payload FROM usage_events WHERE id=?", (cursor,)).fetchone()
            if cursor and (not anchor or (anchor[0] or digest(anchor[1])) != self.get("anchor")):
                cursor = 0
            # Periodic rescan catches restored/backfilled rows below a saved cursor.
            if time.time() - float(self.get("rescan", "0")) > 86400:
                cursor = 0
                self.put("rescan", time.time())
            rows = src.execute("SELECT id,dedup,payload FROM usage_events WHERE id>? ORDER BY id LIMIT 500", (cursor,)).fetchall()
        accounts, usage, delivered = {}, [], []
        for row_id, identity, payload in rows:
            identity = identity or digest(payload)
            safe_identity = digest(identity)
            if self.db.execute("SELECT 1 FROM delivered WHERE identity=?", (safe_identity,)).fetchone():
                continue
            try:
                converted = convert(payload, identity, self.mode)
            except (ValueError, KeyError, TypeError, OverflowError):
                self.db.execute("INSERT OR REPLACE INTO rejected VALUES (?,?)", (safe_identity, "invalid_or_unsupported_record"))
                continue
            if converted is None:
                continue
            account, item = converted
            accounts[account["externalId"]] = account
            usage.append(item)
            delivered.append((safe_identity,))
        try:
            if usage:
                # Ingest accepts at most 100 accounts; split if the upstream grows beyond that.
                for offset in range(0, len(usage), 100):
                    part = usage[offset:offset + 100]
                    ids = {item["accountExternalId"] for item in part}
                    self.send(dict(schemaVersion=1, sourceId=self.source_id,
                                   batchId=str(uuid.uuid4()), collector=dict(name="meterleaf-cpa-bridge", version=VERSION),
                                   accounts=[accounts[key] for key in sorted(ids)], usage=part, quotas=[]))
                self.db.executemany("INSERT OR IGNORE INTO delivered VALUES (?)", delivered)
            if rows:
                self.put("cursor", rows[-1][0])
                self.put("anchor", rows[-1][1] or digest(rows[-1][2]))
            self.put("last_success", time.time())
            self.db.commit()
        except Exception:
            # A timeout after server commit is safe: stable external IDs make replay idempotent.
            self.db.rollback()
            raise
        rejected = self.db.execute("SELECT count(*) FROM rejected").fetchone()[0]
        if rows:
            logging.info("synced=%d examined=%d rejected_total=%d cursor=%s", len(usage), len(rows), rejected, self.get("cursor"))
        return len(rows)


def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    os.umask(0o077)
    stop = threading.Event()
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: stop.set())
    state = Path(os.environ.get("STATE_DATABASE", "/data/state.sqlite"))
    if sys.argv[1:] == ["--health"]:
        with closing(sqlite3.connect(state.resolve().as_uri() + "?mode=ro", uri=True)) as db:
            row = db.execute("SELECT value FROM meta WHERE key='last_success'").fetchone()
        sys.exit(0 if row and time.time() - float(row[0]) < 300 else 1)
    bridge = Bridge(os.environ["CPA_DATABASE"], state, os.environ.get("SOURCE_ID", "cpa"), os.environ.get("MODEL_SCOPE", "all"))
    try:
        while not stop.is_set():
            try:
                rows = bridge.cycle()
                stop.wait(0.2 if rows == 500 else 60)
            except Exception as exc:
                bridge.db.rollback()
                # Exception text from network libraries can contain URLs or credential data.
                logging.error("sync_failed type=%s; retry in 60s", type(exc).__name__)
                stop.wait(60)
    finally:
        bridge.db.close()


if __name__ == "__main__":
    main()
