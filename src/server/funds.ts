import { guardedFetch, requireOk } from "./lib/http-fetch.ts";
import { chatJson, loadChannels } from "./lib/llm.ts";
import { z } from "zod";
import { addDays, beijingDate, beijingTime } from "../shared/time.ts";
import {
  getLlmCallsSince,
  getRecentCloses,
  getStoredJson,
  setStoredJson,
  upsertCloses,
} from "./db.ts";
import { extractTechnicalStats } from "./position.ts";
import { fetchTencentBatchQuotes } from "./intraday.ts";
import {
  buildWeeklyTrendSeries,
  EASTMONEY_KLINE_URL,
  parseKlines,
  TENCENT_KLINE_URL,
} from "./quotes.ts";
import type {
  MarketTrendPoint,
  PorkStatusTone,
  PotentialFundItem,
  PotentialFundsOverview,
  PotentialFundTier,
  PotentialFundTrack,
  PotentialFundWatchItem,
} from "../shared/types.ts";

export const DEFAULT_POTENTIAL_FUNDS: readonly PotentialFundWatchItem[] = [
  {
    code: "512170",
    fullCode: "sh512170",
    name: "医疗ETF",
    sectorTag: "医药医疗",
    thesis: "逆周期属性突出的医药医疗与器械龙头配置标的",
    isBuiltin: true,
  },
  {
    code: "515790",
    fullCode: "sh515790",
    name: "光伏ETF",
    sectorTag: "新能源光伏",
    thesis: "硅料组件产能出清周期、困境反转高赔率观察品种",
    isBuiltin: true,
  },
  {
    code: "512480",
    fullCode: "sh512480",
    name: "半导体ETF",
    sectorTag: "半导体芯片",
    thesis: "国产算力与晶圆设备替代核心、高弹性科技周期先锋",
    isBuiltin: true,
  },
  {
    code: "159819",
    fullCode: "sz159819",
    name: "人工智能ETF",
    sectorTag: "AI算力应用",
    thesis: "A股算力基础设施与AI应用端高弹性核心标的",
    isBuiltin: true,
  },
  {
    code: "159928",
    fullCode: "sz159928",
    name: "消费ETF",
    sectorTag: "必选消费",
    thesis: "白酒乳业等内需现金流龙头、顺周期估值修复锚点",
    isBuiltin: true,
  },
  {
    code: "512880",
    fullCode: "sh512880",
    name: "证券ETF",
    sectorTag: "非银券商",
    thesis: "市场交投情绪高贝塔旗手、适合低位埋伏脉冲行情",
    isBuiltin: true,
  },
  {
    code: "512400",
    fullCode: "sh512400",
    name: "有色金属ETF",
    sectorTag: "有色资源",
    thesis: "铜铝金等上游战略资源、受益全球工业补库与通胀",
    isBuiltin: true,
  },
  {
    code: "512660",
    fullCode: "sh512660",
    name: "军工ETF",
    sectorTag: "国防军工",
    thesis: "国防工业订单周期驱动，具备波段弹性与主题轮动特征",
    isBuiltin: true,
  },
  {
    code: "512890",
    fullCode: "sh512890",
    name: "红利低波ETF",
    sectorTag: "高股息防御",
    thesis: "高分红低波动防御底盘、震荡市稳健底仓标杆",
    isBuiltin: true,
  },
  {
    code: "513100",
    fullCode: "sh513100",
    name: "纳指ETF",
    sectorTag: "全球跨境",
    thesis: "全球科技巨头跨境配置，结合IOPV折溢价追踪回撤窗口",
    isBuiltin: true,
  },
];

const FUND_KLINE_LIMIT = 180;
const WATCHLIST_KEY = "markets.potential_funds_watchlist";
const AI_ANALYSIS_KEY = "markets.potential_funds_ai";
const LIVE_QUOTES_KEY = "markets.potential_funds_quotes";

interface StoredFundQuoteMeta {
  iopv?: number | null;
  discountPremiumPct?: number | null;
  price?: number | null;
  volumeRatio?: number | null;
  day?: string;
  updatedAt: string;
}

export interface EvaluateFundOptions {
  iopv?: number | null;
  discountPremiumPct?: number | null;
  now?: Date;
}

const roundTo = (n: number, decimals: number) => Number(n.toFixed(decimals));

/** Piecewise linear interpolation clamped outside endpoints (sorted ascending by x). */
function piecewiseLinear(x: number, points: ReadonlyArray<readonly [number, number]>): number {
  if (points.length === 0) return 0;
  if (x <= points[0][0]) return points[0][1];
  const last = points[points.length - 1];
  if (x >= last[0]) return last[1];
  for (let i = 1; i < points.length; i++) {
    const [x0, y0] = points[i - 1];
    const [x1, y1] = points[i];
    if (x <= x1) {
      const span = x1 - x0;
      if (span <= 0) return y1;
      return y0 + ((x - x0) / span) * (y1 - y0);
    }
  }
  return last[1];
}

/**
 * Elapsed fraction of today's A-share 240-minute session (09:30-11:30, 13:00-15:00 BJT).
 * Returns 1 for completed historical days or post-close (>= 15:00).
 */
function getAShareElapsedRatio(barDay: string, now: Date): number {
  const todayBjt = beijingDate(now);
  if (barDay !== todayBjt) return 1;
  const [hStr, mStr] = beijingTime(now).split(":");
  const mins = Number(hStr) * 60 + Number(mStr);
  if (!Number.isFinite(mins) || mins >= 15 * 60) return 1;
  if (mins < 9 * 60 + 30) return 0;
  if (mins <= 11 * 60 + 30) return (mins - (9 * 60 + 30)) / 240;
  if (mins < 13 * 60) return 120 / 240;
  return (120 + (mins - 13 * 60)) / 240;
}

function getStoredFundQuotes(): Record<string, StoredFundQuoteMeta> {
  const raw = getStoredJson<Record<string, StoredFundQuoteMeta>>(LIVE_QUOTES_KEY);
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
}

function saveFundQuotesMeta(updates: Record<string, StoredFundQuoteMeta>): void {
  if (Object.keys(updates).length === 0) return;
  const existing = getStoredFundQuotes();
  setStoredJson(LIVE_QUOTES_KEY, { ...existing, ...updates });
}

export function toFullCode(code: string): string {
  const clean = code.trim().toLowerCase();
  if (clean.startsWith("sh") || clean.startsWith("sz")) return clean;
  if (clean.startsWith("5") || clean.startsWith("6") || clean.startsWith("9")) {
    return `sh${clean}`;
  }
  return `sz${clean}`;
}

