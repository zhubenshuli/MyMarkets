import { guardedFetch } from "./lib/http-fetch.ts";
import { chatJson } from "./lib/llm.ts";
import { z } from "zod";
import {
  getDailyFrozenPlan,
  getDb,
  getPositionSnapshots,
  getRecentCloses,
  setDailyFrozenPlan,
} from "./db.ts";
import { beijingDate, beijingTime } from "../shared/time.ts";
import type {
  ActionPointItem,
  IntradayActionPointCheck,
  IntradayCheckResult,
  IntradayChecklistItem,
  IntradayDcaLumpSumCheck,
  IntradayDistanceStatus,
  IntradayLiveContext,
  IntradayLiveQuoteItem,
  IntradaySessionPhase,
  IntradayVerdict,
  PositionPlanDetail,
  PositionTargetSymbol,
} from "../shared/types.ts";
import { readMarkets } from "./quotes.ts";

export interface TencentQuoteItem {
  code: string;
  name: string;
  price: number;
  prevClose: number;
  open: number;
  volume: number;
  timeStr: string;
  change: number;
  changePct: number;
  high: number;
  low: number;
  volumeRatio: number | null;
  vwap: number | null;
  iopv: number | null;
  discountPremiumPct: number | null;
  intradayPositionPct: number | null;
}

export const INTRADAY_TARGET_MAP: Record<
  PositionTargetSymbol,
  {
    primaryCode: string;
    primaryName: string;
    relatedCodes: string[];
    decimals: number;
  }
> = {
  etf_516670: {
    primaryCode: "sh516670",
    primaryName: "畜牧养殖ETF",
    relatedCodes: ["sz002714", "sz300498", "sh000300"],
    decimals: 3,
  },
  cea_600115: {
    primaryCode: "sh600115",
    primaryName: "中国东航",
    relatedCodes: ["hk00670", "sh000001"],
    decimals: 2,
  },
  etf_513180: {
    primaryCode: "sh513180",
    primaryName: "恒生科技ETF",
    relatedCodes: ["hkHSTECH", "hk00700", "hk09988"],
    decimals: 3,
  },
};

/**
 * Determine the intraday session phase from a Beijing time string "HH:mm".
 */
export function getIntradaySessionPhase(timeStr: string): {
  phase: IntradaySessionPhase;
  hint: string;
} {
  if (timeStr < "09:30") {
    return { phase: "pre_open", hint: "盘前集合竞价 / 未开盘" };
  }
  if (timeStr >= "09:30" && timeStr < "11:30") {
    return { phase: "morning_trading", hint: "早盘连续竞价" };
  }
  if (timeStr >= "11:30" && timeStr < "13:00") {
    return { phase: "lunch_break", hint: "午间休市中" };
  }
  if (timeStr >= "13:00" && timeStr < "14:30") {
    return { phase: "afternoon_trading", hint: "午后连续竞价" };
  }
  if (timeStr >= "14:30" && timeStr <= "15:00") {
    return { phase: "closing_window", hint: "尾盘决策窗口（14:30–15:00）" };
  }
  return { phase: "post_close", hint: "今日已收盘" };
}

/**
 * Parse Tencent qt.gtimg.cn quote string (GBK decoded).
 */
