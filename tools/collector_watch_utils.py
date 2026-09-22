"""Shared executable resolution for the collector watchdogs.

The LaunchAgent environment is intentionally minimal on macOS and commonly
does not include Homebrew's ``/opt/homebrew/bin`` directory.  The watchdogs
must not assume that ``npm`` is available through ``PATH`` when they need to
restart the collector.
"""

from __future__ import annotations

import os
import shutil
from collections.abc import Iterable

DEFAULT_NPM_PATHS = (
    "/opt/homebrew/bin/npm",
    "/usr/local/bin/npm",
    "/usr/bin/npm",
)


def _existing_executable(candidate: str | None) -> str | None:
    if not candidate:
        return None
    expanded = os.path.expanduser(candidate)
    if os.path.sep in expanded or (os.path.altsep and os.path.altsep in expanded):
        if os.path.isfile(expanded) and os.access(expanded, os.X_OK):
            return expanded
        return None
    return shutil.which(expanded)


def choose_npm(
    explicit: str | None = None,
    candidates: Iterable[str] | None = None,
) -> str | None:
    """Return the first usable npm executable, or ``None``.

    Resolution order is deliberate: an explicit argument (useful for tests or
    operators), ``POLY_NPM``, the normal ``PATH`` lookup, then known macOS
    installation locations.  Empty values are treated as unset.
    """

    for candidate in (explicit, os.environ.get("POLY_NPM")):
        resolved = _existing_executable(candidate)
        if resolved:
            return resolved

    path_npm = shutil.which("npm")
    if path_npm:
        return path_npm

    fallback_candidates = DEFAULT_NPM_PATHS if candidates is None else candidates
    for candidate in fallback_candidates:
        resolved = _existing_executable(candidate)
        if resolved:
            return resolved
    return None


def resolve_npm(
    explicit: str | None = None,
    candidates: Iterable[str] | None = None,
) -> str:
    """Resolve npm or raise a useful error for the watchdog log."""

    resolved = choose_npm(explicit, candidates)
    if resolved:
        return resolved
    raise FileNotFoundError(
        "npm executable not found; set POLY_NPM or add npm to PATH"
    )
