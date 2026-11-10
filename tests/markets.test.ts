// The markets page: what is read when, what is kept, and the changes and benchmarks its panels show.
process.env.MARKETS_DB_PATH = ":memory:";
process.env.MODEL_CALLS_ENABLED = "false";

import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import {
  clearDb,
  closeDb,
  countClosesBySymbol,
  getDailyFrozenPlan,
  getDistinctSymbols,
  getStoredAnalysis,
  insertLlmCall,
  setDailyFrozenPlan,
  setStoredAnalysis,
} from "../src/server/db.ts";
import {
  evaluateDcaLumpSumRules,
  evaluateGridActionPointRules,
  getIntradaySessionPhase,
  parseTencentQuotes,
  reviewIntradayWithAi,
} from "../src/server/intraday.ts";
import {
  getChannelsOverview,
  loadChannels,
  recordChannelFailure,
  resetChannelState,
  updateChannelQuotaInfo,
} from "../src/server/lib/llm.ts";
import { addDays } from "../src/shared/time.ts";
import {
  compute513180PositionPlan,
  compute516670PositionPlan,
  compute600115PositionPlan,
  extractTechnicalStats,
  recordPositionSnapshot,
  removePositionSnapshot,
} from "../src/server/position.ts";
import {
  buildWeeklyTrendSeries,
  computeAviationBenchmark,
  computeCea600115Guidance,
  computeEtf513180Guidance,
  computeEtf516670Guidance,
  computeHogProfitMetrics,
  computeHstechBenchmark,
  computePigGrainSeries,
  computePorkBenchmark,
  computeRuleBasedAviationAnalysis,
  computeRuleBasedHstechAnalysis,
  computeRuleBasedPorkAnalysis,
  despikeDailySeries,
  GRAMS_PER_TROY_OUNCE,
  INSTRUMENTS,
  inSession,
  normalizeDay,
  parseKlines,
  parseMoaFarmDailyPork,
  parseZhuePriceCure,
  PORK_THRESHOLDS,
  pruneMarkets,
  readMarkets,
  refreshAviationDaily,
  refreshHstechDaily,
  refreshMacroMarkets,
  refreshMarkets,
  refreshPorkDaily,
  type FetchCloses,
  type FetchRate,
} from "../src/server/quotes.ts";
import type { MarketQuote } from "../src/shared/types.ts";

after(() => closeDb());
beforeEach(() => clearDb());

/** `count` closes on consecutive days ending 2026-10-28, the last one `last`, every earlier one 100 + its index. */
const closes = (count: number, last: number) =>
  Array.from({ length: count }, (_, i) => ({ day: addDays("2026-10-28", i - count + 1), close: i === count - 1 ? last : 100 + i }));

const stubRate: FetchRate = async () => 7.0;

test("each market is read only while it trades, Beijing time, wherever the machine runs", () => {
  const at = (iso: string) => new Date(iso);
  assert.equal(inSession("a-share", at("2026-10-28T10:00:00+08:00")), true);
  assert.equal(inSession("a-share", at("2026-10-28T12:00:00+08:00")), false, "lunch break");
  assert.equal(inSession("a-share", at("2026-10-28T15:10:00+08:00")), true, "the final close");
  assert.equal(inSession("a-share", at("2026-10-31T10:00:00+08:00")), false, "Saturday");
  assert.equal(inSession("hk", at("2026-10-28T10:00:00+08:00")), true);
  assert.equal(inSession("hk", at("2026-10-28T12:00:00+08:00")), true, "trading until 12:00");
  assert.equal(inSession("hk", at("2026-10-28T12:30:00+08:00")), false, "HK lunch break");
  assert.equal(inSession("hk", at("2026-10-28T16:05:00+08:00")), true, "closing auction");
  assert.equal(inSession("hk", at("2026-10-28T16:20:00+08:00")), true, "post-close window for 16:08–16:10 closing auction");
  assert.equal(inSession("hk", at("2026-10-28T16:40:00+08:00")), false, "after HK close");
  assert.equal(inSession("hk", at("2026-10-31T10:00:00+08:00")), false, "Saturday");
  assert.equal(inSession("domestic-futures", at("2026-10-28T10:00:00+08:00")), true);
  assert.equal(inSession("domestic-futures", at("2026-10-28T12:00:00+08:00")), false, "lunch break");
  assert.equal(inSession("domestic-futures", at("2026-10-28T14:30:00+08:00")), true, "afternoon session");
  assert.equal(inSession("domestic-futures", at("2026-10-31T10:00:00+08:00")), false, "Saturday");
  assert.equal(inSession("spot-daily", at("2026-10-28T10:00:00+08:00")), true);
  assert.equal(inSession("spot-daily", at("2026-10-28T22:00:00+08:00")), false, "night");
  assert.equal(inSession("spot-daily", at("2026-10-31T10:00:00+08:00")), false, "Saturday outside business hours");
  assert.equal(inSession("global", at("2026-10-28T03:00:00+08:00")), true);
  assert.equal(inSession("global", at("2026-10-31T06:50:00+08:00")), true, "Friday's New York session ends Saturday morning");
  assert.equal(inSession("global", at("2026-10-31T12:00:00+08:00")), false);
  assert.equal(inSession("global", at("2026-11-01T12:00:00+08:00")), false, "Sunday");
  assert.equal(inSession("global", at("2026-11-02T05:00:00+08:00")), false, "before Monday's open");
});

