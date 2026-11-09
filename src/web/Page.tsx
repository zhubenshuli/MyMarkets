// Standalone Markets page: domestic pork, civil aviation, Hang Seng Tech, and macro benchmarks
// with AI/rule-based cyclical analysis, weekly/quarterly trend curves, and mobile-responsive layout.
import { Fragment, useEffect, useState } from "react";
import { beijingDateTimeSec, beijingStamp, monthDay } from "../shared/time.ts";
import { LlmChannelsPanel } from "./components/LlmChannelsPanel.tsx";
import { DilutedCostChart, PositionPlanPanel } from "./components/PositionPlanPanel.tsx";
import type {
  Etf516670Guidance,
  IndicatorAiInsight,
  MarketCategory,
  MarketQuote,
  MarketsAnswer,
  MarketTrendPoint,
  PorkMarketAnalysis,
  PorkQuoteBenchmark,
  PorkStatusTone,
} from "../shared/types.ts";

/** Extensible navigation registry: to add more sectors or system views in the future, append entries here. */
export interface MarketTabDef {
  key: string;
  label: string;
  icon: string;
  group: "market" | "system";
  category: MarketCategory;
  description: string;
}

export const MARKET_TABS: readonly MarketTabDef[] = [
  {
    key: "macro",
    label: "全球大宗与股指",
    icon: "🌐",
    group: "market",
    category: "macro",
    description: "布伦特原油、伦敦现货黄金（折合人民币克价）、上证指数与恒生科技指数监测",
  },
  {
    key: "pork",
    label: "生猪产业链",
    icon: "🐖",
    group: "market",
    category: "pork",
    description: "涵盖农业部白条肉、生猪大盘、大商所期货连续、能繁母猪、仔猪补栏、猪粮比价、饲料成本及畜牧养殖ETF（516670）周期买卖指南",
  },
  {
    key: "aviation",
    label: "航空业",
    icon: "✈️",
    group: "market",
    category: "aviation",
    description: "涵盖上期能源原油与低硫燃料油、美元兑人民币汇率、上海机场枢纽、三大航与春秋航空同业标杆、民航正班客座率及中国东航（600115）周期配置与波段指南",
  },
  {
    key: "hstech",
    label: "恒生科技",
    icon: "🚀",
    group: "market",
    category: "hstech",
    description: "涵盖恒生科技指数、离岸汇率锚、腾讯阿里美团京东四大平台权重、小米中芯AI端侧算力先锋及恒生科技ETF（513180）周期配置与T+0波段指南",
  },
  {
    key: "models",
    label: "AI 模型与额度",
    icon: "🤖",
    group: "system",
    category: "models",
    description: "查看当前使用的 AI 模型通道、剩余额度与配额状态、各板块研判生成时间及调用历史记录",
  },
];

const formatPrice = (value: number) => value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const formatPct = (value: number | null | undefined) => (value === null || value === undefined ? "—" : `${value > 0 ? "+" : ""}${(value * 100).toFixed(2)}%`);
const tone = (value: number | null | undefined) => (value === null || value === undefined || value === 0 ? "text-ink-4" : value > 0 ? "text-hot" : "text-ok");
const prefix = (currency: MarketQuote["currency"]) => (currency === "USD" ? "$" : "");

const TONE_BADGE_CLASSES: Record<PorkStatusTone, string> = {
  critical: "text-hot bg-hot-soft border-hot/30",
  caution: "text-amber-ink bg-amber-soft border-amber/30",
  positive: "text-ok-ink bg-ok-soft border-ok/30",
  accent: "text-accent-ink bg-accent-soft border-accent/30",
  neutral: "text-ink-2 bg-bg-sunk border-line",
};

function formatStatDate(q: MarketQuote, referenceYear: string): { label: string; badge: string } {
  const y = q.day.slice(0, 4);
  const m = Number(q.day.slice(5, 7));
  const d = Number(q.day.slice(8, 10));
  const yearPrefix = y !== referenceYear ? `${y}年` : "";

  if (q.statFrequency === "quarterly" || q.symbol === "sow_inventory" || q.symbol === "caac_load_factor") {
    const quarter = Math.ceil(m / 3);
    return { label: `${yearPrefix}Q${quarter}末`, badge: q.statSourceLabel ?? "官方季报" };
  }
  return { label: `${yearPrefix}${m}月${d}日`, badge: q.statSourceLabel ?? "日频均价" };
}

function fallbackBenchmark(q: MarketQuote): PorkQuoteBenchmark {
  return q.benchmark ?? {
    anchorText: "行业参考指标",
    statusBadge: "常态监测",
    statusTone: "neutral",
    statusDesc: q.note ?? "",
  };
}

/**
 * Medium-term cycle sparkline built on weekly averages (8~12 weeks) or official quarterly points,
 * filtering out intraday/weekend noise so cyclical direction and inflection points stand out clearly.
 */
function CycleTrendSparkline({
  points,
  isQuarterly,
  referenceLine,
}: {
  points: MarketTrendPoint[] | undefined;
  isQuarterly: boolean;
  referenceLine?: number | null;
}) {
  if (!points || points.length < 2) {
    return <span className="text-[11px] text-ink-4">—</span>;
  }
  const values = points.map((p) => p.close);
  const dataMin = Math.min(...values);
  const dataMax = Math.max(...values);

  // Include reference line in scale only when reasonably close (within ±18% of data range) so it doesn't flatten the curve
  const showRef =
    typeof referenceLine === "number" &&
    Number.isFinite(referenceLine) &&
    referenceLine >= dataMin * 0.82 &&
    referenceLine <= dataMax * 1.18;

  const min = showRef ? Math.min(dataMin, referenceLine!) : dataMin;
  const max = showRef ? Math.max(dataMax, referenceLine!) : dataMax;
  const span = max - min || 1;
  const width = 92;
  const height = 26;
  const pad = 3;

  const coords = points.map((p, i) => {
    const x = (i / (points.length - 1)) * width;
    const y = pad + (1 - (p.close - min) / span) * (height - pad * 2);
    return { x, y };
  });
  const polyline = coords.map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(" ");
  const lastCoord = coords.at(-1)!;
  const firstVal = points[0]!.close;
  const lastVal = points.at(-1)!.close;
  const netDiff = lastVal - firstVal;
  const strokeTone = Math.abs(netDiff) < 1e-6 ? "text-ink-4" : netDiff > 0 ? "text-hot" : "text-ok";
  const refY = showRef ? pad + (1 - (referenceLine! - min) / span) * (height - pad * 2) : null;

  const periodTag = isQuarterly ? `近${points.length}季` : `近${points.length}周均`;
  const tooltip = `${periodTag}: ${points[0]!.label} (${formatPrice(firstVal)}) → ${points.at(-1)!.label} (${formatPrice(lastVal)}) | 区间 ${formatPrice(dataMin)} ~ ${formatPrice(dataMax)}`;

  return (
    <div className="inline-flex flex-col items-end" title={tooltip}>
      <svg viewBox={`0 0 ${width} ${height}`} className={`h-6 w-[92px] overflow-visible ${strokeTone}`} aria-hidden="true">
        {refY !== null && (
          <line
            x1={0}
            y1={refY.toFixed(1)}
            x2={width}
            y2={refY.toFixed(1)}
            stroke="currentColor"
            strokeOpacity="0.28"
            strokeWidth="1"
            strokeDasharray="2.5 2.5"
          />
        )}
        <polyline
          fill="none"
          stroke="currentColor"
          strokeWidth="1.65"
          strokeLinecap="round"
          strokeLinejoin="round"
          points={polyline}
        />
        <circle cx={lastCoord.x.toFixed(1)} cy={lastCoord.y.toFixed(1)} r="2.1" fill="currentColor" />
      </svg>
      <div className="num mt-0.5 text-[10px] text-ink-4 whitespace-nowrap">
        {periodTag} {formatPrice(firstVal)}→{formatPrice(lastVal)}
      </div>
    </div>
  );
}

