// What GET /api/markets answers, read by the /markets page.

export type MarketCategory = "pork" | "aviation" | "hstech" | "macro" | (string & {});

export type PorkStatusTone = "critical" | "caution" | "positive" | "accent" | "neutral";

export type MarketStatFrequency = "daily" | "weekly" | "quarterly";

export interface PorkQuoteBenchmark {
  /** Primary cost/policy anchor text (e.g. "成本倒挂 -30.4%", "毛白价差 ¥6.10/kg", "破 5.0:1 (一级预警)") */
  anchorText: string;
  /** Secondary anchor detail (e.g. "头均亏损约 ¥481", "白条/毛猪比 1.66:1") */
  anchorSub?: string | null;
  /** Optional reference threshold in the quote's primary unit (e.g. 13.2, 300, 1650, 3750, 6.0) */
  referenceLine?: number | null;
  /** Short cyclical status badge */
  statusBadge: string;
  /** Semantic tone for UI styling */
  statusTone: PorkStatusTone;
  /** Dynamic explanation derived from current price, thresholds, and trend */
  statusDesc: string;
}

export interface MarketTrendPoint {
  /** Period label (e.g. "10-26" week-ending date or "26Q3" quarter) */
  label: string;
  /** Period mean or official close */
  close: number;
}

export type EtfActionRating =
  | "accumulate"
  | "buy_right"
  | "hold"
  | "reduce"
  | "wait";

export type PositionTargetSymbol = "etf_516670" | "cea_600115" | "etf_513180";

export type CycleRegimeState =
  | "bottom"
  | "recovery"
  | "balanced"
  | "prosperity"
  | "peak";

export interface PositionSnapshotItem {
  id: number;
  symbol: PositionTargetSymbol;
  day: string;
  /** 持仓数量（场外恒生科技为 null） */
  shares: number | null;
  /** 最新持仓市值（元） */
  marketValue: number;
  /** 持仓浮盈亏（元） */
  unrealizedPnl: number;
  /** 持仓成本总额 = 市值 - 盈亏（元） */
  totalCost: number;
  /** 摊薄成本价 = 成本总额 / 持仓数量（元/股，恒生科技为折算 513180 等效成本） */
  dilutedCost: number | null;
  /** 系统自动推算的本笔变动说明 */
  inferredTrade?: string | null;
  /** 用户备注 */
  note?: string | null;
  createdAt: string;
}

export interface GridLadderRow {
  /** 该档对应的总持仓股数（已加上底仓增量 shift） */
  totalShares: number;
  /** 是否为当前持仓所处档位 */
  isCurrent: boolean;
  /** 下一卖点价格（只剩底仓时为 null） */
  sellPrice: number | null;
  /** 下一卖点卖出股数 */
  sellShares: number | null;
  /** 大跌区反弹卖一半时留存转底仓的股数（常规区为 0） */
  retainShares: number;
  /** 配对买入价（用于计算本轮差价利润） */
  pairedBuyPrice: number | null;
  /** 卖点展示文本 */
  sellLabel: string;
  /** 下一买点价格（买满停止时为 null） */
  buyPrice: number | null;
  /** 下一买点买入股数 */
  buyShares: number | null;
  /** 下一买点所需现金（元） */
  buyCash: number | null;
  /** 买点所属区间："normal" 常规区 | "crash" 大跌区 | "stop" 停止买入 */
  buyZone: "normal" | "crash" | "stop";
  /** 买点展示文本 */
  buyLabel: string;
}

export interface ActionPointItem {
  /** 行动点类型："buy1" 第一买点 | "buy2" 第二买点 | "sell1" 第一卖点 | "sell2" 第二卖点 */
  kind: "buy1" | "buy2" | "sell1" | "sell2";
  /** 行动点名称（如 "第一买点 · 回踩均线低吸"） */
  label: string;
  /** 触发价格（元，不可操作时为 null） */
  triggerPrice: number | null;
  /** 较当前市价偏离比例（如 -0.021 表示 -2.1%） */
  distancePct: number | null;
  /** 建议买入或卖出股数 */
  shares: number | null;
  /** 大跌档买入后反弹留存转底仓股数 */
  retainShares: number;
  /** 预计涉及现金（元，买入需现金 / 卖出回收现金） */
  cashAmount: number | null;
  /** 卖出预计净落袋差价利润（元，扣除佣金与印花税后） */
  estimatedNetProfit: number | null;
  /** 执行该步后预计每股摊薄成本（元/股） */
  projectedDilutedCost: number | null;
  /** 行情技术面定位依据（如 "MA20 均线支撑 ¥0.599"、"近20日高点压力 ¥0.618"） */
  technicalAnchor: string;
  /** 行业基本面动态修正依据（如 "猪粮比 3.94 深亏去化（评分82），买点上移积极接筹"） */
  fundamentalReason: string;
  /** 若暂停该方向的说明 */
  disabledReason?: string | null;
}