test("Sina, Tencent, Eastmoney, Yangzhu, MOA FarmDaily, and Zhue answers parse cleanly, and broken ones fail", () => {
  // 1. Sina global & domestic futures
  assert.deepEqual(
    parseKlines([
      { date: "2026-10-27", close: "109.670" },
      { date: "2026-10-28", close: "111.360" },
    ]),
    [
      { day: "2026-10-27", close: 109.67 },
      { day: "2026-10-28", close: 111.36 },
    ],
  );
  assert.deepEqual(
    parseKlines([
      { d: "2026-10-27", c: "9550" },
      { d: "2026-10-28", c: "9505" },
    ]),
    [
      { day: "2026-10-27", close: 9550 },
      { day: "2026-10-28", close: 9505 },
    ],
  );

  // 2. Tencent A-share/HK index
  assert.deepEqual(
    parseKlines({
      data: {
        hkHSTECH: {
          day: [
            ["2026-10-27", "3886.180", "3800.430", "3907.710", "3787.560", "37648593557.000"],
            ["2026-10-28", "3829.970", "3845.620", "3876.540", "3819.710", "38023308378.000"],
          ],
          qt: {
            hkHSTECH: ["100", "恒生科技指数", "HSTECH", "3853.720", ...Array(26).fill("0"), "2026/10/28 16:08:46"],
          },
        },
      },
    }),
    [
      { day: "2026-10-27", close: 3800.43 },
      { day: "2026-10-28", close: 3853.72 },
    ],
  );

  // 2b. Tencent forward-adjusted A-share individual stock (qfqday)
  assert.deepEqual(
    parseKlines({
      data: {
        sh600115: {
          qfqday: [
            ["2026-11-02", "3.41", "3.36", "3.42", "3.35", "1800000"],
            ["2026-11-03", "3.36", "3.43", "3.47", "3.36", "3221434"],
          ],
        },
      },
    }),
    [
      { day: "2026-11-02", close: 3.36 },
      { day: "2026-11-03", close: 3.43 },
    ],
  );

  // 3. Eastmoney kline
  assert.deepEqual(
    parseKlines({
      data: {
        klines: [
          "2026-10-27,9700,9650,9750,9600,1000,1000000,1.5,1.0,100,0.0",
          "2026-10-28,9650,9500,9700,9450,1200,1200000,2.0,-1.5,-150,0.0",
        ],
      },
    }),
    [
      { day: "2026-10-27", close: 9650 },
      { day: "2026-10-28", close: 9500 },
    ],
  );

  // 4. Yangzhu hits data & daily hog-to-grain ratio calculation
  const hogHits = parseKlines({
    code: 200,
    data: [
      { pricedate: "2026-10-29", pigprice: "9.27" },
      { pricedate: "2026-10-30", pigprice: "9.19" },
    ],
  });
  const cornHits = parseKlines({
    code: 200,
    data: [
      { pricedate: "2026-10-29", maizeprice: 2340 },
      { pricedate: "2026-10-30", maizeprice: 2334 },
    ],
  });
  assert.deepEqual(computePigGrainSeries(hogHits, cornHits), [
    { day: "2026-10-29", close: 3.96 },
    { day: "2026-10-30", close: 3.94 },
  ]);

  // 5. MOA pfsc.agri.cn FarmDaily national wholesale pork reports
  assert.deepEqual(
    parseMoaFarmDailyPork({
      code: 200,
      content: {
        list: [
          {
            daylyDate: "2026-10-30 00:00:00",
            animalConclusion: "猪肉平均价格为15.29元/公斤，比昨天下降0.6%；牛肉73.44元/公斤。",
          },
          {
            daylyDate: "2026-10-29 00:00:00",
            animalConclusion: "猪肉平均价格为15.38元/公斤，比昨天下降1.3%。",
          },
        ],
      },
    }),
    [
      { day: "2026-10-29", close: 15.38 },
      { day: "2026-10-30", close: 15.29 },
    ],
  );

  // 6. Zhue pricecure reconstruction across year rollover + 15kg piglet multiplier + single-day spike filter
  const zhueParsed = parseZhuePriceCure(
    [
      {
        daystr: JSON.stringify(["12.30", "01.02", "01.05"]),
        datestr: "[{ name: '2027', data: [14.00,19.80,13.60],marker: {}},{ name: '2026', data: [20,20,20]}]",
      },
      {
        daystr: JSON.stringify(["12.31", "01.03", ""]),
        datestr: "[{ name: '2027', data: [13.90,13.70,null],marker: {}}]",
      },
      {
        daystr: JSON.stringify(["01.01", "01.04"]),
        datestr: "[{ name: '2027', data: [13.80,13.65],marker: {}}]",
      },
    ],
    { multiplier: 15 },
  );
  assert.equal(zhueParsed.length, 7);
  assert.equal(zhueParsed[0]!.day, "2026-12-30", "December dates before January wrap to previous year");
  assert.equal(zhueParsed[2]!.day, "2027-01-01");
  // 2027-01-02 had an isolated spike 19.80 between 13.80 and 13.70 -> despiked to 13.80 * 15 = 207
  const jan02 = zhueParsed.find((p) => p.day === "2027-01-02")!;
  assert.equal(jan02.close, 207);

  // Monotonic downward trend is untouched by despikeDailySeries
  const monotonic = [
    { day: "2026-10-26", close: 20 },
    { day: "2026-10-27", close: 17 },
    { day: "2026-10-28", close: 14 },
  ];
  assert.deepEqual(despikeDailySeries(monotonic), monotonic);

  // 7. Chinese period date formats
  assert.equal(normalizeDay("2026.10.30-农产品日报"), "2026-10-30");
  assert.equal(normalizeDay("2025年10月"), "2025-10-31");
  assert.equal(normalizeDay("2025年三季度（末）"), "2025-09-30");
  assert.equal(normalizeDay("2024"), "2024-12-31");

  assert.throws(() => parseKlines({ data: null }));
  assert.throws(() => parseKlines([]));
  assert.throws(() => parseKlines([{ date: "2026-10-28", close: "-" }]));
  assert.throws(() => parseMoaFarmDailyPork({ content: { list: [] } }));
});

test("each panel shows latest close, WoW/1m/2m changes, weekly trend series, unified benchmark, and converted RMB prices", async () => {
  const fetch: FetchCloses = async ({ symbol }) => {
    if (symbol === "sse" || symbol === "hstech") return closes(70, 150);
    if (symbol === "xau") return closes(70, 4000);
    if (symbol === "hog_futures") return closes(70, 9500);
    if (symbol === "corn_spot") return closes(70, 2334);
    if (symbol === "bean_spot") return closes(70, 3120);
    if (symbol === "hog_spot") return closes(70, 9.19);
    if (symbol === "pork_spot") return closes(70, 15.29);
    if (symbol === "piglet_spot") return closes(70, 205.05);
    if (symbol === "sow_spot") return closes(70, 1484.69);
    if (symbol === "pig_grain_ratio") return closes(70, 3.94);
    if (symbol === "etf_516670") {
      return Array.from({ length: 70 }, (_, i) => ({
        day: addDays("2026-10-28", i - 69),
        close: i === 69 ? 0.6 : Number((0.55 + (i % 10) * 0.005).toFixed(3)),
      }));
    }
    if (symbol === "sow_inventory") {
      return [
        { day: "2025-09-30", close: 4035 },
        { day: "2025-12-31", close: 4035 },
        { day: "2026-03-31", close: 3904 },
        { day: "2026-06-30", close: 3780 },
        { day: "2026-09-30", close: 3602 },
      ];
    }
    return closes(35, 110);
  };
  await refreshMarkets(new Date("2026-10-28T10:00:00+08:00"), fetch, stubRate);
  const { quotes, usdCnyRate, analysis } = await readMarkets();

  assert.equal(usdCnyRate, 7.0);
  assert.deepEqual(quotes.map((q) => q.symbol), INSTRUMENTS.map((i) => i.symbol));

  // 1. Brent: USD, no CNY conversion, 35 days has 1w and 1m but no 2m baseline
  const brent = quotes.find((q) => q.symbol === "brent")!;
  assert.equal(brent.category, "macro");
  assert.equal(brent.price, 110);
  assert.equal(brent.cnyPrice, null);
  assert.equal(brent.close1w, 100 + 34 - 7);
  assert.ok(Math.abs(brent.change1w! - (110 / brent.close1w! - 1)) < 1e-9);
  assert.equal(brent.close1m, 100 + 34 - 30);
  assert.equal(brent.close2m, null);
  assert.equal(brent.benchmark, undefined, "macro quotes do not carry pork benchmarks");

  // 2. Gold: USD converted to CNY/gram
  const xau = quotes.find((q) => q.symbol === "xau")!;
  assert.ok(Math.abs(xau.cnyPrice! - (4000 * 7.0) / GRAMS_PER_TROY_OUNCE) < 1e-9);

  // 3. Hog spot: benchmark head loss matches rule-based analysis head loss identically
  const hogSpot = quotes.find((q) => q.symbol === "hog_spot")!;
  assert.equal(hogSpot.price, 9.19);
  assert.ok(hogSpot.weeklySeries && hogSpot.weeklySeries.length >= 9);
  assert.ok(hogSpot.benchmark);
  const expectedLoss = Math.abs(computeHogProfitMetrics(9.19).profitPerHead);
  assert.equal(expectedLoss, Math.abs(Math.round((9.19 - PORK_THRESHOLDS.hogFullCostPerKg) * PORK_THRESHOLDS.standardHogWeightKg)));
  assert.ok(hogSpot.benchmark.anchorSub?.includes(`¥${expectedLoss}`));
  assert.ok(analysis?.headline.includes(`¥${expectedLoss}`));

  // 4. Sow inventory: preserves all 5 quarterly points in series & weeklySeries
  const sowInv = quotes.find((q) => q.symbol === "sow_inventory")!;
  assert.equal(sowInv.series.length, 5);
  assert.deepEqual(
    sowInv.weeklySeries?.map((p) => p.label),
    ["25Q3", "25Q4", "26Q1", "26Q2", "26Q3"],
  );
  assert.equal(sowInv.benchmark?.statusBadge, "绿色区间去化");

  // 5. ETF 516670: 3-decimal weekly precision + cycle/wave guidance attached to analysis
  const etf = quotes.find((q) => q.symbol === "etf_516670")!;
  assert.equal(etf.price, 0.6);
  assert.equal(etf.segment, "etf");
  assert.ok(etf.benchmark?.anchorText.startsWith("MA20 ¥0."));
  assert.ok(analysis?.etfGuidance);
  assert.equal(analysis?.etfGuidance?.symbol, "etf_516670");
  assert.equal(analysis?.etfGuidance?.factors.length, 4);
  assert.ok(analysis?.etfGuidance?.score >= 75, "deep industry loss + sow destocking yields high cycle allocation score");
});

