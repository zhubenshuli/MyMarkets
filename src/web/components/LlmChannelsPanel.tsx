import { useEffect, useState } from "react";
import { beijingDateTimeSec, beijingStamp } from "../../shared/time.ts";
import type {
  LlmChannelsOverview,
  LlmChannelStatusItem,
  LlmRecentCallItem,
  PorkMarketAnalysis,
} from "../../shared/types.ts";

const QUOTA_MODE_LABEL: Record<string, string> = {
  nvidia: "NVIDIA 状态码检测 (402/429)",
  apinex: "Apinex 实时订阅接口 (/v1/subscription)",
  tokenharbor: "TokenHarbor 响应头 (x-th-free-used-pct)",
  subscription: "订阅接口查询 (/v1/subscription)",
  "http-status": "HTTP 状态码检测",
};

const PURPOSE_LABEL: Record<string, string> = {
  pork_analysis: "🐖 生猪产业链与指标研判",
  pork_etf_strategy: "🎯 畜牧养殖ETF(516670)策略",
  aviation_analysis: "✈️ 航空业与油汇指标研判",
  aviation_stock_strategy: "🎯 中国东航(600115)策略",
  hstech_analysis: "🚀 恒生科技与成分股研判",
  hstech_etf_strategy: "🎯 恒生科技ETF(513180)策略",
  potential_funds_analysis: "🎯 潜力基金跨赛道研判",
  market_analysis: "📊 产业链行情研判",
};

const fmtNum = (n: number | null | undefined) =>
  n === null || n === undefined ? "—" : n.toLocaleString("en-US");

const fmtSecs = (ms: number | null | undefined) =>
  ms === null || ms === undefined ? "—" : ms >= 10_000 ? `${Math.round(ms / 1000)} s` : `${(ms / 1000).toFixed(1)} s`;

export interface LlmChannelsPanelProps {
  porkAnalysis?: PorkMarketAnalysis | null;
  aviationAnalysis?: PorkMarketAnalysis | null;
  hstechAnalysis?: PorkMarketAnalysis | null;
  onSelectSector?: (key: string) => void;
  onTriggerRefresh?: (
    category: "pork" | "aviation" | "hstech" | "funds" | "macro" | "all",
    mode: "all" | "quotes" | "ai",
  ) => Promise<void>;
  refreshingTarget?: string | null;
}