export interface TechnicalDataContext {
  currentPrice: number;
  ma20: number;
  ma20DiffPct: number;
  high20d: number;
  low20d: number;
  low60d: number;
  dailyVolatilityPct: number;
  /** 最新成交量较20日均量的比值（量比，如 0.72 表示缩量，1.65 表示放量） */
  volumeRatio20d?: number | null;
  /** 量能形态信号描述 */
  volumeSignal?: string | null;
  /** 高低点数据来源："high-low" 盘中真实高低点 | "close" 收盘价 */
  intradaySource?: "high-low" | "close";
  fundamentalDriveSummary: string;
}

export interface DcaTierRow {
  /** 偏离区间标签（如 "-20% ～ -10%"） */
  label: string;
  /** 区间下限（如 -0.20，null 表示无下限） */
  minDeviation: number | null;
  /** 区间上限（如 -0.10，null 表示无上限） */
  maxDeviation: number | null;
  /** 每日定投金额（元） */
  dailyAmount: number;
  /** 说明（如 "小幅多买"、"大跌区"） */
  note: string;
  /** 是否为当前生效档位 */
  isCurrent: boolean;
}

export interface CostCurvePoint {
  day: string;
  /** 摊薄成本价 */
  dilutedCost: number;
  /** 当日市价 */
  marketPrice: number;
  /** 当日持仓股数（如有） */
  shares?: number | null;
}

export interface PositionPlanDetail {
  symbol: PositionTargetSymbol;
  mode: "grid" | "dca";
  /** 周期状态枚举 */
  cycleState: CycleRegimeState;
  /** 周期状态名称 */
  cycleStateLabel: string;
  /** 周期状态语义色调 */
  cycleStateTone: PorkStatusTone;
  /** 周期买入系数（如 1.0, 0.8, 0.5, 0） */
  buyMultiplier: number;
  /** 周期确认说明 */
  cycleConfirmNote: string;
  /** 最新持仓快照 */
  latestSnapshot: PositionSnapshotItem;
  /** 历史快照列表（按时间倒序，最新在前） */
  snapshots: PositionSnapshotItem[];
  /** 摊薄成本 vs 市价曲线（按时间正序） */
  costCurve: CostCurvePoint[];
  /** 较初始成本变化比例 */
  costDeltaPct: number;
  /** 利润池当前余额（元，场外定投为止盈加码池余额） */
  profitPool: number;
  /** 当前利润池可加码股数（按100股整数倍） */
  profitBonusReadyShares: number;
  /** 下一买点买100股所需金额 */
  lotCost100: number;
  /** 初始底仓股数 */
  baseCoreShares: number;
  /** 累计利润加码 + 大跌留存新增底仓股数 */
  bonusCoreShares: number;
  /** 当前总底仓股数 = baseCoreShares + bonusCoreShares */
  totalCoreShares: number;
  /** 当前目标底仓描述 */
  coreTargetHint: string;
  /** 网格锚点价（grid 模式） */
  anchorPrice?: number | null;
  /** 常规区间距 / 大跌区间距说明 */
  spacingHint?: string | null;
  /** 当前对齐的网格状态行索引 */
  currentRowIndex?: number | null;
  /** 持仓股数与对齐档位股数的偏差 */
  shareAlignmentDiff?: number | null;
  /** 两段式网格状态表（兼容保留） */
  ladderRows?: GridLadderRow[];
  /** 数据驱动的当下行动点（2买 + 2卖） */
  actionPoints?: ActionPointItem[];
  /** 实时行情与基本面定价上下文 */
  technicalContext?: TechnicalDataContext | null;
  /** 是否触发急跌分批/推迟提醒 */
  crashCircuitBreaker?: {
    triggered: boolean;
    reason: string;
    actionText: string;
  } | null;
  /** 是否触发重新定锚提醒 */
  reanchorAlert?: {
    triggered: boolean;
    suggestedAnchor: number;
    reason: string;
  } | null;
  /** 场外智能定投详情（dca 模式，恒生科技） */
  dcaPlan?: {
    /** 当前持仓盈亏偏离成本比例 */
    deviationPct: number;
    /** 基准每日定投额（100元） */
    baseDailyAmount: number;
    /** 仅按浮亏档位计算的定投额（如 120元） */
    baseTierAmount?: number;
    /** 结合实时估值与均线数据修正后的建议每日定投额 */
    recommendedDailyAmount: number;
    /** 行业与技术面数据对定投额的修正说明 */
    dataAdjustmentNote?: string;
    /** 已定投期数 */
    periods: number;
    /** 防抖状态说明 */
    antiJitterNote: string;
    /** 定投分档表 */
    tiers: DcaTierRow[];
    /** 大跌一次性加仓触发状态 */
    lumpSumAlert: {
      triggered: boolean;
      amount: number;
      triggerLevels: number[];
      reason: string;
    };
  } | null;
  /** 早盘冻结基准日期（YYYY-MM-DD） */
  frozenDate?: string;
  /** 最近一次盘中实时校验结果 */
  intradayCheck?: IntradayCheckResult | null;
}