export function getPotentialFundsWatchlist(): PotentialFundWatchItem[] {
  const stored = getStoredJson<PotentialFundWatchItem[]>(WATCHLIST_KEY);
  if (stored && Array.isArray(stored) && stored.length > 0) {
    return stored;
  }
  return [...DEFAULT_POTENTIAL_FUNDS];
}

export function setPotentialFundsWatchlist(list: PotentialFundWatchItem[]): void {
  setStoredJson(WATCHLIST_KEY, list);
}

export function resetPotentialFundsWatchlist(): PotentialFundWatchItem[] {
  const list = [...DEFAULT_POTENTIAL_FUNDS];
  setPotentialFundsWatchlist(list);
  return list;
}

export async function fetchFundKlines(fullCode: string): Promise<
  Array<{ day: string; close: number; high?: number; low?: number; volume?: number }>
> {
  const cleanCode = fullCode.replace(/^(sh|sz)/i, "");
  const secid = fullCode.toLowerCase().startsWith("sz") ? `0.${cleanCode}` : `1.${cleanCode}`;
  const emUrl = `${EASTMONEY_KLINE_URL}?secid=${secid}&klt=101&fqt=1&lmt=200&end=20500101&iscca=1&fields1=f1,f2,f3,f4,f5,f6,f7,f8&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61`;

  try {
    const res = requireOk(
      await guardedFetch(emUrl, {
        timeoutMs: 15_000,
        headers: { "user-agent": "Mozilla/5.0", referer: "https://quote.eastmoney.com" },
      }),
      fullCode,
    );
    return parseKlines(JSON.parse(res.text()), { includeOhlcv: true, limit: FUND_KLINE_LIMIT });
  } catch {
    // Fallback to Tencent kline
    const url = `${TENCENT_KLINE_URL}?param=${fullCode},day,,,200,qfq`;
    const res = requireOk(
      await guardedFetch(url, {
        timeoutMs: 15_000,
        headers: { "user-agent": "Mozilla/5.0", referer: "https://gu.qq.com" },
      }),
      fullCode,
    );
    return parseKlines(JSON.parse(res.text()), { includeOhlcv: true, limit: FUND_KLINE_LIMIT });
  }
}

export async function addPotentialFundToWatchlist(
  rawCode: string,
  sectorTag?: string,
  thesis?: string,
): Promise<PotentialFundWatchItem> {
  const cleanCode = rawCode.trim().replace(/^(sh|sz)/i, "");
  if (!/^\d{6}$/.test(cleanCode)) {
    throw new Error("请输入合法的6位基金代码（如 512170 或 159819）");
  }

  const fullCode = toFullCode(cleanCode);
  const quotes = await fetchTencentBatchQuotes([fullCode]);
  const live = quotes[fullCode];
  if (!live || !live.name || live.price <= 0) {
    throw new Error(`无法从交易所获取代码 ${cleanCode} 的实时行情，请核对代码`);
  }

  const now = new Date();
  saveFundQuotesMeta({
    [cleanCode]: {
      iopv: live.iopv ?? null,
      discountPremiumPct: live.discountPremiumPct ?? null,
      price: live.price,
      volumeRatio: live.volumeRatio ?? null,
      day: beijingDate(now),
      updatedAt: now.toISOString(),
    },
  });

  // Fetch K-lines and populate DB
  const klines = await fetchFundKlines(fullCode);
  if (klines.length === 0) {
    throw new Error(`无法获取代码 ${cleanCode} 的历史K线数据`);
  }
  upsertCloses(
    klines.map((k) => ({
      symbol: `pf_${cleanCode}`,
      day: k.day,
      close: k.close,
      high: k.high,
      low: k.low,
      volume: k.volume,
    })),
  );

  const currentList = getPotentialFundsWatchlist();
  const existingIndex = currentList.findIndex((item) => item.code === cleanCode);
  const newItem: PotentialFundWatchItem = {
    code: cleanCode,
    fullCode,
    name: live.name.replace(/招商|华夏|易方达|广发|南方|华泰柏瑞|国泰|富国|博时|嘉实|天弘|汇添富/g, "").trim() || live.name,
    sectorTag: sectorTag?.trim() || "自选赛道",
    thesis: thesis?.trim() || "用户自选监控标的，实时跟踪建仓击球区",
    isBuiltin: false,
  };

  if (existingIndex >= 0) {
    currentList[existingIndex] = { ...currentList[existingIndex], ...newItem };
  } else {
    currentList.push(newItem);
  }
  setPotentialFundsWatchlist(currentList);
  return newItem;
}

export function removePotentialFundFromWatchlist(code: string): boolean {
  const currentList = getPotentialFundsWatchlist();
  const filtered = currentList.filter((item) => item.code !== code && item.fullCode !== code);
  if (filtered.length !== currentList.length) {
    setPotentialFundsWatchlist(filtered);
    return true;
  }
  return false;
}

