"""Tier 3 step 3: enrich event_markets_universe.json with resolved outcomePrices.

For a closed/resolved market, outcomePrices is ["1","0"] or ["0","1"] telling
us which outcome WON. We need this so the universe-null comparison only counts
BUY trades on the eventual winning side (otherwise control's cheap fills are
all losing bets and we get nonsensical infinite-ROI numbers).
"""
from __future__ import annotations

import json
import time
import urllib.parse
import urllib.request
from pathlib import Path

# Bypass macOS system proxy.
_no_proxy_handler = urllib.request.ProxyHandler({})
_opener = urllib.request.build_opener(_no_proxy_handler)
urllib.request.install_opener(_opener)

REPO = Path(__file__).resolve().parents[1]
UNIVERSE_PATH = REPO / "data" / "event_markets_universe.json"
OUT_PATH = REPO / "data" / "market_resolutions.json"

BATCH_SIZE = 100  # repeated condition_ids params; conservative URL length


def fetch_batch(condition_ids: list[str]) -> list[dict]:
    params = [("condition_ids", cid) for cid in condition_ids]
    params.append(("closed", "true"))
    params.append(("limit", str(len(condition_ids) + 10)))
    url = "https://gamma-api.polymarket.com/markets?" + urllib.parse.urlencode(params, doseq=True)
    req = urllib.request.Request(url, headers={"User-Agent": "polyfifa-tier3/1.0"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def main() -> None:
    universe = json.loads(UNIVERSE_PATH.read_text())
    cids = [m["conditionId"] for m in universe]
    print(f"resolving {len(cids)} markets")

    resolutions: dict[str, dict] = {}
    if OUT_PATH.exists():
        resolutions = {r["conditionId"]: r for r in json.loads(OUT_PATH.read_text())}
        print(f"  resuming with {len(resolutions)} already-resolved")

    todo = [c for c in cids if c not in resolutions]
    print(f"  fetching {len(todo)} new resolutions")

    for i in range(0, len(todo), BATCH_SIZE):
        batch = todo[i:i + BATCH_SIZE]
        data = None
        for attempt, backoff in enumerate([0, 5, 20, 60]):
            if backoff:
                time.sleep(backoff)
            try:
                data = fetch_batch(batch)
                break
            except Exception as err:
                print(f"  batch {i//BATCH_SIZE + 1} attempt {attempt}: {err}")
        if data is None:
            print(f"  batch {i//BATCH_SIZE + 1}: GIVE UP")
            continue
        for m in data:
            cid = m.get("conditionId")
            if not cid:
                continue
            outcome_prices_raw = m.get("outcomePrices")
            outcome_prices = json.loads(outcome_prices_raw) if isinstance(outcome_prices_raw, str) else outcome_prices_raw
            outcomes_raw = m.get("outcomes")
            outcomes = json.loads(outcomes_raw) if isinstance(outcomes_raw, str) else outcomes_raw
            winner_idx = None
            if outcome_prices:
                try:
                    nums = [float(x) for x in outcome_prices]
                    winner_idx = nums.index(max(nums)) if max(nums) > 0.5 else None
                except (TypeError, ValueError):
                    pass
            resolutions[cid] = {
                "conditionId": cid,
                "outcomes": outcomes,
                "outcomePrices": outcome_prices,
                "winnerIndex": winner_idx,
                "lastTradePrice": m.get("lastTradePrice"),
                "umaResolutionStatus": m.get("umaResolutionStatus"),
            }
        print(f"  batch {i//BATCH_SIZE + 1}/{(len(todo) + BATCH_SIZE - 1) // BATCH_SIZE}: cumulative {len(resolutions)}")
        time.sleep(2.0)

    out_list = list(resolutions.values())
    OUT_PATH.write_text(json.dumps(out_list, indent=2) + "\n")
    resolved_count = sum(1 for r in out_list if r.get("winnerIndex") is not None)
    print(f"\nwrote {OUT_PATH}")
    print(f"  total: {len(out_list)}, with resolved winner: {resolved_count}")


if __name__ == "__main__":
    main()
