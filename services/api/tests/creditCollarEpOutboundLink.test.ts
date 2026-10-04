/**
 * Outbound cross-links (perp site → track record, prediction demo, prediction record) and the
 * operator's traffic page. The links fail closed: hidden until a /healthz answers, hidden again
 * when it stops; an empty env value switches a link off for good.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { OutboundLink, type ProbeFetch } from "../src/singleSide/twoSided/creditCollar/epOutboundLink";
import { emptyFunnel, funnelSummary, recordLooker, recordPageLoad, renderEpFunnelHtml, FUNNEL_PAGES, FUNNEL_PAGE_LABELS } from "../src/singleSide/twoSided/creditCollar/epFunnel";

const answering = (status: number): ProbeFetch => async () => ({ ok: status >= 200 && status < 300, status });
const unreachable: ProbeFetch = async () => {
  throw new Error("ECONNREFUSED");
};
const quiet = (): void => {};

test("outbound link: defaults apply, trailing slashes drop, empty env switches it off", () => {
  const dflt = new OutboundLink("prediction markets", undefined, "https://event.earnandprotect.xyz/");
  assert.equal(dflt.url, "https://event.earnandprotect.xyz");
  assert.ok(dflt.configured);
  const env = new OutboundLink("track record", " https://facility.atticustrade.com// ", "https://x.invalid");
  assert.equal(env.url, "https://facility.atticustrade.com");
  const off = new OutboundLink("prediction record", "", "https://atticus-event-shadow.onrender.com");
  assert.equal(off.url, "");
  assert.ok(!off.configured);
  assert.equal(off.href, "");
});

test("outbound link: hidden until /healthz answers 2xx, hidden again when it stops or errors", async () => {
  const l = new OutboundLink("prediction markets", undefined, "https://event.earnandprotect.xyz");
  assert.equal(l.href, "", "fail closed before the first probe");
  const seen: string[] = [];
  const probe: ProbeFetch = async (url) => {
    seen.push(url);
    return { ok: true, status: 200 };
  };
  assert.equal(await l.probe(probe, 1000, quiet), true);
  assert.deepEqual(seen, ["https://event.earnandprotect.xyz/healthz"], "probes the sister service's /healthz");
  assert.equal(l.href, "https://event.earnandprotect.xyz");
  assert.equal(await l.probe(answering(503), 1000, quiet), false);
  assert.equal(l.href, "", "a 503 hides the link");
  assert.equal(await l.probe(answering(200), 1000, quiet), true);
  assert.equal(await l.probe(unreachable, 1000, quiet), false);
  assert.equal(l.href, "", "an unreachable host hides the link");
});

test("outbound link: a switched-off link never probes", async () => {
  const off = new OutboundLink("prediction record", "", "https://atticus-event-shadow.onrender.com");
  let calls = 0;
  const probe: ProbeFetch = async () => {
    calls += 1;
    return { ok: true, status: 200 };
  };
  assert.equal(await off.probe(probe, 1000, quiet), false);
  assert.equal(calls, 0);
  assert.equal(off.href, "");
});

test("outbound link: logs only on a state change", async () => {
  const l = new OutboundLink("track record", undefined, "https://facility.atticustrade.com");
  const lines: string[] = [];
  const log = (s: string): void => {
    lines.push(s);
  };
  await l.probe(answering(200), 1000, log);
  await l.probe(answering(200), 1000, log);
  await l.probe(answering(200), 1000, log);
  await l.probe(unreachable, 1000, log);
  await l.probe(unreachable, 1000, log);
  assert.equal(lines.length, 2, "ON once, OFF once");
  assert.match(lines[0], /track record link ON/);
  assert.match(lines[1], /track record link OFF/);
});

test("traffic page: every funnel surface has a column, outbound clicks and cross-link health are shown", () => {
  const f = emptyFunnel();
  const now = Date.UTC(2026, 9, 1, 12);
  recordPageLoad(f, "app", now);
  recordPageLoad(f, "miniapp", now);
  recordPageLoad(f, "prediction", now);
  recordPageLoad(f, "prediction", now);
  recordPageLoad(f, "record", now);
  recordLooker(f, "0x" + "ab".repeat(20), now);
  const html = renderEpFunnelHtml(funnelSummary(f, new Set(), now), {
    atIso: new Date(now).toISOString(),
    links: [
      { label: "track record", url: "https://facility.atticustrade.com", alive: true },
      { label: "prediction markets", url: "https://event.earnandprotect.xyz", alive: false },
      { label: "prediction record", url: "", alive: false }
    ]
  });
  for (const p of FUNNEL_PAGES) assert.ok(html.includes(`<th>${FUNNEL_PAGE_LABELS[p]}</th>`), `column for ${p}`);
  assert.ok(html.includes("<th>to prediction markets</th>") && html.includes("<th>to perp record</th>"), "outbound clicks are named plainly");
  assert.ok(html.includes('<div class="n green">2</div><div class="l">clicks to prediction markets, 7 days</div>'), "headline number: clicks to prediction markets");
  assert.ok(html.includes('<div class="n">3</div><div class="l">all outbound clicks, 7 days</div>'), "all outbound clicks summed");
  assert.ok(html.includes('<em class="up">up, link shown</em> https://facility.atticustrade.com'), "live cross-link reported up");
  assert.ok(html.includes('<em class="down">down, link hidden</em> https://event.earnandprotect.xyz'), "down cross-link reported hidden");
  assert.ok(html.includes("<span>prediction record</span><b>off</b>"), "switched-off link reported off");
  assert.ok(html.includes("0xabab…abab"), "recent lookers shortened");
  assert.ok(!html.includes(" — "), "no em dashes");
});
