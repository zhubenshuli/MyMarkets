import {
  deleteDailyFrozenPlan,
  deletePositionSnapshot,
  getPositionSnapshots,
  getStoredStrategyConfig,
  insertPositionSnapshot,
  setStoredStrategyConfig,
  type PositionSnapshotRow,
  type StoredStrategyConfig,
} from "./db.ts";
import { addDays, beijingDate } from "../shared/time.ts";
import type {
  ActionPointItem,
  CostCurvePoint,
  CycleRegimeState,
  DcaTierRow,
  GridLadderRow,
  MarketQuote,
  PorkStatusTone,
  PositionPlanDetail,
  PositionSnapshotItem,
  PositionTargetSymbol,
  TechnicalDataContext,
} from "../shared/types.ts";

interface RawLadderRung {
  baseShares: number;
  sellPrice: number | null;
  sellShares: number | null;
  retainShares: number;
  pairedBuyPrice: number | null;
  buyPrice: number | null;
  buyShares: number | null;
  buyZone: "normal" | "crash" | "stop";
}

export const DEFAULT_STRATEGY_CONFIGS: Record<
  PositionTargetSymbol,
  Required<Pick<StoredStrategyConfig, "anchorPrice" | "baseCoreShares" | "dcaPeriods" | "dcaBaseDaily">>
> = {
  etf_516670: {
    anchorPrice: 0.6,
    baseCoreShares: 10400,
    dcaPeriods: 0,
    dcaBaseDaily: 0,
  },
  cea_600115: {
    anchorPrice: 3.4,
    baseCoreShares: 2200,
    dcaPeriods: 0,
    dcaBaseDaily: 0,
  },
  etf_513180: {
    anchorPrice: 0.586,
    baseCoreShares: 0,
    dcaPeriods: 162,
    dcaBaseDaily: 100,
  },
};

export const DEFAULT_BASELINE_SNAPSHOTS: Record<PositionTargetSymbol, PositionSnapshotRow> = {
  etf_516670: {
    id: 0,
    symbol: "etf_516670",
    day: "2026-11-06",
    shares: 14400,
    market_value: 8798.4,
    unrealized_pnl: 507.84,
    note: "初始底仓与网格筹码（14,400股 · 摊薄成本¥0.5757）",
    created_at: "2026-11-06T15:00:00.000Z",
  },
  cea_600115: {
    id: 0,
    symbol: "cea_600115",
    day: "2026-11-06",
    shares: 3000,
    market_value: 10680.0,
    unrealized_pnl: 674.91,
    note: "初始底仓与网格筹码（3,000股 · 摊薄成本¥3.335）",
    created_at: "2026-11-06T15:00:00.000Z",
  },
  etf_513180: {
    id: 0,
    symbol: "etf_513180",
    day: "2026-11-06",
    shares: null,
    market_value: 16756.62,
    unrealized_pnl: -2502.54,
    note: "场外定投已投162期+单独加仓（累计成本¥19,259.16）",
    created_at: "2026-11-06T15:00:00.000Z",
  },
};

const BASE_516670_RUNGS: readonly RawLadderRung[] = [
  { baseShares: 10400, sellPrice: null, sellShares: null, retainShares: 0, pairedBuyPrice: null, buyPrice: 0.637, buyShares: 1000, buyZone: "normal" },
  { baseShares: 11400, sellPrice: 0.649, sellShares: 1000, retainShares: 0, pairedBuyPrice: 0.637, buyPrice: 0.624, buyShares: 1000, buyZone: "normal" },
  { baseShares: 12400, sellPrice: 0.637, sellShares: 1000, retainShares: 0, pairedBuyPrice: 0.624, buyPrice: 0.612, buyShares: 1000, buyZone: "normal" },
  { baseShares: 13400, sellPrice: 0.624, sellShares: 1000, retainShares: 0, pairedBuyPrice: 0.612, buyPrice: 0.600, buyShares: 1000, buyZone: "normal" },
  { baseShares: 14400, sellPrice: 0.612, sellShares: 1000, retainShares: 0, pairedBuyPrice: 0.600, buyPrice: 0.588, buyShares: 1000, buyZone: "normal" },
  { baseShares: 15400, sellPrice: 0.600, sellShares: 1000, retainShares: 0, pairedBuyPrice: 0.588, buyPrice: 0.576, buyShares: 1000, buyZone: "normal" },
  { baseShares: 16400, sellPrice: 0.588, sellShares: 1000, retainShares: 0, pairedBuyPrice: 0.576, buyPrice: 0.565, buyShares: 1000, buyZone: "normal" },
  { baseShares: 17400, sellPrice: 0.576, sellShares: 1000, retainShares: 0, pairedBuyPrice: 0.565, buyPrice: 0.553, buyShares: 1500, buyZone: "normal" },
  { baseShares: 18900, sellPrice: 0.565, sellShares: 1500, retainShares: 0, pairedBuyPrice: 0.553, buyPrice: 0.542, buyShares: 1500, buyZone: "normal" },
  { baseShares: 20400, sellPrice: 0.553, sellShares: 1500, retainShares: 0, pairedBuyPrice: 0.542, buyPrice: 0.532, buyShares: 1500, buyZone: "normal" },
  { baseShares: 21900, sellPrice: 0.542, sellShares: 1500, retainShares: 0, pairedBuyPrice: 0.532, buyPrice: 0.505, buyShares: 4000, buyZone: "crash" },
  { baseShares: 25900, sellPrice: 0.532, sellShares: 2000, retainShares: 2000, pairedBuyPrice: 0.505, buyPrice: 0.480, buyShares: 5000, buyZone: "crash" },
  { baseShares: 30900, sellPrice: 0.505, sellShares: 2500, retainShares: 2500, pairedBuyPrice: 0.480, buyPrice: 0.456, buyShares: 6000, buyZone: "crash" },
  { baseShares: 36900, sellPrice: 0.480, sellShares: 3000, retainShares: 3000, pairedBuyPrice: 0.456, buyPrice: 0.433, buyShares: 8000, buyZone: "crash" },
  { baseShares: 44900, sellPrice: 0.456, sellShares: 4000, retainShares: 4000, pairedBuyPrice: 0.433, buyPrice: null, buyShares: null, buyZone: "stop" },
];

const BASE_600115_RUNGS: readonly RawLadderRung[] = [
  { baseShares: 2200, sellPrice: null, sellShares: null, retainShares: 0, pairedBuyPrice: null, buyPrice: 3.57, buyShares: 400, buyZone: "normal" },
  { baseShares: 2600, sellPrice: 3.75, sellShares: 400, retainShares: 0, pairedBuyPrice: 3.57, buyPrice: 3.40, buyShares: 400, buyZone: "normal" },
  { baseShares: 3000, sellPrice: 3.57, sellShares: 400, retainShares: 0, pairedBuyPrice: 3.40, buyPrice: 3.23, buyShares: 400, buyZone: "normal" },
  { baseShares: 3400, sellPrice: 3.40, sellShares: 400, retainShares: 0, pairedBuyPrice: 3.23, buyPrice: 3.07, buyShares: 400, buyZone: "normal" },
  { baseShares: 3800, sellPrice: 3.23, sellShares: 400, retainShares: 0, pairedBuyPrice: 3.07, buyPrice: 2.92, buyShares: 400, buyZone: "normal" },
  { baseShares: 4200, sellPrice: 3.07, sellShares: 400, retainShares: 0, pairedBuyPrice: 2.92, buyPrice: 2.77, buyShares: 400, buyZone: "normal" },
  { baseShares: 4600, sellPrice: 2.92, sellShares: 400, retainShares: 0, pairedBuyPrice: 2.77, buyPrice: 2.58, buyShares: 800, buyZone: "crash" },
  { baseShares: 5400, sellPrice: 2.77, sellShares: 400, retainShares: 400, pairedBuyPrice: 2.58, buyPrice: 2.40, buyShares: 1000, buyZone: "crash" },
  { baseShares: 6400, sellPrice: 2.58, sellShares: 500, retainShares: 500, pairedBuyPrice: 2.40, buyPrice: 2.23, buyShares: 1200, buyZone: "crash" },
  { baseShares: 7600, sellPrice: 2.40, sellShares: 600, retainShares: 600, pairedBuyPrice: 2.23, buyPrice: null, buyShares: null, buyZone: "stop" },
];

const round2 = (n: number) => Math.round(n * 100) / 100;
const roundTo = (n: number, decimals: number) => Number(n.toFixed(decimals));

export function getEffectiveSnapshots(symbol: PositionTargetSymbol): PositionSnapshotRow[] {
  const rows = getPositionSnapshots(symbol);
  if (rows.length > 0) return rows;
  return [DEFAULT_BASELINE_SNAPSHOTS[symbol]];
}

export function recordPositionSnapshot(input: {
  symbol: PositionTargetSymbol;
  day?: string;
  shares?: number | null;
  marketValue: number;
  unrealizedPnl: number;
  note?: string | null;
}): PositionSnapshotRow {
  const existing = getPositionSnapshots(input.symbol);
  if (existing.length === 0) {
    const base = DEFAULT_BASELINE_SNAPSHOTS[input.symbol];
    insertPositionSnapshot({
      symbol: base.symbol,
      day: base.day,
      shares: base.shares,
      marketValue: base.market_value,
      unrealizedPnl: base.unrealized_pnl,
      note: base.note,
      createdAt: base.created_at,
    });
  }
  const day = input.day && /^\d{4}-\d{2}-\d{2}$/.test(input.day) ? input.day : beijingDate(new Date());
  const inserted = insertPositionSnapshot({
    symbol: input.symbol,
    day,
    shares: input.symbol === "etf_513180" ? null : (input.shares ?? null),
    marketValue: round2(input.marketValue),
    unrealizedPnl: round2(input.unrealizedPnl),
    note: input.note?.trim() || null,
  });
  // Invalidate cached daily frozen plan so intraday verification reflects new position immediately
  deleteDailyFrozenPlan(input.symbol);
  return inserted;
}

export function removePositionSnapshot(id: number): boolean {
  const deleted = deletePositionSnapshot(id);
  if (deleted) {
    deleteDailyFrozenPlan();
  }
  return deleted;
}

export function updateStrategyConfig(
  symbol: PositionTargetSymbol,
  patch: Partial<StoredStrategyConfig>,
): StoredStrategyConfig {
  const current = getStoredStrategyConfig(symbol) ?? {};
  const next: StoredStrategyConfig = { ...current, ...patch };
  setStoredStrategyConfig(symbol, next);
  deleteDailyFrozenPlan(symbol);
  return next;
}

