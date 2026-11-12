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
function fmtBig(n) { if (n == null || !isFinite(n) || n === 0) return '—'; const sign = n < 0 ? '-' : ''; const a = Math.abs(n); const u = [[1e12,'T'],[1e9,'B'],[1e6,'M'],[1e3,'K']]; for (const [v, s] of u) if (a >= v) return sign + '$' + (a / v).toFixed(2) + s; return sign + '$' + a.toFixed(0); }
function fmtMcVal(n) {
  if (n == null || !isFinite(n)) return '—';
  const sign = n < 0 ? '-' : ''; const a = Math.abs(n);
  const u = [[1e12,'T'],[1e9,'B'],[1e6,'M'],[1e3,'K']];
  for (const [v, s] of u) if (a >= v) return sign + '$' + (a / v).toFixed(a >= 10 * v ? 1 : 2) + s;
  return sign + '$' + a.toFixed(a >= 100 ? 0 : 2);
}
const pairMc = p => { const n = p && (p.marketCap || p.fdv); return n && isFinite(n) ? +n : null; };
const coinMc = c => c && c.mcap && isFinite(c.mcap) ? +c.mcap : null;
const mcFactor = (mc, px) => (mc && px && isFinite(mc) && isFinite(px)) ? mc / px : null;
const fmtPrimaryMc = (mc, px) => mc ? fmtBig(mc) : fmtPrice(px);
const pxSub = px => `<span class="pxsub">${fmtPrice(px)}</span>`;
function levelMcHTML(px, fac) {
  if (px == null || !isFinite(px)) return '<b>—</b>';
  if (fac) return `<b>${fmtBig(px * fac)}</b><br><small class="pxsub">${fmtPrice(px)}</small>`;
  return `<b>${fmtPrice(px)}</b>`;
}
function levelMcRangeHTML(a, b, fac) {
  if (fac) return `<b>${fmtBig(a * fac)}–${fmtBig(b * fac)}</b><br><small class="pxsub">${fmtPrice(a)}–${fmtPrice(b)}</small>`;
  return `<b>${fmtPrice(a)}<br>– ${fmtPrice(b)}</b>`;
}
function planLineHTML(L, fac) {
  if (fac) return `<span>Entry MC <b class="e">${fmtBig(L.entry[0] * fac)}–${fmtBig(L.entry[1] * fac)}</b></span><span>Stop <b class="dn">${fmtBig(L.stop * fac)}</b></span><span>Target <b class="up">${fmtBig(L.tp * fac)}</b></span><span class="hold">⏱ ${esc(L.hold)}</span>`;
  return `<span>Entry <b class="e">${fmtPrice(L.entry[1])}</b></span><span>Stop <b class="dn">${fmtPrice(L.stop)}</b></span><span>Target <b class="up">${fmtPrice(L.tp)}</b></span><span class="hold">⏱ ${esc(L.hold)}</span>`;
}
function dsChartUrl(chain, pairAddress, url) {
  const base = url || (`https://dexscreener.com/${chain}/${pairAddress}`);
  return base + (base.includes('?') ? '&' : '?') + 'chartType=marketCap';
}
function timeAgo(ts) { const s = Math.round((Date.now() - ts) / 1000); if (s < 10) return 'just now'; if (s < 60) return s + 's ago'; if (s < 3600) return Math.round(s / 60) + ' min ago'; if (s < 172800) return Math.round(s / 3600) + ' h ago'; return Math.round(s / 86400) + ' d ago'; }
function toast(msg, ms = 3200) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(() => t.hidden = true, ms); }
class HttpError extends Error { constructor(status, url) { super('HTTP ' + status); this.status = status; this.url = url; } }
const fetchBackoff = {};
/* v11 network layer: per-host pacing, honest per-source health, TypeError-as-probable-429 backoff.
 * GeckoTerminal and DexScreener answer rate limits / Cloudflare challenges without CORS headers, so the browser
 * reports them as a TypeError ("Load failed" on iOS) that looks exactly like being offline. */
const HOST_GAP = { 'api.geckoterminal.com': 2500, 'api.dexscreener.com': 300 };
const HOST_NAME = { 'api.geckoterminal.com': 'GeckoTerminal', 'api.dexscreener.com': 'DexScreener', 'api.rugcheck.xyz': 'RugCheck', 'api.coingecko.com': 'CoinGecko' };
const hostGate = {};   // host -> { last, chain }
const srcHealth = {};  // host -> { ok, fail, kind, streak }
window.srcHealth = srcHealth;
function noteSrc(host, ok, kind) {
  if (!host) return; const h = srcHealth[host] || (srcHealth[host] = { ok: 0, fail: 0, kind: '', streak: 0 });
  if (ok) { h.ok = Date.now(); h.streak = 0; h.kind = ''; } else { h.fail = Date.now(); h.kind = kind; h.streak++; }
}
/** 'ok' | 'limited' | 'down' | 'unknown' for a host, looking at the last few minutes. */
function srcState(host) {
  const h = srcHealth[host]; if (!h) return 'unknown';
  if (h.fail > h.ok && Date.now() - h.fail < 5 * 60e3) return h.kind === 'http' ? 'down' : 'limited';
  return h.ok ? 'ok' : 'unknown';
}
window.srcState = srcState;
/** One-line, honest summary of the DEX data sources. Returns '' when everything is fine. */
function srcSummary() {
  if (navigator.onLine === false) return 'You are offline';
  const gt = srcState('api.geckoterminal.com'), ds = srcState('api.dexscreener.com');
  const bad = s => s === 'limited' || s === 'down';
  if (bad(gt) && bad(ds)) return 'GeckoTerminal and DexScreener are rate-limiting this network';
  if (bad(gt)) return 'GeckoTerminal limited — using DexScreener';
  if (bad(ds)) return 'DexScreener limited — using GeckoTerminal';
  return '';
}
window.srcSummary = srcSummary;
async function hostWait(host, critical) {
  const gap = HOST_GAP[host]; if (!gap) return;
  const g = hostGate[host] || (hostGate[host] = { last: 0, chain: Promise.resolve() });
  if (critical) { g.last = Math.max(g.last, Date.now()); return; }
  const turn = g.chain.then(async () => { const w = g.last + gap - Date.now(); if (w > 0) await new Promise(r => setTimeout(r, w)); g.last = Date.now(); });
  g.chain = turn.catch(() => {});
  await turn;
}
function setBackoff(host, ms) { if (host) fetchBackoff[host] = Math.max(fetchBackoff[host] || 0, Date.now() + ms); }
async function getJSON(url, timeout = 12000, opts) {
  const critical = !!(opts && opts.critical);
  const host = (() => { try { return new URL(url, location.href).host; } catch { return ''; } })();
  if (host && fetchBackoff[host] && Date.now() < fetchBackoff[host] && !critical) { const e = new HttpError(429, url); e.backoff = true; throw e; }
  await hostWait(host, critical);
  if (host && fetchBackoff[host] && Date.now() < fetchBackoff[host] && !critical) { const e = new HttpError(429, url); e.backoff = true; throw e; }
  const ctl = new AbortController(); const id = setTimeout(() => ctl.abort(), timeout);
  try {
    let r;
    try { r = await fetch(url, { signal: ctl.signal }); }
    catch (e) {
      // Network-level failure. If the device is online, GT/DS failures are almost always a 429 / Cloudflare block
      // stripped of CORS headers — back off that host instead of hammering it and calling it "offline".
      const aborted = e && e.name === 'AbortError';
      const paced = !!HOST_GAP[host];
      if (navigator.onLine !== false && host && !critical) {
        const h = srcHealth[host]; const n = ((h && h.streak) || 0) + 1;
        const base = host === 'api.geckoterminal.com' ? 30000 : paced ? 15000 : 8000;
        setBackoff(host, Math.min(paced ? 90000 : 30000, base * Math.pow(1.6, n - 1)));
      }
      noteSrc(host, false, navigator.onLine === false ? 'offline' : aborted ? 'timeout' : 'blocked');
      const ne = new HttpError(0, url); ne.net = true; ne.message = aborted ? 'timeout' : 'network/blocked'; throw ne;
    }
    if (r.status === 429) {
      const ra = parseInt(r.headers.get('retry-after'), 10);
      const fallback = critical ? 2500 : (host === 'api.geckoterminal.com' ? 30000 : 12000);
      const ms = Math.min(critical ? 4000 : 90000, Math.max(critical ? 1500 : 8000, (isFinite(ra) && ra > 0 && ra < 1000 ? ra * 1000 : (ra || 0)) || fallback));
      setBackoff(host, ms);
      noteSrc(host, false, 'limited');
      throw new HttpError(429, url);
    }
    if (!r.ok) {
      // 403 (Cloudflare) / 5xx = the source is blocking or struggling; other 4xx just mean "no such item" (source is reachable).
      if (r.status === 403 || r.status >= 500) { noteSrc(host, false, 'limited'); if (!critical) setBackoff(host, 15000); } else noteSrc(host, true);
      throw new HttpError(r.status, url);
    }
    if (host && fetchBackoff[host] && !critical) delete fetchBackoff[host];
    const j = await r.json();
    noteSrc(host, true);
    return j;
  } finally { clearTimeout(id); }
}
/* Shared JSON cache for list endpoints used by both the Fast tab and the bot's Scout: one network call serves both,
 * concurrent callers share the in-flight request, and the last good answer is kept (up to 10 min) as a fallback. */
