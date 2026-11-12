/* Fresh (pump.fun) strategy — pure functions, no I/O. Used by bot.js when Settings → Strategy is "Fresh" or "Both".
 * Goal: catch brand-new pump.fun tokens with real hype while they are fresh, take profit fast and get out BEFORE the dump. */
(function () {
  'use strict';
  const FRESH_DEFAULTS = {
    // Scout
    minAgeMin: 5, maxAgeH: 6, minMc: 30000, maxMc: 1000000,
    // Safety (kills)
    maxTop10Pct: 35,        // top-10 holders excl. bonding curve / AMM / lockers, % of supply
    maxDevPct: 10,          // creator holdings % of supply
    maxBundlePct: 20,       // bundled / insider cluster %
    max1hChg: 400,          // already +400% in 1h = too late
    minTxM5: 15,            // at least 15 trades in the last 5 min (alive)
    minBuyRatioM5: 0.52,    // buys share of 5-min trades
    // Analyst
    passScore: 60,
    // Executor
    posPct: 0.03, maxOpen: 6, maxImpactPct: 6, abortMovePct: 6, slippageBps: 300,
    // Exits (sell before the dump)
    slPct: 0.12,            // hard stop −12%
    tpPct: 0.25, tpSellPct: 0.5,   // take 50% off at +25%
    trailArmPct: 0.10,      // trailing armed after +10% peak
    trailPct: 0.10,         // 10% off the peak before TP
    trailAfterTpPct: 0.07,  // tighter 7% after TP
    maxHoldMin: 20,         // hard max hold
    staleMin: 6,            // stale exit: after 6 min if under +staleMinGain and volume fading
    staleMinGain: 0.05,
    dumpSellRatio: 2.0,     // last 30 s: sell SOL ≥ 2× buy SOL …
    dumpMinSol: 2,          // … and ≥ 2 SOL sold → exit
    whaleSellSupplyPct: 1.5,// one sell of ≥ 1.5% of supply → exit
    devSellExit: true,      // creator sells anything after entry → exit
    m5SellFlip: 1.5,        // DexScreener 5-min sells > 1.5× buys (≥ 20 trades) and not in profit → exit
    peakDropFastPct: 0.15   // −15% from peak within 60 s → exit even before trail arms
  };
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const num = v => (v == null || v === '' || !isFinite(+v)) ? null : +v;
  const cfg = s => Object.assign({}, FRESH_DEFAULTS, s || {});

  /** pump.fun origin: mint ends in "pump" or pair on pump.fun bonding curve / PumpSwap. */
  function isPumpToken(mint, dexId) { return /pump$/.test(String(mint || '')) || /^pump(fun|swap)$/.test(String(dexId || '')); }

  /** Scout gate on a DexScreener pair. */
  function scoutPair(p, now, s) {
    const c = cfg(s);
    if (!p || !p.baseToken) return { ok: false, why: 'no pair' };
    const ageMin = p.pairCreatedAt ? (now - p.pairCreatedAt) / 60000 : null;
    const mc = num(p.marketCap) || num(p.fdv) || 0;
    if (ageMin == null) return { ok: false, why: 'no age' };
    if (ageMin < c.minAgeMin) return { ok: false, why: 'too new', wait: true };
    if (ageMin > c.maxAgeH * 60) return { ok: false, why: 'too old' };
    if (mc < c.minMc) return { ok: false, why: 'mcap < min' };
    if (mc > c.maxMc) return { ok: false, why: 'mcap > max' };
    return { ok: true, ageMin, mc };
  }

  function holderOwnersToSkip(r) {
    const skip = new Set();
    (r.markets || []).forEach(m => { [m.pubkey, m.liquidityA, m.liquidityB, m.liquidityAAccount, m.liquidityBAccount].forEach(x => x && skip.add(String(x))); });
    Object.keys(r.knownAccounts || {}).forEach(k => { const t = String((r.knownAccounts[k] || {}).type || ''); if (/AMM|LOCKER/i.test(t)) skip.add(k); });
    return skip;
  }
  /** Top-10 holders % excluding bonding curve / AMM pools / lockers. */
  function top10Pct(r) {
    if (!r || !Array.isArray(r.topHolders)) return null;
    const skip = holderOwnersToSkip(r);
    const hs = r.topHolders.filter(h => h && !skip.has(String(h.owner)) && !skip.has(String(h.address)));
    return hs.slice(0, 10).reduce((a, h) => a + (num(h.pct) || 0), 0);
  }
  function devPct(r) {
    if (!r) return null;
    const sup = r.token && num(r.token.supply);
    const bal = sup && num(r.creatorBalance) ? +r.creatorBalance / sup * 100 : 0;
    const own = (r.topHolders || []).filter(h => h && r.creator && h.owner === r.creator).reduce((a, h) => a + (num(h.pct) || 0), 0);
    return Math.max(bal, own);
  }
  function bundlePct(r) {
    if (!r) return null;
    const sup = r.token && num(r.token.supply);
    let net = 0; if (sup) (r.insiderNetworks || []).forEach(n => { net += (num(n.currentHolding) || num(n.tokenAmount) || 0); });
    const ins = (r.topHolders || []).filter(h => h && h.insider).reduce((a, h) => a + (num(h.pct) || 0), 0);
    return Math.max(sup ? net / sup * 100 : 0, ins);
  }

  /** Safety kills (cheap market checks first, then RugCheck). report may be null → kill (cannot verify). */
  function safety(p, report, s) {
    const c = cfg(s);
    const kills = []; const kill = (code, reason) => kills.push({ code, reason }); const facts = {};
    const pc = p.priceChange || {}, m5 = (p.txns && p.txns.m5) || {};
    const n5 = (+m5.buys || 0) + (+m5.sells || 0), br = n5 ? (+m5.buys || 0) / n5 : 0;
    facts.tx5 = n5; facts.buyShare5 = Math.round(br * 100);
    if (num(pc.h1) != null && +pc.h1 > c.max1hChg) kill('f_pumped', 'already +' + Math.round(+pc.h1) + '% in 1h (> ' + c.max1hChg + '%)');
    if (n5 < c.minTxM5) kill('f_dead', 'only ' + n5 + ' trades in 5 min (< ' + c.minTxM5 + ')');
    else if (br < c.minBuyRatioM5) kill('f_selling', 'buys only ' + Math.round(br * 100) + '% of 5-min trades');
    if (!report) { kill('no_rugcheck', 'no RugCheck data yet'); return { pass: false, kills, facts }; }
    if (report.rugged) kill('rugged', 'RugCheck marks token rugged');
    if (report.mintAuthority) kill('mint_auth', 'mint authority not revoked');
    if (report.freezeAuthority) kill('freeze_auth', 'freeze authority not revoked');
    const t10 = top10Pct(report); facts.top10 = t10 == null ? null : Math.round(t10 * 10) / 10;
    if (t10 != null && t10 > c.maxTop10Pct) kill('f_top10', 'top-10 holders ' + t10.toFixed(1) + '% (> ' + c.maxTop10Pct + '%)');
    const dv = devPct(report); facts.devPct = Math.round((dv || 0) * 10) / 10;
    if (dv > c.maxDevPct) kill('dev_holds', 'dev holds ' + dv.toFixed(1) + '% (> ' + c.maxDevPct + '%)');
    const bun = bundlePct(report); facts.bundlePct = Math.round((bun || 0) * 10) / 10;
    if (bun > c.maxBundlePct) kill('bundled', 'bundled/insider ' + bun.toFixed(1) + '% (> ' + c.maxBundlePct + '%)');
    // Danger flags, ignoring bonding-curve/LP/liquidity wording (no LP exists before graduation) and holder flags handled above.
    const dang = (report.risks || []).filter(r => String(r.level || '').toLowerCase() === 'danger' && !/liquidity|lp |lp$|^lp|bundl|sniper|insider|holder|creator history/i.test(String(r.name || '')));
    if (dang.length) kill('rc_danger', 'RugCheck danger: ' + dang.map(r => r.name).join(', '));
    if ((report.risks || []).some(r => /rug/i.test(String(r.name || '')) && /creator|dev|deployer/i.test(String((r.name || '') + ' ' + (r.description || ''))))) kill('dev_rugs', 'creator has rug history');
    return { pass: kills.length === 0, kills, facts };
  }

  /** Hype score 0–100: buzz, buyer surge, buy pressure, volume acceleration, momentum (not parabolic). */
  function score(p, ctx) {
    const x = ctx || {};
    const pc = p.priceChange || {}, tx = p.txns || {}, v = p.volume || {};
    const t5 = tx.m5 || {}, t1 = tx.h1 || {};
    const n5 = (+t5.buys || 0) + (+t5.sells || 0), n1 = (+t1.buys || 0) + (+t1.sells || 0);
    const comps = {};
    // Buzz (DexScreener profile / boost / community takeover / ad / socials / graduation)
    const socials = ((p.info && p.info.socials) || []).length + ((p.info && p.info.websites) || []).length;
    comps.buzz = clamp((x.profile ? 30 : 0) + (x.boost ? 30 : 0) + (x.cto ? 25 : 0) + (x.ad ? 15 : 0) + Math.min(2, socials) * 15 + (x.migrated ? 20 : 0) + ((p.boosts && p.boosts.active) ? 15 : 0), 0, 100);
    // Buyer surge: 5-min trade rate vs the 1-h average (×12 = per hour); plus absolute activity
    const rate = n1 > 0 ? (n5 * 12) / n1 : (n5 > 0 ? 2 : 0);
    comps.surge = Math.round(clamp((rate - 0.8) / 1.7, 0, 1) * 70 + clamp(Math.log10(n5 + 1) / 2.3, 0, 1) * 30);
    // Buy pressure
    const b5 = n5 ? (+t5.buys || 0) / n5 : 0.5, b1 = n1 ? (+t1.buys || 0) / n1 : 0.5;
    comps.pressure = Math.round(clamp((0.6 * b5 + 0.4 * b1 - 0.45) / 0.25, 0, 1) * 100);
    // Volume acceleration: 5-min volume ×12 vs 1-h volume
    const va = (+v.h1 || 0) > 0 ? ((+v.m5 || 0) * 12) / (+v.h1) : ((+v.m5 || 0) > 0 ? 2 : 0);
    comps.volAccel = Math.round(clamp((va - 0.7) / 1.3, 0, 1) * 100);
    // Momentum: rising but not parabolic
    const m5 = +pc.m5 || 0, h1 = +pc.h1 || 0;
    const a = m5 <= 0 ? clamp(50 + m5 * 5, 0, 50) : m5 <= 25 ? 50 + m5 * 2 : Math.max(0, 100 - (m5 - 25) * 2.5);
    const b = h1 <= 0 ? clamp(40 + h1, 0, 40) : h1 <= 150 ? 40 + h1 * 0.4 : Math.max(0, 100 - (h1 - 150) * 0.3);
    comps.momentum = Math.round(clamp(0.6 * a + 0.4 * b, 0, 100));
    const W = { buzz: 20, surge: 25, pressure: 20, volAccel: 15, momentum: 20 };
    const total = Object.keys(W).reduce((s, k) => s + comps[k] * W[k], 0) / 100;
    return { score: Math.round(total), comps };
  }

  /** Trade-stream stats for a mint over a window (PumpPortal trades: {t, buy, sol, tokens, trader}). */
  function flowStats(trades, now, winMs) {
    const w = (trades || []).filter(t => now - t.t <= winMs);
    let buySol = 0, sellSol = 0, buys = 0, sells = 0;
    w.forEach(t => { if (t.buy) { buySol += t.sol; buys++; } else { sellSol += t.sol; sells++; } });
    return { buySol, sellSol, buys, sells, n: w.length };
  }

  /**
   * EXIT decision for a Fresh position. Checked on every 1 s tick AND immediately on every streamed trade.
   * pos: { entryPx, peakPx, openedAt, stopPx, tpTaken, creator, peakAt }
   * mark: worst current price (min of live sources); ctx: { pair, trades, now, rugged, pairGone, lastDevSellT, bigSell }
   */
  function decideExit(pos, mark, now, s, ctx) {
    const c = cfg(s); const x = ctx || {};
    const entry = +pos.entryPx; if (!entry || !(mark > 0)) return { action: 'hold' };
    const pnl = mark / entry - 1;
    const peak = Math.max(+pos.peakPx || entry, mark);
    const heldMin = (now - pos.openedAt) / 60000;
    const out = (reason, why, partial) => partial ? { action: 'sell_partial', pct: partial, reason, why, pnl, peak } : { action: 'sell_all', reason, why, pnl, peak };
    if (x.rugged || x.pairGone) return out('liquidity', 'rugged / pair gone');
    const stopPx = +pos.stopPx > 0 ? +pos.stopPx : entry * (1 - c.slPct);
    if (mark <= stopPx * (1 + 1e-9)) return out('stop', 'hard stop −' + Math.round(c.slPct * 100) + '%');
    if (c.devSellExit && x.lastDevSellT && x.lastDevSellT >= pos.openedAt) return out('dev_sell', 'creator sold');
    if (x.bigSell && x.bigSell.t >= pos.openedAt && now - x.bigSell.t < 30000) return out('whale_sell', 'one wallet sold ' + x.bigSell.pct.toFixed(1) + '% of supply');
    const f30 = flowStats(x.trades, now, 30000);
    if (f30.sellSol >= c.dumpMinSol && f30.sellSol >= c.dumpSellRatio * Math.max(f30.buySol, 0.01)) return out('dump', 'sell pressure ' + f30.sellSol.toFixed(1) + ' SOL sold vs ' + f30.buySol.toFixed(1) + ' bought (30 s)');
    const m5 = x.pair && x.pair.txns && x.pair.txns.m5;
    const sb = m5 ? (+m5.sells || 0) : 0, bb = m5 ? (+m5.buys || 0) : 0;
    if (sb + bb >= 20 && sb > bb * c.m5SellFlip && pnl < c.tpPct) return out('dump', 'sells flipped: ' + sb + ' sells vs ' + bb + ' buys (5 min)');
    if (pos.peakAt && now - pos.peakAt <= 60000 && peak > entry && mark <= peak * (1 - c.peakDropFastPct)) return out('dump', 'fell ' + Math.round((1 - mark / peak) * 100) + '% from peak within 60 s');
    if (heldMin >= c.maxHoldMin) return out('time', 'max hold ' + c.maxHoldMin + ' min');
    if (!pos.tpTaken && c.tpPct > 0 && pnl >= c.tpPct) return out('tp', 'take profit +' + Math.round(pnl * 100) + '%', c.tpSellPct);
    const armed = pos.tpTaken || (peak / entry - 1) >= c.trailArmPct;
    const tp = pos.tpTaken ? c.trailAfterTpPct : c.trailPct;
    if (armed && mark <= peak * (1 - tp)) return out('trail', 'trailing stop ' + Math.round(tp * 100) + '% off peak');
    if (heldMin >= c.staleMin && pnl < c.staleMinGain) {
      const f2 = flowStats(x.trades, now, 120000);
      const fading = x.trades ? f2.n < 6 || f2.buySol < f2.sellSol : (m5 ? sb + bb < 10 : false);
      if (fading) return out('stale', 'no momentum after ' + Math.round(heldMin) + ' min');
    }
    return { action: 'hold', pnl, peak };
  }

  window.FreshStrategy = { FRESH_DEFAULTS, cfg, isPumpToken, scoutPair, safety, score, top10Pct, devPct, bundlePct, flowStats, decideExit };
  if (typeof module !== 'undefined') module.exports = window.FreshStrategy;
})();