export function parseTencentQuotes(text: string): Record<string, TencentQuoteItem> {
  const result: Record<string, TencentQuoteItem> = {};
  const lines = text.split(";");

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = /^v_([a-zA-Z0-9]+)="([^"]*)"/.exec(trimmed);
    if (!match) continue;

    const fullCode = match[1]!;
    const parts = match[2]!.split("~");
    if (parts.length < 35) continue;

    const name = parts[1] ?? fullCode;
    const price = parseFloat(parts[3] ?? "0") || 0;
    const prevClose = parseFloat(parts[4] ?? "0") || price;
    const open = parseFloat(parts[5] ?? "0") || price;
    const volume = parseFloat(parts[6] ?? "0") || 0;

    let timeStr = "";
    const rawTime = parts[30] ?? "";
    if (rawTime.length === 14) {
      // YYYYMMDDHHMMSS -> HH:MM:SS
      timeStr = `${rawTime.slice(8, 10)}:${rawTime.slice(10, 12)}:${rawTime.slice(12, 14)}`;
    } else if (rawTime.includes(" ")) {
      timeStr = rawTime.split(" ")[1] ?? rawTime;
    }

    const change = parseFloat(parts[31] ?? "0") || (prevClose > 0 ? price - prevClose : 0);
    const changePct = (parseFloat(parts[32] ?? "0") || (prevClose > 0 ? (price / prevClose - 1) * 100 : 0)) / 100;
    const high = parseFloat(parts[33] ?? "0") || price;
    const low = parseFloat(parts[34] ?? "0") || price;

    // Volume ratio (量比)
    const volumeRatio = parts[49] && parts[49] !== "" ? parseFloat(parts[49]) : null;

    // VWAP
    let vwap: number | null = parts[51] && parts[51] !== "" ? parseFloat(parts[51]) : null;
    if (!vwap || vwap <= 0) {
      // Try to compute from parts[35]: "price/volume/turnover"
      const sub35 = parts[35]?.split("/") ?? [];
      if (sub35.length >= 3) {
        const tVol = parseFloat(sub35[1] ?? "0");
        const tAmt = parseFloat(sub35[2] ?? "0");
        if (tVol > 0 && tAmt > 0) {
          vwap = Number((tAmt / (tVol * 100)).toFixed(3));
        }
      }
    }

    // IOPV & discount/premium % for ETF
    const iopv = parts[78] && parts[78] !== "" ? parseFloat(parts[78]) : null;
    let discountPremiumPct: number | null =
      parts[77] && parts[77] !== "" ? parseFloat(parts[77]) / 100 : null;
    if (discountPremiumPct === null && iopv && iopv > 0 && price > 0) {
      discountPremiumPct = Number(((price - iopv) / iopv).toFixed(4));
    }

    // Intraday position: (price - low) / (high - low)
    let intradayPositionPct: number | null = null;
    if (high > low) {
      intradayPositionPct = Number(((price - low) / (high - low)).toFixed(3));
    } else {
      intradayPositionPct = 0.5;
    }

    result[fullCode] = {
      code: fullCode,
      name,
      price,
      prevClose,
      open,
      volume,
      timeStr,
      change,
      changePct,
      high,
      low,
      volumeRatio,
      vwap,
      iopv,
      discountPremiumPct,
      intradayPositionPct,
    };
  }

  return result;
}

/**
 * Fetch real-time snapshots from Tencent qt.gtimg.cn.
 */
export async function fetchTencentBatchQuotes(symbols: string[]): Promise<Record<string, TencentQuoteItem>> {
  if (symbols.length === 0) return {};
  const url = `http://qt.gtimg.cn/q=${symbols.join(",")}`;
  const res = await guardedFetch(url, { timeoutMs: 5_000 });
  const text = new TextDecoder("gbk").decode(res.body);
  return parseTencentQuotes(text);
}

/**
 * Retrieve the daily frozen plan for the given symbol, or freeze today's baseline if not yet frozen.
 */
export async function getOrFreezeDailyPlan(
  symbol: PositionTargetSymbol,
  targetDay?: string,
): Promise<PositionPlanDetail> {
  const day = targetDay ?? beijingDate(new Date());
  const existing = getDailyFrozenPlan(symbol, day);
  if (existing) {
    // Verify that the latest position snapshot hasn't changed since this plan was frozen
    const latestRows = getPositionSnapshots(symbol);
    const latestRow = latestRows.at(-1);
    const snapshotStillMatches =
      !latestRow ||
      (existing.latestSnapshot?.id === latestRow.id &&
        existing.latestSnapshot?.shares === latestRow.shares &&
        Math.abs(
          (existing.latestSnapshot?.marketValue ?? 0) - latestRow.market_value,
        ) < 0.01);
    if (snapshotStillMatches) {
      existing.frozenDate = day;
      return existing;
    }
  }

  // Calculate fresh plan from yesterday/latest closes to freeze
  const markets = await readMarkets({ skipAnalysis: false });
  let plan: PositionPlanDetail | undefined;

  if (symbol === "etf_516670") {
    plan = markets.analysis?.etfGuidance?.positionPlan ?? undefined;
  } else if (symbol === "cea_600115") {
    plan = markets.aviationAnalysis?.etfGuidance?.positionPlan ?? undefined;
  } else if (symbol === "etf_513180") {
    plan = markets.hstechAnalysis?.etfGuidance?.positionPlan ?? undefined;
  }

  if (!plan) {
    throw new Error(`Failed to calculate baseline position plan for ${symbol}`);
  }

  const frozen: PositionPlanDetail = {
    ...plan,
    frozenDate: day,
  };

  setDailyFrozenPlan(symbol, day, frozen);
  return frozen;
}

