/**
 * Bitnomial live pricefeed probe (read-only) — capture HUP futures + HUPO option books so we can see
 * real symbols/prices and wire the hashprice fix/floor precisely. Run during Bitnomial market hours
 * (8:30am–2:30pm CT, Mon–Fri) — the book is closed otherwise (you'll get no snapshots).
 *
 *   npm --workspace services/api run miner-protect:bitnomial
 */
import { probeBitnomialBooks, hupToUsdPerThDay } from "../src/minerProtect/bitnomialPricefeed";

async function main() {
  console.log("\n→ Bitnomial WS book probe: HUP (hashrate futures) + HUPO (options)\n");
  let opened = false, errored: unknown = null, messages = 0;
  const books = await probeBitnomialBooks(["HUP", "HUPO"], {
    collectMs: 6000,
    onEvent: (evt, info) => {
      if (evt === "open") { opened = true; console.log("  · ws connected"); }
      else if (evt === "message") { messages = Number(info) || messages; }
      else if (evt === "error") { errored = info; console.log(`  · ws error: ${(info as Error)?.message ?? info}`); }
      else if (evt === "close") { console.log(`  · ws closed (received ${info ?? 0} messages)`); }
    }
  });
  console.log(`\nConnection: ${opened ? "OPENED" : "did NOT open"}${errored ? " · ERRORED" : ""} · ${messages} messages\n`);
  const symbols = Object.keys(books).sort();
  if (!symbols.length) {
    if (!opened) console.log("⚠ Could not connect to Bitnomial WS (network/firewall or wrong URL) — NOT a market-hours issue.");
    else if (messages === 0) console.log("Connected but no data — market likely closed [8:30–2:30 CT, Mon–Fri]. Re-run during hours.");
    else console.log("Connected and received messages but no book snapshots (no HUP/HUPO listings matched, or book closed).");
    return;
  }
  console.log(`Got ${symbols.length} book(s):\n`);
  for (const s of symbols) {
    const b = books[s];
    const isFuture = !/[CP]/.test(s.slice(3)); // heuristic; refine once symbology confirmed
    const hp = hupToUsdPerThDay(b.mid);
    console.log(`  ${s.padEnd(16)} bid ${b.best_bid ?? "—"} / ask ${b.best_ask ?? "—"} / mid ${b.mid ?? "—"}  ${isFuture && hp != null ? `→ $${hp}/TH/day` : ""}`);
  }
  console.log("\nUse the option (HUPO) symbols above to wire the hashprice FLOOR (put) strike/expiry selection.\n");
}

main().catch((e) => { console.error(e); process.exit(1); });
