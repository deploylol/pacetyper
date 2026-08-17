/**
 * Formulas to plain characters. $lpha^2$ becomes α².
 */

/* Single-token symbols. Everything here is one character out, so it types like
   any other character and needs no structure. */
const SYMBOLS = {
  // Greek
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", varepsilon: "ε",
  zeta: "ζ", eta: "η", theta: "θ", vartheta: "ϑ", iota: "ι", kappa: "κ",
  lambda: "λ", mu: "μ", nu: "ν", xi: "ξ", pi: "π", rho: "ρ", sigma: "σ",
  tau: "τ", upsilon: "υ", phi: "φ", varphi: "φ", chi: "χ", psi: "ψ", omega: "ω",
  Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Xi: "Ξ", Pi: "Π",
  Sigma: "Σ", Upsilon: "Υ", Phi: "Φ", Psi: "Ψ", Omega: "Ω",

  // Relations and operators
  times: "×", div: "÷", pm: "±", mp: "∓", cdot: "·", ast: "∗", star: "⋆",
  circ: "∘", bullet: "•", leq: "≤", le: "≤", geq: "≥", ge: "≥", neq: "≠",
  ne: "≠", approx: "≈", equiv: "≡", sim: "∼", simeq: "≃", cong: "≅",
  propto: "∝", ll: "≪", gg: "≫", subset: "⊂", supset: "⊃", subseteq: "⊆",
  supseteq: "⊇", in: "∈", ni: "∋", notin: "∉", cup: "∪", cap: "∩",
  setminus: "∖", emptyset: "∅", varnothing: "∅", forall: "∀", exists: "∃",
  nexists: "∄", neg: "¬", lnot: "¬", wedge: "∧", land: "∧", vee: "∨",
  lor: "∨", oplus: "⊕", otimes: "⊗", perp: "⊥", parallel: "∥", mid: "∣",

  // Arrows
  rightarrow: "→", to: "→", leftarrow: "←", gets: "←", leftrightarrow: "↔",
  Rightarrow: "⇒", implies: "⇒", Leftarrow: "⇐", Leftrightarrow: "⇔",
  iff: "⇔", mapsto: "↦", uparrow: "↑", downarrow: "↓",

  // Big operators. Flat forms: limits are handled as scripts beside them,
  // because nothing in plain text puts one character above another.
  sum: "∑", prod: "∏", coprod: "∐", int: "∫", iint: "∬", iiint: "∭",
  oint: "∮", bigcup: "⋃", bigcap: "⋂",

  // Miscellany
  infty: "∞", partial: "∂", nabla: "∇", angle: "∠", degree: "°", prime: "′",
  therefore: "∴", because: "∵", ldots: "…", dots: "…", cdots: "⋯",
  vdots: "⋮", ddots: "⋱", hbar: "ℏ", ell: "ℓ", Re: "ℜ", Im: "ℑ",
  aleph: "ℵ", surd: "√", checkmark: "✓", dagger: "†", S: "§", P: "¶",
  copyright: "©", pounds: "£", euro: "€", quad: " ", qquad: "  ",
  lbrace: "{", rbrace: "}", langle: "⟨", rangle: "⟩", lceil: "⌈", rceil: "⌉",
  lfloor: "⌊", rfloor: "⌋",
};

/* Blackboard bold and friends: \mathbb{R} and the rest of the sets people
   actually write. Anything outside these falls back to the plain letter. */
const FONTS = {
  mathbb: { R: "ℝ", N: "ℕ", Z: "ℤ", Q: "ℚ", C: "ℂ", P: "ℙ", E: "𝔼", H: "ℍ" },
  mathcal: { L: "ℒ", F: "ℱ", H: "ℋ", N: "𝒩", O: "𝒪", P: "𝒫", B: "ℬ", E: "ℰ" },
  mathfrak: { g: "𝔤", h: "𝔥", m: "𝔪", p: "𝔭", A: "𝔄", B: "𝔅" },
};

/* Accents are combining marks: they attach to the character before them, and
   one backspace removes the pair. The planner counts them as one keystroke. */
const ACCENTS = {
  hat: "̂", widehat: "̂", bar: "̄", overline: "̄",
  vec: "⃗", dot: "̇", ddot: "̈", tilde: "̃",
  widetilde: "̃", acute: "́", grave: "̀", check: "̌",
  breve: "̆", mathring: "̊", underline: "̲",
};

