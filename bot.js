/* Meme Terminal — Fast-only paper/live flip bot. Solana burner wallet, Jupiter swaps. */
(function () {
  'use strict';
  const S = window.BotStrategy;
  if (!S) { console.error('BotStrategy missing'); return; }

  const WSOL = 'So11111111111111111111111111111111111111112';
  const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  const JUP = 'https://lite-api.jup.ag/swap/v1';
  const JUP2 = 'https://api.jup.ag/swap/v1';
  const RUG = 'https://api.rugcheck.xyz/v1/tokens/';
  const STORE = 'bot:v1';
  const WAL = 'bot:wallet';
  const SCAN_MS = 20000;
  const TICK_MS = 1000;
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  const bot = {
    settings: S.cloneDefaults(),
    running: false,
    halted: null,
    cashUsd: 200,
    startUsd: 200,
    startTs: 0,
    positions: [],
    trades: [],
    equity: [],
    dayKey: '',
    dayStartEquity: 200,
    consecLosses: 0,
    cooldownUntil: 0,
    scanned: 0,
    scoreHist: {},
    buyerHist: {},
    ticks: {},
    rugCache: {},
    agents: idleAgents(),
    lastFlash: null,
    tf: 'LIVE',
    solPx: 0,
    wake: null,
    timer: null,
    scanTimer: null,
    unlockedSec: null,
    pub: null,
    hasPin: false,
    liveBal: { sol: 0, tokens: [], usd: 0 },
    view: 'term',
    rejectTally: {},
    _skipSave: false
  };

  function idleAgents() {
    return {
      scanner: { status: 'idle', detail: 'waiting', n: 0 },
      analyst: { status: 'idle', detail: 'waiting', token: null, score: null },
      executor: { status: 'idle', detail: 'ready' },
      brain: { status: 'idle', detail: 'watching' }
    };
  }

  const persistable = () => ({
    settings: bot.settings, running: bot.running, halted: bot.halted,
    cashUsd: bot.cashUsd, startUsd: bot.startUsd, startTs: bot.startTs,
    positions: bot.positions, trades: bot.trades, equity: bot.equity.slice(-4000),
    dayKey: bot.dayKey, dayStartEquity: bot.dayStartEquity,
    consecLosses: bot.consecLosses, cooldownUntil: bot.cooldownUntil,
    tokenCooldownUntil: bot.tokenCooldownUntil || {},
    scanned: bot.scanned, lastFlash: bot.lastFlash, tf: bot.tf
  });

  function save() { if (bot._skipSave) return; try { ls.set(STORE, persistable()); } catch (e) { console.warn('bot save', e); } }
  function migrateSettings(s) {
    const out = Object.assign(S.cloneDefaults(), s || {});
    if (!s) return out;
    if (s.minLiq === 30000 || s.minLiq === 12000) out.minLiq = S.DEFAULTS.minLiq;
    if (s.minAgeMin === 25) out.minAgeMin = S.DEFAULTS.minAgeMin;
    if (s.maxImpactPct === 2) out.maxImpactPct = S.DEFAULTS.maxImpactPct;
    if (s.scoreScans === 3) out.scoreScans = S.DEFAULTS.scoreScans;
    if (s.max1hChg === 300) out.max1hChg = S.DEFAULTS.max1hChg;
    if (s.liqDropPct === 0.30) out.liqDropPct = S.DEFAULTS.liqDropPct;
    if (s.posPct === 0.10) out.posPct = S.DEFAULTS.posPct;
    if (s.maxOpen === 2) out.maxOpen = S.DEFAULTS.maxOpen;
    if (s.maxAgeH === 72) out.maxAgeH = S.DEFAULTS.maxAgeH;
    if (s.minScore === 62) out.minScore = S.DEFAULTS.minScore;
    if (s.minLiqMcRatio === 0.06) out.minLiqMcRatio = S.DEFAULTS.minLiqMcRatio;
    return out;
  }
  function load() {
    const s = ls.get(STORE);
    if (!s) return;
    Object.assign(bot, s);
    bot.settings = migrateSettings(s.settings || {});
    bot.agents = idleAgents();
    bot.rejectTally = bot.rejectTally || {};
    bot.tokenCooldownUntil = bot.tokenCooldownUntil || {};
    if (bot.settings.mode !== 'LIVE') bot.settings.mode = 'PAPER';
  }

  function lib() { return window.SolanaLib || (window.SolanaLibGlobal && (window.SolanaLibGlobal.default || window.SolanaLibGlobal)); }
  function walletRecord() { try { return JSON.parse(localStorage.getItem(WAL) || 'null'); } catch { return null; } }

  async function ensureWallet() {
    const L = lib();
    if (!L) throw new Error('Solana library failed to load');
    let rec = walletRecord();
    if (!rec) {
      const kp = L.Keypair.generate();
      rec = { pub: kp.publicKey.toBase58(), sec: L.bs58.encode(kp.secretKey), enc: false, created: Date.now() };
      localStorage.setItem(WAL, JSON.stringify(rec));
    }
    bot.pub = rec.pub;
    bot.hasPin = !!rec.enc;
    if (!rec.enc) bot.unlockedSec = rec.sec;
    return rec;
  }

  function keypair() {
    const L = lib();
    if (!bot.unlockedSec) throw new Error('Wallet locked');
    return L.Keypair.fromSecretKey(L.bs58.decode(bot.unlockedSec));
  }

  async function pinKey(pin, salt) {
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 120000, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }
  async function encryptStr(plain, pin) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await pinKey(pin, salt);
    const buf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plain));
    return btoa(String.fromCharCode(...salt, ...iv, ...new Uint8Array(buf)));
  }
  async function decryptStr(blob, pin) {
    const raw = Uint8Array.from(atob(blob), c => c.charCodeAt(0));
    const salt = raw.slice(0, 16), iv = raw.slice(16, 28), data = raw.slice(28);
    const key = await pinKey(pin, salt);
    const buf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
    return new TextDecoder().decode(buf);
  }
  async function setPin(pin) {
    const rec = walletRecord();
    if (!rec || rec.enc) return;
    if (!pin || pin.length < 4) throw new Error('PIN must be at least 4 digits');
    const enc = await encryptStr(rec.sec, pin);
    localStorage.setItem(WAL, JSON.stringify({ pub: rec.pub, enc: true, blob: enc, created: rec.created }));
    bot.hasPin = true;
  }
  async function unlock(pin) {
    const rec = walletRecord();
    if (!rec) return false;
    if (!rec.enc) { bot.unlockedSec = rec.sec; return true; }
    try { bot.unlockedSec = await decryptStr(rec.blob, pin); return true; }
    catch { return false; }
  }

  function rpcUrl() { return (bot.settings.rpcUrl || S.DEFAULTS.rpcUrl).trim() || S.DEFAULTS.rpcUrl; }

  async function rpc(method, params, timeout) {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: params || [] });
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeout || 15000);
    try {
      const r = await fetch(rpcUrl(), { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: ctl.signal });
      if (!r.ok) throw new Error('RPC ' + r.status);
      const d = await r.json();
      if (d.error) throw new Error(d.error.message || 'RPC error');
      return d.result;
    } finally { clearTimeout(t); }
  }

  const jupGate = { until: 0, minMs: 400, last: 0 };
  async function jup(path, opts) {
    const o = opts || {};
    if (Date.now() < jupGate.until) throw new Error('Jupiter backoff');
    const wait = jupGate.last + jupGate.minMs - Date.now();
    if (wait > 0) await sleep(wait);
    let last;
    for (const base of [JUP, JUP2]) {
      try {
        const url = base + path;
        const init = { method: o.method || 'GET', headers: { accept: 'application/json' } };
        if (o.body) { init.method = 'POST'; init.headers['content-type'] = 'application/json'; init.body = JSON.stringify(o.body); }
        const r = await fetch(url, init);
        jupGate.last = Date.now();
        if (r.status === 429) {
          jupGate.until = Date.now() + 12000;
          jupGate.minMs = Math.min(2500, (jupGate.minMs || 400) * 1.6);
          last = new Error('Jupiter 429');
          continue;
        }
        if (!r.ok) { last = new Error('Jupiter ' + r.status); continue; }
        jupGate.minMs = Math.max(350, (jupGate.minMs || 400) * 0.92);
        return await r.json();
      } catch (e) { last = e; }
    }
    throw last || new Error('Jupiter failed');
  }

  function impactPct(q) {
    const x = Math.abs(parseFloat(q && (q.priceImpactPct != null ? q.priceImpactPct : 0)) || 0);
    return x <= 1 ? x * 100 : x;
  }

  async function jupQuote(inputMint, outputMint, amount, slip) {
    const q = new URLSearchParams({
      inputMint, outputMint, amount: String(Math.max(1, Math.floor(amount))),
      slippageBps: String(slip || bot.settings.slippageBps || 150),
      restrictIntermediateTokens: 'true'
    });
    const d = await jup('/quote?' + q.toString());
    if (!d || !d.outAmount) return { ok: false, raw: d };
    return { ok: true, raw: d, outAmount: +d.outAmount, inAmount: +d.inAmount, impactPct: impactPct(d) };
  }

  async function jupSwapTx(quote, pub) {
    return jup('/swap', { body: {
      quoteResponse: quote.raw || quote,
      userPublicKey: pub,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      dynamicSlippage: true,
      prioritizationFeeLamports: 'auto'
    }});
  }

  function b64ToBytes(b64) {
    const bin = atob(b64);
    const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u;
  }
  function bytesToB64(u8) {
    let s = '';
    for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
    return btoa(s);
  }

  async function signSwap(swapTransaction) {
    const L = lib();
    const vtx = L.VersionedTransaction.deserialize(b64ToBytes(swapTransaction));
    vtx.sign([keypair()]);
    return bytesToB64(vtx.serialize());
  }

  async function simulateB64(b64) {
    return rpc('simulateTransaction', [b64, { encoding: 'base64', replaceRecentBlockhash: true, sigVerify: false, commitment: 'processed' }]);
  }
  async function sendB64(b64) {
    return rpc('sendTransaction', [b64, { encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 3 }]);
  }
  async function confirmSig(sig, tries) {
    for (let i = 0; i < (tries || 30); i++) {
      const st = await rpc('getSignatureStatuses', [[sig], { searchTransactionHistory: true }]);
      const v = st && st.value && st.value[0];
      if (v && (v.confirmationStatus === 'confirmed' || v.confirmationStatus === 'finalized')) {
        if (v.err) throw new Error('tx failed: ' + JSON.stringify(v.err));
        return v;
      }
      await sleep(600);
    }
    throw new Error('tx confirm timeout');
  }

  async function solPrice() {
    if (bot.solPx && Date.now() - (solPrice._t || 0) < 20000) return bot.solPx;
    try {
      const q = await jupQuote(WSOL, USDC, 10000000, 50);
      if (q.ok) { bot.solPx = (q.outAmount / 1e6) / 0.01; solPrice._t = Date.now(); return bot.solPx; }
    } catch (e) { console.warn('sol price', e); }
    return bot.solPx || 0;
  }

  async function loadLiveBalances() {
    if (!bot.pub) return;
    const lamports = await rpc('getBalance', [bot.pub]);
    const sol = (lamports || 0) / 1e9;
    let tokens = [];
    try {
      const res = await rpc('getParsedTokenAccountsByOwner', [bot.pub, { programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' }, { encoding: 'jsonParsed' }]);
      const res22 = await rpc('getParsedTokenAccountsByOwner', [bot.pub, { programId: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' }, { encoding: 'jsonParsed' }]).catch(() => ({ value: [] }));
      const accs = [].concat((res && res.value) || [], (res22 && res22.value) || []);
      tokens = accs.map(a => {
        const info = a.account.data.parsed.info;
        const ta = info.tokenAmount;
        return { mint: info.mint, amount: +ta.uiAmount || 0, decimals: +ta.decimals, raw: ta.amount };
      }).filter(t => t.amount > 0);
    } catch (e) { console.warn('tokens', e); }
    const px = await solPrice();
    bot.liveBal = { sol, tokens, usd: sol * px, ts: Date.now() };
    return bot.liveBal;
  }

  const dsCache = {};
  async function dsPair(chain, pairAddr, critical) {
    const key = chain + ':' + pairAddr;
    const ttl = critical ? 600 : 2000;
    const hit = dsCache[key];
    if (hit && Date.now() - hit.ts < ttl) return hit.d;
    const d = await getJSON('https://api.dexscreener.com/latest/dex/pairs/' + encodeURIComponent(chain) + '/' + encodeURIComponent(pairAddr), 8000, critical ? { critical: true } : undefined);
    const pair = (d && (d.pair || (d.pairs && d.pairs[0]))) || null;
    dsCache[key] = { ts: Date.now(), d: pair };
    return pair;
  }
  async function dsBestPair(mint, hintAddr, critical) {
    const key = 'tok:' + mint;
    const ttl = critical ? 600 : 2000;
    const hit = dsCache[key];
    let pairs;
    if (hit && Date.now() - hit.ts < ttl) pairs = hit.d;
    else {
      const d = await getJSON('https://api.dexscreener.com/latest/dex/tokens/' + encodeURIComponent(mint), 8000, critical ? { critical: true } : undefined);
      pairs = ((d && d.pairs) || []).filter(p => (p.chainId || p.chain) === 'solana');
      dsCache[key] = { ts: Date.now(), d: pairs };
    }
    if (!pairs || !pairs.length) {
      if (hintAddr) return dsPair('solana', hintAddr, critical);
      return null;
    }
    pairs = pairs.slice().sort((a, b) => ((b.liquidity && +b.liquidity.usd) || 0) - ((a.liquidity && +a.liquidity.usd) || 0));
    return pairs[0];
  }
  async function rugReport(mint) {
    const hit = bot.rugCache[mint];
    if (hit && Date.now() - hit.ts < 360000) return hit.d;
    const d = await getJSON(RUG + encodeURIComponent(mint) + '/report', 12000);
    bot.rugCache[mint] = { ts: Date.now(), d };
    return d;
  }
  const gtCache = {};
  async function gtTicks(pairAddr) {
    try {
      const hit = gtCache[pairAddr];
      if (hit && Date.now() - hit.ts < 180000) return hit.d;
      const d = await getJSON('https://api.geckoterminal.com/api/v2/networks/solana/pools/' + encodeURIComponent(pairAddr) + '/ohlcv/minute?aggregate=1&limit=60&currency=usd&token=base', 10000);
      const list = (d && d.data && d.data.attributes && d.data.attributes.ohlcv_list) || [];
      const out = list.map(r => ({ t: +r[0], px: +r[4], vol: +r[5] || 1 }));
      gtCache[pairAddr] = { ts: Date.now(), d: out };
      return out;
    } catch { return []; }
  }

  function midPx(p) { return (bot._px && bot._px[p.mint]) || p.peakPx || p.entryPx; }
  function lastPx(p) {
    const ds = bot._px && bot._px[p.mint];
    const j = bot._jupPx && bot._jupPx[p.mint];
    const cands = [ds, j].filter(x => x > 0);
    if (cands.length) return Math.min.apply(null, cands);
    return p.peakPx || p.entryPx;
  }
  function equityNow() {
    if (bot.settings.mode === 'LIVE' && bot.liveBal) {
      const pos = bot.positions.reduce((s, p) => s + p.amount * lastPx(p), 0);
      return (bot.liveBal.sol * (bot.solPx || 0)) + pos;
    }
    const prices = {};
    bot.positions.forEach(p => { prices[p.mint] = lastPx(p); });
    return S.markToMarket({ cashUsd: bot.cashUsd, positions: bot.positions }, prices);
  }
  function pushEquity(v) {
    const t = Date.now();
    const last = bot.equity[bot.equity.length - 1];
    if (last && t - last.t < 800 && Math.abs(last.v - v) < 1e-9) { last.v = v; last.t = t; return; }
    bot.equity.push({ t, v });
    if (bot.equity.length > 4000) bot.equity.splice(0, bot.equity.length - 4000);
  }
  function addTrade(tr) {
    bot.trades.unshift(tr);
    if (bot.trades.length > 200) bot.trades.length = 200;
    bot.lastFlash = { t: Date.now(), usd: tr.pnlUsd != null ? tr.pnlUsd : 0, kind: tr.kind };
  }
  function reserveUsd() { return (bot.settings.minSolReserve || 0.02) * (bot.solPx || 0); }

  async function ensureFast() {
    try { if (!fast.ts || Date.now() - fast.ts > 45000) await loadFast(true); }
    catch (e) { console.warn('fast load', e); }
  }
  function solanaFastItems() { return (fast.items || []).filter(i => i.chain === 'solana'); }

  async function jupSellMark(p) {
    bot._jupPx = bot._jupPx || {};
    bot._jupTs = bot._jupTs || {};
    try {
      const raw = rawAmount(p, p.amount);
      const q = await jupQuote(p.mint, WSOL, raw, bot.settings.slippageBps);
      if (!q.ok || !p.amount) return null;
      const usd = (q.outAmount / 1e9) * (bot.solPx || 0);
      const px = usd / p.amount;
      if (px > 0) { bot._jupPx[p.mint] = px; bot._jupTs[p.mint] = Date.now(); }
      p._jupMark = { px, usd, impactPct: q.impactPct, ts: Date.now() };
      return p._jupMark;
    } catch (e) { return null; }
  }
  async function refreshPositionPrices() {
    bot._px = bot._px || {};
    bot._pxTs = bot._pxTs || {};
    bot._jupPx = bot._jupPx || {};
    await Promise.all(bot.positions.map(async p => {
      try {
        let pair = null;
        try { pair = await dsBestPair(p.mint, p.pairAddress, true); } catch (e) { console.warn('px ds', e); }
        if (!pair && p.pairAddress) { try { pair = await dsPair('solana', p.pairAddress, true); } catch {} }
        if (pair) {
          const px = +pair.priceUsd;
          if (px) { bot._px[p.mint] = px; bot._pxTs[p.mint] = Date.now(); }
          p._pair = pair;
          p._mc = pairMc(pair);
          if (pair.pairAddress) p.pairAddress = pair.pairAddress;
          p._quoteLiq = S.quoteLiqUsd(pair, bot.solPx, null);
        } else {
          p._pairGone = !p._pair;
        }
        const mid = midPx(p);
        const alreadyDown = mid && p.entryPx && mid / p.entryPx - 1 <= -0.04;
        const stale = !bot._pxTs[p.mint] || (Date.now() - bot._pxTs[p.mint] > 2500);
        const due = !bot._jupTs || !bot._jupTs[p.mint] || (Date.now() - bot._jupTs[p.mint] > 2000);
        if (stale || alreadyDown || due || !pair) await jupSellMark(p);
      } catch (e) { console.warn('px', e); }
    }));
  }

  async function checkExits() {
    if (!bot.positions.length) { bot.agents.brain.detail = 'watching'; bot.agents.brain.status = 'idle'; return; }
    const now = Date.now();
    for (const pos of bot.positions.slice()) {
      if (!pos._rugTs || now - pos._rugTs > 15000) {
        pos._rugTs = now;
        try {
          const rug = await rugReport(pos.mint);
          pos._rug = rug;
          if (rug && rug.rugged) pos._rugged = true;
          const qRug = S.quoteLiqUsd(pos._pair, bot.solPx, rug);
          if (qRug) pos._quoteLiq = pos._quoteLiq ? Math.min(pos._quoteLiq, qRug) : qRug;
        } catch {}
      }
      const mid = midPx(pos);
      const px = lastPx(pos);
      const d = S.decideExit(pos, mid, now, bot.settings, pos._pair, {
        jupPx: bot._jupPx && bot._jupPx[pos.mint],
        quoteLiqUsd: pos._quoteLiq,
        solPx: bot.solPx,
        rug: pos._rug,
        rugged: !!pos._rugged,
        pairGone: !!pos._pairGone && !pos._pair
      });
      pos.peakPx = Math.max(pos.peakPx || pos.entryPx, mid || pos.entryPx);
      bot.agents.brain.status = 'hot';
      bot.agents.brain.token = pos;
      if (d.action === 'hold') { bot.agents.brain.detail = pos.tpTaken ? 'trailing' : 'holding'; continue; }
      bot.agents.brain.detail = d.reason === 'stop' ? ('stop ' + Math.round((bot.settings.slPct || 0.12) * -100) + '%') : (d.reason === 'tp' ? 'taking profit' : d.reason);
      await executeSell(pos, d.action === 'sell_partial' ? d.pct : 1, d.reason);
    }
  }

  async function executeSell(pos, frac, reason) {
    const px0 = lastPx(pos);
    bot.agents.executor.status = 'hot';
    bot.agents.executor.detail = 'selling ' + Math.round(frac * 100) + '%';
    try {
      let fillUsd, fillQty, fillPx = px0;
      const qty = pos.amount * frac;
      if (bot.settings.mode === 'LIVE') {
        const rec = await liveSwap(pos.mint, WSOL, rawAmount(pos, qty), { signalPx: px0, decimals: pos.decimals || 6 });
        fillPx = rec.px; fillUsd = rec.usd; fillQty = rec.qtyIn;
      } else {
        const dec = pos.decimals || 6;
        const raw = Math.max(1, Math.floor(qty * Math.pow(10, dec)));
        const q = await jupQuote(pos.mint, WSOL, raw, bot.settings.slippageBps);
        if (q.ok) {
          const sol = q.outAmount / 1e9;
          fillUsd = sol * (await solPrice());
          fillQty = qty;
          fillPx = fillUsd / qty;
        } else { fillUsd = qty * px0; fillQty = qty; }
      }
      const res = S.applySell(bot, pos, frac, { usd: fillUsd, px: fillPx, reason });
      if (bot.settings.mode === 'LIVE') await reconcileLiveCash();
      const kind = reason === 'stop' || reason === 'liquidity' || reason === 'sell_spike' ? 'stop' : 'sell';
      const mult = fillPx / pos.entryPx;
      addTrade({
        id: 't' + Date.now() + Math.random().toString(16).slice(2, 6),
        t: Date.now(), kind, mint: pos.mint, symbol: pos.symbol, icon: pos.icon,
        usd: fillUsd, qty: res.qty, px: fillPx, mc: pos._mc || pos.entryMc,
        pnlUsd: res.pnl, pnlPct: fillPx / pos.entryPx - 1, mult,
        agent: kind === 'stop' || reason === 'tp' || reason === 'trail' || reason === 'time' ? 'Brain' : 'Executor',
        note: reason === 'stop' ? 'stop −' + Math.round(bot.settings.slPct * 100) + '%'
          : reason === 'tp' ? 'took profit' : reason === 'trail' ? 'trailing stop'
          : reason === 'time' ? 'time stop' : reason === 'liquidity' ? 'liquidity drop'
          : reason === 'sell_spike' ? 'sell spike' : reason === 'kill' ? 'kill switch' : reason === 'manual' ? 'manual sell' : reason,
        frac
      });
      if (res.closed) S.recordLossStreak(bot, res.pnl, bot.settings, Date.now());
      if (kind === 'stop' || reason === 'liquidity' || reason === 'sell_spike') {
        S.armTokenCooldown(bot, pos.mint, bot.settings, Date.now());
      }
      bot.agents.executor.detail = kind === 'stop' ? ('stopped −$' + Math.abs(res.pnl).toFixed(2)) : ('sold ' + (mult.toFixed(2)) + 'x');
      bot.agents.brain.detail = bot.agents.executor.detail;
      bot.agents.brain.status = kind === 'stop' ? 'danger' : 'hot';
      pushEquity(equityNow());
      save();
      return res;
    } catch (e) {
      console.warn('sell failed', e);
      toast('Sell failed: ' + (e.message || e), 4000);
      bot.agents.executor.detail = 'sell failed, will retry';
      return null;
    }
  }

  function rawAmount(pos, qty) {
    return Math.max(1, Math.floor(qty * Math.pow(10, pos.decimals || 6)));
  }

  async function liveSwap(inputMint, outputMint, rawAmt, opt) {
    const q1 = await jupQuote(inputMint, outputMint, rawAmt, bot.settings.slippageBps);
    if (!q1.ok) throw new Error('quote failed');
    if (opt && opt.signalPx && outputMint === WSOL) {
      const outUsd = (q1.outAmount / 1e9) * (await solPrice());
      const inQty = rawAmt / Math.pow(10, opt.decimals || 6);
      const px = outUsd / inQty;
      const chk = S.abortIfMoved(opt.signalPx, px, bot.settings);
      if (chk.abort) throw new Error(chk.reason);
    }
    const built = await jupSwapTx(q1, bot.pub);
    if (!built || !built.swapTransaction) throw new Error('swap build failed');
    if (built.simulationError) throw new Error('sim: ' + JSON.stringify(built.simulationError));
    const signed = await signSwap(built.swapTransaction);
    const sim = await simulateB64(signed);
    if (sim && sim.value && sim.value.err) throw new Error('simulate err ' + JSON.stringify(sim.value.err));
    const sig = await sendB64(signed);
    await confirmSig(sig);
    const pxSol = await solPrice();
    let usd, qtyIn, px;
    if (inputMint === WSOL) {
      qtyIn = rawAmt / 1e9;
      usd = qtyIn * pxSol;
      px = usd / (q1.outAmount / Math.pow(10, opt && opt.outDecimals || 6));
    } else {
      qtyIn = rawAmt / Math.pow(10, opt && opt.decimals || 6);
      usd = (q1.outAmount / 1e9) * pxSol;
      px = usd / qtyIn;
    }
    return { sig, usd, qtyIn, px, outAmount: q1.outAmount };
  }

  async function reconcileLiveCash() {
    try { await loadLiveBalances(); bot.cashUsd = bot.liveBal.sol * (bot.solPx || 0); }
    catch (e) { console.warn('reconcile', e); }
  }

  async function executeBuy(item, usd) {
    const p = item.pair;
    const mint = item.addr;
    const px = +p.priceUsd;
    bot.agents.executor.status = 'hot';
    bot.agents.executor.detail = 'buying ' + Math.round(bot.settings.posPct * 100) + '%';
    bot.agents.executor.token = item;
    try {
      const solPx = await solPrice();
      const solAmt = usd / solPx;
      let amount = 0, costUsd = usd, fillPx = px, decimals = 6;
      if (bot.settings.mode === 'LIVE') {
        const lamports = Math.floor(solAmt * 1e9);
        const q = await jupQuote(WSOL, mint, lamports, bot.settings.slippageBps);
        if (!q.ok) throw new Error('buy quote failed');
        const rec = await liveSwap(WSOL, mint, lamports, { signalPx: px, outDecimals: decimals });
        await reconcileLiveCash();
        const tok = (bot.liveBal.tokens || []).find(t => t.mint === mint);
        amount = tok ? tok.amount : rec.outAmount / Math.pow(10, decimals);
        if (tok) decimals = tok.decimals;
        costUsd = rec.usd;
        fillPx = amount ? costUsd / amount : px;
        const chk = S.abortIfMoved(px, fillPx, bot.settings);
        if (chk.abort) throw new Error(chk.reason);
      } else {
        const lamports = Math.floor(solAmt * 1e9);
        const q = await jupQuote(WSOL, mint, lamports, bot.settings.slippageBps);
        if (!q.ok) throw new Error('buy quote failed');
        if (q.impactPct > bot.settings.maxImpactPct) throw new Error('impact ' + q.impactPct.toFixed(2) + '%');
        const approx = usd / px;
        const d6 = q.outAmount / 1e6, d9 = q.outAmount / 1e9;
        if (Math.abs(d6 - approx) < Math.abs(d9 - approx)) { decimals = 6; amount = d6; }
        else { decimals = 9; amount = d9; }
        fillPx = amount ? usd / amount : px;
        const chk = S.abortIfMoved(px, fillPx, bot.settings);
        if (chk.abort) throw new Error(chk.reason);
        costUsd = usd;
      }
      const id = 'p' + Date.now() + Math.random().toString(16).slice(2, 6);
      const rugHit = bot.rugCache[mint] && bot.rugCache[mint].d;
      if (rugHit && rugHit.token && isFinite(+rugHit.token.decimals)) decimals = +rugHit.token.decimals;
      let pairAddr = p.pairAddress;
      try {
        const best = await dsBestPair(mint, pairAddr, true);
        if (best && best.pairAddress) { pairAddr = best.pairAddress; item.pair = best; }
      } catch {}
      const used = item.pair || p;
      const quoteLiq = S.quoteLiqUsd(used, bot.solPx || solPx, rugHit);
      S.applyBuy(bot, {
        id, mint, symbol: item.symbol, icon: item.icon, px: fillPx, mc: pairMc(used),
        liq: (used.liquidity && used.liquidity.usd) || 0, quoteLiq, amount, costUsd, t: Date.now(),
        pairAddress: pairAddr
      });
      const pos = bot.positions[bot.positions.length - 1];
      pos.decimals = decimals;
      pos.entryQuoteLiq = quoteLiq;
      addTrade({
        id: 't' + id, t: Date.now(), kind: 'buy', mint, symbol: item.symbol, icon: item.icon,
        usd: costUsd, qty: amount, px: fillPx, mc: pairMc(p), agent: 'Executor', note: 'bought'
      });
      bot.agents.executor.detail = 'bought $' + costUsd.toFixed(0);
      bot.agents.brain.detail = 'holding';
      bot.agents.brain.status = 'hot';
      bot.agents.brain.token = pos;
      pushEquity(equityNow());
      save();
      return pos;
    } catch (e) {
      console.warn('buy failed', e);
      toast('Buy skipped: ' + (e.message || e), 3500);
      bot.agents.executor.detail = 'aborted';
      return null;
    }
  }

  function noteReject(reasons) {
    bot.rejectTally = bot.rejectTally || {};
    const r0 = (reasons && reasons[0]) || 'unknown';
    let bucket = r0;
    if (/^liq|liquidity/.test(r0)) bucket = 'liquidity';
    else if (/young|too new/.test(r0)) bucket = 'too new';
    else if (/too old/.test(r0)) bucket = 'too old';
    else if (/mint/.test(r0)) bucket = 'mint authority';
    else if (/freeze/.test(r0)) bucket = 'freeze authority';
    else if (/LP not/.test(r0)) bucket = 'LP unlocked';
    else if (/danger risks|rugcheck/.test(r0)) bucket = 'rugcheck flags';
    else if (/holders/.test(r0)) bucket = 'holder concentration';
    else if (/buy impact/.test(r0)) bucket = 'buy impact';
    else if (/honeypot|sell quote|sell impact/.test(r0)) bucket = 'honeypot / sell quote';
    else if (/score not yet|score dipped/.test(r0)) bucket = 'score stability';
    else if (/EMA|VWAP|local top|momentum|parabolic|1h |5m |no price|chasing/.test(r0)) bucket = 'momentum: ' + r0;
    else if (/buy count|not rising/.test(r0)) bucket = 'buy count not rising';
    else if (/extreme/i.test(r0)) bucket = 'extreme risk';
    else if (/quote failed|Jupiter/.test(r0)) bucket = 'quote failed';
    else if (/rugcheck failed/.test(r0)) bucket = 'rugcheck failed';
    else if (/no safe/.test(r0)) bucket = 'no scan candidates';
    else if (/quote liquidity|total liquidity|liq\/mcap/.test(r0)) bucket = 'thin exit liquidity';
    else if (/dev holds/.test(r0)) bucket = 'dev holdings';
    else if (/insiders|sniper/.test(r0)) bucket = 'insiders/snipers';
    else if (/5m dump/.test(r0)) bucket = '5m dump';
    else if (/token cooldown/.test(r0)) bucket = 'token cooldown';
    bot.rejectTally[bucket] = (bot.rejectTally[bucket] || 0) + 1;
  }
  async function scanAndMaybeEnter() {
    bot.equityUsd = equityNow();
    pushEquity(bot.equityUsd);
    await ensureFast();
    const now = Date.now();
    const items = solanaFastItems();
    bot.scanned += items.length;
    const scanned = S.scanCandidates(items, now, bot.settings);
    (scanned.whySkip || []).forEach(w => noteReject(w.reasons));
    bot.agents.scanner.status = 'hot';
    bot.agents.scanner.n = bot.scanned;
    bot.agents.scanner.detail = fmtCount(scanned.scanned) + ' pools';
    const gate = S.canOpenMore(bot, bot.settings, now, { solPx: bot.solPx, reserveUsd: reserveUsd() });
    if (!gate.ok) { bot.agents.analyst.detail = gate.reason; bot.agents.analyst.status = 'idle'; return; }
    if (bot.cashUsd - reserveUsd() < 2) { bot.agents.analyst.detail = 'need more cash / reserve'; return; }
    const top = scanned.candidates.slice(0, 5);
    bot.agents.analyst.status = 'hot';
    if (!top.length) { bot.agents.analyst.detail = 'no safe candidates'; noteReject(['no safe candidates']); return; }
    for (const it of top) {
      if (bot.positions.some(p => p.mint === it.addr)) continue;
      if (S.tokenOnCooldown(bot, it.addr, now)) { noteReject(['token cooldown']); continue; }
      const hist = bot.scoreHist[it.addr] || (bot.scoreHist[it.addr] = []);
      hist.push(it.sig.score);
      if (hist.length > 8) hist.shift();
      bot.agents.analyst.token = it;
      bot.agents.analyst.score = it.sig.score;
      bot.agents.analyst.detail = it.symbol + ' score ' + it.sig.score;
      let rug = null, ticks = bot.ticks[it.addr] || [];
      try { rug = await rugReport(it.addr); } catch (e) { bot.agents.analyst.detail = 'rugcheck failed'; noteReject(['rugcheck failed']); continue; }
      if (ticks.length < 12 && it.pair.pairAddress) {
        try { ticks = await gtTicks(it.pair.pairAddress); bot.ticks[it.addr] = ticks; } catch {}
      }
      const pre = S.analyzeSafety({
        item: it, rug, priorScores: hist, ticks, now, skipQuotes: true, solPx: bot.solPx
      }, bot.settings);
      if (!pre.ok) {
        noteReject(pre.reasons);
        bot.agents.analyst.detail = (it.symbol + ' rejected: ' + pre.reasons[0]).slice(0, 52);
        continue;
      }
      const solPx = await solPrice();
      const usd = S.positionUsd(equityNow(), bot.settings, reserveUsd(), bot.solPx || solPx);
      if (usd < 1) { bot.agents.analyst.detail = 'size too small'; return; }
      const lamports = Math.floor((usd / solPx) * 1e9);
      let quoteBuy, quoteSell;
      try {
        quoteBuy = await jupQuote(WSOL, it.addr, lamports, bot.settings.slippageBps);
        const out = quoteBuy.ok ? quoteBuy.outAmount : Math.floor((usd / +it.pair.priceUsd) * 1e6);
        quoteSell = await jupQuote(it.addr, WSOL, Math.max(1, out), bot.settings.slippageBps);
      } catch (e) { bot.agents.analyst.detail = 'quote failed'; noteReject(['quote failed']); continue; }
      const prev = bot.buyerHist[it.addr];
      const h1b = ((it.pair.txns || {}).h1 || {}).buys;
      const verdict = S.analyzeSafety({
        item: it, rug, quoteBuy, quoteSell, priorScores: hist, ticks, now,
        buyerTrend: prev ? { prevH1Buys: prev.h1 } : null,
        solPx
      }, bot.settings);
      bot.buyerHist[it.addr] = { h1: h1b, t: now };
      if (!verdict.ok) {
        noteReject(verdict.reasons);
        bot.agents.analyst.detail = (it.symbol + ' rejected: ' + verdict.reasons[0]).slice(0, 52);
        continue;
      }
      await executeBuy(it, usd);
      return;
    }
  }

  async function tickLoop() {
    if (!bot.running) return;
    try {
      await solPrice();
      if (bot.settings.mode === 'LIVE') await loadLiveBalances().catch(() => {});
      await refreshPositionPrices();
      await checkExits();
      const eq = equityNow();
      bot.equityUsd = eq;
      pushEquity(eq);
      S.updateDayAndHalt(bot, eq, bot.settings, Date.now());
      if (route().name === 'bot') patchLiveUI();
    } catch (e) { console.warn('bot tick', e); }
  }
  async function scanLoop() {
    if (!bot.running) return;
    try {
      const eq = equityNow();
      bot.equityUsd = eq;
      pushEquity(eq);
      await scanAndMaybeEnter();
      if (route().name === 'bot') patchLiveUI();
    } catch (e) { console.warn('bot scan', e); }
  }
  function startTimers() {
    stopTimers();
    bot.timer = setInterval(tickLoop, TICK_MS);
    bot.scanTimer = setInterval(scanLoop, SCAN_MS);
    tickLoop(); scanLoop(); requestWake();
  }
  function stopTimers() {
    if (bot.timer) { clearInterval(bot.timer); bot.timer = null; }
    if (bot.scanTimer) { clearInterval(bot.scanTimer); bot.scanTimer = null; }
  }
  async function requestWake() {
    try {
      if (bot.wake) { try { bot.wake.release(); } catch {} }
      if (navigator.wakeLock) bot.wake = await navigator.wakeLock.request('screen');
    } catch { bot.wake = null; }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && bot.running) requestWake();
  });

  function startBot() {
    if (bot.settings.mode === 'LIVE' && !bot.unlockedSec) { toast('Unlock the burner wallet first'); bot.view = 'wallet'; renderBot(); return; }
    bot.running = true;
    bot.halted = null;
    if (!bot.startTs) {
      bot.startTs = Date.now();
      const eq0 = equityNow();
      bot.startUsd = eq0;
      bot.dayStartEquity = eq0;
      bot.equityUsd = eq0;
    }
    if (!bot.equity.length) pushEquity(equityNow());
    bot.agents = idleAgents();
    save(); startTimers(); renderBot();
  }
  function stopBot() { bot.running = false; stopTimers(); save(); renderBot(); }
  async function killSwitch() {
    bot.halted = 'kill switch';
    toast('Kill switch: selling all positions…');
    await refreshPositionPrices();
    for (const pos of bot.positions.slice()) await executeSell(pos, 1, 'kill');
    bot.running = false; stopTimers(); save(); renderBot();
    toast('Kill switch complete. Bot stopped.');
  }

  function fmtUsd(n, d) {
    if (n == null || !isFinite(n)) return '—';
    const sign = n < 0 ? '-' : '';
    const a = Math.abs(n);
    const dec = d != null ? d : 2;
    return sign + '$' + a.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
  }
  function fmtCount(n) { return n >= 1000 ? n.toLocaleString('en-US') : String(n); }
  function clockNow() { return new Date().toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }); }
  function clockAt(t) { return new Date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }); }
  const openN = () => bot.positions.length;
  function pnlState() {
    const eq = equityNow();
    const start = bot.startUsd || eq;
    const pnl = eq - start;
    const pct = start ? pnl / start * 100 : 0;
    const mult = start ? eq / start : 1;
    return { eq, start, pnl, pct, mult };
  }
  function shareStats() {
    const p = pnlState();
    const text = 'Meme Terminal · Meme Bot\n' + fmtUsd(p.eq) + '  ' + (p.pnl >= 0 ? '+' : '') + fmtUsd(p.pnl) + ' (' + p.pct.toFixed(2) + '%)  ' + p.mult.toFixed(2) + 'x\n' +
      bot.trades.length + ' trades · ' + openN() + ' open · ' + bot.settings.mode + (bot.pub ? '\nBurner: ' + bot.pub : '');
    if (navigator.share) navigator.share({ text }).catch(() => copyText(text));
    else copyText(text);
  }
  function copyText(t) {
    const p = navigator.clipboard && navigator.clipboard.writeText(t);
    if (p) p.then(() => toast('Copied', 1200), () => toast('Copy failed'));
    else toast('Copy failed');
  }

  function agentIcon(name, status) {
    const col = { scanner: '#2ee6c7', analyst: '#ff5a52', executor: '#b084ff', brain: '#ff8a3d' }[name];
    const ring = status === 'danger' ? '#ff5a52' : col;
    const spin = bot.running && status !== 'idle' ? 'term-ring-spin' : '';
    const dash = status === 'idle' ? '92 145' : status === 'danger' ? '128 145' : '112 145';
    const face = {
      scanner: '<g><ellipse cx="26" cy="27" rx="12" ry="11.2" fill="'+col+'"/><path d="M23.2 16.2h5.6M23 18.2h6M25.2 14.8v4.6M27.4 14.8v4.6" fill="none" stroke="#06332c" stroke-width="1.25" stroke-linecap="round"/><circle cx="21.4" cy="25.2" r="1.7" fill="#06332c"/><circle cx="30.6" cy="25.2" r="1.7" fill="#06332c"/><circle cx="21.9" cy="24.6" r=".45" fill="#fff" opacity=".55"/><circle cx="31.1" cy="24.6" r=".45" fill="#fff" opacity=".55"/><path d="M21.8 31c2.5 2.3 6.9 2.3 9.4 0" fill="none" stroke="#06332c" stroke-width="1.55" stroke-linecap="round"/></g>',
      analyst: '<g><path d="M26 9.8l15 27.4H11L26 9.8z" fill="'+col+'" stroke="'+col+'" stroke-linejoin="round" stroke-width="1.6"/><circle cx="22.2" cy="28.2" r="1.75" fill="#2a0808"/><circle cx="29.8" cy="28.2" r="1.75" fill="#2a0808"/><circle cx="22.7" cy="27.6" r=".45" fill="#fff" opacity=".45"/><path d="M22.6 32.6c2.1 1.9 4.7 1.9 6.8 0" fill="none" stroke="#2a0808" stroke-width="1.35" stroke-linecap="round"/></g>',
      executor: '<g><path d="M15.5 24.2c0-6.4 4.4-11.5 10.5-11.5s10.5 5.1 10.5 11.5v11.6c0 1.25-.95 1.55-1.7.7l-2.3-2.55-2.25 2.7c-.6.7-1.65.7-2.25 0l-2-2.5-2 2.5c-.6.7-1.65.7-2.25 0l-2.25-2.7-2.3 2.55c-.75.85-1.7.55-1.7-.7V24.2z" fill="'+col+'"/><circle cx="22.2" cy="23.4" r="1.7" fill="#1a1028"/><circle cx="29.8" cy="23.4" r="1.7" fill="#1a1028"/><circle cx="22.7" cy="22.8" r=".45" fill="#fff" opacity=".5"/><path d="M22.4 28.2c2.2 1.8 5 1.8 7.2 0" fill="none" stroke="#1a1028" stroke-width="1.35" stroke-linecap="round"/></g>',
      brain: '<g><path d="M26 14.2c1.1-2.6 3.8-3.6 5.2-3.4" fill="none" stroke="'+col+'" stroke-width="2.3" stroke-linecap="round"/><ellipse cx="26" cy="27" rx="12.4" ry="11.5" fill="'+col+'"/><circle cx="21.5" cy="25.2" r="1.7" fill="#2a1408"/><circle cx="30.5" cy="25.2" r="1.7" fill="#2a1408"/><circle cx="22" cy="24.6" r=".45" fill="#fff" opacity=".45"/><path d="M21.8 31c2.5 2.2 6.9 2.2 9.4 0" fill="none" stroke="#2a1408" stroke-width="1.5" stroke-linecap="round"/></g>'
    }[name];
    return '<svg class="term-ring '+spin+'" viewBox="0 0 52 52" width="52" height="52" aria-hidden="true"><circle cx="26" cy="26" r="23" fill="none" stroke="rgba(255,255,255,.08)" stroke-width="4.5"/><circle cx="26" cy="26" r="23" fill="none" stroke="'+ring+'" stroke-width="4.5" stroke-linecap="round" stroke-dasharray="'+dash+'" transform="rotate(-90 26 26)"/>'+face+'</svg>';
  }
  function ghIcon() {
    return '<svg class="term-gh" viewBox="0 0 16 16" width="11" height="11" aria-hidden="true"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8a8 8 0 0 0 5.47 7.59c.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82A7.68 7.68 0 0 1 8 3.46c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8 8 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>';
  }
  function tokAv(icon, symbol, cls) {
    const ch = esc((symbol || '?').slice(0, 2));
    const c = cls || 'tav';
    if (icon) return '<img class="'+c+'" src="'+esc(icon)+'" alt="">';
    return '<span class="'+c+' ph">'+ch+'</span>';
  }

  function windowSeries(tf) {
    const now = Date.now();
    const span = { LIVE: 20 * 60e3, '1H': 36e5, '4H': 4 * 36e5, '1D': 864e5, '1W': 7 * 864e5, ALL: Infinity }[tf] || 20 * 60e3;
    const pts = bot.equity.filter(p => now - p.t <= span);
    if (pts.length < 2) {
      const v = pts[0] ? pts[0].v : (bot.startUsd || 200);
      return [{ t: now - Math.min(span, 60000), v }, { t: now, v }];
    }
    return pts;
  }
  function eqAt(t) {
    const e = bot.equity;
    if (!e.length) return bot.startUsd;
    let best = e[0];
    for (const p of e) { if (Math.abs(p.t - t) < Math.abs(best.t - t)) best = p; if (p.t > t) break; }
    return best.v;
  }
  function layoutBubbles(trades, xOf, yOf, W) {
    const all = trades.filter(t => t.kind === 'buy' || t.kind === 'sell' || t.kind === 'stop');
    const vis = [];
    ['sell', 'stop', 'buy'].forEach(k => { const x = all.find(t => t.kind === k && !vis.includes(t)); if (x) vis.push(x); });
    all.forEach(t => { if (vis.length < 3 && !vis.includes(t)) vis.push(t); });
    const placed = [];
    vis.forEach((tr, i) => {
      const x = xOf(tr.t);
      if (x < 4 || x > W - 4) return;
      const y = yOf(eqAt(tr.t));
      const w = tr.kind === 'buy' ? 128 : 146;
      const h = 38;
      let bx = Math.max(8, Math.min(W - w - 8, x - w / 2));
      let by = Math.max(58, y - 66);
      if (bx + w > W - 86 && by < 52) bx = Math.max(8, W - w - 96);
      let guard = 0;
      const overlap = () => placed.some(p => Math.abs((p.bx + p.w / 2) - (bx + w / 2)) < (p.w + w) / 2 - 2 && Math.abs(p.by - by) < (p.h + h) / 2 - 2);
      while (overlap() && guard++ < 16) {
        by += (i % 2 ? 18 : -18);
        if (by < 56) { by = 56; bx = Math.min(W - w - 8, bx + 28); }
        if (by > y - 18) { by = Math.max(56, y - 72); bx = Math.max(8, bx - 22); }
      }
      placed.push({ tr, x, y, bx, by, w, h });
    });
    return placed;
  }

  function drawChart() {
    const host = document.getElementById('termChart');
    if (!host) return;
    const cnv = host.querySelector('canvas');
    const overlay = host.querySelector('.term-bubs');
    const hint = document.getElementById('termHint');
    const dot = document.getElementById('termDot');
    if (!cnv) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = host.clientWidth || 390, H = host.clientHeight || 260;
    cnv.width = W * dpr; cnv.height = H * dpr;
    cnv.style.width = W + 'px'; cnv.style.height = H + 'px';
    const g = cnv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    g.strokeStyle = 'rgba(255,255,255,0.045)';
    g.lineWidth = 1;
    for (let i = 1; i <= 5; i++) {
      const y = (H / 6) * i;
      g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke();
    }
    const pts = windowSeries(bot.tf);
    const ys = pts.map(p => p.v);
    let lo = Math.min.apply(null, ys), hi = Math.max.apply(null, ys);
    const empty = !(bot.trades && bot.trades.length);
    if (hi - lo < Math.max(2, hi * 0.04)) {
      const mid = (hi + lo) / 2 || 200;
      const pad = Math.max(8, mid * 0.08);
      lo = mid - pad * 0.45;
      hi = mid + pad * 1.35;
    }
    const padT = Math.max(118, Math.round(H * 0.42)), padB = 22;
    const xOf = t => { const a = pts[0].t, b = pts[pts.length - 1].t || a + 1; return (t - a) / (b - a || 1) * (W - 8) + 4; };
    const yOf = v => padT + (1 - (v - lo) / (hi - lo || 1)) * (H - padT - padB);
    const path = () => { g.beginPath(); pts.forEach((p, i) => { const x = xOf(p.t), y = yOf(p.v); i ? g.lineTo(x, y) : g.moveTo(x, y); }); };
    path(); g.lineTo(xOf(pts[pts.length - 1].t), H); g.lineTo(xOf(pts[0].t), H); g.closePath();
    const yLine = yOf(pts[pts.length - 1].v);
    const grad = g.createLinearGradient(0, yLine, 0, H);
    grad.addColorStop(0, 'rgba(30, 227, 106, 0.40)');
    grad.addColorStop(0.5, 'rgba(12, 90, 44, 0.16)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad; g.fill();
    path(); g.strokeStyle = 'rgba(30,227,106,.28)'; g.lineWidth = 7; g.lineJoin = 'round'; g.lineCap = 'round'; g.stroke();
    path(); g.strokeStyle = '#1ee36a'; g.lineWidth = 2.4; g.stroke();
    const t0 = pts[0].t, t1 = pts[pts.length - 1].t;
    const trades = bot.trades.filter(tr => tr.t >= t0 && tr.t <= t1 + 1000);
    const latestStop = trades.find(tr => tr.kind === 'stop');
    trades.forEach(tr => {
      const x = xOf(tr.t), y = yOf(eqAt(tr.t));
      if (tr.kind === 'stop') {
        g.beginPath(); g.arc(x, y, 7, 0, Math.PI * 2); g.strokeStyle = 'rgba(255,80,70,.55)'; g.lineWidth = 2; g.stroke();
        if (tr === latestStop) { g.beginPath(); g.arc(x, y, 11, 0, Math.PI * 2); g.strokeStyle = 'rgba(255,70,60,.4)'; g.lineWidth = 2; g.stroke(); }
        g.beginPath(); g.arc(x, y, 3.2, 0, Math.PI * 2); g.fillStyle = '#ff5a52'; g.fill();
      } else {
        g.beginPath(); g.arc(x, y, 4, 0, Math.PI * 2);
        g.fillStyle = tr.kind === 'buy' ? '#3d8bff' : '#1ee36a'; g.fill();
      }
    });
    const last = pts[pts.length - 1];
    const ex = xOf(last.t), ey = yOf(last.v);
    g.beginPath(); g.arc(ex, ey, 8, 0, Math.PI * 2);
    g.fillStyle = 'rgba(30,227,106,.18)'; g.fill();
    g.beginPath(); g.arc(ex, ey, 3.4, 0, Math.PI * 2);
    g.fillStyle = '#1ee36a'; g.fill();
    if (dot) { dot.style.left = ex + 'px'; dot.style.top = ey + 'px'; dot.hidden = false; }
    if (hint) {
      hint.classList.toggle('off', !empty);
      if (empty) hint.style.top = Math.max(8, ey - 28) + 'px';
    }
    const placed = layoutBubbles(trades, xOf, yOf, W);
    if (overlay) {
      overlay.innerHTML = placed.map(b => {
        const tr = b.tr;
        const typ = tr.kind === 'buy' ? 'buy' : tr.kind === 'stop' ? 'stop' : 'sell';
        const pill = (tr.kind !== 'buy' && tr.mult && tr.mult >= 1.15) ? '<span class="bpill">x' + tr.mult.toFixed(2) + '</span>' : '';
        const line2 = typ === 'buy' ? 'bought ' + fmtUsd(tr.usd)
          : typ === 'stop' ? 'stop −' + fmtUsd(Math.abs(tr.pnlUsd || 0))
          : 'sold +' + fmtUsd(Math.abs(tr.pnlUsd || 0));
        const connH = Math.max(8, b.y - b.by - 36);
        return '<div class="tbub '+typ+'" style="left:'+b.bx+'px;top:'+b.by+'px">'+
          tokAv(tr.icon, tr.symbol, 'tav sm')+'<div class="tbub-t"><div class="tbub-h"><b>'+esc(tr.symbol)+'</b>'+pill+'</div><span>'+line2+'</span></div>'+
          '<i class="tconn" style="height:'+connH+'px"></i></div>';
      }).join('');
    }
  }

  function pillLive() {
    if (bot.settings.mode === 'LIVE') return '<span class="term-mode live'+(bot.running ? '' : ' off')+'"><i></i>Live</span>';
    return '<span class="term-mode paper"><i></i>Paper</span>';
  }
  function odometerHTML(value, cls) {
    return '<span class="term-bal '+cls+'" id="termBal" data-v="'+value+'">'+fmtUsd(value)+'</span>';
  }
  function fitBalance(el, text) {
    if (!el) return;
    el.style.fontSize = (text && text.length > 9) ? '60px' : '';
  }
  function animateBalance(el, from, to, cls) {
    if (!el) return;
    el.className = 'term-bal ' + cls;
    const start = performance.now(), dur = 820;
    const step = now => {
      const k = Math.min(1, (now - start) / dur);
      const v = from + (to - from) * (1 - Math.pow(1 - k, 3));
      el.dataset.v = v;
      const text = fmtUsd(v);
      el.textContent = text;
      fitBalance(el, text);
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
  function flashHTML() {
    const f = bot.lastFlash;
    if (!f || Date.now() - f.t > 8000 || f.kind === 'buy') return '';
    const up = (f.usd || 0) >= 0 && f.kind !== 'stop';
    const n = f.kind === 'stop' ? -Math.abs(f.usd || 0) : f.usd;
    if (!n) return '';
    return '<span class="term-flash '+(up ? 'up' : 'dn')+'">'+(n >= 0 ? '+' : '')+fmtUsd(n)+'</span>';
  }

  function agentsHTML() {
    const a = bot.agents;
    const glow = (key, ag) => {
      if (ag.status === 'danger') return 'on-red';
      if (ag.status !== 'hot') return '';
      return 'on-' + ({ scanner: 'teal', analyst: 'red', executor: 'purple', brain: 'green' }[key] || 'teal');
    };
    const card = (key, title, src, bottom) => {
      const ag = a[key];
      return '<div class="agcard '+glow(key, ag)+'" data-ag="'+key+'">'+agentIcon(key, ag.status)+
        '<div class="agbody"><div class="agtitle">'+title+'</div><div class="agsrc">'+ghIcon()+' '+esc(src)+'</div><div class="agbot">'+bottom(ag)+'</div></div></div>';
    };
    return '<div class="term-agents">'+
      card('scanner', 'Scanner', 'dexscreener', ag => tokAv(null, '#', 'tav xs')+' <span class="ok">'+esc(ag.detail)+'</span>')+
      card('analyst', 'Analyst', 'rugcheck', ag => {
        const t = ag.token;
        return (t ? tokAv(t.icon, t.symbol, 'tav xs')+' ' : '')+'<span class="ok">'+(t ? esc(t.symbol)+' score '+(ag.score || (t.sig && t.sig.score) || '') : esc(ag.detail))+'</span>';
      })+
      card('executor', 'Executor', 'jupiter', ag => {
        const t = ag.token;
        return (t ? tokAv(t.icon, t.symbol || t.mint, 'tav xs')+' ' : '')+'<span class="ok">'+esc(ag.detail)+'</span>';
      })+
      card('brain', 'Brain', 'brain', ag => {
        const t = ag.token;
        return (t ? tokAv(t.icon, t.symbol, 'tav xs')+' ' : '')+'<span class="ok">'+esc(ag.detail)+'</span>';
      })+
    '</div>';
  }

  function activityHTML() {
    const rows = bot.trades.slice(0, 20);
    if (!rows.length) return '<div class="term-empty">'+
      '<svg class="term-empty-ico" viewBox="0 0 64 64" aria-hidden="true"><rect x="4" y="8" width="56" height="48" rx="14" fill="rgba(255,255,255,.04)" stroke="rgba(255,255,255,.08)"/><path d="M10 40c8-2 12-16 22-16s12 18 22 10" fill="none" stroke="#1ee36a" stroke-width="2.2" stroke-linecap="round"/><circle cx="54" cy="30" r="3.1" fill="#1ee36a"/></svg>'+
      '<b>Waiting for the first fill</b>'+
      '<span>Safety checks come first. Fast Solana coins only, after every gate passes.</span></div>';
    return rows.map(tr => {
      const badge = tr.kind === 'buy' ? 'b-buy' : tr.kind === 'stop' ? 'b-stop' : 'b-sell';
      const mark = tr.kind === 'buy' ? '↓' : tr.kind === 'stop' ? '×' : '✓';
      const title = tr.kind === 'buy' ? 'Bought '+esc(tr.symbol)
        : tr.kind === 'stop' ? 'Stopped '+esc(tr.symbol)
        : (tr.frac && tr.frac < 0.99 ? 'Sold '+Math.round(tr.frac * 100)+'% '+esc(tr.symbol) : 'Sold '+esc(tr.symbol));
      const sub = esc(tr.agent || '')+' · '+esc(tr.note || '')+' · '+clockAt(tr.t);
      const amt = tr.kind === 'buy' ? fmtUsd(tr.usd) : ((tr.pnlUsd || 0) >= 0 ? '+' : '')+fmtUsd(tr.pnlUsd || 0);
      const amtCls = tr.kind === 'buy' ? '' : ((tr.pnlUsd || 0) >= 0 ? 'up' : 'dn');
      const right2 = tr.kind === 'buy' && tr.mc ? fmtBig(tr.mc)+' MC'
        : tr.kind === 'stop' && tr.pnlPct != null ? (tr.pnlPct * 100).toFixed(1)+'%'
        : tr.mult ? tr.mult.toFixed(1)+'x' : '';
      return '<div class="act"><div class="act-av">'+tokAv(tr.icon, tr.symbol)+'<i class="'+badge+'">'+mark+'</i></div>'+
        '<div class="act-m"><div class="act-t">'+title+'</div><div class="act-s">'+sub+'</div></div>'+
        '<div class="act-r"><div class="'+amtCls+'">'+amt+'</div><div class="act-s">'+esc(right2)+'</div></div></div>';
    }).join('');
  }

  function positionsHTML() {
    if (!bot.positions.length) return '';
    return '<div class="term-h3">Open <span>'+bot.positions.length+'</span></div>'+bot.positions.map(p => {
      const px = lastPx(p);
      const pnl = (px / p.entryPx - 1) * 100;
      const val = p.amount * px;
      const uPnL = val - p.costUsd;
      return '<div class="pos"><div class="act-av">'+tokAv(p.icon, p.symbol)+'</div><div class="act-m"><div class="act-t">'+esc(p.symbol)+'</div>'+
        '<div class="act-s">'+fmtUsd(val)+' · MC '+(p._mc ? fmtBig(p._mc) : (p.entryMc ? fmtBig(p.entryMc) : '—'))+'</div></div>'+
        '<div class="act-r"><div class="'+(uPnL >= 0 ? 'up' : 'dn')+'">'+(uPnL >= 0 ? '+' : '')+fmtUsd(uPnL)+' ('+(pnl >= 0 ? '+' : '')+pnl.toFixed(1)+'%)</div>'+
        '<button class="sellbtn" data-sell="'+esc(p.id)+'">Sell</button></div></div>';
    }).join('');
  }

  function bannerHTML() {
    try { if (ls.get('bot:hideBanner')) return ''; } catch {}
    return '<div class="term-banner" id="termBanner"><svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M8 4.6v4.6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="8" cy="11.6" r=".9" fill="currentColor"/></svg><span>Runs only while the app is open — keep the screen on</span><button type="button" class="term-banner-x" id="termBannerX" aria-label="Dismiss">×</button></div>';
  }
  function bindBanner() {
    const x = document.getElementById('termBannerX');
    if (x) x.onclick = () => { try { ls.set('bot:hideBanner', 1); } catch {} const b = document.getElementById('termBanner'); if (b) b.remove(); };
  }
  function termHeader(title) {
    return '<header class="term-top"><button type="button" class="term-back" id="termBack" aria-label="Back">'+chev()+'</button>'+
      '<div class="term-title">'+title+'</div>'+
      '<button type="button" class="term-share" id="termShare"><svg viewBox="0 0 24 24" width="16" height="16"><path d="M4 12v7a1 1 0 001 1h14a1 1 0 001-1v-7M16 6l-4-4-4 4M12 2v14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg> Share</button></header>';
  }
  function chev() { return '<svg viewBox="0 0 24 24" width="22" height="22"><path d="M15 18l-6-6 6-6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>'; }
  function botFace() {
    return '<span class="term-face" aria-hidden="true"><svg viewBox="0 0 32 32" width="28" height="28"><circle cx="16" cy="16" r="16" fill="#f4f4f5"/><circle cx="11.5" cy="14" r="2" fill="#111"/><circle cx="20.5" cy="14" r="2" fill="#111"/><path d="M11 20c1.6 2.2 8.4 2.2 10 0" fill="none" stroke="#111" stroke-width="1.7" stroke-linecap="round"/></svg></span>';
  }

  function renderTerm() {
    const p = pnlState();
    const cls = p.pnl > 1 ? 'up' : p.pnl < -1 ? 'dn' : '';
    const flashKind = bot.lastFlash && Date.now() - bot.lastFlash.t < 8000 && bot.lastFlash.kind;
    const balCls = flashKind === 'stop' ? 'dn' : (flashKind === 'sell' ? 'up' : cls);
    app.innerHTML = '<div class="term">'+termHeader('Meme Terminal')+
      bannerHTML()+
      '<div class="term-botrow"><button type="button" class="term-botid" id="termBotBtn">'+botFace()+' <span>Meme Bot</span> <i>›</i></button>'+pillLive()+'</div>'+
      '<div class="term-hero">'+
      '<div class="term-chart" id="termChart"><canvas></canvas><div class="term-dot" id="termDot"></div><div class="term-hint" id="termHint">Waiting for first trade…</div><div class="term-bubs"></div></div>'+
      '<div class="term-sub"><span>Solana · '+openN()+' open</span><span id="termClock">'+clockNow()+'</span></div>'+
      '<div class="term-balwrap">'+odometerHTML(p.eq, balCls)+flashHTML()+'</div>'+
      '<div class="term-pnl"><span class="'+(p.pnl >= 0 ? 'up' : 'dn')+'">'+(p.pnl >= 0 ? '▲' : '▼')+' '+fmtUsd(Math.abs(p.pnl))+' ('+Math.abs(p.pct).toFixed(2)+'%)</span><span class="term-mult">'+p.mult.toFixed(2)+'×</span></div>'+
      '</div>'+
      '<div class="term-tfs">'+['LIVE','1H','4H','1D','1W','ALL'].map(t => '<button type="button" data-tf="'+t+'" class="'+(bot.tf === t ? 'on' : '')+'">'+(t === 'LIVE' ? '• LIVE' : t)+'</button>').join('')+'</div>'+
      '<div class="term-h3">Agents <span>4 running</span></div>'+agentsHTML()+
      '<div class="term-h3">Activity <span>'+bot.trades.length+' trade'+(bot.trades.length === 1 ? '' : 's')+'</span></div>'+
      '<div class="term-act">'+activityHTML()+'</div>'+positionsHTML()+
      '<div class="term-foot"><button type="button" class="term-cta '+(bot.running ? 'stop' : '')+'" id="termToggle">'+(bot.running ? 'Pause bot' : (bot.settings.mode === 'LIVE' ? 'Start LIVE bot' : 'Start paper bot'))+'</button>'+
      '<button type="button" class="term-link" id="termWallet">Wallet</button>'+
      '<button type="button" class="term-link" id="termSettings">Settings</button></div>'+
      '<div class="note term-note">Fast Solana memecoins only, holds of about 60–90 minutes. The bot does not predict price and can lose the whole burner wallet. PAPER uses live quotes with fake money. LIVE signs real Jupiter swaps on Solana.</div></div>';
    bindTerm();
    const bal = document.getElementById('termBal');
    if (bal) fitBalance(bal, bal.textContent);
    requestAnimationFrame(drawChart);
  }

  function bindTerm() {
    bindBanner();
    const back = $('#termBack'); if (back) back.onclick = () => { location.hash = '#/'; };
    const sh = $('#termShare'); if (sh) sh.onclick = shareStats;
    const botBtn = $('#termBotBtn'); if (botBtn) botBtn.onclick = () => { bot.view = 'wallet'; renderBot(); };
    app.querySelectorAll('[data-tf]').forEach(b => b.onclick = () => { bot.tf = b.dataset.tf; save(); renderBot(); });
    const tog = $('#termToggle'); if (tog) tog.onclick = () => bot.running ? stopBot() : startBot();
    const w = $('#termWallet'); if (w) w.onclick = () => { bot.view = 'wallet'; renderBot(); };
    const s = $('#termSettings'); if (s) s.onclick = () => { bot.view = 'settings'; renderBot(); };
    app.querySelectorAll('[data-sell]').forEach(b => b.onclick = async () => {
      const pos = bot.positions.find(p => p.id === b.dataset.sell);
      if (!pos) return;
      b.disabled = true; b.textContent = 'Selling…';
      await refreshPositionPrices();
      await executeSell(pos, 1, 'manual');
      renderBot();
    });
  }

  function patchLiveUI() {
    if (route().name !== 'bot' || bot.view !== 'term') return;
    const p = pnlState();
    const el = $('#termBal');
    if (el) {
      const prev = parseFloat(el.dataset.v);
      const flashKind = bot.lastFlash && Date.now() - bot.lastFlash.t < 8000 && bot.lastFlash.kind;
      const cls = flashKind === 'stop' ? 'dn' : flashKind === 'sell' ? 'up' : (p.pnl > 1 ? 'up' : p.pnl < -1 ? 'dn' : '');
      if (isFinite(prev) && Math.abs(prev - p.eq) > 0.005) animateBalance(el, prev, p.eq, cls);
      else { el.className = 'term-bal ' + cls; el.dataset.v = p.eq; el.textContent = fmtUsd(p.eq); fitBalance(el, el.textContent); }
    }
    const cl = $('#termClock'); if (cl) cl.textContent = clockNow();
    const wrap = document.querySelector('.term-balwrap');
    if (wrap) {
      const f = wrap.querySelector('.term-flash');
      const html = flashHTML();
      if (html && !f) wrap.insertAdjacentHTML('beforeend', html);
      else if (!html && f) f.remove();
    }
    const pnl = document.querySelector('.term-pnl');
    if (pnl) pnl.innerHTML = '<span class="'+(p.pnl >= 0 ? 'up' : 'dn')+'">'+(p.pnl >= 0 ? '▲' : '▼')+' '+fmtUsd(Math.abs(p.pnl))+' ('+Math.abs(p.pct).toFixed(2)+'%)</span><span class="term-mult">'+p.mult.toFixed(2)+'×</span>';
    const ag = document.querySelector('.term-agents');
    if (ag) ag.outerHTML = agentsHTML();
    const act = document.querySelector('.term-act');
    if (act) act.innerHTML = activityHTML();
    drawChart();
  }

  function bindWalletChrome() {
    const back = $('#termBack'); if (back) back.onclick = () => { bot.view = 'term'; renderBot(); };
    const sh = $('#termShare'); if (sh) sh.onclick = shareStats;
    const bt = $('#backTerm'); if (bt) bt.onclick = () => { bot.view = 'term'; renderBot(); };
  }

  async function renderWallet() {
    await ensureWallet().catch(e => toast(e.message));
    if (bot.pub) { try { await solPrice(); await loadLiveBalances(); } catch (e) { console.warn(e); } }
    let qr = '';
    try { if (bot.pub && lib() && lib().qrDataUrl) qr = await lib().qrDataUrl(bot.pub); } catch (e) { console.warn('qr', e); }
    const tokens = (bot.liveBal.tokens || []);
    app.innerHTML = '<div class="term term-page">'+termHeader('Wallet')+
      bannerHTML()+
      '<div class="card warn"><b>This is a hot burner wallet</b> kept in this phone’s browser storage. It is not a hardware wallet. Anyone with the phone or the exported key can spend the funds. Start with a small amount you can afford to lose. Never reuse your main Phantom seed.</div>'+
      '<div class="card"><div class="wal-label">Deposit address (Solana)</div><div class="wal-addr" id="walAddr">'+esc(bot.pub || '—')+'</div>'+
      '<div class="wal-actions"><button class="term-cta" id="copyAddr">Copy address</button></div>'+
      (qr ? '<img class="wal-qr" alt="Deposit QR" src="'+qr+'">' : '')+
      '<div class="note">Fund it from Phantom: Send SOL to this address. The bot never asks for your Phantom seed.</div></div>'+
      '<div class="card"><h3>Balances</h3><div class="ind"><div class="lv"><small>SOL</small><b>'+(bot.liveBal.sol || 0).toFixed(4)+'</b><span class="pxsub">'+fmtUsd((bot.liveBal.sol || 0) * (bot.solPx || 0))+'</span></div>'+
      '<div class="lv"><small>Paper cash</small><b>'+fmtUsd(bot.cashUsd)+'</b></div></div>'+
      (tokens.map(t => '<div class="note">'+esc(t.mint.slice(0, 4)+'…'+t.mint.slice(-4))+' · '+t.amount+'</div>').join('') || '<div class="note">No SPL tokens in the burner wallet yet.</div>')+'</div>'+
      '<div class="card"><h3>Withdraw</h3><label class="set-lab">Phantom address</label><input class="set-in" id="wdTo" placeholder="Solana address" autocomplete="off" spellcheck="false">'+
      '<label class="set-lab">Amount (SOL)</label><input class="set-in" id="wdAmt" type="number" inputmode="decimal" placeholder="0.1">'+
      '<label class="chk"><input type="checkbox" id="wdSellAll"> Sell all tokens, then withdraw SOL (keep a tiny fee reserve)</label>'+
      '<button class="term-cta" id="wdBtn">Simulate & withdraw</button><div class="note" id="wdMsg"></div></div>'+
      '<div class="card"><h3>Export private key</h3><p class="note" style="margin-top:0">Base58, importable in Phantom (Private Key). Revealed only on this device, never sent to a server.</p>'+
      (bot.hasPin && !bot.unlockedSec ? '<input class="set-in" id="exPin" type="password" inputmode="numeric" placeholder="PIN to unlock"><button class="term-cta" id="exUnlock">Unlock</button>' : '')+
      '<button class="lk" id="exAsk">I understand — reveal key</button><div id="exBox" hidden><code class="wal-addr" id="exKey"></code><button class="term-cta" id="exCopy">Copy key</button></div></div>'+
      '<div class="card"><h3>Optional PIN lock</h3>'+(bot.hasPin ? '<div class="note">Wallet is PIN-encrypted on this device.</div>' : '<input class="set-in" id="newPin" type="password" inputmode="numeric" placeholder="New PIN (4+ digits)"><button class="lk" id="setPin">Encrypt wallet with PIN</button>')+'</div>'+
      '<div class="term-foot"><button class="term-link" id="backTerm">Back to terminal</button></div></div>';
    bindWalletChrome(); bindBanner();
    const copyA = $('#copyAddr'); if (copyA) copyA.onclick = () => copyText(bot.pub || '');
    const exAsk = $('#exAsk');
    if (exAsk) exAsk.onclick = () => {
      if (!confirm('The private key can spend every token in this burner wallet. Only reveal it if you need to import it into Phantom. Continue?')) return;
      if (!bot.unlockedSec) { toast('Unlock with your PIN first'); return; }
      $('#exBox').hidden = false;
      $('#exKey').textContent = bot.unlockedSec;
    };
    const exCopy = $('#exCopy'); if (exCopy) exCopy.onclick = () => copyText(bot.unlockedSec || '');
    const exUnlock = $('#exUnlock');
    if (exUnlock) exUnlock.onclick = async () => {
      const ok = await unlock($('#exPin').value);
      toast(ok ? 'Unlocked' : 'Wrong PIN');
      if (ok) renderWallet();
    };
    const setPinBtn = $('#setPin');
    if (setPinBtn) setPinBtn.onclick = async () => {
      try { await setPin($('#newPin').value); toast('PIN set'); renderWallet(); }
      catch (e) { toast(e.message); }
    };
    const wdBtn = $('#wdBtn'); if (wdBtn) wdBtn.onclick = () => doWithdraw();
  }

  async function doWithdraw() {
    const to = (($('#wdTo') && $('#wdTo').value) || '').trim();
    const msg = $('#wdMsg');
    const L = lib();
    if (!L) { toast('Library missing'); return; }
    let dest;
    try { dest = new L.PublicKey(to); } catch { toast('Invalid Solana address'); return; }
    if (!bot.unlockedSec) { toast('Unlock the wallet first'); return; }
    const sellAll = $('#wdSellAll') && $('#wdSellAll').checked;
    msg.textContent = 'Working…';
    try {
      if (sellAll && bot.positions.length) {
        await refreshPositionPrices();
        for (const pos of bot.positions.slice()) await executeSell(pos, 1, 'kill');
      }
      if (bot.settings.mode !== 'LIVE') {
        msg.textContent = 'PAPER mode: no real SOL sent. In LIVE, this would transfer SOL to that address after a simulateTransaction check.';
        toast('Paper withdraw simulated');
        return;
      }
      await loadLiveBalances();
      const feeKeep = 0.003;
      let amt = parseFloat($('#wdAmt') && $('#wdAmt').value);
      if (!isFinite(amt) || amt <= 0) amt = Math.max(0, bot.liveBal.sol - feeKeep);
      if (amt <= 0) throw new Error('Nothing to withdraw (keep a fee reserve)');
      const lamports = Math.floor(amt * 1e9);
      const kp = keypair();
      const bh = await rpc('getLatestBlockhash', [{ commitment: 'finalized' }]);
      const tx = new L.Transaction().add(L.SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: dest, lamports }));
      tx.feePayer = kp.publicKey;
      tx.recentBlockhash = bh.blockhash || bh;
      tx.sign(kp);
      const b64 = bytesToB64(tx.serialize());
      const sim = await simulateB64(b64);
      if (sim && sim.value && sim.value.err) throw new Error('Simulation failed: ' + JSON.stringify(sim.value.err));
      if (!confirm('Simulation succeeded. Send ' + amt.toFixed(4) + ' SOL to ' + to + '?')) { msg.textContent = 'Cancelled'; return; }
      const sig = await sendB64(b64);
      await confirmSig(sig);
      msg.textContent = 'Sent. Signature ' + sig;
      await loadLiveBalances();
      toast('Withdraw sent');
    } catch (e) {
      msg.textContent = e.message || String(e);
      toast('Withdraw failed: ' + (e.message || e));
    }
  }

  function setNum(id, label, val, hint) {
    return '<label class="set-lab">'+esc(label)+'</label><input class="set-in" id="'+id+'" type="number" value="'+esc(val)+'"><div class="set-hint">'+esc(hint)+'</div>';
  }

  function renderSettings() {
    const s = bot.settings;
    app.innerHTML = '<div class="term term-page">'+termHeader('Settings')+
      bannerHTML()+
      '<div class="card"><h3>Mode</h3><div class="seg" id="modeSeg">'+
      '<button type="button" data-mode="PAPER" class="'+(s.mode !== 'LIVE' ? 'on' : '')+'">PAPER</button>'+
      '<button type="button" data-mode="LIVE" class="'+(s.mode === 'LIVE' ? 'on' : '')+'">LIVE</button></div>'+
      '<div class="note">'+(s.mode === 'LIVE' ? 'LIVE uses real SOL in the burner wallet. Trades are signed on this phone and sent to Solana.' : 'PAPER simulates fills from live Jupiter quotes. No real money moves.')+'</div></div>'+
      '<div class="card"><h3>Risk (quick flips, capital first)</h3>'+
      setNum('posPct', 'Position size', (s.posPct * 100).toFixed(0), '% of equity, default 5, max 10')+
      setNum('maxOpen', 'Max open positions', s.maxOpen, 'default 8, hard cap 8 (~40% if size is 5%)')+
      setNum('tpPct', 'Take profit', (s.tpPct * 100).toFixed(0), '% · sell half')+
      setNum('tpSellPct', 'Sell at TP', (s.tpSellPct * 100).toFixed(0), '% of the position')+
      setNum('trailPct', 'Trailing stop', (s.trailPct * 100).toFixed(0), '% off peak after TP or +20%')+
      setNum('slPct', 'Hard stop loss', (s.slPct * 100).toFixed(0), '% checked about every 1s')+
      setNum('maxHoldMin', 'Max hold', s.maxHoldMin, 'minutes (60–120 for Fast flips)')+
      setNum('dailyLossPct', 'Daily loss cap', (s.dailyLossPct * 100).toFixed(0), '% of the day-start balance → auto-stop entries')+
      setNum('slippageBps', 'Slippage cap', s.slippageBps, 'basis points')+
      setNum('minScore', 'Min momentum score', s.minScore, 'needs ' + (s.scoreScans || 2) + ' stable scans')+
      setNum('minAgeMin', 'Min pair age', s.minAgeMin, 'minutes')+
      setNum('minSolReserve', 'Fee reserve', s.minSolReserve, 'SOL kept for fees')+
      '<label class="set-lab">Custom RPC URL</label><input class="set-in" id="rpcUrl" value="'+esc(s.rpcUrl || '')+'" placeholder="https://solana-rpc.publicnode.com">'+
      '<div class="note">Public RPC is fine for paper. For LIVE sends, a free Helius (or similar) RPC is more reliable.</div></div>'+
      '<div class="card"><button class="term-cta" id="saveSet">Save settings</button>'+
      '<button class="term-cta danger" id="kill">KILL SWITCH — sell all & stop</button></div>'+
      '<div class="term-foot"><button class="term-link" id="backTerm">Back to terminal</button></div></div>';
    bindWalletChrome();
    bindBanner();
    app.querySelectorAll('#modeSeg [data-mode]').forEach(b => b.onclick = () => {
      if (b.dataset.mode === 'LIVE') {
        if (!confirm('LIVE mode spends real SOL from the burner wallet on Fast Solana memecoins. You can lose everything you deposit. The bot only runs while the app is open. Continue?')) return;
        if (!confirm('Tap OK again to confirm LIVE trading with real money.')) return;
      }
      bot.settings.mode = b.dataset.mode;
      save(); renderSettings();
    });
    $('#saveSet').onclick = () => {
      const val = id => parseFloat(document.getElementById(id).value);
      const pct = (id, max) => { const v = val(id); if (isFinite(v)) bot.settings[id] = Math.min(max != null ? max : 99, v / 100); };
      pct('posPct', 0.10);
      bot.settings.maxOpen = Math.max(1, Math.min(8, Math.round(val('maxOpen') || 8)));
      pct('tpPct'); pct('tpSellPct', 1); pct('trailPct'); pct('slPct'); pct('dailyLossPct');
      if (isFinite(val('maxHoldMin'))) bot.settings.maxHoldMin = Math.max(30, Math.min(180, val('maxHoldMin')));
      if (isFinite(val('slippageBps'))) bot.settings.slippageBps = val('slippageBps');
      if (isFinite(val('minScore'))) bot.settings.minScore = val('minScore');
      if (isFinite(val('minAgeMin'))) bot.settings.minAgeMin = val('minAgeMin');
      if (isFinite(val('minSolReserve'))) bot.settings.minSolReserve = val('minSolReserve');
      bot.settings.rpcUrl = ($('#rpcUrl').value || '').trim() || S.DEFAULTS.rpcUrl;
      bot.settings.posPct = Math.min(0.10, Math.max(0.02, bot.settings.posPct));
      save(); toast('Settings saved');
    };
    $('#kill').onclick = () => { if (!confirm('Sell every open position now and stop the bot?')) return; killSwitch(); };
  }

  function demoRequested() {
    try {
      if (window.__BOT_DEMO === true) return true;
      if (localStorage.getItem('bot:demo') === '1') return true;
      const hashQ = (location.hash.split('?')[1] || '');
      const search = (location.search || '').replace(/^\?/, '');
      return /(?:^|&)demo=1(?:&|$)/.test(hashQ + '&' + search);
    } catch { return false; }
  }
  function demoIcon(bg, letter) {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><circle cx="20" cy="20" r="20" fill="'+bg+'"/><text x="20" y="25" text-anchor="middle" font-size="15" font-family="-apple-system,system-ui,sans-serif" font-weight="700" fill="#fff">'+letter+'</text></svg>';
    return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
  }
  function loadDemoData() {
    const now = Date.now();
    const T = m => now - (18 - m) * 60e3;
    const icoN = demoIcon('#3d8bff', 'N');
    const icoR = demoIcon('#ff7a3d', 'R');
    const icoP = demoIcon('#1ee36a', 'P');
    const key = [
      [0, 200], [1, 200.2], [2, 199.8], [2.8, 200],
      [3, 200], [4, 206], [5, 214], [6, 228], [7, 238],
      [8, 248], [8.2, 248], [10, 248], [10.5, 252], [11, 246], [11.5, 242],
      [12, 244.9], [13, 245], [14, 245], [14.5, 258], [15, 272], [15.5, 290],
      [16, 308], [16.5, 322], [17, 307], [17.2, 312], [17.6, 318], [18, 324.4]
    ];
    const pts = key.map(([m, v]) => ({ t: T(m), v }));
    bot.equity = [];
    for (let ts = pts[0].t; ts <= now; ts += 12000) {
      let a = pts[0], b = pts[pts.length - 1];
      for (let i = 0; i < pts.length - 1; i++) if (ts >= pts[i].t && ts <= pts[i + 1].t) { a = pts[i]; b = pts[i + 1]; break; }
      if (ts >= pts[pts.length - 1].t) { bot.equity.push({ t: ts, v: pts[pts.length - 1].v }); continue; }
      const k = (ts - a.t) / (b.t - a.t || 1);
      bot.equity.push({ t: ts, v: a.v + (b.v - a.v) * k });
    }
    bot.equity.push({ t: now, v: 324.40 });
    bot.startUsd = 200;
    bot.startTs = T(0);
    bot.cashUsd = 324.40;
    bot.dayStartEquity = 200;
    bot.positions = [];
    bot.trades = [
      { id: 'd1', t: T(17), kind: 'sell', symbol: 'PEBBLE', icon: icoP, usd: 90, pnlUsd: 62, pnlPct: 62 / 28, mult: 3.21, agent: 'Brain', note: 'took profit', mc: 412000, frac: 1 },
      { id: 'd2', t: T(14), kind: 'buy', symbol: 'PEBBLE', icon: icoP, usd: 28, agent: 'Executor', note: 'entry', mc: 280000 },
      { id: 'd3', t: T(12), kind: 'stop', symbol: 'RIPP', icon: icoR, usd: 20.9, pnlUsd: -3.10, pnlPct: -0.129, agent: 'Brain', note: 'stop −12%', mc: 190000 },
      { id: 'd4', t: T(10), kind: 'buy', symbol: 'RIPP', icon: icoR, usd: 24, agent: 'Executor', note: 'entry', mc: 210000 },
      { id: 'd5', t: T(8), kind: 'sell', symbol: 'NOVA', icon: icoN, usd: 68, pnlUsd: 48, pnlPct: 2.4, mult: 3.40, agent: 'Brain', note: 'took profit', mc: 640000, frac: 1 },
      { id: 'd6', t: T(3), kind: 'buy', symbol: 'NOVA', icon: icoN, usd: 20, agent: 'Executor', note: 'entry', mc: 375000 }
    ];
    bot.lastFlash = { t: now - 20000, usd: 62, kind: 'sell' };
    bot.agents = {
      scanner: { status: 'hot', detail: '1,284 pools', n: 1284 },
      analyst: { status: 'hot', detail: 'PEBBLE score 88', token: { symbol: 'PEBBLE', icon: icoP }, score: 88 },
      executor: { status: 'hot', detail: 'bought $28', token: { symbol: 'PEBBLE', icon: icoP } },
      brain: { status: 'hot', detail: 'sold 3.21x', token: { symbol: 'PEBBLE', icon: icoP } }
    };
    bot.tf = 'LIVE';
    bot.settings.mode = 'PAPER';
    bot.running = false;
    bot.halted = null;
    bot._skipSave = true;
  }
  function applyDemo() {
    if (bot._demoApplied) return;
    bot._demoApplied = true;
    loadDemoData();
  }
  async function renderBot() {
    document.body.classList.add('term-on');
    $('#backBtn').hidden = true;
    $('#title').innerHTML = '<span class="logo"></span>Meme Terminal';
    try { await ensureWallet(); } catch (e) { console.warn(e); }
    if (demoRequested()) applyDemo();
    if (!bot.equity.length) pushEquity(equityNow());
    if (bot.view === 'wallet') return renderWallet();
    if (bot.view === 'settings') return renderSettings();
    renderTerm();
  }
  function leaveBot() { document.body.classList.remove('term-on'); }

  load();
  ensureWallet().catch(() => {});
  solPrice().catch(() => {});
  if (bot.running) startTimers();
  try { if (typeof route === 'function' && route().name === 'bot') renderBot(); } catch {}

  window.renderBot = renderBot;
  window.__botLeave = leaveBot;
  window.__bot = {
    get state() { return bot; },
    start: startBot, stop: stopBot, kill: killSwitch,
    render: renderBot, save, ensureWallet, keypair, jupQuote, jupSwapTx, signSwap, simulateB64, sendB64,
    rpc, solPrice, loadLiveBalances, equityNow, scanAndMaybeEnter, checkExits, executeBuy, executeSell,
    strategy: S, WSOL, USDC,
    get rejectTally() { return bot.rejectTally || {}; },
    demo: function (on) {
      window.__BOT_DEMO = !!on;
      if (on) applyDemo();
      return renderBot();
    }
  };
})();