test("unified pork benchmarks react dynamically to price & trend changes without static hardcoded conclusions", () => {
  const mk = (symbol: string, price: number, extra?: Partial<MarketQuote>): MarketQuote => ({
    symbol,
    name: symbol,
    category: "pork",
    currency: "CNY",
    unit: "公斤",
    cnyUnit: null,
    price,
    day: "2026-10-30",
    cnyPrice: null,
    closeYesterday: price,
    changeYesterday: 0,
    close1w: price,
    change1w: 0,
    close1m: price,
    change1m: 0,
    close2m: price,
    change2m: 0,
    series: [{ day: "2026-10-30", close: price }],
    ...extra,
  });

  // 1. Piglet: deep freeze (<240) vs normal profit (340) vs overheated (>450)
  const pigletFreeze = computePorkBenchmark(mk("piglet_spot", 205, { unit: "头", cnyPrice: 205 / 15 }), []);
  const pigletNormal = computePorkBenchmark(mk("piglet_spot", 340, { unit: "头", cnyPrice: 340 / 15 }), []);
  const pigletHot = computePorkBenchmark(mk("piglet_spot", 490, { unit: "头", cnyPrice: 490 / 15 }), []);
  assert.equal(pigletFreeze.statusBadge, "补栏冰点");
  assert.equal(pigletNormal.statusBadge, "补栏常态");
  assert.equal(pigletHot.statusBadge, "补栏过热");

  // 2. Breeding sow: deep discount vs equilibrium vs active expansion
  const sowLow = computePorkBenchmark(mk("sow_spot", 1320, { unit: "头", change1m: -0.15 }), []);
  const sowMid = computePorkBenchmark(mk("sow_spot", 1680, { unit: "头", change1m: 0.01 }), []);
  const sowHigh = computePorkBenchmark(mk("sow_spot", 1960, { unit: "头", change1m: 0.12 }), []);
  assert.equal(sowLow.statusBadge, "深跌去化");
  assert.equal(sowMid.statusBadge, "更新均衡");
  assert.equal(sowHigh.statusBadge, "扩繁活跃");
  assert.notEqual(sowLow.anchorText, sowMid.anchorText);

  // 3. Hog-to-grain ratio: deviation % is computed dynamically from actual price
  const ratio394 = computePorkBenchmark(mk("pig_grain_ratio", 3.94, { unit: ":1" }), []);
  const ratio450 = computePorkBenchmark(mk("pig_grain_ratio", 4.5, { unit: ":1" }), []);
  assert.ok(ratio394.anchorSub?.includes("-34.3%"));
  assert.ok(ratio450.anchorSub?.includes("-25.0%"));

  // 4. Feed cost (corn & soybean meal): reacts to 30-day trend
  const cornRising = computePorkBenchmark(mk("corn_spot", 2480, { unit: "吨", cnyPrice: 2.48, change1m: 0.06 }), []);
  const cornFalling = computePorkBenchmark(mk("corn_spot", 2180, { unit: "吨", cnyPrice: 2.18, change1m: -0.05 }), []);
  assert.equal(cornRising.statusBadge, "原料成本抬升");
  assert.equal(cornFalling.statusBadge, "原料让利回落");

  // 5. Weekly trend aggregation groups calendar weeks deterministically
  const weekly = buildWeeklyTrendSeries([
    { day: "2026-10-19", close: 10.0 }, // Mon
    { day: "2026-10-21", close: 9.6 },  // Wed -> week mean 9.8
    { day: "2026-10-26", close: 9.4 },  // Next Mon
    { day: "2026-10-30", close: 9.0 },  // Fri -> week mean 9.2
  ], "daily");
  assert.deepEqual(weekly, [
    { label: "10-21", close: 9.8 },
    { label: "10-30", close: 9.2 },
  ]);
});

test("today's close follows the latest price and a closed market is not read again", async () => {
  const read: string[] = [];
  let last = 150;
  const fetch: FetchCloses = async ({ symbol }) => (read.push(symbol), closes(45, last));
  await refreshMarkets(new Date("2026-10-28T10:00:00+08:00"), fetch, stubRate);
  last = 151;
  read.length = 0;
  await refreshMarkets(new Date("2026-10-28T10:10:00+08:00"), fetch, stubRate);
  assert.deepEqual(read, INSTRUMENTS.map((i) => i.symbol));
  assert.equal((await readMarkets()).quotes.find((q) => q.symbol === "sse")!.price, 151);
  assert.equal(countClosesBySymbol("sse"), 45, "one row per trading day");

  read.length = 0;
  await refreshMarkets(new Date("2026-10-31T12:00:00+08:00"), fetch, stubRate);
  assert.deepEqual(read, [], "Saturday noon: every market is closed");
});

test("one instrument failing leaves the others current, and the run reports it", async () => {
  const fetch: FetchCloses = async ({ symbol }) => {
    if (symbol === "xau") throw new Error("HTTP 502");
    return closes(45, 120);
  };
  await assert.rejects(refreshMarkets(new Date("2026-10-28T10:00:00+08:00"), fetch, stubRate), /xau: HTTP 502/);
  const remaining = (await readMarkets()).quotes.map((q) => q.symbol);
  assert.equal(remaining.includes("xau"), false);
  assert.equal(remaining.includes("brent"), true);
  assert.equal(remaining.includes("hog_spot"), true);
});

test("daily closes older than half a year are pruned while quarterly capacity series keep multi-quarter history", async () => {
  await refreshMarkets(new Date("2026-10-28T10:00:00+08:00"), async () => closes(200, 120), stubRate);
  const { marketCloses } = await pruneMarkets(new Date("2026-10-28T10:00:00+08:00"));
  const dailyInstrumentCount = INSTRUMENTS.filter((i) => i.session !== "spot-periodic").length;
  assert.equal(marketCloses, dailyInstrumentCount * 19);
  const sowCount = countClosesBySymbol("sow_inventory");
  assert.equal(sowCount, 200, "periodic capacity rows within 3 years are retained");
});

