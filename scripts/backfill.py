#!/usr/bin/env python3
"""One-off, resumable public-data import. Python stdlib + curl; no credentials."""
import argparse
import concurrent.futures
import datetime as dt
import hashlib
import json
import math
import pathlib
import re
import sqlite3
import subprocess
import threading
import time
import zipfile
from collections import Counter
from urllib.parse import urlencode

ROOT = pathlib.Path(__file__).resolve().parents[1]
CACHE = ROOT / '.cache'
DATA = ROOT / 'site/data'
UTC = dt.timezone.utc
LOCK = threading.Lock()
NEXT_REQUEST = 0.0


def stamp(value):
    if not value:
        return None
    try:
        parsed = dt.datetime.fromisoformat(value.replace('Z', '+00:00'))
        return int((parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)).timestamp())
    except (ValueError, TypeError):
        return None


def iso(timestamp):
    return dt.datetime.fromtimestamp(timestamp, UTC).isoformat().replace('+00:00', 'Z')


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix('.tmp')
    temp.write_text(json.dumps(value, ensure_ascii=False, separators=(',', ':')))
    temp.replace(path)


def request(url, params):
    global NEXT_REQUEST
    full = url + '?' + urlencode(params)
    path = CACHE / 'http' / (hashlib.sha256(full.encode()).hexdigest() + '.json')
    if path.exists():
        return json.loads(path.read_text())
    for attempt in range(5):
        with LOCK:
            delay = max(0, NEXT_REQUEST - time.monotonic())
            NEXT_REQUEST = max(time.monotonic(), NEXT_REQUEST) + 0.056
        time.sleep(delay)
        result = subprocess.run(['curl', '-fsS', '--max-time', '40', '--connect-timeout', '10',
                                 '-H', 'User-Agent: Mozilla/5.0', full], capture_output=True, text=True)
        if result.returncode == 0:
            try:
                value = json.loads(result.stdout)
                write_json(path, value)
                return value
            except json.JSONDecodeError:
                pass
        if attempt < 4:
            time.sleep(2 ** attempt)
    raise RuntimeError(f'Request failed: {full}: {result.stderr[:200]}')


def array(value):
    if isinstance(value, list):
        return value
    try:
        parsed = json.loads(value or '[]')
        return parsed if isinstance(parsed, list) else []
    except (ValueError, TypeError):
        return []


def pre_match(point, match_time):
    return point[2] > 0 and point[0] + point[2] <= match_time


def normalize(m, start, end):
    if m.get('sportsMarketType') != 'moneyline':
        return None, 'not_match_winner'
    outcomes, tokens = array(m.get('outcomes')), array(m.get('clobTokenIds'))
    title = m.get('question', '')
    if len(outcomes) != 2 or len(tokens) != 2 or not re.search(r'\bvs\.?\s', title, re.I):
        return None, 'not_two_players'
    if any(x.lower() in ('yes', 'no', 'draw') for x in outcomes):
        return None, 'not_two_players'
    if re.search(r'doubles|double[s]?\b|\bmixed\b', title + ' ' + m.get('slug', ''), re.I) or any(re.search(r'[/&+]', x) for x in outcomes):
        return None, 'doubles'
    event = (m.get('events') or [{}])[0]
    tour = event.get('seriesSlug') or (event.get('series') or [{}])[0].get('slug', '')
    if tour not in ('atp', 'wta', 'itf'):
        prefix = m.get('slug', '').split('-')[0]
        tour = prefix if prefix in ('atp', 'wta', 'itf') else 'other'
    match_time = stamp(m.get('gameStartTime')) or stamp(event.get('startTime'))
    if match_time is None:
        return None, 'missing_match_time'
    if not start <= match_time <= end:
        return None, 'outside_match_dates'
    try:
        volume = float(m.get('volumeNum') or m.get('volume') or 0)
    except (ValueError, TypeError):
        return None, 'invalid_volume'
    if not math.isfinite(volume) or volume <= 5000:
        return None, 'volume_at_or_below_5000'
    prices = array(m.get('outcomePrices'))
    return dict(id=str(m['id']), eventId=str(event.get('id', '')), title=title,
                slug=event.get('slug') or m.get('slug'), tour=tour.upper(),
                tournament=title.split(':')[0] if ':' in title else 'Tennis',
                matchTime=match_time, listedAt=stamp(m.get('startDate')) or stamp(m.get('createdAt')),
                endTime=stamp(m.get('endDate')), closedTime=stamp(m.get('closedTime')), closed=bool(m.get('closed')),
                volume=volume, players=outcomes, tokenIds=tokens,
                snapshotPrices=[float(x) for x in prices] if len(prices) == 2 else [None, None],
                conditionId=m.get('conditionId'), sourceUpdatedAt=m.get('updatedAt')), None


