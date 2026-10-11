const $ = (id) => document.getElementById(id);
const number = new Intl.NumberFormat('en-GB');
const compact = new Intl.NumberFormat('en-GB', { notation: 'compact', maximumFractionDigits: 1 });
const shortDate = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
const dateTime = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' });
const dayTime = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' });
const monthName = new Intl.DateTimeFormat('en-GB', { month: 'short', year: '2-digit', timeZone: 'UTC' });
const PAGE_SIZE = 30;
const state = { markets: [], filtered: [], page: 0, selected: null, history: null, range: 'pre', requestId: 0, manifest: null, cache: new Map() };
const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fold = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const formatTime = (t) => dateTime.format(new Date(t * 1000));
const odds = (p) => p === null || p === undefined ? '—' : p === 0 ? '∞' : (1 / p).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const resolution = (s) => s < 3600 ? `${s / 60} min` : `${s / 3600} hr`;
const priceText = (p) => `${(p * 100).toFixed(1)}%`;

async function getJson(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function renderOverview() {
  const m = state.manifest;
  $('preview-banner').hidden = !m.inProgress;
  if (m.inProgress) $('preview-banner').textContent = `INTERFACE PREVIEW · ${number.format(m.matchCount)} of ${number.format(m.expectedMarketCount)} markets imported. The backfill is still running. Counts and month coverage below show only downloaded markets; the complete archive will follow.`;
  $('period').textContent = `${shortDate.format(new Date(m.from))} — ${shortDate.format(new Date(m.to))}`;
  $('stat-matches').textContent = number.format(m.matchCount);
  $('stat-history').textContent = number.format(m.withHistory);
  $('stat-coverage').textContent = `${number.format(m.withPreMatch)} with pre-match observations`;
  $('stat-points').textContent = compact.format(m.pricePointCount);
  $('stat-volume').textContent = `$${compact.format(state.markets.reduce((sum, x) => sum + x.volume, 0))}`;
  $('collected-at').textContent = `Match window ends ${dateTime.format(new Date(m.snapshotAt))} UTC. Collection completed ${dateTime.format(new Date(m.generatedAt))} UTC. ${m.failedOutcomes ? `${m.failedOutcomes} outcome histories could not be fetched; see the manifest.` : 'A single snapshot, ready to explore or download.'}`;
  const tours = [...new Set(state.markets.map((x) => x.tour))].sort();
  $('tour').innerHTML += tours.map((x) => `<option value="${escapeHtml(x)}">${escapeHtml(x)}</option>`).join('');
  for (const id of ['from', 'to']) {
    $(id).min = m.from.slice(0, 10);
    $(id).max = m.to.slice(0, 10);
  }
  $('from').value = m.from.slice(0, 10);
  $('to').value = m.to.slice(0, 10);
  const max = Math.max(...Object.values(m.months).map((x) => x.matches), 1);
  const cursor = new Date(`${m.from.slice(0, 7)}-01T00:00:00Z`);
  const final = m.to.slice(0, 7);
  const months = [];
  while (cursor.toISOString().slice(0, 7) <= final) {
    const key = cursor.toISOString().slice(0, 7);
    const count = m.months[key]?.matches ?? 0;
    months.push(`<button type="button" class="month" data-month="${key}" aria-label="Filter to ${monthName.format(cursor)}: ${number.format(count)} matches"><span class="month-count">${number.format(count)}</span><span class="month-bar-space"><span class="month-bar" style="height:${Math.max(count ? 5 : 0, count / max * 50)}px"></span></span><span class="month-name">${monthName.format(cursor)}</span></button>`);
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  $('timeline').innerHTML = months.join('');
  $('timeline').addEventListener('click', (event) => {
    const button = event.target.closest('[data-month]');
    if (!button) return;
    const month = button.dataset.month;
    const last = new Date(`${month}-01T00:00:00Z`);
    last.setUTCMonth(last.getUTCMonth() + 1);
    last.setUTCDate(0);
    $('from').value = [month + '-01', m.from.slice(0, 10)].sort().at(-1);
    $('to').value = [last.toISOString().slice(0, 10), m.to.slice(0, 10)].sort()[0];
    document.querySelectorAll('.month').forEach((b) => b.classList.toggle('active', b === button));
    filter();
  });
}

function filter() {
  const q = fold($('search').value.trim());
  const from = $('from').value ? Date.parse($('from').value + 'T00:00:00Z') / 1000 : -Infinity;
  const to = $('to').value ? Date.parse($('to').value + 'T00:00:00Z') / 1000 + 86400 : Infinity;
  const tour = $('tour').value;
  const withHistory = $('has-history').checked;
  state.filtered = state.markets.filter((m) => (!q || m.searchText.includes(q)) && (!tour || m.tour === tour) && m.matchTime >= from && m.matchTime < to && (!withHistory || m.preMatch.some((p) => p.count > 0)));
  state.filtered.sort((a, b) => $('sort').value === 'volume' ? b.volume - a.volume : $('sort').value === 'oldest' ? a.matchTime - b.matchTime : b.matchTime - a.matchTime);
  state.page = 0;
  // Keep the detail within the visible selection, including after filters become empty.
  if (!state.filtered.some((m) => m.id === state.selected?.id)) {
    state.selected = null;
    state.history = null;
    state.requestId++;
    $('detail').innerHTML = '<div class="detail-placeholder"><div class="crosshair">+</div><p class="eyebrow">A CLOSER LOOK</p><h3>Select a match.</h3><p>Explore historical prices and pre-match odds.</p></div>';
  }
  renderTable();
}

function renderTable() {
  const rows = state.filtered.slice(state.page * PAGE_SIZE, (state.page + 1) * PAGE_SIZE);
  $('matches').innerHTML = rows.map((m) => `<tr data-id="${m.id}" class="${state.selected?.id === m.id ? 'selected' : ''}"><td><button class="match-button" type="button" aria-pressed="${state.selected?.id === m.id}"><span class="match-tournament">${escapeHtml(m.tournament)}</span>${escapeHtml(m.players[0])}<br>${escapeHtml(m.players[1])}<span class="match-date"><span class="tour-tag">${escapeHtml(m.tour)}</span>${formatTime(m.matchTime)}</span></button></td><td class="number volume-cell" title="$${number.format(m.volume)} recorded total volume">$${compact.format(m.volume)}</td><td class="number odds-cell">${m.preMatch.some((x) => x.last) ? m.preMatch.map((x, i) => `<span class="odds-pair" title="${escapeHtml(m.players[i])}${x.last ? ': ' + formatTime(x.last[0]) + ' UTC' : ': no pre-match history'}"><span class="dot ${i ? 'second' : ''}"></span>${odds(x.last?.[1])}</span>`).join('') : '<span class="no-history">No pre-match<br>history</span>'}</td></tr>`).join('');
  $('result-count').textContent = `${number.format(state.filtered.length)} of ${number.format(state.markets.length)} matches`;
  const pages = Math.ceil(state.filtered.length / PAGE_SIZE);
  $('page-info').textContent = pages ? `${state.page + 1} / ${pages}` : '0 matches';
  $('prev').disabled = state.page === 0;
  $('next').disabled = state.page + 1 >= pages;
  $('empty').hidden = rows.length > 0;
  $('export-markets').disabled = !state.filtered.length;
}

async function selectMatch(id, scroll = false) {
  const market = state.markets.find((m) => m.id === id);
  if (!market) return;
  state.selected = market;
  state.history = null;
  state.range = 'pre';
  const requestId = ++state.requestId;
  const url = new URL(location.href);
  url.searchParams.set('match', id);
  history.replaceState(null, '', url);
  renderTable();
  $('detail').innerHTML = '<p class="loading-detail" role="status">Loading match history…</p>';
  if (scroll && window.innerWidth <= 800) $('detail').scrollIntoView({ behavior: 'smooth', block: 'start' });
  try {
    const data = state.cache.get(id) ?? await getJson(`./data/history/${encodeURIComponent(id)}.json`);
    if (requestId !== state.requestId) return;
    state.cache.set(id, data);
    state.history = data;
    renderDetail();
  } catch (error) {
    if (requestId !== state.requestId) return;
    $('detail').innerHTML = `<div class="loading-detail"><p>Could not load this match’s history (${escapeHtml(error.message)}).</p><button id="retry-history" class="outline-button" type="button">Try again</button></div>`;
    $('retry-history').onclick = () => selectMatch(id);
  }
}

function renderDetail() {
  const m = state.selected;
  $('detail').innerHTML = `<div class="detail-top"><div class="detail-kicker"><span>${escapeHtml(m.tour)} / ${escapeHtml(m.tournament)}</span><span class="status-tag">${m.closed ? 'CLOSED MARKET' : 'OPEN AT COLLECTION'}</span></div><h3>${escapeHtml(m.players[0])}<span class="versus">vs</span>${escapeHtml(m.players[1])}</h3><div class="detail-sub"><span>${formatTime(m.matchTime)} UTC</span><span>·</span><span>$${number.format(m.volume)} traded</span><a href="https://polymarket.com/event/${encodeURIComponent(m.slug)}" target="_blank" rel="noopener">Polymarket ↗</a></div></div><div class="odds-cards">${m.preMatch.map((p, i) => `<div class="odds-card"><div class="player-label"><span class="dot ${i ? 'second' : ''}"></span>${escapeHtml(m.players[i])}</div><strong class="odds-value">${odds(p.last?.[1])}</strong><div class="odds-caption">LAST PRE-MATCH DECIMAL ODDS${p.last ? `<time>Bucket starts ${formatTime(p.last[0])} UTC</time><span>${priceText(p.last[1])} implied probability · ${resolution(p.last[2])} resolution</span>` : '<time>No observation before scheduled start</time>'}</div></div>`).join('')}</div><div class="chart-section"><div class="chart-heading"><span>IMPLIED PROBABILITY</span><div class="segmented" aria-label="Price history range"><button type="button" data-range="pre" class="active" aria-pressed="true">Pre-match</button><button type="button" data-range="all" aria-pressed="false">Full history</button></div></div><div class="chart-legend">${m.players.map((p, i) => `<span><span class="dot ${i ? 'second' : ''}"></span>${escapeHtml(p)}</span>`).join('')}</div><div id="chart" class="chart-wrap"></div><div id="chart-tooltip" class="chart-tooltip" aria-live="polite" hidden></div><input id="sample-slider" class="sample-slider" type="range" min="0" max="0" value="0" aria-label="Explore individual price observations" hidden><p id="chart-hint" class="chart-hint"></p></div><div class="detail-bottom"><span id="history-count"></span><button id="export-history" type="button">↓ Download match prices (CSV)</button></div>`;
  document.querySelectorAll('[data-range]').forEach((b) => b.onclick = () => {
    state.range = b.dataset.range;
    document.querySelectorAll('[data-range]').forEach((x) => {
      x.classList.toggle('active', x === b);
      x.setAttribute('aria-pressed', String(x === b));
    });
    renderChart();
  });
  $('export-history').onclick = exportHistory;
  renderChart();
}

function renderChart() {
  const m = state.selected;
  const outcomes = state.history.outcomes.map((o) => ({ ...o, points: o.points.filter((p) => state.range === 'all' || p[0] + p[2] <= m.matchTime) }));
  const samples = outcomes.flatMap((o, i) => o.points.map((p) => ({ point: p, player: o.player, i }))).sort((a, b) => a.point[0] - b.point[0]);
  const resolutions = [...new Set(samples.map((s) => s.point[2]))].sort((a, b) => a - b);
  $('history-count').textContent = `${number.format(samples.length)} observations ${state.range === 'pre' ? 'before scheduled start' : 'in full history'}`;
  $('export-history').disabled = !state.history.outcomes.some((o) => o.points.length);
  $('chart-tooltip').hidden = true;
  $('sample-slider').hidden = !samples.length;
  if (!samples.length) {
    const failed = state.history.outcomes.some((o) => o.error);
    $('chart').innerHTML = `<div class="chart-empty">${failed ? 'The source request failed for one or both players.' : state.range === 'pre' && state.history.outcomes.some((o) => o.points.length) ? 'No retained observations before the scheduled start.<br>Switch to full history to see the available prices.' : 'No retained price history was returned for this match.'}</div>`;
    $('chart-hint').textContent = 'Missing history is left empty. The market’s final price is not used as a historical substitute.';
    return;
  }
  const W = 620, H = 225, left = 37, right = 16, top = 16, bottom = 35;
  const min = samples[0].point[0], max = samples.at(-1).point[0];
  const span = max - min || 3600;
  const x = (t) => left + (t - min) / span * (W - left - right);
  const y = (p) => top + (1 - p) * (H - top - bottom);
  const colors = ['#306b50', '#b87146'];
  let svg = `<svg id="price-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Historical implied probabilities for ${escapeHtml(m.players.join(' and '))}. Use the slider below to read individual observations.">`;
  for (const p of [0, .25, .5, .75, 1]) svg += `<line class="chart-grid" x1="${left}" x2="${W - right}" y1="${y(p)}" y2="${y(p)}"/><text class="chart-label" x="${left - 8}" y="${y(p) + 3}" text-anchor="end">${p * 100}%</text>`;
  for (const [i, o] of outcomes.entries()) {
    // Break the line at large gaps; keep every original timestamp in the data/CSV.
    let segment = [];
    const segments = [];
    for (const p of o.points) {
      const previous = segment.at(-1);
      if (previous && p[0] - previous[0] > Math.max(p[2], previous[2]) * 4) {
        segments.push(segment);
        segment = [];
      }
      segment.push(p);
    }
    if (segment.length) segments.push(segment);
    for (const group of segments) {
      if (group.length === 1) svg += `<circle cx="${x(group[0][0])}" cy="${y(group[0][1])}" r="3" fill="${colors[i]}"/>`;
      else svg += `<polyline class="chart-line" stroke="${colors[i]}" points="${group.map((p) => `${x(p[0]).toFixed(2)},${y(p[1]).toFixed(2)}`).join(' ')}"/>`;
    }
  }
  if (state.range === 'all' && m.matchTime >= min && m.matchTime <= max) svg += `<line x1="${x(m.matchTime)}" x2="${x(m.matchTime)}" y1="${top}" y2="${H - bottom}" stroke="#9ba98f" stroke-dasharray="4 4"/><text class="chart-label" x="${Math.min(x(m.matchTime) + 4, W - 90)}" y="10">Scheduled start</text>`;
  svg += `<text class="chart-label" x="${left}" y="${H - 10}">${dayTime.format(new Date(min * 1000))}</text><text class="chart-label" x="${W - right}" y="${H - 10}" text-anchor="end">${dayTime.format(new Date(max * 1000))} UTC</text><circle id="chart-cursor" r="4" stroke="white" stroke-width="2" opacity="0"/></svg>`;
  $('chart').innerHTML = svg;
  $('chart-hint').textContent = `${resolutions.map(resolution).join(' / ')} source resolution. Times mark bucket starts; pre-match buckets end by scheduled start. Lines connect available buckets, with large gaps left open. Hover or use the slider to inspect a price. ${state.history.outcomes.some((o) => o.error) ? 'One or more source requests failed.' : ''}`;
  const showSample = (index) => {
    const s = samples[index];
    const [t, p, r] = s.point;
    $('chart-tooltip').textContent = `${s.player} · bucket starts ${formatTime(t)} UTC · ${priceText(p)} · ${odds(p)} decimal odds · ${resolution(r)}`;
    $('chart-tooltip').hidden = false;
    $('sample-slider').value = index;
    const circle = $('chart-cursor');
    circle.setAttribute('cx', x(t)); circle.setAttribute('cy', y(p)); circle.setAttribute('fill', colors[s.i]); circle.setAttribute('opacity', 1);
  };
  $('sample-slider').max = samples.length - 1;
  $('sample-slider').value = samples.length - 1;
  $('sample-slider').oninput = (e) => showSample(Number(e.target.value));
  $('price-chart').onpointermove = (event) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const localX = (event.clientX - rect.left) / rect.width * W;
    const localY = (event.clientY - rect.top) / rect.height * H;
    let best = 0, distance = Infinity;
    samples.forEach((s, i) => {
      const d = Math.abs(x(s.point[0]) - localX) * 3 + Math.abs(y(s.point[1]) - localY);
      if (d < distance) { distance = d; best = i; }
    });
    showSample(best);
  };
}

function csvCell(value) {
  let text = String(value ?? '');
  // Keep source titles from becoming spreadsheet formulas.
  if (/^[=+@\-\t\r]/.test(text)) text = "'" + text;
  return `"${text.replaceAll('"', '""')}"`;
}

function downloadCsv(name, rows) {
  const text = '\uFEFF' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url; link.download = name; document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportMarkets() {
  const rows = [['market_id', 'tournament', 'tour', 'scheduled_start_utc', 'player_1', 'player_2', 'total_volume_usd_at_collection', 'player_1_last_pre_match_price', 'player_1_decimal_odds', 'player_1_bucket_start_utc', 'player_2_last_pre_match_price', 'player_2_decimal_odds', 'player_2_bucket_start_utc', 'history_points', 'url']];
  for (const m of state.filtered) {
    rows.push([m.id, m.tournament, m.tour, new Date(m.matchTime * 1000).toISOString(), ...m.players, m.volume,
      ...m.preMatch.flatMap((p) => p.last ? [p.last[1], p.last[1] > 0 ? 1 / p.last[1] : 'Infinity', new Date(p.last[0] * 1000).toISOString()] : ['', '', '']),
      m.historyPoints, `https://polymarket.com/event/${m.slug}`]);
  }
  downloadCsv('tennis-matches.csv', rows);
}

function exportHistory() {
  const m = state.selected;
  const rows = [['market_id', 'player', 'token_id', 'bucket_start_utc', 'bucket_start_unix', 'price', 'decimal_odds_before_fees', 'resolution_seconds', 'bucket_ends_by_scheduled_start']];
  for (const o of state.history.outcomes) for (const [t, p, r] of o.points) rows.push([m.id, o.player, o.tokenId, new Date(t * 1000).toISOString(), t, p, p > 0 ? 1 / p : 'Infinity', r, t + r <= m.matchTime]);
  downloadCsv(`tennis-${m.id}-prices.csv`, rows);
}

function resetDates() {
  $('from').value = state.manifest.from.slice(0, 10);
  $('to').value = state.manifest.to.slice(0, 10);
  document.querySelectorAll('.month').forEach((b) => b.classList.remove('active'));
}

async function init() {
  try {
    const [manifest, markets] = await Promise.all([getJson('./data/manifest.json'), getJson('./data/markets.json')]);
    state.manifest = manifest;
    state.markets = markets.map((m) => ({ ...m, searchText: fold(`${m.title} ${m.players.join(' ')}`) }));
    renderOverview();
    $('filters').onsubmit = (event) => event.preventDefault();
    $('search').oninput = filter;
    for (const id of ['tour', 'sort', 'from', 'to', 'has-history']) $(id).onchange = () => {
      if (id === 'from' || id === 'to') document.querySelectorAll('.month').forEach((b) => b.classList.remove('active'));
      filter();
    };
    $('all-months').onclick = () => { resetDates(); filter(); };
    $('reset').onclick = () => { $('filters').reset(); $('has-history').checked = false; resetDates(); filter(); };
    $('prev').onclick = () => { state.page--; renderTable(); };
    $('next').onclick = () => { state.page++; renderTable(); };
    $('matches').onclick = (event) => { const row = event.target.closest('[data-id]'); if (row) selectMatch(row.dataset.id, true); };
    $('export-markets').onclick = exportMarkets;
    filter();
    const requested = new URLSearchParams(location.search).get('match');
    const first = state.markets.find((m) => m.id === requested) ?? state.filtered.find((m) => m.preMatch.some((p) => p.count));
    if (first) selectMatch(first.id);
  } catch (error) {
    $('result-count').textContent = 'Archive unavailable';
    $('load-error').hidden = false;
    $('load-error').textContent = `The archive could not be loaded (${error.message}). Please reload the page. If running locally, use an HTTP server rather than opening index.html directly.`;
  }
}

init();
