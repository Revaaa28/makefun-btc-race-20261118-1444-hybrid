# HYBRID-1444 — regime-switching cbBTC trading bot

[![make.fun](https://img.shields.io/badge/make.fun-btc--race--24h--20261118--1444-blue)](https://make.fun)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Runtime: Node 22](https://img.shields.io/badge/runtime-Node%2022-green)](https://nodejs.org)

An active regime-switching hybrid bot for the
[make.fun](https://make.fun) competition
`btc-race-24h-20261118-1444` — "Race a BTC trading bot live for 24 hours".
It trades Coinbase Wrapped BTC (cbBTC) against USDC, minute by minute, on
1-minute on-chain bars from the Orca Whirlpool, starting with 1,000 USDC of
paper money. Long only, at most one open position, full-size entries.

## Design

The bot must not sit idle. Two doors share the single position:

- **Mean-reversion door**: the close has fallen ≥180 bps below the trailing
  60-bar high (ATR-adjusted: 150 bps on a cold tape, 240 bps on a hot one),
  RSI(14) ≤ 38, and the bar bounced. There is deliberately no lift filter:
  at the bottom of a grinding drop the close *is* the trailing low, so a
  lift requirement and a dip requirement can almost never both hold. The
  bounce it buys is short, so it exits fast: +90 bps take-profit, −60 bps
  stop-loss, trailing give-back (arm +60, give 30), 60-bar time stop, or
  RSI ≥ 70.
- **Trend door**: EMA 9 > EMA 21 > EMA 50 with EMA 50 rising, a 20-bar high
  breakout on a bar gaining ≥10 bps (ATR-adjusted), RSI ≤ 65 so a breakout
  that is already hot is not chased. Exits: +90 bps take-profit, −80 bps
  stop-loss, trailing give-back (arm +80, give 40), 90-bar time stop, or
  EMA 9 crossing back under EMA 21.
- **ATR intelligence**: ATR(14) in bps stretches the dip / breakout bars on
  a hot tape and relaxes them on a cold tape, and widens the stop the
  position size is risked against.
- **Risk sizing**: each trade risks ~1% of equity (stop distance); size is
  capped by cash and the weight room, so entries are effectively full-size
  with normal stops and shrink automatically when ATR widens the stop.
- **Internal drawdown halt**: at 20% below peak equity the bot flattens and
  stops for the rest of the window (the competition guardrail is 25%).

After any exit the bot waits 12 bars before a new entry, and takes no new
entry in the last stretch of the window.

A Bollinger lower-band variant was built, measured and removed: on 1-minute
bars its forward edge (+16 bps mean at 30 bars) sits below the ~26 bps
round-trip cost, and on the dev tape its 8 trades net about −$21.

Everything is a pure function of the bars: no clock, no environment, no
randomness — two executions on the same data give the same orders.

## Measured results (official dev window, kit grade-local)

- **HYBRID-1444: net PnL +$11.07, 3 round trips (6 trades), max drawdown
  0.82%** — passes the dev gate (>$0).
- Baselines on the same window: buy-and-hold −$31.63, momentum −$23.87,
  rsi-bollinger −$39.92, adx-momentum −$75.57, ema-cross −$148.17.
- Robustness check on Binance BTCUSDT 1m, Nov 9–16 2026 (a −13.9% week;
  buy-and-hold −$138.93 over the 8 days): this bot −$114.03, 0/8 positive
  days — it loses less than holding, but it does lose in a grinding
  downtrend, as any long-only bot does. Reported plainly; the dev gate is
  what decides whether it races.

## Layout

- `main.ts` — the bot (TypeScript, Node 22, erasable syntax only).
- `vendor/makefun-bars.ts` — byte-identical copy of the kit's
  `agent-fun/bars-replay/v1` SDK shim.
- `LICENSE` — MIT.

## Grade locally

With the competition kit (which ships the frozen dev window and the exact
harness the server grades with):

```sh
node <kit>/cli/makefun.mjs grade-local --kit <kit> --bot . --driver process
```

The dev gate: the entry races only if its latest dev grade ends with net
PnL above $0 after all fees.
