#!/usr/bin/env python3
"""Le tableau du banc face à Jellyfin, à partir de sa sortie : la médiane des passages de chaque titre.

    python3 lumen-core/benches/jellyfin/resume.py lumen-core/benches/out/face-a-jellyfin.jsonl

La médiane, pas la moyenne : sur une machine qui fait autre chose, un passage ralenti ne doit pas
déplacer le chiffre. Le nombre de passages réussis est donné — une médiane sur un seul n'en est pas une.
"""
import json
import statistics
import sys
from collections import defaultdict

rows = [json.loads(line) for line in open(sys.argv[1], encoding="utf8") if line.strip()]
idle = [r for r in rows if r["player"] == "repos"]
by = defaultdict(list)
for r in rows:
    if r["player"] != "repos":
        by[(r["title"], r["player"])].append(r)


def med(values):
    values = [v for v in values if v is not None]
    return round(statistics.median(values)) if values else None


def cell(value, unit=""):
    return "—" if value is None else f"{value:,}".replace(",", " ") + unit


def what(r):
    """Ce que le serveur a fait (jellyfin-web) ou ce que le navigateur a fait du son (Lumen)."""
    if r["player"] == "lumen":
        return (r.get("audio") or "") if r.get("phase") == "playing" else "refus : " + str(r.get("why") or "")[-70:]
    t = (r.get("server") or {}).get("transcoding")
    if not t:
        return (r.get("server") or {}).get("method") or "?"
    return f"vidéo {t['video']}, son {t['audio']}"


if idle:
    i = idle[0]
    print(f"Serveur au repos : {i['serverCpuSeconds']} s de processeur en {i['passSeconds']} s.\n")
print("| Titre | Lecteur | Passages | 1re image | Saut 40 % | Saut 75 % | CPU serveur | Durée du passage | Ce qui s'est passé |")
print("|---|---|---|---|---|---|---|---|---|")
for title in sorted({t for t, _ in by}):
    for player in ("jellyfin", "lumen"):
        runs = by.get((title, player), [])
        ok = [r for r in runs if r.get("phase") == "playing"]
        seeks = lambda k: med([(r.get("seeks") or [{}, {}])[k].get("ms") for r in ok])
        print(
            f"| {title} | {'jellyfin-web' if player == 'jellyfin' else 'Lumen'} | {len(ok)}/{len(runs)} | {cell(med([r.get('firstFrameMs') for r in ok]), ' ms')} | "
            f"{cell(seeks(0), ' ms')} | {cell(seeks(1), ' ms')} | {cell(med([r['serverCpuSeconds'] for r in runs]), ' s')} | {cell(med([r['passSeconds'] for r in runs]), ' s')} | {what((ok or runs)[0]) if runs else ''} |"
        )
