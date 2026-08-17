/**
 * Runs the engine against its own invariants.
 */

import { digraphClass } from "./engine/layout.js";
import { STYLES, applyStyle, newProfile } from "./engine/profile.js";
import { TypingSimulator, parseDuration } from "./engine/simulator.js";
import { PASSAGES, analyseTranscription } from "./engine/trainer.js";

const lines = [];
const log = (m, c) => lines.push({ text: String(m), cls: c || "" });
let failures = 0;
const check = (label, pass, detail) => {
  if (!pass) failures++;
  log(`  ${pass ? "PASS" : "FAIL"}  ${label}${detail ? "  " + detail : ""}`, pass ? "ok" : "bad");
};
try {
  const P = newProfile();
  const TEXT = "The quick brown fox jumps over the lazy dog. Every judge quietly examined both packed boxes.";

  log("determinism", "h");
  const a = new TypingSimulator(P, 7).plan(TEXT), b = new TypingSimulator(P, 7).plan(TEXT);
  check("same seed reproduces byte-identical plan", JSON.stringify(a.strokes) === JSON.stringify(b.strokes));
  const c2 = new TypingSimulator(P, 8).plan(TEXT);
  check("different seed diverges", JSON.stringify(a.strokes) !== JSON.stringify(c2.strokes));

  log("", ""); log("invariants over 800 fuzz plans", "h");
  let bad = 0, under = 0, unfaithful = 0;
  for (let s = 0; s < 800; s++) {
    const pf = newProfile({ typoRate: 0.25, correctionRate: 1.0, revisionProb: 0.25 });
    const pl = new TypingSimulator(pf, s, s % 2 ? "compose" : "transcribe").plan(TEXT);
    let buf = [];
    for (const st of pl.strokes) {
      if (st.isBreak) continue;
      if (st.action === "type") buf.push(st.text);
      else if (st.action === "backspace") { if (!buf.length) under++; buf.pop(); }
      if (!isFinite(st.delayMs) || st.delayMs < 0) bad++;
    }
    if (buf.join("") !== pl.finalText) bad++;
    if (pl.finalText !== TEXT) unfaithful++;
  }
  check("stroke list always reproduces final text", bad === 0, `(${bad} mismatches)`);
  check("never backspaces past the start", under === 0, `(${under} underflows)`);
  check("fix-every-mistake preserves text exactly", unfaithful === 0, `(${unfaithful} corrupted)`);

  log("", ""); log("calibration", "h");
  for (const t of [30, 60, 110]) {
    const pl = new TypingSimulator(newProfile({ baseWpm: t }), 3).plan(TEXT);
    check(`target ${t} wpm`, Math.abs(pl.effectiveWpm - t) < 1.5, `-> ${pl.effectiveWpm.toFixed(1)}`);
  }
  const t1 = new TypingSimulator(P, 3, "transcribe").plan(TEXT);
  const t2 = new TypingSimulator(P, 3, "compose").plan(TEXT);
  check("composing is slower than copying", t2.effectiveWpm < t1.effectiveWpm * 0.8,
        `${t1.effectiveWpm.toFixed(0)} vs ${t2.effectiveWpm.toFixed(0)} wpm`);

  log("", ""); log("keyboard model", "h");
  const pl = new TypingSimulator(newProfile({ baseWpm: 70 }), 42).plan(TEXT.repeat(8), { calibrate: false });
  const g = {}; let prev = null;
  for (const st of pl.strokes) {
    if (st.action !== "type") continue;
    if (prev) { const k = digraphClass(prev, st.text); (g[k] = g[k] || []).push(st.delayMs); }
    prev = st.text;
  }
  const med = (x) => { const s = [...x].sort((p, q) => p - q); return s[Math.floor(s.length / 2)]; };
  check("alt < same-hand < same-finger",
        med(g.alt) < med(g.same_hand) && med(g.same_hand) < med(g.same_finger),
        `${med(g.alt).toFixed(0)} / ${med(g.same_hand).toFixed(0)} / ${med(g.same_finger).toFixed(0)} ms`);
  const d = pl.strokes.filter((s) => s.action === "type").map((s) => s.delayMs);
  const mn = d.reduce((x, y) => x + y) / d.length;
  const sd = Math.sqrt(d.reduce((x, y) => x + (y - mn) ** 2, 0) / d.length);
  const z = d.map((x) => (x - mn) / sd);
  let r1 = 0; for (let i = 0; i < z.length - 1; i++) r1 += z[i] * z[i + 1]; r1 /= z.length - 1;
  check("intervals are autocorrelated (not i.i.d. jitter)", r1 > 0.05,
        `lag-1 ${r1.toFixed(3)}, cv ${(sd / mn).toFixed(2)}`);

  log("", ""); log("breaks and deadlines", "h");
  const bp = new TypingSimulator(P, 1, "compose").plan(TEXT, { breaks: 2, durationS: 1800 });
  check("deadline met exactly with breaks", Math.abs(bp.durationS - 1800) < 1,
        `${bp.breaks} breaks, ${bp.durationS.toFixed(1)}s`);
  check("parseDuration 90m / 1h30m", parseDuration("90m") === 5400 && parseDuration("1h30m") === 5400);
  let rejected = false; try { parseDuration("-5m"); } catch { rejected = true; }
  check("parseDuration rejects -5m", rejected);
  const tiny = new TypingSimulator(P, 1).plan("x", { breaks: 5 });
  check("absurd break count degrades safely", tiny.breaks <= 5);

  log("", ""); log("edge inputs", "h");
  const edges = { empty: "", space: " ", single: "x", newlines: "\n\n\n",
                  unicode: "café naïve 日本語 👋", punct: "!@#$%^&*()", nospace: "a".repeat(80) };
  let edgeBad = 0;
  for (const [name, txt] of Object.entries(edges)) {
    for (const mode of ["transcribe", "compose"]) {
      const q = new TypingSimulator(newProfile({ typoRate: 0.3, correctionRate: 1.0 }), 3, mode).plan(txt);
      if (q.finalText !== txt) { edgeBad++; log(`      ${name}/${mode} corrupted`, "bad"); }
    }
  }
  check("all edge inputs survive both modes", edgeBad === 0);

  log("", ""); log("styles", "h");
  const rows = {};
  for (const s of Object.keys(STYLES)) {
    const sp = new TypingSimulator(applyStyle(newProfile(), s), 2).plan(TEXT);
    rows[s] = sp.effectiveWpm;
    log(`      ${s.padEnd(15)}${String(Math.round(sp.effectiveWpm)).padStart(4)} wpm, ` +
        `${sp.typosInjected - sp.typosCorrected} mistakes left in`);
  }
  check("careful slower than rushed", rows.careful < rows.rushed);
  check("hunt-and-peck slowest", rows["hunt-and-peck"] <= Math.min(...Object.values(rows)));

  log("", ""); log("trainer round-trip", "h");
  for (const target of [45, 68, 95]) {
    const src = PASSAGES[0];
    const gen = new TypingSimulator(newProfile({ baseWpm: target, typoRate: 0 }), 9).plan(src);
    let t = 0; const evs = [];
    for (const st of gen.strokes) { t += st.delayMs; evs.push({ char: st.text, tMs: t, correct: true }); }
    const l = analyseTranscription(evs, src);
    check(`learns ${target} wpm back from its own output`,
          Math.abs(l.baseWpm - target) < target * 0.06, `-> ${l.baseWpm.toFixed(1)}`);
  }
  const src = PASSAGES[1];
  const gen = new TypingSimulator(newProfile({ baseWpm: 68, noiseSigma: 0.28, typoRate: 0 }), 9).plan(src);
  let tt = 0; const ev2 = [];
  for (const st of gen.strokes) { tt += st.delayMs; ev2.push({ char: st.text, tMs: tt, correct: true }); }
  const learned = analyseTranscription(ev2, src);
  check("recovers rhythm spread (envelope variance subtracted)",
        Math.abs(learned.noiseSigma - 0.28) < 0.07, `-> ${learned.noiseSigma.toFixed(3)}`);

  log("", "");
  log(failures === 0 ? `ALL CHECKS PASSED (0 failures)` : `${failures} CHECK(S) FAILED`,
      failures === 0 ? "ok" : "bad");
} catch (e) {
  log("FATAL " + e.message, "bad");
  log(String(e.stack));
}
/* Built as nodes rather than markup: the log carries error messages and stack
   text, which must never be parsed as HTML. */
const out = document.getElementById("out");
out.textContent = "";
for (const line of lines) {
  const node = line.cls ? document.createElement("span") : document.createTextNode(line.text);
  if (line.cls) { node.className = line.cls; node.textContent = line.text; }
  out.appendChild(node);
  out.appendChild(document.createTextNode("\n"));
}
