#!/usr/bin/env python3
"""Validate the published artifact against its manifest and every source series."""
import json
import math
import pathlib
import datetime as dt
from collections import Counter

root = pathlib.Path(__file__).resolve().parents[1] / 'site/data'
manifest = json.loads((root / 'manifest.json').read_text())
markets = json.loads((root / 'markets.json').read_text())
start = int(dt.datetime.fromisoformat(manifest['from'].replace('Z', '+00:00')).timestamp())
end = int(dt.datetime.fromisoformat(manifest['to'].replace('Z', '+00:00')).timestamp())
assert len(markets) == manifest['matchCount']
assert len({m['id'] for m in markets}) == len(markets)
counts = Counter()
for m in markets:
    assert m['volume'] > 5000, m['id']
    assert start <= m['matchTime'] <= end, m['id']
    h = json.loads((root / 'history' / (m['id'] + '.json')).read_text())
    assert h['window'] == [start, end] and h['marketId'] == m['id']
    assert len(h['outcomes']) == len(m['players']) == 2
    size = 0
    for i, o in enumerate(h['outcomes']):
        assert o['player'] == m['players'][i]
        times = [p[0] for p in o['points']]
        assert times == sorted(set(times)), m['id']
        for t, p, r in o['points']:
            assert start <= t and t + r <= end and math.isfinite(p) and 0 <= p <= 1 and r > 0, m['id']
        pre = [p for p in o['points'] if p[0] + p[2] <= m['matchTime']]
        assert m['preMatch'][i] == dict(count=len(pre), last=pre[-1] if pre else None), m['id']
        size += len(times)
        counts['errors'] += bool(o.get('error'))
    assert size == m['historyPoints'], m['id']
    counts['points'] += size
    counts['withHistory'] += bool(size)
    counts['withPreMatch'] += any(p['count'] for p in m['preMatch'])
assert counts['points'] == manifest['pricePointCount']
assert counts['withHistory'] == manifest['withHistory']
assert counts['withPreMatch'] == manifest['withPreMatch']
assert counts['errors'] == manifest['failedOutcomes']
assert sum(x['matches'] for x in manifest['months'].values()) == len(markets)
assert (root / 'tennis-archive.sqlite.zip').stat().st_size > 0
print(f"Validated {len(markets):,} markets and {counts['points']:,} observations; {counts['errors']} failed outcomes.")
