/**
 * Popup controller. Shows the draft, builds a plan, hands it over.
 */

import {
  loadSettings, saveSettings, loadDraft, saveDraft, loadJob, subscribe,
  buildPlan, wireStrokes, loadProfile,
} from "../engine/session.js";
import { STYLES, isTrained } from "../engine/profile.js";
import { hasMath } from "../engine/latex.js";
import { hasList } from "../engine/format.js";

const $ = (id) => document.getElementById(id);
const el = {
  target: $("target"), targetText: $("target-text"), aim: $("aim"),
  text: $("text"), counter: $("counter"), clear: $("clear"),
  style: $("style"), mode: $("mode"), wpm: $("wpm"), wpmOut: $("wpm-out"),
  breaks: $("breaks"), duration: $("duration"), perfect: $("perfect"),
  useProfile: $("use-profile"), math: $("math"), mathRow: $("math-row"),
  lists: $("lists"), listRow: $("list-row"),
  planHeadline: $("plan-headline"), planDetail: $("plan-detail"),
  modeHint: $("mode-hint"),
  progress: $("progress"), progressFill: $("progress-fill"),
  progressPct: $("progress-pct"),
  start: $("start"), pause: $("pause"), stop: $("stop"), status: $("status"),
  openPanel: $("open-panel"),
  resume: $("resume"), resumeText: $("resume-text"),
  resumeGo: $("resume-go"), resumeSkip: $("resume-skip"),
};

/* Written from the reader's side: what this setting does for you, not what the
   simulated typist is doing. */
const MODE_HINT = {
  compose: "Pauses to think, the way writing something new actually goes.",
  transcribe: "Steady and quicker, the way copying something out goes.",
};

let settings = null;
let profile = null;
let targetTabId = null;

const setStatus = (msg, kind = "") => {
  el.status.textContent = msg;
  el.status.className = "status" + (kind ? ` is-${kind}` : "");
};

/* ─────────────────────────────────────────────────────────────── form ── */

function readForm() {
  return {
    style: el.style.value,
    mode: el.mode.value,
    wpm: Number(el.wpm.value),
    typos: settings.typos,          // the popup has no mistakes slider; the
    perfect: el.perfect.checked,    // full editor owns that one
    breaks: Number(el.breaks.value) || 0,
    duration: el.duration.value,
    useProfile: el.useProfile.checked,
    math: el.math.checked,
    lists: el.lists.checked ? "editor" : "literal",
  };
}

function writeForm(next) {
  settings = next;
  if (STYLES[next.style]) el.style.value = next.style;
  el.mode.value = next.mode;
  el.wpm.value = String(next.wpm);
  el.breaks.value = String(next.breaks);
  el.duration.value = next.duration || "";
  el.perfect.checked = Boolean(next.perfect);
  el.useProfile.checked = Boolean(next.useProfile);
  el.math.checked = next.math !== false;
  el.lists.checked = next.lists !== "literal";
  el.wpmOut.textContent = `${next.wpm} wpm`;
  el.modeHint.textContent = MODE_HINT[next.mode] || "";
}

/* The formula switch is only meaningful for text that has formulas in it, so
   it stays out of the way until it does. */
function showMathRow(text) {
  el.mathRow.hidden = !hasMath(text);
  el.listRow.hidden = !hasList(text);
}

let settingsTimer = null;
function pushSettings() {
  settings = readForm();
  el.wpmOut.textContent = `${settings.wpm} wpm`;
  el.modeHint.textContent = MODE_HINT[settings.mode] || "";
  refreshPlanLine();
  clearTimeout(settingsTimer);
  settingsTimer = setTimeout(() => saveSettings(settings), 200);
}

let draftTimer = null;
function pushDraft() {
  const text = el.text.value;
  el.counter.textContent = `${text.length} characters`;
  showMathRow(text);
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => { saveDraft(text); refreshPlanLine(); }, 220);
}

function refreshPlanLine() {
  const { plan, error } = buildPlan(el.text.value, settings, profile);
  if (error) {
    el.planHeadline.textContent = el.text.value.trim()
      ? error : "Enter some text to see the timing.";
    el.planDetail.textContent = "";
    return;
  }
  const s = plan.summary();
  el.planHeadline.textContent = s.headline;
  el.planDetail.textContent = s.detail;
  const warning = plan.warnings[0] || s.warning;
  if (warning) setStatus(warning, "warn");
  else if (el.status.classList.contains("is-warn")) setStatus("");
}

/* ───────────────────────────────────────────────────────────── target ── */

function showTarget({ ok, error, where, hasTarget, title, tabId }) {
  targetTabId = tabId ?? null;
  el.target.className = "target";
  el.aim.hidden = true;

  if (!ok) {
    el.target.classList.add("is-blocked");
    el.targetText.textContent = error;
    el.start.disabled = true;
    return;
  }
  el.start.disabled = false;
  if (hasTarget) {
    el.target.classList.add("is-ready");
    el.targetText.textContent = `Typing into ${where} on “${trim(title)}”`;
    el.aim.hidden = false;
  } else {
    el.targetText.textContent = `No text box picked on “${trim(title)}”`;
    el.aim.hidden = false;
  }
}

const trim = (s) => (s && s.length > 34 ? `${s.slice(0, 33)}…` : (s || "this page"));

async function probe() {
  try {
    showTarget(await browser.runtime.sendMessage({ kind: "probe" }));
  } catch (err) {
    showTarget({ ok: false, error: `Cannot read this page: ${err.message}` });
  }
}

/* ──────────────────────────────────────────────────────────── running ── */