export type IntradayDistanceStatus = "far" | "near" | "reached" | "missed";
export type IntradayVerdict = "execute" | "hold" | "none";

export interface IntradayChecklistItem {
  text: string;
  passed: boolean;
}

export interface IntradayActionPointCheck {
  kind: "buy1" | "buy2" | "sell1" | "sell2";
  label: string;
  triggerPrice: number | null;
  currentPrice: number;
  distancePct: number;
  distanceStatus: IntradayDistanceStatus;
  distanceHint: string;
  verdict: IntradayVerdict;
  verdictText: string;
  checklist: IntradayChecklistItem[];
  ruleReason: string;
  aiVerdict?: "execute" | "hold";
  aiReason?: string;
  recheckCondition?: string;
}

export interface IntradayDcaLumpSumCheck {
  currentPrice: number;
  priceDrop5dPct: number;
  supportLevel1: number;
  supportLevel2: number;
  isInDecisionWindow: boolean;
  windowHint: string;
  cooldownPassed: boolean;
  cooldownNote: string;
  verdict: IntradayVerdict;
  verdictText: string;
  checklist: IntradayChecklistItem[];
  ruleReason: string;
  aiVerdict?: "execute" | "hold";
  aiReason?: string;
}

export interface IntradayLiveQuoteItem {
  symbol: string;
  name: string;
  price: number;
  changePct: number;
}

export type IntradaySessionPhase =
  | "pre_open"
  | "morning_trading"
  | "lunch_break"
  | "afternoon_trading"
  | "closing_window"
  | "post_close";

export interface IntradayLiveContext {
  symbol: string;
  name: string;
  snapshotTime: string;
  currentPrice: number;
  yesterdayClose: number;
  openPrice: number;
  highPrice: number;
  lowPrice: number;
  changePct: number;
  volumeRatio: number | null;
  vwap: number | null;
  iopv: number | null;
  discountPremiumPct: number | null;
  intradayPositionPct: number | null;
  sessionPhase: IntradaySessionPhase;
  sessionHint: string;
  relatedQuotes?: IntradayLiveQuoteItem[];
}

export interface IntradayCheckResult {
  symbol: PositionTargetSymbol;
  checkedAt: string;
  frozenDate: string;
  liveContext: IntradayLiveContext;
  actionChecks?: IntradayActionPointCheck[];
  dcaCheck?: IntradayDcaLumpSumCheck;
  aiReviewed: boolean;
  aiModel?: string;
}

export interface EtfFactorSignal {
  /** 维度名称（如 "产能去化度"） */
  name: string;
  /** 该维度得分 */
  score: number;
  /** 该维度满分权重 */
  maxScore: number;
  /** 简短状态标签（如 "实质去化·看多"） */
  badge: string;
  /** 状态语义色调 */
  tone: PorkStatusTone;
  /** 该维度具体数据依据 */
  detail: string;
}

