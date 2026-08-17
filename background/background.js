/**
 * Coordinator. Tracks which frame holds the caret and the state of a run.
 */

const PANEL_URL = browser.runtime.getURL("panel/panel.html");
const JOB_KEY = "pacetyper.job";
const TARGET_TTL_MS = 10 * 60 * 1000;

/** tabId -> { frameId, where, at } : where the caret was last seen. */
const targets = new Map();

/* tabId -> Set of frame ids that have a content script in them. */
const frames = new Map();

function noteFrame(tabId, frameId) {
  let set = frames.get(tabId);
  if (!set) { set = new Set(); frames.set(tabId, set); }
  set.add(frameId);
}

let job = null;   // { id, tabId, frameId, typed, total, status, error }

/* ────────────────────────────────────────────────────────── job state ── */

/* Progress arrives faster than storage should be written. */
const WRITE_GAP_MS = 1000;
let flushTimer = null;
let lastWrite = 0;

async function flush() {
  clearTimeout(flushTimer);
  flushTimer = null;
  lastWrite = Date.now();
  if (!job) return;
  try { await browser.storage.local.set({ [JOB_KEY]: job }); } catch { /* closing */ }
}

async function publish(patch, { now = false } = {}) {
  job = job ? { ...job, ...patch } : patch;
  if (now || patch.status) return flush();
  const since = Date.now() - lastWrite;
  if (since >= WRITE_GAP_MS) return flush();
  if (!flushTimer) flushTimer = setTimeout(flush, WRITE_GAP_MS - since);
}

async function clearJob() {
  job = null;
  clearTimeout(flushTimer);
  flushTimer = null;
  try { await browser.storage.local.remove(JOB_KEY); } catch { /* closing */ }
}

/* A run only ends by finishing, being stopped, or failing — all of which rewrite the status. */
browser.runtime.onStartup.addListener(async () => {
  try {
    const stored = (await browser.storage.local.get(JOB_KEY))[JOB_KEY];
    if (stored && (stored.status === "typing" || stored.status === "paused")) {
      job = { ...stored, status: "interrupted" };
      await flush();
    }
  } catch { /* nothing recoverable */ }
});

/* ─────────────────────────────────────────────────────────── plumbing ── */

const BLOCKED = /^(about|moz-extension|chrome|resource|view-source|jar):/;

function blockedReason(tab) {
  if (!tab) return "No page to type into.";
  // Without the optional "tabs" permission a tab's URL is hidden. That is the
  // permission working as intended, not an error: the page is simply typed
  // into without being inspected first.
  if (!tab.url) return null;
  if (tab.url === PANEL_URL) return "That is the Pacetyper tab — pick the page you want typed into.";
  if (BLOCKED.test(tab.url)) return "Firefox blocks extensions on this page. Try an ordinary web page.";
  if (/^https:\/\/addons\.mozilla\.org/.test(tab.url)) return "Firefox blocks extensions on addons.mozilla.org.";
  return null;
}

async function ensureInjected(tabId) {
  // allFrames matters more than it looks: Google Docs, and most rich-text
  // editors, keep the element that actually receives text inside a child
  // frame. A top-frame-only script types into nothing.
  await browser.tabs.executeScript(tabId, {
    file: "/content/inject.js",
    allFrames: true,
    // Docs' text-event frame has no src of its own; without this it is skipped
    // and the one frame that can receive text never gets the script.
    matchAboutBlank: true,
    runAt: "document_end",
  });
}

function freshTarget(tabId) {
  const t = targets.get(tabId);
  if (!t) return null;
  if (Date.now() - t.at > TARGET_TTL_MS) { targets.delete(tabId); return null; }
  return t;
}

async function tell(tabId, message, frameId = 0) {
  try { return await browser.tabs.sendMessage(tabId, message, { frameId }); }
  catch { return null; }   // frame has no content script, or the tab went away
}

/* Work out which frame text should go into, by asking rather than remembering. */
async function resolveTarget(tabId) {
  const top = await tell(tabId, { kind: "ping" }, 0);
  if (top && top.active) return { frameId: 0, where: top.where, at: Date.now() };

  if (top && top.descends) {
    // Focus is inside a child. A frame cannot name its own id, but the
    // background sees it on every message a frame sends, so the set of frames
    // worth asking is already known.
    for (const frameId of frames.get(tabId) || []) {
      if (frameId === 0) continue;
      const reply = await tell(tabId, { kind: "ping" }, frameId);
      if (reply && reply.active) return { frameId, where: reply.where, at: Date.now() };
    }
  }

  // Nothing is focused anywhere. Fall back to the last editable a frame saw,
  // preferring whichever frame reported one most recently.
  const hint = freshTarget(tabId);
  if (hint) {
    const reply = await tell(tabId, { kind: "ping" }, hint.frameId);
    if (reply && reply.hasTarget) return { ...hint, where: reply.where, at: Date.now() };
  }
  if (top && top.hasTarget) return { frameId: 0, where: top.where, at: Date.now() };
  return null;
}

