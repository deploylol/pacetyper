/**
 * Measures a typing sample and turns it into a profile.
 */

import { DEFAULT_PROFILE, newProfile } from "./profile.js";

export const BACKSPACE = "\b";
// A correction this long is deleting words, not fixing a slip: the mean English
// word is about five characters plus a space.
const REVISION_RUN = 6;
export const MIN_COMPOSE_CHARS = 140;

export const PASSAGES = [
  "The quiet part of the morning belongs to whoever wakes up first, and lately " +
  "that has been the cat. She patrols the kitchen, knocks a pen off the counter, " +
  "and waits. I make coffee, read a little, and try to write something before " +
  "the day gets loud.",

  "Every project starts with a clean folder and an honest plan. By week three " +
  "the folder has forty files, the plan has become a rumour, and the only thing " +
  "still accurate is the first sentence of the readme. This is normal, and " +
  "knowing it is normal helps more than you would think.",

  "Please review the attached figures before Thursday. Revenue was 41,200 in Q3 " +
  "against a forecast of 38,900, so we are ahead by roughly 6 percent; the " +
  "shortfall in June has been recovered. I have flagged two line items that " +
  "still need a second look.",

  "Debugging is the art of being wrong out loud until the machine agrees with " +
  "you. You read the error, assume it lies, discover it did not, and then find " +
  "the actual bug three files away where nobody was looking. Afterwards it seems " +
  "obvious, which is the cruellest part.",
];

// Answerable by anyone from memory, with no research and no right answer. The
// point is to make the writer compose, not to test recall.
export const PROMPTS = [
  "What did you do yesterday evening?",
  "Describe the room you are sitting in right now.",
  "What is a small thing that reliably makes your day better?",
  "How would someone get from the nearest station to your front door?",
  "Describe a meal you know how to cook, and how you make it.",
  "What would you tell someone visiting your town for the first time?",
  "What is something you used to believe and changed your mind about?",
];

/* ---------------------------------------------------------------- stats */
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

const pvariance = (xs) => {
  const m = mean(xs);
  return mean(xs.map((x) => (x - m) ** 2));
};

const clean = (xs, lo, hi) => xs.filter((v) => v >= lo && v <= hi);

/** Percentile range. Robust where min/max would follow a single outlier. */
function range(values, loPct = 15, hiPct = 85) {
  const s = [...values].sort((a, b) => a - b);
  if (s.length < 4) return null;
  const pct = (p) => {
    const idx = (s.length - 1) * p / 100;
    const lo = Math.floor(idx), hi = Math.ceil(idx);
    return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (idx - lo);
  };
  return [Math.round(pct(loPct) * 10) / 10, Math.round(pct(hiPct) * 10) / 10];
}

/* Variance the speed envelope alone contributes to log intervals. */
function envelopeLogVariance(p) {
  const stationary = (sigma, theta) => {
    const denom = 2 * theta - theta * theta;
    return denom > 0 ? (sigma * sigma) / denom : 0;
  };
  return stationary(p.envelopeSigma, p.envelopeTheta)
       + stationary(p.burstSigma, p.burstTheta);
}

function backspaceRuns(events) {
  const runs = [];
  let current = 0;
  for (const ev of events) {
    if (ev.char === BACKSPACE) current++;
    else if (current) { runs.push(current); current = 0; }
  }
  if (current) runs.push(current);
  return runs;
}

/* ------------------------------------------------------ phase 1: copy */
export function analyseTranscription(events, passage) {
  const p = newProfile();
  if (events.length < 20) throw new Error("Type the whole passage — that was too short to learn from.");

  const intervals = [], backspaceGaps = [], afterPeriod = [], afterComma = [], corrDelays = [];
  let errors = 0, corrected = 0, printable = 0, net = 0;
  let prevT = events[0].tMs, prevChar = null, pendingErrorT = null;

  for (let i = 1; i < events.length; i++) {
    const ev = events[i];
    const gap = ev.tMs - prevT;

    if (ev.char === BACKSPACE) {
      net = Math.max(0, net - 1);
      if (prevChar === BACKSPACE) backspaceGaps.push(gap);
      else if (pendingErrorT !== null) {
        corrDelays.push(ev.tMs - pendingErrorT);
        corrected++;
        pendingErrorT = null;
      }
    } else {
      printable++; net++;
      if (ev.correct === false) { errors++; pendingErrorT = ev.tMs; }
      else if (".!?".includes(prevChar)) afterPeriod.push(gap);
      else if (",;:".includes(prevChar)) afterComma.push(gap);
      else intervals.push(gap);
    }
    prevT = ev.tMs;
    prevChar = ev.char;
  }

  // Speed is the standard net measure: characters that survived over elapsed
  // time. It has to be the same statistic the simulator calibrates against —
  // the median motor interval runs about 20% faster, because it excludes pauses
  // and the median of a skewed distribution sits below its mean.
  const spanMin = (events[events.length - 1].tMs - events[0].tMs) / 60000;
  if (spanMin > 0 && net > 0) {
    p.baseWpm = Math.round(Math.min(Math.max((net / 5) / spanMin, 5), 220) * 10) / 10;
  }

  const core = clean(intervals, 20, 1200);
  if (core.length >= 10) {
    const logs = core.map(Math.log).sort((a, b) => a - b);
    const trimmed = logs.slice(0, Math.max(3, Math.floor(logs.length * 0.9)));
    const residual = pvariance(trimmed) - envelopeLogVariance(p);
    p.noiseSigma = Math.round(Math.min(Math.max(Math.sqrt(Math.max(residual, 0)), 0.12), 0.75) * 1000) / 1000;
  }

  if (printable > 0) p.typoRate = Math.round(Math.min(Math.max(errors / printable, 0.002), 0.12) * 10000) / 10000;
  if (errors > 0) p.correctionRate = Math.round(Math.min(Math.max(corrected / errors, 0.3), 1) * 1000) / 1000;

  const assign = (field, values, lo, hi) => {
    const r = range(clean(values, lo, hi));
    if (r) p[field] = r;
  };
  assign("correctionDelayMs", corrDelays, 40, 4000);
  assign("backspaceMs", backspaceGaps, 15, 400);
  assign("sentencePauseMs", afterPeriod, 40, 6000);
  assign("clausePauseMs", afterComma, 30, 3000);

  const lag = detectLag(events);
  if (lag) p.detectLagChars = lag;

  p.learnedTypos = misspellings(events, passage);
  p.sampleCount = 1;
  p.sampleChars = printable;
  return p;
}

