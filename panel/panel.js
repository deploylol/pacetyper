/**
 * Full editor: preview, typing test, and the tab picker.
 */

import { humanTime } from "../engine/simulator.js";
import {
  STYLES, newProfile, loadProfile, saveProfile, clearProfile,
  mergeProfile, isTrained,
} from "../engine/profile.js";
import {
  PASSAGES, PROMPTS, BACKSPACE, MIN_COMPOSE_CHARS,
  analyseTranscription, analyseComposition,
} from "../engine/trainer.js";
import {
  loadSettings, saveSettings, loadDraft, saveDraft, loadJob, subscribe,
  buildPlan as planFrom, wireStrokes,
} from "../engine/session.js";

const $ = (id) => document.getElementById(id);

const el = {
  text: $("text"), counter: $("counter"), clear: $("clear"),
  preview: $("preview"), previewNote: $("preview-note"),
  style: $("style"), styleBlurb: $("style-blurb"), mode: $("mode"),
  wpm: $("wpm"), wpmOut: $("wpm-out"), typos: $("typos"), typosOut: $("typos-out"),
  perfect: $("perfect"), breaks: $("breaks"), duration: $("duration"),
  planHeadline: $("plan-headline"), planDetail: $("plan-detail"),
  progress: $("progress"), progressFill: $("progress-fill"),
  progressPct: $("progress-pct"), status: $("status"),
  previewBtn: $("preview-btn"), typeBtn: $("type-btn"),
  pauseBtn: $("pause-btn"), stopBtn: $("stop-btn"),
  useProfile: $("use-profile"), profileSummary: $("profile-summary"),
  targetTab: $("target-tab"), refreshTabs: $("refresh-tabs"),
};

let savedProfile = newProfile();
let settings = null;
let previewTimer = null;
let previewStop = false;

/* ────────────────────────────────────────────────────────────── tabs ── */
document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => {
      const on = t === tab;
      t.classList.toggle("is-active", on);
      t.setAttribute("aria-selected", String(on));
    });
    document.querySelectorAll(".panel").forEach((p) => {
      p.classList.toggle("is-active", p.id === tab.dataset.tab);
    });
  });
});

/* ─────────────────────────────────────────────────────────── status ── */
function setStatus(message, kind = "") {
  el.status.textContent = message;
  el.status.className = "status" + (kind ? ` is-${kind}` : "");
}

/* ─────────────────────────────────────────────────── profile + style ── */
function refreshProfileSummary() {
  const trained = isTrained(savedProfile);
  el.useProfile.disabled = !trained;
  if (!trained) {
    el.useProfile.checked = false;
    el.profileSummary.textContent =
      "Nothing trained yet — the Typing test tab takes about two minutes.";
    return;
  }
  const copy = savedProfile.sampleCount, comp = savedProfile.composeSampleCount;
  const parts = [];
  if (copy) parts.push(`${copy} copy`);
  if (comp) parts.push(`${comp} compose`);
  el.profileSummary.textContent =
    `${Math.round(savedProfile.baseWpm)} wpm copying · ` +
    `~${Math.round(savedProfile.baseWpm * savedProfile.composeSpeedRatio)} composing · ` +
    `${parts.join(", ")} session${copy + comp === 1 ? "" : "s"}`;
}

function applyStyleDefaults() {
  const style = STYLES[el.style.value];
  el.styleBlurb.textContent = style.blurb;
  if (style.baseWpm) el.wpm.value = String(style.baseWpm);
  if (style.typoRate) el.typos.value = String(Math.round(style.typoRate * 1000));
  syncOutputs();
}

function syncOutputs() {
  el.wpmOut.textContent = `${el.wpm.value} wpm`;
  // Shown as accuracy, stored as a typo rate. "97% accurate" is a number
  // people already have a feel for; "2.8% error rate" is one they do not.
  el.typosOut.textContent = `${(100 - Number(el.typos.value) / 10).toFixed(1)}%`;
}

/* ────────────────────────────────────────────────────────── planning ── */
function buildPlan() {
  const { plan, error } = planFrom(el.text.value, settings, savedProfile);
  if (error) { setStatus(error, "error"); return null; }
  return plan;
}