export function LlmChannelsPanel({
  porkAnalysis,
  aviationAnalysis,
  hstechAnalysis,
  onSelectSector,
  onTriggerRefresh,
  refreshingTarget,
}: LlmChannelsPanelProps) {
  const [days, setDays] = useState<number>(30);
  const [data, setData] = useState<LlmChannelsOverview | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [resetting, setResetting] = useState<string | null>(null);
  const [expandedUsage, setExpandedUsage] = useState<Record<string, boolean>>({});
  const [selectedCall, setSelectedCall] = useState<LlmRecentCallItem | null>(null);
  const [selectedFailures, setSelectedFailures] = useState<LlmChannelStatusItem | null>(null);

  const loadOverview = async (targetDays = days, isManual = false) => {
    if (isManual) setRefreshing(true);
    try {
      const res = await fetch(`/api/llm/channels?days=${targetDays}`);
      if (res.ok) {
        const json = (await res.json()) as LlmChannelsOverview;
        setData(json);
      }
    } catch {
      // ignore network error
    } finally {
      setLoading(false);
      if (isManual) setRefreshing(false);
    }
  };

  useEffect(() => {
    void loadOverview(days);
    const timer = setInterval(() => void loadOverview(days), 30_000);
    return () => clearInterval(timer);
  }, [days]);

  useEffect(() => {
    if (!selectedCall && !selectedFailures) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setSelectedCall(null);
        setSelectedFailures(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedCall, selectedFailures]);

  const handleReset = async (channelId: string) => {
    setResetting(channelId);
    try {
      await fetch(`/api/llm/channels/${encodeURIComponent(channelId)}/reset`, { method: "POST" });
      await loadOverview(days, true);
    } finally {
      setResetting(null);
    }
  };

  const toggleUsage = (id: string) => {
    setExpandedUsage((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const channels = data?.channels ?? [];
  const availableCount = channels.filter((c) => c.available).length;
  const activeChannel = channels.find((c) => c.id === data?.activeChannelId) ?? channels[0] ?? null;
  const totalCalls = channels.reduce((acc, c) => acc + c.totals.calls, 0);
  const totalOk = channels.reduce((acc, c) => acc + c.totals.ok, 0);
  const totalFailed = channels.reduce((acc, c) => acc + c.totals.failed, 0);
  const totalTokensIn = channels.reduce((acc, c) => acc + c.totals.tokensIn, 0);
  const totalTokensOut = channels.reduce((acc, c) => acc + c.totals.tokensOut, 0);
  const anyAbnormal = channels.some((c) => !c.available || c.consecutiveFailures > 0 || !!c.lastError);
  const periodLabel = days < 0 ? "全部历史" : days === 0 ? "今日 (UTC 0点起)" : `近 ${days} 天`;

  const sectorCards = [
    {
      key: "pork",
      title: "🐖 生猪产业链",
      schedule: "每日 00:00 定时研判",
      analysis: porkAnalysis,
    },
    {
      key: "aviation",
      title: "✈️ 航空业与东航",
      schedule: "每日 00:05 定时研判",
      analysis: aviationAnalysis,
    },
    {
      key: "hstech",
      title: "🚀 恒生科技",
      schedule: "每日 00:10 定时研判",
      analysis: hstechAnalysis,
    },
  ];

  return (
    <div className="space-y-5">
      {/* 顶部标题与过滤操作栏 */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between border-b border-line pb-3.5">
        <div>
          <h2 className="text-[19px] sm:text-[20px] font-bold text-ink">AI 模型通道与额度监测</h2>
          <p className="mt-1 text-[12.5px] text-ink-3">
            实时查看当前使用的 AI 模型、各通道剩余额度/配额状态、各板块研判生成时间与完整调用流水。
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 self-start sm:self-auto">
          {anyAbnormal && (
            <button
              type="button"
              disabled={resetting === "all"}
              onClick={() => void handleReset("all")}
              className="rounded-control border border-hot/30 bg-hot-soft px-2.5 py-1.5 text-[12px] font-semibold text-hot hover:opacity-85 transition-opacity"
            >
              {resetting === "all" ? "重置中…" : "重置全部异常状态"}
            </button>
          )}
          <div className="inline-flex rounded-control bg-well p-0.5 border border-line-soft">
            {[
              { value: 0, label: "今日" },
              { value: 7, label: "7 天" },
              { value: 30, label: "30 天" },
              { value: -1, label: "全部" },
            ].map((opt) => {
              const active = days === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setDays(opt.value)}
                  className={`rounded px-2.5 py-1 text-[12px] font-medium transition-colors ${
                    active ? "bg-surface text-ink shadow-xs border border-line" : "text-ink-3 hover:text-ink"
                  }`}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
          <button
            type="button"
            disabled={refreshing}
            onClick={() => void loadOverview(days, true)}
            className="rounded-control border border-line bg-surface px-2.5 py-1.5 text-[12px] font-medium text-ink-2 hover:border-line-strong transition-colors"
          >
            {refreshing ? "查询中…" : "↻ 刷新额度"}
          </button>
        </div>
      </div>

      {/* 1. 顶部 4 项核心概览 KPI */}
      <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 xl:grid-cols-4">
        <div className="card p-4">
          <div className="text-[12px] font-medium text-ink-4">当前主用通道与模型</div>
          <div className="mt-1.5 font-bold text-[15.5px] text-ink truncate" title={activeChannel?.model ?? "未配置"}>
            {activeChannel ? activeChannel.model : "未配置模型"}
          </div>
          <div className="mt-1 flex items-center gap-1.5 text-[12px] text-ink-3">
            <span className={`size-2 rounded-full ${activeChannel?.available ? "bg-ok" : "bg-amber"}`} />
            <span className="truncate" title={activeChannel?.host}>
              {activeChannel ? `#${activeChannel.index} ${activeChannel.host}` : "请检查 .env 配置"}
            </span>
          </div>
        </div>

        <div className="card p-4">
          <div className="text-[12px] font-medium text-ink-4">多通道可用状态</div>
          <div className="mt-1.5 num font-bold text-[16px] text-ink">
            {availableCount} / {channels.length} <span className="text-[13px] font-normal text-ink-3">通道就绪</span>
          </div>
          <div className="mt-1 text-[12px] text-ink-3">
            {availableCount === channels.length && channels.length > 0
              ? "全部容灾通道在线待命"
              : `${channels.filter((c) => c.status === "cooldown").length} 个冷却中 · ${channels.filter((c) => c.status === "exhausted").length} 个额度耗尽`}
          </div>
        </div>

        <div className="card p-4">
          <div className="text-[12px] font-medium text-ink-4">{periodLabel}累计调用与 Token</div>
          <div className="mt-1.5 num font-bold text-[16px] text-ink">
            {fmtNum(totalCalls)} 次{" "}
            <span className="text-[12px] font-normal text-ink-3">
              (成功 <span className="text-ok font-semibold">{fmtNum(totalOk)}</span> · 失败{" "}
              <span className={totalFailed > 0 ? "text-hot font-semibold" : "text-ink-3"}>{fmtNum(totalFailed)}</span>)
            </span>
          </div>
          <div className="mt-1 num text-[11.5px] text-ink-4">
            累计输入 {fmtNum(totalTokensIn)} / 输出 {fmtNum(totalTokensOut)} tokens
          </div>
        </div>

        <div className="card p-4">
          <div className="text-[12px] font-medium text-ink-4">定时研判与频控策略</div>
          <div className="mt-1.5 num font-bold text-[15.5px] text-ink">
            {data?.modelCallsEnabled === false
              ? "模型调用已关闭"
              : data?.rpm && data.rpm > 0
                ? `${data.rpm} RPM (间隔 ${Math.round(data.intervalMs / 1000)}s)`
                : "每日零点自动调度"}
          </div>
          <div className="mt-1 text-[11.5px] text-ink-3">
            00:00 生猪 · 00:05 航空 · 00:10 恒生科技
          </div>
        </div>
      </div>

      {/* 2. 三大板块当前生效研判模型与生成时间 */}
      <div className="card p-4 sm:p-5">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 pb-3 border-b border-line">
          <div>
            <h3 className="text-[15px] font-bold text-ink">📌 各板块当前生效研判（用的是哪个模型 · 什么时候生成）</h3>
            <p className="mt-0.5 text-[11.5px] text-ink-4">
              支持盘中随时手动拉取最新行情并重新触发 AI 研判，无需等待每日零点定时任务
            </p>
          </div>
          {onTriggerRefresh && (
            <button
              type="button"
              disabled={!!refreshingTarget}
              onClick={async () => {
                await onTriggerRefresh("all", "all");
                await loadOverview(days, true);
              }}
              className="self-start sm:self-auto shrink-0 inline-flex items-center gap-1.5 rounded-control bg-accent px-3 py-1.5 text-[12px] font-semibold text-accent-contrast shadow-xs hover:opacity-90 active:scale-[0.98] disabled:opacity-50 transition-all cursor-pointer"
            >
              {refreshingTarget === "all:all" ? "⏳ 正在全量更新并重算…" : "⚡ 一键更新全部行情+AI重算"}
            </button>
          )}
        </div>

        <div className="mt-3.5 grid grid-cols-1 md:grid-cols-3 gap-3">
          {sectorCards.map((sc) => {
            const a = sc.analysis;
            const isAi = a?.source === "ai";
            const cat = sc.key as "pork" | "aviation" | "hstech";
            const isBusyAll = refreshingTarget === `${cat}:all` || refreshingTarget === "all:all";
            return (
              <div
                key={sc.key}
                onClick={() => onSelectSector?.(sc.key)}
                className="rounded-control border border-line bg-bg-sunk/50 hover:bg-bg-sunk p-3.5 transition-colors cursor-pointer flex flex-col justify-between gap-2.5"
              >
                <div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-bold text-[14px] text-ink">{sc.title}</span>
                    <span
                      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                        isAi ? "bg-accent-soft text-accent-ink" : "bg-surface text-ink-3 border border-line"
                      }`}
                    >
                      {isAi ? "✨ AI 智能研判" : "📊 产业规则引擎"}
                    </span>
                  </div>

                  <div className="mt-2.5 space-y-1 text-[12px]">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-ink-4 shrink-0">使用模型：</span>
                      <span className="mono font-semibold text-ink truncate" title={a?.model ?? undefined}>
                        {isAi ? (a?.model ?? activeChannel?.model ?? "AI 大模型") : "内置量化规则引擎"}
                      </span>
                    </div>
                    {isAi && (a?.channelId || a?.channelHost) && (
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-ink-4 shrink-0">应答通道：</span>
                        <span className="mono text-ink-2 truncate">
                          {a.channelId ? `${a.channelId.toUpperCase()} ` : ""}
                          {a.channelHost ? `(${a.channelHost})` : ""}
                        </span>
                      </div>
                    )}
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-ink-4 shrink-0">生成时间：</span>
                      <span className="num font-medium text-ink-2">
                        {a?.analyzedAt ? beijingDateTimeSec(a.analyzedAt) : "暂无"}
                      </span>
                    </div>
                    {isAi && (a?.tokensIn || a?.latencyMs) && (
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-ink-4 shrink-0">当次消耗：</span>
                        <span className="num text-[11.5px] text-ink-3">
                          {a.tokensIn ? `${a.tokensIn}/${a.tokensOut ?? 0} tok` : ""}
                          {a.latencyMs ? ` · ${fmtSecs(a.latencyMs)}` : ""}
                        </span>
                      </div>
                    )}
                  </div>
                </div>

                <div className="pt-2 border-t border-line-soft flex flex-wrap items-center justify-between gap-2 text-[11px] text-ink-4">
                  <span>{sc.schedule}</span>
                  <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
                    {onTriggerRefresh && (
                      <button
                        type="button"
                        disabled={!!refreshingTarget}
                        onClick={async () => {
                          await onTriggerRefresh(cat, "all");
                          await loadOverview(days, true);
                        }}
                        title="拉取最新盘中行情并立即调用 AI 重新生成研判结论"
                        className="rounded bg-accent px-2.5 py-1 text-[11px] font-semibold text-accent-contrast shadow-xs hover:opacity-90 active:scale-[0.98] disabled:opacity-50 cursor-pointer"
                      >
                        {isBusyAll ? "AI重算中…" : "✨ 更新行情+AI重算"}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => onSelectSector?.(sc.key)}
                      className="text-accent font-medium hover:underline ml-0.5"
                    >
                      查看 →
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* 3. 各模型通道详细状态与剩余额度卡片 */}
      <div className="space-y-3.5">
        <div className="flex items-center justify-between">
          <h3 className="text-[15.5px] font-bold text-ink">🔋 模型通道池与剩余额度明细（还有多少可用）</h3>
          <span className="text-[11.5px] text-ink-4">按优先级 #1 → #N 顺位容灾切换</span>
        </div>

        {loading && channels.length === 0 ? (
          <div className="card p-8 text-center text-[13px] text-ink-3">正在加载模型通道与配额数据…</div>
        ) : channels.length === 0 ? (
          <div className="card p-8 text-center text-[13px] text-ink-3">
            未检测到已配置的 AI 模型通道，请在 <code className="mono">.env</code> 中配置 <code className="mono">LLM_BASE_URL</code> 与 <code className="mono">LLM_API_KEY</code>。
          </div>
        ) : (
          channels.map((ch) => {
            const canReset = !ch.available || ch.consecutiveFailures > 0 || !!ch.lastError;
            const q = ch.quotaInfo;

            // Calculate quota bar if applicable
            let quotaPctUsed: number | null = null;
            if (typeof q?.usedPct === "number" && Number.isFinite(q.usedPct)) {
              quotaPctUsed = Math.min(100, Math.max(0, q.usedPct));
            } else if (
              typeof q?.limitTokens === "number" &&
              q.limitTokens > 0 &&
              typeof q?.remainingTokens === "number"
            ) {
              quotaPctUsed = Math.min(100, Math.max(0, Math.round(((q.limitTokens - q.remainingTokens) / q.limitTokens) * 1000) / 10));
            }

            return (
              <div key={ch.id} className="card overflow-hidden">
                {/* Channel Card Header */}
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between px-4 py-3 border-b border-line bg-surface">
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className={`inline-flex items-center rounded px-2 py-0.5 text-[11.5px] font-bold ${
                        ch.status === "active"
                          ? "bg-accent-soft text-accent-ink border border-accent/30"
                          : "bg-bg-sunk text-ink-3 border border-line"
                      }`}
                    >
                      优先级 #{ch.index}
                    </span>
                    <span className="font-bold text-[14.5px] text-ink">{ch.host}</span>
                    <span className="mono rounded bg-bg-sunk px-2 py-0.5 text-[12px] font-semibold text-accent border border-line-soft">
                      {ch.model}
                    </span>

                    {ch.status === "active" && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-ok-soft px-2.5 py-0.5 text-[11.5px] font-bold text-ok-ink border border-ok/30">
                        <span className="size-1.5 rounded-full bg-ok" />
                        正在使用 (当前首选)
                      </span>
                    )}
                    {ch.status === "standby" && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-accent-soft px-2.5 py-0.5 text-[11.5px] font-bold text-accent-ink border border-accent/30">
                        <span className="size-1.5 rounded-full bg-accent" />
                        待命就绪 (备用容灾)
                      </span>
                    )}
                    {ch.status === "cooldown" && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-amber-soft px-2.5 py-0.5 text-[11.5px] font-bold text-amber-ink border border-amber/30">
                        <span className="size-1.5 rounded-full bg-amber" />
                        冷却中 {ch.cooldownUntil ? `(至 ${beijingStamp(ch.cooldownUntil)})` : ""}
                      </span>
                    )}
                    {ch.status === "exhausted" && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-hot-soft px-2.5 py-0.5 text-[11.5px] font-bold text-hot border border-hot/30">
                        <span className="size-1.5 rounded-full bg-hot" />
                        额度耗尽 {ch.exhaustedUntil ? `(至 ${beijingStamp(ch.exhaustedUntil)})` : ""}
                      </span>
                    )}
                  </div>

                  <div className="flex items-center gap-2 self-start sm:self-auto">
                    <span className="hidden text-[11.5px] text-ink-4 md:inline">
                      {QUOTA_MODE_LABEL[ch.quotaMode] ?? ch.quotaMode}
                    </span>
                    {canReset && (
                      <button
                        type="button"
                        disabled={resetting === ch.id}
                        onClick={() => void handleReset(ch.id)}
                        className="rounded border border-line bg-bg-sunk px-2.5 py-1 text-[11.5px] font-medium text-ink-2 hover:text-ink"
                      >
                        {resetting === ch.id ? "重置中…" : "重置状态"}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => toggleUsage(ch.id)}
                      className="rounded border border-line-soft bg-bg-sunk/60 px-2.5 py-1 text-[11.5px] font-medium text-ink-3 hover:text-ink"
                    >
                      {expandedUsage[ch.id] ? "收起明细" : "展开明细"}
                    </button>
                  </div>
                </div>

                {/* 4-Column Quota & Metrics Strip */}
                <div className="grid grid-cols-1 gap-3 bg-bg-sunk/40 px-4 py-3.5 text-[12.5px] sm:grid-cols-2 lg:grid-cols-4">
                  {/* Col 1: Quota & Remaining Balance */}
                  <div className="space-y-1">
                    <div className="text-[11.5px] text-ink-4">剩余额度与配额状态</div>
                    <div className="font-medium text-ink">
                      {ch.quotaMode === "apinex" || ch.quotaMode === "subscription" ? (
                        q?.unlimited ? (
                          <span className="text-ok-ink font-semibold">无限额度 (Unlimited)</span>
                        ) : q?.remainingTokens !== null && q?.remainingTokens !== undefined ? (
                          <div className="space-y-1">
                            <div>
                              剩余{" "}
                              <span className="num font-bold text-ok-ink">{fmtNum(q.remainingTokens)}</span>
                              {q.limitTokens ? ` / ${fmtNum(q.limitTokens)}` : ""} tokens
                              {quotaPctUsed !== null ? (
                                <span className="num ml-1 text-[11.5px] text-ink-3">(已用 {quotaPctUsed}%)</span>
                              ) : null}
                            </div>
                            {quotaPctUsed !== null && (
                              <div className="h-1.5 w-full max-w-[200px] rounded-full bg-line overflow-hidden">
                                <div
                                  className={`h-full rounded-full ${quotaPctUsed >= 90 ? "bg-hot" : quotaPctUsed >= 70 ? "bg-amber" : "bg-ok"}`}
                                  style={{ width: `${Math.max(2, 100 - quotaPctUsed)}%` }}
                                  title={`剩余 ${(100 - quotaPctUsed).toFixed(1)}%`}
                                />
                              </div>
                            )}
                            {q.resetsAt && (
                              <div className="text-[11px] text-ink-4">重置时间：{beijingStamp(q.resetsAt)}</div>
                            )}
                          </div>
                        ) : (
                          <span className="text-ink-3">
                            实时订阅检测 (保护阈值 {fmtNum(data?.tokenThreshold ?? 50000)} tok)
                            {ch.lastError?.includes("Daily check-in") && (
                              <span className="block text-[11px] text-amber-ink mt-0.5">⚠️ 需前往 Apinex 每日签到激活免费额度</span>
                            )}
                          </span>
                        )
                      ) : ch.quotaMode === "tokenharbor" ? (
                        q?.usedPct !== null && q?.usedPct !== undefined ? (
                          <div className="space-y-1">
                            <div>
                              7天免费额度：剩余{" "}
                              <span className="num font-bold text-ok-ink">
                                {Math.max(0, 100 - q.usedPct).toFixed(0)}%
                              </span>{" "}
                              <span className="num text-[11.5px] text-ink-3">(已用 {q.usedPct}%)</span>
                            </div>
                            <div className="h-1.5 w-full max-w-[200px] rounded-full bg-line overflow-hidden">
                              <div
                                className={`h-full rounded-full ${q.usedPct >= 90 ? "bg-hot" : q.usedPct >= 70 ? "bg-amber" : "bg-ok"}`}
                                style={{ width: `${Math.max(2, 100 - q.usedPct)}%` }}
                              />
                            </div>
                            {q.resetsAt && (
                              <div className="text-[11px] text-ink-4">重置时间：{beijingStamp(q.resetsAt)}</div>
                            )}
                          </div>
                        ) : (
                          <span className="text-ink-3">按响应头 x-th-free-used-pct 实时监测</span>
                        )
                      ) : (
                        <div className="space-y-0.5">
                          <span className={ch.status === "exhausted" ? "text-hot font-semibold" : "text-ok-ink font-semibold"}>
                            {ch.status === "exhausted" ? "额度耗尽冻结中" : "状态正常 · 按状态码 (402/429) 监测"}
                          </span>
                          <div className="num text-[11px] text-ink-4">
                            期间已用：{fmtNum(ch.totals.tokensIn + ch.totals.tokensOut)} tokens ({fmtNum(ch.totals.ok)} 次成功)
                          </div>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Col 2: Consecutive Failures & Cooldown */}
                  <div className="space-y-1">
                    <div className="text-[11.5px] text-ink-4">连续失败与容灾计数</div>
                    <div className="font-medium text-ink">
                      <span className={ch.consecutiveFailures > 0 ? "text-amber-ink font-bold" : ""}>
                        连续失败 {ch.consecutiveFailures} / {ch.failureLimit} 次
                      </span>
                      {ch.cooldownUntil ? (
                        <span className="block text-[11.5px] text-amber-ink mt-0.5">
                          冷却至 {beijingStamp(ch.cooldownUntil)}
                        </span>
                      ) : ch.exhaustedUntil ? (
                        <span className="block text-[11.5px] text-hot mt-0.5">
                          冻结至 {beijingStamp(ch.exhaustedUntil)}
                        </span>
                      ) : (
                        <span className="block text-[11px] text-ink-4 mt-0.5">连续满 3 次报错自动冷却 10 分钟</span>
                      )}
                    </div>
                  </div>

                  {/* Col 3: Throughput & Errors */}
                  <div className="space-y-1">
                    <div className="text-[11.5px] text-ink-4">{periodLabel}累计吞吐</div>
                    <div className="num font-medium text-ink">
                      成功 <span className="font-bold text-ok-ink">{fmtNum(ch.totals.ok)}</span> 次，
                      {ch.totals.failed > 0 || ch.recentFailures.length > 0 ? (
                        <button
                          type="button"
                          onClick={() => setSelectedFailures(ch)}
                          className="text-hot font-bold underline decoration-dotted underline-offset-2 hover:opacity-80"
                          title="点击查看失败时间与报错原因"
                        >
                          失败 {fmtNum(ch.totals.failed)} 次
                        </button>
                      ) : (
                        <span>失败 0 次</span>
                      )}
                    </div>
                    <div className="num text-[11px] text-ink-4">
                      输入 {fmtNum(ch.totals.tokensIn)} / 输出 {fmtNum(ch.totals.tokensOut)} tok
                      {ch.totals.p50 !== null ? ` · 耗时 p50 ${fmtSecs(ch.totals.p50)}` : ""}
                    </div>
                  </div>

                  {/* Col 4: Last Used Time */}
                  <div className="space-y-1">
                    <div className="text-[11.5px] text-ink-4">最近一次使用时间</div>
                    <div className="num font-medium text-ink">
                      {ch.lastSuccessAt ? beijingDateTimeSec(ch.lastSuccessAt) : "暂无成功记录"}
                    </div>
                    {ch.lastErrorAt && (
                      <div className="text-[11px] text-ink-4">
                        最近报错：{beijingStamp(ch.lastErrorAt)}
                      </div>
                    )}
                  </div>
                </div>

                {/* Expandable Usage by Sector */}
                {expandedUsage[ch.id] && (
                  <div className="border-t border-line bg-surface px-4 py-3">
                    {ch.usage.length > 0 ? (
                      <div className="overflow-x-auto">
                        <table className="w-full text-left text-[12.5px]">
                          <thead>
                            <tr className="border-b border-line text-[11px] text-ink-4">
                              <th className="py-1.5 pr-3 font-medium">研判用途</th>
                              <th className="py-1.5 px-2.5 text-right font-medium">调用次数</th>
                              <th className="py-1.5 px-2.5 text-right font-medium">成功率</th>
                              <th className="py-1.5 px-2.5 text-right font-medium">耗时 (p50 / p95)</th>
                              <th className="py-1.5 px-2.5 text-right font-medium">输入 / 输出 Token</th>
                              <th className="py-1.5 pl-2.5 text-right font-medium">最近调用时间</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-line-soft">
                            {ch.usage.map((u) => {
                              const rate = u.calls > 0 ? Math.round((u.ok / u.calls) * 1000) / 10 : 100;
                              return (
                                <tr key={u.purpose}>
                                  <td className="py-2 pr-3 font-semibold text-ink">
                                    {PURPOSE_LABEL[u.purpose] ?? u.purpose}
                                  </td>
                                  <td className="py-2 px-2.5 text-right num">{fmtNum(u.calls)}</td>
                                  <td className={`py-2 px-2.5 text-right num font-semibold ${rate < 95 ? "text-hot" : "text-ok-ink"}`}>
                                    {rate}%
                                  </td>
                                  <td className="py-2 px-2.5 text-right num text-ink-3">
                                    {fmtSecs(u.p50)} / {fmtSecs(u.p95)}
                                  </td>
                                  <td className="py-2 px-2.5 text-right num text-ink-3">
                                    {fmtNum(u.tokensIn)} / {fmtNum(u.tokensOut)}
                                  </td>
                                  <td className="py-2 pl-2.5 text-right num text-ink-3">
                                    {u.lastAt ? beijingDateTimeSec(u.lastAt) : "—"}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    ) : (
                      <div className="py-3 text-center text-[12px] text-ink-4">{periodLabel}内该通道暂无调用记录</div>
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* 4. 最近模型调用流水表（什么时候用的、用的哪个模型、耗时与 Token） */}
      <div className="card overflow-hidden">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1 px-4 py-3.5 border-b border-line">
          <div>
            <h3 className="text-[15.5px] font-bold text-ink">🕒 最近 AI 模型调用记录（什么时候用的 · 用的哪个模型）</h3>
            <p className="text-[11.5px] text-ink-4 mt-0.5">
              记录每次产业链研判调用的精确时间、实际应答通道与模型、Token 消耗及容灾顺延轨迹
            </p>
          </div>
          <span className="num text-[12px] text-ink-4">共展示最近 {data?.recentCalls.length ?? 0} 条记录</span>
        </div>

        {!data || data.recentCalls.length === 0 ? (
          <div className="p-8 text-center text-[13px] text-ink-4">暂无模型调用流水记录</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[780px] border-collapse text-left text-[12.5px]">
              <thead>
                <tr className="border-b border-line bg-bg-sunk/50 text-[11.5px] font-medium text-ink-4">
                  <th className="py-2.5 pl-4 pr-2 font-medium">记录 ID</th>
                  <th className="py-2.5 px-2.5 font-medium">调用时间 (北京时间)</th>
                  <th className="py-2.5 px-2.5 font-medium">研判板块 / 用途</th>
                  <th className="py-2.5 px-2.5 font-medium">应答通道</th>
                  <th className="py-2.5 px-2.5 font-medium">实际使用模型</th>
                  <th className="py-2.5 px-2.5 font-medium">调度轨迹</th>
                  <th className="py-2.5 px-2.5 text-right font-medium">耗时</th>
                  <th className="py-2.5 px-2.5 text-right font-medium">Token (输入/输出)</th>
                  <th className="py-2.5 pl-2.5 pr-4 text-right font-medium">状态</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line-soft">
                {data.recentCalls.map((r) => {
                  const ch = channels.find((c) => c.id === r.channelId);
                  const dateTag = r.subject?.includes(":") ? r.subject.split(":")[1] : null;
                  return (
                    <tr key={r.id} className="hover:bg-bg-sunk/40 transition-colors">
                      <td className="py-2.5 pl-4 pr-2 num mono text-[12px] text-ink-3">#{r.id}</td>
                      <td className="py-2.5 px-2.5 num font-medium text-ink whitespace-nowrap">
                        {beijingDateTimeSec(r.at)}
                      </td>
                      <td className="py-2.5 px-2.5 whitespace-nowrap">
                        <span className="font-semibold text-ink">{PURPOSE_LABEL[r.purpose] ?? r.purpose}</span>
                        {dateTag && (
                          <span className="num ml-1.5 rounded bg-bg-sunk px-1.5 py-0.5 text-[10.5px] text-ink-4 border border-line-soft">
                            {dateTag}
                          </span>
                        )}
                      </td>
                      <td className="py-2.5 px-2.5 whitespace-nowrap">
                        {ch ? (
                          <span className="inline-flex items-center rounded bg-accent-soft px-2 py-0.5 text-[11px] font-semibold text-accent-ink">
                            #{ch.index} {ch.host}
                          </span>
                        ) : (
                          <span className="mono text-[12px] text-ink-3">{r.channelId ?? "—"}</span>
                        )}
                      </td>
                      <td className="py-2.5 px-2.5 mono text-[12px] font-semibold text-ink whitespace-nowrap">
                        {r.model ?? "—"}
                      </td>
                      <td className="py-2.5 px-2.5 whitespace-nowrap">
                        {r.attemptedChannels.length > 1 ? (
                          <button
                            type="button"
                            onClick={() => setSelectedCall(r)}
                            className="inline-flex items-center gap-1 rounded bg-amber-soft px-2 py-0.5 text-[11px] font-semibold text-amber-ink border border-amber/30 hover:opacity-80"
                            title="点击查看故障顺延详情"
                          >
                            <span>故障顺延</span>
                            <span className="mono underline">{r.attemptedChannels.join(" → ")}</span>
                          </button>
                        ) : (
                          <span className="text-[11.5px] text-ink-4">直连命中</span>
                        )}
                      </td>
                      <td className="py-2.5 px-2.5 text-right num whitespace-nowrap text-ink-2">
                        {fmtSecs(r.latencyMs)}
                      </td>
                      <td className="py-2.5 px-2.5 text-right num whitespace-nowrap text-ink-2">
                        {fmtNum(r.tokensIn)} / {fmtNum(r.tokensOut)}
                      </td>
                      <td className="py-2.5 pl-2.5 pr-4 text-right whitespace-nowrap">
                        {r.status === "completed" ? (
                          <span className="inline-flex items-center rounded px-2 py-0.5 text-[11px] font-bold bg-ok-soft text-ok-ink border border-ok/30">
                            成功
                          </span>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setSelectedCall(r)}
                            className="inline-flex items-center rounded px-2 py-0.5 text-[11px] font-bold bg-hot-soft text-hot border border-hot/30 hover:opacity-80"
                            title="点击查看报错详情"
                          >
                            失败 (查看)
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Modal 1: 单次调用顺延/失败详情 */}
      {selectedCall && (
        <div className="fixed inset-0 z-50 flex items-end justify-center p-3 sm:items-center">
          <div className="absolute inset-0 bg-ink/35 backdrop-blur-[2px]" onClick={() => setSelectedCall(null)} />
          <div
            role="dialog"
            aria-modal="true"
            className="relative w-full max-w-xl rounded-sheet bg-raised p-5 shadow-2xl border border-line-strong"
          >
            <div className="flex items-start justify-between gap-3 border-b border-line pb-3">
              <div>
                <h3 className="text-[16px] font-bold text-ink">调用记录 #{selectedCall.id} · 轨迹与报错明细</h3>
                <div className="mt-1 text-[12px] text-ink-3">
                  {beijingDateTimeSec(selectedCall.at)} · {PURPOSE_LABEL[selectedCall.purpose] ?? selectedCall.purpose}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setSelectedCall(null)}
                className="rounded border border-line px-2.5 py-1 text-[12px] text-ink-3 hover:text-ink"
              >
                关闭
              </button>
            </div>

            <div className="mt-4 max-h-[60vh] space-y-3 overflow-y-auto">
              {selectedCall.failoverErrors.length > 0 &&
                selectedCall.failoverErrors.map((fe, idx) => (
                  <div key={idx} className="rounded-control bg-bg-sunk p-3 border border-line">
                    <div className="text-[12px] font-bold text-amber-ink">顺延切出通道：{fe.channelId}</div>
                    <pre className="mt-1.5 overflow-x-auto whitespace-pre-wrap break-all mono text-[11.5px] text-hot">
                      {fe.error}
                    </pre>
                  </div>
                ))}
              {selectedCall.error && (
                <div className="rounded-control bg-bg-sunk p-3 border border-line">
                  <div className="text-[12px] font-bold text-hot">错误详情</div>
                  <pre className="mt-1.5 overflow-x-auto whitespace-pre-wrap break-all mono text-[11.5px] text-hot">
                    {selectedCall.error}
                  </pre>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Modal 2: 通道近期失败记录 */}
      {selectedFailures && (
        <div className="fixed inset-0 z-50 flex items-end justify-center p-3 sm:items-center">
          <div className="absolute inset-0 bg-ink/35 backdrop-blur-[2px]" onClick={() => setSelectedFailures(null)} />
          <div
            role="dialog"
            aria-modal="true"
            className="relative w-full max-w-xl rounded-sheet bg-raised p-5 shadow-2xl border border-line-strong"
          >
            <div className="flex items-start justify-between gap-3 border-b border-line pb-3">
              <div>
                <h3 className="text-[16px] font-bold text-ink">
                  通道 #{selectedFailures.index} {selectedFailures.host} · 最近报错记录
                </h3>
                <div className="mt-1 mono text-[12px] text-ink-3">{selectedFailures.model}</div>
              </div>
              <button
                type="button"
                onClick={() => setSelectedFailures(null)}
                className="rounded border border-line px-2.5 py-1 text-[12px] text-ink-3 hover:text-ink"
              >
                关闭
              </button>
            </div>

            <div className="mt-4 max-h-[60vh] space-y-3 overflow-y-auto">
              {selectedFailures.recentFailures.length > 0 ? (
                selectedFailures.recentFailures.slice(0, 8).map((rf, idx) => (
                  <div key={idx} className="rounded-control bg-bg-sunk p-3 border border-line">
                    <div className="flex items-center justify-between text-[12px]">
                      <span className="font-bold text-hot">报错 #{idx + 1}</span>
                      <span className="num mono text-ink-3">{beijingDateTimeSec(rf.at)}</span>
                    </div>
                    <pre className="mt-1.5 overflow-x-auto whitespace-pre-wrap break-all mono text-[11.5px] text-hot">
                      {rf.error}
                    </pre>
                  </div>
                ))
              ) : selectedFailures.lastError ? (
                <div className="rounded-control bg-bg-sunk p-3 border border-line">
                  <div className="text-[12px] font-bold text-hot">最后一次报错</div>
                  <pre className="mt-1.5 overflow-x-auto whitespace-pre-wrap break-all mono text-[11.5px] text-hot">
                    {selectedFailures.lastError}
                  </pre>
                </div>
              ) : (
                <div className="p-4 text-center text-[12.5px] text-ink-4">近期无报错记录</div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