export interface Etf516670Guidance {
  /** 标的代码 */
  symbol: "etf_516670" | "cea_600115" | "etf_513180" | (string & {});
  /** 操作评级枚举 */
  action: EtfActionRating;
  /** 操作评级展示文本（如 "左侧建仓 · 顺势收集"） */
  actionLabel: string;
  /** 操作评级语义色调 */
  actionTone: PorkStatusTone;
  /** 综合周期配置评分 (0 ~ 100) */
  score: number;
  /** 参考仓位区间与配置策略 */
  positionHint: string;
  /** 近90日价格所处分位 (0 ~ 100) */
  pricePercentile: number;
  /** 统计区间最低价 */
  rangeLow: number;
  /** 统计区间最高价 */
  rangeHigh: number;
  /** 20日均线价格 (MA20) */
  ma20: number;
  /** 当前价较MA20乖离率 (如 0.0195 表示 +1.95%) */
  ma20Diff: number;
  /** 短线技术面形态判定 */
  swingSignal: string;
  /** 核心买卖指导综述（中长线猪周期 + 短线波段） */
  summary: string;
  /** 中长线周期底仓配置建议 */
  cycleAdvice: string;
  /** 短线技术面波段操作建议 */
  swingAdvice: string;
  /** 买点/加仓触发锚点 */
  buyTriggers: string[];
  /** 止盈/减仓风控锚点 */
  sellTriggers: string[];
  /** 四维量化因子拆解 */
  factors: EtfFactorSignal[];
  /** 个人化长期降本加减仓规划与持仓账本状态 */
  positionPlan?: PositionPlanDetail | null;
}

export interface IndicatorAiInsight {
  /** AI 判定的状态短标签（4~6字，如 "领涨超额·回购"、"深亏收储托底"） */
  badge?: string | null;
  /** 状态语义色调 */
  tone?: PorkStatusTone | null;
  /** AI 对该单项指标/成分股的具体解读与传导分析 */
  comment: string;
}

export interface PorkMarketAnalysis {
  /** 周期阶段判定 (如: "深度亏损筑底与主动去产能期") */
  stage: string;
  /** 综合研判一句话总结 */
  headline: string;
  /** 预警等级 */
  warningLevel: "normal" | "caution" | "critical";
  /** 预警等级说明文本 */
  warningText: string;
  /** 各维度详细研判 */
  bullets: Array<{
    dimension: string;
    assessment: string;
  }>;
  /** 板块内各核心指标/成分股的 AI 逐项深度点评（symbol -> insight） */
  indicatorInsights?: Record<string, IndicatorAiInsight> | null;
  /** 畜牧养殖ETF (516670) / 中国东航 (600115) / 恒生科技ETF (513180) 周期配置与短线波段买卖指导 */
  etfGuidance?: Etf516670Guidance | null;
  /** 分析生成时间 ISO 字符串 */
  analyzedAt: string;
  /** 分析来源：模型调用 ("ai") 或 规则研判引擎 ("rules") */
  source: "ai" | "rules";
  /** 实际调用的 AI 模型名称（source === "ai" 时） */
  model?: string | null;
  /** 实际命中的通道 ID（如 "ch-1", "ch-2"） */
  channelId?: string | null;
  /** 实际命中的通道域名（如 "integrate.api.nvidia.com"） */
  channelHost?: string | null;
  /** 调用耗时（毫秒） */
  latencyMs?: number | null;
  /** 输入 Token 数量 */
  tokensIn?: number | null;
  /** 输出 Token 数量 */
  tokensOut?: number | null;
}

export type QuotaMode = "nvidia" | "apinex" | "tokenharbor" | "http-status" | "subscription";

export interface LlmChannelQuotaInfo {
  usedPct?: number | null;
  remainingTokens?: number | null;
  limitTokens?: number | null;
  resetsAt?: string | null;
  updatedAt?: string | null;
  unlimited?: boolean | null;
}

export interface LlmChannelUsageItem {
  purpose: string;
  calls: number;
  ok: number;
  failed: number;
  p50: number | null;
  p95: number | null;
  tokensIn: number;
  tokensOut: number;
  lastAt: string | null;
}

export interface LlmChannelFailureItem {
  at: string;
  error: string;
  callId: number | null;
  purpose: string | null;
}

