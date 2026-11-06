import {
  DEFAULT_PLAN, analyze, duration, fmtInt, fmtP, fmtPct, mdeForDays, peekingSim, sizeCurve, srm,
} from "./stats.js";

const $ = (id) => document.getElementById(id);
const form = $("form");
const readoutFields = $("analyze");
const SVG_NS = "http://www.w3.org/2000/svg";

const DEFAULT_RESULT = { visitorsA: 39560, conversionsA: 1582, visitorsB: 39490, conversionsB: 1736 };
const DEFAULTS = { ...DEFAULT_PLAN, ...DEFAULT_RESULT };

let state = decode(location.hash);
let peekTimer = 0;

function decode(hash) {
  const p = new URLSearchParams(String(hash).replace(/^#/, ""));
  const out = { ...DEFAULTS };
  for (const k of Object.keys(DEFAULTS)) {
    const n = Number(p.get(k));
    if (p.has(k) && Number.isFinite(n) && n >= 0) out[k] = n;
  }
  out.baseline = Math.min(0.99, Math.max(0.0001, out.baseline));
  out.trafficShare = Math.min(1, Math.max(0.01, out.trafficShare));
  return out;
}

const encode = (s) => new URLSearchParams(Object.entries(s).map(([k, v]) => [k, String(v)])).toString();

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "text") node.textContent = v;
    else node.setAttribute(k, v);
  }
  node.append(...children);
  return node;
}

function svg(tag, attrs = {}, text) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text != null) node.textContent = text;
  return node;
}

function card(label, value, sub) {
  return el("div", { class: "card" }, [el("span", { class: "card-label", text: label }), el("span", { class: "card-total", text: value }), el("span", { class: "card-sub", text: sub })]);
}

function fillForm() {
  for (const f of [...form.elements, ...readoutFields.querySelectorAll("input")]) {
    if (!f.name) continue;
    const v = state[f.name];
    f.value = f.dataset.pct !== undefined ? +(v * 100).toFixed(4) : v;
  }
}

function plan() {
  const { baseline, mde, alpha, power, dailyVisitors, trafficShare } = state;
  return { baseline, mde, alpha, power, dailyVisitors, trafficShare };
}

function update() {
  const p = plan();
  const d = duration(p);
  const twoWeeks = mdeForDays(p, 14);
  $("cards").replaceChildren(
    card("Visitors per variant", fmtInt(d.perArm), `${fmtInt(d.total)} in total`),
    card("Run time", Number.isFinite(d.days) ? `${d.days} days` : "too long", Number.isFinite(d.weeks) ? `round up to ${d.weeks} full week${d.weeks > 1 ? "s" : ""}` : "raise traffic or the lift"),
    card("Rate to detect", fmtPct(p.baseline * (1 + p.mde), 2), `up from ${fmtPct(p.baseline, 2)}, a ${fmtPct(p.mde, 0)} relative lift`),
    card("Detectable in 2 weeks", twoWeeks == null ? "none" : fmtPct(twoWeeks, 1), "smallest lift two weeks of traffic can find"),
  );
  drawSize(p);
  drawReadout();
  history.replaceState(null, "", `#${encode(state)}`);
  clearTimeout(peekTimer);
  peekTimer = setTimeout(() => drawPeek(p, d), 120);
}

// Sample size curve --------------------------------------------------------