def discover(start, end):
    snapshot = CACHE / 'discovered.json'
    if snapshot.exists():
        saved = json.loads(snapshot.read_text())
        if saved['start'] == start and saved['end'] == end:
            return saved
    found, reasons, seen = {}, Counter(), set()
    for closed in ('true', 'false'):
        cursor = None
        page = 0
        while True:
            params = dict(tag_id=864, sports_market_types='moneyline', volume_num_min=5000,
                          end_date_min=iso(start - 31 * 86400), closed=closed,
                          limit=100, order='id', ascending='true')
            if cursor:
                params['after_cursor'] = cursor
            data = request('https://gamma-api.polymarket.com/markets/keyset', params)
            if not isinstance(data.get('markets'), list):
                raise RuntimeError('Unexpected Gamma discovery response')
            for raw in data['markets']:
                if raw['id'] in seen:
                    continue
                seen.add(raw['id'])
                market, reason = normalize(raw, start, end)
                if market:
                    found[market['id']] = market
                else:
                    reasons[reason] += 1
            page += 1
            if page % 10 == 0:
                print(f'Discovery {closed=}: {page} pages, {len(found)} eligible matches', flush=True)
            next_cursor = data.get('next_cursor')
            if not next_cursor:
                break
            if next_cursor == cursor:
                raise RuntimeError('Discovery cursor did not advance')
            cursor = next_cursor
    saved = dict(start=start, end=end, fetchedAt=iso(int(time.time())),
                 scanned=len(seen), exclusions=dict(reasons),
                 markets=sorted(found.values(), key=lambda x: x['matchTime'], reverse=True))
    write_json(snapshot, saved)
    print(f'Discovery complete: {len(found)} matches; exclusions: {dict(reasons)}', flush=True)
    return saved


def token_history(token, market, start, end, bucket):
    rows = {}
    if bucket >= 10800:
        windows = [dict(interval='max')]
    else:
        lo = max(start, (market['listedAt'] or market['matchTime'] - 7 * 86400) - 86400)
        hi = min(end + 1, market['closedTime'] + 86400 if market.get('closedTime') else (market['endTime'] or market['matchTime']) + 15 * 86400)
        windows = [dict(start=a, end=min(a + 14 * 86400, hi)) for a in range(lo, hi, 14 * 86400)]
    for window in windows:
        params = dict(token_id=token, bucket_seconds=bucket, **window)
        visited = set()
        while True:
            response = request('https://data-api.polymarket.com/v2/prices-history', params)
            if not isinstance(response.get('data'), list) or 'pagination' not in response:
                raise RuntimeError('Unexpected price-history response')
            for row in response['data']:
                t, p, r = row['timestamp'], row['price'], row['resolution_seconds']
                # Zero-resolution terminal points can be synthetic settlement payouts.
                # Conservatively retain aggregate buckets only, wholly before the cutoff.
                if r > 0 and start <= t and t + r <= end and isinstance(p, (int, float)) and math.isfinite(p) and 0 <= p <= 1:
                    rows[t] = [t, p, r]
            cursor = response['pagination'].get('next_cursor')
            if not cursor:
                if response['pagination'].get('has_more'):
                    raise RuntimeError('Price pagination claims more data without a cursor')
                break
            if cursor in visited:
                raise RuntimeError('Price cursor repeated')
            visited.add(cursor)
            params['cursor'] = cursor
    return sorted(rows.values())


