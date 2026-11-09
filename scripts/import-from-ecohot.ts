import { readFileSync } from "node:fs";
import {
  closeDb,
  countTotalCloses,
  insertLlmCall,
  setStoredAnalysis,
  setStoredChannelState,
  upsertCloses,
  type StoredChannelState,
} from "../src/server/db.ts";
import type { PorkMarketAnalysis } from "../src/shared/types.ts";

interface ExportBundle {
  closes?: Array<{ symbol: string; day: string; close: number }>;
  analyses?: Array<{ key: string; value: PorkMarketAnalysis }>;
  llmCalls?: Array<Parameters<typeof insertLlmCall>[0]>;
  channelStates?: Record<string, StoredChannelState>;
}

const inputFile = process.argv[2];
if (!inputFile) {
  console.error("Usage: node scripts/import-from-ecohot.ts <export.json>");
  process.exit(1);
}

try {
  const bundle = JSON.parse(readFileSync(inputFile, "utf8")) as ExportBundle;
  const written = upsertCloses(bundle.closes ?? []);
  let analysesCount = 0;
  for (const item of bundle.analyses ?? []) {
    if (item.key && item.value) {
      setStoredAnalysis(item.key, item.value);
      analysesCount++;
    }
  }
  let callsCount = 0;
  for (const call of bundle.llmCalls ?? []) {
    insertLlmCall(call);
    callsCount++;
  }
  let statesCount = 0;
  for (const [chId, state] of Object.entries(bundle.channelStates ?? {})) {
    setStoredChannelState(chId, state);
    statesCount++;
  }
  console.log(JSON.stringify({
    importedCloses: written,
    totalCloses: countTotalCloses(),
    importedAnalyses: analysesCount,
    importedLlmCalls: callsCount,
    importedChannelStates: statesCount,
  }));
} finally {
  closeDb();
}
