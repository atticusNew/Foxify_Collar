/**
 * PICK WORDS — a parlay leg as a bettor reads it, not as the venue titles it.
 *
 * The public combo catalog names a game two ways. US sports: "Dodgers at Padres" or
 * "Buccaneers vs. Cowboys", with the outcomes the team names. Soccer: one Yes/No market
 * per side, "Will Brighton & Hove Albion FC win on 2026-10-10?", with outcomes Yes and No,
 * and no opponent in the title. A row that says "No · Will Brighton & Hove Albion FC win on
 * 2026-10-10?" is not a pick anyone would recognise; "Brighton not to win" is.
 *
 * Pure string work, no money. Used by the retail shape (the phone) and the public record.
 */

export interface PickWords {
  /** the side the bettor needs: "Cowboys", "Brighton & Hove Albion to win" */
  outcome: string;
  /** the rest of the matchup, to sit after the outcome: "vs Buccaneers", "at Padres"; "" when the venue gives no opponent */
  versus: string;
}

const WILL_WIN = /^will\s+(.+?)\s+win(?:\s+on\s+\d{4}-\d{2}-\d{2})?\s*\??$/i;
const AT = /^(.+?)\s+at\s+(.+)$/i;
const VS = /^(.+?)\s+vs\.?\s+(.+)$/i;

/** Club-name suffixes that are legal form, not what anyone says: "Brighton & Hove Albion FC" is Brighton & Hove Albion. */
export function shortClub(name: string): string {
  return name
    .trim()
    .replace(/^(AFC|FC|SC|CF)\s+/i, "")
    .replace(/\s+(FC|AFC|SC|CF|BC|FK|SK|IF|AC)$/i, "")
    .trim();
}

export function pickWords(outcome: string, title: string): PickWords {
  const o = outcome.trim();
  const t = title.trim();
  const yesNo = /^(yes|no)$/i.exec(o);
  const will = WILL_WIN.exec(t);
  if (yesNo && will) {
    const team = shortClub(will[1]);
    return { outcome: yesNo[1].toLowerCase() === "yes" ? `${team} to win` : `${team} not to win`, versus: "" };
  }
  const at = AT.exec(t);
  if (at) {
    const [away, home] = [at[1].trim(), at[2].trim()];
    if (same(o, away)) return { outcome: o, versus: `at ${home}` };
    if (same(o, home)) return { outcome: o, versus: `vs ${away}` };
  }
  const vs = VS.exec(t);
  if (vs) {
    const [a, b] = [vs[1].trim(), vs[2].trim()];
    if (same(o, a)) return { outcome: o, versus: `vs ${b}` };
    if (same(o, b)) return { outcome: o, versus: `vs ${a}` };
  }
  // the outcome is not a side of the title: show the title as the venue wrote it
  return { outcome: o, versus: t && t !== o ? t : "" };
}

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
