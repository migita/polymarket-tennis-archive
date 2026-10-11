const GAMMA = 'https://gamma-api.polymarket.com/markets/keyset';
const BOOKS = 'https://clob.polymarket.com/books';

function array(value) {
  try { const result = typeof value === 'string' ? JSON.parse(value) : value; return Array.isArray(result) ? result : []; }
  catch { return []; }
}

export function normalizeLive(raw) {
  const players = array(raw.outcomes), tokenIds = array(raw.clobTokenIds);
  const title = raw.question ?? '', slug = raw.slug ?? '';
  const volume = Number(raw.volumeNum ?? raw.volume);
  if (raw.closed || raw.sportsMarketType !== 'moneyline' || !Number.isFinite(volume) || volume <= 5000) return null;
  if (players.length !== 2 || tokenIds.length !== 2 || !/\bvs\.?\s/i.test(title)) return null;
  if (players.some((p) => typeof p !== 'string' || /^(yes|no|draw)$/i.test(p) || /[/&+]/.test(p))) return null;
  if (/doubles|doubles?\b|\bmixed\b/i.test(`${title} ${slug}`)) return null;
  const event = raw.events?.[0] ?? {};
  const matchTime = (Date.parse(raw.gameStartTime) || Date.parse(event.startTime)) / 1000;
  if (!Number.isFinite(matchTime) || raw.id == null) return null;
  let tour = event.seriesSlug || event.series?.[0]?.slug;
  if (!['atp', 'wta', 'itf'].includes(tour)) tour = slug.split('-')[0];
  return {
    id: String(raw.id), title, slug: event.slug || slug, players, tokenIds,
    tour: ['atp', 'wta', 'itf'].includes(tour) ? tour.toUpperCase() : 'OTHER',
    tournament: title.includes(':') ? title.split(':')[0] : 'Tennis', matchTime, volume,
    closed: false, acceptingOrders: raw.acceptingOrders === true,
    archived: false, preMatch: players.map(() => ({ count: 0, last: null })), historyPoints: 0,
  };
}

export function bestAsk(book) {
  let price = Infinity, size = 0;
  for (const level of book.asks ?? []) {
    const p = Number(level.price), s = Number(level.size);
    if (!Number.isFinite(p) || p <= 0 || p > 1 || !Number.isFinite(s) || s <= 0) continue;
    if (p < price) { price = p; size = s; }
    else if (p === price) size += s;
  }
  return price === Infinity ? null : { price, size, bookTime: Number(book.timestamp) || null };
}

async function json(url, options, fetcher) {
  const response = await fetcher(url, { ...options, signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`Polymarket HTTP ${response.status}`);
  return response.json();
}

// Complete a scan before replacing the displayed snapshot. A failed batch must
// not make a partial list look complete or silently erase previous quotes.
export async function fetchLive(fetcher = fetch) {
  const found = new Map(), visited = new Set();
  let cursor = '';
  for (let page = 0; page < 100; page++) {
    const params = new URLSearchParams({ tag_id: '864', sports_market_types: 'moneyline', volume_num_min: '5000', closed: 'false', limit: '100', order: 'id', ascending: 'true' });
    if (cursor) params.set('after_cursor', cursor);
    const data = await json(`${GAMMA}?${params}`, { cache: 'no-store' }, fetcher);
    if (!Array.isArray(data.markets)) throw new Error('Unexpected market response');
    for (const raw of data.markets) {
      const m = normalizeLive(raw);
      if (m) found.set(m.id, m);
    }
    cursor = data.next_cursor;
    if (!cursor) break;
    if (visited.has(cursor) || page === 99) throw new Error('Incomplete market pagination');
    visited.add(cursor);
  }
  const tokens = [...new Set([...found.values()].filter((m) => m.acceptingOrders).flatMap((m) => m.tokenIds))];
  const books = new Map();
  for (let i = 0; i < tokens.length; i += 100) {
    const batch = tokens.slice(i, i + 100);
    const result = await json(BOOKS, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(batch.map((token_id) => ({ token_id }))) }, fetcher);
    if (!Array.isArray(result)) throw new Error('Unexpected order book response');
    for (const book of result) {
      if (!Array.isArray(book.asks)) throw new Error('Incomplete order book response');
      books.set(String(book.asset_id), bestAsk(book));
    }
    if (batch.some((id) => !books.has(String(id)))) throw new Error('Missing outcome order book');
  }
  const fetchedAt = Date.now();
  return [...found.values()].map((m) => ({ ...m, live: {
    asks: m.tokenIds.map((id) => m.acceptingOrders ? books.get(String(id)) ?? null : null),
    fetchedAt, stale: false, acceptingOrders: m.acceptingOrders,
  } }));
}