/* ────────────────────────────────────────────────────────────── start ── */

async function start({ strokes, tabId, text }) {
  if (job && (job.status === "typing" || job.status === "paused")) {
    return { ok: false, error: "A run is already going. Stop it first." };
  }

  let tab;
  if (tabId != null) {
    try { tab = await browser.tabs.get(tabId); } catch { tab = null; }
  } else {
    [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  }
  const blocked = blockedReason(tab);
  if (blocked) return { ok: false, error: blocked };

  try {
    await ensureInjected(tab.id);
  } catch (err) {
    return { ok: false, error: `Cannot reach that page: ${err.message}` };
  }

  const target = await resolveTarget(tab.id);
  if (!target) {
    await tell(tab.id, { kind: "pick" });
    await browser.tabs.update(tab.id, { active: true });
    return { ok: false, needsTarget: true,
             error: "Click the box you want typed into on that page, then start again." };
  }

  const id = String(Date.now());
  // The reply comes back as soon as typing is under way, not when it ends, so
  // this can be awaited: a run that is refused is reported as a refusal
  // instead of appearing to start and then quietly doing nothing.
  const reply = await tell(tab.id, { kind: "replay", strokes, jobId: id },
                           target.frameId);
  if (!reply || !reply.ok) {
    if (reply && reply.needsTarget) await tell(tab.id, { kind: "pick" });
    return {
      ok: false,
      needsTarget: Boolean(reply && reply.needsTarget),
      error: (reply && reply.error) || "That page did not respond.",
    };
  }

  /* The source is kept with the run so an interrupted one can be picked up
     again. The draft is stored separately and the user is free to edit it in
     the meantime, which would make it the wrong thing to resume from. */
  await publish({ id, tabId: tab.id, frameId: target.frameId,
                  where: reply.where || target.where, text: text || "",
                  typed: 0, total: 0, net: 0, status: "typing", error: null });
  return { ok: true, jobId: id, where: reply.where || target.where, tabId: tab.id };
}

async function stop() {
  if (job) {
    await tell(job.tabId, { kind: "cancel" }, job.frameId);
    await publish({ status: "stopped" });
  }
  return { ok: true };
}

async function setPaused(wantPaused) {
  if (!job || (job.status !== "typing" && job.status !== "paused")) {
    return { ok: false, error: "Nothing is running." };
  }
  const reply = await tell(job.tabId, { kind: wantPaused ? "pause" : "resume" },
                           job.frameId);
  if (!reply) return { ok: false, error: "That page stopped responding." };
  await publish({ status: reply.paused ? "paused" : "typing" });
  return { ok: true, paused: reply.paused };
}

/* ───────────────────────────────────────────────────────────── routing ── */

async function openPanel() {
  // Finding an already-open panel needs the "tabs" permission, which is
  // optional. Without it, opening a second one is a far better outcome than
  // demanding a permission just to avoid a duplicate tab.
  try {
    const existing = await browser.tabs.query({ url: PANEL_URL });
    if (existing.length) {
      await browser.tabs.update(existing[0].id, { active: true });
      await browser.windows.update(existing[0].windowId, { focused: true });
      return existing[0];
    }
  } catch { /* no tabs permission */ }
  return browser.tabs.create({ url: PANEL_URL });
}

browser.runtime.onMessage.addListener((message, sender) => {
  switch (message.kind) {

    /* ---- from the page ------------------------------------------------ */
    case "editable-focused":
    case "target-picked":
      if (sender.tab) {
        noteFrame(sender.tab.id, sender.frameId || 0);
        targets.set(sender.tab.id,
                    { frameId: sender.frameId || 0, where: message.where, at: Date.now() });
      }
      return Promise.resolve({ ok: true });

    case "frame-ready":
      if (sender.tab) {
        noteFrame(sender.tab.id, sender.frameId || 0);
        if (message.hasTarget && !freshTarget(sender.tab.id)) {
          targets.set(sender.tab.id,
                      { frameId: sender.frameId || 0, where: message.where, at: Date.now() });
        }
      }
      return Promise.resolve({ ok: true });

    case "progress":
      if (job && job.id === message.jobId) {
        publish({ typed: message.typed, total: message.total, net: message.net });
      }
      return Promise.resolve({ ok: true });

    case "finished":
      if (job && job.id === message.jobId) {
        if (message.ok) {
          publish({ status: message.cancelled ? "stopped" : "done",
                    collided: Boolean(message.collided),
                    typed: message.typed ?? job.typed,
                    net: message.net ?? job.net });
        } else {
          publish({ status: "error", error: message.error,
                    typed: message.typed ?? job.typed, net: message.net ?? job.net });
        }
      }
      return Promise.resolve({ ok: true });

    case "overlay":
      // Typing often happens in a child frame with no visible area of its own,
      // so the chip is always drawn by the top frame.
      if (sender.tab) {
        tell(sender.tab.id, { kind: "show", text: message.text, options: message.options });
      }
      return Promise.resolve({ ok: true });

    case "cancel-request":
      return stop();

    case "tick-request": {
      /* A clock for pages that block workers. This page is an extension page:
         the site's content policy does not apply to it, and it is not a tab,
         so the throttling that stops a hidden tab's timers does not either. */
      if (sender.tab) {
        const { id } = sender.tab;
        const frameId = sender.frameId || 0;
        setTimeout(() => {
          browser.tabs.sendMessage(id, { kind: "tick", id: message.id }, { frameId })
            .catch(() => {});
        }, Math.max(0, message.ms));
      }
      return Promise.resolve({ ok: true });
    }

    /* ---- from the popup and the panel --------------------------------- */
    case "start":       return start(message);
    case "stop":        return stop();
    case "pause":       return setPaused(true);
    case "resume":      return setPaused(false);
    case "job":         return Promise.resolve({ ok: true, job });
    // An interrupted run has been dealt with, one way or the other.
    case "forget":      return clearJob().then(() => ({ ok: true }));
    case "open-panel":  return openPanel().then(() => ({ ok: true }));

    case "probe": {
      // "Where would text go if I pressed start right now?"
      const probe = async () => {
        const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
        const blocked = blockedReason(tab);
        if (blocked) return { ok: false, error: blocked, tab: tab && tab.title };
        try { await ensureInjected(tab.id); } catch (err) {
          return { ok: false, error: `Cannot reach that page: ${err.message}` };
        }
        const target = await resolveTarget(tab.id);
        return { ok: true, tabId: tab.id, title: tab.title, url: tab.url,
                 where: target && target.where, hasTarget: Boolean(target) };
      };
      return probe();
    }

    case "aim": {
      // Put the page into click-to-choose mode from the popup.
      const aim = async () => {
        const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
        const blocked = blockedReason(tab);
        if (blocked) return { ok: false, error: blocked };
        try { await ensureInjected(tab.id); } catch (err) {
          return { ok: false, error: err.message };
        }
        await tell(tab.id, { kind: "pick" });
        return { ok: true };
      };
      return aim();
    }

    case "targets": {
      // Tabs the panel can offer as a destination. Listing other tabs is the
      // one thing here that genuinely needs broad access, so it is optional
      // and the panel explains what it is for before asking.
      const list = async () => {
        const granted = await browser.permissions.contains(
          { permissions: ["tabs"], origins: ["<all_urls>"] });
        if (!granted) return { ok: false, needsPermission: true, tabs: [] };
        const tabs = await browser.tabs.query({});
        return {
          ok: true,
          tabs: tabs
            .filter((t) => !blockedReason(t))
            .map((t) => ({ id: t.id, title: t.title || t.url, url: t.url,
                           active: t.active, windowId: t.windowId,
                           ready: Boolean(freshTarget(t.id)) })),
        };
      };
      return list();
    }

    default:
      return undefined;
  }
});

/* Once typing carries on in a tab you are not looking at, you need a way to
   stop it without going to find that tab first. */
browser.commands.onCommand.addListener((name) => {
  if (name === "stop-typing") stop();
});

/* A tab that navigated away has lost whatever we knew about it. */
browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") { targets.delete(tabId); frames.delete(tabId); }
});
browser.tabs.onRemoved.addListener((tabId) => {
  targets.delete(tabId);
  frames.delete(tabId);
  if (job && job.tabId === tabId && job.status === "typing") {
    publish({ status: "error", error: "The target tab was closed." });
  }
});

// A stale job from a previous browser session helps nobody.
clearJob();
