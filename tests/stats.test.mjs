import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_PLAN, analyze, duration, erfc, fmtP, mdeForDays, normCdf, normInv, peekingSim, sampleSize, sizeCurve, srm,
} from "../src/stats.js";

const near = (a, b, tol) => assert.ok(Math.abs(a - b) <= tol, `${a} is not within ${tol} of ${b}`);

test("normal distribution functions match table values", () => {
  near(normInv(0.975), 1.959964, 1e-6);
  near(normInv(0.8), 0.841621, 1e-6);
  near(normInv(0.001), -3.090232, 1e-5);
  near(normCdf(1.96), 0.975002, 1e-6);
  near(normCdf(0), 0.5, 1e-7);
  near(erfc(0), 1, 1e-7);
  for (const p of [0.01, 0.2, 0.5, 0.9, 0.999]) near(normCdf(normInv(p)), p, 1e-6);
  assert.throws(() => normInv(1), RangeError);
});

test("sample size matches the textbook two-proportion formula", () => {
  // 10% to 12%, alpha 0.05 two-sided, power 80%: 3,841 per group.
  assert.equal(sampleSize({ baseline: 0.1, mde: 0.2, alpha: 0.05, power: 0.8 }), 3841);
});

test("smaller effects and higher power need more visitors", () => {
  const base = sampleSize(DEFAULT_PLAN);
  assert.ok(sampleSize({ ...DEFAULT_PLAN, mde: 0.05 }) > 3.5 * base); // roughly 1 / mde squared
  assert.ok(sampleSize({ ...DEFAULT_PLAN, power: 0.9 }) > base);
  assert.ok(sampleSize({ ...DEFAULT_PLAN, alpha: 0.01 }) > base);
  assert.equal(sampleSize({ ...DEFAULT_PLAN, mde: 0 }), Infinity);
  assert.equal(sampleSize({ ...DEFAULT_PLAN, baseline: 0.6, mde: 1 }), Infinity);
});

test("duration covers both arms and rounds to whole weeks", () => {
  const d = duration({ ...DEFAULT_PLAN, trafficShare: 0.5 });
  assert.equal(d.total, 2 * d.perArm);
  assert.equal(d.days, Math.ceil(d.total / 3000));
  assert.equal(d.weeks, Math.ceil(d.days / 7));
  assert.equal(duration({ ...DEFAULT_PLAN, dailyVisitors: 0 }).days, Infinity);
});

test("detectable lift for a fixed number of days inverts the sample size", () => {
  const mde = mdeForDays(DEFAULT_PLAN, 14);
  const n = (DEFAULT_PLAN.dailyVisitors * 14) / 2;
  assert.ok(sampleSize({ ...DEFAULT_PLAN, mde }) <= n);
  assert.ok(sampleSize({ ...DEFAULT_PLAN, mde: mde * 0.98 }) > n);
  assert.equal(mdeForDays({ ...DEFAULT_PLAN, dailyVisitors: 1 }, 1), null);
});

test("size curve falls as the lift grows", () => {
  const pts = sizeCurve(DEFAULT_PLAN);
  assert.ok(pts.length > 20);
  for (let i = 1; i < pts.length; i++) assert.ok(pts[i].perArm <= pts[i - 1].perArm);
});

test("analysis gives the pooled z-test p-value and intervals", () => {
  const r = analyze({ visitorsA: 10000, conversionsA: 400, visitorsB: 10000, conversionsB: 460 });
  near(r.pa, 0.04, 1e-12);
  near(r.lift, 0.15, 1e-12);
  near(r.z, 2.0914, 1e-3);
  near(r.pValue, 0.0365, 1e-3);
  assert.equal(r.significant, true);
  assert.ok(r.diffLow > 0 && r.diffHigh > r.diff);
  assert.ok(r.liftLow > 0 && r.liftLow < 0.15 && r.liftHigh > 0.15);
});

test("an interval that crosses zero is not significant", () => {
  const r = analyze({ visitorsA: 2000, conversionsA: 80, visitorsB: 2000, conversionsB: 88 });
  assert.equal(r.significant, false);
  assert.ok(r.liftLow < 0 && r.liftHigh > 0);
});

test("analysis handles zero conversions and rejects bad input", () => {
  const r = analyze({ visitorsA: 100, conversionsA: 0, visitorsB: 100, conversionsB: 0 });
  assert.equal(r.pValue, 1);
  assert.equal(r.lift, null);
  assert.throws(() => analyze({ visitorsA: 10, conversionsA: 11, visitorsB: 10, conversionsB: 1 }), /between 0/);
  assert.throws(() => analyze({ visitorsA: 0, conversionsA: 0, visitorsB: 10, conversionsB: 1 }), /visitors/);
});

test("sample ratio mismatch flags a broken split", () => {
  const fine = srm(50000, 50500);
  near(fine.chi2, 2.4876, 1e-3);
  near(fine.pValue, 0.1148, 1e-3);
  assert.equal(fine.mismatch, false);
  assert.equal(srm(50000, 51500).mismatch, true);
  assert.equal(srm(30000, 70000, 0.3).mismatch, false);
});

test("peeking every day inflates false positives, a fixed horizon does not", () => {
  const sim = peekingSim(DEFAULT_PLAN, 28, { runs: 3000 });
  near(sim.fixed, 0.05, 0.015);
  assert.ok(sim.peeking > 0.15, `peeking rate ${sim.peeking}`);
  for (let i = 1; i < sim.byDay.length; i++) assert.ok(sim.byDay[i] >= sim.byDay[i - 1]);
  assert.deepEqual(peekingSim(DEFAULT_PLAN, 10, { runs: 200 }), peekingSim(DEFAULT_PLAN, 10, { runs: 200 }));
});

test("p-value formatting", () => {
  assert.equal(fmtP(0.00001), "< 0.0001");
  assert.equal(fmtP(0.03654), "0.0365");
});