function refreshPlanLine() {
  const text = el.text.value;
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  el.counter.textContent = `${text.length} characters · ${words} words`;

  if (!text.trim()) {
    el.planHeadline.textContent = "Enter some text to see the timing.";
    el.planDetail.textContent = "";
    return;
  }
  const { plan, error } = planFrom(text, settings, savedProfile);
  if (error) {
    el.planHeadline.textContent = error;
    el.planDetail.textContent = "";
    return;
  }
  const summary = plan.summary();
  el.planHeadline.textContent = summary.headline;
  el.planDetail.textContent = summary.detail;
  const warning = plan.warnings[0] || summary.warning;
  if (warning) setStatus(warning, "warn");
  else if (el.status.classList.contains("is-warn")) setStatus("");
}

/* ─────────────────────────────────────────────────────────── preview ── */
function stopPreview() {
  previewStop = true;
  if (previewTimer) { clearTimeout(previewTimer); previewTimer = null; }
  el.preview.classList.remove("is-typing");
  el.stopBtn.hidden = true;
  el.previewBtn.disabled = false;
  el.typeBtn.disabled = false;
}

function runPreview(plan) {
  el.preview.textContent = "";
  el.preview.classList.add("is-typing");
  el.previewBtn.disabled = true;
  el.typeBtn.disabled = true;
  el.stopBtn.hidden = false;
  previewStop = false;

  // One text node, mutated in place. Rebuilding the DOM per keystroke is what
  // makes previews stutter on slow machines.
  const node = document.createTextNode("");
  el.preview.appendChild(node);

  const started = performance.now();
  let scheduled = 0;
  let i = 0;
  let buf = "";
  // A break starts a fresh text node, so track where the current node's slice
  // of the document begins — otherwise everything typed before the break gets
  // written out a second time after it.
  let segmentStart = 0;

  const step = () => {
    if (previewStop || i >= plan.strokes.length) {
      if (!previewStop) setStatus("Preview finished.", "ok");
      stopPreview();
      return;
    }
    const stroke = plan.strokes[i++];

    if (stroke.isBreak) {
      // Show breaks as a marker rather than waiting them out; a preview of
      // nothing happening for four minutes helps nobody.
      const mark = document.createElement("span");
      mark.className = "brk";
      mark.textContent = `— break, ${humanTime(stroke.delayMs / 1000)} —`;
      el.preview.appendChild(mark);
      el.preview.appendChild(document.createTextNode(""));
      segmentStart = buf.length;
      el.preview.scrollTop = el.preview.scrollHeight;
      previewTimer = setTimeout(step, 400);
      return;
    }

    scheduled += stroke.delayMs;
    if (stroke.action === "backspace") buf = buf.slice(0, -1);
    else buf += stroke.text;

    el.preview.lastChild.nodeValue = buf.slice(segmentStart);
    el.preview.scrollTop = el.preview.scrollHeight;

    // Absolute deadlines, so the preview cannot drift late over a long run.
    const wait = Math.max(0, started + scheduled - performance.now());
    previewTimer = setTimeout(step, wait);
  };
  step();
}

/* ──────────────────────────────────────────────────── type into page ── */

/* The old build counted down five seconds while you switched tabs, then typed
   into whatever happened to be active. Picking the destination outright
   removes the race, and works when the target is in another window. */
async function refreshTargets() {
  const keep = el.targetTab.value;
  const reply = await browser.runtime.sendMessage({ kind: "targets" });

  /* Reading other tabs is the one thing here that needs broad access, so it is
     an optional permission rather than something demanded at install. Nobody
     should have to grant "read your data on all websites" to try a typing
     tool, and the popup route needs none of it. */
  if (reply && reply.needsPermission) {
    el.targetTab.textContent = "";
    el.targetTab.appendChild(new Option("Permission needed to list tabs", ""));
    setStatus("To type into a tab from here, Pacetyper needs permission to see " +
              "your open tabs. The toolbar button works without it.", "warn");
    el.refreshTabs.textContent = "Grant access";
    return;
  }
  el.refreshTabs.textContent = "Refresh";

  const tabs = (reply && reply.tabs) || [];
  el.targetTab.textContent = "";
  if (!tabs.length) {
    el.targetTab.appendChild(new Option("No eligible tabs open", ""));
    return;
  }
  for (const t of tabs) {
    const label = `${t.ready ? "● " : "○ "}${t.title.slice(0, 60)}`;
    el.targetTab.appendChild(new Option(label, String(t.id)));
  }
  const wanted = tabs.some((t) => String(t.id) === keep)
    ? keep : String((tabs.find((t) => t.ready) || tabs.find((t) => t.active) || tabs[0]).id);
  el.targetTab.value = wanted;
}