export function buildLadderRows(
  symbol: "etf_516670" | "cea_600115",
  anchorPrice: number,
  baseCoreShares: number,
  bonusCoreShares: number,
  currentShares: number,
): { rows: GridLadderRow[]; currentRowIndex: number; shareAlignmentDiff: number } {
  const isCea = symbol === "cea_600115";
  const decimals = isCea ? 2 : 3;
  const defaultAnchor = DEFAULT_STRATEGY_CONFIGS[symbol].anchorPrice;
  const defaultBaseCore = DEFAULT_STRATEGY_CONFIGS[symbol].baseCoreShares;
  const scale = anchorPrice > 0 ? anchorPrice / defaultAnchor : 1;
  const shift = (baseCoreShares - defaultBaseCore) + bonusCoreShares;
  const rawRungs = isCea ? BASE_600115_RUNGS : BASE_516670_RUNGS;

  const scalePrice = (p: number | null) =>
    p === null ? null : Number((p * scale).toFixed(decimals));

  let bestIdx = 0;
  let bestDist = Infinity;

  const rows: GridLadderRow[] = rawRungs.map((r, idx) => {
    const totalShares = Math.max(0, Math.round(r.baseShares + shift));
    const dist = Math.abs(totalShares - currentShares);
    if (dist < bestDist) {
      bestDist = dist;
      bestIdx = idx;
    }

    const sellPrice = scalePrice(r.sellPrice);
    const pairedBuyPrice = scalePrice(r.pairedBuyPrice);
    const buyPrice = scalePrice(r.buyPrice);
    const buyCash = buyPrice !== null && r.buyShares !== null ? Math.round(buyPrice * r.buyShares) : null;

    let sellLabel = "—（只剩底仓，准备重新定锚）";
    if (sellPrice !== null && r.sellShares !== null) {
      sellLabel =
        r.retainShares > 0
          ? `${sellPrice.toFixed(decimals)} 卖 ${r.sellShares.toLocaleString()}（留 ${r.retainShares.toLocaleString()}）`
          : `${sellPrice.toFixed(decimals)} 卖 ${r.sellShares.toLocaleString()}`;
    }

    let buyLabel = "停止买入";
    if (buyPrice !== null && r.buyShares !== null) {
      buyLabel =
        r.buyZone === "crash"
          ? `大跌 ${buyPrice.toFixed(decimals)} 买 ${r.buyShares.toLocaleString()}`
          : `${buyPrice.toFixed(decimals)} 买 ${r.buyShares.toLocaleString()}`;
    }

    return {
      totalShares,
      isCurrent: false,
      sellPrice,
      sellShares: r.sellShares,
      retainShares: r.retainShares,
      pairedBuyPrice,
      sellLabel,
      buyPrice,
      buyShares: r.buyShares,
      buyCash,
      buyZone: r.buyZone,
      buyLabel,
    };
  });

  if (rows[bestIdx]) {
    rows[bestIdx]!.isCurrent = true;
  }
  const shareAlignmentDiff = rows[bestIdx] ? currentShares - rows[bestIdx]!.totalShares : 0;

  return { rows, currentRowIndex: bestIdx, shareAlignmentDiff };
}

function replayGridSnapshots(
  symbol: "etf_516670" | "cea_600115",
  rawRows: PositionSnapshotRow[],
  anchorPrice: number,
  baseCoreShares: number,
): {
  snapshots: PositionSnapshotItem[];
  profitPool: number;
  bonusCoreShares: number;
  lastBuyPrice: number | null;
} {
  const decimals = symbol === "cea_600115" ? 2 : 3;
  let profitPool = 0;
  let bonusCoreShares = 0;
  let lastBuyPrice: number | null = null;
  const snapshots: PositionSnapshotItem[] = [];

  for (let i = 0; i < rawRows.length; i++) {
    const r = rawRows[i]!;
    const totalCost = round2(r.market_value - r.unrealized_pnl);
    const shares = r.shares ?? DEFAULT_BASELINE_SNAPSHOTS[symbol].shares ?? 0;
    const dilutedCost = shares > 0 ? Number((totalCost / shares).toFixed(4)) : null;

    if (i === 0) {
      snapshots.push({
        id: r.id,
        symbol,
        day: r.day,
        shares,
        marketValue: r.market_value,
        unrealizedPnl: r.unrealized_pnl,
        totalCost,
        dilutedCost,
        inferredTrade: r.note ?? "初始持仓基准",
        note: r.note,
        createdAt: r.created_at,
      });
      continue;
    }

    const prev = snapshots[i - 1]!;
    const prevShares = prev.shares ?? 0;
    const deltaShares = shares - prevShares;
    const deltaCost = round2(totalCost - prev.totalCost);
    const spotPrice =
      shares > 0 ? r.market_value / shares : prev.marketValue / Math.max(1, prevShares);

    const { rows: prevLadder, currentRowIndex: prevIdx } = buildLadderRows(
      symbol,
      anchorPrice,
      baseCoreShares,
      bonusCoreShares,
      prevShares,
    );
    const prevRung = prevLadder[prevIdx];

    let inferredTrade = "持仓市值校准（股数未变）";

    if (deltaShares < 0) {
      const soldShares = Math.abs(deltaShares);
      // Prefer actual transaction price derived from real cost reduction (deltaCost < 0)
      const costImpliedSell = deltaCost < 0 ? Math.abs(deltaCost) / soldShares : null;
      const isValidImpliedSell =
        costImpliedSell !== null &&
        costImpliedSell >= spotPrice * 0.75 &&
        costImpliedSell <= spotPrice * 1.25;
      const sellPrice = isValidImpliedSell
        ? roundTo(costImpliedSell, decimals)
        : (prevRung?.sellPrice ?? roundTo(spotPrice, decimals));

      const defaultPairedBuy =
        prevRung?.pairedBuyPrice ?? sellPrice * (symbol === "cea_600115" ? 0.95 : 0.98);
      const pairedBuy =
        lastBuyPrice !== null && lastBuyPrice < sellPrice
          ? lastBuyPrice
          : defaultPairedBuy;

      // 600115 has 5 RMB min commission each way + 0.05% stamp tax on sell (~11 RMB total)
      const fee =
        symbol === "cea_600115"
          ? round2(10 + soldShares * sellPrice * 0.0005)
          : round2(soldShares * sellPrice * 0.0001);

      // Calculate net profit from actual cost reduction vs diluted/paired basis, fallback to spread
      const basisForCostDelta = Math.min(prev.dilutedCost ?? pairedBuy, pairedBuy);
      const realizedFromCostDelta =
        deltaCost < 0 ? round2(Math.abs(deltaCost) - soldShares * basisForCostDelta) : 0;
      const spreadProfit = round2(Math.max(0, (sellPrice - pairedBuy) * soldShares) - fee);
      const netProfit = Math.max(
        0,
        isValidImpliedSell && realizedFromCostDelta > 0 ? realizedFromCostDelta : spreadProfit,
      );
      profitPool = round2(profitPool + netProfit);

      let retainNote = "";
      if (prevRung && prevRung.retainShares > 0) {
        bonusCoreShares += prevRung.retainShares;
        retainNote = ` · 大跌档留底仓 +${prevRung.retainShares}股`;
      }

      inferredTrade = `卖出 ${soldShares.toLocaleString()}股 @ ~¥${sellPrice.toFixed(decimals)} · 净利入池 +¥${netProfit.toFixed(2)}${retainNote}`;
    } else if (deltaShares > 0) {
      const boughtShares = deltaShares;
      // Prefer actual transaction price derived from real cost addition (deltaCost > 0)
      const costImpliedBuy = deltaCost > 0 ? deltaCost / boughtShares : null;
      const isValidImpliedBuy =
        costImpliedBuy !== null &&
        costImpliedBuy >= spotPrice * 0.75 &&
        costImpliedBuy <= spotPrice * 1.25;
      const buyPrice = isValidImpliedBuy
        ? roundTo(costImpliedBuy, decimals)
        : (prevRung?.buyPrice ?? roundTo(spotPrice, decimals));
      lastBuyPrice = buyPrice;

      const expectedBuyShares = prevRung?.buyShares ?? boughtShares;

      let bonusNote = "";
      if (boughtShares > expectedBuyShares && buyPrice > 0) {
        const extraShares = boughtShares - expectedBuyShares;
        const affordableBonus = Math.floor(profitPool / (buyPrice * 100)) * 100;
        const usedBonus = Math.min(extraShares, affordableBonus);
        if (usedBonus >= 100) {
          bonusCoreShares += usedBonus;
          const usedCash = round2(usedBonus * buyPrice);
          profitPool = Math.max(0, round2(profitPool - usedCash));
          bonusNote = `（含利润池加码底仓 +${usedBonus}股）`;
        }
      } else if (
        r.note?.includes("利润") &&
        buyPrice > 0 &&
        boughtShares >= 100 &&
        profitPool >= boughtShares * buyPrice * 0.8
      ) {
        bonusCoreShares += boughtShares;
        profitPool = Math.max(0, round2(profitPool - boughtShares * buyPrice));
        bonusNote = `（利润池加码底仓 +${boughtShares}股）`;
      }

      inferredTrade = `买入 ${boughtShares.toLocaleString()}股 @ ~¥${buyPrice.toFixed(decimals)}${bonusNote}`;
    }

    snapshots.push({
      id: r.id,
      symbol,
      day: r.day,
      shares,
      marketValue: r.market_value,
      unrealizedPnl: r.unrealized_pnl,
      totalCost,
      dilutedCost,
      inferredTrade,
      note: r.note,
      createdAt: r.created_at,
    });
  }

  return { snapshots, profitPool, bonusCoreShares, lastBuyPrice };
}

function buildCostCurve(
  series: Array<{ day: string; close: number }>,
  snapshots: PositionSnapshotItem[],
  fallbackMarketPrice: number,
  fallbackDilutedCost: number,
): CostCurvePoint[] {
  const pts: CostCurvePoint[] = [];
  const recentSeries = series.length > 0 ? series.slice(-60) : [{ day: beijingDate(new Date()), close: fallbackMarketPrice }];
  const sortedSnaps = [...snapshots].sort((a, b) => a.day.localeCompare(b.day) || a.id - b.id);
  const firstCost = sortedSnaps[0]?.dilutedCost ?? fallbackDilutedCost;
  const firstShares = sortedSnaps[0]?.shares ?? null;

  for (const p of recentSeries) {
    let activeCost = firstCost;
    let activeShares = firstShares;
    for (const s of sortedSnaps) {
      if (s.day <= p.day && s.dilutedCost !== null) {
        activeCost = s.dilutedCost;
        activeShares = s.shares;
      }
    }
    pts.push({
      day: p.day,
      dilutedCost: Number(activeCost.toFixed(4)),
      marketPrice: p.close,
      shares: activeShares,
    });
  }

  // Ensure the latest snapshot day is represented if newer than the last quote day
  const latestSnap = sortedSnaps.at(-1);
  const lastPt = pts.at(-1);
  if (latestSnap && latestSnap.dilutedCost !== null && lastPt && latestSnap.day > lastPt.day) {
    pts.push({
      day: latestSnap.day,
      dilutedCost: Number(latestSnap.dilutedCost.toFixed(4)),
      marketPrice: lastPt.marketPrice,
      shares: latestSnap.shares,
    });
  } else if (latestSnap && latestSnap.dilutedCost !== null && lastPt && latestSnap.day === lastPt.day) {
    lastPt.dilutedCost = Number(latestSnap.dilutedCost.toFixed(4));
    lastPt.shares = latestSnap.shares;
  }

  return pts;
}

