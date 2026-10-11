# Court Archive

A one-off, public archive of **Polymarket tennis singles match-winner markets with recorded total volume above $5,000**, covering scheduled matches from **11 October 2025 to 11 October 2026**.

**Website:** https://migita.github.io/polymarket-tennis-archive/

The site provides player/tournament search, tour and date filters, monthly navigation, pre-match and full-history charts, decimal odds, CSV exports, and a downloadable SQLite database. It is a static GitHub Pages site. Visitors need no account, installation, API key, or wallet.

## Data semantics

- The threshold applies to **match-winner market volume at collection**, strictly greater than $5,000. It does not establish when the threshold was crossed or whether it was crossed before play. Volume is not the sum of all side bets in the event.
- Discovery uses the Gamma tennis tag (`864`), `sports_market_types=moneyline`, both closed and open markets, and cursor pagination. The importer excludes doubles using titles, slugs, and paired outcome names. This is metadata-based classification, not an independently verified match schedule.
- The date window applies to `gameStartTime`, falling back to event `startTime`. API market expiry dates often occur days after the tennis match, so they are not used as match dates. Discovery scans expiries from a month before the window; final inclusion uses scheduled match time.
- Each player's token history is fetched independently. The second series is not invented as `1 - first_price`.
- Recent histories request 15-minute buckets; older histories request 30-minute or 3-hour buckets, with a 12-hour fallback. The site and database preserve each API observation's timestamp and `resolution_seconds`. Timestamps are bucket starts; the observation falls somewhere within that interval. Only buckets ending by the snapshot cutoff are retained. Actual spacing may be longer than nominal resolution. Missing observations are never interpolated into the data.
- Fine-history requests use bounded windows of at most 14 days. Long-range requests use `interval=max`. All price-history cursors are followed. Zero-resolution terminal points are excluded conservatively: the API uses them for both exact ticks and synthetic settlement payouts, without a separate discriminator. This also omits some real exact terminal observations.
- “Last pre-match odds” uses the final available bucket **ending at or before the scheduled start** (`timestamp + resolution_seconds <= match_time`). It is not necessarily the final quote before actual play. Scheduled starts can be stale or rescheduled.
- Decimal odds are `1 / token_price`, before fees. Historical prices are not guaranteed executable quotes. A zero price has infinite implied decimal odds; absent data stays absent.
- This is **one snapshot**, not a continuously running monitor. Reloading the website does not collect new data. Its only browser requests are static assets, archived JSON, and the display font.

See [the collection manifest](site/data/manifest.json) for exact timestamps, counts, resolution coverage, excluded-market counts, and request failures. The archive covers markets returned by the public API, not all matches played during the year. Separate listings for the same players and scheduled start remain separate market IDs; their prices and volumes are not merged.

## Download and query

Download [`tennis-archive.sqlite.zip`](https://migita.github.io/polymarket-tennis-archive/data/tennis-archive.sqlite.zip) and extract it. The database contains:

| Table | Columns |
| --- | --- |
| `markets` | `id`, `match_time`, `volume_usd`, `data_json` |
| `prices` | `market_id`, `token_id`, `timestamp`, `price`, `resolution_seconds` |
| `metadata` | `key`, `value` (JSON) |

Timestamps are Unix seconds in UTC. Full metadata includes player/token mappings and source identifiers. Example query:

```sql
SELECT m.id, json_extract(m.data_json, '$.title') AS match,
       datetime(p.timestamp, 'unixepoch') AS observed_utc,
       p.token_id, p.price,
       CASE WHEN p.price > 0 THEN 1.0 / p.price END AS decimal_odds,
       p.resolution_seconds
FROM prices p
JOIN markets m ON m.id = p.market_id
WHERE p.timestamp + p.resolution_seconds <= m.match_time
ORDER BY m.match_time DESC, p.timestamp;
```

Static files are `site/data/markets.json` (the index), `site/data/history/<market-id>.json` (both players' observations), and `site/data/manifest.json` (provenance). History point arrays have columns `[timestamp, price, resolution_seconds]`. A failed API request is stored as an outcome `error`, separately from an empty successful response.

## Run locally

Python 3 is enough to serve the website:

```sh
python3 -m http.server 4173 --directory site
```

Open http://localhost:4173. Do not open `index.html` as a `file://` URL; the browser must be able to fetch the JSON files over HTTP.

## Reproduce the backfill

Requires Python 3 and `curl`. No Python packages or Polymarket credentials are required.

```sh
python3 scripts/backfill.py
python3 scripts/validate.py
```

The first run fixes a one-year window in `.cache/run.json`. Discovery and successful HTTP responses are cached. Completed match files are reused when they match that window; failed requests are retried on the next run. The collector uses eight workers and a shared request rate below 20 requests/second. A full import can take tens of minutes.

To make a new snapshot, move `.cache/` aside before starting. Existing history files with a different window will be replaced. To preserve an old archive, copy `site/data/` first. Review the new manifest and validation results before committing refreshed data.

## Checks

```sh
python3 -m unittest discover -s tests -p 'test_*.py'
python3 scripts/validate.py
node --check site/app.js
npm ci
npx playwright install chromium
npm run test:browser
```

Tests cover market classification, strict threshold/date boundaries, cursor handling, settlement exclusion, browser filtering, CSV download, chart interaction, missing data, API-file errors, and mobile overflow. The artifact validator scans every market and observation and reconciles counts with the manifest.

## Publishing

GitHub Pages is configured to use **GitHub Actions**. Pushing to `main` runs checks and publishes the `site/` directory through `.github/workflows/pages.yml`. There is deliberately no scheduled collection workflow.

Sources: [market discovery](https://docs.polymarket.com/market-data/discover-markets), [price-history API](https://docs.polymarket.com/api-reference/markets/get-a-tokens-price-history), [GitHub Pages workflows](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages).

Independent project, not affiliated with Polymarket.
