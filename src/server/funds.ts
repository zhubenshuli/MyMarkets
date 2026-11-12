import { guardedFetch, requireOk } from "./lib/http-fetch.ts";
import { chatJson, loadChannels } from "./lib/llm.ts";
import { z } from "zod";
import { addDays, beijingDate } from "../shared/time.ts";
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
    thesis: "历经多年深度出清、估值处历史底部区间的逆周期医疗核心资产",
    isBuiltin: true,
  },
  {
    code: "515790",
    fullCode: "sh515790",
    name: "光伏ETF",
    sectorTag: "新能源光伏",
    thesis: "硅料组件产能出清尾声、困境反转高赔率观察品种",
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
    thesis: "A股算力光模块与大模型应用端右侧动量核心",
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
    thesis: "十四五/十五五订单周期拐点驱动、波段弹性突出",
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
    thesis: "全球科技巨头跨境配置、捕捉回撤时的折价低吸窗口",
    isBuiltin: true,
  },
];

const WATCHLIST_KEY = "markets.potential_funds_watchlist";
const AI_ANALYSIS_KEY = "markets.potential_funds_ai";

const roundTo = (n: number, decimals: number) => Number(n.toFixed(decimals));

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
  const emUrl = `${EASTMONEY_KLINE_URL}?secid=${secid}&klt=101&fqt=1&lmt=180&end=20500101&iscca=1&fields1=f1,f2,f3,f4,f5,f6,f7,f8&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61`;

  try {
    const res = requireOk(
      await guardedFetch(emUrl, {
        timeoutMs: 15_000,
        headers: { "user-agent": "Mozilla/5.0", referer: "https://quote.eastmoney.com" },
      }),
      fullCode,
    );
    return parseKlines(JSON.parse(res.text()), { includeOhlcv: true });
  } catch {
    // Fallback to Tencent kline
    const url = `${TENCENT_KLINE_URL}?param=${fullCode},day,,,180,qfq`;
    const res = requireOk(
      await guardedFetch(url, {
        timeoutMs: 15_000,
        headers: { "user-agent": "Mozilla/5.0", referer: "https://gu.qq.com" },
      }),
      fullCode,
    );
    return parseKlines(JSON.parse(res.text()), { includeOhlcv: true });
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
  series: Array<{ day: string; close: number; high?: number; low?: number; volume?: number }>,
  aiComment?: string | null,
): PotentialFundItem {
  const valid = series.filter((p) => Number.isFinite(p.close) && p.close > 0);
  if (valid.length === 0) {
    throw new Error(`No valid kline data for ${watchItem.code}`);
  }

  const latest = valid.at(-1)!;
  const price = latest.close;
  const day = latest.day;

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
  const getHigh = (p: { close: number; high?: number }) =>
    p.high !== undefined && Number.isFinite(p.high) && p.high > 0 ? Math.max(p.close, p.high) : p.close;
  const getLow = (p: { close: number; low?: number }) =>
    p.low !== undefined && Number.isFinite(p.low) && p.low > 0 ? Math.min(p.close, p.low) : p.close;

  const high120d = roundTo(Math.max(price, ...recent120.map(getHigh)), 3);
  const low120d = roundTo(Math.min(price, ...recent120.map(getLow)), 3);

  const span120 = Math.max(0.001, high120d - low120d);
  const percentile120d = roundTo(Math.max(0, Math.min(100, ((price - low120d) / span120) * 100)), 1);
  const drawdownFrom120dHighPct = high120d > 0 ? roundTo(price / high120d - 1, 4) : 0;

  let volumeRatio20d = tech.volumeRatio20d ?? null;
  let volumeSignal = tech.volumeSignal ?? "量能常态";

  // Effective volume ratio: if intraday volume is partial (< 0.60x), look back to yesterday's completed day for fair scoring
  let effectiveVolRatio = volumeRatio20d;
  if (volumeRatio20d != null && volumeRatio20d < 0.60 && valid.length >= 22) {
    const closed20 = valid.slice(-21, -1);
    const meanClosedVol = closed20.reduce((s, p) => s + (p.volume ?? 0), 0) / closed20.length;
    const yesterdayPt = valid.at(-2);
    if (meanClosedVol > 0 && yesterdayPt?.volume && yesterdayPt.volume > 0) {
      effectiveVolRatio = Number((yesterdayPt.volume / meanClosedVol).toFixed(2));
    }
  }

  // 3-Track Classification: bottom_ambush | right_breakout | range_defense
  const isDeepOversold = percentile120d <= 35 || drawdownFrom120dHighPct <= -0.16;
  const isDefensiveProfile =
    (high120d - low120d) / price <= 0.12 ||
    (Math.abs(drawdownFrom120dHighPct) <= 0.06 && (change1m ?? 0) < 0.04) ||
    /红利|低波|高股息|防御/i.test(watchItem.sectorTag ?? "");

  const hasBreakoutMomentum =
    (change1m ?? 0) >= 0.035 ||
    (change1w ?? 0) >= 0.018 ||
    (price >= high20d * 0.995 && (change1m ?? 0) >= 0.015);

  const isRightBullish =
    price >= ma20 * 0.995 &&
    ma10 >= ma20 * 0.995 &&
    percentile120d >= 35 &&
    hasBreakoutMomentum;

  let track: PotentialFundTrack = "range_defense";
  let trackLabel = "⚖️ 稳健防守";

  if (isDefensiveProfile && !isDeepOversold) {
    track = "range_defense";
    trackLabel = "⚖️ 稳健防守";
  } else if (isDeepOversold && !isRightBullish) {
    track = "bottom_ambush";
    trackLabel = "🛡️ 底部埋伏";
  } else if (isRightBullish && !isDeepOversold) {
    track = "right_breakout";
    trackLabel = "🚀 右侧启动";
  } else {
    // If neither deep oversold nor high-momentum breakout
    if (percentile120d >= 40 || Math.abs(drawdownFrom120dHighPct) <= 0.10) {
      track = "range_defense";
      trackLabel = "⚖️ 稳健防守";
    } else {
      track = "bottom_ambush";
      trackLabel = "🛡️ 底部埋伏";
    }
  }

  let score = 50;
  let entryBuyPrice = price;
  let entryBuyAnchor = "";
  let strongSupportPrice = price;
  let strongSupportAnchor = "";
  let strategyModeLabel = "";

  if (track === "bottom_ambush") {
    // 1. Valuation & Drawdown Odds (max 32 pts)
    let valScore = 0;
    if (percentile120d <= 15) valScore += 18;
    else if (percentile120d <= 25) valScore += 14;
    else if (percentile120d <= 35) valScore += 10;
    else if (percentile120d <= 50) valScore += 5;

    if (drawdownFrom120dHighPct <= -0.25) valScore += 14;
    else if (drawdownFrom120dHighPct <= -0.18) valScore += 11;
    else if (drawdownFrom120dHighPct <= -0.12) valScore += 7;
    else if (drawdownFrom120dHighPct <= -0.06) valScore += 4;

    // 2. Stabilization & Structure (max 28 pts)
    let stabScore = 8;
    if (price >= low20d * 1.008 && price <= low20d * 1.05) stabScore += 10;
    else if (price < low20d * 1.008) stabScore += 3;
    else stabScore += 6;

    if (ma20DiffPct >= -0.035 && ma20DiffPct <= 0.01) stabScore += 10;
    else if (ma20DiffPct < -0.035 && ma20DiffPct >= -0.07) stabScore += 6;
    else stabScore += 2;

    // 3. Volume Bottom Signal (max 18 pts)
    let volScore = 10;
    if (effectiveVolRatio != null) {
      if (effectiveVolRatio >= 0.70 && effectiveVolRatio <= 1.05 && (changeYesterday ?? 0) >= -0.01) {
        volScore = 15;
      } else if (effectiveVolRatio > 1.05 && effectiveVolRatio <= 1.50 && (changeYesterday ?? 0) > 0) {
        volScore = 18;
      } else if (effectiveVolRatio < 0.65) {
        volScore = 8;
      } else if (effectiveVolRatio >= 1.50 && (changeYesterday ?? 0) < -0.015) {
        volScore = 3;
      }
    }

    // Buy levels for bottom ambush
    const rawEntry = Math.min(price * 0.995, Math.max(low20d * 1.002, Math.min(ma20, ma10) * 0.992));
    entryBuyPrice = roundTo(rawEntry, 3);
    entryBuyAnchor = price <= ma20 ? "近20日箱体下沿低吸位" : "回踩 MA20 均线支撑位";
    strongSupportPrice = roundTo(Math.min(low20d * 0.985, low120d * 1.002), 3);
    strongSupportAnchor = "近120日前低强支撑";
    strategyModeLabel = percentile120d <= 25 ? "适合分批建底仓 / 开启低位定投" : "适合回踩支撑网格低吸";

    // 4. Nearness to entry buy price (max 12 pts, or penalty if chased too far)
    let entryScore = 0;
    const distanceToBuyPct = (price - entryBuyPrice) / entryBuyPrice;
    if (distanceToBuyPct <= 0.015 && distanceToBuyPct >= -0.015) {
      entryScore = 12;
    } else if (distanceToBuyPct <= 0.035) {
      entryScore = 6;
    } else if (distanceToBuyPct > 0.05) {
      entryScore = -6; // price too far above buy point, penalize
    }

    // 5. Penalties: fast falling knife or severe downtrend
    let penalty = 0;
    if ((change1w ?? 0) <= -0.035) penalty += 8;
    if (price < ma10 && ma10 < ma20 && ma20DiffPct < -0.05) penalty += 10;

    score = Math.min(92, Math.max(25, Math.round(valScore + stabScore + volScore + entryScore - penalty)));
  } else if (track === "right_breakout") {
    // 1. Trend breakout strength (max 35 pts)
    let trendScore = 12;
    if (price >= ma10 && ma10 >= ma20) trendScore = 32;
    else if (price >= ma20) trendScore = 22;
    if ((change1m ?? 0) > 0.02) trendScore += 3;

    // 2. Volume & price coordination (max 25 pts)
    let volScore = 12;
    if (effectiveVolRatio != null && effectiveVolRatio >= 1.15 && (changeYesterday ?? 0) >= 0) {
      volScore = 24;
    } else if ((change1w ?? 0) >= 0.01) {
      volScore = 18;
    }

    // Buy levels for right breakout
    const rawEntry = Math.min(price * 0.992, Math.max(ma20, ma10 * 0.995));
    entryBuyPrice = roundTo(rawEntry, 3);
    entryBuyAnchor = price >= ma10 ? "回踩 MA10 突破支撑位" : "回踩 MA20 趋势防守位";
    strongSupportPrice = roundTo(Math.min(ma20 * 0.975, low20d), 3);
    strongSupportAnchor = "MA20 趋势波段防守位";
    strategyModeLabel = ma20DiffPct > 0.05 ? "短线乖离偏大 · 等回踩均线再接" : "趋势走强 · 回踩均线右侧跟进";

    // 3. Nearness to entry buy price (max 20 pts)
    let entryScore = 4;
    const distanceToBuyPct = (price - entryBuyPrice) / entryBuyPrice;
    if (distanceToBuyPct <= 0.018) {
      entryScore = 20;
    } else if (distanceToBuyPct <= 0.035) {
      entryScore = 12;
    }

    // 4. Overheating / Chase penalty
    let penalty = 0;
    if (ma20DiffPct > 0.06) penalty += 12;
    if ((changeYesterday ?? 0) < -0.02 && effectiveVolRatio != null && effectiveVolRatio > 1.3) penalty += 8;

    score = Math.min(92, Math.max(25, Math.round(trendScore + volScore + entryScore - penalty)));
  } else {
    // range_defense
    // 1. Valuation & Resilience (max 30 pts)
    let valScore = 18;
    if (percentile120d >= 40 && percentile120d <= 75) valScore += 8;
    else if (percentile120d > 75) valScore += 4;
    if (Math.abs(drawdownFrom120dHighPct) <= 0.06) valScore += 4;

    // 2. Stability & Low Volatility (max 30 pts)
    let stabScore = 15;
    if (Math.abs(ma20DiffPct) <= 0.025) stabScore += 12;
    if (price >= low20d * 1.008) stabScore += 3;

    // Buy levels for range defense
    const rawEntry = roundTo(Math.min(price * 0.992, (ma20 + low20d) / 2), 3);
    entryBuyPrice = roundTo(rawEntry, 3);
    entryBuyAnchor = "箱体中轨回踩低吸位";
    strongSupportPrice = roundTo(low20d * 0.99, 3);
    strongSupportAnchor = "近20日箱体下沿防守";
    strategyModeLabel = "高股息防御底仓 · 箱体下沿逢低配置";

    // 3. Nearness to entry buy price (max 20 pts)
    let entryScore = 6;
    const distanceToBuyPct = (price - entryBuyPrice) / entryBuyPrice;
    if (distanceToBuyPct <= 0.015) {
      entryScore = 20;
    } else if (distanceToBuyPct <= 0.03) {
      entryScore = 12;
    }

    let penalty = 0;
    if ((changeYesterday ?? 0) < -0.02) penalty += 8;

    score = Math.min(85, Math.max(30, Math.round(valScore + stabScore + entryScore - penalty)));
  }

  const entryBuyDistancePct = price > 0 ? roundTo(entryBuyPrice / price - 1, 4) : 0;
  const isNearEntryZone = price <= entryBuyPrice * 1.018;

  // Signal tier with Price Trigger Lock
  let tier: PotentialFundTier = "wait";
  let tierLabel = "⏳ 耐心等待区";
  let tierTone: PorkStatusTone = "neutral";
  if (score >= 75) {
    if (isNearEntryZone) {
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
    tierLabel = "👀 重点观察区";
    tierTone = "accent";
  }

  // Fallback rule comment
  let ruleComment = "";
  if (tier === "prime") {
    if (track === "bottom_ambush") {
      ruleComment = `120日分位仅 ${percentile120d}%，距高点回撤 ${(drawdownFrom120dHighPct * 100).toFixed(1)}%，现价已进入建议低吸击球区 (¥${entryBuyPrice.toFixed(3)})，赔率优势凸显`;
    } else if (track === "right_breakout") {
      ruleComment = `均线多头共振，已回踩 MA10/MA20 确认支撑，处于黄金突破买点区间 (¥${entryBuyPrice.toFixed(3)})，顺势轻仓跟进`;
    } else {
      ruleComment = `防御底仓属性突出，当前贴近箱体中下轨 (¥${entryBuyPrice.toFixed(3)})，具备较高稳健抗跌与股息配置价值`;
    }
  } else if (tier === "watch") {
    if (score >= 75 && !isNearEntryZone) {
      const waitPct = (((price - entryBuyPrice) / entryBuyPrice) * 100).toFixed(1);
      ruleComment = `多因子评分优异(${score}分)，但现价距建仓点仍高 ${waitPct}%，严禁追高，耐心等待回踩 ¥${entryBuyPrice.toFixed(3)} 触发黄金击球`;
    } else if (track === "bottom_ambush") {
      ruleComment = `底部震荡蓄势中，短期仍有波动，建议等待价格贴近 ¥${entryBuyPrice.toFixed(3)} 再分批埋伏`;
    } else if (track === "right_breakout") {
      ruleComment = `右侧动能初现，等待进一步缩量回踩 MA20 (¥${ma20.toFixed(3)}) 确认支撑有效性`;
    } else {
      ruleComment = `处于箱体中上轨震荡，等待回踩支撑位 ¥${entryBuyPrice.toFixed(3)} 附近低吸`;
    }
  } else {
    ruleComment =
      track === "bottom_ambush"
        ? `处于单边下跌或未见缩量企稳信号，建议保持观望防接飞刀`
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
    percentile120d,
    drawdownFrom120dHighPct,
    volumeRatio20d,
    volumeSignal,
    entryBuyPrice,
    entryBuyDistancePct,
    entryBuyAnchor,
    strongSupportPrice,
    strongSupportAnchor,
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
  model?: string | null;
  channelId?: string | null;
  channelHost?: string | null;
  latencyMs?: number | null;
};

export async function refreshPotentialFundsDaily(
  now: Date,
  opts?: { force?: boolean; skipQuotes?: boolean; skipAi?: boolean },
): Promise<PotentialFundsOverview> {
  const watchlist = getPotentialFundsWatchlist();
  const dayStr = beijingDate(now);

  // 1. Fetch & upsert K-lines if not skipQuotes
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
  }

  // 2. Load closes and evaluate preliminary items
  const allCloses = getRecentCloses(180);
  const preliminaryItems = watchlist.map((item) => {
    const symbol = `pf_${item.code}`;
    const series = allCloses.filter((r) => r.symbol === symbol);
    if (series.length > 0) {
      return evaluatePotentialFund(item, series);
    }
    // Fallback if not yet in DB
    return evaluatePotentialFund(item, [{ day: dayStr, close: 1.0, high: 1.0, low: 1.0, volume: 1000 }]);
  });

  // 3. AI review batch call if enabled
  let storedAi: StoredAiAnalysis | null = null;
  if (!opts?.skipAi && process.env.MODEL_CALLS_ENABLED === "true") {
    try {
      const fundSummaries = preliminaryItems.map((p) => {
        return `- ${p.name} (${p.code}, ${p.sectorTag}): 现价 ¥${p.price.toFixed(3)}, 近1月 ${p.change1m ? `${(p.change1m * 100).toFixed(1)}%` : "平"}, 120日分位 ${p.percentile120d}%, 距高点回撤 ${(p.drawdownFrom120dHighPct * 100).toFixed(1)}%, 轨道: ${p.trackLabel}, 评分: ${p.score} (${p.tierLabel}), 建议低吸价: ¥${p.entryBuyPrice.toFixed(3)}`;
      });

      const systemPrompt = `你是一位精通 A 股跨行业 ETF 配置、行业周期轮动与技术波段的资深量化基金经理。
请严格基于提供的潜力基金池实时量化数据，输出跨赛道宏观机会研判及每只基金的一句话精练点评。
严格输出合法 JSON 对象，字段名完全一致：
{
  "headline": "跨赛道机会总览（1句话，40字以内，点名当前处于黄金击球区且赔率或动能突出的核心品种）",
  "allocationAdvice": "底部埋伏（低估反转）、右侧动量（突破跟进）与稳健防守（高股息/跨市场）三轨配置建议（60~90字，说明当下资金应如何在超跌赛道与右侧强势板块间平衡仓位）",
  "fundComments": [
    { "code": "6位基金代码", "comment": "针对该基金的结合回撤分位、均线支撑与赛道逻辑的一句话精评（28~42字）" }
  ]
}
注意：字符串内容内部严禁使用英文双引号（"），如需引号请使用中文引号（「」或“”）。`;

      const userPrompt = `今日潜力基金观察池多因子量化评估数据（基准日 ${dayStr}）：\n${fundSummaries.join("\n")}\n\n请生成跨赛道宏观总览与各基金逐项解读 JSON。`;

      const aiRes = await chatJson({
        system: systemPrompt,
        user: userPrompt,
        schema: PotentialFundsAiSchema,
        temperature: 0.2,
        maxTokens: 2500,
        purpose: "potential_funds_analysis",
        subject: `potential_funds:${dayStr}`,
      });

      storedAi = {
        ...aiRes.data,
        analyzedAt: new Date().toISOString(),
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

  return readPotentialFundsOverview();
}

export async function readPotentialFundsOverview(skipAnalysis = false): Promise<PotentialFundsOverview> {
  const watchlist = getPotentialFundsWatchlist();
  const allCloses = getRecentCloses(180);
  const storedAi = getStoredJson<StoredAiAnalysis>(AI_ANALYSIS_KEY);

  const aiCommentMap = new Map<string, string>();
  if (storedAi && Array.isArray(storedAi.fundComments)) {
    for (const fc of storedAi.fundComments) {
      aiCommentMap.set(fc.code, fc.comment);
    }
  }

  const items: PotentialFundItem[] = [];
  for (const item of watchlist) {
    const symbol = `pf_${item.code}`;
    const series = allCloses.filter((r) => r.symbol === symbol);
    if (series.length > 0) {
      const fund = evaluatePotentialFund(item, series, aiCommentMap.get(item.code));
      items.push(fund);
    }
  }

  // Sort by score DESC
  items.sort((a, b) => b.score - a.score);

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

  const defaultAllocation = `三轨精选配置：底部超跌（${bottomAmbushCount}只）分批建立底仓；右侧动量（${rightBreakoutCount}只）待均线回踩跟进；稳健防守（${rangeDefenseCount}只）在箱体下沿配置，严禁追高。`;

  const channels = loadChannels();
  const recentCalls = getLlmCallsSince(null, 20);
  const recentFundCall = recentCalls.find(
    (c) => c.status === "completed" && (c.purpose === "potential_funds_analysis" || c.subject?.startsWith("potential_funds")),
  );

  return {
    updatedAt: storedAi?.analyzedAt ?? new Date().toISOString(),
    source: storedAi ? "ai" : "rules",
    model: storedAi?.model ?? recentFundCall?.model ?? channels[0]?.model ?? null,
    channelId: storedAi?.channelId ?? recentFundCall?.channel_id ?? channels[0]?.id ?? null,
    channelHost: storedAi?.channelHost ?? channels[0]?.host ?? null,
    latencyMs: storedAi?.latencyMs ?? recentFundCall?.latency_ms ?? null,
    headline: storedAi?.headline ?? defaultHeadline,
    allocationAdvice: storedAi?.allocationAdvice ?? defaultAllocation,
    totalCount,
    primeCount,
    bottomAmbushCount,
    rightBreakoutCount,
    rangeDefenseCount,
    items,
  };
}