/**
 * Evaluate intraday verification rules for grid targets (516670 and 600115).
 */
export function evaluateGridActionPointRules(
  symbol: PositionTargetSymbol,
  liveContext: IntradayLiveContext,
  frozenPlan: PositionPlanDetail,
  currentTimeStr: string,
): IntradayActionPointCheck[] {
  const cfg = INTRADAY_TARGET_MAP[symbol];
  const decimals = cfg.decimals;
  const isCea = symbol === "cea_600115";
  const { currentPrice, changePct, vwap, volumeRatio, intradayPositionPct, discountPremiumPct, relatedQuotes } =
    liveContext;

  const results: IntradayActionPointCheck[] = [];
  const actionPoints = frozenPlan.actionPoints ?? [];

  // Find related leader changes
  let maxRelatedDrop = 0;
  let maxRelatedSurge = 0;
  if (relatedQuotes && relatedQuotes.length > 0) {
    for (const r of relatedQuotes) {
      if (r.changePct < -maxRelatedDrop) maxRelatedDrop = -r.changePct;
      if (r.changePct > maxRelatedSurge) maxRelatedSurge = r.changePct;
    }
  }

  const isOpeningNoiseWindow = currentTimeStr >= "09:30" && currentTimeStr < "09:45";

  for (const pt of actionPoints) {
    const triggerPrice = pt.triggerPrice;
    if (triggerPrice === null) {
      results.push({
        kind: pt.kind,
        label: pt.label,
        triggerPrice: null,
        currentPrice,
        distancePct: 0,
        distanceStatus: "far",
        distanceHint: "未设定触发位",
        verdict: "none",
        verdictText: "暂不触发",
        checklist: [],
        ruleReason: pt.disabledReason ?? "当前档位未开放",
      });
      continue;
    }

    const distancePct = (currentPrice - triggerPrice) / triggerPrice;
    const isBuy = pt.kind === "buy1" || pt.kind === "buy2";
    const isBuy1 = pt.kind === "buy1";
    const isBuy2 = pt.kind === "buy2";
    const isSell1 = pt.kind === "sell1";
    const isSell2 = pt.kind === "sell2";

    let distanceStatus: IntradayDistanceStatus = "far";
    let distanceHint = "";

    if (isBuy) {
      if (currentPrice <= triggerPrice) {
        distanceStatus = "reached";
        distanceHint = `🟢 已触达买点（现价 ¥${currentPrice.toFixed(decimals)}）`;
      } else if (currentPrice <= triggerPrice * (isBuy1 ? 1.008 : 1.01)) {
        distanceStatus = "near";
        distanceHint = `🟡 接近${pt.label.slice(0, 4)} (${(distancePct * 100).toFixed(2)}%)`;
      } else if (liveContext.lowPrice <= triggerPrice && currentPrice > triggerPrice * 1.008) {
        distanceStatus = "missed";
        distanceHint = `⚫ 盘中曾触及（最低 ¥${liveContext.lowPrice.toFixed(decimals)}），现已离开不追单`;
      } else {
        distanceStatus = "far";
        distanceHint = `⚪ 距${pt.label.slice(0, 4)} ${(distancePct * 100).toFixed(1)}% · 安心等待`;
      }
    } else {
      // Sell point
      if (currentPrice >= triggerPrice) {
        distanceStatus = "reached";
        distanceHint = `🔴 已触达卖点（现价 ¥${currentPrice.toFixed(decimals)}）`;
      } else if (currentPrice >= triggerPrice * 0.992) {
        distanceStatus = "near";
        distanceHint = `🟡 接近${pt.label.slice(0, 4)} (${(distancePct * 100).toFixed(2)}%)`;
      } else if (liveContext.highPrice >= triggerPrice && currentPrice < triggerPrice * 0.992) {
        distanceStatus = "missed";
        distanceHint = `⚫ 盘中曾触及（最高 ¥${liveContext.highPrice.toFixed(decimals)}），现已回落不追单`;
      } else {
        distanceStatus = "far";
        distanceHint = `⚪ 距${pt.label.slice(0, 4)} ${distancePct >= 0 ? "+" : ""}${(distancePct * 100).toFixed(1)}% · 锁仓持有`;
      }
    }

    const checklist: IntradayChecklistItem[] = [];
    let verdict: IntradayVerdict = "none";
    let verdictText = "未到触发位";
    let ruleReason = "";
    let recheckCondition: string | undefined;

    if (isBuy1) {
      const chk1 = !isOpeningNoiseWindow;
      checklist.push({ text: "非开盘乱波期 (09:30–09:45)", passed: chk1 });

      const chk2 = vwap === null || currentPrice >= vwap || (intradayPositionPct !== null && intradayPositionPct >= 0.2);
      checklist.push({
        text: `均价线企稳 (${vwap ? `均价¥${vwap.toFixed(decimals)}` : "温和整理"})`,
        passed: chk2,
      });

      const dropLimit = isCea ? -0.035 : -0.025;
      const chk3 = !(changePct <= dropLimit && (volumeRatio ?? 1) >= 1.8 && (intradayPositionPct ?? 0.5) < 0.2);
      checklist.push({
        text: `未见单边急跌 (${(changePct * 100).toFixed(2)}%)`,
        passed: chk3,
      });

      const chk4 = maxRelatedDrop < 0.03;
      checklist.push({
        text: `权重龙头未现恐慌踩踏 (龙头最深 -${(maxRelatedDrop * 100).toFixed(1)}%)`,
        passed: chk4,
      });

      const chk5 = discountPremiumPct === null || discountPremiumPct <= 0.006;
      if (symbol === "etf_516670" && discountPremiumPct !== null) {
        checklist.push({
          text: `ETF场内溢价合理 (${(discountPremiumPct * 100).toFixed(2)}%)`,
          passed: chk5,
        });
      }

      if (distanceStatus === "reached" || distanceStatus === "near") {
        if (!chk1) {
          verdict = "hold";
          verdictText = "⏸ 暂缓执行";
          ruleReason = "处于 09:30–09:45 开盘乱波期，建议观望防脉冲诱多/急杀。";
          recheckCondition = "待 09:45 盘面多空方向明朗后再执行。";
        } else if (!chk3) {
          verdict = "hold";
          verdictText = "⏸ 暂缓执行";
          ruleReason = "放量单边急杀且现价处于均价线下方创新低，建议先撤单防接飞刀。";
          recheckCondition = "待 14:45 尾盘站稳分时均价线上方或企稳反弹再执行；若尾盘仍创新低则今日放弃买1守买2。";
        } else if (!chk4) {
          verdict = "hold";
          verdictText = "⏸ 暂缓执行";
          ruleReason = "权重龙头同步大跌超 3%，共振杀跌风险大，建议暂缓观望。";
          recheckCondition = "待龙头止跌回稳且标的站稳均价线后再择机低吸。";
        } else if (!chk5) {
          verdict = "hold";
          verdictText = "⏸ 暂缓执行";
          ruleReason = "ETF 盘中溢价率偏高 (>+0.6%)，买入成本过高，建议暂缓。";
          recheckCondition = "待溢价率回落至 +0.3% 以内再执行买入。";
        } else {
          verdict = "execute";
          verdictText = "✅ 按计划执行";
          ruleReason = "回踩支撑位且量能温和、未见单边踩踏，按计划执行挂单/成交。";
        }
      }
    } else if (isBuy2) {
      const chk1 = !(changePct <= -0.045 && (volumeRatio ?? 1) >= 2.2 && (intradayPositionPct ?? 0.5) < 0.1);
      checklist.push({
        text: `避开极端无底恐慌踩踏 (${(changePct * 100).toFixed(2)}%)`,
        passed: chk1,
      });

      const isTailWindow = currentTimeStr >= "14:45";
      checklist.push({
        text: `尾盘先手保护窗口 (${isTailWindow ? "已到尾盘必拿筹码" : "盘中避开尖峰"})`,
        passed: isTailWindow || chk1,
      });

      if (distanceStatus === "reached" || distanceStatus === "near") {
        if (!chk1 && !isTailWindow) {
          verdict = "hold";
          verdictText = "⏸ 暂缓执行";
          ruleReason = "遭遇极端恐慌踩踏且正在日内最低点下杀，盘中先避开急跌尖峰，等 14:45 尾盘再拿先手筹码。";
          recheckCondition = "14:45 尾盘复查时，只要不再封死跌停，一律转为「✅ 执行」拿先手筹码。";
        } else {
          verdict = "execute";
          verdictText = "✅ 按计划执行";
          ruleReason = "触及大跌强支撑黄金坑，带反弹卖半留半纪律，执行加码。";
        }
      }
    } else if (isSell1) {
      const chk1 = !isOpeningNoiseWindow;
      checklist.push({ text: "非开盘脉冲期 (09:30–09:45)", passed: chk1 });

      const surgeLimit = isCea ? 0.035 : 0.025;
      const isLeaderSkyrocketing = maxRelatedSurge >= 0.04;
      const isSurgingTrend =
        changePct >= surgeLimit &&
        vwap !== null &&
        currentPrice >= vwap &&
        isLeaderSkyrocketing;

      checklist.push({
        text: `非主升浪逼空 (龙头最高 +${(maxRelatedSurge * 100).toFixed(1)}%)`,
        passed: !isSurgingTrend,
      });

      if (distanceStatus === "reached" || distanceStatus === "near") {
        if (!chk1) {
          verdict = "hold";
          verdictText = "⏸ 暂缓执行";
          ruleReason = "处于 09:30–09:45 开盘脉冲期，先看多头能否站稳均价线。";
          recheckCondition = "待 09:45 后若回落且现价跌破均价线，可择机做T。";
        } else if (isSurgingTrend) {
          verdict = "hold";
          verdictText = "⏸ 暂缓执行（惜售防卖飞）";
          ruleReason = "板块龙头集体井喷领跑，现价稳居分时均线之上，触发惜售保护防卖飞，让利润奔跑到卖2或留待明日更高位兑现！";
          recheckCondition = "若盘中冲高回落跌破分时均价线且仍在卖1上方，可执行止盈；若直到 14:45 依然强势封在日内高位，今日惜售不卖。";
        } else {
          verdict = "execute";
          verdictText = "✅ 按计划执行";
          ruleReason = "触及近期压力位，弱势冲高回落，按纪律卖出 1,000 股做T落袋利润。";
        }
      }
    } else if (isSell2) {
      checklist.push({
        text: "波段脉冲冲高极值区 (MA20正乖离超买，触及即执行)",
        passed: true,
      });

      if (distanceStatus === "reached" || distanceStatus === "near") {
        verdict = "execute";
        verdictText = "✅ 按计划执行";
        ruleReason = "触及波段脉冲冲高极值区（MA20正乖离超买），纪律性止盈机动仓落袋现金利润入池（底仓坚决锁仓）。";
      }
    }

    results.push({
      kind: pt.kind,
      label: pt.label,
      triggerPrice,
      currentPrice,
      distancePct,
      distanceStatus,
      distanceHint,
      verdict,
      verdictText,
      checklist,
      ruleReason,
      recheckCondition,
    });
  }

  return results;
}