function detectLag(events) {
  const lags = [];
  let since = null;
  for (const ev of events) {
    if (ev.char === BACKSPACE) {
      if (since !== null) { lags.push(Math.min(since, 12)); since = null; }
    } else if (ev.correct === false) since = 0;
    else if (since !== null) since++;
  }
  if (!lags.length) return null;
  return [Math.max(1, Math.min(...lags)), Math.max(2, Math.max(...lags))];
}

/** Words left wrong on screen, keyed by their correct spelling. */
function misspellings(events, passage) {
  const buf = [];
  for (const ev of events) {
    if (ev.char === BACKSPACE) buf.pop();
    else buf.push(ev.char);
  }
  const out = {};
  const want = passage.split(/\s+/), got = buf.join("").split(/\s+/);
  const strip = (s) => s.replace(/^[.,;:!?"'()]+|[.,;:!?"'()]+$/g, "").toLowerCase();
  for (let i = 0; i < Math.min(want.length, got.length); i++) {
    const w = strip(want[i]), g = strip(got[i]);
    if (w && g && w !== g && w.length > 3 && Math.abs(w.length - g.length) <= 2) out[w] = g;
  }
  return out;
}

/* --------------------------------------------------- phase 2: compose */
/**
 * Errors are deliberately not measured here. With no intended text there is no
 * ground truth to compare against, and guessing would poison the motor model
 * that phase 1 measured properly.
 */
export function analyseComposition(events, transcribeWpm) {
  const p = newProfile();
  const printable = events.filter((e) => e.char !== BACKSPACE);
  if (printable.length < 40) throw new Error("Write a couple more sentences — that was too short.");

  const wordGaps = [], clauseGaps = [], sentenceGaps = [], motor = [];
  let prevT = events[0].tMs, prevChar = null;

  for (let i = 1; i < events.length; i++) {
    const ev = events[i];
    const gap = ev.tMs - prevT;
    if (ev.char !== BACKSPACE) {
      if (".!?".includes(prevChar)) sentenceGaps.push(gap);
      else if (",;:".includes(prevChar)) clauseGaps.push(gap);
      else if (prevChar === " ") wordGaps.push(gap);
      else if (prevChar !== null && prevChar !== "\n") motor.push(gap);
    }
    prevT = ev.tMs;
    prevChar = ev.char;
  }

  let net = 0;
  for (const ev of events) net = ev.char === BACKSPACE ? Math.max(0, net - 1) : net + 1;

  // Rate over the whole session, pauses and all — that is what "composing
  // speed" means to anyone watching.
  const spanMin = (events[events.length - 1].tMs - events[0].tMs) / 60000;
  if (spanMin > 0 && net > 0) {
    const composeWpm = (net / 5) / spanMin;
    let reference = transcribeWpm;
    if (!reference && motor.length) reference = 60000 / (median(motor) * 5);
    if (reference > 0) {
      p.composeSpeedRatio = Math.round(Math.min(Math.max(composeWpm / reference, 0.15), 1) * 1000) / 1000;
    }
  }

  const assign = (field, values, lo, hi, loPct, hiPct) => {
    const r = range(clean(values, lo, hi), loPct, hiPct);
    if (r) p[field] = r;
  };
  assign("composeWordPauseMs", wordGaps, 120, 12000, 25, 85);
  assign("composeClausePauseMs", clauseGaps, 150, 20000, 20, 85);
  assign("composeSentencePauseMs", sentenceGaps, 200, 40000, 20, 85);

  if (wordGaps.length) {
    const floor = motor.length ? median(motor) * 2.2 : 300;
    const paused = wordGaps.filter((g) => g > floor).length;
    p.composeWordPauseProb = Math.round(Math.min(Math.max(paused / wordGaps.length, 0.05), 0.9) * 1000) / 1000;

    const searches = wordGaps.filter((g) => g > Math.max(1200, floor * 4));
    p.composeSearchProb = Math.round(Math.min(searches.length / wordGaps.length, 0.4) * 10000) / 10000;
    const r = range(searches, 20, 85);
    if (r) p.composeSearchPauseMs = r;
  }

  // Long backspace runs are rewriting, not fixing.
  const revisions = backspaceRuns(events).filter((r) => r >= REVISION_RUN);
  const words = Math.max(1, printable.filter((e) => e.char === " ").length);
  p.revisionProb = Math.round(Math.min(revisions.length / words, 0.25) * 10000) / 10000;
  if (revisions.length) {
    const est = revisions.map((r) => Math.max(1, Math.round(r / 6))).sort((a, b) => a - b);
    p.revisionWords = [est[0], Math.max(est[0] + 1, est[est.length - 1])];
  }

  p.composeSampleCount = 1;
  p.composeSampleChars = printable.length;
  return p;
}
