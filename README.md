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

Every API it uses is public, keyless and CORS-enabled. There is no build step; GitHub Pages serves these files as-is. Bump `VERSION` in `sw.js` when you deploy changes so installed phones pick up the update.

**Not financial advice.** Memecoins are extremely risky, and many fresh tokens are rugs.

Published site: https://majitelzeme.github.io/coins-signals/

## Install on a phone

- iOS: Safari Share > Add to Home Screen
- Android: Chrome menu > Install app / Add to Home screen
