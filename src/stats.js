// Statistics for planning and reading a two-variant conversion test.
// Plain functions, no DOM, so everything here is unit tested.

/** Complementary error function. Numerical Recipes erfcc, fractional error under 1.2e-7. */
export function erfc(x) {
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const r = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 +
    t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
  return x >= 0 ? r : 2 - r;
}

export const normCdf = (z) => 0.5 * erfc(-z / Math.SQRT2);

/** Inverse of the standard normal CDF. Acklam's algorithm, relative error about 1e-9. */
export function normInv(p) {
  if (!(p > 0 && p < 1)) throw new RangeError("p must be between 0 and 1");
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const lo = 0.02425;
  if (p < lo) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - lo) return -normInv(1 - p);
  const q = p - 0.5, r = q * q;
  return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

export const DEFAULT_PLAN = {
  baseline: 0.04, // current conversion rate
  mde: 0.1, // smallest relative lift worth detecting
  alpha: 0.05, // two-sided false positive rate
  power: 0.8,
  dailyVisitors: 6000,
  trafficShare: 1, // share of visitors entering the test
};

/**
 * Visitors needed in each arm to detect a relative lift `mde` over `baseline`
 * with a two-sided z-test on two proportions.
 */
export function sampleSize({ baseline, mde, alpha, power }) {
  const p1 = baseline;
  const p2 = baseline * (1 + mde);
  if (!(p1 > 0 && p1 < 1) || !(p2 > 0 && p2 < 1) || mde === 0) return Infinity;
  const za = normInv(1 - alpha / 2);
  const zb = normInv(power);
  const pbar = (p1 + p2) / 2;
  const num = za * Math.sqrt(2 * pbar * (1 - pbar)) + zb * Math.sqrt(p1 * (1 - p1) + p2 * (1 - p2));
  return Math.ceil((num * num) / ((p2 - p1) ** 2));
}

/** Days to reach the sample, and the same rounded up to whole weeks so every weekday is counted equally. */
export function duration(plan) {
  const perArm = sampleSize(plan);
  const perDay = plan.dailyVisitors * plan.trafficShare;
  if (!Number.isFinite(perArm) || perDay <= 0) return { perArm, total: Infinity, days: Infinity, weeks: Infinity };
  const days = Math.ceil((2 * perArm) / perDay);
  return { perArm, total: 2 * perArm, days, weeks: Math.ceil(days / 7) };
}

/** The smallest relative lift detectable within `days`. Found by bisection on sampleSize. */
export function mdeForDays(plan, days) {
  const n = (plan.dailyVisitors * plan.trafficShare * days) / 2;
  let lo = 1e-4, hi = Math.min(10, 1 / plan.baseline - 1 - 1e-9);
  if (sampleSize({ ...plan, mde: hi }) > n) return null;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (sampleSize({ ...plan, mde: mid }) > n) lo = mid;
    else hi = mid;
  }
  return hi;
}

/** Sample size across a range of lifts, for the planning curve. */
export function sizeCurve(plan, from = 0.02, to = 0.5, steps = 60) {
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const mde = from * (to / from) ** (i / steps);
    if (plan.baseline * (1 + mde) >= 1) break;
    pts.push({ mde, perArm: sampleSize({ ...plan, mde }) });
  }
  return pts;
}

/**
 * Read out a finished test. Pooled z-test for the p-value, an unpooled
 * interval for the absolute difference, and a delta-method interval for the
 * relative lift on the log scale.
 */