test("pork analysis provides cyclical stage, warning level, headline, and multi-dimensional assessments", async () => {
  const mockQuotes = [
    { symbol: "pig_grain_ratio", price: 3.94 },
    { symbol: "hog_spot", price: 9.19 },
    { symbol: "hog_futures", price: 9505, cnyPrice: 9.505 },
    { symbol: "pork_spot", price: 15.29 },
    { symbol: "piglet_spot", price: 205.05, unit: "头", cnyPrice: 13.67 },
    { symbol: "sow_spot", price: 1484.69, unit: "头" },
    { symbol: "sow_inventory", price: 3602 },
    { symbol: "corn_spot", price: 2334, cnyPrice: 2.334 },
    { symbol: "bean_spot", price: 3120, cnyPrice: 3.12 },
  ] as Parameters<typeof computeRuleBasedPorkAnalysis>[0];

  const analysis = computeRuleBasedPorkAnalysis(mockQuotes);
  assert.equal(analysis.warningLevel, "critical", "ratio < 5.0 triggers critical warning");
  assert.ok(analysis.stage.includes("深度亏损"));
  assert.ok(analysis.headline.includes("¥481"), "uses calibrated 13.20 CNY/kg * 120kg head loss");
  assert.ok(analysis.warningText.includes("过度下跌一级预警"));
  assert.equal(analysis.source, "rules");
  assert.equal(analysis.bullets.length, 4);

  const cautionAnalysis = computeRuleBasedPorkAnalysis([
    ...mockQuotes.filter((q) => q.symbol !== "pig_grain_ratio"),
    { symbol: "pig_grain_ratio", price: 5.5 } as (typeof mockQuotes)[0],
  ]);
  assert.equal(cautionAnalysis.warningLevel, "caution");

  const normalAnalysis = computeRuleBasedPorkAnalysis([
    ...mockQuotes.filter((q) => q.symbol !== "pig_grain_ratio"),
    { symbol: "pig_grain_ratio", price: 7.2 } as (typeof mockQuotes)[0],
  ]);
  assert.equal(normalAnalysis.warningLevel, "normal");

  // ETF 516670 guidance adapts to cycle bottom vs overbought short-term wave vs cycle peak
  const etfSeriesNormal = Array.from({ length: 30 }, (_, i) => ({
    day: addDays("2026-10-30", i - 29),
    close: i === 29 ? 0.595 : 0.585,
  }));
  const bottomGuidance = computeEtf516670Guidance([
    ...mockQuotes,
    { symbol: "etf_516670", price: 0.595, series: etfSeriesNormal } as (typeof mockQuotes)[0],
  ]);
  assert.equal(bottomGuidance.action, "accumulate");
  assert.ok(bottomGuidance.score >= 75);
  assert.ok(bottomGuidance.ma20Diff > 0 && bottomGuidance.ma20Diff < 0.04);

  const etfSeriesOverbought = Array.from({ length: 30 }, (_, i) => ({
    day: addDays("2026-10-30", i - 29),
    close: i === 29 ? 0.65 : 0.58,
  }));
  const overboughtGuidance = computeEtf516670Guidance([
    ...mockQuotes,
    { symbol: "etf_516670", price: 0.65, series: etfSeriesOverbought } as (typeof mockQuotes)[0],
  ]);
  assert.equal(overboughtGuidance.action, "accumulate");
  assert.ok(overboughtGuidance.actionLabel.includes("忌追高"));

  const peakGuidance = computeEtf516670Guidance([
    { symbol: "pig_grain_ratio", price: 9.6 },
    { symbol: "hog_spot", price: 19.5 },
    { symbol: "hog_futures", price: 16500, cnyPrice: 16.5 },
    { symbol: "pork_spot", price: 25.0 },
    { symbol: "piglet_spot", price: 520, unit: "头", cnyPrice: 34.67 },
    { symbol: "sow_spot", price: 1980, unit: "头" },
    { symbol: "sow_inventory", price: 3950 },
    { symbol: "corn_spot", price: 2500, cnyPrice: 2.5, change1m: 0.05 },
    { symbol: "bean_spot", price: 3400, cnyPrice: 3.4, change1m: 0.05 },
    { symbol: "etf_516670", price: 0.78, series: etfSeriesOverbought },
  ] as Parameters<typeof computeEtf516670Guidance>[0]);
  assert.ok(peakGuidance.action === "wait" || peakGuidance.action === "reduce");
  assert.ok(peakGuidance.score < 35);

  await refreshMarkets(new Date("2026-10-28T10:00:00+08:00"), async () => closes(45, 100), stubRate);
  const result = await readMarkets();
  assert.ok(result.analysis);
  assert.ok(result.analysis.stage);
  assert.ok(result.analysis.headline);
  assert.ok(result.analysis.bullets.length >= 3);
  assert.ok(result.aviationAnalysis);
  assert.equal(result.aviationAnalysis.etfGuidance?.symbol, "cea_600115");

  // Aviation & China Eastern (600115) cycle + wave guidance check
  const avQuotes = [
    { symbol: "ine_crude", price: 510, change1m: -0.06 },
    { symbol: "fuel_futures", price: 3650, cnyPrice: 3.65 },
    { symbol: "fx_usdcny", price: 6.67, change1m: -0.01 },
    { symbol: "sh_airport", price: 29.5, change1w: 0.02 },
    { symbol: "air_china", price: 6.8, change1w: 0.02 },
    { symbol: "csa_600029", price: 5.5, change1w: 0.01 },
    { symbol: "spring_air", price: 48.0, change1w: 0.02 },
    { symbol: "caac_load_factor", price: 85.6 },
    {
      symbol: "cea_600115",
      price: 3.48,
      series: Array.from({ length: 25 }, (_, i) => ({
        day: addDays("2026-10-30", i - 24),
        close: i === 24 ? 3.48 : 3.42,
      })),
    },
  ] as Parameters<typeof computeCea600115Guidance>[0];
  const ceaGuidance = computeCea600115Guidance(avQuotes);
  assert.equal(ceaGuidance.symbol, "cea_600115");
  assert.ok(ceaGuidance.score >= 70, "low oil + strong RMB + high load factor yields high CEA score");
  assert.equal(ceaGuidance.factors.length, 4);

  const avAnalysis = computeRuleBasedAviationAnalysis(avQuotes);
  assert.equal(avAnalysis.warningLevel, "normal");
  assert.ok(avAnalysis.headline.includes("85.6%"));

  const crudeBench = computeAviationBenchmark({
    symbol: "ine_crude",
    name: "上期原油连续",
    category: "aviation",
    currency: "CNY",
    unit: "桶",
    cnyUnit: null,
    price: 698,
    day: "2026-11-03",
    cnyPrice: null,
    closeYesterday: 690,
    changeYesterday: 0.01,
    close1m: 650,
    change1m: 0.07,
    close2m: 620,
    change2m: 0.12,
    series: [{ day: "2026-11-03", close: 698 }],
  }, []);
  assert.equal(crudeBench.statusBadge, "高油价挤压");

  // Hang Seng Tech & 513180 ETF cycle + wave guidance check
  assert.ok(result.hstechAnalysis);
  assert.equal(result.hstechAnalysis.etfGuidance?.symbol, "etf_513180");

  const hsQuotes = [
    { symbol: "hstech_index", price: 4727, change1w: -0.02, change1m: -0.04 },
    { symbol: "hstech_fx", price: 6.67, change1m: -0.01 },
    { symbol: "hk_00700", price: 488.8, change1w: 0.02 },
    { symbol: "hk_09988", price: 127.6, change1w: 0.03 },
    { symbol: "hk_03690", price: 82.8, change1w: 0.01 },
    { symbol: "hk_09618", price: 112.1, change1w: 0.01 },
    { symbol: "hk_01810", price: 32.1, change1w: 0.02 },
    { symbol: "hk_00981", price: 59.5, change1w: 0.02 },
    {
      symbol: "etf_513180",
      price: 0.629,
      series: Array.from({ length: 25 }, (_, i) => ({
        day: addDays("2026-10-30", i - 24),
        close: i === 24 ? 0.629 : 0.64,
      })),
    },
  ] as Parameters<typeof computeEtf513180Guidance>[0];
  const hsGuidance = computeEtf513180Guidance(hsQuotes);
  assert.equal(hsGuidance.symbol, "etf_513180");
  assert.ok(hsGuidance.score >= 70, "undervalued index + strong RMB + positive weights yields high 513180 score");
  assert.equal(hsGuidance.factors.length, 4);

  const hsAnalysis = computeRuleBasedHstechAnalysis(hsQuotes);
  assert.equal(hsAnalysis.warningLevel, "normal");
  assert.ok(hsAnalysis.headline.includes("4727"));

  const hsIdxBench = computeHstechBenchmark({
    symbol: "hstech_index",
    name: "恒生科技指数",
    category: "hstech",
    currency: "HKD",
    unit: "点",
    cnyUnit: null,
    price: 4100,
    day: "2026-11-03",
    cnyPrice: null,
    closeYesterday: 4150,
    changeYesterday: -0.012,
    close1m: 4400,
    change1m: -0.068,
    close2m: 4600,
    change2m: -0.108,
    series: [{ day: "2026-11-03", close: 4100 }],
  }, []);
  assert.equal(hsIdxBench.statusBadge, "估值深度折价");
});