function drawSize(p) {
  const pts = sizeCurve(p, 0.02, Math.min(0.5, 0.98 / p.baseline - 1));
  const chart = $("size-chart");
  const W = 640, H = 260, m = { l: 64, r: 16, t: 12, b: 44 };
  chart.setAttribute("viewBox", `0 0 ${W} ${H}`);
  if (pts.length < 2) return chart.replaceChildren();
  const lx0 = Math.log10(pts[0].mde), lx1 = Math.log10(pts.at(-1).mde);
  const ys = pts.map((q) => q.perArm);
  const ly0 = Math.floor(Math.log10(Math.min(...ys))), ly1 = Math.ceil(Math.log10(Math.max(...ys)));
  const x = (v) => m.l + ((Math.log10(v) - lx0) / (lx1 - lx0)) * (W - m.l - m.r);
  const y = (v) => H - m.b - ((Math.log10(v) - ly0) / (ly1 - ly0)) * (H - m.t - m.b);
  const nodes = [];
  for (let e = ly0; e <= ly1; e++) {
    for (const s of [1, 3]) {
      const v = s * 10 ** e;
      if (Math.log10(v) > ly1 + 1e-9) continue;
      nodes.push(svg("line", { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v), class: "grid" }));
      nodes.push(svg("text", { x: m.l - 8, y: y(v) + 4, class: "tick", "text-anchor": "end" }, compact(v)));
    }
  }
  for (const v of [0.02, 0.05, 0.1, 0.2, 0.5]) {
    if (v < pts[0].mde - 1e-9 || v > pts.at(-1).mde + 1e-9) continue;
    nodes.push(svg("text", { x: x(v), y: H - m.b + 18, class: "tick", "text-anchor": "middle" }, fmtPct(v, 0)));
  }
  nodes.push(svg("text", { x: (m.l + W - m.r) / 2, y: H - 6, class: "tick", "text-anchor": "middle" }, "Smallest lift worth detecting. Both axes use a log scale."));
  nodes.push(svg("path", { d: pts.map((q, i) => `${i ? "L" : "M"}${x(q.mde).toFixed(1)},${y(q.perArm).toFixed(1)}`).join(""), class: "line s-mean" }));
  const cur = duration(p).perArm;
  if (Number.isFinite(cur) && p.mde >= pts[0].mde && p.mde <= pts.at(-1).mde) {
    nodes.push(svg("line", { x1: x(p.mde), x2: x(p.mde), y1: m.t, y2: H - m.b, class: "marker" }));
    nodes.push(svg("circle", { cx: x(p.mde), cy: y(cur), r: 5, class: "dot s-mean" }));
    nodes.push(svg("text", { x: x(p.mde) + 10, y: y(cur) - 10, class: "annot" }, `${fmtInt(cur)} per variant`));
  }
  const hover = svg("g", { visibility: "hidden" });
  const hl = svg("line", { y1: m.t, y2: H - m.b, class: "crosshair" });
  const hd = svg("circle", { r: 4.5, class: "dot s-mean" });
  hover.append(hl, hd);
  const hit = svg("rect", { x: m.l, y: m.t, width: W - m.l - m.r, height: H - m.t - m.b, fill: "transparent" });
  nodes.push(hover, hit);
  chart.replaceChildren(...nodes);

  const tip = $("size-tip");
  hit.addEventListener("pointermove", (evt) => {
    const box = chart.getBoundingClientRect();
    const px = ((evt.clientX - box.left) / box.width) * W;
    let best = pts[0];
    for (const q of pts) if (Math.abs(x(q.mde) - px) < Math.abs(x(best.mde) - px)) best = q;
    const cx = x(best.mde);
    hover.setAttribute("visibility", "visible");
    hl.setAttribute("x1", cx); hl.setAttribute("x2", cx);
    hd.setAttribute("cx", cx); hd.setAttribute("cy", y(best.perArm));
    const days = Math.ceil((2 * best.perArm) / (p.dailyVisitors * p.trafficShare));
    tip.replaceChildren(el("strong", { text: `${fmtPct(best.mde, 1)} lift` }), el("div", { text: `${fmtInt(best.perArm)} per variant` }), el("div", { text: `${days} days at your traffic` }));
    tip.hidden = false;
    const left = (cx / W) * box.width;
    tip.style.left = `${left > box.width / 2 ? left - tip.offsetWidth - 12 : left + 12}px`;
    tip.style.top = "8px";
  });
  hit.addEventListener("pointerleave", () => { hover.setAttribute("visibility", "hidden"); tip.hidden = true; });

  $("size-note").textContent = "Halving the lift you want to detect roughly quadruples the visitors you need. Pick the smallest lift that would change a decision, not the one you hope for.";
}

// Peeking ---------------------------------------------------------------------