const jsonCache = new Map(); // url -> { ts, d, p }
const JSON_KEEP = 10 * 60e3;
async function cachedJSON(url, ttl, timeout = 12000) {
  const c = jsonCache.get(url);
  if (c && c.d !== undefined && Date.now() - c.ts < ttl) return c.d;
  if (c && c.p) return c.p;
  const ent = c || {}; jsonCache.set(url, ent);
  ent.p = getJSON(url, timeout).then(d => { ent.ts = Date.now(); ent.d = d; ent.fresh = true; return d; })
    .catch(e => { if (ent.d !== undefined && Date.now() - ent.ts < JSON_KEEP) { ent.fresh = false; return ent.d; } throw e; })
    .finally(() => { ent.p = null; });
  return ent.p;
}
/** Like cachedJSON but tells the caller whether it got fresh data, cached fallback, or nothing. */
async function cachedJSONx(url, ttl, timeout) {
  const before = jsonCache.get(url); const hadFresh = before && before.d !== undefined && Date.now() - before.ts < ttl;
  try { const d = await cachedJSON(url, ttl, timeout); const e = jsonCache.get(url); return { d, ok: true, stale: !hadFresh && e && e.fresh === false, age: e ? Date.now() - e.ts : 0 }; }
  catch (err) { return { d: null, ok: false, err }; }
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
const state = { err: null, coins: [], ts: 0, source: '', stale: false, filter: 'all', q: '', sort: 'score', loading: false, tf: '7d' };
const favs = () => ls.get('favs', []);
const isFav = id => favs().includes(id);
function toggleFav(id) { const f = favs(); const i = f.indexOf(id); i >= 0 ? f.splice(i, 1) : f.unshift(id); ls.set('favs', f); return i < 0; }

function enrich(c) {
  const sig = c.spark && c.spark.length >= 55 ? analyze(c.spark, 24) : null;
  if (sig) delete sig.series; // keep list lean
  const out = { ...c, sig }; out.swing = swingSignal(out); return out;
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
  const mn = Math.min(...pts), mx = Math.max(...pts), rg = mx - mn || 1; const col = pts[pts.length - 1] >= pts[0] ? '#32d074' : '#ff5a52';
  const d = pts.map((v, i) => `${(i / (pts.length - 1) * w).toFixed(1)},${(h - 2 - (v - mn) / rg * (h - 4)).toFixed(1)}`).join(' ');
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><polyline points="${d}" fill="none" stroke="${col}" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
}
function rowHTML(c) {
  const s = c.sig;
  return `<a class="row" href="#/coin/${encodeURIComponent(c.id)}" data-id="${esc(c.id)}"><span class="bar" style="background:${barColor(s)}"></span>
    ${avatar(c)}
    <div class="nm"><div class="t"><span class="nmx">${esc(c.name)}</span><span class="sym">${esc(c.symbol)}</span>${c.rank ? `<span class="rk">#${c.rank}</span>` : ''}</div>
      <div class="r">${s ? esc(s.reason) : 'Not enough data'}</div></div>
    <div class="rt"><div style="display:flex;gap:8px;align-items:center">${sparkSVG(c.spark)}<span class="px">${fmtPrimaryMc(c.mcap, c.price)}</span></div>
      ${c.mcap ? pxSub(c.price) : ''}<div style="display:flex;gap:6px;align-items:center"><span class="chg ${pctCls(c.ch24)}">${fmtPct(c.ch24)}</span>${badge(s)}</div></div></a>`;
}
const DISCLAIMER = `<div class="disclaimer"><b>Not financial advice. Nothing here predicts price.</b> Memecoins are extremely risky and many fresh tokens are rugs or scams that go to zero. Scores are automated momentum, buy-pressure and indicator readings from past data and are often wrong. Do your own research and only risk money you can afford to lose completely.</div>`;
function metaHTML() {
  return `<div class="meta"><span class="live"><span class="dot ${state.stale ? 'stale' : ''}"></span><span class="upd" data-ts="${state.ts || ''}">${state.ts ? 'Updated ' + timeAgo(state.ts) : 'Loading…'}</span>&nbsp;· ${esc(state.source || '')}</span>
    <button class="chip sm" id="sortBtn" >Sort: ${({ score: 'Swing', rank: 'Market cap', ch24: '24h %' })[state.sort]}</button></div>`;
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


// ---------- DEX data (DexScreener + GeckoTerminal, keyless) ----------
const DS = 'https://api.dexscreener.com';
const GT = 'https://api.geckoterminal.com/api/v2';
const FAST_TTL = 45 * 1000, FAST_REFRESH = 60 * 1000, LIVE_REFRESH = 20 * 1000, PAIR_TTL = 60 * 1000;
const FAST_CHAINS = ['solana', 'base', 'bsc', 'ethereum'];
const GT_NET = { solana: 'solana', base: 'base', bsc: 'bsc', eth: 'ethereum' };
const CHAIN_LABEL = { solana: 'SOL', base: 'BASE', bsc: 'BSC', ethereum: 'ETH', arbitrum: 'ARB', polygon: 'POL', avalanche: 'AVAX', ton: 'TON', sui: 'SUI', tron: 'TRX', hyperliquid: 'HYPE', robinhood: 'HOOD', elysium: 'ELYS', abstract: 'ABS', monad: 'MON' };
const chainName = c => CHAIN_LABEL[c] || String(c || '').toUpperCase().slice(0, 6);
// quote / major tokens that are never "fresh memecoins"
const NOT_MEME = new Set(['so11111111111111111111111111111111111111112', 'epjfwdd5aufqssqem2qn1xzybapc8g4wegggkzwytdt1v', 'es9vmfrzacermjfrf4h2fyd4kconky11mcce8benwnyb',
  '0x4200000000000000000000000000000000000006', '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c', '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', '0x55d398326f99059ff775485246999027b3197955', '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d',
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', '0xdac17f958d2ee523a2206206994597c13d831ec7']);
const dexIcon = i => !i ? '' : /^https?:/.test(i) ? i : `https://cdn.dexscreener.com/cms/images/${encodeURIComponent(i)}?width=64&height=64&fit=crop&quality=95&format=auto`;
const tkey = (chain, addr) => chain + ':' + String(addr).toLowerCase();
function fmtAge(ms) { if (!ms || ms < 0) return '—'; const m = ms / 60000; if (m < 60) return Math.max(1, Math.round(m)) + 'm'; const h = m / 60; if (h < 48) return (h < 10 ? h.toFixed(1) : Math.round(h)) + 'h'; return Math.round(h / 24) + 'd'; }
const shortAddr = a => a && a.length > 12 ? a.slice(0, 4) + '…' + a.slice(-4) : a || '';
const buysSells = t => ({ b: (t && t.buys) || 0, s: (t && t.sells) || 0 });
const buyRatio = t => { const { b, s } = buysSells(t); return b + s ? b / (b + s) : 0.5; };

async function dsTokens(chain, addrs) {
  const out = [];
  for (let i = 0; i < addrs.length; i += 30) {
    try { const d = await getJSON(`${DS}/tokens/v1/${encodeURIComponent(chain)}/${addrs.slice(i, i + 30).join(',')}`); if (Array.isArray(d)) out.push(...d); }
    catch (e) { console.warn('dexscreener tokens', chain, e.message); }
  }
  return out;
}
const pairCache = new Map(); // key -> {pair, ts}
/** Best (most liquid) pair for each requested token. tokens: [{chain, addr}] */
async function pairsFor(tokens, maxAge = PAIR_TTL) {
  const want = new Set(tokens.map(t => tkey(t.chain, t.addr)));
  const by = {};
  tokens.forEach(t => { const c = pairCache.get(tkey(t.chain, t.addr)); if (!c || Date.now() - c.ts > maxAge) (by[t.chain] ||= new Set()).add(t.addr); });
  const res = await Promise.all(Object.entries(by).map(([ch, s]) => dsTokens(ch, [...s])));
  const best = new Map();
  for (const p of res.flat()) {
    if (!p || !p.baseToken) continue; const k = tkey(p.chainId, p.baseToken.address); if (!want.has(k)) continue;
    const q = best.get(k); if (!q || ((p.liquidity && p.liquidity.usd) || 0) > ((q.liquidity && q.liquidity.usd) || 0)) best.set(k, p);
  }
  best.forEach((p, k) => pairCache.set(k, { pair: p, ts: Date.now() }));
  const out = new Map(); want.forEach(k => { const c = pairCache.get(k); if (c && Date.now() - c.ts < 10 * 60e3) out.set(k, c.pair); });
  return out;
}
function pairLinks(p, extra) {
  const info = (p && p.info) || {}; const L = [];
  (info.socials || []).forEach(s => L.push({ type: s.type || s.platform || 'link', url: s.url }));
  (info.websites || []).forEach(w => L.push({ type: 'website', url: w.url, label: w.label }));
  (extra || []).forEach(l => { if (l && l.url && !L.some(x => x.url === l.url)) L.push({ type: l.type || (/(^|\.)(x|twitter)\.com/i.test(l.url) ? 'twitter' : 'website'), url: l.url, label: l.label }); });
  return L.filter(l => /^https?:\/\//i.test(l.url));
}
const xHandle = url => { const m = /(?:x|twitter)\.com\/(?:#!\/)?@?([A-Za-z0-9_]{1,15})(?:[/?#]|$)/i.exec(url || ''); return m && !/^(i|home|search|intent|share)$/i.test(m[1]) ? m[1] : null; };
function linksHTML(links, compact) {
  return links.slice(0, 5).map(l => {
    const h = l.type === 'twitter' ? xHandle(l.url) : null;
    const txt = l.type === 'twitter' ? (h ? '𝕏 @' + h : '𝕏') : l.type === 'telegram' ? 'Telegram' : l.type === 'discord' ? 'Discord' : l.type === 'website' ? (compact ? 'Web' : 'Website') : (l.label || l.type);
    return `<a class="lk ${l.type === 'twitter' ? 'x' : ''}" href="${esc(l.url)}" target="_blank" rel="noopener noreferrer">${esc(txt)}</a>`;
  }).join('');
}

// ---------- Fast: momentum + buy pressure scanner ----------
/**
 * Momentum score 0–100 (50 = neutral). Raw points:
 *   Momentum   ±30 : 5m (±8, 5% = full), 1h (±14, 25% = full), 6h (±8, 60% = full)
 *   Buy pressure ±30 : buy share of txns in 5m (±12) and 1h (±18)
 *   Turnover   0–20 : 1h volume / liquidity (50% = full)
 *   Activity   0–10 : 1h txn count (log scale, 1000 = full)
 *   Buzz       0–10 : DexScreener boost (+6), socials listed (+4)
 */
function fastScore(p) {
  const pc = p.priceChange || {}, tx = p.txns || {}, v = p.volume || {}, liq = (p.liquidity && p.liquidity.usd) || 0;
  const m5 = +pc.m5 || 0, h1 = +pc.h1 || 0, h6 = +pc.h6 || 0;
  const F = [];
  const mom = clamp(m5 / 5, -1, 1) * 8 + clamp(h1 / 25, -1, 1) * 14 + clamp(h6 / 60, -1, 1) * 8;
  F.push({ k: 'Momentum', pts: +mom.toFixed(1), txt: `Price ${fmtPct(m5)} 5m · ${fmtPct(h1)} 1h · ${fmtPct(h6)} 6h` });
  const r5 = buyRatio(tx.m5), r1 = buyRatio(tx.h1);
  const bp = (r5 - 0.5) * 2 * 12 + (r1 - 0.5) * 2 * 18;
  F.push({ k: 'Buy pressure', pts: +bp.toFixed(1), txt: `Buys ${Math.round(r1 * 100)}% of 1h trades, ${Math.round(r5 * 100)}% of 5m` });
  const turn = liq ? (v.h1 || 0) / liq : 0; const vl = clamp(turn / 0.5, 0, 1) * 20;
  F.push({ k: 'Volume', pts: +vl.toFixed(1), txt: `1h volume ${fmtBig(v.h1 || 0)} = ${(turn * 100).toFixed(0)}% of liquidity` });
  const n1 = buysSells(tx.h1).b + buysSells(tx.h1).s; const act = clamp(Math.log10(n1 + 1) / 3, 0, 1) * 10;
  F.push({ k: 'Activity', pts: +act.toFixed(1), txt: `${n1.toLocaleString('en-US')} trades in the last hour` });
  const hasSoc = ((p.info && p.info.socials) || []).length > 0; const boosted = (p.boosts && p.boosts.active) || 0;
  const buzz = (boosted ? 6 : 0) + (hasSoc ? 4 : 0);
  F.push({ k: 'Buzz', pts: buzz, txt: (boosted ? `Boosted on DexScreener (${boosted})` : 'Not boosted') + (hasSoc ? ', socials listed' : ', no socials listed') });
  const raw = mom + bp + vl + act + buzz;
  const score = Math.round(clamp((raw + 60) / 160 * 100, 0, 100));
  const [label, code] = score >= 70 ? ['🔥 HOT', 'SB'] : score >= 57 ? ['HEATING UP', 'B'] : score > 43 ? ['MIXED', 'H'] : score > 30 ? ['COOLING', 'S'] : ['DUMPING', 'SS'];
  return { score, label, code, factors: F };
}
/** Risk points → HIGH / VERY HIGH / EXTREME (a fresh memecoin is never "low risk"). */
function fastRisk(p, now = Date.now()) {
  const pc = p.priceChange || {}, tx = p.txns || {}, liq = (p.liquidity && p.liquidity.usd) || 0, fdv = p.fdv || p.marketCap || 0;
  let pts = 0; const why = [];
  const ageH = p.pairCreatedAt ? (now - p.pairCreatedAt) / 36e5 : 999;
  if (ageH < 1) { pts += 3; why.push('under 1 hour old'); } else if (ageH < 6) { pts += 2; why.push('under 6 hours old'); } else if (ageH < 24) { pts += 1; why.push('under 1 day old'); }
  if (liq < 30e3) { pts += 3; why.push('very thin liquidity'); } else if (liq < 75e3) { pts += 2; why.push('thin liquidity'); } else if (liq < 200e3) { pts += 1; why.push('modest liquidity'); }
  const fl = liq ? fdv / liq : 99;
  if (fl > 50) { pts += 3; why.push(`FDV is ${fl.toFixed(0)}× liquidity`); } else if (fl > 20) { pts += 2; why.push(`FDV is ${fl.toFixed(0)}× liquidity`); } else if (fl > 10) { pts += 1; why.push(`FDV is ${fl.toFixed(0)}× liquidity`); }
  const t1 = buysSells(tx.h1); if (t1.s > t1.b * 1.3) { pts += 2; why.push('more sells than buys (1h)'); }
  if ((+pc.m5 || 0) < -10 || (+pc.h1 || 0) < -25) { pts += 2; why.push('sharp drop in progress'); }
  if ((+pc.h1 || 0) > 200 || (+pc.h6 || 0) > 500) { pts += 1; why.push('parabolic move, pullbacks are violent'); }
  if (!((p.info && p.info.socials) || []).length) { pts += 2; why.push('no socials listed'); }
  const [label, cls] = pts >= 8 ? ['EXTREME', 'rx'] : pts >= 4 ? ['VERY HIGH', 'rv'] : ['HIGH', 'rh'];
  return { pts, label, cls, why, ageH };
}
const riskBadge = r => `<span class="risk ${r.cls}">⚠ ${r.label}</span>`;
function fastPlan(p, risk) {
  const price = +p.priceUsd; if (!price) return null;
  const sp = risk.label === 'EXTREME' ? 0.25 : risk.label === 'VERY HIGH' ? 0.2 : 0.15;
  return { price, stop: price * (1 - sp), tp1: price * (1 + sp * 1.5), tp2: price * (1 + sp * 3), sp };
}
const fast = { items: [], ts: 0, loading: false, err: null, age: 72, chain: 'all', sort: 'score' };
function toFastItem(p, meta) {
  const s = fastScore(p), r = fastRisk(p);
  return { key: tkey(p.chainId, p.baseToken.address), chain: p.chainId, addr: p.baseToken.address, name: p.baseToken.name, symbol: p.baseToken.symbol,
    icon: (p.info && p.info.imageUrl) || dexIcon(meta && meta.icon), pair: p, sig: s, risk: r, src: (meta && meta.src) || [] };
}
/** Convert a GeckoTerminal pool (+ its included base token) into the DexScreener pair shape the app uses,
 *  so the Fast list still works when DexScreener is rate-limited. */
function gtPoolToPair(pl, tokById) {
  const a = (pl && pl.attributes) || {}; const rel = pl && pl.relationships && pl.relationships.base_token && pl.relationships.base_token.data;
  const id = rel && rel.id; if (!id || id.indexOf('_') < 0) return null;
  const net = id.slice(0, id.indexOf('_')), addr = id.slice(id.indexOf('_') + 1); const chain = GT_NET[net]; if (!chain) return null;
  const t = (tokById && tokById[id] && tokById[id].attributes) || {};
  const pc = a.price_change_percentage || {}, tx = a.transactions || {}, v = a.volume_usd || {};
  const T = k => tx[k] ? { buys: +tx[k].buys || 0, sells: +tx[k].sells || 0 } : undefined;
  const nm = String(a.name || '').split(' / ');
  return { chainId: chain, dexId: (pl.relationships && pl.relationships.dex && pl.relationships.dex.data && pl.relationships.dex.data.id) || '', pairAddress: a.address,
    url: `https://www.geckoterminal.com/${net}/pools/${a.address}`, baseToken: { address: addr, name: t.name || nm[0] || '?', symbol: t.symbol || nm[0] || '?' },
    priceUsd: a.base_token_price_usd, priceChange: { m5: +pc.m5 || 0, h1: +pc.h1 || 0, h6: +pc.h6 || 0, h24: +pc.h24 || 0 },
    txns: { m5: T('m5'), h1: T('h1'), h6: T('h6'), h24: T('h24') }, volume: { m5: +v.m5 || 0, h1: +v.h1 || 0, h6: +v.h6 || 0, h24: +v.h24 || 0 },
    liquidity: { usd: +a.reserve_in_usd || 0 }, fdv: +a.fdv_usd || 0, marketCap: +a.market_cap_usd || 0,
    pairCreatedAt: a.pool_created_at ? Date.parse(a.pool_created_at) : 0, info: t.image_url && /^https?:/.test(t.image_url) ? { imageUrl: t.image_url } : undefined, _src: 'gecko' };
}
const FAST_DS_TTL = 60 * 1000, FAST_GT_TTL = 120 * 1000, FAST_GT6_TTL = 300 * 1000;
async function loadFast(force = false) {
  const c = ls.get('fast');
  if (!force && c && Date.now() - c.ts < FAST_TTL) { fast.items = c.items.map(i => toFastItem(i.pair, i)); fast.ts = c.ts; return; }
  const meta = new Map();
  const add = (chain, addr, src, extra) => {
    if (!FAST_CHAINS.includes(chain) || !addr || NOT_MEME.has(String(addr).toLowerCase())) return;
    const k = tkey(chain, addr); const m = meta.get(k) || { chain, addr, src: [] };
    if (!m.src.includes(src)) m.src.push(src); if (extra && extra.icon && !m.icon) m.icon = extra.icon; meta.set(k, m);
  };
  // Shared with the bot's Scout (same URLs → same cache); GeckoTerminal is paced per host.
  const [prof, bl, bt, g1, g2] = await Promise.all([
    cachedJSONx(DS + '/token-profiles/latest/v1', FAST_DS_TTL), cachedJSONx(DS + '/token-boosts/latest/v1', FAST_DS_TTL), cachedJSONx(DS + '/token-boosts/top/v1', FAST_DS_TTL),
    cachedJSONx(GT + '/networks/trending_pools?duration=1h&include=base_token', FAST_GT_TTL), cachedJSONx(GT + '/networks/trending_pools?duration=6h&include=base_token', FAST_GT6_TTL)]);
  const arr = x => Array.isArray(x.d) ? x.d : [];
  arr(prof).forEach(x => add(x.chainId, x.tokenAddress, 'new profile', x));
  arr(bl).forEach(x => add(x.chainId, x.tokenAddress, 'boosted', x));
  arr(bt).forEach(x => add(x.chainId, x.tokenAddress, 'top boosted', x));
  const gtPair = new Map();
  [g1, g2].forEach(g => {
    if (!g.d) return; const toks = {}; (g.d.included || []).forEach(t => { if (t && t.id) toks[t.id] = t; });
    (g.d.data || []).forEach(pl => {
      const gp = gtPoolToPair(pl, toks); if (!gp) return;
      add(gp.chainId, gp.baseToken.address, 'trending');
      const k = tkey(gp.chainId, gp.baseToken.address); const q = gtPair.get(k);
      if (!q || gp.liquidity.usd > q.liquidity.usd) gtPair.set(k, gp);
    });
  });
  const dsOk = prof.ok || bl.ok || bt.ok, gtOk = g1.ok || g2.ok;
  fast.src = { ds: dsOk, gt: gtOk, stale: [prof, bl, bt, g1, g2].some(x => x.stale) };
  if (!meta.size) {
    const why = navigator.onLine === false ? 'You are offline' : 'GeckoTerminal and DexScreener are not answering on this network (rate limit)';
    if (c) { fast.items = c.items.map(i => toFastItem(i.pair, i)); fast.ts = c.ts; fast.src.cached = true; srcToast(why + ' — showing coins from ' + timeAgo(c.ts)); return; }
    throw new Error(why + '. Retrying automatically.');
  }
  const pairs = await pairsFor([...meta.values()], FAST_TTL);
  const items = [];
  meta.forEach((m, k) => {
    const p = pairs.get(k) || gtPair.get(k);
    if (p && +p.priceUsd > 0 && p.pairCreatedAt) items.push(toFastItem(p, m));
  });
  fast.items = items; fast.ts = Date.now();
  ls.set('fast', { ts: fast.ts, items: items.map(i => ({ pair: i.pair, icon: i.icon, src: i.src })) });
  const sum = srcSummary(); if (sum) srcToast(sum);
}
/** Source-status toast, at most once per 3 minutes per message (no toast spam on every refresh). */
const _srcToastAt = {};
function srcToast(msg) { const t = _srcToastAt[msg] || 0; if (Date.now() - t < 3 * 60e3) return; _srcToastAt[msg] = Date.now(); if (['fast', 'watch', 'live'].includes(route().name)) toast(msg, 4000); }
function fastVisible() {
  const now = Date.now();
  let l = fast.items.filter(i => ((i.pair.liquidity && i.pair.liquidity.usd) || 0) >= 20e3 && ((i.pair.volume && i.pair.volume.h24) || 0) >= 10e3);
  if (fast.age) l = l.filter(i => now - i.pair.pairCreatedAt < fast.age * 36e5);
  if (fast.chain !== 'all') l = l.filter(i => i.chain === fast.chain);
  const by = { score: (a, b) => b.sig.score - a.sig.score, h1: (a, b) => (+b.pair.priceChange.h1 || 0) - (+a.pair.priceChange.h1 || 0), age: (a, b) => b.pair.pairCreatedAt - a.pair.pairCreatedAt, risk: (a, b) => a.risk.pts - b.risk.pts };
  return l.sort(by[fast.sort] || by.score);
}
function fastRowHTML(i) {
  const p = i.pair, pc = p.priceChange || {}, t1 = buysSells(p.txns && p.txns.h1), now = Date.now();
  const mc = pairMc(p);
  return `<a class="row frow" href="#/t/${encodeURIComponent(i.chain)}/${encodeURIComponent(i.addr)}"><span class="bar" style="background:${barColor(i.sig)}"></span>
    ${avatar({ symbol: i.symbol, image: i.icon })}
    <div class="nm"><div class="t"><span class="nmx">${esc(i.symbol)}</span><span class="ch">${chainName(i.chain)}</span><span class="age">${fmtAge(now - p.pairCreatedAt)}</span></div>
      <div class="r">Liq ${fmtBig(p.liquidity && p.liquidity.usd)} · <span class="up">${t1.b}</span>/<span class="dn">${t1.s}</span> b/s 1h</div>
      <div class="pcs"><span class="${pctCls(+pc.m5)}">5m ${fmtPct(+pc.m5)}</span><span class="${pctCls(+pc.h1)}">1h ${fmtPct(+pc.h1)}</span><span class="${pctCls(+pc.h24)}">24h ${fmtPct(+pc.h24)}</span></div></div>
    <div class="rt"><span class="px">${fmtPrimaryMc(mc, +p.priceUsd)}</span>${mc ? pxSub(+p.priceUsd) : ''}${badge(i.sig)}${riskBadge(i.risk)}</div></a>`;
}
function renderFast() {
  if (!fast.ts) { app.innerHTML = fast.err ? errHTML(fast.err) : skeleton(); return; }
  const l = fastVisible();
  const chains = ['all', ...FAST_CHAINS.filter(c => fast.items.some(i => i.chain === c))];
  app.innerHTML = `<div class="intro">⚡ <b>Fast flips</b> · fresh pairs (minutes–hours trades) ranked by momentum, buy pressure and volume. Liquidity ≥ $20K. Not predictions.</div>
    <div class="chips">${[[6, '< 6h'], [24, '< 24h'], [72, '< 72h'], [0, 'Any age']].map(([a, t]) => `<button class="chip ${fast.age === a ? 'on' : ''}" data-age="${a}">${t}</button>`).join('')}</div>
    <div class="chips">${chains.map(c => `<button class="chip sm ${fast.chain === c ? 'on' : ''}" data-ch="${c}">${c === 'all' ? 'All chains' : chainName(c)}</button>`).join('')}</div>
    <div class="meta"><span class="live"><span class="dot"></span><span class="upd" data-ts="${fast.ts}">Updated ${timeAgo(fast.ts)}</span> · ${l.length} coins</span>${srcSummary() ? `<span class="srcwarn">⚠ ${esc(srcSummary())}</span>` : ''}
      <button class="chip sm" id="fsort">Sort: ${({ score: 'Momentum', h1: '1h %', age: 'Newest', risk: 'Lowest risk' })[fast.sort]}</button></div>
    <div class="list">${l.map(fastRowHTML).join('') || `<div class="empty">No fresh coins pass the filters right now.<br>Try a longer age window.</div>`}</div>
    ${DISCLAIMER}`;
  app.querySelectorAll('[data-age]').forEach(b => b.onclick = () => { fast.age = +b.dataset.age; ls.set('fastAge', fast.age); renderFast(); });
  app.querySelectorAll('[data-ch]').forEach(b => b.onclick = () => { fast.chain = b.dataset.ch; renderFast(); });
  $('#fsort').onclick = () => { fast.sort = ({ score: 'h1', h1: 'age', age: 'risk', risk: 'score' })[fast.sort]; ls.set('fastSort', fast.sort); renderFast(); };
}

// ---------- Live feed (J7Tracker-style) ----------
const live = { items: ls.get('live', []), ts: 0, loading: false, err: null, chain: 'all', boot: Date.now(), fresh: new Set() };
async function loadLive() {
  const [pr, bo] = await Promise.allSettled([cachedJSON(DS + '/token-profiles/latest/v1', LIVE_REFRESH - 2000), cachedJSON(DS + '/token-boosts/latest/v1', LIVE_REFRESH - 2000)]);
  if (!pr.value && !bo.value) {
    const why = navigator.onLine === false ? 'You are offline' : 'DexScreener is rate-limiting this network';
    if (live.items.length) { srcToast(why + ' — retrying'); return; } throw new Error(why + '. Retrying automatically.');
  }
  const now = Date.now(); const map = new Map(live.items.map(i => [i.key, i])); const firstLoad = !live.items.length;
  const incoming = [];
  (pr.value || []).forEach(x => incoming.push({ x, kind: 'new' }));
  (bo.value || []).forEach(x => incoming.push({ x, kind: 'boost' }));
  incoming.forEach(({ x, kind }, idx) => {
    if (!x || !x.tokenAddress) return; const k = tkey(x.chainId, x.tokenAddress); let it = map.get(k);
    if (!it) { it = { key: k, chain: x.chainId, addr: x.tokenAddress, seen: now - idx * 1000, kinds: [] }; map.set(k, it); if (!firstLoad) live.fresh.add(k); }
    else if (kind === 'boost' && x.amount && x.totalAmount && x.totalAmount !== it.boostTotal && !firstLoad) { it.seen = now; live.fresh.add(k); }
    if (!it.kinds.includes(kind)) it.kinds.push(kind);
    if (x.icon) it.icon = dexIcon(x.icon); if (x.description) it.desc = x.description; if (x.links) it.links = x.links; if (x.url) it.url = x.url;
    if (kind === 'boost') { it.boost = x.amount || it.boost; it.boostTotal = x.totalAmount || it.boostTotal; }
  });
  live.items = [...map.values()].sort((a, b) => b.seen - a.seen).slice(0, 120);
  // pair stats for the newest 60
  try {
    const pairs = await pairsFor(live.items.slice(0, 60), PAIR_TTL);
    live.items.forEach(i => { const p = pairs.get(i.key); if (p) { i.p = { price: +p.priceUsd, liq: p.liquidity && p.liquidity.usd, mc: p.marketCap || p.fdv, h1: p.priceChange && p.priceChange.h1, m5: p.priceChange && p.priceChange.m5, created: p.pairCreatedAt, name: p.baseToken.name, symbol: p.baseToken.symbol, url: p.url, img: p.info && p.info.imageUrl, tx: p.txns && p.txns.h1 }; } });
  } catch (e) { console.warn('live pairs', e); }
  live.ts = Date.now();
  ls.set('live', live.items.map(i => ({ ...i })));
}
function liveCardHTML(i, now) {
  const p = i.p || {}; const sym = p.symbol || shortAddr(i.addr); const links = pairLinks(null, i.links);
  const t = buysSells(p.tx); const isNew = live.fresh.has(i.key);
  return `<div class="lcard ${isNew ? 'new' : ''}" data-k="${esc(i.key)}">
    <div class="lhead">${avatar({ symbol: sym, image: i.icon || p.img })}
      <a class="lt" href="#/t/${encodeURIComponent(i.chain)}/${encodeURIComponent(i.addr)}"><div class="t"><b>${esc(sym)}</b>${p.name ? `<span class="sub">${esc(p.name)}</span>` : ''}</div>
        <div class="tags"><span class="ch">${chainName(i.chain)}</span>${i.kinds.includes('boost') ? `<span class="tag boost">⚡ Boost${i.boostTotal ? ' ' + i.boostTotal : ''}</span>` : ''}${i.kinds.includes('new') ? '<span class="tag np">New profile</span>' : ''}<span class="seen" data-seen="${i.seen}">${timeAgo(i.seen)}</span></div></a>
      <button class="cp" data-ca="${esc(i.addr)}" aria-label="Copy contract address">CA</button></div>
    ${i.desc ? `<div class="desc">${esc(i.desc)}</div>` : ''}
    ${i.p ? `<div class="lstats"><span class="px">${fmtPrimaryMc(p.mc, p.price)}</span>${p.mc ? pxSub(p.price) : ''}<span>Liq ${fmtBig(p.liq)}</span><span class="${pctCls(+p.h1)}">1h ${fmtPct(+p.h1)}</span><span>Age ${fmtAge(now - p.created)}</span>${p.tx ? `<span><span class="up">${t.b}</span>/<span class="dn">${t.s}</span></span>` : ''}</div>` : '<div class="lstats"><span class="mut">loading pair stats…</span></div>'}
    <div class="links">${linksHTML(links, true)}<a class="lk" href="${esc(i.url || 'https://dexscreener.com/' + i.chain + '/' + i.addr)}" target="_blank" rel="noopener noreferrer">Chart</a></div></div>`;
}
function renderLive() {
  if (!live.items.length) { app.innerHTML = live.err ? errHTML(live.err) : skeleton(); return; }
  const chains = {}; live.items.forEach(i => chains[i.chain] = (chains[i.chain] || 0) + 1);
  const ch = ['all', ...Object.keys(chains).sort((a, b) => chains[b] - chains[a])];
  if (!ch.includes(live.chain)) live.chain = 'all';
  const l = live.items.filter(i => live.chain === 'all' || i.chain === live.chain); const now = Date.now();
  app.innerHTML = `<div class="intro">📡 <b>Live feed</b> · new token profiles and boosts on DexScreener as they appear, refreshed every 20s. Tap 𝕏 to open the coin’s account.</div>
    <div class="chips">${ch.map(c => `<button class="chip sm ${live.chain === c ? 'on' : ''}" data-lc="${c}">${c === 'all' ? 'All' : chainName(c)}<span class="n">${c === 'all' ? live.items.length : chains[c]}</span></button>`).join('')}</div>
    <div class="meta"><span class="live"><span class="dot pulse"></span><span class="upd" data-ts="${live.ts}">${live.ts ? 'Updated ' + timeAgo(live.ts) : 'Connecting…'}</span></span><span>${l.length} tokens</span></div>
    <div class="feed">${l.map(i => liveCardHTML(i, now)).join('') || '<div class="empty">Nothing on this chain yet.</div>'}</div>
    ${DISCLAIMER}`;
  live.fresh.clear();
  app.querySelectorAll('[data-lc]').forEach(b => b.onclick = () => { live.chain = b.dataset.lc; renderLive(); });
}

// ---------- token detail (fast / live) ----------
async function renderToken(chain, addr) {
  const k = tkey(chain, addr);
  let it = fast.items.find(i => i.key === k);
  let p = it ? it.pair : (pairCache.get(k) || {}).pair;
  const draw = () => {
    if (!p) { app.innerHTML = `<div class="empty">No trading pair found for this token yet.<br><br><a class="chip" href="https://dexscreener.com/${esc(chain)}/${esc(addr)}" target="_blank" rel="noopener">Open on DexScreener</a></div>`; return; }
    const s = fastScore(p), r = fastRisk(p), plan = fastPlan(p, r), pc = p.priceChange || {}, v = p.volume || {}, tx = p.txns || {}, now = Date.now();
    const liveIt = live.items.find(i => i.key === k);
    const links = pairLinks(p, liveIt && liveIt.links); const fav = isDexFav(k);
    $('#title').innerHTML = `<span class="logo"></span>${esc(p.baseToken.symbol)}`;
    const tr = (lbl, t) => { const x = buysSells(t); const tot = x.b + x.s || 1; return `<div class="bsr"><small>${lbl}</small><div class="bsbar"><i style="width:${(x.b / tot * 100).toFixed(0)}%"></i></div><span><b class="up">${x.b}</b> / <b class="dn">${x.s}</b></span></div>`; };
    app.innerHTML = `
      <div class="dhead">${avatar({ symbol: p.baseToken.symbol, image: (p.info && p.info.imageUrl) || (it && it.icon) || (liveIt && liveIt.icon) })}<div><h1>${esc(p.baseToken.name)}</h1><div class="sub">${esc(p.baseToken.symbol)} · ${chainName(chain)} · ${esc(p.dexId || '')} · age ${fmtAge(now - p.pairCreatedAt)}</div></div>
        <button class="star ${fav ? 'on' : ''}" id="favBtn" aria-label="Add to watchlist">${STAR}</button></div>
      <div class="pxline"><div class="pxstack"><span class="bigpx" id="bigpx">${fmtPrimaryMc(pairMc(p), +p.priceUsd)}</span>${pairMc(p) ? `<span class="pxsub" id="pxsub">${fmtPrice(+p.priceUsd)}</span>` : ''}</div><span class="chg ${pctCls(+pc.m5)}">5m ${fmtPct(+pc.m5)}</span><span class="chg ${pctCls(+pc.h1)}">1h ${fmtPct(+pc.h1)}</span><span class="chg ${pctCls(+pc.h24)}">24h ${fmtPct(+pc.h24)}</span></div>
      <div class="links big">${linksHTML(links)}<button class="lk cp" data-ca="${esc(addr)}">Copy CA ${esc(shortAddr(addr))}</button></div>
      <div class="tf">
        <div class="card"><small>Momentum</small><div style="margin-top:6px">${badge(s)}</div><div class="note" style="margin-top:6px">Score ${s.score}/100</div></div>
        <div class="card"><small>Risk</small><div style="margin-top:6px">${riskBadge(r)}</div><div class="note" style="margin-top:6px">${r.pts} risk points</div></div>
      </div>
      <div class="card chartcard"><h3><span class="chart-h">Market cap <span class="livepill" id="livepill" hidden><i></i><b>LIVE</b></span><span class="livemc" id="livemc">${pairMc(p) ? fmtBig(pairMc(p)) : ''}</span></span>${tfSegHTML('1m')}</h3>
        <div class="ohlc" id="ohlc" hidden></div>
        <div class="chartbox" id="mcchart"><div class="chart-empty mut">Loading chart…</div></div>
        <div class="chartcap">BUY/SELL marks are automated indicator signals from past candles, not predictions. Last candle is live from DexScreener. Charts by <a href="https://www.tradingview.com/" target="_blank" rel="noopener">TradingView</a>.</div>
        <div class="note"><a href="${esc(dsChartUrl(chain, p.pairAddress, p.url))}" target="_blank" rel="noopener">Open DexScreener chart</a> · pair ${esc(shortAddr(p.pairAddress))}</div></div>
      <div class="card"><h3>Stats</h3><div class="ind">
        <div class="lv"><small>Liquidity</small><b>${fmtBig(p.liquidity && p.liquidity.usd)}</b></div>
        <div class="lv"><small>Market cap / FDV</small><b>${fmtBig(p.marketCap)} / ${fmtBig(p.fdv)}</b></div>
        <div class="lv"><small>Volume 1h</small><b>${fmtBig(v.h1)}</b></div>
        <div class="lv"><small>Volume 24h</small><b>${fmtBig(v.h24)}</b></div>
        <div class="lv"><small>Pair age</small><b>${fmtAge(now - p.pairCreatedAt)}</b></div>
        <div class="lv"><small>6h change</small><b class="${pctCls(+pc.h6)}">${fmtPct(+pc.h6)}</b></div>
      </div>${tr('Buys / sells 5m', tx.m5)}${tr('Buys / sells 1h', tx.h1)}${tr('Buys / sells 24h', tx.h24)}</div>
      <div class="card"><h3>Why this momentum score</h3><ul class="factors">${s.factors.map(f => `<li><span>${esc(f.txt)}</span><span class="pts ${f.pts > 0 ? 'up' : f.pts < 0 ? 'dn' : ''}">${f.pts > 0 ? '+' : ''}${f.pts}</span></li>`).join('')}</ul></div>
      <div class="card"><h3>Risk flags</h3>${r.why.length ? `<ul class="flags">${r.why.map(w => `<li>⚠ ${esc(w)}</li>`).join('')}</ul>` : '<div class="note" style="margin:0">No extra flags — still a memecoin: high risk.</div>'}
        <div class="note">Not checked here: mint/freeze authority, LP lock, holder concentration, honeypot tax. Check those on the chart page before buying.</div></div>
      ${plan ? `<div class="card"><h3>Example quick-flip exit plan</h3><div class="levels">
        <div class="lv s"><small>Stop</small>${levelMcHTML(plan.stop, mcFactor(pairMc(p), +p.priceUsd))}<br><small>−${(plan.sp * 100).toFixed(0)}%</small></div>
        <div class="lv t"><small>Take part</small>${levelMcHTML(plan.tp1, mcFactor(pairMc(p), +p.priceUsd))}<br><small>+${(plan.sp * 150).toFixed(0)}%</small></div>
        <div class="lv t"><small>Take rest</small>${levelMcHTML(plan.tp2, mcFactor(pairMc(p), +p.priceUsd))}<br><small>+${(plan.sp * 300).toFixed(0)}%</small></div></div>
        <div class="note">Hold: minutes to hours. Example levels from the risk level (wider stop for riskier coins), not a prediction — fresh memecoins can drop 90% in seconds and stops may not fill. Values shown as market cap, with token price underneath.</div></div>` : ''}
      ${DISCLAIMER}
      <div class="note">Data: DexScreener live price · GeckoTerminal history · pair ${esc(shortAddr(p.pairAddress))} · <a href="${esc(p.url)}" target="_blank" rel="noopener">open full chart</a></div>`;
    $('#favBtn').onclick = e => { const on = toggleDexFav({ key: k, chain, addr, symbol: p.baseToken.symbol, name: p.baseToken.name, icon: (p.info && p.info.imageUrl) || '' }); e.currentTarget.classList.toggle('on', on); toast(on ? 'Added to watchlist' : 'Removed from watchlist', 1500); };
    bindMcChart({ kind: 'token', key: k, chain, addr, pairAddress: p.pairAddress, dsUrl: dsChartUrl(chain, p.pairAddress, p.url), price: +p.priceUsd, mcap: pairMc(p), plan, defaultTf: '1m' });
  };
  if (p) draw(); else app.innerHTML = skeleton(3);
  try { const m = await pairsFor([{ chain, addr }], p ? PAIR_TTL : 0); const np = m.get(k); if (np && location.hash === `#/t/${encodeURIComponent(chain)}/${encodeURIComponent(addr)}`) { const changed = !p || np !== p; p = np; if (changed) draw(); } else if (!p) draw(); }
  catch (e) { if (!p) draw(); }
}

// ---------- Slow: 1–3 day swing setups for established memecoins ----------
/**
 * Swing score (−100…100): half of the hourly indicator score, plus
 *   4h trend (EMA9 vs EMA21 on 4h bars) ±20, 4h EMA21 slope ±10, 7d trend ±15,
 *   pullback-in-uptrend bonus +10, overextension penalties (24h > +35% −15, RSI > 75 −10).
 */
function swingSignal(c) {
  const s = c.sig; if (!s || !c.spark || c.spark.length < 90) return null;
  const sp = c.spark, b4 = []; for (let i = sp.length - 1; i >= 0; i -= 4) b4.unshift(sp[i]);
  const e9 = ema(b4, 9), e21 = ema(b4, 21), n = b4.length;
  const F = []; F.push({ pts: Math.round(s.score * 0.5), txt: `hourly indicators ${s.score > 0 ? '+' : ''}${s.score}` });
  const up = last(e9) > last(e21); F.push({ pts: up ? 20 : -20, txt: up ? '4h trend up (EMA9 > EMA21)' : '4h trend down (EMA9 < EMA21)' });
  const sl = e21[n - 1] != null && e21[n - 4] != null ? e21[n - 1] - e21[n - 4] : 0; F.push({ pts: sl > 0 ? 10 : -10, txt: sl > 0 ? '4h EMA21 rising' : '4h EMA21 falling' });
  const w = clamp((c.ch7d || 0) / 30, -1, 1) * 15; F.push({ pts: Math.round(w), txt: `${fmtPct(c.ch7d)} over 7d` });
  if (up && c.ch24 < -3 && c.ch24 > -12) F.push({ pts: 10, txt: 'healthy pullback inside an uptrend' });
  if (c.ch24 > 25) F.push({ pts: -15, txt: `already +${c.ch24.toFixed(0)}% today (chasing risk)` });
  if (s.rsi > 75) F.push({ pts: -10, txt: `RSI ${s.rsi.toFixed(0)} overbought` });
  const score = Math.round(clamp(F.reduce((a, f) => a + f.pts, 0), -100, 100));
  const [label, code] = score >= 45 ? ['STRONG BUY', 'SB'] : score >= 15 ? ['BUY', 'B'] : score > -15 ? ['HOLD', 'H'] : score > -45 ? ['SELL', 'S'] : ['STRONG SELL', 'SS'];
  const dir = Math.sign(score); const reason = F.filter(f => dir ? Math.sign(f.pts) === dir : true).sort((a, b) => Math.abs(b.pts) - Math.abs(a.pts)).slice(0, 3).map(f => f.txt).join(', ');
  const price = c.price || sp[sp.length - 1], atr = s.atr, lo = s.swingLow;
  let lv;
  if (code === 'SB' || code === 'B') { const stop = Math.max(Math.min(lo - 0.25 * atr, price - 1.5 * atr), price - 3 * atr, price * 0.8); lv = { mode: 'long', entry: [price - 0.5 * atr, price], stop, tp: price + 2 * (price - stop), hold: code === 'SB' ? '1–3 days' : '1–2 days' }; }
  else if (code === 'H') { const eHi = price - 0.5 * atr, eLo = Math.max(price - 1.5 * atr, lo); const stop = Math.min(eLo, eHi) - 1.2 * atr; lv = { mode: 'dip', entry: [Math.min(eLo, eHi), eHi], stop, tp: eHi + 2 * (eHi - stop), hold: 'wait for dip, then 1–2 days' }; }
  else lv = { mode: 'avoid', entry: [lo, lo + 0.5 * atr], stop: lo - 1.5 * atr, tp: price + atr, hold: 'avoid for now' };
  return { score, label, code, reason: reason.charAt(0).toUpperCase() + reason.slice(1), factors: F, levels: lv };
}
function slowRowHTML(c) {
  const w = c.swing, L = w && w.levels;
  return `<a class="row" href="#/coin/${encodeURIComponent(c.id)}"><span class="bar" style="background:${barColor(w)}"></span>
    ${avatar(c)}
    <div class="nm"><div class="t"><span class="nmx">${esc(c.name)}</span>${c.name.toLowerCase() !== String(c.symbol).toLowerCase() ? `<span class="sym">${esc(c.symbol)}</span>` : ''}${c.rank ? `<span class="rk">#${c.rank}</span>` : ''}</div>
      <div class="r">${w ? esc(w.reason) : 'Not enough data'}</div></div>
    <div class="rt"><div style="display:flex;gap:8px;align-items:center">${sparkSVG(c.spark)}<span class="px">${fmtPrimaryMc(c.mcap, c.price)}</span></div>
      ${c.mcap ? pxSub(c.price) : ''}<div style="display:flex;gap:6px;align-items:center"><span class="chg ${pctCls(c.ch24)}">${fmtPct(c.ch24)}</span>${badge(w)}</div></div>
    ${L && L.mode !== 'avoid' ? `<div class="plan">${planLineHTML(L, mcFactor(c.mcap, c.price))}</div>` : ''}</a>`;
}

// ---------- screens ----------
function errHTML(e) { return `<div class="empty">Couldn't load data.<br><small>${esc(e && e.message || e)}</small><br><br><button class="chip on" onclick="refresh()">Try again</button></div>`; }
const dexFavs = () => ls.get('dexfavs', []);
const isDexFav = k => dexFavs().some(f => f.key === k);
function toggleDexFav(t) { const f = dexFavs(); const i = f.findIndex(x => x.key === t.key); i >= 0 ? f.splice(i, 1) : f.unshift(t); ls.set('dexfavs', f); return i < 0; }
function sortedSlow(list) {
  const l = [...list];
  if (state.sort === 'score') l.sort((a, b) => (b.swing ? b.swing.score : -999) - (a.swing ? a.swing.score : -999));
  else if (state.sort === 'rank') l.sort((a, b) => (a.rank || 999) - (b.rank || 999));
  else l.sort((a, b) => (b.ch24 || 0) - (a.ch24 || 0));
  return l;
}
function renderSlow() {
  if (!state.coins.length) { app.innerHTML = state.err ? errHTML(state.err) : skeleton(); return; }
  const all = state.coins;
  const buys = all.filter(c => c.swing && (c.swing.code === 'SB' || c.swing.code === 'B'));
  const sells = all.filter(c => c.swing && (c.swing.code === 'SS' || c.swing.code === 'S'));
  const avg = all.reduce((s, c) => s + (c.ch24 || 0), 0) / all.length;
  let list = state.filter === 'buy' ? buys : state.filter === 'sell' ? sells : all;
  const q = state.q.trim().toLowerCase();
  if (q) list = list.filter(c => c.name.toLowerCase().includes(q) || c.symbol.toLowerCase().includes(q));
  list = sortedSlow(list);
  const focused = document.activeElement && document.activeElement.id === 'q';
  app.innerHTML = `<div class="intro">🐢 <b>Slow swings</b> · established memecoins, 1–3 day holds. Signals favour the 4h/daily trend. Each buy setup shows entry, stop, target and hold time.</div>
    <div class="summary">
      <div class="stat"><small>Swing buys</small><b class="up">${buys.length}</b></div>
      <div class="stat"><small>Swing sells</small><b class="dn">${sells.length}</b></div>
      <div class="stat"><small>Avg 24h</small><b class="${pctCls(avg)}">${fmtPct(avg)}</b></div>
    </div>
    <label class="search"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>
      <input id="q" type="search" placeholder="Search memecoins" value="${esc(state.q)}" autocomplete="off" enterkeyhint="search"></label>
    <div class="chips">
      ${[['all', 'All', all.length], ['buy', 'Swing buys', buys.length], ['sell', 'Avoid / sell', sells.length]].map(([k, l, n]) => `<button class="chip ${state.filter === k ? 'on' : ''}" data-f="${k}">${l}<span class="n">${n}</span></button>`).join('')}
    </div>
    ${metaHTML()}
    <div class="list">${list.map(slowRowHTML).join('') || '<div class="empty">No coins match.</div>'}</div>
    ${DISCLAIMER}`;
  const qi = $('#q'); qi.oninput = e => { state.q = e.target.value; renderSlow(); };
  if (focused) { qi.focus(); qi.setSelectionRange(qi.value.length, qi.value.length); }
  app.querySelectorAll('[data-f]').forEach(b => b.onclick = () => { state.filter = b.dataset.f; renderSlow(); });
  bindSort();
}
let watchPairs = null;
function renderWatch() {
  const f = favs(), df = dexFavs();
  const list = f.map(id => state.coins.find(c => c.id === id)).filter(Boolean);
  const dRows = df.map(t => { const c = pairCache.get(t.key); return c ? toFastItem(c.pair, { icon: t.icon }) : null; });
  app.innerHTML = `<h2 style="margin:4px 2px 10px;font-size:20px">Watchlist</h2>
    ${!f.length && !df.length ? `<div class="empty"><div style="font-size:40px;margin-bottom:8px">⭐</div>No favorites yet.<br>Open any coin (Fast, Slow or Live) and tap the star to add it here.</div>` : ''}
    ${df.length ? `<div class="sec">⚡ Fresh coins</div><div class="list">${dRows.map((r, i) => r ? fastRowHTML(r) : `<a class="row" href="#/t/${encodeURIComponent(df[i].chain)}/${encodeURIComponent(df[i].addr)}">${avatar({ symbol: df[i].symbol, image: df[i].icon })}<div class="nm"><div class="t">${esc(df[i].symbol)}</div><div class="r">loading…</div></div><div></div></a>`).join('')}</div>` : ''}
    ${f.length ? `<div class="sec">🐢 Swing coins</div>${list.length ? metaHTML() + '<div class="list">' + sortedSlow(list).map(slowRowHTML).join('') + '</div>' : (state.coins.length ? '' : skeleton(2))}` : ''}
    ${state.coins.length && f.length > list.length ? `<div class="note">${f.length - list.length} saved coin(s) are outside the current top list.</div>` : ''}
    ${DISCLAIMER}`;
  bindSort();
  if (df.length && (!watchPairs || Date.now() - watchPairs > PAIR_TTL)) { watchPairs = Date.now(); pairsFor(df).then(() => { if (route().name === 'watch') renderWatch(); }).catch(() => {}); }
}
function renderAbout() {
  app.innerHTML = `<div class="about">
    <h2>How it works</h2>
    <div class="card warn"><b>Nothing here predicts price.</b> The app scans live market data for momentum, buy pressure and buzz and shows the risk. Many fresh memecoins are rugs or go to zero within hours. Only trade money you can afford to lose completely.</div>
    <h2>⚡ Fast (quick flips)</h2>
    <p>Pulls fresh tokens from DexScreener (latest token profiles, latest and top boosts) and GeckoTerminal trending pools on Solana, Base, BSC and Ethereum, then loads each token's most liquid pair. Shown only if liquidity ≥ $20K and 24h volume ≥ $10K. Age filter: under 6h / 24h / 72h.</p>
    <div class="card"><ul class="factors">
      <li><span><b>Momentum</b>: 5m, 1h, 6h price change</span><span class="pts">±30</span></li>
      <li><span><b>Buy pressure</b>: share of buys in 5m and 1h trades</span><span class="pts">±30</span></li>
      <li><span><b>Turnover</b>: 1h volume vs liquidity</span><span class="pts">0–20</span></li>
      <li><span><b>Activity</b>: number of trades in the last hour</span><span class="pts">0–10</span></li>
      <li><span><b>Buzz</b>: DexScreener boost, socials listed</span><span class="pts">0–10</span></li>
    </ul></div>
    <p>Score 0–100: ≥ 70 <span class="badge b-SB">🔥 HOT</span> · ≥ 57 <span class="badge b-B">HEATING UP</span> · 44–56 <span class="badge b-H">MIXED</span> · ≥ 31 <span class="badge b-S">COOLING</span> · lower <span class="badge b-SS">DUMPING</span></p>
    <p><b>Risk</b> is never "low" for these. Points for: very young pair, thin liquidity, FDV many times liquidity, more sells than buys, sharp drop, parabolic pump, no socials. <span class="risk rh">⚠ HIGH</span> <span class="risk rv">⚠ VERY HIGH</span> <span class="risk rx">⚠ EXTREME</span>. The app does <i>not</i> check mint authority, LP locks, holders or honeypot taxes. Check those on the chart page.</p>
    <h2>🐢 Slow (1–3 day swings)</h2>
    <p>Established memecoins from CoinGecko's meme category (Binance as backup). Swing score = half the hourly indicator score (RSI, SMA20/50, MACD, momentum) + 4h trend (EMA9 vs EMA21) ±20 + 4h trend slope ±10 + 7-day trend ±15, a bonus for a pullback inside an uptrend, and penalties for coins already up 25%+ today or overbought. Buy setups show an entry zone, a stop under recent swing lows, a 2:1 target and a suggested hold time.</p>
    <h2>🤖 Bot (Meme Terminal)</h2>
    <p>A paper or live flip bot that only trades <b>Fast Solana</b> memecoins (never Slow 2-day coins), holding about 60–90 minutes. It uses the Fast momentum score plus a strict analyst gate (RugCheck mint/freeze/LP, holder concentration, liquidity, age, volume, Jupiter price impact and a sell-side honeypot quote). Default is PAPER (live quotes, fake money). LIVE spends real SOL from a <b>separate burner wallet</b> generated on this phone — not your Phantom seed. The bot only runs while the app is open on screen.</p>
    <h2>📡 Live (J7Tracker-style)</h2>
    <p>A live stream of tokens that just got a DexScreener profile or boost, refreshed every 20 seconds, with new ones highlighted. Tap 𝕏 to open the coin's X account in the X app, <b>CA</b> to copy the contract address, Chart for DexScreener. A boost is <i>paid</i> promotion, not proof of quality.</p>
    <p class="mut">Live tweet tracking (like J7Tracker's tweet feed) needs paid X/J7 API keys, so this app links to each token's X account instead of streaming tweets.</p>
    <p><b>Data</b>: DexScreener and GeckoTerminal public APIs (fresh coins), CoinGecko and Binance (swing coins). Updates automatically while the app is open: Live every 20s, Fast every 60s, Slow every 3 minutes. Last data is cached so the app still opens offline.</p>
    <p><b>Install</b>: iPhone Safari → Share → <i>Add to Home Screen</i>. Android Chrome → menu ⋮ → <i>Install app</i>.</p>
    ${DISCLAIMER}</div>`;
}

// ---------- router ----------
const TITLES = { fast: 'Fast flips', slow: 'Slow swings', live: 'Live feed', bot: 'Meme Terminal', watch: 'Watchlist', about: 'How it works' };
function route() {
  const h = location.hash || '#/';
  if (h.startsWith('#/coin/')) return { name: 'coin', id: decodeURIComponent(h.slice(7)) };
  if (h.startsWith('#/t/')) { const [c, a] = h.slice(4).split('/'); return { name: 'token', chain: decodeURIComponent(c || ''), addr: decodeURIComponent(a || '') }; }
  const n = h.slice(2).split('?')[0].replace(/\/$/, ''); return { name: TITLES[n] ? n : 'fast' };
}
let lastRoute = '';
function render() {
  const r = route(); const detail = r.name === 'coin' || r.name === 'token';
  document.querySelectorAll('.tabbar a').forEach(a => a.classList.toggle('on', a.dataset.tab === r.name));
  $('#backBtn').hidden = !detail;
  if (!detail) $('#title').innerHTML = '<span class="logo"></span>' + (r.name === 'fast' ? 'Memecoin Signals' : TITLES[r.name]);
  const key = r.name + (r.id || r.addr || '');
  if (key !== lastRoute) { window.scrollTo(0, 0); app.style.animation = 'none'; void app.offsetWidth; app.style.animation = ''; if (r.name === 'coin' && !lastRoute.startsWith('coin')) state.tf = '7d'; lastRoute = key; }
  if (r.name !== 'coin' && r.name !== 'token') destroyMcChart();
  if (r.name !== 'bot' && window.__botLeave) window.__botLeave();
  if (r.name === 'coin') renderDetail(r.id); else if (r.name === 'token') renderToken(r.chain, r.addr);
  else if (r.name === 'slow') renderSlow(); else if (r.name === 'live') renderLive(); else if (r.name === 'bot') (window.renderBot || function(){ app.innerHTML = '<div class="empty">Bot failed to load.</div>'; })();
  else if (r.name === 'watch') renderWatch(); else if (r.name === 'about') renderAbout(); else renderFast();
  schedule();
}
window.addEventListener('hashchange', render);
$('#backBtn').onclick = () => { if (history.length > 1) history.back(); else location.hash = '#/'; };

// ---------- refresh ----------
const busy = () => state.loading || fast.loading || live.loading;
const spin = () => $('#refreshBtn').classList.toggle('spin', busy());
async function run(mod, fn, rerender) {
  if (mod.loading) return; mod.loading = true; spin();
  try { await fn(); mod.err = null; if (rerender()) render(); }
  catch (e) { console.warn('refresh failed', e); mod.err = e; if (rerender()) render(); }
  finally { mod.loading = false; spin(); }
}
const on = (...names) => () => names.includes(route().name);
const refreshSlow = (force = true) => run(state, () => loadMarkets(force), on('slow', 'watch', 'coin'));
const refreshFast = (force = true) => run(fast, () => loadFast(force), on('fast', 'watch', 'bot'));
const refreshLive = () => run(live, loadLive, on('live'));
async function refresh() { const n = route().name; if (n === 'live') return refreshLive(); if (n === 'bot') { if (window.renderBot) window.renderBot(); return; } if (n === 'fast' || n === 'token') { if (n === 'token') render(); return refreshFast(true); } if (n === 'watch') { watchPairs = null; refreshFast(true); } return refreshSlow(true); }
window.refresh = refresh;
$('#refreshBtn').onclick = () => refresh();
function schedule() {
  if (document.visibilityState !== 'visible') return; const n = route().name, now = Date.now();
  if (n === 'live' && now - live.ts > LIVE_REFRESH) refreshLive();
  if ((n === 'fast' || n === 'watch') && now - fast.ts > FAST_REFRESH) refreshFast(true);
  if ((n === 'slow' || n === 'watch' || n === 'coin') && now - state.ts > AUTO_REFRESH) refreshSlow(true);
}
setInterval(schedule, 5000);
document.addEventListener('visibilitychange', schedule);
setInterval(() => {
  document.querySelectorAll('.upd[data-ts]').forEach(el => { const t = +el.dataset.ts; if (t) el.textContent = 'Updated ' + timeAgo(t); });
  document.querySelectorAll('.seen[data-seen]').forEach(el => el.textContent = timeAgo(+el.dataset.seen));
  const m = document.querySelector('.meta .live .slow-upd'); if (m && state.ts) m.textContent = 'Updated ' + timeAgo(state.ts) + ' · ' + state.source;
}, 5000);
window.addEventListener('online', () => refresh());
// copy contract address (event delegation)
function copyText(t) {
  if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(t);
  const a = document.createElement('textarea'); a.value = t; a.style.position = 'fixed'; a.style.opacity = '0'; document.body.appendChild(a); a.select();
  try { document.execCommand('copy'); } finally { a.remove(); } return Promise.resolve();
}
document.addEventListener('click', e => { const b = e.target.closest('[data-ca]'); if (!b) return; e.preventDefault(); e.stopPropagation(); copyText(b.dataset.ca).then(() => toast('Contract address copied', 1500), () => toast(b.dataset.ca, 6000)); });
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
      <div class="pxline"><div class="pxstack"><span class="bigpx" id="bigpx">${fmtPrimaryMc(coin.mcap, coin.price)}</span>${coin.mcap ? `<span class="pxsub" id="pxsub">${fmtPrice(coin.price)}</span>` : ''}</div><span class="chg ${pctCls(coin.ch24)}" style="font-size:14px">${fmtPct(coin.ch24)} 24h</span><span class="chg ${pctCls(coin.ch7d)}" style="font-size:14px">${fmtPct(coin.ch7d)} 7d</span></div>
      <div class="tf">
        <div class="card"><small>Short-term (1h)</small><div style="margin-top:6px">${badge(short)}</div><div class="note" style="margin-top:6px">Score ${short ? short.score : '—'}</div></div>
        <div class="card"><small>Swing (1D, 90d)</small><div style="margin-top:6px">${hist ? badge(swing) : '<span class="badge b-H">loading…</span>'}</div><div class="note" style="margin-top:6px">Score ${swing ? swing.score : '—'}</div></div>
      </div>
      ${coin.swing ? swingPlanCard(coin.swing, mcFactor(coin.mcap, coin.price)) : ''}
      <div class="card chartcard"><h3>Market cap ${tfSegHTML('1h')}</h3>
        <div class="ohlc" id="ohlc" hidden></div>
        <div class="chartbox" id="mcchart"><div class="chart-empty mut">Loading chart…</div></div>
        <div class="chartcap">BUY/SELL marks are automated indicator signals from past candles, not predictions. Charts by <a href="https://www.tradingview.com/" target="_blank" rel="noopener">TradingView</a>.</div></div>
      ${sig ? signalCard(sig, tf, mcFactor(coin.mcap, coin.price)) : '<div class="card">Not enough history to compute signals.</div>'}
      ${DISCLAIMER}
      <div class="note">Data: ${esc(tf === '7d' ? state.source : (hist && hist.source) || '')} · ${tf === '7d' ? 'updated ' + timeAgo(state.ts) : hist ? 'updated ' + timeAgo(hist.ts) : ''}${coin.vol ? ' · Vol 24h ' + fmtBig(coin.vol) : ''}</div>`;
    $('#favBtn').onclick = e => { const on = toggleFav(coin.id); e.currentTarget.classList.toggle('on', on); toast(on ? 'Added to watchlist' : 'Removed from watchlist', 1500); };
    app.querySelectorAll('[data-tf]').forEach(b => b.onclick = () => { state.tf = b.dataset.tf; renderDetail(id); });
    bindMcChart({ kind: 'coin', key: coin.id, coinId: coin.id, symbol: coin.symbol, spark: coin.spark, binance: !!coin.binance, price: coin.price, mcap: coinMc(coin), plan: (coin.swing && coin.swing.levels) || (sig && sig.levels), defaultTf: '1h' });
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
  const col = ({ SB: '#2bb866', B: '#32d074', H: '#8e8e93', S: '#ff7b73', SS: '#e5484d' })[code];
  const a = (score + 100) / 200; const R = 34, C = Math.PI * R;
  return `<svg class="gauge" viewBox="0 0 84 84"><path d="M8 52 A34 34 0 0 1 76 52" stroke="#26262b" stroke-width="8" fill="none" stroke-linecap="round"/>
    <path d="M8 52 A34 34 0 0 1 76 52" stroke="${col}" stroke-width="8" fill="none" stroke-linecap="round" stroke-dasharray="${(a * C).toFixed(1)} ${C.toFixed(1)}"/>
    <text x="42" y="50" text-anchor="middle" fill="#f2f2f4" font-size="19" font-weight="800" style="stroke:none">${score > 0 ? '+' : ''}${score}</text>
    <text x="42" y="66" text-anchor="middle" fill="#8e8e93" font-size="9" font-weight="700" style="stroke:none">SCORE</text></svg>`;
}
function signalCard(s, tf, fac) {
  const col = ({ SB: '#32d074', B: '#32d074', H: '#aeaeb2', S: '#ff7b73', SS: '#ff6b63' })[s.code];
  const L = s.levels;
  const titles = L.mode === 'long' ? ['Entry zone', 'Stop-loss', 'Take-profit'] : L.mode === 'dip' ? ['Buy-the-dip zone', 'Stop-loss', 'Take-profit'] : ['Re-entry (support)', 'Stop if holding', 'Resistance'];
  const note = L.mode === 'long' ? `Reward/risk ≈ ${L.rr.toFixed(1)} : 1. Stop sits below the recent swing low / volatility band.` :
    L.mode === 'dip' ? 'No clear edge right now — consider waiting for a pullback into the zone.' :
    'Bearish setup: avoid new buys for now. If you hold, consider protecting gains; watch support for a possible re-entry.';
  const fx = s.factors.map(f => `<li><span>${esc(f.txt.charAt(0).toUpperCase() + f.txt.slice(1))}</span><span class="pts ${f.pts > 0 ? 'up' : f.pts < 0 ? 'dn' : ''}">${f.pts > 0 ? '+' : ''}${f.pts}</span></li>`).join('');
  return `<div class="card"><h3>Signal · ${tf === '7d' ? 'short-term' : 'swing'} <div class="seg"><button data-tf="7d" class="${tf === '7d' ? 'on' : ''}">1h</button><button data-tf="90d" class="${tf === '90d' ? 'on' : ''}">1D</button></div></h3>
      <div class="sig">${gaugeSVG(s.score, s.code)}<div><div class="lbl" style="color:${col}">${s.label}</div><div class="why">${esc(s.reason)}</div></div></div>
      <div class="levels">
        <div class="lv e"><small>${titles[0]}</small>${levelMcRangeHTML(L.entry[0], L.entry[1], fac)}</div>
        <div class="lv s"><small>${titles[1]}</small>${levelMcHTML(L.stop, fac)}<br><small>${fmtPct((L.stop / L.entry[1] - 1) * 100)}</small></div>
        <div class="lv t"><small>${titles[2]}</small>${levelMcHTML(L.tp, fac)}<br><small>${fmtPct((L.tp / L.entry[1] - 1) * 100)}</small></div>
      </div><div class="note">${note}${fac ? ' Levels shown as market cap, with token price underneath.' : ''}</div></div>
    <div class="card"><h3>Indicators</h3><div class="ind">
      <div class="lv"><small>RSI (14)</small><b class="${s.rsi < 30 ? 'up' : s.rsi > 70 ? 'dn' : ''}">${s.rsi.toFixed(1)}</b></div>
      <div class="lv"><small>MACD hist</small><b class="${pctCls(s.hist)}">${s.hist >= 0 ? '+' : ''}${(s.hist / s.sma20 * 100).toFixed(3)}%</b></div>
      <div class="lv"><small>SMA 20</small>${levelMcHTML(s.sma20, fac)}</div>
      <div class="lv"><small>SMA 50</small>${levelMcHTML(s.sma50, fac)}</div>
      <div class="lv"><small>Momentum</small><b class="${pctCls(s.roc)}">${fmtPct(s.roc)}</b></div>
      <div class="lv"><small>Volatility (ATR/day)</small><b>${s.atrPct.toFixed(2)}%</b></div>
    </div></div>
    <div class="card"><h3>Score breakdown</h3><ul class="factors">${fx}</ul></div>`;
}

// ---------- market-cap candlestick chart (Axiom-style) ----------
const CHART_TF = [
  { id: '1s',  gt: ['minute', 1],  bn: '1s',  cgDays: 1,  limit: 250 },
  { id: '1m',  gt: ['minute', 1],  bn: '1m',  cgDays: 1,  limit: 250 },
  { id: '5m',  gt: ['minute', 5],  bn: '5m',  cgDays: 1,  limit: 250 },
  { id: '15m', gt: ['minute', 15], bn: '15m', cgDays: 1,  limit: 250 },
  { id: '1h',  gt: ['hour', 1],    bn: '1h',  cgDays: 7,  limit: 250 },
  { id: '4h',  gt: ['hour', 4],    bn: '4h',  cgDays: 30, limit: 220 },
  { id: '1D',  gt: ['day', 1],     bn: '1d',  cgDays: 90, limit: 200 }
];
const TF_SEC = { '1s': 1, '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1D': 86400 };
const TF_BPD = { '1s': 86400, '1m': 1440, '5m': 288, '15m': 96, '1h': 24, '4h': 6, '1D': 1 };
const tradesCache = new Map();
const GT_POOL_NET = { ethereum: 'eth', bsc: 'bsc', base: 'base', solana: 'solana', arbitrum: 'arbitrum', polygon: 'polygon_pos', avalanche: 'avax', ton: 'ton', sui: 'sui', tron: 'tron' };
const ohlcvCache = new Map();
const bnMissing = new Set();
let chartState = {};

function tfSegHTML(active) {
  return `<div class="seg" id="chtf">${CHART_TF.map(t => `<button type="button" data-ctf="${t.id}" class="${t.id === active ? 'on' : ''}">${t.id}</button>`).join('')}</div>`;
}
function stopLiveFeed(st) {
  if (!st) return;
  st.liveGen = (st.liveGen || 0) + 1;
  if (st.liveTimer) { clearTimeout(st.liveTimer); st.liveTimer = null; }
  if (st.timer) { clearInterval(st.timer); st.timer = null; }
  if (st.onVis) { try { document.removeEventListener('visibilitychange', st.onVis); } catch {} st.onVis = null; }
}
function destroyMcChart() {
  stopLiveFeed(chartState);
  if (chartState.ro) { try { chartState.ro.disconnect(); } catch {} }
  if (chartState.badges && chartState.series) { try { chartState.series.detachPrimitive(chartState.badges); } catch {} }
  if (chartState.markers && chartState.markers.detach) { try { chartState.markers.detach(); } catch {} }
  if (chartState.chart) { try { chartState.chart.remove(); } catch {} }
  chartState = {};
}
function resampleCloses(prices, vols, sec) {
  const buckets = new Map();
  for (const [ms, px] of prices) {
    if (px == null || !isFinite(px)) continue;
    const t = Math.floor(ms / 1000 / sec) * sec;
    let b = buckets.get(t);
    if (!b) buckets.set(t, { t, o: px, h: px, l: px, c: px, v: 0 });
    else { b.h = Math.max(b.h, px); b.l = Math.min(b.l, px); b.c = px; }
  }
  for (const [ms, v] of vols || []) {
    const t = Math.floor(ms / 1000 / sec) * sec;
    const b = buckets.get(t); if (b) b.v = v;
  }
  return [...buckets.values()].sort((a, b) => a.t - b.t).map(b => [b.t, b.o, b.h, b.l, b.c, b.v]);
}
function sparkToBars(spark, tfId) {
  const sec = TF_SEC[tfId];
  if (!sec || sec < 3600 || !spark || spark.length < 3) return null;
  const step = 3600, now = Math.floor(Date.now() / 1000);
  const start = now - (spark.length - 1) * step;
  const pts = spark.map((c, i) => [(start + i * step) * 1000, c]);
  return resampleCloses(pts, [], sec);
}
function barsFromOhlcvList(list, fac) {
  const k = fac || 1, candles = [], volume = [];
  const seen = new Set();
  for (const row of list) {
    const t = +row[0], o = +row[1], h = +row[2], l = +row[3], c = +row[4], v = +row[5] || 0;
    if (!isFinite(t) || !isFinite(o) || !isFinite(c) || seen.has(t)) continue;
    seen.add(t);
    const up = c >= o;
    candles.push({ time: t, open: o * k, high: h * k, low: l * k, close: c * k, volume: v });
    volume.push({ time: t, value: v, color: up ? 'rgba(50,208,116,.45)' : 'rgba(255,90,82,.45)' });
  }
  candles.sort((a, b) => a.time - b.time);
  volume.sort((a, b) => a.time - b.time);
  return { candles, volume };
}
async function fetchGtOhlcv(chain, pairAddr, tf) {
  const net = GT_POOL_NET[chain] || chain;
  const url = `${GT}/networks/${encodeURIComponent(net)}/pools/${encodeURIComponent(pairAddr)}/ohlcv/${tf.gt[0]}?aggregate=${tf.gt[1]}&limit=${tf.limit}&currency=usd&token=base&include_empty_intervals=true`;
  const d = await getJSON(url, 15000);
  return (d && d.data && d.data.attributes && d.data.attributes.ohlcv_list) || [];
}
async function fetchBinanceOhlcv(symbol, tf) {
  const k = await binance(`/klines?symbol=${symbol.toUpperCase()}USDT&interval=${tf.bn}&limit=${tf.limit}`);
  return k.map(x => [Math.floor(x[0] / 1000), +x[1], +x[2], +x[3], +x[4], +x[7]]);
}
async function fetchCgChart(id, tf) {
  const d = await getJSON(`${CG}/coins/${encodeURIComponent(id)}/market_chart?vs_currency=usd&days=${tf.cgDays}`, 15000);
  return resampleCloses(d.prices || [], d.total_volumes || [], TF_SEC[tf.id]);
}
async function fetchOhlcv(st, tf) {
  const key = [st.kind, st.key, tf.id, st.pairAddress || ''].join('|');
  const hit = ohlcvCache.get(key);
  if (hit && Date.now() - hit.ts < 45e3) return hit.list;
  let list = null, err;
  if (st.kind === 'token' && st.pairAddress) {
    try { list = await fetchGtOhlcv(st.chain, st.pairAddress, tf); } catch (e) { err = e; }
  } else if (st.kind === 'coin') {
    const sym = (st.symbol || '').toUpperCase();
    const bnKnown = st.binance || FALLBACK.some(f => f[0] === sym);
    if (sym && bnKnown && !bnMissing.has(sym)) {
      try { list = await fetchBinanceOhlcv(st.symbol, tf); }
      catch (e) { if (e && (e.status === 400 || e.status === 404)) bnMissing.add(sym); err = e; }
    }
    if (!list && !cgBlocked()) {
      try { list = await fetchCgChart(st.coinId, tf); } catch (e) { cgBackoff(e); err = err || e; }
    }
    if (!list && st.spark) list = sparkToBars(st.spark, tf.id);
  }
  if (list && list.length) { ohlcvCache.set(key, { ts: Date.now(), list }); return list; }
  if (hit) return hit.list;
  if (err) throw err;
  return list;
}
function tradeUsdPrice(attr, baseAddr) {
  const b = String(baseAddr || '').toLowerCase();
  const from = String(attr.from_token_address || '').toLowerCase();
  const to = String(attr.to_token_address || '').toLowerCase();
  if (b && from === b && attr.price_from_in_usd != null) return +attr.price_from_in_usd;
  if (b && to === b && attr.price_to_in_usd != null) return +attr.price_to_in_usd;
  if (attr.kind === 'buy' && attr.price_to_in_usd != null) return +attr.price_to_in_usd;
  if (attr.price_from_in_usd != null) return +attr.price_from_in_usd;
  return NaN;
}
async function fetchGtTrades(chain, pairAddr) {
  const key = (chain || '') + ':' + (pairAddr || '');
  const hit = tradesCache.get(key);
  if (hit && Date.now() - hit.ts < 40e3) return hit.list;
  const net = GT_POOL_NET[chain] || chain;
  const d = await getJSON(`${GT}/networks/${encodeURIComponent(net)}/pools/${encodeURIComponent(pairAddr)}/trades?trade_volume_in_usd_greater_than=0`, 12000);
  const list = (d && d.data) || [];
  tradesCache.set(key, { ts: Date.now(), list });
  return list;
}
function ticksFromTrades(list, baseAddr) {
  const out = [];
  for (const tr of list || []) {
    const a = tr.attributes || tr;
    const px = tradeUsdPrice(a, baseAddr);
    const ms = Date.parse(a.block_timestamp);
    if (!isFinite(px) || px <= 0 || !isFinite(ms)) continue;
    out.push({ t: ms / 1000, px, vol: +a.volume_in_usd || 0 });
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}
async function fetchDsPair(chain, pairAddr) {
  const d = await getJSON(`${DS}/latest/dex/pairs/${encodeURIComponent(chain)}/${encodeURIComponent(pairAddr)}`, 8000);
  return (d && (d.pair || (d.pairs && d.pairs[0]))) || null;
}
function pruneTicks(ticks, keepSec) {
  const cut = Date.now() / 1000 - (keepSec || 1800);
  let i = 0;
  while (i < ticks.length && ticks[i].t < cut) i++;
  if (i) ticks.splice(0, i);
  if (ticks.length > 8000) ticks.splice(0, ticks.length - 8000);
}
function mergeUsdRows(ohlcvList, ticks, sec) {
  const by = new Map();
  let firstTick = Infinity;
  for (const tk of ticks || []) if (tk && isFinite(tk.t)) firstTick = Math.min(firstTick, tk.t);
  const liveStart = isFinite(firstTick) ? Math.floor(firstTick / sec) * sec : Math.floor(Date.now() / 1000 / sec) * sec;
  for (const row of ohlcvList || []) {
    const t = +row[0];
    if (!isFinite(t) || t >= liveStart) continue;
    const o = +row[1], h = +row[2], l = +row[3], c = +row[4], v = +row[5] || 0;
    if (!isFinite(o) || !isFinite(c)) continue;
    by.set(t, [t, o, h, l, c, v]);
  }
  for (const tk of ticks || []) {
    if (!tk || !isFinite(tk.px) || tk.px <= 0) continue;
    const t = Math.floor(tk.t / sec) * sec;
    let b = by.get(t);
    if (!b) by.set(t, [t, tk.px, tk.px, tk.px, tk.px, tk.vol || 0]);
    else {
      b[2] = Math.max(b[2], tk.px);
      b[3] = Math.min(b[3], tk.px);
      b[4] = tk.px;
      b[5] += tk.vol || 0;
    }
  }
  return [...by.values()].sort((a, b) => a[0] - b[0]);
}
function setLivePill(on, mc) {
  const pill = $('#livepill');
  if (pill) {
    pill.hidden = false;
    pill.classList.toggle('off', !on);
    const b = pill.querySelector('b');
    if (b) b.textContent = on ? 'LIVE' : 'STALE';
  }
  const livemc = $('#livemc');
  if (livemc && mc) livemc.textContent = fmtBig(mc);
}
function updateHeaderMc(st) {
  const big = $('#bigpx'); if (big) big.textContent = fmtPrimaryMc(st.mcap, st.price);
  const sub = $('#pxsub'); if (sub) sub.textContent = fmtPrice(st.price);
  const livemc = $('#livemc'); if (livemc && st.mcap) livemc.textContent = fmtBig(st.mcap);
}
function packUsdToMc(usdRows, fac) {
  return barsFromOhlcvList(usdRows, fac || 1);
}
function applyPacked(st, packed, fit) {
  st.bars = packed.candles;
  if (!st.series) return;
  st.series.setData(packed.candles.map(({ time, open, high, low, close }) => ({ time, open, high, low, close })));
  if (st.vol) st.vol.setData(packed.volume);
  const marks = signalMarkers(packed.candles, st.kind === 'coin' ? 'coin' : 'token', st.tf);
  st.markCount = marks.length;
  applyChartBadges(st.series, marks, st.plan, st.fac);
  if (fit && st.chart) st.chart.timeScale().fitContent();
  paintOhlc();
}
function rebuildTokenChart(st, fit) {
  const sec = TF_SEC[st.tf] || 60;
  const hist = st.tf === '1s' ? [] : (st.ohlcvList || []);
  st.usdRows = mergeUsdRows(hist, st.ticks || [], sec);
  applyPacked(st, packUsdToMc(st.usdRows, st.fac || 1), fit);
}
function applyLiveTick(st, px, mcap, volDelta) {
  if (!px || !isFinite(px) || px <= 0) return;
  const now = Date.now() / 1000;
  st.ticks = st.ticks || [];
  st.ticks.push({ t: now, px, vol: volDelta || 0 });
  pruneTicks(st.ticks, st.tf === '1s' ? 1800 : 6 * 3600);
  const fac = mcFactor(mcap, px);
  const facChanged = !!(fac && st.fac && Math.abs(fac - st.fac) / st.fac > 0.005);
  if (fac) st.fac = fac;
  st.price = px;
  if (mcap != null) st.mcap = mcap;
  updateHeaderMc(st);
  setLivePill(true, st.mcap);
  st.liveAt = Date.now();
  st.liveOk = true;
  if (!st.series) {
    const host = $('#mcchart');
    if (host) {
      const inst = createMcChart(host);
      if (inst) {
        st.chart = inst.chart; st.series = inst.series; st.vol = inst.vol;
        inst.chart.subscribeCrosshairMove(param => {
          if (!chartState.bars) return;
          if (!param || param.time == null) { paintOhlc(); return; }
          const i = chartState.bars.findIndex(b => b.time === param.time);
          if (i >= 0) paintOhlc(i);
        });
        rebuildTokenChart(st, true);
      }
    }
    return;
  }
  if (facChanged || !st.usdRows || !st.usdRows.length) { rebuildTokenChart(st, false); return; }
  const sec = TF_SEC[st.tf] || 60;
  const t = Math.floor(now / sec) * sec;
  const val = st.fac ? px * st.fac : (st.mcap || px);
  const last = st.usdRows[st.usdRows.length - 1];
  if (!last || t > last[0]) st.usdRows.push([t, px, px, px, px, volDelta || 0]);
  else if (t === last[0]) { last[2] = Math.max(last[2], px); last[3] = Math.min(last[3], px); last[4] = px; last[5] += volDelta || 0; }
  else { rebuildTokenChart(st, false); return; }
  let bar = st.bars[st.bars.length - 1];
  if (!bar || t > bar.time) {
    bar = { time: t, open: val, high: val, low: val, close: val, volume: volDelta || 0 };
    st.bars.push(bar);
  } else if (t === bar.time) {
    bar.close = val; bar.high = Math.max(bar.high, val); bar.low = Math.min(bar.low, val);
    bar.volume = (bar.volume || 0) + (volDelta || 0);
  }
  st.series.update({ time: bar.time, open: bar.open, high: bar.high, low: bar.low, close: bar.close });
  if (st.vol) st.vol.update({ time: bar.time, value: bar.volume || 0, color: bar.close >= bar.open ? 'rgba(50,208,116,.45)' : 'rgba(255,90,82,.45)' });
  paintOhlc();
}
function exposeLiveDebug() {
  window.__liveChart = () => {
    const st = chartState || {};
    const last = st.bars && st.bars[st.bars.length - 1];
    return {
      key: st.key, chain: st.chain, addr: st.addr, pairAddress: st.pairAddress,
      tf: st.tf, mc: st.mcap, price: st.price, fac: st.fac,
      lastClose: last && last.close, lastTime: last && last.time,
      lastOpen: last && last.open, lastHigh: last && last.high, lastLow: last && last.low,
      nBars: (st.bars && st.bars.length) || 0, nTicks: (st.ticks && st.ticks.length) || 0,
      liveAt: st.liveAt, liveOk: st.liveOk
    };
  };
}
async function tickTokenChart() {
  const st = chartState;
  if (!st || st.kind !== 'token' || !st.pairAddress) return;
  if (document.visibilityState !== 'visible' || route().name !== 'token') return;
  try {
    const p = await fetchDsPair(st.chain, st.pairAddress);
    if (!p || chartState !== st) return;
    const px = +p.priceUsd;
    const mc = pairMc(p);
    let volDelta = 0;
    const h24 = p.volume && +p.volume.h24;
    if (h24 && st._h24 && h24 > st._h24) volDelta = h24 - st._h24;
    if (h24) st._h24 = h24;
    pairCache.set(st.key, { pair: p, ts: Date.now() });
    applyLiveTick(st, px, mc, volDelta);
  } catch (e) {
    st.liveOk = false;
    setLivePill(false, st.mcap);
    if (st.chain === 'solana' && st.addr) {
      try {
        const d = await getJSON('https://api.jup.ag/price/v3?ids=' + encodeURIComponent(st.addr), 8000);
        const x = d && (d[st.addr] || d[Object.keys(d)[0]]);
        const px = x && +x.usdPrice;
        if (px && chartState === st) applyLiveTick(st, px, st.fac ? px * st.fac : st.mcap, 0);
        else console.warn('live tick', e);
      } catch { console.warn('live tick', e); }
    } else console.warn('live tick', e);
  }
}
function startLiveFeed(st) {
  stopLiveFeed(st);
  if (!st || st.kind !== 'token') return;
  const gen = (st.liveGen = (st.liveGen || 0) + 1);
  const loop = async () => {
    if (chartState !== st || st.liveGen !== gen) return;
    const t0 = Date.now();
    if (document.visibilityState === 'visible' && route().name === 'token') await tickTokenChart();
    if (chartState !== st || st.liveGen !== gen) return;
    st.liveTimer = setTimeout(loop, Math.max(250, 1000 - (Date.now() - t0)));
  };
  st.onVis = () => { if (document.visibilityState === 'visible' && chartState === st) tickTokenChart(); };
  document.addEventListener('visibilitychange', st.onVis);
  setLivePill(!!(st.price || st.mcap), st.mcap);
  exposeLiveDebug();
  loop();
}
function signalMarkers(candles, kind, tfId) {
  const n = candles.length, out = [];
  if (n < 13) return out;
  const closes = candles.map(c => c.close);
  const push = (i, dir) => {
    const c = candles[i];
    out.push({ time: c.time, dir, price: dir === 'buy' ? c.low : c.high, low: c.low, high: c.high });
  };
  const confirm = 2, cooldown = Math.max(8, Math.round(n / 20));
  const emit = (raw) => {
    let stance = null;
    const filled = raw.map(d => {
      if (d === 'buy' || d === 'sell' || d === 'hold') stance = d;
      return stance;
    });
    let prev = null, pending = null, pendingAt = -1, last = -Infinity;
    filled.forEach((dir, i) => {
      if (!dir || dir === 'hold') { pending = null; return; }
      if (dir === prev) { pending = null; return; }
      if (pending !== dir) { pending = dir; pendingAt = i; }
      if (pending === dir && i - pendingAt + 1 >= confirm && i - last >= cooldown) {
        push(i, dir); prev = dir; last = i; pending = null;
      }
    });
  };
  if (kind === 'coin' && n >= 55) {
    const bpd = TF_BPD[tfId] || 24;
    const raw = Array(n).fill(null);
    for (let i = 54; i < n; i++) {
      const s = analyze(closes.slice(0, i + 1), bpd);
      if (!s) continue;
      raw[i] = (s.code === 'SB' || s.code === 'B') ? 'buy' : (s.code === 'S' || s.code === 'SS') ? 'sell' : 'hold';
    }
    emit(raw);
    return out;
  }
  const fastN = n >= 30 ? 21 : 13, fastS = n >= 30 ? 9 : 5;
  const e9 = ema(closes, fastS), e21 = ema(closes, fastN), r = rsi(closes, Math.min(14, Math.max(6, Math.floor(n / 3))));
  const raw = Array(n).fill(null);
  let seeded = false;
  for (let i = fastN; i < n; i++) {
    if (e9[i] == null || e21[i] == null) continue;
    if (!seeded) {
      if (e9[i] > e21[i] && (r[i] == null || r[i] < 70)) raw[i] = 'buy';
      else if (e9[i] < e21[i] && (r[i] == null || r[i] > 30)) raw[i] = 'sell';
      seeded = true;
      continue;
    }
    if (e9[i - 1] == null || e21[i - 1] == null) continue;
    const crossUp = e9[i - 1] <= e21[i - 1] && e9[i] > e21[i];
    const crossDn = e9[i - 1] >= e21[i - 1] && e9[i] < e21[i];
    const mom = i >= 5 && closes[i - 5] ? closes[i] / closes[i - 5] - 1 : 0;
    if (crossUp && (r[i] == null || r[i] < 70) && mom >= -0.02) raw[i] = 'buy';
    else if (crossDn && (r[i] == null || r[i] > 30)) raw[i] = 'sell';
    else if (r[i - 1] != null && r[i] != null) {
      if (r[i - 1] <= 30 && r[i] > 30 && e9[i] >= e21[i]) raw[i] = 'buy';
      else if (r[i - 1] >= 70 && r[i] < 70 && e9[i] <= e21[i]) raw[i] = 'sell';
    }
  }
  emit(raw);
  return out;
}
const BADGE = {
  buy: '#16c784', sell: '#ea3943', entry: '#5e9eff',
  buyGlow: 'rgba(22,199,132,.55)', sellGlow: 'rgba(234,57,67,.55)', entryGlow: 'rgba(94,158,255,.5)'
};
function planItems(plan, fac) {
  const items = [];
  if (!plan) return items;
  const add = (pricePx, color, title) => {
    const price = fac ? pricePx * fac : pricePx;
    if (!isFinite(price)) return;
    items.push({ price, color, title, label: title + '  ' + fmtMcVal(price) });
  };
  if (plan.entry && Array.isArray(plan.entry)) {
    add(plan.entry[0], BADGE.entry, 'Entry');
    if (Math.abs(plan.entry[1] - plan.entry[0]) / Math.max(Math.abs(plan.entry[1]), 1e-12) > 0.006) add(plan.entry[1], BADGE.entry, 'Entry');
  } else if (plan.price) add(plan.price, BADGE.entry, 'Entry');
  if (plan.stop) add(plan.stop, BADGE.sell, 'Stop');
  if (plan.tp) add(plan.tp, BADGE.buy, 'TP');
  if (plan.tp1) add(plan.tp1, BADGE.buy, 'TP1');
  if (plan.tp2) add(plan.tp2, BADGE.buy, 'TP2');
  return items;
}
function setPlanLines(series, plan, fac, LW) {
  (chartState.lines || []).forEach(l => { try { series.removePriceLine(l); } catch {} });
  chartState.lines = [];
  if (!plan || !series) return;
  planItems(plan, fac).forEach(it => {
    chartState.lines.push(series.createPriceLine({
      price: it.price, color: it.color, lineWidth: 1, lineStyle: LW.LineStyle.Dashed,
      axisLabelVisible: false, title: '', lastValueVisible: false
    }));
  });
}
function lightenHex(hex, amt) {
  const n = hex.replace('#', '');
  const r = parseInt(n.slice(0, 2), 16), g = parseInt(n.slice(2, 4), 16), b = parseInt(n.slice(4, 6), 16);
  const m = v => Math.min(255, Math.round(v + (255 - v) * amt));
  return `rgb(${m(r)},${m(g)},${m(b)})`;
}
function roundRectPath(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}
function measurePill(ctx, text, fontSize) {
  const size = fontSize || 11;
  ctx.font = '700 ' + size + 'px -apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,sans-serif';
  return { w: Math.ceil(ctx.measureText(text).width) + 14, h: size >= 11 ? 20 : 18, size };
}
function drawBadgePill(ctx, box, text, color, glow, pointer, fontSize) {
  const { x, y, w, h } = box;
  const cx = x + w / 2, cy = y + h / 2;
  const triW = 6.5, triH = 5, r = Math.min(8, h / 2);
  ctx.save();
  // tight drop shadow, light color glow
  ctx.shadowColor = 'rgba(0,0,0,.55)';
  ctx.shadowBlur = 5;
  ctx.shadowOffsetY = 1;
  ctx.shadowOffsetX = 0;
  const fillBody = () => {
    const grad = ctx.createLinearGradient(0, y, 0, y + h);
    grad.addColorStop(0, lightenHex(color, 0.18));
    grad.addColorStop(0.6, color);
    grad.addColorStop(1, color);
    ctx.fillStyle = grad;
    ctx.fill();
  };
  ctx.beginPath();
  roundRectPath(ctx, x, y, w, h, r);
  fillBody();
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  // crisp pointer, slightly overlapping the body so it reads as one badge
  ctx.beginPath();
  if (pointer === 'up') { ctx.moveTo(cx - triW / 2, y + 1.2); ctx.lineTo(cx, y - triH); ctx.lineTo(cx + triW / 2, y + 1.2); }
  else if (pointer === 'down') { ctx.moveTo(cx - triW / 2, y + h - 1.2); ctx.lineTo(cx, y + h + triH); ctx.lineTo(cx + triW / 2, y + h - 1.2); }
  else if (pointer === 'left') { ctx.moveTo(x + 1.2, cy - triW / 2); ctx.lineTo(x - triH, cy); ctx.lineTo(x + 1.2, cy + triW / 2); }
  ctx.closePath();
  ctx.fillStyle = pointer === 'up' || pointer === 'left' ? lightenHex(color, 0.12) : color;
  ctx.fill();
  // soft color halo (no blur-blob)
  ctx.globalAlpha = 0.28;
  ctx.shadowColor = glow;
  ctx.shadowBlur = 8;
  ctx.beginPath();
  roundRectPath(ctx, x, y, w, h, r);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  // sheen
  ctx.beginPath();
  roundRectPath(ctx, x + 0.6, y + 0.6, w - 1.2, Math.max(6, h * 0.42), r - 1);
  ctx.fillStyle = 'rgba(255,255,255,.18)';
  ctx.fill();
  ctx.font = '700 ' + (fontSize || 11) + 'px -apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,sans-serif';
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, cx, cy + 0.4);
  ctx.restore();
}
function overlaps(a, b, pad) {
  const p = pad || 3;
  return a.x < b.x + b.w + p && a.x + a.w + p > b.x && a.y < b.y + b.h + p && a.y + a.h + p > b.y;
}
class ChartBadges {
  constructor() { this._marks = []; this._plans = []; this._boxes = []; this._pv = [{ zOrder: () => 'top', renderer: () => this._renderer() }]; }
  attached(param) { this._chart = param.chart; this._series = param.series; this._requestUpdate = param.requestUpdate; }
  detached() { this._chart = this._series = this._requestUpdate = null; }
  setData(marks, plans) { this._marks = marks || []; this._plans = plans || []; if (this._requestUpdate) this._requestUpdate(); }
  boxes() { return this._boxes; }
  updateAllViews() {}
  paneViews() { return this._pv; }
  _renderer() {
    const self = this;
    return {
      draw(target) {
        const chart = self._chart, series = self._series;
        if (!chart || !series) return;
        const paint = (ctx, width, height) => {
          const ts = chart.timeScale();
          const boxes = [];
          const planReserve = 92;
          // --- plan labels on the right first, so marks can avoid them ---
          const plans = (self._plans || []).slice().sort((a, b) => b.price - a.price);
          const planBoxes = [];
          plans.forEach(it => {
            const y = series.priceToCoordinate(it.price);
            if (y == null) return;
            const sz = measurePill(ctx, it.label, 10);
            let x0 = Math.round(width - sz.w - 6);
            let y0 = Math.round(y - sz.h / 2);
            y0 = Math.max(2, Math.min(height - sz.h - 2, y0));
            const box = { x: x0, y: y0, w: sz.w, h: sz.h, text: it.label, color: it.color, glow: it.color === BADGE.sell ? BADGE.sellGlow : it.color === BADGE.entry ? BADGE.entryGlow : BADGE.buyGlow, pointer: 'left', kind: 'plan', size: 10 };
            planBoxes.forEach(p => {
              if (overlaps(box, p, 3)) {
                if (box.y >= p.y) box.y = Math.min(height - box.h - 2, p.y + p.h + 3);
                else box.y = Math.max(2, p.y - box.h - 3);
              }
            });
            planBoxes.push(box);
            boxes.push(box);
          });
          // --- signal markers ---
          const placed = [];
          const marks = self._marks || [];
          const xs = marks.map(m => ts.timeToCoordinate(m.time));
          marks.forEach((m, idx) => {
            const x = xs[idx];
            const yAnchor = series.priceToCoordinate(m.dir === 'buy' ? m.low : m.high);
            if (x == null || yAnchor == null) return;
            if (x > width - planReserve) return; // keep the right edge for plan labels
            let close = false;
            xs.forEach((nx, j) => { if (j !== idx && nx != null && Math.abs(nx - x) < 50) close = true; });
            const text = m.dir === 'buy' ? (close ? 'B' : 'BUY') : (close ? 'S' : 'SELL');
            const sz = measurePill(ctx, text, close ? 11 : 11);
            const gap = 8, tri = 5;
            let pointer = m.dir === 'buy' ? 'up' : 'down';
            let x0 = Math.round(x - sz.w / 2), y0;
            if (pointer === 'up') y0 = Math.round(yAnchor + gap + tri);
            else y0 = Math.round(yAnchor - gap - tri - sz.h);
            if (y0 < 2) { pointer = 'up'; y0 = Math.round(yAnchor + gap + tri); }
            if (y0 + sz.h > height - 2) { pointer = 'down'; y0 = Math.round(yAnchor - gap - tri - sz.h); }
            x0 = Math.max(2, Math.min(width - planReserve - sz.w, x0));
            y0 = Math.max(2, Math.min(height - sz.h - 2, y0));
            const box = { x: x0, y: y0, w: sz.w, h: sz.h, text, color: m.dir === 'buy' ? BADGE.buy : BADGE.sell, glow: m.dir === 'buy' ? BADGE.buyGlow : BADGE.sellGlow, pointer, kind: 'mark', dir: m.dir, size: 11 };
            [...placed, ...planBoxes].forEach(p => {
              if (!overlaps(box, p, 4)) return;
              if (box.dir === 'buy') box.y = Math.min(height - box.h - 2, Math.max(p.y + p.h + 4, box.y));
              else box.y = Math.max(2, Math.min(p.y - box.h - 4, box.y));
            });
            if (planBoxes.some(p => overlaps(box, p, 2))) return;
            placed.push(box);
            boxes.push(box);
          });
          boxes.filter(b => b.kind === 'plan').forEach(b => drawBadgePill(ctx, b, b.text, b.color, b.glow, b.pointer, b.size));
          boxes.filter(b => b.kind === 'mark').forEach(b => drawBadgePill(ctx, b, b.text, b.color, b.glow, b.pointer, b.size));
          self._boxes = boxes;
          chartState.badgeBoxes = boxes;
          try {
            const el = series.getPane && series.getPane().getHTMLElement && series.getPane().getHTMLElement();
            const r = el && el.getBoundingClientRect();
            window.__badgeBoxes = { boxes, pane: r ? { x: r.left, y: r.top, w: r.width, h: r.height, dpr: window.devicePixelRatio || 1 } : null };
          } catch { window.__badgeBoxes = { boxes, pane: null }; }
        };
        if (target.useMediaCoordinateSpace) {
          target.useMediaCoordinateSpace(({ context, mediaSize }) => paint(context, mediaSize.width, mediaSize.height));
        } else {
          target.useBitmapCoordinateSpace(({ context, horizontalPixelRatio, verticalPixelRatio, mediaSize }) => {
            context.save();
            context.scale(horizontalPixelRatio, verticalPixelRatio);
            paint(context, mediaSize.width, mediaSize.height);
            context.restore();
          });
        }
      }
    };
  }
}
function applyChartBadges(series, marks, plan, fac) {
  const LW = window.LightweightCharts;
  setPlanLines(series, plan, fac, LW);
  if (!chartState.badges) {
    chartState.badges = new ChartBadges();
    series.attachPrimitive(chartState.badges);
  }
  chartState.badges.setData(marks, planItems(plan, fac));
}

function fmtOhlcHud(bar, prev) {
  if (!bar) return '';
  const ch = prev && prev.close ? (bar.close / prev.close - 1) * 100 : null;
  return `<span>O <b>${fmtMcVal(bar.open)}</b></span><span>H <b>${fmtMcVal(bar.high)}</b></span><span>L <b>${fmtMcVal(bar.low)}</b></span><span>C <b>${fmtMcVal(bar.close)}</b></span>${bar.volume ? `<span>Vol <b>${fmtBig(bar.volume)}</b></span>` : ''}${ch != null ? `<span class="${pctCls(ch)}">${fmtPct(ch)}</span>` : ''}`;
}
function paintOhlc(i) {
  const ohlc = $('#ohlc'), bars = chartState.bars; if (!ohlc || !bars || !bars.length) return;
  const idx = i == null ? bars.length - 1 : i;
  ohlc.hidden = false;
  ohlc.innerHTML = fmtOhlcHud(bars[idx], bars[idx - 1]);
}
function chartDate(time) {
  if (time && typeof time === 'object' && time.year) return new Date(time.year, (time.month || 1) - 1, time.day || 1);
  return new Date((+time || 0) * 1000);
}
function formatChartTick(time, type) {
  const d = chartDate(time);
  const T = window.LightweightCharts && window.LightweightCharts.TickMarkType;
  if (T && type === T.Year) return String(d.getFullYear());
  if (T && type === T.Month) return d.toLocaleString(undefined, { month: 'short' });
  if (T && type === T.DayOfMonth) return String(d.getDate());
  const withSec = (T && type === T.TimeWithSeconds) || type === 4;
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: withSec ? '2-digit' : undefined, hour12: false });
}
function formatChartTime(time) {
  const d = chartDate(time);
  const sec = chartState.tf === '1s' || chartState.tf === '1m';
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: sec ? '2-digit' : undefined, hour12: false });
}
function createMcChart(host) {
  const LW = window.LightweightCharts;
  if (!LW) { host.innerHTML = '<div class="chart-empty mut">Chart library failed to load.</div>'; return null; }
  host.innerHTML = '';
  const chart = LW.createChart(host, {
    autoSize: true,
    layout: { background: { color: '#000000' }, textColor: '#8e8e93', fontFamily: '-apple-system,BlinkMacSystemFont,system-ui,sans-serif', fontSize: 11, attributionLogo: false },
    grid: { vertLines: { color: 'rgba(255,255,255,0.06)' }, horzLines: { color: 'rgba(255,255,255,0.06)' } },
    rightPriceScale: { borderColor: 'rgba(255,255,255,0.08)', scaleMargins: { top: 0.08, bottom: 0.05 } },
    leftPriceScale: { visible: false },
    timeScale: { borderColor: 'rgba(255,255,255,0.08)', timeVisible: true, secondsVisible: chartState.tf === '1s' || chartState.tf === '1m', rightOffset: 4, tickMarkFormatter: formatChartTick },
    crosshair: {
      mode: LW.CrosshairMode.Normal,
      vertLine: { color: 'rgba(242,242,244,.35)', labelBackgroundColor: '#1c1c21' },
      horzLine: { color: 'rgba(242,242,244,.35)', labelBackgroundColor: '#1c1c21' }
    },
    localization: { priceFormatter: fmtMcVal, timeFormatter: formatChartTime },
    handleScroll: { vertTouchDrag: false }
  });
  const series = chart.addSeries(LW.CandlestickSeries, {
    upColor: '#32d074', downColor: '#ff5a52',
    borderUpColor: '#32d074', borderDownColor: '#ff5a52',
    wickUpColor: '#32d074', wickDownColor: '#ff5a52',
    lastValueVisible: true, priceLineVisible: true, priceLineColor: '#f2f2f4', priceLineWidth: 1,
    autoscaleInfoProvider: orig => {
      const res = orig();
      if (!res || !res.priceRange) return res;
      let min = res.priceRange.minValue, max = res.priceRange.maxValue;
      if (min < 0) min = 0;
      const st = chartState, fac = st.fac, plan = st.plan;
      if (plan) {
        const add = px => { if (px != null && isFinite(px)) { const v = fac ? px * fac : px; if (v < min) min = Math.max(0, v); if (v > max) max = v; } };
        if (plan.entry) { add(plan.entry[0]); add(plan.entry[1]); }
        add(plan.price); add(plan.stop); add(plan.tp); add(plan.tp1);
        if (plan.tp2 && max && (fac ? plan.tp2 * fac : plan.tp2) < max * 2.2) add(plan.tp2);
      }
      res.priceRange.minValue = min;
      res.priceRange.maxValue = max;
      return res;
    }
  });
  const volPane = chart.addPane();
  const vol = volPane.addSeries(LW.HistogramSeries, {
    lastValueVisible: false, priceLineVisible: false, priceFormat: { type: 'volume' }
  });
  try {
    const panes = chart.panes();
    if (panes[0] && panes[0].setStretchFactor) panes[0].setStretchFactor(3.5);
    volPane.setStretchFactor(1);
    vol.priceScale().applyOptions({ borderVisible: false });
  } catch (e) { console.warn('pane layout', e); }
  return { chart, series, vol };
}
async function loadAndDrawChart() {
  const st = chartState, host = $('#mcchart');
  if (!host || !st.kind) return;
  const tf = CHART_TF.find(t => t.id === st.tf);
  const seq = (st.seq = (st.seq || 0) + 1);
  host.innerHTML = '<div class="chart-empty mut">Loading chart…</div>';
  try {
    let raw = null, trades = [];
    if (st.kind === 'token' && st.pairAddress) {
      const jobs = [];
      if (tf.id !== '1s') jobs.push(fetchOhlcv(st, tf).then(v => { raw = v; }).catch(e => { st._ohlcvErr = e; }));
      jobs.push(fetchGtTrades(st.chain, st.pairAddress).then(v => { trades = v; }).catch(() => {}));
      await Promise.all(jobs);
    } else {
      raw = await fetchOhlcv(st, tf);
    }
    if (seq !== chartState.seq || !$('#mcchart')) return;
    const fac = mcFactor(st.mcap, st.price);
    st.fac = fac;
    let packed;
    if (st.kind === 'token') {
      st.ohlcvList = raw || [];
      const fresh = ticksFromTrades(trades, st.addr);
      const old = st.ticks || [];
      st.ticks = fresh.concat(old);
      st.ticks.sort((a, b) => a.t - b.t);
      if (st.price && isFinite(st.price) && st.price > 0) st.ticks.push({ t: Date.now() / 1000, px: st.price, vol: 0 });
      pruneTicks(st.ticks, tf.id === '1s' ? 1800 : 6 * 3600);
      const hist = tf.id === '1s' ? [] : st.ohlcvList;
      st.usdRows = mergeUsdRows(hist, st.ticks, TF_SEC[tf.id]);
      packed = packUsdToMc(st.usdRows, fac || 1);
    } else {
      packed = barsFromOhlcvList(raw || [], fac || 1);
    }
    if (!packed || !packed.candles.length) {
      host.innerHTML = `<div class="chart-empty mut">No candle data for this timeframe.${st.dsUrl ? `<br><a href="${esc(st.dsUrl)}" target="_blank" rel="noopener">Open DexScreener</a>` : ''}</div>`;
      if (st.kind === 'token') startLiveFeed(st);
      return;
    }
    if (st.chart) { try { st.chart.remove(); } catch {} st.chart = st.series = st.vol = st.markers = st.badges = null; }
    const inst = createMcChart(host);
    if (!inst) return;
    st.chart = inst.chart; st.series = inst.series; st.vol = inst.vol;
    applyPacked(st, packed, true);
    inst.chart.subscribeCrosshairMove(param => {
      if (!chartState.bars) return;
      if (!param || param.time == null) { paintOhlc(); return; }
      const i = chartState.bars.findIndex(b => b.time === param.time);
      if (i >= 0) paintOhlc(i);
    });
    if (st.kind === 'token') startLiveFeed(st);
  } catch (e) {
    console.warn('chart', e);
    if (seq !== chartState.seq || !$('#mcchart')) return;
    host.innerHTML = `<div class="chart-empty mut">Couldn't load candles.${st.dsUrl ? ` <a href="${esc(st.dsUrl)}" target="_blank" rel="noopener">Open DexScreener</a>` : ''}</div>`;
    if (st.kind === 'token') startLiveFeed(st);
  }
}
function bindMcChart(opts) {
  const same = chartState.key === opts.key && chartState.kind === opts.kind;
  const keepTf = same && chartState.tf ? chartState.tf : null;
  const keepTicks = same ? (chartState.ticks || []) : [];
  const keepOhlcv = same ? (chartState.ohlcvList || []) : [];
  destroyMcChart();
  const host = $('#mcchart'); if (!host) return;
  const saved = keepTf || ls.get('chartTf:' + opts.kind, opts.defaultTf);
  const tf = CHART_TF.some(t => t.id === saved) ? saved : opts.defaultTf;
  chartState = { ...opts, tf, lines: [], seq: 0, ticks: keepTicks, ohlcvList: keepOhlcv };
  document.querySelectorAll('[data-ctf]').forEach(b => {
    b.classList.toggle('on', b.dataset.ctf === tf);
    b.onclick = () => {
      chartState.tf = b.dataset.ctf;
      ls.set('chartTf:' + opts.kind, b.dataset.ctf);
      document.querySelectorAll('[data-ctf]').forEach(x => x.classList.toggle('on', x.dataset.ctf === chartState.tf));
      loadAndDrawChart();
    };
  });
  loadAndDrawChart();
}

function swingPlanCard(w, fac) {
  const L = w.levels; const t = L.mode === 'long' ? ['Entry zone', 'Stop-loss', 'Target'] : L.mode === 'dip' ? ['Buy-the-dip zone', 'Stop-loss', 'Target'] : ['Support (re-entry)', 'Stop if holding', 'Resistance'];
  return `<div class="card"><h3>Slow swing plan ${badge(w)}</h3>
    <div class="why" style="margin-bottom:10px">${esc(w.reason)}</div>
    <div class="levels"><div class="lv e"><small>${t[0]}</small>${levelMcRangeHTML(L.entry[0], L.entry[1], fac)}</div>
      <div class="lv s"><small>${t[1]}</small>${levelMcHTML(L.stop, fac)}</div><div class="lv t"><small>${t[2]}</small>${levelMcHTML(L.tp, fac)}</div></div>
    <div class="note">⏱ Suggested hold: <b>${esc(L.hold)}</b>. Swing score ${w.score > 0 ? '+' : ''}${w.score} (4h/daily trend weighted). Not a prediction.${fac ? ' Levels shown as market cap, with token price underneath.' : ''}</div></div>`;
}

// pull-to-refresh
(() => { let y0 = null, dy = 0; const ptr = $('#ptr');
  addEventListener('touchstart', e => { y0 = window.scrollY <= 0 && !e.target.closest('canvas') ? e.touches[0].clientY : null; dy = 0; }, { passive: true });
  addEventListener('touchmove', e => { if (y0 == null) return; dy = e.touches[0].clientY - y0; if (dy > 0) ptr.style.height = Math.min(dy * 0.5, 60) + 'px'; }, { passive: true });
  addEventListener('touchend', () => { if (y0 == null) return; if (dy > 90) { ptr.style.height = '48px'; refresh().finally(() => ptr.style.height = '0'); } else ptr.style.height = '0'; y0 = null; });
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
fast.age = ls.get('fastAge', 72); fast.sort = ls.get('fastSort', 'score');
const cached = ls.get('markets'); if (cached) { Object.assign(state, cached, { stale: true }); state.coins = state.coins.map(c => c.swing ? c : { ...c, swing: swingSignal(c) }); }
const cf = ls.get('fast'); if (cf) { try { fast.items = cf.items.map(i => toFastItem(i.pair, i)); fast.ts = cf.ts; } catch { } }
render();
refreshSlow(false);
if (route().name !== 'fast') refreshFast(false);
if ('serviceWorker' in navigator) addEventListener('load', () => {
  const had = !!navigator.serviceWorker.controller; let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (had && !reloaded) { reloaded = true; location.reload(); } });
  navigator.serviceWorker.register('sw.js').then(r => r.update && r.update()).catch(e => console.warn('SW', e));
});
