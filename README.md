# Memecoin Signals

Static installable web app (PWA) that scans memecoins. It has three views, and none of them predicts price:

- **Fast**: fresh pairs under 72 hours old on Solana, Base, BSC and Ethereum, taken from DexScreener (latest token profiles and boosts) and GeckoTerminal trending pools. Each pair gets a momentum score from price change, buy pressure, volume against liquidity, trade activity and buzz, plus a risk level (HIGH, VERY HIGH or EXTREME) based on age, liquidity, FDV against liquidity, sell pressure and missing socials.
- **Slow**: established memecoins from the CoinGecko `meme-token` category, with Binance as a fallback. Swing setups lasting 1 to 3 days are weighted toward the 4h trend and show entry, stop, target and hold time.
- **Bot (Meme Terminal)**: a paper or live bot for Solana memecoins, built as six agents with hard handoffs (each stage only sees the previous stage's output). Default is PAPER. LIVE uses a burner wallet generated in the browser (not your Phantom seed) and Jupiter swaps. The bot only runs while the app is open.
  1. **Scout**: GeckoTerminal trending/active Solana pools + DexScreener profiles/boosts, resolved on DexScreener. Keeps pairs 30m–72h old with market cap $300K–$20M.
  2. **Filter**: RugCheck report. Kills mint or freeze authority not revoked, LP < 90% burned/locked (or unknown), liquidity/market cap < 25% (configurable), dev holds > 3%, dev rug history (RugCheck flag, or ≥ 2 earlier launches now under $5K MC), bundled/insider cluster > 10%, already > +80% in 1h, RugCheck danger flags.
  3. **Analyst**: 0–100 score. Momentum 25, unique buyers 20 (GeckoTerminal), buy/sell ratio 15, holder growth 15 (RugCheck holder-count snapshots; labelled proxy until 10 min of data), liquidity/mcap 10, smart wallets 15 (your own wallet list checked over RPC; left out when empty). Missing components are excluded and the rest re-weighted; fewer than 4 components never passes. Only 70+ moves on.
  4. **Executor**: sizes at most 8% of equity (0.02 SOL floor, max 8 open), gets a Jupiter buy quote and a sell quote (honeypot check).
  5. **Risk**: approves the ticket and registers a −6% hard stop before the fill; trailing stop 6% off the peak once the position has been +12%. Also keeps the liquidity-drop, sell-spike, time and daily-loss exits and the kill switch. Marks use the worse of DexScreener and the Jupiter sell quote about every second.
  6. **Logger**: every kill (stage + reason), score and trade, kept in localStorage (last 600 events). Tap an agent or **Log** to filter by agent.
- **Live**: a feed in the style of J7Tracker that lists new DexScreener token profiles and boosts. It refreshes every 20 seconds and shows social links and copyable contract addresses. Live tweet tracking would need paid X/J7 API keys, so the feed links to each token's X account instead.

**Data sources on mobile networks (v11).** Phones on LTE often share one public IP with many other users (carrier NAT), so GeckoTerminal (~30 calls/min per IP) and DexScreener rate-limit them. Their limit responses carry no CORS headers, so the browser reports a plain network error. The app paces requests per host (GeckoTerminal ≥2.5 s apart), backs off a host after a failure instead of retrying, and shares one cache between the Fast tab and the bot's Scout. Open positions are priced with one batched DexScreener call per tick. If one source fails, the other one is used, and the last good data is kept for up to 10 minutes. The status says which source is limited and only says "offline" when the device is offline.

**Faster bot (v12).** The pipeline runs every 12 s and never overlaps. The Scout pulls fresh DexScreener lists and token data about every 36 s; before v12 it was every 120 s. GeckoTerminal stays slow: one background round per minute of 2 calls, plus at most one Analyst lookup per 30–60 s. RugCheck runs 3 lookups at a time and caches reports for 10 minutes. Coins killed in the last 5 minutes are not re-checked. With no open positions the bot makes about 9 DexScreener and 2 GeckoTerminal calls per minute.

**Fresh (pump.fun) mode (v13).** Settings → Strategy: Strong (default) / Fresh (pump.fun) / Both. Paper only unless you switch to LIVE yourself. Fresh trades brand-new pump.fun coins: 5 min–6 h old, $30K–$1M market cap, with hype (DexScreener profiles, boosts, community takeovers and ads; GeckoTerminal pump.fun pools; the PumpPortal new-token and migration stream). Safety checks: mint and freeze authority revoked, no RugCheck danger, top-10 ≤35% (bonding curve excluded), dev ≤10%, bundles ≤20%. Before every entry the dev's history is checked: earlier launches are sampled from public Solana RPC and combined with PumpPortal and RugCheck. Serial launchers (>5 launches in 24 h) and devs with ≥2 dead or rugged launches are skipped. Results are cached for 30 minutes per dev. Each trade uses 3% of equity, with at most 6 open. Exits: sell half at +25%, then a 10% trail (7% after the take-profit). Hard stop −12%, max hold 20 min. The bot also exits at once when the creator sells, one wallet sells ≥1.5% of supply, sellers outpace buyers 2:1 in 30 s, or the price drops 15% from a fresh peak. The PumpPortal trade stream triggers exits within about a second; there is also a 1 s price check. pump.fun's own API is blocked for browsers (Cloudflare), so it is not used.

**Paper balance & currency (v13).** Settings → Mode: *Display currency* USD / CZK. The USD→CZK rate comes from open.er-api.com (fallback frankfurter.dev), is cached 1 h, and the last rate is kept if offline. Display only; accounting stays in USD. *Paper balance* plus *Reset paper account* restarts the paper account with that cash (positions, trades, equity history and log are cleared). In PAPER the smallest trade is $0.50 and each simulated swap pays a ~0.00008 SOL network/priority fee. LIVE keeps the 0.02 SOL minimum.

Every API it uses is public, keyless and CORS-enabled. There is no build step; GitHub Pages serves these files as-is. Bump `VERSION` in `sw.js` when you deploy changes so installed phones pick up the update.

**Not financial advice.** Memecoins are extremely risky, and many fresh tokens are rugs.

Published site: https://majitelzeme.github.io/coins-signals/

## Install on a phone

- iOS: Safari Share > Add to Home Screen
- Android: Chrome menu > Install app / Add to Home screen