function drawPeek(p, d) {
  const days = Number.isFinite(d.weeks) ? Math.min(56, Math.max(14, d.weeks * 7)) : 28;
  const sim = peekingSim(p, days);
  const chart = $("peek-chart");
  const W = 640, H = 240, m = { l: 48, r: 16, t: 12, b: 40 };
  chart.setAttribute("viewBox", `0 0 ${W} ${H}`);
  const yMax = Math.max(0.1, Math.ceil((sim.peeking * 1.15) / 0.05) * 0.05);
  const x = (day) => m.l + ((day - 1) / (days - 1)) * (W - m.l - m.r);
  const y = (v) => H - m.b - (v / yMax) * (H - m.t - m.b);
  const nodes = [];
  for (let v = 0; v <= yMax + 1e-9; v += 0.05) {
    nodes.push(svg("line", { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v), class: "grid" }));
    nodes.push(svg("text", { x: m.l - 8, y: y(v) + 4, class: "tick", "text-anchor": "end" }, fmtPct(v, 0)));
  }
  for (let day = 7; day <= days; day += 7) nodes.push(svg("text", { x: x(day), y: H - m.b + 18, class: "tick", "text-anchor": "middle" }, `day ${day}`));
  nodes.push(svg("line", { x1: m.l, x2: W - m.r, y1: y(p.alpha), y2: y(p.alpha), class: "target" }));
  nodes.push(svg("path", { d: sim.byDay.map((v, i) => `${i ? "L" : "M"}${x(i + 1).toFixed(1)},${y(v).toFixed(1)}`).join(""), class: "line s-pct" }));
  nodes.push(svg("text", { x: x(days) - 4, y: y(sim.peeking) - 10, class: "annot", "text-anchor": "end" }, `${fmtPct(sim.peeking, 0)} false winners`));
  const hover = svg("g", { visibility: "hidden" });
  const hl = svg("line", { y1: m.t, y2: H - m.b, class: "crosshair" });
  const hd = svg("circle", { r: 4.5, class: "dot s-pct" });
  hover.append(hl, hd);
  const hit = svg("rect", { x: m.l, y: m.t, width: W - m.l - m.r, height: H - m.t - m.b, fill: "transparent" });
  nodes.push(hover, hit);
  chart.replaceChildren(...nodes);

  const tip = $("peek-tip");
  hit.addEventListener("pointermove", (evt) => {
    const box = chart.getBoundingClientRect();
    const px = ((evt.clientX - box.left) / box.width) * W;
    const day = Math.min(days, Math.max(1, Math.round(1 + ((px - m.l) / (W - m.l - m.r)) * (days - 1))));
    const v = sim.byDay[day - 1];
    hover.setAttribute("visibility", "visible");
    hl.setAttribute("x1", x(day)); hl.setAttribute("x2", x(day));
    hd.setAttribute("cx", x(day)); hd.setAttribute("cy", y(v));
    tip.replaceChildren(el("strong", { text: `Day ${day}` }), el("div", { text: `${fmtPct(v, 1)} have called a winner` }));
    tip.hidden = false;
    const left = (x(day) / W) * box.width;
    tip.style.left = `${left > box.width / 2 ? left - tip.offsetWidth - 12 : left + 12}px`;
    tip.style.top = "8px";
  });
  hit.addEventListener("pointerleave", () => { hover.setAttribute("visibility", "hidden"); tip.hidden = true; });

  $("peek-note").textContent = `Checked once at the end of ${days} days, ${fmtPct(sim.fixed, 1)} of these tests show a false winner, close to the ${fmtPct(p.alpha, 0)} promised. Checked every day and stopped at the first significant result, ${fmtPct(sim.peeking, 1)} do. Decide the run time up front, or use a sequential method built for repeated looks.`;
}

// Readout -------------------------------------------------------------------