async function typeIntoPage() {
  const plan = buildPlan();
  if (!plan) return;

  const tabId = Number(el.targetTab.value);
  if (!tabId) { setStatus("Pick a tab to type into.", "error"); return; }

  setStatus("Starting…");
  const reply = await browser.runtime.sendMessage({
    kind: "start", strokes: wireStrokes(plan), tabId, text: plan.sourceText,
  });
  if (reply && reply.ok) {
    setStatus(`Typing into ${reply.where}. It keeps going if you switch tabs.`);
  } else {
    setStatus((reply && reply.error) || "The page did not accept the text.", "error");
    if (reply && reply.needsTarget) refreshTargets();
  }
}

/* Job state is owned by the background and mirrored into storage, so the panel
   reports on runs it did not start — including ones begun from the popup. */
function showJob(job) {
  const live = Boolean(job && (job.status === "typing" || job.status === "paused"));
  const paused = Boolean(job && job.status === "paused");

  el.stopBtn.hidden = !live;
  el.pauseBtn.hidden = !live;
  el.pauseBtn.textContent = paused ? "Resume" : "Pause";
  el.typeBtn.disabled = live;
  el.progress.hidden = !live;
  el.progress.classList.toggle("is-paused", paused);

  if (!job) return;
  if (live && job.total) {
    const pct = Math.min(100, Math.round((job.typed / job.total) * 100));
    el.progressFill.style.width = `${pct}%`;
    el.progressPct.textContent = `${pct}%`;
  }

  if (job.status === "paused") {
    setStatus(`Paused at ${job.typed} of ${job.total}.`);
  } else if (job.status === "typing") {
    setStatus(`Typing into ${job.where || "the page"} — you can switch tabs.`);
  } else if (job.status === "done") {
    setStatus(`Finished — ${job.typed} characters.`, "ok");
  } else if (job.status === "stopped") {
    setStatus(job.collided
      ? `Stopped at ${job.typed} characters — you started typing on the page.`
      : `Stopped at ${job.typed} characters.`);
  } else if (job.status === "error") {
    setStatus(job.error || "Something went wrong.", "error");
  }
}

/* ─────────────────────────────────────────────────────── typing test ── */
const test = {
  passage: PASSAGES[Math.floor(Math.random() * PASSAGES.length)],
  prompt: PROMPTS[Math.floor(Math.random() * PROMPTS.length)],
  copyEvents: [], copyStart: null, copyDone: false,
  composeEvents: [], composeStart: null, composeWpm: null,
};

function renderPassage() {
  const typed = $("copy-input").value;
  const frag = document.createDocumentFragment();
  for (let i = 0; i < test.passage.length; i++) {
    const span = document.createElement("span");
    span.textContent = test.passage[i];
    if (i < typed.length) span.className = typed[i] === test.passage[i] ? "done" : "bad";
    else if (i === typed.length) span.className = "next";
    frag.appendChild(span);
  }
  const box = $("passage");
  box.textContent = "";
  box.appendChild(frag);
  $("copy-progress").style.width =
    `${Math.min(100, (typed.length / test.passage.length) * 100)}%`;
}

for (const id of ["copy-input", "compose-input"]) {
  $(id).addEventListener("paste", (event) => {
    // One timestamp for fifty characters would poison every timing measurement
    // in the profile, so pasting has to be refused rather than absorbed.
    event.preventDefault();
    const box = $(id === "copy-input" ? "copy-result" : "compose-result");
    box.className = "result is-error";
    box.textContent = "Pasting can't be measured — please type it.";
  });
}

