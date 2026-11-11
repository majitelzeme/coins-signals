/* Memecoin Signals — live memecoin signals PWA. No external libraries. */
'use strict';

// ---------- config ----------
const CG = 'https://api.coingecko.com/api/v3';
const BINANCE = ['https://data-api.binance.vision/api/v3', 'https://api.binance.com/api/v3'];
const MARKETS_TTL = 60 * 1000;          // reuse cached list for 60s
const HIST_TTL = 15 * 60 * 1000;        // reuse daily history for 15 min
const AUTO_REFRESH = 3 * 60 * 1000;     // auto refresh every 3 min
const PER_PAGE = 100;
const EXCLUDE = new Set(['tether','usd-coin','dai','first-digital-usd','ethena-usde','usds','paypal-usd','true-usd','frax',
  'usd1-wlfi','falcon-finance','global-dollar','ripple-usd','blackrock-usd-institutional-digital-liquidity-fund','usdtb','bfusd',
  'wrapped-bitcoin','staked-ether','wrapped-steth','weth','wrapped-eeth','coinbase-wrapped-btc','binance-bridged-usdt-bnb-smart-chain',
  'rocket-pool-eth','mantle-staked-ether','binance-staked-sol','jito-staked-sol','lombard-staked-btc','solv-btc','kelp-dao-restaked-eth',
  'renzo-restaked-eth','wbnb','wrapped-solana','susds','susde','bridged-usdc-polygon-pos-bridge','tether-gold','pax-gold','syrupusdc',
  'clbtc','wrapped-beacon-eth','liquid-staked-ethereum','stakewise-v3-oseth','binance-peg-weth','arbitrum-bridged-wbtc-arbitrum-one']);
const FALLBACK = [['DOGE','dogecoin','Dogecoin'],['SHIB','shiba-inu','Shiba Inu'],['PEPE','pepe','Pepe'],
  ['PENGU','pudgy-penguins','Pudgy Penguins'],['TRUMP','official-trump','Official Trump'],['BONK','bonk','Bonk'],
  ['FLOKI','floki','FLOKI'],['WIF','dogwifcoin','dogwifhat'],['PNUT','peanut-the-squirrel','Peanut the Squirrel'],
  ['TURBO','turbo','Turbo'],['NOT','notcoin','Notcoin'],['BOME','book-of-meme','BOOK OF MEME'],
  ['PEOPLE','constitutiondao','ConstitutionDAO'],['DOGS','dogs-2','Dogs'],['NEIRO','neiro-3','Neiro'],
  ['MEME','memecoin-2','Memecoin'],['1MBABYDOGE','baby-doge-coin','Baby Doge Coin'],['HMSTR','hamster-kombat','Hamster Kombat'],
  ['1000SATS','sats-ordinals','SATS (Ordinals)']];

// ---------- helpers ----------
const $ = s => document.querySelector(s);
const app = $('#app');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const ls = {
  get(k, d = null) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* quota: drop old history */ try { Object.keys(localStorage).filter(x => x.startsWith('hist:')).forEach(x => localStorage.removeItem(x)); localStorage.setItem(k, JSON.stringify(v)); } catch {} } }
};
function fmtPrice(p) {
  if (p == null || !isFinite(p)) return '—';
  const a = Math.abs(p);
  const d = a >= 1000 ? 0 : a >= 1 ? 2 : a >= 0.01 ? 4 : a >= 0.0001 ? 6 : 8;
  return '$' + p.toLocaleString('en-US', { minimumFractionDigits: a >= 1000 ? 0 : Math.min(d, 2), maximumFractionDigits: d });
}
const fmtPct = v => v == null || !isFinite(v) ? '—' : (v >= 0 ? '+' : '') + v.toFixed(2) + '%';
const pctCls = v => v >= 0 ? 'up' : 'dn';
function fmtBig(n) { if (!n) return '—'; const u = [[1e12,'T'],[1e9,'B'],[1e6,'M'],[1e3,'K']]; for (const [v, s] of u) if (n >= v) return '$' + (n / v).toFixed(2) + s; return '$' + n.toFixed(0); }
function timeAgo(ts) { const s = Math.round((Date.now() - ts) / 1000); if (s < 10) return 'just now'; if (s < 60) return s + 's ago'; if (s < 3600) return Math.round(s / 60) + ' min ago'; return Math.round(s / 3600) + ' h ago'; }
function toast(msg, ms = 3200) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(() => t.hidden = true, ms); }
class HttpError extends Error { constructor(status, url) { super('HTTP ' + status); this.status = status; this.url = url; } }
async function getJSON(url, timeout = 12000) {
  const ctl = new AbortController(); const id = setTimeout(() => ctl.abort(), timeout);
  try { const r = await fetch(url, { signal: ctl.signal }); if (!r.ok) throw new HttpError(r.status, url); return await r.json(); }
  finally { clearTimeout(id); }
}
async function pool(items, n, fn) { const out = new Array(items.length); let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; try { out[k] = await fn(items[k]); } catch { out[k] = null; } } })); return out; }
async function binance(path) { let err; for (const b of BINANCE) { try { return await getJSON(b + path); } catch (e) { err = e; } } throw err; }
const cgBlocked = () => Date.now() < ls.get('cg_block_until', 0);
function cgBackoff(e) { if (e && e.status === 429) ls.set('cg_block_until', Date.now() + 90 * 1000); }

// ---------- indicators ----------
function sma(a, n) { const o = Array(a.length).fill(null); let s = 0; for (let i = 0; i < a.length; i++) { s += a[i]; if (i >= n) s -= a[i - n]; if (i >= n - 1) o[i] = s / n; } return o; }
function ema(a, n) { const o = Array(a.length).fill(null); const k = 2 / (n + 1); let e = null; for (let i = 0; i < a.length; i++) { if (a[i] == null) continue; if (e == null) { // seed with SMA
      let c = 0, s = 0; for (let j = i; j < a.length && c < n; j++, c++) s += a[j]; if (c < n) break; e = s / n; i = i + n - 1; o[i] = e; continue; }
    e = a[i] * k + e * (1 - k); o[i] = e; } return o; }