function detectCrashCircuitBreaker(
  etfQuote: Partial<Pick<MarketQuote, "price" | "changeYesterday" | "series">> | undefined,
  nextBuyPrice: number | null,
  buyZone: "normal" | "crash" | "stop",
  decimals: number,
): PositionPlanDetail["crashCircuitBreaker"] {
  const ch1d = etfQuote?.changeYesterday ?? 0;
  const series = etfQuote?.series ?? [];
  const ch5d =
    series.length >= 6 && series.at(-6)!.close > 0
      ? series.at(-1)!.close / series.at(-6)!.close - 1
      : 0;

  const isSharpDrop1d = ch1d <= -0.04;
  const isSharpDrop5d = ch5d <= -0.10;
  if (!isSharpDrop1d && !isSharpDrop5d) {
    return null;
  }

  const dropReason = isSharpDrop1d
    ? `单日急跌 ${(ch1d * 100).toFixed(2)}%（超 -4% 阈值）`
    : `5日累计急跌 ${(ch5d * 100).toFixed(2)}%（超 -10% 阈值）`;

  if (buyZone === "crash") {
    return {
      triggered: true,
      reason: `${dropReason}，且价格处于大跌区`,
      actionText: "当档买入量 ×1.5，分两天执行（今天买一半、明天买一半），不一次性接飞刀",
    };
  }
  return {
    triggered: true,
    reason: `${dropReason}（触发常规区急跌减速）`,
    actionText: nextBuyPrice
      ? `下一档（¥${nextBuyPrice.toFixed(decimals)}）推迟 1 个交易日待缩量企稳后再买`
      : "暂缓买入，等待企稳",
  };
}

export function extractTechnicalStats(
  series: Array<{ day: string; close: number; high?: number; low?: number; volume?: number }>,
  currentPrice: number,
  decimals: number,
  defaultVol = 0.014,
): Omit<TechnicalDataContext, "fundamentalDriveSummary"> {
  const valid = series.filter((p) => Number.isFinite(p.close) && p.close > 0);
  const recent10 = valid.slice(-10);
  const recent20 = valid.slice(-20);
  const recent60 = valid.slice(-60);

  const ma10Raw =
    recent10.length > 0
      ? recent10.reduce((sum, p) => sum + p.close, 0) / recent10.length
      : currentPrice;
  const ma10 = roundTo(ma10Raw, decimals);

  const ma20Raw =
    recent20.length > 0
      ? recent20.reduce((sum, p) => sum + p.close, 0) / recent20.length
      : currentPrice;
  const ma20 = roundTo(ma20Raw, decimals);
  const ma20DiffPct = ma20 > 0 ? Number((currentPrice / ma20 - 1).toFixed(4)) : 0;

  const hasHighLow = recent20.some(
    (p) => (p.high !== undefined && p.high > 0) || (p.low !== undefined && p.low > 0),
  );
  const getHigh = (p: { close: number; high?: number }) =>
    p.high !== undefined && Number.isFinite(p.high) && p.high > 0 ? Math.max(p.close, p.high) : p.close;
  const getLow = (p: { close: number; low?: number }) =>
    p.low !== undefined && Number.isFinite(p.low) && p.low > 0 ? Math.min(p.close, p.low) : p.close;

  const high20d = roundTo(
    recent20.length > 0 ? Math.max(currentPrice, ...recent20.map(getHigh)) : currentPrice * 1.02,
    decimals,
  );
  const low20d = roundTo(
    recent20.length > 0 ? Math.min(currentPrice, ...recent20.map(getLow)) : currentPrice * 0.97,
    decimals,
  );
  const high60d = roundTo(
    recent60.length > 0 ? Math.max(high20d, ...recent60.map(getHigh)) : high20d * 1.03,
    decimals,
  );
  const low60d = roundTo(
    recent60.length > 0 ? Math.min(low20d, ...recent60.map(getLow)) : low20d * 0.97,
    decimals,
  );

  const prior20 = recent20.length > 1 ? recent20.slice(0, -1) : [];
  const prevHigh20d = roundTo(
    prior20.length > 0 ? Math.max(...prior20.map(getHigh)) : high20d,
    decimals,
  );
  const prevLow20d = roundTo(
    prior20.length > 0 ? Math.min(...prior20.map(getLow)) : low20d,
    decimals,
  );

  let volSum = 0;
  let volCount = 0;
  for (let i = 1; i < recent20.length; i++) {
    const prev = recent20[i - 1]!.close;
    const curr = recent20[i]!.close;
    if (prev > 0) {
      volSum += Math.abs(curr / prev - 1);
      volCount++;
    }
  }
  const rawVol = volCount >= 3 ? volSum / volCount : defaultVol;
  const dailyVolatilityPct = Number(Math.min(0.035, Math.max(0.008, rawVol)).toFixed(4));
  const bandWidthPct = Math.max(0.025, dailyVolatilityPct * 2.1);
  const upperBand20d = roundTo(ma20 * (1 + bandWidthPct), decimals);
  const lowerBand20d = roundTo(ma20 * (1 - bandWidthPct), decimals);

  const volPoints = recent20.filter((p) => p.volume !== undefined && Number.isFinite(p.volume) && p.volume > 0);
  const latestPt = recent20.at(-1);
  let volumeRatio20d: number | null = null;
  let volumeSignal = "量能常态";
  if (
    volPoints.length >= 3 &&
    latestPt?.volume !== undefined &&
    Number.isFinite(latestPt.volume) &&
    latestPt.volume > 0
  ) {
    const meanVol = volPoints.reduce((sum, p) => sum + (p.volume ?? 0), 0) / volPoints.length;
    if (meanVol > 0) {
      volumeRatio20d = Number((latestPt.volume / meanVol).toFixed(2));
      if (volumeRatio20d <= 0.78) {
        volumeSignal = `缩量企稳 (${volumeRatio20d.toFixed(2)}x)`;
      } else if (volumeRatio20d >= 1.55) {
        volumeSignal = `放量异动 (${volumeRatio20d.toFixed(2)}x)`;
      } else {
        volumeSignal = `量能温和 (${volumeRatio20d.toFixed(2)}x)`;
      }
    }
  }

  return {
    currentPrice,
    ma10,
    ma20,
    ma20DiffPct,
    high20d,
    low20d,
    high60d,
    low60d,
    prevHigh20d,
    prevLow20d,
    upperBand20d,
    lowerBand20d,
    dailyVolatilityPct,
    volumeRatio20d,
    volumeSignal,
    intradaySource: hasHighLow ? "high-low" : "close",
  };
}

interface RawPointSpec {
  label: string;
  price: number | null;
  shares: number | null;
  retainShares: number;
  netProfit: number | null;
  projectedCost: number | null;
  technicalAnchor: string;
  fundamentalReason: string;
  disabledReason: string | null;
}

function buildGridActionPoints(
  currentPrice: number,
  currentShares: number,
  totalCost: number,
  costDecimals: number,
  buyFixedFee: number,
  points: {
    sell1: RawPointSpec;
    sell2: RawPointSpec;
    buy1: Omit<RawPointSpec, "netProfit" | "projectedCost">;
    buy2: Omit<RawPointSpec, "netProfit" | "projectedCost">;
  },
): ActionPointItem[] {
  const calcBuyProjectedCost = (price: number | null, shares: number | null) =>
    price && shares
      ? Number(
          ((totalCost + price * shares + buyFixedFee) / (currentShares + shares)).toFixed(
            costDecimals,
          ),
        )
      : null;

  const toItem = (
    kind: ActionPointItem["kind"],
    spec: RawPointSpec,
  ): ActionPointItem => ({
    kind,
    label: spec.label,
    triggerPrice: spec.price,
    distancePct: spec.price ? Number((spec.price / currentPrice - 1).toFixed(4)) : null,
    shares: spec.shares,
    retainShares: spec.retainShares,
    cashAmount: spec.price && spec.shares ? round2(spec.price * spec.shares) : null,
    estimatedNetProfit: spec.netProfit,
    projectedDilutedCost: spec.projectedCost,
    technicalAnchor: spec.technicalAnchor,
    fundamentalReason: spec.fundamentalReason,
    disabledReason: spec.disabledReason,
  });

  return [
    toItem("sell1", points.sell1),
    toItem("sell2", points.sell2),
    toItem("buy1", {
      ...points.buy1,
      netProfit: null,
      projectedCost: calcBuyProjectedCost(points.buy1.price, points.buy1.shares),
    }),
    toItem("buy2", {
      ...points.buy2,
      netProfit: null,
      projectedCost: calcBuyProjectedCost(points.buy2.price, points.buy2.shares),
    }),
  ];
}

function syncCurrentLadderRow(
  currentRow: GridLadderRow | undefined,
  decimals: number,
  sell1Price: number | null,
  sell1Shares: number | null,
  sell1Disabled: string | null,
  buy1Price: number | null,
  buy1Shares: number | null,
  buy1Disabled: string | null,
): void {
  if (!currentRow) return;
  currentRow.sellPrice = sell1Price;
  currentRow.sellShares = sell1Shares;
  currentRow.sellLabel =
    sell1Price && sell1Shares
      ? `¥${sell1Price.toFixed(decimals)} 卖 ${sell1Shares.toLocaleString()}股`
      : (sell1Disabled ?? "锁仓持有");
  currentRow.buyPrice = buy1Price;
  currentRow.buyShares = buy1Shares;
  currentRow.buyCash = buy1Price && buy1Shares ? round2(buy1Price * buy1Shares) : null;
  currentRow.buyLabel =
    buy1Price && buy1Shares
      ? `¥${buy1Price.toFixed(decimals)} 买 ${buy1Shares.toLocaleString()}股`
      : (buy1Disabled ?? "暂停买入");
}