const SUPER = {
  0: "⁰", 1: "¹", 2: "²", 3: "³", 4: "⁴", 5: "⁵", 6: "⁶", 7: "⁷", 8: "⁸",
  9: "⁹", "+": "⁺", "-": "⁻", "−": "⁻", "=": "⁼", "(": "⁽", ")": "⁾",
  a: "ᵃ", b: "ᵇ", c: "ᶜ", d: "ᵈ", e: "ᵉ", f: "ᶠ", g: "ᵍ", h: "ʰ", i: "ⁱ",
  j: "ʲ", k: "ᵏ", l: "ˡ", m: "ᵐ", n: "ⁿ", o: "ᵒ", p: "ᵖ", r: "ʳ", s: "ˢ",
  t: "ᵗ", u: "ᵘ", v: "ᵛ", w: "ʷ", x: "ˣ", y: "ʸ", z: "ᶻ",
};

const SUB = {
  0: "₀", 1: "₁", 2: "₂", 3: "₃", 4: "₄", 5: "₅", 6: "₆", 7: "₇", 8: "₈",
  9: "₉", "+": "₊", "-": "₋", "−": "₋", "=": "₌", "(": "₍", ")": "₎",
  a: "ₐ", e: "ₑ", h: "ₕ", i: "ᵢ", j: "ⱼ", k: "ₖ", l: "ₗ", m: "ₘ", n: "ₙ",
  o: "ₒ", p: "ₚ", r: "ᵣ", s: "ₛ", t: "ₜ", u: "ᵤ", v: "ᵥ", x: "ₓ",
};

/* Fractions with a dedicated character. Anything else becomes a/b. */
const VULGAR = {
  "1/2": "½", "1/3": "⅓", "2/3": "⅔", "1/4": "¼", "3/4": "¾", "1/5": "⅕",
  "2/5": "⅖", "3/5": "⅗", "4/5": "⅘", "1/6": "⅙", "5/6": "⅚", "1/8": "⅛",
  "3/8": "⅜", "5/8": "⅝", "7/8": "⅞",
};

/* Spacing commands, and wrappers that only affect size or style. Dropping them
   is right: they say how to draw, and there is no drawing here. */
const IGNORED = new Set([
  "left", "right", "displaystyle", "textstyle", "scriptstyle", "limits",
  "nolimits", "big", "Big", "bigg", "Bigg", "bigl", "bigr", "Bigl", "Bigr",
  "mathrm", "mathit", "mathsf", "mathtt", "operatorname", "boldsymbol",
  "mathbf", "bf", "it", "rm", "!", ",", ";", ":", " ",
]);

/* Two-dimensional constructs. There is no honest flat rendering, so the caller
   is told rather than handed something wrong. */
const UNRENDERABLE = new Set([
  "matrix", "pmatrix", "bmatrix", "vmatrix", "Vmatrix", "smallmatrix",
  "array", "align", "aligned", "alignat", "cases", "gather", "gathered",
  "split", "eqnarray", "table", "tabular",
]);

const TOKEN = /\\[a-zA-Z]+|\\.|[{}^_&]|\s+|[^\\{}^_&\s]/g;

/** Strip the delimiters that copied LaTeX arrives wrapped in. */
export function stripDelimiters(latex) {
  let s = latex.trim();
  for (const [open, close] of [["$$", "$$"], ["\\[", "\\]"], ["\\(", "\\)"], ["$", "$"]]) {
    if (s.startsWith(open) && s.endsWith(close) && s.length > open.length + close.length) {
      return s.slice(open.length, -close.length).trim();
    }
  }
  return s;
}

/** Map each character to its superscript or subscript form, or fail. */
function script(text, table) {
  let out = "";
  for (const ch of text) {
    const mapped = table[ch];
    if (mapped === undefined) return null;   // no partial scripts: all or none
    out += mapped;
  }
  return out;
}

/** True if `s` is a bare number or single symbol that needs no bracketing. */
const isAtomic = (s) => /^[^\s+\-−*/=<>]+$/.test(s) || /^-?\d+(\.\d+)?$/.test(s);

