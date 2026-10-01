"""Fetch ESPN play states + win probability for matched Polymarket games.

Caches raw API replies under /tmp/poly_espn_cache and writes a compact gzip
timeline for the requested league. Research only; does not touch repo data.
"""
import datetime, gzip, hashlib, json, os, re, sys, time, urllib.request
from concurrent.futures import ThreadPoolExecutor

PROXY = os.environ.get("POLY_RESEARCH_PROXY", "http://127.0.0.1:10808")
CACHE = "/tmp/poly_espn_cache"
os.makedirs(CACHE, exist_ok=True)
LEAGUES = {
    "nba": ("basketball/nba", [""]),
    "nfl": ("football/nfl", [""]),
    "cfb": ("football/college-football", ["&groups=80", "&groups=81"]),
    "nhl": ("hockey/nhl", [""]),
}
opener = urllib.request.build_opener(urllib.request.ProxyHandler({"http": PROXY, "https": PROXY}))

def get(url):
    key = hashlib.sha1(url.encode()).hexdigest()
    path = os.path.join(CACHE, key + ".json")
    if os.path.exists(path):
        return json.load(open(path))
    last = None
    for attempt in range(8):
        try:
            with opener.open(url, timeout=45) as r:
                raw = r.read()
            data = json.loads(raw)
            tmp = path + ".tmp"
            with open(tmp, "wb") as f:
                f.write(raw)
            os.replace(tmp, path)
            return data
        except Exception as e:
            last = e
            time.sleep(min(20, 1.2 * (attempt + 1) ** 2))
    raise RuntimeError(f"{url}: {last}")

def ms(iso):
    return int(datetime.datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp() * 1000)

def norm(s):
    return re.sub(r"[^a-z0-9]", "", (s or "").lower())

def team_keys(team):
    return {norm(team.get(k)) for k in ("shortDisplayName", "displayName", "name", "location", "abbreviation", "nickname")} - {""}

def plays_of(summary):
    if summary.get("plays"):
        return summary["plays"]
    return [p for d in summary.get("drives", {}).get("previous", []) for p in d.get("plays", [])]

def state_timeline(summary):
    wp = {x.get("playId"): x for x in summary.get("winprobability", []) if isinstance(x, dict)}
    out = []
    for p in plays_of(summary):
        w = wp.get(p.get("id"))
        if not p.get("wallclock") or not w:
            continue
        hp = w.get("homeWinPercentage")
        if not isinstance(hp, (int, float)):
            continue
        out.append({
            "t": ms(p["wallclock"]),
            "period": (p.get("period") or {}).get("number"),
            "clock": (p.get("clock") or {}).get("displayValue"),
            "awayScore": p.get("awayScore"),
            "homeScore": p.get("homeScore"),
            "pHome": float(hp),
            "possession": p.get("possession"),
            "downDistanceText": p.get("downDistanceText"),
        })
    out.sort(key=lambda x: (x["t"], x["period"] or 0))
    # Duplicate play ids/timestamps occasionally appear after corrections. Keep
    # the last API state at each exact wallclock, which is the live-visible one.
    dedup = []
    for x in out:
        if dedup and dedup[-1]["t"] == x["t"]:
            dedup[-1] = x
        else:
            dedup.append(x)
    return dedup

def main(league, dataset_paths):
    sport_path, groups = LEAGUES[league]
    games = []
    seen = set()
    for path in dataset_paths.split(","):
        data = json.load(open(path))
        for e in data["events"]:
            if e["eventSlug"] in seen or not e.get("startMs"):
                continue
            ml = [m for m in e["markets"] if m["marketType"] == "moneyline" and len(m.get("outcomes", [])) == 2]
            if not ml:
                continue
            names = [norm(o.get("name")) for o in ml[0]["outcomes"]]
            if all(names):
                games.append((e, names)); seen.add(e["eventSlug"])
    dates = set()
    for e, _ in games:
        d0 = datetime.datetime.fromtimestamp(e["startMs"] / 1000, datetime.timezone.utc).date()
        for delta in (-1, 0):
            dates.add((d0 + datetime.timedelta(days=delta)).strftime("%Y%m%d"))
    urls = [f"https://site.api.espn.com/apis/site/v2/sports/{sport_path}/scoreboard?dates={d}&limit=500{g}" for d in sorted(dates) for g in groups]
    print(f"{league}: loading {len(urls)} scoreboards for {len(games)} games", file=sys.stderr, flush=True)
    with ThreadPoolExecutor(8) as pool:
        boards = list(pool.map(lambda u: (u, get(u)), urls))
    espn = []
    for _, board in boards:
        for ev in board.get("events", []):
            comps = ev.get("competitions", [{}])[0].get("competitors", [])
            if len(comps) != 2:
                continue
            espn.append((ev["id"], ms(ev["date"]), [team_keys(c.get("team") or {}) for c in comps]))
    matched = {}
    for e, names in games:
        cands = [x for x in espn if abs(x[1] - e["startMs"]) <= 12 * 3600_000
                 and all(any(n in keys for keys in x[2]) for n in names)]
        if cands:
            matched[e["eventSlug"]] = min(cands, key=lambda x: abs(x[1] - e["startMs"]))[0]
    print(f"{league}: matched {len(matched)}/{len(games)} games", file=sys.stderr, flush=True)

    def work(item):
        slug, espn_id = item
        try:
            summary = get(f"https://site.api.espn.com/apis/site/v2/sports/{sport_path}/summary?event={espn_id}")
            states = state_timeline(summary)
            header = (summary.get("header") or {}).get("competitions", [{}])[0]
            teams = {}
            for c in header.get("competitors", []):
                if c.get("homeAway") in ("home", "away"):
                    teams[c["homeAway"]] = {
                        "name": (c.get("team") or {}).get("displayName"),
                        "score": c.get("score"), "winner": c.get("winner")}
            return slug, {"espnId": espn_id, "teams": teams, "states": states}
        except Exception as ex:
            return slug, {"espnId": espn_id, "error": str(ex)[:300]}
    with ThreadPoolExecutor(8) as pool:
        result = dict(pool.map(work, matched.items()))
    out = f"/tmp/espn_states_{league}.json.gz"
    with gzip.open(out, "wt") as f:
        json.dump(result, f, separators=(",", ":"))
    ok = sum(len(v.get("states", [])) >= 10 for v in result.values())
    print(f"{league}: states for {ok}/{len(result)} games -> {out}", file=sys.stderr, flush=True)

if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
