import { useState } from "react";
import { monthDay } from "../../shared/time.ts";
import type {
  CostCurvePoint,
  IntradayActionPointCheck,
  IntradayCheckResult,
  IntradayDcaLumpSumCheck,
  IntradayLiveContext,
  MarketsAnswer,
  PorkStatusTone,
  PositionPlanDetail,
  PositionTargetSymbol,
} from "../../shared/types.ts";

const TONE_BADGE_CLASSES: Record<PorkStatusTone, string> = {
  critical: "text-hot bg-hot-soft border-hot/30",
  caution: "text-amber-ink bg-amber-soft border-amber/30",
  positive: "text-ok-ink bg-ok-soft border-ok/30",
  accent: "text-accent-ink bg-accent-soft border-accent/30",
  neutral: "text-ink-2 bg-bg-sunk border-line",
};

/** Dual-line SVG chart comparing daily market close vs user's diluted cost per share. */
export function DilutedCostChart({
  costCurve,
  nextBuyPrice,
  nextSellPrice,
  decimals = 3,
}: {
  costCurve: CostCurvePoint[];
  nextBuyPrice?: number | null;
  nextSellPrice?: number | null;
  decimals?: number;
}) {
  if (!costCurve || costCurve.length < 2) return null;

  const marketVals = costCurve.map((p) => p.marketPrice);
  const costVals = costCurve.map((p) => p.dilutedCost);
  const allVals = [...marketVals, ...costVals];
  if (typeof nextBuyPrice === "number" && Number.isFinite(nextBuyPrice)) allVals.push(nextBuyPrice);
  if (typeof nextSellPrice === "number" && Number.isFinite(nextSellPrice)) allVals.push(nextSellPrice);

  const min = Math.min(...allVals);
  const max = Math.max(...allVals);
  const span = max - min || 0.01;
  const width = 280;
  const height = 68;
  const pad = 6;

  const toY = (v: number) => pad + (1 - (v - min) / span) * (height - pad * 2);

  const marketCoords = costCurve.map((p, i) => ({
    x: (i / (costCurve.length - 1)) * width,
    y: toY(p.marketPrice),
  }));
  const costCoords = costCurve.map((p, i) => ({
    x: (i / (costCurve.length - 1)) * width,
    y: toY(p.dilutedCost),
  }));

  const marketPoints = marketCoords.map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(" ");
  const costPoints = costCoords.map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(" ");
  const lastMarket = marketCoords.at(-1)!;
  const lastCost = costCoords.at(-1)!;
  const latestPt = costCurve.at(-1)!;
  const isProfitable = latestPt.marketPrice >= latestPt.dilutedCost;

  const buyY = typeof nextBuyPrice === "number" ? toY(nextBuyPrice) : null;
  const sellY = typeof nextSellPrice === "number" ? toY(nextSellPrice) : null;

  return (
    <div className="mt-2.5 rounded bg-bg-sunk/70 px-3 py-2 border border-line-soft">
      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
        <span className="font-semibold text-ink-2">摊薄成本 vs 市价曲线</span>
        <div className="flex items-center gap-3">
          <span className="inline-flex items-center gap-1 text-ink-3">
            <span className={`inline-block h-0.5 w-3 rounded ${isProfitable ? "bg-hot" : "bg-ok"}`} />
            现价 ¥{latestPt.marketPrice.toFixed(decimals)}
          </span>
          <span className="inline-flex items-center gap-1 text-accent font-semibold">
            <span className="inline-block h-0.5 w-3 border-b-2 border-dashed border-accent" />
            摊薄成本 ¥{latestPt.dilutedCost.toFixed(decimals === 2 ? 3 : 4)}
          </span>
        </div>
      </div>

      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="mt-1.5 h-16 w-full overflow-visible"
        aria-label="摊薄成本与市价对比曲线"
      >
        {sellY !== null && (
          <line
            x1={0}
            y1={sellY.toFixed(1)}
            x2={width}
            y2={sellY.toFixed(1)}
            stroke="var(--hot)"
            strokeOpacity="0.28"
            strokeWidth="1"
            strokeDasharray="2 2"
          />
        )}
        {buyY !== null && (
          <line
            x1={0}
            y1={buyY.toFixed(1)}
            x2={width}
            y2={buyY.toFixed(1)}
            stroke="var(--ok)"
            strokeOpacity="0.28"
            strokeWidth="1"
            strokeDasharray="2 2"
          />
        )}
        {/* Diluted cost stepped/dashed line */}
        <polyline
          fill="none"
          stroke="var(--accent)"
          strokeWidth="1.6"
          strokeDasharray="4 2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          points={costPoints}
        />
        {/* Market close line */}
        <polyline
          fill="none"
          stroke={isProfitable ? "var(--hot)" : "var(--ok)"}
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          points={marketPoints}
        />
        <circle cx={lastCost.x.toFixed(1)} cy={lastCost.y.toFixed(1)} r="2.2" fill="var(--accent)" />
        <circle
          cx={lastMarket.x.toFixed(1)}
          cy={lastMarket.y.toFixed(1)}
          r="2.5"
          fill={isProfitable ? "var(--hot)" : "var(--ok)"}
        />
      </svg>

      <div className="mt-0.5 flex items-center justify-between text-[10.5px] text-ink-4">
        <span className="num">{monthDay(costCurve[0]!.day)}</span>
        <span className="num">
          {isProfitable
            ? `高于摊薄成本 +${(((latestPt.marketPrice - latestPt.dilutedCost) / latestPt.dilutedCost) * 100).toFixed(1)}%`
            : `低于摊薄成本 ${(((latestPt.marketPrice - latestPt.dilutedCost) / latestPt.dilutedCost) * 100).toFixed(1)}%`}
        </span>
        <span className="num">{monthDay(latestPt.day)}</span>
      </div>
    </div>
  );
}

