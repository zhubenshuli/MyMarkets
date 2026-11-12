import { useState } from "react";
import type {
  MarketCategory,
  MarketsAnswer,
  PorkStatusTone,
  PotentialFundItem,
  PotentialFundsOverview,
  PotentialFundTier,
  PotentialFundTrack,
} from "../../shared/types.ts";

const TONE_BADGE_CLASSES: Record<PorkStatusTone, string> = {
  critical: "text-hot bg-hot-soft border-hot/30",
  caution: "text-amber-ink bg-amber-soft border-amber/30",
  positive: "text-ok-ink bg-ok-soft border-ok/30",
  accent: "text-accent-ink bg-accent-soft border-accent/30",
  neutral: "text-ink-2 bg-bg-sunk border-line",
};

const fmt = (v: number | null | undefined, digits = 3): string =>
  typeof v === "number" && Number.isFinite(v) ? v.toFixed(digits) : "—";

const fmtPct = (v: number | null | undefined, digits = 1): string =>
  typeof v === "number" && Number.isFinite(v) ? `${(v * 100).toFixed(digits)}%` : "—";

/** Mini cycle sparkline for potential funds */
function FundSparkline({
  points,
  referenceLine,
}: {
  points: PotentialFundItem["weeklySeries"];
  referenceLine?: number | null;
}) {
  if (!points || !Array.isArray(points) || points.length < 2) {
    return <span className="text-[11px] text-ink-4">—</span>;
  }
  const values = points.map((p) => p.close).filter((v) => typeof v === "number" && Number.isFinite(v));
  if (values.length < 2) {
    return <span className="text-[11px] text-ink-4">—</span>;
  }
  const dataMin = Math.min(...values);
  const dataMax = Math.max(...values);

  const showRef =
    typeof referenceLine === "number" &&
    Number.isFinite(referenceLine) &&
    referenceLine >= dataMin * 0.85 &&
    referenceLine <= dataMax * 1.15;

  const min = showRef ? Math.min(dataMin, referenceLine!) : dataMin;
  const max = showRef ? Math.max(dataMax, referenceLine!) : dataMax;
  const span = max - min || 1;
  const width = 84;
  const height = 24;
  const pad = 2;

  const coords = points.map((p, i) => {
    const x = (i / (points.length - 1)) * width;
    const y = pad + (1 - (p.close - min) / span) * (height - pad * 2);
    return { x, y };
  });
  const polyline = coords.map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(" ");
  const lastCoord = coords[coords.length - 1] ?? coords[0]!;
  const firstVal = points[0]?.close ?? 0;
  const lastVal = points[points.length - 1]?.close ?? 0;
  const netDiff = lastVal - firstVal;
  const strokeTone = Math.abs(netDiff) < 1e-4 ? "text-ink-4" : netDiff > 0 ? "text-hot" : "text-ok";

  return (
    <div className="inline-flex flex-col items-end" title={`近${points.length}周均走势: ¥${firstVal.toFixed(3)} → ¥${lastVal.toFixed(3)}`}>
      <svg viewBox={`0 0 ${width} ${height}`} className={`h-5 w-[84px] overflow-visible ${strokeTone}`} aria-hidden="true">
        <polyline
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          points={polyline}
        />
        <circle cx={lastCoord.x.toFixed(1)} cy={lastCoord.y.toFixed(1)} r="2" fill="currentColor" />
      </svg>
      <div className="num mt-0.5 text-[9.5px] text-ink-4 whitespace-nowrap">
        近{points.length}周 ¥{firstVal.toFixed(3)}→¥{lastVal.toFixed(3)}
      </div>
    </div>
  );
}

