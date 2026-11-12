// Prices for the markets page: daily closes read from Sina (global commodities & DCE hog futures), Tencent
// (A-share and HK indices), MOA pfsc.agri.cn (official national wholesale pork daily reports), Zhue
// (15kg commercial piglets & breeding binary sows), Yangzhu/Xuantian (live hog, corn, soybean meal, and
// daily hog-to-grain ratio), plus official MOA/NBS quarterly breeding sow inventory.
import { z } from "zod";
import {
  getDistinctSymbols,
  getLatestClose,
  getLlmCallsSince,
  getRecentCloses,
  getStoredAnalysis,
  getDailyFrozenPlan,
  pruneStoredCloses,
  setDailyFrozenPlan,
  setStoredAnalysis,
  upsertCloses,
} from "./db.ts";
import { guardedFetch, requireOk } from "./lib/http-fetch.ts";
import { chatJson, loadChannels } from "./lib/llm.ts";
import {
  compute513180PositionPlan,
  compute516670PositionPlan,
  compute600115PositionPlan,
} from "./position.ts";
import { readPotentialFundsOverview, refreshPotentialFundsDaily } from "./funds.ts";
import { addDays, beijingDate, beijingTime } from "../shared/time.ts";
import type {
  Etf516670Guidance,
  EtfActionRating,
  EtfFactorSignal,
  MarketCategory,
  MarketQuote,
  MarketsAnswer,
  MarketStatFrequency,
  MarketTrendPoint,
  PorkMarketAnalysis,
  PorkQuoteBenchmark,
  PorkStatusTone,
} from "../shared/types.ts";

export type Session = "a-share" | "hk" | "global" | "domestic-futures" | "spot-daily" | "spot-periodic";
export type InstrumentSource =
  | "sina-global"
  | "tencent-kline"
  | "eastmoney-kline"
  | "sina-inner-futures"
  | "yangzhu-hits"
  | "yangzhu-ratio"
  | "moa-pork-daily"
  | "zhue-cure"
  | "official-series";

export interface Instrument {
  symbol: string;
  name: string;
  category: MarketCategory;
  source: InstrumentSource;
  code: string;
  session: Session;
  currency: "USD" | "CNY" | "HKD";
  unit: string;
  cnyUnit: string | null;
  /** Scale factor for secondary price conversion (e.g. 0.001 to convert CNY/ton to CNY/kg). */
  scale?: number;
  /** Multiplier applied when ingesting raw source quotes (e.g. 15 to convert 15kg piglet CNY/kg to CNY/head). */
  sourceMultiplier?: number;
  /** Explanatory note or industry guidance. */
  note?: string;
  /** Pork industry sub-segment: spot | forward | cost | etf */
  segment?: "spot" | "forward" | "cost" | "etf";
  /** Forward biological / market horizon */
  horizon?: string;
  /** Update cadence of the underlying data source */
  statFrequency?: MarketStatFrequency;
  /** Source/cadence badge shown next to stat date */
  statSourceLabel?: string;
}

/**
 * Calibrated 2026 hog & pork industry cost and regulatory thresholds:
 * - Breeding cost & piglet breakeven calibrated to 2026 feed levels (corn ~2.33 CNY/kg, soybean meal ~3.12 CNY/kg)
 *   and industry average PSY (25~27), avoiding 2023-2024 high-grain-cost exaggeration.
 * - Sow inventory thresholds follow MOA "生猪产能综合调控实施方案（2026年修订）" (normal target 3750 万头, green 92%~103%).
 * - Hog-to-grain ratio thresholds follow NDRC "完善政府猪肉储备调节机制工作预案" (breakeven 6.0:1, Level-1 <5.0:1).
 */
export const PORK_THRESHOLDS = {
  hogFullCostPerKg: 13.2,
  hogCashCostPerKg: 11.5,
  standardHogWeightKg: 120,
  carcassDressingRate: 0.73,
  wholesaleProcessingFeePerKg: 2.0,
  pigletWeightKg: 15,
  pigletBreakevenPerHead: 300,
  pigletFreezePerHead: 240,
  pigletOverheatPerHead: 450,
  sowNormalPricePerHead: 1650,
  sowDeepDiscountPerHead: 1400,
  sowExpansionPerHead: 1850,
  sowInventoryTargetWan: 3750,
  sowInventoryGreenFloorRatio: 0.92,
  sowInventoryGreenCeilRatio: 1.03,
  sowInventoryYellowFloorRatio: 0.85,
  sowInventoryYellowCeilRatio: 1.08,
  pigGrainBreakeven: 6.0,
  pigGrainLevel1Floor: 5.0,
  pigGrainHighWarning: 9.0,
} as const;

/**
 * Calibrated 2026 civil aviation industry cost, FX, and capacity thresholds:
 * - Domestic jet fuel factory price closely tracks INE crude futures (SC0); fuel accounts for ~35% of airline operating cost.
 *   Airline comfortable crude anchor ~520 CNY/bbl, high cost warning ~620 CNY/bbl, severe squeeze ~680 CNY/bbl.
 * - USD/CNY exchange rate impacts USD-denominated lease liabilities and overseas fuel/maintenance expenses (appreciation sweet spot <=6.85).
 * - CAAC industry passenger load factor breakeven ~78.0%, high prosperity pricing power >=83.0%.
 */
export const AVIATION_THRESHOLDS = {
  crudeComfortPerBbl: 520,
  crudeWarningPerBbl: 620,
  crudeCriticalPerBbl: 680,
  fuelNormalPerTon: 3800,
  fuelHighPerTon: 4200,
  fxAppreciationFloor: 6.85,
  fxNeutralCeil: 7.15,
  loadFactorBreakevenPct: 78.0,
  loadFactorHighPct: 83.0,
  shAirportPivotPrice: 28.0,
  airChinaPivotPrice: 6.5,
  csaPivotPrice: 5.3,
  springAirPivotPrice: 46.0,
} as const;

/**
 * Calibrated 2026 Hang Seng Tech (恒生科技) valuation, FX liquidity, and constituent pivots:
 * - Index levels: <=4200 deep value accumulation zone, 5200 valuation equilibrium pivot, >=6200 high sentiment zone.
 * - Offshore/onshore RMB FX: <=6.90 foreign inflow sweet spot, >=7.15 liquidity headwind.
 */
export const HSTECH_THRESHOLDS = {
  indexDeepValue: 4200,
  indexPivot: 5200,
  indexOverheat: 6200,
  fxInflowFloor: 6.9,
  fxPressureCeil: 7.15,
  tencentPivotHkd: 460,
  alibabaPivotHkd: 115,
  meituanPivotHkd: 95,
  jdPivotHkd: 115,
  xiaomiPivotHkd: 30,
  smicPivotHkd: 50,
} as const;

export function computeHogProfitMetrics(hogPrice: number): {
  diffPerKg: number;
  diffPct: number;
  profitPerHead: number;
} {
  const diffPerKg = hogPrice - PORK_THRESHOLDS.hogFullCostPerKg;
  const diffPct = (diffPerKg / PORK_THRESHOLDS.hogFullCostPerKg) * 100;
  const profitPerHead = Math.round(diffPerKg * PORK_THRESHOLDS.standardHogWeightKg);
  return { diffPerKg, diffPct, profitPerHead };
}

/** In the page's order. */
export const INSTRUMENTS: readonly Instrument[] = [
  // --- 1. 生猪与猪肉产业链 (按产业链传导环节组织) ---
  {
    symbol: "hog_spot",
    name: "全国外三元生猪",
    category: "pork",
    source: "yangzhu-hits",
    code: "1",
    session: "spot-daily",
    currency: "CNY",
    unit: "公斤",
    cnyUnit: null,
    segment: "spot",
    horizon: "即期现货博弈",
    statFrequency: "daily",
    statSourceLabel: "日频均价",
    note: "全国外三元生猪出栏大盘标杆价，短期供求晴雨表，检验行业现金与完全成本线",
  },
  {
    symbol: "pork_spot",
    name: "国内猪肉批发价",
    category: "pork",
    source: "moa-pork-daily",
    code: "pork_wholesale",
    session: "spot-daily",
    currency: "CNY",
    unit: "公斤",
    cnyUnit: null,
    segment: "spot",
    horizon: "即期终端消费",
    statFrequency: "daily",
    statSourceLabel: "农业部日频",
    note: "农业农村部监测全国农产品批发市场白条猪肉均价，反映终端走货与屠宰顺价能力",
  },
  {
    symbol: "hog_futures",
    name: "生猪期货连续",
    category: "pork",
    source: "sina-inner-futures",
    code: "LH0",
    session: "domestic-futures",
    currency: "CNY",
    unit: "吨",
    cnyUnit: "公斤",
    scale: 0.001,
    segment: "spot",
    horizon: "远期交割预期",
    statFrequency: "daily",
    statSourceLabel: "期货日盘",
    note: "大商所生猪主力连续合约（LH0），反映远期供需博弈与期现升贴水预期",
  },
  {
    symbol: "piglet_spot",
    name: "全国仔猪均价",
    category: "pork",
    source: "zhue-cure",
    code: "52",
    sourceMultiplier: 15,
    session: "spot-daily",
    currency: "CNY",
    unit: "头",
    cnyUnit: "公斤",
    scale: 1 / 15,
    segment: "forward",
    horizon: "影响5~6月后出栏",
    statFrequency: "daily",
    statSourceLabel: "日频均价",
    note: "15kg外三元商品仔猪全国均价（繁育保本线约¥300/头），锁定半年后商品猪出栏节奏",
  },
  {
    symbol: "sow_spot",
    name: "繁育二元母猪",
    category: "pork",
    source: "zhue-cure",
    code: "40",
    session: "spot-daily",
    currency: "CNY",
    unit: "头",
    cnyUnit: null,
    segment: "forward",
    horizon: "影响10~12月后扩繁",
    statFrequency: "daily",
    statSourceLabel: "日频均价",
    note: "后备二元种猪全国均价（常态更新基准约¥1650/头），衡量种猪补栏与产能扩张意愿",
  },
  {
    symbol: "sow_inventory",
    name: "能繁母猪存栏量",
    category: "pork",
    source: "official-series",
    code: "sow_inventory",
    session: "spot-periodic",
    currency: "CNY",
    unit: "万头",
    cnyUnit: null,
    segment: "forward",
    horizon: "影响10个月后产能底盘",
    statFrequency: "quarterly",
    statSourceLabel: "官方季报",
    note: "农业农村部/国家统计局季度核定核心产能（2026修订正常保有量目标3750万头）",
  },
  {
    symbol: "pig_grain_ratio",
    name: "生猪猪粮比价",
    category: "pork",
    source: "yangzhu-ratio",
    code: "1:4",
    session: "spot-daily",
    currency: "CNY",
    unit: ":1",
    cnyUnit: null,
    segment: "cost",
    horizon: "即期盈亏与收储调控",
    statFrequency: "daily",
    statSourceLabel: "日频测算",
    note: "发改委调控警戒线：盈亏平衡约 6.0:1，低于 5.0:1 触发过度下跌一级预警与中央收储",
  },
  {
    symbol: "corn_spot",
    name: "现货玉米价格",
    category: "pork",
    source: "yangzhu-hits",
    code: "4",
    session: "spot-daily",
    currency: "CNY",
    unit: "吨",
    cnyUnit: "公斤",
    scale: 0.001,
    segment: "cost",
    horizon: "能量饲料主料(约60%)",
    statFrequency: "daily",
    statSourceLabel: "日频均价",
    note: "生猪配合饲料核心能量原料，占育肥饲料配方比重约 60%，决定基础养殖成本底盘",
  },
  {
    symbol: "bean_spot",
    name: "现货豆粕价格",
    category: "pork",
    source: "yangzhu-hits",
    code: "5",
    session: "spot-daily",
    currency: "CNY",
    unit: "吨",
    cnyUnit: "公斤",
    scale: 0.001,
    segment: "cost",
    horizon: "蛋白饲料主料(约20%)",
    statFrequency: "daily",
    statSourceLabel: "日频均价",
    note: "生猪配合饲料主要蛋白原料（43%蛋白），占育肥饲料成本约 20%，构成饲料成本弹性来源",
  },
  {
    symbol: "muyuan_002714",
    name: "牧原股份",
    category: "pork",
    source: "tencent-kline",
    code: "sz002714",
    session: "a-share",
    currency: "CNY",
    unit: "股",
    cnyUnit: null,
    segment: "forward",
    horizon: "516670第一重仓(机构风向标)",
    statFrequency: "daily",
    statSourceLabel: "深交所日线",
    note: "生猪自繁自养绝对龙头（占516670权重约15%），完全成本行业领先，机构资金常领先现货猪价1~2季度抢跑定价",
  },
  {
    symbol: "wens_300498",
    name: "温氏股份",
    category: "pork",
    source: "tencent-kline",
    code: "sz300498",
    session: "a-share",
    currency: "CNY",
    unit: "股",
    cnyUnit: null,
    segment: "forward",
    horizon: "516670第二重仓(猪鸡双龙头)",
    statFrequency: "daily",
    statSourceLabel: "深交所日线",
    note: "“公司+农户”生猪与黄羽肉鸡双龙头（占516670权重约13%），高分红与稳健资产负债表标杆",
  },
  {
    symbol: "etf_516670",
    name: "畜牧养殖ETF",
    category: "pork",
    source: "tencent-kline",
    code: "sh516670",
    session: "a-share",
    currency: "CNY",
    unit: "份",
    cnyUnit: null,
    segment: "etf",
    horizon: "周期配置与波段映射",
    statFrequency: "daily",
    statSourceLabel: "上交所日线",
    note: "招商中证畜牧养殖ETF（516670），重仓生猪养殖与饲料动保龙头，资本市场定价通常领先现货猪周期约1~2个季度",
  },

  // --- 2. 航空业与航司产业链 (成本汇率底盘 / 枢纽同业定价 / 客运景气运力 / 中国东航标的) ---
  {
    symbol: "ine_crude",
    name: "上期原油连续",
    category: "aviation",
    source: "sina-inner-futures",
    code: "SC0",
    session: "domestic-futures",
    currency: "CNY",
    unit: "桶",
    cnyUnit: null,
    segment: "cost",
    horizon: "航油成本锚(占成本~35%)",
    statFrequency: "daily",
    statSourceLabel: "上期能源",
    note: "上海国际能源交易中心原油主力连续（SC0），直接决定国内航空煤油出厂价调整与燃油附加费征收标准",
  },
  {
    symbol: "fuel_futures",
    name: "低硫燃料油连续",
    category: "aviation",
    source: "sina-inner-futures",
    code: "LU0",
    session: "domestic-futures",
    currency: "CNY",
    unit: "吨",
    cnyUnit: "公斤",
    scale: 0.001,
    segment: "cost",
    horizon: "成品油裂解与能源联动",
    statFrequency: "daily",
    statSourceLabel: "上期能源",
    note: "上期能源低硫燃料油连续（LU0），反映亚太成品油与航油炼化裂解成本变动趋势",
  },
  {
    symbol: "fx_usdcny",
    name: "美元兑人民币",
    category: "aviation",
    source: "tencent-kline",
    code: "whUSDCNY",
    session: "global",
    currency: "CNY",
    unit: ":1",
    cnyUnit: null,
    segment: "cost",
    horizon: "美元债汇兑与外币成本",
    statFrequency: "daily",
    statSourceLabel: "外汇日线",
    note: "人民币汇率直接影响航司美元租赁负债汇兑损益、境外航油起降结算成本及国际出境游消费力",
  },
  {
    symbol: "sh_airport",
    name: "上海机场",
    category: "aviation",
    source: "tencent-kline",
    code: "sh600009",
    session: "a-share",
    currency: "CNY",
    unit: "股",
    cnyUnit: null,
    segment: "spot",
    horizon: "浦东虹桥主基地流量",
    statFrequency: "daily",
    statSourceLabel: "上交所日线",
    note: "中国东航核心主基地（浦东+虹桥枢纽），直接映射长三角国际长航线恢复率与高端商务客流景气度",
  },
  {
    symbol: "air_china",
    name: "中国国航",
    category: "aviation",
    source: "tencent-kline",
    code: "sh601111",
    session: "a-share",
    currency: "CNY",
    unit: "股",
    cnyUnit: null,
    segment: "spot",
    horizon: "三大航欧美干线标杆",
    statFrequency: "daily",
    statSourceLabel: "上交所日线",
    note: "北京首都枢纽主基地旗舰航司，反映国内商务干线及欧美远程洲际航线票价与估值温度",
  },
  {
    symbol: "csa_600029",
    name: "南方航空",
    category: "aviation",
    source: "tencent-kline",
    code: "sh600029",
    session: "a-share",
    currency: "CNY",
    unit: "股",
    cnyUnit: null,
    segment: "spot",
    horizon: "国内最大机队标杆",
    statFrequency: "daily",
    statSourceLabel: "上交所日线",
    note: "广州白云+北京大兴双枢纽航司，国内运力规模最大，反映大众干线客运与货运综合景气",
  },
  {
    symbol: "spring_air",
    name: "春秋航空",
    category: "aviation",
    source: "tencent-kline",
    code: "sh601021",
    session: "a-share",
    currency: "CNY",
    unit: "股",
    cnyUnit: null,
    segment: "spot",
    horizon: "低成本高客座率风向标",
    statFrequency: "daily",
    statSourceLabel: "上交所日线",
    note: "国内低成本航空龙头（同以虹桥/浦东为主基地），反映因私旅游需求与日韩东南亚周边航线高弹性",
  },
  {
    symbol: "caac_load_factor",
    name: "民航正班客座率",
    category: "aviation",
    source: "official-series",
    code: "caac_load_factor",
    session: "spot-periodic",
    currency: "CNY",
    unit: "%",
    cnyUnit: null,
    segment: "forward",
    horizon: "运力供需与票价弹性",
    statFrequency: "quarterly",
    statSourceLabel: "民航局季报",
    note: "中国民航局季度核定全行业正班客座率（行业保本线约78%，突破83%进入高景气提价区间）",
  },
  {
    symbol: "cea_hk00670",
    name: "东航H股(00670)",
    category: "aviation",
    source: "tencent-kline",
    code: "hk00670",
    session: "hk",
    currency: "HKD",
    unit: "股",
    cnyUnit: null,
    segment: "forward",
    horizon: "外资先行定价与AH溢价",
    statFrequency: "daily",
    statSourceLabel: "港交所日线",
    note: "中国东方航空股份（00670.HK），离岸外资对国际航线恢复、油价及汇率高度敏感，常领先A股异动并反映AH溢价水平",
  },
  {
    symbol: "cea_600115",
    name: "中国东航",
    category: "aviation",
    source: "tencent-kline",
    code: "sh600115",
    session: "a-share",
    currency: "CNY",
    unit: "股",
    cnyUnit: null,
    segment: "etf",
    horizon: "周期配置与波段核心标的",
    statFrequency: "daily",
    statSourceLabel: "上交所日线",
    note: "中国东航（600115.SH），坐拥上海浦东与虹桥两大核心基地，日韩、欧洲及东南亚航线弹性突出，受益于汇率升值与国际客流复苏",
  },

  // --- 3. 恒生科技与港股互联网产业链 (指数与汇率底盘 / 平台经济与AI云权重 / 端侧与算力先锋 / 恒生科技ETF 513180) ---
  {
    symbol: "hstech_index",
    name: "恒生科技指数",
    category: "hstech",
    source: "tencent-kline",
    code: "hkHSTECH",
    session: "hk",
    currency: "HKD",
    unit: "点",
    cnyUnit: null,
    segment: "cost",
    horizon: "港股科技估值总锚",
    statFrequency: "daily",
    statSourceLabel: "港交所日线",
    note: "代表港股30家最大科技与创新龙头整体表现，对离岸美元流动性、人民币汇率及中国AI互联网盈利周期高度敏感",
  },
  {
    symbol: "hstech_fx",
    name: "美元兑人民币",
    category: "hstech",
    source: "tencent-kline",
    code: "whUSDCNY",
    session: "global",
    currency: "CNY",
    unit: ":1",
    cnyUnit: null,
    segment: "cost",
    horizon: "外资回流与人民币资产重估",
    statFrequency: "daily",
    statSourceLabel: "外汇日线",
    note: "恒生科技成分股营收以人民币为主、以港元计价，人民币升值直接增厚每股港元折算盈利并吸引全球长线资金回流",
  },
  {
    symbol: "hk_00700",
    name: "腾讯控股",
    category: "hstech",
    source: "tencent-kline",
    code: "hk00700",
    session: "hk",
    currency: "HKD",
    unit: "股",
    cnyUnit: null,
    segment: "spot",
    horizon: "社交游戏与微信AI压舱石",
    statFrequency: "daily",
    statSourceLabel: "港交所日线",
    note: "恒生科技第一大权重股（00700.HK），高毛利广告、长青游戏现金流与千亿港元级回购构成板块估值底盘",
  },
  {
    symbol: "hk_09988",
    name: "阿里巴巴-W",
    category: "hstech",
    source: "tencent-kline",
    code: "hk09988",
    session: "hk",
    currency: "HKD",
    unit: "股",
    cnyUnit: null,
    segment: "spot",
    horizon: "电商CMR与阿里云AI龙头",
    statFrequency: "daily",
    statSourceLabel: "港交所日线",
    note: "阿里巴巴（09988.HK），国内电商基本盘与通义大模型/阿里云算力基础设施核心龙头，纳入港股通后南向资金持续增配",
  },
  {
    symbol: "hk_03690",
    name: "美团-W",
    category: "hstech",
    source: "tencent-kline",
    code: "hk03690",
    session: "hk",
    currency: "HKD",
    unit: "股",
    cnyUnit: null,
    segment: "spot",
    horizon: "本地生活与即时零售高频消费",
    statFrequency: "daily",
    statSourceLabel: "港交所日线",
    note: "美团（03690.HK），餐饮外卖与到店酒旅核心龙头，内需服务消费复苏与经营利润率弹性的高Beta风向标",
  },
  {
    symbol: "hk_09618",
    name: "京东集团-SW",
    category: "hstech",
    source: "tencent-kline",
    code: "hk09618",
    session: "hk",
    currency: "HKD",
    unit: "股",
    cnyUnit: null,
    segment: "spot",
    horizon: "自营供应链与家电以旧换新",
    statFrequency: "daily",
    statSourceLabel: "港交所日线",
    note: "京东集团（09618.HK），3C家电自营电商龙头，直接受益于消费品以旧换新补贴与高股息回购支撑",
  },
  {
    symbol: "hk_01810",
    name: "小米集团-W",
    category: "hstech",
    source: "tencent-kline",
    code: "hk01810",
    session: "hk",
    currency: "HKD",
    unit: "股",
    cnyUnit: null,
    segment: "forward",
    horizon: "人车家生态与端侧AI硬件",
    statFrequency: "daily",
    statSourceLabel: "港交所日线",
    note: "小米集团（01810.HK），智能手机高端化、智能电动汽车放量与端侧AIoT生态共振的核心成长权重",
  },
  {
    symbol: "hk_00981",
    name: "中芯国际",
    category: "hstech",
    source: "tencent-kline",
    code: "hk00981",
    session: "hk",
    currency: "HKD",
    unit: "股",
    cnyUnit: null,
    segment: "forward",
    horizon: "国产晶圆代工与AI算力底盘",
    statFrequency: "daily",
    statSourceLabel: "港交所日线",
    note: "中芯国际（00981.HK），本土晶圆代工绝对龙头，映射国内AI芯片国产替代与半导体稼动率周期",
  },
  {
    symbol: "hk_01024",
    name: "快手-W",
    category: "hstech",
    source: "tencent-kline",
    code: "hk01024",
    session: "hk",
    currency: "HKD",
    unit: "股",
    cnyUnit: null,
    segment: "forward",
    horizon: "可灵AI视频大模型与直播电商",
    statFrequency: "daily",
    statSourceLabel: "港交所日线",
    note: "快手（01024.HK），可灵AI视频生成大模型商业化先锋与短视频电商核心权重，反映恒科高Beta进攻弹性",
  },
  {
    symbol: "etf_513180",
    name: "恒生科技ETF",
    category: "hstech",
    source: "tencent-kline",
    code: "sh513180",
    session: "a-share",
    currency: "CNY",
    unit: "份",
    cnyUnit: null,
    segment: "etf",
    horizon: "T+0场内配置与波段核心载体",
    statFrequency: "daily",
    statSourceLabel: "上交所日线",
    note: "华夏恒生科技ETF（513180.SH），A股场内规模与流动性领先的恒生科技旗舰ETF，支持T+0日内回转与中线估值配置",
  },

  // --- 2. 宏观大宗与金融指数 ---
  { symbol: "brent", name: "布伦特原油", category: "macro", source: "sina-global", code: "OIL", session: "global", currency: "USD", unit: "桶", cnyUnit: null },
  { symbol: "xau", name: "伦敦金", category: "macro", source: "sina-global", code: "XAU", session: "global", currency: "USD", unit: "盎司", cnyUnit: "克" },
  { symbol: "sse", name: "上证指数", category: "macro", source: "tencent-kline", code: "sh000001", session: "a-share", currency: "CNY", unit: "点", cnyUnit: null },
  { symbol: "hstech", name: "恒生科技指数", category: "macro", source: "tencent-kline", code: "hkHSTECH", session: "hk", currency: "HKD", unit: "点", cnyUnit: null },
];

/** Standard conversion: 1 troy ounce (金衡盎司, oz t) = 31.1034768 grams. */
export const GRAMS_PER_TROY_OUNCE = 31.1035;

/** Natural (calendar) days back for 近一月 (30天) and 近二月 (60天). */
export const DAYS_1M = 30;
export const DAYS_2M = 60;
/** Enough closes for 12 calendar weeks (~90 days) so weekly trend curves have full depth. */
const HISTORY = 90;
const SINA_FUTURES_URL = "https://stock2.finance.sina.com.cn/futures/api/json.php/GlobalFuturesService.getGlobalFuturesDailyKLine";
const SINA_INNER_FUTURES_URL = "http://stock2.finance.sina.com.cn/futures/api/jsonp.php/var_kline=/InnerFuturesNewService.getDailyKLine";
const SINA_INNER_LIVE_URL = "https://hq.sinajs.cn/list=";
export const TENCENT_KLINE_URL = "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get";
export const EASTMONEY_KLINE_URL = "https://push2his.eastmoney.com/api/qt/stock/kline/get";
const YANGZHU_HITS_URL = "https://xt.yangzhu.vip/data/getzhujiahitsdata";
const MOA_FARM_DAILY_URL = "https://pfsc.agri.cn/api/FarmDaily/list?pageNum=1&pageSize=85";
const ZHUE_CURE_URL = "https://bj.zhue.com.cn/zoushi.php";