/**
 * Evaluate intraday rules for Hang Seng Tech OTC (513180): "14:30–14:55 whether to top up ¥1,000".
 */
export function evaluateDcaLumpSumRules(
  liveContext: IntradayLiveContext,
  currentTimeStr: string,
): IntradayDcaLumpSumCheck {
  const currentPrice = liveContext.currentPrice;
  const supportLevel1 = 0.458;
  const supportLevel2 = 0.440;

  // 1. Time Decision Window (14:30 - 14:55)
  const isInDecisionWindow = currentTimeStr >= "14:30" && currentTimeStr <= "14:55";
  let windowHint = "";
  if (currentTimeStr < "14:30") {
    windowHint = "🕒 盘中预判阶段（正式拍板建议在 14:30–14:55 决策窗内点击）";
  } else if (isInDecisionWindow) {
    windowHint = "🎯 尾盘正式拍板决策窗（15:00 前申购按今日净值成交）";
  } else {
    windowHint = "⌛ 今日 15:00 申购已截止（若此时下单将按明日收盘净值成交）";
  }

  // 2. 5-day drop calculation
  const db = getDb();
  const rows = db
    .prepare("SELECT close FROM market_daily_closes WHERE symbol = 'etf_513180' ORDER BY day DESC LIMIT 6")
    .all() as Array<{ close: number }>;
  const baseClose5d = rows.length >= 6 ? rows[5]!.close : rows.at(-1)?.close ?? currentPrice;
  const priceDrop5dPct = baseClose5d > 0 ? (currentPrice - baseClose5d) / baseClose5d : 0;

  const reachedSupport = currentPrice <= supportLevel1 || priceDrop5dPct <= -0.06;

  // 3. Cooldown check: past 7 calendar days snapshots
  const snapshots = getPositionSnapshots("etf_513180");
  const sevenDaysAgo = beijingDate(Date.now() - 7 * 86400000);
  const recentAdds = snapshots.filter((s) => s.day >= sevenDaysAgo && (s.note?.includes("加仓") || s.note?.includes("¥1,000") || s.note?.includes("1000")));
  const hasRecentLumpSum = recentAdds.length > 0;

  let cooldownPassed = true;
  let cooldownNote = "冷却锁通过（近5个交易日内未追加过单笔 ¥1,000）";
  if (hasRecentLumpSum) {
    if (currentPrice <= supportLevel2) {
      cooldownPassed = true;
      cooldownNote = `已跌破深水支撑 ¥${supportLevel2.toFixed(3)}，允许打破5日冷却限制再次加仓！`;
    } else {
      cooldownPassed = false;
      cooldownNote = `近5个交易日内已加仓过一次，且未跌破深水支撑 ¥${supportLevel2.toFixed(3)}，保持防连跌冷却锁。`;
    }
  }

  // 4. HK Tech Index panic dumping check
  let panicDump = false;
  const hkTechQuote = liveContext.relatedQuotes?.find((r) => r.symbol === "hkHSTECH");
  if (hkTechQuote && hkTechQuote.changePct <= -0.035) {
    panicDump = true;
  }

  const checklist: IntradayChecklistItem[] = [
    {
      text: `到达强支撑位 (周跌${(priceDrop5dPct * 100).toFixed(1)}% / 现价¥${currentPrice.toFixed(3)} ≤ ¥${supportLevel1})`,
      passed: reachedSupport,
    },
    {
      text: cooldownNote,
      passed: cooldownPassed,
    },
    {
      text: `港股尾盘未现恐慌杀跌 (恒科指 ${hkTechQuote ? `${(hkTechQuote.changePct * 100).toFixed(1)}%` : "正常"})`,
      passed: !panicDump,
    },
    {
      text: `处于 14:30–14:55 决策窗口 (${isInDecisionWindow ? "正是拍板时" : "预判中"})`,
      passed: isInDecisionWindow,
    },
  ];

  let verdict: IntradayVerdict = "hold";
  let verdictText = "⏸ 暂缓（今日不追加）";
  let ruleReason = "";

  if (!reachedSupport) {
    verdict = "hold";
    verdictText = "⏸ 暂缓（今日不追加）";
    ruleReason = "未达大跌强支撑位（周跌未满6%且未破¥0.458），维持每日日常定投即可，不盲目追加。";
  } else if (!cooldownPassed) {
    verdict = "hold";
    verdictText = "⏸ 暂缓（本周额度已用）";
    ruleReason = cooldownNote;
  } else if (panicDump) {
    verdict = "hold";
    verdictText = "⏸ 暂缓（推迟至明日 14:30）";
    ruleReason = "港股恒生科技指数尾盘仍在放量暴跌创新低，15:00–16:00 恐继续下探，推迟至明日尾盘再看。";
  } else {
    verdict = "execute";
    verdictText = "✅ 执行：今日 15:00 前手动追加 ¥1,000";
    ruleReason = "已破强支撑位且尾盘企稳缩量，未触发恐慌踩踏，今日 15:00 前建议在券商/天天基金手动追加单笔 ¥1,000（优先动用加码池）。";
  }

  return {
    currentPrice,
    priceDrop5dPct,
    supportLevel1,
    supportLevel2,
    isInDecisionWindow,
    windowHint,
    cooldownPassed,
    cooldownNote,
    verdict,
    verdictText,
    checklist,
    ruleReason,
  };
}