export function evaluatePotentialFund(
  watchItem: PotentialFundWatchItem,
  series: Array<{
    day: string;
    close: number;
    high?: number | null;
    low?: number | null;
    volume?: number | null;
  }>,
  aiComment?: string | null,
  opts?: EvaluateFundOptions,
): PotentialFundItem {
  const valid = series
    .filter((p) => Number.isFinite(p.close) && p.close > 0)
    .map((p) => ({
      day: p.day,
      close: p.close,
      ...(p.high != null && Number.isFinite(p.high) && p.high > 0 ? { high: p.high } : {}),
      ...(p.low != null && Number.isFinite(p.low) && p.low > 0 ? { low: p.low } : {}),
      ...(p.volume != null && Number.isFinite(p.volume) && p.volume >= 0 ? { volume: p.volume } : {}),
    }))
    .sort((a, b) => a.day.localeCompare(b.day));
  if (valid.length === 0) {
    throw new Error(`No valid kline data for ${watchItem.code}`);
  }

  const latest = valid.at(-1)!;
  const price = latest.close;
  const day = latest.day;
  const now = opts?.now ?? new Date();

  const yesterday = valid.length >= 2 ? valid.at(-2) : undefined;
  const changeYesterday = yesterday && yesterday.close > 0 ? Number((price / yesterday.close - 1).toFixed(4)) : null;

  const target1w = addDays(day, -7);
  const target1m = addDays(day, -30);
  const target3m = addDays(day, -90);

  const pt1w = valid.filter((p) => p.day <= target1w).at(-1);
  const pt1m = valid.filter((p) => p.day <= target1m).at(-1);
  const pt3m = valid.filter((p) => p.day <= target3m).at(-1);

  const change1w = pt1w && pt1w.close > 0 ? Number((price / pt1w.close - 1).toFixed(4)) : null;
  const change1m = pt1m && pt1m.close > 0 ? Number((price / pt1m.close - 1).toFixed(4)) : null;
  const change3m = pt3m && pt3m.close > 0 ? Number((price / pt3m.close - 1).toFixed(4)) : null;

  const tech = extractTechnicalStats(valid, price, 3, 0.015);
  const ma10 = tech.ma10 ?? price;
  const ma20 = tech.ma20;
  const ma20DiffPct = tech.ma20DiffPct;
  const high20d = tech.high20d;
  const low20d = tech.low20d;

  const recent120 = valid.slice(-120);
  const valuationWindowDays = recent120.length;
  const getHigh = (p: { close: number; high?: number }) =>
    p.high !== undefined && Number.isFinite(p.high) && p.high > 0 ? Math.max(p.close, p.high) : p.close;
  const getLow = (p: { close: number; low?: number }) =>
    p.low !== undefined && Number.isFinite(p.low) && p.low > 0 ? Math.min(p.close, p.low) : p.close;

  // Exclude today's bar when measuring pre-existing 20d box floor so a fresh crash doesn't mask a breakdown
  const prior20 = valid.slice(-21, -1);
  const priorLow20d = prior20.length > 0 ? roundTo(Math.min(...prior20.map(getLow)), 3) : low20d;

  const high120d = roundTo(Math.max(price, ...recent120.map(getHigh)), 3);
  const low120d = roundTo(Math.min(price, ...recent120.map(getLow)), 3);

  const span120 = Math.max(0.001, high120d - low120d);
  const percentile120d = roundTo(Math.max(0, Math.min(100, ((price - low120d) / span120) * 100)), 1);
  const drawdownFrom120dHighPct = high120d > 0 ? roundTo(price / high120d - 1, 4) : 0;

  let volumeRatio20d = tech.volumeRatio20d ?? null;
  let volumeSignal = tech.volumeSignal ?? "量能常态";

  // Time-aware intraday volume scaling: annualize partial intraday volume after >= 15m elapsed;
  // in the opening 15m use yesterday's settled ratio; after close use exact settled volume.
  const elapsedRatio = getAShareElapsedRatio(day, now);
  let effectiveVolRatio = volumeRatio20d;
  if (volumeRatio20d != null && elapsedRatio > 0 && elapsedRatio < 1 && valid.length >= 22) {
    const closed20 = valid.slice(-21, -1).filter((p) => (p.volume ?? 0) > 0);
    const meanClosedVol =
      closed20.length >= 3 ? closed20.reduce((s, p) => s + (p.volume ?? 0), 0) / closed20.length : 0;
    if (elapsedRatio >= 15 / 240) {
      const scaled =
        meanClosedVol > 0 && latest.volume != null && latest.volume > 0
          ? roundTo(latest.volume / elapsedRatio / meanClosedVol, 2)
          : roundTo(volumeRatio20d / elapsedRatio, 2);
      volumeRatio20d = scaled;
      effectiveVolRatio = scaled;
      volumeSignal = scaled >= 1.3 ? "盘中折算放量" : scaled <= 0.75 ? "盘中折算缩量" : "盘中量能常态";
    } else {
      const yesterdayPt = valid.at(-2);
      if (meanClosedVol > 0 && yesterdayPt?.volume && yesterdayPt.volume > 0) {
        effectiveVolRatio = Number((yesterdayPt.volume / meanClosedVol).toFixed(2));
      }
      volumeSignal = "开盘初量能未稳";
    }
  } else if (volumeRatio20d != null && elapsedRatio >= 15 / 240 && elapsedRatio < 1) {
    const scaled = roundTo(volumeRatio20d / elapsedRatio, 2);
    volumeRatio20d = scaled;
    effectiveVolRatio = scaled;
    volumeSignal = scaled >= 1.3 ? "盘中折算放量" : scaled <= 0.75 ? "盘中折算缩量" : "盘中量能常态";
  }

  // 3-Track Classification: bottom_ambush | right_breakout | range_defense
  const rangeAmplitude120d = price > 0 ? (high120d - low120d) / price : 0;
  const isExplicitDefenseTag = /红利|低波|高股息|防御|债券|国债|黄金|公用/i.test(watchItem.sectorTag ?? "");
  const isLowVolatility = rangeAmplitude120d <= 0.16;
  const isNotBreakingDown =
    (change1m ?? 0) >= -0.04 &&
    ma20DiffPct >= -0.025 &&
    (changeYesterday ?? 0) >= -0.02;

  const isDeepOversold = percentile120d <= 35 || drawdownFrom120dHighPct <= -0.15;
  const isDefensiveProfile = (isExplicitDefenseTag || isLowVolatility) && isNotBreakingDown && !isDeepOversold;

  const hasBreakoutMomentum =
    (change1m ?? 0) >= 0.035 ||
    (change1w ?? 0) >= 0.018 ||
    (price >= high20d * 0.99 && (change1m ?? 0) >= 0.015);

  const isRightBullish =
    price >= ma20 * 0.995 &&
    ma10 >= ma20 * 0.995 &&
    percentile120d >= 35 &&
    hasBreakoutMomentum;

  let track: PotentialFundTrack = "bottom_ambush";
  let trackLabel = "🛡️ 底部埋伏";

  if (isDefensiveProfile) {
    track = "range_defense";
    trackLabel = "⚖️ 稳健防守";
  } else if (isDeepOversold && !isRightBullish) {
    track = "bottom_ambush";
    trackLabel = "🛡️ 底部埋伏";
  } else if (isRightBullish && !isDeepOversold) {
    track = "right_breakout";
    trackLabel = "🚀 右侧启动";
  } else if (price >= ma20 && ma10 >= ma20 && (change1m ?? 0) >= 0) {
    track = "right_breakout";
    trackLabel = "🚀 右侧启动";
  } else if (rangeAmplitude120d <= 0.22 && Math.abs(ma20DiffPct) <= 0.025 && (changeYesterday ?? 0) > -0.015) {
    track = "range_defense";
    trackLabel = "⚖️ 稳健防守";
  } else {
    track = "bottom_ambush";
    trackLabel = "🛡️ 底部埋伏";
  }

  let score = 50;
  let entryBuyPrice = price;
  let entryBuyAnchor = "";
  let strongSupportPrice = price;
  let strongSupportAnchor = "";
  let takeProfitPrice = price;
  let takeProfitAnchor = "";
  let strategyModeLabel = "";

  const isBearishMaCascade = price < ma10 && ma10 < ma20;
  const isBreakdown =
    price < priorLow20d * 0.992 &&
    ((changeYesterday ?? 0) <= -0.01 || (change1w ?? 0) <= -0.025 || isBearishMaCascade);
  const isSevereCrash = (changeYesterday ?? 0) <= -0.025 || (change1w ?? 0) <= -0.045;

  if (track === "bottom_ambush") {
    // 1. Valuation & Drawdown Odds (max 34 pts, smooth piecewise linear)
    const valScore =
      piecewiseLinear(percentile120d, [
        [0, 20],
        [15, 18],
        [30, 13],
        [45, 7],
        [65, 2],
        [100, 0],
      ]) +
      piecewiseLinear(drawdownFrom120dHighPct, [
        [-0.3, 14],
        [-0.22, 12],
        [-0.15, 9],
        [-0.08, 4],
        [0, 0],
      ]);

    // 2. Stabilization & Structure (max 28 pts)
    let stabFloor = 2;
    if (!isBreakdown && price >= priorLow20d * 1.005) {
      stabFloor = piecewiseLinear(price / Math.max(0.001, priorLow20d), [
        [1.005, 10],
        [1.04, 12],
        [1.12, 6],
        [1.25, 2],
      ]);
      if ((changeYesterday ?? 0) > 0 && price <= priorLow20d * 1.05) {
        stabFloor = Math.min(14, stabFloor + 2);
      }
    }
    const stabMa = piecewiseLinear(ma20DiffPct, [
      [-0.1, 0],
      [-0.05, 6],
      [-0.025, 12],
      [0.005, 14],
      [0.04, 8],
      [0.08, 2],
    ]);
    const stabScore = stabFloor + stabMa;

    // 3. Volume Bottom Signal (max 18 pts)
    let volScore = 10;
    if (effectiveVolRatio != null) {
      if ((changeYesterday ?? 0) <= -0.015 && effectiveVolRatio >= 1.35) {
        volScore = 2;
      } else if (effectiveVolRatio >= 0.65 && effectiveVolRatio <= 1.05 && (changeYesterday ?? 0) >= -0.008) {
        volScore = 15;
      } else if (effectiveVolRatio > 1.05 && effectiveVolRatio <= 1.6 && (changeYesterday ?? 0) > 0) {
        volScore = 18;
      } else if (effectiveVolRatio < 0.65) {
        volScore = (changeYesterday ?? 0) >= 0 ? 11 : 7;
      }
    }

    // Genuine structural buy anchors without artificial price*0.995 clipping
    if (isBreakdown || price < priorLow20d * 0.995) {
      if (low120d < price * 0.985) {
        entryBuyPrice = roundTo(low120d * 1.008, 3);
        entryBuyAnchor = "下探近120日前低支撑区";
        strongSupportPrice = roundTo(low120d * 0.975, 3);
        strongSupportAnchor = "120日低点破位防守下沿";
      } else {
        entryBuyPrice = roundTo(priorLow20d, 3);
        entryBuyAnchor = "重返前20日低点止跌确认位";
        strongSupportPrice = roundTo(low120d * 0.97, 3);
        strongSupportAnchor = "趋势失守风控防守位";
      }
      strategyModeLabel = "短期破位下探 · 严防接飞刀，等放量企稳再动手";
    } else if (price >= ma20 * 0.992) {
      entryBuyPrice = roundTo(Math.max(priorLow20d * 1.005, ma20 * 0.992), 3);
      entryBuyAnchor = "回踩 MA20 均线支撑位";
      strongSupportPrice = roundTo(Math.min(priorLow20d * 0.985, low120d * 1.002), 3);
      strongSupportAnchor = "近120日前低强支撑";
      strategyModeLabel = percentile120d <= 25 ? "适合分批建底仓 / 开启低位定投" : "适合回踩支撑网格低吸";
    } else {
      entryBuyPrice = roundTo(Math.max(low120d * 1.005, priorLow20d * 1.005), 3);
      entryBuyAnchor = "近20日箱体下沿低吸位";
      strongSupportPrice = roundTo(Math.min(priorLow20d * 0.985, low120d * 1.002), 3);
      strongSupportAnchor = "近120日前低强支撑";
      strategyModeLabel = percentile120d <= 25 ? "适合分批建底仓 / 开启低位定投" : "回撤蓄势阶段 · 等箱体下沿缩量企稳";
    }

    takeProfitPrice = roundTo(
      Math.max(entryBuyPrice * 1.06, Math.max(high20d, (low120d + high120d) * 0.5)),
      3,
    );
    takeProfitAnchor = "前波段压力 / 震荡中枢目标位";

    // 4. Nearness to structural entry buy price (max 12 pts, 0 during active selloffs)
    let entryScore = 0;
    const distanceToBuyPct = (price - entryBuyPrice) / entryBuyPrice;
    if (!isBreakdown && !isSevereCrash && (changeYesterday ?? 0) > -0.018) {
      entryScore = piecewiseLinear(distanceToBuyPct, [
        [-0.04, 2],
        [-0.015, 12],
        [0.015, 12],
        [0.04, 4],
        [0.07, -6],
      ]);
    }

    // 5. Continuous falling-knife & bearish MA cascade penalties
    let penalty = 0;
    if ((changeYesterday ?? 0) <= -0.018) {
      penalty += piecewiseLinear(changeYesterday ?? 0, [
        [-0.05, 16],
        [-0.03, 10],
        [-0.018, 4],
      ]);
    }
    if ((change1w ?? 0) <= -0.025) {
      penalty += piecewiseLinear(change1w ?? 0, [
        [-0.08, 16],
        [-0.05, 10],
        [-0.025, 3],
      ]);
    }
    if (isBearishMaCascade && ma20DiffPct < -0.02) {
      penalty += piecewiseLinear(ma20DiffPct, [
        [-0.08, 12],
        [-0.04, 8],
        [-0.02, 4],
      ]);
    }

    score = Math.min(92, Math.max(22, Math.round(valScore + stabScore + volScore + entryScore - penalty)));
  } else if (track === "right_breakout") {
    // 1. Trend breakout strength (max 35 pts)
    const baseTrend = price >= ma10 && ma10 >= ma20 ? 30 : price >= ma20 ? 20 : 10;
    const trendScore =
      baseTrend +
      piecewiseLinear(change1m ?? 0, [
        [-0.02, 0],
        [0.02, 2],
        [0.06, 5],
      ]);

    // 2. Volume & price coordination (max 25 pts)
    let volScore = (change1w ?? 0) >= 0.01 ? 17 : 12;
    if (effectiveVolRatio != null) {
      if ((changeYesterday ?? 0) >= 0) {
        volScore = piecewiseLinear(effectiveVolRatio, [
          [0.6, 10],
          [1.0, 16],
          [1.3, 25],
          [2.2, 22],
        ]);
      } else if ((changeYesterday ?? 0) > -0.018) {
        volScore = piecewiseLinear(effectiveVolRatio, [
          [0.5, 22],
          [0.85, 20],
          [1.2, 12],
          [1.6, 6],
        ]);
      } else {
        volScore = 4;
      }
    }

    // True structural buy anchor for right breakout
    if (price >= ma10 * 1.005) {
      entryBuyPrice = roundTo(ma10, 3);
      entryBuyAnchor = "回踩 MA10 突破支撑位";
    } else {
      entryBuyPrice = roundTo(Math.max(ma20, ma10 * 0.995), 3);
      entryBuyAnchor = price >= ma10 ? "MA10 突破回踩确认位" : "回踩 MA20 趋势防守位";
    }
    strongSupportPrice = roundTo(Math.min(ma20 * 0.975, low20d), 3);
    strongSupportAnchor = "MA20 趋势波段防守位";
    takeProfitPrice = roundTo(Math.max(price * 1.08, high120d * 1.03), 3);
    takeProfitAnchor = "右侧主升浪延伸目标";
    strategyModeLabel = ma20DiffPct > 0.05 ? "短线乖离偏大 · 等回踩均线再接" : "趋势走强 · 回踩均线右侧跟进";

    // 3. Nearness to entry buy price (max 22 pts)
    const distanceToBuyPct = (price - entryBuyPrice) / entryBuyPrice;
    const entryScore =
      (changeYesterday ?? 0) <= -0.02
        ? 0
        : piecewiseLinear(distanceToBuyPct, [
            [-0.05, 6],
            [-0.015, 22],
            [0.018, 22],
            [0.045, 10],
            [0.08, 0],
          ]);

    // 4. Overheating / sharp selloff penalty
    let penalty = 0;
    if (ma20DiffPct > 0.05) {
      penalty += piecewiseLinear(ma20DiffPct, [
        [0.05, 4],
        [0.09, 14],
        [0.14, 20],
      ]);
    }
    if ((changeYesterday ?? 0) <= -0.02) {
      penalty += effectiveVolRatio != null && effectiveVolRatio >= 1.3 ? 12 : 7;
    }

    score = Math.min(92, Math.max(25, Math.round(trendScore + volScore + entryScore - penalty)));
  } else {
    // range_defense
    // 1. Valuation & Resilience (max 30 pts)
    const valScore =
      14 +
      piecewiseLinear(percentile120d, [
        [0, 6],
        [25, 10],
        [50, 12],
        [70, 10],
        [85, 4],
        [100, 0],
      ]) +
      (Math.abs(drawdownFrom120dHighPct) <= 0.06 ? 4 : 0);

    // 2. Stability & Low Volatility (max 30 pts)
    const stabScore =
      10 +
      piecewiseLinear(Math.abs(ma20DiffPct), [
        [0, 14],
        [0.02, 12],
        [0.05, 4],
        [0.08, 0],
      ]) +
      (price >= priorLow20d * 1.005 ? 6 : 1);

    // True box buy levels without artificial price*0.992 clipping
    entryBuyPrice = roundTo((ma20 + priorLow20d) / 2, 3);
    entryBuyAnchor = "箱体中下轨回踩低吸位";
    strongSupportPrice = roundTo(priorLow20d * 0.99, 3);
    strongSupportAnchor = "近20日箱体下沿防守";
    takeProfitPrice = roundTo(Math.max(entryBuyPrice * 1.035, high20d * 0.995), 3);
    takeProfitAnchor = "近20日箱体上沿兑现位";
    strategyModeLabel = isExplicitDefenseTag
      ? "高股息防御底仓 · 箱体下沿逢低配置"
      : "稳健震荡区间 · 箱体下沿逢低配置";

    // 3. Nearness to entry buy price (max 22 pts)
    const distanceToBuyPct = (price - entryBuyPrice) / entryBuyPrice;
    const entryScore =
      (changeYesterday ?? 0) <= -0.02
        ? 0
        : piecewiseLinear(distanceToBuyPct, [
            [-0.04, 6],
            [-0.015, 22],
            [0.015, 22],
            [0.035, 10],
            [0.06, 0],
          ]);

    let penalty = 0;
    if ((changeYesterday ?? 0) <= -0.015) {
      penalty += piecewiseLinear(changeYesterday ?? 0, [
        [-0.04, 14],
        [-0.015, 5],
      ]);
    }
    if ((change1w ?? 0) <= -0.025) penalty += 6;

    score = Math.min(85, Math.max(28, Math.round(valScore + stabScore + entryScore - penalty)));
  }

  // QDII / ETF IOPV High-Premium Penalty & Circuit Breaker
  const iopv = opts?.iopv ?? null;
  const discountPremiumPct = opts?.discountPremiumPct ?? null;
  const hasHighPremium = discountPremiumPct != null && discountPremiumPct >= 0.03;
  if (discountPremiumPct != null) {
    if (discountPremiumPct >= 0.08) {
      score = Math.max(20, score - 24);
    } else if (discountPremiumPct >= 0.05) {
      score = Math.max(24, score - 18);
    } else if (discountPremiumPct >= 0.03) {
      score = Math.max(25, score - 10);
    } else if (discountPremiumPct >= 0.015) {
      score = Math.max(25, score - 4);
    } else if (discountPremiumPct <= -0.01) {
      score = Math.min(92, score + 3);
    }
  }

  const entryBuyDistancePct = price > 0 ? roundTo(entryBuyPrice / price - 1, 4) : 0;
  const reward = Math.max(0, takeProfitPrice - price);
  const stopRisk = Math.max(price * 0.02, price - strongSupportPrice * 0.985);
  const riskRewardRatio = stopRisk > 0 ? roundTo(reward / stopRisk, 2) : null;

  const isBelowSupport = isBreakdown || price < entryBuyPrice * 0.98;
  const isNearPriceWindow =
    !isBelowSupport &&
    !isSevereCrash &&
    !hasHighPremium &&
    Math.abs(price - entryBuyPrice) / Math.max(0.001, entryBuyPrice) <= 0.018;

  // Signal tier with Price Trigger, Falling-Knife & IOPV Premium Circuit Breakers
  let tier: PotentialFundTier = "wait";
  let tierLabel = "⏳ 耐心等待区";
  let tierTone: PorkStatusTone = "neutral";
  if (score >= 75 && !hasHighPremium && !isSevereCrash && !isBelowSupport) {
    if (isNearPriceWindow) {
      tier = "prime";
      tierLabel = "🔥 黄金击球区";
      tierTone = "positive";
    } else {
      tier = "watch";
      tierLabel = "👀 待回踩触发";
      tierTone = "accent";
    }
  } else if (score >= 60) {
    tier = "watch";
    tierLabel = hasHighPremium ? "⚠️ 高溢价警戒" : "👀 重点观察区";
    tierTone = hasHighPremium ? "caution" : "accent";
  } else if (hasHighPremium) {
    tierLabel = "⚠️ 高溢价等待";
  }

  const isNearEntry = isNearPriceWindow;
  let entryStatusLabel = `⏳ 距建议买点 ${(Math.abs(entryBuyDistancePct) * 100).toFixed(1)}%`;
  if (hasHighPremium) {
    entryStatusLabel = `⚠️ 场内溢价 +${((discountPremiumPct ?? 0) * 100).toFixed(1)}% · 严禁追高`;
  } else if (isBelowSupport) {
    entryStatusLabel = "⚠️ 已跌破支撑 · 暂防飞刀";
  } else if (tier === "prime") {
    entryStatusLabel = "🔥 已进入黄金击球区";
  } else if (isNearPriceWindow) {
    entryStatusLabel = "📍 价格贴近买点 · 等因子共振";
  }

  // Fallback rule comment
  let ruleComment = "";
  if (hasHighPremium) {
    ruleComment = `当前场内 IOPV 溢价高达 +${((discountPremiumPct ?? 0) * 100).toFixed(1)}%，存在显著溢价回吐风险，建议等待折溢价收敛至 2% 以内再评估低吸`;
  } else if (isBelowSupport || isSevereCrash) {
    ruleComment = `短期跌势较急或已跌破前支撑位 (¥${entryBuyPrice.toFixed(3)})，暂不抄底，保持观望待放量止跌确认`;
  } else if (tier === "prime") {
    if (track === "bottom_ambush") {
      ruleComment = `${valuationWindowDays}日分位仅 ${percentile120d}%，距高点回撤 ${(drawdownFrom120dHighPct * 100).toFixed(1)}%，现价已进入建议低吸击球区 (¥${entryBuyPrice.toFixed(3)})，赔率优势凸显`;
    } else if (track === "right_breakout") {
      ruleComment = `均线多头共振，已回踩 MA10/MA20 确认支撑，处于黄金突破买点区间 (¥${entryBuyPrice.toFixed(3)})，顺势轻仓跟进`;
    } else if (isExplicitDefenseTag) {
      ruleComment = `防御底仓属性突出，当前贴近箱体中下轨 (¥${entryBuyPrice.toFixed(3)})，具备较高稳健抗跌与股息配置价值`;
    } else {
      ruleComment = `波动收敛且贴近震荡箱体中下轨 (¥${entryBuyPrice.toFixed(3)})，盈亏比合适，可逢低稳健配置`;
    }
  } else if (tier === "watch") {
    if (score >= 75 && !isNearPriceWindow) {
      const waitPct = (((price - entryBuyPrice) / entryBuyPrice) * 100).toFixed(1);
      ruleComment = `多因子评分优异(${score}分)，但现价距建仓点仍高 ${waitPct}%，严禁追高，耐心等待回踩 ¥${entryBuyPrice.toFixed(3)} 触发黄金击球`;
    } else if (track === "bottom_ambush") {
      ruleComment = `底部震荡蓄势中，当前贴近/等待 ¥${entryBuyPrice.toFixed(3)} 附近企稳，还需量能或均线收敛确认`;
    } else if (track === "right_breakout") {
      ruleComment = `右侧动能初现，等待进一步缩量回踩支撑 (¥${entryBuyPrice.toFixed(3)}) 确认支撑有效性`;
    } else {
      ruleComment = `处于箱体中上轨震荡，等待回踩支撑位 ¥${entryBuyPrice.toFixed(3)} 附近低吸`;
    }
  } else {
    ruleComment =
      track === "bottom_ambush"
        ? `处于偏弱回落或分位优势不足阶段，等待企稳或价格回落至 ¥${entryBuyPrice.toFixed(3)} 附近再观察`
        : `技术指标偏弱或短线乖离过大，暂不具备操作性价比，保持耐心等待`;
  }

  const comment = aiComment?.trim() ? aiComment.trim() : ruleComment;
  const commentSource = aiComment?.trim() ? "ai" : "rules";

  const weeklySeries = buildWeeklyTrendSeries(valid);

  return {
    ...watchItem,
    day,
    price,
    changeYesterday,
    change1w,
    change1m,
    change3m,
    track,
    trackLabel,
    score,
    tier,
    tierLabel,
    tierTone,
    ma10,
    ma20,
    ma20DiffPct,
    high20d,
    low20d,
    high120d,
    low120d,
    valuationWindowDays,
    percentile120d,
    drawdownFrom120dHighPct,
    volumeRatio20d,
    volumeSignal,
    iopv,
    discountPremiumPct,
    entryBuyPrice,
    entryBuyDistancePct,
    entryBuyAnchor,
    strongSupportPrice,
    strongSupportAnchor,
    takeProfitPrice,
    takeProfitAnchor,
    riskRewardRatio,
    isNearEntry,
    entryStatusLabel,
    strategyModeLabel,
    comment,
    commentSource,
    weeklySeries,
  };
}

