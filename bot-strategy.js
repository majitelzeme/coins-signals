/* Meme Terminal — conservative Fast-only flip strategy (pure functions, no I/O). */
(function (root) {
  'use strict';

  /* v10: 6-agent pipeline defaults (Scout → Filter → Analyst → Executor → Risk → Logger). */
  const DEFAULTS = {
    mode: 'PAPER',
    pipelineV: 1,
    // Scout
    scoutMinAgeMin: 30,
    scoutMaxAgeH: 72,
    scoutMinMc: 300000,
    scoutMaxMc: 20000000,
    // Filter (kills)
    minLiqMcPct: 25,
    minLpLockedPct: 90,
    maxDevPct: 3,
    maxDeadLaunches: 2,
    deadLaunchMc: 5000,
    maxBundlePct: 10,
    max1hChg: 80,
    minLiq: 8000,
    // Analyst
    passScore: 70,
    weights: { momentum: 25, buyers: 20, buySell: 15, holders: 15, liqMc: 10, smart: 15 },
    smartWallets: [],
    // Executor
    posPct: 0.08,
    maxOpen: 8,
    minPosSol: 0.02,
    maxImpactPct: 4,
    abortMovePct: 3,
    slippageBps: 150,
    // Risk
    slPct: 0.06,
    trailArmPct: 0.12,
    trailPct: 0.06,
    tpPct: 0,
    tpSellPct: 0.5,
    maxHoldMin: 120,
    dailyLossPct: 0.20,
    maxSellImpactPct: 8,
    liqDropPct: 0.25,
    emergencyQuoteLiq: 2000,
    tokenCooldownMin: 30,
    consecLossLimit: 0,
    cooldownMin: 40,
    minSolReserve: 0.02,
    paperStartUsd: 200,
    rpcUrl: 'https://solana-rpc.publicnode.com',
    // legacy (v9 scanner/analyzeSafety; kept for compatibility)
    minAgeMin: 5, maxAgeH: 120, minScore: 52, scoreScans: 1, maxTopHoldersPct: 40,
    minQuoteLiq: 5000, minLiqMcRatio: 0.05, maxInsiderPct: 12, minBuySellRatio: 1.15, minVolM5: 1000, minVolH1: 8000
  };
  /** v9 defaults, kept so the legacy unit tests still describe the old scanner. */
  const LEGACY_DEFAULTS = {
    mode: 'PAPER', posPct: 0.05, maxOpen: 10, tpPct: 0.35, tpSellPct: 0.50, trailPct: 0.12, trailArmPct: 0.20, slPct: 0.12,
    dailyLossPct: 0.20, maxHoldMin: 90, minSolReserve: 0.02, slippageBps: 150, minLiq: 8000, minAgeMin: 5, maxAgeH: 120,
    minScore: 52, scoreScans: 1, cooldownMin: 40, consecLossLimit: 0, max1hChg: 180, maxImpactPct: 4, maxTopHoldersPct: 40,
    abortMovePct: 3, liqDropPct: 0.25, minQuoteLiq: 5000, minLiqMcRatio: 0.05, tokenCooldownMin: 30, minPosSol: 0.02,
    maxDevPct: 5, maxInsiderPct: 12, maxSellImpactPct: 8, emergencyQuoteLiq: 2000, minBuySellRatio: 1.15, minVolM5: 1000,
    minVolH1: 8000, paperStartUsd: 200, rpcUrl: 'https://solana-rpc.publicnode.com'
  };

  const cloneDefaults = () => { const o = Object.assign({}, DEFAULTS); o.weights = Object.assign({}, DEFAULTS.weights); o.smartWallets = []; return o; };

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

  function isPumpOrGraduated(report, pair) {
    const bits = [];
    if (report) {
      const pad = report.launchpad || {};
      bits.push(pad.name, pad.platform, pad.launchpad, report.deployPlatform,
        report.tokenMeta && (report.tokenMeta.launchpad || report.tokenMeta.platform));
      (report.markets || []).forEach(m => bits.push(m.marketType, m.dexId, m.source, m.platform, m.name, m.pubkey));
      if (report.pumpFun || report.bonded || report.graduated || report.lpBurned) return true;
    }
    if (pair) {
      bits.push(pair.dexId, pair.dexId === 'pumpfun' && 'pump',
        Array.isArray(pair.labels) ? pair.labels.join(' ') : pair.labels,
        pair.info && pair.info.dex);
    }
    const s = bits.filter(Boolean).join(' ').toLowerCase();
    return /pump|pumpswap|pumpfun|moonshot|letsbonk|launchlab|raydium launch|graduat|bonded|bonding/.test(s);
  }

  function lpLockedOrBonded(report, pair) {
    if (isPumpOrGraduated(report, pair)) return true;
    if (!report) return false;
    const top = +report.lpLockedPct;
    if (isFinite(top) && top >= 90) return true;
    const mk = report.markets || [];
    if (mk.some(m => m && m.lp && (+m.lp.lpLockedPct >= 90 || m.lp.lpBurned))) return true;
    if (report.lpBurned || report.burned) return true;
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
      const name = String(r.name || r.displayName || r.description || '').toLowerCase();
      if (lvl === 'danger' || lvl === 'critical') return true;
      if ((lvl === 'high' || lvl === 'danger') && /honeypot|rugged|freeze authority|mint authority/.test(name)) return true;
      // LP-pull / bundle / sniper style flags should block even at "warn".
      if (lvl !== 'info' && /low liquidity|lp (removed|unlocked|pulled)|can.*(rug|withdraw)|bundl|sniper|honeypot/.test(name)) return true;
      return false;
    });
  }

  function pairMc(p) {
    return (p && (+p.marketCap || +p.fdv || +p.fdvUsd)) || 0;
  }

  /** SOL/quote-side USD liquidity — the side you actually exit through. */
  function quoteLiqUsd(p, solPx, report) {
    let best = 0;
    if (report && report.markets) {
      (report.markets || []).forEach(m => {
        const q = m && m.lp && +m.lp.quoteUSD;
        if (q > best) best = q;
      });
      if (report.totalStableLiquidity && +report.totalStableLiquidity > best) best = +report.totalStableLiquidity;
    }
    if (p && p.liquidity) {
      const usd = +p.liquidity.usd || 0;
      const q = +p.liquidity.quote;
      const px = +solPx || 0;
      if (q > 0 && px > 0) {
        const qUsd = q * px;
        if (!usd || qUsd <= usd * 1.8) best = Math.max(best, qUsd);
      }
    }
    return best;
  }

  function creatorPct(report) {
    if (!report) return 0;
    const cr = String(report.creator || '').toLowerCase();
    if (!cr) return 0;
    let pct = 0;
    (report.topHolders || []).forEach(h => {
      const a = String(h.address || '').toLowerCase();
      const o = String(h.owner || '').toLowerCase();
      if (a === cr || o === cr) pct += +h.pct || +h.percentage || +h.percent || 0;
    });
    return pct;
  }

  function insiderPct(report) {
    if (!report) return 0;
    let pct = 0;
    (report.topHolders || []).forEach(h => {
      if (h.insider || h.isInsider) pct += +h.pct || +h.percentage || +h.percent || 0;
    });
    return pct;
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
      const ratio = s.minBuySellRatio || 1;
      if (m5.b + m5.s >= 8 && m5.b < m5.s * ratio) reasons.push('5m sells >= buys');
      else if (m5.b + m5.s > 0 && m5.b <= m5.s) reasons.push('5m sells >= buys');
      if (h1.b + h1.s > 0 && h1.b <= h1.s) reasons.push('1h sells >= buys');
      const ch1 = +(p.priceChange && p.priceChange.h1) || 0;
      const cm5 = +(p.priceChange && p.priceChange.m5) || 0;
      if (ch1 >= s.max1hChg) reasons.push('parabolic 1h');
      if (cm5 <= -8) reasons.push('5m dump');
      const mc = pairMc(p);
      if (mc > 0 && s.minLiqMcRatio && pairLiq(p) / mc < s.minLiqMcRatio) reasons.push('liq/mcap thin');
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
    if (pairLiq(p) < s.minLiq) reasons.push('liquidity < $' + Math.round(s.minLiq / 1000) + 'K');
    const qLiq = quoteLiqUsd(p, input.solPx, report);
    if (s.minQuoteLiq && qLiq > 0 && qLiq < s.minQuoteLiq) reasons.push('quote liquidity $' + Math.round(qLiq));
    if (report && +report.totalMarketLiquidity > 0 && +report.totalMarketLiquidity < s.minLiq) reasons.push('total liquidity $' + Math.round(+report.totalMarketLiquidity));
    const mc = pairMc(p);
    if (mc > 0 && s.minLiqMcRatio && pairLiq(p) / mc < s.minLiqMcRatio) reasons.push('liq/mcap ' + (100 * pairLiq(p) / mc).toFixed(1) + '%');
    const age = ageMin(p, now);
    if (age < s.minAgeMin) reasons.push('pair younger than ' + s.minAgeMin + 'm');
    if (it.risk && it.risk.label === 'EXTREME') reasons.push('EXTREME risk flag');

    if (!report) reasons.push('no rugcheck');
    else {
      if (report.rugged) reasons.push('marked rugged');
      const auth = mintOrFreeze(report);
      if (auth.mint) reasons.push('mint authority enabled');
      if (auth.freeze) reasons.push('freeze authority enabled');
      if (!lpLockedOrBonded(report, p)) reasons.push('LP not locked/burned or unbonded');
      const dang = dangerRisks(report);
      if (dang.length) reasons.push('danger risks: ' + dang.map(r => r.name || r).join(', '));
      const scoreN = +report.score_normalised;
      if (isFinite(scoreN) && scoreN >= 25) reasons.push('rugcheck score danger (' + scoreN + ')');
      const top = topHolderPctExLp(report, 10);
      if (top > (s.maxTopHoldersPct || 40)) reasons.push('top 10 holders (ex-LP) ' + top.toFixed(1) + '%');
      const dev = creatorPct(report);
      if (s.maxDevPct != null && dev > s.maxDevPct) reasons.push('dev holds ' + dev.toFixed(1) + '%');
      const ins = insiderPct(report);
      if (s.maxInsiderPct != null && ins > s.maxInsiderPct) reasons.push('insiders/snipers ' + ins.toFixed(1) + '%');
    }

    if (!input.skipQuotes) {
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
        else if (imp > (s.maxSellImpactPct || Math.max(s.maxImpactPct * 2, 8))) reasons.push('sell impact ' + imp.toFixed(2) + '% (thin exit / honeypot risk)');
      } else reasons.push('missing sell quote (honeypot check)');
    }

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
    const hasMom = m5 > 0 || h1 > 0;
    if (closes.length >= 15) {
      const e9 = ema(closes, 9), e21 = ema(closes, Math.min(21, closes.length));
      // Allow a flat EMA if there is 5m/1h momentum; only reject a clearly falling trend.
      if (e9 != null && e21 != null && e9 < e21 * 0.992 && !hasMom) return { ok: false, reason: 'EMA trend down' };
      if (e9 != null && e21 != null && e9 < e21 * 0.97) return { ok: false, reason: 'EMA trend down' };
      const hour = (ticks || []).filter(t => t.t >= ((ticks[ticks.length - 1].t) - 3600));
      const vw = vwap(hour.length ? hour : ticks);
      if (vw && px < vw * 0.985) return { ok: false, reason: 'price below hourly VWAP' };
      const recent = closes.slice(-15);
      const hi = Math.max.apply(null, recent);
      if (px >= hi * 0.995 && m5 > 28) return { ok: false, reason: 'at local top, already extended' };
    } else {
      // Without a 1m series, allow flat-to-up 1h with some 5m interest.
      if (h1 < 0 && m5 <= 2) return { ok: false, reason: '1h momentum too weak' };
      if (m5 > 45) return { ok: false, reason: '5m already extended, wait for pullback' };
      if (m5 < -12) return { ok: false, reason: '5m dump in progress' };
    }
    return { ok: true, reason: 'momentum ok' };
  }

  function decideExit(pos, px, now, settings, pair, extra) {
    const s = Object.assign({}, DEFAULTS, settings || {});
    const x = extra || {};
    if (!pos) return { action: 'hold' };
    const entry = +pos.entryPx;
    if (!entry) return { action: 'hold' };
    const jupPx = +x.jupPx || 0;
    const mark = (px > 0 && jupPx > 0) ? Math.min(px, jupPx) : (px > 0 ? px : jupPx);
    if (!mark || mark <= 0) return { action: 'hold' };
    const pnl = mark / entry - 1;
    const mid = px > 0 ? px : mark;
    const peak = Math.max(+pos.peakPx || entry, mid);
    const heldMin = (now - pos.openedAt) / 60000;

    if (x.rugged || x.pairGone) return { action: 'sell_all', reason: 'liquidity', pnl, peak, emergency: true };

    const stopPx = +pos.stopPx > 0 ? +pos.stopPx : entry * (1 - s.slPct);
    if (mark <= stopPx * (1 + 1e-9)) return { action: 'sell_all', reason: 'stop', sl: true, pnl, peak };

    if (pos.entryLiq && pair && pairLiq(pair) > 0 && pairLiq(pair) < pos.entryLiq * (1 - s.liqDropPct)) {
      return { action: 'sell_all', reason: 'liquidity', pnl, peak, emergency: true };
    }
    const qNow = x.quoteLiqUsd != null ? +x.quoteLiqUsd : quoteLiqUsd(pair, x.solPx, x.rug);
    if (qNow > 0 && qNow < (s.emergencyQuoteLiq || 2000)) {
      return { action: 'sell_all', reason: 'liquidity', pnl, peak, emergency: true };
    }
    if (pos.entryQuoteLiq && qNow > 0 && qNow < pos.entryQuoteLiq * (1 - (s.liqDropPct || 0.25))) {
      return { action: 'sell_all', reason: 'liquidity', pnl, peak, emergency: true };
    }
    const tx = pair && pair.txns && pair.txns.m5;
    const bs = buysSells(tx);
    if (bs.s + bs.b >= 6 && bs.s > bs.b * 1.6 && pnl < 0.15) {
      return { action: 'sell_all', reason: 'sell_spike', pnl, peak, emergency: true };
    }
    const m5chg = pair && pair.priceChange ? +pair.priceChange.m5 : 0;
    if (m5chg <= -20 && pnl < 0) {
      return { action: 'sell_all', reason: 'sell_spike', pnl, peak, emergency: true };
    }
    if (heldMin >= s.maxHoldMin) return { action: 'sell_all', reason: 'time', pnl, peak };

    if (s.tpPct > 0 && !pos.tpTaken && pnl >= s.tpPct) {
      return { action: 'sell_partial', pct: s.tpSellPct, reason: 'tp', pnl, peak };
    }
    const armPct = pos.trailArmPct != null ? +pos.trailArmPct : s.trailArmPct;
    const trailPct = pos.trailPct != null ? +pos.trailPct : s.trailPct;
    const armed = pos.tpTaken || (peak / entry - 1) >= armPct;
    if (armed && mark <= peak * (1 - trailPct)) {
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

  function minPosUsd(settings, solPx) {
    const s = Object.assign({}, DEFAULTS, settings || {});
    const sol = Math.max(s.minPosSol || 0.02, s.minSolReserve || 0.02);
    const px = +solPx || 0;
    return px > 0 ? sol * px : 0;
  }

  function canOpenMore(state, settings, now, extra) {
    const s = Object.assign({}, DEFAULTS, settings || {});
    const x = (extra && typeof extra === 'object') ? extra : { solPx: extra };
    if (state.halted) return { ok: false, reason: state.halted };
    if ((now || Date.now()) < (state.cooldownUntil || 0)) return { ok: false, reason: 'cooldown after losses' };
    const open = (state.positions || []).length;
    if (open >= s.maxOpen) return { ok: false, reason: 'max open positions' };
    const eq = +state.equityUsd || +state.cashUsd || 0;
    const start = +state.dayStartEquity || eq;
    if (start > 0 && (start - eq) / start >= s.dailyLossPct) return { ok: false, reason: 'daily loss cap' };
    const reserve = +x.reserveUsd || 0;
    const cash = +state.cashUsd || eq;
    const sized = positionUsd(eq, s, reserve, x.solPx);
    if (sized <= 0) return { ok: false, reason: 'size too small' };
    const minUsd = minPosUsd(s, x.solPx);
    if (minUsd > 0 && cash - reserve < minUsd) return { ok: false, reason: 'size too small' };
    return { ok: true };
  }

  function positionUsd(equityUsd, settings, reserveUsd, solPx) {
    const s = Object.assign({}, DEFAULTS, settings || {});
    const reserve = Math.max(0, +reserveUsd || 0);
    const spendable = Math.max(0, +equityUsd - reserve);
    const usd = Math.min(spendable, (+equityUsd || 0) * s.posPct);
    const minUsd = minPosUsd(s, solPx);
    if (minUsd > 0 && usd < minUsd) return 0;
    return usd;
  }

  function tokenOnCooldown(state, mint, now) {
    const until = (state.tokenCooldownUntil || {})[mint];
    return !!(until && (now || Date.now()) < until);
  }

  function armTokenCooldown(state, mint, settings, now) {
    if (!mint) return 0;
    const s = Object.assign({}, DEFAULTS, settings || {});
    const mins = s.tokenCooldownMin != null ? s.tokenCooldownMin : 30;
    state.tokenCooldownUntil = state.tokenCooldownUntil || {};
    const until = (now || Date.now()) + mins * 60e3;
    state.tokenCooldownUntil[mint] = until;
    const t = now || Date.now();
    Object.keys(state.tokenCooldownUntil).forEach(k => {
      if (state.tokenCooldownUntil[k] <= t) delete state.tokenCooldownUntil[k];
    });
    return until;
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
      entryQuoteLiq: fill.quoteLiq || 0,
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
      if (s.consecLossLimit > 0 && state.consecLosses >= s.consecLossLimit) {
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

  /* ===================== v10 6-agent pipeline (pure) ===================== */
  const clamp01 = x => Math.max(0, Math.min(1, x));
  const ramp = (x, x0, x1) => (!isFinite(x) ? 0 : 100 * clamp01((x - x0) / (x1 - x0)));
  const num = v => (v == null || v === '' || !isFinite(+v)) ? null : +v;
  const round1 = x => Math.round(x * 10) / 10;

  /** Normalise a DexScreener pair (+ optional GeckoTerminal pool attrs) into a Scout record. */
  function toScoutPair(dsPair, gt, extra) {
    const p = dsPair || {};
    const g = gt || null;
    const pc = p.priceChange || {};
    const gpc = (g && g.price_change_percentage) || {};
    const pick = (a, b) => (num(a) != null ? num(a) : num(b));
    const base = p.baseToken || {};
    const created = p.pairCreatedAt || (g && g.pool_created_at ? Date.parse(g.pool_created_at) : 0);
    return {
      mint: base.address || (extra && extra.mint) || '',
      symbol: base.symbol || (extra && extra.symbol) || '?',
      name: base.name || '',
      icon: (extra && extra.icon) || (p.info && p.info.imageUrl) || '',
      pairAddress: p.pairAddress || (g && g.address) || '',
      dexId: p.dexId || '',
      chainId: p.chainId || 'solana',
      createdAt: created || 0,
      mcap: pairMc(p) || (g ? (num(g.market_cap_usd) || num(g.fdv_usd) || 0) : 0),
      liqUsd: pairLiq(p) || (g ? num(g.reserve_in_usd) || 0 : 0),
      priceUsd: num(p.priceUsd) || (g ? num(g.base_token_price_usd) : null) || 0,
      quoteLiq: (p.liquidity && num(p.liquidity.quote)) || null,
      priceChange: { m5: pick(pc.m5, gpc.m5), m15: num(gpc.m15), m30: num(gpc.m30), h1: pick(pc.h1, gpc.h1), h6: pick(pc.h6, gpc.h6), h24: pick(pc.h24, gpc.h24) },
      txns: p.txns || null,
      gtTx: (g && g.transactions) || null,
      volume: p.volume || null,
      src: (extra && extra.src) || [],
      pair: p
    };
  }

  /** SCOUT: Solana pairs 30m–72h old, mcap $300k–$20M. Input: candidate records. Output: { pairs, skipped }. */
  function scoutStage(records, now, settings) {
    const s = Object.assign({}, DEFAULTS, settings || {});
    const best = {};
    const skipped = {};
    const skip = r => { skipped[r] = (skipped[r] || 0) + 1; };
    (records || []).forEach(r => {
      if (!r || !r.mint) return skip('no token');
      if ((r.chainId || 'solana') !== 'solana') return skip('not solana');
      if (!(r.priceUsd > 0)) return skip('no price');
      const age = r.createdAt ? (now - r.createdAt) / 60000 : Infinity;
      if (age < s.scoutMinAgeMin) return skip('younger than ' + s.scoutMinAgeMin + 'm');
      if (age > s.scoutMaxAgeH * 60) return skip('older than ' + s.scoutMaxAgeH + 'h');
      if (!(r.mcap > 0)) return skip('no mcap');
      if (r.mcap < s.scoutMinMc) return skip('mcap < $' + Math.round(s.scoutMinMc / 1000) + 'K');
      if (r.mcap > s.scoutMaxMc) return skip('mcap > $' + Math.round(s.scoutMaxMc / 1e6) + 'M');
      const cur = best[r.mint];
      if (!cur || (r.liqUsd || 0) > (cur.liqUsd || 0)) best[r.mint] = Object.assign({}, r, { ageMin: age });
    });
    const pairs = Object.keys(best).map(k => best[k]).sort((a, b) => (b.liqUsd || 0) - (a.liqUsd || 0));
    return { stage: 'scout', t: now, pairs, skipped, seen: (records || []).length };
  }

  /** LP locked/burned % for the traded pool (RugCheck markets[].lp.lpLockedPct). null = unknown. */
  function lpLockedPctOf(report, pairAddress) {
    if (!report) return null;
    const mk = (report.markets || []).filter(m => m && m.lp);
    const own = mk.find(m => pairAddress && String(m.pubkey) === String(pairAddress));
    const vals = (own ? [own] : mk).map(m => num(m.lp.lpLockedPct)).filter(v => v != null);
    if (vals.length) return Math.max.apply(null, vals);
    if (mk.some(m => m.lp && m.lp.lpBurned)) return 100;
    const top = num(report.lpLockedPct);
    return top != null ? top : null;
  }
  function supplyRaw(report) {
    const t = report && report.token;
    return t && num(t.supply) > 0 ? +t.supply : 0;
  }
  /** Dev holdings %: creator wallet balance + top-holder accounts owned by the creator. */
  function devHoldPct(report) {
    if (!report) return null;
    const sup = supplyRaw(report);
    const bal = sup && num(report.creatorBalance) ? (+report.creatorBalance / sup) * 100 : 0;
    return Math.max(bal, creatorPct(report));
  }
  /** Bundled/insider cluster % (RugCheck insiderNetworks current holdings, or insider-flagged top holders). */
  function bundlePct(report) {
    if (!report) return null;
    const sup = supplyRaw(report);
    let net = 0;
    if (sup) (report.insiderNetworks || []).forEach(n => { net += (num(n.currentHolding) || num(n.tokenAmount) || 0); });
    const netPct = sup ? net / sup * 100 : 0;
    return Math.max(netPct, insiderPct(report));
  }
  /** Creator history: RugCheck rug flags + earlier launches that are dead (mcap < deadLaunchMc, >6h old). */
  function devHistory(report, settings, now) {
    const s = Object.assign({}, DEFAULTS, settings || {});
    if (!report) return { rugFlag: false, dead: 0, launches: 0 };
    const rugFlag = (report.risks || []).some(r => /rug/i.test(String(r.name || r.description || '')) && /creator|dev|deployer|history|previous/i.test(String((r.name || '') + ' ' + (r.description || ''))));
    const t = now || Date.now();
    const others = (report.creatorTokens || []).filter(x => x && x.mint && x.mint !== report.mint);
    const dead = others.filter(x => {
      const mc = num(x.marketCap);
      const age = x.createdAt ? (t - Date.parse(x.createdAt)) / 36e5 : 99;
      return mc != null && mc < s.deadLaunchMc && age > 6;
    }).length;
    return { rugFlag, dead, launches: others.length };
  }

  /** FILTER: hard kills for one scout pair. Returns { pass, kills:[{code, reason}], facts }. */
  function filterPair(pair, report, settings, now) {
    const s = Object.assign({}, DEFAULTS, settings || {});
    const kills = [];
    const kill = (code, reason) => kills.push({ code, reason });
    const facts = {};
    const liqMc = pair.mcap > 0 ? pair.liqUsd / pair.mcap * 100 : 0;
    facts.liqMcPct = round1(liqMc);
    const h1 = pair.priceChange && pair.priceChange.h1;
    facts.h1 = h1;
    if (h1 != null && h1 > s.max1hChg) kill('pumped_1h', 'already +' + Math.round(h1) + '% in 1h (> ' + s.max1hChg + '%)');
    if (pair.liqUsd < s.minLiq) kill('liq_floor', 'liquidity $' + Math.round(pair.liqUsd) + ' < $' + Math.round(s.minLiq));
    if (liqMc < s.minLiqMcPct) kill('liq_mcap', 'liq/mcap ' + liqMc.toFixed(1) + '% < ' + s.minLiqMcPct + '%');
    if (!report) {
      kill('no_rugcheck', 'no RugCheck data, cannot verify authorities/LP');
      return { pass: false, kills, facts };
    }
    if (report.rugged) kill('rugged', 'RugCheck marks token rugged');
    const auth = mintOrFreeze(report);
    if (auth.mint) kill('mint_auth', 'mint authority not revoked');
    if (auth.freeze) kill('freeze_auth', 'freeze authority not revoked');
    const lp = lpLockedPctOf(report, pair.pairAddress);
    facts.lpLockedPct = lp == null ? null : round1(lp);
    if (lp == null) kill('lp_unknown', 'LP lock/burn status unknown');
    else if (lp < s.minLpLockedPct) kill('lp_unlocked', 'LP only ' + lp.toFixed(0) + '% burned/locked');
    const dev = devHoldPct(report);
    facts.devPct = round1(dev || 0);
    if (dev > s.maxDevPct) kill('dev_holds', 'dev holds ' + dev.toFixed(1) + '% (> ' + s.maxDevPct + '%)');
    const hist = devHistory(report, s, now);
    facts.devDead = hist.dead; facts.devLaunches = hist.launches;
    if (hist.rugFlag) kill('dev_rugs', 'creator has rug history (RugCheck)');
    else if (s.maxDeadLaunches > 0 && hist.dead >= s.maxDeadLaunches) kill('dev_rugs', 'creator has ' + hist.dead + ' dead earlier launches');
    const bun = bundlePct(report);
    facts.bundlePct = round1(bun || 0);
    if (bun > s.maxBundlePct) kill('bundled', 'bundled/insider cluster ' + bun.toFixed(1) + '% (> ' + s.maxBundlePct + '%)');
    const dang = dangerRisks(report).filter(r => !/bundl|sniper|insider/i.test(String(r.name || '')));
    if (dang.length) kill('rc_danger', 'RugCheck danger: ' + dang.map(r => r.name || r).join(', '));
    return { pass: kills.length === 0, kills, facts };
  }

  /** FILTER stage: input = Scout output + reports map. */
  function filterStage(scoutOut, reports, settings, now) {
    const passed = [], killed = [];
    (scoutOut.pairs || []).forEach(p => {
      const r = filterPair(p, reports ? reports[p.mint] : null, settings, now);
      if (r.pass) passed.push(Object.assign({}, p, { safety: r.facts }));
      else killed.push({ mint: p.mint, symbol: p.symbol, icon: p.icon, kills: r.kills, facts: r.facts });
    });
    return { stage: 'filter', t: now, pairs: passed, killed };
  }

  /* ---- Analyst component scores (0–100 each, null = no data) ---- */
  function scoreMomentum(pc) {
    pc = pc || {};
    if (pc.h1 == null && pc.m5 == null) return null;
    const h1 = pc.h1 != null ? pc.h1 : 0;
    let a = h1 <= 25 ? ramp(h1, -10, 25) : (h1 <= 60 ? 100 : 100 - 0.5 * ramp(h1, 60, 80));
    const sh = pc.m15 != null ? pc.m15 : (pc.m5 != null ? pc.m5 * 2 : 0);
    let b = sh <= 30 ? ramp(sh, -6, 8) : 100 - 0.6 * ramp(sh, 30, 50);
    const seq = [pc.m5, pc.m15 != null ? pc.m15 : pc.m30, pc.h1, pc.h6].filter(v => v != null);
    const c = seq.length ? 100 * seq.filter(v => v > 0).length / seq.length : 50;
    return Math.round(0.4 * a + 0.35 * b + 0.25 * c);
  }
  function scoreBuyers(gtTx) {
    const h1 = gtTx && gtTx.h1;
    if (!h1 || h1.buyers == null) return null;
    const buyers = +h1.buyers || 0, sellers = +h1.sellers || 0;
    const a = buyers > 0 ? ramp(Math.log10(buyers), Math.log10(30), Math.log10(1500)) : 0;
    const b = buyers + sellers > 0 ? ramp(buyers / (buyers + sellers), 0.45, 0.62) : 0;
    const m15 = gtTx.m15 && +gtTx.m15.buyers;
    const c = m15 != null && buyers > 0 ? ramp(m15 * 4 / buyers, 0.7, 1.5) : 50;
    return Math.round(0.5 * a + 0.3 * b + 0.2 * c);
  }
  function scoreBuySell(txns, gtTx) {
    const src = (txns && txns.h1) ? txns : (gtTx || null);
    if (!src || !src.h1) return null;
    const h1 = src.h1, m5 = src.m5 || {};
    const r1 = (+h1.buys || 0) / Math.max(1, +h1.sells || 0);
    const n5 = (+m5.buys || 0) + (+m5.sells || 0);
    const r5 = n5 >= 10 ? (+m5.buys || 0) / Math.max(1, +m5.sells || 0) : r1;
    return Math.round(ramp(0.6 * r1 + 0.4 * r5, 0.9, 1.6));
  }
  /** Holder growth: measured %/h from RugCheck holder-count snapshots; else proxy from GT unique buyers per holder. */
  function scoreHolders(snaps, gtTx) {
    const list = (snaps || []).filter(x => x && x.n > 0);
    if (list.length >= 2) {
      const a = list[0], b = list[list.length - 1];
      const hrs = (b.t - a.t) / 36e5;
      if (hrs >= 10 / 60) {
        const g = (b.n - a.n) / a.n * 100 / hrs;
        return { score: Math.round(ramp(g, 0, 6)), growthPctH: round1(g), basis: 'measured' };
      }
    }
    const n = list.length ? list[list.length - 1].n : 0;
    const buyers = gtTx && gtTx.h1 && +gtTx.h1.buyers;
    if (n > 0 && buyers) {
      const rate = buyers / n * 100;
      return { score: Math.round(0.8 * ramp(rate, 0, 15)), growthPctH: null, basis: 'proxy' };
    }
    return null;
  }
  function scoreLiqMc(liqMcPct) {
    if (liqMcPct == null || !isFinite(liqMcPct)) return null;
    return Math.round(ramp(liqMcPct, 5, 40));
  }
  function scoreSmart(hits, nWallets) {
    if (!nWallets) return null;
    if (hits == null) return null;
    return hits >= 3 ? 100 : hits === 2 ? 85 : hits === 1 ? 60 : 0;
  }

  /** ANALYST: weighted 0–100 score. Components without data are excluded and weights renormalised. */
  function scorePair(pair, ctx, settings) {
    const s = Object.assign({}, DEFAULTS, settings || {});
    const w = Object.assign({}, DEFAULTS.weights, s.weights || {});
    const c = ctx || {};
    const gtTx = c.gtTx || pair.gtTx;
    const pc = Object.assign({}, pair.priceChange || {}, c.priceChange || {});
    const hold = scoreHolders(c.holderSnaps, gtTx);
    const liqMc = pair.mcap > 0 ? pair.liqUsd / pair.mcap * 100 : null;
    const comps = {
      momentum: { score: scoreMomentum(pc), weight: w.momentum },
      buyers: { score: scoreBuyers(gtTx), weight: w.buyers },
      buySell: { score: scoreBuySell(pair.txns, gtTx), weight: w.buySell },
      holders: { score: hold ? hold.score : null, weight: w.holders, basis: hold ? hold.basis : 'no data', growthPctH: hold ? hold.growthPctH : null },
      liqMc: { score: scoreLiqMc(liqMc), weight: w.liqMc },
      smart: { score: scoreSmart(c.smartHits, c.smartWallets), weight: w.smart, basis: c.smartWallets ? (c.smartHits == null ? 'rpc failed' : c.smartHits + '/' + c.smartWallets + ' wallets') : 'n/a (no wallets set)' }
    };
    let tw = 0, acc = 0, have = 0;
    Object.keys(comps).forEach(k => {
      const x = comps[k];
      if (x.score == null) return;
      have++; tw += x.weight; acc += x.weight * x.score;
    });
    const score = tw > 0 ? Math.round(acc / tw) : 0;
    const enough = have >= 4;
    return { score, pass: enough && score >= s.passScore, enough, components: comps };
  }

  /** EXECUTOR sizing: ≤ posPct (8%) of equity, floor at minPosSol, never more than spendable cash. */
  function executorSize(equityUsd, cashUsd, settings, reserveUsd, solPx) {
    const s = Object.assign({}, DEFAULTS, settings || {});
    const pct = Math.min(0.08, s.posPct);
    const want = (+equityUsd || 0) * pct;
    const spend = Math.max(0, (+cashUsd || 0) - Math.max(0, +reserveUsd || 0));
    const usd = Math.min(want, spend);
    const floor = minPosUsd(s, solPx);
    if (floor > 0 && usd < floor) return 0;
    return usd;
  }

  /** RISK pre-entry: approve a sized ticket and register the hard stop + trailing plan BEFORE any fill. */
  function riskApprove(ticket, state, settings, now, extra) {
    const s = Object.assign({}, DEFAULTS, settings || {});
    const reasons = [];
    const gate = canOpenMore(state, s, now, extra);
    if (!gate.ok) reasons.push(gate.reason);
    if (!ticket || !(ticket.usd > 0)) reasons.push('no size');
    if (ticket && ticket.usd > (+state.equityUsd || +state.cashUsd || 0) * 0.08 + 1e-6) reasons.push('size above 8% cap');
    const qs = ticket && ticket.quoteSell;
    if (!qs || !qs.ok) reasons.push('sell quote failed (honeypot)');
    else if (Math.abs(+qs.impactPct || 0) > s.maxSellImpactPct) reasons.push('sell impact ' + Math.abs(+qs.impactPct).toFixed(2) + '% (thin exit)');
    const qb = ticket && ticket.quoteBuy;
    if (!qb || !qb.ok) reasons.push('no buy quote');
    else if (Math.abs(+qb.impactPct || 0) > s.maxImpactPct) reasons.push('buy impact ' + Math.abs(+qb.impactPct).toFixed(2) + '%');
    if (ticket && ticket.mint && tokenOnCooldown(state, ticket.mint, now)) reasons.push('token cooldown');
    if (ticket && (state.positions || []).some(p => p.mint === ticket.mint)) reasons.push('already holding');
    if (reasons.length) return { ok: false, reasons };
    const ref = +ticket.expectedPx || +ticket.priceUsd;
    return {
      ok: true, reasons: [],
      plan: { stopPct: s.slPct, stopPx: ref * (1 - s.slPct), trailArmPct: s.trailArmPct, trailPct: s.trailPct, registeredAt: now || Date.now() }
    };
  }
  /** After the fill, re-anchor the registered stop to the actual fill price: exactly −stopPct from entry. */
  function anchorStop(plan, fillPx) {
    const px = +fillPx;
    if (!plan || !(px > 0)) return null;
    return px * (1 - plan.stopPct);
  }

  /** LOGGER helpers: append with dedupe for repeated kills; cap size. */
  function logAppend(log, ev, cap, dedupeMs) {
    const L = log || [];
    const lim = cap || 600;
    const win = dedupeMs != null ? dedupeMs : 10 * 60e3;
    if (ev.kind === 'kill' && ev.mint) {
      for (let i = 0; i < Math.min(L.length, 200); i++) {
        const e = L[i];
        if (e.kind === 'kill' && e.mint === ev.mint && e.stage === ev.stage && e.code === ev.code) {
          if (ev.t - e.t0 < win) { e.n = (e.n || 1) + 1; e.t = ev.t; e.reason = ev.reason; L.splice(i, 1); L.unshift(e); return L; }
          break;
        }
      }
    }
    ev.n = ev.n || 1; ev.t0 = ev.t;
    L.unshift(ev);
    if (L.length > lim) L.length = lim;
    return L;
  }

  const api = {
    DEFAULTS, LEGACY_DEFAULTS, cloneDefaults, toScoutPair, scoutStage, filterPair, filterStage, scorePair, scoreMomentum, scoreBuyers, scoreBuySell, scoreHolders, scoreLiqMc, scoreSmart, lpLockedPctOf, devHoldPct, bundlePct, devHistory, executorSize, riskApprove, anchorStop, logAppend, scanCandidates, analyzeSafety, momentumEntry,
    decideExit, abortIfMoved, canOpenMore, positionUsd, applyBuy, applySell,
    markToMarket, updateDayAndHalt, recordLossStreak, tradeStats, maxDrawdown,
    walkExit, topHolderPctExLp, lpLockedOrBonded, isPumpOrGraduated, mintOrFreeze, ema, vwap, quoteLiqUsd, creatorPct, insiderPct, pairMc, dangerRisks, minPosUsd, tokenOnCooldown, armTokenCooldown
  };
  root.BotStrategy = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