function rsi(a, n = 14) { const o = Array(a.length).fill(null); if (a.length <= n) return o; let g = 0, l = 0;
  for (let i = 1; i <= n; i++) { const d = a[i] - a[i - 1]; if (d > 0) g += d; else l -= d; } g /= n; l /= n; o[n] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  for (let i = n + 1; i < a.length; i++) { const d = a[i] - a[i - 1]; g = (g * (n - 1) + Math.max(d, 0)) / n; l = (l * (n - 1) + Math.max(-d, 0)) / n; o[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); } return o; }
function macd(a, f = 12, s = 26, sg = 9) { const ef = ema(a, f), es = ema(a, s); const m = a.map((_, i) => ef[i] != null && es[i] != null ? ef[i] - es[i] : null);
  const first = m.findIndex(v => v != null); const sigPart = first < 0 ? [] : ema(m.slice(first), sg); const sig = Array(a.length).fill(null); sigPart.forEach((v, i) => sig[first + i] = v);
  const h = m.map((v, i) => v != null && sig[i] != null ? v - sig[i] : null); return { macd: m, signal: sig, hist: h }; }
const last = a => { for (let i = a.length - 1; i >= 0; i--) if (a[i] != null) return a[i]; return null; };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/**
 * Score a price series.  barsPerDay: 24 for hourly, 1 for daily.
 * Score components (max ±8, scaled to ±100):
 *   RSI(14)  : <30 +2 | 30–40 +1 | 60–70 −0.5 | >70 −2
 *   Trend    : SMA20 vs SMA50 ±1, fresh cross (last 5 bars) ±1, price vs SMA20 ±0.5
 *   MACD     : histogram sign ±1, histogram rising/falling ±0.5, fresh signal cross ±0.5
 *   Momentum : rate of change over the window, ±1.5 (10% move = 1 pt)
 */
function analyze(closes, barsPerDay = 24) {
  const n = closes.length; if (n < 55) return null;
  const price = closes[n - 1];
  const r = rsi(closes, 14), s20 = sma(closes, 20), s50 = sma(closes, 50), m = macd(closes);
  const R = last(r), A = s20[n - 1], B = s50[n - 1], H = m.hist[n - 1], Hp = m.hist[n - 2];
  const F = []; // factors {pts, txt}
  // RSI
  if (R < 30) F.push({ k: 'RSI', pts: 2, txt: `RSI ${R.toFixed(0)} oversold` });
  else if (R < 40) F.push({ k: 'RSI', pts: 1, txt: `RSI ${R.toFixed(0)} near oversold` });
  else if (R > 70) F.push({ k: 'RSI', pts: -2, txt: `RSI ${R.toFixed(0)} overbought` });
  else if (R > 60) F.push({ k: 'RSI', pts: -0.5, txt: `RSI ${R.toFixed(0)} getting stretched` });
  else F.push({ k: 'RSI', pts: 0, txt: `RSI ${R.toFixed(0)} neutral` });
  // SMA trend
  const up = A > B; F.push({ k: 'Trend', pts: up ? 1 : -1, txt: up ? 'SMA20 above SMA50 (uptrend)' : 'SMA20 below SMA50 (downtrend)' });
  let cross = 0; for (let i = n - 5; i < n; i++) { if (s20[i - 1] == null || s50[i - 1] == null) continue; const a0 = s20[i - 1] - s50[i - 1], a1 = s20[i] - s50[i]; if (a0 <= 0 && a1 > 0) cross = 1; if (a0 >= 0 && a1 < 0) cross = -1; }
  if (cross) F.push({ k: 'Cross', pts: cross, txt: cross > 0 ? 'fresh golden cross (SMA20↑SMA50)' : 'fresh death cross (SMA20↓SMA50)' });
  let pc = 0; for (let i = n - 3; i < n; i++) { if (closes[i - 1] <= s20[i - 1] && closes[i] > s20[i]) pc = 1; if (closes[i - 1] >= s20[i - 1] && closes[i] < s20[i]) pc = -1; }
  const above = price > A;
  F.push({ k: 'Price', pts: above ? 0.5 : -0.5, txt: pc > 0 ? 'price crossed above SMA20' : pc < 0 ? 'price dropped below SMA20' : above ? 'price above SMA20' : 'price below SMA20' });
  // MACD
  F.push({ k: 'MACD', pts: H > 0 ? 1 : -1, txt: H > 0 ? 'MACD above signal (bullish)' : 'MACD below signal (bearish)' });
  F.push({ k: 'MACD Δ', pts: H > Hp ? 0.5 : -0.5, txt: H > Hp ? 'MACD momentum rising' : 'MACD momentum fading' });
  let mc = 0; for (let i = n - 3; i < n; i++) { const a0 = m.hist[i - 1], a1 = m.hist[i]; if (a0 == null) continue; if (a0 <= 0 && a1 > 0) mc = 1; if (a0 >= 0 && a1 < 0) mc = -1; }
  if (mc) F.push({ k: 'MACD ×', pts: mc * 0.5, txt: mc > 0 ? 'MACD just crossed up' : 'MACD just crossed down' });
  // Momentum (over the window: 7d for hourly, 14d for daily)
  const lb = barsPerDay >= 24 ? n - 1 : Math.min(14, n - 1);
  const roc = (price / closes[n - 1 - lb] - 1) * 100;
  const mp = clamp(roc / 10, -1.5, 1.5);
  F.push({ k: 'Momentum', pts: +mp.toFixed(2), txt: `${roc >= 0 ? '+' : ''}${roc.toFixed(1)}% over ${barsPerDay >= 24 ? '7d' : '14d'}` });

  const total = F.reduce((s, f) => s + f.pts, 0);
  const score = Math.round(clamp(total / 8 * 100, -100, 100));
  const [label, code] = score >= 45 ? ['STRONG BUY', 'SB'] : score >= 15 ? ['BUY', 'B'] : score > -15 ? ['HOLD', 'H'] : score > -45 ? ['SELL', 'S'] : ['STRONG SELL', 'SS'];
  // Reason: strongest factors agreeing with the verdict
  const dir = Math.sign(score);
  let picks = F.filter(f => dir === 0 ? true : Math.sign(f.pts) === dir).sort((a, b) => Math.abs(b.pts) - Math.abs(a.pts));
  if (dir === 0) picks = [F.find(f => f.k === 'RSI'), ...F.filter(f => f.k !== 'RSI').sort((a, b) => Math.abs(b.pts) - Math.abs(a.pts))];
  const reasonParts = picks.slice(0, 3).map(f => f.txt);
  if (dir === 0) reasonParts[0] = 'Mixed signals: ' + reasonParts[0];
  let reason = reasonParts.join(', '); reason = reason.charAt(0).toUpperCase() + reason.slice(1);

  // Volatility (ATR-like from closes): mean |Δclose| over last 14 bars, scaled to one day
  let dv = 0; for (let i = n - 14; i < n; i++) dv += Math.abs(closes[i] - closes[i - 1]); dv /= 14;
  const atr = dv * Math.sqrt(barsPerDay);
  const sw = barsPerDay >= 24 ? 72 : 20;
  const win = closes.slice(-sw); const swingLow = Math.min(...win), swingHigh = Math.max(...win);
  let lv;
  if (code === 'SB' || code === 'B') {
    const stop = Math.max(Math.min(swingLow - 0.25 * atr, price - 1.5 * atr), price - 4 * atr);
    lv = { mode: 'long', entry: [price - 0.5 * atr, price], stop, tp: price + 2 * (price - stop) };
  } else if (code === 'H') {
    const eHi = price - 0.3 * atr, eLo = Math.max(price - 1.2 * atr, swingLow);
    const stop = Math.min(eLo - 1.2 * atr, swingLow - 0.25 * atr);
    lv = { mode: 'dip', entry: [Math.min(eLo, eHi), eHi], stop, tp: Math.max(swingHigh, eHi + 2 * (eHi - stop)) };
  } else {
    const eLo = swingLow, eHi = swingLow + 0.5 * atr; const stop = swingLow - 1.5 * atr;
    lv = { mode: 'wait', entry: [eLo, eHi], stop, tp: Math.max(A, price + atr) };
  }
  lv.rr = (lv.tp - lv.entry[1]) / Math.max(lv.entry[1] - lv.stop, 1e-12);
  return { score, label, code, reason, factors: F, rsi: R, sma20: A, sma50: B, macd: last(m.macd), signal: last(m.signal), hist: H, roc, atr, atrPct: atr / price * 100, swingLow, swingHigh, levels: lv,
    series: { r, s20, s50, m } };
}