test("refreshPorkDaily runs at midnight Beijing time for all pork instruments, while refreshMacroMarkets only runs macro", async () => {
  const readSymbols: string[] = [];
  const fetch: FetchCloses = async ({ symbol }) => (readSymbols.push(symbol), closes(45, 100));

  const midnightBeijing = new Date("2026-10-29T00:00:00+08:00");
  await refreshPorkDaily(midnightBeijing, fetch);

  const porkSymbols = INSTRUMENTS.filter((i) => i.category === "pork").map((i) => i.symbol);
  const macroSymbols = INSTRUMENTS.filter((i) => i.category === "macro").map((i) => i.symbol);

  assert.deepEqual(readSymbols.sort(), porkSymbols.sort(), "pork daily only reads pork instruments");
  const storedPorkSymbols = [...getDistinctSymbols()];
  assert.deepEqual(storedPorkSymbols.sort(), porkSymbols.sort());

  const analysisRow = getStoredAnalysis("markets.pork_analysis");
  assert.ok(analysisRow?.stage);

  readSymbols.length = 0;
  await refreshAviationDaily(midnightBeijing, fetch);
  const aviationSymbols = INSTRUMENTS.filter((i) => i.category === "aviation").map((i) => i.symbol);
  assert.deepEqual(readSymbols.sort(), aviationSymbols.sort(), "aviation daily only reads aviation instruments");
  const avAnalysisRow = getStoredAnalysis("markets.aviation_analysis");
  assert.ok(avAnalysisRow?.stage);

  readSymbols.length = 0;
  await refreshHstechDaily(midnightBeijing, fetch);
  const hstechSymbols = INSTRUMENTS.filter((i) => i.category === "hstech").map((i) => i.symbol);
  assert.deepEqual(readSymbols.sort(), hstechSymbols.sort(), "hstech daily only reads hstech instruments");
  const hsAnalysisRow = getStoredAnalysis("markets.hstech_analysis");
  assert.ok(hsAnalysisRow?.stage);

  readSymbols.length = 0;
  const intradayBeijing = new Date("2026-10-29T10:00:00+08:00");
  await refreshMacroMarkets(intradayBeijing, fetch, stubRate);

  assert.deepEqual(readSymbols.sort(), macroSymbols.sort(), "macro refresh only reads macro instruments");
});

test("LLM channels overview tracks multi-channel models, quota info, call history, cooldowns, and analysis model metadata", async () => {
  process.env.LLM_BASE_URL = "https://integrate.api.nvidia.com/v1";
  process.env.LLM_API_KEY = "test-nv-key";
  process.env.LLM_MODEL = "minimaxai/minimax-m3.1-flash";
  process.env.LLM_CHANNEL_1_QUOTA_MODE = "nvidia";
  process.env.LLM_CHANNEL_2_BASE_URL = "https://tokenharbor.ai/v1";
  process.env.LLM_CHANNEL_2_API_KEY = "test-th-key";
  process.env.LLM_CHANNEL_2_MODEL = "deepseek-v4.1-flash:free";
  process.env.LLM_CHANNEL_2_QUOTA_MODE = "tokenharbor";

  const channels = loadChannels();
  assert.equal(channels.length, 2);
  assert.equal(channels[0]!.id, "ch-1");
  assert.equal(channels[0]!.model, "minimaxai/minimax-m3.1-flash");
  assert.equal(channels[1]!.id, "ch-2");
  assert.equal(channels[1]!.quotaMode, "tokenharbor");

  updateChannelQuotaInfo("ch-2", { usedPct: 12, resetsAt: "2026-11-12T00:00:00Z" });
  insertLlmCall({
    purpose: "pork_analysis",
    subject: "pork_market:2026-11-05",
    status: "completed",
    channelId: "ch-2",
    channelIndex: 2,
    model: "deepseek-v4.1-flash:free",
    latencyMs: 3420,
    tokensIn: 2400,
    tokensOut: 380,
    attemptedChannels: ["ch-1", "ch-2"],
    failoverErrors: [{ channelId: "ch-1", error: "HTTP 429: Too Many Requests" }],
    createdAt: new Date().toISOString(),
  });

  // Trigger 3 consecutive failures on ch-1 to put it in cooldown
  recordChannelFailure("ch-1", Date.now(), "HTTP 429");
  recordChannelFailure("ch-1", Date.now(), "HTTP 429");
  recordChannelFailure("ch-1", Date.now(), "HTTP 429");

  const overview = await getChannelsOverview(30);
  assert.equal(overview.activeChannelId, "ch-2", "ch-1 is in cooldown so ch-2 becomes active");
  const ch1 = overview.channels.find((c) => c.id === "ch-1")!;
  const ch2 = overview.channels.find((c) => c.id === "ch-2")!;
  assert.equal(ch1.status, "cooldown");
  assert.equal(ch2.status, "active");
  assert.equal(ch2.quotaInfo?.usedPct, 12);
  assert.equal(ch2.totals.ok, 1);
  assert.equal(overview.recentCalls.length, 1);
  assert.equal(overview.recentCalls[0]!.model, "deepseek-v4.1-flash:free");

  // Resetting ch-1 restores it to active primary status
  resetChannelState("ch-1");
  const afterReset = await getChannelsOverview(30);
  assert.equal(afterReset.activeChannelId, "ch-1");

  // Stored AI analysis without explicit model field is enriched from recent llm_calls on readMarkets()
  setStoredAnalysis("markets.pork_analysis", {
    stage: "亏损去化",
    headline: "生猪深度亏损",
    warningLevel: "critical",
    warningText: "猪粮比一级预警",
    bullets: [{ dimension: "终端", assessment: "平衡" }],
    analyzedAt: new Date().toISOString(),
    source: "ai",
  });
  const markets = await readMarkets();
  assert.equal(markets.analysis?.source, "ai");
  assert.equal(markets.analysis?.model, "deepseek-v4.1-flash:free");
  assert.equal(markets.analysis?.channelId, "ch-2");
});

test("manual refresh with force=true bypasses session checks and supports quotes-only or partial updates", async () => {
  const firstFetch: FetchCloses = async () => closes(40, 100);
  await refreshMarkets(new Date("2026-10-28T10:00:00+08:00"), firstFetch, stubRate, "macro");

  // Off-hours Saturday: normal refresh skips known macro symbols, but force=true updates them
  const saturday = new Date("2026-10-31T14:00:00+08:00");
  const updatedFetch: FetchCloses = async () => closes(40, 200);
  const skippedRun = await refreshMarkets(saturday, updatedFetch, stubRate, "macro");
  assert.equal(skippedRun.sse, undefined, "without force, Saturday refresh skips SSE");

  const forcedRun = await refreshMarkets(saturday, updatedFetch, stubRate, "macro", {
    force: true,
    skipAi: true,
    allowPartial: true,
  });
  assert.equal(forcedRun.sse, 1, "with force=true, manual refresh updates the latest SSE close even outside session hours");
  const afterForce = await readMarkets();
  assert.equal(afterForce.quotes.find((q) => q.symbol === "sse")?.price, 200);
});