export interface LlmChannelStatusItem {
  id: string;
  index: number;
  host: string;
  baseUrl: string;
  model: string;
  quotaMode: QuotaMode;
  status: "active" | "standby" | "cooldown" | "exhausted";
  available: boolean;
  consecutiveFailures: number;
  failureLimit: number;
  cooldownUntil: string | null;
  exhaustedUntil: string | null;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
  recentFailures: LlmChannelFailureItem[];
  quotaInfo: LlmChannelQuotaInfo | null;
  totals: {
    calls: number;
    ok: number;
    failed: number;
    failoverFrom: number;
    p50: number | null;
    p95: number | null;
    tokensIn: number;
    tokensOut: number;
  };
  usage: LlmChannelUsageItem[];
}

export interface LlmRecentCallItem {
  id: number;
  channelId: string | null;
  channelIndex: number | null;
  host: string | null;
  model: string | null;
  purpose: string;
  subject: string | null;
  status: "completed" | "failed";
  latencyMs: number | null;
  tokensIn: number;
  tokensOut: number;
  attemptedChannels: string[];
  failoverErrors: Array<{ channelId: string; error: string }>;
  error: string | null;
  at: string;
}

export interface LlmChannelsOverview {
  days: number;
  rpm: number;
  intervalMs: number;
  tokenThreshold: number;
  modelCallsEnabled: boolean;
  activeChannelId: string | null;
  channels: LlmChannelStatusItem[];
  recentCalls: LlmRecentCallItem[];
}

export interface MarketQuote {
  symbol: string;
  name: string;
  category: MarketCategory;
  /** Currency of the quote: "USD" for Brent and gold, "CNY" for SSE and domestic quotes, "HKD" for HSTECH. */
  currency: "USD" | "CNY" | "HKD";
  /** Unit of the quote: "桶", "盎司", "点", "公斤", "吨", "万头", ":1". */
  unit: string;
  /** The latest close: today's price while its trading day is open. */
  price: number;
  /** The trading day of `price` (YYYY-MM-DD). */
  day: string;
  /** Equivalent RMB price: for gold, converted to CNY/gram; for futures/bulk, converted to CNY/kg; null for SSE. */
  cnyPrice: number | null;
  /** Unit for the RMB price: "克" for gold, "公斤" for feed/futures, null for SSE. */
  cnyUnit: string | null;
  /** The close 1 trading day before (yesterday), and the change against it as a fraction (0.0123 is +1.23%). */
  closeYesterday: number | null;
  changeYesterday: number | null;
  /** The close 7 calendar days before (or preceding trading close), and the WoW change as a fraction. */
  close1w?: number | null;
  change1w?: number | null;
  /** The close 30 calendar days before (or preceding trading close), and the change against it as a fraction (0.0123 is +1.23%). */
  close1m: number | null;
  change1m: number | null;
  /** The close 60 calendar days before (or preceding trading close), and the change against it. */
  close2m: number | null;
  change2m: number | null;
  /** Recent daily closes up to 60 calendar days back, oldest first (with optional intraday high/low/volume). */
  series: Array<{ day: string; close: number; high?: number; low?: number; volume?: number }>;
  /** Explanatory note or regulatory hint (e.g. "发改委盈亏警戒线约 6.0:1"). */
  note?: string | null;
  /** Pork industry sub-segment: "spot" | "forward" | "cost" | "etf" */
  segment?: "spot" | "forward" | "cost" | "etf";
  /** Forward biological / market horizon (e.g. "即期现货", "影响5~6月后出栏", "影响10个月后产能底盘") */
  horizon?: string;
  /** Update cadence of the underlying data source */
  statFrequency?: MarketStatFrequency;
  /** Concise cadence/source badge shown next to stat date (e.g. "日频均价", "农业部日频", "官方季报") */
  statSourceLabel?: string;
  /** Smoothed medium-term weekly average series (or multi-quarter series for periodic capacity) */
  weeklySeries?: MarketTrendPoint[];
  /** Unified backend-computed industry cost / policy benchmark */
  benchmark?: PorkQuoteBenchmark | null;
}

export interface MarketsAnswer {
  quotes: MarketQuote[];
  /** Latest USD/CNY exchange rate used for conversions. */
  usdCnyRate: number | null;
  /** Consolidated analysis for the pork and hog industry. */
  analysis?: PorkMarketAnalysis | null;
  /** Consolidated analysis for the civil aviation industry & China Eastern (600115). */
  aviationAnalysis?: PorkMarketAnalysis | null;
  /** Consolidated analysis for the Hang Seng Tech Index & ETF (513180). */
  hstechAnalysis?: PorkMarketAnalysis | null;
}
