import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { LlmChannelQuotaInfo, PorkMarketAnalysis, PositionPlanDetail } from "../shared/types.ts";

export interface StoredChannelState {
  consecutiveFailures: number;
  cooldownUntil: number;
  exhaustedUntil: number;
  lastSuccessAt?: string | null;
  lastErrorAt?: string | null;
  lastError?: string | null;
  recentFailures?: Array<{ at: string; error: string }>;
  quotaInfo?: LlmChannelQuotaInfo | null;
  resetAt?: number;
  updatedAtMs?: number;
}

export interface LlmCallRow {
  id: number;
  purpose: string;
  subject: string | null;
  status: "completed" | "failed";
  channel_id: string | null;
  channel_index: number | null;
  model: string | null;
  latency_ms: number | null;
  tokens_in: number | null;
  tokens_out: number | null;
  attempted_channels: string | null;
  failover_errors: string | null;
  error: string | null;
  created_at: string;
}

export interface PositionSnapshotRow {
  id: number;
  symbol: string;
  day: string;
  shares: number | null;
  market_value: number;
  unrealized_pnl: number;
  note: string | null;
  created_at: string;
}

export interface StoredStrategyConfig {
  anchorPrice?: number;
  baseCoreShares?: number;
  dcaPeriods?: number;
  dcaBaseDaily?: number;
  cycleState?: string;
  cyclePendingState?: string | null;
  cyclePendingDays?: number;
  cycleLastDay?: string | null;
}

let instance: DatabaseSync | null = null;

export function getDbPath(): string {
  if (process.env.MARKETS_DB_PATH) return process.env.MARKETS_DB_PATH;
  const dataDir = process.env.DATA_DIR || ".data";
  mkdirSync(dataDir, { recursive: true });
  return path.join(dataDir, "markets.db");
}