test("v4 data-driven position plans: dynamic 2-Buy + 2-Sell action points, oil/FX linkage, smart DCA, snapshot ledger, and crash-zone half-retain", () => {
  // 1. 畜牧养殖ETF (516670) baseline: 14,400 shares, MV 8798.40, PnL +507.84 -> totalCost 8290.56, dilutedCost 0.5757
  const etfSeries = [
    { day: "2026-11-01", close: 0.585 },
    { day: "2026-11-03", close: 0.598 },
    { day: "2026-11-05", close: 0.618 },
    { day: "2026-11-08", close: 0.611 },
  ];
  const plan516670 = compute516670PositionPlan(
    {
      symbol: "etf_516670",
      price: 0.611,
      changeYesterday: 0.005,
      series: etfSeries,
    },
    82,
    60,
    [
      { symbol: "pig_grain_ratio", price: 3.94 },
      { symbol: "hog_spot", price: 9.19 },
      { symbol: "sow_inventory", price: 3602 },
    ],
  );
  assert.equal(plan516670.latestSnapshot.shares, 14400);
  assert.equal(plan516670.latestSnapshot.totalCost, 8290.56);
  assert.equal(plan516670.latestSnapshot.dilutedCost, 0.5757);
  assert.equal(plan516670.baseCoreShares, 10400);
  assert.equal(plan516670.totalCoreShares, 10400);
  assert.equal(plan516670.cycleState, "bottom");
  assert.ok(plan516670.technicalContext?.fundamentalDriveSummary.includes("猪粮比 3.94:1"));
  assert.equal(plan516670.actionPoints?.length, 4);
  const buy1_516670 = plan516670.actionPoints?.find((p) => p.kind === "buy1");
  const sell1_516670 = plan516670.actionPoints?.find((p) => p.kind === "sell1");
  assert.ok(buy1_516670?.triggerPrice && buy1_516670.triggerPrice < 0.611);
  assert.ok(sell1_516670?.triggerPrice && sell1_516670.triggerPrice > 0.611);
  assert.ok(sell1_516670?.projectedDilutedCost && sell1_516670.projectedDilutedCost < 0.5757);

  // Cycle top (score < 30) pauses regular buy and allows reducing core position to 0~1,500 shares
  const topPlan516670 = compute516670PositionPlan(
    {
      symbol: "etf_516670",
      price: 0.78,
      changeYesterday: 0.02,
      series: [{ day: "2026-11-08", close: 0.78 }],
    },
    22,
    18,
  );
  assert.equal(topPlan516670.cycleState, "peak");
  assert.ok(topPlan516670.coreTargetHint.includes("0～1,500 股"));
  assert.equal(topPlan516670.actionPoints?.find((p) => p.kind === "buy1")?.triggerPrice, null);

  // 2. 中国东航 (600115): oil/FX tailwind vs oil/FX headwind dynamically shifts buy1 deeper
  const ceaSeries = [
    { day: "2026-11-01", close: 3.32 },
    { day: "2026-11-04", close: 3.45 },
    { day: "2026-11-06", close: 3.66 },
    { day: "2026-11-08", close: 3.56 },
  ];
  const plan600115Tailwind = compute600115PositionPlan(
    {
      symbol: "cea_600115",
      price: 3.56,
      changeYesterday: 0.01,
      series: ceaSeries,
    },
    75,
    [
      { symbol: "ine_crude", price: 510, change1m: -0.05 },
      { symbol: "fx_usdcny", price: 6.7, change1m: -0.008 },
      { symbol: "caac_load_factor", price: 85.6 },
    ],
  );
  const plan600115Headwind = compute600115PositionPlan(
    {
      symbol: "cea_600115",
      price: 3.56,
      changeYesterday: 0.01,
      series: ceaSeries,
    },
    42,
    [
      { symbol: "ine_crude", price: 685, change1m: 0.08 },
      { symbol: "fx_usdcny", price: 7.15, change1m: 0.015 },
    ],
  );
  assert.equal(plan600115Tailwind.latestSnapshot.shares, 3000);
  assert.equal(plan600115Tailwind.latestSnapshot.dilutedCost, 3.335);
  const buy1Tailwind = plan600115Tailwind.actionPoints?.find((p) => p.kind === "buy1")!;
  const buy1Headwind = plan600115Headwind.actionPoints?.find((p) => p.kind === "buy1")!;
  assert.ok(
    buy1Headwind.triggerPrice! < buy1Tailwind.triggerPrice!,
    "oil/FX headwind automatically retreats buy1 deeper than tailwind",
  );
  const sell1Cea = plan600115Tailwind.actionPoints?.find((p) => p.kind === "sell1")!;
  assert.ok(sell1Cea.estimatedNetProfit! >= 40, "no-fee-waiver guardrail ensures >= 40 RMB net profit after 11 RMB fee");

  // 3. 恒生科技 (513180 场外联接): floating PnL tier (-13% -> 120) + MA20 dip boost (+20 -> 140)
  const plan513180Flat = compute513180PositionPlan(
    {
      symbol: "etf_513180",
      price: 0.51,
      changeYesterday: -0.005,
      series: [{ day: "2026-11-08", close: 0.51 }],
    },
    78,
  );
  assert.equal(plan513180Flat.latestSnapshot.totalCost, 19259.16);
  assert.equal(plan513180Flat.dcaPlan?.baseTierAmount, 120);
  assert.equal(plan513180Flat.dcaPlan?.recommendedDailyAmount, 120);

  const plan513180Dip = compute513180PositionPlan(
    {
      symbol: "etf_513180",
      price: 0.5,
      changeYesterday: -0.015,
      series: [
        { day: "2026-11-01", close: 0.53 },
        { day: "2026-11-04", close: 0.525 },
        { day: "2026-11-06", close: 0.52 },
        { day: "2026-11-08", close: 0.5 },
      ],
    },
    78,
    [{ symbol: "hstech_index", price: 4450 }],
  );
  assert.equal(
    plan513180Dip.dcaPlan?.recommendedDailyAmount,
    140,
    "undervalued score + dip below MA20 boosts daily DCA from 120 to 140 RMB",
  );

  // 4. Snapshot ledger: selling 1,000 shares of 516670 at 0.618 lowers dilutedCost and credits profitPool
  recordPositionSnapshot({
    symbol: "etf_516670",
    shares: 13400,
    marketValue: 8281.2, // 13400 * 0.618
    unrealizedPnl: 602.64,
    note: "测试T+1档止盈1000股",
  });
  const afterSell516670 = compute516670PositionPlan(
    {
      symbol: "etf_516670",
      price: 0.618,
      changeYesterday: 0.002,
      series: etfSeries,
    },
    82,
    60,
  );
  assert.equal(afterSell516670.latestSnapshot.shares, 13400);
  assert.ok(
    afterSell516670.latestSnapshot.dilutedCost! < 0.5757,
    "selling above diluted cost lowers remaining diluted cost per share",
  );
  assert.ok(afterSell516670.profitPool > 0, "realized spread profit is credited to profitPool");

  // 5. Crash-zone buy & rebound half-sell retains half into bonusCoreShares
  recordPositionSnapshot({
    symbol: "cea_600115",
    shares: 5400,
    marketValue: 13932,
    unrealizedPnl: -2500,
    note: "大跌深水区加仓",
  });
  recordPositionSnapshot({
    symbol: "cea_600115",
    shares: 5000,
    marketValue: 14000,
    unrealizedPnl: -1310,
    note: "深水区反弹卖半留半",
  });
  const afterCrashRebound600115 = compute600115PositionPlan(
    {
      symbol: "cea_600115",
      price: 2.8,
      changeYesterday: 0.02,
      series: [{ day: "2026-11-08", close: 2.8 }],
    },
    75,
  );
  assert.equal(afterCrashRebound600115.bonusCoreShares, 400, "retained 400 shares permanently added to bonusCoreShares");
  assert.equal(afterCrashRebound600115.totalCoreShares, 2600, "base 2200 + bonus 400 = 2600 total core shares");

  // 6. Undo / delete snapshot restores previous state
  const latestSnapId = afterSell516670.snapshots[0]?.id;
  assert.ok(latestSnapId);
  removePositionSnapshot(latestSnapId);
  const restored516670 = compute516670PositionPlan(
    {
      symbol: "etf_516670",
      price: 0.611,
      changeYesterday: 0.005,
      series: etfSeries,
    },
    82,
    60,
  );
  assert.equal(restored516670.latestSnapshot.shares, 14400);
});

