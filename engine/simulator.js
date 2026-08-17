/* Turns text into a timed keystroke plan. */

import {
  bigramSpeedFactor, digraphClass, digraphDifficulty, keyDistance,
  neighbors, requiresShift, wordSpans, wordSpeedFactor,
} from "./layout.js";

/* Floor on the gap between keystrokes. */
const MIN_IKI_MS = 25.0;
const SYMBOLS = new Set("!@#$%^&*()_+{}|:\"<>?~`-=[]\\;'/,.");

/* ------------------------------------------------------------ seeded RNG */
/** mulberry32 — small, fast, and good enough that seeds reproduce exactly. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Rng {
  constructor(seed) {
    this.next = mulberry32(seed === undefined || seed === null
      ? (Math.random() * 4294967296) >>> 0 : seed);
    this._spare = null;
  }
  random() { return this.next(); }
  uniform(lo, hi) { return lo + (hi - lo) * this.next(); }
  randint(lo, hi) { return lo + Math.floor(this.next() * (hi - lo + 1)); }
  choice(arr) { return arr[Math.floor(this.next() * arr.length)]; }
  /** Box-Muller, with the second value kept for the next call. */
  gauss(mu = 0, sigma = 1) {
    if (this._spare !== null) {
      const v = this._spare; this._spare = null;
      return mu + sigma * v;
    }
    let u = 0, v = 0, s = 0;
    do {
      u = this.next() * 2 - 1;
      v = this.next() * 2 - 1;
      s = u * u + v * v;
    } while (s >= 1 || s === 0);
    const f = Math.sqrt((-2 * Math.log(s)) / s);
    this._spare = v * f;
    return mu + sigma * u * f;
  }
  weighted(entries) {
    const total = entries.reduce((a, [, w]) => a + w, 0);
    let r = this.next() * total;
    for (const [key, w] of entries) { r -= w; if (r <= 0) return key; }
    return entries[entries.length - 1][0];
  }
}

/* --------------------------------------------------------------- duration */
const DURATION_FULL = /^(?:\d+(?:\.\d+)?\s*[hms]?\s*)+$/;
const DURATION_PART = /(\d+(?:\.\d+)?)\s*([hms]?)/g;

/** "90m", "1h30m", "2h", "45s", "30" (bare = minutes) -> seconds. */
export function parseDuration(text) {
  const cleaned = String(text).trim().toLowerCase();
  // The whole string must be duration terms; scanning for fragments would read
  // "-5m" as five minutes.
  if (!DURATION_FULL.test(cleaned)) {
    throw new Error(`Can't read a duration from "${text}". Try 90m, 2h, or 1h30m.`);
  }
  const units = { h: 3600, m: 60, s: 1, "": 60 };
  let total = 0;
  for (const [, value, unit] of cleaned.matchAll(DURATION_PART)) {
    total += parseFloat(value) * units[unit];
  }
  if (total <= 0) throw new Error("Duration must be positive.");
  return total;
}