const GridReviewItemSchema = z.object({
  kind: z.enum(["buy1", "buy2", "sell1", "sell2"]),
  aiVerdict: z.enum(["execute", "hold"]),
  aiReason: z.string().describe("45字以内的一句话简明复核理由"),
});

const IntradayGridAiReviewSchema = z.union([
  z.object({
    reviews: z.array(GridReviewItemSchema),
  }),
  z.array(GridReviewItemSchema).transform((arr) => ({ reviews: arr })),
]);

const IntradayDcaAiReviewSchema = z.object({
  aiVerdict: z.enum(["execute", "hold"]),
  aiReason: z.string().describe("45字以内的一句话简明复核理由"),
});

/**
 * AI review layer with unidirectional safety valve:
 * AI can only downgrade "execute" to "hold", never promote "hold" to "execute"!
 */
export async function reviewIntradayWithAi(
  symbol: PositionTargetSymbol,
  liveContext: IntradayLiveContext,
  actionChecks?: IntradayActionPointCheck[],
  dcaCheck?: IntradayDcaLumpSumCheck,
): Promise<{ reviewed: boolean; model?: string }> {
  try {
    if (symbol === "etf_513180" && dcaCheck) {
      // Only call AI if reaching support or in decision window
      if (!dcaCheck.checklist[0]!.passed && !dcaCheck.isInDecisionWindow) {
        return { reviewed: false };
      }

      const prompt = `你是拥有20年实战经验的ETF纪律性交易员。
请复核今日恒生科技场外基金（513180）尾盘是否追加 ¥1,000 单笔加码：
- 现价: ¥${liveContext.currentPrice.toFixed(3)}
- 近5日累计跌幅: ${(dcaCheck.priceDrop5dPct * 100).toFixed(1)}%
- 恒生科技指数当日表现: ${liveContext.relatedQuotes?.find((q) => q.symbol === "hkHSTECH")?.changePct ?? 0}%
- 规则引擎初步判定: ${dcaCheck.verdict} (${dcaCheck.verdictText})
- 规则理由: ${dcaCheck.ruleReason}

请给出最终复核结论（execute 或 hold）与 45 字以内的极简诊断理由。`;

      const aiRes = await chatJson({
        system: "你只输出严格符合 JSON Schema 的投资复核结论，理由务必精炼硬核，控制在45字以内。",
        user: prompt,
        schema: IntradayDcaAiReviewSchema,
        temperature: 0.2,
        maxTokens: 500,
        purpose: "intraday_review",
        subject: `${symbol}:${liveContext.snapshotTime}`,
      });

      const { aiVerdict, aiReason } = aiRes.data;
      dcaCheck.aiReason = aiReason;
      dcaCheck.aiVerdict = aiVerdict;

      // UNIDIRECTIONAL SAFETY VALVE: AI cannot override rule-based "hold" to "execute"
      if (dcaCheck.verdict === "hold") {
        // keep hold
      } else if (dcaCheck.verdict === "execute" && aiVerdict === "hold") {
        dcaCheck.verdict = "hold";
        dcaCheck.verdictText = "⏸ 建议暂缓（AI复核降级）";
      }

      return { reviewed: true, model: aiRes.model };
    }

    if (actionChecks && actionChecks.length > 0) {
      // Only review if at least one point is near or reached
      const activeChecks = actionChecks.filter(
        (c) => c.distanceStatus === "near" || c.distanceStatus === "reached",
      );
      if (activeChecks.length === 0) {
        return { reviewed: false };
      }

      const prompt = `你是拥有20年实战经验的ETF网格与波段量化交易员。
请复核今日标的【${liveContext.name} (${symbol})】在盘中的触及或接近点位：
- 当前盘中现价: ¥${liveContext.currentPrice}
- 涨跌幅: ${(liveContext.changePct * 100).toFixed(2)}%
- 分时均价 (VWAP): ¥${liveContext.vwap ?? "无"}
- 实时量比: ${liveContext.volumeRatio ?? "无"}
- 联动龙头走势: ${liveContext.relatedQuotes?.map((q) => `${q.name} ${(q.changePct * 100).toFixed(1)}%`).join("，") ?? "无"}

当前处于决策窗的点位：
${activeChecks
  .map(
    (c) =>
      `- [${c.kind}] 触发价 ¥${c.triggerPrice} (距现价 ${(c.distancePct * 100).toFixed(2)}%)，规则建议: ${c.verdict} (${c.ruleReason})`,
  )
  .join("\n")}

请针对上述点位逐一复核，必须输出如下 JSON 格式：
{
  "reviews": [
    {
      "kind": "点位名称如 sell1 或 buy1",
      "aiVerdict": "execute" 或 "hold",
      "aiReason": "45字以内的一句话盘中诊断，直接指导操作"
    }
  ]
}`;

      const aiRes = await chatJson({
        system: "你只输出严格符合 JSON Schema 的投资复核结论，理由务必精炼硬核，控制在45字以内。",
        user: prompt,
        schema: IntradayGridAiReviewSchema,
        temperature: 0.2,
        maxTokens: 800,
        purpose: "intraday_review",
        subject: `${symbol}:${liveContext.snapshotTime}`,
      });

      for (const rev of aiRes.data.reviews) {
        const targetCheck = actionChecks.find((c) => c.kind === rev.kind);
        if (targetCheck) {
          targetCheck.aiVerdict = rev.aiVerdict;
          targetCheck.aiReason = rev.aiReason;

          // UNIDIRECTIONAL SAFETY VALVE: AI cannot promote "hold" to "execute"
          if (targetCheck.verdict === "hold") {
            // keep hold
          } else if (targetCheck.verdict === "execute" && rev.aiVerdict === "hold") {
            targetCheck.verdict = "hold";
            targetCheck.verdictText = "⏸ 建议暂缓（AI复核降级）";
          }
        }
      }

      return { reviewed: true, model: aiRes.model };
    }

    return { reviewed: false };
  } catch (error) {
    console.error("AI Intraday review failed, skipping AI layer:", error);
    return { reviewed: false };
  }
}