test("intraday OHLCV klines and leading sector indicators (002714, 300498, hk00670, hk01024) enrich technical and fundamental pricing", () => {
  // 1. parseKlines with includeOhlcv: true extracts intraday high, low, volume
  const ohlcvTencent = parseKlines(
    {
      data: {
        sh516670: {
          qfqday: [
            ["2026-11-05", "0.600", "0.605", "0.618", "0.592", "120000"],
            ["2026-11-06", "0.605", "0.610", "0.625", "0.598", "150000"],
            ["2026-11-07", "0.610", "0.608", "0.619", "0.588", "90000"],
            ["2026-11-08", "0.608", "0.611", "0.622", "0.595", "80000"],
          ],
        },
      },
    },
    { includeOhlcv: true },
  );
  assert.equal(ohlcvTencent.length, 4);
  assert.equal(ohlcvTencent[1]?.high, 0.625);
  assert.equal(ohlcvTencent[2]?.low, 0.588);
  assert.equal(ohlcvTencent[3]?.volume, 80000);

  // 2. extractTechnicalStats uses intraday high/low and computes 20d volume ratio
  const stats = extractTechnicalStats(ohlcvTencent, 0.611, 3);
  assert.equal(stats.intradaySource, "high-low");
  assert.equal(stats.high20d, 0.625, "uses true intraday high 0.625 rather than close 0.611");
  assert.equal(stats.low20d, 0.588, "uses true intraday low 0.588 rather than close 0.605");
  assert.ok(stats.volumeRatio20d != null && stats.volumeRatio20d < 0.78);
  assert.ok(stats.volumeSignal?.includes("缩量企稳"));

  // 3. Benchmarks for the 4 new leading instruments
  const muyuanBench = computePorkBenchmark(
    {
      symbol: "muyuan_002714",
      name: "牧原股份",
      category: "pork",
      currency: "CNY",
      unit: "股",
      cnyUnit: null,
      price: 41.2,
      day: "2026-11-08",
      cnyPrice: null,
      closeYesterday: 40.5,
      changeYesterday: 0.017,
      close1w: 39.8,
      change1w: 0.035,
      close1m: 38.5,
      change1m: 0.07,
      close2m: 37.0,
      change2m: 0.11,
      series: [],
      note: null,
    },
    [
      { symbol: "etf_516670", price: 0.611, change1m: 0.02 } as any,
      { symbol: "hog_spot", price: 11.2, change1m: -0.02 } as any,
    ],
  );
  assert.equal(muyuanBench.statusBadge, "机构抢跑反转");

  const ceaHkBench = computeAviationBenchmark(
    {
      symbol: "cea_hk00670",
      name: "东航H股(00670)",
      category: "aviation",
      currency: "HKD",
      unit: "股",
      cnyUnit: null,
      price: 2.25,
      day: "2026-11-08",
      cnyPrice: null,
      closeYesterday: 2.2,
      changeYesterday: 0.022,
      close1w: 2.15,
      change1w: 0.046,
      close1m: 2.08,
      change1m: 0.081,
      close2m: 2.0,
      change2m: 0.125,
      series: [],
      note: null,
    },
    [
      { symbol: "cea_600115", price: 3.56, change1m: 0.03 } as any,
      { symbol: "fx_usdcny", price: 6.85 } as any,
    ],
  );
  assert.ok(ceaHkBench.anchorText.includes("A/H比价"));
  assert.equal(ceaHkBench.statusBadge, "外资抢筹领涨");

  const kuaishouBench = computeHstechBenchmark(
    {
      symbol: "hk_01024",
      name: "快手-W",
      category: "hstech",
      currency: "HKD",
      unit: "股",
      cnyUnit: null,
      price: 51.5,
      day: "2026-11-08",
      cnyPrice: null,
      closeYesterday: 50.0,
      changeYesterday: 0.03,
      close1w: 48.5,
      change1w: 0.06,
      close1m: 46.0,
      change1m: 0.12,
      close2m: 44.0,
      change2m: 0.17,
      series: [],
      note: null,
    },
    [{ symbol: "hstech_index", price: 4650, change1m: 0.05 } as any],
  );
  assert.ok(kuaishouBench.anchorText.includes("可灵AI"));
  assert.equal(kuaishouBench.statusBadge, "领涨超额阿尔法");
});

test("intraday verification: early baseline freezing in daily_frozen_plans", () => {
  clearDb();
  const symbol = "etf_516670";
  const today = "2026-11-10";

  assert.equal(getDailyFrozenPlan(symbol, today), null);

  const mockPlan = {
    symbol: "etf_516670" as const,
    mode: "grid" as const,
    cycleState: "recovery" as const,
    cycleStateLabel: "周期底部修复",
    cycleStateTone: "positive" as const,
    buyMultiplier: 1.0,
    cycleConfirmNote: "测试",
    latestSnapshot: {
      id: 1,
      symbol: "etf_516670" as const,
      day: "2026-11-09",
      shares: 14400,
      marketValue: 8798.4,
      unrealizedPnl: 507.84,
      dilutedCost: 0.5757,
      totalCost: 8290.56,
      pnlPct: 0.061,
      inferredTrade: "初始",
      createdAt: "2026-11-09T15:00:00.000Z",
    },
    snapshots: [],
    costCurve: [],
    costDeltaPct: 0,
    profitPool: 42.2,
    profitBonusReadyShares: 0,
    lotCost100: 59.1,
    baseCoreShares: 10400,
    bonusCoreShares: 0,
    totalCoreShares: 10400,
    coreTargetHint: "底仓锁仓",
    actionPoints: [
      {
        kind: "buy1" as const,
        label: "第一买点 · 回踩支撑低吸",
        triggerPrice: 0.591,
        distancePct: -0.033,
        shares: 1000,
        retainShares: 0,
        cashAmount: 591,
        estimatedNetProfit: null,
        projectedDilutedCost: 0.5767,
        technicalAnchor: "MA20",
        fundamentalReason: "能繁存栏",
      },
    ],
  };

  setDailyFrozenPlan(symbol, today, mockPlan);
  const retrieved = getDailyFrozenPlan(symbol, today);
  assert.ok(retrieved);
  assert.equal(retrieved.actionPoints?.[0]?.triggerPrice, 0.591);
  assert.equal(retrieved.profitPool, 42.2);

  clearDb();
  assert.equal(getDailyFrozenPlan(symbol, today), null);
});

test("intraday verification: Tencent qt.gtimg.cn quote parsing & session detection", () => {
  const sampleTencent = `v_sh516670="1~畜牧养殖ETF招商~516670~0.609~0.611~0.611~591377~333615~257762~0.609~1536~0.000~0~0.000~0~0.000~0~0.000~0~0.000~0~0.000~0~0.000~0~0.000~0~0.000~0~~20261110152712~-0.002~-0.33~0.612~0.607~0.609/591377/36056210~591377~3606~1.71~~~0.612~0.607~0.82~21.05~21.05~0.00~0.672~0.550~0.71~1536~0.610~~~~~~3605.6210~0.2436~40~   B~ETF~-13.74~1.50~~~~0.755~0.529~3.75~3.22~-0.98~3457266300~3457266300~100.00~-13.12~3457266300~-0.21~0.6103~-17.26~-0.16~0.6122~CNY~0~___D__F__N~0.000~0~";
v_sz002714="51~牧原股份~002714~44.57~44.55~44.29~219360~106738~112621~44.57~125~0.00~0~0.00~0~0.00~0~0.00~0~44.57~0~0.00~0~0.00~0~0.00~0~0.00~0~~20261110152700~0.02~0.04~44.69~44.10~44.57/219360/973856741~219360~97386~0.67~-29.88~~44.69~44.10~1.32~1462.14~2573.02~3.36~49.01~40.10~0.47~125~44.40~-20.71~16.61~~~0.46~97385.6741~32.9818~74~   B~GP-A~-11.14~3.63~0.95~-11.11~-4.91~51.43~31.81~7.53~8.97~10.76~3280544551~5772996148~100.00~-3.08~3280544551~~~-13.03~0.00~~CNY~0~~0.00~0~";`;

  const quotes = parseTencentQuotes(sampleTencent);
  const etf = quotes.sh516670;
  assert.ok(etf);
  assert.equal(etf.code, "sh516670");
  assert.equal(etf.name, "畜牧养殖ETF招商");
  assert.equal(etf.price, 0.609);
  assert.equal(etf.prevClose, 0.611);
  assert.equal(etf.timeStr, "15:27:12");
  assert.equal(etf.changePct, -0.0033);
  assert.equal(etf.volumeRatio, 0.71);
  assert.equal(etf.vwap, 0.61);
  assert.equal(etf.iopv, 0.6103);
  assert.equal(etf.discountPremiumPct, -0.0021);
  assert.ok(etf.intradayPositionPct !== null && etf.intradayPositionPct >= 0 && etf.intradayPositionPct <= 1);

  // Session detection checks
  assert.equal(getIntradaySessionPhase("09:15").phase, "pre_open");
  assert.equal(getIntradaySessionPhase("09:45").phase, "morning_trading");
  assert.equal(getIntradaySessionPhase("12:00").phase, "lunch_break");
  assert.equal(getIntradaySessionPhase("13:45").phase, "afternoon_trading");
  assert.equal(getIntradaySessionPhase("14:35").phase, "closing_window");
  assert.equal(getIntradaySessionPhase("15:05").phase, "post_close");
});

