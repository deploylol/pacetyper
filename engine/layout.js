/**
 * Keyboard geometry, bigram cost, and word frequency.
 */

export const ROWS = [
  "`1234567890-=",
  "qwertyuiop[]\\",
  "asdfghjkl;'",
  "zxcvbnm,./",
];

// Horizontal offset of each row on a staggered keyboard, in key widths.
// Without this, q->a and a->z look like identical moves.
const STAGGER = [0.0, 0.5, 0.75, 1.15];
// Vertical spacing costs more than horizontal: fingers curl and extend less
// comfortably than they splay.
const ROW_WEIGHT = 1.2;

const SHIFT_PAIRS = {
  "~": "`", "!": "1", "@": "2", "#": "3", "$": "4", "%": "5",
  "^": "6", "&": "7", "*": "8", "(": "9", ")": "0", "_": "-",
  "+": "=", "{": "[", "}": "]", "|": "\\", ":": ";", '"': "'",
  "<": ",", ">": ".", "?": "/",
};

// Touch-typing fingers. 0-4 left pinky..thumb, 5-9 right thumb..pinky.
const FINGER_KEYS = {
  0: "`1qaz", 1: "2wsx", 2: "3edc", 3: "45rtfgvb",
  6: "67yuhjnm", 7: "8ik,", 8: "9ol.", 9: "0-=p[]\\;'/",
};

const KEY_FINGER = {};
for (const [finger, keys] of Object.entries(FINGER_KEYS)) {
  for (const ch of keys) KEY_FINGER[ch] = Number(finger);
}

const KEY_POS = {};
ROWS.forEach((row, r) => {
  [...row].forEach((ch, c) => { KEY_POS[ch] = [r, c]; });
});

// Relative frequency of common English bigrams, per 1000. Graded rather than a
// flat common/uncommon split: the drilled advantage of "th" over "st" is real
// and roughly proportional to log frequency.
const BIGRAM_FREQ = {
  th: 3.56, he: 3.07, in: 2.43, er: 2.05, an: 1.99, re: 1.85, on: 1.76,
  at: 1.49, en: 1.45, nd: 1.35, ti: 1.34, es: 1.34, or: 1.28, te: 1.20,
  of: 1.17, ed: 1.17, is: 1.13, it: 1.12, al: 1.09, ar: 1.07, st: 1.05,
  to: 1.04, nt: 1.04, ng: 0.95, se: 0.93, ha: 0.93, as: 0.87, ou: 0.87,
  io: 0.83, le: 0.83, ve: 0.83, co: 0.79, me: 0.79, de: 0.76, hi: 0.76,
  ri: 0.73, ro: 0.73, ic: 0.70, ne: 0.69, ea: 0.69, ra: 0.69, ce: 0.65,
  li: 0.62, ch: 0.60, ll: 0.58, be: 0.58, ma: 0.57, si: 0.55, om: 0.55,
  ur: 0.54, ca: 0.53, el: 0.53, ta: 0.53, la: 0.53, ns: 0.51, di: 0.50,
  fo: 0.49, ho: 0.46, pe: 0.45, ec: 0.45, pr: 0.45, no: 0.44, ct: 0.44,
  us: 0.43, ac: 0.43, ot: 0.43, il: 0.43, tr: 0.42, ly: 0.42, nc: 0.41,
  et: 0.41, ut: 0.40, ss: 0.40, so: 0.39, rs: 0.39, un: 0.38, lo: 0.38,
  wa: 0.38, ge: 0.37, ie: 0.37, wh: 0.37, ee: 0.36, wi: 0.36, em: 0.35,
  ad: 0.35, ol: 0.34, rt: 0.34, po: 0.33, we: 0.33, na: 0.33, ul: 0.32,
  ni: 0.32, ts: 0.32, mo: 0.31, ow: 0.31, pa: 0.30, im: 0.30, mi: 0.30,
  ai: 0.30, sh: 0.30, ir: 0.29, su: 0.29, id: 0.29, os: 0.29, iv: 0.29,
};
const MAX_BIGRAM_FREQ = 3.56;

// Words typed as a single motor chunk rather than assembled letter by letter.
const WORDS_T1 = new Set(
  ("the of and to a in is it you that he was for on are with as i his they be " +
   "at have this from or had by not but what all we can").split(" "));
const WORDS_T2 = new Set(
  ("were when your said there use an each which she do how their if will up " +
   "other about out many then them these so some her would make like him into " +
   "time has look two more write go see number no way could people my than " +
   "first been call who now find long down day did get come made may part " +
   "over new sound take only little work know place year live me back give " +
   "most very after thing our just name good man think say great where help " +
   "through much before line right too mean old any same tell show also " +
   "around form three small set put end does another well large must big " +
   "even such because turn here why ask went men read need land different " +
   "home us move try kind hand picture again change off play air away " +
   "house point page letter mother answer found study still learn should " +
   "world").split(" "));