function IntradayActionCardSection({ check }: { check?: IntradayActionPointCheck }) {
  if (!check) return null;
  const isExec = check.verdict === "execute";
  const isHold = check.verdict === "hold";

  return (
    <div className="mt-2.5 pt-2 border-t border-line-soft/90 space-y-1.5">
      {/* 1. Status bar & verdict */}
      <div className="flex flex-wrap items-center justify-between gap-1.5 text-[11.5px]">
        <span className="font-semibold text-ink-2">
          🎯 盘中校验 · {check.distanceHint}
        </span>
        <span
          className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-bold border ${
            isExec
              ? "bg-ok text-white border-ok shadow-2xs"
              : isHold
                ? "bg-amber text-white border-amber shadow-2xs"
                : "bg-bg-sunk text-ink-3 border-line"
          }`}
        >
          {check.verdictText}
        </span>
      </div>

      {/* 2. Checklist pills */}
      {check.checklist && check.checklist.length > 0 && (
        <div className="flex flex-wrap gap-1 text-[10.5px]">
          {check.checklist.map((item, idx) => (
            <span
              key={idx}
              className={`rounded px-1.5 py-0.2 border ${
                item.passed
                  ? "bg-ok-soft text-ok-ink border-ok/30"
                  : "bg-amber-soft text-amber-ink border-amber/30"
              }`}
            >
              {item.passed ? "✓" : "⚠"} {item.text}
            </span>
          ))}
        </div>
      )}

      {/* 3. Reason or Recheck Condition */}
      <div className="text-[11px] leading-snug text-ink-3">
        <span>{check.ruleReason}</span>
        {check.recheckCondition && (
          <div className="mt-0.5 text-amber-ink font-medium">
            ⏱ 恢复条件：{check.recheckCondition}
          </div>
        )}
      </div>

      {/* 4. AI Review diagnostic if available */}
      {check.aiReason && (
        <div className="rounded bg-surface/90 border border-line-soft p-1.5 text-[11px] text-ink-2 leading-relaxed">
          <span className="font-semibold text-accent">💡 AI 复核：</span>
          {check.aiReason}
        </div>
      )}
    </div>
  );
}

function IntradayDcaSection({
  check,
}: {
  check?: IntradayDcaLumpSumCheck;
}) {
  if (!check) return null;
  const isExec = check.verdict === "execute";

  return (
    <div className="mt-2.5 rounded-control border border-accent/40 bg-accent-softer p-3 space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <span className="text-[13px] font-bold text-ink">
            🎯 场外 15:00 申购截止前决策
          </span>
          <span className="text-[11px] text-ink-3">({check.windowHint})</span>
        </div>
        <span
          className={`rounded px-2.5 py-0.5 text-[12px] font-bold border ${
            isExec
              ? "bg-ok text-white border-ok"
              : "bg-amber text-white border-amber"
          }`}
        >
          {check.verdictText}
        </span>
      </div>

      {/* Checklist pills */}
      <div className="flex flex-wrap gap-1.5 text-[11px]">
        {check.checklist.map((item, idx) => (
          <span
            key={idx}
            className={`rounded px-2 py-0.5 border ${
              item.passed
                ? "bg-ok-soft text-ok-ink border-ok/30"
                : "bg-amber-soft text-amber-ink border-amber/30"
            }`}
          >
            {item.passed ? "✓" : "⚠"} {item.text}
          </span>
        ))}
      </div>

      <div className="text-[11.5px] text-ink-2 leading-relaxed">
        {check.ruleReason}
      </div>

      {check.aiReason && (
        <div className="rounded bg-surface/90 border border-line-soft p-2 text-[11.5px] text-ink-2 leading-relaxed">
          <span className="font-semibold text-accent">💡 AI 复核：</span>
          {check.aiReason}
        </div>
      )}
    </div>
  );
}

export function PositionPlanPanel({
  plan,
  currentPrice,
  decimals = 3,
  onMarketsUpdated,
}: {
  plan: PositionPlanDetail;
  currentPrice: number;
  decimals?: number;
  onMarketsUpdated?: (markets: MarketsAnswer) => void;
}) {
  const isDca = plan.mode === "dca";
  const latest = plan.latestSnapshot;

  const [showRecordForm, setShowRecordForm] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [sharesInput, setSharesInput] = useState<string>(
    latest.shares !== null ? String(latest.shares) : "",
  );
  const [marketValInput, setMarketValInput] = useState<string>(String(latest.marketValue));
  const [pnlInput, setPnlInput] = useState<string>(String(latest.unrealizedPnl));
  const [noteInput, setNoteInput] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<{ text: string; isError?: boolean } | null>(null);

  const [intradayResult, setIntradayResult] = useState<IntradayCheckResult | null>(
    plan.intradayCheck ?? null,
  );
  const [intradayLoading, setIntradayLoading] = useState(false);
  const [intradayError, setIntradayError] = useState<string | null>(null);

  const handleIntradayCheck = async () => {
    setIntradayLoading(true);
    setIntradayError(null);
    try {
      const res = await fetch("/api/markets/intraday-check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol: plan.symbol }),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      const json = (await res.json()) as { ok: boolean; result: IntradayCheckResult };
      setIntradayResult(json.result);
    } catch (err) {
      setIntradayError((err as Error).message || "盘中校验请求失败");
    } finally {
      setIntradayLoading(false);
    }
  };

  const openFormWithCurrent = () => {
    setSharesInput(latest.shares !== null ? String(latest.shares) : "");
    setMarketValInput(String(latest.marketValue));
    setPnlInput(String(latest.unrealizedPnl));
    setNoteInput("");
    setShowRecordForm((v) => !v);
  };

  const previewMarketVal = Number(marketValInput);
  const previewPnl = Number(pnlInput);
  const previewShares = Number(sharesInput);
  const previewCostTotal =
    Number.isFinite(previewMarketVal) && Number.isFinite(previewPnl)
      ? previewMarketVal - previewPnl
      : latest.totalCost;
  const previewDilutedCost =
    !isDca && Number.isFinite(previewShares) && previewShares > 0
      ? previewCostTotal / previewShares
      : null;

  const handleRecordSnapshot = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setFeedback(null);
    try {
      const payload: {
        symbol: PositionTargetSymbol;
        shares?: number | null;
        marketValue: number;
        unrealizedPnl: number;
        note?: string;
      } = {
        symbol: plan.symbol,
        marketValue: Number(marketValInput),
        unrealizedPnl: Number(pnlInput),
        note: noteInput.trim() || undefined,
      };
      if (!isDca) {
        payload.shares = Number(sharesInput);
      }

      const res = await fetch("/api/positions/snapshot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      const json = (await res.json()) as { ok: boolean; markets?: MarketsAnswer };
      if (json.markets && onMarketsUpdated) {
        onMarketsUpdated(json.markets);
      }
      setShowRecordForm(false);
      setFeedback({ text: "持仓快照已录入，阶梯与摊薄成本已更新", isError: false });
      setTimeout(() => setFeedback(null), 4000);
    } catch (error) {
      setFeedback({ text: `录入失败：${(error as Error).message}`, isError: true });
    } finally {
      setSubmitting(false);
    }
  };

  const handleDeleteSnapshot = async (id: number) => {
    if (id <= 0) return;
    setSubmitting(true);
    try {
      const res = await fetch(`/api/positions/snapshot/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { ok: boolean; markets?: MarketsAnswer };
      if (json.markets && onMarketsUpdated) {
        onMarketsUpdated(json.markets);
      }
      setFeedback({ text: "已撤销该条持仓快照", isError: false });
      setTimeout(() => setFeedback(null), 3500);
    } catch (error) {
      setFeedback({ text: `删除失败：${(error as Error).message}`, isError: true });
    } finally {
      setSubmitting(false);
    }
  };

  const handleApplyReanchor = async (newAnchor: number) => {
    setSubmitting(true);
    try {
      const res = await fetch("/api/positions/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol: plan.symbol, anchorPrice: newAnchor }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { ok: boolean; markets?: MarketsAnswer };
      if (json.markets && onMarketsUpdated) {
        onMarketsUpdated(json.markets);
      }
      setFeedback({ text: `锚点已更新为 ¥${newAnchor.toFixed(decimals)}`, isError: false });
      setTimeout(() => setFeedback(null), 3500);
    } catch (error) {
      setFeedback({ text: `更新锚点失败：${(error as Error).message}`, isError: true });
    } finally {
      setSubmitting(false);
    }
  };

  const curRow =
    plan.ladderRows && typeof plan.currentRowIndex === "number"
      ? plan.ladderRows[plan.currentRowIndex]
      : undefined;
  const cycleBadgeClass = TONE_BADGE_CLASSES[plan.cycleStateTone] ?? TONE_BADGE_CLASSES.neutral;

  // Check if current price has already reached or is within 0.5% of nextSell or nextBuy
  const nearSell =
    curRow?.sellPrice != null && currentPrice >= curRow.sellPrice * 0.995;
  const reachedSell =
    curRow?.sellPrice != null && currentPrice >= curRow.sellPrice;
  const nearBuy =
    curRow?.buyPrice != null && currentPrice <= curRow.buyPrice * 1.005;

  return (
    <div className="mt-4 rounded-control border border-line bg-surface p-3.5 sm:p-4 space-y-3.5">
      {/* 1. Header Bar: Title + Cycle State + Snapshot Entry Button */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between border-b border-line-soft pb-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 text-[13.5px] sm:text-[14px] font-bold text-ink">
            <svg
              viewBox="0 0 20 20"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              className="size-4 text-accent shrink-0"
              aria-hidden="true"
            >
              <path d="M3 5h14M3 10h14M3 15h14" strokeLinecap="round" />
              <circle cx="7" cy="5" r="1.5" fill="currentColor" />
              <circle cx="13" cy="10" r="1.5" fill="currentColor" />
              <circle cx="9" cy="15" r="1.5" fill="currentColor" />
            </svg>
            {isDca ? "场外基金智能分档定投账本" : "个人持仓账本与两段式降本网格表"}
          </span>
          <span className={`inline-flex items-center rounded px-2 py-0.5 text-[11px] font-bold border ${cycleBadgeClass}`}>
            周期状态：{plan.cycleStateLabel}
          </span>
          {plan.spacingHint && (
            <span className="text-[11px] text-ink-4 hidden xl:inline">
              · {plan.spacingHint}
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          {feedback && (
            <span
              className={`rounded px-2 py-0.5 text-[11px] font-semibold border ${
                feedback.isError
                  ? "border-hot/30 bg-hot-soft text-hot"
                  : "border-ok/30 bg-ok-soft text-ok-ink"
              }`}
            >
              {feedback.text}
            </span>
          )}
          <button
            type="button"
            onClick={() => setShowHistory((v) => !v)}
            className="rounded-control border border-line bg-bg-sunk px-2.5 py-1 text-[11.5px] font-medium text-ink-2 hover:border-line-strong transition-colors"
          >
            变动记录 ({plan.snapshots.length})
          </button>
          <button
            type="button"
            onClick={openFormWithCurrent}
            className="inline-flex items-center gap-1 rounded-control bg-accent px-2.5 py-1 text-[11.5px] font-semibold text-accent-contrast shadow-xs hover:opacity-90 transition-opacity"
          >
            <span>{showRecordForm ? "收起录入" : "+ 录入变动后总数总价"}</span>
          </button>
        </div>
      </div>

      {/* 2. Snapshot Quick Entry Form (only total shares, market value, unrealized PnL) */}
      {showRecordForm && (
        <form
          onSubmit={(e) => void handleRecordSnapshot(e)}
          className="rounded-control border border-accent/30 bg-accent-softer p-3 space-y-2.5"
        >
          <div className="flex flex-wrap items-center justify-between gap-2 text-[12px]">
            <span className="font-bold text-ink">
              录入持仓变动快照（照抄券商/基金 App 变动后的总数与总价，无需逐笔记账）
            </span>
            <span className="num text-[11.5px] text-ink-3">
              自动推算总成本：<strong>¥{previewCostTotal.toFixed(2)}</strong>
              {previewDilutedCost !== null && (
                <>
                  {" "}· 摊薄成本价：
                  <strong className="text-accent">¥{previewDilutedCost.toFixed(decimals === 2 ? 3 : 4)}</strong>
                </>
              )}
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-4 gap-2.5">
            {!isDca && (
              <label className="block">
                <span className="text-[11px] font-medium text-ink-3 block mb-1">变动后持仓数量（股）</span>
                <input
                  type="number"
                  step="100"
                  min="0"
                  required
                  value={sharesInput}
                  onChange={(e) => setSharesInput(e.target.value)}
                  className="num w-full rounded border border-line bg-surface px-2.5 py-1.5 text-[13px] font-semibold text-ink"
                />
              </label>
            )}
            <label className="block">
              <span className="text-[11px] font-medium text-ink-3 block mb-1">最新持仓市值（元）</span>
              <input
                type="number"
                step="0.01"
                min="0"
                required
                value={marketValInput}
                onChange={(e) => setMarketValInput(e.target.value)}
                className="num w-full rounded border border-line bg-surface px-2.5 py-1.5 text-[13px] font-semibold text-ink"
              />
            </label>
            <label className="block">
              <span className="text-[11px] font-medium text-ink-3 block mb-1">持仓盈亏（元，亏损填负数）</span>
              <input
                type="number"
                step="0.01"
                required
                value={pnlInput}
                onChange={(e) => setPnlInput(e.target.value)}
                className="num w-full rounded border border-line bg-surface px-2.5 py-1.5 text-[13px] font-semibold text-ink"
              />
            </label>
            <label className="block">
              <span className="text-[11px] font-medium text-ink-3 block mb-1">备注（选填）</span>
              <input
                type="text"
                placeholder={isDca ? "如：周度校准 / 大跌加仓1000" : "如：3.57卖400股 / 利润加码"}
                value={noteInput}
                onChange={(e) => setNoteInput(e.target.value)}
                className="w-full rounded border border-line bg-surface px-2.5 py-1.5 text-[12.5px] text-ink"
              />
            </label>
          </div>

          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={() => setShowRecordForm(false)}
              className="rounded border border-line bg-surface px-3 py-1 text-[12px] text-ink-3"
            >
              取消
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="rounded bg-accent px-3.5 py-1 text-[12px] font-semibold text-accent-contrast disabled:opacity-50"
            >
              {submitting ? "保存中…" : "保存快照并重算阶梯"}
            </button>
          </div>
        </form>
      )}

      {/* 3. Snapshot History Drawer */}
      {showHistory && (
        <div className="rounded-control border border-line bg-bg-sunk/60 p-3 space-y-2">
          <div className="flex items-center justify-between text-[12px] font-bold text-ink">
            <span>历史持仓变动快照（按录入时间倒序）</span>
            <span className="text-[11px] font-normal text-ink-4">成本总额 = 市值 − 持仓盈亏</span>
          </div>
          <div className="divide-y divide-line-soft text-[12px]">
            {plan.snapshots.map((s) => (
              <div key={`${s.id}-${s.day}`} className="py-1.5 flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="num font-semibold text-ink">{s.day}</span>
                  {s.shares !== null && (
                    <span className="num rounded bg-surface px-1.5 py-0.5 border border-line-soft font-semibold text-ink">
                      {s.shares.toLocaleString()} 股
                    </span>
                  )}
                  <span className="num text-ink-3">
                    市值 ¥{s.marketValue.toLocaleString("en-US", { minimumFractionDigits: 2 })}
                  </span>
                  <span className={`num font-semibold ${s.unrealizedPnl >= 0 ? "text-hot" : "text-ok"}`}>
                    盈亏 {s.unrealizedPnl >= 0 ? "+" : ""}¥{s.unrealizedPnl.toFixed(2)}
                  </span>
                  {s.dilutedCost !== null && (
                    <span className="num text-accent font-semibold">
                      {isDca ? "等效成本" : "摊薄成本"} ¥{s.dilutedCost.toFixed(decimals === 2 ? 3 : 4)}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {s.inferredTrade && (
                    <span className="text-[11.5px] text-ink-3">{s.inferredTrade}</span>
                  )}
                  {s.id > 0 && (
                    <button
                      type="button"
                      onClick={() => void handleDeleteSnapshot(s.id)}
                      disabled={submitting}
                      className="text-[11px] text-hot hover:underline"
                    >
                      撤销
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 4. Key Metrics Summary Cards */}
      {!isDca && curRow ? (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5">
          {/* Card A: Holdings & Core Position */}
          <div className="rounded-control bg-bg-sunk/80 border border-line-soft p-2.5">
            <div className="text-[11px] text-ink-4">当前总股数 / 底仓</div>
            <div className="num mt-0.5 text-[16px] font-bold text-ink">
              {(latest.shares ?? 0).toLocaleString()} <span className="text-[11.5px] font-normal text-ink-3">股</span>
            </div>
            <div className="num mt-0.5 text-[11px] text-ink-3">
              底仓 {plan.totalCoreShares.toLocaleString()}股
              {plan.bonusCoreShares > 0 && (
                <span className="text-ok-ink font-semibold"> (含加码+{plan.bonusCoreShares}股)</span>
              )}
            </div>
          </div>

          {/* Card B: Diluted Cost & Unrealized PnL */}
          <div className="rounded-control bg-bg-sunk/80 border border-line-soft p-2.5">
            <div className="text-[11px] text-ink-4">摊薄成本价 / 持仓盈亏</div>
            <div className="num mt-0.5 text-[16px] font-bold text-accent">
              ¥{(latest.dilutedCost ?? 0).toFixed(decimals === 2 ? 3 : 4)}
            </div>
            <div className="num mt-0.5 text-[11px]">
              <span className="text-ink-4">成本 ¥{latest.totalCost.toFixed(0)} · </span>
              <span className={`font-semibold ${latest.unrealizedPnl >= 0 ? "text-hot" : "text-ok"}`}>
                {latest.unrealizedPnl >= 0 ? "+" : ""}¥{latest.unrealizedPnl.toFixed(2)}
              </span>
            </div>
          </div>

          {/* Card C: Next Paired Sell */}
          <div
            className={`rounded-control border p-2.5 ${
              nearSell
                ? "border-hot/40 bg-hot-soft/60"
                : "border-line-soft bg-bg-sunk/80"
            }`}
          >
            <div className="flex items-center justify-between gap-1 text-[11px]">
              <span className="text-ink-4">下一卖点（配对止盈）</span>
              {reachedSell ? (
                <span className="rounded bg-hot px-1.5 py-0.2 text-[10px] font-bold text-white">
                  已触达可卖
                </span>
              ) : nearSell ? (
                <span className="rounded bg-hot-soft px-1.5 py-0.2 text-[10px] font-bold text-hot border border-hot/30">
                  差 ¥{Math.abs((curRow.sellPrice ?? 0) - currentPrice).toFixed(decimals)}
                </span>
              ) : null}
            </div>
            <div className="num mt-0.5 text-[15px] font-bold text-hot">
              {curRow.sellLabel}
            </div>
            <div className="num mt-0.5 text-[11px] text-ink-3">
              {curRow.pairedBuyPrice !== null
                ? `配对买价 ¥${curRow.pairedBuyPrice.toFixed(decimals)} · 赚钱才卖`
                : "仅剩底仓，突破顶部上移锚点"}
            </div>
          </div>

          {/* Card D: Next Grid Buy & Profit Pool */}
          <div
            className={`rounded-control border p-2.5 ${
              nearBuy
                ? "border-ok/40 bg-ok-soft/60"
                : "border-line-soft bg-bg-sunk/80"
            }`}
          >
            <div className="flex items-center justify-between gap-1 text-[11px]">
              <span className="text-ink-4">下一买点 / 利润池</span>
              <span className="num text-[10.5px] font-semibold text-accent">
                池 ¥{plan.profitPool.toFixed(1)}
              </span>
            </div>
            <div className="num mt-0.5 text-[15px] font-bold text-ok-ink">
              {curRow.buyLabel}
            </div>
            <div className="num mt-0.5 text-[11px] text-ink-3">
              {plan.profitBonusReadyShares >= 100
                ? `💡 利润池可顺便多买 +${plan.profitBonusReadyShares}股转底仓`
                : curRow.buyCash !== null
                  ? `需现金 ¥${curRow.buyCash.toLocaleString()} · 满¥${plan.lotCost100.toFixed(0)}加码100股`
                  : "已达持仓上限停止买入"}
            </div>
          </div>
        </div>
      ) : plan.dcaPlan ? (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5">
          <div className="rounded-control bg-bg-sunk/80 border border-line-soft p-2.5">
            <div className="text-[11px] text-ink-4">场外持仓市值 / 累计成本</div>
            <div className="num mt-0.5 text-[15.5px] font-bold text-ink">
              ¥{latest.marketValue.toLocaleString("en-US", { minimumFractionDigits: 2 })}
            </div>
            <div className="num mt-0.5 text-[11px] text-ink-3">
              成本 ¥{latest.totalCost.toLocaleString("en-US", { minimumFractionDigits: 2 })} · 已投 {plan.dcaPlan.periods} 期
            </div>
          </div>

          <div className="rounded-control bg-bg-sunk/80 border border-line-soft p-2.5">
            <div className="text-[11px] text-ink-4">持仓盈亏 / 成本偏离度</div>
            <div className={`num mt-0.5 text-[15.5px] font-bold ${latest.unrealizedPnl >= 0 ? "text-hot" : "text-ok"}`}>
              {latest.unrealizedPnl >= 0 ? "+" : ""}¥{latest.unrealizedPnl.toFixed(2)} (
              {(plan.dcaPlan.deviationPct * 100).toFixed(1)}%)
            </div>
            <div className="num mt-0.5 text-[11px] text-ink-3">
              等效 513180 成本 ~¥{(latest.dilutedCost ?? 0.586).toFixed(3)}
            </div>
          </div>

          <div className="rounded-control border border-accent/35 bg-accent-softer p-2.5">
            <div className="text-[11px] text-accent-ink font-semibold">本周数据联动定投额</div>
            <div className="num mt-0.5 text-[17px] font-bold text-accent">
              ¥{plan.dcaPlan.recommendedDailyAmount} <span className="text-[11.5px] font-normal">/ 天</span>
            </div>
            <div className="text-[11px] text-ink-3 mt-0.5">
              浮亏基础档 ¥{plan.dcaPlan.baseTierAmount ?? plan.dcaPlan.recommendedDailyAmount}/天 · 原设 ¥{plan.dcaPlan.baseDailyAmount}/天
            </div>
          </div>

          <div
            className={`rounded-control border p-2.5 ${
              plan.dcaPlan.lumpSumAlert.triggered
                ? "border-ok/40 bg-ok-soft/60"
                : "border-line-soft bg-bg-sunk/80"
            }`}
          >
            <div className="flex items-center justify-between text-[11px]">
              <span className="text-ink-4">强支撑单独加仓（¥1,000/次）</span>
              <span className="num text-[10.5px] text-accent font-semibold">
                加码池 ¥{plan.profitPool.toFixed(0)}
              </span>
            </div>
            <div className="mt-0.5 text-[13px] font-bold text-ink">
              {plan.dcaPlan.lumpSumAlert.triggered ? "✅ 已触发强支撑加仓" : "⏸ 常规观察（未触发）"}
            </div>
            <div className="num mt-0.5 text-[11px] text-ink-3">
              触发线：周跌≥6% 或破{" "}
              {plan.dcaPlan.lumpSumAlert.triggerLevels.map((lv) => `¥${lv.toFixed(3)}`).join(" / ")}
            </div>
          </div>
        </div>
      ) : null}

      {/* 5. Alerts: Crash Circuit Breaker or Re-anchoring */}
      {plan.crashCircuitBreaker?.triggered && (
        <div className="rounded-control border border-amber/40 bg-amber-soft px-3 py-2 text-[12px] text-amber-ink flex flex-wrap items-center justify-between gap-2">
          <div>
            <strong>⚡ 急跌风控触发：</strong>
            {plan.crashCircuitBreaker.reason} —— {plan.crashCircuitBreaker.actionText}
          </div>
        </div>
      )}

      {/* 5b. Live Technical & Fundamental Pricing Basis Banner */}
      {plan.technicalContext && (
        <div className="rounded-control border border-line bg-bg-sunk/70 p-2.5 space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2 text-[11.5px]">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-bold text-ink">
                📊 实时数据定价基准
              </span>
              {plan.frozenDate && (
                <span className="rounded bg-surface px-1.5 py-0.2 border border-line-soft text-[10.5px] font-medium text-ink-3">
                  基准点位已于 {plan.frozenDate} 早盘冻结
                </span>
              )}
            </div>

            <div className="flex items-center gap-2">
              {intradayError && (
                <span className="text-[11px] text-hot font-semibold">{intradayError}</span>
              )}
              <button
                type="button"
                onClick={() => void handleIntradayCheck()}
                disabled={intradayLoading}
                className="inline-flex items-center gap-1 rounded-control bg-accent px-2.5 py-1 text-[11px] font-semibold text-accent-contrast shadow-xs hover:opacity-90 transition-opacity disabled:opacity-60"
              >
                {intradayLoading ? (
                  <>
                    <span className="inline-block size-3 animate-spin rounded-full border-2 border-white border-t-transparent" />
                    <span>校验中...</span>
                  </>
                ) : (
                  <>
                    <span>⚡ {isDca ? "14:30 尾盘加仓校验" : "盘中实时校验"}</span>
                  </>
                )}
              </button>
            </div>
          </div>

          <div className="num flex flex-wrap items-center gap-2 text-[11px] text-ink-3">
            <span>
              现价 <strong className="text-ink">¥{plan.technicalContext.currentPrice.toFixed(decimals)}</strong>
            </span>
            <span>·</span>
            <span>
              MA20 <strong className="text-ink">¥{plan.technicalContext.ma20.toFixed(decimals)}</strong> (
              {plan.technicalContext.ma20DiffPct >= 0 ? "+" : ""}
              {(plan.technicalContext.ma20DiffPct * 100).toFixed(2)}%)
            </span>
            <span>·</span>
            <span>
              近20日{plan.technicalContext.intradaySource === "high-low" ? "盘中" : ""}支撑/压力{" "}
              <strong className="text-ok-ink">¥{plan.technicalContext.low20d.toFixed(decimals)}</strong> ～{" "}
              <strong className="text-hot">¥{plan.technicalContext.high20d.toFixed(decimals)}</strong>
            </span>
            <span>·</span>
            <span>
              60日强支撑 <strong className="text-ink">¥{plan.technicalContext.low60d.toFixed(decimals)}</strong>
            </span>
            {plan.technicalContext.volumeSignal && (
              <>
                <span>·</span>
                <span>
                  量能 <strong className="text-ink">{plan.technicalContext.volumeSignal}</strong>
                </span>
              </>
            )}
          </div>

          <div className="text-[11.5px] leading-relaxed text-ink-2">
            <span className="font-semibold text-accent">行业基本面驱动：</span>
            {plan.technicalContext.fundamentalDriveSummary}
          </div>

          {intradayResult && (
            <div className="mt-1.5 pt-2 border-t border-line-soft/80 flex flex-col gap-1.5 text-[11.5px]">
              <div className="flex flex-wrap items-center gap-2 text-ink-3">
                <span className="num rounded bg-surface px-1.5 py-0.5 border border-line-soft font-semibold text-ink">
                  {intradayResult.liveContext.snapshotTime} 盘口快照
                </span>
                <span className="rounded bg-accent-soft px-1.5 py-0.5 border border-accent/30 text-[11px] font-bold text-accent-ink">
                  {intradayResult.liveContext.sessionHint}
                </span>
                <span>
                  现价 <strong className="text-ink">¥{intradayResult.liveContext.currentPrice.toFixed(decimals)}</strong>
                  <span className={`ml-1 font-semibold ${intradayResult.liveContext.changePct >= 0 ? "text-hot" : "text-ok"}`}>
                    ({intradayResult.liveContext.changePct >= 0 ? "+" : ""}
                    {(intradayResult.liveContext.changePct * 100).toFixed(2)}%)
                  </span>
                </span>
                {intradayResult.liveContext.vwap !== null && (
                  <span>
                    · 分时均价 <strong className="text-ink">¥{intradayResult.liveContext.vwap.toFixed(decimals)}</strong>
                  </span>
                )}
                {intradayResult.liveContext.volumeRatio !== null && (
                  <span>
                    · 量比 <strong className="text-ink">{intradayResult.liveContext.volumeRatio.toFixed(2)}x</strong>
                  </span>
                )}
                {intradayResult.liveContext.iopv !== null && (
                  <span>
                    · IOPV <strong className="text-ink">¥{intradayResult.liveContext.iopv.toFixed(decimals)}</strong>
                    {intradayResult.liveContext.discountPremiumPct !== null && (
                      <span className="ml-1 text-[11px] text-ink-3">
                        ({intradayResult.liveContext.discountPremiumPct >= 0 ? "溢价" : "折价"}
                        {(intradayResult.liveContext.discountPremiumPct * 100).toFixed(2)}%)
                      </span>
                    )}
                  </span>
                )}
              </div>

              {intradayResult.liveContext.relatedQuotes && intradayResult.liveContext.relatedQuotes.length > 0 && (
                <div className="flex flex-wrap items-center gap-2 text-[11px] text-ink-3">
                  <span className="font-semibold text-ink-2">同板块盘中联动：</span>
                  {intradayResult.liveContext.relatedQuotes.map((r) => (
                    <span key={r.symbol} className="rounded bg-bg-sunk px-1.5 py-0.2 border border-line-soft">
                      {r.name}{" "}
                      <strong className={r.changePct >= 0 ? "text-hot" : "text-ok"}>
                        {r.changePct >= 0 ? "+" : ""}
                        {(r.changePct * 100).toFixed(1)}%
                      </strong>
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* 5c. OTC Hang Seng Tech Intraday Lump Sum Decision Banner */}
      {isDca && intradayResult?.dcaCheck && (
        <IntradayDcaSection check={intradayResult.dcaCheck} />
      )}

      {/* 6. Data-Driven Immediate Action Cards (2 Buy + 2 Sell) OR Smart DCA Tiers Table */}
      {!isDca && plan.actionPoints && plan.actionPoints.length > 0 ? (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2 text-[11.5px] text-ink-3">
            <span>
              <strong>当下数据驱动行动卡（2买 + 2卖）</strong> · 每次变动录入快照或次日行情更新后自动滚动重算
            </span>
            <span>{plan.coreTargetHint}</span>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            {/* Left Column: Buy 1 & Buy 2 */}
            <div className="space-y-2">
              {plan.actionPoints
                .filter((pt) => pt.kind === "buy1" || pt.kind === "buy2")
                .map((pt) => {
                  const isBuy1 = pt.kind === "buy1";
                  return (
                    <div
                      key={pt.kind}
                      className={`rounded-control border p-3 ${
                        isBuy1
                          ? "border-ok/35 bg-ok-soft/35"
                          : "border-amber/35 bg-amber-soft/30"
                      }`}
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-1.5">
                          <span
                            className={`rounded px-1.5 py-0.5 text-[10.5px] font-bold ${
                              isBuy1
                                ? "bg-ok text-white"
                                : "bg-amber text-white"
                            }`}
                          >
                            {isBuy1 ? "常规低吸" : "大跌加码"}
                          </span>
                          <span className="text-[13px] font-bold text-ink">{pt.label}</span>
                        </div>
                        {pt.triggerPrice !== null && pt.shares !== null ? (
                          <div className="num text-right">
                            <span className="text-[15px] font-bold text-ok-ink">
                              ¥{pt.triggerPrice.toFixed(decimals)}
                            </span>
                            {pt.distancePct !== null && (
                              <span className="ml-1 text-[11px] text-ink-3">
                                ({pt.distancePct >= 0 ? "+" : ""}
                                {(pt.distancePct * 100).toFixed(2)}%)
                              </span>
                            )}
                            <span className="ml-2 rounded bg-surface px-1.5 py-0.5 text-[12px] font-bold text-ink border border-line-soft">
                              买入 {pt.shares.toLocaleString()} 股
                            </span>
                          </div>
                        ) : (
                          <span className="text-[12px] font-semibold text-ink-4">
                            {pt.disabledReason ?? "暂不触发"}
                          </span>
                        )}
                      </div>

                      {pt.triggerPrice !== null && pt.shares !== null && (
                        <div className="num mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-ink-2">
                          {pt.cashAmount !== null && (
                            <span>
                              需现金 <strong>¥{pt.cashAmount.toLocaleString()}</strong>
                            </span>
                          )}
                          {pt.projectedDilutedCost !== null && (
                            <span>
                              执行后摊薄成本{" "}
                              <strong className="text-accent">
                                ¥{pt.projectedDilutedCost.toFixed(decimals === 2 ? 3 : 4)}
                              </strong>
                            </span>
                          )}
                          {pt.retainShares > 0 && (
                            <span className="rounded bg-amber-soft px-1.5 py-0.2 text-[10.5px] font-semibold text-amber-ink border border-amber/30">
                              反弹卖半留半 (+{pt.retainShares.toLocaleString()}股永久转底仓)
                            </span>
                          )}
                        </div>
                      )}

                      <div className="mt-2 pt-1.5 border-t border-line-soft/80 space-y-0.5 text-[11.5px] text-ink-3">
                        <div>
                          <span className="font-semibold text-ink-2">技术定位：</span>
                          {pt.technicalAnchor}
                        </div>
                        <div>
                          <span className="font-semibold text-ink-2">数据依据：</span>
                          {pt.fundamentalReason}
                        </div>
                      </div>

                      <IntradayActionCardSection
                        check={intradayResult?.actionChecks?.find((c) => c.kind === pt.kind)}
                      />
                    </div>
                  );
                })}
            </div>

            {/* Right Column: Sell 1 & Sell 2 */}
            <div className="space-y-2">
              {plan.actionPoints
                .filter((pt) => pt.kind === "sell1" || pt.kind === "sell2")
                .map((pt) => {
                  const isSell1 = pt.kind === "sell1";
                  return (
                    <div
                      key={pt.kind}
                      className={`rounded-control border p-3 ${
                        isSell1
                          ? "border-hot/35 bg-hot-soft/35"
                          : "border-line bg-bg-sunk/50"
                      }`}
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-1.5">
                          <span
                            className={`rounded px-1.5 py-0.5 text-[10.5px] font-bold ${
                              isSell1
                                ? "bg-hot text-white"
                                : "bg-ink-3 text-white"
                            }`}
                          >
                            {isSell1 ? "近期压力做T" : "冲高止盈"}
                          </span>
                          <span className="text-[13px] font-bold text-ink">{pt.label}</span>
                        </div>
                        {pt.triggerPrice !== null && pt.shares !== null ? (
                          <div className="num text-right">
                            <span className="text-[15px] font-bold text-hot">
                              ¥{pt.triggerPrice.toFixed(decimals)}
                            </span>
                            {pt.distancePct !== null && (
                              <span className="ml-1 text-[11px] text-ink-3">
                                ({pt.distancePct >= 0 ? "+" : ""}
                                {(pt.distancePct * 100).toFixed(2)}%)
                              </span>
                            )}
                            <span className="ml-2 rounded bg-surface px-1.5 py-0.5 text-[12px] font-bold text-ink border border-line-soft">
                              卖出 {pt.shares.toLocaleString()} 股
                            </span>
                          </div>
                        ) : (
                          <span className="text-[12px] font-semibold text-ink-4">
                            {pt.disabledReason ?? "锁仓持有"}
                          </span>
                        )}
                      </div>

                      {pt.triggerPrice !== null && pt.shares !== null && (
                        <div className="num mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-ink-2">
                          {pt.cashAmount !== null && (
                            <span>
                              回收现金 <strong>¥{pt.cashAmount.toLocaleString()}</strong>
                            </span>
                          )}
                          {pt.estimatedNetProfit !== null && (
                            <span>
                              预计净利入池{" "}
                              <strong className="text-hot">+¥{pt.estimatedNetProfit.toFixed(1)}</strong>
                            </span>
                          )}
                          {pt.projectedDilutedCost !== null && (
                            <span>
                              执行后摊薄成本降至{" "}
                              <strong className="text-accent">
                                ¥{pt.projectedDilutedCost.toFixed(decimals === 2 ? 3 : 4)}
                              </strong>
                            </span>
                          )}
                        </div>
                      )}

                      <div className="mt-2 pt-1.5 border-t border-line-soft/80 space-y-0.5 text-[11.5px] text-ink-3">
                        <div>
                          <span className="font-semibold text-ink-2">技术定位：</span>
                          {pt.technicalAnchor}
                        </div>
                        <div>
                          <span className="font-semibold text-ink-2">数据依据：</span>
                          {pt.fundamentalReason}
                        </div>
                      </div>

                      <IntradayActionCardSection
                        check={intradayResult?.actionChecks?.find((c) => c.kind === pt.kind)}
                      />
                    </div>
                  );
                })}
            </div>
          </div>
        </div>
      ) : plan.dcaPlan ? (
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center justify-between gap-2 text-[11.5px] text-ink-3">
            <span>
              <strong>场外定投金额分档表</strong>（按持仓盈亏 ÷ 成本总额查表，高亮行为当前生效档位）
            </span>
            <span>{plan.dcaPlan.antiJitterNote}</span>
          </div>

          <div className="overflow-x-auto rounded-control border border-line">
            <table className="w-full min-w-[480px] border-collapse text-left text-[12px]">
              <thead>
                <tr className="border-b border-line bg-bg-sunk text-[11px] font-semibold text-ink-4">
                  <th className="py-1.5 px-3">偏离度（持仓盈亏 ÷ 成本）</th>
                  <th className="py-1.5 px-3">每日定投金额</th>
                  <th className="py-1.5 px-3">执行说明与止盈/加码纪律</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line-soft">
                {plan.dcaPlan.tiers.map((tier) => (
                  <tr
                    key={tier.label}
                    className={
                      tier.isCurrent
                        ? "bg-accent-soft/80 font-bold text-ink ring-1 ring-inset ring-accent/40"
                        : "text-ink-2 hover:bg-bg-sunk/40"
                    }
                  >
                    <td className="num py-1.5 px-3 whitespace-nowrap">{tier.label}</td>
                    <td className="num py-1.5 px-3 whitespace-nowrap">
                      <span className={tier.isCurrent ? "text-accent font-bold" : ""}>
                        {tier.dailyAmount} 元 / 天
                      </span>
                      {tier.isCurrent && (
                        <span className="ml-2 inline-flex items-center rounded bg-accent px-1.5 py-0.2 text-[10px] font-bold text-accent-contrast">
                          ← 当前 ({(plan.dcaPlan!.deviationPct * 100).toFixed(1)}%)
                        </span>
                      )}
                    </td>
                    <td className="py-1.5 px-3">{tier.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </div>
  );
}