$("copy-input").addEventListener("input", (event) => {
  if (test.copyDone) return;
  const now = performance.now();
  if (test.copyStart === null) test.copyStart = now;
  const value = event.target.value;
  const t = now - test.copyStart;

  if (event.inputType === "deleteContentBackward") {
    test.copyEvents.push({ char: BACKSPACE, tMs: t });
  } else if (event.data) {
    for (const ch of event.data) {
      const idx = value.length - 1;
      test.copyEvents.push({ char: ch, tMs: t, correct: ch === test.passage[idx] });
    }
  }
  renderPassage();

  if (value.length >= test.passage.length) {
    test.copyDone = true;
    event.target.disabled = true;
    finishCopy();
  }
});

async function finishCopy() {
  const result = $("copy-result");
  try {
    const fresh = analyseTranscription(test.copyEvents, test.passage);
    test.composeWpm = fresh.baseWpm;
    savedProfile = mergeProfile(savedProfile, fresh);
    await saveProfile(savedProfile);
    result.className = "result";
    result.textContent =
      `Measured ${Math.round(fresh.baseWpm)} wpm, ${(fresh.typoRate * 100).toFixed(1)}% mistakes, ` +
      `${Math.round(fresh.correctionRate * 100)}% of them caught. Now phase 2 below.`;
    refreshProfileSummary();
    refreshSavedSummary();
    $("compose-input").focus();
  } catch (err) {
    result.className = "result is-error";
    result.textContent = err.message;
  }
}

$("compose-input").addEventListener("input", (event) => {
  const now = performance.now();
  if (test.composeStart === null) test.composeStart = now;
  const t = now - test.composeStart;
  if (event.inputType === "deleteContentBackward") {
    test.composeEvents.push({ char: BACKSPACE, tMs: t });
  } else if (event.data) {
    for (const ch of event.data) test.composeEvents.push({ char: ch, tMs: t });
  } else if (event.inputType === "insertLineBreak") {
    test.composeEvents.push({ char: "\n", tMs: t });
  }
  const len = event.target.value.length;
  $("compose-count").textContent = `${len} / ${MIN_COMPOSE_CHARS} characters`;
  $("compose-done").disabled = len < MIN_COMPOSE_CHARS;
});

$("compose-done").addEventListener("click", async () => {
  const result = $("compose-result");
  try {
    const fresh = analyseComposition(test.composeEvents, test.composeWpm);
    savedProfile = mergeProfile(savedProfile, fresh);
    await saveProfile(savedProfile);
    result.className = "result";
    result.textContent =
      `You compose at ${Math.round(fresh.composeSpeedRatio * 100)}% of your copying speed, ` +
      `pausing at ${Math.round(fresh.composeWordPauseProb * 100)}% of word gaps. Profile saved.`;
    $("compose-done").disabled = true;
    $("compose-input").disabled = true;
    refreshProfileSummary();
    refreshSavedSummary();
  } catch (err) {
    result.className = "result is-error";
    result.textContent = err.message;
  }
});

function refreshSavedSummary() {
  const box = $("saved-summary");
  if (!isTrained(savedProfile)) {
    box.textContent = "Nothing trained yet.";
    return;
  }
  box.textContent =
    `${Math.round(savedProfile.baseWpm)} wpm copying · ` +
    `~${Math.round(savedProfile.baseWpm * savedProfile.composeSpeedRatio)} composing · ` +
    `${(savedProfile.typoRate * 100).toFixed(1)}% mistakes · ` +
    `${savedProfile.sampleCount} copy, ${savedProfile.composeSampleCount} compose sessions`;
}

$("reset-profile").addEventListener("click", async () => {
  await clearProfile();
  savedProfile = newProfile();
  refreshProfileSummary();
  refreshSavedSummary();
  $("copy-result").textContent = "";
  $("compose-result").textContent = "";
});

