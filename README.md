# Memecoin Signals

Static installable web app (PWA) that scans memecoins. It has three views, and none of them predicts price:

- **Fast**: fresh pairs under 72 hours old on Solana, Base, BSC and Ethereum, taken from DexScreener (latest token profiles and boosts) and GeckoTerminal trending pools. Each pair gets a momentum score from price change, buy pressure, volume against liquidity, trade activity and buzz, plus a risk level (HIGH, VERY HIGH or EXTREME) based on age, liquidity, FDV against liquidity, sell pressure and missing socials.
- **Slow**: established memecoins from the CoinGecko `meme-token` category, with Binance as a fallback. Swing setups lasting 1 to 3 days are weighted toward the 4h trend and show entry, stop, target and hold time.
- **Bot (Meme Terminal)**: a paper or live flip bot for Fast Solana memecoins only (minutes to ~90 minutes, never Slow coins). Default is PAPER. LIVE uses a burner wallet generated in the browser (not your Phantom seed) and Jupiter swaps. The bot only runs while the app is open.
- **Live**: a feed in the style of J7Tracker that lists new DexScreener token profiles and boosts. It refreshes every 20 seconds and shows social links and copyable contract addresses. Live tweet tracking would need paid X/J7 API keys, so the feed links to each token's X account instead.

Every API it uses is public, keyless and CORS-enabled. There is no build step; GitHub Pages serves these files as-is. Bump `VERSION` in `sw.js` when you deploy changes so installed phones pick up the update.

**Not financial advice.** Memecoins are extremely risky, and many fresh tokens are rugs.

Published site: https://majitelzeme.github.io/coins-signals/

## Install on a phone

- iOS: Safari Share > Add to Home Screen
- Android: Chrome menu > Install app / Add to Home screen
