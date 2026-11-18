// HYBRID-1444 — an active regime-switching hybrid for the make.fun cbBTC 24h race.
//
// Rev's design: the bot must NOT sit idle. Two doors share one long-only
// position (100% of cash per entry, risk-sized so the stop is ~1% of equity):
//
//   * MR door (mean reversion, sideways tape): the close has fallen a long way
//     below the trailing 60-bar high, RSI(14) is washed out, the bar bounced
//     off its low and lifted off the trailing 30-bar low; or, as a second
//     trigger, RSI is washed out and the close sits under the lower Bollinger
//     band. Exits on take-profit, stop-loss, a trailing give-back, a time
//     stop, or RSI running hot again.
//   * Trend door (trending tape): EMA 9 > EMA 21 > EMA 50 with EMA 50 rising,
//     a 20-bar high breakout on a strong bar, RSI not overbought. Exits on
//     take-profit, stop-loss, a trailing give-back, a time stop, or the fast
//     EMA crossing back under the slow one.
//
//   * ATR intelligence: ATR(14) in bps stretches the dip / breakout bars when
//     the tape is hot and relaxes them when it is cold, and widens the stop
//     the position size is risked against, so one wild hour cannot force a
//     full-size entry on a noise dip.
//   * A 20% internal drawdown halt: once equity falls 20% below its peak the
//     bot flattens and stops for the rest of the window (the guardrail is 25%).
//
// Everything is a pure function of the bars: no clock, no environment, no
// randomness. Indicator math is float64, exactly as the kit baselines do it,
// so two executions on the same data give the same orders.