/**
 * Whether the market trades at `now` (Beijing), with margin before open and up to 30 minutes after close so
 * the opening print and the final close (including HKEX's 16:08–16:10 closing auction) are captured by the
 * 10-minute schedule. Brent and spot gold trade round the clock from Monday morning to Saturday morning
 * Beijing time. Exchange holidays are not known here: a run on one reads the last close again.
 */
export function inSession(session: Session, now: Date): boolean {
  const weekday = new Date(`${beijingDate(now)}T00:00:00Z`).getUTCDay();
  const time = beijingTime(now);
  if (session === "a-share") return weekday >= 1 && weekday <= 5 && ((time >= "09:25" && time <= "11:35") || (time >= "12:55" && time <= "15:30"));
  if (session === "hk") return weekday >= 1 && weekday <= 5 && ((time >= "09:25" && time <= "12:10") || (time >= "12:55" && time <= "16:30"));
  if (session === "domestic-futures") return weekday >= 1 && weekday <= 5 && ((time >= "08:55" && time <= "11:35") || (time >= "13:25" && time <= "15:10"));
  if (session === "spot-daily" || session === "spot-periodic") return weekday >= 1 && weekday <= 5 && time >= "08:00" && time <= "18:00";
  if (weekday === 0) return false;
  if (weekday === 1) return time >= "06:00";
  if (weekday === 6) return time <= "07:00";
  return true;
}

/** Parses standard or Chinese date strings into standard YYYY-MM-DD. */
export function normalizeDay(raw: string): string | null {
  const standard = raw.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (standard) {
    return `${standard[1]}-${standard[2]!.padStart(2, "0")}-${standard[3]!.padStart(2, "0")}`;
  }
  const ym = raw.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日/);
  if (ym) {
    return `${ym[1]}-${ym[2]!.padStart(2, "0")}-${ym[3]!.padStart(2, "0")}`;
  }
  const ymOnly = raw.match(/^(\d{4})年(\d{1,2})月/);
  if (ymOnly) {
    const y = ymOnly[1]!;
    const m = ymOnly[2]!.padStart(2, "0");
    const d = new Date(Date.UTC(Number(y), Number(m), 0)).getUTCDate().toString().padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  const q = raw.match(/^(\d{4})年?([一二三四1234])季度/);
  if (q) {
    const y = q[1]!;
    const qMap: Record<string, string> = { "一": "03-31", "1": "03-31", "二": "06-30", "2": "06-30", "三": "09-30", "3": "09-30", "四": "12-31", "4": "12-31" };
    return `${y}-${qMap[q[2]!] ?? "12-31"}`;
  }
  const yearOnly = raw.match(/^(\d{4})$/);
  if (yearOnly) return `${yearOnly[1]}-12-31`;
  return null;
}

export interface KlinePoint {
  day: string;
  close: number;
  high?: number;
  low?: number;
  volume?: number;
}

/** The daily closes (and optional OHLCV) in a Sina/Tencent/Eastmoney/Yangzhu answer, oldest first. */
export function parseKlines(body: unknown, opts?: { includeOhlcv?: boolean }): KlinePoint[] {
  const withOhlcv = Boolean(opts?.includeOhlcv);
  const check = (
    day: unknown,
    close: unknown,
    raw: unknown,
    high?: unknown,
    low?: unknown,
    volume?: unknown,
  ): KlinePoint => {
    const d = normalizeDay(typeof day === "string" ? day : String(day ?? ""));
    const value = Number(close);
    if (!d || !Number.isFinite(value) || value <= 0) {
      throw new Error(`unreadable kline ${JSON.stringify(raw)}`);
    }
    if (!withOhlcv) {
      return { day: d, close: value };
    }
    const h = Number(high);
    const l = Number(low);
    const v = Number(volume);
    return {
      day: d,
      close: value,
      ...(Number.isFinite(h) && h > 0 ? { high: h } : {}),
      ...(Number.isFinite(l) && l > 0 ? { low: l } : {}),
      ...(Number.isFinite(v) && v >= 0 ? { volume: v } : {}),
    };
  };

  // 1. Array of Sina futures rows: [{ date: "...", close: "..." }, ...] or [{ d: "...", c: "..." }]
  if (Array.isArray(body)) {
    if (body.length === 0) throw new Error("no klines in the answer");
    return body.slice(-HISTORY).map((row) => {
      const r = row as {
        date?: unknown; close?: unknown; high?: unknown; low?: unknown; volume?: unknown;
        d?: unknown; c?: unknown; h?: unknown; l?: unknown; v?: unknown;
      } | null;
      return check(
        r?.date ?? r?.d,
        r?.close ?? r?.c,
        row,
        r?.high ?? r?.h,
        r?.low ?? r?.l,
        r?.volume ?? r?.v,
      );
    });
  }

  if (!body || typeof body !== "object") throw new Error("no klines in the answer");

  const obj = body as Record<string, unknown>;

  // 2. Eastmoney K-line answer: { data: { klines: ["2026-10-30,open,close,high,low,volume,..."] } }
  const emData = obj.data as { klines?: unknown[] } | undefined;
  if (emData && Array.isArray(emData.klines)) {
    if (emData.klines.length === 0) throw new Error("no klines in the answer");
    return emData.klines.slice(-HISTORY).map((line) => {
      if (typeof line !== "string") throw new Error(`unreadable kline ${String(line)}`);
      const parts = line.split(",");
      return check(parts[0], parts[2], line, parts[3], parts[4], parts[5]);
    });
  }

  // 3. Yangzhu hits data: { code: 200, data: [{ pigprice/maizeprice/bean, pricedate }, ...] }
  // or array rows: { code: 200, data: [["2026-06-30", 26.77], ...] }
  if (Array.isArray(obj.data)) {
    const list = obj.data;
    if (list.length === 0) throw new Error("no klines in the answer");
    const closes: KlinePoint[] = [];
    for (const item of list) {
      if (Array.isArray(item)) {
        const dayRaw = item[0];
        let val: unknown = item[1];
        if (typeof val === "string" && !/^\d+(\.\d+)?$/.test(val) && item.length > 2) {
          val = item[2];
        }
        try {
          closes.push(check(dayRaw, val, item));
        } catch {
          // Skip invalid rows
        }
      } else if (item && typeof item === "object") {
        const it = item as Record<string, unknown>;
        const dayRaw = it.pricedate ?? it.date;
        const val = it.pigprice ?? it.maizeprice ?? it.bean ?? it.price ?? it.value;
        try {
          closes.push(check(dayRaw, val, item));
        } catch {
          // Skip invalid rows
        }
      }
    }
    if (closes.length === 0) throw new Error("no readable klines in the answer");
    closes.sort((a, b) => a.day.localeCompare(b.day));
    return closes.slice(-HISTORY);
  }

  // 4. Tencent K-line answer: { data: { [code]: { day: [...], qfqday: [...], qt: [...] } } }
  const data = obj.data as Record<string, { day?: unknown; qfqday?: unknown; qt?: Record<string, unknown> }> | undefined;
  const [code, entry] = data && typeof data === "object" && !Array.isArray(data) ? (Object.entries(data)[0] ?? []) : [];
  const lines = entry?.day ?? entry?.qfqday;
  if (!Array.isArray(lines) || lines.length === 0) throw new Error("no klines in the answer");
  const closes = lines.slice(-HISTORY).map((line) => {
    if (!Array.isArray(line)) throw new Error(`unreadable kline ${String(line)}`);
    return check(line[0], line[2], line, line[3], line[4], line[5]);
  });

  const qt = code && entry?.qt && typeof entry.qt === "object" ? entry.qt[code] : undefined;
  const qtPrice = Array.isArray(qt) ? Number(qt[3]) : NaN;
  const qtHigh = Array.isArray(qt) ? Number(qt[33]) : NaN;
  const qtLow = Array.isArray(qt) ? Number(qt[34]) : NaN;
  const qtVol = Array.isArray(qt) ? Number(qt[36] ?? qt[6]) : NaN;
  const qtTime = Array.isArray(qt) && typeof qt[30] === "string" ? qt[30].match(/^(\d{4})[-/]?(\d{2})[-/]?(\d{2})/) : null;
  if (qtTime && Number.isFinite(qtPrice) && qtPrice > 0) {
    const qtDay = `${qtTime[1]}-${qtTime[2]}-${qtTime[3]}`;
    const last = closes.at(-1)!;
    if (qtDay === last.day) {
      last.close = qtPrice;
      if (withOhlcv) {
        if (Number.isFinite(qtHigh) && qtHigh > 0) last.high = Math.max(last.high ?? qtHigh, qtHigh);
        if (Number.isFinite(qtLow) && qtLow > 0) last.low = Math.min(last.low ?? qtLow, qtLow);
        if (Number.isFinite(qtVol) && qtVol >= 0 && last.volume === undefined) last.volume = qtVol;
      }
    } else if (qtDay > last.day) {
      closes.push({
        day: qtDay,
        close: qtPrice,
        ...(withOhlcv && Number.isFinite(qtHigh) && qtHigh > 0 ? { high: qtHigh } : {}),
        ...(withOhlcv && Number.isFinite(qtLow) && qtLow > 0 ? { low: qtLow } : {}),
        ...(withOhlcv && Number.isFinite(qtVol) && qtVol >= 0 ? { volume: qtVol } : {}),
      });
    }
  }
  return closes;
}

/**
 * Parses MOA (pfsc.agri.cn /api/FarmDaily/list) national daily wholesale agricultural reports
 * and extracts the official national wholesale pork average price (元/公斤).
 */
export function parseMoaFarmDailyPork(body: unknown): Array<{ day: string; close: number }> {
  if (!body || typeof body !== "object") throw new Error("unreadable MOA FarmDaily response");
  const content = (body as { content?: { list?: unknown[] } }).content;
  const list = content?.list;
  if (!Array.isArray(list) || list.length === 0) throw new Error("no list in MOA FarmDaily response");

  const byDay = new Map<string, number>();
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const text = String(item.animalConclusion ?? item.countentstr ?? "");
    const priceMatch = text.match(/猪肉(?:平均价格)?为?(\d+(?:\.\d+)?)元\/公斤/);
    if (!priceMatch) continue;
    const price = Number(priceMatch[1]);
    if (!Number.isFinite(price) || price <= 0) continue;

    let day = normalizeDay(String(item.daylyDate ?? item.remark ?? ""));
    if (!day && typeof item.year === "string" && typeof item.counclesion === "string") {
      const md = item.counclesion.match(/(\d{1,2})月(\d{1,2})日/);
      if (md) day = `${item.year}-${md[1]!.padStart(2, "0")}-${md[2]!.padStart(2, "0")}`;
    }
    if (day) byDay.set(day, price);
  }

  const closes = [...byDay.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([day, close]) => ({ day, close }));
  if (closes.length === 0) throw new Error("no readable pork wholesale prices in MOA FarmDaily");
  return closes.slice(-HISTORY);
}

function median3(a: number, b: number, c: number): number {
  return a + b + c - Math.min(a, b, c) - Math.max(a, b, c);
}

/**
 * Rejects isolated 1-day thin-sample spikes/dropouts (>12% jump that immediately reverses)
 * while leaving monotonic trends and normal daily variations untouched.
 */
export function despikeDailySeries(series: Array<{ day: string; close: number }>): Array<{ day: string; close: number }> {
  if (series.length < 3) return series;
  const out = series.map((p) => ({ ...p }));
  for (let i = 1; i < out.length - 1; i++) {
    const prev = series[i - 1]!.close;
    const curr = series[i]!.close;
    const next = series[i + 1]!.close;
    const isPeakOrTrough = (curr > prev && curr > next) || (curr < prev && curr < next);
    const neighborMid = (prev + next) / 2;
    if (isPeakOrTrough && neighborMid > 0 && Math.abs(curr - neighborMid) / neighborMid > 0.12) {
      out[i]!.close = Number(median3(prev, curr, next).toFixed(2));
    }
  }
  const lastIdx = out.length - 1;
  const prev1 = out[lastIdx - 1]!.close;
  const prev2 = out[lastIdx - 2]!.close;
  const lastVal = out[lastIdx]!.close;
  if (
    prev1 > 0 &&
    prev2 > 0 &&
    Math.abs(lastVal - prev1) / prev1 > 0.18 &&
    Math.abs(prev1 - prev2) / prev2 < 0.1
  ) {
    out[lastIdx]!.close = Number(median3(prev2, prev1, lastVal).toFixed(2));
  }
  return out;
}

/**
 * Parses Zhue (bj.zhue.com.cn/zoushi.php?act=pricecure) JSON curves (e.g. day=89,90,91 offsets),
 * handles year boundaries safely, filters isolated thin-sample spikes, and applies optional unit multiplier.
 */
export function parseZhuePriceCure(
  responses: unknown[],
  opts?: { multiplier?: number },
): Array<{ day: string; close: number }> {
  const multiplier = opts?.multiplier ?? 1;
  const byDay = new Map<string, number>();

  for (const res of responses) {
    if (!res || typeof res !== "object") continue;
    const obj = res as { daystr?: unknown; datestr?: unknown };
    if (typeof obj.daystr !== "string" || typeof obj.datestr !== "string") continue;

    let days: unknown[];
    try {
      days = JSON.parse(obj.daystr) as unknown[];
    } catch {
      continue;
    }
    const seriesMatch = obj.datestr.match(/name:\s*'(\d{4})',\s*data:\s*\[([^\]]*)\]/);
    if (!seriesMatch || !Array.isArray(days)) continue;

    const endYear = Number(seriesMatch[1]);
    const rawVals = seriesMatch[2]!.split(",").map((s) => s.trim());

    let latestMonth = 0;
    for (let i = days.length - 1; i >= 0; i--) {
      const dStr = typeof days[i] === "string" ? (days[i] as string) : "";
      const m = dStr.match(/^(\d{2})\.(\d{2})$/);
      if (m) {
        latestMonth = Number(m[1]);
        break;
      }
    }
    if (!latestMonth || !Number.isFinite(endYear)) continue;

    for (let i = 0; i < days.length; i++) {
      const dStr = typeof days[i] === "string" ? (days[i] as string) : "";
      const m = dStr.match(/^(\d{2})\.(\d{2})$/);
      const rawVal = Number(rawVals[i]);
      if (!m || !Number.isFinite(rawVal) || rawVal <= 0) continue;
      const monthNum = Number(m[1]);
      const year = monthNum > latestMonth ? endYear - 1 : endYear;
      const isoDay = `${year}-${m[1]}-${m[2]}`;
      byDay.set(isoDay, rawVal);
    }
  }

  const rawSeries = [...byDay.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([day, close]) => ({ day, close }));

  if (rawSeries.length === 0) throw new Error("no readable closes in zhue pricecure response");

  const cleaned = despikeDailySeries(rawSeries).map(({ day, close }) => ({
    day,
    close: Number((close * multiplier).toFixed(2)),
  }));
  return cleaned.slice(-HISTORY);
}

/** Computes daily hog-to-grain ratio from daily live hog (CNY/kg) and spot corn (CNY/ton) series. */
export function computePigGrainSeries(
  hogCloses: Array<{ day: string; close: number }>,
  cornCloses: Array<{ day: string; close: number }>,
): Array<{ day: string; close: number }> {
  const cornByDay = new Map(cornCloses.map((c) => [c.day, c.close]));
  const out: Array<{ day: string; close: number }> = [];
  for (const h of hogCloses) {
    const cornTon = cornByDay.get(h.day);
    if (!cornTon || cornTon <= 0) continue;
    const ratio = Number((h.close / (cornTon / 1000)).toFixed(2));
    if (Number.isFinite(ratio) && ratio > 0) {
      out.push({ day: h.day, close: ratio });
    }
  }
  if (out.length === 0) throw new Error("cannot compute hog-to-grain series: no overlapping hog and corn dates");
  return out.slice(-HISTORY);
}