export function getDb(): DatabaseSync {
  if (instance) return instance;
  const dbPath = getDbPath();
  const db = new DatabaseSync(dbPath);
  if (dbPath !== ":memory:") {
    db.exec("PRAGMA journal_mode = WAL;");
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS market_daily_closes (
      symbol TEXT NOT NULL,
      day TEXT NOT NULL,
      close REAL NOT NULL,
      high REAL,
      low REAL,
      volume REAL,
      PRIMARY KEY (symbol, day)
    );
    CREATE TABLE IF NOT EXISTS market_analyses (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS llm_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      purpose TEXT NOT NULL,
      subject TEXT,
      status TEXT NOT NULL,
      channel_id TEXT,
      channel_index INTEGER,
      model TEXT,
      latency_ms INTEGER,
      tokens_in INTEGER,
      tokens_out INTEGER,
      attempted_channels TEXT,
      failover_errors TEXT,
      error TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_llm_calls_created_at ON llm_calls (created_at DESC, id DESC);
    CREATE TABLE IF NOT EXISTS llm_channel_states (
      channel_id TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS position_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      day TEXT NOT NULL,
      shares REAL,
      market_value REAL NOT NULL,
      unrealized_pnl REAL NOT NULL,
      note TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_position_snapshots_symbol_day ON position_snapshots (symbol, day ASC, id ASC);
    CREATE TABLE IF NOT EXISTS position_strategy_states (
      symbol TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS daily_frozen_plans (
      symbol TEXT NOT NULL,
      day TEXT NOT NULL,
      plan_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (symbol, day)
    );
  `);
  const cols = db.prepare("PRAGMA table_info(market_daily_closes)").all() as Array<{ name: string }>;
  const colNames = new Set(cols.map((c) => c.name));
  if (!colNames.has("high")) db.exec("ALTER TABLE market_daily_closes ADD COLUMN high REAL;");
  if (!colNames.has("low")) db.exec("ALTER TABLE market_daily_closes ADD COLUMN low REAL;");
  if (!colNames.has("volume")) db.exec("ALTER TABLE market_daily_closes ADD COLUMN volume REAL;");
  instance = db;
  return db;
}

export function closeDb(): void {
  if (instance) {
    instance.close();
    instance = null;
  }
}

export function clearDb(): void {
  const db = getDb();
  db.exec(
    "DELETE FROM market_daily_closes; DELETE FROM market_analyses; DELETE FROM llm_calls; DELETE FROM llm_channel_states; DELETE FROM position_snapshots; DELETE FROM position_strategy_states; DELETE FROM daily_frozen_plans;",
  );
}

export function getDistinctSymbols(): Set<string> {
  const db = getDb();
  const rows = db.prepare("SELECT DISTINCT symbol FROM market_daily_closes").all() as Array<{ symbol: string }>;
  return new Set(rows.map((r) => r.symbol));
}

export function upsertCloses(
  rows: Array<{
    symbol: string;
    day: string;
    close: number;
    high?: number | null;
    low?: number | null;
    volume?: number | null;
  }>,
): number {
  if (rows.length === 0) return 0;
  const db = getDb();
  const selectStmt = db.prepare(
    "SELECT close, high, low, volume FROM market_daily_closes WHERE symbol = ? AND day = ?",
  );
  const upsertStmt = db.prepare(`
    INSERT INTO market_daily_closes (symbol, day, close, high, low, volume)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (symbol, day) DO UPDATE SET
      close = excluded.close,
      high = COALESCE(excluded.high, market_daily_closes.high),
      low = COALESCE(excluded.low, market_daily_closes.low),
      volume = COALESCE(excluded.volume, market_daily_closes.volume)
  `);

  let changed = 0;
  db.exec("BEGIN");
  try {
    for (const r of rows) {
      const h = r.high ?? null;
      const l = r.low ?? null;
      const v = r.volume ?? null;
      const existing = selectStmt.get(r.symbol, r.day) as
        | { close: number; high: number | null; low: number | null; volume: number | null }
        | undefined;
      if (
        existing === undefined ||
        existing.close !== r.close ||
        (h !== null && existing.high !== h) ||
        (l !== null && existing.low !== l) ||
        (v !== null && existing.volume !== v)
      ) {
        upsertStmt.run(r.symbol, r.day, r.close, h, l, v);
        changed++;
      }
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return changed;
}

export function getRecentCloses(
  limitPerSymbol = 91,
): Array<{ symbol: string; day: string; close: number; high?: number | null; low?: number | null; volume?: number | null }> {
  const db = getDb();
  const stmt = db.prepare(`
    SELECT symbol, day, close, high, low, volume FROM (
      SELECT symbol, day, close, high, low, volume,
             row_number() OVER (PARTITION BY symbol ORDER BY day DESC) - 1 AS n
      FROM market_daily_closes
    ) ranked
    WHERE n <= ?
    ORDER BY day ASC
  `);
  return stmt.all(limitPerSymbol - 1) as Array<{
    symbol: string;
    day: string;
    close: number;
    high?: number | null;
    low?: number | null;
    volume?: number | null;
  }>;
}

export function getLatestClose(symbol: string): number | null {
  const db = getDb();
  const row = db
    .prepare("SELECT close FROM market_daily_closes WHERE symbol = ? ORDER BY day DESC LIMIT 1")
    .get(symbol) as { close: number } | undefined;
  return row?.close ?? null;
}

export function countClosesBySymbol(symbol: string): number {
  const db = getDb();
  const row = db
    .prepare("SELECT count(*) AS count FROM market_daily_closes WHERE symbol = ?")
    .get(symbol) as { count: number } | undefined;
  return Number(row?.count ?? 0);
}

export function countTotalCloses(): number {
  const db = getDb();
  const row = db.prepare("SELECT count(*) AS count FROM market_daily_closes").get() as { count: number } | undefined;
  return Number(row?.count ?? 0);
}

export function setStoredAnalysis(key: string, analysis: PorkMarketAnalysis): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO market_analyses (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, JSON.stringify(analysis), new Date().toISOString());
}

export function getStoredAnalysis(key: string): PorkMarketAnalysis | null {
  const db = getDb();
  const row = db.prepare("SELECT value FROM market_analyses WHERE key = ?").get(key) as { value: string } | undefined;
  if (!row?.value) return null;
  try {
    return JSON.parse(row.value) as PorkMarketAnalysis;
  } catch {
    return null;
  }
}

export function pruneStoredCloses(cutoffDaily: string, cutoffPeriodic: string, periodicSymbols: string[]): number {
  const db = getDb();
  let deleted = 0;
  if (periodicSymbols.length > 0) {
    const placeholders = periodicSymbols.map(() => "?").join(", ");
    const resDaily = db
      .prepare(`DELETE FROM market_daily_closes WHERE symbol NOT IN (${placeholders}) AND day < ?`)
      .run(...periodicSymbols, cutoffDaily);
    const resPeriodic = db
      .prepare(`DELETE FROM market_daily_closes WHERE symbol IN (${placeholders}) AND day < ?`)
      .run(...periodicSymbols, cutoffPeriodic);
    deleted = Number(resDaily.changes) + Number(resPeriodic.changes);
  } else {
    const resDaily = db.prepare("DELETE FROM market_daily_closes WHERE day < ?").run(cutoffDaily);
    deleted = Number(resDaily.changes);
  }
  return deleted;
}

export function insertLlmCall(row: {
  id?: number;
  purpose: string;
  subject?: string | null;
  status: "completed" | "failed";
  channelId?: string | null;
  channelIndex?: number | null;
  model?: string | null;
  latencyMs?: number | null;
  tokensIn?: number | null;
  tokensOut?: number | null;
  attemptedChannels?: string[];
  failoverErrors?: Array<{ channelId: string; error: string }>;
  error?: string | null;
  createdAt?: string;
}): number {
  const db = getDb();
  const createdAt = row.createdAt ?? new Date().toISOString();
  const attempted = JSON.stringify(row.attemptedChannels ?? (row.channelId ? [row.channelId] : []));
  const failovers = JSON.stringify(row.failoverErrors ?? []);
  if (typeof row.id === "number") {
    const res = db
      .prepare(`
        INSERT INTO llm_calls (
          id, purpose, subject, status, channel_id, channel_index, model,
          latency_ms, tokens_in, tokens_out, attempted_channels, failover_errors, error, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (id) DO UPDATE SET
          purpose = excluded.purpose,
          subject = excluded.subject,
          status = excluded.status,
          channel_id = excluded.channel_id,
          channel_index = excluded.channel_index,
          model = excluded.model,
          latency_ms = excluded.latency_ms,
          tokens_in = excluded.tokens_in,
          tokens_out = excluded.tokens_out,
          attempted_channels = excluded.attempted_channels,
          failover_errors = excluded.failover_errors,
          error = excluded.error,
          created_at = excluded.created_at
      `)
      .run(
        row.id,
        row.purpose,
        row.subject ?? null,
        row.status,
        row.channelId ?? null,
        row.channelIndex ?? null,
        row.model ?? null,
        row.latencyMs ?? null,
        row.tokensIn ?? null,
        row.tokensOut ?? null,
        attempted,
        failovers,
        row.error ?? null,
        createdAt,
      );
    return Number(res.lastInsertRowid || row.id);
  }
  const res = db
    .prepare(`
      INSERT INTO llm_calls (
        purpose, subject, status, channel_id, channel_index, model,
        latency_ms, tokens_in, tokens_out, attempted_channels, failover_errors, error, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      row.purpose,
      row.subject ?? null,
      row.status,
      row.channelId ?? null,
      row.channelIndex ?? null,
      row.model ?? null,
      row.latencyMs ?? null,
      row.tokensIn ?? null,
      row.tokensOut ?? null,
      attempted,
      failovers,
      row.error ?? null,
      createdAt,
    );
  return Number(res.lastInsertRowid);
}

export function getLlmCallsSince(sinceIso: string | null, limit = 500): LlmCallRow[] {
  const db = getDb();
  if (sinceIso) {
    return db
      .prepare(`
        SELECT id, purpose, subject, status, channel_id, channel_index, model,
               latency_ms, tokens_in, tokens_out, attempted_channels, failover_errors, error, created_at
        FROM llm_calls
        WHERE created_at >= ?
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      `)
      .all(sinceIso, limit) as unknown as LlmCallRow[];
  }
  return db
    .prepare(`
      SELECT id, purpose, subject, status, channel_id, channel_index, model,
             latency_ms, tokens_in, tokens_out, attempted_channels, failover_errors, error, created_at
      FROM llm_calls
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `)
    .all(limit) as unknown as LlmCallRow[];
}

export function getStoredChannelStates(): Record<string, StoredChannelState> {
  const db = getDb();
  const rows = db.prepare("SELECT channel_id, value FROM llm_channel_states").all() as Array<{
    channel_id: string;
    value: string;
  }>;
  const out: Record<string, StoredChannelState> = {};
  for (const r of rows) {
    try {
      out[r.channel_id] = JSON.parse(r.value) as StoredChannelState;
    } catch {
      // ignore invalid JSON
    }
  }
  return out;
}

export function setStoredChannelState(channelId: string, state: StoredChannelState): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO llm_channel_states (channel_id, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT (channel_id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(channelId, JSON.stringify(state), new Date().toISOString());
}

export function getPositionSnapshots(symbol?: string): PositionSnapshotRow[] {
  const db = getDb();
  if (symbol) {
    return db
      .prepare(`
        SELECT id, symbol, day, shares, market_value, unrealized_pnl, note, created_at
        FROM position_snapshots
        WHERE symbol = ?
        ORDER BY day ASC, id ASC
      `)
      .all(symbol) as unknown as PositionSnapshotRow[];
  }
  return db
    .prepare(`
      SELECT id, symbol, day, shares, market_value, unrealized_pnl, note, created_at
      FROM position_snapshots
      ORDER BY day ASC, id ASC
    `)
    .all() as unknown as PositionSnapshotRow[];
}

export function insertPositionSnapshot(row: {
  symbol: string;
  day: string;
  shares?: number | null;
  marketValue: number;
  unrealizedPnl: number;
  note?: string | null;
  createdAt?: string;
}): PositionSnapshotRow {
  const db = getDb();
  const createdAt = row.createdAt ?? new Date().toISOString();
  const res = db
    .prepare(`
      INSERT INTO position_snapshots (symbol, day, shares, market_value, unrealized_pnl, note, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      row.symbol,
      row.day,
      row.shares ?? null,
      row.marketValue,
      row.unrealizedPnl,
      row.note ?? null,
      createdAt,
    );
  const id = Number(res.lastInsertRowid);
  return {
    id,
    symbol: row.symbol,
    day: row.day,
    shares: row.shares ?? null,
    market_value: row.marketValue,
    unrealized_pnl: row.unrealizedPnl,
    note: row.note ?? null,
    created_at: createdAt,
  };
}

export function deletePositionSnapshot(id: number): boolean {
  const db = getDb();
  const res = db.prepare("DELETE FROM position_snapshots WHERE id = ?").run(id);
  return Number(res.changes) > 0;
}

export function getStoredStrategyConfig(symbol: string): StoredStrategyConfig | null {
  const db = getDb();
  const row = db
    .prepare("SELECT value FROM position_strategy_states WHERE symbol = ?")
    .get(symbol) as { value: string } | undefined;
  if (!row?.value) return null;
  try {
    return JSON.parse(row.value) as StoredStrategyConfig;
  } catch {
    return null;
  }
}

export function setStoredStrategyConfig(symbol: string, config: StoredStrategyConfig): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO position_strategy_states (symbol, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT (symbol) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(symbol, JSON.stringify(config), new Date().toISOString());
}

export function getDailyFrozenPlan(symbol: string, day: string): PositionPlanDetail | null {
  const db = getDb();
  const row = db
    .prepare("SELECT plan_json FROM daily_frozen_plans WHERE symbol = ? AND day = ?")
    .get(symbol, day) as { plan_json: string } | undefined;
  if (!row?.plan_json) return null;
  try {
    return JSON.parse(row.plan_json) as PositionPlanDetail;
  } catch {
    return null;
  }
}

export function setDailyFrozenPlan(symbol: string, day: string, plan: PositionPlanDetail): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO daily_frozen_plans (symbol, day, plan_json, created_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT (symbol, day) DO UPDATE SET plan_json = excluded.plan_json, created_at = excluded.created_at
  `).run(symbol, day, JSON.stringify(plan), new Date().toISOString());
}

export function deleteDailyFrozenPlan(symbol?: string, day?: string): void {
  const db = getDb();
  if (symbol && day) {
    db.prepare("DELETE FROM daily_frozen_plans WHERE symbol = ? AND day = ?").run(symbol, day);
  } else if (symbol) {
    db.prepare("DELETE FROM daily_frozen_plans WHERE symbol = ?").run(symbol);
  } else {
    db.prepare("DELETE FROM daily_frozen_plans").run();
  }
}

export function getStoredJson<T>(key: string): T | null {
  const db = getDb();
  const row = db.prepare("SELECT value FROM market_analyses WHERE key = ?").get(key) as { value: string } | undefined;
  if (!row?.value) return null;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return null;
  }
}

export function setStoredJson(key: string, value: unknown): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO market_analyses (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, JSON.stringify(value), new Date().toISOString());
}



