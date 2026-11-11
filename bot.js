/* Meme Terminal v10 — 6-agent pipeline (Scout → Filter → Analyst → Executor → Risk → Logger). Solana burner wallet, Jupiter swaps. */
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
  const SCAN_MS = 30000;
  const LOGKEY = 'bot:log';
  const LOG_CAP = 600;
  const GT = 'https://api.geckoterminal.com/api/v2';
  const DSAPI = 'https://api.dexscreener.com';
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
    log: [],
    stats: freshStats(),
    holderHist: {},
    smartCache: {},
    logFilter: 'all',
    _skipSave: false
  };

  function idleAgents() {
    return {
      scout: { status: 'idle', detail: 'waiting', n: 0 },
      filter: { status: 'idle', detail: 'waiting', n: 0 },
      analyst: { status: 'idle', detail: 'waiting', token: null, score: null },
      executor: { status: 'idle', detail: 'ready' },
      risk: { status: 'idle', detail: 'watching' },
      logger: { status: 'idle', detail: '0 events' }
    };
  }
  function freshStats() {
    return { scouted: 0, scoutLast: 0, seenLast: 0, killed: 0, killLast: 0, filterPassLast: 0, killByCode: {}, scored: 0, passed: 0, passLast: 0, lastBest: null, entries: 0, riskBlocks: 0, exits: 0, cycles: 0 };
  }

  const persistable = () => ({
    settings: bot.settings, running: bot.running, halted: bot.halted,
    cashUsd: bot.cashUsd, startUsd: bot.startUsd, startTs: bot.startTs,
    positions: bot.positions, trades: bot.trades, equity: bot.equity.slice(-4000),
    dayKey: bot.dayKey, dayStartEquity: bot.dayStartEquity,
    consecLosses: bot.consecLosses, cooldownUntil: bot.cooldownUntil,
    tokenCooldownUntil: bot.tokenCooldownUntil || {},
    scanned: bot.scanned, lastFlash: bot.lastFlash, tf: bot.tf, stats: bot.stats
  });

  function save() { if (bot._skipSave) return; try { ls.set(STORE, persistable()); } catch (e) { console.warn('bot save', e); } saveLog(); }
  function saveLog() {
    if (bot._skipSave) return;
    try { ls.set(LOGKEY, bot.log.slice(0, LOG_CAP)); }
    catch (e) { try { bot.log.length = Math.min(bot.log.length, 200); ls.set(LOGKEY, bot.log); } catch {} }
  }
  function migrateSettings(s) {
    if (s && s.pipelineV !== S.DEFAULTS.pipelineV) {
      // v9 → v10: adopt the new pipeline defaults, keep only user plumbing.
      const keep = {};
      ['mode', 'rpcUrl', 'minSolReserve', 'slippageBps', 'paperStartUsd'].forEach(k => { if (s[k] != null) keep[k] = s[k]; });
      return Object.assign(S.cloneDefaults(), keep);
    }
    const out = Object.assign(S.cloneDefaults(), s || {});
    out.weights = Object.assign({}, S.DEFAULTS.weights, (s && s.weights) || {});
    out.smartWallets = Array.isArray(s && s.smartWallets) ? s.smartWallets.slice(0, 10) : [];
    return out;
  }
  function load() {
    const s = ls.get(STORE);
    if (!s) return;
    Object.assign(bot, s);
    bot.settings = migrateSettings(s.settings || {});
    bot.agents = idleAgents();
    bot.stats = Object.assign(freshStats(), s.stats || {});
    try { const lg = ls.get(LOGKEY); bot.log = Array.isArray(lg) ? lg : []; } catch { bot.log = []; }
    bot.rejectTally = bot.rejectTally || {};
    bot.tokenCooldownUntil = bot.tokenCooldownUntil || {};
    (bot.positions || []).forEach(p => { p._selling = false; });
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
        const ctl = new AbortController();
        const to = setTimeout(() => ctl.abort(), o.body ? 20000 : 10000);
        init.signal = ctl.signal;
        let r;
        try { r = await fetch(url, init); } finally { clearTimeout(to); }
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
    if (hit && Date.now() - hit.ts < 180000) return hit.d;
    const d = await getJSON(RUG + encodeURIComponent(mint) + '/report', 12000);
    bot.rugCache[mint] = { ts: Date.now(), d };
    if (d && +d.totalHolders > 0) {
      const h = bot.holderHist[mint] || (bot.holderHist[mint] = []);
      h.push({ t: Date.now(), n: +d.totalHolders });
      while (h.length && Date.now() - h[0].t > 2 * 36e5) h.shift();
      if (h.length > 40) h.splice(0, h.length - 40);
    }
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
    const R = bot.agents.risk;
    if (!bot.positions.length) { R.detail = bot.halted ? ('halted: ' + bot.halted) : 'no open risk'; R.status = bot.halted ? 'danger' : 'idle'; R.token = null; return; }
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
      if (!(pos.stopPx > 0)) {
        // Positions opened before v10 get a stop registered now (−slPct from entry).
        pos.stopPx = pos.entryPx * (1 - bot.settings.slPct);
        pos.trailArmPct = bot.settings.trailArmPct; pos.trailPct = bot.settings.trailPct;
      }
      const mid = midPx(pos);
      const d = S.decideExit(pos, mid, now, bot.settings, pos._pair, {
        jupPx: bot._jupPx && bot._jupPx[pos.mint],
        quoteLiqUsd: pos._quoteLiq,
        solPx: bot.solPx,
        rug: pos._rug,
        rugged: !!pos._rugged,
        pairGone: !!pos._pairGone && !pos._pair
      });
      pos.peakPx = Math.max(pos.peakPx || pos.entryPx, mid || pos.entryPx);
      const peakUp = pos.peakPx / pos.entryPx - 1;
      pos._trailing = peakUp >= (pos.trailArmPct != null ? pos.trailArmPct : bot.settings.trailArmPct);
      R.status = 'hot';
      R.token = pos;
      if (d.action === 'hold') {
        const n = bot.positions.length;
        const trailing = bot.positions.filter(p => p._trailing).length;
        R.detail = trailing ? (n + ' open · ' + trailing + ' trail') : (n + ' open · −' + Math.round(bot.settings.slPct * 100) + '%');
        continue;
      }
      R.detail = d.reason === 'stop' ? ('stop −' + Math.round(bot.settings.slPct * 100) + '% hit') : d.reason === 'trail' ? 'trailing stop hit' : d.reason;
      await executeSell(pos, d.action === 'sell_partial' ? d.pct : 1, d.reason);
    }
  }

  async function executeSell(pos, frac, reason) {
    // Never sell the same position twice concurrently (1s ticks, manual sell, kill switch can overlap).
    if (!pos || pos._selling || !bot.positions.includes(pos)) return null;
    pos._selling = true;
    try { return await executeSellInner(pos, frac, reason); }
    finally { pos._selling = false; }
  }
  async function executeSellInner(pos, frac, reason) {
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
        agent: reason === 'manual' || reason === 'kill' ? 'Executor' : 'Risk',
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
      bot.agents.risk.detail = bot.agents.executor.detail;
      bot.agents.risk.status = kind === 'stop' ? 'danger' : 'hot';
      bot.stats.exits++;
      logEvent({ stage: 'risk', kind: 'trade', side: kind, mint: pos.mint, symbol: pos.symbol, icon: pos.icon,
        reason: (reason === 'stop' ? 'hard stop −' + Math.round(bot.settings.slPct * 100) + '%' : reason === 'trail' ? 'trailing stop (' + Math.round((pos.trailPct || bot.settings.trailPct) * 100) + '% off peak)' : reason),
        usd: fillUsd, pnlUsd: res.pnl, pnlPct: fillPx / pos.entryPx - 1, frac });
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

  /* ======================= v10 agent pipeline ======================= */
  let _logSaveT = 0;
  function logEvent(ev) {
    ev.t = ev.t || Date.now();
    S.logAppend(bot.log, ev, LOG_CAP);
    const L = bot.agents.logger;
    if (L) {
      L.status = 'hot';
      L.n = (L.n || 0) + 1;
      L.detail = fmtCount(bot.log.length) + ' events';
    }
    if (Date.now() - _logSaveT > 5000) { _logSaveT = Date.now(); saveLog(); }
  }

  function scoutCandidateRecords(gtPools, dsLists, dsPairs, now) {
    const s = bot.settings;
    const gtByMint = {};
    (gtPools || []).forEach(pl => {
      const a = pl && pl.attributes; if (!a) return;
      const rel = pl.relationships && pl.relationships.base_token && pl.relationships.base_token.data;
      const id = rel && rel.id; if (!id || id.indexOf('solana_') !== 0) return;
      const mint = id.slice(7);
      const age = a.pool_created_at ? (now - Date.parse(a.pool_created_at)) / 60000 : Infinity;
      const mc = +a.market_cap_usd || +a.fdv_usd || 0;
      if (age < 20 || age > s.scoutMaxAgeH * 60 * 1.25) return;
      if (mc && (mc < s.scoutMinMc * 0.6 || mc > s.scoutMaxMc * 1.5)) return;
      const cur = gtByMint[mint];
      if (!cur || (+a.reserve_in_usd || 0) > (+cur.reserve_in_usd || 0)) gtByMint[mint] = a;
    });
    const dsMeta = {};
    (dsLists || []).forEach(list => (list || []).forEach(x => {
      if (!x || (x.chainId !== 'solana') || !x.tokenAddress) return;
      dsMeta[x.tokenAddress] = dsMeta[x.tokenAddress] || { icon: x.icon ? (/^https?:/.test(x.icon) ? x.icon : 'https://cdn.dexscreener.com/cms/images/' + encodeURIComponent(x.icon) + '?width=64&height=64&fit=crop&quality=95&format=auto') : '' };
    }));
    return { gtByMint, dsMeta };
  }

  // GeckoTerminal allows ~30 calls/min per IP and answers 429 without CORS headers, so pace it.
  const gtGate = { last: 0, pauseUntil: 0, gapMs: 2100 };
  async function gtGet(url) {
    if (Date.now() < gtGate.pauseUntil) throw new Error('GT paused');
    const wait = gtGate.last + gtGate.gapMs - Date.now();
    if (wait > 0) await sleep(wait);
    gtGate.last = Date.now();
    try { return await getJSON(url, 12000); }
    catch (e) { gtGate.pauseUntil = Date.now() + 20000; throw e; }
  }
  const GT_SCOUT = [
    '/networks/solana/trending_pools?duration=1h&page=1', '/networks/solana/trending_pools?duration=6h&page=1',
    '/networks/solana/trending_pools?duration=24h&page=1', '/networks/solana/trending_pools?duration=5m&page=1',
    '/networks/solana/pools?sort=h24_tx_count_desc&page=1', '/networks/solana/trending_pools?duration=1h&page=2',
    '/networks/solana/trending_pools?duration=6h&page=2', '/networks/solana/trending_pools?duration=24h&page=2'
  ];
  async function scoutFetch() {
    const c = bot._scoutCache;
    if (c && Date.now() - c.ts < 90000) return c;
    const now = Date.now();
    const gtUrls = GT_SCOUT.map(x => GT + x + '&include=base_token');
    const dsUrls = [DSAPI + '/token-profiles/latest/v1', DSAPI + '/token-boosts/latest/v1', DSAPI + '/token-boosts/top/v1'];
    const gtRes = [];
    for (const u of gtUrls) { try { gtRes.push(await gtGet(u)); } catch { gtRes.push(null); if (Date.now() < gtGate.pauseUntil) break; } }
    const dsRes = await pool(dsUrls, 3, u => getJSON(u, 10000));
    const gtPools = [];
    let gtOk = 0;
    gtRes.forEach(d => { if (d && d.data) { gtOk++; d.data.forEach(x => gtPools.push(x)); } });
    const { gtByMint, dsMeta } = scoutCandidateRecords(gtPools, dsRes, null, now);
    (solanaFastItems() || []).forEach(it => { if (it.addr && !dsMeta[it.addr]) dsMeta[it.addr] = { icon: it.icon || '' }; });
    const mints = Array.from(new Set(Object.keys(gtByMint).concat(Object.keys(dsMeta)))).slice(0, 120);
    const chunks = [];
    for (let i = 0; i < mints.length; i += 30) chunks.push(mints.slice(i, i + 30));
    const dsBatches = await pool(chunks, 2, ch => getJSON(DSAPI + '/tokens/v1/solana/' + ch.join(','), 12000));
    const bestDs = {};
    dsBatches.forEach(arr => (Array.isArray(arr) ? arr : []).forEach(p => {
      if (!p || p.chainId !== 'solana' || !p.baseToken) return;
      const m = p.baseToken.address;
      if (!mints.includes(m)) return;
      const cur = bestDs[m];
      if (!cur || ((p.liquidity && +p.liquidity.usd) || 0) > ((cur.liquidity && +cur.liquidity.usd) || 0)) bestDs[m] = p;
    }));
    const records = [];
    mints.forEach(m => {
      const ds = bestDs[m], gt = gtByMint[m];
      const src = [gt ? 'gecko' : null, dsMeta[m] ? 'dexscreener' : null].filter(Boolean);
      if (ds) records.push(S.toScoutPair(ds, gt && gt.address === ds.pairAddress ? gt : null, { mint: m, icon: (dsMeta[m] && dsMeta[m].icon) || '', src }));
      else if (gt) records.push(S.toScoutPair(null, gt, { mint: m, symbol: String(gt.name || '?').split(' / ')[0], src }));
    });
    bot._scoutCache = { ts: now, records, gtOk, gtCalls: gtUrls.length, dsResolved: Object.keys(bestDs).length, mints: mints.length };
    return bot._scoutCache;
  }

  /** 1) SCOUT — finds Solana pairs 30m–72h old with mcap $300k–$20M. */
  async function agentScout() {
    const A = bot.agents.scout;
    A.status = 'hot'; A.detail = 'scanning…';
    const now = Date.now();
    let fetched;
    try { fetched = await scoutFetch(); }
    catch (e) { A.status = 'danger'; A.detail = 'data error'; return { stage: 'scout', t: now, pairs: [], skipped: {}, seen: 0 }; }
    const out = S.scoutStage(fetched.records, now, bot.settings);
    bot._lastScout = out;
    bot.scanned += out.seen;
    bot.stats.scouted = (bot.stats.scouted || 0) + out.pairs.length;
    bot.stats.scoutLast = out.pairs.length;
    bot.stats.seenLast = out.seen;
    bot.stats.scoutSkipLast = out.skipped;
    A.n = out.pairs.length;
    A.detail = out.pairs.length + ' pair' + (out.pairs.length === 1 ? '' : 's') + ' in range';
    bot._seenMint = bot._seenMint || {};
    out.pairs.forEach(p => {
      if (bot._seenMint[p.mint] && now - bot._seenMint[p.mint] < 30 * 60e3) return;
      bot._seenMint[p.mint] = now;
      logEvent({ stage: 'scout', kind: 'found', mint: p.mint, symbol: p.symbol, icon: p.icon,
        reason: 'age ' + fmtAge(p.ageMin) + ' · MC ' + fmtMc(p.mcap) + ' · liq ' + fmtMc(p.liqUsd) });
    });
    return out;
  }
  function fmtAge(min) { return min < 90 ? Math.round(min) + 'm' : (min / 60).toFixed(1).replace(/\.0$/, '') + 'h'; }

  /** 2) FILTER — receives Scout output only. Kills on authorities, LP, liq/mcap, dev, bundles, 1h pump. */
  async function agentFilter(scoutOut) {
    const A = bot.agents.filter;
    A.status = 'hot';
    const reports = {};
    await pool(scoutOut.pairs, 3, async p => {
      try { reports[p.mint] = await rugReport(p.mint); } catch { reports[p.mint] = null; }
    });
    const out = S.filterStage(scoutOut, reports, bot.settings, Date.now());
    bot._lastFilter = out;
    bot.stats.killUniq = bot.stats.killUniq || {};
    out.killed.forEach(k => {
      bot.stats.killed++;
      k.kills.forEach(x => {
        bot.stats.killByCode[x.code] = (bot.stats.killByCode[x.code] || 0) + 1;
        bot.rejectTally[x.code] = (bot.rejectTally[x.code] || 0) + 1;
        const u = bot.stats.killUniq[x.code] || (bot.stats.killUniq[x.code] = {});
        u[k.mint] = 1;
      });
      logEvent({ stage: 'filter', kind: 'kill', code: k.kills[0].code, mint: k.mint, symbol: k.symbol, icon: k.icon,
        reason: k.kills.map(x => x.reason).join('; '), codes: k.kills.map(x => x.code), facts: k.facts });
    });
    bot.stats.killLast = out.killed.length;
    bot.stats.filterPassLast = out.pairs.length;
    A.n = out.killed.length;
    A.detail = out.killed.length + ' killed · ' + out.pairs.length + ' pass';
    if (!scoutOut.pairs.length) { A.status = 'idle'; A.detail = 'nothing to check'; }
    return out;
  }

  async function gtPoolsMulti(addrs) {
    const out = {};
    const list = addrs.filter(Boolean).slice(0, 30);
    if (!list.length) return out;
    try {
      const d = await gtGet(GT + '/networks/solana/pools/multi/' + list.join(','));
      ((d && d.data) || []).forEach(x => { if (x && x.attributes) out[x.attributes.address] = x.attributes; });
    } catch {}
    return out;
  }
  function validWallet(w) { return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(w || '').trim()); }
  async function smartWalletHits(mint) {
    const wallets = (bot.settings.smartWallets || []).filter(validWallet).slice(0, 10);
    if (!wallets.length) return { hits: null, n: 0 };
    let hits = 0, failed = 0;
    for (const w of wallets) {
      const key = w + ':' + mint;
      const hit = bot.smartCache[key];
      if (hit && Date.now() - hit.t < 120000) { if (hit.has) hits++; continue; }
      try {
        const r = await rpc('getTokenAccountsByOwner', [w, { mint }, { encoding: 'jsonParsed' }], 8000);
        const has = ((r && r.value) || []).some(a => {
          const amt = a && a.account && a.account.data && a.account.data.parsed && a.account.data.parsed.info && a.account.data.parsed.info.tokenAmount;
          return amt && +amt.uiAmount > 0;
        });
        bot.smartCache[key] = { t: Date.now(), has };
        if (has) hits++;
      } catch { failed++; }
    }
    return { hits: failed === wallets.length ? null : hits, n: wallets.length };
  }

  /** 3) ANALYST — receives Filter survivors only. Scores 0–100; only ≥ passScore go on. */
  async function agentAnalyst(filterOut) {
    const A = bot.agents.analyst;
    const s = bot.settings;
    if (!filterOut.pairs.length) {
      A.status = 'idle'; A.token = null; A.score = null;
      A.detail = 'waiting for survivors';
      return { stage: 'analyst', t: Date.now(), pairs: [], scored: [] };
    }
    A.status = 'hot';
    const gt = await gtPoolsMulti(filterOut.pairs.map(p => p.pairAddress));
    const scored = [];
    for (const p of filterOut.pairs) {
      const g = gt[p.pairAddress];
      const gpc = (g && g.price_change_percentage) || {};
      const snaps = (bot.holderHist[p.mint] || []).filter(x => Date.now() - x.t <= 60 * 60e3);
      const sm = await smartWalletHits(p.mint);
      const res = S.scorePair(p, {
        gtTx: (g && g.transactions) || p.gtTx,
        priceChange: { m15: gpc.m15 != null ? +gpc.m15 : undefined, m30: gpc.m30 != null ? +gpc.m30 : undefined },
        holderSnaps: snaps, smartHits: sm.hits, smartWallets: sm.n
      }, s);
      bot.stats.scored++;
      const row = Object.assign({}, p, { score: res.score, pass: res.pass, components: res.components, enough: res.enough });
      scored.push(row);
      const prev = (bot._lastScore || (bot._lastScore = {}))[p.mint];
      if (!prev || Math.abs(prev.s - res.score) >= 3 || Date.now() - prev.t > 10 * 60e3 || prev.pass !== res.pass) {
        bot._lastScore[p.mint] = { s: res.score, t: Date.now(), pass: res.pass };
        const c = res.components;
        const part = k => c[k].score == null ? '–' : c[k].score;
        logEvent({ stage: 'analyst', kind: res.pass ? 'pass' : 'kill', code: res.pass ? 'score_pass' : (res.enough ? 'score_low' : 'score_nodata'),
          mint: p.mint, symbol: p.symbol, icon: p.icon, score: res.score,
          reason: (res.enough ? 'score ' + res.score + (res.pass ? ' ≥ ' : ' < ') + s.passScore : 'not enough data (' + Object.keys(c).filter(k => c[k].score != null).length + '/6 components) · score ' + res.score) + ' · mom ' + part('momentum') + ' · buyers ' + part('buyers') + ' · b/s ' + part('buySell') +
            ' · holders ' + part('holders') + (c.holders.basis === 'proxy' ? '*' : '') + ' · liq/mc ' + part('liqMc') + ' · smart ' + part('smart'),
          components: Object.keys(c).reduce((o, k) => { o[k] = c[k].score; return o; }, {}) });
      }
      if (!res.pass) {
        bot.stats.killByCode[res.enough ? 'score_low' : 'score_nodata'] = (bot.stats.killByCode[res.enough ? 'score_low' : 'score_nodata'] || 0) + 1;
      }
    }
    scored.sort((a, b) => b.score - a.score);
    const passed = scored.filter(x => x.pass);
    bot._lastScored = scored;
    bot.stats.passed += passed.length;
    bot.stats.passLast = passed.length;
    const best = scored[0];
    bot.stats.lastBest = best ? { symbol: best.symbol, score: best.score } : null;
    A.token = best ? { symbol: best.symbol, icon: best.icon } : null;
    A.score = best ? best.score : null;
    A.n = passed.length;
    A.detail = passed.length ? (passed.length + ' ≥' + s.passScore + ' · top ' + best.score) : (best ? 'best ' + best.score + ' < ' + s.passScore : 'no scores');
    return { stage: 'analyst', t: Date.now(), pairs: passed, scored };
  }

  /** 4) EXECUTOR — receives Analyst ≥70 list only. Sizes ≤8%, gets buy + honeypot sell quotes, hands ticket to Risk. */
  async function agentExecutor(analystOut) {
    const E = bot.agents.executor;
    if (!analystOut.pairs.length) { E.status = 'idle'; E.detail = bot.positions.length ? (bot.positions.length + ' open') : 'ready'; return { tickets: 0, fills: 0 }; }
    let tickets = 0, fills = 0;
    for (const p of analystOut.pairs) {
      const now = Date.now();
      if (bot.positions.some(x => x.mint === p.mint)) continue;
      const gate = S.canOpenMore(bot, bot.settings, now, { solPx: bot.solPx, reserveUsd: reserveUsd() });
      if (!gate.ok) { E.detail = gate.reason; logEvent({ stage: 'executor', kind: 'skip', code: 'gate', mint: p.mint, symbol: p.symbol, icon: p.icon, reason: gate.reason }); break; }
      const solPx = await solPrice();
      const eq = equityNow();
      const usd = S.executorSize(eq, bot.cashUsd, bot.settings, reserveUsd(), solPx);
      if (!(usd > 0)) { E.detail = 'size below floor'; logEvent({ stage: 'executor', kind: 'skip', code: 'size', mint: p.mint, symbol: p.symbol, reason: 'size below 0.02 SOL floor' }); break; }
      E.status = 'hot'; E.token = p; E.detail = 'quoting ' + p.symbol;
      // Scout data can be ~90s old: re-read the live pair so the signal price is current.
      let livePx = p.priceUsd, livePair = p.pair;
      try {
        const fresh = await dsBestPair(p.mint, p.pairAddress, true);
        if (fresh && +fresh.priceUsd > 0) { livePx = +fresh.priceUsd; livePair = fresh; }
      } catch {}
      let quoteBuy = null, quoteSell = null;
      try {
        const lamports = Math.floor((usd / solPx) * 1e9);
        quoteBuy = await jupQuote(WSOL, p.mint, lamports, bot.settings.slippageBps);
        if (quoteBuy && quoteBuy.ok) quoteSell = await jupQuote(p.mint, WSOL, Math.max(1, quoteBuy.outAmount), bot.settings.slippageBps);
      } catch (e) { /* risk will reject on missing quotes */ }
      const ticket = { mint: p.mint, symbol: p.symbol, icon: p.icon, usd, score: p.score, expectedPx: livePx, priceUsd: livePx, quoteBuy, quoteSell, scout: Object.assign({}, p, { pair: livePair || p.pair, liqUsd: (livePair && livePair.liquidity && +livePair.liquidity.usd) || p.liqUsd }) };
      tickets++;
      const ok = await agentRisk(ticket);
      if (ok) fills++;
    }
    if (fills) E.detail = 'bought ' + fills + ' · ' + bot.positions.length + ' open';
    return { tickets, fills };
  }

  /** 5) RISK — approves a ticket and registers stop −6% + trail (+12% arm) BEFORE the fill; also owns exits (checkExits). */
  async function agentRisk(ticket) {
    const R = bot.agents.risk;
    const st = { positions: bot.positions, cashUsd: bot.cashUsd, equityUsd: equityNow(), dayStartEquity: bot.dayStartEquity, halted: bot.halted, cooldownUntil: bot.cooldownUntil, tokenCooldownUntil: bot.tokenCooldownUntil };
    const v = S.riskApprove(ticket, st, bot.settings, Date.now(), { solPx: bot.solPx, reserveUsd: reserveUsd() });
    if (!v.ok) {
      bot.stats.riskBlocks++;
      bot.stats.killByCode['risk_' + (v.reasons[0] || 'x').split(' ')[0]] = (bot.stats.killByCode['risk_' + (v.reasons[0] || 'x').split(' ')[0]] || 0) + 1;
      logEvent({ stage: 'risk', kind: 'kill', code: 'risk', mint: ticket.mint, symbol: ticket.symbol, icon: ticket.icon, reason: v.reasons.join('; ') });
      R.detail = 'blocked ' + ticket.symbol;
      return false;
    }
    ticket.risk = v.plan;
    logEvent({ stage: 'risk', kind: 'plan', mint: ticket.mint, symbol: ticket.symbol, icon: ticket.icon,
      reason: 'stop −' + Math.round(v.plan.stopPct * 100) + '% registered · trail ' + Math.round(v.plan.trailPct * 100) + '% after +' + Math.round(v.plan.trailArmPct * 100) + '%' });
    const pos = await executeBuy(ticket);
    return !!pos;
  }

  /** Executor fill — refuses any ticket without a Risk-registered stop. */
  async function executeBuy(ticket) {
    if (!ticket || !ticket.risk || !(ticket.risk.stopPct > 0)) { console.warn('executeBuy: no risk plan'); return null; }
    const item = ticket.scout || {};
    const p = item.pair || {};
    const mint = ticket.mint;
    const px = +ticket.expectedPx || +p.priceUsd;
    const usd = ticket.usd;
    bot.agents.executor.status = 'hot';
    bot.agents.executor.detail = 'buying $' + usd.toFixed(0);
    bot.agents.executor.token = { symbol: ticket.symbol, icon: ticket.icon };
    try {
      const solPx = await solPrice();
      const solAmt = usd / solPx;
      let amount = 0, costUsd = usd, fillPx = px, decimals = 6;
      if (bot.settings.mode === 'LIVE') {
        const lamports = Math.floor(solAmt * 1e9);
        const rec = await liveSwap(WSOL, mint, lamports, { signalPx: px, outDecimals: decimals });
        await reconcileLiveCash();
        const tok = (bot.liveBal.tokens || []).find(t => t.mint === mint);
        amount = tok ? tok.amount : rec.outAmount / Math.pow(10, decimals);
        if (tok) decimals = tok.decimals;
        costUsd = rec.usd;
        fillPx = amount ? costUsd / amount : px;
      } else {
        const q = ticket.quoteBuy;
        if (!q || !q.ok) throw new Error('buy quote failed');
        if (q.impactPct > bot.settings.maxImpactPct) throw new Error('impact ' + q.impactPct.toFixed(2) + '%');
        const rugHit = bot.rugCache[mint] && bot.rugCache[mint].d;
        if (rugHit && rugHit.token && isFinite(+rugHit.token.decimals)) decimals = +rugHit.token.decimals;
        else {
          const approx = usd / px;
          const d6 = q.outAmount / 1e6, d9 = q.outAmount / 1e9;
          decimals = Math.abs(d6 - approx) < Math.abs(d9 - approx) ? 6 : 9;
        }
        amount = q.outAmount / Math.pow(10, decimals);
        fillPx = amount ? usd / amount : px;
        const chk = S.abortIfMoved(px, fillPx, bot.settings);
        if (chk.abort) throw new Error(chk.reason);
        costUsd = usd;
      }
      const id = 'p' + Date.now() + Math.random().toString(16).slice(2, 6);
      const rugHit = bot.rugCache[mint] && bot.rugCache[mint].d;
      // Same source as the 1s exit checks (DexScreener quote side), so the liquidity-drop exit compares like with like.
      const quoteLiq = S.quoteLiqUsd(p, bot.solPx || solPx, null) || S.quoteLiqUsd(p, bot.solPx || solPx, rugHit);
      S.applyBuy(bot, {
        id, mint, symbol: ticket.symbol, icon: ticket.icon, px: fillPx, mc: item.mcap || pairMc(p),
        liq: item.liqUsd || 0, quoteLiq, amount, costUsd, t: Date.now(), pairAddress: item.pairAddress
      });
      const pos = bot.positions[bot.positions.length - 1];
      pos.decimals = decimals;
      pos.entryQuoteLiq = quoteLiq;
      pos.stopPx = S.anchorStop(ticket.risk, fillPx);
      pos.trailArmPct = ticket.risk.trailArmPct;
      pos.trailPct = ticket.risk.trailPct;
      pos.score = ticket.score;
      pos._pair = p;
      bot.stats.entries++;
      addTrade({
        id: 't' + id, t: Date.now(), kind: 'buy', mint, symbol: ticket.symbol, icon: ticket.icon,
        usd: costUsd, qty: amount, px: fillPx, mc: item.mcap || pairMc(p), agent: 'Executor', note: 'score ' + ticket.score
      });
      logEvent({ stage: 'executor', kind: 'trade', side: 'buy', mint, symbol: ticket.symbol, icon: ticket.icon, usd: costUsd, score: ticket.score,
        reason: 'bought ' + fmtUsd(costUsd) + ' (' + (costUsd / Math.max(1e-9, equityNow()) * 100).toFixed(1) + '% equity) · score ' + ticket.score + ' · stop ' + fmtPx(pos.stopPx) });
      bot.agents.executor.detail = 'bought $' + costUsd.toFixed(0);
      bot.agents.risk.detail = bot.positions.length + ' open · −' + Math.round(bot.settings.slPct * 100) + '%';
      bot.agents.risk.status = 'hot';
      bot.agents.risk.token = pos;
      pushEquity(equityNow());
      save();
      return pos;
    } catch (e) {
      console.warn('buy failed', e);
      logEvent({ stage: 'executor', kind: 'kill', code: 'fill_abort', mint, symbol: ticket.symbol, icon: ticket.icon, reason: 'fill aborted: ' + (e.message || e) });
      bot.agents.executor.detail = 'aborted';
      return null;
    }
  }
  function fmtPx(x) { if (!(x > 0)) return '—'; return x >= 1 ? '$' + x.toFixed(4) : '$' + x.toPrecision(3); }

  /** Pipeline: Scout → Filter → Analyst → Executor → Risk (each stage gets only the previous output). Logger records all. */
  async function runPipeline() {
    bot.equityUsd = equityNow();
    pushEquity(bot.equityUsd);
    bot.stats.cycles++;
    const scoutOut = await agentScout();
    const filterOut = await agentFilter(scoutOut);
    const analystOut = await agentAnalyst(filterOut);
    const execOut = await agentExecutor(analystOut);
    bot._lastCycle = { t: Date.now(), scout: scoutOut.pairs.length, seen: scoutOut.seen, killed: filterOut.killed.length, survivors: filterOut.pairs.length, scored: analystOut.scored.length, passed: analystOut.pairs.length, tickets: execOut.tickets, fills: execOut.fills };
    saveLog();
    return bot._lastCycle;
  }
  const scanAndMaybeEnter = runPipeline;

  async function tickLoop() {
    if (!bot.running || bot._tickBusy) return;
    bot._tickBusy = true;
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
    finally { bot._tickBusy = false; }
  }
  async function scanLoop() {
    if (!bot.running || bot._scanBusy) return;
    bot._scanBusy = true;
    try {
      const eq = equityNow();
      bot.equityUsd = eq;
      pushEquity(eq);
      await scanAndMaybeEnter();
      if (route().name === 'bot') patchLiveUI();
    } catch (e) { console.warn('bot scan', e); }
    finally { bot._scanBusy = false; }
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
  function clockNow() {
    if (bot._demoClock) return bot._demoClock;
    return new Date().toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }
  function clockAt(t) {
    return new Date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }
  const openN = () => bot.positions.length;
  function seriesNow() { return bot._demoNow || Date.now(); }
  function moneyTxt(n) {
    if (n == null || !isFinite(n)) return '—';
    return (n < 0 ? '−' : '') + fmtUsd(Math.abs(n));
  }
  function fmtMc(n) {
    if (n == null || !isFinite(n) || n === 0) return '—';
    const sign = n < 0 ? '−' : '', a = Math.abs(n);
    if (a >= 1e6) {
      const v = a / 1e6;
      let s = v >= 10 ? v.toFixed(1) : v.toFixed(2);
      s = s.replace(/\.0+$/, '');
      return sign + '$' + s + 'M';
    }
    if (a >= 1e3) {
      const v = a / 1e3;
      const s = (v >= 100 || Math.abs(v - Math.round(v)) < 0.05) ? String(Math.round(v)) : v.toFixed(1);
      return sign + '$' + s + 'K';
    }
    return sign + '$' + Math.round(a);
  }
  function sublineLeft() {
    const p = bot.positions[0];
    const name = (p && p.symbol) ? p.symbol : 'Solana';
    const ico = p ? tokAv(p.icon, p.symbol, 'tav xs') : tokAv(null, 'SOL', 'tav xs');
    return ico + ' <span>' + esc(name) + ' · ' + openN() + ' open</span>';
  }
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

  function slotEyes(cx, cy, gap, w, h, fill) {
    const x1 = cx - gap / 2 - w, x2 = cx + gap / 2, y = cy - h / 2, r = w / 2;
    return '<rect x="'+x1+'" y="'+y+'" width="'+w+'" height="'+h+'" rx="'+r+'" fill="'+fill+'"/>' +
           '<rect x="'+x2+'" y="'+y+'" width="'+w+'" height="'+h+'" rx="'+r+'" fill="'+fill+'"/>';
  }
  const AG_COLORS = { scout: '#12a8a2', filter: '#f2b40c', analyst: '#f83c3c', executor: '#8f6af0', risk: '#f86e0c', logger: '#3d8bff' };
  function agentIcon(name, status) {
    const body = AG_COLORS[name] || '#888';
    const ok = '#1ee36a';
    const ring = name === 'scout' ? '#5ac8f8' : (status === 'danger' ? '#f85840' : (status === 'idle' ? 'rgba(255,255,255,.22)' : ok));
    const circ = (2 * Math.PI * 23).toFixed(2);
    const pct = name === 'scout' ? 0.50 : status === 'danger' ? 0.95 : status === 'idle' ? 0.38 : 0.86;
    const dash = (pct * 2 * Math.PI * 23).toFixed(2) + ' ' + circ;
    const face = {
      scout: '<g><circle cx="26.00" cy="21.15" r="5.55" fill="'+body+'"/><circle cx="30.20" cy="23.57" r="5.55" fill="'+body+'"/><circle cx="30.20" cy="28.42" r="5.55" fill="'+body+'"/><circle cx="26.00" cy="30.85" r="5.55" fill="'+body+'"/><circle cx="21.80" cy="28.43" r="5.55" fill="'+body+'"/><circle cx="21.80" cy="23.57" r="5.55" fill="'+body+'"/><circle cx="26" cy="26" r="7.1" fill="'+body+'"/>'+slotEyes(26, 26.1, 3.15, 2.2, 6.2, '#05332f')+'</g>',
      filter: '<g><path d="M26 12.6L36.6 16.4Q37.8 16.9 37.8 18.2V25.2C37.8 31.4 33.1 35.9 26.6 38.3Q26 38.5 25.4 38.3C18.9 35.9 14.2 31.4 14.2 25.2V18.2Q14.2 16.9 15.4 16.4Z" fill="'+body+'"/>'+slotEyes(26, 25.6, 3.2, 2.3, 6.6, '#2a1c00')+'</g>',
      analyst: '<g><path d="M26 12.4 L37.4 33.4 Q38.5 35.7 36.2 35.7 H15.8 Q13.5 35.7 14.6 33.4 Z" fill="'+body+'" stroke="'+body+'" stroke-linejoin="round" stroke-width="3.2"/>'+slotEyes(26, 27.4, 3.2, 2.35, 6.6, '#1a0505')+'</g>',
      executor: '<g><path d="M14.6 25.2C13.2 18.8 17.2 15.2 21.2 16.2C22.1 12.4 26.8 12.2 28.8 15.6C32.2 13.6 37.4 16.2 36.8 21.6C39.6 23.6 39.2 29.6 35.4 31.1C34.4 35 28.2 36.6 24.2 34.1C20.2 36.6 14.6 34.6 14.1 30.2C11.8 28.6 12.2 26.2 14.6 25.2Z" fill="'+body+'"/>'+slotEyes(26.2, 24.8, 3.4, 2.2, 6.2, '#1a1030')+'</g>',
      risk: '<g><path d="M27.6 13.4c.4-1.6 1.6-2.6 2.7-2.8" fill="none" stroke="#3c4a22" stroke-width="1.7" stroke-linecap="round"/><rect x="14.4" y="15.2" width="23.2" height="22.2" rx="8.4" fill="'+body+'"/>'+slotEyes(26, 26.2, 3.0, 3.05, 8.6, '#1a0c00')+'</g>',
      logger: '<g><path d="M18 14.2H34Q38.6 14.2 38.6 18.8V28.4Q38.6 33 34 33H25L19.4 37.6Q18.4 38.4 18.6 37.1L19.2 33H18Q13.4 33 13.4 28.4V18.8Q13.4 14.2 18 14.2Z" fill="'+body+'"/>'+slotEyes(26, 23.6, 3.2, 2.3, 6.4, '#06142e')+'</g>'
    }[name];
    return '<svg class="term-ring" viewBox="0 0 52 52" width="52" height="52" aria-hidden="true"><circle cx="26" cy="26" r="23" fill="none" stroke="rgba(255,255,255,.06)" stroke-width="4.4"/><circle cx="26" cy="26" r="23" fill="none" stroke="'+ring+'" stroke-width="4.4" stroke-linecap="round" stroke-dasharray="'+dash+'" transform="rotate(-90 26 26)"/>'+face+'</svg>';
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
    const now = seriesNow();
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
      let bx = Math.max(8, Math.min(W - w - 8, x - w * 0.62));
      let by = Math.max(132, y - 92);
      if (bx + w > W - 70 && by < 120) bx = Math.max(8, W - w - 78);
      let guard = 0;
      const overlap = () => placed.some(p => Math.abs((p.bx + p.w / 2) - (bx + w / 2)) < (p.w + w) / 2 - 2 && Math.abs(p.by - by) < (p.h + h) / 2 - 2);
      while (overlap() && guard++ < 16) {
        by += (i % 2 ? 16 : -16);
        if (by < 132) { by = 132; bx = Math.min(W - w - 8, bx + 28); }
        if (by > y - 22) { by = Math.max(132, y - 84); bx = Math.max(8, bx - 22); }
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
    const padT = Math.max(132, Math.round(H * 0.44)), padB = 20;
    const padX = 4, padXR = 16;
    const xOf = t => { const a = pts[0].t, b = pts[pts.length - 1].t || a + 1; return (t - a) / (b - a || 1) * (W - padX - padXR) + padX; };
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
      if (tr.kind === 'buy') {
        g.beginPath(); g.arc(x, y, 4.2, 0, Math.PI * 2);
        g.fillStyle = '#3d8bff'; g.fill();
      } else if (tr.kind === 'stop') {
        g.beginPath(); g.arc(x, y, 5.2, 0, Math.PI * 2);
        g.strokeStyle = '#ff5a52'; g.lineWidth = 2.1; g.stroke();
        if (tr === latestStop) { g.beginPath(); g.arc(x, y, 8.5, 0, Math.PI * 2); g.strokeStyle = 'rgba(255,70,60,.35)'; g.lineWidth = 1.6; g.stroke(); }
      } else {
        g.beginPath(); g.arc(x, y, 5.2, 0, Math.PI * 2);
        g.strokeStyle = '#1ee36a'; g.lineWidth = 2.1; g.stroke();
      }
    });
    const last = pts[pts.length - 1];
    const ex = xOf(last.t), ey = yOf(last.v);
    const endTok = (bot.positions[0] && (bot.positions[0].icon || bot.positions[0].symbol))
      ? bot.positions[0]
      : (trades.length ? trades[0] : null);
    const endAv = document.getElementById('termEndAv');
    if (endAv && endTok && !empty) {
      endAv.innerHTML = tokAv(endTok.icon, endTok.symbol, 'tav');
      endAv.style.left = Math.max(12, Math.min(ex, W - 13)) + 'px';
      endAv.style.top = ey + 'px';
      endAv.hidden = false;
      if (dot) dot.hidden = true;
    } else {
      if (endAv) { endAv.hidden = true; endAv.innerHTML = ''; }
      g.beginPath(); g.arc(ex, ey, 8, 0, Math.PI * 2);
      g.fillStyle = 'rgba(30,227,106,.18)'; g.fill();
      g.beginPath(); g.arc(ex, ey, 3.4, 0, Math.PI * 2);
      g.fillStyle = '#1ee36a'; g.fill();
      if (dot) { dot.style.left = ex + 'px'; dot.style.top = ey + 'px'; dot.hidden = false; }
    }
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
        const connH = Math.max(8, b.y - b.by - 40);
        const connX = Math.max(14, Math.min(b.w - 14, b.x - b.bx));
        return '<div class="tbub '+typ+'" style="left:'+b.bx+'px;top:'+b.by+'px">'+
          tokAv(tr.icon, tr.symbol, 'tav sm')+'<div class="tbub-t"><div class="tbub-h"><b>'+esc(tr.symbol)+'</b>'+pill+'</div><span>'+line2+'</span></div>'+
          '<i class="tconn" style="left:'+connX+'px;height:'+connH+'px"></i></div>';
      }).join('');
    }
  }

  function pillLive() {
    if (bot._demoLive || bot.settings.mode === 'LIVE') return '<span class="term-mode live'+(bot.running || bot._demoLive ? '' : ' off')+'"><i></i>Live</span>';
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

  const AG_ORDER = [
    ['scout', 'Scout', 'dexscreener'],
    ['filter', 'Filter', 'rugcheck'],
    ['analyst', 'Analyst', 'on-chain score'],
    ['executor', 'Executor', 'jupiter'],
    ['risk', 'Risk', 'stop · trail'],
    ['logger', 'Logger', 'kill log']
  ];
  function agentsHTML() {
    const a = bot.agents;
    const featured = () => {
      if (a.risk && a.risk.status === 'danger') return 'risk';
      if (a.executor && a.executor.status === 'hot' && a.executor.token) return 'executor';
      if (a.risk && a.risk.status === 'hot') return 'risk';
      if (a.analyst && a.analyst.status === 'hot' && a.analyst.n) return 'analyst';
      return '';
    };
    const f = featured();
    const glow = (key, ag) => {
      if (ag.status === 'danger') return 'on-red';
      if (key === f && ag.status !== 'idle') return 'on-green';
      return '';
    };
    const tokLine = (tok, txt, cls) => (tok ? tokAv(tok.icon, tok.symbol, 'tav xs') : '') + '<span class="agline">' + (tok ? '<span class="agtok">' + esc(tok.symbol) + '</span> ' : '') + '<span class="' + (cls || 'ok') + '">' + esc(txt) + '</span></span>';
    const bottom = {
      scout: ag => '<span class="agline"><span class="ok">' + esc(ag.detail) + '</span></span>',
      filter: ag => {
        const k = ag.n || 0;
        return '<span class="agline">' + (ag.status === 'idle' ? '<span class="ok">' + esc(ag.detail) + '</span>' : '<span class="bad">' + k + ' killed</span> <span class="ok">· ' + esc(String(bot.stats.filterPassLast || 0)) + ' pass</span>') + '</span>';
      },
      analyst: ag => ag.token && ag.score != null ? tokLine(ag.token, String(ag.score) + (ag.score >= bot.settings.passScore ? ' ✓' : ''), ag.score >= bot.settings.passScore ? 'ok' : 'warn') : tokLine(null, ag.detail),
      executor: ag => tokLine(ag.status === 'hot' ? ag.token : null, ag.status === 'hot' && ag.token ? String(ag.detail).replace(/^bought /, '') : ag.detail),
      risk: ag => tokLine(null, ag.detail, ag.status === 'danger' ? 'bad' : 'ok'),
      logger: ag => tokLine(null, ag.detail)
    };
    return '<div class="term-agents six">' + AG_ORDER.map(([key, title, src]) => {
      const ag = a[key] || { status: 'idle', detail: '' };
      return '<button type="button" class="agcard ' + glow(key, ag) + '" data-ag="' + key + '">' + agentIcon(key, ag.status) +
        '<div class="agbody"><div class="agtitle">' + title + '</div><div class="agsrc">' + ghIcon() + '<span>' + esc(src) + '</span></div><div class="agbot">' + bottom[key](ag) + '</div></div></button>';
    }).join('') + '</div>';
  }

  const STAGE_LABEL = { scout: 'Scout', filter: 'Filter', analyst: 'Analyst', executor: 'Executor', risk: 'Risk', logger: 'Logger' };
  const KILL_LABEL = {
    liq_mcap: 'liq/mcap too low', lp_unlocked: 'LP not burned/locked', lp_unknown: 'LP status unknown', mint_auth: 'mint not revoked',
    freeze_auth: 'freeze not revoked', dev_holds: 'dev holds >3%', dev_rugs: 'dev past rugs', bundled: 'bundled >10%',
    pumped_1h: '+80% in 1h', liq_floor: 'liquidity floor', no_rugcheck: 'no RugCheck', rugged: 'rugged', rc_danger: 'RugCheck danger',
    score_low: 'score < 70', score_nodata: 'not enough data', risk: 'risk blocked', fill_abort: 'fill aborted'
  };
  function logRowHTML(e) {
    const st = e.stage || 'logger';
    const verb = e.kind === 'kill' ? (st === 'analyst' ? 'rejected' : st === 'risk' ? 'blocked' : st === 'executor' ? 'aborted' : 'killed')
      : e.kind === 'pass' ? 'passed' : e.kind === 'found' ? 'found' : e.kind === 'plan' ? 'armed stop'
      : e.kind === 'trade' ? (e.side === 'buy' ? 'bought' : e.side === 'stop' ? 'stopped' : 'sold') : e.kind === 'skip' ? 'skipped' : 'noted';
    const right = e.kind === 'trade' && e.side !== 'buy' && e.pnlUsd != null
      ? '<div class="' + (e.pnlUsd >= 0 ? 'up' : 'dn') + '">' + (e.pnlUsd >= 0 ? '+' : '') + moneyTxt(e.pnlUsd) + '</div>'
      : e.score != null ? '<div class="' + (e.score >= bot.settings.passScore ? 'up' : '') + '">' + e.score + '</div>'
      : e.kind === 'trade' ? '<div>' + fmtUsd(e.usd) + '</div>' : '';
    return '<div class="lgr lg-' + esc(st) + ' k-' + esc(e.kind) + '"><div class="act-av">' + tokAv(e.icon, e.symbol) + '<i class="lg-dot" style="background:' + (AG_COLORS[st] || '#888') + '"></i></div>' +
      '<div class="act-m"><div class="act-t"><span class="lg-st">' + esc(STAGE_LABEL[st] || st) + '</span> ' + esc(verb) + ' ' + esc(e.symbol || '') + '</div>' +
      '<div class="lg-why">' + esc(e.reason || '') + '</div></div>' +
      '<div class="act-r">' + right + '<div class="act-s">' + esc(clockAt(e.t)) + (e.n > 1 ? ' · ×' + e.n : '') + '</div></div></div>';
  }
  function killSummaryHTML() {
    const uniq = bot.stats.killUniq || {};
    const rows = Object.keys(uniq).map(k => [k, Object.keys(uniq[k]).length]).sort((a, b) => b[1] - a[1]).slice(0, 8);
    if (!rows.length) return '';
    return '<div class="lg-sum">' + rows.map(([k, n]) => '<span class="lg-chip">' + esc(KILL_LABEL[k] || k) + ' <b>' + n + '</b></span>').join('') + '</div>';
  }
  function renderLog() {
    const f = bot.logFilter || 'all';
    const list = bot.log.filter(e => f === 'all' || e.stage === f || (f === 'logger' && e.kind === 'trade'));
    const lc = bot._lastCycle;
    app.innerHTML = '<div class="term term-page">' + termHeader('Agent log') +
      '<div class="lg-chips" id="lgChips">' + [['all', 'All']].concat(AG_ORDER.map(x => [x[0], x[1]])).map(([k, t]) =>
        '<button type="button" data-lf="' + k + '" class="' + (f === k ? 'on' : '') + '">' + (k !== 'all' ? '<i style="background:' + AG_COLORS[k] + '"></i>' : '') + esc(k === 'logger' ? 'Trades' : t) + '</button>').join('') + '</div>' +
      (lc ? '<div class="lg-cycle">Last cycle ' + esc(clockAt(lc.t)) + ': scout ' + lc.scout + ' → filter pass ' + lc.survivors + ' → ≥' + bot.settings.passScore + ': ' + lc.passed + ' → fills ' + lc.fills + '</div>' : '') +
      ((f === 'all' || f === 'filter') ? killSummaryHTML() : '') +
      '<div class="term-act">' + (list.length ? list.slice(0, 150).map(logRowHTML).join('') : '<div class="term-empty"><b>No events yet</b><span>Start the paper bot. Every kill, score and trade lands here.</span></div>') + '</div>' +
      '<div class="term-foot"><button type="button" class="term-link" id="backTerm">Back to terminal</button><button type="button" class="term-link" id="lgClear">Clear log</button></div>' +
      '<div class="note term-note">Kept on this phone only (last ' + LOG_CAP + ' events). Repeated kills of the same coin for the same reason are merged (×n).</div></div>';
    bindWalletChrome();
    app.querySelectorAll('[data-lf]').forEach(b => b.onclick = () => { bot.logFilter = b.dataset.lf; renderLog(); });
    const c = $('#lgClear'); if (c) c.onclick = () => { if (!confirm('Clear the agent log?')) return; bot.log = []; bot.stats.killUniq = {}; saveLog(); renderLog(); };
  }

  function activityHTML() {
    const rows = bot.trades.slice(0, 20);
    if (!rows.length) return '<div class="term-empty">'+
      '<svg class="term-empty-ico" viewBox="0 0 64 64" aria-hidden="true"><rect x="4" y="8" width="56" height="48" rx="14" fill="rgba(255,255,255,.04)" stroke="rgba(255,255,255,.08)"/><path d="M10 40c8-2 12-16 22-16s12 18 22 10" fill="none" stroke="#1ee36a" stroke-width="2.2" stroke-linecap="round"/><circle cx="54" cy="30" r="3.1" fill="#1ee36a"/></svg>'+
      '<b>Waiting for the first fill</b>'+
      '<span>Scout → Filter → Analyst must all pass first. Every kill is in the Log.</span></div>';
    return rows.map(tr => {
      const badge = tr.kind === 'buy' ? 'b-buy' : tr.kind === 'stop' ? 'b-stop' : 'b-sell';
      const mark = tr.kind === 'buy'
        ? '<svg viewBox="0 0 12 12" width="8" height="8" aria-hidden="true"><path d="M3 9L9 3M5 3h4v4" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>'
        : tr.kind === 'stop' ? '×' : '✓';
      const title = tr.kind === 'buy' ? 'Bought '+esc(tr.symbol)
        : tr.kind === 'stop' ? 'Stopped '+esc(tr.symbol)
        : (tr.frac && tr.frac < 0.99 ? 'Sold '+Math.round(tr.frac * 100)+'% '+esc(tr.symbol) : 'Sold '+esc(tr.symbol));
      const bits = [tr.agent];
      if (tr.kind !== 'buy' && tr.note) bits.push(tr.note);
      bits.push(tr.clock || clockAt(tr.t));
      const sub = bits.filter(Boolean).map(esc).join(' · ');
      const amt = tr.kind === 'buy' ? fmtUsd(tr.usd) : ((tr.pnlUsd || 0) >= 0 ? '+' : '') + moneyTxt(tr.pnlUsd || 0);
      const amtCls = tr.kind === 'buy' ? '' : ((tr.pnlUsd || 0) >= 0 ? 'up' : 'dn');
      const right2 = tr.kind === 'buy' && tr.mc ? fmtMc(tr.mc)+' MC'
        : tr.kind === 'stop' && tr.pnlPct != null ? (tr.pnlPct * 100).toFixed(1).replace('-', '−')+'%'
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
      '<button type="button" class="term-share" id="termShare"><svg viewBox="0 0 24 24" width="16" height="16"><path d="M12 14V4M8.5 7.5L12 4l3.5 3.5M7 10v8.5A1.5 1.5 0 008.5 20h7a1.5 1.5 0 001.5-1.5V10" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"/></svg> Share</button></header>';
  }
  function chev() { return '<svg viewBox="0 0 24 24" width="22" height="22"><path d="M15 18l-6-6 6-6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>'; }
  function botFace() {
    return '<span class="term-face" aria-hidden="true"><svg viewBox="0 0 32 32" width="28" height="28"><circle cx="16" cy="16" r="16" fill="#f2f2f4"/><rect x="10.15" y="10.2" width="3.7" height="11.6" rx="1.85" fill="#111"/><rect x="18.15" y="10.2" width="3.7" height="11.6" rx="1.85" fill="#111"/></svg></span>';
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
      '<div class="term-chart" id="termChart"><canvas></canvas><div class="term-dot" id="termDot"></div><div class="term-endav" id="termEndAv" hidden></div><div class="term-hint" id="termHint">Waiting for first trade…</div><div class="term-bubs"></div></div>'+
      '<div class="term-sub"><span class="term-sub-l" id="termSubLeft">'+sublineLeft()+'</span><span id="termClock">'+clockNow()+'</span></div>'+
      '<div class="term-balwrap">'+odometerHTML(p.eq, balCls)+flashHTML()+'</div>'+
      '<div class="term-pnl"><span class="'+(p.pnl >= 0 ? 'up' : 'dn')+'">'+(p.pnl >= 0 ? '▲' : '▼')+' '+fmtUsd(Math.abs(p.pnl))+' ('+Math.abs(p.pct).toFixed(2)+'%)</span><span class="term-mult">'+p.mult.toFixed(2)+'x</span></div>'+
      '</div>'+
      '<div class="term-tfs">'+['LIVE','1H','4H','1D','1W','ALL'].map(t => '<button type="button" data-tf="'+t+'" class="'+(bot.tf === t ? 'on' : '')+'">'+(t === 'LIVE' ? '• LIVE' : t)+'</button>').join('')+'</div>'+
      '<div class="term-h3">Agents <span>'+(bot.running || bot._demoLive ? '6 running' : 'idle')+'</span></div>'+agentsHTML()+
      '<div class="term-h3">Activity <span>'+bot.trades.length+' trade'+(bot.trades.length === 1 ? '' : 's')+'</span></div>'+
      '<div class="term-act">'+activityHTML()+'</div>'+(bot._demoApplied ? '' : positionsHTML())+
      '<div class="term-foot"><button type="button" class="term-cta '+(bot.running ? 'stop' : '')+'" id="termToggle">'+(bot.running ? 'Pause bot' : (bot.settings.mode === 'LIVE' ? 'Start LIVE bot' : 'Start paper bot'))+'</button>'+
      '<button type="button" class="term-link" id="termLog">Log</button>'+
      '<button type="button" class="term-link" id="termWallet">Wallet</button>'+
      '<button type="button" class="term-link" id="termSettings">Settings</button></div>'+
      '<div class="note term-note">6 agents: Scout finds Solana pairs 30m–72h old ($300K–$20M MC) → Filter kills unsafe ones → Analyst scores 0–100 (70+ pass) → Executor sizes ≤8% → Risk sets −6% stop before entry, trails after +12% → Logger records every kill. It can still lose money. PAPER uses live quotes with fake money.</div></div>';
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
    const lg = $('#termLog'); if (lg) lg.onclick = () => { bot.logFilter = 'all'; bot.view = 'log'; renderBot(); };
    bindAgents();
    app.querySelectorAll('[data-sell]').forEach(b => b.onclick = async () => {
      const pos = bot.positions.find(p => p.id === b.dataset.sell);
      if (!pos) return;
      b.disabled = true; b.textContent = 'Selling…';
      await refreshPositionPrices();
      await executeSell(pos, 1, 'manual');
      renderBot();
    });
  }

  function bindAgents() {
    app.querySelectorAll('.term-agents [data-ag]').forEach(b => b.onclick = () => { bot.logFilter = b.dataset.ag; bot.view = 'log'; renderBot(); });
  }
  function patchLiveUI() {
    if (route().name === 'bot' && bot.view === 'log') {
      const sig = bot.log.length + ':' + (bot.log[0] ? bot.log[0].t : 0);
      if (sig !== bot._logSig && window.scrollY < 60) { bot._logSig = sig; renderLog(); }
      return;
    }
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
    const sl = $('#termSubLeft'); if (sl) sl.innerHTML = sublineLeft();
    const wrap = document.querySelector('.term-balwrap');
    if (wrap) {
      const f = wrap.querySelector('.term-flash');
      const html = flashHTML();
      if (html && !f) wrap.insertAdjacentHTML('beforeend', html);
      else if (!html && f) f.remove();
    }
    const pnl = document.querySelector('.term-pnl');
    if (pnl) pnl.innerHTML = '<span class="'+(p.pnl >= 0 ? 'up' : 'dn')+'">'+(p.pnl >= 0 ? '▲' : '▼')+' '+fmtUsd(Math.abs(p.pnl))+' ('+Math.abs(p.pct).toFixed(2)+'%)</span><span class="term-mult">'+p.mult.toFixed(2)+'x</span>';
    const ag = document.querySelector('.term-agents');
    if (ag) { ag.outerHTML = agentsHTML(); bindAgents(); }
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
    const w = s.weights || S.DEFAULTS.weights;
    app.innerHTML = '<div class="term term-page">'+termHeader('Settings')+
      bannerHTML()+
      '<div class="card"><h3>Mode</h3><div class="seg" id="modeSeg">'+
      '<button type="button" data-mode="PAPER" class="'+(s.mode !== 'LIVE' ? 'on' : '')+'">PAPER</button>'+
      '<button type="button" data-mode="LIVE" class="'+(s.mode === 'LIVE' ? 'on' : '')+'">LIVE</button></div>'+
      '<div class="note">'+(s.mode === 'LIVE' ? 'LIVE uses real SOL in the burner wallet. Trades are signed on this phone and sent to Solana.' : 'PAPER simulates fills from live Jupiter quotes. No real money moves.')+'</div></div>'+
      '<div class="card"><h3>1 · Scout</h3>'+
      setNum('scoutMinAgeMin', 'Min pair age', s.scoutMinAgeMin, 'minutes (default 30)')+
      setNum('scoutMaxAgeH', 'Max pair age', s.scoutMaxAgeH, 'hours (default 72)')+
      setNum('scoutMinMc', 'Min market cap', Math.round(s.scoutMinMc / 1000), '$K (default 300)')+
      setNum('scoutMaxMc', 'Max market cap', +(s.scoutMaxMc / 1e6).toFixed(2), '$M (default 20)')+'</div>'+
      '<div class="card"><h3>2 · Filter (kills)</h3>'+
      setNum('minLiqMcPct', 'Min liquidity / market cap', s.minLiqMcPct, '% (default 25 — very strict for memes, most coins sit at 5–20%)')+
      setNum('minLpLockedPct', 'Min LP burned/locked', s.minLpLockedPct, '% of LP (default 90)')+
      setNum('maxDevPct', 'Max dev holdings', s.maxDevPct, '% of supply (default 3)')+
      setNum('maxDeadLaunches', 'Kill if dev has dead launches ≥', s.maxDeadLaunches, 'earlier tokens now under $5K MC (default 2, 0 = off) · RugCheck rug flags always kill')+
      setNum('maxBundlePct', 'Max bundled / insider cluster', s.maxBundlePct, '% of supply (default 10)')+
      setNum('max1hChg', 'Max 1h pump', s.max1hChg, '% (default 80)')+'</div>'+
      '<div class="card"><h3>3 · Analyst</h3>'+
      setNum('passScore', 'Pass score', s.passScore, '0–100 (default 70)')+
      '<div class="set-hint">Weights: momentum '+w.momentum+' · unique buyers '+w.buyers+' · buy/sell '+w.buySell+' · holder growth '+w.holders+' · liq/mcap '+w.liqMc+' · smart wallets '+w.smart+'. Components without data are left out and the rest re-weighted.</div>'+
      '<label class="set-lab">Smart wallets (one per line, max 10)</label><textarea class="set-in" id="smartWallets" rows="3" placeholder="Solana wallet addresses you trust">'+esc((s.smartWallets || []).join('\n'))+'</textarea>'+
      '<div class="set-hint">Checked on-chain via RPC. Empty = this component is not scored.</div></div>'+
      '<div class="card"><h3>4 · Executor</h3>'+
      setNum('posPct', 'Position size', +(s.posPct * 100).toFixed(1), '% of equity, max 8')+
      setNum('maxOpen', 'Max open positions', s.maxOpen, 'default 8, max 10')+
      setNum('slippageBps', 'Slippage cap', s.slippageBps, 'basis points')+'</div>'+
      '<div class="card"><h3>5 · Risk</h3>'+
      setNum('slPct', 'Hard stop', +(s.slPct * 100).toFixed(1), '% below entry, set before the buy (default 6)')+
      setNum('trailArmPct', 'Trailing starts after', +(s.trailArmPct * 100).toFixed(1), '% gain (default 12)')+
      setNum('trailPct', 'Trailing distance', +(s.trailPct * 100).toFixed(1), '% off the peak (default 6)')+
      setNum('maxHoldMin', 'Max hold', s.maxHoldMin, 'minutes')+
      setNum('dailyLossPct', 'Daily loss cap', +(s.dailyLossPct * 100).toFixed(1), '% of the day-start balance → stop new entries')+
      setNum('minSolReserve', 'Fee reserve', s.minSolReserve, 'SOL kept for fees')+
      '<label class="set-lab">Custom RPC URL</label><input class="set-in" id="rpcUrl" value="'+esc(s.rpcUrl || '')+'" placeholder="https://solana-rpc.publicnode.com">'+
      '<div class="note">Public RPC is fine for paper. For LIVE sends, a free Helius (or similar) RPC is more reliable.</div></div>'+
      '<div class="card"><button class="term-cta" id="saveSet">Save settings</button>'+
      '<button class="term-cta" id="resetSet" style="margin-top:8px;background:#2c2c2e;color:#fff">Reset to defaults</button>'+
      '<button class="term-cta danger" id="kill">KILL SWITCH — sell all & stop</button></div>'+
      '<div class="term-foot"><button class="term-link" id="backTerm">Back to terminal</button></div></div>';
    bindWalletChrome();
    bindBanner();
    app.querySelectorAll('#modeSeg [data-mode]').forEach(b => b.onclick = () => {
      if (b.dataset.mode === 'LIVE') {
        if (!confirm('LIVE mode spends real SOL from the burner wallet on Solana memecoins. You can lose everything you deposit. The bot only runs while the app is open. Continue?')) return;
        if (!confirm('Tap OK again to confirm LIVE trading with real money.')) return;
      }
      bot.settings.mode = b.dataset.mode;
      save(); renderSettings();
    });
    $('#saveSet').onclick = () => {
      const val = id => parseFloat(document.getElementById(id).value);
      const set = (id, lo, hi, mul) => { const v = val(id); if (isFinite(v)) bot.settings[id] = Math.max(lo, Math.min(hi, v * (mul || 1))); };
      set('scoutMinAgeMin', 0, 1440); set('scoutMaxAgeH', 1, 720);
      set('scoutMinMc', 0, 1e9, 1000); set('scoutMaxMc', 0.05e6, 1e10, 1e6);
      set('minLiqMcPct', 0, 100); set('minLpLockedPct', 0, 100); set('maxDevPct', 0, 100);
      set('maxDeadLaunches', 0, 100); set('maxBundlePct', 0, 100); set('max1hChg', 5, 10000);
      set('passScore', 0, 100);
      set('posPct', 0.01, 0.08, 0.01); set('maxOpen', 1, 10); bot.settings.maxOpen = Math.round(bot.settings.maxOpen);
      set('slippageBps', 10, 2000);
      set('slPct', 0.01, 0.5, 0.01); set('trailArmPct', 0.01, 5, 0.01); set('trailPct', 0.01, 0.5, 0.01);
      set('maxHoldMin', 5, 1440); set('dailyLossPct', 0.01, 1, 0.01); set('minSolReserve', 0, 1);
      bot.settings.smartWallets = String($('#smartWallets').value || '').split(/[\s,]+/).map(x => x.trim()).filter(validWallet).slice(0, 10);
      bot.settings.rpcUrl = ($('#rpcUrl').value || '').trim() || S.DEFAULTS.rpcUrl;
      bot.settings.pipelineV = S.DEFAULTS.pipelineV;
      bot._scoutCache = null;
      save(); toast('Settings saved');
    };
    $('#resetSet').onclick = () => {
      if (!confirm('Reset all strategy settings to the defaults?')) return;
      const keep = { mode: bot.settings.mode, rpcUrl: bot.settings.rpcUrl, minSolReserve: bot.settings.minSolReserve };
      bot.settings = Object.assign(S.cloneDefaults(), keep);
      save(); renderSettings(); toast('Defaults restored');
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
  function icoPussy() {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><circle cx="20" cy="20" r="20" fill="#0b2f16"/><path fill="#d4ff3d" d="M20 6.5l11.2 21.2-11.2-4.6-11.2 4.6z"/><path fill="#8fbf22" d="M20 23.1l11.2 4.6L20 33.6z"/></svg>';
    return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
  }
  function icoAlice() {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><defs><clipPath id="c"><circle cx="20" cy="20" r="20"/></clipPath></defs><g clip-path="url(#c)"><rect width="40" height="40" fill="#1a1428"/><ellipse cx="20" cy="24" rx="16" ry="16" fill="#1c1018"/><ellipse cx="20" cy="36" rx="8" ry="7" fill="#2a1628"/><ellipse cx="20" cy="33.5" rx="5.5" ry="5" fill="#d4a07a"/><ellipse cx="20" cy="20" rx="8.6" ry="10" fill="#e6b48c"/><path d="M6 22 Q10 4 20 5.5 Q30 4 34 22 Q31 8 20 8.5 Q9 8 6 22Z" fill="#14080e"/><path d="M12 8 Q20 2 28 8" fill="#1c0c12"/><ellipse cx="16.6" cy="21" rx="1.25" ry="1.55" fill="#1a1010"/><ellipse cx="23.4" cy="21" rx="1.25" ry="1.55" fill="#1a1010"/><path d="M18 25.4 Q20 26.8 22 25.4" fill="none" stroke="#c47868" stroke-width=".9" stroke-linecap="round"/><path d="M6 40 Q20 29 34 40" fill="#2a1630"/></g></svg>';
    return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
  }
  function loadDemoData() {
    const now = Date.now();
    bot._demoNow = now;
    bot._demoClock = '10:46 PM';
    const ago = (min, sec) => now - (min * 60 + (sec || 0)) * 1000;
    const icoP = icoPussy();
    const icoA = icoAlice();
    const icoB = demoIcon('#6b7280', 'P');
    // Equity: $231.70 start → $816.87. Visual: wiggle, rise, long plateau with dots, rocket.
    const key = [
      [19.8, 231.70], [19.2, 233.4], [18.7, 229.8], [18.2, 231.70],
      [17.8, 231.70],
      [17.0, 280], [16.3, 340], [15.6, 380], [15.2, 394.36],
      [14.8, 394.36], [13.6, 396.2], [12.4, 393.4], [11.2, 394.8],
      [10.2, 394.36], [9.2, 395.0], [8.2, 393.8], [7.2, 394.36],
      [6.6, 391.99], [6.2, 391.99],
      [5.6, 430], [5.1, 468], [4.6, 510], [4.2, 490],
      [3.7, 560], [3.2, 620], [2.8, 598], [2.3, 680],
      [1.8, 730], [1.3, 710], [0.9, 778], [0.5, 804], [0.2, 792], [0, 816.87]
    ];
    // minutes-ago → timestamp; later keys override earlier at same t via interpolation
    const pts = key.map(([m, v]) => ({ t: now - m * 60e3, v }));
    pts.sort((a, b) => a.t - b.t);
    bot.equity = [];
    for (let ts = pts[0].t; ts <= now; ts += 8000) {
      let a = pts[0], b = pts[pts.length - 1];
      for (let i = 0; i < pts.length - 1; i++) if (ts >= pts[i].t && ts <= pts[i + 1].t) { a = pts[i]; b = pts[i + 1]; break; }
      if (ts >= pts[pts.length - 1].t) { bot.equity.push({ t: ts, v: pts[pts.length - 1].v }); continue; }
      const k = (ts - a.t) / (b.t - a.t || 1);
      bot.equity.push({ t: ts, v: a.v + (b.v - a.v) * k });
    }
    bot.equity.push({ t: now, v: 816.87 });
    bot.startUsd = 816.87 / 3.5255;
    bot.startTs = pts[0].t;
    bot.cashUsd = 215.60;
    bot.dayStartEquity = bot.startUsd;
    bot.positions = [{
      id: 'd-open', mint: 'demo-pussy', symbol: 'PUSSY', icon: icoP,
      amount: 1, entryPx: 176.40, peakPx: 601.27, costUsd: 176.40,
      entryMc: 375000, _mc: 375000, openedAt: ago(10)
    }];
    bot.trades = [
      { id: 'd1', t: ago(6.2), kind: 'buy', symbol: 'PUSSY', icon: icoP, usd: 176.40, agent: 'Executor', note: 'entry', mc: 375000, clock: '10:36 PM' },
      { id: 'd2', t: ago(7.4), kind: 'stop', symbol: 'Alice', icon: icoA, usd: 37.07, pnlUsd: -2.37, pnlPct: -0.06, agent: 'Risk', note: 'stop −6%', mc: 261000, clock: '10:35 PM' },
      { id: 'd3', t: ago(9.0), kind: 'buy', symbol: 'Alice', icon: icoA, usd: 39.44, agent: 'Executor', note: 'entry', mc: 261000, clock: '10:33 PM' },
      { id: 'd4', t: ago(15.2), kind: 'sell', symbol: 'Alice', icon: icoA, usd: 278.85, pnlUsd: 162.66, pnlPct: 1.40, mult: 2.40, agent: 'Risk', note: 'trailing stop', mc: 310000, frac: 1, clock: '10:32 PM' },
      { id: 'd5', t: ago(17.8), kind: 'buy', symbol: 'Alice', icon: icoA, usd: 116.19, agent: 'Executor', note: 'entry', mc: 190000, clock: '10:29 PM' },
      { id: 'd6', t: ago(19.4), kind: 'sell', symbol: 'PEBBLE', icon: icoB, usd: 48.1, pnlUsd: 22.10, pnlPct: 0.85, mult: 1.85, agent: 'Risk', note: 'trailing stop', mc: 140000, frac: 1, clock: '10:27 PM' }
    ];
    bot.lastFlash = null;
    bot.agents = {
      scout: { status: 'hot', detail: '14 pairs in range', n: 14 },
      filter: { status: 'hot', detail: '11 killed · 3 pass', n: 11 },
      analyst: { status: 'hot', detail: '1 ≥70 · top 92', token: { symbol: 'PUSSY', icon: icoP }, score: 92, n: 1 },
      executor: { status: 'hot', detail: 'bought $176', token: { symbol: 'PUSSY', icon: icoP } },
      risk: { status: 'hot', detail: '1 open · 1 trail', token: { symbol: 'PUSSY', icon: icoP } },
      logger: { status: 'hot', detail: '1,284 events', n: 1284 }
    };
    bot.stats = Object.assign(freshStats(), { filterPassLast: 3, killLast: 11, scoutLast: 14 });
    bot.log = [
      { t: ago(0.3), stage: 'risk', kind: 'plan', symbol: 'PUSSY', icon: icoP, reason: 'stop −6% registered · trail 6% after +12%' },
      { t: ago(0.4), stage: 'analyst', kind: 'pass', symbol: 'PUSSY', icon: icoP, score: 92, reason: 'score 92 ≥ 70 · mom 88 · buyers 95 · b/s 90 · holders 84 · liq/mc 100 · smart –' },
      { t: ago(0.6), stage: 'filter', kind: 'kill', code: 'liq_mcap', symbol: 'Max', icon: icoB, reason: 'liq/mcap 5.1% < 25%', n: 6 },
      { t: ago(0.8), stage: 'filter', kind: 'kill', code: 'dev_holds', symbol: 'Alice', icon: icoA, reason: 'dev holds 4.2% (> 3%)', n: 2 },
      { t: ago(1.2), stage: 'scout', kind: 'found', symbol: 'PUSSY', icon: icoP, reason: 'age 3.2h · MC $375K · liq $118K' }
    ];    bot.tf = 'LIVE';
    bot.settings.mode = 'PAPER';
    bot.running = false;
    bot._demoLive = true;
    bot.halted = null;
    bot._skipSave = true;
  }
  function applyDemo() {
    if (bot._demoApplied) return;
    bot._demoApplied = true;
    try { ls.set('bot:hideBanner', 1); } catch {}
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
    if (bot.view === 'log') return renderLog();
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
