/* v13: display currency (USD / CZK). Internal accounting stays USD — this only converts for display/input. */
(function () {
  const KC = 'ms:currency', KR = 'ms:fxRate';
  const TTL = 60 * 60e3;
  const FALLBACK_CZK = 22.0; // used only until the first successful fetch
  const rd = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } };
  const wr = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
  let cur = rd(KC, 'USD') === 'CZK' ? 'CZK' : 'USD';
  let fx = rd(KR, null); // { czk, ts, src }
  let inflight = null;
  const listeners = [];
  function rate() { return cur === 'CZK' ? ((fx && fx.czk > 0) ? fx.czk : FALLBACK_CZK) : 1; }
  function num(n, minD, maxD) {
    return n.toLocaleString(cur === 'CZK' ? 'cs-CZ' : 'en-US', { minimumFractionDigits: minD, maximumFractionDigits: maxD });
  }
  /** wrap a formatted number string with the currency symbol */
  function wrap(sign, s) { return cur === 'CZK' ? sign + s + '\u00a0Kč' : sign + '$' + s; }
  /** toFixed-style string in the display locale */
  function fixed(n, d) { const s = n.toFixed(d); return cur === 'CZK' ? s.replace('.', ',') : s; }
  async function fetchRate() {
    const srcs = [
      ['open.er-api.com', 'https://open.er-api.com/v6/latest/USD', j => j && j.rates && +j.rates.CZK],
      ['frankfurter.dev', 'https://api.frankfurter.dev/v1/latest?base=USD&symbols=CZK', j => j && j.rates && +j.rates.CZK]
    ];
    for (const [src, url, pick] of srcs) {
      try {
        const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 8000);
        const r = await fetch(url, { signal: ctl.signal, cache: 'no-store' }); clearTimeout(tm);
        if (!r.ok) continue;
        const v = pick(await r.json());
        if (v > 5 && v < 100) { fx = { czk: v, ts: Date.now(), src }; wr(KR, fx); emit(); return fx; }
      } catch {}
    }
    return null;
  }
  function refresh(force) {
    if (cur !== 'CZK') return Promise.resolve(fx);
    if (!force && fx && Date.now() - fx.ts < TTL) return Promise.resolve(fx);
    if (!inflight) inflight = fetchRate().finally(() => { inflight = null; });
    return inflight;
  }
  function emit() { listeners.forEach(f => { try { f(); } catch {} }); }
  function setCurrency(c) { cur = c === 'CZK' ? 'CZK' : 'USD'; wr(KC, cur); emit(); refresh(); }
  setInterval(() => refresh(), 10 * 60e3);
  refresh();
  window.FX = {
    get currency() { return cur; },
    setCurrency, refresh, rate, wrap, num, fixed,
    toLocal: usd => usd * rate(),
    fromLocal: v => v / rate(),
    symbol: () => cur === 'CZK' ? 'Kč' : '$',
    info: () => ({ currency: cur, rate: rate(), ts: fx && fx.ts, src: fx && fx.src, approx: cur === 'CZK' && !(fx && fx.czk > 0) }),
    onChange: f => listeners.push(f)
  };
})();
