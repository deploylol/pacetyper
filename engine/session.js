/**
 * The draft and settings that the popup and the panel share.
 */

import { TypingSimulator, parseDuration } from "./simulator.js";
import { renderMath } from "./latex.js";
import { deferListMarkers, substitutionRisk, LIST_NOTE } from "./format.js";
import { applyStyle, newProfile, loadProfile, isTrained } from "./profile.js";

const SETTINGS_KEY = "pacetyper.settings";
const DRAFT_KEY = "pacetyper.draft";
const JOB_KEY = "pacetyper.job";

export const DEFAULT_SETTINGS = {
  style: "normal",
  mode: "compose",
  wpm: 45,
  typos: 28,          // slider units: tenths of a percent
  perfect: false,
  breaks: 0,
  duration: "",
  useProfile: false,
  math: true,         // no effect unless the text actually contains formulas
  lists: "editor",    // "editor" lets the editor number them, "literal" types them
};

/* The longest text a run will accept. Planning is quick even far above this,
   but the plan has to be handed to the page as one message, and a plan this
   size is already about eight hours of typing. */
export const MAX_CHARS = 50000;

export async function loadSettings() {
  try {
    const got = await browser.storage.local.get(SETTINGS_KEY);
    return { ...DEFAULT_SETTINGS, ...(got[SETTINGS_KEY] || {}) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(settings) {
  await browser.storage.local.set({ [SETTINGS_KEY]: settings });
}

export async function loadDraft() {
  try {
    const got = await browser.storage.local.get(DRAFT_KEY);
    return got[DRAFT_KEY] || "";
  } catch {
    return "";
  }
}

export async function saveDraft(text) {
  await browser.storage.local.set({ [DRAFT_KEY]: text });
}

export async function loadJob() {
  try {
    const got = await browser.storage.local.get(JOB_KEY);
    return got[JOB_KEY] || null;
  } catch {
    return null;
  }
}

/* Call `handlers` when another surface changes something. */
export function subscribe({ settings, draft, job } = {}) {
  const listener = (changes, area) => {
    if (area !== "local") return;
    if (settings && changes[SETTINGS_KEY]) {
      settings({ ...DEFAULT_SETTINGS, ...(changes[SETTINGS_KEY].newValue || {}) });
    }
    if (draft && changes[DRAFT_KEY]) draft(changes[DRAFT_KEY].newValue || "");
    if (job && changes[JOB_KEY]) job(changes[JOB_KEY].newValue || null);
  };
  browser.storage.onChanged.addListener(listener);
  return () => browser.storage.onChanged.removeListener(listener);
}

/** Fold the settings and the trained profile into the numbers the engine takes. */
export function profileFor(settings, trained) {
  const base = settings.useProfile && trained && isTrained(trained)
    ? trained : newProfile();
  const p = applyStyle(base, settings.style);
  p.baseWpm = Number(settings.wpm);
  p.typoRate = Number(settings.typos) / 1000;
  if (settings.perfect) p.correctionRate = 1.0;
  return p;
}

/* Build a plan, or explain why not. */
export function buildPlan(text, settings, trained) {
  if (!text || !text.trim()) return { error: "Nothing to type yet." };
  if (text.length > MAX_CHARS) {
    return { error: `That is ${text.length.toLocaleString()} characters. The ` +
                    `limit is ${MAX_CHARS.toLocaleString()} — about 20 pages. ` +
                    `Split it and run the parts one after another.` };
  }

  let durationS = null;
  const raw = (settings.duration || "").trim();
  if (raw) {
    try { durationS = parseDuration(raw); }
    catch (err) { return { error: err.message }; }
  }

  /* Formulas become ordinary characters before anything is planned, so what
     gets typed is what the preview showed and the timing counts the symbols
     that will actually be typed rather than the source that produced them. */
  let source = text;
  let spans = 0;
  const notes = [];
  if (settings.math !== false) {
    const math = renderMath(text);
    if (math.replaced) {
      source = math.text;
      spans = math.replaced;
      notes.push(...math.warnings);
    }
  }

  /* A list typed by hand is numbered by the editor, not by the typist. Typing
     the numbers as well would give "2. 2." on every item after the first. */
  let deferred = 0;
  if (settings.lists !== "literal") {
    const listed = deferListMarkers(source);
    if (listed.removed) { source = listed.text; deferred = listed.removed; }
  }

  const sim = new TypingSimulator(profileFor(settings, trained), undefined, settings.mode);
  const plan = sim.plan(source, {
    breaks: Math.max(0, Number(settings.breaks) || 0),
    durationS,
  });
  plan.mathSpans = spans;
  plan.warnings.push(...notes);
  if (deferred) plan.warnings.push(LIST_NOTE);
  const risk = substitutionRisk(source);
  if (risk) plan.warnings.push(risk);
  return { plan };
}

/** Strip a plan down to what survives being posted between processes. */
export const wireStrokes = (plan) => plan.strokes.map((s) => ({
  action: s.action, text: s.text, delayMs: s.delayMs, isBreak: s.isBreak,
}));

export { loadProfile };