export function analyze({ visitorsA, conversionsA, visitorsB, conversionsB, alpha = 0.05 }) {
  if (!(visitorsA > 0 && visitorsB > 0)) throw new Error("Each variant needs visitors.");
  if (conversionsA > visitorsA || conversionsB > visitorsB || conversionsA < 0 || conversionsB < 0) throw new Error("Conversions must be between 0 and the number of visitors.");
  const pa = conversionsA / visitorsA;
  const pb = conversionsB / visitorsB;
  const pool = (conversionsA + conversionsB) / (visitorsA + visitorsB);
  const sePool = Math.sqrt(pool * (1 - pool) * (1 / visitorsA + 1 / visitorsB));
  const z = sePool > 0 ? (pb - pa) / sePool : 0;
  const pValue = sePool > 0 ? erfc(Math.abs(z) / Math.SQRT2) : 1;
  const zc = normInv(1 - alpha / 2);
  const se = Math.sqrt((pa * (1 - pa)) / visitorsA + (pb * (1 - pb)) / visitorsB);
  const diff = pb - pa;
  let lift = null, liftLow = null, liftHigh = null;
  if (pa > 0 && pb > 0) {
    lift = pb / pa - 1;
    const seLog = Math.sqrt((1 - pa) / (visitorsA * pa) + (1 - pb) / (visitorsB * pb));
    liftLow = Math.exp(Math.log(pb / pa) - zc * seLog) - 1;
    liftHigh = Math.exp(Math.log(pb / pa) + zc * seLog) - 1;
  }
  return { pa, pb, diff, diffLow: diff - zc * se, diffHigh: diff + zc * se, lift, liftLow, liftHigh, z, pValue, significant: pValue < alpha };
}

/**
 * Sample ratio mismatch: a chi-square test of the visitor split against the
 * intended split. A tiny p-value means assignment or logging is broken and
 * the result should not be trusted, whatever it says.
 */
export function srm(visitorsA, visitorsB, expectedShareA = 0.5) {
  const n = visitorsA + visitorsB;
  const ea = n * expectedShareA, eb = n - ea;
  const chi2 = (visitorsA - ea) ** 2 / ea + (visitorsB - eb) ** 2 / eb;
  return { chi2, pValue: erfc(Math.sqrt(chi2 / 2)), mismatch: erfc(Math.sqrt(chi2 / 2)) < 0.001 };
}

/** Small seedable PRNG so the simulation gives the same answer every time. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The peeking problem. Simulate A/A tests, where there is no real difference,
 * and check the p-value at the end of every day. Stopping at the first
 * "significant" day finds a winner far more often than alpha promises.
 * Daily conversions are drawn with a normal approximation to the binomial.
 */
export function peekingSim({ baseline, alpha, dailyVisitors, trafficShare }, days, { runs = 2000, seed = 7 } = {}) {
  const rand = mulberry32(seed);
  const gauss = () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
  const perArm = (dailyVisitors * trafficShare) / 2;
  const sd = Math.sqrt(perArm * baseline * (1 - baseline));
  const everByDay = new Array(days).fill(0);
  let atEnd = 0;
  for (let r = 0; r < runs; r++) {
    let ca = 0, cb = 0, n = 0, stopped = false;
    for (let d = 0; d < days; d++) {
      n += perArm;
      ca += Math.max(0, perArm * baseline + sd * gauss());
      cb += Math.max(0, perArm * baseline + sd * gauss());
      const pool = (ca + cb) / (2 * n);
      const se = Math.sqrt(pool * (1 - pool) * (2 / n));
      const p = se > 0 ? erfc(Math.abs((cb - ca) / n / se) / Math.SQRT2) : 1;
      if (p < alpha) stopped = true;
      if (stopped) everByDay[d]++;
      if (d === days - 1 && p < alpha) atEnd++;
    }
  }
  return { byDay: everByDay.map((c) => c / runs), peeking: everByDay[days - 1] / runs, fixed: atEnd / runs, runs };
}

export function fmtPct(x, digits = 1) {
  if (x == null || !Number.isFinite(x)) return "n/a";
  return `${(x * 100).toFixed(digits)}%`;
}

export function fmtInt(n) {
  return Number.isFinite(n) ? Math.round(n).toLocaleString("en-US") : "too many";
}

export function fmtP(p) {
  return p < 0.0001 ? "< 0.0001" : p.toFixed(4);
}