const PotentialFundsAiSchema = z.object({
  headline: z.string().describe("跨赛道机会总览（1句话，40字以内，点名当前处于黄金击球区的核心品种）"),
  allocationAdvice: z.string().describe("底部埋伏与右侧动量双轨配置建议（60~90字）"),
  fundComments: z.array(
    z.object({
      code: z.string(),
      comment: z.string().describe("结合回撤分位、均线支撑与行业逻辑的一句话精评（28~42字）"),
    }),
  ),
});

type StoredAiAnalysis = z.infer<typeof PotentialFundsAiSchema> & {
  analyzedAt: string;
  marketDay?: string;
  watchlistKey?: string;
  primeCodes?: string[];
  scores?: Record<string, number>;
  model?: string | null;
  channelId?: string | null;
  channelHost?: string | null;
  latencyMs?: number | null;
};

/** Reject AI headlines that cite non-prime funds or invent prime hits when none exist. */
export function isHeadlineConsistent(headline: string | undefined | null, items: PotentialFundItem[]): boolean {
  if (!headline || !headline.trim()) return false;
  const text = headline.trim();
  const primeItems = items.filter((i) => i.tier === "prime");
  const mentioned = items.filter((i) => text.includes(i.name) || text.includes(i.code));

  if (primeItems.length === 0) {
    if (/(?:触发|进入|处于)黄金击球/.test(text) && !/暂无|尚未|无.*黄金击球/.test(text)) {
      return false;
    }
    if (mentioned.length > 0 && !/暂无|尚未|观望|等待|警戒|谨防/.test(text)) {
      return false;
    }
    return true;
  }

  const primeCodes = new Set(primeItems.map((i) => i.code));
  if (mentioned.some((m) => !primeCodes.has(m.code))) return false;
  if (mentioned.length === 0) return false;
  return true;
}

