import type { z } from "zod";
import {
  getLlmCallsSince,
  getStoredChannelStates,
  insertLlmCall,
  setStoredChannelState,
  type LlmCallRow,
  type StoredChannelState,
} from "../db.ts";
import { guardedFetch, type GuardedResponse } from "./http-fetch.ts";
import type {
  LlmChannelFailureItem,
  LlmChannelQuotaInfo,
  LlmChannelsOverview,
  LlmChannelStatusItem,
  LlmChannelUsageItem,
  LlmRecentCallItem,
  QuotaMode,
} from "../../shared/types.ts";

export const CHANNEL_FAILURE_LIMIT = 3;
export const CHANNEL_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes

export interface LlmChannel {
  index: number;
  id: string;
  host: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  quotaMode: QuotaMode;
  extra: Record<string, unknown>;
}

const channelStates = new Map<string, StoredChannelState>();

function parseExtraJson(raw: string | undefined): Record<string, unknown> {
  if (!raw?.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function hostOfUrl(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

export function detectQuotaMode(baseUrl: string, explicitMode?: string | null): QuotaMode {
  const normalized = explicitMode?.trim().toLowerCase();
  if (
    normalized === "nvidia" ||
    normalized === "apinex" ||
    normalized === "tokenharbor" ||
    normalized === "http-status" ||
    normalized === "subscription"
  ) {
    return normalized;
  }
  const lowerUrl = baseUrl.toLowerCase();
  if (lowerUrl.includes("apinex.bond")) return "apinex";
  if (lowerUrl.includes("tokenharbor.ai")) return "tokenharbor";
  if (lowerUrl.includes("nvidia.com")) return "nvidia";
  return "http-status";
}

export function getTokenThreshold(): number {
  const val = process.env.LLM_TOKEN_THRESHOLD;
  if (val !== undefined && val !== "") {
    const num = Number(val);
    if (Number.isFinite(num) && num >= 0) return num;
  }
  return 50_000;
}

export function getLlmRpm(): number {
  const val = process.env.LLM_RPM;
  if (val !== undefined && val !== "") {
    const num = Number(val);
    if (Number.isFinite(num) && num >= 0) return num;
  }
  return 5;
}

export function getLlmIntervalMs(): number {
  const rpm = getLlmRpm();
  return rpm > 0 ? Math.round(60_000 / rpm) : 0;
}

export function loadChannels(): LlmChannel[] {
  const channels: LlmChannel[] = [];
  const primaryUrl = process.env.LLM_BASE_URL?.trim();
  const primaryKey = process.env.LLM_API_KEY?.trim();
  const primaryModel = (process.env.MARKET_ANALYSIS_MODEL?.trim() || process.env.LLM_MODEL?.trim()) ?? "deepseek-flash";
  const primaryExtra = parseExtraJson(process.env.LLM_EXTRA_JSON);
  const primaryQuotaEnv = process.env.LLM_CHANNEL_1_QUOTA_MODE ?? process.env.LLM_QUOTA_MODE;

  if (primaryUrl && primaryKey) {
    const cleanUrl = primaryUrl.replace(/\/+$/, "");
    channels.push({
      index: 1,
      id: "ch-1",
      host: hostOfUrl(cleanUrl),
      baseUrl: cleanUrl,
      apiKey: primaryKey,
      model: primaryModel,
      quotaMode: detectQuotaMode(cleanUrl, primaryQuotaEnv),
      extra: primaryExtra,
    });
  }

  for (let i = 2; i <= 20; i++) {
    const baseUrl = process.env[`LLM_CHANNEL_${i}_BASE_URL`]?.trim();
    const apiKey = process.env[`LLM_CHANNEL_${i}_API_KEY`]?.trim();
    const model = process.env[`LLM_CHANNEL_${i}_MODEL`]?.trim() || primaryModel;
    const extraRaw = process.env[`LLM_CHANNEL_${i}_EXTRA_JSON`];
    const extra = extraRaw !== undefined ? parseExtraJson(extraRaw) : primaryExtra;
    const quotaMode = detectQuotaMode(baseUrl ?? "", process.env[`LLM_CHANNEL_${i}_QUOTA_MODE`]);
    if (baseUrl && apiKey) {
      const cleanUrl = baseUrl.replace(/\/+$/, "");
      channels.push({
        index: i,
        id: `ch-${i}`,
        host: hostOfUrl(cleanUrl),
        baseUrl: cleanUrl,
        apiKey,
        model,
        quotaMode,
        extra,
      });
    }
  }
  return channels;
}

function normalizeChannelId(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  const m = /^channel_(\d+)$/i.exec(trimmed);
  if (m) return `ch-${m[1]}`;
  return trimmed;
}

export function syncChannelStatesFromDb(): void {
  try {
    const saved = getStoredChannelStates();
    for (const [rawId, remote] of Object.entries(saved)) {
      const id = normalizeChannelId(rawId) ?? rawId;
      const local = channelStates.get(id);
      if (!local || (remote.updatedAtMs ?? 0) >= (local.updatedAtMs ?? 0)) {
        channelStates.set(id, {
          consecutiveFailures: Number(remote.consecutiveFailures ?? 0),
          cooldownUntil: Number(remote.cooldownUntil ?? 0),
          exhaustedUntil: Number(remote.exhaustedUntil ?? 0),
          lastSuccessAt: remote.lastSuccessAt ?? local?.lastSuccessAt ?? null,
          lastErrorAt: remote.lastErrorAt ?? null,
          lastError: remote.lastError ?? null,
          recentFailures: remote.recentFailures ?? local?.recentFailures ?? [],
          quotaInfo: remote.quotaInfo ?? local?.quotaInfo ?? null,
          resetAt: remote.resetAt ?? 0,
          updatedAtMs: remote.updatedAtMs ?? Date.now(),
        });
      }
    }
  } catch {
    // ignore db read errors on cold start
  }
}

export function getChannelState(channelId: string): StoredChannelState {
  const normId = normalizeChannelId(channelId) ?? channelId;
  let state = channelStates.get(normId);
  if (!state) {
    state = { consecutiveFailures: 0, cooldownUntil: 0, exhaustedUntil: 0 };
    channelStates.set(normId, state);
  }
  return state;
}

function persistState(channelId: string): void {
  const normId = normalizeChannelId(channelId) ?? channelId;
  const state = channelStates.get(normId);
  if (!state) return;
  try {
    setStoredChannelState(normId, state);
  } catch {
    // ignore persistence errors
  }
}

export function isChannelAvailable(channelId: string, nowMs = Date.now()): boolean {
  const state = getChannelState(channelId);
  if (state.cooldownUntil > 0 && nowMs >= state.cooldownUntil) {
    state.cooldownUntil = 0;
    state.consecutiveFailures = 0;
  }
  if (state.exhaustedUntil > 0 && nowMs >= state.exhaustedUntil) {
    state.exhaustedUntil = 0;
  }
  return nowMs >= state.exhaustedUntil && nowMs >= state.cooldownUntil;
}

export function recordChannelSuccess(channelId: string, nowMs = Date.now()): void {
  const state = getChannelState(channelId);
  state.consecutiveFailures = 0;
  state.cooldownUntil = 0;
  state.exhaustedUntil = 0;
  state.lastSuccessAt = new Date(nowMs).toISOString();
  state.updatedAtMs = nowMs;
  persistState(channelId);
}

export function recordChannelFailure(channelId: string, nowMs = Date.now(), errorMsg?: string): StoredChannelState {
  const state = getChannelState(channelId);
  state.lastErrorAt = new Date(nowMs).toISOString();
  if (errorMsg) {
    state.lastError = errorMsg.slice(0, 300);
    state.recentFailures ??= [];
    state.recentFailures.unshift({ at: new Date(nowMs).toISOString(), error: errorMsg.slice(0, 300) });
    if (state.recentFailures.length > 20) state.recentFailures.length = 20;
  }
  if (nowMs < state.cooldownUntil) {
    state.consecutiveFailures = CHANNEL_FAILURE_LIMIT;
    state.updatedAtMs = nowMs;
    persistState(channelId);
    return state;
  }
  state.consecutiveFailures += 1;
  if (state.consecutiveFailures >= CHANNEL_FAILURE_LIMIT) {
    state.cooldownUntil = nowMs + CHANNEL_COOLDOWN_MS;
    state.consecutiveFailures = CHANNEL_FAILURE_LIMIT;
  }
  state.updatedAtMs = nowMs;
  persistState(channelId);
  return state;
}

export function markChannelExhausted(
  channelId: string,
  untilMs: number,
  errorMsg?: string,
  nowMs = Date.now(),
): StoredChannelState {
  const state = getChannelState(channelId);
  state.exhaustedUntil = untilMs;
  state.consecutiveFailures = 0;
  if (errorMsg) {
    state.lastErrorAt = new Date(nowMs).toISOString();
    state.lastError = errorMsg.slice(0, 300);
    state.recentFailures ??= [];
    state.recentFailures.unshift({ at: new Date(nowMs).toISOString(), error: errorMsg.slice(0, 300) });
    if (state.recentFailures.length > 20) state.recentFailures.length = 20;
  }
  state.updatedAtMs = nowMs;
  persistState(channelId);
  return state;
}

export function updateChannelQuotaInfo(channelId: string, info: LlmChannelQuotaInfo, nowMs = Date.now()): void {
  const state = getChannelState(channelId);
  state.quotaInfo = { ...state.quotaInfo, ...info, updatedAt: new Date(nowMs).toISOString() };
  state.updatedAtMs = nowMs;
  persistState(channelId);
}

export function getNextUtcResetMs(nowMs = Date.now()): number {
  const d = new Date(nowMs);
  const nextDayOffset = d.getUTCHours() < 1 ? 0 : 1;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + nextDayOffset, 1, 0, 0, 0);
}

const HTTP_QUOTA_EXHAUSTED_RE =
  /\binsufficient_quota\b|\bcredit_balance_exhausted\b|\bsponsored_pool_exhausted\b|\bpool has been used up\b|\bFreeUsageLimitError\b|\bGoUsageLimitError\b|\bfree_usage_limit\b|\bgo_usage_limit\b|\bCreditLimitExceeded\b|\bout of credits\b|\bnot enough credits\b|\binsufficient (?:account |credit )?balance\b|\b(?:credit )?balance (?:is )?(?:exhausted|insufficient)\b|\bfree allocated quota exceeded\b|账户.*欠费|余额不足|额度耗尽/i;

export async function fetchLiveSubscriptionQuota(ch: LlmChannel, timeoutMs = 3_500): Promise<LlmChannelQuotaInfo | null> {
  if (ch.quotaMode !== "apinex" && ch.quotaMode !== "subscription") return null;
  try {
    const res = await guardedFetch(`${ch.baseUrl}/subscription`, {
      method: "GET",
      timeoutMs,
      headers: { authorization: `Bearer ${ch.apiKey}` },
    });
    if (res.status !== 200) return null;
    const data = JSON.parse(res.text()) as {
      unlimited?: boolean;
      allowed?: boolean;
      token_limit?: number | null;
      tokens_remaining?: number | null;
      resets_at_utc?: string | null;
    };
    const limit = typeof data.token_limit === "number" ? data.token_limit : null;
    const remaining = typeof data.tokens_remaining === "number" ? data.tokens_remaining : null;
    const usedPct =
      limit && limit > 0 && remaining !== null ? Math.round(((limit - remaining) / limit) * 1000) / 10 : null;
    const info: LlmChannelQuotaInfo = {
      remainingTokens: remaining,
      limitTokens: limit,
      usedPct,
      resetsAt: data.resets_at_utc ?? null,
      unlimited: data.unlimited ?? null,
      updatedAt: new Date().toISOString(),
    };
    const state = getChannelState(ch.id);
    const recovered =
      data.unlimited === true ||
      (data.allowed === true && typeof remaining === "number" && remaining > getTokenThreshold());
    if (recovered && state.exhaustedUntil > 0) {
      state.exhaustedUntil = 0;
    }
    updateChannelQuotaInfo(ch.id, info);
    return info;
  } catch {
    return null;
  }
}

export type QuotaCheckResult = { exhausted: false } | { exhausted: true; untilMs: number };

export async function checkChannelQuotaExhausted(
  channel: LlmChannel,
  res: GuardedResponse | null,
  responseText: string,
  nowMs = Date.now(),
): Promise<QuotaCheckResult> {
  const defaultResetMs = getNextUtcResetMs(nowMs);

  if (channel.quotaMode === "apinex" || channel.quotaMode === "subscription") {
    const liveInfo = await fetchLiveSubscriptionQuota(channel, 5_000);
    if (liveInfo) {
      if (liveInfo.unlimited === true) return { exhausted: false };
      const threshold = getTokenThreshold();
      if (typeof liveInfo.remainingTokens === "number" && liveInfo.remainingTokens <= threshold) {
        return { exhausted: true, untilMs: defaultResetMs };
      }
    }
    if (res?.status === 402) return { exhausted: true, untilMs: defaultResetMs };
    return { exhausted: false };
  }

  if (channel.quotaMode === "tokenharbor") {
    if (!res) return { exhausted: false };
    const usedPctHeader = res.headers.get("x-th-free-used-pct");
    const usedPct = usedPctHeader !== null && usedPctHeader !== "" ? Number(usedPctHeader) : Number.NaN;
    const resetHeader = res.headers.get("x-th-free-resets");
    const parsedReset = resetHeader ? Date.parse(resetHeader) : Number.NaN;
    const untilMs = Number.isFinite(parsedReset) && parsedReset > nowMs ? parsedReset : defaultResetMs;

    if (Number.isFinite(usedPct) || resetHeader) {
      updateChannelQuotaInfo(channel.id, {
        usedPct: Number.isFinite(usedPct) ? usedPct : null,
        resetsAt: Number.isFinite(parsedReset) ? new Date(parsedReset).toISOString() : null,
      });
    }

    if (Number.isFinite(usedPct) && usedPct >= 100) {
      return { exhausted: true, untilMs };
    }
    if (res.status === 402) {
      return { exhausted: true, untilMs };
    }
    if (
      res.status === 429 &&
      (!Number.isFinite(usedPct) || usedPct >= 100) &&
      (/allowance|free[- ]tier|rolling.*7[- ]day/i.test(responseText) || HTTP_QUOTA_EXHAUSTED_RE.test(responseText))
    ) {
      return { exhausted: true, untilMs };
    }
    return { exhausted: false };
  }

  if (!res) return { exhausted: false };
  if (res.status === 402) {
    return { exhausted: true, untilMs: defaultResetMs };
  }
  if ((res.status === 403 || res.status === 429) && HTTP_QUOTA_EXHAUSTED_RE.test(responseText)) {
    return { exhausted: true, untilMs: defaultResetMs };
  }
  return { exhausted: false };
}

function escapeInnerQuotesAndNewlines(raw: string): string {
  let out = "";
  let inStr = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!;
    if (c === "\\" && inStr && i + 1 < raw.length) {
      out += c + raw[i + 1]!;
      i++;
      continue;
    }
    if (c === '"') {
      if (!inStr) {
        inStr = true;
        out += c;
      } else {
        let j = i + 1;
        while (j < raw.length && /\s/.test(raw[j]!)) j++;
        const next = raw[j];
        if (next === ":" || next === "}" || next === "]" || next === undefined) {
          inStr = false;
          out += c;
        } else if (next === ",") {
          let k = j + 1;
          while (k < raw.length && /\s/.test(raw[k]!)) k++;
          const afterComma = raw[k];
          if (
            afterComma === '"' ||
            afterComma === "{" ||
            afterComma === "[" ||
            afterComma === "}" ||
            afterComma === "]" ||
            (afterComma !== undefined && /[-0-9tfn]/.test(afterComma))
          ) {
            inStr = false;
            out += c;
          } else {
            out += "”";
          }
        } else {
          out += "“";
        }
      }
      continue;
    }
    if (inStr && (c === "\n" || c === "\r")) {
      out += " ";
      continue;
    }
    out += c;
  }
  return out;
}

function repairMalformedJson(raw: string): string {
  let s = escapeInnerQuotesAndNewlines(raw);
  // Fix accidental `},{"key":{` inside a dictionary object
  s = s.replace(/\}\s*,\s*\{\s*("[a-zA-Z0-9_]+"\s*:\s*\{)/g, "}, $1");
  // Remove trailing commas before `}` or `]`
  s = s.replace(/,\s*([}\]])/g, "$1");
  return s;
}