import { runBars, type Bar, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

const P = {
  // Mean-reversion door
  mrDipBps: 180, // close this far (bps) below the trailing 60-bar high
  mrRsiMax: 38, // RSI(14) at or under this
  mrLiftBps: 15, // close lifted this far (bps) off the trailing 30-bar low
  mrTpBps: 150,
  mrSlBps: 80,
  mrTrailArmBps: 80,
  mrTrailGiveBps: 50,
  mrTimeStop: 360,
  mrRsiExit: 72, // bounce spent: RSI hot again
  // Bollinger variant of the MR door (sideways chop that never dips 180 bps)
  bbRsiMax: 35,
  bbBars: 20,
  bbSigmas: 2,
  // Trend door
  trTpBps: 200,
  trSlBps: 100,
  trTrailArmBps: 100,
  trTrailGiveBps: 60,
  trTimeStop: 360,
  trRsiMax: 68,
  trGainMinBps: 10, // breakout bar must gain at least this (bps)
  // Shared
  cooldown: 12, // bars to wait after any exit before a new entry
  warmupMr: 60, // MR door needs the trailing high + RSI seeded
  warmupTrend: 130, // trend door needs EMA 50 + its 10-bar history
  noEntryAfterSeq: 1400, // no new entry in the last stretch of the window
  maxSlipBps: 500, // 5% past the close: rejects only freak opens
  riskBudgetBps: 100, // risk ~1% of equity per trade (stop distance)
  haltDdBps: 2000, // 20% internal drawdown halt
  atrHotBps: 90, // ATR at/above this: hot tape, demand more
  atrColdBps: 25, // ATR at/under this: cold tape, accept less
  atrHotDipBps: 240, // MR dip demanded on a hot tape
  atrColdDipBps: 150, // MR dip accepted on a cold tape
  atrHotGainBps: 15, // breakout bar gain demanded on a hot tape
  atrColdGainBps: 8, // breakout bar gain accepted on a cold tape
};

type Door = 'mr' | 'bb' | 'trend';

class Hybrid {
  closes: number[] = [];
  highs: number[] = [];
  lows: number[] = [];
  typical: number[] = [];
  ema9: number | null = null;
  ema21: number | null = null;
  ema50: number | null = null;
  ema50Hist: number[] = [];
  // Wilder RSI(14)
  rsiGain: number | null = null;
  rsiLoss: number | null = null;
  rsiFirst: number[] = [];
  rsi: number | null = null;
  // Wilder ATR(14) on true range, kept in price units
  atr: number | null = null;
  atrFirst: number[] = [];
  prevClose: number | null = null;

  entryPrice = 0; // actual fill price once the buy fill lands
  entryIdx = -1;
  entryDoor: Door | null = null;
  peakGainBps = 0;
  lastExitIdx = -1_000_000;
  pending: 'buy' | 'sell' | null = null;
  orderN = 0;
  peakEquity: bigint | null = null;
  halted = false;

  private nextId(tag: string): string {
    this.orderN += 1;
    return `${tag}${this.orderN}`;
  }

  private static ema(prev: number | null, x: number, n: number): number {
    if (prev === null) return x;
    const k = 2 / (n + 1);
    return prev + (x - prev) * k;
  }

  private feed(bar: Bar): void {
    const h = Number(bar.h);
    const l = Number(bar.l);
    const c = Number(bar.c);
    this.highs.push(h);
    this.lows.push(l);
    this.closes.push(c);
    this.typical.push((h + l + c) / 3);
    if (this.typical.length > P.bbBars) this.typical.shift();

    if (this.prevClose !== null) {
      const chg = c - this.prevClose;
      const up = chg > 0 ? chg : 0;
      const down = chg < 0 ? -chg : 0;
      if (this.rsiGain === null) {
        this.rsiFirst.push(chg);
        if (this.rsiFirst.length === 14) {
          let g = 0;
          let lo = 0;
          for (const d of this.rsiFirst) {
            if (d > 0) g += d;
            else lo -= d;
          }
          this.rsiGain = g / 14;
          this.rsiLoss = lo / 14;
        }
      } else {
        this.rsiGain = (this.rsiGain * 13 + up) / 14;
        this.rsiLoss = (this.rsiLoss * 13 + down) / 14;
      }
      if (this.rsiGain !== null && this.rsiLoss !== null) {
        this.rsi = this.rsiLoss === 0 ? 100 : 100 - 100 / (1 + this.rsiGain / this.rsiLoss);
      }
      const tr = Math.max(h - l, Math.abs(h - this.prevClose), Math.abs(l - this.prevClose));
      if (this.atr === null) {
        this.atrFirst.push(tr);
        if (this.atrFirst.length === 14) {
          this.atr = this.atrFirst.reduce((a, x) => a + x, 0) / 14;
        }
      } else {
        this.atr = (this.atr * 13 + tr) / 14;
      }
    }
    this.prevClose = c;
    this.ema9 = Hybrid.ema(this.ema9, c, 9);
    this.ema21 = Hybrid.ema(this.ema21, c, 21);
    this.ema50 = Hybrid.ema(this.ema50, c, 50);
    if (this.ema50 !== null) this.ema50Hist.push(this.ema50);
  }

  /** ATR(14) as bps of the latest close, or null before it is seeded. */
  private atrBps(): number | null {
    if (this.atr === null || this.closes.length === 0) return null;
    const c = this.closes[this.closes.length - 1];
    return (this.atr / c) * 10_000;
  }

  /** Lower Bollinger band (20 typical prices, 2 population sigmas), or null. */
  private lowerBand(): number | null {
    if (this.typical.length < P.bbBars) return null;
    let mean = 0;
    for (const x of this.typical) mean += x;
    mean /= P.bbBars;
    let variance = 0;
    for (const x of this.typical) variance += (x - mean) * (x - mean);
    variance /= P.bbBars;
    return mean - P.bbSigmas * Math.sqrt(variance);
  }

  onBatch(state: BarsState, batch: { bars: Bar[]; fills: { side: string; status: string; price: string }[] }): (BuyInput | SellInput)[] | null {
    for (const bar of batch.bars) {
      if (bar.symbol === SYMBOL) this.feed(bar);
    }
    for (const fill of batch.fills) {
      if (this.pending === 'buy' && fill.side === 'buy') {
        if (fill.status === 'filled') this.entryPrice = Number(fill.price);
        this.pending = null;
      } else if (this.pending === 'sell' && fill.side === 'sell') {
        this.pending = null;
      }
    }
    if (state.warmingUp || this.closes.length === 0) return null;
    const i = this.closes.length - 1;
    const close = this.closes[i];
    const prev = i > 0 ? this.closes[i - 1] : close;

    // Internal drawdown halt: 20% below peak equity flattens and stops.
    if (this.peakEquity === null || state.equity > this.peakEquity) this.peakEquity = state.equity;
    if (!this.halted && state.equity * 10_000n <= this.peakEquity * BigInt(10_000 - P.haltDdBps)) {
      this.halted = true;
    }

    const holding = state.positions.get(SYMBOL);
    if (this.halted) {
      if (holding !== undefined && this.pending === null) {
        this.pending = 'sell';
        this.lastExitIdx = i;
        return [{ side: 'sell', client_id: this.nextId('s'), symbol: SYMBOL, qty: holding.qty, max_slippage_bps: P.maxSlipBps }];
      }
      return null;
    }

    if (holding !== undefined && this.pending === null) {
      const gainBps = ((close - this.entryPrice) * 10_000) / this.entryPrice;
      if (gainBps > this.peakGainBps) this.peakGainBps = gainBps;
      const door = this.entryDoor ?? 'mr';
      const tp = door === 'trend' ? P.trTpBps : P.mrTpBps;
      const sl = door === 'trend' ? P.trSlBps : P.mrSlBps;
      const arm = door === 'trend' ? P.trTrailArmBps : P.mrTrailArmBps;
      const give = door === 'trend' ? P.trTrailGiveBps : P.mrTrailGiveBps;
      const ts = door === 'trend' ? P.trTimeStop : P.mrTimeStop;
      let exit = false;
      if (gainBps <= -sl) exit = true; // stop-loss
      else if (gainBps >= tp) exit = true; // take-profit
      else if (this.peakGainBps >= arm && this.peakGainBps - gainBps >= give) exit = true; // trailing give-back
      else if (i - this.entryIdx >= ts) exit = true; // time stop
      else if (door !== 'trend' && this.rsi !== null && this.rsi >= P.mrRsiExit) exit = true; // MR bounce spent
      else if (
        door === 'trend' &&
        this.ema9 !== null &&
        this.ema21 !== null &&
        this.ema9 < this.ema21
      ) {
        exit = true; // trend broken: fast EMA back under slow
      }
      if (exit) {
        this.pending = 'sell';
        this.lastExitIdx = i;
        return [{ side: 'sell', client_id: this.nextId('s'), symbol: SYMBOL, qty: holding.qty, max_slippage_bps: P.maxSlipBps }];
      }
      return null;
    }
    if (holding !== undefined || this.pending !== null) return null;
    if (i - this.lastExitIdx < P.cooldown) return null;
    if (state.seq > P.noEntryAfterSeq) return null;

    const atr = this.atrBps();
    const dipBps = atr === null ? P.mrDipBps : atr >= P.atrHotBps ? P.atrHotDipBps : atr <= P.atrColdBps ? P.atrColdDipBps : P.mrDipBps;
    const gainMinBps =
      atr === null ? P.trGainMinBps : atr >= P.atrHotBps ? P.atrHotGainBps : atr <= P.atrColdBps ? P.atrColdGainBps : P.trGainMinBps;

    let door: Door | null = null;

    // MR door: deep dip + washed-out RSI + bounce + lift off the low.
    if (this.rsi !== null && i >= P.warmupMr) {
      const win = this.highs.slice(Math.max(0, i - 60), i);
      const hi = win.length > 0 ? Math.max(...win) : close;
      const low30 = Math.min(...this.closes.slice(Math.max(0, i - 30), i + 1));
      const dipped = close * 10_000 <= hi * (10_000 - dipBps);
      const lifted = close * 10_000 >= low30 * (10_000 + P.mrLiftBps);
      if (dipped && this.rsi <= P.mrRsiMax && close > prev && lifted) door = 'mr';
    }
    // Bollinger variant: washed-out RSI, close under the lower band, bouncing.
    if (door === null && this.rsi !== null && i >= P.warmupMr) {
      const lower = this.lowerBand();
      if (lower !== null && this.rsi <= P.bbRsiMax && close < lower && close > prev) door = 'bb';
    }
    // Trend door: bull EMA stack, EMA 50 rising, 20-bar breakout, strong bar.
    if (door === null && i >= P.warmupTrend) {
      if (
        this.ema9 !== null &&
        this.ema21 !== null &&
        this.ema50 !== null &&
        this.ema50Hist.length > 10 &&
        this.ema9 > this.ema21 &&
        this.ema21 > this.ema50 &&
        this.ema50 > this.ema50Hist[this.ema50Hist.length - 11] &&
        this.rsi !== null &&
        this.rsi <= P.trRsiMax
      ) {
        const winHi = Math.max(...this.highs.slice(Math.max(0, i - 20), i));
        const barGainBps = ((close - prev) * 10_000) / prev;
        if (close > winHi && barGainBps >= gainMinBps) door = 'trend';
      }
    }
    if (door === null) return null;

    // Risk sizing: size the stop at ~1% of equity; the stop widens with ATR,
    // so a hot tape automatically buys smaller. Capped by cash and weight room.
    const slBps = Math.max(door === 'trend' ? P.trSlBps : P.mrSlBps, atr ?? 0);
    let size = (state.equity * BigInt(P.riskBudgetBps)) / BigInt(Math.round(slBps));
    if (size > state.cash) size = state.cash;
    const room = state.weightRoom(SYMBOL);
    if (size > room) size = room;
    if (size < BigInt(state.hello.fees.min_notional_quote_units)) return null;

    this.pending = 'buy';
    this.entryPrice = close; // replaced by the actual fill price next batch
    this.entryIdx = i;
    this.entryDoor = door;
    this.peakGainBps = 0;
    return [{ side: 'buy', client_id: this.nextId('b'), symbol: SYMBOL, notional_quote_units: size, max_slippage_bps: P.maxSlipBps }];
  }
}

const bot = new Hybrid();

await runBars({
  onBatch(state, batch) {
    return bot.onBatch(state, batch);
  },
});