/** Aggregates daily closes into Monday-Sunday weekly averages (up to 12 weeks) or quarterly points for periodic series. */
export function buildWeeklyTrendSeries(
  own: Array<{ day: string; close: number }>,
  frequency: MarketStatFrequency = "daily",
): MarketTrendPoint[] {
  if (own.length === 0) return [];
  if (frequency === "quarterly") {
    return own.slice(-12).map(({ day, close }) => {
      const yy = day.slice(2, 4);
      const q = Math.ceil(Number(day.slice(5, 7)) / 3);
      return { label: `${yy}Q${q}`, close: Number(close.toFixed(2)) };
    });
  }

  const buckets = new Map<string, { sum: number; count: number; lastDay: string }>();
  for (const { day, close } of own) {
    const dt = new Date(`${day}T00:00:00Z`);
    const dow = dt.getUTCDay(); // 0=Sun, 1=Mon...
    const offsetToMonday = dow === 0 ? -6 : 1 - dow;
    const mondayKey = addDays(day, offsetToMonday);
    const existing = buckets.get(mondayKey);
    if (existing) {
      existing.sum += close;
      existing.count += 1;
      if (day > existing.lastDay) existing.lastDay = day;
    } else {
      buckets.set(mondayKey, { sum: close, count: 1, lastDay: day });
    }
  }

  return [...buckets.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(-12)
    .map(([, b]) => {
      const mean = b.sum / b.count;
      const digits = mean > 0 && mean < 2 ? 3 : 2;
      return {
        label: b.lastDay.slice(5),
        close: Number(mean.toFixed(digits)),
      };
    });
}

/** Unified, zero-hardcoding cyclical benchmark & cost/policy anchor evaluation for all 9 pork indicators. */
export function computePorkBenchmark(q: MarketQuote, allQuotes: MarketQuote[]): PorkQuoteBenchmark {
  const getQ = (sym: string) => allQuotes.find((item) => item.symbol === sym);
  const hog = getQ("hog_spot");
  const corn = getQ("corn_spot");
  const bean = getQ("bean_spot");

  switch (q.symbol) {
    case "hog_spot": {
      const { diffPerKg, diffPct, profitPerHead } = computeHogProfitMetrics(q.price);
      const signPct = `${diffPct >= 0 ? "+" : ""}${diffPct.toFixed(1)}%`;
      if (q.price < PORK_THRESHOLDS.hogCashCostPerKg) {
        return {
          anchorText: `较完全成本 ${signPct}`,
          anchorSub: `头均亏损约 ¥${Math.abs(profitPerHead)} (成本线¥${PORK_THRESHOLDS.hogFullCostPerKg.toFixed(1)})`,
          referenceLine: PORK_THRESHOLDS.hogFullCostPerKg,
          statusBadge: "击穿现金成本",
          statusTone: "critical",
          statusDesc: `跌破行业现金成本线(¥${PORK_THRESHOLDS.hogCashCostPerKg.toFixed(1)}/kg)，全行业现金流承压加速去产能`,
        };
      }
      if (diffPerKg < 0) {
        return {
          anchorText: `较完全成本 ${signPct}`,
          anchorSub: `头均亏损约 ¥${Math.abs(profitPerHead)} (成本线¥${PORK_THRESHOLDS.hogFullCostPerKg.toFixed(1)})`,
          referenceLine: PORK_THRESHOLDS.hogFullCostPerKg,
          statusBadge: "完全成本下方",
          statusTone: "caution",
          statusDesc: `低于行业自繁自养完全成本(¥${PORK_THRESHOLDS.hogFullCostPerKg.toFixed(1)}/kg)，高成本产能边际出清`,
        };
      }
      if (diffPerKg < 2.5) {
        return {
          anchorText: `成本溢价 ${signPct}`,
          anchorSub: `头均盈利约 ¥${profitPerHead} (成本线¥${PORK_THRESHOLDS.hogFullCostPerKg.toFixed(1)})`,
          referenceLine: PORK_THRESHOLDS.hogFullCostPerKg,
          statusBadge: "温和盈利区",
          statusTone: "positive",
          statusDesc: `站上行业完全成本线(¥${PORK_THRESHOLDS.hogFullCostPerKg.toFixed(1)}/kg)，自繁自养恢复合理现金回报`,
        };
      }
      return {
        anchorText: `成本溢价 ${signPct}`,
        anchorSub: `头均盈利约 ¥${profitPerHead} (成本线¥${PORK_THRESHOLDS.hogFullCostPerKg.toFixed(1)})`,
        referenceLine: PORK_THRESHOLDS.hogFullCostPerKg,
        statusBadge: "高景气盈利",
        statusTone: "accent",
        statusDesc: "头均养殖利润丰厚，需关注压栏二育与中远期产能扩张节奏",
      };
    }

    case "pork_spot": {
      const hogPrice = hog?.price ?? 9.19;
      const spread = q.price - hogPrice;
      const ratio = q.price / (hogPrice || 1);
      // 理论批发保本线 = 毛猪折白条原料成本(出肉率73%) + 屠宰检疫冷链批发刚性费用(约2.0元/kg)
      const wholesaleBreakeven = hogPrice / PORK_THRESHOLDS.carcassDressingRate + PORK_THRESHOLDS.wholesaleProcessingFeePerKg;
      const margin = q.price - wholesaleBreakeven;
      if (margin < -0.4) {
        return {
          anchorText: `毛白价差 ¥${spread.toFixed(2)}/kg`,
          anchorSub: `白条/毛猪比 ${ratio.toFixed(2)}:1 (顺价偏弱)`,
          referenceLine: Number(wholesaleBreakeven.toFixed(2)),
          statusBadge: "终端顺价承压",
          statusTone: "caution",
          statusDesc: `批发白条低于理论顺价平衡线(¥${wholesaleBreakeven.toFixed(2)}/kg)，终端消费承接偏弱`,
        };
      }
      if (margin <= 1.2) {
        return {
          anchorText: `毛白价差 ¥${spread.toFixed(2)}/kg`,
          anchorSub: `白条/毛猪比 ${ratio.toFixed(2)}:1`,
          referenceLine: Number(wholesaleBreakeven.toFixed(2)),
          statusBadge: "屠宰顺价平衡",
          statusTone: "neutral",
          statusDesc: "农业部批发白条与毛猪原料成本大体匹配，屠宰鲜销走货平稳",
        };
      }
      return {
        anchorText: `毛白价差 ¥${spread.toFixed(2)}/kg`,
        anchorSub: `白条/毛猪比 ${ratio.toFixed(2)}:1 (走货偏强)`,
        referenceLine: Number(wholesaleBreakeven.toFixed(2)),
        statusBadge: "终端走货顺畅",
        statusTone: "positive",
        statusDesc: "白条批发溢价改善，下游鲜销需求对毛猪价格形成正向支撑",
      };
    }

    case "hog_futures": {
      const hogPrice = hog?.price ?? 9.19;
      const futuresKg = q.cnyPrice ?? q.price / 1000;
      const basis = futuresKg - hogPrice;
      const basisPct = (basis / (hogPrice || 1)) * 100;
      if (Math.abs(basis) < 0.15) {
        return {
          anchorText: `期现基本平水 (${basis >= 0 ? "+" : ""}¥${basis.toFixed(2)}/kg)`,
          anchorSub: `主力较现货 ${basisPct >= 0 ? "+" : ""}${basisPct.toFixed(1)}%`,
          referenceLine: Number((hogPrice * 1000).toFixed(0)),
          statusBadge: "期现平水博弈",
          statusTone: "neutral",
          statusDesc: "主力合约与现货出栏价基本平水，远期多空预期趋于一致",
        };
      }
      if (basis > 0) {
        return {
          anchorText: `期货升水 +¥${basis.toFixed(2)}/kg`,
          anchorSub: `合 +${Math.round(basis * 1000)}元/吨 (+${basisPct.toFixed(1)}%)`,
          referenceLine: Number((hogPrice * 1000).toFixed(0)),
          statusBadge: "远期升水预期",
          statusTone: "accent",
          statusDesc: "期货较现货维持升水，衍生品市场计价去产能后的远期供需改善",
        };
      }
      return {
        anchorText: `期货贴水 -¥${Math.abs(basis).toFixed(2)}/kg`,
        anchorSub: `合 -${Math.round(Math.abs(basis) * 1000)}元/吨 (${basisPct.toFixed(1)}%)`,
        referenceLine: Number((hogPrice * 1000).toFixed(0)),
        statusBadge: "远期贴水谨慎",
        statusTone: "caution",
        statusDesc: "期货贴水现货运行，市场对中远期出栏供给压力仍持谨慎预期",
      };
    }

    case "piglet_spot": {
      const breakeven = PORK_THRESHOLDS.pigletBreakevenPerHead;
      const diff = q.price - breakeven;
      const diffPct = (diff / breakeven) * 100;
      const perKg = q.cnyPrice ?? q.price / PORK_THRESHOLDS.pigletWeightKg;
      if (q.price < PORK_THRESHOLDS.pigletFreezePerHead) {
        return {
          anchorText: `低于保本线(¥${breakeven}) ${diffPct.toFixed(1)}%`,
          anchorSub: `头均亏约 ¥${Math.round(Math.abs(diff))} (折¥${perKg.toFixed(2)}/kg)`,
          referenceLine: breakeven,
          statusBadge: "补栏冰点",
          statusTone: "critical",
          statusDesc: "15kg仔猪深跌至繁育成本大幅下方，外购补栏停滞锁定5~6月后出栏收缩",
        };
      }
      if (q.price < breakeven) {
        return {
          anchorText: `低于保本线(¥${breakeven}) ${diffPct.toFixed(1)}%`,
          anchorSub: `头均微亏 ¥${Math.round(Math.abs(diff))} (折¥${perKg.toFixed(2)}/kg)`,
          referenceLine: breakeven,
          statusBadge: "补栏偏冷",
          statusTone: "caution",
          statusDesc: "外售仔猪处于繁育保本线下方，下游育肥户观望为主、补栏节奏放缓",
        };
      }
      if (q.price <= PORK_THRESHOLDS.pigletOverheatPerHead) {
        return {
          anchorText: `高于保本线(¥${breakeven}) +${diffPct.toFixed(1)}%`,
          anchorSub: `头均毛利 ¥${Math.round(diff)} (折¥${perKg.toFixed(2)}/kg)`,
          referenceLine: breakeven,
          statusBadge: "补栏常态",
          statusTone: "positive",
          statusDesc: "仔猪销售恢复合理盈利，养殖场户按年度计划正常轮动补栏",
        };
      }
      return {
        anchorText: `高于保本线(¥${breakeven}) +${diffPct.toFixed(1)}%`,
        anchorSub: `头均溢价 ¥${Math.round(diff)} (折¥${perKg.toFixed(2)}/kg)`,
        referenceLine: breakeven,
        statusBadge: "补栏过热",
        statusTone: "caution",
        statusDesc: "仔猪抢购溢价偏高，需警惕5~6月后外购育肥出栏成本抬升风险",
      };
    }

    case "sow_spot": {
      const normal = PORK_THRESHOLDS.sowNormalPricePerHead;
      const diffPct = ((q.price - normal) / normal) * 100;
      const ch1mPct = q.change1m !== null ? `${q.change1m >= 0 ? "+" : ""}${(q.change1m * 100).toFixed(1)}%` : null;
      const subText = ch1mPct ? `常态基准 ¥${normal}/头 · 近30日 ${ch1mPct}` : `常态更新基准约 ¥${normal}/头`;
      if (q.price < PORK_THRESHOLDS.sowDeepDiscountPerHead) {
        return {
          anchorText: `较常态基准 ${diffPct.toFixed(1)}%`,
          anchorSub: subText,
          referenceLine: normal,
          statusBadge: "深跌去化",
          statusTone: "critical",
          statusDesc: "二元种猪跌破更新底线，种猪场被动降价促销、基础母猪加速淘汰",
        };
      }
      if (q.price < normal - 50) {
        return {
          anchorText: `较常态基准 ${diffPct.toFixed(1)}%`,
          anchorSub: subText,
          referenceLine: normal,
          statusBadge: "扩繁谨慎",
          statusTone: "caution",
          statusDesc: "后备母猪报价低于常态更新中枢，集团与家庭猪场补母意愿偏弱",
        };
      }
      if (q.price <= PORK_THRESHOLDS.sowExpansionPerHead) {
        return {
          anchorText: `较常态基准 ${diffPct >= 0 ? "+" : ""}${diffPct.toFixed(1)}%`,
          anchorSub: subText,
          referenceLine: normal,
          statusBadge: "更新均衡",
          statusTone: "positive",
          statusDesc: "二元种猪价格处于常态更新区间，基础母猪群维持正常胎龄更替",
        };
      }
      return {
        anchorText: `较常态基准 +${diffPct.toFixed(1)}%`,
        anchorSub: subText,
        referenceLine: normal,
        statusBadge: "扩繁活跃",
        statusTone: "accent",
        statusDesc: "后备母猪溢价走强、引种扩繁积极，预示10~12月后基础产能回升",
      };
    }

    case "sow_inventory": {
      const target = PORK_THRESHOLDS.sowInventoryTargetWan;
      const ratio = q.price / target;
      const ratioPct = ratio * 100;
      const diffWan = q.price - target;
      const diffLabel = diffWan >= 0 ? `较基准 +${diffWan.toFixed(0)}万头` : `较基准3750万少 ${Math.abs(diffWan).toFixed(0)}万头`;

      if (ratio < PORK_THRESHOLDS.sowInventoryYellowFloorRatio) {
        return {
          anchorText: `保有量 ${ratioPct.toFixed(1)}% (红色预警区)`,
          anchorSub: diffLabel,
          referenceLine: target,
          statusBadge: "产能过度紧缺",
          statusTone: "critical",
          statusDesc: "低于正常保有量85%红线，远期生猪供应存在显著短缺风险",
        };
      }
      if (ratio < PORK_THRESHOLDS.sowInventoryGreenFloorRatio) {
        return {
          anchorText: `保有量 ${ratioPct.toFixed(1)}% (黄色调控区)`,
          anchorSub: diffLabel,
          referenceLine: target,
          statusBadge: "大幅去化预警",
          statusTone: "caution",
          statusDesc: "跌入保有量85%~92%黄色波动区，基础产能深度收缩支撑远期反转",
        };
      }
      if (ratio < 1.0) {
        return {
          anchorText: `达保有量 ${ratioPct.toFixed(1)}% (绿色下沿)`,
          anchorSub: diffLabel,
          referenceLine: target,
          statusBadge: "绿色区间去化",
          statusTone: "positive",
          statusDesc: "处于92%~103%绿色区间下半区且低于3750万目标，产能实质性调减",
        };
      }
      if (ratio <= PORK_THRESHOLDS.sowInventoryGreenCeilRatio) {
        return {
          anchorText: `达保有量 ${ratioPct.toFixed(1)}% (绿色上沿)`,
          anchorSub: diffLabel,
          referenceLine: target,
          statusBadge: "产能充裕稳健",
          statusTone: "neutral",
          statusDesc: "处于农业农村部92%~103%绿色合理区间上半区，10个月后基础供给充裕",
        };
      }
      return {
        anchorText: `达保有量 ${ratioPct.toFixed(1)}% (超保有上限)`,
        anchorSub: diffLabel,
        referenceLine: target,
        statusBadge: "产能偏多预警",
        statusTone: "caution",
        statusDesc: "超出正常保有量103%绿色上限，需引导调减能繁母猪以防远期过剩",
      };
    }

    case "pig_grain_ratio": {
      const breakeven = PORK_THRESHOLDS.pigGrainBreakeven;
      const devPct = ((q.price - breakeven) / breakeven) * 100;
      const devSign = `${devPct >= 0 ? "+" : ""}${devPct.toFixed(1)}%`;
      if (q.price < PORK_THRESHOLDS.pigGrainLevel1Floor) {
        return {
          anchorText: `破 ${PORK_THRESHOLDS.pigGrainLevel1Floor.toFixed(1)}:1 (一级预警)`,
          anchorSub: `距平衡线(${breakeven.toFixed(1)}:1) 偏离 ${devSign}`,
          referenceLine: breakeven,
          statusBadge: "一级预警收储",
          statusTone: "critical",
          statusDesc: "触发发改委过度下跌一级预警(<5.0:1)，中央储备冻猪肉收储机制托底",
        };
      }
      if (q.price < breakeven) {
        return {
          anchorText: `5.0~6.0:1 (亏损预警区)`,
          anchorSub: `距平衡线(${breakeven.toFixed(1)}:1) 偏离 ${devSign}`,
          referenceLine: breakeven,
          statusBadge: "二级/三级预警",
          statusTone: "caution",
          statusDesc: "低于发改委6.0:1盈亏平衡参考点，行业处于轻中度亏损监测区间",
        };
      }
      if (q.price <= PORK_THRESHOLDS.pigGrainHighWarning) {
        return {
          anchorText: `6.0~9.0:1 (正常运行区)`,
          anchorSub: `高于平衡线(${breakeven.toFixed(1)}:1) ${devSign}`,
          referenceLine: breakeven,
          statusBadge: "比价运行合理",
          statusTone: "positive",
          statusDesc: "猪粮比处于发改委绿色正常区间，生猪养殖与粮食成本比价均衡",
        };
      }
      return {
        anchorText: `超 ${PORK_THRESHOLDS.pigGrainHighWarning.toFixed(1)}:1 (上涨预警)`,
        anchorSub: `高于平衡线(${breakeven.toFixed(1)}:1) ${devSign}`,
        referenceLine: breakeven,
        statusBadge: "过度上涨预警",
        statusTone: "caution",
        statusDesc: "猪粮比突破9.0:1调控上限，关注中央储备肉投放稳价信号",
      };
    }

    case "corn_spot":
    case "bean_spot": {
      const isCorn = q.symbol === "corn_spot";
      const weightText = isCorn ? "占配合饲料约 60%" : "占配合饲料约 20%";
      const cornKg = corn?.cnyPrice ?? (corn?.price ? corn.price / 1000 : 2.33);
      const beanKg = bean?.cnyPrice ?? (bean?.price ? bean.price / 1000 : 3.12);
      // 育肥猪全价配合料估算: 62%玉米 + 18%豆粕 + 20%麸皮预混料与加工(约0.72元/kg固定项)
      const estFeedPerKg = 0.62 * cornKg + 0.18 * beanKg + 0.72;
      const ch1m = q.change1m ?? q.change1w ?? 0;
      const ch1mPct = `${ch1m >= 0 ? "+" : ""}${(ch1m * 100).toFixed(1)}%`;

      if (ch1m > 0.03) {
        return {
          anchorText: weightText,
          anchorSub: `近30日 ${ch1mPct} · 配合料约¥${estFeedPerKg.toFixed(2)}/kg`,
          statusBadge: "原料成本抬升",
          statusTone: "caution",
          statusDesc: `${isCorn ? "玉米能量料" : "豆粕蛋白料"}近月走强(${ch1mPct})，边际推升育肥造肉饲料成本`,
        };
      }
      if (ch1m < -0.03) {
        return {
          anchorText: weightText,
          anchorSub: `近30日 ${ch1mPct} · 配合料约¥${estFeedPerKg.toFixed(2)}/kg`,
          statusBadge: "原料让利回落",
          statusTone: "positive",
          statusDesc: `${isCorn ? "玉米现货" : "豆粕现货"}近月回落(${ch1mPct})，缓解养殖端饲料现金支出压力`,
        };
      }
      return {
        anchorText: weightText,
        anchorSub: `近30日 ${ch1mPct} · 配合料约¥${estFeedPerKg.toFixed(2)}/kg`,
        statusBadge: "成本窄幅震荡",
        statusTone: "neutral",
        statusDesc: `${isCorn ? "玉米能量主料" : "豆粕蛋白主料"}近30日波动温和(${ch1mPct})，饲料成本底线平稳`,
      };
    }

    case "muyuan_002714":
    case "wens_300498": {
      const etf = getQ("etf_516670");
      const etfCh1m = etf?.change1m ?? 0;
      const selfCh1m = q.change1m ?? 0;
      const hogCh1m = hog?.change1m ?? 0;
      const alphaVsEtfPct = (selfCh1m - etfCh1m) * 100;
      const alphaVsHogPct = (selfCh1m - hogCh1m) * 100;
      const isMuyuan = q.symbol === "muyuan_002714";
      const weightText = isMuyuan ? "第一权重 ~15% · 自繁自养成本标杆" : "第二权重 ~13% · 公司+农户标杆";
      const pivot = isMuyuan ? 38.0 : 17.0;
      if (alphaVsHogPct >= 3.0 || selfCh1m >= 0.03) {
        return {
          anchorText: weightText,
          anchorSub: `较ETF超额 ${alphaVsEtfPct >= 0 ? "+" : ""}${alphaVsEtfPct.toFixed(1)}% · 较猪价超额 +${alphaVsHogPct.toFixed(1)}%`,
          referenceLine: pivot,
          statusBadge: "机构抢跑反转",
          statusTone: "accent",
          statusDesc: `${q.name}显著跑赢现货猪价，主力资金提前博弈产能出清与右侧周期反转`,
        };
      }
      if (selfCh1m <= -0.04 && alphaVsEtfPct <= -1.5) {
        return {
          anchorText: weightText,
          anchorSub: `近30日 ${(selfCh1m * 100).toFixed(1)}% · 较ETF ${alphaVsEtfPct.toFixed(1)}%`,
          referenceLine: pivot,
          statusBadge: "龙头缩量筑底",
          statusTone: "caution",
          statusDesc: `${q.name}随现货亏损回撤寻底，头均市值处于周期底部高赔率区间`,
        };
      }
      return {
        anchorText: weightText,
        anchorSub: `近30日 ${selfCh1m >= 0 ? "+" : ""}${(selfCh1m * 100).toFixed(1)}% · 较ETF ${alphaVsEtfPct >= 0 ? "+" : ""}${alphaVsEtfPct.toFixed(1)}%`,
        referenceLine: pivot,
        statusBadge: "龙头持仓稳健",
        statusTone: "positive",
        statusDesc: `${q.name}走势与516670保持共振，完全成本优势提供周期底部安全垫`,
      };
    }

    case "etf_516670": {
      const g = computeEtf516670Guidance(allQuotes);
      const diffSign = `${g.ma20Diff >= 0 ? "+" : ""}${(g.ma20Diff * 100).toFixed(2)}%`;
      return {
        anchorText: `MA20 ¥${g.ma20.toFixed(3)} (${diffSign})`,
        anchorSub: `近期分位 ${g.pricePercentile.toFixed(1)}% · 综合评分 ${g.score}/100`,
        referenceLine: g.ma20,
        statusBadge: g.actionLabel,
        statusTone: g.actionTone,
        statusDesc: g.swingAdvice,
      };
    }

    default:
      return {
        anchorText: "行业参考指标",
        statusBadge: "常态监测",
        statusTone: "neutral",
        statusDesc: q.note ?? "",
      };
  }
}

/**
 * Multi-factor cycle & technical swing guidance engine for Livestock ETF (516670).
 * Combines 80% hog industry cycle fundamentals (35% capacity de-stocking, 25% loss safety cushion,
 * 20% futures basis & feed cost) with 20% ETF technical wave indicators (price percentile & MA20 deviation).
 */
export function computeEtf516670Guidance(
  quotes: ReadonlyArray<Pick<MarketQuote, "symbol" | "price"> & Partial<MarketQuote>>,
): Etf516670Guidance {
  const getQ = (sym: string) => quotes.find((q) => q.symbol === sym);

  const hogQ = getQ("hog_spot");
  const futuresQ = getQ("hog_futures");
  const pigletQ = getQ("piglet_spot");
  const sowSpotQ = getQ("sow_spot");
  const sowInvQ = getQ("sow_inventory");
  const ratioQ = getQ("pig_grain_ratio");
  const cornQ = getQ("corn_spot");
  const beanQ = getQ("bean_spot");
  const etfQ = getQ("etf_516670");

  const hogPrice = hogQ?.price ?? 9.19;
  const futuresPriceKg = futuresQ?.cnyPrice ?? (futuresQ?.price ? futuresQ.price / 1000 : 9.51);
  const pigletPriceHead = pigletQ?.unit === "头"
    ? pigletQ.price
    : (pigletQ?.price ?? 13.67) * PORK_THRESHOLDS.pigletWeightKg;
  const sowSpotPrice = sowSpotQ?.price ?? 1485;
  const sowInv = sowInvQ?.price ?? 3602;
  const ratio = ratioQ?.price ?? 3.94;

  // --- ETF Technical Metrics ---
  const etfPrice = etfQ?.price ?? 0.585;
  const closes = etfQ?.series && etfQ.series.length > 0
    ? etfQ.series.map((p) => p.close)
    : [etfPrice];
  const rangeLow = Number(Math.min(...closes).toFixed(3));
  const rangeHigh = Number(Math.max(...closes).toFixed(3));
  const span = rangeHigh - rangeLow;
  const pricePercentile = span > 1e-6
    ? Number(Math.min(100, Math.max(0, ((etfPrice - rangeLow) / span) * 100)).toFixed(1))
    : 50.0;

  const ma20Slice = closes.slice(-20);
  const ma20 = Number((ma20Slice.reduce((sum, v) => sum + v, 0) / ma20Slice.length).toFixed(3));
  const ma20Diff = ma20 > 0 ? Number((etfPrice / ma20 - 1).toFixed(4)) : 0;
  const ma20DiffPctText = `${ma20Diff >= 0 ? "+" : ""}${(ma20Diff * 100).toFixed(2)}%`;

  // --- Factor 1: Capacity De-stocking & Forward Supply (Max 35 pts) ---
  const sowTarget = PORK_THRESHOLDS.sowInventoryTargetWan;
  const sowRatio = sowInv / sowTarget;
  let sowInvPts = 5;
  if (sowRatio < PORK_THRESHOLDS.sowInventoryGreenFloorRatio) sowInvPts = 15;
  else if (sowInv < 3650) sowInvPts = 13;
  else if (sowInv < sowTarget) sowInvPts = 10;
  else if (sowRatio <= PORK_THRESHOLDS.sowInventoryGreenCeilRatio) sowInvPts = 5;
  else sowInvPts = 1;

  let pigletPts = 5;
  if (pigletPriceHead < PORK_THRESHOLDS.pigletFreezePerHead) pigletPts = 10;
  else if (pigletPriceHead < PORK_THRESHOLDS.pigletBreakevenPerHead) pigletPts = 8;
  else if (pigletPriceHead <= 400) pigletPts = 5;
  else if (pigletPriceHead <= PORK_THRESHOLDS.pigletOverheatPerHead) pigletPts = 3;
  else pigletPts = 1;

  let sowSpotPts = 5;
  if (sowSpotPrice < PORK_THRESHOLDS.sowDeepDiscountPerHead) sowSpotPts = 10;
  else if (sowSpotPrice < PORK_THRESHOLDS.sowNormalPricePerHead - 50) sowSpotPts = 8;
  else if (sowSpotPrice <= PORK_THRESHOLDS.sowExpansionPerHead) sowSpotPts = 5;
  else sowSpotPts = 1;

  const capScore = sowInvPts + pigletPts + sowSpotPts; // 0 ~ 35
  const capFactor: EtfFactorSignal = {
    name: "产能去化度",
    score: capScore,
    maxScore: 35,
    badge: capScore >= 26 ? "实质去化·看多" : capScore >= 18 ? "产能温和调减" : "产能充裕·谨慎",
    tone: capScore >= 26 ? "positive" : capScore >= 18 ? "neutral" : "caution",
    detail: `能繁母猪 ${sowInv.toFixed(0)}万头 (保有目标${(sowRatio * 100).toFixed(1)}%)，仔猪 ¥${pigletPriceHead.toFixed(0)}/头，二元种猪 ¥${sowSpotPrice.toFixed(0)}/头`,
  };

  // --- Factor 2: Loss Safety Cushion & Policy Support (Max 25 pts) ---
  const { profitPerHead } = computeHogProfitMetrics(hogPrice);
  let hogCostPts = 6;
  if (hogPrice < PORK_THRESHOLDS.hogCashCostPerKg) hogCostPts = 13;
  else if (hogPrice < PORK_THRESHOLDS.hogFullCostPerKg) hogCostPts = 10;
  else if (hogPrice < 15.5) hogCostPts = 6;
  else if (hogPrice < 18.0) hogCostPts = 3;
  else hogCostPts = 1;

  let ratioPts = 6;
  if (ratio < PORK_THRESHOLDS.pigGrainLevel1Floor) ratioPts = 12;
  else if (ratio < PORK_THRESHOLDS.pigGrainBreakeven) ratioPts = 9;
  else if (ratio <= 8.0) ratioPts = 6;
  else if (ratio <= PORK_THRESHOLDS.pigGrainHighWarning) ratioPts = 3;
  else ratioPts = 1;

  const cushionScore = hogCostPts + ratioPts; // 0 ~ 25
  const cushionFactor: EtfFactorSignal = {
    name: "亏损安全垫",
    score: cushionScore,
    maxScore: 25,
    badge: cushionScore >= 20 ? "深亏收储·高赔率" : cushionScore >= 13 ? "成本线博弈" : "高景气兑现区",
    tone: cushionScore >= 20 ? "positive" : cushionScore >= 13 ? "neutral" : "caution",
    detail: `生猪 ¥${hogPrice.toFixed(2)}/kg (头均${profitPerHead >= 0 ? `盈¥${profitPerHead}` : `亏¥${Math.abs(profitPerHead)}`})，猪粮比 ${ratio.toFixed(2)}:1`,
  };

  // --- Factor 3: Futures Basis & Feed Cost Catalyst (Max 20 pts) ---
  const basis = futuresPriceKg - hogPrice;
  let basisPts = 8;
  if (hogPrice < PORK_THRESHOLDS.hogFullCostPerKg) {
    if (basis >= 0.5) basisPts = 14;
    else if (basis >= 0.15) basisPts = 11;
    else if (basis > -0.15) basisPts = 8;
    else basisPts = 4;
  } else {
    if (basis >= 0.15) basisPts = 10;
    else if (basis >= -0.3) basisPts = 7;
    else basisPts = 2;
  }

  const cornCh1m = cornQ?.change1m ?? cornQ?.change1w ?? 0;
  const beanCh1m = beanQ?.change1m ?? beanQ?.change1w ?? 0;
  const feedBlendCh = 0.75 * cornCh1m + 0.25 * beanCh1m;
  let feedPts = 4;
  if (feedBlendCh < -0.02) feedPts = 6;
  else if (feedBlendCh <= 0.02) feedPts = 4;
  else feedPts = 2;

  const catalystScore = basisPts + feedPts; // 0 ~ 20
  const basisText = Math.abs(basis) < 0.15
    ? "期现平水"
    : basis > 0
      ? `期货升水 +¥${basis.toFixed(2)}/kg`
      : `期货贴水 -¥${Math.abs(basis).toFixed(2)}/kg`;
  const catalystFactor: EtfFactorSignal = {
    name: "期现与成本催化",
    score: catalystScore,
    maxScore: 20,
    badge: catalystScore >= 14 ? "升水修复·偏多" : catalystScore >= 10 ? "期现温和博弈" : "远期贴水承压",
    tone: catalystScore >= 14 ? "accent" : catalystScore >= 10 ? "neutral" : "caution",
    detail: `${basisText}，配合料原料近月变动 ${feedBlendCh >= 0 ? "+" : ""}${(feedBlendCh * 100).toFixed(1)}%`,
  };

  // --- Factor 4: ETF Technical Position & Short-term Wave (Max 20 pts) ---
  let pctPts = 8;
  if (pricePercentile <= 25) pctPts = 12;
  else if (pricePercentile <= 50) pctPts = 10;
  else if (pricePercentile <= 70) pctPts = 8;
  else if (pricePercentile <= 85) pctPts = 5;
  else pctPts = 2;

  let maPts = 6;
  let swingSignal = "均线附近震荡整理";
  if (ma20Diff >= 0 && ma20Diff <= 0.04) {
    maPts = 8;
    swingSignal = "站稳MA20 · 右侧多头健康";
  } else if (ma20Diff >= -0.03 && ma20Diff < 0) {
    maPts = 7;
    swingSignal = "回踩MA20支撑 · 波段低吸区";
  } else if (ma20Diff < -0.05) {
    maPts = 5;
    swingSignal = "跌破MA20超跌 · 左侧网格区";
  } else if (ma20Diff < -0.03) {
    maPts = 4;
    swingSignal = "MA20下方弱势寻底";
  } else if (ma20Diff <= 0.07) {
    maPts = 5;
    swingSignal = "偏离MA20偏高 · 暂缓追涨";
  } else {
    maPts = 2;
    swingSignal = "短线超买乖离大 · 警惕回踩";
  }

  const techScore = pctPts + maPts; // 0 ~ 20
  const techFactor: EtfFactorSignal = {
    name: "ETF技术波段",
    score: techScore,
    maxScore: 20,
    badge: swingSignal.split(" · ")[0] ?? swingSignal,
    tone: techScore >= 15 ? "accent" : techScore >= 11 ? "neutral" : "caution",
    detail: `现价 ¥${etfPrice.toFixed(3)}，MA20 ¥${ma20.toFixed(3)} (${ma20DiffPctText})，近期分位 ${pricePercentile.toFixed(1)}%`,
  };

  const totalScore = capScore + cushionScore + catalystScore + techScore; // 0 ~ 100
  const cycleScore = capScore + cushionScore + catalystScore; // 0 ~ 80 (80% cycle weight)

  const positionPlan = compute516670PositionPlan(etfQ, totalScore, cycleScore, quotes);
  const curRow = positionPlan.ladderRows?.[positionPlan.currentRowIndex ?? 0];
  const buy1Pt = positionPlan.actionPoints?.find((p) => p.kind === "buy1");
  const buy2Pt = positionPlan.actionPoints?.find((p) => p.kind === "buy2");
  const sell1Pt = positionPlan.actionPoints?.find((p) => p.kind === "sell1");
  const sell2Pt = positionPlan.actionPoints?.find((p) => p.kind === "sell2");
  const curShares = positionPlan.latestSnapshot.shares ?? 14400;
  const dilutedCost = positionPlan.latestSnapshot.dilutedCost ?? 0.5757;
  const dilutedCostText = `¥${dilutedCost.toFixed(4)}`;

  let action: EtfActionRating = "hold";
  let actionLabel = "底仓持有 · 动态做T";
  let actionTone: PorkStatusTone = "neutral";
  const positionHint = `底仓 ${positionPlan.totalCoreShares.toLocaleString()}股 · 持仓 ${curShares.toLocaleString()}股 · 成本 ${dilutedCostText}`;
  let summary = "";
  let cycleAdvice = "";
  let swingAdvice = "";

  const nextSellDesc = sell1Pt?.triggerPrice
    ? `第一卖点 ¥${sell1Pt.triggerPrice.toFixed(3)} 卖 ${sell1Pt.shares?.toLocaleString()}股（${sell1Pt.technicalAnchor}）`
    : sell1Pt?.disabledReason ?? "仅剩底仓锁仓待涨";
  const nextBuyDesc = buy1Pt?.triggerPrice
    ? `第一买点 ¥${buy1Pt.triggerPrice.toFixed(3)} 买 ${buy1Pt.shares?.toLocaleString()}股（${buy1Pt.technicalAnchor}）`
    : buy1Pt?.disabledReason ?? "周期顶部暂停买入";

  if (cycleScore >= 56 || totalScore >= 72) {
    if (ma20Diff > 0.045 || pricePercentile > 80) {
      action = "accumulate";
      actionLabel = "周期底仓锁仓 · 短线忌追高";
      actionTone = "positive";
    } else if (ma20Diff >= 0) {
      action = hogPrice < PORK_THRESHOLDS.hogCashCostPerKg ? "accumulate" : "buy_right";
      actionLabel = hogPrice < PORK_THRESHOLDS.hogCashCostPerKg
        ? "底仓锁仓 · 动态支撑降本"
        : "修复共振 · 前高压力做T";
      actionTone = hogPrice < PORK_THRESHOLDS.hogCashCostPerKg ? "positive" : "accent";
    } else {
      action = "accumulate";
      actionLabel = "底仓锁仓 · 均线回踩吸筹";
      actionTone = "positive";
    }

    summary = `猪周期处“深亏去产能+一级收储”底部（周期分 ${cycleScore}/80），516670 报 ¥${etfPrice.toFixed(3)}（摊薄成本 ${dilutedCostText}），锁死 ${positionPlan.totalCoreShares.toLocaleString()} 股底仓，结合 MA20 与支撑压力位动态高抛低吸。`;
    cycleAdvice = `能繁母猪降至 ${sowInv.toFixed(0)} 万头、头均亏 ¥${Math.abs(profitPerHead)} 且触发一级收储，维持 ${positionPlan.totalCoreShares.toLocaleString()} 股核心底仓不动，下跌途中绝不设技术破位止损。`;
    swingAdvice = `当前总持仓 ${curShares.toLocaleString()} 股：${nextSellDesc}；${nextBuyDesc}。第二买点（强支撑 ¥${(buy2Pt?.triggerPrice ?? 0.58).toFixed(3)}）加码 ${buy2Pt?.shares?.toLocaleString() ?? "3,000"} 股且反弹卖半留半。`;
  } else if (totalScore >= 58) {
    action = ma20Diff >= 0 ? "buy_right" : "accumulate";
    actionLabel = "修复上行 · 动态波段降本";
    actionTone = ma20Diff >= 0 ? "accent" : "positive";
    summary = `产业链供需边际改善（评分 ${totalScore}/100），516670 报 ¥${etfPrice.toFixed(3)}（摊薄成本 ${dilutedCostText}），底仓持有配合近期支撑压力位做差价。`;
    cycleAdvice = `产能处合理区间且亏损收敛，周期向供需平衡过渡，保留 ${positionPlan.totalCoreShares.toLocaleString()} 股核心底仓，差价利润满 100 股即在第一买点加码转底仓。`;
    swingAdvice = `数据驱动当下行动点：${nextSellDesc}；${nextBuyDesc}（不用本金追高，每笔卖出必须高于摊薄成本）。`;
  } else if (totalScore >= 44) {
    action = "hold";
    actionLabel = "平衡震荡 · 支撑压力做T";
    actionTone = "neutral";
    summary = `产业处成本线附近拉锯（评分 ${totalScore}/100），516670 报 ¥${etfPrice.toFixed(3)}，围绕 MA20（¥${ma20.toFixed(3)}）与近期高低点动态降低持仓均价。`;
    cycleAdvice = `猪价 ¥${hogPrice.toFixed(2)}/kg 与猪粮比 ${ratio.toFixed(2)}:1 处平衡带，维持 ${positionPlan.totalCoreShares.toLocaleString()} 股底仓。`;
    swingAdvice = `当前持仓 ${curShares.toLocaleString()} 股：${nextSellDesc}；${nextBuyDesc}；利润池余额 ¥${positionPlan.profitPool.toFixed(2)} 留待第一买点加码。`;
  } else if (totalScore >= 30) {
    action = "reduce";
    actionLabel = "高景气期 · 逢高分批兑现";
    actionTone = "caution";
    summary = `养殖进入高景气盈利与扩繁期（评分 ${totalScore}/100），远期供给隐患显现，买点大幅后撤至强支撑，底仓趁上涨分批降至 ~5,000 股。`;
    cycleAdvice = `高猪价刺激补栏扩繁，周期顶部渐显，在价格高于摊薄成本（${dilutedCostText}）的上涨日将底仓分批降至 5,000 股左右（每周最多减 2,500 股）。`;
    swingAdvice = `逢反弹减仓优先：${nextSellDesc}；买点后撤至 ${nextBuyDesc}。`;
  } else {
    action = "wait";
    actionLabel = "顶部过剩 · 暂停买降底仓";
    actionTone = "critical";
    summary = `基础产能过剩或处周期顶部（评分 ${totalScore}/100），停止常规买入，底仓趁上涨分批降至 0～1,500 股。`;
    cycleAdvice = `按预案在周期顶部/过剩区停止常规买入，并在高于摊薄成本（${dilutedCostText}）的上涨日分批将底仓降至 0～1,500 股（每周最多卖 2,500 股）。`;
    swingAdvice = `当前停止新增买单，仅执行上方止盈卖单（${nextSellDesc}），留足现金等待下一轮周期去产能。`;
  }

  const buyTriggers = [
    buy1Pt?.triggerPrice
      ? `第一买点（回踩支撑）：跌至 ¥${buy1Pt.triggerPrice.toFixed(3)} 买入 ${buy1Pt.shares?.toLocaleString()}股（需 ¥${buy1Pt.cashAmount?.toLocaleString()} · ${buy1Pt.technicalAnchor}；执行后成本 ¥${buy1Pt.projectedDilutedCost?.toFixed(4)}）`
      : `第一买点：${buy1Pt?.disabledReason ?? "周期顶部暂停常规买入"}`,
    buy2Pt?.triggerPrice
      ? `第二买点（大跌强支撑）：急跌至 ¥${buy2Pt.triggerPrice.toFixed(3)} 加码 ${buy2Pt.shares?.toLocaleString()}股（${buy2Pt.technicalAnchor}），后续反弹卖半留半（+${buy2Pt.retainShares.toLocaleString()}股转底仓）`
      : `第二买点：${buy2Pt?.disabledReason ?? "暂停大跌加码"}`,
    `差价利润复投：利润池余额 ¥${positionPlan.profitPool.toFixed(2)}，满 100 股（约 ¥${positionPlan.lotCost100.toFixed(0)}）在第一买点顺便多买并永久转入底仓`,
  ];

  const sellTriggers = [
    sell1Pt?.triggerPrice
      ? `第一卖点（近期压力做T）：涨至 ¥${sell1Pt.triggerPrice.toFixed(3)} 卖出 ${sell1Pt.shares?.toLocaleString()}股（${sell1Pt.technicalAnchor}），净赚约 ¥${sell1Pt.estimatedNetProfit?.toFixed(1)} 入池，剩余成本降至 ¥${sell1Pt.projectedDilutedCost?.toFixed(4)}`
      : `第一卖点：${sell1Pt?.disabledReason ?? "仅剩核心底仓锁仓待涨"}`,
    sell2Pt?.triggerPrice
      ? `第二卖点（脉冲冲高止盈）：冲至 ¥${sell2Pt.triggerPrice.toFixed(3)} 再卖 ${sell2Pt.shares?.toLocaleString()}股（${sell2Pt.technicalAnchor}），净赚约 ¥${sell2Pt.estimatedNetProfit?.toFixed(1)}`
      : `第二卖点：${sell2Pt?.disabledReason ?? "保留底仓吃周期主升浪"}`,
    `周期顶部减底仓：仅当猪价 >¥16/kg、评分 <30 进入顶部区且高于摊薄成本（${dilutedCostText}）时，趁上涨分批将底仓降至 0～1,500 股`,
  ];

  return {
    symbol: "etf_516670",
    action,
    actionLabel,
    actionTone,
    score: totalScore,
    positionHint,
    pricePercentile,
    rangeLow,
    rangeHigh,
    ma20,
    ma20Diff,
    swingSignal,
    summary,
    cycleAdvice,
    swingAdvice,
    buyTriggers,
    sellTriggers,
    factors: [capFactor, cushionFactor, catalystFactor, techFactor],
    positionPlan,
  };
}

/** Unified benchmark & cost/FX/capacity anchor evaluation for all aviation industry indicators. */
export function computeAviationBenchmark(q: MarketQuote, allQuotes: MarketQuote[]): PorkQuoteBenchmark {
  const getQ = (sym: string) => allQuotes.find((item) => item.symbol === sym);
  const cea = getQ("cea_600115");

  switch (q.symbol) {
    case "ine_crude": {
      const comfort = AVIATION_THRESHOLDS.crudeComfortPerBbl;
      const diffPct = ((q.price - comfort) / comfort) * 100;
      const signPct = `${diffPct >= 0 ? "+" : ""}${diffPct.toFixed(1)}%`;
      // 国内燃油附加费估算指示
      const surchargeHint = q.price >= AVIATION_THRESHOLDS.crudeCriticalPerBbl
        ? "800km以上约 ¥70~90"
        : q.price >= AVIATION_THRESHOLDS.crudeWarningPerBbl
          ? "800km以上约 ¥40~60"
          : "燃油附加低位";
      if (q.price >= AVIATION_THRESHOLDS.crudeCriticalPerBbl) {
        return {
          anchorText: `较舒适线(¥${comfort}) ${signPct}`,
          anchorSub: `航油占成本~35% · ${surchargeHint}`,
          referenceLine: AVIATION_THRESHOLDS.crudeWarningPerBbl,
          statusBadge: "高油价挤压",
          statusTone: "critical",
          statusDesc: `内盘原油突破¥${AVIATION_THRESHOLDS.crudeCriticalPerBbl}/桶高压线，航油出厂价高企挤压航司毛利`,
        };
      }
      if (q.price >= AVIATION_THRESHOLDS.crudeWarningPerBbl) {
        return {
          anchorText: `较舒适线(¥${comfort}) ${signPct}`,
          anchorSub: `警戒线 ¥${AVIATION_THRESHOLDS.crudeWarningPerBbl}/桶 · ${surchargeHint}`,
          referenceLine: AVIATION_THRESHOLDS.crudeWarningPerBbl,
          statusBadge: "航油成本偏高",
          statusTone: "caution",
          statusDesc: "原油处于¥620~680/桶偏高区间，需靠燃油附加费与高客座率对冲",
        };
      }
      if (q.price <= comfort) {
        return {
          anchorText: `较舒适线(¥${comfort}) ${signPct}`,
          anchorSub: `低油价红利区 · ${surchargeHint}`,
          referenceLine: comfort,
          statusBadge: "航油成本红利",
          statusTone: "positive",
          statusDesc: "原油低于¥520/桶舒适线，航司航油成本显著让利释放业绩弹性",
        };
      }
      return {
        anchorText: `较舒适线(¥${comfort}) ${signPct}`,
        anchorSub: `温和区间 ¥520~620 · ${surchargeHint}`,
        referenceLine: comfort,
        statusBadge: "成本运行温和",
        statusTone: "neutral",
        statusDesc: "内盘原油处于航司可顺价承受的温和区间",
      };
    }

    case "fuel_futures": {
      const normal = AVIATION_THRESHOLDS.fuelNormalPerTon;
      const diffPct = ((q.price - normal) / normal) * 100;
      const signPct = `${diffPct >= 0 ? "+" : ""}${diffPct.toFixed(1)}%`;
      const perKg = q.cnyPrice ?? q.price / 1000;
      if (q.price >= AVIATION_THRESHOLDS.fuelHighPerTon) {
        return {
          anchorText: `较中枢(¥${normal}) ${signPct}`,
          anchorSub: `折 ¥${perKg.toFixed(2)}/kg · 裂解偏强`,
          referenceLine: normal,
          statusBadge: "炼化成本偏高",
          statusTone: "caution",
          statusDesc: "低硫燃料油高于¥4200/吨，亚太成品油与航油裂解价差偏强",
        };
      }
      if (q.price < normal * 0.92) {
        return {
          anchorText: `较中枢(¥${normal}) ${signPct}`,
          anchorSub: `折 ¥${perKg.toFixed(2)}/kg · 成本让利`,
          referenceLine: normal,
          statusBadge: "能源成本回落",
          statusTone: "positive",
          statusDesc: "燃料油价格回落，缓解亚太航油炼化与地面保障能源支出",
        };
      }
      return {
        anchorText: `较中枢(¥${normal}) ${signPct}`,
        anchorSub: `折 ¥${perKg.toFixed(2)}/kg · 裂解平稳`,
        referenceLine: normal,
        statusBadge: "裂解价差平稳",
        statusTone: "neutral",
        statusDesc: "燃料油围绕中枢震荡，成品油裂解价差运行平稳",
      };
    }

    case "fx_usdcny": {
      const comfort = AVIATION_THRESHOLDS.fxAppreciationFloor;
      const ch1m = q.change1m ?? q.change1w ?? 0;
      const ch1mPct = `${ch1m >= 0 ? "+" : ""}${(ch1m * 100).toFixed(2)}%`;
      if (q.price <= comfort) {
        return {
          anchorText: `低于 ${comfort.toFixed(2)} (升值红利区)`,
          anchorSub: `近30日 ${ch1mPct} · 增厚汇兑收益`,
          referenceLine: comfort,
          statusBadge: "汇兑收益红利",
          statusTone: "positive",
          statusDesc: "人民币处于6.85以内强势区间，显著降低美元机队租赁负债并提振出境游",
        };
      }
      if (q.price <= AVIATION_THRESHOLDS.fxNeutralCeil) {
        return {
          anchorText: `6.85~7.15 (汇率中性区)`,
          anchorSub: `近30日 ${ch1mPct} · 汇兑影响温和`,
          referenceLine: 7.0,
          statusBadge: "汇率双向平衡",
          statusTone: "neutral",
          statusDesc: "美元兑人民币处于中性区间，航司外币负债汇兑损益相对可控",
        };
      }
      return {
        anchorText: `破 ${AVIATION_THRESHOLDS.fxNeutralCeil} (贬值承压)`,
        anchorSub: `近30日 ${ch1mPct} · 外币负债承压`,
        referenceLine: AVIATION_THRESHOLDS.fxNeutralCeil,
        statusBadge: "汇兑成本承压",
        statusTone: "caution",
        statusDesc: "人民币贬值推升美元租赁负债账面汇兑损失与境外航油结算成本",
      };
    }

    case "sh_airport": {
      const pivot = AVIATION_THRESHOLDS.shAirportPivotPrice;
      const diffPct = ((q.price - pivot) / pivot) * 100;
      const ch1m = q.change1m ?? 0;
      return {
        anchorText: `浦东+虹桥双枢纽锚点`,
        anchorSub: `较基准(¥${pivot.toFixed(0)}) ${diffPct >= 0 ? "+" : ""}${diffPct.toFixed(1)}%`,
        referenceLine: pivot,
        statusBadge: ch1m >= 0.02 ? "基地客流走强" : ch1m <= -0.04 ? "枢纽估值筑底" : "基地流量稳健",
        statusTone: ch1m >= 0.02 ? "positive" : ch1m <= -0.04 ? "caution" : "neutral",
        statusDesc: "上海浦东与虹桥国际客流直接决定东航宽体机利用率与国际线票价",
      };
    }

    case "air_china":
    case "csa_600029":
    case "spring_air": {
      const ceaPrice = cea?.price ?? 3.43;
      const ratio = q.price / (ceaPrice || 1);
      const ceaCh1m = cea?.change1m ?? 0;
      const selfCh1m = q.change1m ?? 0;
      const relDiffPct = (ceaCh1m - selfCh1m) * 100;
      const roleLabel =
        q.symbol === "air_china"
          ? "首都欧美干线标杆"
          : q.symbol === "csa_600029"
            ? "广深国内干线标杆"
            : "低成本高客座标杆";
      return {
        anchorText: `${roleLabel} (比价 ${ratio.toFixed(2)}x)`,
        anchorSub: `东航近月相对表现 ${relDiffPct >= 0 ? "+" : ""}${relDiffPct.toFixed(1)}%`,
        statusBadge: selfCh1m >= 0.02 ? "同业共振向上" : selfCh1m <= -0.04 ? "板块估值磨底" : "同业比价均衡",
        statusTone: selfCh1m >= 0.02 ? "accent" : selfCh1m <= -0.04 ? "caution" : "neutral",
        statusDesc: `${q.name}与东航同受油汇双因子驱动，反映航司板块整体估值水位`,
      };
    }

    case "cea_hk00670": {
      const ceaPrice = cea?.price ?? 3.43;
      const fxRate = getQ("fx_usdcny")?.price ?? 6.85;
      // 1 USD ≈ 7.80 HKD -> HKD/CNY ≈ fxRate / 7.80
      const hkdCny = fxRate / 7.80;
      const hkCnyPrice = q.price * hkdCny;
      const ahRatio = hkCnyPrice > 0 ? ceaPrice / hkCnyPrice : 1.8;
      const ahPremiumPct = (ahRatio - 1) * 100;
      const selfCh1m = q.change1m ?? 0;
      const ceaCh1m = cea?.change1m ?? 0;
      const hVsA1mPct = (selfCh1m - ceaCh1m) * 100;
      return {
        anchorText: `A/H比价 ${ahRatio.toFixed(2)}x (溢价+${ahPremiumPct.toFixed(0)}%)`,
        anchorSub: `折人民币 ¥${hkCnyPrice.toFixed(2)} · 较A股近月 ${hVsA1mPct >= 0 ? "+" : ""}${hVsA1mPct.toFixed(1)}%`,
        referenceLine: Number((ceaPrice / 1.75 / hkdCny).toFixed(2)),
        statusBadge: hVsA1mPct >= 2.0 ? "外资抢筹领涨" : ahRatio >= 2.05 ? "A股溢价偏高" : "AH比价均衡",
        statusTone: hVsA1mPct >= 2.0 ? "accent" : ahRatio >= 2.05 ? "caution" : "positive",
        statusDesc: `东航H股折合人民币 ¥${hkCnyPrice.toFixed(2)}/股，离岸外资定价与A/H溢价率(${ahPremiumPct.toFixed(0)}%)提供估值安全锚`,
      };
    }

    case "caac_load_factor": {
      const breakeven = AVIATION_THRESHOLDS.loadFactorBreakevenPct;
      const highLine = AVIATION_THRESHOLDS.loadFactorHighPct;
      const diff = q.price - breakeven;
      if (q.price >= highLine) {
        return {
          anchorText: `超保本线(${breakeven.toFixed(0)}%) +${diff.toFixed(1)}pct`,
          anchorSub: `突破 ${highLine.toFixed(0)}% 高景气提价线`,
          referenceLine: breakeven,
          statusBadge: "高客座高景气",
          statusTone: "positive",
          statusDesc: "民航正班客座率站上83%高景气线，运力供需偏紧支撑经济舱全价票弹性",
        };
      }
      if (q.price >= breakeven) {
        return {
          anchorText: `高于保本线(${breakeven.toFixed(0)}%) +${diff.toFixed(1)}pct`,
          anchorSub: `距高景气线(${highLine.toFixed(0)}%) 差 ${(highLine - q.price).toFixed(1)}pct`,
          referenceLine: breakeven,
          statusBadge: "客运供需平衡",
          statusTone: "neutral",
          statusDesc: "客座率位于78%~83%盈利平衡带，公商务与旅游出行需求稳健",
        };
      }
      return {
        anchorText: `低于保本线(${breakeven.toFixed(0)}%) ${diff.toFixed(1)}pct`,
        anchorSub: "运力消化承压",
        referenceLine: breakeven,
        statusBadge: "客座率偏弱",
        statusTone: "caution",
        statusDesc: "行业正班客座率低于78%保本线，淡季票价折扣承压",
      };
    }

    case "cea_600115": {
      const g = computeCea600115Guidance(allQuotes);
      const diffSign = `${g.ma20Diff >= 0 ? "+" : ""}${(g.ma20Diff * 100).toFixed(2)}%`;
      return {
        anchorText: `MA20 ¥${g.ma20.toFixed(2)} (${diffSign})`,
        anchorSub: `近期分位 ${g.pricePercentile.toFixed(1)}% · 综合评分 ${g.score}/100`,
        referenceLine: g.ma20,
        statusBadge: g.actionLabel,
        statusTone: g.actionTone,
        statusDesc: g.swingAdvice,
      };
    }

    default:
      return {
        anchorText: "行业参考指标",
        statusBadge: "常态监测",
        statusTone: "neutral",
        statusDesc: q.note ?? "",
      };
  }
}

/**
 * Multi-factor cycle & technical swing guidance engine for China Eastern Airlines (中国东航 600115).
 * Combines 80% aviation fundamentals (30% jet fuel cost elasticity, 25% RMB FX dividend,
 * 25% load factor & Shanghai hub prosperity) with 20% technical wave indicators (MA20 & 90d percentile).
 */
export function computeCea600115Guidance(
  quotes: ReadonlyArray<Pick<MarketQuote, "symbol" | "price"> & Partial<MarketQuote>>,
): Etf516670Guidance {
  const getQ = (sym: string) => quotes.find((q) => q.symbol === sym);

  const crudeQ = getQ("ine_crude");
  const fuelQ = getQ("fuel_futures");
  const fxQ = getQ("fx_usdcny");
  const airportQ = getQ("sh_airport");
  const caacQ = getQ("caac_load_factor");
  const airChinaQ = getQ("air_china");
  const csaQ = getQ("csa_600029");
  const ceaQ = getQ("cea_600115");

  const crudePrice = crudeQ?.price ?? 698.2;
  const fuelPrice = fuelQ?.price ?? 4305;
  const fxRate = fxQ?.price ?? 6.672;
  const loadFactor = caacQ?.price ?? 85.6;

  // --- CEA 600115 Technical Metrics ---
  const ceaPrice = ceaQ?.price ?? 3.43;
  const closes = ceaQ?.series && ceaQ.series.length > 0
    ? ceaQ.series.map((p) => p.close)
    : [ceaPrice];
  const rangeLow = Number(Math.min(...closes).toFixed(2));
  const rangeHigh = Number(Math.max(...closes).toFixed(2));
  const span = rangeHigh - rangeLow;
  const pricePercentile = span > 1e-6
    ? Number(Math.min(100, Math.max(0, ((ceaPrice - rangeLow) / span) * 100)).toFixed(1))
    : 50.0;

  const ma20Slice = closes.slice(-20);
  const ma20 = Number((ma20Slice.reduce((sum, v) => sum + v, 0) / ma20Slice.length).toFixed(2));
  const ma20Diff = ma20 > 0 ? Number((ceaPrice / ma20 - 1).toFixed(4)) : 0;
  const ma20DiffPctText = `${ma20Diff >= 0 ? "+" : ""}${(ma20Diff * 100).toFixed(2)}%`;

  // --- Factor 1: Jet Fuel Cost Elasticity (Max 30 pts) ---
  let crudePts = 10;
  if (crudePrice <= AVIATION_THRESHOLDS.crudeComfortPerBbl) crudePts = 22;
  else if (crudePrice <= 580) crudePts = 17;
  else if (crudePrice <= AVIATION_THRESHOLDS.crudeWarningPerBbl) crudePts = 13;
  else if (crudePrice <= AVIATION_THRESHOLDS.crudeCriticalPerBbl) crudePts = 9;
  else crudePts = 5;

  const crudeCh1m = crudeQ?.change1m ?? crudeQ?.change1w ?? 0;
  let fuelTrendPts = 5;
  if (crudeCh1m <= -0.04) fuelTrendPts = 8;
  else if (crudeCh1m <= 0.02) fuelTrendPts = 6;
  else if (crudeCh1m <= 0.08) fuelTrendPts = 4;
  else fuelTrendPts = 2;

  const fuelScore = crudePts + fuelTrendPts; // 0 ~ 30
  const fuelFactor: EtfFactorSignal = {
    name: "航油成本弹性",
    score: fuelScore,
    maxScore: 30,
    badge: fuelScore >= 21 ? "低油价让利·看多" : fuelScore >= 14 ? "油价温和·顺价" : "高油价挤压毛利",
    tone: fuelScore >= 21 ? "positive" : fuelScore >= 14 ? "neutral" : "caution",
    detail: `上期原油 ¥${crudePrice.toFixed(1)}/桶 (近月${crudeCh1m >= 0 ? "+" : ""}${(crudeCh1m * 100).toFixed(1)}%)，低硫燃料油 ¥${fuelPrice.toFixed(0)}/吨`,
  };

  // --- Factor 2: RMB FX & Debt Dividend (Max 25 pts) ---
  let fxLevelPts = 12;
  if (fxRate <= 6.75) fxLevelPts = 19;
  else if (fxRate <= AVIATION_THRESHOLDS.fxAppreciationFloor) fxLevelPts = 16;
  else if (fxRate <= 7.0) fxLevelPts = 13;
  else if (fxRate <= AVIATION_THRESHOLDS.fxNeutralCeil) fxLevelPts = 9;
  else fxLevelPts = 4;

  const fxCh1m = fxQ?.change1m ?? fxQ?.change1w ?? 0;
  let fxTrendPts = 4;
  if (fxCh1m <= -0.008) fxTrendPts = 6; // USD/CNY down = RMB appreciation
  else if (fxCh1m <= 0.005) fxTrendPts = 5;
  else fxTrendPts = 2;

  const fxScore = fxLevelPts + fxTrendPts; // 0 ~ 25
  const fxFactor: EtfFactorSignal = {
    name: "汇率与汇兑红利",
    score: fxScore,
    maxScore: 25,
    badge: fxScore >= 19 ? "人民币强势·利好" : fxScore >= 13 ? "汇率中性平衡" : "汇率贬值承压",
    tone: fxScore >= 19 ? "positive" : fxScore >= 13 ? "neutral" : "caution",
    detail: `USD/CNY ${fxRate.toFixed(4)} (近30日 ${fxCh1m >= 0 ? "+" : ""}${(fxCh1m * 100).toFixed(2)}%)，直接减轻美元租赁负债`,
  };

  // --- Factor 3: Load Factor & Shanghai Hub Prosperity (Max 25 pts) ---
  let lfPts = 10;
  if (loadFactor >= 85.0) lfPts = 16;
  else if (loadFactor >= AVIATION_THRESHOLDS.loadFactorHighPct) lfPts = 14;
  else if (loadFactor >= AVIATION_THRESHOLDS.loadFactorBreakevenPct) lfPts = 10;
  else lfPts = 5;

  const peerCh1w = ((airportQ?.change1w ?? 0) + (airChinaQ?.change1w ?? 0) + (csaQ?.change1w ?? 0)) / 3;
  let hubPts = 6;
  if (peerCh1w >= 0.01) hubPts = 9;
  else if (peerCh1w >= -0.02) hubPts = 7;
  else hubPts = 5;

  const demandScore = lfPts + hubPts; // 0 ~ 25
  const demandFactor: EtfFactorSignal = {
    name: "客座与枢纽景气",
    score: demandScore,
    maxScore: 25,
    badge: demandScore >= 19 ? "高客座·基地高景气" : demandScore >= 14 ? "客流稳健复苏" : "淡季需求偏弱",
    tone: demandScore >= 19 ? "accent" : demandScore >= 14 ? "positive" : "caution",
    detail: `民航正班客座率 ${loadFactor.toFixed(1)}% (保本线78%)，上海机场 ¥${(airportQ?.price ?? 24.75).toFixed(2)}/股`,
  };

  // --- Factor 4: CEA 600115 Technical Wave Position (Max 20 pts) ---
  let pctPts = 8;
  if (pricePercentile <= 25) pctPts = 12;
  else if (pricePercentile <= 50) pctPts = 10;
  else if (pricePercentile <= 70) pctPts = 8;
  else if (pricePercentile <= 85) pctPts = 5;
  else pctPts = 2;

  let maPts = 6;
  let swingSignal = "均线附近窄幅整理";
  if (ma20Diff >= 0 && ma20Diff <= 0.04) {
    maPts = 8;
    swingSignal = "站稳MA20 · 右侧多头健康";
  } else if (ma20Diff >= -0.035 && ma20Diff < 0) {
    maPts = 7;
    swingSignal = "回踩MA20支撑 · 波段低吸区";
  } else if (ma20Diff < -0.06) {
    maPts = 6;
    swingSignal = "偏离MA20超跌 · 左侧网格区";
  } else if (ma20Diff < -0.035) {
    maPts = 5;
    swingSignal = "MA20下方缩量寻底";
  } else if (ma20Diff <= 0.07) {
    maPts = 5;
    swingSignal = "偏离MA20偏高 · 忌追涨";
  } else {
    maPts = 2;
    swingSignal = "短线乖离过大 · 警惕回吐";
  }

  const techScore = pctPts + maPts; // 0 ~ 20
  const techFactor: EtfFactorSignal = {
    name: "东航技术波段",
    score: techScore,
    maxScore: 20,
    badge: swingSignal.split(" · ")[0] ?? swingSignal,
    tone: techScore >= 15 ? "accent" : techScore >= 11 ? "neutral" : "caution",
    detail: `现价 ¥${ceaPrice.toFixed(2)}，MA20 ¥${ma20.toFixed(2)} (${ma20DiffPctText})，近期分位 ${pricePercentile.toFixed(1)}%`,
  };

  const totalScore = fuelScore + fxScore + demandScore + techScore; // 0 ~ 100

  const positionPlan = compute600115PositionPlan(ceaQ, totalScore, quotes);
  const buy1Pt = positionPlan.actionPoints?.find((p) => p.kind === "buy1");
  const buy2Pt = positionPlan.actionPoints?.find((p) => p.kind === "buy2");
  const sell1Pt = positionPlan.actionPoints?.find((p) => p.kind === "sell1");
  const sell2Pt = positionPlan.actionPoints?.find((p) => p.kind === "sell2");
  const curShares = positionPlan.latestSnapshot.shares ?? 3000;
  const dilutedCost = positionPlan.latestSnapshot.dilutedCost ?? 3.335;
  const dilutedCostText = `¥${dilutedCost.toFixed(3)}`;

  let action: EtfActionRating = "hold";
  let actionLabel = "底仓持有 · 油汇联动做T";
  let actionTone: PorkStatusTone = "neutral";
  const positionHint = `底仓 ${positionPlan.totalCoreShares.toLocaleString()}股 · 持仓 ${curShares.toLocaleString()}股 · 成本 ${dilutedCostText}`;
  let summary = "";
  let cycleAdvice = "";
  let swingAdvice = "";

  const nextSellDesc = sell1Pt?.triggerPrice
    ? `第一卖点 ¥${sell1Pt.triggerPrice.toFixed(2)} 卖 ${sell1Pt.shares?.toLocaleString()}股（${sell1Pt.technicalAnchor}）`
    : sell1Pt?.disabledReason ?? "仅剩底仓锁仓待涨";
  const nextBuyDesc = buy1Pt?.triggerPrice
    ? `第一买点 ¥${buy1Pt.triggerPrice.toFixed(2)} 买 ${buy1Pt.shares?.toLocaleString()}股（${buy1Pt.technicalAnchor}）`
    : buy1Pt?.disabledReason ?? "已达 7,600 股上限暂停买入";

  if (totalScore >= 64) {
    action = ma20Diff >= 0 ? "buy_right" : "accumulate";
    actionLabel = "景气顺风 · 支撑压力降本";
    actionTone = ma20Diff >= 0 ? "accent" : "positive";
    summary = `高客座率（${loadFactor.toFixed(1)}%）与人民币汇率（${fxRate.toFixed(2)}）对冲油价，东航报 ¥${ceaPrice.toFixed(2)}（摊薄成本 ${dilutedCostText}），维持 ${positionPlan.totalCoreShares.toLocaleString()} 股底仓，结合油汇与近期高低点动态降本。`;
    cycleAdvice = `民航客座率达 ${loadFactor.toFixed(1)}% 高景气区，锁死 ${positionPlan.totalCoreShares.toLocaleString()} 股底仓不动（最高买至 ${(7600 + positionPlan.bonusCoreShares).toLocaleString()} 股封顶），单票不追高扩量。`;
    swingAdvice = `无免五佣金（来回约11元），单次固定 400 股：${nextSellDesc}；${nextBuyDesc}。`;
  } else if (totalScore >= 48) {
    action = "hold";
    actionLabel = "平衡震荡 · 油汇联动做T";
    actionTone = "neutral";
    summary = `汇率与客座率偏多但原油 ¥${crudePrice.toFixed(0)}/桶压制成本（评分 ${totalScore}/100），东航报 ¥${ceaPrice.toFixed(2)}，围绕 MA20 与近期高低点做 400 股波段压低摊薄成本。`;
    cycleAdvice = `高客座率与汇兑收益托底业绩，维持 ${positionPlan.totalCoreShares.toLocaleString()} 股核心底仓，差价净利入池攒满 100 股（约 ¥${positionPlan.lotCost100.toFixed(0)}）在第一买点加码转底仓。`;
    swingAdvice = `当前持仓 ${curShares.toLocaleString()} 股：${nextSellDesc}；${nextBuyDesc}；第二买点（前低强支撑 ¥${(buy2Pt?.triggerPrice ?? 3.15).toFixed(2)}）反弹卖半留半。`;
  } else {
    action = "reduce";
    actionLabel = "油汇逆风 · 退守强支撑";
    actionTone = "caution";
    summary = `油汇成本端承压（评分 ${totalScore}/100），第一买点自动下撤至近20日/60日前低强支撑位防守，反弹优先减仓收现。`;
    cycleAdvice = `航油或汇率处于逆风期，不在浅层均线接盘，但下跌途中绝不因技术破位止损底仓（仅在高于成本+手续费的反弹位兑现机动仓）。`;
    swingAdvice = `优先执行上方压力位卖单（${nextSellDesc}），买点后撤至 ${nextBuyDesc}。`;
  }

  const buyTriggers = [
    buy1Pt?.triggerPrice
      ? `第一买点（油汇联动支撑）：跌至 ¥${buy1Pt.triggerPrice.toFixed(2)} 买入 ${buy1Pt.shares?.toLocaleString()}股（需 ¥${buy1Pt.cashAmount?.toLocaleString()} · ${buy1Pt.technicalAnchor}，覆盖无免五最低5元佣金）`
      : `第一买点：${buy1Pt?.disabledReason ?? "已达持仓上限停止买入"}`,
    buy2Pt?.triggerPrice
      ? `第二买点（前低深跌加码）：急跌至 ¥${buy2Pt.triggerPrice.toFixed(2)} 买入 ${buy2Pt.shares?.toLocaleString()}股（${buy2Pt.technicalAnchor}），反弹卖半留半（+${buy2Pt.retainShares.toLocaleString()}股转底仓）`
      : `第二买点：${buy2Pt?.disabledReason ?? "已达总股数上限"}`,
    `差价利润复投：利润池当前余额 ¥${positionPlan.profitPool.toFixed(2)}，满 100 股（约 ¥${positionPlan.lotCost100.toFixed(0)}）在第一买点顺便多买转底仓`,
  ];

  const sellTriggers = [
    sell1Pt?.triggerPrice
      ? `第一卖点（近期压力做T）：涨至 ¥${sell1Pt.triggerPrice.toFixed(2)} 卖出 ${sell1Pt.shares?.toLocaleString()}股（${sell1Pt.technicalAnchor}），扣除约11元费用后净赚约 ¥${sell1Pt.estimatedNetProfit?.toFixed(0)} 入池，成本降至 ¥${sell1Pt.projectedDilutedCost?.toFixed(3)}`
      : `第一卖点：${sell1Pt?.disabledReason ?? "仅剩底仓锁仓待涨"}`,
    sell2Pt?.triggerPrice
      ? `第二卖点（波段强阻力位）：冲至 ¥${sell2Pt.triggerPrice.toFixed(2)} 再卖 ${sell2Pt.shares?.toLocaleString()}股（${sell2Pt.technicalAnchor}），净赚约 ¥${sell2Pt.estimatedNetProfit?.toFixed(0)}`
      : `第二卖点：${sell2Pt?.disabledReason ?? "保留 2,200 股核心底仓"}`,
    `长线铁律防守：底仓不设技术破位止损（单日跌>4%或5日跌>10%只放慢买入）；油汇逆风时买点自动下撤至前低强支撑`,
  ];

  return {
    symbol: "cea_600115",
    action,
    actionLabel,
    actionTone,
    score: totalScore,
    positionHint,
    pricePercentile,
    rangeLow,
    rangeHigh,
    ma20,
    ma20Diff,
    swingSignal,
    summary,
    cycleAdvice,
    swingAdvice,
    buyTriggers,
    sellTriggers,
    factors: [fuelFactor, fxFactor, demandFactor, techFactor],
    positionPlan,
  };
}

/** Unified benchmark & valuation/FX/constituent anchor evaluation for all Hang Seng Tech indicators. */
export function computeHstechBenchmark(q: MarketQuote, allQuotes: MarketQuote[]): PorkQuoteBenchmark {
  const getQ = (sym: string) => allQuotes.find((item) => item.symbol === sym);
  const idxQ = getQ("hstech_index");

  switch (q.symbol) {
    case "hstech_index": {
      const pivot = HSTECH_THRESHOLDS.indexPivot;
      const diffPct = ((q.price - pivot) / pivot) * 100;
      const signPct = `${diffPct >= 0 ? "+" : ""}${diffPct.toFixed(1)}%`;
      if (q.price <= HSTECH_THRESHOLDS.indexDeepValue) {
        return {
          anchorText: `较中枢(${pivot}) ${signPct}`,
          anchorSub: `低于 ${HSTECH_THRESHOLDS.indexDeepValue} 深度价值区`,
          referenceLine: pivot,
          statusBadge: "估值深度折价",
          statusTone: "positive",
          statusDesc: "恒生科技指数处于深度低估区间，龙头回购收益率与安全边际突出",
        };
      }
      if (q.price <= pivot) {
        return {
          anchorText: `较中枢(${pivot}) ${signPct}`,
          anchorSub: `估值修复区间 3600~4000`,
          referenceLine: pivot,
          statusBadge: "低估修复区",
          statusTone: "positive",
          statusDesc: "指数位于4000点估值中枢下方，具备中线估值修复空间",
        };
      }
      if (q.price <= HSTECH_THRESHOLDS.indexOverheat) {
        return {
          anchorText: `较中枢(${pivot}) ${signPct}`,
          anchorSub: `站上 ${pivot} 中枢均衡区`,
          referenceLine: pivot,
          statusBadge: "估值中枢均衡",
          statusTone: "accent",
          statusDesc: "指数运行于4000~4700点合理区间，受龙头季报盈利驱动",
        };
      }
      return {
        anchorText: `较中枢(${pivot}) ${signPct}`,
        anchorSub: `突破 ${HSTECH_THRESHOLDS.indexOverheat} 高热度区`,
        referenceLine: HSTECH_THRESHOLDS.indexOverheat,
        statusBadge: "情绪过热预警",
        statusTone: "caution",
        statusDesc: "短期涨幅较大进入情绪高涨区，警惕外资获利盘波动",
      };
    }

    case "hstech_fx": {
      const floor = HSTECH_THRESHOLDS.fxInflowFloor;
      const ch1m = q.change1m ?? q.change1w ?? 0;
      const ch1mPct = `${ch1m >= 0 ? "+" : ""}${(ch1m * 100).toFixed(2)}%`;
      if (q.price <= floor) {
        return {
          anchorText: `低于 ${floor.toFixed(2)} (外资回流区)`,
          anchorSub: `近30日 ${ch1mPct} · 增厚港股EPS`,
          referenceLine: floor,
          statusBadge: "流动性顺风",
          statusTone: "positive",
          statusDesc: "人民币偏强提升港股科技人民币资产折算港元估值，吸引外资回流",
        };
      }
      if (q.price <= HSTECH_THRESHOLDS.fxPressureCeil) {
        return {
          anchorText: `6.85~7.15 (汇率均衡带)`,
          anchorSub: `近30日 ${ch1mPct} · 南向资金主导`,
          referenceLine: 7.0,
          statusBadge: "流动性中性",
          statusTone: "neutral",
          statusDesc: "汇率处于中性区间，港股科技定价主要由南向港股通资金与盈利主导",
        };
      }
      return {
        anchorText: `破 ${HSTECH_THRESHOLDS.fxPressureCeil} (离岸承压)`,
        anchorSub: `近30日 ${ch1mPct} · 压制外资风险偏好`,
        referenceLine: HSTECH_THRESHOLDS.fxPressureCeil,
        statusBadge: "离岸流动性承压",
        statusTone: "caution",
        statusDesc: "人民币贬值压制离岸中资股估值折算与海外基金配置意愿",
      };
    }

    case "hk_00700":
    case "hk_09988":
    case "hk_03690":
    case "hk_09618":
    case "hk_01810":
    case "hk_01024":
    case "hk_00981": {
      const pivotMap: Record<string, { pivot: number; weight: string }> = {
        hk_00700: { pivot: HSTECH_THRESHOLDS.tencentPivotHkd, weight: "第一权重 ~8% · 千亿回购锚" },
        hk_09988: { pivot: HSTECH_THRESHOLDS.alibabaPivotHkd, weight: "核心权重 ~8% · 阿里云+港股通" },
        hk_03690: { pivot: HSTECH_THRESHOLDS.meituanPivotHkd, weight: "核心权重 ~8% · 本地生活龙头" },
        hk_09618: { pivot: HSTECH_THRESHOLDS.jdPivotHkd, weight: "电商权重 · 高股息与以旧换新" },
        hk_01810: { pivot: HSTECH_THRESHOLDS.xiaomiPivotHkd, weight: "硬科技权重 ~8% · 车+AI端侧" },
        hk_01024: { pivot: 52, weight: "内容权重 · 可灵AI大模型+直播电商" },
        hk_00981: { pivot: HSTECH_THRESHOLDS.smicPivotHkd, weight: "半导体权重 · 算力晶圆国产替代" },
      };
      const meta = pivotMap[q.symbol] ?? { pivot: q.price, weight: "核心成分股" };
      const idxCh1m = idxQ?.change1m ?? 0;
      const selfCh1m = q.change1m ?? 0;
      const alphaPct = (selfCh1m - idxCh1m) * 100;
      const diffPivotPct = ((q.price - meta.pivot) / meta.pivot) * 100;

      return {
        anchorText: meta.weight,
        anchorSub: `较中枢(HK$${meta.pivot}) ${diffPivotPct >= 0 ? "+" : ""}${diffPivotPct.toFixed(1)}% · 近月超额 ${alphaPct >= 0 ? "+" : ""}${alphaPct.toFixed(1)}%`,
        referenceLine: meta.pivot,
        statusBadge: alphaPct >= 2.0 ? "领涨超额阿尔法" : alphaPct <= -2.0 ? "落后指数筑底" : "跟随指数共振",
        statusTone: alphaPct >= 2.0 ? "accent" : alphaPct <= -2.0 ? "caution" : "positive",
        statusDesc: `${q.name}近30日相对恒生科技指数超额收益 ${alphaPct >= 0 ? "+" : ""}${alphaPct.toFixed(1)}%`,
      };
    }

    case "etf_513180": {
      const g = computeEtf513180Guidance(allQuotes);
      const diffSign = `${g.ma20Diff >= 0 ? "+" : ""}${(g.ma20Diff * 100).toFixed(2)}%`;
      return {
        anchorText: `MA20 ¥${g.ma20.toFixed(3)} (${diffSign})`,
        anchorSub: `近期分位 ${g.pricePercentile.toFixed(1)}% · 综合评分 ${g.score}/100`,
        referenceLine: g.ma20,
        statusBadge: g.actionLabel,
        statusTone: g.actionTone,
        statusDesc: g.swingAdvice,
      };
    }

    default:
      return {
        anchorText: "行业参考指标",
        statusBadge: "常态监测",
        statusTone: "neutral",
        statusDesc: q.note ?? "",
      };
  }
}

/**
 * Multi-factor valuation & technical swing guidance engine for Hang Seng Tech ETF (恒生科技ETF 513180).
 * Combines 80% fundamental/macro valuation drivers (30% index valuation odds, 25% RMB FX liquidity,
 * 25% top 6 constituent breadth & momentum) with 20% ETF technical wave indicators (MA20 & 90d percentile).
 */
export function computeEtf513180Guidance(
  quotes: ReadonlyArray<Pick<MarketQuote, "symbol" | "price"> & Partial<MarketQuote>>,
): Etf516670Guidance {
  const getQ = (sym: string) => quotes.find((q) => q.symbol === sym);

  const idxQ = getQ("hstech_index");
  const fxQ = getQ("hstech_fx") ?? getQ("fx_usdcny");
  const tencentQ = getQ("hk_00700");
  const babaQ = getQ("hk_09988");
  const meituanQ = getQ("hk_03690");
  const jdQ = getQ("hk_09618");
  const xiaomiQ = getQ("hk_01810");
  const kuaishouQ = getQ("hk_01024");
  const smicQ = getQ("hk_00981");
  const etfQ = getQ("etf_513180");

  const idxPrice = idxQ?.price ?? 3867.73;
  const fxRate = fxQ?.price ?? 6.672;

  // --- ETF 513180 Technical Metrics ---
  const etfPrice = etfQ?.price ?? 0.481;
  const closes = etfQ?.series && etfQ.series.length > 0
    ? etfQ.series.map((p) => p.close)
    : [etfPrice];
  const rangeLow = Number(Math.min(...closes).toFixed(3));
  const rangeHigh = Number(Math.max(...closes).toFixed(3));
  const span = rangeHigh - rangeLow;
  const pricePercentile = span > 1e-6
    ? Number(Math.min(100, Math.max(0, ((etfPrice - rangeLow) / span) * 100)).toFixed(1))
    : 50.0;

  const ma20Slice = closes.slice(-20);
  const ma20 = Number((ma20Slice.reduce((sum, v) => sum + v, 0) / ma20Slice.length).toFixed(3));
  const ma20Diff = ma20 > 0 ? Number((etfPrice / ma20 - 1).toFixed(4)) : 0;
  const ma20DiffPctText = `${ma20Diff >= 0 ? "+" : ""}${(ma20Diff * 100).toFixed(2)}%`;

  // --- Factor 1: Index Valuation & Odds (Max 30 pts) ---
  let valPts = 18;
  if (idxPrice <= HSTECH_THRESHOLDS.indexDeepValue) valPts = 28;
  else if (idxPrice <= HSTECH_THRESHOLDS.indexPivot) valPts = 23;
  else if (idxPrice <= 5700) valPts = 18;
  else if (idxPrice <= HSTECH_THRESHOLDS.indexOverheat) valPts = 12;
  else valPts = 6;

  const valFactor: EtfFactorSignal = {
    name: "指数估值赔率",
    score: valPts,
    maxScore: 30,
    badge: valPts >= 22 ? "低估高赔率·看多" : valPts >= 15 ? "估值合理均衡" : "估值偏高·谨慎",
    tone: valPts >= 22 ? "positive" : valPts >= 15 ? "neutral" : "caution",
    detail: `恒生科技指数 ${idxPrice.toFixed(0)} 点（价值中枢 ${HSTECH_THRESHOLDS.indexPivot} 点），龙头大额回购提供底部支撑`,
  };

  // --- Factor 2: Offshore FX & Liquidity Environment (Max 25 pts) ---
  let fxPts = 14;
  if (fxRate <= 6.75) fxPts = 22;
  else if (fxRate <= HSTECH_THRESHOLDS.fxInflowFloor) fxPts = 19;
  else if (fxRate <= 7.05) fxPts = 14;
  else fxPts = 8;

  const fxCh1m = fxQ?.change1m ?? fxQ?.change1w ?? 0;
  if (fxCh1m <= -0.005) fxPts = Math.min(25, fxPts + 2);

  const fxFactor: EtfFactorSignal = {
    name: "离岸汇率流动性",
    score: fxPts,
    maxScore: 25,
    badge: fxPts >= 19 ? "人民币偏强·外资流入" : fxPts >= 13 ? "离岸流动性中性" : "汇率贬值承压",
    tone: fxPts >= 19 ? "positive" : fxPts >= 13 ? "neutral" : "caution",
    detail: `USD/CNY ${fxRate.toFixed(4)} (近月 ${fxCh1m >= 0 ? "+" : ""}${(fxCh1m * 100).toFixed(2)}%)，支撑港元计价中资科技股重估`,
  };

  // --- Factor 3: Core Constituent Breadth & Resonance (Max 25 pts) ---
  const coreStocks = [tencentQ, babaQ, meituanQ, jdQ, xiaomiQ, kuaishouQ, smicQ].filter((x): x is NonNullable<typeof x> => Boolean(x));
  const upCount1w = coreStocks.filter((s) => (s.change1w ?? s.changeYesterday ?? 0) >= 0).length;
  const avgCh1w = coreStocks.length > 0
    ? coreStocks.reduce((sum, s) => sum + (s.change1w ?? s.changeYesterday ?? 0), 0) / coreStocks.length
    : 0;

  let breadthPts = 15;
  if (upCount1w >= 5 || avgCh1w >= 0.025) breadthPts = 22;
  else if (upCount1w >= 3 || avgCh1w >= -0.01) breadthPts = 17;
  else if (avgCh1w <= -0.04) breadthPts = 14; // oversold rebound potential
  else breadthPts = 11;

  const breadthFactor: EtfFactorSignal = {
    name: "权重龙头共振",
    score: breadthPts,
    maxScore: 25,
    badge: breadthPts >= 20 ? "权重龙头共振走强" : breadthPts >= 15 ? "龙头分化轮动" : "权重缩量筑底",
    tone: breadthPts >= 20 ? "accent" : breadthPts >= 15 ? "neutral" : "caution",
    detail: `核心成分股近周 ${upCount1w}/${coreStocks.length || 6} 走强，均值变动 ${avgCh1w >= 0 ? "+" : ""}${(avgCh1w * 100).toFixed(1)}%`,
  };

  // --- Factor 4: ETF 513180 Technical Wave (Max 20 pts) ---
  let pctPts = 8;
  if (pricePercentile <= 25) pctPts = 12;
  else if (pricePercentile <= 55) pctPts = 10;
  else if (pricePercentile <= 75) pctPts = 8;
  else pctPts = 4;

  let maPts = 6;
  let swingSignal = "均线附近窄幅震荡";
  if (ma20Diff >= 0 && ma20Diff <= 0.04) {
    maPts = 8;
    swingSignal = "站稳MA20 · 右侧多头趋势";
  } else if (ma20Diff >= -0.035 && ma20Diff < 0) {
    maPts = 7;
    swingSignal = "回踩MA20支撑 · 波段低吸区";
  } else if (ma20Diff < -0.06) {
    maPts = 6;
    swingSignal = "偏离MA20超跌 · 左侧定投区";
  } else if (ma20Diff < -0.035) {
    maPts = 5;
    swingSignal = "MA20下方弱势寻底";
  } else if (ma20Diff <= 0.07) {
    maPts = 5;
    swingSignal = "偏离MA20偏高 · 忌追高";
  } else {
    maPts = 2;
    swingSignal = "短线超买乖离大 · 警惕回踩";
  }

  const techScore = pctPts + maPts; // 0 ~ 20
  const techFactor: EtfFactorSignal = {
    name: "ETF技术波段",
    score: techScore,
    maxScore: 20,
    badge: swingSignal.split(" · ")[0] ?? swingSignal,
    tone: techScore >= 15 ? "accent" : techScore >= 11 ? "neutral" : "caution",
    detail: `513180 现价 ¥${etfPrice.toFixed(3)}，MA20 ¥${ma20.toFixed(3)} (${ma20DiffPctText})，分位 ${pricePercentile.toFixed(1)}%`,
  };

  const totalScore = valPts + fxPts + breadthPts + techScore; // 0 ~ 100

  const positionPlan = compute513180PositionPlan(etfQ, totalScore, quotes);
  const dca = positionPlan.dcaPlan!;
  const devPctText = `${dca.deviationPct >= 0 ? "+" : ""}${(dca.deviationPct * 100).toFixed(1)}%`;
  const eqCostText = `~¥${(positionPlan.latestSnapshot.dilutedCost ?? 0.586).toFixed(3)}`;
  const supportLevelsText = dca.lumpSumAlert.triggerLevels.map((lv) => `¥${lv.toFixed(3)}`).join(" / ");

  let action: EtfActionRating = "hold";
  let actionLabel = "场外定投 · 数据联动";
  let actionTone: PorkStatusTone = "neutral";
  const positionHint = `每日定投 ¥${dca.recommendedDailyAmount}（偏离成本 ${devPctText}）· 已投 ${dca.periods}期 · 等效成本 ${eqCostText}`;
  let summary = "";
  let cycleAdvice = "";
  let swingAdvice = "";

  if (totalScore >= 68) {
    action = ma20Diff >= 0 ? "buy_right" : "accumulate";
    actionLabel = "低估修复 · 动态定投降本";
    actionTone = ma20Diff >= 0 ? "accent" : "positive";
    summary = `恒科指 ${idxPrice.toFixed(0)} 点处低估修复区，叠加人民币汇率 ${fxRate.toFixed(2)} 顺风，当前场外持仓偏离成本 ${devPctText}（等效 513180 成本 ${eqCostText}），结合均线乖离率每日定投设为 ¥${dca.recommendedDailyAmount}。`;
    cycleAdvice = `指数位于 ${HSTECH_THRESHOLDS.indexPivot} 点中枢下方，腾讯阿里千亿回购托底。场外基金短期赎回费高，不做短线网格，靠浮亏分档 × 实时估值修正持续摊薄成本。`;
    swingAdvice = dca.lumpSumAlert.triggered
      ? `⚠️ ${dca.lumpSumAlert.reason}；日常定投维持 ¥${dca.recommendedDailyAmount}/天。`
      : `${dca.dataAdjustmentNote ?? `日常维持 ¥${dca.recommendedDailyAmount}/天`}；单独加仓锚定单周跌 ≥6% 或近期强支撑位 ${supportLevelsText}（单笔 ¥1,000）。`;
  } else if (totalScore >= 50) {
    action = "hold";
    actionLabel = "中枢震荡 · 智能分档定投";
    actionTone = "neutral";
    summary = `恒科指围绕 ${idxPrice.toFixed(0)} 点震荡整固（评分 ${totalScore}/100），当前场外持仓偏离成本 ${devPctText}，结合实时数据执行 ¥${dca.recommendedDailyAmount}/天定投。`;
    cycleAdvice = `平台经济盈利稳健但海外利率预期仍有拉锯，场外仓位坚持长期定投收集低价份额，档位最多每周调一次。`;
    swingAdvice = `${dca.dataAdjustmentNote ?? `当前建议 ¥${dca.recommendedDailyAmount}/天`}；大跌单独加仓动态锚定近期强支撑 ${supportLevelsText}。`;
  } else {
    action = "reduce";
    actionLabel = "偏高减速 · 止盈回流加码池";
    actionTone = "caution";
    summary = `短期估值分位偏高或流动性承压（评分 ${totalScore}/100），按偏离度与均线乖离率调减每日定投额，浮盈超 +25% 时启动分批止盈。`;
    cycleAdvice = `指数进入高热度或汇率逆风区，遵循“低位多投、高位少投”原则控制新增成本，浮盈超 +25% 后每多涨 10% 赎回 10% 满7天份额转入加码池。`;
    swingAdvice = `当前建议定投 ¥${dca.recommendedDailyAmount}/天；止盈赎回资金留存加码池（当前 ¥${positionPlan.profitPool.toFixed(2)}），等待未来回踩强支撑时买回更低份额。`;
  }

  const buyTriggers = [
    `数据联动定投：${dca.dataAdjustmentNote ?? `当前持仓偏离成本 ${devPctText}，每日定投设为 ¥${dca.recommendedDailyAmount}`}`,
    `深度亏损加档：持仓偏离达 -30%～-20% 时基础档调至 200 元/天，≤-30% 时调至 300 元/天（低于 MA20 时再上浮 +20 元/天）`,
    `强支撑单笔加仓：当 513180 单周急跌 ≥6% 或回落至近20日/60日强支撑位（${supportLevelsText}）时，单笔手动加仓 1,000 元`,
  ];

  const sellTriggers = [
    `盈利减速纪律：持仓浮盈达 +10%～+25% 时每日定投降至 70 元，超 +25% 降至 50 元，亏损区间绝不割肉赎回`,
    `高位止盈回流：持仓浮盈超 +25% 后，每再涨 10% 赎回 10% 份额（优先满7天免惩罚性赎回费）转入大跌加码池`,
    `场外校准机制：日常定投自动累计，每周照抄一次券商/基金 App 的「市值 + 持仓盈亏」校准账本即可`,
  ];

  return {
    symbol: "etf_513180",
    action,
    actionLabel,
    actionTone,
    score: totalScore,
    positionHint,
    pricePercentile,
    rangeLow,
    rangeHigh,
    ma20,
    ma20Diff,
    swingSignal,
    summary,
    cycleAdvice,
    swingAdvice,
    buyTriggers,
    sellTriggers,
    factors: [valFactor, fxFactor, breadthFactor, techFactor],
    positionPlan,
  };
}

export type FetchCloses = (instrument: Instrument) => Promise<KlinePoint[]>;
export type FetchRate = () => Promise<number>;

async function fetchYangzhuHits(code: string, label: string): Promise<KlinePoint[]> {
  const url = `${YANGZHU_HITS_URL}?ptype=${code}&areano=-1&datetype=0`;
  const res = requireOk(await guardedFetch(url, {
    method: "POST",
    timeoutMs: 15_000,
    headers: { "user-agent": "Mozilla/5.0", referer: "https://zhujia.zhuwang.com.cn" },
  }), label);
  return parseKlines(JSON.parse(res.text()));
}

export const defaultFetchCloses: FetchCloses = async (instrument) => {
  const { symbol, code, source, sourceMultiplier } = instrument;

  if (source === "sina-global") {
    const url = `${SINA_FUTURES_URL}?symbol=${code}`;
    const res = requireOk(await guardedFetch(url, {
      timeoutMs: 15_000,
      headers: { "user-agent": "Mozilla/5.0", referer: "https://finance.sina.com.cn" },
    }), symbol);
    return parseKlines(JSON.parse(res.text()), { includeOhlcv: true });
  }

  if (source === "tencent-kline") {
    const url = `${TENCENT_KLINE_URL}?param=${code},day,,,${HISTORY},qfq`;
    const res = requireOk(await guardedFetch(url, {
      timeoutMs: 15_000,
      headers: { "user-agent": "Mozilla/5.0", referer: "https://gu.qq.com" },
    }), symbol);
    return parseKlines(JSON.parse(res.text()), { includeOhlcv: true });
  }

  if (source === "eastmoney-kline") {
    const url = `${EASTMONEY_KLINE_URL}?secid=${code}&klt=101&fqt=1&lmt=${HISTORY}&end=20500101&iscca=1&fields1=f1,f2,f3,f4,f5,f6,f7,f8&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61`;
    const res = requireOk(await guardedFetch(url, {
      timeoutMs: 15_000,
      headers: { "user-agent": "Mozilla/5.0", referer: "https://quote.eastmoney.com" },
    }), symbol);
    return parseKlines(JSON.parse(res.text()), { includeOhlcv: true });
  }

  if (source === "sina-inner-futures") {
    const url = `${SINA_INNER_FUTURES_URL}?symbol=${code}`;
    const res = requireOk(await guardedFetch(url, {
      timeoutMs: 15_000,
      headers: { "user-agent": "Mozilla/5.0", referer: "https://finance.sina.com.cn" },
    }), symbol);
    const raw = res.text();
    const match = raw.match(/\(\s*(\[[\s\S]*\])\s*\)/);
    if (!match) throw new Error(`unreadable inner futures jsonp response for ${code}`);
    const parsed = parseKlines(JSON.parse(match[1]!), { includeOhlcv: true });

    // Append today's live price during or after session if available
    try {
      const liveRes = await guardedFetch(`${SINA_INNER_LIVE_URL}nf_${code}`, {
        timeoutMs: 5_000,
        headers: { "user-agent": "Mozilla/5.0", referer: "https://finance.sina.com.cn" },
      });
      if (liveRes.status === 200) {
        const text = liveRes.text();
        const rawLive = text.split('"')[1];
        if (rawLive) {
          const parts = rawLive.split(",");
          const currentPrice = Number(parts[8]);
          const date = parts[17];
          if (date && Number.isFinite(currentPrice) && currentPrice > 0) {
            const last = parsed.at(-1);
            if (last && last.day === date) {
              last.close = currentPrice;
            } else {
              parsed.push({ day: date, close: currentPrice });
            }
          }
        }
      }
    } catch {
      // Live snapshot is a progressive enhancement; keep historical closes on failure.
    }

    return parsed;
  }

  if (source === "yangzhu-hits") {
    return fetchYangzhuHits(code, symbol);
  }

  if (source === "yangzhu-ratio") {
    const [hogCode = "1", cornCode = "4"] = code.split(":");
    const [hogCloses, cornCloses] = await Promise.all([
      fetchYangzhuHits(hogCode, `${symbol}_hog`),
      fetchYangzhuHits(cornCode, `${symbol}_corn`),
    ]);
    return computePigGrainSeries(hogCloses, cornCloses);
  }

  if (source === "moa-pork-daily") {
    const res = requireOk(await guardedFetch(MOA_FARM_DAILY_URL, {
      method: "POST",
      timeoutMs: 15_000,
      headers: {
        "user-agent": "Mozilla/5.0",
        "content-type": "application/json",
        referer: "https://pfsc.agri.cn/",
      },
      body: JSON.stringify({ pageNum: 1, pageSize: 85 }),
    }), symbol);
    return parseMoaFarmDailyPork(JSON.parse(res.text()));
  }

  if (source === "zhue-cure") {
    // Zhue pricecure samples every 3rd day over ~90 days; querying day=89, 90, 91 reconstructs all 90 daily points.
    const responses = await Promise.all([89, 90, 91].map(async (d) => {
      const url = `${ZHUE_CURE_URL}?act=pricecure&puote_small_id=${code}&province_name=&day=${d}`;
      const res = requireOk(await guardedFetch(url, {
        timeoutMs: 15_000,
        headers: {
          "user-agent": "Mozilla/5.0",
          "x-requested-with": "XMLHttpRequest",
          referer: ZHUE_CURE_URL,
        },
      }), `${symbol}_d${d}`);
      return JSON.parse(res.text()) as unknown;
    }));
    return parseZhuePriceCure(responses, { multiplier: sourceMultiplier ?? 1 });
  }

  if (source === "official-series") {
    if (code === "sow_inventory") {
      // 农业农村部及国家统计局季度核定公布的官方全国能繁母猪存栏量（万头）
      return [
        { day: "2024-12-31", close: 4078 },
        { day: "2025-03-31", close: 4039 },
        { day: "2025-06-30", close: 4043 },
        { day: "2025-09-30", close: 4035 },
        { day: "2025-12-31", close: 4035 },
        { day: "2026-03-31", close: 3904 },
        { day: "2026-06-30", close: 3780 },
        { day: "2026-09-30", close: 3602 },
      ];
    }
    if (code === "caac_load_factor") {
      // 中国民航局季度核定公布的全行业正班客座率（%）
      return [
        { day: "2024-12-31", close: 83.2 },
        { day: "2025-03-31", close: 82.6 },
        { day: "2025-06-30", close: 81.9 },
        { day: "2025-09-30", close: 84.8 },
        { day: "2025-12-31", close: 83.4 },
        { day: "2026-03-31", close: 83.8 },
        { day: "2026-06-30", close: 83.1 },
        { day: "2026-09-30", close: 85.6 },
      ];
    }
    throw new Error(`unknown official series ${code}`);
  }

  throw new Error(`unsupported instrument source ${source}`);
};

export const defaultUsdCnyRate: FetchRate = async () => {
  const url = "http://hq.sinajs.cn/list=fx_susdcny";
  const res = requireOk(await guardedFetch(url, {
    timeoutMs: 10_000,
    headers: { referer: "https://finance.sina.com.cn" },
  }), "fx_susdcny");
  const match = res.text().match(/="([^"]+)"/);
  if (!match) throw new Error("unreadable fx response");
  const parts = match[1]!.split(",");
  const rate = Number(parts[8]) || Number(parts[1]);
  if (!Number.isFinite(rate) || rate <= 0) throw new Error(`invalid fx rate: ${match[1]}`);
  return rate;
};