def collect(market, start, end):
    path = DATA / 'history' / f"{market['id']}.json"
    if path.exists():
        saved = json.loads(path.read_text())
        if saved.get('window') == [start, end] and not any(x.get('error') for x in saved['outcomes']):
            for outcome in saved['outcomes']:
                outcome['points'] = [p for p in outcome['points'] if start <= p[0] and p[2] > 0 and p[0] + p[2] <= end]
            write_json(path, saved)
            return market, saved
    age = end - (market['listedAt'] or market['matchTime'] - 7 * 86400)
    bucket = 900 if age < 55 * 86400 else 1800 if age < 85 * 86400 else 10800
    outcomes = []
    for player, token in zip(market['players'], market['tokenIds']):
        try:
            points = token_history(token, market, start, end, bucket)
            if not points and bucket < 10800:
                points = token_history(token, market, start, end, 10800)
            if not points:
                points = token_history(token, market, start, end, 43200)
            outcomes.append(dict(player=player, tokenId=token, points=points))
        except Exception as error:
            outcomes.append(dict(player=player, tokenId=token, points=[], error=str(error)))
    saved = dict(marketId=market['id'], window=[start, end], fetchedAt=iso(int(time.time())),
                 columns=['timestamp', 'price', 'resolution_seconds'], outcomes=outcomes)
    write_json(path, saved)
    return market, saved


