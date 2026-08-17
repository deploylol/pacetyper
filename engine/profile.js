/**
 * Profile defaults, named styles, storage, and session merging.
 */

export const DEFAULT_PROFILE = {
  name: "default",

  /* --- motor ----------------------------------------------------------- */
  baseWpm: 62,
  // Spread of inter-key intervals, as the sigma of a lognormal. Lognormal is
  // right for the *motor* component; the long tail of real data comes from
  // cognition, modelled explicitly below rather than hidden in this number.
  noiseSigma: 0.28,

  // Speed varies on two timescales at once: stamina drifting over a paragraph,
  // and the burst-and-catch rhythm of running off a few words then re-reading.
  envelopeTheta: 0.07,
  envelopeSigma: 0.07,
  burstTheta: 0.34,
  burstSigma: 0.12,

  sameFingerPenalty: 1.34,
  sameFingerDistance: 0.11,   // extra per key-width of finger travel
  sameHandPenalty: 1.05,
  sameHandDistance: 0.035,
  altHandBonus: 0.88,
  sameKeyBonus: 0.72,
  wordStartPenalty: 1.12,
  shiftPenalty: 1.3,
  digitPenalty: 1.45,
  symbolPenalty: 1.65,
  spaceBonus: 0.86,

  /* --- pauses while copying (ms) --------------------------------------- */
  sentencePauseMs: [280, 900],
  clausePauseMs: [120, 380],
  paragraphPauseMs: [600, 2200],
  thinkPauseMs: [250, 1100],
  thinkPauseProb: 0.035,

  /* --- pauses while composing ------------------------------------------ */
  composeSpeedRatio: 0.62,
  composeWordPauseMs: [140, 800],
  composeWordPauseProb: 0.3,
  composeClausePauseMs: [500, 2200],
  composeSentencePauseMs: [1100, 5000],
  composeParagraphPauseMs: [2500, 14000],
  composeSearchPauseMs: [1400, 6000],
  composeSearchProb: 0.055,
  revisionProb: 0.022,
  revisionWords: [1, 3],
  revisionPauseMs: [350, 1800],

  /* --- errors ----------------------------------------------------------- */
  typoRate: 0.022,
  typoWeights: {
    substitute: 0.42,   // hit the neighbouring key
    transpose: 0.22,    // "teh"
    insert: 0.14,       // stray extra key
    double: 0.12,       // held a key too long
    omit: 0.1,          // dropped a letter
  },
  // Not every mistake is equally visible. You cannot see a letter that is not
  // there, so omissions survive proofreading far more often.
  detectBias: { substitute: 1.0, transpose: 1.0, insert: 0.95, double: 0.78, omit: 0.55 },
  learnedTypos: {},
  learnedTypoProb: 0.3,

  correctionRate: 0.93,
  detectLagChars: [1, 5],
  correctionDelayMs: [180, 620],
  backspaceMs: [55, 105],
  retypeCare: 1.15,

  /* --- endurance -------------------------------------------------------- */
  fatiguePer1k: 0.035,
  breakMs: [30000, 300000],

  /* --- provenance ------------------------------------------------------- */
  sampleCount: 0,
  sampleChars: 0,
  composeSampleCount: 0,
  composeSampleChars: 0,
};

/* Named styles. Applied over a profile, so training still counts. */
export const STYLES = {
  careful: {
    label: "Careful",
    blurb: "Slower than able, checks as they go. Almost nothing survives.",
    baseWpm: 48, noiseSigma: 0.26, typoRate: 0.012, correctionRate: 0.99,
    detectLagChars: [1, 2], retypeCare: 1.3, thinkPauseProb: 0.07,
  },
  normal: {
    label: "Normal",
    blurb: "An ordinary office typist. A sensible default.",
    baseWpm: 45, noiseSigma: 0.34, typoRate: 0.028, correctionRate: 0.9,
  },
  rushed: {
    label: "Rushed",
    blurb: "Quick and slightly reckless — speed bought with accuracy.",
    baseWpm: 110, noiseSigma: 0.28, typoRate: 0.048, correctionRate: 0.93,
    altHandBonus: 0.82, burstSigma: 0.15,
  },
  "touch-typist": {
    label: "Touch typist",
    blurb: "Trained, unhurried, accurate. Steady rhythm.",
    baseWpm: 75, noiseSigma: 0.24, typoRate: 0.016, correctionRate: 0.95,
    sameFingerPenalty: 1.45, altHandBonus: 0.84,
  },
  "hunt-and-peck": {
    label: "Hunt and peck",
    blurb: "Two fingers, eyes on the keyboard. Slow and uneven.",
    baseWpm: 24, noiseSigma: 0.52, typoRate: 0.055, correctionRate: 0.88,
    wordStartPenalty: 1.3, sameFingerPenalty: 1.15, altHandBonus: 0.97,
    envelopeSigma: 0.09, composeSpeedRatio: 0.78,
  },
  sloppy: {
    label: "Sloppy",
    blurb: "Types fast, proofreads never. Mistakes stay in the document.",
    baseWpm: 72, noiseSigma: 0.4, typoRate: 0.062, correctionRate: 0.62,
    detectLagChars: [2, 9],
  },
  tired: {
    label: "Tired",
    blurb: "End of a long day: slowing, drifting, more mistakes.",
    baseWpm: 38, noiseSigma: 0.45, typoRate: 0.05, correctionRate: 0.8,
    fatiguePer1k: 0.14, envelopeSigma: 0.1, thinkPauseProb: 0.09,
    composeSearchProb: 0.1,
  },
};