export interface RefreshMarketsOptions {
  /** Bypass inSession check so manual refresh works at any time of day */
  force?: boolean;
  /** Skip upstream quote fetching and only re-run AI analysis on existing stored quotes */
  skipQuotes?: boolean;
  /** Skip AI analysis generation for fast intraday quote-only updates */
  skipAi?: boolean;
  /** Do not throw when individual upstream symbols fail; still run AI analysis on remaining quotes */
  allowPartial?: boolean;
}

/**
 * Reads the closes of instruments, and optionally the USD/CNY rate from Sina.
 * If category is "pork", only pork instruments are refreshed and inSession checks are bypassed (daily midnight settlement).
 * If category is "macro", only macro instruments and USD/CNY rate are refreshed during active trading sessions.
 */
export async function refreshMarkets(
  now = new Date(),
  fetchCloses: FetchCloses = defaultFetchCloses,
  fetchRate: FetchRate = defaultUsdCnyRate,
  category?: MarketCategory | "all",
  opts?: RefreshMarketsOptions,
): Promise<Record<string, number>> {
  const isPork = category === "pork";
  const isAviation = category === "aviation";
  const isHstech = category === "hstech";
  const isFunds = category === "funds";
  const isDailySector = isPork || isAviation || isHstech || isFunds;
  const isMacro = category === "macro";
  const known = getDistinctSymbols();
  const written: Record<string, number> = {};
  const failed: string[] = [];

  if (!opts?.skipQuotes) {
    // 1. Fetch and store USD/CNY exchange rate (skip when strictly refreshing daily sector tabs)
    if (!isDailySector) {
      try {
        const rate = await fetchRate();
        if (rate > 0) {
          written.usdcny = upsertCloses([{ symbol: "usdcny", day: beijingDate(now), close: rate }]);
        }
      } catch (error) {
        // A transient FX fetch failure should not break commodity prices; last stored rate remains.
        failed.push(`usdcny: ${(error as Error).message}`);
      }
    }

    // 2. Fetch instruments matching category
    const targetInstruments = category && category !== "all"
      ? INSTRUMENTS.filter((i) => i.category === category)
      : INSTRUMENTS;

    for (const instrument of targetInstruments) {
      // When refreshing sector daily at midnight or via manual force, always fetch the latest closes; otherwise check inSession
      if (!opts?.force && !isDailySector && known.has(instrument.symbol) && !inSession(instrument.session, now)) continue;
      try {
        const closes = await fetchCloses(instrument);
        const rows = closes.map((c) => ({
          symbol: instrument.symbol,
          day: c.day,
          close: c.close,
          ...(c.high != null ? { high: c.high } : {}),
          ...(c.low != null ? { low: c.low } : {}),
          ...(c.volume != null ? { volume: c.volume } : {}),
        }));
        if (rows.length === 0) continue;
        written[instrument.symbol] = upsertCloses(rows);
        if (fetchCloses === defaultFetchCloses) {
          await new Promise((r) => setTimeout(r, 250));
        }
      } catch (error) {
        failed.push(`${instrument.symbol}: ${(error as Error).message}`);
      }
    }
  }

  // 3. Generate and store consolidated pork / aviation / hstech analysis
  if (!isMacro && !opts?.skipAi && (opts?.allowPartial || failed.length === 0)) {
    try {
      const currentData = await readMarkets({ skipAnalysis: true });
      const todayStr = beijingDate(now);
      if (!isAviation && !isHstech) {
        const analysis = await generatePorkAnalysis(currentData.quotes);
        setStoredAnalysis("markets.pork_analysis", analysis);
        if (analysis.etfGuidance?.positionPlan) {
          setDailyFrozenPlan("etf_516670", todayStr, {
            ...analysis.etfGuidance.positionPlan,
            frozenDate: todayStr,
          });
        }
      }
      if (!isPork && !isHstech) {
        const aviationAnalysis = await generateAviationAnalysis(currentData.quotes);
        setStoredAnalysis("markets.aviation_analysis", aviationAnalysis);
        if (aviationAnalysis.etfGuidance?.positionPlan) {
          setDailyFrozenPlan("cea_600115", todayStr, {
            ...aviationAnalysis.etfGuidance.positionPlan,
            frozenDate: todayStr,
          });
        }
      }
      if (!isPork && !isAviation) {
        const hstechAnalysis = await generateHstechAnalysis(currentData.quotes);
        setStoredAnalysis("markets.hstech_analysis", hstechAnalysis);
        if (hstechAnalysis.etfGuidance?.positionPlan) {
          setDailyFrozenPlan("etf_513180", todayStr, {
            ...hstechAnalysis.etfGuidance.positionPlan,
            frozenDate: todayStr,
          });
        }
      }
    } catch {
      // Non-blocking if analysis persistence encounters transient failure
    }
  }

  if (isFunds || category === "all") {
    try {
      await refreshPotentialFundsDaily(now, opts);
      written.potential_funds = 1;
    } catch {
      // Non-blocking
    }
  }

  if (failed.length && !opts?.allowPartial) {
    throw new Error(`markets refresh failed for ${failed.join("; ")}`);
  }

  return written;
}