def export(discovery, collected):
    db = sqlite3.connect(CACHE / 'archive.sqlite')
    db.executescript('DROP TABLE IF EXISTS markets; DROP TABLE IF EXISTS prices; DROP TABLE IF EXISTS metadata;'
                    'CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);'
                    'CREATE TABLE markets(id TEXT PRIMARY KEY, match_time INTEGER, volume_usd REAL, data_json TEXT NOT NULL);'
                    'CREATE TABLE prices(market_id TEXT REFERENCES markets(id), token_id TEXT, timestamp INTEGER, price REAL, resolution_seconds INTEGER, PRIMARY KEY(token_id,timestamp));')
    summaries, count, errors, available, pre_available = [], 0, 0, 0, 0
    resolutions, months = Counter(), {}
    for market, history in sorted(collected, key=lambda x: x[0]['matchTime'], reverse=True):
        summary = {k: v for k, v in market.items() if k not in ('conditionId', 'sourceUpdatedAt', 'endTime', 'closedTime', 'eventId', 'listedAt', 'tokenIds', 'snapshotPrices')}
        summary['historyPoints'] = sum(len(o['points']) for o in history['outcomes'])
        summary['historyErrors'] = sum(bool(o.get('error')) for o in history['outcomes'])
        summary['preMatch'] = []
        summary['resolutionSeconds'] = sorted({p[2] for o in history['outcomes'] for p in o['points']})
        for o in history['outcomes']:
            pre = [p for p in o['points'] if pre_match(p, market['matchTime'])]
            summary['preMatch'].append(dict(count=len(pre), last=pre[-1] if pre else None))
        summaries.append(summary)
        db.execute('INSERT INTO markets VALUES (?,?,?,?)', (market['id'], market['matchTime'], market['volume'], json.dumps(market, ensure_ascii=False)))
        for o in history['outcomes']:
            db.executemany('INSERT INTO prices VALUES (?,?,?,?,?)', [(market['id'], o['tokenId'], *p) for p in o['points']])
            for p in o['points']:
                resolutions[str(p[2])] += 1
        count += summary['historyPoints']
        errors += summary['historyErrors']
        available += bool(summary['historyPoints'])
        pre_available += any(o['count'] for o in summary['preMatch'])
        month = iso(market['matchTime'])[:7]
        month_data = months.setdefault(month, dict(matches=0, withHistory=0, withPreMatch=0, volume=0))
        month_data['matches'] += 1
        month_data['withHistory'] += bool(summary['historyPoints'])
        month_data['withPreMatch'] += any(o['count'] for o in summary['preMatch'])
        month_data['volume'] += market['volume']
    meta = dict(schemaVersion=1, title='Polymarket Tennis Archive', generatedAt=iso(int(time.time())),
                snapshotAt=iso(discovery['end']), **{'from': iso(discovery['start']), 'to': iso(discovery['end'])},
                volumeThreshold=5000, volumeBasis='Recorded total match-winner market volume at collection; not historical pre-match volume.',
                discovery=dict(scanned=discovery['scanned'], exclusions=discovery['exclusions'], tennisTag=864,
                               dateBasis='Scheduled gameStartTime, falling back to event startTime',
                               scope='Tennis-tagged moneyline markets with two named outcomes; excludes doubles by title, slug, and outcome names.'),
                matchCount=len(summaries), expectedMarketCount=len(discovery['markets']),
                inProgress=len(summaries) < len(discovery['markets']), withHistory=available, withPreMatch=pre_available,
                pricePointCount=count, failedOutcomes=errors, resolutions=dict(resolutions), months=months,
                sources=['https://gamma-api.polymarket.com/markets/keyset', 'https://data-api.polymarket.com/v2/prices-history'],
                notes=['One-off historical archive; live browser quotes are separate and do not update this database.',
                       'History availability and spacing vary. Missing points are not interpolated or fabricated.',
                       'Zero-resolution terminal points are excluded conservatively: the API uses them for both exact ticks and synthetic settlement payouts.',
                       'Decimal odds equal 1 / token price, before fees; historical prices are not executable quotes.',
                       'Price timestamps are bucket starts. Pre-match requires timestamp + resolution_seconds <= scheduled start; buckets crossing the start are excluded.',
                       'The API scheduled start time may differ from actual play. Only buckets ending by the snapshot cutoff are retained.',
                       'The volume threshold may have been reached during or after play. Historical threshold crossing is unknown.'])
    for k, v in meta.items():
        db.execute('INSERT INTO metadata VALUES (?,?)', (k, json.dumps(v)))
    db.commit()
    if db.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
        raise RuntimeError('SQLite integrity check failed')
    db.close()
    write_json(DATA / 'manifest.json', meta)
    write_json(DATA / 'markets.json', summaries)
    with zipfile.ZipFile(DATA / 'tennis-archive.sqlite.zip', 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        archive.write(CACHE / 'archive.sqlite', 'tennis-archive.sqlite')
    print(json.dumps({k: meta[k] for k in ['matchCount', 'withHistory', 'withPreMatch', 'pricePointCount', 'failedOutcomes', 'resolutions']}, indent=2), flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--discover-only', action='store_true')
    parser.add_argument('--workers', type=int, default=8)
    args = parser.parse_args()
    CACHE.mkdir(exist_ok=True)
    state = CACHE / 'run.json'
    if state.exists():
        window = json.loads(state.read_text())
    else:
        now = dt.datetime.now(UTC)
        start = now.replace(year=now.year - 1, hour=0, minute=0, second=0, microsecond=0)
        window = dict(start=int(start.timestamp()), end=int(now.timestamp()))
        write_json(state, window)
    discovery = discover(**window)
    if args.discover_only:
        return
    collected = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as executor:
        futures = [executor.submit(collect, m, **window) for m in discovery['markets']]
        for future in concurrent.futures.as_completed(futures):
            collected.append(future.result())
            if len(collected) % 100 == 0:
                failures = sum(bool(o.get('error')) for _, h in collected for o in h['outcomes'])
                print(f'History {len(collected)}/{len(futures)} markets; failed outcomes: {failures}', flush=True)
    export(discovery, collected)


if __name__ == '__main__':
    main()