export function baseKey(ch) {
  if (SHIFT_PAIRS[ch]) return SHIFT_PAIRS[ch];
  const low = ch.toLowerCase();
  return KEY_POS[low] ? low : null;
}

export function requiresShift(ch) {
  return (ch !== ch.toLowerCase() && ch === ch.toUpperCase()) || ch in SHIFT_PAIRS;
}

export function fingerOf(ch) {
  if (ch === " ") return 4;
  const key = baseKey(ch);
  return key != null && key in KEY_FINGER ? KEY_FINGER[key] : null;
}

export function keyDistance(a, b) {
  const ka = baseKey(a), kb = baseKey(b);
  if (!ka || !kb || !KEY_POS[ka] || !KEY_POS[kb]) return 1.0;
  const [ra, ca] = KEY_POS[ka];
  const [rb, cb] = KEY_POS[kb];
  const dx = (ca + STAGGER[ra]) - (cb + STAGGER[rb]);
  const dy = (ra - rb) * ROW_WEIGHT;
  return Math.hypot(dx, dy);
}

/** Keys a finger could plausibly land on instead of this one. */
export function neighbors(ch) {
  const key = baseKey(ch);
  if (!key || !KEY_POS[key]) return [];
  const [row, col] = KEY_POS[key];
  const out = [];
  for (const dr of [-1, 0, 1]) {
    const r = row + dr;
    if (r < 0 || r >= ROWS.length) continue;
    const span = dr === 0 ? [-1, 1] : [-1, 0, 1];
    for (const dc of span) {
      const c = col + dc;
      if (c >= 0 && c < ROWS[r].length) out.push(ROWS[r][c]);
    }
  }
  const isUpper = ch !== ch.toLowerCase() && ch === ch.toUpperCase();
  return isUpper ? out.map((c) => c.toUpperCase()) : out;
}

/** Multiplier from how drilled this key pair is. Log-scaled. */
export function bigramSpeedFactor(a, b) {
  const freq = BIGRAM_FREQ[(a + b).toLowerCase()];
  if (freq === undefined) return 1.06;
  const rel = Math.log1p(freq) / Math.log1p(MAX_BIGRAM_FREQ);
  return 1.0 - 0.3 * rel;
}

/** How much of a single motor chunk this word is. */
export function wordSpeedFactor(word) {
  const w = word.replace(/^[.,;:!?"'()[\]]+|[.,;:!?"'()[\]]+$/g, "").toLowerCase();
  if (!w) return 1.0;
  if (WORDS_T1.has(w)) return 0.74;
  if (WORDS_T2.has(w)) return 0.87;
  if (w.length >= 12) return 1.1;
  return 1.0;
}

export function digraphClass(prev, cur) {
  const f1 = fingerOf(prev), f2 = fingerOf(cur);
  if (f1 === null || f2 === null) return "alt";
  if (f1 === 4 || f1 === 5 || f2 === 4 || f2 === 5) return "alt";
  if (f1 === f2) return baseKey(prev) === baseKey(cur) ? "same_key" : "same_finger";
  return (f1 < 5) === (f2 < 5) ? "same_hand" : "alt";
}

/**
 * Relative likelihood of fumbling this transition. Errors concentrate on the
 * same moves that are slow, which is why a difficulty-driven typo model looks
 * right and a uniform one does not.
 */
export function digraphDifficulty(prev, cur) {
  const cls = digraphClass(prev, cur);
  const dist = keyDistance(prev, cur);
  if (cls === "same_finger") return 1.7 + 0.35 * dist;
  if (cls === "same_key") return 0.55;
  if (cls === "same_hand") return 1.0 + 0.18 * dist;
  return 0.8;
}

/**
 * [[start, end, word], ...] for every whitespace-delimited run.
 *
 * Accepts a string or an array of characters. The planner passes an array,
 * because the unit it counts in is the character a person would delete with one
 * backspace, which is not always one element of a string.
 */
export function wordSpans(text) {
  const spans = [];
  let i = 0;
  while (i < text.length) {
    while (i < text.length && /\s/.test(text[i])) i++;
    if (i >= text.length) break;
    const start = i;
    while (i < text.length && !/\s/.test(text[i])) i++;
    const run = text.slice(start, i);
    spans.push([start, i, Array.isArray(run) ? run.join("") : run]);
  }
  return spans;
}
