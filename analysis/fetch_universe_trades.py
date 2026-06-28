"""Tier 3 step 2: fetch BUY trades for control markets (in same matches as
candidates, but not in the strategy candidate set). Filter to the last 480s
before each match's end. Output schema mirrors loss_requires2_strategy_multiwindow_trades.json
so Tier 3 analysis can re-use Tier 2 plumbing.

NOTE on proxy: macOS system proxy (127.0.0.1:7897) is auto-picked by urllib
and rate-limits us. We disable proxy autodetection here because direct
connection to data-api.polymarket.com works fine and is much more reliable.
"""
from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

import urllib.request
import urllib.parse

# Force direct connection - bypass macOS system proxy that flakes under load.
_no_proxy_handler = urllib.request.ProxyHandler({})
_opener = urllib.request.build_opener(_no_proxy_handler)
urllib.request.install_opener(_opener)

# Ensure stdout is line-buffered so progress is visible while running.
try:
    sys.stdout.reconfigure(line_buffering=True)
except Exception:
    pass

REPO = Path(__file__).resolve().parents[1]
DATA = REPO / "data"
TRADES_PATH = DATA / "loss_requires2_strategy_multiwindow_trades.json"
UNIVERSE_PATH = DATA / "event_markets_universe.json"
OUT_PATH = DATA / "universe_tail_trades.json"

WINDOWS = [60, 120, 180, 300, 480]
SLEEP_BETWEEN = 0.4
LIMIT = 1000
RETRY_BACKOFFS = [3, 10, 30, 90]


def derive_match_end_per_slug() -> dict[str, int]:
    """Per-slug match_end_timestamp inferred from existing strategy trades.

    For any trade in any candidate of slug X, timestamp + sec_to_finish gives
    the match_end_timestamp. We take the median to defend against any single
    measurement glitch.
    """
    rows = json.loads(TRADES_PATH.read_text())
    per_slug: dict[str, list[int]] = {}
    for row in rows:
        slug = row.get("slug")
        if not slug:
            continue
        for trades in (row.get("windows") or {}).values():
            for t in trades or []:
                try:
                    ts = int(t["timestamp"]) + int(t["sec_to_finish"])
                except (KeyError, TypeError, ValueError):
                    continue
                per_slug.setdefault(slug, []).append(ts)

    result: dict[str, int] = {}
    for slug, samples in per_slug.items():
        samples_sorted = sorted(samples)
        mid = samples_sorted[len(samples_sorted) // 2]
        result[slug] = int(mid)
    return result


class _PaginationEnd(Exception):
    """Raised when the API signals there are no more pages (HTTP 400 at high offset)."""


def _get_with_retry(url: str) -> list:
    last_err: Exception | None = None
    for attempt, backoff in enumerate([0] + RETRY_BACKOFFS):
        if backoff:
            print(f"     retry after {backoff}s (attempt {attempt})")
            time.sleep(backoff)
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "polyfifa-tier3/1.0"})
            with urllib.request.urlopen(req, timeout=30) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.request.HTTPError as err:
            # data-api caps pagination around offset=4000; HTTP 400 there
            # means "no more rows", not a transient failure.
            if err.code == 400:
                raise _PaginationEnd() from err
            last_err = err
        except Exception as err:
            last_err = err
    raise RuntimeError(f"exhausted retries: {last_err}")


def fetch_trades_for_market(
    condition_id: str,
    match_end: int,
    max_pages: int = 30,
    early_stop_after_secs: int = 480 + 60,  # 540s buffer past tail window
) -> list[dict]:
    """Fetch BUY trades for a conditionId via data-api paginated, newest-first.

    Early-stops as soon as we see a trade older than `match_end - early_stop_after_secs`
    because everything past that point is outside our largest window (480s).
    """
    base = "https://data-api.polymarket.com/trades"
    all_trades: list[dict] = []
    offset = 0
    for _ in range(max_pages):
        q = urllib.parse.urlencode({
            "market": condition_id,
            "limit": LIMIT,
            "offset": offset,
            "takerOnly": "false",
            "side": "BUY",
        })
        url = f"{base}?{q}"
        try:
            page = _get_with_retry(url)
        except _PaginationEnd:
            break
        if not isinstance(page, list) or not page:
            break
        all_trades.extend(page)

        oldest_ts = min((int(t["timestamp"]) for t in page if "timestamp" in t), default=0)
        if oldest_ts and (match_end - oldest_ts) > early_stop_after_secs:
            break

        if len(page) < LIMIT:
            break
        offset += LIMIT
        time.sleep(SLEEP_BETWEEN)
    return all_trades