function extractJsonObject(raw: string): unknown {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1]!.trim() : trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) {
      const slice = candidate.slice(start, end + 1);
      try {
        return JSON.parse(slice);
      } catch {
        const repaired = repairMalformedJson(slice);
        try {
          return JSON.parse(repaired);
        } catch {
          if (repaired.endsWith("}}")) {
            return JSON.parse(repaired.slice(0, -1));
          }
          throw new Error("LLM response did not contain valid JSON");
        }
      }
    }
    throw new Error("LLM response did not contain valid JSON");
  }
}

export interface ChatJsonInput<T extends z.ZodTypeAny> {
  system: string;
  user: string;
  schema: T;
  temperature?: number;
  maxTokens?: number;
  purpose?: string;
  subject?: string;
}

export interface ChatJsonResult<T> {
  data: T;
  channelId: string;
  channelIndex: number;
  model: string;
  host: string;
  latencyMs: number;
  tokensIn: number;
  tokensOut: number;
}

export async function chatJson<T extends z.ZodTypeAny>(
  input: ChatJsonInput<T>,
): Promise<ChatJsonResult<z.infer<T>>> {
  syncChannelStatesFromDb();
  const channels = loadChannels();
  if (channels.length === 0) {
    throw new Error("No LLM channels configured");
  }

  const nowMs = Date.now();
  let candidates = channels.filter((ch) => isChannelAvailable(ch.id, nowMs));
  if (candidates.length === 0) {
    candidates = channels;
  }

  const errors: string[] = [];
  const attemptedChannels: string[] = [];
  const failoverErrors: Array<{ channelId: string; error: string }> = [];
  const purpose = input.purpose ?? "market_analysis";
  const subject = input.subject ?? null;

  for (const ch of candidates) {
    if (!isChannelAvailable(ch.id, Date.now()) && candidates.some((c) => isChannelAvailable(c.id, Date.now()))) {
      continue;
    }
    attemptedChannels.push(ch.id);
    const maxAttempts = candidates.length === 1 ? 2 : 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const startMs = performance.now();
      let res: GuardedResponse | null = null;
      let resText = "";
      try {
        const url = `${ch.baseUrl}/chat/completions`;
        const bodyObj: Record<string, unknown> = {
          model: ch.model,
          messages: [
            { role: "system", content: input.system },
            { role: "user", content: input.user },
          ],
          temperature: input.temperature ?? 0.2,
          max_tokens: input.maxTokens ?? 2500,
          ...(process.env.LLM_JSON_MODE === "false" ? {} : { response_format: { type: "json_object" } }),
          ...ch.extra,
        };

        res = await guardedFetch(url, {
          method: "POST",
          timeoutMs: 60_000,
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${ch.apiKey}`,
          },
          body: JSON.stringify(bodyObj),
        });
        resText = res.text();
        const latencyMs = Math.round(performance.now() - startMs);

        if (res.status !== 200) {
          const errSummary = `HTTP ${res.status}: ${resText.slice(0, 240)}`;
          failoverErrors.push({ channelId: ch.id, error: errSummary });
          const quota = await checkChannelQuotaExhausted(ch, res, resText);
          if (quota.exhausted) {
            markChannelExhausted(ch.id, quota.untilMs, errSummary);
          } else {
            recordChannelFailure(ch.id, Date.now(), errSummary);
          }
          attempt = maxAttempts; // Do not retry non-200 HTTP status on same channel
          throw new Error(errSummary);
        }

        const payload = JSON.parse(resText) as {
          model?: string;
          choices?: Array<{ message?: { content?: string | null } }>;
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        const content = payload.choices?.[0]?.message?.content;
        if (!content) {
          throw new Error("Empty LLM content");
        }

        const parsed = extractJsonObject(content);
        const validated = input.schema.parse(parsed);
        const tokensIn = Number(payload.usage?.prompt_tokens ?? 0);
        const tokensOut = Number(payload.usage?.completion_tokens ?? 0);
        const actualModel = payload.model?.trim() || ch.model;

        recordChannelSuccess(ch.id);
        if (ch.quotaMode === "tokenharbor") {
          const quota = await checkChannelQuotaExhausted(ch, res, resText);
          if (quota.exhausted) {
            markChannelExhausted(ch.id, quota.untilMs);
          }
        } else if (ch.quotaMode === "apinex" || ch.quotaMode === "subscription") {
          void fetchLiveSubscriptionQuota(ch).catch(() => {});
        }

        insertLlmCall({
          purpose,
          subject,
          status: "completed",
          channelId: ch.id,
          channelIndex: ch.index,
          model: actualModel,
          latencyMs,
          tokensIn,
          tokensOut,
          attemptedChannels,
          failoverErrors,
          error: null,
        });

        return {
          data: validated,
          channelId: ch.id,
          channelIndex: ch.index,
          model: actualModel,
          host: ch.host,
          latencyMs,
          tokensIn,
          tokensOut,
        };
      } catch (err) {
        const msg = (err as Error).message;
        if (attempt < maxAttempts) {
          continue;
        }
        errors.push(`${ch.id} (${ch.model}): ${msg}`);
        if (!failoverErrors.some((fe) => fe.channelId === ch.id)) {
          failoverErrors.push({ channelId: ch.id, error: msg.slice(0, 240) });
          recordChannelFailure(ch.id, Date.now(), msg);
        }
      }
    }
  }

  const finalError = `All LLM channels failed: ${errors.join(" | ")}`;
  const lastCh = candidates.at(-1) ?? channels[0];
  insertLlmCall({
    purpose,
    subject,
    status: "failed",
    channelId: lastCh?.id ?? null,
    channelIndex: lastCh?.index ?? null,
    model: lastCh?.model ?? null,
    latencyMs: null,
    tokensIn: 0,
    tokensOut: 0,
    attemptedChannels,
    failoverErrors,
    error: finalError.slice(0, 500),
  });

  throw new Error(finalError);
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
  return sorted[idx]!;
}

function parseJsonArray<T>(raw: string | null | undefined): T[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

export async function getChannelsOverview(days = 0): Promise<LlmChannelsOverview> {
  syncChannelStatesFromDb();
  const channels = loadChannels();
  const now = new Date();
  const sinceIso =
    days < 0
      ? null
      : days === 0
        ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0)).toISOString()
        : new Date(now.getTime() - days * 86_400_000).toISOString();

  const liveQuotas = new Map<string, LlmChannelQuotaInfo | null>(
    await Promise.all(channels.map(async (ch) => [ch.id, await fetchLiveSubscriptionQuota(ch)] as const)),
  );

  const rows = getLlmCallsSince(sinceIso, 500);
  const allRecentRows = sinceIso !== null ? getLlmCallsSince(null, 50) : rows.slice(0, 50);

  const resolveRowChannelId = (r: LlmCallRow): string | null => {
    const norm = normalizeChannelId(r.channel_id);
    if (norm && channels.some((c) => c.id === norm)) return norm;
    if (r.model) {
      const mLower = r.model.toLowerCase();
      const exact = channels.find((c) => c.model.toLowerCase() === mLower);
      if (exact) return exact.id;
      const stripped = channels.find((c) => c.model.toLowerCase().replace(/:free$/, "") === mLower);
      if (stripped) return stripped.id;
    }
    return norm;
  };

  const nowMs = Date.now();
  const activeChannel = channels.find((c) => isChannelAvailable(c.id, nowMs)) ?? channels[0] ?? null;

  const failoverRowsByCh = new Map<string, LlmCallRow[]>();
  for (const r of rows) {
    const attempted = parseJsonArray<string>(r.attempted_channels).map((id) => normalizeChannelId(id) ?? id);
    if (attempted.length > 1) {
      for (const chId of attempted.slice(0, -1)) {
        let list = failoverRowsByCh.get(chId);
        if (!list) {
          list = [];
          failoverRowsByCh.set(chId, list);
        }
        list.push(r);
      }
    }
  }

  const channelItems: LlmChannelStatusItem[] = channels.map((ch) => {
    const state = getChannelState(ch.id);
    const isExhausted = nowMs < state.exhaustedUntil;
    const isCooldown = !isExhausted && nowMs < state.cooldownUntil;
    const available = !isExhausted && !isCooldown;
    const status: LlmChannelStatusItem["status"] = isExhausted
      ? "exhausted"
      : isCooldown
        ? "cooldown"
        : activeChannel?.id === ch.id
          ? "active"
          : "standby";

    const chRows = rows.filter((r) => resolveRowChannelId(r) === ch.id);
    const chFailoverRows = failoverRowsByCh.get(ch.id) ?? [];
    const latencies = chRows
      .map((r) => r.latency_ms)
      .filter((v): v is number => typeof v === "number" && Number.isFinite(v))
      .sort((a, b) => a - b);

    const byPurpose = new Map<string, { landed: LlmCallRow[]; failedOver: LlmCallRow[] }>();
    for (const r of chRows) {
      const key = r.subject?.startsWith("pork")
        ? "pork_analysis"
        : r.subject?.startsWith("aviation")
          ? "aviation_analysis"
          : r.subject?.startsWith("hstech")
            ? "hstech_analysis"
            : r.purpose;
      let bucket = byPurpose.get(key);
      if (!bucket) {
        bucket = { landed: [], failedOver: [] };
        byPurpose.set(key, bucket);
      }
      bucket.landed.push(r);
    }
    for (const r of chFailoverRows) {
      const key = r.subject?.startsWith("pork")
        ? "pork_analysis"
        : r.subject?.startsWith("aviation")
          ? "aviation_analysis"
          : r.subject?.startsWith("hstech")
            ? "hstech_analysis"
            : r.purpose;
      let bucket = byPurpose.get(key);
      if (!bucket) {
        bucket = { landed: [], failedOver: [] };
        byPurpose.set(key, bucket);
      }
      bucket.failedOver.push(r);
    }

    const usage: LlmChannelUsageItem[] = Array.from(byPurpose.entries())
      .map(([purpose, { landed, failedOver }]) => {
        const lats = landed
          .map((r) => r.latency_ms)
          .filter((v): v is number => typeof v === "number" && Number.isFinite(v))
          .sort((a, b) => a - b);
        const okCount = landed.filter((r) => r.status === "completed").length;
        const failCount = landed.filter((r) => r.status === "failed").length + failedOver.length;
        const latestLanded = landed[0]?.created_at ?? null;
        const latestFailover = failedOver[0]?.created_at ?? null;
        const lastAt =
          latestLanded && latestFailover
            ? latestLanded > latestFailover
              ? latestLanded
              : latestFailover
            : latestLanded ?? latestFailover;
        return {
          purpose,
          calls: okCount + failCount,
          ok: okCount,
          failed: failCount,
          p50: percentile(lats, 0.5),
          p95: percentile(lats, 0.95),
          tokensIn: landed.reduce((acc, r) => acc + (r.tokens_in ?? 0), 0),
          tokensOut: landed.reduce((acc, r) => acc + (r.tokens_out ?? 0), 0),
          lastAt,
        };
      })
      .sort((a, b) => b.calls - a.calls);

    const totalOk = chRows.filter((r) => r.status === "completed").length;
    const totalFailed = chRows.filter((r) => r.status === "failed").length + chFailoverRows.length;
    const allChOkRow = allRecentRows.find((r) => resolveRowChannelId(r) === ch.id && r.status === "completed");
    const lastSuccessAt =
      state.lastSuccessAt && allChOkRow?.created_at
        ? state.lastSuccessAt > allChOkRow.created_at
          ? state.lastSuccessAt
          : allChOkRow.created_at
        : state.lastSuccessAt ?? allChOkRow?.created_at ?? null;

    const mergedQuota = liveQuotas.get(ch.id) ?? state.quotaInfo ?? null;

    const recentFailures: LlmChannelFailureItem[] = [];
    for (const r of chFailoverRows) {
      const fErrors = parseJsonArray<{ channelId: string; error: string }>(r.failover_errors);
      const matched = fErrors.find((fe) => (normalizeChannelId(fe.channelId) ?? fe.channelId) === ch.id);
      if (matched) {
        recentFailures.push({
          at: r.created_at,
          error: matched.error,
          callId: r.id,
          purpose: r.purpose,
        });
      }
    }
    for (const r of chRows) {
      if (r.status === "failed" && r.error) {
        recentFailures.push({
          at: r.created_at,
          error: r.error,
          callId: r.id,
          purpose: r.purpose,
        });
      }
    }
    if (Array.isArray(state.recentFailures)) {
      for (const rf of state.recentFailures) {
        if (rf?.at && rf?.error && !recentFailures.some((existing) => existing.at === rf.at)) {
          recentFailures.push({
            at: rf.at,
            error: rf.error,
            callId: null,
            purpose: null,
          });
        }
      }
    }
    recentFailures.sort((a, b) => b.at.localeCompare(a.at));

    return {
      id: ch.id,
      index: ch.index,
      host: ch.host,
      baseUrl: ch.baseUrl,
      model: ch.model,
      quotaMode: ch.quotaMode,
      status,
      available,
      consecutiveFailures: state.consecutiveFailures,
      failureLimit: CHANNEL_FAILURE_LIMIT,
      cooldownUntil: isCooldown ? new Date(state.cooldownUntil).toISOString() : null,
      exhaustedUntil: isExhausted ? new Date(state.exhaustedUntil).toISOString() : null,
      lastSuccessAt,
      lastErrorAt: state.lastErrorAt ?? null,
      lastError: state.lastError ?? null,
      recentFailures: recentFailures.slice(0, 15),
      quotaInfo: mergedQuota,
      totals: {
        calls: totalOk + totalFailed,
        ok: totalOk,
        failed: totalFailed,
        failoverFrom: chFailoverRows.length,
        p50: percentile(latencies, 0.5),
        p95: percentile(latencies, 0.95),
        tokensIn: chRows.reduce((acc, r) => acc + (r.tokens_in ?? 0), 0),
        tokensOut: chRows.reduce((acc, r) => acc + (r.tokens_out ?? 0), 0),
      },
      usage,
    };
  });

  // Always show recent calls (up to 30), using the filtered range or falling back to all recent calls if today has none yet
  const sourceCallRows = rows.length > 0 ? rows : allRecentRows;
  const recentCalls: LlmRecentCallItem[] = sourceCallRows.slice(0, 30).map((r) => {
    const chId = resolveRowChannelId(r);
    const chObj = channels.find((c) => c.id === chId);
    const attemptedRaw = parseJsonArray<string>(r.attempted_channels).map((id) => normalizeChannelId(id) ?? id);
    const attempted = attemptedRaw.length > 0 ? attemptedRaw : chId ? [chId] : [];
    const failoverErrors = parseJsonArray<{ channelId: string; error: string }>(r.failover_errors).map((fe) => ({
      channelId: normalizeChannelId(fe.channelId) ?? fe.channelId,
      error: fe.error,
    }));
    const derivedPurpose = r.subject?.startsWith("pork")
      ? "pork_analysis"
      : r.subject?.startsWith("aviation")
        ? "aviation_analysis"
        : r.subject?.startsWith("hstech")
          ? "hstech_analysis"
          : r.purpose;

    return {
      id: r.id,
      channelId: chId,
      channelIndex: chObj?.index ?? r.channel_index ?? null,
      host: chObj?.host ?? null,
      model: r.model ?? chObj?.model ?? null,
      purpose: derivedPurpose,
      subject: r.subject,
      status: r.status,
      latencyMs: r.latency_ms,
      tokensIn: r.tokens_in ?? 0,
      tokensOut: r.tokens_out ?? 0,
      attemptedChannels: attempted,
      failoverErrors,
      error: r.error,
      at: r.created_at,
    };
  });

  return {
    days,
    rpm: getLlmRpm(),
    intervalMs: getLlmIntervalMs(),
    tokenThreshold: getTokenThreshold(),
    modelCallsEnabled: process.env.MODEL_CALLS_ENABLED === "true",
    activeChannelId: activeChannel?.id ?? null,
    channels: channelItems,
    recentCalls,
  };
}

export function resetChannelState(channelId: string): { ok: true; channelId: string } {
  syncChannelStatesFromDb();
  const channels = loadChannels();
  const targetIds = channelId === "all" ? channels.map((c) => c.id) : [normalizeChannelId(channelId) ?? channelId];
  const now = Date.now();
  for (const id of targetIds) {
    const state = getChannelState(id);
    state.consecutiveFailures = 0;
    state.cooldownUntil = 0;
    state.exhaustedUntil = 0;
    state.lastError = null;
    state.lastErrorAt = null;
    state.recentFailures = [];
    state.resetAt = now;
    state.updatedAtMs = now;
    persistState(id);
  }
  return { ok: true, channelId };
}
