/* Meme Terminal — conservative Fast-only flip strategy (pure functions, no I/O). */
(function (root) {
  'use strict';

  const DEFAULTS = {
    mode: 'PAPER',
    posPct: 0.10,
    maxOpen: 2,
    tpPct: 0.35,
    tpSellPct: 0.50,
    trailPct: 0.12,
    trailArmPct: 0.20,
    slPct: 0.12,
    dailyLossPct: 0.20,
    maxHoldMin: 90,
    minSolReserve: 0.02,
    slippageBps: 150,
    minLiq: 30000,
    minAgeMin: 25,
    maxAgeH: 72,
    minScore: 62,
    scoreScans: 3,
    cooldownMin: 40,
    consecLossLimit: 2,
    max1hChg: 300,
    maxImpactPct: 2,
    abortMovePct: 3,
    liqDropPct: 0.30,
    minVolM5: 1000,
    minVolH1: 8000,
    paperStartUsd: 200,
    rpcUrl: 'https://solana-rpc.publicnode.com'
  };

  const cloneDefaults = () => Object.assign({}, DEFAULTS);

  const pairLiq = p => (p && p.liquidity && +p.liquidity.usd) || 0;
  const pairVol = (p, k) => (p && p.volume && +p.volume[k]) || 0;
  const buysSells = t => ({ b: (t && t.buys) || 0, s: (t && t.sells) || 0 });
  const ageMin = (p, now) => p && p.pairCreatedAt ? (now - p.pairCreatedAt) / 60000 : Infinity;

  function isLpHolder(h, report) {
    const addr = String((h && (h.address || h.owner)) || '').toLowerCase();
    const owner = String((h && h.owner) || '').toLowerCase();
    const lp = new Set();
    (report.markets || []).forEach(m => {
      if (m.pubkey) lp.add(String(m.pubkey).toLowerCase());
      if (m.liquidityA) lp.add(String(m.liquidityA).toLowerCase());
      if (m.liquidityB) lp.add(String(m.liquidityB).toLowerCase());
      if (m.mintLP) lp.add(String(m.mintLP).toLowerCase());
      if (m.lp && m.lp.lpMint) lp.add(String(m.lp.lpMint).toLowerCase());
    });
    const known = report.knownAccounts || {};
    Object.keys(known).forEach(k => {
      const v = known[k];
      const typ = String((v && (v.type || v.kind || v.name)) || '').toLowerCase();
      if (/lp|pool|amm|market|vault/.test(typ)) lp.add(k.toLowerCase());
    });
    return lp.has(addr) || lp.has(owner);
  }

  function topHolderPctExLp(report, n) {
    const list = (report && report.topHolders) || [];
    const ex = list.filter(h => !isLpHolder(h, report));
    return ex.slice(0, n || 10).reduce((s, h) => s + (+h.pct || +h.percentage || +h.percent || 0), 0);
  }

  function lpLockedOrBonded(report) {
    if (!report) return false;
    const top = +report.lpLockedPct;
    if (isFinite(top) && top >= 90) return true;
    const mk = report.markets || [];
    if (mk.some(m => m && m.lp && +m.lp.lpLockedPct >= 90)) return true;
    const pad = report.launchpad || {};
    const name = String(pad.name || pad.platform || report.deployPlatform || '').toLowerCase();
    if (/pump/.test(name)) return true;
    if (mk.some(m => /pump/i.test(String(m.marketType || m.dexId || '')))) return true;
    return false;
  }

  function mintOrFreeze(report) {
    if (!report) return { mint: true, freeze: true };
    const mint = report.mintAuthority || (report.token && report.token.mintAuthority) || null;
    const freeze = report.freezeAuthority || (report.token && report.token.freezeAuthority) || null;
    const zero = a => !a || a === '11111111111111111111111111111111' || a === 'null';
    return { mint: !zero(mint) ? mint : null, freeze: !zero(freeze) ? freeze : null };
  }

  function dangerRisks(report) {
    return ((report && report.risks) || []).filter(r => {
      const lvl = String(r.level || r.severity || '').toLowerCase();
      return lvl === 'danger' || lvl === 'critical' || lvl === 'high';
    });
  }

  /** Scanner: Fast tab, Solana only, never Slow coins. */
  function scanCandidates(items, now, settings) {
    const s = Object.assign({}, DEFAULTS, settings || {});
    const out = [];
    const whySkip = [];
    (items || []).forEach(it => {
      const p = it.pair || it;
      const reasons = [];
      if ((it.chain || p.chainId) !== 'solana') reasons.push('not solana');
      if (pairLiq(p) < s.minLiq) reasons.push('liq');
      const age = ageMin(p, now);
      if (age < s.minAgeMin) reasons.push('too new');
      if (age > s.maxAgeH * 60) reasons.push('too old');
      if (it.risk && it.risk.label === 'EXTREME') reasons.push('extreme risk');
      const score = it.sig ? it.sig.score : (it.score || 0);
      if (score < s.minScore) reasons.push('score');
      const v5 = pairVol(p, 'm5'), v1 = pairVol(p, 'h1');
      if (v5 < s.minVolM5 && v1 < s.minVolH1) reasons.push('thin volume');
      const tx = p.txns || {};
      const m5 = buysSells(tx.m5), h1 = buysSells(tx.h1);
      if (m5.b + m5.s > 0 && m5.b <= m5.s) reasons.push('5m sells >= buys');
      if (h1.b + h1.s > 0 && h1.b <= h1.s) reasons.push('1h sells >= buys');
      const ch1 = +(p.priceChange && p.priceChange.h1) || 0;
      if (ch1 >= s.max1hChg) reasons.push('parabolic 1h');
      if (reasons.length) whySkip.push({ key: it.key || it.addr, reasons });
      else out.push(it);
    });
    out.sort((a, b) => ((b.sig && b.sig.score) || 0) - ((a.sig && a.sig.score) || 0));
    return { candidates: out, scanned: (items || []).length, whySkip };
  }

  /**
   * Analyst safety gate: ALL must pass.
   * quoteBuy/quoteSell: { impactPct, ok }
   * priorScores: number[] most recent last
   * ticks: [{t, px}] optional 1m/recent prices
   * buyerTrend: optional { prevH1Buys, prevM5Buys }
   */
  function analyzeSafety(input, settings) {
    const s = Object.assign({}, DEFAULTS, settings || {});
    const reasons = [];
    const it = input.item || input;
    const p = it.pair || input.pair || {};
    const report = input.rug || null;
    const now = input.now || Date.now();

    if ((it.chain || p.chainId) !== 'solana') reasons.push('not solana');
    if (pairLiq(p) < s.minLiq) reasons.push('liquidity < $30K');
    const age = ageMin(p, now);
    if (age < s.minAgeMin) reasons.push('pair younger than ' + s.minAgeMin + 'm');
    if (it.risk && it.risk.label === 'EXTREME') reasons.push('EXTREME risk flag');

    if (!report) reasons.push('no rugcheck');
    else {
      if (report.rugged) reasons.push('marked rugged');
      const auth = mintOrFreeze(report);
      if (auth.mint) reasons.push('mint authority enabled');
      if (auth.freeze) reasons.push('freeze authority enabled');
      if (!lpLockedOrBonded(report)) reasons.push('LP not locked/burned or unbonded');
      const dang = dangerRisks(report);
      if (dang.length) reasons.push('danger risks: ' + dang.map(r => r.name || r).join(', '));
      const scoreN = +report.score_normalised;
      if (isFinite(scoreN) && scoreN >= 25) reasons.push('rugcheck score danger (' + scoreN + ')');
      const top = topHolderPctExLp(report, 10);
      if (top > 30) reasons.push('top 10 holders (ex-LP) ' + top.toFixed(1) + '%');
    }

    const qIn = input.quoteBuy;
    if (qIn) {
      const imp = Math.abs(+qIn.impactPct || 0);
      if (!qIn.ok) reasons.push('no buy quote');
      else if (imp > s.maxImpactPct) reasons.push('buy impact ' + imp.toFixed(2) + '%');
    } else reasons.push('missing buy quote');

    const qOut = input.quoteSell;
    if (qOut) {
      const imp = Math.abs(+qOut.impactPct || 0);
      if (!qOut.ok) reasons.push('sell quote failed (honeypot)');
      else if (imp > Math.max(s.maxImpactPct * 2, 6)) reasons.push('sell impact ' + imp.toFixed(2) + '% (honeypot risk)');
    } else reasons.push('missing sell quote (honeypot check)');

    const scores = input.priorScores || [];
    if (scores.length < s.scoreScans) reasons.push('score not yet stable (' + scores.length + '/' + s.scoreScans + ' scans)');
    else if (scores.slice(-s.scoreScans).some(v => v < s.minScore)) reasons.push('score dipped below threshold');

    const mom = momentumEntry(input.ticks || [], p, s);
    if (!mom.ok) reasons.push(mom.reason);

    if (input.buyerTrend) {
      const t = input.buyerTrend;
      if (t.prevH1Buys != null && buysSells((p.txns || {}).h1).b < t.prevH1Buys) reasons.push('unique/buy count not rising');
    }

    return { ok: reasons.length === 0, reasons, score: (it.sig && it.sig.score) || 0 };
  }

  function ema(values, n) {
    if (!values || values.length < n) return null;
    const k = 2 / (n + 1);
    let e = values.slice(0, n).reduce((a, b) => a + b, 0) / n;
    for (let i = n; i < values.length; i++) e = values[i] * k + e * (1 - k);
    return e;
  }

  function vwap(ticks) {
    let pv = 0, v = 0;
    (ticks || []).forEach(t => {
      const w = t.vol || 1;
      pv += t.px * w; v += w;
    });
    return v ? pv / v : null;
  }

  function momentumEntry(ticks, pair, settings) {
    const px = +(pair && pair.priceUsd) || (ticks.length && ticks[ticks.length - 1].px) || 0;
    if (!px) return { ok: false, reason: 'no price' };
    const pc = (pair && pair.priceChange) || {};
    const h1 = +pc.h1 || 0, m5 = +pc.m5 || 0;
    if (h1 >= (settings.max1hChg || 300)) return { ok: false, reason: 'chasing parabolic 1h' };
    if (h1 < 0 && m5 < 0) return { ok: false, reason: '5m and 1h both down' };

    const closes = (ticks || []).map(t => t.px).filter(x => x > 0);
    if (closes.length >= 15) {
      const e9 = ema(closes, 9), e21 = ema(closes, Math.min(21, closes.length));
      if (e9 != null && e21 != null && e9 < e21) return { ok: false, reason: 'EMA trend not up' };
      const hour = (ticks || []).filter(t => t.t >= ((ticks[ticks.length - 1].t) - 3600));
      const vw = vwap(hour.length ? hour : ticks);
      if (vw && px < vw) return { ok: false, reason: 'price below hourly VWAP' };
      const recent = closes.slice(-15);
      const hi = Math.max.apply(null, recent);
      if (px >= hi * 0.995) return { ok: false, reason: 'at local top, wait for pullback' };
    } else {
      // Without a 1m series, require modest 5m (not a vertical spike) and positive 1h.
      if (h1 < 3) return { ok: false, reason: '1h momentum too weak' };
      if (m5 > 40) return { ok: false, reason: '5m already extended, wait for pullback' };
      if (m5 < -12) return { ok: false, reason: '5m dump in progress' };
    }
    return { ok: true, reason: 'momentum+pullback' };
  }

  function decideExit(pos, px, now, settings, pair) {
    const s = Object.assign({}, DEFAULTS, settings || {});
    if (!pos || !px || px <= 0) return { action: 'hold' };
    const entry = +pos.entryPx;
    if (!entry) return { action: 'hold' };
    const pnl = px / entry - 1;
    const peak = Math.max(+pos.peakPx || entry, px);
    const heldMin = (now - pos.openedAt) / 60000;

    if (pnl <= -s.slPct) return { action: 'sell_all', reason: 'stop', sl: true, pnl, peak };

    if (pos.entryLiq && pair && pairLiq(pair) > 0 && pairLiq(pair) < pos.entryLiq * (1 - s.liqDropPct)) {
      return { action: 'sell_all', reason: 'liquidity', pnl, peak };
    }
    const tx = pair && pair.txns && pair.txns.m5;
    const bs = buysSells(tx);
    if (bs.s + bs.b >= 8 && bs.s > bs.b * 1.8 && pnl < 0.15) {
      return { action: 'sell_all', reason: 'sell_spike', pnl, peak };
    }
    if (heldMin >= s.maxHoldMin) return { action: 'sell_all', reason: 'time', pnl, peak };

    if (!pos.tpTaken && pnl >= s.tpPct) {
      return { action: 'sell_partial', pct: s.tpSellPct, reason: 'tp', pnl, peak };
    }
    const armed = pos.tpTaken || (peak / entry - 1) >= s.trailArmPct;
    if (armed && px <= peak * (1 - s.trailPct)) {
      return { action: 'sell_all', reason: 'trail', pnl, peak };
    }
    return { action: 'hold', pnl, peak };
  }

  function abortIfMoved(signalPx, quotePx, settings) {
    const s = Object.assign({}, DEFAULTS, settings || {});
    if (!signalPx || !quotePx) return { abort: true, reason: 'missing price' };
    const moved = Math.abs(quotePx / signalPx - 1) * 100;
    if (moved > s.abortMovePct) return { abort: true, reason: 'price moved ' + moved.toFixed(2) + '% since signal', moved };
    return { abort: false, moved };
  }

  function canOpenMore(state, settings, now) {
    const s = Object.assign({}, DEFAULTS, settings || {});
    if (state.halted) return { ok: false, reason: state.halted };
    if ((now || Date.now()) < (state.cooldownUntil || 0)) return { ok: false, reason: 'cooldown after losses' };
    const open = (state.positions || []).length;
    if (open >= s.maxOpen) return { ok: false, reason: 'max open positions' };
    const eq = +state.equityUsd || +state.cashUsd || 0;
    const start = +state.dayStartEquity || eq;
    if (start > 0 && (start - eq) / start >= s.dailyLossPct) return { ok: false, reason: 'daily loss cap' };
    return { ok: true };
  }

  function positionUsd(equityUsd, settings, reserveUsd) {
    const s = Object.assign({}, DEFAULTS, settings || {});
    const reserve = Math.max(0, +reserveUsd || 0);
    const spendable = Math.max(0, equityUsd - reserve);
    return Math.min(spendable, equityUsd * s.posPct);
  }

  function applyBuy(state, fill) {
    const st = state;
    const cost = +fill.costUsd;
    st.cashUsd = +(st.cashUsd - cost).toFixed(8);
    st.positions = st.positions || [];
    st.positions.push({
      id: fill.id,
      mint: fill.mint,
      symbol: fill.symbol,
      icon: fill.icon || '',
      entryPx: +fill.px,
      entryMc: fill.mc || null,
      entryLiq: fill.liq || 0,
      amount: +fill.amount,
      costUsd: cost,
      openedAt: fill.t,
      peakPx: +fill.px,
      tpTaken: false,
      pairAddress: fill.pairAddress || '',
      chain: 'solana'
    });
    return st;
  }

  function applySell(state, pos, fraction, fill) {
    const frac = Math.max(0, Math.min(1, fraction));
    const qty = pos.amount * frac;
    const proceeds = +fill.usd;
    const costCut = pos.costUsd * frac;
    const pnl = proceeds - costCut;
    pos.amount = +(pos.amount - qty).toFixed(12);
    pos.costUsd = +(pos.costUsd - costCut).toFixed(8);
    if (frac >= 0.999 || pos.amount * (fill.px || pos.entryPx) < 0.02) {
      state.positions = (state.positions || []).filter(p => p.id !== pos.id);
    } else if (fill.reason === 'tp') {
      pos.tpTaken = true;
    }
    state.cashUsd = +(state.cashUsd + proceeds).toFixed(8);
    return { pnl, qty, proceeds, closed: !(state.positions || []).some(p => p.id === pos.id) };
  }

  function markToMarket(state, prices) {
    const posVal = (state.positions || []).reduce((s, p) => s + p.amount * (prices[p.mint] || p.entryPx || 0), 0);
    return (state.cashUsd || 0) + posVal;
  }

  function updateDayAndHalt(state, equityUsd, settings, now) {
    const s = Object.assign({}, DEFAULTS, settings || {});
    const d = new Date(now || Date.now());
    const key = d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
    if (state.dayKey !== key) {
      state.dayKey = key;
      state.dayStartEquity = equityUsd;
    }
    const start = +state.dayStartEquity || equityUsd;
    if (start > 0 && (start - equityUsd) / start >= s.dailyLossPct) {
      state.halted = 'daily loss cap';
      return true;
    }
    return false;
  }

  function recordLossStreak(state, pnl, settings, now) {
    const s = Object.assign({}, DEFAULTS, settings || {});
    if (pnl < 0) {
      state.consecLosses = (state.consecLosses || 0) + 1;
      if (state.consecLosses >= s.consecLossLimit) {
        state.cooldownUntil = (now || Date.now()) + s.cooldownMin * 60e3;
        state.consecLosses = 0;
        return { cooldown: true, until: state.cooldownUntil };
      }
    } else if (pnl > 0) state.consecLosses = 0;
    return { cooldown: false };
  }

  function tradeStats(trades) {
    const closed = (trades || []).filter(t => t.kind === 'sell' || t.kind === 'stop');
    const wins = closed.filter(t => (t.pnlUsd || 0) > 0);
    const losses = closed.filter(t => (t.pnlUsd || 0) <= 0);
    const avg = arr => arr.length ? arr.reduce((s, t) => s + (t.pnlUsd || 0), 0) / arr.length : 0;
    return {
      trades: closed.length,
      wins: wins.length,
      losses: losses.length,
      winRate: closed.length ? wins.length / closed.length : 0,
      avgWin: avg(wins),
      avgLoss: avg(losses),
      net: closed.reduce((s, t) => s + (t.pnlUsd || 0), 0)
    };
  }

  function maxDrawdown(equity) {
    let peak = -Infinity, maxDd = 0;
    (equity || []).forEach(p => {
      const v = typeof p === 'number' ? p : p.v;
      if (v > peak) peak = v;
      if (peak > 0) maxDd = Math.max(maxDd, (peak - v) / peak);
    });
    return maxDd;
  }

  /** Walk a close[] series as if we entered at entryIdx, for exit-logic tests / backtests. */
  function walkExit(closes, entryIdx, settings, opt) {
    const s = Object.assign({}, DEFAULTS, settings || {});
    const start = closes[entryIdx];
    const pos = { entryPx: start, peakPx: start, openedAt: entryIdx * 60e3, tpTaken: false, amount: 1, costUsd: start, id: 't', entryLiq: (opt && opt.liq) || 100000 };
    const fills = [];
    let qty = 1, cash = 0;
    for (let i = entryIdx + 1; i < closes.length; i++) {
      const px = closes[i];
      const d = decideExit(pos, px, i * 60e3, s, opt && opt.pairs && opt.pairs[i]);
      pos.peakPx = Math.max(pos.peakPx, px);
      if (d.action === 'hold') continue;
      const frac = d.action === 'sell_partial' ? d.pct : 1;
      const sold = qty * frac;
      cash += sold * px;
      qty -= sold;
      fills.push({ i, px, reason: d.reason, frac, pnl: (px / start - 1) });
      if (d.reason === 'tp') pos.tpTaken = true;
      if (qty <= 1e-9 || d.action === 'sell_all') { qty = 0; break; }
    }
    if (qty > 0) cash += qty * closes[closes.length - 1];
    return { fills, pnlPct: cash / start - 1, exitReason: (fills[fills.length - 1] || {}).reason || 'open' };
  }

  const api = {
    DEFAULTS, cloneDefaults, scanCandidates, analyzeSafety, momentumEntry,
    decideExit, abortIfMoved, canOpenMore, positionUsd, applyBuy, applySell,
    markToMarket, updateDayAndHalt, recordLossStreak, tradeStats, maxDrawdown,
    walkExit, topHolderPctExLp, lpLockedOrBonded, mintOrFreeze, ema, vwap
  };
  root.BotStrategy = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