def windowed(trades: list[dict], match_end: int) -> dict[str, list[dict]]:
    """Group a market's BUY trades into our standard window buckets."""
    out: dict[str, list[dict]] = {str(w): [] for w in WINDOWS}
    for raw in trades:
        try:
            ts = int(raw["timestamp"])
            price = float(raw["price"])
            size = float(raw["size"])
        except (KeyError, TypeError, ValueError):
            continue
        if not (0.0 < price < 1.0):
            continue
        sec_to_finish = match_end - ts
        if sec_to_finish < 0:
            continue
        record = {
            "timestamp": ts,
            "sec_to_finish": sec_to_finish,
            "price": price,
            "size": size,
            "tx": raw.get("transactionHash") or raw.get("tx") or "",
            "asset": raw.get("asset", ""),
        }
        for w in WINDOWS:
            if sec_to_finish <= w:
                out[str(w)].append(record)
    return out


def main() -> None:
    match_end_by_slug = derive_match_end_per_slug()
    print(f"[step 1] derived match_end for {len(match_end_by_slug)} slugs")

    universe = json.loads(UNIVERSE_PATH.read_text())
    controls = [r for r in universe if not r.get("in_candidates")]
    print(f"[step 2] {len(controls)} control markets to fetch")

    existing: dict[str, dict] = {}
    if OUT_PATH.exists():
        for row in json.loads(OUT_PATH.read_text()):
            existing[row["conditionId"]] = row
        print(f"  resuming with {len(existing)} already-fetched markets in cache")

    out: list[dict] = list(existing.values())
    fetched = 0
    skipped = 0
    failed = 0

    for i, market in enumerate(controls):
        cid = market["conditionId"]
        if cid in existing:
            skipped += 1
            continue
        slug = market["slug"]
        match_end = match_end_by_slug.get(slug)
        if match_end is None:
            print(f"  [{i+1}/{len(controls)}] {slug}: no match_end anchor, skipping")
            failed += 1
            continue

        try:
            trades = fetch_trades_for_market(cid, match_end)
            windows = windowed(trades, match_end)
        except Exception as err:
            print(f"  [{i+1}/{len(controls)}] {cid[:14]} {slug}: FAIL {err}")
            failed += 1
            time.sleep(1.0)
            continue

        n_in_window = sum(len(v) for v in windows.values())
        row = {
            "slug": slug,
            "conditionId": cid,
            "question": market.get("question", ""),
            "marketType": market.get("marketType"),
            "outcomes": market.get("outcomes", []),
            "line": market.get("line"),
            "team": market.get("team"),
            "match_end_timestamp": match_end,
            "fetched_trades": len(trades),
            "windows": windows,
        }
        out.append(row)
        fetched += 1
        if (i + 1) % 25 == 0 or n_in_window > 0:
            print(f"  [{i+1}/{len(controls)}] {slug[:30]} cid {cid[:10]} -> {len(trades)} trades, {n_in_window} in 480s")
        if fetched % 50 == 0:
            OUT_PATH.write_text(json.dumps(out, indent=2) + "\n")
            print(f"  -- intermediate save: {len(out)} rows")
        time.sleep(SLEEP_BETWEEN)

    OUT_PATH.write_text(json.dumps(out, indent=2) + "\n")
    print(f"\nwrote {OUT_PATH}")
    print(f"  total control markets cached: {len(out)}")
    print(f"  fetched this run: {fetched}, skipped (cached): {skipped}, failed: {failed}")


if __name__ == "__main__":
    main()