test("intraday verification: grid action points evaluation (buy1/buy2/sell1/sell2 rules)", () => {
  const frozenPlan: any = {
    symbol: "etf_516670",
    actionPoints: [
      {
        kind: "buy1",
        label: "第一买点 · 回踩支撑低吸",
        triggerPrice: 0.591,
        shares: 1000,
        retainShares: 0,
        cashAmount: 591,
      },
      {
        kind: "buy2",
        label: "第二买点 · 强支撑大跌加码",
        triggerPrice: 0.559,
        shares: 3000,
        retainShares: 1500,
        cashAmount: 1677,
      },
      {
        kind: "sell1",
        label: "第一卖点 · 近期压力做T",
        triggerPrice: 0.618,
        shares: 1000,
        retainShares: 0,
        cashAmount: 618,
      },
      {
        kind: "sell2",
        label: "第二卖点 · 脉冲冲高止盈",
        triggerPrice: 0.632,
        shares: 1500,
        retainShares: 0,
        cashAmount: 948,
      },
    ],
  };

  // Case 1: Buy1 reached, but during opening noise 09:35 -> HOLD
  const noiseContext: any = {
    currentPrice: 0.590,
    yesterdayClose: 0.600,
    changePct: -0.016,
    vwap: 0.592,
    volumeRatio: 1.1,
    intradayPositionPct: 0.3,
    discountPremiumPct: -0.001,
    lowPrice: 0.590,
    highPrice: 0.605,
    relatedQuotes: [{ symbol: "sz002714", changePct: -0.005 }],
  };
  const noiseChecks = evaluateGridActionPointRules("etf_516670", noiseContext, frozenPlan, "09:35");
  const buy1Noise = noiseChecks.find((c) => c.kind === "buy1")!;
  assert.equal(buy1Noise.distanceStatus, "reached");
  assert.equal(buy1Noise.verdict, "hold");
  assert.ok(buy1Noise.ruleReason.includes("开盘乱波期"));
  assert.ok(buy1Noise.recheckCondition);

  // Case 2: Buy1 reached at 10:30 with gentle pullback -> EXECUTE
  const gentleContext: any = {
    currentPrice: 0.591,
    yesterdayClose: 0.600,
    changePct: -0.015,
    vwap: 0.591,
    volumeRatio: 0.8,
    intradayPositionPct: 0.35,
    discountPremiumPct: -0.002,
    lowPrice: 0.590,
    highPrice: 0.602,
    relatedQuotes: [{ symbol: "sz002714", changePct: 0.005 }],
  };
  const gentleChecks = evaluateGridActionPointRules("etf_516670", gentleContext, frozenPlan, "10:30");
  const buy1Gentle = gentleChecks.find((c) => c.kind === "buy1")!;
  assert.equal(buy1Gentle.distanceStatus, "reached");
  assert.equal(buy1Gentle.verdict, "execute");
  assert.ok(buy1Gentle.ruleReason.includes("按计划执行"));

  // Case 3: Sell1 reached at 10:30, but leaders surging +5.2% and price > VWAP -> HOLD (惜售防卖飞)
  const surgeContext: any = {
    currentPrice: 0.619,
    yesterdayClose: 0.600,
    changePct: 0.0317,
    vwap: 0.615,
    volumeRatio: 2.1,
    intradayPositionPct: 0.85,
    discountPremiumPct: 0.002,
    lowPrice: 0.598,
    highPrice: 0.620,
    relatedQuotes: [{ symbol: "sz002714", changePct: 0.052 }],
  };
  const surgeChecks = evaluateGridActionPointRules("etf_516670", surgeContext, frozenPlan, "10:30");
  const sell1Surge = surgeChecks.find((c) => c.kind === "sell1")!;
  assert.equal(sell1Surge.distanceStatus, "reached");
  assert.equal(sell1Surge.verdict, "hold");
  assert.ok(sell1Surge.ruleReason.includes("惜售保护防卖飞"));

  // Case 4: Sell2 reached -> EXECUTE
  const sell2Context: any = {
    currentPrice: 0.633,
    yesterdayClose: 0.600,
    changePct: 0.055,
    vwap: 0.625,
    volumeRatio: 2.5,
    intradayPositionPct: 0.95,
    discountPremiumPct: 0.003,
    lowPrice: 0.600,
    highPrice: 0.635,
    relatedQuotes: [],
  };
  const sell2Checks = evaluateGridActionPointRules("etf_516670", sell2Context, frozenPlan, "14:15");
  const sell2Pt = sell2Checks.find((c) => c.kind === "sell2")!;
  assert.equal(sell2Pt.distanceStatus, "reached");
  assert.equal(sell2Pt.verdict, "execute");
});

test("intraday verification: Hang Seng Tech 513180 14:30 lump sum decision tree", () => {
  clearDb();

  // Case 1: Normal trading hours, not reaching support (price 0.510) -> HOLD
  const normalCtx: any = {
    currentPrice: 0.510,
    relatedQuotes: [{ symbol: "hkHSTECH", changePct: -0.01 }],
  };
  const res1 = evaluateDcaLumpSumRules(normalCtx, "10:30");
  assert.equal(res1.isInDecisionWindow, false);
  assert.equal(res1.verdict, "hold");
  assert.ok(res1.ruleReason.includes("未达大跌强支撑位"));

  // Case 2: In 14:30–14:55 window, price drops to 0.455 (<= 0.458) with no prior lump sum -> EXECUTE
  const reachedCtx: any = {
    currentPrice: 0.455,
    relatedQuotes: [{ symbol: "hkHSTECH", changePct: -0.015 }],
  };
  const res2 = evaluateDcaLumpSumRules(reachedCtx, "14:40");
  assert.equal(res2.isInDecisionWindow, true);
  assert.equal(res2.verdict, "execute");
  assert.ok(res2.ruleReason.includes("今日 15:00 前建议在券商/天天基金手动追加单笔 ¥1,000"));

  // Case 3: Reached 0.455, but added 2 days ago and price not below 0.440 -> HOLD (cooldown lock)
  recordPositionSnapshot({
    symbol: "etf_513180",
    marketValue: 17756,
    unrealizedPnl: -2500,
    note: "大跌强支撑单独加仓 ¥1,000",
  });
  const res3 = evaluateDcaLumpSumRules(reachedCtx, "14:40");
  assert.equal(res3.cooldownPassed, false);
  assert.equal(res3.verdict, "hold");
  assert.ok(res3.ruleReason.includes("保持防连跌冷却锁"));
});

test("intraday verification: AI review layer skips remote calls when all points are far", async () => {
  const farChecks: any[] = [
    { kind: "buy1", distanceStatus: "far", verdict: "none" },
    { kind: "buy2", distanceStatus: "far", verdict: "none" },
    { kind: "sell1", distanceStatus: "far", verdict: "none" },
    { kind: "sell2", distanceStatus: "far", verdict: "none" },
  ];
  const liveCtx: any = {
    symbol: "sh516670",
    name: "畜牧养殖ETF",
    snapshotTime: "10:30:00",
    currentPrice: 0.611,
  };

  const aiReview = await reviewIntradayWithAi("etf_516670", liveCtx, farChecks);
  assert.equal(aiReview.reviewed, false);
});