export function humanTime(seconds) {
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m${String(Math.floor(seconds % 60)).padStart(2, "0")}s`;
  return `${Math.floor(seconds / 3600)}h${String(Math.floor((seconds % 3600) / 60)).padStart(2, "0")}m`;
}

/* ------------------------------------------------------------------ types */
export class Plan {
  constructor(fields) {
    Object.assign(this, {
      strokes: [], sourceText: "", finalText: "", mode: "transcribe",
      typosInjected: 0, typosCorrected: 0, revisions: 0, breaks: 0, warnings: [],
      finalCells: null, mathSpans: 0,
    }, fields);
  }
  get durationMs() { return this.strokes.reduce((a, s) => a + s.delayMs, 0); }
  get typingMs() { return this.strokes.reduce((a, s) => a + (s.isBreak ? 0 : s.delayMs), 0); }
  get breakMs() { return this.strokes.reduce((a, s) => a + (s.isBreak ? s.delayMs : 0), 0); }
  get durationS() { return this.durationMs / 1000; }
  /** Words per minute excluding time spent away from the keyboard. */
  get effectiveWpm() {
    const minutes = this.typingMs / 60000;
    // Characters as typed, not as stored: an emoji is one keystroke, not two.
    const chars = this.finalCells ?? this.finalText.length;
    return minutes > 0 ? (chars / 5) / minutes : 0;
  }
  get isFaithful() { return this.finalText === this.sourceText; }

  /* The two numbers worth reading at a glance, and the rest. */
  summary() {
    const detail = [`${this.strokes.length} keystrokes`];
    if (this.typosInjected) {
      detail.push(`${this.typosInjected} typo${this.typosInjected === 1 ? "" : "s"}` +
                  (this.typosCorrected ? `, ${this.typosCorrected} fixed` : ""));
    }
    if (this.revisions) {
      detail.push(`${this.revisions} rewrite${this.revisions === 1 ? "" : "s"}`);
    }
    if (this.breaks) {
      detail.push(`${this.breaks} break${this.breaks === 1 ? "" : "s"} ` +
                  `(${humanTime(this.breakMs / 1000)})`);
    }
    if (this.mathSpans) {
      detail.push(`${this.mathSpans} formula${this.mathSpans === 1 ? "" : "s"}`);
    }
    return {
      headline: `${humanTime(this.durationS)} at ${Math.round(this.effectiveWpm)} wpm`,
      detail: detail.join(" · "),
      warning: this.isFaithful ? null
        : "A few typos will be left in, so the result won't match your text exactly.",
    };
  }

  describe() {
    const s = this.summary();
    return `${s.headline} · ${s.detail}`;
  }
}

const isSpace = (ch) => /\s/.test(ch);

/** One definition of "word start", used by every path that rebuilds the buffer. */
function isWordStart(text, i) {
  return (i === 0 || isSpace(text[i - 1])) && !isSpace(text[i]);
}

/* Code points that never stand alone: they modify whatever came before. A
   backspace in a real editor removes the whole cluster, so a plan that treats
   them separately can leave half a character behind. */
const JOINS_LEFT = new RegExp(
  "^[" +
  "\\u0300-\\u036F\\u0483-\\u0489\\u0591-\\u05BD\\u0610-\\u061A\\u064B-\\u065F" +
  "\\u0900-\\u0903\\u093A-\\u094F\\u0951-\\u0957\\u0E31\\u0E34-\\u0E3A" +
  "\\u1AB0-\\u1AFF\\u1DC0-\\u1DFF\\u20D0-\\u20F0\\uFE00-\\uFE0F\\uFE20-\\uFE2F" +
  "]$|^[\\u{1F3FB}-\\u{1F3FF}\\u{E0100}-\\u{E01EF}]$",
  "u",
);
const ZWJ = "‍";
const isRegionalIndicator = (cp) => cp >= "\u{1F1E6}" && cp <= "\u{1F1FF}";

/* Split text into the units a keystroke actually moves. */
export function toCells(text) {
  const cps = Array.from(text);
  const cells = [];
  for (let i = 0; i < cps.length; i++) {
    let cell = cps[i];
    if (isRegionalIndicator(cell) && isRegionalIndicator(cps[i + 1] || "")) {
      cell += cps[++i];                       // a flag is a pair, or nothing
    }
    for (;;) {
      const next = cps[i + 1];
      if (next === undefined) break;
      if (next === ZWJ && cps[i + 2] !== undefined) {
        cell += next + cps[i + 2];            // 👨‍👩‍👧 and friends
        i += 2;
      } else if (JOINS_LEFT.test(next) || next === "⃣") {
        cell += next;                         // accents, skin tones, keycaps
        i += 1;
      } else break;
    }
    cells.push(cell);
  }
  return cells;
}

/* -------------------------------------------------------------- simulator */
export class TypingSimulator {
  constructor(profile, seed, mode = "transcribe") {
    if (mode !== "transcribe" && mode !== "compose") {
      throw new Error(`mode must be transcribe or compose, got ${mode}`);
    }
    this.p = profile;
    this.mode = mode;
    this.rng = new Rng(seed);
  }

  /* Build a plan. */
  plan(text, { calibrate = true, breaks = 0, durationS = null } = {}) {
    const plan = this._planOnce(text);
    if (breaks > 0) this._insertBreaks(plan, breaks);

    if (durationS != null) {
      this._fitToDuration(plan, durationS);
    } else if (calibrate && plan.typingMs > 0) {
      let target = this.p.baseWpm;
      if (this.mode === "compose") target *= this.p.composeSpeedRatio;
      const actual = plan.effectiveWpm;
      if (actual > 0 && target > 0) {
        const scale = actual / target;
        if (scale > 0.05 && scale < 20) this._scaleTyping(plan, scale);
      }
    }
    return plan;
  }

  _scaleTyping(plan, factor) {
    for (const s of plan.strokes) if (!s.isBreak) s.delayMs *= factor;
  }

  _insertBreaks(plan, count) {
    let candidates = [];
    plan.strokes.forEach((s, i) => {
      if (i < plan.strokes.length - 1 && s.action === "type" && ".!?\n".includes(s.text)) {
        candidates.push(i);
      }
    });
    if (!candidates.length) {
      const step = Math.max(1, Math.floor(plan.strokes.length / (count + 1)));
      for (let i = step; i < plan.strokes.length; i += step) candidates.push(i);
    }
    if (!candidates.length) {
      plan.warnings.push("Text is too short to place breaks in.");
      return;
    }
    count = Math.min(count, candidates.length);
    const step = candidates.length / (count + 1);
    const chosen = [...new Set(
      Array.from({ length: count }, (_, k) =>
        candidates[Math.min(Math.floor(step * (k + 1)), candidates.length - 1)])
    )].sort((a, b) => a - b);

    chosen.forEach((idx, offset) => {
      const pause = this.rng.uniform(this.p.breakMs[0], this.p.breakMs[1]);
      plan.strokes.splice(idx + 1 + offset, 0,
        { action: "type", text: "", delayMs: pause, isBreak: true });
    });
    plan.breaks = chosen.length;
  }

  _fitToDuration(plan, durationS) {
    const targetMs = durationS * 1000;
    const typingNow = plan.typingMs;
    const available = targetMs - plan.breakMs;

    if (available <= 0) {
      plan.warnings.push(
        `Breaks alone take ${humanTime(plan.breakMs / 1000)}, longer than the ` +
        `${humanTime(durationS)} deadline. Use fewer breaks.`);
      return;
    }
    if (typingNow <= 0) return;

    this._scaleTyping(plan, available / typingNow);
    const wpm = plan.effectiveWpm;
    if (wpm > 150) {
      plan.warnings.push(
        `That deadline needs ${Math.round(wpm)} wpm, faster than almost anyone ` +
        `sustains. Allow more time or fewer breaks.`);
    } else if (wpm < 8) {
      plan.warnings.push(
        `That deadline works out to ${Math.round(wpm)} wpm — slow enough to look ` +
        `stalled. Consider adding breaks instead of stretching the typing.`);
    }
  }

  /* ------------------------------------------------------------ planning */
  _planOnce(source) {
    const p = this.p, rng = this.rng;
    const composing = this.mode === "compose";
    /* Everything below indexes characters as a person would count them, not as
       the string stores them. `text` is an array of those units; the original
       string is kept only to report back. */
    const text = toCells(source);
    const { factors, chunk } = TypingSimulator._wordTables(text);

    const strokes = [];
    const buf = [];
    const marks = [];        // [bufferPos, sourcePos] at each word start
    let pending = null;
    let slow = 1.0, fast = 1.0;
    let typed = 0, revisions = 0, typos = 0, corrected = 0;

    let i = 0;
    const n = text.length;
    while (i < n) {
      const ch = text[i];
      if (isWordStart(text, i)) marks.push([buf.length, i]);

      // Two mean-reverting envelopes at different timescales.
      slow += p.envelopeTheta * (1 - slow) + rng.gauss(0, p.envelopeSigma);
      fast += p.burstTheta * (1 - fast) + rng.gauss(0, p.burstSigma);
      slow = Math.min(Math.max(slow, 0.62), 1.55);
      fast = Math.min(Math.max(fast, 0.6), 1.6);
      const envelope = Math.min(Math.max(slow * fast, 0.45), 1.85);
      const fatigue = 1 + p.fatiguePer1k * (typed / 1000);

      const prev = buf.length ? buf[buf.length - 1] : null;
      let delay = this._iki(prev, ch, envelope, fatigue, factors[i], chunk[i]);
      delay += this._extraPause(text, i, prev, composing);

      if (composing && pending === null && isWordStart(text, i) &&
          marks.length > 2 && rng.random() < p.revisionProb) {
        revisions++;
        this._emitRevision(strokes, buf, marks, text, i, envelope, fatigue, factors, chunk);
      }

      let consumed = 0, wrong = [], kind = "";
      if (pending === null) {
        [consumed, wrong, kind] = this._maybeTypo(text, i, envelope, prev);
      }

      if (consumed) {
        typos++;
        // The bias scales the odds of *missing*. Scaling the catch rate instead
        // would let a profile set to catch everything still leak omissions.
        const bias = p.detectBias[kind] ?? 1.0;
        const miss = bias > 0 ? Math.min(1, (1 - p.correctionRate) / bias) : 1;
        const willCorrect = rng.random() >= miss;
        pending = {
          bufferStart: buf.length,
          srcStart: i,
          detectAt: Math.min(n, i + consumed + rng.randint(p.detectLagChars[0], p.detectLagChars[1])),
          willCorrect,
        };
        if (willCorrect) corrected++;
        wrong.forEach((wc, k) => {
          const d = k === 0 ? delay
            : this._iki(buf.length ? buf[buf.length - 1] : null, wc, envelope, fatigue, 1.0, false);
          strokes.push({ action: "type", text: wc, delayMs: d, isBreak: false });
          buf.push(wc);
        });
        i += consumed;
        typed += consumed;
      } else {
        strokes.push({ action: "type", text: ch, delayMs: delay, isBreak: false });
        buf.push(ch);
        i++;
        typed++;
      }

      if (pending !== null && i >= pending.detectAt) {
        if (pending.willCorrect) {
          this._emitCorrection(strokes, buf, text, pending, i, envelope, fatigue,
                               factors, chunk, marks);
        }
        pending = null;
      }
    }

    // Ran out of text with an unnoticed mistake open: a real typist proofreads
    // the last line, so resolve it here.
    if (pending !== null && pending.willCorrect) {
      this._emitCorrection(strokes, buf, text, pending, n, 1.0, 1.0, factors, chunk, marks);
    }

    return new Plan({
      strokes, sourceText: source, finalText: buf.join(""), mode: this.mode,
      typosInjected: typos, typosCorrected: corrected, revisions,
      finalCells: buf.length,
    });
  }

  static _wordTables(text) {
    const factors = new Array(text.length).fill(1.0);
    const chunk = new Array(text.length).fill(false);
    for (const [start, end, word] of wordSpans(text)) {
      const f = wordSpeedFactor(word);
      for (let i = start; i < end; i++) { factors[i] = f; chunk[i] = f <= 0.8; }
    }
    return { factors, chunk };
  }

  _emitRevision(strokes, buf, marks, text, srcIndex, envelope, fatigue, factors, chunk) {
    const p = this.p, rng = this.rng;
    const back = Math.min(rng.randint(p.revisionWords[0], p.revisionWords[1]), marks.length - 1);
    if (back < 1) return;
    const [bpos, spos] = marks[marks.length - back];
    const nBack = buf.length - bpos;
    if (nBack <= 0) return;

    strokes.push({ action: "backspace", text: "", isBreak: false,
                   delayMs: rng.uniform(p.revisionPauseMs[0], p.revisionPauseMs[1]) });
    for (let k = 0; k < nBack - 1; k++) {
      strokes.push({ action: "backspace", text: "", isBreak: false,
                     delayMs: rng.uniform(p.backspaceMs[0], p.backspaceMs[1]) });
    }
    buf.length = bpos;
    marks.length = marks.length - back;

    for (let k = spos; k < srcIndex; k++) {
      if (isWordStart(text, k)) marks.push([buf.length, k]);
      const prev = buf.length ? buf[buf.length - 1] : null;
      let d = this._iki(prev, text[k], envelope, fatigue, factors[k], chunk[k]);
      if (k === spos) d += rng.uniform(p.composeWordPauseMs[0], p.composeWordPauseMs[1]);
      strokes.push({ action: "type", text: text[k], delayMs: d, isBreak: false });
      buf.push(text[k]);
    }
  }

  _emitCorrection(strokes, buf, text, pending, srcIndex, envelope, fatigue,
                  factors, chunk, marks) {
    const p = this.p, rng = this.rng;
    const nBack = buf.length - pending.bufferStart;

    // Word marks pointing into the region about to be deleted would describe
    // buffer positions that no longer exist. A later revision trusting one
    // rewinds to the wrong place and duplicates text, so drop them here and
    // rebuild during the retype.
    if (marks) {
      while (marks.length && marks[marks.length - 1][0] >= pending.bufferStart) marks.pop();
    }

    let firstExtra = 0;
    if (nBack > 0) {
      strokes.push({ action: "backspace", text: "", isBreak: false,
                     delayMs: rng.uniform(p.correctionDelayMs[0], p.correctionDelayMs[1]) });
      for (let k = 0; k < nBack - 1; k++) {
        strokes.push({ action: "backspace", text: "", isBreak: false,
                       delayMs: rng.uniform(p.backspaceMs[0], p.backspaceMs[1]) });
      }
      buf.length = pending.bufferStart;
    } else {
      // Omission caught instantly: nothing to delete, but still a beat.
      firstExtra = rng.uniform(p.correctionDelayMs[0], p.correctionDelayMs[1]);
    }

    for (let k = pending.srcStart; k < srcIndex; k++) {
      if (marks && isWordStart(text, k)) marks.push([buf.length, k]);
      const prev = buf.length ? buf[buf.length - 1] : null;
      let d = this._iki(prev, text[k], envelope, fatigue, factors[k], chunk[k]) * p.retypeCare;
      if (k === pending.srcStart) d += firstExtra;
      strokes.push({ action: "type", text: text[k], delayMs: d, isBreak: false });
      buf.push(text[k]);
    }
  }

  /* -------------------------------------------------------------- timing */
  _iki(prev, ch, envelope, fatigue, wordFactor, inChunk) {
    const p = this.p, rng = this.rng;
    const base = 60000 / (p.baseWpm * 5);   // 5 chars = 1 "word", by convention
    let m = wordFactor;

    if (prev !== null) {
      const cls = digraphClass(prev, ch);
      const dist = keyDistance(prev, ch);
      if (cls === "same_finger") m *= p.sameFingerPenalty + p.sameFingerDistance * dist;
      else if (cls === "same_key") m *= p.sameKeyBonus;
      else if (cls === "same_hand") m *= p.sameHandPenalty + p.sameHandDistance * dist;
      else m *= p.altHandBonus;
      m *= bigramSpeedFactor(prev, ch);
      // Starting a word costs planning, unless the word comes out as one gesture.
      if (isSpace(prev) && !inChunk) m *= p.wordStartPenalty;
    }

    if (ch === " ") m *= p.spaceBonus;
    else if (ch >= "0" && ch <= "9") m *= p.digitPenalty;
    else if (SYMBOLS.has(ch)) m *= p.symbolPenalty;
    if (requiresShift(ch)) m *= p.shiftPenalty;

    m *= fatigue;
    m /= envelope;

    return Math.max(MIN_IKI_MS, base * m * Math.exp(rng.gauss(0, p.noiseSigma)));
  }

  _extraPause(text, i, prev, composing) {
    const p = this.p, rng = this.rng;
    let extra = 0;

    if (composing) {
      if (prev === "." || prev === "!" || prev === "?") {
        extra += rng.uniform(p.composeSentencePauseMs[0], p.composeSentencePauseMs[1]);
      } else if (prev === "," || prev === ";" || prev === ":") {
        extra += rng.uniform(p.composeClausePauseMs[0], p.composeClausePauseMs[1]);
      } else if (prev === "\n") {
        extra += rng.uniform(p.composeParagraphPauseMs[0], p.composeParagraphPauseMs[1]);
      } else if (prev === " ") {
        // Most word gaps while composing carry a real pause — the single
        // biggest difference from copying.
        if (rng.random() < p.composeWordPauseProb) {
          extra += rng.uniform(p.composeWordPauseMs[0], p.composeWordPauseMs[1]);
        }
        if (rng.random() < p.composeSearchProb) {
          extra += rng.uniform(p.composeSearchPauseMs[0], p.composeSearchPauseMs[1]);
        }
      }
      return extra;
    }

    if (prev === "." || prev === "!" || prev === "?") {
      extra += rng.uniform(p.sentencePauseMs[0], p.sentencePauseMs[1]);
    } else if (prev === "," || prev === ";" || prev === ":") {
      extra += rng.uniform(p.clausePauseMs[0], p.clausePauseMs[1]);
    } else if (prev === "\n") {
      extra += rng.uniform(p.paragraphPauseMs[0], p.paragraphPauseMs[1]);
    }

    if ((i === 0 || text[i - 1] === " ") && rng.random() < p.thinkPauseProb) {
      const end = text.indexOf(" ", i);
      const word = text.slice(i, end === -1 ? text.length : end);
      if (word.length >= 7) extra += rng.uniform(p.thinkPauseMs[0], p.thinkPauseMs[1]);
    }
    return extra;
  }

  /* --------------------------------------------------------------- typos */
  _typoProbability(ch, prev, envelope) {
    const p = this.p;
    if (isSpace(ch)) return 0;
    // Going faster than usual costs accuracy, which is why typo bursts cluster
    // in the fast stretches.
    let rate = p.typoRate * Math.pow(envelope, 1.8);
    if (prev !== null) rate *= digraphDifficulty(prev, ch);
    return rate;
  }

  _maybeTypo(text, i, envelope, prev) {
    const rng = this.rng;
    const ch = text[i];

    if ((i === 0 || isSpace(text[i - 1])) && Object.keys(this.p.learnedTypos).length) {
      const hit = this._learnedTypoAt(text, i);
      if (hit) return hit;
    }
    if (i === 0 || rng.random() >= this._typoProbability(ch, prev, envelope)) {
      return [0, [], ""];
    }

    const kind = rng.weighted(Object.entries(this.p.typoWeights));

    if (kind === "substitute") {
      const opts = neighbors(ch);
      return opts.length ? [1, [rng.choice(opts)], kind] : [0, [], ""];
    }
    if (kind === "transpose") {
      if (i + 1 >= text.length || isSpace(text[i + 1]) || isSpace(ch)) return [0, [], ""];
      // Transposition is a race between two fingers, so it needs two hands.
      // Same-hand pairs are sequenced by one motor program and come out in
      // order; "teh" happens because the right hand fires before the left has
      // finished.
      if (digraphClass(ch, text[i + 1]) !== "alt" && rng.random() < 0.85) return [0, [], ""];
      return [2, [text[i + 1], ch], kind];
    }
    if (kind === "insert") {
      const opts = neighbors(ch);
      if (!opts.length) return [0, [], ""];
      const stray = rng.choice(opts);
      return rng.random() < 0.4 ? [1, [stray, ch], kind] : [1, [ch, stray], kind];
    }
    if (kind === "double") return [1, [ch, ch], kind];
    if (kind === "omit") return [1, [], kind];
    return [0, [], ""];
  }

  _learnedTypoAt(text, i) {
    let end = i;
    while (end < text.length && /[A-Za-z']/.test(text[end])) end++;
    const word = text.slice(i, end);
    if (!word.length) return null;
    let wrong = this.p.learnedTypos[word.join("").toLowerCase()];
    if (!wrong || this.rng.random() >= this.p.learnedTypoProb) return null;
    if (word[0] === word[0].toUpperCase() && word[0] !== word[0].toLowerCase()) {
      wrong = wrong[0].toUpperCase() + wrong.slice(1);
    }
    return [word.length, [...wrong], "word"];
  }
}