function drawReadout() {
  const out = $("readout");
  let r;
  try {
    r = analyze({ ...state, alpha: state.alpha });
  } catch (err) {
    out.replaceChildren(el("p", { class: "hint", text: err.message }));
    return;
  }
  const split = srm(state.visitorsA, state.visitorsB);
  const stat = (k, v) => el("div", {}, [el("dt", { text: k }), el("dd", { text: v })]);
  let verdict;
  if (split.mismatch) verdict = el("span", { class: "verdict bad" }, ["⚠ Sample ratio mismatch: do not trust this result"]);
  else if (!r.significant) verdict = el("span", { class: "verdict neutral" }, ["\u25cb No significant difference"]);
  else if (r.diff > 0) verdict = el("span", { class: "verdict good" }, ["✓ B converts better"]);
  else verdict = el("span", { class: "verdict bad" }, ["✕ B converts worse"]);

  const n = state.visitorsA + state.visitorsB;
  const planned = duration(plan()).total;
  const notes = [];
  notes.push(split.mismatch
    ? `The split is ${fmtPct(state.visitorsA / n, 2)} / ${fmtPct(state.visitorsB / n, 2)}, which a fair 50/50 coin would almost never produce (${pText(split.pValue)}). Check assignment, redirects, and logging before reading the numbers.`
    : `The visitor split looks healthy (sample ratio check ${pText(split.pValue)}).`);
  if (Number.isFinite(planned) && n < planned) notes.push(`This test has ${fmtInt(n)} of the ${fmtInt(planned)} visitors the plan calls for. Reading it early raises the false positive rate, as the chart above shows.`);

  out.replaceChildren(
    verdict,
    el("dl", { class: "readout" }, [
      stat("Conversion A / B", `${fmtPct(r.pa, 2)} / ${fmtPct(r.pb, 2)}`),
      stat("Relative lift", r.lift == null ? "n/a" : `${r.lift >= 0 ? "+" : ""}${fmtPct(r.lift, 1)}`),
      stat(`${fmtPct(1 - state.alpha, 0)} interval for the lift`, r.lift == null ? "n/a" : `${fmtPct(r.liftLow, 1)} to ${fmtPct(r.liftHigh, 1)}`),
      stat("p-value", fmtP(r.pValue)),
    ]),
    ciChart(r),
    ...notes.map((t) => el("p", { class: "hint", text: t })),
  );
}

function ciChart(r) {
  const W = 640, H = 56, m = { l: 16, r: 16 };
  const node = svg("svg", { id: "ci-chart", viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Interval for the relative lift" });
  if (r.lift == null) return node;
  const span = Math.max(0.05, Math.abs(r.liftLow), Math.abs(r.liftHigh)) * 1.2;
  const x = (v) => m.l + ((v + span) / (2 * span)) * (W - m.l - m.r);
  node.append(
    svg("line", { x1: x(0), x2: x(0), y1: 16, y2: 34, class: "zero" }),
    svg("text", { x: x(0), y: 11, class: "tick", "text-anchor": "middle" }, "no change"),
    svg("line", { x1: x(r.liftLow), x2: x(r.liftHigh), y1: 25, y2: 25, class: "ci" }),
    svg("circle", { cx: x(r.lift), cy: 25, r: 6, class: "ci-pt" }),
    svg("text", { x: x(r.liftLow), y: 50, class: "tick", "text-anchor": "middle" }, fmtPct(r.liftLow, 1)),
    svg("text", { x: x(r.liftHigh), y: 50, class: "tick", "text-anchor": "middle" }, fmtPct(r.liftHigh, 1)),
  );
  return node;
}

function compact(n) {
  return n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${+(n / 1e3).toFixed(1)}k` : String(Math.round(n));
}

function onInput(e) {
  const f = e.target;
  if (!f.name) return;
  const n = Number(f.value);
  if (f.value === "" || !Number.isFinite(n) || n < 0) return;
  const v = f.dataset.pct !== undefined ? n / 100 : n;
  if (f.name === "baseline" && !(v > 0 && v < 1)) return;
  if (f.name === "trafficShare" && !(v > 0 && v <= 1)) return;
  state = { ...state, [f.name]: v };
  update();
}

form.addEventListener("input", onInput);
readoutFields.addEventListener("input", onInput);

$("reset").addEventListener("click", () => {
  state = { ...DEFAULTS };
  fillForm();
  update();
});

$("share").addEventListener("click", async () => {
  const btn = $("share");
  try {
    await navigator.clipboard.writeText(location.href);
    btn.textContent = "Link copied";
  } catch {
    btn.textContent = "Copy failed";
  }
  setTimeout(() => (btn.textContent = "Copy share link"), 1500);
});

fillForm();
update();

function pText(p) {
  const s = fmtP(p);
  return s.startsWith("<") ? `p ${s}` : `p = ${s}`;
}