export function compute516670PositionPlan(
  etfQuote: (Pick<MarketQuote, "symbol" | "price"> & Partial<MarketQuote>) | undefined,
  totalScore: number,
  cycleScore: number,
  sectorQuotes?: ReadonlyArray<Pick<MarketQuote, "symbol" | "price"> & Partial<MarketQuote>>,
): PositionPlanDetail {
  const config = getStoredStrategyConfig("etf_516670") ?? {};
  const anchorPrice = config.anchorPrice ?? DEFAULT_STRATEGY_CONFIGS.etf_516670.anchorPrice;
  const baseCoreShares = config.baseCoreShares ?? DEFAULT_STRATEGY_CONFIGS.etf_516670.baseCoreShares;

  const rawRows = getEffectiveSnapshots("etf_516670");
  const { snapshots, profitPool, bonusCoreShares, lastBuyPrice } = replayGridSnapshots(
    "etf_516670",
    rawRows,
    anchorPrice,
    baseCoreShares,
  );
  const latestSnapshot = snapshots.at(-1)!;
  const currentShares = latestSnapshot.shares ?? 14400;
  const totalCoreShares = baseCoreShares + bonusCoreShares;
  const currentPrice = etfQuote?.price ?? 0.611;

  const { rows: ladderRows, currentRowIndex, shareAlignmentDiff } = buildLadderRows(
    "etf_516670",
    anchorPrice,
    baseCoreShares,
    bonusCoreShares,
    currentShares,
  );

  const tech = extractTechnicalStats(etfQuote?.series ?? [], currentPrice, 3, 0.012);
  const pigGrain = sectorQuotes?.find((q) => q.symbol === "pig_grain_ratio")?.price;
  const hogSpot = sectorQuotes?.find((q) => q.symbol === "hog_spot")?.price;
  const sowInv = sectorQuotes?.find((q) => q.symbol === "sow_inventory")?.price;
  const muyuanQ = sectorQuotes?.find((q) => q.symbol === "muyuan_002714");
  const wensQ = sectorQuotes?.find((q) => q.symbol === "wens_300498");
  const leadersCh1m =
    muyuanQ?.change1m != null && wensQ?.change1m != null
      ? (muyuanQ.change1m + wensQ.change1m) / 2
      : (muyuanQ?.change1m ?? wensQ?.change1m ?? null);
  const isHighVolDump =
    tech.volumeRatio20d != null &&
    tech.volumeRatio20d >= 1.55 &&
    (etfQuote?.changeYesterday ?? 0) <= -0.015;

  // Cycle state mapping (with 5-day confirmation note & hysteresis buffer)
  let cycleState: CycleRegimeState = "balanced";
  let cycleStateLabel = "平衡震荡";
  let cycleStateTone: PorkStatusTone = "neutral";
  let buyMultiplier = 0.8;
  let coreTargetHint = `${totalCoreShares.toLocaleString()} 股底仓（初始 ${baseCoreShares.toLocaleString()} + 留存 ${bonusCoreShares.toLocaleString()}）`;

  if (cycleScore >= 56 || totalScore >= 72) {
    cycleState = "bottom";
    cycleStateLabel = "深度底部";
    cycleStateTone = "positive";
    buyMultiplier = 1.0;
    coreTargetHint = `${totalCoreShares.toLocaleString()} 股底仓锁仓（回踩均线积极吸筹，大跌反弹卖半留半）`;
  } else if (totalScore >= 58) {
    cycleState = "recovery";
    cycleStateLabel = "修复上行";
    cycleStateTone = "accent";
    buyMultiplier = 1.0;
    coreTargetHint = `${totalCoreShares.toLocaleString()} 股底仓持有（围绕 MA20 与支撑压力位动态高抛低吸）`;
  } else if (totalScore >= 44) {
    cycleState = "balanced";
    cycleStateLabel = "平衡震荡";
    cycleStateTone = "neutral";
    buyMultiplier = 0.8;
    coreTargetHint = `${totalCoreShares.toLocaleString()} 股底仓持有（买点适度后撤至支撑位）`;
  } else if (totalScore >= 30) {
    cycleState = "prosperity";
    cycleStateLabel = "高景气兑现";
    cycleStateTone = "caution";
    buyMultiplier = 0.5;
    coreTargetHint = "底仓逢高分批降至 ~5,000 股（每周最多减 2,500 股，仅在高于摊薄成本的上涨日卖）";
  } else {
    cycleState = "peak";
    cycleStateLabel = "顶部/过剩";
    cycleStateTone = "critical";
    buyMultiplier = 0;
    coreTargetHint = "暂停买入 · 底仓趁上涨分批降至 0～1,500 股（每周最多卖 2,500 股，须高于摊薄成本）";
  }

  const firstCost = snapshots[0]?.dilutedCost ?? 0.5757;
  const latestCost = latestSnapshot.dilutedCost ?? firstCost;
  const totalCost = latestSnapshot.totalCost;
  const costDeltaPct = firstCost > 0 ? Number((latestCost / firstCost - 1).toFixed(4)) : 0;

  // Build data-driven fundamental summary
  const porkDataBits: string[] = [];
  if (pigGrain !== undefined) porkDataBits.push(`猪粮比 ${pigGrain.toFixed(2)}:1`);
  if (hogSpot !== undefined) porkDataBits.push(`生猪现货 ¥${hogSpot.toFixed(2)}/kg`);
  if (sowInv !== undefined) porkDataBits.push(`能繁存栏 ${sowInv}万头`);
  if (leadersCh1m !== null) {
    porkDataBits.push(`牧原/温氏近月 ${leadersCh1m >= 0 ? "+" : ""}${(leadersCh1m * 100).toFixed(1)}%`);
  }
  const porkMetricsText = porkDataBits.length > 0 ? porkDataBits.join("、") : `综合周期评分 ${totalScore}/100`;

  const fundamentalDriveSummary =
    cycleState === "bottom" || cycleState === "recovery"
      ? `${porkMetricsText}（评分 ${totalScore}/100 · ${cycleStateLabel}）：基本面高赔率支撑，第一买点上移锚定 MA20 均线/浅回踩位，第一卖点拉宽至近期压力位惜售防卖飞`
      : cycleState === "balanced"
        ? `${porkMetricsText}（评分 ${totalScore}/100 · ${cycleStateLabel}）：供需拉锯，按近20日高低点支撑压力位标准波段做差价`
        : cycleState === "prosperity"
          ? `${porkMetricsText}（评分 ${totalScore}/100 · ${cycleStateLabel}）：景气兑现期，买点大幅后撤至强支撑防守，反弹及早减仓收现`
          : `${porkMetricsText}（评分 ${totalScore}/100 · 周期顶部）：暂停常规买入，趁上涨日将底仓分批降至 0～1,500 股`;

  const technicalContext: TechnicalDataContext = {
    ...tech,
    fundamentalDriveSummary,
  };

  // Compute dynamic 2-Buy + 2-Sell action points guided by technicals + fundamentals
  const isBullishCycle = totalScore >= 68 || cycleScore >= 56;
  const isWeakCycle = totalScore < 45;

  // Effective support when currentPrice is already at/breaking 20d low
  const isAt20dLow = currentPrice <= tech.low20d * 1.002;
  const effectiveSupport20d = isAt20dLow
    ? Math.min(tech.low60d, tech.lowerBand20d ?? currentPrice * 0.98)
    : tech.low20d;

  // 1) Buy 1 (第一买点 · 常规回踩低吸)
  let buy1Price: number | null = null;
  let buy1Shares: number | null = null;
  let buy1TechAnchor = "";
  let buy1FundReason = "";
  let buy1Disabled: string | null = null;

  if (cycleState === "peak") {
    buy1Disabled = "周期顶部（评分 < 30）暂停常规买入";
    buy1TechAnchor = `现价 ¥${currentPrice.toFixed(3)} / MA20 ¥${tech.ma20.toFixed(3)}`;
    buy1FundReason = `${porkMetricsText}，行业处于高景气顶部区间，只卖不买`;
  } else {
    if (isBullishCycle) {
      // Cap single-step pullback when price rallies > +3.8% above MA20 by stepping up to MA10 / -3.2%
      const isExtendedAboveMa20 = currentPrice > tech.ma20 * 1.038;
      const maPullback = isExtendedAboveMa20
        ? Math.max(tech.ma20, tech.ma10 ?? currentPrice * 0.972, currentPrice * 0.968)
        : currentPrice > tech.ma20 * 1.006
          ? tech.ma20
          : currentPrice * 0.982;
      const dumpDiscount = isHighVolDump ? 0.993 : 1.0;
      const rawBuy1 = Math.min(currentPrice * 0.985, Math.max(effectiveSupport20d, maPullback)) * dumpDiscount;
      const p1 = roundTo(rawBuy1, 3);
      buy1Price = p1;
      buy1Shares = 1000;
      buy1TechAnchor =
        Math.abs(p1 - tech.ma20) <= 0.004
          ? `回踩 MA20 均线支撑 (¥${tech.ma20.toFixed(3)} · ${tech.volumeSignal})`
          : isExtendedAboveMa20 && p1 > tech.ma20 + 0.004
            ? `强势脱离均线，上移锚定 MA10 浅回踩支撑 (¥${(tech.ma10 ?? p1).toFixed(3)} · ${tech.volumeSignal})`
            : `近期回踩支撑位 (MA20 ¥${tech.ma20.toFixed(3)} / 20日盘中低点 ¥${tech.low20d.toFixed(3)} · ${tech.volumeSignal})`;
      buy1FundReason = `${porkMetricsText}（评分 ${totalScore}），底部基本面扎实${isHighVolDump ? "（当日放量回调下移0.7%防急杀）" : "，回踩均线支撑即可低吸接回"}`;
    } else if (!isWeakCycle) {
      const rawBuy1 = Math.min(currentPrice * 0.976, (tech.ma20 + effectiveSupport20d) / 2);
      const p1 = roundTo(rawBuy1, 3);
      buy1Price = p1;
      buy1Shares = 1000;
      buy1TechAnchor = `MA20 (¥${tech.ma20.toFixed(3)}) 与近20日低点 (¥${tech.low20d.toFixed(3)}) 中枢支撑`;
      buy1FundReason = `基本面中性震荡（评分 ${totalScore}），等回调约 ${((p1 / currentPrice - 1) * 100).toFixed(1)}% 至支撑区再接`;
    } else {
      const rawBuy1 = Math.min(currentPrice * 0.962, effectiveSupport20d * 0.995);
      const p1 = roundTo(rawBuy1, 3);
      buy1Price = p1;
      buy1Shares = 800;
      buy1TechAnchor = `退守近20日前低强支撑 (¥${tech.low20d.toFixed(3)})`;
      buy1FundReason = `景气偏高或基本面承压（评分 ${totalScore}），买点后撤防接飞刀，买量缩减`;
    }
  }

  // 2) Buy 2 (第二买点 · 强支撑大跌加码)
  let buy2Price: number | null = null;
  let buy2Shares: number | null = null;
  let buy2Retain = 0;
  let buy2TechAnchor = "";
  let buy2FundReason = "";
  let buy2Disabled: string | null = null;

  if (cycleState === "peak") {
    buy2Disabled = "周期顶部暂停加仓";
    buy2TechAnchor = `近60日低点 ¥${tech.low60d.toFixed(3)}`;
    buy2FundReason = "周期顶部不设深跌抄底";
  } else {
    const refBase = buy1Price ?? currentPrice * 0.97;
    const rawBuy2 = Math.min(refBase * 0.965, tech.low20d * 0.985, tech.low60d * 1.005);
    buy2Price = roundTo(rawBuy2, 3);
    buy2Shares = isBullishCycle ? 3000 : 2000;
    buy2Retain = Math.floor(buy2Shares / 200) * 100;
    buy2TechAnchor = `近20/60日箱体下沿强支撑 (20日低 ¥${tech.low20d.toFixed(3)} / 60日低 ¥${tech.low60d.toFixed(3)})`;
    buy2FundReason = `若受大盘拖累急跌破位至深水支撑，加码 ${buy2Shares.toLocaleString()} 股加速降本；后续反弹卖半留半（+${buy2Retain.toLocaleString()} 股转底仓）`;
  }

  // 3) Sell 1 (第一卖点 · 近期压力位做T降本)
  const minFloorShares = cycleState === "peak" ? 0 : cycleState === "prosperity" ? 5000 : totalCoreShares;
  const sellableShares = Math.max(0, currentShares - minFloorShares);
  const currentRow = ladderRows[currentRowIndex];
  let sell1Price: number | null = null;
  let sell1Shares: number | null = null;
  let sell1NetProfit: number | null = null;
  let sell1ProjectedCost: number | null = null;
  let sell1TechAnchor = "";
  let sell1FundReason = "";
  let sell1Disabled: string | null = null;

  if (sellableShares < 100) {
    sell1Disabled = `当前持仓 ${currentShares.toLocaleString()} 股已达目标底仓下限（${minFloorShares.toLocaleString()} 股），锁仓待涨`;
    sell1TechAnchor = `近20日高点压力 ¥${tech.high20d.toFixed(3)}`;
    sell1FundReason = "仅剩核心底仓，暂不做T卖出";
  } else {
    // Prevent deadlock in deep drawdown: use paired swing basis for excess swing lots instead of locking at global latestCost
    const isDeepDrawdownSwing = currentPrice < latestCost * 0.985 && sellableShares > 1000;
    const pairedSwingBasis = isDeepDrawdownSwing
      ? Math.min(latestCost, lastBuyPrice ?? currentRow?.pairedBuyPrice ?? currentPrice)
      : latestCost;

    // Upgrade resistance anchor if price is already breaking out at/above 20d high
    const isBreakout20d = currentPrice >= tech.high20d * 0.998;
    const effectiveHighAnchor = isBreakout20d
      ? Math.max(tech.high60d ?? tech.high20d * 1.02, tech.upperBand20d ?? currentPrice * 1.02)
      : tech.high20d;

    const minProfitTarget = isDeepDrawdownSwing
      ? Math.max(pairedSwingBasis * 1.025, currentPrice * 1.018)
      : Math.max(latestCost * 1.025, currentPrice * 1.012);

    const rawSell1 = isDeepDrawdownSwing
      ? Math.max(
          minProfitTarget,
          Math.min(tech.ma20, (tech.ma10 ?? currentPrice * 1.025) * 1.005, currentPrice * 1.04),
        )
      : isBullishCycle
        ? Math.max(minProfitTarget, effectiveHighAnchor * 0.998, tech.ma20 * 1.028)
        : Math.max(minProfitTarget, currentPrice * 1.014, tech.ma20 * 1.018);

    const s1 = roundTo(rawSell1, 3);
    const s1Shares = Math.min(sellableShares, cycleState === "peak" ? 2500 : 1000);
    sell1Price = s1;
    sell1Shares = s1Shares;
    const fee1 = round2(s1Shares * s1 * 0.0001);
    sell1NetProfit = Math.max(0, round2((s1 - pairedSwingBasis) * s1Shares - fee1));
    const remShares1 = currentShares - s1Shares;
    sell1ProjectedCost =
      remShares1 > 0
        ? Number(((totalCost - s1Shares * s1 + fee1) / remShares1).toFixed(4))
        : 0;
    sell1TechAnchor = isBreakout20d
      ? `突破20日前高，上移锚定60日压力/波动上轨 ¥${effectiveHighAnchor.toFixed(3)}（较 MA20 +${((s1 / tech.ma20 - 1) * 100).toFixed(1)}%）`
      : isDeepDrawdownSwing
        ? `浮亏区波段反弹压力位 (MA10 ¥${(tech.ma10 ?? tech.ma20).toFixed(3)} / MA20 ¥${tech.ma20.toFixed(3)})`
        : `近20日高点压力位 ¥${tech.high20d.toFixed(3)}（较 MA20 +${((s1 / tech.ma20 - 1) * 100).toFixed(1)}%）`;
    sell1FundReason = isDeepDrawdownSwing
      ? `浮亏区波段配对做T（配对基准 ¥${pairedSwingBasis.toFixed(3)}），反弹至 ¥${s1.toFixed(3)} 卖 ${s1Shares.toLocaleString()} 股净赚约 ¥${sell1NetProfit.toFixed(1)} 入池降本`
      : isBullishCycle
        ? `底部高赔率惜售，等触及前高压力 ¥${s1.toFixed(3)} 再卖 ${s1Shares.toLocaleString()} 股做T，净赚约 ¥${sell1NetProfit.toFixed(1)} 入利润池`
        : `触及波段压力位兑现 ${s1Shares.toLocaleString()} 股，将剩余持仓摊薄成本压低至 ¥${sell1ProjectedCost.toFixed(4)}`;
  }

  // 4) Sell 2 (第二卖点 · 脉冲冲高止盈)
  const remAfterSell1 = Math.max(0, sellableShares - (sell1Shares ?? 0));
  let sell2Price: number | null = null;
  let sell2Shares: number | null = null;
  let sell2NetProfit: number | null = null;
  let sell2ProjectedCost: number | null = null;
  let sell2TechAnchor = "";
  let sell2FundReason = "";
  let sell2Disabled: string | null = null;

  if (remAfterSell1 < 100) {
    sell2Disabled = "第一卖点执行后即达底仓保护线";
    sell2TechAnchor = `MA20 +5% 强阻力区 ¥${(tech.ma20 * 1.05).toFixed(3)}`;
    sell2FundReason = "保留核心底仓吃周期主升浪";
  } else {
    const baseS1 = sell1Price ?? Math.max(currentPrice * 1.015, latestCost * 1.03);
    const rawSell2 = Math.max(baseS1 * 1.022, tech.high20d * 1.018, tech.ma20 * 1.05);
    const s2 = roundTo(rawSell2, 3);
    const s2Shares = Math.min(remAfterSell1, cycleState === "peak" ? 2500 : 1500);
    sell2Price = s2;
    sell2Shares = s2Shares;
    const fee2 = round2(s2Shares * s2 * 0.0001);
    const basis2 = Math.min(latestCost, lastBuyPrice ?? latestCost);
    sell2NetProfit = Math.max(0, round2((s2 - basis2) * s2Shares - fee2));
    const remShares2 = currentShares - (sell1Shares ?? 0) - s2Shares;
    const costAfterS1 = totalCost - (sell1Shares ?? 0) * (sell1Price ?? 0);
    sell2ProjectedCost =
      remShares2 > 0
        ? Number(((costAfterS1 - s2Shares * s2 + fee2) / remShares2).toFixed(4))
        : 0;
    sell2TechAnchor = `波段突破强阻力位 / MA20 正乖离 +${((s2 / tech.ma20 - 1) * 100).toFixed(1)}%`;
    sell2FundReason = `情绪脉冲急涨超买时再减 ${s2Shares.toLocaleString()} 股浮仓，落袋净利约 ¥${sell2NetProfit.toFixed(1)}，等回踩均线接回`;
  }

  const actionPoints = buildGridActionPoints(currentPrice, currentShares, totalCost, 4, 0, {
    sell1: {
      label: "第一卖点 · 近期压力做T",
      price: sell1Price,
      shares: sell1Shares,
      retainShares: 0,
      netProfit: sell1NetProfit,
      projectedCost: sell1ProjectedCost,
      technicalAnchor: sell1TechAnchor,
      fundamentalReason: sell1FundReason,
      disabledReason: sell1Disabled,
    },
    sell2: {
      label: "第二卖点 · 脉冲冲高止盈",
      price: sell2Price,
      shares: sell2Shares,
      retainShares: 0,
      netProfit: sell2NetProfit,
      projectedCost: sell2ProjectedCost,
      technicalAnchor: sell2TechAnchor,
      fundamentalReason: sell2FundReason,
      disabledReason: sell2Disabled,
    },
    buy1: {
      label: "第一买点 · 回踩支撑低吸",
      price: buy1Price,
      shares: buy1Shares,
      retainShares: 0,
      technicalAnchor: buy1TechAnchor,
      fundamentalReason: buy1FundReason,
      disabledReason: buy1Disabled,
    },
    buy2: {
      label: "第二买点 · 强支撑大跌加码",
      price: buy2Price,
      shares: buy2Shares,
      retainShares: buy2Retain,
      technicalAnchor: buy2TechAnchor,
      fundamentalReason: buy2FundReason,
      disabledReason: buy2Disabled,
    },
  });

  syncCurrentLadderRow(
    currentRow,
    3,
    sell1Price,
    sell1Shares,
    sell1Disabled,
    buy1Price,
    buy1Shares,
    buy1Disabled,
  );

  const nextBuyPrice = buy1Price ?? currentPrice;
  const lotCost100 = Number((nextBuyPrice * 100).toFixed(2));
  const profitBonusReadyShares =
    nextBuyPrice > 0 ? Math.floor(profitPool / (nextBuyPrice * 100)) * 100 : 0;

  const costCurve = buildCostCurve(
    etfQuote?.series ?? [],
    snapshots,
    currentPrice,
    latestCost,
  );

  const crashCircuitBreaker = detectCrashCircuitBreaker(
    etfQuote,
    buy1Price,
    currentPrice < tech.low20d ? "crash" : "normal",
    3,
  );

  return {
    symbol: "etf_516670",
    mode: "grid",
    cycleState,
    cycleStateLabel,
    cycleStateTone,
    buyMultiplier,
    cycleConfirmNote: "由实时行情（MA20/近20日高低点）+ 生猪基本面评分动态驱动当下 2买2卖",
    latestSnapshot,
    snapshots: [...snapshots].reverse(),
    costCurve,
    costDeltaPct,
    profitPool,
    profitBonusReadyShares,
    lotCost100,
    baseCoreShares,
    bonusCoreShares,
    totalCoreShares,
    coreTargetHint,
    anchorPrice: tech.ma20,
    spacingHint: `MA20 ¥${tech.ma20.toFixed(3)} · 近20日区间 ¥${tech.low20d.toFixed(3)}～¥${tech.high20d.toFixed(3)} · 大跌买点反弹卖半留半`,
    currentRowIndex,
    shareAlignmentDiff,
    ladderRows,
    actionPoints,
    technicalContext,
    crashCircuitBreaker,
    reanchorAlert: null,
    dcaPlan: null,
  };
}

