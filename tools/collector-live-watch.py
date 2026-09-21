#!/usr/bin/env python3
"""Foreground live watch for the compact collector.

Prints one compact line every few seconds and acts on the failures that
previously went unnoticed:

* the collector process is gone, or the LaunchAgent is not loaded;
* the publisher is stuck (no new records / no state update) while reporting
  ``collecting``;
* a match was archived without a window;
* the store started deleting finished matches (retention/size pressure).

Remediation is limited to re-running the idempotent ``npm run collect:start``,
which reinstalls and reloads the LaunchAgent. Every action is logged.
"""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
import subprocess
import sys
import time
import urllib.error
import urllib.request
from collections import deque

MAX_LOG_BYTES = 2 * 1024 * 1024
KEEP_LOG_LINES = 2000


def now_ms() -> int:
    return int(time.time() * 1000)


def fmt(ms: int | None) -> str:
    return "-" if not ms else time.strftime("%H:%M:%S", time.localtime(ms / 1000))


class LiveWatch:
    def __init__(self, project: str, data_root: str, port: int, interval: float,
                 stuck_records_s: int, stuck_state_s: int, restart_after_s: int,
                 log_path: str, auto_restart: bool) -> None:
        self.project = project
        self.data_root = data_root
        self.port = port
        self.interval = interval
        self.stuck_records_s = stuck_records_s
        self.stuck_state_s = stuck_state_s
        self.restart_after_s = restart_after_s
        self.log_path = log_path
        self.auto_restart = auto_restart
        self.db_path = os.path.join(data_root, "tail.sqlite")
        self.state_path = os.path.join(data_root, "state.json")
        self.archives: dict[str, str] = {}
        self.started = False
        self.last_records = 0
        self.last_records_at = time.time()
        self.last_state_ms = 0
        self.last_restart_at = 0.0
        self.last_alerts: dict[str, float] = {}
        self.matches_seen: set[str] = set()
        self.tail_records = 0
        self.matches = 0
        self.staging = 0
        self.db_bytes = 0
        self.deleted_matches = 0
        self.empty_archives = deque()

    # ------------------------------------------------------------------ io
    def api(self) -> dict | None:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{self.port}/api/status", timeout=5) as response:
                return json.loads(response.read().decode("utf-8"))
        except (urllib.error.URLError, OSError, ValueError):
            try:
                with open(self.state_path, "r", encoding="utf-8") as handle:
                    return json.load(handle)
            except (OSError, ValueError):
                return None

    def db_metrics(self) -> dict:
        connection = sqlite3.connect(f"file:{self.db_path}?mode=ro", uri=True, timeout=5)
        try:
            metrics = {
                "matches": connection.execute("SELECT COUNT(*) FROM matches").fetchone()[0],
                "tailRecords": connection.execute("SELECT COUNT(*) FROM tail_records").fetchone()[0],
                "staging": connection.execute("SELECT COUNT(*) FROM staging_records").fetchone()[0],
                "dbBytes": connection.execute("SELECT page_count*page_size FROM pragma_page_count(), pragma_page_size()").fetchone()[0],
                "matchKeys": {row[0] for row in connection.execute("SELECT game_key FROM matches")},
            }
        finally:
            connection.close()
        return metrics

    def log(self, level: str, event: str, **fields: object) -> None:
        record = {"at": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "level": level, "event": event}
        record.update(fields)
        line = json.dumps(record, ensure_ascii=False, default=str)
        try:
            if os.path.exists(self.log_path) and os.path.getsize(self.log_path) > MAX_LOG_BYTES:
                with open(self.log_path, "r", encoding="utf-8", errors="replace") as handle:
                    tail = deque(handle, maxlen=KEEP_LOG_LINES)
                with open(self.log_path, "w", encoding="utf-8") as handle:
                    handle.writelines(tail)
            with open(self.log_path, "a", encoding="utf-8") as handle:
                handle.write(line + "\n")
        except OSError:
            pass
        print(line, flush=True)

    def alert(self, event: str, cooldown_s: int = 120, **fields: object) -> None:
        last = self.last_alerts.get(event, 0.0)
        if time.time() - last < cooldown_s:
            return
        self.last_alerts[event] = time.time()
        self.log("alert", event, **fields)

    # ------------------------------------------------------------ remediation
    def restart_collector(self, reason: str) -> None:
        if not self.auto_restart:
            self.log("alert", "restart_skipped", reason=reason)
            return
        if time.time() - self.last_restart_at < 180:
            return
        self.last_restart_at = time.time()
        self.log("action", "restart_collector", reason=reason)
        try:
            result = subprocess.run(["npm", "run", "collect:start"], cwd=self.project,
                                    capture_output=True, text=True, timeout=120)
            self.log("action", "restart_collector_done", code=result.returncode,
                     tail=(result.stdout or result.stderr or "").strip()[-400:])
        except (OSError, subprocess.SubprocessError) as error:
            self.log("error", "restart_collector_failed", error=str(error))

    # ------------------------------------------------------------------ loop
    def cycle(self) -> None:
        status = self.api()
        metrics = self.db_metrics()
        self.matches = metrics["matches"]
        self.tail_records = metrics["tailRecords"]
        self.staging = metrics["staging"]
        self.db_bytes = metrics["dbBytes"]
        free_gb = None
        mode = "no-status"
        tokens = 0
        records = 0
        state_age_ms = None
        if status is not None:
            mode = status.get("mode")
            tokens = status.get("desiredTokens") or 0
            records = status.get("receivedRecords") or 0
            state_age_ms = now_ms() - int(status.get("updatedAtMs") or 0)
            free = status.get("freeBytes")
            free_gb = round(free / 1024 ** 3, 1) if isinstance(free, int) else None
            compact = status.get("compactStorage") or {}
            self.deleted_matches = compact.get("lastMaintenanceDeletedMatches") or 0

        # progress bookkeeping
        if records != self.last_records:
            self.last_records = records
            self.last_records_at = time.time()
        silent_s = time.time() - self.last_records_at

        # archives: only transitions we witnessed count as news
        if status is not None:
            for game in status.get("games", []):
                key = game.get("key")
                archive = game.get("archive") or {}
                state = str(archive.get("status"))
                previous = self.archives.get(key)
                self.archives[key] = state
                if state != "complete" or previous == "complete" or not self.started:
                    continue
                in_matches = key in metrics["matchKeys"]
                if in_matches:
                    self.log("info", "archive_ok", game=key, anchor=game.get("finishAnchor"),
                             error=archive.get("error"), title=str(game.get("title"))[:40])
                else:
                    self.empty_archives.append(now_ms())
                    self.log("alert", "archive_without_data", game=key, title=str(game.get("title"))[:40],
                             anchor=game.get("finishAnchor"), error=archive.get("error"),
                             lastBookAt=fmt(game.get("lastBookAtMs")), finishedAt=fmt(game.get("finishedAtMs")))
            new_matches = metrics["matchKeys"] - self.matches_seen
            if self.started:
                for key in sorted(new_matches):
                    self.log("info", "match_finalized", game=key)
            self.matches_seen |= metrics["matchKeys"]

        # conditions
        if status is None:
            self.alert("no_status", 60)
            if time.time() - self.last_records_at > self.restart_after_s:
                self.restart_collector("no status from the collector API or state file")
        else:
            if mode == "collecting" and silent_s > self.stuck_records_s:
                self.alert("no_new_records", 120, silentSeconds=round(silent_s), mode=mode, tokens=tokens)
                if silent_s > self.restart_after_s:
                    self.restart_collector(f"no new records for {round(silent_s)}s")
            if mode == "starting" and silent_s > 480:
                self.restart_collector(f"stuck in starting for {round(silent_s)}s")
            if state_age_ms is not None and state_age_ms > self.stuck_state_s * 1000:
                self.alert("state_stale", 120, stateAgeMs=state_age_ms, mode=mode)
                if state_age_ms > self.restart_after_s * 1000:
                    self.restart_collector(f"state not published for {round(state_age_ms/1000)}s")
            if self.deleted_matches > 0:
                self.alert("store_deleted_finished_matches", 600, deleted=self.deleted_matches)
            if free_gb is not None and free_gb < 25:
                self.alert("low_disk", 600, freeGbytes=free_gb)
            if mode == "collecting" and self.staging == 0:
                self.alert("staging_empty", 300, mode=mode)
        self.started = True

        # one compact line per cycle
        self.log("tick", "status", mode=mode, tokens=tokens, records=records, silentSeconds=round(silent_s),
                 matches=self.matches, tailRecords=self.tail_records, staging=self.staging,
                 dbMB=round(self.db_bytes / 1e6, 1), freeGbytes=free_gb,
                 stateAgeMs=state_age_ms, emptyArchives=len(self.empty_archives))

    def run(self) -> None:
        self.log("info", "live_watch_started", dataRoot=self.data_root, intervalSeconds=self.interval,
                 autoRestart=self.auto_restart)
        while True:
            try:
                self.cycle()
            except Exception as error:  # noqa: BLE001 - never die
                self.log("error", "live_cycle_failed", error=f"{type(error).__name__}: {error}")
            time.sleep(self.interval)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", default="/Users/ww/Project/polyFIFA2026")
    parser.add_argument("--data-root", default="/Users/ww/Project/polyFIFA2026/data/collector/continuous")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--interval", type=float, default=5.0)
    parser.add_argument("--stuck-records", type=int, default=60)
    parser.add_argument("--stuck-state", type=int, default=45)
    parser.add_argument("--restart-after", type=int, default=240)
    parser.add_argument("--log", default=None)
    parser.add_argument("--no-restart", action="store_true")
    options = parser.parse_args()
    log_path = options.log or os.path.join(options.data_root, "logs", "live-watch.log")
    LiveWatch(options.project, options.data_root, options.port, options.interval,
              options.stuck_records, options.stuck_state, options.restart_after,
              log_path, not options.no_restart).run()
    return 0


if __name__ == "__main__":
    sys.exit(main())