/**
 * Execute full intraday verification workflow for a given symbol.
 */
export async function performIntradayCheck(
  symbol: PositionTargetSymbol,
  opts?: { forceAi?: boolean; targetDay?: string },
): Promise<IntradayCheckResult> {
  const cfg = INTRADAY_TARGET_MAP[symbol];
  if (!cfg) throw new Error(`Unsupported symbol for intraday check: ${symbol}`);

  const todayStr = opts?.targetDay ?? beijingDate(new Date());
  const nowBeijingTime = beijingTime(new Date());

  // 1. Get or freeze daily plan
  const frozenPlan = await getOrFreezeDailyPlan(symbol, todayStr);

  // 2. Fetch live quotes from Tencent
  const allSymbols = [cfg.primaryCode, ...cfg.relatedCodes];
  const quotesMap = await fetchTencentBatchQuotes(allSymbols);

  const primaryQuote = quotesMap[cfg.primaryCode];
  if (!primaryQuote) {
    throw new Error(`Failed to fetch real-time quote for ${cfg.primaryCode}`);
  }

  const relatedQuotes: IntradayLiveQuoteItem[] = cfg.relatedCodes
    .map((code) => {
      const q = quotesMap[code];
      if (!q) return null;
      return {
        symbol: q.code,
        name: q.name,
        price: q.price,
        changePct: q.changePct,
      };
    })
    .filter((q): q is IntradayLiveQuoteItem => q !== null);

  const { phase, hint } = getIntradaySessionPhase(nowBeijingTime);

  const liveContext: IntradayLiveContext = {
    symbol: primaryQuote.code,
    name: primaryQuote.name,
    snapshotTime: primaryQuote.timeStr || `${nowBeijingTime}:00`,
    currentPrice: primaryQuote.price,
    yesterdayClose: primaryQuote.prevClose,
    openPrice: primaryQuote.open,
    highPrice: primaryQuote.high,
    lowPrice: primaryQuote.low,
    changePct: primaryQuote.changePct,
    volumeRatio: primaryQuote.volumeRatio,
    vwap: primaryQuote.vwap,
    iopv: primaryQuote.iopv,
    discountPremiumPct: primaryQuote.discountPremiumPct,
    intradayPositionPct: primaryQuote.intradayPositionPct,
    sessionPhase: phase,
    sessionHint: hint,
    relatedQuotes,
  };

  // 3. Rule engine evaluation
  let actionChecks: IntradayActionPointCheck[] | undefined;
  let dcaCheck: IntradayDcaLumpSumCheck | undefined;

  if (symbol === "etf_513180") {
    dcaCheck = evaluateDcaLumpSumRules(liveContext, nowBeijingTime);
  } else {
    actionChecks = evaluateGridActionPointRules(symbol, liveContext, frozenPlan, nowBeijingTime);
  }

  // 4. AI review layer
  const { reviewed, model } = await reviewIntradayWithAi(
    symbol,
    liveContext,
    actionChecks,
    dcaCheck,
  );

  const checkResult: IntradayCheckResult = {
    symbol,
    checkedAt: new Date().toISOString(),
    frozenDate: todayStr,
    liveContext,
    actionChecks,
    dcaCheck,
    aiReviewed: reviewed,
    aiModel: model,
  };

  return checkResult;
}
