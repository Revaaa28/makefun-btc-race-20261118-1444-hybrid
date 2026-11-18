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

- **Mean-reversion door** (sideways tape): the close has fallen ≥180 bps
  below the trailing 60-bar high, RSI(14) ≤ 38, the bar bounced off its low
  and lifted ≥15 bps off the trailing 30-bar low. A second trigger fires when
  RSI ≤ 35 and the close sits under the lower Bollinger band (20, 2σ).
  Exits: +150 bps take-profit, −80 bps stop-loss, trailing give-back
  (arm +80, give 50), 360-bar time stop, or RSI ≥ 72 (bounce spent).
- **Trend door** (trending tape): EMA 9 > EMA 21 > EMA 50 with EMA 50
  rising, a 20-bar high breakout on a bar gaining ≥10 bps, RSI ≤ 68.
  Exits: +200 bps take-profit, −100 bps stop-loss, trailing give-back
  (arm +100, give 60), 360-bar time stop, or EMA 9 crossing back under
  EMA 21 (trend broken).
- **ATR intelligence**: ATR(14) in bps stretches the dip / breakout bars on
  a hot tape (≥90 bps) and relaxes them on a cold tape (≤25 bps), and widens
  the stop the position size is risked against — a wild hour cannot force a
  full-size entry on a noise dip.
- **Risk sizing**: each trade risks ~1% of equity (stop distance); size is
  capped by cash and the weight room, so entries are effectively full-size
  with normal stops and shrink automatically when ATR widens the stop.
- **Internal drawdown halt**: at 20% below peak equity the bot flattens and
  stops for the rest of the window (the competition guardrail is 25%).

After any exit the bot waits 12 bars before a new entry, and takes no new
entry in the last stretch of the window.

Everything is a pure function of the bars: no clock, no environment, no
randomness — two executions on the same data give the same orders.

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