export function compute600115PositionPlan(
  ceaQuote: (Pick<MarketQuote, "symbol" | "price"> & Partial<MarketQuote>) | undefined,
  totalScore: number,
  sectorQuotes?: ReadonlyArray<Pick<MarketQuote, "symbol" | "price"> & Partial<MarketQuote>>,
): PositionPlanDetail {
  const config = getStoredStrategyConfig("cea_600115") ?? {};
  const anchorPrice = config.anchorPrice ?? DEFAULT_STRATEGY_CONFIGS.cea_600115.anchorPrice;
  const baseCoreShares = config.baseCoreShares ?? DEFAULT_STRATEGY_CONFIGS.cea_600115.baseCoreShares;

  const rawRows = getEffectiveSnapshots("cea_600115");
  const { snapshots, profitPool, bonusCoreShares, lastBuyPrice } = replayGridSnapshots(
    "cea_600115",
    rawRows,
    anchorPrice,
    baseCoreShares,
  );
  const latestSnapshot = snapshots.at(-1)!;
  const currentShares = latestSnapshot.shares ?? 3000;
  const totalCoreShares = baseCoreShares + bonusCoreShares;
  const currentPrice = ceaQuote?.price ?? 3.56;

  const { rows: ladderRows, currentRowIndex, shareAlignmentDiff } = buildLadderRows(
    "cea_600115",
    anchorPrice,
    baseCoreShares,
    bonusCoreShares,
    currentShares,
  );

  const tech = extractTechnicalStats(ceaQuote?.series ?? [], currentPrice, 2, 0.016);
  const crudeQuote = sectorQuotes?.find((q) => q.symbol === "ine_crude");
  const fxQuote = sectorQuotes?.find((q) => q.symbol === "fx_usdcny");
  const hkQuote = sectorQuotes?.find((q) => q.symbol === "cea_hk00670");
  const loadFactor = sectorQuotes?.find((q) => q.symbol === "caac_load_factor")?.price;

  const hkdCny = (fxQuote?.price ?? 6.85) / 7.8;
  const hkCnyPrice = hkQuote?.price ? hkQuote.price * hkdCny : null;
  const ahRatio = hkCnyPrice && hkCnyPrice > 0 ? Number((currentPrice / hkCnyPrice).toFixed(2)) : null;

  const crudeChg1m = crudeQuote?.change1m ?? 0;
  const fxChg1m = fxQuote?.change1m ?? 0;
  const isOilFxHeadwind = crudeChg1m >= 0.04 || fxChg1m >= 0.01 || totalScore < 48;
  const isOilFxTailwind = !isOilFxHeadwind && (crudeChg1m <= -0.02 || totalScore >= 64);

  let cycleState: CycleRegimeState = "balanced";
  let cycleStateLabel = "平衡震荡";
  let cycleStateTone: PorkStatusTone = "neutral";
  let buyMultiplier = 1.0;
  const maxCapShares = 7600 + bonusCoreShares;
  let coreTargetHint = `${totalCoreShares.toLocaleString()} 股底仓（每次固定 400 股，最高买至 ${maxCapShares.toLocaleString()} 股封顶）`;

  if (totalScore >= 64 && !isOilFxHeadwind) {
    cycleState = "recovery";
    cycleStateLabel = "景气顺风";
    cycleStateTone = "positive";
    buyMultiplier = 1.0;
    coreTargetHint = `${totalCoreShares.toLocaleString()} 股底仓持有（油汇顺风，回踩均线支撑买 400 股，前高压力卖 400 股）`;
  } else if (totalScore >= 48 && !isOilFxHeadwind) {
    cycleState = "balanced";
    cycleStateLabel = "平衡震荡";
    cycleStateTone = "neutral";
    buyMultiplier = 1.0;
    coreTargetHint = `${totalCoreShares.toLocaleString()} 股底仓持有（围绕近期高低点与 MA20 做 400 股波段降本）`;
  } else {
    cycleState = "peak";
    cycleStateLabel = "油汇逆风";
    cycleStateTone = "caution";
    buyMultiplier = 0.8;
    coreTargetHint = "油汇成本承压 · 买点大幅后撤至近20日/60日前低强支撑位防守，反弹优先减仓收现";
  }

  const firstCost = snapshots[0]?.dilutedCost ?? 3.335;
  const latestCost = latestSnapshot.dilutedCost ?? firstCost;
  const totalCost = latestSnapshot.totalCost;
  const costDeltaPct = firstCost > 0 ? Number((latestCost / firstCost - 1).toFixed(4)) : 0;

  const avDataBits: string[] = [];
  if (crudeQuote?.price !== undefined) {
    avDataBits.push(`上期原油 ¥${crudeQuote.price.toFixed(1)}（月${crudeChg1m >= 0 ? "+" : ""}${(crudeChg1m * 100).toFixed(1)}%）`);
  }
  if (fxQuote?.price !== undefined) {
    avDataBits.push(`USD/CNY ${fxQuote.price.toFixed(4)}`);
  }
  if (loadFactor !== undefined) {
    avDataBits.push(`客座率 ${loadFactor.toFixed(1)}%`);
  }
  if (ahRatio !== null) {
    avDataBits.push(`东航A/H比价 ${ahRatio.toFixed(2)}x`);
  }
  const avMetricsText = avDataBits.length > 0 ? avDataBits.join("、") : `航空综合评分 ${totalScore}/100`;

  const fundamentalDriveSummary = isOilFxHeadwind
    ? `${avMetricsText}（评分 ${totalScore}/100 · 油汇逆风）：航司成本承压，第一买点跳过浅层均线直接后撤至前低强支撑，且严守来回 11 元无免五佣金门槛`
    : isOilFxTailwind
      ? `${avMetricsText}（评分 ${totalScore}/100 · 景气顺风）：油汇利好航司利润修复，回踩 MA20 与近期支撑即可接筹 400 股，前高压力区兑现差价`
      : `${avMetricsText}（评分 ${totalScore}/100 · 平衡震荡）：按无免五 400 股标准步长，在近期支撑与压力位间赚取 ≥¥0.16/股净差价`;

  const technicalContext: TechnicalDataContext = {
    ...tech,
    fundamentalDriveSummary,
  };

  const isAt20dLow = currentPrice <= tech.low20d * 1.002;
  const effectiveSupport20d = isAt20dLow
    ? Math.min(tech.low60d, tech.lowerBand20d ?? currentPrice * 0.96)
    : tech.low20d;

  // Compute dynamic 2-Buy + 2-Sell points for 600115 (with no-fee-waiver ~11 RMB guardrail)
  // 1) Buy 1
  let buy1Price: number | null = null;
  let buy1Shares: number | null = null;
  let buy1TechAnchor = "";
  let buy1FundReason = "";
  let buy1Disabled: string | null = null;

  if (currentShares >= maxCapShares) {
    buy1Disabled = `当前持仓 ${currentShares.toLocaleString()} 股已达封顶上限（${maxCapShares.toLocaleString()} 股），暂停加仓`;
    buy1TechAnchor = `近20日低点 ¥${tech.low20d.toFixed(2)}`;
    buy1FundReason = "遵守东航不重仓原则，等待反弹高抛后再接";
  } else {
    if (isOilFxTailwind) {
      const isExtendedAboveMa20 = currentPrice > tech.ma20 * 1.05;
      const maSupport = isExtendedAboveMa20
        ? Math.max(tech.ma20, tech.ma10 ?? currentPrice * 0.96, currentPrice * 0.955)
        : currentPrice > tech.ma20 * 1.02
          ? tech.ma20
          : currentPrice * 0.955;
      const rawBuy1 = Math.min(currentPrice * 0.96, Math.max(effectiveSupport20d, maSupport));
      const p1 = roundTo(rawBuy1, 2);
      buy1Price = p1;
      buy1Shares = 400;
      buy1TechAnchor = `回踩 MA20 均线 (¥${tech.ma20.toFixed(2)}) 与近期支撑区`;
      buy1FundReason = `${avMetricsText}，油汇顺风支撑估值，回踩约 ${((p1 / currentPrice - 1) * 100).toFixed(1)}% 买 400 股（拉开无免五安全价差）`;
    } else if (!isOilFxHeadwind) {
      const rawBuy1 = Math.min(currentPrice * 0.952, (tech.ma20 + effectiveSupport20d) / 2);
      const p1 = roundTo(rawBuy1, 2);
      buy1Price = p1;
      buy1Shares = 400;
      buy1TechAnchor = `MA20 (¥${tech.ma20.toFixed(2)}) 下方与近20日低点 (¥${tech.low20d.toFixed(2)}) 支撑位`;
      buy1FundReason = `无免五要求拉开约 5% 间距覆盖 11 元佣金印花税，回调至 ¥${p1.toFixed(2)} 买入 400 股`;
    } else {
      const rawBuy1 = Math.min(currentPrice * 0.938, effectiveSupport20d * 0.99);
      const p1 = roundTo(rawBuy1, 2);
      buy1Price = p1;
      buy1Shares = 400;
      buy1TechAnchor = `退守近20日前低强支撑位 (¥${tech.low20d.toFixed(2)})`;
      buy1FundReason = `${avMetricsText}，油汇逆风承压，买点自动下撤防接飞刀`;
    }
  }

  // 2) Buy 2 (Strong crash support)
  let buy2Price: number | null = null;
  let buy2Shares: number | null = null;
  let buy2Retain = 0;
  let buy2TechAnchor = "";
  let buy2FundReason = "";
  let buy2Disabled: string | null = null;

  if (currentShares + (buy1Shares ?? 0) >= maxCapShares) {
    buy2Disabled = "触发第一买点后即达总股数上限";
    buy2TechAnchor = `近60日低点 ¥${tech.low60d.toFixed(2)}`;
    buy2FundReason = "控制单一航司仓位上限";
  } else {
    const refBase = buy1Price ?? currentPrice * 0.95;
    const rawBuy2 = Math.min(refBase * 0.935, tech.low60d * 0.995);
    buy2Price = roundTo(rawBuy2, 2);
    buy2Shares = Math.min(800, maxCapShares - currentShares - (buy1Shares ?? 0));
    buy2Retain = Math.floor(buy2Shares / 200) * 100;
    buy2TechAnchor = `近60日波段前低强支撑 (¥${tech.low60d.toFixed(2)})`;
    buy2FundReason = `极端深跌破位时买入 ${buy2Shares} 股摊薄成本；后续反弹卖 ${buy2Shares - buy2Retain} 股赚差价、留 ${buy2Retain} 股转底仓`;
  }

  // 3) Sell 1 (Must cover 11 RMB fee + reasonable net profit above dilutedCost or pairedSwingBasis)
  const minFloorShares = isOilFxHeadwind ? 1400 : totalCoreShares;
  const sellableShares = Math.max(0, currentShares - minFloorShares);
  const currentRow = ladderRows[currentRowIndex];
  let sell1Price: number | null = null;
  let sell1Shares: number | null = null;
  let sell1NetProfit: number | null = null;
  let sell1ProjectedCost: number | null = null;
  let sell1TechAnchor = "";
  let sell1FundReason = "";
  let sell1Disabled: string | null = null;

  if (sellableShares < 100) {
    sell1Disabled = `当前持仓 ${currentShares.toLocaleString()} 股已达底仓保护线（${minFloorShares.toLocaleString()} 股），锁仓待涨`;
    sell1TechAnchor = `近20日高点压力 ¥${tech.high20d.toFixed(2)}`;
    sell1FundReason = "保留底仓等待航司周期弹性";
  } else {
    const isDeepDrawdownSwing = currentPrice < latestCost * 0.98 && sellableShares > 400;
    const pairedSwingBasis = isDeepDrawdownSwing
      ? Math.min(latestCost, lastBuyPrice ?? currentRow?.pairedBuyPrice ?? currentPrice)
      : latestCost;

    const isBreakout20d = currentPrice >= tech.high20d * 0.998;
    const effectiveHighAnchor = isBreakout20d
      ? Math.max(tech.high60d ?? tech.high20d * 1.03, tech.upperBand20d ?? currentPrice * 1.03)
      : tech.high20d;

    // 400 shares needs >= 0.16 RMB above basis to clear 11 RMB fee + ~53 RMB net profit
    const minFeeSafePrice = Math.max(pairedSwingBasis + 0.18, currentPrice * 1.022);
    const rawSell1 = isDeepDrawdownSwing
      ? Math.max(minFeeSafePrice, Math.min(tech.ma20, currentPrice * 1.045))
      : isOilFxTailwind
        ? Math.max(minFeeSafePrice, effectiveHighAnchor * 1.005, tech.ma20 * 1.045)
        : Math.max(minFeeSafePrice, effectiveHighAnchor * 0.995, currentPrice * 1.025);
    const s1 = roundTo(rawSell1, 2);
    const s1Shares = Math.min(400, sellableShares);
    sell1Price = s1;
    sell1Shares = s1Shares;
    const fee1 = round2(10 + s1Shares * s1 * 0.0005);
    sell1NetProfit = Math.max(0, round2((s1 - pairedSwingBasis) * s1Shares - fee1));
    const remShares1 = currentShares - s1Shares;
    sell1ProjectedCost =
      remShares1 > 0
        ? Number(((totalCost - s1Shares * s1 + fee1) / remShares1).toFixed(3))
        : 0;
    sell1TechAnchor = isBreakout20d
      ? `突破20日前高，上移锚定60日压力/波动上轨 ¥${effectiveHighAnchor.toFixed(2)}（较 MA20 +${((s1 / tech.ma20 - 1) * 100).toFixed(1)}%）`
      : isDeepDrawdownSwing
        ? `浮亏区波段反弹压力位 (MA10 ¥${(tech.ma10 ?? tech.ma20).toFixed(2)} / MA20 ¥${tech.ma20.toFixed(2)})`
        : `近20日高点压力位 ¥${tech.high20d.toFixed(2)}（较 MA20 +${((s1 / tech.ma20 - 1) * 100).toFixed(1)}%）`;
    sell1FundReason = isDeepDrawdownSwing
      ? `浮亏区波段配对做T（配对基准 ¥${pairedSwingBasis.toFixed(2)}），卖出 ${s1Shares} 股扣除无免五佣金印花税后净赚约 ¥${sell1NetProfit.toFixed(0)} 入池降本`
      : `卖出 ${s1Shares} 股扣除约 ¥${fee1.toFixed(1)} 佣金印花税后净赚约 ¥${sell1NetProfit.toFixed(0)} 入池，剩余 ${remShares1.toLocaleString()} 股成本降至 ¥${sell1ProjectedCost.toFixed(3)}`;
  }

  // 4) Sell 2
  const remAfterSell1 = Math.max(0, sellableShares - (sell1Shares ?? 0));
  let sell2Price: number | null = null;
  let sell2Shares: number | null = null;
  let sell2NetProfit: number | null = null;
  let sell2ProjectedCost: number | null = null;
  let sell2TechAnchor = "";
  let sell2FundReason = "";
  let sell2Disabled: string | null = null;

  if (remAfterSell1 < 100) {
    sell2Disabled = "第一卖点执行后即达底仓保护线";
    sell2TechAnchor = `波段强阻力位 ¥${((sell1Price ?? currentPrice) * 1.045).toFixed(2)}`;
    sell2FundReason = "保留 2,200 股核心底仓";
  } else {
    const baseS1 = sell1Price ?? Math.max(currentPrice * 1.03, latestCost + 0.2);
    const rawSell2 = Math.max(baseS1 * 1.042, tech.high20d * 1.035, tech.ma20 * 1.07);
    const s2 = roundTo(rawSell2, 2);
    const s2Shares = Math.min(400, remAfterSell1);
    sell2Price = s2;
    sell2Shares = s2Shares;
    const fee2 = round2(10 + s2Shares * s2 * 0.0005);
    const basis2 = Math.min(latestCost, lastBuyPrice ?? latestCost);
    sell2NetProfit = Math.max(0, round2((s2 - basis2) * s2Shares - fee2));
    const remShares2 = currentShares - (sell1Shares ?? 0) - s2Shares;
    const costAfterS1 = totalCost - (sell1Shares ?? 0) * (sell1Price ?? 0);
    sell2ProjectedCost =
      remShares2 > 0
        ? Number(((costAfterS1 - s2Shares * s2 + fee2) / remShares2).toFixed(3))
        : 0;
    sell2TechAnchor = `波段突破强阻力位（较 MA20 +${((s2 / tech.ma20 - 1) * 100).toFixed(1)}%）`;
    sell2FundReason = `脉冲大涨再兑现 ${s2Shares} 股机动仓，扣除无免五费用后净赚约 ¥${sell2NetProfit.toFixed(0)}，摊薄成本降至 ¥${sell2ProjectedCost.toFixed(3)}`;
  }

  const actionPoints = buildGridActionPoints(currentPrice, currentShares, totalCost, 3, 5, {
    sell1: {
      label: "第一卖点 · 近期压力做T",
      price: sell1Price,
      shares: sell1Shares,
      retainShares: 0,
      netProfit: sell1NetProfit,
      projectedCost: sell1ProjectedCost,
      technicalAnchor: sell1TechAnchor,
      fundamentalReason: sell1FundReason,
      disabledReason: sell1Disabled,
    },
    sell2: {
      label: "第二卖点 · 波段阻力止盈",
      price: sell2Price,
      shares: sell2Shares,
      retainShares: 0,
      netProfit: sell2NetProfit,
      projectedCost: sell2ProjectedCost,
      technicalAnchor: sell2TechAnchor,
      fundamentalReason: sell2FundReason,
      disabledReason: sell2Disabled,
    },
    buy1: {
      label: "第一买点 · 油汇联动支撑",
      price: buy1Price,
      shares: buy1Shares,
      retainShares: 0,
      technicalAnchor: buy1TechAnchor,
      fundamentalReason: buy1FundReason,
      disabledReason: buy1Disabled,
    },
    buy2: {
      label: "第二买点 · 前低深跌加码",
      price: buy2Price,
      shares: buy2Shares,
      retainShares: buy2Retain,
      technicalAnchor: buy2TechAnchor,
      fundamentalReason: buy2FundReason,
      disabledReason: buy2Disabled,
    },
  });

  syncCurrentLadderRow(
    currentRow,
    2,
    sell1Price,
    sell1Shares,
    sell1Disabled,
    buy1Price,
    buy1Shares,
    buy1Disabled,
  );

  const nextBuyPrice = buy1Price ?? currentPrice;
  const lotCost100 = Number((nextBuyPrice * 100).toFixed(2));
  const profitBonusReadyShares =
    nextBuyPrice > 0 ? Math.floor(profitPool / (nextBuyPrice * 100)) * 100 : 0;

  const costCurve = buildCostCurve(
    ceaQuote?.series ?? [],
    snapshots,
    currentPrice,
    latestCost,
  );

  const crashCircuitBreaker = detectCrashCircuitBreaker(
    ceaQuote,
    buy1Price,
    currentPrice < tech.low20d ? "crash" : "normal",
    2,
  );

  return {
    symbol: "cea_600115",
    mode: "grid",
    cycleState,
    cycleStateLabel,
    cycleStateTone,
    buyMultiplier,
    cycleConfirmNote: "无免五（来回约11元佣金印花税），由油价/汇率实时数据 + 近20日高低点动态驱动当下 2买2卖",
    latestSnapshot,
    snapshots: [...snapshots].reverse(),
    costCurve,
    costDeltaPct,
    profitPool,
    profitBonusReadyShares,
    lotCost100,
    baseCoreShares,
    bonusCoreShares,
    totalCoreShares,
    coreTargetHint,
    anchorPrice: tech.ma20,
    spacingHint: `MA20 ¥${tech.ma20.toFixed(2)} · 近20日区间 ¥${tech.low20d.toFixed(2)}～¥${tech.high20d.toFixed(2)} · 单笔 ≥400股覆盖无免五成本`,
    currentRowIndex,
    shareAlignmentDiff,
    ladderRows,
    actionPoints,
    technicalContext,
    crashCircuitBreaker,
    reanchorAlert: null,
    dcaPlan: null,
  };
}

