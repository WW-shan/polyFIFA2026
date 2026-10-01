#!/usr/bin/env python3
"""Live watchdog for the compact collector.

Watches the two failure modes that silently lost matches:

* a game is archived (``archive.status == complete``) while nothing was written
  into ``matches``/``tail_records`` - the "closing whistle with no data" case;
* no new finalized match appears even though games keep getting archived.

It also keeps a short rolling history of ``staging_records`` per game, so when a
game is archived empty the log shows whether its frames were staged at all in
the minutes before the archive turn.

Stdlib only, read-only against the collector: it opens ``tail.sqlite`` with
``mode=ro`` and reads the status API over loopback.
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

from collector_watch_utils import npm_env, resolve_npm

MAX_LOG_BYTES = 4 * 1024 * 1024
KEEP_LOG_LINES = 4000
# A condition that persists (low disk, a paused collector, an empty staging
# table) is reported when it starts and then at most this often. Logging it on
# every 5-second cycle pushed restart history out of the rotated log.
REPEAT_ALERT_MS = 300_000


def now_ms() -> int:
    return int(time.time() * 1000)


def _valid_timestamp(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def expected_shutdown_error(message: str) -> bool:
    """True for the cancellation diagnostic emitted during an intentional stop/restart."""

    return message == "Collector stopped" or message.endswith(": Collector stopped")


def merge_heartbeat_status(status: dict, heartbeat: object) -> dict:
    """Overlay a matching heartbeat timestamp on a saved full status snapshot."""

    if not isinstance(heartbeat, dict):
        return status
    if heartbeat.get("instanceId") != status.get("instanceId") or heartbeat.get("pid") != status.get("pid"):
        return status
    heartbeat_ms = heartbeat.get("updatedAtMs")
    status_ms = status.get("updatedAtMs")
    if not _valid_timestamp(heartbeat_ms) or not _valid_timestamp(status_ms):
        return status
    if heartbeat_ms <= status_ms:
        return status
    merged = dict(status)
    merged["updatedAtMs"] = heartbeat_ms
    last_record_ms = heartbeat.get("lastRecordAtMs")
    current_last_record_ms = status.get("lastRecordAtMs")
    if _valid_timestamp(last_record_ms) and (
        not _valid_timestamp(current_last_record_ms) or last_record_ms > current_last_record_ms
    ):
        merged["lastRecordAtMs"] = last_record_ms
    return merged


def fmt_clock(ms: int | None) -> str:
    if not ms:
        return "-"
    return time.strftime("%H:%M:%S", time.localtime(ms / 1000))


class LogFile:
    def __init__(self, path: str) -> None:
        self.path = path
        os.makedirs(os.path.dirname(path), exist_ok=True)

    def write(self, level: str, event: str, **fields: object) -> dict:
        record = {"at": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "level": level, "event": event}
        record.update(fields)
        line = json.dumps(record, ensure_ascii=False, default=str)
        # A full disk or a removed logs directory must not take the watcher
        # down: the line still reaches stdout and the next cycle retries.
        try:
            os.makedirs(os.path.dirname(self.path), exist_ok=True)
            self._rotate_if_needed()
            with open(self.path, "a", encoding="utf-8") as handle:
                handle.write(line + "\n")
        except OSError:
            pass
        try:
            print(line, flush=True)
        except OSError:
            pass
        return record

    def _rotate_if_needed(self) -> None:
        try:
            if os.path.getsize(self.path) <= MAX_LOG_BYTES:
                return
        except FileNotFoundError:
            return
        with open(self.path, "r", encoding="utf-8", errors="replace") as handle:
            tail = deque(handle, maxlen=KEEP_LOG_LINES)
        with open(self.path, "w", encoding="utf-8") as handle:
            handle.writelines(tail)


class HealthWatch:
    def __init__(self, data_root: str, port: int, log: LogFile, heartbeat_s: float,
                 empty_archive_grace_s: int, silent_match_alert_s: int,
                 project: str = "/Users/ww/Project/polyFIFA2026", auto_restart: bool = True,
                 count_refresh_s: float = 300.0) -> None:
        self.project = project
        self.auto_restart = auto_restart
        self.data_root = data_root
        self.port = port
        self.log = log
        self.heartbeat_s = heartbeat_s
        self.empty_archive_grace_s = empty_archive_grace_s
        self.silent_match_alert_s = silent_match_alert_s
        self.db_path = os.path.join(data_root, "tail.sqlite")
        self.state_path = os.path.join(data_root, "state.json")
        self.archives: dict[str, str] = {}
        self.history: dict[str, deque] = {}
        self.last_archive_at_ms: int | None = None
        self.last_match_at_ms: int | None = None
        self.matches_seen: set[str] = set()
        self.last_heartbeat_at = 0.0
        self.last_error_line = ""
        self.started = False
        self.stale = False
        self.last_restart_at = 0.0
        self.seen_status_errors: set[tuple[str, int, str]] = set()
        self.last_data_age_ms: int | None = None
        # Cycles that ended in an exception. A watcher restart resets the
        # in-process ``started`` flag, so a collector that was already stuck
        # when the watcher came up could never be restarted; count failures
        # instead of relying on having observed one healthy cycle first.
        self.consecutive_failures = 0
        # Multi-million-row counts are refreshed on this cadence, not every
        # cycle: holding a read transaction open for the whole sweep blocked
        # the collector's WAL checkpoint in production.
        self.count_refresh_s = count_refresh_s
        self.last_count_refresh_at: float | None = None
        self.cached_tail_records: int | None = None
        self.deleted_matches = 0
        self.empty_archive_counts: deque = deque()
        self.stop_marker = os.path.join(data_root, ".collector-stopped")
        self.intentionally_stopped = False
        # Time in the current mode, as observed by this watcher. Keyed on the
        # process identity too, so a restarted collector that comes back in
        # `starting` gets a fresh clock instead of inheriting the old one.
        self.mode_key: tuple | None = None
        self.mode_since_ms = 0
        self.watch_started_at_ms: int | None = None
        # event -> (episode start ms, last logged ms) for persistent conditions.
        self.repeating_alerts: dict[str, tuple[int, int]] = {}

    # ---------------------------------------------------------------- sources
    def api_status(self) -> dict:
        url = f"http://127.0.0.1:{self.port}/api/status?view=compact"
        try:
            with urllib.request.urlopen(url, timeout=10) as response:
                return json.loads(response.read().decode("utf-8"))
        except (urllib.error.URLError, OSError, ValueError):
            with open(self.state_path, "r", encoding="utf-8") as handle:
                status = json.load(handle)
            try:
                with open(os.path.join(self.data_root, "state-heartbeat.json"), "r", encoding="utf-8") as handle:
                    heartbeat = json.load(handle)
            except (OSError, ValueError):
                heartbeat = None
            return merge_heartbeat_status(status, heartbeat)

    def stop_requested(self) -> bool:
        """True while the operator has stopped the collector on purpose.

        ``collect:stop`` leaves a marker behind; without it the watchdog cannot
        tell an intentional stop from a crash and would restart the collector -
        including in the middle of the documented ``repair-tail`` workflow that
        requires a stopped collector.
        """
        return os.path.exists(self.stop_marker)

    def db(self) -> sqlite3.Connection:
        return sqlite3.connect(f"file:{self.db_path}?mode=ro", uri=True, timeout=10)

    def db_metrics(self, connection: sqlite3.Connection, *, refresh_counts: bool = False) -> dict:
        """Read the cheap health metrics; refresh the expensive counts rarely.

        ``COUNT(*) FROM payloads`` measured 38 s and a full ``tail_records``
        scan 5 s on the 2026-09 store. Running them every cycle kept a read
        transaction open almost continuously, which stopped the collector
        from ever completing a WAL checkpoint: the write-ahead log grew to
        7.8 GB and could not be truncated. Keep this sweep small; the
        expensive counts are refreshed on ``count_refresh_s`` and per-match
        counts are read lazily through the indexed game key.
        """
        metrics = {}
        for name, sql in (
            ("matches", "SELECT COUNT(*) FROM matches"),
            ("stagingRecords", "SELECT COUNT(*) FROM staging_records"),
            ("stagingGames", "SELECT COUNT(DISTINCT game_key) FROM staging_records"),
            ("stagingOldestMs", "SELECT MIN(received_at_ms) FROM staging_records"),
        ):
            row = connection.execute(sql).fetchone()
            metrics[name] = row[0] if row else None
        metrics["matchKeys"] = {row[0] for row in connection.execute("SELECT game_key FROM matches")}
        metrics["recordsPerMatch"] = {}
        if refresh_counts:
            row = connection.execute("SELECT COUNT(*) FROM tail_records").fetchone()
            self.cached_tail_records = row[0] if row else None
        metrics["tailRecords"] = self.cached_tail_records
        return metrics

    def record_counts(self, keys: Iterable[str]) -> dict[str, int]:
        """Per-match record counts through the (game_key, ...) primary key."""
        wanted = [key for key in dict.fromkeys(keys) if key]
        if not wanted:
            return {}
        counts: dict[str, int] = {}
        connection: sqlite3.Connection | None = None
        try:
            connection = self.db()
            for key in wanted:
                row = connection.execute(
                    "SELECT COUNT(*) FROM tail_records WHERE game_key = ?", (key,)).fetchone()
                counts[key] = int(row[0]) if row else 0
        except sqlite3.Error:
            return counts
        finally:
            if connection is not None:
                connection.close()
        return counts

    def record_count(self, key: str) -> int:
        return self.record_counts([key]).get(key, 0)

    def staging_snapshot(self, connection: sqlite3.Connection) -> dict:
        rows = connection.execute(
            "SELECT game_key, COUNT(*), MIN(received_at_ms), MAX(received_at_ms) "
            "FROM staging_records GROUP BY game_key").fetchall()
        return {row[0]: {"records": row[1], "oldest": row[2], "newest": row[3]} for row in rows}

    def read_db_metrics(self, attempts: int = 20, delay_s: float = 0.5) -> tuple[dict, dict]:
        """Read metrics, tolerating the collector's short restart window.

        ``collect:start`` can briefly replace or lock the SQLite files while the
        old process exits. A single ``unable to open database file`` therefore
        says "retry", not "the collector is broken". After the bounded retries
        the original error is raised so a persistent failure is still visible.
        """
        last_error: sqlite3.OperationalError | None = None
        for attempt in range(max(1, attempts)):
            connection: sqlite3.Connection | None = None
            try:
                connection = self.db()
                refresh = (self.last_count_refresh_at is None
                           or time.time() - self.last_count_refresh_at >= self.count_refresh_s)
                metrics = self.db_metrics(connection, refresh_counts=refresh)
                if refresh:
                    self.last_count_refresh_at = time.time()
                return metrics, self.staging_snapshot(connection)
            except sqlite3.OperationalError as error:
                last_error = error
                if attempt + 1 < attempts:
                    time.sleep(delay_s)
            finally:
                if connection is not None:
                    connection.close()
        assert last_error is not None
        raise last_error

    # ------------------------------------------------------------ remediation
    def restart_collector(self, reason: str) -> None:
        """Re-run the idempotent start command when the publisher is stuck."""
        if time.time() - self.last_restart_at < 300:
            return
        self.last_restart_at = time.time()
        self.log.write("action", "restart_collector", reason=reason)
        try:
            npm = resolve_npm()
            result = subprocess.run([npm, "run", "collect:restart"], cwd=self.project,
                                    capture_output=True, text=True, timeout=180,
                                    env=npm_env(npm))
            tail = (result.stdout or result.stderr or "").strip()[-400:]
            # A non-zero exit is how a restart silently failed for weeks: the
            # neutral "done" line hid `env: node: No such file or directory`.
            level = "action" if result.returncode == 0 else "alert"
            event = "restart_collector_done" if result.returncode == 0 else "restart_collector_failed"
            self.log.write(level, event, code=result.returncode, tail=tail)
        except (OSError, subprocess.SubprocessError) as error:
            self.log.write("error", "restart_collector_failed", error=str(error))

    # ------------------------------------------------------------------ checks
    def condition_alert(self, event: str, active: bool, **fields: object) -> None:
        """Report a persistent condition once per episode, then at a bounded rate."""
        if not active:
            self.repeating_alerts.pop(event, None)
            return
        current = now_ms()
        first_ms, last_ms = self.repeating_alerts.get(event, (current, None))
        if last_ms is not None and current - last_ms < REPEAT_ALERT_MS:
            return
        self.repeating_alerts[event] = (first_ms, current)
        if current > first_ms:
            fields["ongoingSeconds"] = round((current - first_ms) / 1000)
        self.log.write("alert", event, **fields)

    def check_archives(self, status: dict, metrics: dict, snapshot: dict) -> list[dict]:
        alerts = []
        for game in status.get("games", []):
            key = game.get("key")
            archive = game.get("archive") or {}
            state = str(archive.get("status"))
            previous = self.archives.get(key)
            self.archives[key] = state
            if state != "complete" or previous == "complete":
                continue
            # Archives already complete when the watcher starts are history, not
            # news: only transitions this process witnessed are reported.
            if not self.started:
                continue
            self.last_archive_at_ms = now_ms()
            records = self.record_count(key)
            in_matches = key in metrics["matchKeys"]
            base = {"game": key, "title": str(game.get("title"))[:48], "sport": game.get("sport"),
                    "records": records, "inMatches": in_matches, "attempt": archive.get("attempt"),
                    "error": archive.get("error"), "anchor": game.get("finishAnchor"),
                    "bookUpdates": game.get("bookUpdates"),
                    "lastBookAt": fmt_clock(game.get("lastBookAtMs")),
                    "finishedAt": fmt_clock(game.get("finishedAtMs"))}
            if in_matches and records > 0:
                self.log.write("info", "archive_ok", **base)
            else:
                history = list(self.history.get(key, []))
                self.empty_archive_counts.append(now_ms())
                alerts.append(self.log.write(
                    "alert", "archive_without_data",
                    stagedBefore=list(history)[-8:],
                    stagedNow=snapshot.get(key),
                    **base))
        return alerts

    def anchor_drift(self, status: dict, snapshot: dict) -> tuple[str, int] | None:
        """Worst gap between a game's last-book clock and its newest staged frame.

        A positive drift larger than the tail window means the finish anchor
        would land past every stored frame; the collector now moves the anchor
        back, so this is the leading indicator that the fallback is carrying a
        game rather than the clock being right.
        """
        worst: tuple[str, int] | None = None
        for game in status.get("games", []):
            key = game.get("key")
            staged = snapshot.get(key)
            last_book = game.get("lastBookAtMs")
            if not staged or not isinstance(last_book, int):
                continue
            drift = last_book - staged["newest"]
            if worst is None or drift > worst[1]:
                worst = (key, drift)
        return worst

    def check_health(self, status: dict, metrics: dict, previous_metrics: dict | None) -> None:
        snapshot = {}
        if metrics.get("stagingRecords") is not None:
            snapshot["stagingRecords"] = metrics["stagingRecords"]
        if metrics.get("matches") is not None:
            snapshot["matches"] = metrics["matches"]
        state_age_ms = now_ms() - int(status.get("updatedAtMs") or 0)
        # The collector's own threshold is 15s, but a pulse that runs a
        # discovery pass or a snapshot sweep can legitimately take longer while
        # records keep flowing, so only a genuinely stuck publisher alerts.
        stale_after_ms = max(3 * int(status.get("stateStaleAfterMs") or 15_000), 45_000)
        stopped = self.stop_requested()
        if stopped != self.intentionally_stopped:
            self.intentionally_stopped = stopped
            self.log.write("info", "stop_marker_changed", intentionallyStopped=stopped,
                           note="collect:stop records an intentional stop; the watchdog will not restart it")
        stale = state_age_ms > stale_after_ms and not stopped
        mode = status.get("mode")
        if self.watch_started_at_ms is None:
            self.watch_started_at_ms = now_ms()
        mode_key = (status.get("instanceId"), status.get("pid"), mode)
        if mode_key != self.mode_key:
            self.mode_key = mode_key
            self.mode_since_ms = now_ms()
            self.repeating_alerts.pop("mode_not_collecting", None)
        mode_age_ms = now_ms() - self.mode_since_ms
        last_record_at_ms = status.get("lastRecordAtMs")
        data_age_ms = now_ms() - last_record_at_ms if _valid_timestamp(last_record_at_ms) else None
        self.last_data_age_ms = data_age_ms
        data_stale = mode == "collecting" and (data_age_ms is None or data_age_ms > 60_000)
        self.stale = stale or data_stale
        if stale:
            snapshot["stale"] = True
            snapshot["stateAgeMs"] = state_age_ms
        self.condition_alert("status_stale", stale, **snapshot)
        if data_stale:
            snapshot["dataAgeMs"] = data_age_ms
        self.condition_alert("data_stale", data_stale, **snapshot)
        errors = status.get("errors")
        if isinstance(errors, list):
            cutoff_ms = now_ms() - 15 * 60_000
            # The dedupe set only needs to remember errors that could still be
            # reported, so drop anything older than the alert window instead of
            # growing one entry per error for the lifetime of the watcher.
            for key in [key for key in self.seen_status_errors if key[1] < cutoff_ms]:
                self.seen_status_errors.discard(key)
            for error in errors:
                if not isinstance(error, dict):
                    continue
                scope = error.get("scope")
                at_ms = error.get("atMs")
                message = error.get("message")
                if not isinstance(scope, str) or not _valid_timestamp(at_ms) or not isinstance(message, str):
                    continue
                key = (scope, at_ms, message)
                if key in self.seen_status_errors:
                    continue
                self.seen_status_errors.add(key)
                # A watcher restarted alongside the collector can read the old
                # process's last snapshot. Remember those errors for dedupe but
                # do not report them as new until a later cycle proves the
                # condition survived the restart.
                if self.started and at_ms >= cutoff_ms and not expected_shutdown_error(message):
                    self.log.write("alert", "collector_error", scope=scope[:128], atMs=at_ms, message=message[:2000])
        # A fresh process legitimately reports `starting` with no subscriptions
        # yet, so only a stuck or degraded mode is an alert. An intentional stop
        # is not an alert either. A fresh state file says nothing about how long
        # the collector has been starting, so the grace uses time in the mode.
        not_collecting = (self.started and not stopped and mode != "collecting"
                          and (mode != "starting" or mode_age_ms > 120_000))
        self.condition_alert("mode_not_collecting", not_collecting, mode=mode,
                             modeSeconds=round(mode_age_ms / 1000), **snapshot)
        self.condition_alert("staging_empty", mode == "collecting" and (metrics.get("stagingRecords") or 0) == 0,
                             **snapshot)
        self.condition_alert("no_desired_tokens", mode == "collecting" and status.get("desiredTokens", 0) == 0,
                             **snapshot)
        compact = status.get("compactStorage") or {}
        deleted = compact.get("lastMaintenanceDeletedMatches") or 0
        if deleted > self.deleted_matches:
            self.deleted_matches = deleted
            self.log.write("alert", "store_deleted_finished_matches", deleted=deleted,
                           note="retention/size pressure removed finished matches from the backtest store")
        # A publisher that stops progressing while claiming to collect, or that
        # never leaves `starting`, is restarted instead of waiting for a human.
        # Missing records only count while collecting: `paused_disk` stops the
        # streams on purpose and a restart cannot free any disk.
        stuck_ms = 300_000
        no_records = mode == "collecting" and (
            data_age_ms > stuck_ms if data_age_ms is not None else mode_age_ms > stuck_ms)
        stuck_starting = mode == "starting" and mode_age_ms > 900_000
        if self.started and self.auto_restart and not stopped and (
                state_age_ms > stuck_ms or no_records or stuck_starting):
            reason = f"state age {round(state_age_ms/1000)}s in mode {mode}"
            if no_records:
                reason += f"; no records for {round((data_age_ms if data_age_ms is not None else mode_age_ms)/1000)}s"
            if stuck_starting:
                reason += f"; starting for {round(mode_age_ms/1000)}s"
            self.restart_collector(reason)
        new_matches = metrics["matchKeys"] - self.matches_seen
        if self.started:
            for key in sorted(new_matches):
                self.last_match_at_ms = now_ms()
                self.log.write("info", "match_finalized", game=key,
                               records=self.record_count(key))
        self.matches_seen |= metrics["matchKeys"]
        # Before the first finalized match the watcher's own start is the
        # baseline; otherwise a store that never finalizes anything would
        # never raise this alert at all.
        last_match_at_ms = self.last_match_at_ms if self.last_match_at_ms is not None else self.watch_started_at_ms
        if self.started and self.last_archive_at_ms is not None:
            silent_ms = now_ms() - last_match_at_ms
            if self.last_archive_at_ms > last_match_at_ms and silent_ms > self.silent_match_alert_s * 1000:
                self.log.write("alert", "archives_without_new_matches",
                               silentSeconds=round(silent_ms / 1000),
                               archivesSeen=len(self.empty_archive_counts))
                self.last_match_at_ms = now_ms()  # re-arm instead of spamming
        cutoff = now_ms() - 3600_000
        while self.empty_archive_counts and self.empty_archive_counts[0] < cutoff:
            self.empty_archive_counts.popleft()
        free = status.get("freeBytes")
        self.condition_alert("low_disk", isinstance(free, int) and free < 20 * 1024 ** 3, freeBytes=free)

    def prune_runtime_state(self, status: dict, metrics: dict) -> None:
        """Forget per-game bookkeeping once the collector no longer reports it."""

        status_keys = {game.get("key") for game in status.get("games", []) if isinstance(game, dict) and isinstance(game.get("key"), str)}
        match_keys = metrics.get("matchKeys")
        if not isinstance(match_keys, set):
            match_keys = set(match_keys or ())
        keep_archives = status_keys | match_keys
        self.archives = {key: value for key, value in self.archives.items() if key in keep_archives}
        self.history = {key: value for key, value in self.history.items() if key in status_keys}
        self.matches_seen.intersection_update(match_keys)

    def run(self, interval_s: float) -> None:
        previous_metrics = None
        self.log.write("info", "watch_started", dataRoot=self.data_root, db=self.db_path,
                       intervalSeconds=interval_s)
        while True:
            try:
                status = self.api_status()
                metrics, snapshot = self.read_db_metrics()
                for key, info in snapshot.items():
                    bucket = self.history.setdefault(key, deque(maxlen=20))
                    if not bucket or bucket[-1]["at"] != info["newest"] or bucket[-1]["records"] != info["records"]:
                        bucket.append({"at": fmt_clock(now_ms()), "records": info["records"],
                                       "oldest": fmt_clock(info["oldest"]), "newest": fmt_clock(info["newest"])})
                self.consecutive_failures = 0
                self.check_archives(status, metrics, snapshot)
                self.check_health(status, metrics, previous_metrics)
                drift = self.anchor_drift(status, snapshot)
                previous_metrics = metrics
                self.started = True
                self.prune_runtime_state(status, metrics)
                if time.time() - self.last_heartbeat_at >= self.heartbeat_s:
                    self.last_heartbeat_at = time.time()
                    self.log.write(
                        "info", "heartbeat",
                        mode=status.get("mode"), stale=self.stale,
                        dataAgeMs=None if self.last_data_age_ms is None else round(self.last_data_age_ms),
                        desiredTokens=status.get("desiredTokens"),
                        receivedRecords=status.get("receivedRecords"),
                        matches=metrics["matches"], tailRecords=metrics["tailRecords"],
                        stagingRecords=metrics["stagingRecords"], stagingGames=metrics["stagingGames"],
                        dbBytes=(status.get("compactStorage") or {}).get("databaseBytes"),
                        rawBytes=status.get("rawBytes"), freeGbytes=round((status.get("freeBytes") or 0) / 1024 ** 3, 2),
                        emptyArchivesLastHour=len(self.empty_archive_counts),
                        anchorDriftGame=drift[0] if drift else None,
                        anchorDriftSeconds=round(drift[1] / 1000, 1) if drift else None,
                        backtestRetentionDays=round(((status.get("compactStorage") or {}).get("retentionMs") or 0) / 86_400_000, 1),
                        backtestStoreCapGbytes=round(((status.get("compactStorage") or {}).get("maxBytes") or 0) / 1024 ** 3, 1),
                        runId=str(status.get("runId"))[:20])
            except Exception as error:  # noqa: BLE001 - the watcher must never die
                self.consecutive_failures += 1
                # The handler itself must not escape the loop either (for
                # example a log that cannot be written).
                try:
                    line = f"{type(error).__name__}: {error}"
                    if line != self.last_error_line:
                        self.last_error_line = line
                        self.log.write("error", "watch_cycle_failed", error=line)
                    if (self.consecutive_failures >= 3 and self.auto_restart and not self.stop_requested()
                            and time.time() - self.last_restart_at > 300):
                        self.restart_collector(
                            f"status API and state file unreadable for {self.consecutive_failures} cycles")
                except Exception:  # noqa: BLE001
                    pass
            time.sleep(interval_s)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-root", default="data/collector/continuous")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--interval", type=float, default=15.0)
    parser.add_argument("--db-count-interval", type=float, default=300.0,
                        help="seconds between expensive tail/payload count refreshes")
    parser.add_argument("--heartbeat", type=float, default=300.0)
    # The collector finalizes the match row before it marks the archive
    # complete, so there is no window to wait out; kept so existing command
    # lines keep parsing.
    parser.add_argument("--empty-archive-grace", type=int, default=600,
                        help="accepted for compatibility; unused")
    parser.add_argument("--silent-match-alert", type=int, default=1800)
    parser.add_argument("--project", default="/Users/ww/Project/polyFIFA2026")
    parser.add_argument("--no-restart", action="store_true")
    parser.add_argument("--log", default=None)
    parser.add_argument("--once", action="store_true", help="print one report and exit")
    options = parser.parse_args()
    log_path = options.log or os.path.join(options.data_root, "logs", "health-watch.log")
    log = LogFile(log_path)
    watch = HealthWatch(options.data_root, options.port, log, options.heartbeat,
                        options.empty_archive_grace, options.silent_match_alert,
                        options.project, not options.no_restart,
                        count_refresh_s=options.db_count_interval)
    if options.once:
        status = watch.api_status()  # noqa: F841 - read once for a single report
        metrics, snapshot = watch.read_db_metrics()
        print(json.dumps({
            "mode": status.get("mode"), "stale": status.get("stale"),
            "desiredTokens": status.get("desiredTokens"), "runId": status.get("runId"),
            "matches": metrics["matches"], "tailRecords": metrics["tailRecords"],
            "stagingRecords": metrics["stagingRecords"], "stagingGames": metrics["stagingGames"],
            "matchKeys": sorted(metrics["matchKeys"]),
            "recordsPerMatch": watch.record_counts(sorted(metrics["matchKeys"])),
            "stagingTop": sorted(((k, v["records"]) for k, v in snapshot.items()),
                                 key=lambda item: -item[1])[:10],
        }, ensure_ascii=False, indent=2))
        return 0
    watch.run(options.interval)
    return 0


if __name__ == "__main__":
    sys.exit(main())
