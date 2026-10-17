import assert from "node:assert/strict";
import test from "node:test";
import { applyTake } from "../src/singleSide/twoSided/creditCollar/capsConfig";
import {
  BRAND_SETTINGS_BOUNDS,
  DEFAULT_BRAND_SETTINGS,
  brandDiffers,
  describeBrandSettings,
  normalizeBrandSettings,
  parseBrandAllowlist,
  parseBrandSettings,
  resolveBrandFor,
  settingsForBrand
} from "../src/singleSide/twoSided/creditCollar/epBranding";

test("branding: allowlist parses comma-separated names, trimming blanks", () => {
  assert.deepEqual(parseBrandAllowlist("PRIMEVAULT, Copper , BitGo"), ["PRIMEVAULT", "Copper", "BitGo"]);
  assert.deepEqual(parseBrandAllowlist(" , ,"), []);
  assert.deepEqual(parseBrandAllowlist(undefined), []);
  assert.deepEqual(parseBrandAllowlist(""), []);
});

test("branding: query override resolves case-insensitively to the CONFIGURED casing", () => {
  const allow = parseBrandAllowlist("PRIMEVAULT,Copper");
  assert.equal(resolveBrandFor("HYPERLIQUID", "primevault", allow), "PRIMEVAULT");
  assert.equal(resolveBrandFor("HYPERLIQUID", "PrimeVault", allow), "PRIMEVAULT");
  assert.equal(resolveBrandFor("HYPERLIQUID", "COPPER", allow), "Copper");
});

test("branding: unapproved names fail closed to the env default — nobody screenshots an arbitrary brand", () => {
  const allow = parseBrandAllowlist("PRIMEVAULT");
  assert.equal(resolveBrandFor("HYPERLIQUID", "FIREBLOCKS", allow), "HYPERLIQUID"); // not allowlisted
  assert.equal(resolveBrandFor("HYPERLIQUID", "<script>", allow), "HYPERLIQUID");
  assert.equal(resolveBrandFor("HYPERLIQUID", null, allow), "HYPERLIQUID");
  assert.equal(resolveBrandFor("HYPERLIQUID", "  ", allow), "HYPERLIQUID");
  assert.equal(resolveBrandFor("HYPERLIQUID", "primevault", []), "HYPERLIQUID"); // empty allowlist = no overrides
});

// ── per-brand settings ────────────────────────────────────────────────────────

test("brand settings: no EP_BRAND_SETTINGS = the instance defaults for every brand, and the defaults are today's product", () => {
  assert.deepEqual(DEFAULT_BRAND_SETTINGS, { tenorMinDays: 3, tenorMaxDays: 14, capExceedProb: 0.2, takeWaived: false });
  for (const raw of [undefined, "", "   "]) {
    const t = parseBrandSettings(raw);
    assert.deepEqual(t.defaults, DEFAULT_BRAND_SETTINGS);
    assert.deepEqual(t.byBrand, {});
    assert.deepEqual(t.notes, []);
    assert.deepEqual(settingsForBrand(t, "PRIMEVAULT"), DEFAULT_BRAND_SETTINGS);
    assert.deepEqual(settingsForBrand(t, null), DEFAULT_BRAND_SETTINGS);
  }
  // The instance's own cap odds become the default the brands inherit from.
  const inst = parseBrandSettings(undefined, { ...DEFAULT_BRAND_SETTINGS, capExceedProb: 0.25 });
  assert.equal(settingsForBrand(inst, "anyone").capExceedProb, 0.25);
});

test("brand settings: a configured brand dials inside its bands, case-insensitively; partial objects inherit the rest", () => {
  const t = parseBrandSettings('{"PRIMEVAULT":{"tenorMinDays":7,"tenorMaxDays":14,"capExceedProb":0.15,"takeWaived":true},"Copper":{"capExceedProb":"0.1"}}');
  assert.deepEqual(t.notes, []);
  assert.deepEqual(settingsForBrand(t, "primevault"), { tenorMinDays: 7, tenorMaxDays: 14, capExceedProb: 0.15, takeWaived: true });
  assert.deepEqual(settingsForBrand(t, "PrimeVault"), settingsForBrand(t, "PRIMEVAULT"));
  assert.deepEqual(settingsForBrand(t, "COPPER"), { ...DEFAULT_BRAND_SETTINGS, capExceedProb: 0.1 }, "a string number is a number; the rest is the default");
  assert.deepEqual(settingsForBrand(t, "BitGo"), DEFAULT_BRAND_SETTINGS, "an unconfigured brand runs the instance's settings");
});