export function PotentialFundsPanel({
  overview,
  onMarketsUpdated,
  onTriggerRefresh,
  refreshing,
}: {
  overview: PotentialFundsOverview | null | undefined;
  onMarketsUpdated: (data: MarketsAnswer) => void;
  onTriggerRefresh: (category: MarketCategory, mode: "all" | "quotes" | "ai") => Promise<void>;
  refreshing?: boolean;
}) {
  const [activeFilter, setActiveFilter] = useState<"all" | "prime" | PotentialFundTrack>("all");
  const [newCode, setNewCode] = useState("");
  const [newSector, setNewSector] = useState("");
  const [newThesis, setNewThesis] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [isAdding, setIsAdding] = useState(false);
  const [isResetting, setIsResetting] = useState(false);
  const [deletingCode, setDeletingCode] = useState<string | null>(null);

  if (!overview) {
    return (
      <div className="card p-8 text-center text-[13.5px] text-ink-3">
        正在加载跨赛道潜力基金与机会雷达数据…
      </div>
    );
  }

  const items = overview.items ?? [];

  // Filter items
  const filteredItems = items.filter((item) => {
    if (activeFilter === "prime") return item.tier === "prime";
    if (activeFilter === "bottom_ambush") return item.track === "bottom_ambush";
    if (activeFilter === "right_breakout") return item.track === "right_breakout";
    return true;
  });

  const handleAddFund = async (e: React.FormEvent) => {
    e.preventDefault();
    const code = newCode.trim();
    if (!/^\d{6}$/.test(code)) {
      setActionError("请输入 6 位纯数字基金代码（如 512170、159819）");
      return;
    }
    setIsAdding(true);
    setActionError(null);
    try {
      const res = await fetch("/api/funds/watchlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code,
          sectorTag: newSector.trim() || undefined,
          thesis: newThesis.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "添加基金失败");
      }
      setNewCode("");
      setNewSector("");
      setNewThesis("");
      if (data.markets) {
        onMarketsUpdated(data.markets);
      }
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setIsAdding(false);
    }
  };

  const handleDeleteFund = async (code: string) => {
    if (!window.confirm(`确定从潜力基金池中移除代码 ${code} 吗？`)) {
      return;
    }
    setDeletingCode(code);
    setActionError(null);
    try {
      const res = await fetch(`/api/funds/watchlist/${code}`, {
        method: "DELETE",
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "移除基金失败");
      }
      if (data.markets) {
        onMarketsUpdated(data.markets);
      }
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setDeletingCode(null);
    }
  };

  const handleResetDefault = async () => {
    if (!window.confirm("确定将潜力基金池重置为系统默认的 10 只全赛道龙头 ETF 吗？")) {
      return;
    }
    setIsResetting(true);
    setActionError(null);
    try {
      const res = await fetch("/api/funds/watchlist/reset", {
        method: "POST",
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "重置基金池失败");
      }
      if (data.markets) {
        onMarketsUpdated(data.markets);
      }
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setIsResetting(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* 1. Header Banner & AI Strategic Overview */}
      <section className="card p-5 sm:p-6 border border-line bg-surface relative overflow-hidden">
        <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4">
          <div className="space-y-2 flex-1">
            <div className="flex items-center gap-2.5 flex-wrap">
              <span className="flex size-7 items-center justify-center rounded-control bg-accent text-accent-contrast font-bold text-sm">
                🎯
              </span>
              <h2 className="text-[19px] sm:text-[21px] font-bold text-ink">
                跨赛道潜力基金与机会雷达
              </h2>
              <span className="rounded-full bg-accent-soft px-2.5 py-0.5 text-[11px] font-semibold text-accent-ink border border-accent/20">
                双轨建仓雷达
              </span>
              <span className="text-[11px] text-ink-4">
                更新于 {overview.updatedAt}
              </span>
            </div>

            <p className="text-[13px] text-ink-3 leading-relaxed">
              覆盖科技、医药、内需消费、大宗周期等高流动性核心行业 ETF。通过 120 日历史分位、高点回撤、均线多空与量价动量，双轨挖掘「🛡️ 底部超跌反转」与「🚀 右侧突破启动」机会，为首笔建仓与防守点位提供量化锚点。
            </p>

            {/* AI / Quant Overall Thesis */}
            <div className="mt-3.5 rounded-control border border-line-soft bg-bg-sunk/70 p-3.5 space-y-2">
              <div className="flex items-start gap-2">
                <span className="text-[15px] shrink-0">💡</span>
                <div className="text-[13.5px] font-semibold text-ink leading-snug">
                  {overview.headline || "跨赛道估值与动能分化，精选黄金击球区标的"}
                </div>
              </div>
              <p className="text-[12.5px] text-ink-2 pl-6 leading-relaxed">
                {overview.allocationAdvice || "建议保持哑铃型配置：在处于 120 日低估分位且企稳的品种分批建仓首笔底仓；对突破均线压制的右侧领涨龙头顺势跟踪，同时守好止损防守底线。"}
              </p>
            </div>
          </div>

          {/* Quick Metrics & Refresh Action */}
          <div className="flex flex-col sm:flex-row lg:flex-col items-start lg:items-end justify-between gap-3 shrink-0">
            <div className="flex flex-wrap gap-2 text-[12px]">
              <span className="inline-flex items-center gap-1.5 rounded-control bg-surface px-3 py-1.5 border border-line font-medium text-ink">
                总标的 <b className="text-ink font-bold">{overview.totalCount}</b>
              </span>
              <span className="inline-flex items-center gap-1.5 rounded-control bg-hot-soft px-3 py-1.5 border border-hot/30 font-semibold text-hot">
                🔥 黄金击球区 <b className="font-bold">{overview.primeCount}</b>
              </span>
              <span className="inline-flex items-center gap-1.5 rounded-control bg-sky-soft px-3 py-1.5 border border-sky/30 font-medium text-sky-700 dark:text-sky-300">
                🛡️ 底部埋伏 <b>{overview.bottomAmbushCount}</b>
              </span>
              <span className="inline-flex items-center gap-1.5 rounded-control bg-amber-soft px-3 py-1.5 border border-amber/30 font-medium text-amber-700 dark:text-amber-300">
                🚀 右侧启动 <b>{overview.rightBreakoutCount}</b>
              </span>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void onTriggerRefresh("funds", "all")}
                disabled={refreshing}
                className="inline-flex items-center gap-1.5 rounded-control border border-line bg-surface hover:bg-bg-sunk px-3 py-1.5 text-[12px] font-semibold text-ink-2 transition-colors disabled:opacity-50"
              >
                <span>{refreshing ? "⏳" : "🔄"}</span>
                <span>{refreshing ? "正在刷新…" : "全量刷新雷达与AI研判"}</span>
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* 2. Filter Tabs & Fund Pool Management Bar */}
      <div className="space-y-3">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
          {/* Filter Pills */}
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={() => setActiveFilter("all")}
              className={`rounded-full px-3.5 py-1 text-[12.5px] font-semibold transition-colors ${
                activeFilter === "all"
                  ? "bg-accent text-accent-contrast shadow-xs"
                  : "bg-surface text-ink-3 hover:text-ink border border-line"
              }`}
            >
              全部 ({items.length})
            </button>
            <button
              type="button"
              onClick={() => setActiveFilter("prime")}
              className={`rounded-full px-3.5 py-1 text-[12.5px] font-semibold transition-colors ${
                activeFilter === "prime"
                  ? "bg-hot text-accent-contrast shadow-xs"
                  : "bg-surface text-ink-3 hover:text-ink border border-line"
              }`}
            >
              🔥 黄金击球区 ({items.filter((i) => i.tier === "prime").length})
            </button>
            <button
              type="button"
              onClick={() => setActiveFilter("bottom_ambush")}
              className={`rounded-full px-3.5 py-1 text-[12.5px] font-semibold transition-colors ${
                activeFilter === "bottom_ambush"
                  ? "bg-sky-600 text-white shadow-xs"
                  : "bg-surface text-ink-3 hover:text-ink border border-line"
              }`}
            >
              🛡️ 底部埋伏 ({items.filter((i) => i.track === "bottom_ambush").length})
            </button>
            <button
              type="button"
              onClick={() => setActiveFilter("right_breakout")}
              className={`rounded-full px-3.5 py-1 text-[12.5px] font-semibold transition-colors ${
                activeFilter === "right_breakout"
                  ? "bg-amber-600 text-white shadow-xs"
                  : "bg-surface text-ink-3 hover:text-ink border border-line"
              }`}
            >
              🚀 右侧启动 ({items.filter((i) => i.track === "right_breakout").length})
            </button>
          </div>

          {/* Watchlist Quick Add & Reset */}
          <div className="flex flex-wrap items-center gap-2">
            <form onSubmit={handleAddFund} className="flex items-center gap-1.5">
              <input
                type="text"
                placeholder="6位代码(如 512170)"
                maxLength={6}
                value={newCode}
                onChange={(e) => setNewCode(e.target.value)}
                className="w-32 rounded-control border border-line bg-surface px-2.5 py-1 text-[12px] text-ink focus:border-accent focus:outline-hidden"
              />
              <button
                type="submit"
                disabled={isAdding || !newCode.trim()}
                className="rounded-control bg-accent hover:bg-accent-hover text-accent-contrast px-3 py-1 text-[12px] font-semibold transition-colors disabled:opacity-40"
              >
                {isAdding ? "添加中…" : "+ 加入监控"}
              </button>
            </form>

            <button
              type="button"
              onClick={handleResetDefault}
              disabled={isResetting}
              title="重置为默认10只跨行业龙头ETF"
              className="rounded-control border border-line bg-surface hover:bg-bg-sunk text-ink-3 px-2.5 py-1 text-[12px] font-medium transition-colors disabled:opacity-50"
            >
              {isResetting ? "重置中…" : "重置默认池"}
            </button>
          </div>
        </div>

        {actionError && (
          <div className="rounded-control border border-hot/30 bg-hot-soft p-2.5 text-[12px] text-hot flex items-center justify-between">
            <span>⚠️ {actionError}</span>
            <button
              type="button"
              onClick={() => setActionError(null)}
              className="text-hot font-bold hover:underline ml-2"
            >
              ✕
            </button>
          </div>
        )}
      </div>

      {/* 3. Potential Funds Cards Grid */}
      {filteredItems.length === 0 ? (
        <div className="card p-12 text-center text-[13.5px] text-ink-3 border border-line">
          当前筛选条件下暂无标的。可切换过滤标签或在右上角添加新的 6 位基金代码进行监控。
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4.5">
          {filteredItems.map((item) => {
            const isHitPrime = item.tier === "prime";
            const isNearEntry = item.price <= item.entryBuyPrice * 1.01;
            const diffPctToBuy = ((item.price - item.entryBuyPrice) / item.entryBuyPrice) * 100;
            const badgeClass = TONE_BADGE_CLASSES[item.tierTone] ?? TONE_BADGE_CLASSES.neutral;

            return (
              <div
                key={item.code}
                className={`card p-4.5 border transition-all flex flex-col justify-between ${
                  isHitPrime
                    ? "border-hot/45 ring-1 ring-hot/20 bg-surface"
                    : "border-line bg-surface hover:border-line-strong"
                }`}
              >
                <div className="space-y-3.5">
                  {/* Card Header: Code, Name, Sector Tag, Track, Delete */}
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="text-[16px] font-bold text-ink truncate">
                          {item.name}
                        </span>
                        <span className="num text-[12px] font-semibold text-ink-3">
                          {item.code}
                        </span>
                        <span className="rounded bg-bg-sunk px-1.5 py-0.5 text-[10.5px] font-medium text-ink-3 border border-line-soft">
                          {item.sectorTag}
                        </span>
                        {!item.isBuiltin && (
                          <span className="rounded bg-accent-soft px-1.5 py-0.5 text-[10px] font-semibold text-accent-ink">
                            自选
                          </span>
                        )}
                      </div>
                      <p className="text-[11px] text-ink-4 mt-0.5 truncate" title={item.thesis}>
                        {item.thesis}
                      </p>
                    </div>

                    <div className="flex items-center gap-1.5 shrink-0">
                      {/* Track Badge */}
                      <span
                        className={`rounded-full px-2 py-0.5 text-[10.5px] font-bold border ${
                          item.track === "bottom_ambush"
                            ? "bg-sky-50 text-sky-700 border-sky-300/40 dark:bg-sky-950/40 dark:text-sky-300"
                            : "bg-amber-50 text-amber-700 border-amber-300/40 dark:bg-amber-950/40 dark:text-amber-300"
                        }`}
                      >
                        {item.track === "bottom_ambush" ? "🛡️ 底部埋伏" : "🚀 右侧启动"}
                      </span>

                      {/* Remove Button */}
                      <button
                        type="button"
                        onClick={() => handleDeleteFund(item.code)}
                        disabled={deletingCode === item.code}
                        title={`移除 ${item.name} (${item.code})`}
                        className="size-5 rounded flex items-center justify-center text-ink-4 hover:text-hot hover:bg-bg-sunk transition-colors text-[13px]"
                      >
                        ✕
                      </button>
                    </div>
                  </div>

                  {/* Card Price & Score Highlight Row */}
                  <div className="flex items-end justify-between gap-3 border-b border-line-soft pb-3">
                    <div>
                      <div className="flex items-baseline gap-2">
                        <span className="num text-[22px] font-bold tracking-tight text-ink">
                          ¥{fmt(item.price)}
                        </span>
                        <span
                          className={`num text-[12px] font-semibold ${
                            (item.changeYesterday ?? 0) > 0
                              ? "text-hot"
                              : (item.changeYesterday ?? 0) < 0
                                ? "text-ok"
                                : "text-ink-4"
                          }`}
                        >
                          {item.changeYesterday !== null && item.changeYesterday !== undefined
                            ? `${item.changeYesterday > 0 ? "+" : ""}${fmtPct(item.changeYesterday, 2)}`
                            : "—"}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 mt-0.5 text-[10.5px] text-ink-4">
                        <span>
                          近1月:{" "}
                          <b
                            className={`font-semibold ${
                              (item.change1m ?? 0) > 0
                                ? "text-hot"
                                : (item.change1m ?? 0) < 0
                                  ? "text-ok"
                                  : "text-ink-4"
                            }`}
                          >
                            {item.change1m !== null && item.change1m !== undefined
                              ? `${item.change1m > 0 ? "+" : ""}${fmtPct(item.change1m, 1)}`
                              : "—"}
                          </b>
                        </span>
                        <span>·</span>
                        <span>
                          距高点:{" "}
                          <b className="font-semibold text-ok">
                            -{fmtPct(Math.abs(item.drawdownFrom120dHighPct ?? 0), 1)}
                          </b>
                        </span>
                      </div>
                    </div>

                    <div className="flex flex-col items-end gap-1">
                      <div className="flex items-center gap-1.5">
                        <span className="num text-[18px] font-bold text-ink">
                          {item.score ?? 50}
                        </span>
                        <span className={`rounded px-1.5 py-0.5 text-[10.5px] font-bold border ${badgeClass}`}>
                          {item.tierLabel || "待机"}
                        </span>
                      </div>
                      <FundSparkline points={item.weeklySeries} referenceLine={item.entryBuyPrice} />
                    </div>
                  </div>

                  {/* 120-Day Range & Water-level Bar */}
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between text-[11px] text-ink-3">
                      <span>120日估值水位</span>
                      <span className="font-semibold text-ink">
                        {fmt(item.percentile120d, 1)}% 分位
                        {(item.percentile120d ?? 50) <= 25
                          ? " (深度低估)"
                          : (item.percentile120d ?? 50) >= 75
                            ? " (高位防守)"
                            : " (中位震荡)"}
                      </span>
                    </div>

                    <div className="relative h-2 w-full rounded-full bg-bg-sunk overflow-hidden border border-line-soft">
                      <div
                        className={`h-full rounded-full transition-all ${
                          (item.percentile120d ?? 50) <= 25
                            ? "bg-ok"
                            : (item.percentile120d ?? 50) <= 60
                              ? "bg-accent"
                              : "bg-amber"
                        }`}
                        style={{ width: `${Math.min(100, Math.max(4, item.percentile120d ?? 50))}%` }}
                      />
                    </div>

                    <div className="flex items-center justify-between text-[10px] text-ink-4">
                      <span>120日低: ¥{fmt(item.low120d)}</span>
                      <span>120日高: ¥{fmt(item.high120d)}</span>
                    </div>
                  </div>

                  {/* Entry Hitting Strategy Box (建议建仓价 & 强支撑防守) */}
                  <div className="rounded-control border border-line-soft bg-bg-sunk/60 p-3 space-y-2">
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="font-semibold text-ink-2">🎯 建仓雷达击球区</span>
                      <span
                        className={`font-semibold px-1.5 py-0.2 rounded text-[10px] ${
                          isNearEntry
                            ? "bg-hot text-accent-contrast font-bold animate-pulse"
                            : "bg-surface text-ink-3 border border-line"
                        }`}
                      >
                        {isNearEntry
                          ? "已进入建议区间"
                          : diffPctToBuy > 0
                            ? `距建仓位需跌 ${fmt(diffPctToBuy, 1)}%`
                            : "已击穿首笔买点"}
                      </span>
                    </div>

                    <div className="grid grid-cols-2 gap-2 text-[11.5px]">
                      <div className="rounded bg-surface p-2 border border-line">
                        <div className="text-[10px] text-ink-4">建议首笔建仓价</div>
                        <div className="num text-[14px] font-bold text-accent-ink mt-0.5">
                          ¥{fmt(item.entryBuyPrice)}
                        </div>
                        <div className="text-[9.5px] text-ink-4 truncate mt-0.5" title={item.entryBuyAnchor}>
                          {item.entryBuyAnchor || "估值支撑位"}
                        </div>
                      </div>

                      <div className="rounded bg-surface p-2 border border-line">
                        <div className="text-[10px] text-ink-4">强支撑防守线</div>
                        <div className="num text-[14px] font-bold text-ink-2 mt-0.5">
                          ¥{fmt(item.strongSupportPrice)}
                        </div>
                        <div className="text-[9.5px] text-ink-4 truncate mt-0.5" title={item.strongSupportAnchor}>
                          {item.strongSupportAnchor || "大级别历史底"}
                        </div>
                      </div>
                    </div>

                    <div className="text-[10.5px] text-ink-3 font-medium flex items-center justify-between pt-0.5">
                      <span>策略导向: {item.strategyModeLabel || "区间震荡跟踪"}</span>
                    </div>
                  </div>

                  {/* AI / Quant Commentary */}
                  <div className="text-[11.5px] text-ink-2 bg-surface rounded p-2.5 border border-line-soft leading-relaxed flex items-start gap-1.5">
                    <span className="shrink-0 text-accent font-bold">💡</span>
                    <span>{item.aiComment || item.comment || item.thesis}</span>
                  </div>
                </div>

                {/* Card Sub-footer: MA & Range levels */}
                <div className="mt-3 pt-2.5 border-t border-line-soft flex items-center justify-between text-[10px] text-ink-4">
                  <span>MA10: ¥{fmt(item.ma10)}</span>
                  <span>MA20: ¥{fmt(item.ma20)}</span>
                  <span>20日震荡: ¥{fmt(item.low20d)} ~ ¥{fmt(item.high20d)}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
