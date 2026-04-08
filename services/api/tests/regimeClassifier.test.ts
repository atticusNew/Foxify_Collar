import assert from "node:assert/strict";
import test from "node:test";
import { classifyRegime, __resetRegimeClassifierForTests } from "../src/pilot/regimeClassifier";

test("classifyRegime — CALM when vol < 40", () => {
  __resetRegimeClassifierForTests();
  const thresholds = { calmBelow: 40, stressAbove: 65 };
  assert.equal(classifyRegime(20, thresholds), "calm");
  assert.equal(classifyRegime(39, thresholds), "calm");
  assert.equal(classifyRegime(39.9, thresholds), "calm");
  assert.equal(classifyRegime(0, thresholds), "calm");
});

test("classifyRegime — NORMAL when 40 <= vol <= 65", () => {
  const thresholds = { calmBelow: 40, stressAbove: 65 };
  assert.equal(classifyRegime(40, thresholds), "normal");
  assert.equal(classifyRegime(50, thresholds), "normal");
  assert.equal(classifyRegime(65, thresholds), "normal");
});

test("classifyRegime — STRESS when vol > 65", () => {
  const thresholds = { calmBelow: 40, stressAbove: 65 };
  assert.equal(classifyRegime(65.1, thresholds), "stress");
  assert.equal(classifyRegime(80, thresholds), "stress");
  assert.equal(classifyRegime(100, thresholds), "stress");
});

test("classifyRegime — boundary at calm threshold", () => {
  const thresholds = { calmBelow: 40, stressAbove: 65 };
  assert.equal(classifyRegime(40, thresholds), "normal");
});

test("classifyRegime — boundary at stress threshold", () => {
  const thresholds = { calmBelow: 40, stressAbove: 65 };
  assert.equal(classifyRegime(65, thresholds), "normal");
  assert.equal(classifyRegime(65.01, thresholds), "stress");
});

test("classifyRegime — custom thresholds", () => {
  const custom = { calmBelow: 30, stressAbove: 50 };
  assert.equal(classifyRegime(25, custom), "calm");
  assert.equal(classifyRegime(35, custom), "normal");
  assert.equal(classifyRegime(55, custom), "stress");
});