export async function refreshPotentialFundsDaily(
  now: Date,
  opts?: { force?: boolean; skipQuotes?: boolean; skipAi?: boolean },
): Promise<PotentialFundsOverview> {
  const watchlist = getPotentialFundsWatchlist();
  const dayStr = beijingDate(now);

  // 1. Fetch & upsert K-lines + real-time IOPV / premium metadata if not skipQuotes
  if (!opts?.skipQuotes) {
    for (const item of watchlist) {
      try {
        const klines = await fetchFundKlines(item.fullCode);
        if (klines.length > 0) {
          upsertCloses(
            klines.map((k) => ({
              symbol: `pf_${item.code}`,
              day: k.day,
              close: k.close,
              high: k.high,
              low: k.low,
              volume: k.volume,
            })),
          );
        }
      } catch (err) {
        console.warn(`[PotentialFunds] Failed to refresh kline for ${item.code}: ${(err as Error).message}`);
      }
    }

    try {
      const batch = await fetchTencentBatchQuotes(watchlist.map((w) => w.fullCode));
      const updates: Record<string, StoredFundQuoteMeta> = {};
      for (const item of watchlist) {
        const q = batch[item.fullCode];
        if (q && q.price > 0) {
          updates[item.code] = {
            iopv: q.iopv ?? null,
            discountPremiumPct: q.discountPremiumPct ?? null,
            price: q.price,
            volumeRatio: q.volumeRatio ?? null,
            day: dayStr,
            updatedAt: now.toISOString(),
          };
        }
      }
      saveFundQuotesMeta(updates);
    } catch (err) {
      console.warn(`[PotentialFunds] Failed to fetch batch IOPV quotes: ${(err as Error).message}`);
    }
  }

  // 2. Load closes and evaluate preliminary items (with IOPV / time-aware scaling)
  const allCloses = getRecentCloses(FUND_KLINE_LIMIT);
  const quotesMeta = getStoredFundQuotes();
  const preliminaryItems = watchlist.map((item) => {
    const symbol = `pf_${item.code}`;
    const series = allCloses.filter((r) => r.symbol === symbol);
    const meta = quotesMeta[item.code];
    const evalOpts: EvaluateFundOptions = {
      iopv: meta?.iopv ?? null,
      discountPremiumPct: meta?.discountPremiumPct ?? null,
      now,
    };
    if (series.length > 0) {
      return evaluatePotentialFund(item, series, null, evalOpts);
    }
    return evaluatePotentialFund(item, [{ day: dayStr, close: 1.0, high: 1.0, low: 1.0, volume: 1000 }], null, evalOpts);
  });

  const marketDay = preliminaryItems.reduce((max, i) => (i.day > max ? i.day : max), "") || dayStr;
  const watchlistKey = watchlist.map((w) => w.code).sort().join(",");
  const primeCodes = preliminaryItems
    .filter((i) => i.tier === "prime")
    .map((i) => i.code)
    .sort();
  const scoresMap = Object.fromEntries(preliminaryItems.map((i) => [i.code, i.score]));

  // 3. AI review batch call if enabled
  if (!opts?.skipAi && process.env.MODEL_CALLS_ENABLED === "true") {
    try {
      const fundSummaries = preliminaryItems.map((p) => {
        const premStr =
          p.discountPremiumPct != null
            ? `${p.discountPremiumPct >= 0 ? "+" : ""}${(p.discountPremiumPct * 100).toFixed(2)}%`
            : "未知";
        const rrStr = p.riskRewardRatio != null ? `${p.riskRewardRatio.toFixed(1)}:1` : "—";
        return `- ${p.name} (${p.code}, ${p.sectorTag}): 现价 ¥${p.price.toFixed(3)}, 日涨跌 ${p.changeYesterday != null ? `${(p.changeYesterday * 100).toFixed(1)}%` : "—"}, 近1周 ${p.change1w != null ? `${(p.change1w * 100).toFixed(1)}%` : "—"}, 近1月 ${p.change1m != null ? `${(p.change1m * 100).toFixed(1)}%` : "—"}, ${p.valuationWindowDays ?? 120}日分位 ${p.percentile120d}%, 距高点回撤 ${(p.drawdownFrom120dHighPct * 100).toFixed(1)}%, IOPV折溢价 ${premStr}, 轨道: ${p.trackLabel}, 评分: ${p.score} (${p.tierLabel}), 建议买点: ¥${p.entryBuyPrice.toFixed(3)}, 目标止盈: ¥${(p.takeProfitPrice ?? p.price).toFixed(3)} (盈亏比 ${rrStr}), 状态: ${p.entryStatusLabel}`;
      });

      const systemPrompt = `你是一位精通 A 股跨行业 ETF 配置、行业周期轮动与技术波段的资深量化基金经理。
请严格基于提供的潜力基金池实时量化数据，输出跨赛道宏观机会研判及每只基金的一句话精练点评。
严格约束：
1. "headline" 只能点名当前评级明确为「🔥 黄金击球区」的标的；如果没有任何标的处于「🔥 黄金击球区」，必须明确写出暂无黄金击球标的，严禁把「重点观察区」「高溢价警戒」「耐心等待区」写成黄金击球区！
2. 对标注高溢价（如溢价率 >= 3% 的跨境/QDII品种）或单周大跌破位防飞刀品种，点评中必须明确提示风险与等待信号，禁止违背状态提示立即买入。
3. 严格输出合法 JSON 对象，字段名完全一致：
{
  "headline": "跨赛道机会总览（1句话，40字以内，仅点名处于🔥黄金击球区的标的，无则客观说明暂无击球信号）",
  "allocationAdvice": "底部埋伏（低估反转）、右侧动量（突破跟进）与稳健防守（高股息/低波）三轨配置建议（60~90字，说明当下资金应如何分配与风控）",
  "fundComments": [
    { "code": "6位基金代码", "comment": "结合回撤分位、均线支撑、IOPV折溢价与赛道逻辑的一句话精评（28~45字）" }
  ]
}
注意：字符串内容内部严禁使用英文双引号（"），如需引号请使用中文引号（「」或“”）。`;

      const userPrompt = `潜力基金观察池多因子量化评估数据（行情基准日 ${marketDay}，触发时间 ${dayStr}）：\n${fundSummaries.join("\n")}\n\n请生成跨赛道宏观总览与各基金逐项解读 JSON。`;

      const aiRes = await chatJson({
        system: systemPrompt,
        user: userPrompt,
        schema: PotentialFundsAiSchema,
        temperature: 0.2,
        maxTokens: 2500,
        purpose: "potential_funds_analysis",
        subject: `potential_funds:${marketDay}`,
      });

      const storedAi: StoredAiAnalysis = {
        ...aiRes.data,
        analyzedAt: now.toISOString(),
        marketDay,
        watchlistKey,
        primeCodes,
        scores: scoresMap,
        model: aiRes.model,
        channelId: aiRes.channelId,
        channelHost: aiRes.host,
        latencyMs: aiRes.latencyMs,
      };
      setStoredJson(AI_ANALYSIS_KEY, storedAi);
    } catch (err) {
      console.warn(`[PotentialFunds] AI review failed: ${(err as Error).message}`);
    }
  }

  return readPotentialFundsOverview(false, now);
}