function showJob(job) {
  const live = Boolean(job && (job.status === "typing" || job.status === "paused"));
  const paused = Boolean(job && job.status === "paused");

  el.start.hidden = live;
  el.pause.hidden = !live;
  el.stop.hidden = !live;
  el.pause.textContent = paused ? "Resume" : "Pause";
  el.progress.hidden = !live;
  el.progress.classList.toggle("is-paused", paused);

  if (!job) return;
  if (live && job.total) {
    const pct = Math.min(100, Math.round((job.typed / job.total) * 100));
    el.progressFill.style.width = `${pct}%`;
    el.progressPct.textContent = `${pct}%`;
  }

  if (job.status === "paused") {
    setStatus("Paused. Close this and it stays paused.");
  } else if (job.status === "typing") {
    setStatus("Typing. You can close this and use other tabs.");
  } else if (job.status === "done") {
    setStatus(`Finished — ${job.typed} characters.`, "ok");
  } else if (job.status === "stopped") {
    setStatus(job.collided
      ? `Stopped at ${job.typed} characters — you started typing on the page.`
      : `Stopped at ${job.typed} characters.`);
    offerResume(job);
  } else if (job.status === "error") {
    setStatus(job.error || "Something went wrong.", "error");
    offerResume(job);
  } else if (job.status === "interrupted") {
    offerResume(job);
  }
}

/* Offers the untyped remainder after a run ends early. */
function offerResume(job) {
  const done = Math.max(0, job.net || 0);
  const rest = typeof job.text === "string" ? job.text.slice(done) : "";
  if (!rest) {
    el.resume.hidden = true;
    // Only an interrupted run is worth forgetting on sight. A run that stopped
    // or failed still has a status the user came here to read, and discarding
    // it would replace the explanation with nothing.
    if (job.status === "interrupted") browser.runtime.sendMessage({ kind: "forget" });
    return;
  }
  el.resume.hidden = false;
  el.resumeText.textContent = job.status === "interrupted"
    ? `Firefox closed after ${done} of ${job.text.length} characters. ` +
      `Check where the document ends, then continue.`
    : `${job.text.length - done} characters were never typed. ` +
      `Continue from there?`;
  el.resumeGo.onclick = () => {
    el.text.value = rest;
    pushDraft();
    el.resume.hidden = true;
    browser.runtime.sendMessage({ kind: "forget" });
    setStatus("Loaded what was left. Check the document, then start.");
  };
  el.resumeSkip.onclick = () => { el.resume.hidden = true; };
}

async function start() {
  const { plan, error } = buildPlan(el.text.value, settings, profile);
  if (error) { setStatus(error, "error"); return; }

  el.start.disabled = true;
  setStatus("Starting…");
  const reply = await browser.runtime.sendMessage({
    kind: "start", strokes: wireStrokes(plan), tabId: targetTabId,
    text: plan.sourceText,
  });
  el.start.disabled = false;

  if (reply && reply.ok) {
    // Typing has begun and keeps going without this window, so leaving the
    // popup open is optional. It stays put long enough to show that it
    // started, then gets out of the way.
    setStatus("Typing. You can close this and use other tabs.");
    setTimeout(() => window.close(), 900);
  } else {
    setStatus((reply && reply.error) || "Could not start.", "error");
    if (reply && reply.needsTarget) setTimeout(() => window.close(), 900);
  }
}

/* ─────────────────────────────────────────────────────────────── wire ── */

/* A style is a preset. Its speed and accuracy are written into the controls so
   the choice is visible, and so the sliders below stay a fine adjustment
   instead of silently overriding what the style just set. */
el.style.addEventListener("change", () => {
  const style = STYLES[el.style.value];
  if (style) {
    if (style.baseWpm) el.wpm.value = String(Math.round(style.baseWpm));
    if (style.typoRate) settings = { ...settings, typos: Math.round(style.typoRate * 1000) };
  }
  pushSettings();
});

[el.mode, el.perfect, el.useProfile, el.math, el.lists, el.breaks, el.duration]
  .forEach((node) => node.addEventListener("change", pushSettings));
el.wpm.addEventListener("input", pushSettings);
el.text.addEventListener("input", pushDraft);

el.clear.addEventListener("click", () => {
  el.text.value = "";
  pushDraft();
  el.text.focus();
});

el.start.addEventListener("click", start);
el.stop.addEventListener("click", async () => {
  await browser.runtime.sendMessage({ kind: "stop" });
  setStatus("Stopped.");
});

el.pause.addEventListener("click", async () => {
  const resuming = el.pause.textContent === "Resume";
  const reply = await browser.runtime.sendMessage(
    { kind: resuming ? "resume" : "pause" });
  if (reply && !reply.ok) setStatus(reply.error || "Could not pause.", "error");
});

el.aim.addEventListener("click", async () => {
  const reply = await browser.runtime.sendMessage({ kind: "aim" });
  if (reply && reply.ok) window.close();
  else setStatus((reply && reply.error) || "Cannot reach that page.", "error");
});

el.openPanel.addEventListener("click", async () => {
  await browser.runtime.sendMessage({ kind: "open-panel" });
  window.close();
});

subscribe({
  draft: (text) => { if (text !== el.text.value) el.text.value = text; },
  settings: (next) => writeForm(next),
  job: showJob,
});

/* ────────────────────────────────────────────────────────────── start ── */

(async function init() {
  const [loaded, draft, prof, job] =
    await Promise.all([loadSettings(), loadDraft(), loadProfile(), loadJob()]);
  profile = prof;
  writeForm(loaded);
  el.text.value = draft;
  el.counter.textContent = `${draft.length} characters`;
  el.useProfile.disabled = !isTrained(prof);
  if (!isTrained(prof)) $("profile-row").title = "Run the typing test in the full editor first.";
  refreshPlanLine();
  showJob(job);
  probe();
  el.text.focus();
})();