export function compute513180PositionPlan(
  etfQuote: (Pick<MarketQuote, "symbol" | "price"> & Partial<MarketQuote>) | undefined,
  totalScore: number,
  sectorQuotes?: ReadonlyArray<Pick<MarketQuote, "symbol" | "price"> & Partial<MarketQuote>>,
): PositionPlanDetail {
  const config = getStoredStrategyConfig("etf_513180") ?? {};
  const periods = config.dcaPeriods ?? DEFAULT_STRATEGY_CONFIGS.etf_513180.dcaPeriods;
  const baseDailyAmount = config.dcaBaseDaily ?? DEFAULT_STRATEGY_CONFIGS.etf_513180.dcaBaseDaily;

  const rawRows = getEffectiveSnapshots("etf_513180");
  const currentPrice = etfQuote?.price ?? 0.51;
  const tech = extractTechnicalStats(etfQuote?.series ?? [], currentPrice, 3, 0.018);

  let profitPool = 0;
  const snapshots: PositionSnapshotItem[] = rawRows.map((r, idx) => {
    const totalCost = round2(r.market_value - r.unrealized_pnl);
    const dev = totalCost > 0 ? r.unrealized_pnl / totalCost : 0;
    const eqCost = dev > -0.95 ? Number((currentPrice / (1 + dev)).toFixed(3)) : 0.586;

    let inferredTrade = r.note ?? "初始场外定投基准";
    if (idx > 0) {
      const prev = rawRows[idx - 1]!;
      const prevCost = round2(prev.market_value - prev.unrealized_pnl);
      const deltaCost = round2(totalCost - prevCost);
      if (deltaCost > 0) {
        inferredTrade = `定投/加仓累计新投入 +¥${deltaCost.toFixed(2)}`;
      } else if (deltaCost < 0) {
        const redeemed = Math.abs(deltaCost);
        profitPool = round2(profitPool + redeemed);
        inferredTrade = `高位止盈赎回 ¥${redeemed.toFixed(2)}（已转入大跌加码池）`;
      } else {
        inferredTrade = "场外持仓市值与盈亏周度校准";
      }
    }

    return {
      id: r.id,
      symbol: "etf_513180",
      day: r.day,
      shares: null,
      marketValue: r.market_value,
      unrealizedPnl: r.unrealized_pnl,
      totalCost,
      dilutedCost: eqCost,
      inferredTrade,
      note: r.note,
      createdAt: r.created_at,
    };
  });

  const latestSnapshot = snapshots.at(-1)!;
  const deviationPct =
    latestSnapshot.totalCost > 0
      ? Number((latestSnapshot.unrealizedPnl / latestSnapshot.totalCost).toFixed(4))
      : -0.13;

  const rawTiers: Array<Omit<DcaTierRow, "isCurrent">> = [
    { label: "≤ -30%", minDeviation: null, maxDeviation: -0.3, dailyAmount: 300, note: "极端深跌区 · 3倍定投加速摊薄" },
    { label: "-30% ～ -20%", minDeviation: -0.3, maxDeviation: -0.2, dailyAmount: 200, note: "大跌区 · 2倍定投收集筹码" },
    { label: "-20% ～ -10%", minDeviation: -0.2, maxDeviation: -0.1, dailyAmount: 120, note: "小幅多买 · 温和压低均价" },
    { label: "-10% ～ +10%", minDeviation: -0.1, maxDeviation: 0.1, dailyAmount: 100, note: "成本平衡区 · 维持原定投额" },
    { label: "+10% ～ +25%", minDeviation: 0.1, maxDeviation: 0.25, dailyAmount: 70, note: "盈利区 · 放缓定投节奏" },
    { label: "> +25%", minDeviation: 0.25, maxDeviation: null, dailyAmount: 50, note: "高盈利区 · 定投减半并启动分批止盈" },
  ];

  let activeTierIdx = 3;
  if (deviationPct <= -0.3) activeTierIdx = 0;
  else if (deviationPct <= -0.2) activeTierIdx = 1;
  else if (deviationPct <= -0.1) activeTierIdx = 2;
  else if (deviationPct <= 0.1) activeTierIdx = 3;
  else if (deviationPct <= 0.25) activeTierIdx = 4;
  else activeTierIdx = 5;

  const tiers: DcaTierRow[] = rawTiers.map((t, idx) => ({
    ...t,
    isCurrent: idx === activeTierIdx,
  }));

  const baseTierAmount = tiers[activeTierIdx]!.dailyAmount;

  // Dynamic market & fundamental adjustment on top of floating PnL tier
  const hsIdxQuote = sectorQuotes?.find((q) => q.symbol === "hstech_index");
  const kuaishouQuote = sectorQuotes?.find((q) => q.symbol === "hk_01024");
  const hsIdxText = hsIdxQuote?.price ? `恒科指数 ${hsIdxQuote.price.toFixed(0)}点` : `板块评分 ${totalScore}/100`;
  const ksText =
    kuaishouQuote?.change1w != null
      ? ` · 快手周${kuaishouQuote.change1w >= 0 ? "+" : ""}${(kuaishouQuote.change1w * 100).toFixed(1)}%`
      : "";

  let recommendedDailyAmount = baseTierAmount;
  let dataAdjustmentNote = `浮亏 ${(deviationPct * 100).toFixed(1)}% 对应基础档 ¥${baseTierAmount}/天；当前现价较 MA20 (¥${tech.ma20.toFixed(3)}) 偏离 ${(tech.ma20DiffPct * 100).toFixed(1)}%（${tech.volumeSignal}${ksText}），维持 ¥${baseTierAmount}/天`;

  if (totalScore >= 68 && tech.ma20DiffPct <= -0.015) {
    recommendedDailyAmount = baseTierAmount + 20;
    dataAdjustmentNote = `浮亏基础档 ¥${baseTierAmount}/天 + 实时数据加码 ¥20/天（${hsIdxText} 低估评分 ${totalScore}，现价低于 MA20 达 ${(tech.ma20DiffPct * 100).toFixed(1)}% · ${tech.volumeSignal}，趁均线下折价多拿份额）`;
  } else if (tech.ma20DiffPct >= 0.04 || totalScore < 45) {
    recommendedDailyAmount = Math.max(50, baseTierAmount - 20);
    dataAdjustmentNote = `浮亏基础档 ¥${baseTierAmount}/天 - 短线防追高调减 ¥20/天（现价高于 MA20 达 +${(tech.ma20DiffPct * 100).toFixed(1)}% · ${tech.volumeSignal}，短线脉冲偏热，回退至 ¥${recommendedDailyAmount}/天避免高位多投）`;
  }

  // Dynamic lump-sum crash triggers driven by live 20d/60d support & weekly drop
  const ch1w = etfQuote?.change1w ?? hsIdxQuote?.change1w ?? 0;
  const support1 = roundTo(Math.min(tech.low20d * 0.99, tech.ma20 * 0.955), 3);
  const support2 = roundTo(Math.min(tech.low60d * 0.99, support1 * 0.96), 3);
  const triggerLevels = [support1, support2];
  const isWeeklyCrash = ch1w <= -0.06;
  const isAtStrongSupport = currentPrice <= support1 && totalScore >= 50;
  const lumpTriggered = isWeeklyCrash || isAtStrongSupport;
  const lumpReason = isWeeklyCrash
    ? `近一周急跌 ${(ch1w * 100).toFixed(2)}%（超 -6% 阈值），触发单笔 ¥1,000 场外手动加仓`
    : isAtStrongSupport
      ? `513180 现价 ¥${currentPrice.toFixed(3)} 回落至近20日/MA20强支撑位 ¥${support1.toFixed(3)} 且估值高赔率（评分 ${totalScore}），触发单笔 ¥1,000 手动加仓`
      : `未触发（需单周急跌 ≥6% 或回踩近期强支撑位 ¥${support1.toFixed(3)} / ¥${support2.toFixed(3)}；现价 ¥${currentPrice.toFixed(3)}）`;

  let cycleState: CycleRegimeState = "recovery";
  let cycleStateLabel = "低估修复";
  let cycleStateTone: PorkStatusTone = "positive";
  if (totalScore >= 68) {
    cycleState = "bottom";
    cycleStateLabel = "低估高赔率";
    cycleStateTone = "positive";
  } else if (totalScore >= 50) {
    cycleState = "balanced";
    cycleStateLabel = "中枢震荡";
    cycleStateTone = "neutral";
  } else {
    cycleState = "prosperity";
    cycleStateLabel = "偏高减速";
    cycleStateTone = "caution";
  }

  const firstCost = snapshots[0]?.dilutedCost ?? 0.586;
  const latestCost = latestSnapshot.dilutedCost ?? firstCost;
  const costDeltaPct = firstCost > 0 ? Number((latestCost / firstCost - 1).toFixed(4)) : 0;

  const costCurve = buildCostCurve(
    etfQuote?.series ?? [],
    snapshots,
    currentPrice,
    latestCost,
  );

  const technicalContext: TechnicalDataContext = {
    ...tech,
    fundamentalDriveSummary: dataAdjustmentNote,
  };

  return {
    symbol: "etf_513180",
    mode: "dca",
    cycleState,
    cycleStateLabel,
    cycleStateTone,
    buyMultiplier: Number((recommendedDailyAmount / baseDailyAmount).toFixed(2)),
    cycleConfirmNote: "由持仓浮亏档位 × 恒科实时估值与 MA20 乖离率共同决定本周每日定投额",
    latestSnapshot,
    snapshots: [...snapshots].reverse(),
    costCurve,
    costDeltaPct,
    profitPool,
    profitBonusReadyShares: 0,
    lotCost100: 1000,
    baseCoreShares: 0,
    bonusCoreShares: 0,
    totalCoreShares: 0,
    coreTargetHint: `已定投 ${periods + Math.max(0, snapshots.length - 1)} 期 · 累计投入 ¥${latestSnapshot.totalCost.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
    anchorPrice: tech.ma20,
    spacingHint: `智能定投建议 ¥${recommendedDailyAmount}/天（基础档 ¥${baseTierAmount}）· 强支撑加仓线 ¥${support1.toFixed(3)}`,
    currentRowIndex: activeTierIdx,
    shareAlignmentDiff: 0,
    ladderRows: undefined,
    actionPoints: undefined,
    technicalContext,
    crashCircuitBreaker: null,
    reanchorAlert: null,
    dcaPlan: {
      deviationPct,
      baseDailyAmount,
      baseTierAmount,
      recommendedDailyAmount,
      dataAdjustmentNote,
      periods: periods + Math.max(0, snapshots.length - 1),
      antiJitterNote: "档位最多每周调整一次，结合 MA20 乖离率防高位多投、低位漏投",
      tiers,
      lumpSumAlert: {
        triggered: lumpTriggered,
        amount: 1000,
        triggerLevels,
        reason: lumpReason,
      },
    },
  };
}
