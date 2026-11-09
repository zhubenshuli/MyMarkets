import { closeDb } from "../src/server/db.ts";
import { refreshMarkets } from "../src/server/quotes.ts";
import type { MarketCategory } from "../src/shared/types.ts";

const category = (process.argv[2] as MarketCategory | "all" | undefined) ?? "all";
try {
  console.log(`Refreshing markets (category=${category})...`);
  const written = await refreshMarkets(new Date(), undefined, undefined, category);
  console.log("Done:", JSON.stringify(written, null, 2));
} finally {
  closeDb();
}