// ---------- data ----------
const state = { coins: [], ts: 0, source: '', stale: false, filter: 'all', q: '', sort: 'score', loading: false, tf: '7d' };
const favs = () => ls.get('favs', []);
const isFav = id => favs().includes(id);
function toggleFav(id) { const f = favs(); const i = f.indexOf(id); i >= 0 ? f.splice(i, 1) : f.unshift(id); ls.set('favs', f); return i < 0; }

function enrich(c) {
  const sig = c.spark && c.spark.length >= 55 ? analyze(c.spark, 24) : null;
  if (sig) delete sig.series; // keep list lean
  return { ...c, sig };
}
async function fromCoinGecko() {
  const url = `${CG}/coins/markets?vs_currency=usd&category=meme-token&order=market_cap_desc&per_page=${PER_PAGE}&page=1&sparkline=true&price_change_percentage=24h,7d`;
  const d = await getJSON(url);
  const imgs = ls.get('imgs', {});
  const coins = d.filter(x => !EXCLUDE.has(x.id) && !(x.current_price > 0.97 && x.current_price < 1.03 && Math.abs(x.price_change_percentage_7d_in_currency || 0) < 1)).map(x => {
    imgs[x.id] = x.image;
    return { id: x.id, symbol: x.symbol, name: x.name, image: x.image, price: x.current_price, mcap: x.market_cap, rank: x.market_cap_rank, vol: x.total_volume,
      ch24: x.price_change_percentage_24h_in_currency ?? x.price_change_percentage_24h, ch7d: x.price_change_percentage_7d_in_currency,
      high24: x.high_24h, low24: x.low_24h, ath: x.ath, spark: (x.sparkline_in_7d && x.sparkline_in_7d.price || []).filter(v => v != null) };
  });
  ls.set('imgs', imgs);
  return coins;
}
async function fromBinance() {
  const imgs = ls.get('imgs', {});
  const rows = await pool(FALLBACK, 8, async ([sym, id, name], ) => {
    const k = await binance(`/klines?symbol=${sym}USDT&interval=1h&limit=168`);
    const c = k.map(x => +x[4]); const p = c[c.length - 1];
    const vol = k.slice(-24).reduce((s, x) => s + +x[7], 0);
    return { id, symbol: sym.toLowerCase(), name, image: imgs[id] || '', price: p, mcap: null, rank: null, vol,
      ch24: (p / c[c.length - 25] - 1) * 100, ch7d: (p / c[0] - 1) * 100, spark: c, binance: true };
  });
  const out = rows.filter(Boolean); if (!out.length) throw new Error('Binance fallback failed');
  out.forEach((c, i) => c.rank = FALLBACK.findIndex(f => f[1] === c.id) + 1);
  return out;
}
async function loadMarkets(force = false) {
  const cache = ls.get('markets');
  if (!force && cache && Date.now() - cache.ts < MARKETS_TTL) { Object.assign(state, cache, { stale: false }); return; }
  let coins, source, err;
  if (!cgBlocked()) { try { coins = await fromCoinGecko(); source = 'CoinGecko'; } catch (e) { err = e; cgBackoff(e); } }
  if (!coins) { try { coins = await fromBinance(); source = 'Binance (fallback)'; if (err) toast(err.status === 429 ? 'CoinGecko rate limit hit — using Binance data' : 'CoinGecko unavailable — using Binance data'); } catch (e2) { err = err || e2; } }
  if (!coins) {
    if (cache) { Object.assign(state, cache, { stale: true }); toast('Offline or rate-limited — showing cached data from ' + timeAgo(cache.ts)); return; }
    throw err || new Error('No data');
  }
  coins = coins.map(enrich);
  const snap = { coins, ts: Date.now(), source };
  ls.set('markets', snap);
  Object.assign(state, snap, { stale: false });
}
async function loadHistory(coin) {
  const key = 'hist:' + coin.id; const c = ls.get(key);
  if (c && Date.now() - c.ts < HIST_TTL) return c;
  let pts, source, err;
  if (!coin.binance && !cgBlocked()) {
    try { const d = await getJSON(`${CG}/coins/${encodeURIComponent(coin.id)}/market_chart?vs_currency=usd&days=90&interval=daily`);
      pts = d.prices.map(([t, p]) => [t, p]); // last point is "now"
      source = 'CoinGecko'; } catch (e) { err = e; cgBackoff(e); }
  }
  if (!pts) {
    try { const k = await binance(`/klines?symbol=${coin.symbol.toUpperCase()}USDT&interval=1d&limit=90`); pts = k.map(x => [x[0], +x[4]]); source = 'Binance'; }
    catch (e) { err = err || e; }
  }
  if (!pts) { if (c) return { ...c, stale: true }; throw err || new Error('No history'); }
  // dedupe same-day points (CoinGecko returns an extra "now" point)
  const out = []; for (const p of pts) { if (out.length && Math.abs(p[0] - out[out.length - 1][0]) < 3600e3 * 6) out[out.length - 1] = p; else out.push(p); }
  const v = { ts: Date.now(), pts: out, source }; ls.set(key, v); return v;
}