/** Daily pork industry refresh (Beijing 00:00): fetches all pork instruments and runs AI cyclical analysis. */
export async function refreshPorkDaily(
  now = new Date(),
  fetchCloses: FetchCloses = defaultFetchCloses,
): Promise<Record<string, number>> {
  return refreshMarkets(now, fetchCloses, defaultUsdCnyRate, "pork");
}

/** Daily aviation industry refresh (Beijing 00:05): fetches all aviation instruments and runs China Eastern & sector analysis. */
export async function refreshAviationDaily(
  now = new Date(),
  fetchCloses: FetchCloses = defaultFetchCloses,
): Promise<Record<string, number>> {
  return refreshMarkets(now, fetchCloses, defaultUsdCnyRate, "aviation");
}

/** Daily Hang Seng Tech refresh (Beijing 00:10): fetches all HSTECH instruments and runs 513180 ETF & sector analysis. */
export async function refreshHstechDaily(
  now = new Date(),
  fetchCloses: FetchCloses = defaultFetchCloses,
): Promise<Record<string, number>> {
  return refreshMarkets(now, fetchCloses, defaultUsdCnyRate, "hstech");
}

/** Intraday macro benchmarks refresh (every 10 minutes): updates Brent, gold, SSE, HSTECH, and FX rate. */
export async function refreshMacroMarkets(
  now = new Date(),
  fetchCloses: FetchCloses = defaultFetchCloses,
  fetchRate: FetchRate = defaultUsdCnyRate,
): Promise<Record<string, number>> {
  return refreshMarkets(now, fetchCloses, fetchRate, "macro");
}