export async function readPotentialFundsOverview(
  _skipAnalysis = false,
  now: Date = new Date(),
): Promise<PotentialFundsOverview> {
  const watchlist = getPotentialFundsWatchlist();
  const allCloses = getRecentCloses(FUND_KLINE_LIMIT);
  const quotesMeta = getStoredFundQuotes();
  const storedAi = getStoredJson<StoredAiAnalysis>(AI_ANALYSIS_KEY);

  // First pass: pure rule evaluation so staleness and prime-drift checks see true current state
  const baseItems: PotentialFundItem[] = [];
  for (const item of watchlist) {
    const symbol = `pf_${item.code}`;
    const series = allCloses.filter((r) => r.symbol === symbol);
    if (series.length > 0) {
      const meta = quotesMeta[item.code];
      baseItems.push(
        evaluatePotentialFund(item, series, null, {
          iopv: meta?.iopv ?? null,
          discountPremiumPct: meta?.discountPremiumPct ?? null,
          now,
        }),
      );
    }
  }

  baseItems.sort((a, b) => b.score - a.score);

  const marketDay = baseItems.reduce((max, i) => (i.day > max ? i.day : max), "") || null;
  const watchlistKey = watchlist.map((w) => w.code).sort().join(",");
  const actualPrimeCodes = baseItems
    .filter((i) => i.tier === "prime")
    .map((i) => i.code)
    .sort();

  const aiDayValid = Boolean(
    storedAi?.analyzedAt && (!marketDay || beijingDate(storedAi.analyzedAt) >= marketDay),
  );
  const aiWatchlistValid = Boolean(storedAi?.watchlistKey && storedAi.watchlistKey === watchlistKey);
  const aiPrimeUnchanged = Boolean(
    storedAi?.primeCodes && storedAi.primeCodes.join(",") === actualPrimeCodes.join(","),
  );
  const aiOverviewValid = Boolean(
    storedAi &&
      aiDayValid &&
      aiWatchlistValid &&
      aiPrimeUnchanged &&
      isHeadlineConsistent(storedAi.headline, baseItems),
  );

  const aiCommentMap = new Map<string, string>();
  if (
    storedAi &&
    aiDayValid &&
    aiWatchlistValid &&
    storedAi.scores !== undefined &&
    Array.isArray(storedAi.fundComments)
  ) {
    const baseMap = new Map(baseItems.map((i) => [i.code, i]));
    const oldPrimeSet = new Set(storedAi.primeCodes ?? []);
    for (const fc of storedAi.fundComments) {
      const curr = baseMap.get(fc.code);
      if (!curr) continue;
      // Invalidate stale per-fund comment if its score drifted materially (>= 8 pts) or crossed prime boundary
      const oldScore = storedAi.scores?.[fc.code];
      const scoreDrifted = oldScore === undefined || Math.abs(curr.score - oldScore) >= 8;
      const primeFlipped = storedAi.primeCodes !== undefined && oldPrimeSet.has(fc.code) !== (curr.tier === "prime");
      if (!scoreDrifted && !primeFlipped && isHeadlineConsistent(storedAi.headline, baseItems)) {
        aiCommentMap.set(fc.code, fc.comment);
      }
    }
  }

  const items = baseItems.map((b) => {
    const aiText = aiCommentMap.get(b.code)?.trim();
    if (!aiText) return b;
    return {
      ...b,
      comment: aiText,
      commentSource: "ai" as const,
    };
  });

  const totalCount = items.length;
  const primeCount = items.filter((i) => i.tier === "prime").length;
  const bottomAmbushCount = items.filter((i) => i.track === "bottom_ambush").length;
  const rightBreakoutCount = items.filter((i) => i.track === "right_breakout").length;
  const rangeDefenseCount = items.filter((i) => i.track === "range_defense").length;

  const primeNames = items
    .filter((i) => i.tier === "prime")
    .map((i) => i.name)
    .join("、");

  const defaultHeadline =
    primeCount > 0
      ? `当前共监测 ${totalCount} 只精选标的，其中 ${primeNames} 触发黄金击球区`
      : `当前共监测 ${totalCount} 只精选标的，暂无进入极佳击球点位标的，多数处于待回踩或震荡观察`;

  const defaultAllocation = `三轨精选配置：底部超跌（${bottomAmbushCount}只）分批建立底仓；右侧动量（${rightBreakoutCount}只）待均线回踩跟进；稳健防守（${rangeDefenseCount}只）在箱体下沿配置，严禁追高或买在高溢价区间。`;

  const latestQuoteUpdatedAt = Object.values(quotesMeta).reduce(
    (max, q) => (q.updatedAt && q.updatedAt > max ? q.updatedAt : max),
    "",
  );
  const stableUpdatedAt =
    (aiOverviewValid ? storedAi?.analyzedAt : null) ||
    latestQuoteUpdatedAt ||
    (marketDay ? `${marketDay}T15:00:00+08:00` : now.toISOString());

  const channels = loadChannels();
  const recentCalls = getLlmCallsSince(null, 20);
  const recentFundCall = recentCalls.find(
    (c) => c.status === "completed" && (c.purpose === "potential_funds_analysis" || c.subject?.startsWith("potential_funds")),
  );

  return {
    updatedAt: stableUpdatedAt,
    marketDay,
    source: aiOverviewValid ? "ai" : "rules",
    model: storedAi?.model ?? recentFundCall?.model ?? channels[0]?.model ?? null,
    channelId: storedAi?.channelId ?? recentFundCall?.channel_id ?? channels[0]?.id ?? null,
    channelHost: storedAi?.channelHost ?? channels[0]?.host ?? null,
    latencyMs: storedAi?.latencyMs ?? recentFundCall?.latency_ms ?? null,
    headline: aiOverviewValid ? storedAi!.headline : defaultHeadline,
    allocationAdvice: aiOverviewValid ? storedAi!.allocationAdvice : defaultAllocation,
    totalCount,
    primeCount,
    bottomAmbushCount,
    rightBreakoutCount,
    rangeDefenseCount,
    items,
  };
}