// ---------- rendering: shared ----------
const STAR = '<svg viewBox="0 0 24 24"><path d="M12 3l2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9z"/></svg>';
function avatar(c) { const l = esc((c.symbol || '?').slice(0, 3).toUpperCase()); return c.image ? `<div class="av"><img src="${esc(c.image)}" alt="" loading="lazy" onerror="this.parentNode.textContent='${l}'"></div>` : `<div class="av">${l}</div>`; }
const badge = s => s ? `<span class="badge b-${s.code}">${s.label}</span>` : '<span class="badge b-H">N/A</span>';
const barColor = s => !s ? 'transparent' : ({ SB: 'var(--sb)', B: 'var(--b)', H: 'transparent', S: 'var(--s)', SS: 'var(--ss)' })[s.code];
function sparkSVG(a, w = 64, h = 24) {
  if (!a || a.length < 2) return ''; const step = Math.max(1, Math.floor(a.length / 48)); const pts = a.filter((_, i) => i % step === 0 || i === a.length - 1);
  const mn = Math.min(...pts), mx = Math.max(...pts), rg = mx - mn || 1; const col = pts[pts.length - 1] >= pts[0] ? '#2ee6a0' : '#ff5470';
  const d = pts.map((v, i) => `${(i / (pts.length - 1) * w).toFixed(1)},${(h - 2 - (v - mn) / rg * (h - 4)).toFixed(1)}`).join(' ');
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><polyline points="${d}" fill="none" stroke="${col}" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
}
function rowHTML(c) {
  const s = c.sig;
  return `<a class="row" href="#/coin/${encodeURIComponent(c.id)}" data-id="${esc(c.id)}"><span class="bar" style="background:${barColor(s)}"></span>
    ${avatar(c)}
    <div class="nm"><div class="t"><span class="nmx">${esc(c.name)}</span><span class="sym">${esc(c.symbol)}</span>${c.rank ? `<span class="rk">#${c.rank}</span>` : ''}</div>
      <div class="r">${s ? esc(s.reason) : 'Not enough data'}</div></div>
    <div class="rt"><div style="display:flex;gap:8px;align-items:center">${sparkSVG(c.spark)}<span class="px">${fmtPrice(c.price)}</span></div>
      <div style="display:flex;gap:6px;align-items:center"><span class="chg ${pctCls(c.ch24)}">${fmtPct(c.ch24)}</span>${badge(s)}</div></div></a>`;
}
const DISCLAIMER = `<div class="disclaimer"><b>Not financial advice.</b> Signals are automated technical indicators (RSI, moving averages, MACD, momentum) computed from past prices. They can be wrong, especially in volatile markets. Memecoins are extremely volatile. Do your own research and never invest more than you can afford to lose.</div>`;
function metaHTML() {
  return `<div class="meta"><span class="live"><span class="dot ${state.stale ? 'stale' : ''}"></span>${state.ts ? 'Updated ' + timeAgo(state.ts) : 'Loading…'} · ${esc(state.source || '')}</span>
    <button class="chip" id="sortBtn" style="padding:4px 10px;font-size:12px">Sort: ${({ score: 'Signal', rank: 'Market cap', ch24: '24h %' })[state.sort]}</button></div>`;
}
function sorted(list) {
  const l = [...list];
  if (state.sort === 'score') l.sort((a, b) => (b.sig ? b.sig.score : -999) - (a.sig ? a.sig.score : -999));
  else if (state.sort === 'rank') l.sort((a, b) => (a.rank || 999) - (b.rank || 999));
  else l.sort((a, b) => (b.ch24 || 0) - (a.ch24 || 0));
  return l;
}
function skeleton(n = 8) { return '<div class="list">' + Array.from({ length: n }, () => '<div class="skel"></div>').join('') + '</div>'; }
function bindSort() { const b = $('#sortBtn'); if (b) b.onclick = () => { state.sort = ({ score: 'rank', rank: 'ch24', ch24: 'score' })[state.sort]; ls.set('sort', state.sort); render(); }; }

// ---------- screens ----------
function renderHome() {
  if (!state.coins.length) { app.innerHTML = skeleton(); return; }
  const all = state.coins;
  const buys = all.filter(c => c.sig && (c.sig.code === 'SB' || c.sig.code === 'B'));
  const sells = all.filter(c => c.sig && (c.sig.code === 'SS' || c.sig.code === 'S'));
  const avg = all.reduce((s, c) => s + (c.ch24 || 0), 0) / all.length;
  let list = state.filter === 'buy' ? buys : state.filter === 'sell' ? sells : all;
  const q = state.q.trim().toLowerCase();
  if (q) list = list.filter(c => c.name.toLowerCase().includes(q) || c.symbol.toLowerCase().includes(q));
  list = sorted(list);
  const focused = document.activeElement && document.activeElement.id === 'q';
  app.innerHTML = `
    <div class="summary">
      <div class="stat"><small>Buy signals</small><b class="up">${buys.length}</b></div>
      <div class="stat"><small>Sell signals</small><b class="dn">${sells.length}</b></div>
      <div class="stat"><small>Avg 24h</small><b class="${pctCls(avg)}">${fmtPct(avg)}</b></div>
    </div>
    <label class="search"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>
      <input id="q" type="search" placeholder="Search coins" value="${esc(state.q)}" autocomplete="off" enterkeyhint="search"></label>
    <div class="chips">
      ${[['all', 'All', all.length], ['buy', 'Buy signals', buys.length], ['sell', 'Sell signals', sells.length]].map(([k, l, n]) => `<button class="chip ${state.filter === k ? 'on' : ''}" data-f="${k}">${l}<span class="n">${n}</span></button>`).join('')}
    </div>
    ${metaHTML()}
    <div class="list">${list.map(rowHTML).join('') || '<div class="empty">No coins match.</div>'}</div>
    ${DISCLAIMER}`;
  const qi = $('#q'); qi.oninput = e => { state.q = e.target.value; renderHome(); };
  if (focused) { qi.focus(); qi.setSelectionRange(qi.value.length, qi.value.length); }
  app.querySelectorAll('[data-f]').forEach(b => b.onclick = () => { state.filter = b.dataset.f; renderHome(); });
  bindSort();
}
function renderWatch() {
  const f = favs();
  if (!state.coins.length) { app.innerHTML = skeleton(4); return; }
  const list = f.map(id => state.coins.find(c => c.id === id)).filter(Boolean);
  app.innerHTML = `<h2 style="margin:4px 2px 10px;font-size:20px">Watchlist</h2>
    ${list.length ? metaHTML() + '<div class="list">' + sorted(list).map(rowHTML).join('') + '</div>' :
      `<div class="empty"><div style="font-size:40px;margin-bottom:8px">⭐</div>No favorites yet.<br>Open any coin and tap the star to add it here.</div>`}
    ${f.length > list.length ? `<div class="note">${f.length - list.length} saved coin(s) are outside the current top list.</div>` : ''}
    ${DISCLAIMER}`;
  bindSort();
}
function renderAbout() {
  app.innerHTML = `<div class="about">
    <h2>How the signals work</h2>
    <p>Each memecoin gets a score from −100 to +100, recalculated from live prices every time data refreshes. The list uses the last 7 days of hourly prices (short-term). The coin screen also shows a 90-day daily (swing) view.</p>
    <div class="card"><ul class="factors">
      <li><span><b>RSI(14)</b>: below 30 oversold, above 70 overbought</span><span class="pts">±2</span></li>
      <li><span><b>SMA20 vs SMA50</b>: trend direction + fresh crossovers</span><span class="pts">±2</span></li>
      <li><span><b>Price vs SMA20</b></span><span class="pts">±0.5</span></li>
      <li><span><b>MACD(12,26,9)</b>: histogram sign, slope, fresh cross</span><span class="pts">±2</span></li>
      <li><span><b>Momentum</b>: % change over the window</span><span class="pts">±1.5</span></li>
    </ul></div>
    <p>Score ≥ 45 <span class="badge b-SB">STRONG BUY</span> · ≥ 15 <span class="badge b-B">BUY</span> · −15…15 <span class="badge b-H">HOLD</span> · ≤ −15 <span class="badge b-S">SELL</span> · ≤ −45 <span class="badge b-SS">STRONG SELL</span></p>
    <p><b>Entry / stop / target</b>: based on recent swing low/high and an ATR-style volatility estimate (average daily move). Buy setups use a 2:1 reward-to-risk target.</p>
    <p><b>Data</b>: CoinGecko public API (live, updated every 3 minutes), with Binance public market data as a backup. Data is cached on your phone so the app still opens offline.</p>
    <p><b>Install</b>: Android Chrome → menu ⋮ → <i>Install app</i>. iPhone Safari → Share → <i>Add to Home Screen</i>.</p>
    ${DISCLAIMER}</div>`;
}

// ---------- detail ----------
async function renderDetail(id) {
  let coin = state.coins.find(c => c.id === id);
  if (!coin) { app.innerHTML = skeleton(3); return; }
  const tf = state.tf;
  const draw = (hist) => {
    let closes, times, bpd;
    if (tf === '7d') { closes = coin.spark; bpd = 24; const step = 7 * 864e5 / (closes.length - 1); times = closes.map((_, i) => Date.now() - (closes.length - 1 - i) * step); }
    else { closes = hist.pts.map(p => p[1]); times = hist.pts.map(p => p[0]); bpd = 1; }
    const sig = analyze(closes, bpd);
    const swing = hist ? analyze(hist.pts.map(p => p[1]), 1) : null;
    const short = analyze(coin.spark, 24);
    const fav = isFav(coin.id);
    $('#title').innerHTML = `<span class="logo"></span>${esc(coin.symbol.toUpperCase())}`;
    app.innerHTML = `
      <div class="dhead">${avatar(coin)}<div><h1>${esc(coin.name)}</h1><div class="sub">${esc(coin.symbol.toUpperCase())}${coin.rank ? ' · Rank #' + coin.rank : ''}</div></div>
        <button class="star ${fav ? 'on' : ''}" id="favBtn" aria-label="Add to watchlist">${STAR}</button></div>
      <div class="pxline"><span class="bigpx">${fmtPrice(coin.price)}</span><span class="chg ${pctCls(coin.ch24)}" style="font-size:14px">${fmtPct(coin.ch24)} 24h</span><span class="chg ${pctCls(coin.ch7d)}" style="font-size:14px">${fmtPct(coin.ch7d)} 7d</span></div>
      <div class="tf">
        <div class="card"><small>Short-term (1h)</small><div style="margin-top:6px">${badge(short)}</div><div class="note" style="margin-top:6px">Score ${short ? short.score : '—'}</div></div>
        <div class="card"><small>Swing (1D, 90d)</small><div style="margin-top:6px">${hist ? badge(swing) : '<span class="badge b-H">loading…</span>'}</div><div class="note" style="margin-top:6px">Score ${swing ? swing.score : '—'}</div></div>
      </div>
      <div class="card"><h3>Price chart <div class="seg"><button data-tf="7d" class="${tf === '7d' ? 'on' : ''}">7D · 1h</button><button data-tf="90d" class="${tf === '90d' ? 'on' : ''}">90D · 1D</button></div></h3>
        <div class="chartwrap"><canvas class="chart" id="chart"></canvas><div class="tip" id="tip" hidden></div></div>
        <div class="legend"><span><i style="background:#e8edf7"></i>Price</span><span><i style="background:#ffc24b"></i>SMA20</span><span><i style="background:#a78bfa"></i>SMA50</span><span><i style="background:#5aa9ff"></i>Entry</span><span><i style="background:#ff5470"></i>Stop</span><span><i style="background:#2ee6a0"></i>Target</span></div>
      </div>
      ${sig ? signalCard(sig, tf) : '<div class="card">Not enough history to compute signals.</div>'}
      ${DISCLAIMER}
      <div class="note">Data: ${esc(tf === '7d' ? state.source : (hist && hist.source) || '')} · ${tf === '7d' ? 'updated ' + timeAgo(state.ts) : hist ? 'updated ' + timeAgo(hist.ts) : ''}${coin.mcap ? ' · Mkt cap ' + fmtBig(coin.mcap) : ''}${coin.vol ? ' · Vol 24h ' + fmtBig(coin.vol) : ''}</div>`;
    $('#favBtn').onclick = e => { const on = toggleFav(coin.id); e.currentTarget.classList.toggle('on', on); toast(on ? 'Added to watchlist' : 'Removed from watchlist', 1500); };
    app.querySelectorAll('[data-tf]').forEach(b => b.onclick = () => { state.tf = b.dataset.tf; renderDetail(id); });
    if (sig) drawChart($('#chart'), times, closes, sig, tf);
  };
  if (tf === '7d') {
    draw(ls.get('hist:' + id) && Date.now() - ls.get('hist:' + id).ts < HIST_TTL ? ls.get('hist:' + id) : null);
    loadHistory(coin).then(h => { if (location.hash === '#/coin/' + encodeURIComponent(id) && state.tf === '7d') draw(h); }).catch(() => {});
  } else {
    const cached = ls.get('hist:' + id);
    if (cached) draw(cached); else app.innerHTML = skeleton(3);
    try { const h = await loadHistory(coin); if (location.hash === '#/coin/' + encodeURIComponent(id) && state.tf === '90d') draw(h); }
    catch (e) { toast(e.status === 429 ? 'Rate limited — try again in a minute' : 'Could not load 90-day history'); if (!cached) { state.tf = '7d'; renderDetail(id); } }
  }
}
function gaugeSVG(score, code) {
  const col = ({ SB: '#00d68f', B: '#2ee6a0', H: '#8b97b3', S: '#ff7a8a', SS: '#ff3b5c' })[code];
  const a = (score + 100) / 200; const R = 34, C = Math.PI * R;
  return `<svg class="gauge" viewBox="0 0 84 84"><path d="M8 52 A34 34 0 0 1 76 52" stroke="#24304d" stroke-width="8" fill="none" stroke-linecap="round"/>
    <path d="M8 52 A34 34 0 0 1 76 52" stroke="${col}" stroke-width="8" fill="none" stroke-linecap="round" stroke-dasharray="${(a * C).toFixed(1)} ${C.toFixed(1)}"/>
    <text x="42" y="50" text-anchor="middle" fill="#e8edf7" font-size="19" font-weight="800" style="stroke:none">${score > 0 ? '+' : ''}${score}</text>
    <text x="42" y="66" text-anchor="middle" fill="#8b97b3" font-size="9" font-weight="700" style="stroke:none">SCORE</text></svg>`;
}
function signalCard(s, tf) {
  const col = ({ SB: '#3dfcb4', B: '#2ee6a0', H: '#b7c1d9', S: '#ff7a8a', SS: '#ff6b84' })[s.code];
  const L = s.levels;
  const titles = L.mode === 'long' ? ['Entry zone', 'Stop-loss', 'Take-profit'] : L.mode === 'dip' ? ['Buy-the-dip zone', 'Stop-loss', 'Take-profit'] : ['Re-entry (support)', 'Stop if holding', 'Resistance'];
  const note = L.mode === 'long' ? `Reward/risk ≈ ${L.rr.toFixed(1)} : 1. Stop sits below the recent swing low / volatility band.` :
    L.mode === 'dip' ? 'No clear edge right now — consider waiting for a pullback into the zone.' :
    'Bearish setup: avoid new buys for now. If you hold, consider protecting gains; watch support for a possible re-entry.';
  const fx = s.factors.map(f => `<li><span>${esc(f.txt.charAt(0).toUpperCase() + f.txt.slice(1))}</span><span class="pts ${f.pts > 0 ? 'up' : f.pts < 0 ? 'dn' : ''}">${f.pts > 0 ? '+' : ''}${f.pts}</span></li>`).join('');
  return `<div class="card"><h3>Signal · ${tf === '7d' ? 'short-term' : 'swing'}</h3>
      <div class="sig">${gaugeSVG(s.score, s.code)}<div><div class="lbl" style="color:${col}">${s.label}</div><div class="why">${esc(s.reason)}</div></div></div>
      <div class="levels">
        <div class="lv e"><small>${titles[0]}</small><b>${fmtPrice(L.entry[0])}<br>– ${fmtPrice(L.entry[1])}</b></div>
        <div class="lv s"><small>${titles[1]}</small><b>${fmtPrice(L.stop)}</b><br><small>${fmtPct((L.stop / L.entry[1] - 1) * 100)}</small></div>
        <div class="lv t"><small>${titles[2]}</small><b>${fmtPrice(L.tp)}</b><br><small>${fmtPct((L.tp / L.entry[1] - 1) * 100)}</small></div>
      </div><div class="note">${note}</div></div>
    <div class="card"><h3>Indicators</h3><div class="ind">
      <div class="lv"><small>RSI (14)</small><b class="${s.rsi < 30 ? 'up' : s.rsi > 70 ? 'dn' : ''}">${s.rsi.toFixed(1)}</b></div>
      <div class="lv"><small>MACD hist</small><b class="${pctCls(s.hist)}">${s.hist >= 0 ? '+' : ''}${(s.hist / s.sma20 * 100).toFixed(3)}%</b></div>
      <div class="lv"><small>SMA 20</small><b>${fmtPrice(s.sma20)}</b></div>
      <div class="lv"><small>SMA 50</small><b>${fmtPrice(s.sma50)}</b></div>
      <div class="lv"><small>Momentum</small><b class="${pctCls(s.roc)}">${fmtPct(s.roc)}</b></div>
      <div class="lv"><small>Volatility (ATR/day)</small><b>${s.atrPct.toFixed(2)}%</b></div>
    </div></div>
    <div class="card"><h3>Score breakdown</h3><ul class="factors">${fx}</ul></div>`;
}

// ---------- chart (canvas) ----------
function drawChart(cv, times, closes, sig, tf) {
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const W = cv.clientWidth || 360, H = 330;
  cv.style.height = H + 'px'; cv.width = W * dpr; cv.height = H * dpr;
  const g = cv.getContext('2d'); g.scale(dpr, dpr);
  const pad = { l: 6, r: 58 }; const pTop = 8, pH = 190, rTop = pTop + pH + 14, rH = 52, mTop = rTop + rH + 12, mH = 48;
  const n = closes.length, x = i => pad.l + i / (n - 1) * (W - pad.l - pad.r);
  const { r, s20, s50, m } = sig.series; const L = sig.levels;
  const vals = closes.concat(s20.filter(v => v != null), s50.filter(v => v != null), [L.stop, L.tp, L.entry[0]]);
  let mn = Math.min(...vals), mx = Math.max(...vals); const span = mx - mn || mx * 0.01; mn -= span * 0.04; mx += span * 0.04;
  const y = v => pTop + (1 - (v - mn) / (mx - mn)) * pH;
  g.font = '10px -apple-system,system-ui,sans-serif'; g.textBaseline = 'middle';
  // grid
  g.strokeStyle = 'rgba(36,48,77,.7)'; g.lineWidth = 1; g.fillStyle = '#8b97b3';
  for (let k = 0; k <= 4; k++) { const v = mn + (mx - mn) * k / 4, yy = y(v); g.beginPath(); g.moveTo(pad.l, yy); g.lineTo(W - pad.r, yy); g.stroke(); g.fillText(fmtPrice(v).replace('$', ''), W - pad.r + 6, yy); }
  // entry zone band
  g.fillStyle = 'rgba(90,169,255,.12)'; g.fillRect(pad.l, y(L.entry[1]), W - pad.l - pad.r, y(L.entry[0]) - y(L.entry[1]));
  const hline = (v, c) => { g.save(); g.setLineDash([4, 4]); g.strokeStyle = c; g.lineWidth = 1.2; g.beginPath(); g.moveTo(pad.l, y(v)); g.lineTo(W - pad.r, y(v)); g.stroke(); g.restore();
    g.fillStyle = c; g.beginPath(); g.roundRect ? g.roundRect(W - pad.r + 2, y(v) - 8, pad.r - 3, 16, 4) : g.rect(W - pad.r + 2, y(v) - 8, pad.r - 3, 16); g.fill(); g.fillStyle = '#0b0f1a'; g.font = 'bold 9.5px -apple-system,system-ui,sans-serif'; g.fillText(fmtPrice(v).replace('$', ''), W - pad.r + 5, y(v)); g.font = '10px -apple-system,system-ui,sans-serif'; };
  // area under price
  const upc = closes[n - 1] >= closes[0];
  const grad = g.createLinearGradient(0, pTop, 0, pTop + pH); grad.addColorStop(0, upc ? 'rgba(46,230,160,.28)' : 'rgba(255,84,112,.25)'); grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.beginPath(); closes.forEach((v, i) => i ? g.lineTo(x(i), y(v)) : g.moveTo(x(i), y(v))); g.lineTo(x(n - 1), pTop + pH); g.lineTo(x(0), pTop + pH); g.closePath(); g.fillStyle = grad; g.fill();
  const line = (arr, c, w) => { g.beginPath(); let st = false; arr.forEach((v, i) => { if (v == null) return; st ? g.lineTo(x(i), y(v)) : (g.moveTo(x(i), y(v)), st = true); }); g.strokeStyle = c; g.lineWidth = w; g.stroke(); };
  line(s50, '#a78bfa', 1.3); line(s20, '#ffc24b', 1.3); line(closes, upc ? '#2ee6a0' : '#ff5470', 2);
  hline(L.stop, '#ff5470'); hline(L.tp, '#2ee6a0'); hline(L.entry[1], '#5aa9ff');
  // last price dot
  g.fillStyle = '#e8edf7'; g.beginPath(); g.arc(x(n - 1), y(closes[n - 1]), 3.5, 0, 7); g.fill();
  // RSI panel
  const ry = v => rTop + (1 - v / 100) * rH;
  g.fillStyle = 'rgba(167,139,250,.08)'; g.fillRect(pad.l, ry(70), W - pad.l - pad.r, ry(30) - ry(70));
  g.strokeStyle = 'rgba(36,48,77,.9)'; [30, 70].forEach(v => { g.beginPath(); g.moveTo(pad.l, ry(v)); g.lineTo(W - pad.r, ry(v)); g.stroke(); });
  g.fillStyle = '#8b97b3'; g.fillText('RSI ' + sig.rsi.toFixed(0), W - pad.r + 6, rTop + rH / 2); g.fillText('70', W - pad.r + 6, ry(70)); g.fillText('30', W - pad.r + 6, ry(30));
  g.beginPath(); let st = false; r.forEach((v, i) => { if (v == null) return; st ? g.lineTo(x(i), ry(v)) : (g.moveTo(x(i), ry(v)), st = true); }); g.strokeStyle = '#a78bfa'; g.lineWidth = 1.4; g.stroke();
  // MACD panel
  const hs = m.hist.filter(v => v != null), ml = m.macd.filter(v => v != null); const am = Math.max(...hs.map(Math.abs), ...ml.map(Math.abs)) || 1;
  const my = v => mTop + mH / 2 - v / am * mH / 2; const bw = Math.max(1, (W - pad.l - pad.r) / n * 0.7);
  m.hist.forEach((v, i) => { if (v == null) return; g.fillStyle = v >= 0 ? 'rgba(46,230,160,.65)' : 'rgba(255,84,112,.65)'; g.fillRect(x(i) - bw / 2, Math.min(my(0), my(v)), bw, Math.abs(my(v) - my(0)) || 1); });
  const mline = (arr, c) => { g.beginPath(); let s = false; arr.forEach((v, i) => { if (v == null) return; s ? g.lineTo(x(i), my(v)) : (g.moveTo(x(i), my(v)), s = true); }); g.strokeStyle = c; g.lineWidth = 1.2; g.stroke(); };
  mline(m.macd, '#5aa9ff'); mline(m.signal, '#ffc24b');
  g.fillStyle = '#8b97b3'; g.fillText('MACD', W - pad.r + 6, mTop + mH / 2);
  // crosshair interaction
  const tip = $('#tip'); const snapshot = g.getImageData(0, 0, cv.width, cv.height);
  const move = ev => {
    const rect = cv.getBoundingClientRect(); const px = (ev.touches ? ev.touches[0].clientX : ev.clientX) - rect.left;
    const i = clamp(Math.round((px - pad.l) / (W - pad.l - pad.r) * (n - 1)), 0, n - 1);
    g.putImageData(snapshot, 0, 0); g.save(); g.strokeStyle = 'rgba(232,237,247,.4)'; g.setLineDash([3, 3]); g.beginPath(); g.moveTo(x(i), pTop); g.lineTo(x(i), mTop + mH); g.stroke(); g.restore();
    g.fillStyle = '#fff'; g.beginPath(); g.arc(x(i), y(closes[i]), 3.5, 0, 7); g.fill();
    const d = new Date(times[i]);
    tip.hidden = false; tip.style.left = clamp(x(i), 70, W - 70) + 'px';
    tip.innerHTML = `<b>${fmtPrice(closes[i])}</b> · ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}${tf === '7d' ? ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : ''}${r[i] != null ? ' · RSI ' + r[i].toFixed(0) : ''}`;
  };
  const end = () => { tip.hidden = true; g.putImageData(snapshot, 0, 0); };
  cv.onmousemove = move; cv.onmouseleave = end; cv.ontouchstart = move; cv.ontouchmove = move; cv.ontouchend = end;
}

// ---------- router ----------
function route() { const h = location.hash || '#/'; if (h.startsWith('#/coin/')) return { name: 'coin', id: decodeURIComponent(h.slice(7)) }; if (h === '#/watch') return { name: 'watch' }; if (h === '#/about') return { name: 'about' }; return { name: 'home' }; }
let lastRoute = '';
function render() {
  const r = route();
  document.querySelectorAll('.tabbar a').forEach(a => a.classList.toggle('on', a.dataset.tab === (r.name === 'coin' ? '' : r.name)));
  $('#backBtn').hidden = r.name !== 'coin';
  if (r.name !== 'coin') $('#title').innerHTML = '<span class="logo"></span>Memecoin Signals';
  const key = r.name + (r.id || '');
  if (key !== lastRoute) { window.scrollTo(0, 0); if (r.name === 'coin' && !lastRoute.startsWith('coin')) state.tf = '7d'; lastRoute = key; }
  if (r.name === 'coin') renderDetail(r.id); else if (r.name === 'watch') renderWatch(); else if (r.name === 'about') renderAbout(); else renderHome();
}
window.addEventListener('hashchange', render);
$('#backBtn').onclick = () => { if (history.length > 1) history.back(); else location.hash = '#/'; };

// ---------- refresh ----------
async function refresh(force = true) {
  if (state.loading) return; state.loading = true; $('#refreshBtn').classList.add('spin');
  try { await loadMarkets(force); render(); }
  catch (e) { console.warn('refresh failed', e); if (!state.coins.length) app.innerHTML = `<div class="empty">Couldn't load market data.<br><small>${esc(e.message)}</small><br><br><button class="chip on" onclick="refresh()">Try again</button></div>`; else toast('Refresh failed — showing previous data'); }
  finally { state.loading = false; $('#refreshBtn').classList.remove('spin'); }
}
window.refresh = refresh;
$('#refreshBtn').onclick = () => refresh(true);
setInterval(() => { if (document.visibilityState === 'visible') refresh(true); }, AUTO_REFRESH);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && Date.now() - state.ts > AUTO_REFRESH) refresh(true); });
setInterval(() => { const m = document.querySelector('.meta .live'); if (m && state.ts) m.lastChild.textContent = 'Updated ' + timeAgo(state.ts) + ' · ' + state.source; }, 15000);
window.addEventListener('online', () => refresh(true));