/* Translate LaTeX to plain Unicode. */
export function latexToUnicode(latex) {
  const warnings = [];
  const tokens = stripDelimiters(latex).match(TOKEN) || [];
  let i = 0;

  /** Consume one argument: a braced group, or the next single token. */
  function group() {
    while (i < tokens.length && /^\s+$/.test(tokens[i])) i++;
    if (i >= tokens.length) return "";
    if (tokens[i] !== "{") return render([tokens[i++]]);
    let depth = 1;
    const start = ++i;
    while (i < tokens.length && depth) {
      if (tokens[i] === "{") depth++;
      else if (tokens[i] === "}") depth--;
      i++;
    }
    return render(tokens.slice(start, i - 1));
  }

  function render(subtokens) {
    const inner = latexToUnicode(subtokens.join(""));
    for (const w of inner.warnings) warnings.push(w);
    return inner.text;
  }

  let out = "";
  while (i < tokens.length) {
    const tok = tokens[i];

    if (/^\s+$/.test(tok)) { out += " "; i++; continue; }

    if (tok === "^" || tok === "_") {
      i++;
      const body = group();
      const mapped = script(body, tok === "^" ? SUPER : SUB);
      if (mapped !== null) out += mapped;
      else out += `${tok}${isAtomic(body) ? body : `(${body})`}`;
      continue;
    }

    if (tok === "{" || tok === "}" || tok === "&") { i++; continue; }

    if (!tok.startsWith("\\")) { out += tok; i++; continue; }

    const cmd = tok.slice(1);

    if (cmd === "\\") { out += "\n"; i++; continue; }   // row break

    if (cmd === "begin" || cmd === "end") {
      i++;
      const env = group();
      if (UNRENDERABLE.has(env)) {
        warnings.push(`A ${env} block can't be written as plain characters — ` +
                      `it needs rows and columns. Insert that part yourself.`);
      }
      continue;
    }
    if (IGNORED.has(cmd)) { i++; continue; }

    if (cmd === "frac" || cmd === "dfrac" || cmd === "tfrac") {
      i++;
      const num = group(), den = group();
      const vulgar = VULGAR[`${num}/${den}`];
      if (vulgar) out += vulgar;
      else out += `${isAtomic(num) ? num : `(${num})`}/${isAtomic(den) ? den : `(${den})`}`;
      continue;
    }
    if (cmd === "sqrt") {
      i++;
      const body = group();
      out += isAtomic(body) ? `√${body}` : `√(${body})`;
      continue;
    }
    if (cmd === "text" || cmd === "textrm" || cmd === "mbox") {
      i++;
      out += group();
      continue;
    }
    if (ACCENTS[cmd]) {
      i++;
      out += group() + ACCENTS[cmd];      // combining mark follows its base
      continue;
    }
    if (FONTS[cmd]) {
      i++;
      const body = group();
      out += [...body].map((ch) => FONTS[cmd][ch] || ch).join("");
      continue;
    }
    if (SYMBOLS[cmd] !== undefined) { out += SYMBOLS[cmd]; i++; continue; }
    if (cmd.length === 1 && !/[a-zA-Z]/.test(cmd)) { out += cmd; i++; continue; }

    // A named function — \sin, \log, \max — reads correctly as its own name.
    if (/^[a-z]+$/.test(cmd) && cmd.length <= 6) { out += cmd; i++; continue; }

    warnings.push(`\\${cmd} has no plain-text equivalent, so it is left as written.`);
    out += `\\${cmd}`;
    i++;
  }

  // Collapse runs of spaces, which LaTeX ignores anyway, but keep row breaks.
  const tidy = out.replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").trim();
  return { text: tidy, warnings: [...new Set(warnings)] };
}

/* $…$, $$…$$, \(…\) and \[…\]. Escaped \$ is a literal dollar and is skipped. */
const MATH_SPAN = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|(?<!\\)\$([^$\n]+?)(?<!\\)\$/g;

/* "$5 and $10" is two prices, not one formula. A single-dollar span is only
   taken as maths if it carries something maths actually uses; the unambiguous
   $$…$$, \(…\) and \[…\] forms are trusted as written. */
const MATH_SIGNAL = /[\\^_]|[+\-−*/=<>≤≥≠]|\b[a-zA-Z]\s*[₀-₉0-9]\b/;

/** True if the text contains anything that looks like a maths span. */
export function hasMath(text) {
  MATH_SPAN.lastIndex = 0;
  let m;
  while ((m = MATH_SPAN.exec(text)) !== null) {
    if (m[4] === undefined || MATH_SIGNAL.test(m[4])) { MATH_SPAN.lastIndex = 0; return true; }
  }
  return false;
}

/* Replace every maths span in `text` with its plain-character form. */
export function renderMath(text) {
  const warnings = [];
  let replaced = 0;
  const out = text.replace(MATH_SPAN, (match, dd, br, pr, single) => {
    const body = [dd, br, pr, single].find((g) => g !== undefined);
    if (body === undefined) return match;
    if (single !== undefined && !MATH_SIGNAL.test(single)) return match;
    const { text: rendered, warnings: w } = latexToUnicode(body);
    if (!rendered) return match;
    replaced++;
    for (const one of w) warnings.push(one);
    return rendered;
  });
  return { text: out, replaced, warnings: [...new Set(warnings)] };
}