test("brand settings: every value is clamped into its published band and the correction is noted, never silent", () => {
  const notes: string[] = [];
  const s = normalizeBrandSettings({ tenorMinDays: 1, tenorMaxDays: 30, capExceedProb: 0.5, takeWaived: "true" }, DEFAULT_BRAND_SETTINGS, "X", notes);
  assert.deepEqual(s, { tenorMinDays: 3, tenorMaxDays: 14, capExceedProb: 0.3, takeWaived: true });
  assert.equal(notes.length, 3);
  assert.match(notes[0], /X\.tenorMinDays: 1 → 3/);
  assert.match(notes[1], /X\.tenorMaxDays: 30 → 14/);
  assert.match(notes[2], /X\.capExceedProb: 0\.5 → 0\.3/);
  assert.equal(BRAND_SETTINGS_BOUNDS.tenorDays.min, 3);
  assert.equal(BRAND_SETTINGS_BOUNDS.tenorDays.max, 14);
  assert.equal(BRAND_SETTINGS_BOUNDS.capExceedProb.min, 0.1);
  assert.equal(BRAND_SETTINGS_BOUNDS.capExceedProb.max, 0.3);

  // Odds may be written as a percentage; 15 is 15%. Days are whole; a max under the min is raised.
  const n2: string[] = [];
  const s2 = normalizeBrandSettings({ capExceedProb: 15, tenorMinDays: 9.6, tenorMaxDays: 5 }, DEFAULT_BRAND_SETTINGS, "Y", n2);
  assert.equal(s2.capExceedProb, 0.15);
  assert.equal(s2.tenorMinDays, 10);
  assert.equal(s2.tenorMaxDays, 10);
  assert.ok(n2.some((n) => /Y\.tenorMinDays: 9\.6 → 10/.test(n)));
  assert.ok(n2.some((n) => /tenorMaxDays 5 under tenorMinDays 10, raised/.test(n)));
  assert.equal(s2.capExceedProb, 0.15, "a value under 1 or over 1 both land on the same fraction; nothing noted when inside the band");

  // Junk keeps the default and says so; unknown keys cannot widen anything.
  const n3: string[] = [];
  const s3 = normalizeBrandSettings({ tenorMinDays: "soon", takeWaived: "maybe", widenBand: 99 }, DEFAULT_BRAND_SETTINGS, "Z", n3);
  assert.deepEqual(s3, DEFAULT_BRAND_SETTINGS);
  assert.ok(n3.some((n) => /Z\.tenorMinDays: not a number/.test(n)));
  assert.ok(n3.some((n) => /Z\.takeWaived: not a boolean/.test(n)));
  const n4: string[] = [];
  assert.deepEqual(normalizeBrandSettings([7], DEFAULT_BRAND_SETTINGS, "W", n4), DEFAULT_BRAND_SETTINGS);
  assert.match(n4[0], /W: not an object/);
});

test("brand settings: broken JSON or a non-object leaves every brand on the defaults and is noted, never thrown", () => {
  const bad = parseBrandSettings("{not json");
  assert.deepEqual(bad.byBrand, {});
  assert.equal(bad.notes.length, 1);
  assert.match(bad.notes[0], /EP_BRAND_SETTINGS: invalid JSON/);
  const arr = parseBrandSettings('[{"takeWaived":true}]');
  assert.deepEqual(arr.byBrand, {});
  assert.match(arr.notes[0], /expected an object keyed by brand/);
  assert.deepEqual(settingsForBrand(arr, "PRIMEVAULT"), DEFAULT_BRAND_SETTINGS);
  // A blank brand name is skipped; a brand whose value is junk gets the defaults with a note.
  const odd = parseBrandSettings('{"  ":{"takeWaived":true},"BitGo":7}');
  assert.deepEqual(Object.keys(odd.byBrand), ["bitgo"]);
  assert.deepEqual(odd.byBrand.bitgo, DEFAULT_BRAND_SETTINGS);
  assert.match(odd.notes[0], /BitGo: not an object/);
});

test("brand settings: brandDiffers names only a real change; describeBrandSettings reads in plain words", () => {
  const d = DEFAULT_BRAND_SETTINGS;
  assert.equal(brandDiffers({ ...d }, d), false);
  assert.equal(brandDiffers({ ...d, tenorMinDays: 7 }, d), true);
  assert.equal(brandDiffers({ ...d, tenorMaxDays: 10 }, d), true);
  assert.equal(brandDiffers({ ...d, capExceedProb: 0.15 }, d), true);
  assert.equal(brandDiffers({ ...d, takeWaived: true }, d), true);
  assert.equal(describeBrandSettings(d), "cycle to the nearest Friday 3–14 days out · cap odds 20%");
  assert.equal(describeBrandSettings({ tenorMinDays: 7, tenorMaxDays: 14, capExceedProb: 0.15, takeWaived: true }), "cycle to the nearest Friday 7–14 days out · cap odds 15% · take waived");
});

test("brand settings: P&L identity under the take waiver — the trader is paid the whole net credit, the writer keeps nothing", () => {
  // Without the waiver: trader = C − T, writer = T (the product today).
  const kept = applyTake(10, 0.2, 0.05, false, 1.5);
  assert.equal(kept.traderCreditUsdc + kept.atticusTakeUsdc, 10, "the credit is split, never created or lost");
  assert.equal(kept.atticusTakeUsdc, 2);
  // With the waiver the service passes rate 0 AND no notional minimum: trader = C, writer = 0.
  const waived = applyTake(10, 0, 0.05, false, 0);
  assert.equal(waived.traderCreditUsdc, 10);
  assert.equal(waived.atticusTakeUsdc, 0);
  assert.equal(waived.rule, "waived");
  // The minimum is part of the take, so the waiver zeroes it too; a leftover minimum would still bite.
  const leftoverMinimum = applyTake(10, 0, 0.05, false, 1.5);
  assert.equal(leftoverMinimum.atticusTakeUsdc, 1.5, "proof the service must zero the minimum, not just the rate");
  // Floor, cap excess and release are untouched by who keeps the take: the identity is C-only.
  assert.equal(waived.traderCreditUsdc - kept.traderCreditUsdc, kept.atticusTakeUsdc, "the waiver moves exactly T from writer to trader");
});
