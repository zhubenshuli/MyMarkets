import { countTotalCloses } from "./db.ts";
import { refreshPotentialFundsDaily } from "./funds.ts";
import {
  pruneMarkets,
  refreshAviationDaily,
  refreshHstechDaily,
  refreshMacroMarkets,
  refreshMarkets,
  refreshPorkDaily,
} from "./quotes.ts";
import { beijingDate, beijingTime } from "../shared/time.ts";

let timer: NodeJS.Timeout | null = null;
const executedMinutes = new Set<string>();
let runningTask = false;

async function runTask(name: string, fn: () => Promise<unknown>): Promise<void> {
  if (runningTask) return;
  runningTask = true;
  const start = performance.now();
  try {
    const out = await fn();
    console.log(JSON.stringify({
      level: "info",
      task: name,
      elapsedMs: Math.round(performance.now() - start),
      result: out,
    }));
  } catch (err) {
    console.error(JSON.stringify({
      level: "error",
      task: name,
      elapsedMs: Math.round(performance.now() - start),
      error: (err as Error).message,
    }));
  } finally {
    runningTask = false;
  }
}

export function startScheduler(): void {
  if (process.env.COLLECT_ENABLED !== "true") {
    console.log(JSON.stringify({ level: "info", msg: "scheduler disabled (COLLECT_ENABLED !== true)" }));
    return;
  }

  // Initial cold-start populate if DB is empty
  if (countTotalCloses() === 0) {
    console.log(JSON.stringify({ level: "info", msg: "empty database detected on startup; triggering initial full refresh" }));
    void runTask("markets.init", () => refreshMarkets(new Date(), undefined, undefined, "all"));
  }

  timer = setInterval(() => {
    const now = new Date();
    const day = beijingDate(now);
    const hm = beijingTime(now);
    const stamp = `${day} ${hm}`;
    if (executedMinutes.has(stamp)) return;
    executedMinutes.add(stamp);
    if (executedMinutes.size > 120) {
      const oldest = executedMinutes.values().next().value;
      if (oldest) executedMinutes.delete(oldest);
    }

    const minute = Number(hm.slice(3, 5));

    if (hm === "00:00") {
      void runTask("markets.pork.daily", () => refreshPorkDaily(now));
    } else if (hm === "00:05") {
      void runTask("markets.aviation.daily", () => refreshAviationDaily(now));
    } else if (hm === "00:10") {
      void runTask("markets.hstech.daily", () => refreshHstechDaily(now));
    } else if (hm === "00:15") {
      void runTask("markets.funds.daily", () => refreshPotentialFundsDaily(now));
    } else if (hm === "03:30") {
      void runTask("markets.retention", () => pruneMarkets(now));
    } else if (hm === "15:05") {
      void runTask("markets.funds.close", () => refreshPotentialFundsDaily(now));
    } else if (minute % 10 === 0) {
      void runTask("markets.macro.refresh", () => refreshMacroMarkets(now));
    }
  }, 20_000);
  timer.unref();
}

export function stopScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