/* ───────────────────────────────────────────────────────── settings ── */
function readForm() {
  return {
    style: el.style.value, mode: el.mode.value,
    wpm: Number(el.wpm.value), typos: Number(el.typos.value),
    perfect: el.perfect.checked, breaks: Number(el.breaks.value) || 0,
    duration: el.duration.value, useProfile: el.useProfile.checked,
  };
}

function writeForm(next) {
  settings = next;
  if (STYLES[next.style]) el.style.value = next.style;
  el.mode.value = next.mode;
  el.wpm.value = String(next.wpm);
  el.typos.value = String(next.typos);
  el.breaks.value = String(next.breaks);
  el.duration.value = next.duration || "";
  el.perfect.checked = Boolean(next.perfect);
  el.useProfile.checked = Boolean(next.useProfile);
  el.styleBlurb.textContent = (STYLES[next.style] || {}).blurb || "";
  syncOutputs();
}

let settingsTimer = null;
function pushSettings() {
  settings = readForm();
  syncOutputs();
  refreshPlanLine();
  clearTimeout(settingsTimer);
  settingsTimer = setTimeout(() => saveSettings(settings), 250);
}

let draftTimer = null;
function pushDraft() {
  clearTimeout(draftTimer);
  // Planning long text is not free, and neither is writing it to storage.
  draftTimer = setTimeout(() => { refreshPlanLine(); saveDraft(el.text.value); }, 220);
}

/* ──────────────────────────────────────────────────────────── wiring ── */
el.style.addEventListener("change", () => { applyStyleDefaults(); pushSettings(); });
[el.mode, el.perfect, el.breaks, el.duration, el.useProfile].forEach((node) =>
  node.addEventListener("change", pushSettings));
[el.wpm, el.typos].forEach((node) => node.addEventListener("input", pushSettings));

el.text.addEventListener("input", pushDraft);

el.clear.addEventListener("click", () => {
  el.text.value = "";
  el.preview.textContent = "";
  refreshPlanLine();
  saveDraft("");
  el.text.focus();
});

el.previewBtn.addEventListener("click", () => {
  const plan = buildPlan();
  if (!plan) return;
  setStatus("");
  runPreview(plan);
});

el.typeBtn.addEventListener("click", typeIntoPage);

el.refreshTabs.addEventListener("click", async () => {
  if (el.refreshTabs.textContent === "Grant access") {
    // Must be called straight from the click: Firefox refuses a permission
    // request that is not attached to a user gesture.
    const granted = await browser.permissions.request(
      { permissions: ["tabs"], origins: ["<all_urls>"] });
    if (!granted) {
      setStatus("Left as it was. The toolbar button still types into the page " +
                "you are on.", "warn");
      return;
    }
    setStatus("");
  }
  refreshTargets();
});

el.pauseBtn.addEventListener("click", async () => {
  const resuming = el.pauseBtn.textContent === "Resume";
  const reply = await browser.runtime.sendMessage(
    { kind: resuming ? "resume" : "pause" });
  if (reply && !reply.ok) setStatus(reply.error || "Could not pause.", "error");
});
el.stopBtn.addEventListener("click", () => {
  previewStop = true;
  browser.runtime.sendMessage({ kind: "stop" }).catch(() => {});
  stopPreview();
  setStatus("Stopped.");
});

/* The popup writes to the same draft and settings; follow along rather than
   letting the two surfaces drift into two different answers. */
subscribe({
  draft: (text) => {
    if (text === el.text.value) return;
    el.text.value = text;
    refreshPlanLine();
  },
  settings: (next) => { writeForm(next); refreshPlanLine(); },
  job: showJob,
});

/* ───────────────────────────────────────────────────────────── start ── */
(async function init() {
  const [profile, loaded, draft, job] =
    await Promise.all([loadProfile(), loadSettings(), loadDraft(), loadJob()]);
  savedProfile = profile;
  writeForm(loaded);
  el.text.value = draft;

  refreshProfileSummary();
  refreshSavedSummary();
  refreshPlanLine();
  showJob(job);
  refreshTargets();

  $("prompt").textContent = test.prompt;
  $("test-profile").textContent = isTrained(savedProfile)
    ? "You already have a profile. Another session sharpens it."
    : "";
  renderPassage();
  el.text.focus();
})();