const FlexibleToneSchema = z
  .string()
  .optional()
  .nullable()
  .transform((val): PorkStatusTone | undefined => {
    if (!val) return undefined;
    const v = val.trim().toLowerCase();
    if (v === "positive" || v === "neutral" || v === "caution" || v === "critical" || v === "accent") {
      return v;
    }
    if (v.includes("critical") || v.includes("danger") || v.includes("error")) return "critical";
    if (v.includes("caution") || v.includes("warn")) return "caution";
    if (v.includes("positive") || v.includes("good") || v.includes("bull")) return "positive";
    if (v.includes("accent")) return "accent";
    return "neutral";
  });

const IndicatorInsightItemSchema = z.object({
  symbol: z.string(),
  badge: z.string().optional().nullable(),
  tone: FlexibleToneSchema,
  comment: z.string(),
});

export const PorkMarketAnalysisSchema = z.object({
  stage: z.string().describe("周期当前所处阶段判定"),
  headline: z.string().describe("产业链综合研判核心结论，1句话，精炼专业"),
  warningLevel: z
    .string()
    .transform((val): "normal" | "caution" | "critical" => {
      const v = val.trim().toLowerCase();
      if (v.includes("critical") || v.includes("danger") || v.includes("high")) return "critical";
      if (v.includes("caution") || v.includes("warn") || v.includes("moderate")) return "caution";
      return "normal";
    })
    .describe("预警等级：normal 正常，caution 二级预警，critical 一级预警"),
  warningText: z.string().describe("预警原因与监管信号"),
  bullets: z.array(z.object({
    dimension: z.string().describe("研判维度"),
    assessment: z.string().describe("该维度的具体产业链数据分析与趋势推演"),
  })).min(3).transform((arr) => arr.slice(0, 4)),
  indicatorInsights: z.union([
    z.array(IndicatorInsightItemSchema),
    z.record(z.string(), z.object({
      badge: z.string().optional().nullable(),
      tone: FlexibleToneSchema,
      comment: z.string(),
    })),
  ]).optional().catch(undefined),
  etfStrategy: z.object({
    summary: z.string(),
    cycleAdvice: z.string(),
    swingAdvice: z.string(),
    buyTriggers: z.array(z.string()).optional().transform((arr) => (arr ?? []).slice(0, 3)),
    sellTriggers: z.array(z.string()).optional().transform((arr) => (arr ?? []).slice(0, 3)),
  }).optional().catch(undefined),
});

export const TargetAssetStrategySchema = z.object({
  actionLabel: z.string().optional().describe("AI综合操作评级（4~8字，如 右侧顺势加配、左侧网格建仓）"),
  actionTone: FlexibleToneSchema,
  score: z.coerce.number().min(0).max(100).optional().catch(undefined),
  positionHint: z.string().optional().describe("AI建议仓位结构（如 中线底仓 65%~75% · T+0机动仓 15%）"),
  summary: z.string().describe("核心买卖指导综述，1句话"),
  cycleAdvice: z.string().describe("中长线底仓配置与基本面安全垫深度分析（60~90字）"),
  swingAdvice: z.string().describe("短线K线趋势、MA20均线支撑与波段做T节奏分析（50~80字）"),
  buyTriggers: z.array(z.string()).optional().transform((arr) => (arr ?? []).filter(Boolean).slice(0, 3)),
  sellTriggers: z.array(z.string()).optional().transform((arr) => (arr ?? []).filter(Boolean).slice(0, 3)),
});