function SparklineLarge({ series, change, currency }: { series: MarketQuote["series"]; change: number | null; currency: MarketQuote["currency"] }) {
  if (series.length < 2) return null;
  const values = series.map((p) => p.close);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const width = 240;
  const height = 52;
  const pad = 4;
  const points = series.map((p, i) => {
    const x = (i / (series.length - 1)) * width;
    const y = pad + (1 - (p.close - min) / span) * (height - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  const color = change === null || change === 0 ? "text-ink-4" : change > 0 ? "text-hot" : "text-ok";
  const sym = prefix(currency);
  return (
    <div className="mt-4">
      <svg viewBox={`0 0 ${width} ${height}`} className={`h-12 w-full overflow-visible ${color}`} aria-hidden="true">
        <polyline fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" points={points} />
      </svg>
      <div className="mt-1 flex justify-between text-[11px] text-ink-4">
        <span className="num">{monthDay(series[0]!.day)}</span>
        <span className="num">区间 {sym}{formatPrice(min)} – {sym}{formatPrice(max)}</span>
        <span className="num">{monthDay(series.at(-1)!.day)}</span>
      </div>
    </div>
  );
}

function MacroPanel({ q }: { q: MarketQuote }) {
  const isUsd = q.currency === "USD";
  const unitLabel = q.unit.startsWith(":") ? q.unit : `/ ${q.unit}`;
  return (
    <section aria-label={q.name} className="card flex flex-col justify-between p-4 sm:p-5">
      <div>
        <div className="flex items-baseline justify-between gap-2">
          <h3 className="text-[15px] sm:text-[16px] font-bold text-ink">{q.name}</h3>
          <time dateTime={q.day} className="num text-[11.5px] text-ink-4">{monthDay(q.day)}</time>
        </div>
        <div className="mt-2.5">
          <div className="num flex flex-wrap items-baseline gap-1 text-[24px] sm:text-[26px] font-bold leading-tight tracking-tight text-ink">
            {isUsd && <span className="text-[18px] font-semibold text-ink-3">$</span>}
            <span>{formatPrice(q.price)}</span>
            <span className="text-[12px] font-normal text-ink-4">{unitLabel}</span>
          </div>
          {q.cnyPrice !== null && (
            <div className="mt-1 flex flex-wrap items-baseline gap-1 text-[12px]">
              <span className="text-ink-4">折合人民币</span>
              <span className="num font-bold text-accent">约 ¥{formatPrice(q.cnyPrice)}</span>
              <span className="text-[11px] text-ink-4">/ {q.cnyUnit}</span>
            </div>
          )}
        </div>
        <SparklineLarge series={q.series} change={q.change2m ?? q.change1m} currency={q.currency} />
      </div>
      <div className="mt-3.5 grid grid-cols-3 gap-1.5 sm:gap-2">
        <div className="rounded-control bg-bg-sunk px-2 py-1.5 text-center">
          <div className="text-[11px] text-ink-4">较昨日</div>
          <div className={`num mt-0.5 text-[14px] font-bold ${tone(q.changeYesterday)}`}>{formatPct(q.changeYesterday)}</div>
        </div>
        <div className="rounded-control bg-bg-sunk px-2 py-1.5 text-center">
          <div className="text-[11px] text-ink-4">近一月</div>
          <div className={`num mt-0.5 text-[14px] font-bold ${tone(q.change1m)}`}>{formatPct(q.change1m)}</div>
        </div>
        <div className="rounded-control bg-bg-sunk px-2 py-1.5 text-center">
          <div className="text-[11px] text-ink-4">近二月</div>
          <div className={`num mt-0.5 text-[14px] font-bold ${tone(q.change2m)}`}>{formatPct(q.change2m)}</div>
        </div>
      </div>
    </section>
  );
}

interface PorkSegmentGroup {
  key: "spot" | "forward" | "cost";
  title: string;
  tag: string;
  description: string;
  symbols: string[];
}

const PORK_SEGMENTS: readonly PorkSegmentGroup[] = [
  {
    key: "spot",
    title: "即期现货与衍生品",
    tag: "即期博弈与交割预期",
    description: "反映当下农业部批发市场走货、生猪出栏博弈及大商所期货期现升贴水",
    symbols: ["hog_spot", "pork_spot", "hog_futures"],
  },
  {
    key: "forward",
    title: "中远期供给与龙头抢跑",
    tag: "能繁仔猪传导与权重龙头",
    description: "能繁母猪传导约10个月、仔猪传导约5~6个月；牧原与温氏（合计占516670约28%权重）领先现货反映机构反转预期",
    symbols: ["piglet_spot", "sow_spot", "sow_inventory", "muyuan_002714", "wens_300498"],
  },
  {
    key: "cost",
    title: "成本支撑与监管警戒",
    tag: "养殖盈亏与政策收储",
    description: "玉米豆粕决定配合料成本底线；猪粮比价触发发改委预警与中央储备肉收储",
    symbols: ["pig_grain_ratio", "corn_spot", "bean_spot"],
  },
];

const AVIATION_SEGMENTS: readonly PorkSegmentGroup[] = [
  {
    key: "cost",
    title: "航油与汇率成本底盘",
    tag: "占航司成本~35%与汇兑损益",
    description: "内盘原油与低硫燃料油决定航油出厂价；人民币汇率决定美元飞机租赁负债汇兑收益",
    symbols: ["ine_crude", "fuel_futures", "fx_usdcny"],
  },
  {
    key: "spot",
    title: "基地枢纽与AH同业标杆",
    tag: "浦东虹桥流量与A/H比价",
    description: "上海机场映射东航主基地国际客流；东航H股反映外资定价与A/H溢价率；国航、南航、春秋反映航司估值水位",
    symbols: ["sh_airport", "cea_hk00670", "air_china", "csa_600029", "spring_air"],
  },
  {
    key: "forward",
    title: "客运景气与运力供需",
    tag: "保本线78% · 高景气线83%",
    description: "民航局核定全行业正班客座率，突破83%进入高景气提价与利润释放区间",
    symbols: ["caac_load_factor"],
  },
];

const HSTECH_SEGMENTS: readonly PorkSegmentGroup[] = [
  {
    key: "cost",
    title: "指数基准与离岸流动性锚",
    tag: "估值中枢与港币折算",
    description: "恒生科技指数（4200点价值底线 / 5200点中枢）与人民币汇率共同决定513180场内净值与外资流向",
    symbols: ["hstech_index", "hstech_fx"],
  },
  {
    key: "spot",
    title: "平台经济与内容电商权重",
    tag: "合计占指数权重超38%",
    description: "腾讯（社交游戏AI）、阿里（电商云回购）、美团（本地生活）、京东（供应链）、快手（可灵AI大模型+直播电商）",
    symbols: ["hk_00700", "hk_09988", "hk_03690", "hk_09618", "hk_01024"],
  },
  {
    key: "forward",
    title: "端侧硬件与算力芯片先锋",
    tag: "高Beta弹性与国产替代",
    description: "小米（人车家生态+智能汽车）与中芯国际（本土晶圆代工AI算力底座）领衔科技成长弹性",
    symbols: ["hk_01810", "hk_00981"],
  },
];

/** Mobile card representation of a single pork/aviation industry metric (< md screens, zero horizontal scroll). */
function MobilePorkIndicatorCard({
  q,
  referenceYear,
  aiInsight,
}: {
  q: MarketQuote;
  referenceYear: string;
  aiInsight?: IndicatorAiInsight;
}) {
  const currPrefix = q.currency === "HKD" ? "HK$" : q.currency === "USD" ? "$" : "";
  const unitLabel = q.unit.startsWith(":") ? q.unit : q.unit === "%" ? "%" : ` / ${q.unit}`;
  const stat = formatStatDate(q, referenceYear);
  const bench = fallbackBenchmark(q);
  const effectiveTone = aiInsight?.tone ?? bench.statusTone;
  const effectiveBadge = aiInsight?.badge || bench.statusBadge;
  const effectiveComment = aiInsight?.comment || bench.statusDesc;
  const badgeClass = TONE_BADGE_CLASSES[effectiveTone] ?? TONE_BADGE_CLASSES.neutral;
  const isQuarterly = q.statFrequency === "quarterly" || q.symbol === "sow_inventory" || q.symbol === "caac_load_factor";
  const primaryChange = isQuarterly ? q.changeYesterday : (q.change1w ?? q.changeYesterday);
  const secondaryChange = isQuarterly ? null : q.change1m;

  return (
    <div className="rounded-control border border-line bg-surface p-3 space-y-2">
      {/* Row 1: Name + Stat Date + Status Badge */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 flex-wrap min-w-0">
          <span className="font-bold text-[14px] text-ink">{q.name}</span>
          <span className="text-[10.5px] text-ink-4 rounded bg-bg-sunk px-1.5 py-0.5 border border-line-soft">
            {stat.label}
          </span>
          {q.horizon && (
            <span className="text-[10.5px] text-ink-3">· {q.horizon}</span>
          )}
        </div>
        <span
          className={`shrink-0 inline-flex items-center rounded px-2 py-0.5 text-[11px] font-bold border ${badgeClass}`}
          title={effectiveComment}
        >
          {effectiveBadge}
        </span>
      </div>

      {/* Row 2: Price on left, Weekly/Quarterly Trend & Change on right */}
      <div className="flex items-end justify-between gap-3">
        <div>
          <div className="num font-bold text-[18px] leading-tight text-ink">
            {currPrefix}{formatPrice(q.price)}
            <span className="text-[11.5px] font-normal text-ink-4 ml-0.5">{unitLabel}</span>
          </div>
          {q.cnyPrice !== null && (
            <div className="num text-[11.5px] text-accent mt-0.5">
              折合 ¥{formatPrice(q.cnyPrice)}/{q.cnyUnit}
            </div>
          )}
        </div>

        <div className="flex items-center gap-3">
          <CycleTrendSparkline
            points={q.weeklySeries}
            isQuarterly={isQuarterly}
            referenceLine={bench.referenceLine}
          />
          <div className="text-right flex flex-col items-end gap-0.5">
            <div className="flex items-center gap-1.5">
              <span className="text-[11px] text-ink-4">{isQuarterly ? "季环比" : "周环比"}</span>
              <span className={`num font-bold text-[12.5px] ${tone(primaryChange)}`}>
                {formatPct(primaryChange)}
              </span>
            </div>
            {secondaryChange !== null && (
              <div className="flex items-center gap-1.5">
                <span className="text-[11px] text-ink-4">近一月</span>
                <span className={`num font-bold text-[12.5px] ${tone(secondaryChange)}`}>
                  {formatPct(secondaryChange)}
                </span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Row 3: Compact Benchmark Anchor & AI Insight */}
      <div className="rounded bg-bg-sunk px-2.5 py-1.5 border border-line-soft space-y-1 text-[11.5px]">
        <div className="flex flex-wrap items-baseline justify-between gap-x-2">
          <span className="font-semibold text-ink">{bench.anchorText}</span>
          {bench.anchorSub && <span className="num text-[11px] text-ink-3">{bench.anchorSub}</span>}
        </div>
        {effectiveComment && (
          <div className="text-[11px] text-ink-3 leading-snug border-t border-line-soft pt-1">
            {effectiveComment}
          </div>
        )}
      </div>
    </div>
  );
}

/** Dedicated chart for target asset (516670 / 600115) daily closes + MA20 reference line. */
function EtfWaveSparkline({
  series,
  ma20,
  decimals = 3,
}: {
  series: MarketQuote["series"] | undefined;
  ma20: number;
  decimals?: number;
}) {
  if (!series || series.length < 2) return null;
  const values = series.map((p) => p.close);
  const dataMin = Math.min(...values);
  const dataMax = Math.max(...values);
  const min = Math.min(dataMin, ma20);
  const max = Math.max(dataMax, ma20);
  const span = max - min || 0.01;
  const width = 260;
  const height = 56;
  const pad = 5;

  const coords = series.map((p, i) => {
    const x = (i / (series.length - 1)) * width;
    const y = pad + (1 - (p.close - min) / span) * (height - pad * 2);
    return { x, y };
  });
  const points = coords.map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(" ");
  const lastCoord = coords.at(-1)!;
  const lastClose = values.at(-1)!;
  const ma20Y = pad + (1 - (ma20 - min) / span) * (height - pad * 2);
  const strokeTone = lastClose >= ma20 ? "text-hot" : "text-ok";

  return (
    <div className="mt-3">
      <svg viewBox={`0 0 ${width} ${height}`} className={`h-14 w-full overflow-visible ${strokeTone}`} aria-hidden="true">
        <line
          x1={0}
          y1={ma20Y.toFixed(1)}
          x2={width}
          y2={ma20Y.toFixed(1)}
          stroke="currentColor"
          strokeOpacity="0.35"
          strokeWidth="1.1"
          strokeDasharray="3 3"
        />
        <polyline
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          points={points}
        />
        <circle cx={lastCoord.x.toFixed(1)} cy={lastCoord.y.toFixed(1)} r="2.5" fill="currentColor" />
      </svg>
      <div className="mt-1 flex items-center justify-between text-[11px] text-ink-4">
        <span className="num">{monthDay(series[0]!.day)}</span>
        <span className="num">虚线: MA20 均线 (¥{ma20.toFixed(decimals)})</span>
        <span className="num">{monthDay(series.at(-1)!.day)}</span>
      </div>
    </div>
  );
}

function cleanActionLabel(label: string): string {
  const main = label.split(" · ")[0]?.trim();
  return main || label;
}

function cleanSectorStage(stage: string): string {
  return stage
    .replace(/[·\s]*(右侧启动|右侧顺势|右侧加配|右侧配置|右侧布局)/g, "")
    .replace(/^(.{2,6})与(.{2,6})期$/, "$1·$2")
    .trim();
}

function cleanSectorHeadline(headline: string): string {
  let cleaned = headline
    .replace(/[，,]\s*(?:恒生科技ETF|畜牧养殖ETF|中国东航|东航|513180|516670|600115)[^，,。]*(?:右侧加配|右侧顺势|右侧配置|右侧布局|逢低配置|估值修复|波段窗口|配置窗口)[^。]*([。]?)$/, "$1")
    .replace(/；/g, "，")
    .trim();

  cleaned = cleaned.replace(/，[。]/g, "。").replace(/[，,]$/, "");
  if (cleaned && !cleaned.endsWith("。")) {
    cleaned += "。";
  }
  return cleaned;
}

/** Clean redundant parenthetical notes from buy/sell trigger strings for concise display. */
function cleanTriggerText(text: string): string {
  return text
    .replace(/（MA20[^）]*）/g, "")
    .replace(/\(MA20[^)]*\)/g, "")
    .trim();
}

/** Dedicated Cycle Allocation & Short-term Technical Wave Guidance Section (supports 516670 ETF, 600115 China Eastern & 513180 HSTECH ETF). */
function Etf516670GuidanceSection({
  etfQuote,
  guidance,
  referenceYear,
  sector = "pork",
  onMarketsUpdated,
}: {
  etfQuote: MarketQuote | undefined;
  guidance: Etf516670Guidance;
  referenceYear: string;
  sector?: "pork" | "aviation" | "hstech";
  onMarketsUpdated?: (markets: MarketsAnswer) => void;
}) {
  const isAviation = sector === "aviation";
  const isHstech = sector === "hstech";
  const decimals = isAviation ? 2 : 3;
  const fmtTarget = (v: number) => v.toFixed(decimals);
  const badgeClass = TONE_BADGE_CLASSES[guidance.actionTone] ?? TONE_BADGE_CLASSES.neutral;
  const price = etfQuote?.price ?? guidance.ma20;
  const stat = etfQuote
    ? formatStatDate(etfQuote, referenceYear)
    : { label: "最新结算", badge: "上交所日线" };
  const plan = guidance.positionPlan;
  const curLadderRow =
    plan?.ladderRows && typeof plan.currentRowIndex === "number"
      ? plan.ladderRows[plan.currentRowIndex]
      : undefined;
  const nextBuyVal = curLadderRow?.buyPrice ?? Number((guidance.ma20 * 0.97).toFixed(decimals));
  const nextSellVal = curLadderRow?.sellPrice ?? Number((guidance.ma20 * 1.05).toFixed(decimals));
  const dilutedCostVal = plan?.latestSnapshot.dilutedCost ?? guidance.ma20;

  const sectionTitle = isAviation
    ? "中国东航（600115）长线降本与两段式网格指南"
    : isHstech
      ? "恒生科技（场外定投 / 513180）智能分档降本指南"
      : "畜牧养殖ETF（516670）长线降本与两段式网格指南";
  const assetName = isAviation ? "中国东航" : isHstech ? "恒生科技ETF" : "畜牧养殖ETF";
  const assetCode = isAviation ? "600115.SH" : isHstech ? "513180.SH" : "516670";
  const assetUnit = isAviation ? "股" : "份";

  return (
    <div
      aria-label={
        isAviation
          ? "中国东航 600115 周期配置与波段指南"
          : isHstech
            ? "恒生科技ETF 513180 周期配置与波段指南"
            : "畜牧养殖ETF 516670 周期配置与波段指南"
      }
      className="rounded-control border border-line bg-well/60 p-4 sm:p-5"
    >
      {/* Section Header */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between border-b border-line pb-3">
        <h3 className="flex items-center gap-2 text-[15.5px] sm:text-[16.5px] font-bold text-ink">
          <svg
            viewBox="0 0 20 20"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            className="size-4.5 shrink-0 text-accent"
            aria-hidden="true"
          >
            <circle cx="10" cy="10" r="7.5" />
            <circle cx="10" cy="10" r="3" />
            <path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2" strokeLinecap="round" />
          </svg>
          <span>{sectionTitle}</span>
        </h3>

        <div className="flex flex-wrap items-center gap-2.5 self-start sm:self-auto shrink-0">
          <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[12px] font-bold border ${badgeClass}`}>
            <span className="size-1.5 rounded-full bg-current opacity-75" />
            {cleanActionLabel(guidance.actionLabel)}
          </span>
          <span className="num text-[12.5px] font-semibold text-ink-3">
            综合评分 <strong className="text-accent font-bold">{guidance.score}</strong>/100
          </span>
        </div>
      </div>

      {/* Main 2-Column Body */}
      <div className="mt-3.5 grid grid-cols-1 lg:grid-cols-12 gap-3.5">
        {/* Left Column (5 cols): Quote, Diluted Cost vs Market Price Curve & 3 Key Price Anchors */}
        <div className="lg:col-span-5 rounded-control bg-surface border border-line p-3.5 flex flex-col justify-between space-y-3">
          <div>
            {/* Asset Name + Price on one clean header row */}
            <div className="flex items-baseline justify-between gap-2">
              <div className="flex items-center gap-1.5">
                <span className="font-bold text-[14.5px] text-ink">{assetName}</span>
                <span className="num rounded bg-accent-soft px-1.5 py-0.5 text-[11px] font-bold text-accent-ink">
                  {assetCode}
                </span>
                <span className="text-[11.5px] text-ink-4">· {stat.label}</span>
              </div>
              <div className="num flex items-baseline gap-0.5">
                <span className="text-[12.5px] font-semibold text-ink-3">¥</span>
                <span className="text-[22px] sm:text-[24px] font-bold leading-none tracking-tight text-ink">
                  {fmtTarget(price)}
                </span>
                <span className="text-[11px] text-ink-4">/{assetUnit}</span>
              </div>
            </div>

            {/* 3 Core Period Returns */}
            {etfQuote && (
              <div className="mt-2.5 grid grid-cols-3 gap-1.5">
                <div className="rounded bg-bg-sunk px-2 py-1 text-center">
                  <div className="text-[10.5px] text-ink-4">较昨日</div>
                  <div className={`num text-[12.5px] font-bold ${tone(etfQuote.changeYesterday)}`}>
                    {formatPct(etfQuote.changeYesterday)}
                  </div>
                </div>
                <div className="rounded bg-bg-sunk px-2 py-1 text-center">
                  <div className="text-[10.5px] text-ink-4">周环比</div>
                  <div className={`num text-[12.5px] font-bold ${tone(etfQuote.change1w)}`}>
                    {formatPct(etfQuote.change1w)}
                  </div>
                </div>
                <div className="rounded bg-bg-sunk px-2 py-1 text-center">
                  <div className="text-[10.5px] text-ink-4">近一月</div>
                  <div className={`num text-[12.5px] font-bold ${tone(etfQuote.change1m)}`}>
                    {formatPct(etfQuote.change1m)}
                  </div>
                </div>
              </div>
            )}

            {/* Diluted Cost vs Market Price Curve (fallback to MA20 wave sparkline if no costCurve) */}
            {plan?.costCurve && plan.costCurve.length >= 2 ? (
              <DilutedCostChart
                costCurve={plan.costCurve}
                nextBuyPrice={curLadderRow?.buyPrice ?? (isHstech ? (plan.dcaPlan?.lumpSumAlert.triggerLevels[0] ?? 0.468) : null)}
                nextSellPrice={curLadderRow?.sellPrice ?? null}
                decimals={decimals}
              />
            ) : (
              <EtfWaveSparkline series={etfQuote?.series} ma20={guidance.ma20} decimals={decimals} />
            )}
          </div>

          {/* 3 Key Ladder / DCA Price Levels */}
          {isHstech && plan?.dcaPlan ? (
            <div className="grid grid-cols-3 gap-1.5 rounded bg-bg-sunk px-2.5 py-2 border border-line-soft text-[11.5px] text-center">
              <div>
                <span className="text-ink-4 block">强支撑加仓线</span>
                <span className="num font-bold text-ok-ink">
                  ¥{(plan.dcaPlan.lumpSumAlert.triggerLevels[0] ?? 0.468).toFixed(3)}
                </span>
              </div>
              <div className="border-x border-line-soft px-1">
                <span className="text-ink-4 block">等效摊薄成本</span>
                <span className="num font-bold text-accent">~¥{dilutedCostVal.toFixed(3)}</span>
              </div>
              <div>
                <span className="text-ink-4 block">本周定投额</span>
                <span className="num font-bold text-hot">¥{plan.dcaPlan.recommendedDailyAmount}/天</span>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-3 gap-1.5 rounded bg-bg-sunk px-2.5 py-2 border border-line-soft text-[11.5px] text-center">
              <div>
                <span className="text-ink-4 block">下一买点</span>
                <span className="num font-bold text-ok-ink">
                  {curLadderRow?.buyPrice !== null && curLadderRow?.buyPrice !== undefined
                    ? `¥${fmtTarget(nextBuyVal)}`
                    : "停止买入"}
                </span>
              </div>
              <div className="border-x border-line-soft px-1">
                <span className="text-ink-4 block">摊薄成本价</span>
                <span className="num font-bold text-accent">
                  ¥{dilutedCostVal.toFixed(decimals === 2 ? 3 : 4)}
                </span>
              </div>
              <div>
                <span className="text-ink-4 block">下一卖点</span>
                <span className="num font-bold text-hot">
                  {curLadderRow?.sellPrice !== null && curLadderRow?.sellPrice !== undefined
                    ? `¥${fmtTarget(nextSellVal)}`
                    : "仅剩底仓"}
                </span>
              </div>
            </div>
          )}
        </div>

        {/* Right Column (7 cols): Position Strategy + Buy/Sell Triggers */}
        <div className="lg:col-span-7 flex flex-col justify-between gap-3">
          {/* Card 1: Position, Cycle & Wave Strategy */}
          <div className="rounded-control bg-surface p-3.5 border border-line space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="inline-flex items-center gap-1.5 text-[13px] font-bold text-ink">
                <svg
                  viewBox="0 0 20 20"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  className="size-4 text-accent shrink-0"
                  aria-hidden="true"
                >
                  <path d="M10 2.5L3 6.25 10 10l7-3.75L10 2.5z" strokeLinejoin="round" />
                  <path d="M3 10l7 3.75L17 10M3 13.75L10 17.5l7-3.75" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                长线底仓与降本策略
              </span>
              <span className="rounded bg-accent-soft/70 px-2 py-0.5 text-[12px] font-bold text-accent">
                {guidance.positionHint}
              </span>
            </div>
            <p className="text-[12.5px] leading-relaxed text-ink-2">
              <strong className="text-ink font-semibold">中线底仓：</strong>
              {guidance.cycleAdvice}
            </p>
            {guidance.swingAdvice && (
              <p className="text-[12.5px] leading-relaxed text-ink-2 border-t border-line-soft pt-1.5">
                <strong className="text-ink font-semibold">执行纪律：</strong>
                {guidance.swingAdvice}
              </p>
            )}
          </div>

          {/* Card 2 & 3: Buy / Sell Discipline Triggers */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 flex-1">
            <div className="rounded-control bg-surface border border-line p-3.5 flex flex-col justify-center">
              <div className="inline-flex items-center gap-1.5 text-[13px] font-bold text-ok-ink">
                <svg
                  viewBox="0 0 20 20"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.9"
                  className="size-4 shrink-0"
                  aria-hidden="true"
                >
                  <path d="M3 14l4.5-4.5 3 3L17 6" strokeLinecap="round" strokeLinejoin="round" />
                  <path d="M12.5 6H17v4.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                低吸与加码纪律
              </div>
              <ul className="mt-2 space-y-1.5 text-[12.5px] text-ink-2 leading-relaxed list-disc pl-4">
                {guidance.buyTriggers.slice(0, 3).map((t, idx) => (
                  <li key={idx}>{cleanTriggerText(t)}</li>
                ))}
              </ul>
            </div>
            <div className="rounded-control bg-surface border border-line p-3.5 flex flex-col justify-center">
              <div className="inline-flex items-center gap-1.5 text-[13px] font-bold text-hot">
                <svg
                  viewBox="0 0 20 20"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.9"
                  className="size-4 shrink-0"
                  aria-hidden="true"
                >
                  <path d="M10 2.5l6 2.5v4.5c0 4.1-2.5 7.4-6 8.5-3.5-1.1-6-4.4-6-8.5V5l6-2.5z" strokeLinejoin="round" />
                  <path d="M10 7v3.5M10 13.5h.01" strokeLinecap="round" />
                </svg>
                配对止盈与铁律
              </div>
              <ul className="mt-2 space-y-1.5 text-[12.5px] text-ink-2 leading-relaxed list-disc pl-4">
                {guidance.sellTriggers.slice(0, 3).map((t, idx) => (
                  <li key={idx}>{cleanTriggerText(t)}</li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </div>

      {/* Interactive Position Ledger, Snapshot Entry & Two-Stage Ladder / Smart DCA Table */}
      {plan && (
        <PositionPlanPanel
          plan={plan}
          currentPrice={price}
          decimals={decimals}
          onMarketsUpdated={onMarketsUpdated}
        />
      )}
    </div>
  );
}

function ConsolidatedPorkSummaryCard({
  quotes,
  analysis,
  sector = "pork",
  onOpenModels,
  onManualRefresh,
  onMarketsUpdated,
  refreshingTarget,
  feedbackNotice,
}: {
  quotes: MarketQuote[];
  analysis: PorkMarketAnalysis | null | undefined;
  sector?: "pork" | "aviation" | "hstech";
  onOpenModels?: () => void;
  onManualRefresh?: () => void;
  onMarketsUpdated?: (markets: MarketsAnswer) => void;
  refreshingTarget?: string | null;
  feedbackNotice?: { text: string; isError?: boolean } | null;
}) {
  const isAviation = sector === "aviation";
  const isHstech = sector === "hstech";
  const segments = isAviation ? AVIATION_SEGMENTS : isHstech ? HSTECH_SEGMENTS : PORK_SEGMENTS;
  const targetSymbol = isAviation ? "cea_600115" : isHstech ? "etf_513180" : "etf_516670";
  const referenceYear = quotes.map((q) => q.day.slice(0, 4)).sort().at(-1) ?? "2026";
  const etfQuote = quotes.find((q) => q.symbol === targetSymbol);
  const etfGuidance = analysis?.etfGuidance;
  const indicatorCount = segments.reduce((sum, s) => sum + s.symbols.length, 0);
  const isRefreshingAll = refreshingTarget === `${sector}:all` || refreshingTarget === "all:all";
  const isAnyRefreshing = !!refreshingTarget;
  const stageClean = analysis?.stage ? cleanSectorStage(analysis.stage) : "";
  const headlineClean = analysis?.headline
    ? cleanSectorHeadline(analysis.headline)
    : "";

  return (
    <section
      aria-label={
        isAviation
          ? "航空业与中国东航产业链汇总研判"
          : isHstech
            ? "恒生科技与港股互联网汇总研判"
            : "生猪与猪肉产业链汇总研判"
      }
      className="card p-4 sm:p-6 shadow-sm"
    >
      {/* 1. Header: Title, Timestamp & Intraday Manual Refresh */}
      <div className="flex flex-col gap-2.5 lg:flex-row lg:items-center lg:justify-between border-b border-line pb-3.5">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-[18px] sm:text-[19px] font-bold text-ink">
            {isAviation
              ? "航空业周期与油汇智能研判"
              : isHstech
                ? "恒生科技与港股互联网智能研判"
                : "生猪与猪肉产业链智能研判"}
          </h2>
        </div>

        <div className="flex flex-wrap items-center gap-2 self-start lg:self-auto shrink-0">
          {analysis?.analyzedAt && (
            <button
              type="button"
              onClick={onOpenModels}
              title="点击查看 AI 模型通道与研判调用记录"
              className="num text-[11.5px] text-ink-4 hover:text-accent transition-colors"
            >
              研判于 {beijingStamp(analysis.analyzedAt)}
            </button>
          )}

          {onManualRefresh && (
            <div className="flex items-center gap-2">
              {feedbackNotice && (
                <span
                  className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-semibold border ${
                    feedbackNotice.isError
                      ? "border-hot/30 bg-hot-soft text-hot"
                      : "border-ok/30 bg-ok-soft text-ok-ink"
                  }`}
                >
                  {feedbackNotice.isError ? "⚠️" : "✓"} {feedbackNotice.text}
                </span>
              )}
              <button
                type="button"
                disabled={isAnyRefreshing}
                onClick={onManualRefresh}
                title="拉取本板块最新盘中行情，并立即发起双路 AI 深度重算（产业链全局+个股/指标解读 + 核心标的波段策略）"
                className="inline-flex items-center gap-1.5 rounded-control bg-accent px-3 py-1.5 text-[12px] font-semibold text-accent-contrast shadow-xs hover:opacity-90 active:scale-[0.98] disabled:opacity-50 transition-all cursor-pointer"
              >
                <svg
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.75"
                  className={`size-3.5 shrink-0 ${isRefreshingAll ? "animate-spin" : ""}`}
                  aria-hidden="true"
                >
                  <path d="M13.5 8a5.5 5.5 0 1 1-1.35-3.6" strokeLinecap="round" />
                  <path d="M13.5 2v2.6h-2.6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <span>{isRefreshingAll ? "正在重算…" : "更新行情+AI重算"}</span>
              </button>
            </div>
          )}
        </div>
      </div>

      {/* 2. AI Headline & Deep 4-Dimension Grid */}
      {analysis && (
        <div className="mt-4 space-y-2.5">
          <div className="rounded-control bg-well/75 border border-line px-3.5 py-2.5 flex items-start sm:items-center gap-2 text-[13px] sm:text-[13.5px] leading-relaxed">
            <svg
              viewBox="0 0 20 20"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              className="size-4.5 shrink-0 text-accent mt-0.5 sm:mt-0"
              aria-hidden="true"
            >
              <path d="M2.5 10h3l2-5 4 10 2.5-5h3.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <div className="min-w-0">
              {stageClean && (
                <span className="font-bold text-accent mr-2">
                  {stageClean}
                </span>
              )}
              <span className="text-ink font-medium">
                {headlineClean}
              </span>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5">
            {analysis.bullets.map((b) => (
              <div
                key={b.dimension}
                className="rounded-control bg-bg-sunk/70 border border-line-soft p-3"
              >
                <div className="text-[12.5px] font-bold text-ink">{b.dimension}</div>
                <p className="mt-1.5 text-[12px] leading-relaxed text-ink-2">
                  {b.assessment}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 3. Dedicated Target Asset (516670 ETF or 600115 China Eastern) Cycle & Wave Guidance Section */}
      {etfGuidance && (
        <div className="mt-5">
          <Etf516670GuidanceSection
            etfQuote={etfQuote}
            guidance={etfGuidance}
            referenceYear={referenceYear}
            sector={sector}
            onMarketsUpdated={onMarketsUpdated}
          />
        </div>
      )}

      {/* 4. Divider */}
      <div className="my-5 border-t border-line" />

      {/* 5. Consolidated Indicators Dashboard (Desktop Table + Mobile Stacked Segment Cards) */}
      <div>
        <div className="flex flex-col sm:flex-row sm:items-baseline sm:justify-between gap-1 mb-3">
          <h3 className="text-[15px] sm:text-[16px] font-bold text-ink">
            {isAviation
              ? `航空业核心参数看板（${indicatorCount}项）`
              : isHstech
                ? `恒生科技核心成分与宏观看板（${indicatorCount}项）`
                : `产业链核心参数看板（${indicatorCount}项）`}
          </h3>
          <span className="text-[11px] text-ink-4 shrink-0">
            红涨绿跌 · 虚线为成本或行业基准线
          </span>
        </div>

        {/* 5A. Mobile Stacked Cards (< md) */}
        <div className="space-y-4 md:hidden">
          {segments.map((seg) => {
            const segQuotes = seg.symbols
              .map((sym) => quotes.find((q) => q.symbol === sym))
              .filter((q): q is MarketQuote => q !== undefined);
            if (segQuotes.length === 0) return null;
            return (
              <div key={seg.key} className="space-y-2">
                <div className="rounded bg-bg-sunk px-3 py-1.5 border border-line-soft flex items-center gap-2">
                  <span className="font-bold text-[12.5px] text-ink">{seg.title}</span>
                  <span className="rounded bg-accent-soft px-1.5 py-0.5 text-[10.5px] font-semibold text-accent-ink">
                    {seg.tag}
                  </span>
                </div>
                <div className="space-y-2">
                  {segQuotes.map((q) => (
                    <MobilePorkIndicatorCard
                      key={q.symbol}
                      q={q}
                      referenceYear={referenceYear}
                      aiInsight={analysis?.indicatorInsights?.[q.symbol]}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>

        {/* 5B. Desktop Structured Table (>= md) */}
        <div className="hidden md:block overflow-x-auto">
          <table className="w-full min-w-[860px] border-collapse text-left text-[13px]">
            <thead>
              <tr className="border-b border-line text-[11.5px] font-medium text-ink-4">
                <th className="py-2 pr-3 font-medium">指标名称</th>
                <th className="py-2 px-2.5 font-medium text-right">最新值</th>
                <th className="py-2 px-2.5 font-medium text-center">{isAviation || isHstech ? "核心传导机制" : "传导周期"}</th>
                <th className="py-2 px-2.5 font-medium text-right">趋势(周均/季)</th>
                <th className="py-2 px-2.5 font-medium text-right">环比 (周 / 月)</th>
                <th className="py-2 px-2.5 font-medium text-left">{isAviation || isHstech ? "成本 / 估值锚点" : "成本 / 政策锚点"}</th>
                <th className="py-2 pl-2.5 font-medium text-left">周期状态与 AI 解读</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line-soft">
              {segments.map((seg) => {
                const segQuotes = seg.symbols
                  .map((sym) => quotes.find((q) => q.symbol === sym))
                  .filter((q): q is MarketQuote => q !== undefined);
                if (segQuotes.length === 0) return null;
                return (
                  <Fragment key={seg.key}>
                    <tr className="bg-bg-sunk/70 border-y border-line">
                      <td colSpan={7} className="py-1.5 px-3">
                        <div className="flex items-center gap-2">
                          <span className="font-bold text-[12px] text-ink">{seg.title}</span>
                          <span className="rounded bg-accent-soft px-1.5 py-0.5 text-[10.5px] font-semibold text-accent-ink">
                            {seg.tag}
                          </span>
                        </div>
                      </td>
                    </tr>
                    {segQuotes.map((q) => {
                      const currPrefix = q.currency === "HKD" ? "HK$" : q.currency === "USD" ? "$" : "";
                      const unitLabel = q.unit.startsWith(":") ? q.unit : q.unit === "%" ? "%" : ` / ${q.unit}`;
                      const stat = formatStatDate(q, referenceYear);
                      const bench = fallbackBenchmark(q);
                      const aiInsight = analysis?.indicatorInsights?.[q.symbol];
                      const effectiveTone = aiInsight?.tone ?? bench.statusTone;
                      const effectiveBadge = aiInsight?.badge || bench.statusBadge;
                      const effectiveComment = aiInsight?.comment || bench.statusDesc;
                      const badgeClass = TONE_BADGE_CLASSES[effectiveTone] ?? TONE_BADGE_CLASSES.neutral;
                      const isQuarterly = q.statFrequency === "quarterly" || q.symbol === "sow_inventory" || q.symbol === "caac_load_factor";
                      const primaryChange = isQuarterly ? q.changeYesterday : (q.change1w ?? q.changeYesterday);
                      const secondaryChange = isQuarterly ? null : q.change1m;

                      return (
                        <tr key={q.symbol} className="hover:bg-bg-sunk/40 transition-colors">
                          {/* 1. Name & Date */}
                          <td className="py-2.5 pr-3" title={q.note ?? undefined}>
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <span className="font-bold text-ink text-[13.5px]">{q.name}</span>
                              <span className="text-[10.5px] text-ink-4 rounded bg-bg-sunk px-1.5 py-0.5 border border-line-soft">
                                {stat.label}
                              </span>
                            </div>
                          </td>

                          {/* 2. Price / Value & Converted unit */}
                          <td className="py-2.5 px-2.5 text-right">
                            <div className="num font-bold text-[14.5px] text-ink whitespace-nowrap">
                              {currPrefix}{formatPrice(q.price)}
                              <span className="text-[11.5px] font-normal text-ink-4 ml-1">{unitLabel}</span>
                            </div>
                            {q.cnyPrice !== null && (
                              <div className="num text-[11px] text-accent mt-0.5 whitespace-nowrap">
                                折合 ¥{formatPrice(q.cnyPrice)}/{q.cnyUnit}
                              </div>
                            )}
                          </td>

                          {/* 3. Horizon */}
                          <td className="py-2.5 px-2.5 text-center whitespace-nowrap">
                            <span className="inline-block rounded-full bg-well px-2.5 py-0.5 text-[11px] font-medium text-ink-2 border border-line">
                              {q.horizon ?? "即期"}
                            </span>
                          </td>

                          {/* 4. Smoothed Weekly / Quarterly Trend Sparkline */}
                          <td className="py-2.5 px-2.5 text-right whitespace-nowrap">
                            <CycleTrendSparkline
                              points={q.weeklySeries}
                              isQuarterly={isQuarterly}
                              referenceLine={bench.referenceLine}
                            />
                          </td>

                          {/* 5. WoW / QoQ + 30d Change */}
                          <td className="py-2.5 px-2.5 text-right whitespace-nowrap">
                            <div
                              className="inline-flex flex-col items-end gap-0.5"
                              title={
                                isQuarterly
                                  ? `季环比: ${formatPct(primaryChange)} (较上一季度)`
                                  : `周环比: ${formatPct(primaryChange)} (较7日前)\n近一月: ${formatPct(secondaryChange)} (较30日前)`
                              }
                            >
                              <div className="flex items-center justify-end gap-1.5">
                                <span className="text-[11px] text-ink-4">{isQuarterly ? "季环比" : "周环比"}</span>
                                <span className={`num font-bold text-[12.5px] ${tone(primaryChange)}`}>
                                  {formatPct(primaryChange)}
                                </span>
                              </div>
                              {secondaryChange !== null && (
                                <div className="flex items-center justify-end gap-1.5">
                                  <span className="text-[11px] text-ink-4">近一月</span>
                                  <span className={`num font-bold text-[12.5px] ${tone(secondaryChange)}`}>
                                    {formatPct(secondaryChange)}
                                  </span>
                                </div>
                              )}
                            </div>
                          </td>

                          {/* 6. Cost / Policy Benchmark */}
                          <td className="py-2.5 px-2.5">
                            <div className="font-semibold text-[12.5px] text-ink whitespace-nowrap">
                              {bench.anchorText}
                            </div>
                            {bench.anchorSub && (
                              <div className="num text-[11px] text-ink-4 mt-0.5 whitespace-nowrap">
                                {bench.anchorSub}
                              </div>
                            )}
                          </td>

                          {/* 7. Cyclical Position Badge & AI Insight */}
                          <td className="py-2.5 pl-2.5 max-w-[270px]">
                            <div className="flex flex-col items-start gap-1">
                              <span className={`inline-flex items-center rounded px-2 py-0.5 text-[11px] font-bold border ${badgeClass}`}>
                                {effectiveBadge}
                              </span>
                              {effectiveComment && (
                                <span className="text-[11.5px] leading-snug text-ink-3">
                                  {effectiveComment}
                                </span>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="mt-3 border-t border-line-soft pt-2.5 text-[11px] text-ink-4">
          {isAviation
            ? "💡 2026航空业校准基准：航油占航司营业成本约 35%（内盘原油舒适线 ¥520/桶 · 警戒线 ¥620/桶）· 美元兑人民币升值红利线 ≤6.85:1 · 民航局正班客座率保本线 78.0%（高景气提价线 ≥83.0%）。"
            : isHstech
              ? "💡 2026恒生科技校准基准：恒指科技低估击球线 ≤4200点 · 合理估值中枢 5200点 · 情绪过热警戒 ≥6200点 · 离岸汇率顺风线 USD/CNY ≤6.90:1 · 场内ETF（513180）支持T+0回转交易。"
              : "💡 2026校准基准：完全成本 ¥13.2/kg（现金 ¥11.5）· 15kg仔猪保本 ¥300/头 · 二元母猪 ¥1650/头 · 能繁目标 3750万头（绿区92%~103%）· 猪粮比平衡点 6.0:1（<5.0一级预警）。"}
        </div>
      </div>
    </section>
  );
}

export default function MarketsPage() {
  const [data, setData] = useState<MarketsAnswer>({
    quotes: [],
    usdCnyRate: null,
    analysis: null,
    aviationAnalysis: null,
    hstechAnalysis: null,
  });
  const [loading, setLoading] = useState(true);
  const [tabKey, setTabKey] = useState<string>(() => {
    if (typeof window === "undefined") return MARKET_TABS[0]!.key;
    const p = new URLSearchParams(window.location.search).get("tab");
    return MARKET_TABS.find((t) => t.key === p)?.key ?? MARKET_TABS[0]!.key;
  });
  const [dark, setDark] = useState<boolean>(() => {
    if (typeof document === "undefined") return false;
    return document.documentElement.getAttribute("data-theme") === "dark";
  });
  const [refreshingTarget, setRefreshingTarget] = useState<string | null>(null);
  const [sectorNotices, setSectorNotices] = useState<Record<string, { text: string; isError?: boolean }>>({});

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const res = await fetch("/api/markets");
        if (!res.ok) return;
        const json = (await res.json()) as MarketsAnswer;
        if (active) {
          setData(json);
          setLoading(false);
        }
      } catch {
        if (active) setLoading(false);
      }
    };
    void load();
    const interval = setInterval(() => void load(), 60_000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, []);

  const handleManualRefresh = async (
    category: "pork" | "aviation" | "hstech" | "macro" | "all",
    mode: "all" | "quotes" | "ai",
  ) => {
    const key = `${category}:${mode}`;
    setRefreshingTarget(key);
    try {
      const res = await fetch(
        `/api/markets/refresh?category=${encodeURIComponent(category)}&mode=${encodeURIComponent(mode)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ category, mode }),
        },
      );
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      const json = (await res.json()) as {
        ok: boolean;
        refreshedAt?: string;
        markets?: MarketsAnswer;
      };
      if (json.markets) {
        setData(json.markets);
      } else {
        const reloadRes = await fetch("/api/markets");
        if (reloadRes.ok) {
          setData((await reloadRes.json()) as MarketsAnswer);
        }
      }
      const stamp = beijingDateTimeSec(json.refreshedAt ?? new Date().toISOString()).slice(11);
      setSectorNotices((prev) => ({
        ...prev,
        [category]: { text: `已更新 (${stamp})`, isError: false },
      }));
      setTimeout(() => {
        setSectorNotices((prev) => {
          const next = { ...prev };
          delete next[category];
          return next;
        });
      }, 4000);
    } catch (error) {
      setSectorNotices((prev) => ({
        ...prev,
        [category]: { text: `更新失败：${(error as Error).message}`, isError: true },
      }));
      setTimeout(() => {
        setSectorNotices((prev) => {
          const next = { ...prev };
          delete next[category];
          return next;
        });
      }, 5000);
    } finally {
      setRefreshingTarget(null);
    }
  };

  const handleSelectTab = (key: string) => {
    setTabKey(key);
    const url = new URL(window.location.href);
    if (key === MARKET_TABS[0]!.key) {
      url.searchParams.delete("tab");
    } else {
      url.searchParams.set("tab", key);
    }
    window.history.replaceState(null, "", url.toString());
  };

  const toggleTheme = () => {
    const next = !dark;
    setDark(next);
    if (next) {
      document.documentElement.setAttribute("data-theme", "dark");
      localStorage.setItem("mymarkets-theme", "dark");
    } else {
      document.documentElement.removeAttribute("data-theme");
      localStorage.setItem("mymarkets-theme", "light");
    }
  };

  const currentTab = MARKET_TABS.find((t) => t.key === tabKey) ?? MARKET_TABS[0]!;
  const marketGroupTabs = MARKET_TABS.filter((t) => t.group === "market");
  const systemGroupTabs = MARKET_TABS.filter((t) => t.group === "system");

  const { quotes, usdCnyRate, analysis, aviationAnalysis, hstechAnalysis } = data;
  const activeQuotes = quotes.filter((q) => q.category === currentTab.category);

  const getTabBadge = (key: string) => {
    if (key === "pork") return analysis?.source === "ai" ? "AI" : "规则";
    if (key === "aviation") return aviationAnalysis?.source === "ai" ? "AI" : "规则";
    if (key === "hstech") return hstechAnalysis?.source === "ai" ? "AI" : "规则";
    if (key === "macro") {
      const cnt = quotes.filter((q) => q.category === "macro").length;
      return cnt > 0 ? String(cnt) : null;
    }
    if (key === "models") return "查看";
    return null;
  };

  return (
    <div className="flex min-h-dvh bg-bg text-ink">
      {/* 1. Desktop Left Sidebar Navigation (>= lg) */}
      <aside
        aria-label="主导航栏"
        className="sticky top-0 hidden h-dvh w-[236px] shrink-0 flex-col border-r border-line bg-sidebar px-3.5 py-5 lg:flex"
      >
        {/* Brand Header */}
        <div className="mb-5 px-2">
          <div className="flex items-center gap-2.5">
            <span className="flex size-8 items-center justify-center rounded-control bg-accent text-accent-contrast shadow-xs">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                className="size-4.5"
                aria-hidden="true"
              >
                <path d="M4 17l5-5 3.5 3.5L20 7.5" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M15 7.5h5v5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
            <div>
              <h1 data-page-title="" className="text-[16px] font-bold leading-tight text-ink">
                MyMarkets 行情
              </h1>
              <p className="text-[11px] text-ink-4 mt-0.5">重点产业链与宏观智能研判</p>
            </div>
          </div>
        </div>

        {/* Navigation Groups */}
        <nav className="flex-1 space-y-5 overflow-y-auto px-0.5" aria-label="行情分类导航">
          <div>
            <div className="mb-1.5 px-2.5 text-[11px] font-semibold tracking-wide text-ink-4">
              重点产业链与宏观
            </div>
            <div className="space-y-1">
              {marketGroupTabs.map((item) => {
                const isActive = item.key === currentTab.key;
                const badge = getTabBadge(item.key);
                return (
                  <button
                    key={item.key}
                    type="button"
                    aria-current={isActive ? "page" : undefined}
                    onClick={() => handleSelectTab(item.key)}
                    className={`flex w-full items-center justify-between gap-2 rounded-control px-2.5 py-2 text-left text-[13.5px] transition-colors ${
                      isActive
                        ? "bg-accent-soft font-bold text-accent-ink ring-1 ring-accent/25"
                        : "font-medium text-ink-2 hover:bg-bg-sunk hover:text-ink"
                    }`}
                  >
                    <span className="flex items-center gap-2 min-w-0">
                      <span className="text-[15px] shrink-0">{item.icon}</span>
                      <span className="truncate">{item.label}</span>
                    </span>
                    {badge && (
                      <span
                        className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold leading-none ${
                          isActive
                            ? "bg-accent text-accent-contrast"
                            : badge === "AI"
                              ? "bg-accent-soft text-accent-ink"
                              : "bg-bg-sunk text-ink-4"
                        }`}
                      >
                        {badge}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <div className="mb-1.5 px-2.5 text-[11px] font-semibold tracking-wide text-ink-4">
              系统与模型监测
            </div>
            <div className="space-y-1">
              {systemGroupTabs.map((item) => {
                const isActive = item.key === currentTab.key;
                return (
                  <button
                    key={item.key}
                    type="button"
                    aria-current={isActive ? "page" : undefined}
                    onClick={() => handleSelectTab(item.key)}
                    className={`flex w-full items-center justify-between gap-2 rounded-control px-2.5 py-2 text-left text-[13.5px] transition-colors ${
                      isActive
                        ? "bg-accent-soft font-bold text-accent-ink ring-1 ring-accent/25"
                        : "font-medium text-ink-2 hover:bg-bg-sunk hover:text-ink"
                    }`}
                  >
                    <span className="flex items-center gap-2 min-w-0">
                      <span className="text-[15px] shrink-0">{item.icon}</span>
                      <span className="truncate">{item.label}</span>
                    </span>
                    <span
                      className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold leading-none ${
                        isActive ? "bg-accent text-accent-contrast" : "bg-ok-soft text-ok-ink"
                      }`}
                    >
                      额度/记录
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </nav>

        {/* Sidebar Footer: Theme Switch */}
        <div className="mt-4 border-t border-line pt-3.5 px-1">
          <button
            type="button"
            onClick={toggleTheme}
            aria-label="切换深浅色外观"
            className="flex w-full items-center justify-center gap-1.5 rounded-control border border-line bg-surface px-3 py-1.5 text-[12.5px] font-medium text-ink-2 hover:border-line-strong transition-colors"
          >
            {dark ? "☀️ 切换浅色模式" : "🌙 切换深色模式"}
          </button>
        </div>
      </aside>

      {/* 2. Main Content Column */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Mobile / Tablet Sticky Top Bar (< lg) */}
        <div className="sticky top-0 z-30 border-b border-line bg-bg/90 backdrop-blur lg:hidden">
          <div className="flex items-center justify-between gap-2 px-4 pt-3 pb-2">
            <div className="flex items-center gap-2 min-w-0">
              <span className="flex size-6 shrink-0 items-center justify-center rounded bg-accent text-accent-contrast">
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.3"
                  className="size-3.5"
                  aria-hidden="true"
                >
                  <path d="M4 17l5-5 3.5 3.5L20 7.5" strokeLinecap="round" strokeLinejoin="round" />
                  <path d="M15 7.5h5v5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </span>
              <span className="text-[15px] font-bold text-ink truncate">MyMarkets 行情与研判</span>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <button
                type="button"
                onClick={() => handleSelectTab("models")}
                className={`rounded-control border px-2.5 py-1 text-[11.5px] font-semibold transition-colors ${
                  currentTab.key === "models"
                    ? "border-accent bg-accent-soft text-accent-ink"
                    : "border-line bg-surface text-ink-2"
                }`}
              >
                🤖 模型与额度
              </button>
              <button
                type="button"
                onClick={toggleTheme}
                aria-label="切换深浅色外观"
                className="rounded-control border border-line bg-surface px-2.5 py-1 text-[11.5px] font-medium text-ink-2"
              >
                {dark ? "☀️" : "🌙"}
              </button>
            </div>
          </div>

          <nav className="scrollbar-none flex gap-1.5 overflow-x-auto px-4 pb-2.5" aria-label="移动端导航">
            {MARKET_TABS.map((item) => {
              const active = item.key === currentTab.key;
              return (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => handleSelectTab(item.key)}
                  className={`shrink-0 inline-flex items-center gap-1 whitespace-nowrap rounded-full px-3 py-1 text-[12.5px] font-medium transition-colors ${
                    active
                      ? "bg-accent text-accent-contrast font-semibold"
                      : "bg-well text-ink-3 hover:text-ink border border-line-soft"
                  }`}
                >
                  <span>{item.icon}</span>
                  <span>{item.label}</span>
                </button>
              );
            })}
          </nav>
        </div>

        {/* Main Workspace Container */}
        <main className="mx-auto w-full max-w-[1440px] flex-1 px-4 sm:px-6 lg:px-8 py-4 sm:py-6 pb-12">
          {currentTab.key === "models" ? (
            <LlmChannelsPanel
              porkAnalysis={analysis}
              aviationAnalysis={aviationAnalysis}
              hstechAnalysis={hstechAnalysis}
              onSelectSector={handleSelectTab}
              onTriggerRefresh={handleManualRefresh}
              refreshingTarget={refreshingTarget}
            />
          ) : loading && quotes.length === 0 ? (
            <div className="card p-8 text-center text-[13.5px] text-ink-3">正在加载行情数据…</div>
          ) : quotes.length === 0 ? (
            <div className="card p-8 text-center text-[13.5px] text-ink-3">暂无行情数据，等待下一次定时更新。</div>
          ) : (
            <div>
              {/* Tab: 生猪产业链 (单卡片汇总 + AI研判 + 516670指南 + 9大核心指标看板) */}
              {currentTab.key === "pork" && (
                activeQuotes.length > 0 ? (
                  <ConsolidatedPorkSummaryCard
                    quotes={activeQuotes}
                    analysis={analysis}
                    sector="pork"
                    onOpenModels={() => handleSelectTab("models")}
                    onManualRefresh={() => void handleManualRefresh("pork", "all")}
                    refreshingTarget={refreshingTarget}
                    feedbackNotice={sectorNotices.pork}
                    onMarketsUpdated={setData}
                  />
                ) : (
                  <div className="card p-8 text-center text-[13.5px] text-ink-3">暂无生猪产业链数据。</div>
                )
              )}

              {/* Tab: 航空业 (单卡片汇总 + AI研判 + 中国东航600115指南 + 8大核心指标看板) */}
              {currentTab.key === "aviation" && (
                activeQuotes.length > 0 ? (
                  <ConsolidatedPorkSummaryCard
                    quotes={activeQuotes}
                    analysis={aviationAnalysis}
                    sector="aviation"
                    onOpenModels={() => handleSelectTab("models")}
                    onManualRefresh={() => void handleManualRefresh("aviation", "all")}
                    refreshingTarget={refreshingTarget}
                    feedbackNotice={sectorNotices.aviation}
                    onMarketsUpdated={setData}
                  />
                ) : (
                  <div className="card p-8 text-center text-[13.5px] text-ink-3">暂无航空业产业链数据。</div>
                )
              )}

              {/* Tab: 恒生科技 (单卡片汇总 + AI研判 + 恒生科技ETF 513180指南 + 8大核心指标看板) */}
              {currentTab.key === "hstech" && (
                activeQuotes.length > 0 ? (
                  <ConsolidatedPorkSummaryCard
                    quotes={activeQuotes}
                    analysis={hstechAnalysis}
                    sector="hstech"
                    onOpenModels={() => handleSelectTab("models")}
                    onManualRefresh={() => void handleManualRefresh("hstech", "all")}
                    refreshingTarget={refreshingTarget}
                    feedbackNotice={sectorNotices.hstech}
                    onMarketsUpdated={setData}
                  />
                ) : (
                  <div className="card p-8 text-center text-[13.5px] text-ink-3">暂无恒生科技板块数据。</div>
                )
              )}

              {/* Tab: 全球大宗与股指 (4项基准指标) */}
              {currentTab.key === "macro" && (
                <div>
                  <div className="border-b border-line pb-2.5 mb-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                    <div>
                      <h2 className="text-[18px] font-bold text-ink">全球大宗商品与主要指数</h2>
                      <p className="mt-0.5 text-[12px] text-ink-3">
                        布伦特原油、伦敦现货黄金（1 金衡盎司 ≈ 31.1035 克{usdCnyRate ? `，参考汇率 USD/CNY ${usdCnyRate.toFixed(4)}` : ""}）、上证指数与恒生科技指数
                      </p>
                    </div>
                  </div>
                  {activeQuotes.length > 0 ? (
                    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 2xl:grid-cols-4">
                      {activeQuotes.map((q) => (
                        <MacroPanel key={q.symbol} q={q} />
                      ))}
                    </div>
                  ) : (
                    <div className="card p-8 text-center text-[13.5px] text-ink-3">暂无大宗与指数数据。</div>
                  )}
                </div>
              )}

              {/* 默认兜底：未来增加新 Tab（如粮食作物、能源化工等）时的通用自适应渲染 */}
              {currentTab.key !== "pork" && currentTab.key !== "aviation" && currentTab.key !== "hstech" && currentTab.key !== "macro" && (
                <div>
                  <div className="border-b border-line pb-2 mb-4">
                    <h2 className="text-[17px] font-bold text-ink">{currentTab.label}</h2>
                    <p className="mt-0.5 text-[12px] text-ink-3">{currentTab.description}</p>
                  </div>
                  <div className="grid grid-cols-1 gap-4 md:grid-cols-2 2xl:grid-cols-3">
                    {activeQuotes.map((q) => (
                      <MacroPanel key={q.symbol} q={q} />
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