export function newProfile(overrides = {}) {
  return JSON.parse(JSON.stringify({ ...DEFAULT_PROFILE, ...overrides }));
}

/** Layer a named style over a profile, keeping everything it does not set. */
export function applyStyle(profile, styleName) {
  const style = STYLES[styleName];
  if (!style) throw new Error(`Unknown style: ${styleName}`);
  const out = newProfile(profile);
  for (const [key, value] of Object.entries(style)) {
    if (key === "label" || key === "blurb") continue;
    out[key] = value;
  }
  return out;
}

/* ------------------------------------------------------------- storage */
/* Only the trained profile lives here. The draft and the UI settings belong to
   session.js, which is what both windows read and write — two modules owning
   the same storage key is how they end up disagreeing about it. */
const STORAGE_KEY = "pacetyper.profile";

export async function loadProfile() {
  try {
    const got = await browser.storage.local.get(STORAGE_KEY);
    return got[STORAGE_KEY] ? newProfile(got[STORAGE_KEY]) : newProfile();
  } catch {
    return newProfile();
  }
}

export async function saveProfile(profile) {
  await browser.storage.local.set({ [STORAGE_KEY]: profile });
}

export async function clearProfile() {
  await browser.storage.local.remove(STORAGE_KEY);
}

/* --------------------------------------------------- merging sessions */
const TYPICAL_SAMPLE_CHARS = 300;
const HISTORY_WEIGHT_CAP = 4;

const MOTOR_SCALARS = ["baseWpm", "noiseSigma", "typoRate", "correctionRate"];
const MOTOR_RANGES = ["sentencePauseMs", "clausePauseMs", "correctionDelayMs",
                      "backspaceMs", "detectLagChars"];
const COMPOSE_SCALARS = ["composeSpeedRatio", "composeWordPauseProb",
                         "composeSearchProb", "revisionProb"];
const COMPOSE_RANGES = ["composeWordPauseMs", "composeClausePauseMs",
                        "composeSentencePauseMs", "composeSearchPauseMs"];
const INT_RANGES = new Set(["detectLagChars", "revisionWords"]);

function blend(oldP, newP, into, scalars, ranges, wOld, wNew) {
  const total = wOld + wNew;
  for (const f of scalars) {
    into[f] = Math.round(((oldP[f] * wOld + newP[f] * wNew) / total) * 10000) / 10000;
  }
  for (const f of ranges) {
    const lo = (oldP[f][0] * wOld + newP[f][0] * wNew) / total;
    const hi = (oldP[f][1] * wOld + newP[f][1] * wNew) / total;
    into[f] = INT_RANGES.has(f)
      ? [Math.max(1, Math.round(lo)), Math.max(2, Math.round(hi))]
      : [Math.round(lo * 10) / 10, Math.round(hi * 10) / 10];
  }
}

/* Fold a training session into a profile. */
export function mergeProfile(oldP, newP) {
  const out = newProfile(oldP);

  if (newP.sampleChars > 0) {
    if (oldP.sampleChars > 0) {
      const wOld = Math.min(oldP.sampleChars, HISTORY_WEIGHT_CAP * TYPICAL_SAMPLE_CHARS);
      blend(oldP, newP, out, MOTOR_SCALARS, MOTOR_RANGES, wOld, newP.sampleChars);
    } else {
      for (const f of [...MOTOR_SCALARS, ...MOTOR_RANGES]) out[f] = newP[f];
    }
  }

  if (newP.composeSampleChars > 0) {
    if (oldP.composeSampleChars > 0) {
      const wOld = Math.min(oldP.composeSampleChars, HISTORY_WEIGHT_CAP * TYPICAL_SAMPLE_CHARS);
      blend(oldP, newP, out, COMPOSE_SCALARS, COMPOSE_RANGES, wOld, newP.composeSampleChars);
    } else {
      for (const f of [...COMPOSE_SCALARS, ...COMPOSE_RANGES]) out[f] = newP[f];
    }
  }

  out.learnedTypos = { ...oldP.learnedTypos, ...newP.learnedTypos };
  out.sampleCount = oldP.sampleCount + newP.sampleCount;
  out.sampleChars = oldP.sampleChars + newP.sampleChars;
  out.composeSampleCount = oldP.composeSampleCount + newP.composeSampleCount;
  out.composeSampleChars = oldP.composeSampleChars + newP.composeSampleChars;
  return out;
}

export function isTrained(profile) {
  return profile.sampleCount > 0 || profile.composeSampleCount > 0;
}