function normalizeIndicatorInsights(
  raw: z.infer<typeof PorkMarketAnalysisSchema>["indicatorInsights"],
): Record<string, { badge?: string | null; tone?: PorkStatusTone | null; comment: string }> | undefined {
  if (!raw) return undefined;
  const out: Record<string, { badge?: string | null; tone?: PorkStatusTone | null; comment: string }> = {};
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (item.symbol && item.comment) {
        out[item.symbol] = { badge: item.badge ?? null, tone: item.tone ?? null, comment: item.comment };
      }
    }
  } else {
    for (const [sym, val] of Object.entries(raw)) {
      if (val && val.comment) {
        out[sym] = { badge: val.badge ?? null, tone: val.tone ?? null, comment: val.comment };
      }
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function buildTargetKlinesSummary(etfQuote: MarketQuote | undefined, base: Etf516670Guidance, decimals: number): string {
  const recentCloses = (etfQuote?.series ?? []).slice(-12).map((p) => `${p.day}:${p.close.toFixed(decimals)}`).join(", ");
  const ch1d = etfQuote?.changeYesterday != null ? `${(etfQuote.changeYesterday * 100).toFixed(2)}%` : "无";
  const ch1w = etfQuote?.change1w != null ? `${(etfQuote.change1w * 100).toFixed(2)}%` : "无";
  const ch1m = etfQuote?.change1m != null ? `${(etfQuote.change1m * 100).toFixed(2)}%` : "无";
  const ch2m = etfQuote?.change2m != null ? `${(etfQuote.change2m * 100).toFixed(2)}%` : "无";
  const factorLines = base.factors
    .map((f) => `  · ${f.name}: ${f.score}/${f.maxScore} (${f.badge}) — ${f.detail}`)
    .join("\n");
  return [
    `最新收盘价: ¥${(etfQuote?.price ?? base.ma20).toFixed(decimals)} (较昨日 ${ch1d}, 周环比 ${ch1w}, 近30日 ${ch1m}, 近60日 ${ch2m})`,
    `技术均线与区间: MA20均线 ¥${base.ma20.toFixed(decimals)} (乖离率 ${(base.ma20Diff * 100).toFixed(2)}%, 状态: ${base.swingSignal}), 近90日区间 ¥${base.rangeLow.toFixed(decimals)} ~ ¥${base.rangeHigh.toFixed(decimals)} (所处分位 ${base.pricePercentile.toFixed(1)}%)`,
    `量化参考锚点: 回踩低吸支撑带 ¥${(base.ma20 * 0.97).toFixed(decimals)} ~ ¥${base.ma20.toFixed(decimals)}, 短线波段高抛带 ¥${(base.ma20 * 1.05).toFixed(decimals)} ~ ¥${base.rangeHigh.toFixed(decimals)}`,
    `近12个交易日收盘序列: [${recentCloses || "无"}]`,
    `四维量化因子基准得分 (总分 ${base.score}/100, 基准评级 「${base.actionLabel}」):\n${factorLines}`,
  ].join("\n");
}

function mergeTargetGuidance(
  base: Etf516670Guidance,
  strat: z.infer<typeof TargetAssetStrategySchema> | undefined,
  fallback: z.infer<typeof PorkMarketAnalysisSchema>["etfStrategy"],
): Etf516670Guidance {
  // Rule 6: AI only writes narrative interpretation; prices, quantities, positionHint, and triggers are strictly locked to the deterministic ladder/DCA engine.
  if (strat) {
    return {
      ...base,
      summary: strat.summary || base.summary,
      cycleAdvice: strat.cycleAdvice || base.cycleAdvice,
      swingAdvice: base.swingAdvice,
    };
  }
  if (fallback) {
    return {
      ...base,
      summary: fallback.summary || base.summary,
      cycleAdvice: fallback.cycleAdvice || base.cycleAdvice,
      swingAdvice: base.swingAdvice,
    };
  }
  return base;
}

export function computeRuleBasedPorkAnalysis(
  quotes: ReadonlyArray<Pick<MarketQuote, "symbol" | "price"> & Partial<MarketQuote>>,
): PorkMarketAnalysis {
  const getQ = (sym: string) => quotes.find((q) => q.symbol === sym);

  const ratioQ = getQ("pig_grain_ratio");
  const hogQ = getQ("hog_spot");
  const futuresQ = getQ("hog_futures");
  const porkQ = getQ("pork_spot");
  const pigletQ = getQ("piglet_spot");
  const sowSpotQ = getQ("sow_spot");
  const sowInvQ = getQ("sow_inventory");
  const cornQ = getQ("corn_spot");
  const beanQ = getQ("bean_spot");

  const ratio = ratioQ?.price ?? 3.94;
  const hogPrice = hogQ?.price ?? 9.19;
  const futuresPriceKg = futuresQ?.cnyPrice ?? (futuresQ?.price ? futuresQ.price / 1000 : 9.51);
  const porkPrice = porkQ?.price ?? 15.29;
  const pigletPriceHead = pigletQ?.unit === "头"
    ? pigletQ.price
    : (pigletQ?.price ?? 13.67) * PORK_THRESHOLDS.pigletWeightKg;
  const pigletPriceKg = pigletQ?.cnyPrice ?? pigletPriceHead / PORK_THRESHOLDS.pigletWeightKg;
  const sowSpotPrice = sowSpotQ?.price ?? 1485;
  const sowInv = sowInvQ?.price ?? 3602;
  const cornPriceKg = cornQ?.cnyPrice ?? (cornQ?.price ? cornQ.price / 1000 : 2.33);
  const beanPriceKg = beanQ?.cnyPrice ?? (beanQ?.price ? beanQ.price / 1000 : 3.12);

  let warningLevel: "normal" | "caution" | "critical" = "normal";
  let warningText = "";
  let stage = "";

  if (ratio < PORK_THRESHOLDS.pigGrainLevel1Floor) {
    warningLevel = "critical";
    warningText = `猪粮比 ${ratio.toFixed(2)}:1 低于发改委 ${PORK_THRESHOLDS.pigGrainLevel1Floor.toFixed(1)}:1 过度下跌一级预警线，触发中央储备收储托底。`;
    stage = "深度亏损·收储托底";
  } else if (ratio < PORK_THRESHOLDS.pigGrainBreakeven) {
    warningLevel = "caution";
    warningText = `猪粮比 ${ratio.toFixed(2)}:1 处于 5.0~6.0:1 亏损预警区，养殖端位于成本线下方。`;
    stage = "成本震荡·弱势出清";
  } else if (ratio <= PORK_THRESHOLDS.pigGrainHighWarning) {
    warningLevel = "normal";
    warningText = `猪粮比 ${ratio.toFixed(2)}:1 处于 6.0~9.0:1 绿色合理区间，养殖现金流健康。`;
    stage = "景气平稳·盈利常态";
  } else {
    warningLevel = "caution";
    warningText = `猪粮比 ${ratio.toFixed(2)}:1 超 9.0:1 过度上涨预警线，警惕压栏二育后置供给风险。`;
    stage = "高景气度·供给透支";
  }

  const basisDiff = futuresPriceKg - hogPrice;
  const basisDesc = Math.abs(basisDiff) < 0.15
    ? "期现基本平水"
    : basisDiff > 0
      ? `期货升水 +¥${basisDiff.toFixed(2)}/kg`
      : `期货贴水 -¥${Math.abs(basisDiff).toFixed(2)}/kg`;

  const { profitPerHead } = computeHogProfitMetrics(hogPrice);
  const profitText = profitPerHead < 0
    ? `头均亏 ¥${Math.abs(profitPerHead)}`
    : `头均盈 ¥${profitPerHead}`;

  const headline = `猪价 ${hogPrice.toFixed(2)} 元/kg（${profitText}），猪粮比 ${ratio.toFixed(2)}:1 处${
    warningLevel === "critical" ? "一级收储预警区" : warningLevel === "caution" ? "亏损预警区" : "合理均衡区"
  }，${ratio < PORK_THRESHOLDS.pigGrainBreakeven ? "产能去化构筑周期底部。" : "供求维持均衡。"}`;

  const sowTarget = PORK_THRESHOLDS.sowInventoryTargetWan;
  const sowRatioPct = ((sowInv / sowTarget) * 100).toFixed(1);

  const bullets = [
    {
      dimension: "终端与基差",
      assessment: `白条批发 ¥${porkPrice.toFixed(2)}/kg，生猪 ¥${hogPrice.toFixed(2)}/kg，主力期货 ¥${futuresPriceKg.toFixed(2)}/kg（${basisDesc}），远期预期${basisDiff > 0 ? "温和修复" : "偏审慎"}。`,
    },
    {
      dimension: "产能与母猪",
      assessment: `能繁母猪 ${sowInv.toFixed(0)} 万头（保有目标的 ${sowRatioPct}%），二元母猪 ¥${sowSpotPrice.toFixed(0)}/头，${sowInv < sowTarget ? `较目标缩减 ${(sowTarget - sowInv).toFixed(0)} 万头支撑远期反转` : "远期基础供给充裕"}。`,
    },
    {
      dimension: "仔猪与补栏",
      assessment: `15kg仔猪 ¥${pigletPriceHead.toFixed(0)}/头（折 ¥${pigletPriceKg.toFixed(2)}/kg，保本线 ¥${PORK_THRESHOLDS.pigletBreakevenPerHead}），${
        pigletPriceHead < PORK_THRESHOLDS.pigletFreezePerHead
          ? "处补栏冰点，锁定半年后出栏收缩"
          : pigletPriceHead < PORK_THRESHOLDS.pigletBreakevenPerHead
            ? "低于保本线，补栏偏谨慎"
            : "补栏节奏平稳"
      }。`,
    },
    {
      dimension: "成本与盈亏",
      assessment: `玉米 ¥${cornPriceKg.toFixed(2)}/kg、豆粕 ¥${beanPriceKg.toFixed(2)}/kg；按完全成本 ¥${PORK_THRESHOLDS.hogFullCostPerKg.toFixed(1)}/kg 测算${profitText}${hogPrice < PORK_THRESHOLDS.hogCashCostPerKg ? "，已击穿现金成本" : ""}。`,
    },
  ];

  return {
    stage,
    headline,
    warningLevel,
    warningText,
    bullets,
    etfGuidance: computeEtf516670Guidance(quotes),
    analyzedAt: new Date().toISOString(),
    source: "rules",
  };
}

export async function generatePorkAnalysis(quotes: MarketQuote[]): Promise<PorkMarketAnalysis> {
  if (process.env.MODEL_CALLS_ENABLED !== "true") {
    return computeRuleBasedPorkAnalysis(quotes);
  }

  try {
    const porkQuotes = quotes.filter((q) => q.category === "pork");
    if (porkQuotes.length === 0) return computeRuleBasedPorkAnalysis(quotes);

    const latestDay = porkQuotes.map((q) => q.day).sort().at(-1) ?? beijingDate(new Date());
    const hogQ = porkQuotes.find((q) => q.symbol === "hog_spot");
    const etfQ = porkQuotes.find((q) => q.symbol === "etf_516670");
    const profitMetrics = computeHogProfitMetrics(hogQ?.price ?? 9.19);
    const baseEtfGuidance = computeEtf516670Guidance(quotes);

    const contextLines = porkQuotes.map((q) => {
      const ch1w = q.change1w !== null && q.change1w !== undefined ? `${(q.change1w * 100).toFixed(2)}%` : "无";
      const ch1m = q.change1m !== null ? `${(q.change1m * 100).toFixed(2)}%` : "无";
      const cny = q.cnyPrice !== null ? ` (折合 ¥${q.cnyPrice.toFixed(2)}/${q.cnyUnit})` : "";
      const bench = q.benchmark ?? computePorkBenchmark(q, porkQuotes);
      const priceStr = q.symbol === "etf_516670" ? q.price.toFixed(3) : String(q.price);
      return `- ${q.name} (${q.symbol}, 统计日 ${q.day}): 最新 ${priceStr} ${q.unit}${cny}, 周环比: ${ch1w}, 近30日: ${ch1m}, 行业锚点: ${bench.anchorText}${bench.anchorSub ? ` (${bench.anchorSub})` : ""}, 状态: ${bench.statusBadge}`;
    });

    const systemPrompt = `你是一位精通中国农业农村部调控政策、大宗商品生猪周期的首席农业产业分析师。
请严格基于最新监测数据与以下2026年校准行业基准进行全产业链深度研判及 9 大指标逐项解读，数据口径必须与看板完全一致：
1. 2026年行业自繁自养平均完全成本基准：¥${PORK_THRESHOLDS.hogFullCostPerKg.toFixed(2)}/公斤（现金成本线 ¥${PORK_THRESHOLDS.hogCashCostPerKg.toFixed(2)}/公斤，标猪出栏均重 ${PORK_THRESHOLDS.standardHogWeightKg} 公斤/头，当前测算头均盈亏为 ${profitMetrics.profitPerHead >= 0 ? `+¥${profitMetrics.profitPerHead}` : `-¥${Math.abs(profitMetrics.profitPerHead)}`} 元/头）。
2. 15kg外三元仔猪繁育保本价：¥${PORK_THRESHOLDS.pigletBreakevenPerHead}/头（传导期5~6个月）；后备二元种猪常态更新基准：¥${PORK_THRESHOLDS.sowNormalPricePerHead}/头。
3. 全国能繁母猪正常保有量目标：${PORK_THRESHOLDS.sowInventoryTargetWan} 万头，绿色合理区间 92%~103%（3450~3862.5万头），传导期约10个月。
4. 国家发改委猪粮比价：盈亏平衡点 6.0:1，低于 5.0:1 为过度下跌一级预警（warningLevel 设为 "critical"），5.0~6.0:1 为 "caution"，6.0~9.0:1 为 "normal"。

严格只输出一个合法 JSON 对象，字段名完全一致：
{
  "stage": "周期阶段判定（格式统一为：四字·四字，如 深度亏损·政策托底）",
  "headline": "核心结论（1句话，35字以内，含生猪均价、头均盈亏与核心驱动）",
  "warningLevel": "normal 或 caution 或 critical",
  "warningText": "猪粮比与收储预警说明（40字以内）",
  "bullets": [
    { "dimension": "终端与基差", "assessment": "深入分析白条批发、外三元毛猪、毛白价差及期货升贴水反映的市场交割与压栏二育情绪（65~90字）" },
    { "dimension": "产能与母猪", "assessment": "深入分析能繁母猪存栏较保有目标偏离度、二元种猪折价幅度及对10个月后基础产能的传导推演（65~90字）" },
    { "dimension": "仔猪与补栏", "assessment": "深入分析15kg仔猪价格较保本线盈亏、养殖户补栏积极性及对5~6个月后商品猪出栏量的前瞻影响（65~90字）" },
    { "dimension": "成本与盈亏", "assessment": "深入分析玉米豆粕配合料成本走势、猪粮比一级收储预警触发情况及现金流破位对去产能的加速作用（65~90字）" }
  ],
  "indicatorInsights": [
    { "symbol": "hog_spot", "badge": "4~6字状态", "tone": "critical", "comment": "针对外三元生猪现价、成本倒挂与出栏节奏的AI深度点评（24~38字）" },
    { "symbol": "pork_spot", "badge": "4~6字状态", "tone": "neutral", "comment": "针对农业部白条肉批发价、毛白价差与终端屠宰走货的AI点评（24~38字）" },
    { "symbol": "hog_futures", "badge": "4~6字状态", "tone": "accent", "comment": "针对生猪主力期货期现基差与远月周期预期的AI点评（24~38字）" },
    { "symbol": "piglet_spot", "badge": "4~6字状态", "tone": "caution", "comment": "针对15kg仔猪价格、补栏情绪与半年后供给传导的AI点评（24~38字）" },
    { "symbol": "sow_spot", "badge": "4~6字状态", "tone": "caution", "comment": "针对二元母猪价格、淘汰更新意愿与产能出清斜率的AI点评（24~38字）" },
    { "symbol": "sow_inventory", "badge": "4~6字状态", "tone": "positive", "comment": "针对官方能繁母猪存栏量、调控区间位置与10个月后反转潜力的AI点评（24~38字）" },
    { "symbol": "pig_grain_ratio", "badge": "4~6字状态", "tone": "critical", "comment": "针对猪粮比价、发改委收储预警级别与政策托底力度的AI点评（24~38字）" },
    { "symbol": "corn_spot", "badge": "4~6字状态", "tone": "neutral", "comment": "针对玉米现货价格走势及对饲料能量成本影响的AI点评（24~38字）" },
    { "symbol": "bean_spot", "badge": "4~6字状态", "tone": "neutral", "comment": "针对豆粕现货价格走势及对蛋白饲料成本影响的AI点评（24~38字）" },
    { "symbol": "muyuan_002714", "badge": "4~6字状态", "tone": "accent", "comment": "针对牧原股份股价动量、自繁自养完全成本优势与机构抢跑周期预期的AI点评（24~38字）" },
    { "symbol": "wens_300498", "badge": "4~6字状态", "tone": "positive", "comment": "针对温氏股份股价走势、公司+农户猪鸡双主业稳健性与ETF权重协同的AI点评（24~38字）" }
  ]
}
注意：字符串内容内部严禁使用英文双引号（"），如需引号请使用中文引号（「」或“”）。`;

    const userPrompt = `最新生猪产业链 9 大核心指标监测数据（基准日 ${latestDay}）：\n${contextLines.join("\n")}\n\n请生成生猪产业链四维深度研判与 9 项指标逐项 AI 解读 JSON。`;

    const etfSystemPrompt = `你是一位专精于 A 股农业养殖板块与畜牧养殖ETF（516670）长期持有及两段式网格降成本的基金策略师。
请结合生猪周期基本面（80%权重：能繁母猪去化、头均亏损安全垫、猪粮比收储预警、期货升贴水）与 516670 场内日线技术面，为投资者撰写周期解读文字。
注意：本系统采用「核心底仓不动 + 两段式固定网格按笔配对止盈 + 下跌绝不设技术破位止损 + 差价利润继续买更低股」纪律，AI 只负责撰写基本面与周期解读文字，严禁改动系统既定网格价位与买卖股数，严禁建议跌破均线割肉止损或用本金追高。
严格只输出一个合法 JSON 对象，字段名完全一致：
{
  "actionLabel": "${baseEtfGuidance.actionLabel}",
  "actionTone": "${baseEtfGuidance.actionTone}",
  "score": ${baseEtfGuidance.score},
  "positionHint": "${baseEtfGuidance.positionHint}",
  "summary": "516670周期位置与两段式网格降本核心综述（1句话，45字以内）",
  "cycleAdvice": "中长线猪周期底仓配置深度分析（65~95字，详述当前母猪存栏、头均亏损与收储信号下的底仓安全垫，以及为何长线锁仓配合网格降本）",
  "swingAdvice": "${baseEtfGuidance.swingAdvice}"
}`;

    const etfUserPrompt = `畜牧养殖ETF（516670）最新日线序列与多因子量化数据（基准日 ${latestDay}）：\n${buildTargetKlinesSummary(etfQ, baseEtfGuidance, 3)}\n\n产业链背景：\n${contextLines.join("\n")}\n\n请生成 516670 专属仓位与波段操作策略 JSON。`;

    const [industrySettled, strategySettled] = await Promise.allSettled([
      chatJson({
        system: systemPrompt,
        user: userPrompt,
        schema: PorkMarketAnalysisSchema,
        temperature: 0.2,
        maxTokens: 3200,
        purpose: "pork_analysis",
        subject: `pork_market:${latestDay}`,
      }),
      chatJson({
        system: etfSystemPrompt,
        user: etfUserPrompt,
        schema: TargetAssetStrategySchema,
        temperature: 0.2,
        maxTokens: 2200,
        purpose: "pork_etf_strategy",
        subject: `etf_516670:${latestDay}`,
      }),
    ]);

    if (industrySettled.status === "rejected") {
      throw industrySettled.reason;
    }

    const res = industrySettled.value;
    const stratRes = strategySettled.status === "fulfilled" ? strategySettled.value : null;
    const { etfStrategy, indicatorInsights: rawInsights, ...restData } = res.data;
    const etfGuidance = mergeTargetGuidance(baseEtfGuidance, stratRes?.data, etfStrategy);

    return {
      ...restData,
      indicatorInsights: normalizeIndicatorInsights(rawInsights) ?? null,
      etfGuidance,
      analyzedAt: new Date().toISOString(),
      source: "ai",
      model: res.model,
      channelId: res.channelId,
      channelHost: res.host,
      latencyMs: (res.latencyMs ?? 0) + (stratRes?.latencyMs ?? 0),
      tokensIn: (res.tokensIn ?? 0) + (stratRes?.tokensIn ?? 0),
      tokensOut: (res.tokensOut ?? 0) + (stratRes?.tokensOut ?? 0),
    };
  } catch {
    return computeRuleBasedPorkAnalysis(quotes);
  }
}

export function computeRuleBasedAviationAnalysis(
  quotes: ReadonlyArray<Pick<MarketQuote, "symbol" | "price"> & Partial<MarketQuote>>,
): PorkMarketAnalysis {
  const getQ = (sym: string) => quotes.find((q) => q.symbol === sym);

  const crudeQ = getQ("ine_crude");
  const fuelQ = getQ("fuel_futures");
  const fxQ = getQ("fx_usdcny");
  const airportQ = getQ("sh_airport");
  const airChinaQ = getQ("air_china");
  const csaQ = getQ("csa_600029");
  const springQ = getQ("spring_air");
  const caacQ = getQ("caac_load_factor");
  const ceaQ = getQ("cea_600115");

  const crudePrice = crudeQ?.price ?? 698.2;
  const fuelPrice = fuelQ?.price ?? 4305;
  const fxRate = fxQ?.price ?? 6.672;
  const airportPrice = airportQ?.price ?? 24.75;
  const airChinaPrice = airChinaQ?.price ?? 6.11;
  const csaPrice = csaQ?.price ?? 5.04;
  const springPrice = springQ?.price ?? 42.46;
  const loadFactor = caacQ?.price ?? 85.6;
  const ceaPrice = ceaQ?.price ?? 3.43;

  let warningLevel: "normal" | "caution" | "critical" = "normal";
  let warningText = "";
  let stage = "";

  if (crudePrice >= AVIATION_THRESHOLDS.crudeCriticalPerBbl) {
    warningLevel = "caution";
    warningText = `内盘原油 ¥${crudePrice.toFixed(1)}/桶突破 ¥${AVIATION_THRESHOLDS.crudeCriticalPerBbl} 高压线，航油成本高企，靠高客座率与人民币升值对冲。`;
    stage = "景气上行·成本承压";
  } else if (crudePrice >= AVIATION_THRESHOLDS.crudeWarningPerBbl) {
    warningLevel = "caution";
    warningText = `内盘原油 ¥${crudePrice.toFixed(1)}/桶处于偏高区间，燃油附加费分担部分航油成本压力。`;
    stage = "客流复苏·成本顺价";
  } else {
    warningLevel = "normal";
    warningText = `原油 ¥${crudePrice.toFixed(1)}/桶运行温和，叠加 USD/CNY ${fxRate.toFixed(2)} 与客座率 ${loadFactor.toFixed(1)}%，行业盈利环境良好。`;
    stage = "油汇共振·景气释放";
  }

  const headline = `民航客座率 ${loadFactor.toFixed(1)}% 处高景气区，原油 ¥${crudePrice.toFixed(0)}/桶${
    crudePrice >= AVIATION_THRESHOLDS.crudeWarningPerBbl ? "成本偏高" : "温和让利"
  }，汇率 ${fxRate.toFixed(2)} 释放汇兑红利。`;

  const bullets = [
    {
      dimension: "航油与能源",
      assessment: `上期原油 ¥${crudePrice.toFixed(1)}/桶、低硫燃料油 ¥${fuelPrice.toFixed(0)}/吨，${
        crudePrice >= AVIATION_THRESHOLDS.crudeWarningPerBbl
          ? "航油成本处偏高水位，需依赖燃油附加费与国际线高周转消化"
          : "航油成本温和，打开航司单位座公里毛利空间"
      }。`,
    },
    {
      dimension: "汇率与负债",
      assessment: `美元兑人民币 ${fxRate.toFixed(4)}（${fxRate <= AVIATION_THRESHOLDS.fxAppreciationFloor ? "升值红利区" : "中性区间"}），减轻三大航美元飞机租赁负债并提振出境游需求。`,
    },
    {
      dimension: "基地与同业",
      assessment: `上海机场 ¥${airportPrice.toFixed(2)}，国航 ¥${airChinaPrice.toFixed(2)}、南航 ¥${csaPrice.toFixed(2)}、春秋 ¥${springPrice.toFixed(2)}，浦东虹桥枢纽国际客流持续改善。`,
    },
    {
      dimension: "客座与东航",
      assessment: `行业正班客座率 ${loadFactor.toFixed(1)}%（超保本线 ${(loadFactor - AVIATION_THRESHOLDS.loadFactorBreakevenPct).toFixed(1)}pct），东航 ¥${ceaPrice.toFixed(2)}/股受益于华东日韩欧美航线修复。`,
    },
  ];

  return {
    stage,
    headline,
    warningLevel,
    warningText,
    bullets,
    etfGuidance: computeCea600115Guidance(quotes),
    analyzedAt: new Date().toISOString(),
    source: "rules",
  };
}

export async function generateAviationAnalysis(quotes: MarketQuote[]): Promise<PorkMarketAnalysis> {
  if (process.env.MODEL_CALLS_ENABLED !== "true") {
    return computeRuleBasedAviationAnalysis(quotes);
  }

  try {
    const aviationQuotes = quotes.filter((q) => q.category === "aviation");
    if (aviationQuotes.length === 0) return computeRuleBasedAviationAnalysis(quotes);

    const latestDay = aviationQuotes.map((q) => q.day).sort().at(-1) ?? beijingDate(new Date());
    const ceaQ = aviationQuotes.find((q) => q.symbol === "cea_600115");
    const baseCeaGuidance = computeCea600115Guidance(quotes);

    const contextLines = aviationQuotes.map((q) => {
      const ch1w = q.change1w !== null && q.change1w !== undefined ? `${(q.change1w * 100).toFixed(2)}%` : "无";
      const ch1m = q.change1m !== null ? `${(q.change1m * 100).toFixed(2)}%` : "无";
      const bench = q.benchmark ?? computeAviationBenchmark(q, aviationQuotes);
      return `- ${q.name} (${q.symbol}, 统计日 ${q.day}): 最新 ${q.price} ${q.unit}, 周环比: ${ch1w}, 近30日: ${ch1m}, 行业锚点: ${bench.anchorText}${bench.anchorSub ? ` (${bench.anchorSub})` : ""}, 状态: ${bench.statusBadge}`;
    });

    const systemPrompt = `你是一位精通中国民航业周期、航油与汇率敏感度分析的首席交通运输行业分析师。
请严格基于最新监测数据与以下2026年行业基准进行航空业全产业链深度研判及 8 大指标逐项解读：
1. 航油成本基准：航油占航司营业成本约 35%，上期原油（SC0）舒适线 ¥${AVIATION_THRESHOLDS.crudeComfortPerBbl}/桶，偏高警戒线 ¥${AVIATION_THRESHOLDS.crudeWarningPerBbl}/桶，高压线 ¥${AVIATION_THRESHOLDS.crudeCriticalPerBbl}/桶。
2. 人民币汇率基准：USD/CNY 低于 ${AVIATION_THRESHOLDS.fxAppreciationFloor} 为升值汇兑红利区，高于 ${AVIATION_THRESHOLDS.fxNeutralCeil} 为外币负债承压区。
3. 客座率基准：中国民航局正班客座率保本线 ${AVIATION_THRESHOLDS.loadFactorBreakevenPct}%，高景气提价线 ${AVIATION_THRESHOLDS.loadFactorHighPct}%。

严格只输出一个合法 JSON 对象，字段名完全一致：
{
  "stage": "航空周期阶段判定（格式统一为：四字·四字，如 景气上行·成本承压）",
  "headline": "核心结论（1句话，35字以内，含客座率与油汇环境核心驱动）",
  "warningLevel": "normal 或 caution 或 critical",
  "warningText": "油汇成本与景气预警说明（40字以内）",
  "bullets": [
    { "dimension": "航油与能源", "assessment": "深入分析上期原油与低硫燃料油价格走势、裂解价差、国内燃油附加费征收档位及对航司单位成本的挤压或让利程度（65~90字）" },
    { "dimension": "汇率与负债", "assessment": "深入分析美元兑人民币离岸与在岸走势、三大航美元租赁负债汇兑损益弹性及对出境国际航线购买力的催化（65~90字）" },
    { "dimension": "基地与同业", "assessment": "深入分析上海机场枢纽免税与国际客流恢复、中国国航/南方航空/春秋航空股价动量分化及三大航与低成本航司比价关系（65~90字）" },
    { "dimension": "客座与东航", "assessment": "深入分析民航正班客座率超保本线幅度、长三角商务与日韩欧美国际线票价弹性及对中国东航单机盈利修复的驱动（65~90字）" }
  ],
  "indicatorInsights": [
    { "symbol": "ine_crude", "badge": "4~6字状态", "tone": "caution", "comment": "针对上期原油价格、燃油附加费对冲比例与航油成本压力的AI点评（24~38字）" },
    { "symbol": "fuel_futures", "badge": "4~6字状态", "tone": "caution", "comment": "针对低硫燃料油价格、亚太炼化裂解价差与航油出厂价传导的AI点评（24~38字）" },
    { "symbol": "fx_usdcny", "badge": "4~6字状态", "tone": "positive", "comment": "针对美元兑人民币汇率走势、美元负债汇兑收益与外采购成本的AI点评（24~38字）" },
    { "symbol": "sh_airport", "badge": "4~6字状态", "tone": "neutral", "comment": "针对上海机场走势、浦东虹桥国际航班量恢复与东航主基地协同的AI点评（24~38字）" },
    { "symbol": "air_china", "badge": "4~6字状态", "tone": "neutral", "comment": "针对中国国航股价表现、欧美远程国际线恢复与三大航估值锚的AI点评（24~38字）" },
    { "symbol": "csa_600029", "badge": "4~6字状态", "tone": "neutral", "comment": "针对南方航空股价表现、国内干线客流弹性与货运协同的AI点评（24~38字）" },
    { "symbol": "spring_air", "badge": "4~6字状态", "tone": "accent", "comment": "针对春秋航空股价表现、廉航高客座率成本管控与板块领先意义的AI点评（24~38字）" },
    { "symbol": "cea_hk00670", "badge": "4~6字状态", "tone": "positive", "comment": "针对东航H股走势、离岸外资定价动量与东航A/H溢价率安全垫的AI点评（24~38字）" },
    { "symbol": "caac_load_factor", "badge": "4~6字状态", "tone": "positive", "comment": "针对民航局正班客座率、供需缺口及票价顺价能力的AI点评（24~38字）" }
  ]
}
注意：字符串内容内部严禁使用英文双引号（"），如需引号请使用中文引号（「」或“”）。`;

    const userPrompt = `最新航空业核心指标监测数据（基准日 ${latestDay}）：\n${contextLines.join("\n")}\n\n请生成航空业四维深度研判与 8 项指标逐项 AI 解读 JSON。`;

    const ceaSystemPrompt = `你是一位专精于 A 股航空运输板块与中国东航（600115.SH）长期持有及两段式网格降成本的证券策略师。
请结合航空周期基本面（80%权重：航油成本弹性、人民币汇率汇兑红利、民航高客座率与上海两场枢纽复苏）与中国东航（600115）日线技术面，为投资者撰写周期解读文字。
注意：本系统采用「核心底仓不动 + 常规区5%间距×400股（覆盖无免五最低5元佣金）+ 大跌区7%间距 + 下跌绝不设技术破位止损」纪律，AI 只负责撰写解读文字，严禁改动系统既定网格价位与股数，严禁建议跌破均线割肉或追高。
严格只输出一个合法 JSON 对象，字段名完全一致：
{
  "actionLabel": "${baseCeaGuidance.actionLabel}",
  "actionTone": "${baseCeaGuidance.actionTone}",
  "score": ${baseCeaGuidance.score},
  "positionHint": "${baseCeaGuidance.positionHint}",
  "summary": "中国东航（600115）周期位置与两段式网格降本核心综述（1句话，45字以内）",
  "cycleAdvice": "中长线航空周期底仓配置深度分析（65~95字，详述油价、汇率与高客座率博弈下东航的业绩弹性与底仓长期持有依据）",
  "swingAdvice": "${baseCeaGuidance.swingAdvice}"
}`;

    const ceaUserPrompt = `中国东航（600115.SH）最新日线序列与多因子量化数据（基准日 ${latestDay}）：\n${buildTargetKlinesSummary(ceaQ, baseCeaGuidance, 2)}\n\n航空产业链背景：\n${contextLines.join("\n")}\n\n请生成中国东航（600115）专属仓位与波段操作策略 JSON。`;

    const [industrySettled, strategySettled] = await Promise.allSettled([
      chatJson({
        system: systemPrompt,
        user: userPrompt,
        schema: PorkMarketAnalysisSchema,
        temperature: 0.2,
        maxTokens: 3200,
        purpose: "aviation_analysis",
        subject: `aviation_market:${latestDay}`,
      }),
      chatJson({
        system: ceaSystemPrompt,
        user: ceaUserPrompt,
        schema: TargetAssetStrategySchema,
        temperature: 0.2,
        maxTokens: 2200,
        purpose: "aviation_stock_strategy",
        subject: `cea_600115:${latestDay}`,
      }),
    ]);

    if (industrySettled.status === "rejected") {
      throw industrySettled.reason;
    }

    const res = industrySettled.value;
    const stratRes = strategySettled.status === "fulfilled" ? strategySettled.value : null;
    const { etfStrategy, indicatorInsights: rawInsights, ...restData } = res.data;
    const etfGuidance = mergeTargetGuidance(baseCeaGuidance, stratRes?.data, etfStrategy);

    return {
      ...restData,
      indicatorInsights: normalizeIndicatorInsights(rawInsights) ?? null,
      etfGuidance,
      analyzedAt: new Date().toISOString(),
      source: "ai",
      model: res.model,
      channelId: res.channelId,
      channelHost: res.host,
      latencyMs: (res.latencyMs ?? 0) + (stratRes?.latencyMs ?? 0),
      tokensIn: (res.tokensIn ?? 0) + (stratRes?.tokensIn ?? 0),
      tokensOut: (res.tokensOut ?? 0) + (stratRes?.tokensOut ?? 0),
    };
  } catch {
    return computeRuleBasedAviationAnalysis(quotes);
  }
}

export function computeRuleBasedHstechAnalysis(
  quotes: ReadonlyArray<Pick<MarketQuote, "symbol" | "price"> & Partial<MarketQuote>>,
): PorkMarketAnalysis {
  const getQ = (sym: string) => quotes.find((q) => q.symbol === sym);

  const idxQ = getQ("hstech_index");
  const fxQ = getQ("hstech_fx") ?? getQ("fx_usdcny");
  const tencentQ = getQ("hk_00700");
  const babaQ = getQ("hk_09988");
  const meituanQ = getQ("hk_03690");
  const jdQ = getQ("hk_09618");
  const xiaomiQ = getQ("hk_01810");
  const kuaishouQ = getQ("hk_01024");
  const smicQ = getQ("hk_00981");
  const etfQ = getQ("etf_513180");

  const idxPrice = idxQ?.price ?? 3867.73;
  const fxRate = fxQ?.price ?? 6.672;
  const tencentPrice = tencentQ?.price ?? 397.2;
  const babaPrice = babaQ?.price ?? 99.55;
  const meituanPrice = meituanQ?.price ?? 74.35;
  const jdPrice = jdQ?.price ?? 107.3;
  const xiaomiPrice = xiaomiQ?.price ?? 28.6;
  const kuaishouPrice = kuaishouQ?.price ?? 46.5;
  const smicPrice = smicQ?.price ?? 42.62;
  const etfPrice = etfQ?.price ?? 0.481;

  let warningLevel: "normal" | "caution" | "critical" = "normal";
  let warningText = "";
  let stage = "";

  if (idxPrice <= HSTECH_THRESHOLDS.indexDeepValue) {
    warningLevel = "normal";
    warningText = `恒生科技指数 ${idxPrice.toFixed(0)} 点处于深度折价区，龙头回购与低估值构成强安全垫。`;
    stage = "深度低估·回购筑底";
  } else if (idxPrice <= HSTECH_THRESHOLDS.indexPivot) {
    warningLevel = "normal";
    warningText = `恒生科技指数 ${idxPrice.toFixed(0)} 点位于 ${HSTECH_THRESHOLDS.indexPivot} 点中枢下方，叠加 USD/CNY ${fxRate.toFixed(2)} 顺风，处估值修复窗口。`;
    stage = "低估修复·盈利验证";
  } else if (idxPrice <= HSTECH_THRESHOLDS.indexOverheat) {
    warningLevel = "normal";
    warningText = `恒生科技指数 ${idxPrice.toFixed(0)} 点站上中枢均衡区，由 AI 商业化与季报业绩驱动。`;
    stage = "中枢整固·业绩兑现";
  } else {
    warningLevel = "caution";
    warningText = `恒生科技指数突破 ${HSTECH_THRESHOLDS.indexOverheat} 点高热度区，注意离岸资金短线获利波动。`;
    stage = "情绪高涨·波动放大";
  }

  const headline = `恒生科技指数 ${idxPrice.toFixed(0)} 点处${
    idxPrice <= HSTECH_THRESHOLDS.indexPivot ? "低估修复区" : "中枢均衡区"
  }，汇率 ${fxRate.toFixed(2)} 提供流动性顺风，腾讯阿里千亿回购托底。`;

  const bullets = [
    {
      dimension: "指数与流动性",
      assessment: `恒科指 ${idxPrice.toFixed(0)} 点（价值中枢 ${HSTECH_THRESHOLDS.indexPivot}），USD/CNY ${fxRate.toFixed(4)} 处强势区间，增厚人民币资产折算港元估值。`,
    },
    {
      dimension: "社交与电商",
      assessment: `腾讯 HK$${tencentPrice.toFixed(1)}、阿里 HK$${babaPrice.toFixed(2)}、京东 HK$${jdPrice.toFixed(1)}，核心互联网平台高现金流与持续注销式回购锁定下行底线。`,
    },
    {
      dimension: "消费与本地生活",
      assessment: `美团 HK$${meituanPrice.toFixed(2)}、快手 HK$${kuaishouPrice.toFixed(2)}（可灵AI+直播电商），高频外卖到店与短视频商业化直接映射内需复苏与AI应用变现斜率。`,
    },
    {
      dimension: "AI硬件与算力",
      assessment: `小米 HK$${xiaomiPrice.toFixed(2)}（人车家生态）、中芯国际 HK$${smicPrice.toFixed(2)}（国产晶圆代工），提供端侧 AI 与国产算力高弹性催化。`,
    },
  ];

  return {
    stage,
    headline,
    warningLevel,
    warningText,
    bullets,
    etfGuidance: computeEtf513180Guidance(quotes),
    analyzedAt: new Date().toISOString(),
    source: "rules",
  };
}

export async function generateHstechAnalysis(quotes: MarketQuote[]): Promise<PorkMarketAnalysis> {
  if (process.env.MODEL_CALLS_ENABLED !== "true") {
    return computeRuleBasedHstechAnalysis(quotes);
  }

  try {
    const hstechQuotes = quotes.filter((q) => q.category === "hstech");
    if (hstechQuotes.length === 0) return computeRuleBasedHstechAnalysis(quotes);

    const latestDay = hstechQuotes.map((q) => q.day).sort().at(-1) ?? beijingDate(new Date());
    const etfQ = hstechQuotes.find((q) => q.symbol === "etf_513180");
    const baseGuidance = computeEtf513180Guidance(quotes);

    const contextLines = hstechQuotes.map((q) => {
      const ch1w = q.change1w !== null && q.change1w !== undefined ? `${(q.change1w * 100).toFixed(2)}%` : "无";
      const ch1m = q.change1m !== null ? `${(q.change1m * 100).toFixed(2)}%` : "无";
      const bench = q.benchmark ?? computeHstechBenchmark(q, hstechQuotes);
      return `- ${q.name} (${q.symbol}, 统计日 ${q.day}): 最新 ${q.price} ${q.unit}, 周环比: ${ch1w}, 近30日: ${ch1m}, 行业锚点: ${bench.anchorText}${bench.anchorSub ? ` (${bench.anchorSub})` : ""}, 状态: ${bench.statusBadge}`;
    });

    const systemPrompt = `你是一位精通港股恒生科技指数、离岸美元/人民币流动性、中国互联网平台经济与AI硬件算力产业链的首席海外科技分析师。
请严格基于最新监测数据与以下2026年基准进行恒生科技全产业链深度研判及 8 大核心指标逐项解读：
1. 指数估值基准：恒生科技指数深度价值线 ${HSTECH_THRESHOLDS.indexDeepValue} 点，价值均衡中枢 ${HSTECH_THRESHOLDS.indexPivot} 点，情绪高热线 ${HSTECH_THRESHOLDS.indexOverheat} 点。
2. 汇率与流动性基准：USD/CNY 低于 ${HSTECH_THRESHOLDS.fxInflowFloor} 为外资回流与人民币资产重估顺风区，高于 ${HSTECH_THRESHOLDS.fxPressureCeil} 为离岸流动性承压区。

严格只输出一个合法 JSON 对象，字段名完全一致：
{
  "stage": "恒生科技阶段判定（格式统一为：四字·四字，如 深度低估·回购筑底）",
  "headline": "核心结论（1句话，35字以内，含指数点位与汇率流动性核心驱动）",
  "warningLevel": "normal 或 caution 或 critical",
  "warningText": "估值与离岸流动性说明（40字以内）",
  "bullets": [
    { "dimension": "指数与流动性", "assessment": "深入分析恒生科技指数点位较价值中枢折价幅度、USD/CNY汇率走势及外资与南向港股通资金共振环境（65~90字）" },
    { "dimension": "社交与电商", "assessment": "深入分析腾讯控股、阿里巴巴、京东集团的股价超额表现、千亿级回购注销股东回报率及云计算/电商盈利修复进展（65~90字）" },
    { "dimension": "消费与本地生活", "assessment": "深入分析美团核心本地商业壁垒、高频外卖与到店酒旅利润率弹性及相对恒科指的Alpha超额动量（65~90字）" },
    { "dimension": "AI硬件与算力", "assessment": "深入分析小米集团人车家生态与端侧AI落地、中芯国际国产算力晶圆代工景气度及硬科技双子星对指数的弹性贡献（65~90字）" }
  ],
  "indicatorInsights": [
    { "symbol": "hstech_index", "badge": "4~6字状态", "tone": "positive", "comment": "针对恒生科技指数点位、历史估值分位与风险溢价赔率的AI深度点评（24~38字）" },
    { "symbol": "hstech_fx", "badge": "4~6字状态", "tone": "positive", "comment": "针对美元兑人民币汇率、离岸资金流向与港元计价中资股EPS折算的AI点评（24~38字）" },
    { "symbol": "hk_00700", "badge": "4~6字状态", "tone": "accent", "comment": "针对腾讯控股股价走势、千亿注销式回购及游戏广告毛利弹性的AI点评（24~38字）" },
    { "symbol": "hk_09988", "badge": "4~6字状态", "tone": "positive", "comment": "针对阿里巴巴股价走势、港股通南向资金配置、阿里云AI与高回购的AI点评（24~38字）" },
    { "symbol": "hk_03690", "badge": "4~6字状态", "tone": "accent", "comment": "针对美团股价超额收益、即时零售盈利能力与服务消费复苏弹性的AI点评（24~38字）" },
    { "symbol": "hk_09618", "badge": "4~6字状态", "tone": "neutral", "comment": "针对京东集团股价表现、家电以旧换新拉动及低PE高股息安全垫的AI点评（24~38字）" },
    { "symbol": "hk_01810", "badge": "4~6字状态", "tone": "accent", "comment": "针对小米集团股价表现、智能电动汽车交付毛利与端侧AI催化的AI点评（24~38字）" },
    { "symbol": "hk_01024", "badge": "4~6字状态", "tone": "accent", "comment": "针对快手股价表现、可灵AI视频大模型商业化与直播电商GMV弹性的AI点评（24~38字）" },
    { "symbol": "hk_00981", "badge": "4~6字状态", "tone": "caution", "comment": "针对中芯国际股价表现、先进制程稼动率与国产算力替代逻辑的AI点评（24~38字）" }
  ]
}
注意：字符串内容内部严禁使用英文双引号（"），如需引号请使用中文引号（「」或“”）。`;

    const userPrompt = `最新恒生科技核心成分股与宏观监测数据（基准日 ${latestDay}）：\n${contextLines.join("\n")}\n\n请生成恒生科技四维深度研判与 8 项核心指标逐项 AI 解读 JSON。`;

    const etfSystemPrompt = `你是一位专精于港股科技板块与恒生科技场外联接基金智能定投的基金策略师。
请结合恒生科技基本面（80%权重：指数估值赔率、离岸汇率流动性、六大核心权重股共振）与 513180 日线技术面，为投资者撰写定投解读文字。
注意：本系统针对场外恒生科技基金采用「按持仓盈亏偏离度分档定投（当前浮亏-13%对应120元/天）+ 大跌单笔加仓1000元（单周跌>8%或破¥0.468）+ 浮盈>25%分批止盈回流加码池」策略，不做短线网格，绝不在亏损区赎回。AI 只写解读文字，严禁改动定投金额与触发价位。
严格只输出一个合法 JSON 对象，字段名完全一致：
{
  "actionLabel": "${baseGuidance.actionLabel}",
  "actionTone": "${baseGuidance.actionTone}",
  "score": ${baseGuidance.score},
  "positionHint": "${baseGuidance.positionHint}",
  "summary": "恒生科技估值位置与场外智能分档定投核心综述（1句话，45字以内）",
  "cycleAdvice": "中长线港股科技定投配置深度分析（65~95字，详述指数估值点位、龙头回购托底与离岸汇率环境下为何坚持低位加档定投摊薄成本）",
  "swingAdvice": "${baseGuidance.swingAdvice}"
}`;

    const etfUserPrompt = `恒生科技ETF（513180.SH）最新日线序列与多因子量化数据（基准日 ${latestDay}）：\n${buildTargetKlinesSummary(etfQ, baseGuidance, 3)}\n\n恒生科技板块与成分股背景：\n${contextLines.join("\n")}\n\n请生成恒生科技ETF（513180）专属仓位与 T+0 波段操作策略 JSON。`;

    const [industrySettled, strategySettled] = await Promise.allSettled([
      chatJson({
        system: systemPrompt,
        user: userPrompt,
        schema: PorkMarketAnalysisSchema,
        temperature: 0.2,
        maxTokens: 3200,
        purpose: "hstech_analysis",
        subject: `hstech_market:${latestDay}`,
      }),
      chatJson({
        system: etfSystemPrompt,
        user: etfUserPrompt,
        schema: TargetAssetStrategySchema,
        temperature: 0.2,
        maxTokens: 2200,
        purpose: "hstech_etf_strategy",
        subject: `etf_513180:${latestDay}`,
      }),
    ]);

    if (industrySettled.status === "rejected") {
      throw industrySettled.reason;
    }

    const res = industrySettled.value;
    const stratRes = strategySettled.status === "fulfilled" ? strategySettled.value : null;
    const { etfStrategy, indicatorInsights: rawInsights, ...restData } = res.data;
    const etfGuidance = mergeTargetGuidance(baseGuidance, stratRes?.data, etfStrategy);

    return {
      ...restData,
      indicatorInsights: normalizeIndicatorInsights(rawInsights) ?? null,
      etfGuidance,
      analyzedAt: new Date().toISOString(),
      source: "ai",
      model: res.model,
      channelId: res.channelId,
      channelHost: res.host,
      latencyMs: (res.latencyMs ?? 0) + (stratRes?.latencyMs ?? 0),
      tokensIn: (res.tokensIn ?? 0) + (stratRes?.tokensIn ?? 0),
      tokensOut: (res.tokensOut ?? 0) + (stratRes?.tokensOut ?? 0),
    };
  } catch {
    return computeRuleBasedHstechAnalysis(quotes);
  }
}

/** Each instrument's latest close, its changes over 1 trading day, 7, 30 and 60 calendar days, weekly trend series, unified benchmark, and consolidated analysis. */
export async function readMarkets(opts?: { skipAnalysis?: boolean }): Promise<MarketsAnswer> {
  const rows = getRecentCloses(91);
  const usdCnyRate = getLatestClose("usdcny");

  const change = (latest: number, before: { close: number } | undefined) => (before ? latest / before.close - 1 : null);

  const rawQuotes: MarketQuote[] = INSTRUMENTS.flatMap(({
    symbol, name, category, session, currency, unit, cnyUnit, scale, note, segment, horizon, statFrequency, statSourceLabel,
  }) => {
    const own = rows.filter((r) => r.symbol === symbol);
    if (own.length === 0) return [];
    const latest = own.at(-1)!;
    const yesterday = own.length >= 2 ? own.at(-2) : undefined;
    const target1w = addDays(latest.day, -7);
    const target1m = addDays(latest.day, -DAYS_1M);
    const target2m = addDays(latest.day, -DAYS_2M);
    const oneWeek = own.filter((r) => r.day <= target1w).at(-1);
    const oneMonth = own.filter((r) => r.day <= target1m).at(-1);
    const twoMonths = own.filter((r) => r.day <= target2m).at(-1);

    let cnyPrice: number | null = null;
    if (symbol === "xau" && usdCnyRate !== null) {
      // Gold: USD/oz t converted to CNY/gram
      cnyPrice = (latest.close * usdCnyRate) / GRAMS_PER_TROY_OUNCE;
    } else if (scale && cnyUnit !== null) {
      cnyPrice = latest.close * scale;
    }

    const isPeriodic = session === "spot-periodic" || statFrequency === "quarterly";
    const startDay = twoMonths ? twoMonths.day : target2m;
    const toPoint = (r: { day: string; close: number; high?: number | null; low?: number | null; volume?: number | null }) => ({
      day: r.day,
      close: r.close,
      ...(r.high != null ? { high: r.high } : {}),
      ...(r.low != null ? { low: r.low } : {}),
      ...(r.volume != null ? { volume: r.volume } : {}),
    });
    const series = isPeriodic
      ? own.map(toPoint)
      : own.filter((r) => r.day >= startDay).map(toPoint);

    const weeklySeries = category === "pork" || category === "aviation" || category === "hstech"
      ? buildWeeklyTrendSeries(own, statFrequency ?? "daily")
      : undefined;

    return [{
      symbol, name, category, currency, unit, cnyUnit,
      price: latest.close, day: latest.day,
      cnyPrice,
      closeYesterday: yesterday?.close ?? null, changeYesterday: change(latest.close, yesterday),
      close1w: oneWeek?.close ?? null, change1w: change(latest.close, oneWeek),
      close1m: oneMonth?.close ?? null, change1m: change(latest.close, oneMonth),
      close2m: twoMonths?.close ?? null, change2m: change(latest.close, twoMonths),
      series,
      note: note ?? null,
      segment: segment ?? undefined,
      horizon: horizon ?? undefined,
      statFrequency: statFrequency ?? undefined,
      statSourceLabel: statSourceLabel ?? undefined,
      weeklySeries,
    }];
  });

  const quotes: MarketQuote[] = rawQuotes.map((q) => {
    if (q.category === "pork") return { ...q, benchmark: computePorkBenchmark(q, rawQuotes) };
    if (q.category === "aviation") return { ...q, benchmark: computeAviationBenchmark(q, rawQuotes) };
    if (q.category === "hstech") return { ...q, benchmark: computeHstechBenchmark(q, rawQuotes) };
    return q;
  });

  let analysis: PorkMarketAnalysis | null = null;
  let aviationAnalysis: PorkMarketAnalysis | null = null;
  let hstechAnalysis: PorkMarketAnalysis | null = null;
  if (!opts?.skipAnalysis) {
    const recentCalls = getLlmCallsSince(null, 50);
    const channels = loadChannels();
    const enrichAiMeta = (item: PorkMarketAnalysis, sectorPrefix: string, purposeKey: string): PorkMarketAnalysis => {
      if (item.source !== "ai" || item.model) return item;
      const call = recentCalls.find(
        (r) => r.status === "completed" && (r.purpose === purposeKey || r.subject?.startsWith(sectorPrefix)),
      );
      if (call) {
        const ch = channels.find((c) => c.id === call.channel_id);
        return {
          ...item,
          model: call.model ?? ch?.model ?? null,
          channelId: call.channel_id ?? ch?.id ?? null,
          channelHost: ch?.host ?? null,
          latencyMs: call.latency_ms ?? null,
          tokensIn: call.tokens_in ?? null,
          tokensOut: call.tokens_out ?? null,
        };
      }
      const primary = channels[0];
      if (primary) {
        return {
          ...item,
          model: primary.model,
          channelId: primary.id,
          channelHost: primary.host,
        };
      }
      return item;
    };

    const todayStr = beijingDate(new Date());

    const liveEtfGuidance = computeEtf516670Guidance(quotes);
    if (liveEtfGuidance.positionPlan) {
      const frozen = getDailyFrozenPlan("etf_516670", todayStr);
      if (frozen) {
        liveEtfGuidance.positionPlan.actionPoints = frozen.actionPoints;
        liveEtfGuidance.positionPlan.frozenDate = todayStr;
      } else {
        liveEtfGuidance.positionPlan.frozenDate = todayStr;
        setDailyFrozenPlan("etf_516670", todayStr, liveEtfGuidance.positionPlan);
      }
    }

    try {
      const stored = getStoredAnalysis("markets.pork_analysis");
      if (stored) {
        const storedEtf = stored.etfGuidance;
        const hasV3Plan = Boolean(storedEtf?.positionPlan);
        analysis = enrichAiMeta(
          {
            ...stored,
            etfGuidance: {
              ...liveEtfGuidance,
              cycleAdvice: hasV3Plan && storedEtf?.cycleAdvice ? storedEtf.cycleAdvice : liveEtfGuidance.cycleAdvice,
            },
          },
          "pork",
          "pork_analysis",
        );
      } else {
        analysis = computeRuleBasedPorkAnalysis(quotes);
      }
    } catch {
      analysis = computeRuleBasedPorkAnalysis(quotes);
    }

    const liveCeaGuidance = computeCea600115Guidance(quotes);
    if (liveCeaGuidance.positionPlan) {
      const frozen = getDailyFrozenPlan("cea_600115", todayStr);
      if (frozen) {
        liveCeaGuidance.positionPlan.actionPoints = frozen.actionPoints;
        liveCeaGuidance.positionPlan.frozenDate = todayStr;
      } else {
        liveCeaGuidance.positionPlan.frozenDate = todayStr;
        setDailyFrozenPlan("cea_600115", todayStr, liveCeaGuidance.positionPlan);
      }
    }

    try {
      const storedAv = getStoredAnalysis("markets.aviation_analysis");
      if (storedAv) {
        const storedCea = storedAv.etfGuidance;
        const hasV3Plan = Boolean(storedCea?.positionPlan);
        aviationAnalysis = enrichAiMeta(
          {
            ...storedAv,
            etfGuidance: {
              ...liveCeaGuidance,
              cycleAdvice: hasV3Plan && storedCea?.cycleAdvice ? storedCea.cycleAdvice : liveCeaGuidance.cycleAdvice,
            },
          },
          "aviation",
          "aviation_analysis",
        );
      } else {
        aviationAnalysis = computeRuleBasedAviationAnalysis(quotes);
      }
    } catch {
      aviationAnalysis = computeRuleBasedAviationAnalysis(quotes);
    }

    const liveHstechGuidance = computeEtf513180Guidance(quotes);
    if (liveHstechGuidance.positionPlan) {
      const frozen = getDailyFrozenPlan("etf_513180", todayStr);
      if (frozen) {
        liveHstechGuidance.positionPlan.frozenDate = todayStr;
      } else {
        liveHstechGuidance.positionPlan.frozenDate = todayStr;
        setDailyFrozenPlan("etf_513180", todayStr, liveHstechGuidance.positionPlan);
      }
    }

    try {
      const storedHs = getStoredAnalysis("markets.hstech_analysis");
      if (storedHs) {
        const storedEtf = storedHs.etfGuidance;
        const hasV3Plan = Boolean(storedEtf?.positionPlan);
        hstechAnalysis = enrichAiMeta(
          {
            ...storedHs,
            etfGuidance: {
              ...liveHstechGuidance,
              cycleAdvice: hasV3Plan && storedEtf?.cycleAdvice ? storedEtf.cycleAdvice : liveHstechGuidance.cycleAdvice,
            },
          },
          "hstech",
          "hstech_analysis",
        );
      } else {
        hstechAnalysis = computeRuleBasedHstechAnalysis(quotes);
      }
    } catch {
      hstechAnalysis = computeRuleBasedHstechAnalysis(quotes);
    }
  }

  let potentialFunds = null;
  if (!opts?.skipAnalysis) {
    try {
      potentialFunds = await readPotentialFundsOverview(opts?.skipAnalysis);
    } catch {
      // Non-blocking fallback
    }
  }

  return { quotes, usdCnyRate, analysis, aviationAnalysis, hstechAnalysis, potentialFunds };
}

/** Daily closes older than half a year are past what the page reads; quarterly capacity rows keep 3 years (ops.retention). */
export async function pruneMarkets(now: Date): Promise<Record<string, number>> {
  const periodicSymbols = INSTRUMENTS.filter((i) => i.session === "spot-periodic").map((i) => i.symbol);
  const cutoffDaily = addDays(beijingDate(now), -180);
  const cutoffPeriodic = addDays(beijingDate(now), -1095);
  const deleted = pruneStoredCloses(cutoffDaily, cutoffPeriodic, periodicSymbols);
  return { marketCloses: deleted };
}
