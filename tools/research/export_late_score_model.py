"""Fit the late-game score model on all available games and export JSON.

The monitor must not retrain or invent model parameters at run time, so this
script freezes the same regularized logistic regression used by
late_score_walk_forward.py into a small JSON artifact. It also embeds
self-test predictions computed by the Python implementation; the TypeScript
monitor recomputes them at load time and refuses to run on any mismatch.

Research only. Reads public data, writes one JSON file, touches nothing else.
"""
import argparse
import datetime
import gzip
import hashlib
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from late_score_walk_forward import fit, fit_row, load_games  # noqa: E402

FEATURE_SPEC = ["margin/10", "margin*root/10", "margin/minutes/10", "root", "ot"]
SELF_TEST_STATES = [
    {"period": 4, "clock": "15:00", "homeScore": 24, "awayScore": 20},
    {"period": 4, "clock": "12:00", "homeScore": 24, "awayScore": 20},
    {"period": 4, "clock": "3:00", "homeScore": 24, "awayScore": 20},
    {"period": 4, "clock": "0:45", "homeScore": 27, "awayScore": 24},
    {"period": 4, "clock": "0:05", "homeScore": 17, "awayScore": 20},
    {"period": 5, "clock": "4:00", "homeScore": 20, "awayScore": 20},
]


def feature(state, final_period, period_seconds):
    """Same feature transform as late_score_walk_forward.feature."""
    period = int(state.get("period") or 0)
    clock = state.get("clock")
    if not isinstance(clock, str) or ":" not in clock:
        return None
    minutes_text, seconds_text = clock.split(":", 1)
    seconds = int(minutes_text) * 60 + float(seconds_text)
    margin = float(state["homeScore"]) - float(state["awayScore"])
    if not period:
        return None
    if period <= final_period:
        remaining = max(0, (final_period - period) * period_seconds + seconds)
        overtime = 0
    else:
        remaining = max(0, seconds)
        overtime = period - final_period
    if remaining > 900:
        return None
    minutes = (remaining + 1) / 60
    root = 1 / (minutes ** 0.5)
    return [margin / 10, margin * root / 10, margin / minutes / 10, root, float(overtime)]


def predict(model, row):
    coefficients, mean, scale = model
    z = (np.asarray(row, float) - mean) / scale
    eta = float(np.clip(coefficients[0] + z @ coefficients[1:], -35, 35))
    return 1 / (1 + np.exp(-eta))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("league", choices=["nfl", "nba", "cfb", "nhl"])
    parser.add_argument("states", help="ESPN states .json.gz produced by fetch_espn_states.py")
    parser.add_argument("final_period", type=int)
    parser.add_argument("period_seconds", type=int)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    games = load_games(args.states)
    rows, labels, weights = [], [], []
    for game in games:
        data = fit_row(game, args.final_period, args.period_seconds)
        if data is None:
            continue
        rows.extend(data[0])
        labels.extend(data[1])
        weights.extend(data[2])
    if len(rows) < 100:
        raise SystemExit(f"REFUSING: only {len(rows)} usable states for {args.league}")
    model = fit(np.asarray(rows), np.asarray(labels), np.asarray(weights), 1.0)
    coefficients, mean, scale = model

    self_test = []
    for state in SELF_TEST_STATES:
        row = feature(state, args.final_period, args.period_seconds)
        if row is None:
            continue
        self_test.append({**state, "features": [round(float(x), 12) for x in row],
                          "probability": round(predict(model, row), 10)})

    digest = hashlib.sha256(open(args.states, "rb").read()).hexdigest()
    artifact = {
        "schemaVersion": 1,
        "league": args.league,
        "featureSpec": FEATURE_SPEC,
        "finalPeriod": args.final_period,
        "periodSeconds": args.period_seconds,
        "feeRate": 0.05,
        "l2": 1.0,
        "coefficients": [float(x) for x in coefficients],
        "mean": [float(x) for x in mean],
        "scale": [float(x) for x in scale],
        "trainedGames": len(games),
        "trainedStates": len(rows),
        "firstGameStart": datetime.datetime.fromtimestamp(games[0]["start"] / 1000, datetime.timezone.utc).isoformat(),
        "lastGameStart": datetime.datetime.fromtimestamp(games[-1]["start"] / 1000, datetime.timezone.utc).isoformat(),
        "datasetSha256": digest,
        "datasetPath": os.path.abspath(args.states),
        "createdAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "selfTest": self_test,
    }
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w") as handle:
        json.dump(artifact, handle, indent=2)
        handle.write("\n")
    print(f"{args.league}: games={len(games)} states={len(rows)} -> {args.out}", file=sys.stderr)
    for check in self_test:
        print(f"  Q{check['period']} {check['clock']} {check['homeScore']}-{check['awayScore']} p={check['probability']:.6f}")


if __name__ == "__main__":
    main()
