"""Loaders for the random-control study.

The repo ships strategy-filtered artefacts only, so every loader documents
the *universe-scope* it operates on. We never silently widen this.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Iterator

import pandas as pd

DATA_DIR = Path(__file__).resolve().parents[2] / "data"


def load_candidates() -> pd.DataFrame:
    """275 (strategy, market) candidates that pass lossRequiresGoals >= 2."""
    path = DATA_DIR / "loss_requires2_strategy_candidates.json"
    rows = json.loads(path.read_text())
    df = pd.DataFrame(rows)
    return df


def load_summary() -> pd.DataFrame:
    """One row per (candidate, window). Source of headline backtest stats."""
    path = DATA_DIR / "loss_requires2_strategy_multiwindow_summary.csv"
    df = pd.read_csv(path)
    df["window_sec"] = df["window_sec"].astype(int)
    return df


def load_aggregate() -> pd.DataFrame:
    """Per-(strategy, window) aggregates — the headline numbers in the doc."""
    path = DATA_DIR / "loss_requires2_strategy_multiwindow_aggregate.csv"
    return pd.read_csv(path)


def iter_window_trades() -> Iterator[dict]:
    """Yield each (candidate, window) cell with its trade list.

    Schema:
        {
          "strategy": str,
          "slug": str,            # match-date identifier, e.g. fifwc-esp-ksa-2026-06-21
          "date": str,
          "title": str,
          "token": str,
          "loss_requires_goals": int,
          "window_sec": int,
          "trades": list[{timestamp:int, sec_to_finish:int, price:float, size:float, tx:str}]
        }
    """
    path = DATA_DIR / "loss_requires2_strategy_multiwindow_trades.json"
    rows = json.loads(path.read_text())
    for row in rows:
        windows = row.get("windows", {})
        for window_sec_str, trades in windows.items():
            yield {
                "strategy": row.get("strategy"),
                "slug": row.get("slug"),
                "date": row.get("date"),
                "title": row.get("title"),
                "token": row.get("token"),
                "loss_requires_goals": row.get("loss_requires_goals"),
                "window_sec": int(window_sec_str),
                "trades": list(trades or []),
            }


def trades_dataframe() -> pd.DataFrame:
    """Flatten iter_window_trades into a DataFrame for groupby/joins."""
    return pd.DataFrame(list(iter_window_trades()))