// pull-to-refresh
(() => { let y0 = null, dy = 0; const ptr = $('#ptr');
  addEventListener('touchstart', e => { y0 = window.scrollY <= 0 && !e.target.closest('canvas') ? e.touches[0].clientY : null; dy = 0; }, { passive: true });
  addEventListener('touchmove', e => { if (y0 == null) return; dy = e.touches[0].clientY - y0; if (dy > 0) ptr.style.height = Math.min(dy * 0.5, 60) + 'px'; }, { passive: true });
  addEventListener('touchend', () => { if (y0 == null) return; if (dy > 90) { ptr.style.height = '48px'; refresh(true).finally(() => ptr.style.height = '0'); } else ptr.style.height = '0'; y0 = null; });
})();

// install prompt
(() => { let deferred; const bar = $('#installBar');
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  if (standalone || ls.get('installDismissed')) return;
  addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferred = e; bar.hidden = false; });
  $('#installBtn').onclick = async () => { if (deferred) { deferred.prompt(); await deferred.userChoice; deferred = null; bar.hidden = true; } else toast('Tap Share, then "Add to Home Screen"', 5000); };
  $('#installClose').onclick = () => { bar.hidden = true; ls.set('installDismissed', true); };
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) && !/crios|fxios/i.test(navigator.userAgent);
  if (ios) setTimeout(() => { bar.querySelector('span').textContent = 'Install: tap Share ⬆︎ then "Add to Home Screen"'; $('#installBtn').hidden = true; bar.hidden = false; }, 2500);
})();

// ---------- boot ----------
state.sort = ls.get('sort', 'score');
const cached = ls.get('markets'); if (cached) Object.assign(state, cached, { stale: true });
render();
refresh(false);
if ('serviceWorker' in navigator) addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(e => console.warn('SW', e)));
