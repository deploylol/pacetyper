/* Runs on the page: finds the box, replays the plan, shows progress. */

(() => {
  if (window.__pacetyperReady) return;
  window.__pacetyperReady = true;

  const TOP = window.top === window;
  let target = null;         // last editable that held focus in this frame
  let cancelled = false;
  let running = false;
  let paused = false;
  let unpick = null;         // teardown for pick mode, null when not picking
  let overlay = null;
  let relayTick = null;   // set while a relay clock is in use

  const send = (message) => {
    try { browser.runtime.sendMessage(message).catch(() => {}); }
    catch { /* extension torn down mid-run */ }
  };

  /* A wait that overruns by more than this was not a wait: the machine slept,
     or the tab was throttled past what the clock can absorb. A hidden tab's
     coarsest timer is about a second, so the threshold sits well clear of it. */
  const SLEEP_GAP_MS = 4000;

  /* ─────────────────────────────────────────────────────────── targets ── */

  const TEXT_INPUT = /^(text|search|url|email|tel|password|number|)$/i;

  const isTextControl = (node) =>
    node instanceof HTMLTextAreaElement ||
    (node instanceof HTMLInputElement && TEXT_INPUT.test(node.type || ""));

  function isEditable(node) {
    if (!node || node.nodeType !== 1) return false;
    if (node.disabled || node.readOnly) return false;
    return isTextControl(node) || node.isContentEditable === true;
  }

  /** How many more characters this box will take, or null if it is uncapped. */
  function capacityOf(node) {
    if (!isTextControl(node)) return null;      // contenteditable has no cap
    const max = node.maxLength;
    if (typeof max !== "number" || max < 0) return null;
    return Math.max(0, max - (node.value ? node.value.length : 0));
  }

  function describe(node) {
    if (!node) return null;
    if (node instanceof HTMLTextAreaElement) return "a text area";
    if (node instanceof HTMLInputElement) return "a text field";
    const label = node.getAttribute("aria-label");
    return label ? `an editable area (${label})` : "an editable area";
  }

  function noteFocus(node) {
    if (!isEditable(node)) return;
    target = node;
    // The background keeps one address for the whole tab. Reporting every
    // focus is what lets the popup type into the box the user clicked before
    // they opened it, instead of guessing at replay time.
    send({ kind: "editable-focused", where: describe(node) });
  }

  document.addEventListener("focusin", (e) => noteFocus(e.target), true);
  // Some editors move focus in ways that produce no focusin we can see; a
  // click landing inside an editable is just as good a signal.
  document.addEventListener("mousedown", (e) => {
    const el = e.target && e.target.closest &&
      e.target.closest("textarea, input, [contenteditable]");
    if (isEditable(el)) noteFocus(el);
  }, true);

  // Injection normally happens while the user is still looking at the page
  // they just clicked into, so whatever holds focus now is the best guess.
  if (isEditable(document.activeElement)) noteFocus(document.activeElement);

  /* The element Google Docs actually reads keystrokes from. */
  function canvasTarget() {
    const direct = document.querySelector(
      "textarea.docs-texteventtarget, .docs-texteventtarget");
    if (direct && direct.isConnected) return direct;
    const frame = document.querySelector(".docs-texteventtarget-iframe");
    const body = frame && frame.contentDocument && frame.contentDocument.body;
    return body && body.isConnected ? body : null;
  }

  /* activeElement is the truth; the remembered box is only a fallback. */
  function currentTarget() {
    // The editor frame drives canvas editors, never the buffer frame itself.
    // Docs discards and rebuilds that frame while typing, taking the content
    // script inside it with it; the outer frame survives and can simply look
    // the buffer up again.
    if (!inCanvasBuffer() && isCanvasEditor()) {
      const buffer = canvasTarget();
      if (buffer) { target = buffer; return buffer; }
    }
    const active = document.activeElement;
    if (isEditable(active)) { target = active; return active; }
    // Focus can be genuinely lost — the user clicked the toolbar button, or
    // the page moved focus to a button. The last editable is the best guess.
    if (target && target.isConnected && isEditable(target)) return target;
    target = null;
    return null;
  }

  /** Does focus sit inside a child frame rather than in this document? */
  const focusDescends = () => {
    const a = document.activeElement;
    return Boolean(a && (a.tagName === "IFRAME" || a.tagName === "FRAME"));
  };

  /* ──────────────────────────────────────────────────────── insertion ── */

  /* Four ways to insert a character. The first that works is kept. */

  function ensureCaretIn(el) {
    const doc = el.ownerDocument, win = doc.defaultView;
    if (isTextControl(el)) return;              // focus alone gives these a caret
    const sel = win.getSelection();
    if (sel && sel.rangeCount && el.contains(sel.anchorNode)) return;
    const range = doc.createRange();
    range.selectNodeContents(el);
    range.collapse(false);                      // to the end of what is there
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function focusTarget(el) {
    const win = el.ownerDocument.defaultView;
    if (win !== window) { try { win.focus(); } catch { /* cross-origin */ } }
    if (el.ownerDocument.activeElement !== el) {
      try { el.focus({ preventScroll: true }); } catch { /* designMode body */ }
    }
    ensureCaretIn(el);
  }

  /* ---- realm-correct synthetic events ---------------------------------- */

  /* Events must be built with the target frame's own constructors. */
  function fire(el, Ctor, type, init) {
    const win = el.ownerDocument.defaultView;

    // Best: the page's own constructor, reached past the Xray wrapper. The
    // init dictionary has to be cloned into that realm too, or the constructor
    // sees an object it is not allowed to read. `view` is attached after the
    // clone because a Window cannot be cloned across realms — and it has to be
    // set at all, because a real key event names the window it happened in and
    // an event built without it reports `view` as null.
    try {
      const raw = win && win.wrappedJSObject;
      if (raw && raw[Ctor]) {
        const payload = typeof cloneInto === "function"
          ? cloneInto(init, raw) : { ...init };
        try { payload.view = raw; } catch { /* not settable; carry on */ }
        el.dispatchEvent(new raw[Ctor](type, payload));
        return true;
      }
    } catch { /* no Xray access here */ }

    // Next best: the frame's constructor as this script sees it.
    try {
      if (win && win[Ctor]) {
        el.dispatchEvent(new win[Ctor](type, { ...init, view: win }));
        return true;
      }
    } catch { /* fall through */ }

    try {
      const C = Ctor === "KeyboardEvent" ? KeyboardEvent : InputEvent;
      el.dispatchEvent(new C(type, init));
      return true;
    } catch { return false; }
  }

  const CODES = {
    " ": ["Space", 32], "\n": ["Enter", 13], ".": ["Period", 190],
    ",": ["Comma", 188], ";": ["Semicolon", 186], "'": ["Quote", 222],
    "-": ["Minus", 189], "=": ["Equal", 187], "/": ["Slash", 191],
    "\\": ["Backslash", 220], "[": ["BracketLeft", 219], "]": ["BracketRight", 221],
    "`": ["Backquote", 192],
  };

  /** Key identity for one character, as a real keyboard would report it. */
  function keyInit(ch) {
    if (CODES[ch]) {
      const [code, keyCode] = CODES[ch];
      return { key: ch === "\n" ? "Enter" : ch, code, keyCode,
               charCode: ch.charCodeAt(0), shiftKey: false };
    }
    const upper = ch.toUpperCase();
    if (upper >= "A" && upper <= "Z") {
      return { key: ch, code: `Key${upper}`, keyCode: upper.charCodeAt(0),
               charCode: ch.charCodeAt(0), shiftKey: ch !== ch.toLowerCase() };
    }
    if (ch >= "0" && ch <= "9") {
      return { key: ch, code: `Digit${ch}`, keyCode: ch.charCodeAt(0),
               charCode: ch.charCodeAt(0), shiftKey: false };
    }
    return { key: ch, code: "", keyCode: ch.charCodeAt(0),
             charCode: ch.charCodeAt(0), shiftKey: /[A-Z!@#$%^&*()_+{}|:"<>?~]/.test(ch) };
  }

  /**
   * Send one character as a full key sequence.
   *
   * `keypress` goes only to printable keys. Sending it for Backspace, Tab or
   * an arrow makes Docs insert that key's ASCII value as literal text, which
   * corrupts the document in a way that is hard to trace back to here.
   */
  function sendKeys(el, ch, inputType, data) {
    const init = ch === null ? { key: "Backspace", code: "Backspace", keyCode: 8,
                                 charCode: 8, shiftKey: false } : keyInit(ch);
    const common = { ...init, which: init.keyCode, bubbles: true,
                     cancelable: true, composed: true, repeat: false };
    fire(el, "KeyboardEvent", "keydown", common);
    if (init.key.length === 1) fire(el, "KeyboardEvent", "keypress", common);
    if (inputType) {
      const payload = { data, inputType, bubbles: true, cancelable: true, composed: true };
      fire(el, "InputEvent", "beforeinput", payload);
      fire(el, "InputEvent", "input", { ...payload, cancelable: false });
    }
    fire(el, "KeyboardEvent", "keyup", { ...common, cancelable: false });
  }

  /* ---- the four strategies -------------------------------------------- */

  function nativeSet(el, next, caret) {
    const proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, next);
    try { el.setSelectionRange(caret, caret); } catch { /* number inputs */ }
  }

  const STRATEGIES = {
    keys: {
      insert(el, text) { sendKeys(el, text, "insertText", text); return true; },
      remove(el) { sendKeys(el, null, "deleteContentBackward", null); return true; },
    },
    exec: {
      insert(el, text) {
        focusTarget(el);
        return el.ownerDocument.execCommand("insertText", false, text);
      },
      remove(el) {
        focusTarget(el);
        return el.ownerDocument.execCommand("delete", false, null);
      },
    },
    native: {
      insert(el, text) {
        if (!("value" in el)) return false;
        const start = el.selectionStart ?? el.value.length;
        const end = el.selectionEnd ?? start;
        nativeSet(el, el.value.slice(0, start) + text + el.value.slice(end),
                  start + text.length);
        fire(el, "InputEvent", "input",
             { bubbles: true, data: text, inputType: "insertText" });
        return true;
      },
      remove(el) {
        if (!("value" in el)) return false;
        const start = el.selectionStart ?? el.value.length;
        if (start <= 0) return true;
        nativeSet(el, el.value.slice(0, start - 1) + el.value.slice(start), start - 1);
        fire(el, "InputEvent", "input",
             { bubbles: true, inputType: "deleteContentBackward" });
        return true;
      },
    },
    range: {
      insert(el, text) {
        if (!el.isContentEditable) return false;
        const doc = el.ownerDocument, win = doc.defaultView;
        focusTarget(el);
        const sel = win.getSelection();
        if (!sel || !sel.rangeCount) return false;
        const range = sel.getRangeAt(0);
        range.deleteContents();
        const node = doc.createTextNode(text);
        range.insertNode(node);
        range.setStartAfter(node);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
        fire(el, "InputEvent", "input",
             { bubbles: true, data: text, inputType: "insertText" });
        return true;
      },
      remove(el) {
        if (!el.isContentEditable) return false;
        const win = el.ownerDocument.defaultView;
        const sel = win.getSelection();
        if (!sel || !sel.rangeCount) return false;
        const range = sel.getRangeAt(0);
        if (range.startContainer.nodeType === 3 && range.startOffset > 0) {
          range.setStart(range.startContainer, range.startOffset - 1);
          range.deleteContents();
          fire(el, "InputEvent", "input",
               { bubbles: true, inputType: "deleteContentBackward" });
          return true;
        }
        return false;
      },
    },
  };

  function strategyOrder(el) {
    if (isTextControl(el)) return ["exec", "native", "keys"];
    return ["exec", "range", "keys"];
  }

  /* ---- canvas editors ---------------------------------------------------
   *
   * Google Docs ships different editor builds to different users and each one
   * honours a different subset of synthetic events, so there is no single
   * method that works and no return value worth believing: execCommand reports
   * false on a build that applied the text anyway, and dispatchEvent reports
   * that an event was sent, never that anything came of it. The hidden buffer
   * cannot be read back either — it holds placeholder characters and is
   * cleared after every keystroke.
   *
   * The caret is the way out. It is an ordinary DOM element, and it moves only
   * when the editor actually applies an edit. So each method is tried
   * speculatively and kept only if the caret advanced.
   */

  const LOCAL_CARET = "docs-text-ui-cursor-blink";

  function caretSignature() {
    let sig = "";
    for (const caret of document.querySelectorAll(".kix-cursor")) {
      // Only the local caret blinks. In a shared document a collaborator's
      // caret moves on its own and would read as proof of our own edit.
      if (!caret.classList.contains(LOCAL_CARET)) continue;
      sig += `${getComputedStyle(caret).transform}|`;
    }
    return sig;
  }

  const caretObservable = () =>
    Boolean(document.querySelector(`.kix-cursor.${LOCAL_CARET}`));

  /**
   * Wait for the caret to move, briefly.
   *
   * The synchronous first look matters: the beforeinput path moves the caret
   * before dispatch returns, so the common case never waits at all. Timers
   * rather than animation frames, because a backgrounded tab gets no frames
   * and typing is expected to continue there.
   */
  async function caretMoved(before, timeoutMs = 400) {
    if (caretSignature() !== before) return true;
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) {
      await sleep(16);
      if (caretSignature() !== before) return true;
    }
    return false;
  }

  /** The candidate buffers, best first. Builds differ in which one exists. */
  function canvasTargets() {
    const out = [];
    const frame = document.querySelector(".docs-texteventtarget-iframe");
    const doc = frame && frame.contentDocument;
    if (doc) {
      const editable = doc.querySelector("[contenteditable=true]");
      if (editable) out.push(editable);
      if (doc.body) out.push(doc.body);
    }
    const direct = document.querySelector(
      "textarea.docs-texteventtarget, .docs-texteventtarget");
    if (direct) out.push(direct);
    return out.filter((el) => el && el.isConnected);
  }

  function dispatchPaste(el, text, bubbles) {
    const win = el.ownerDocument.defaultView;
    const raw = (win && win.wrappedJSObject) || win || window;
    const DT = raw.DataTransfer || DataTransfer;
    const CE = raw.ClipboardEvent || ClipboardEvent;
    const data = new DT();
    data.setData("text/plain", text);
    // A DataTransfer cannot be cloned into another realm, so the init object
    // goes across as-is and the attempt is simply allowed to fail.
    el.dispatchEvent(new CE("paste", { clipboardData: data, bubbles,
                                       cancelable: true }));
    return true;
  }

  const CANVAS_INSERT = [
    // Applied synchronously on the builds that take it, and the only method
    // that handles a lone space.
    { label: "beforeinput", apply: (el, text) => {
        focusTarget(el);
        fire(el, "InputEvent", "beforeinput",
             { data: text, inputType: "insertText", bubbles: true,
               cancelable: true, composed: true });
        fire(el, "InputEvent", "input",
             { data: text, inputType: "insertText", bubbles: true, composed: true });
      } },
    // Builds that ignore beforeinput run a legacy keyCode pipeline instead.
    { label: "keys", apply: (el, text) => { focusTarget(el); sendKeys(el, text, null); } },
    { label: "paste", apply: (el, text) => dispatchPaste(el, text, false) },
    { label: "paste-bubbling", apply: (el, text) => dispatchPaste(el, text, true) },
    { label: "exec", apply: (el, text) => {
        focusTarget(el);
        el.ownerDocument.execCommand("insertText", false, text);
      } },
  ];

  /* Deleting is a separate capability from inserting: a build can take our
     text through beforeinput and still ignore a beforeinput delete, so a run
     can type happily and then fail on its first correction. */
  const CANVAS_DELETE = [
    { label: "backspace-key", apply: (el) => {
        focusTarget(el);
        sendKeys(el, null, "deleteContentBackward");
      } },
    { label: "exec-delete", apply: (el) => {
        focusTarget(el);
        el.ownerDocument.execCommand("delete", false, null);
      } },
  ];

  async function deliverCanvas(op, text, state) {
    const methods = op === "insert" ? CANVAS_INSERT : CANVAS_DELETE;
    const key = op === "insert" ? "method" : "deleteMethod";
    const targets = canvasTargets();
    if (!targets.length) {
      state.reason = "the editor's input frame is not there";
      return false;
    }
    // Without a caret there is nothing to verify against, so the first method
    // that does not throw has to be taken on trust.
    const canVerify = caretObservable();
    const ordered = state[key]
      ? [...methods].sort((a, b) => (b.label === state[key]) - (a.label === state[key]))
      : methods;

    for (const el of targets) {
      for (const method of ordered) {
        const before = caretSignature();
        try { method.apply(el, text); }
        catch (err) { state.reason = err.message; continue; }
        if (!canVerify || await caretMoved(before)) {
          state[key] = method.label;
          return true;
        }
      }
    }
    state.reason = "the editor rejected every way of sending text";
    return false;
  }

  const DOC_HOST = /(^|\.)docs\.google\.com$/;

  /** Is this frame the hidden input buffer rather than the editor proper? */
  function inCanvasBuffer() {
    try {
      const frame = window.frameElement;
      return Boolean(frame && /docs-texteventtarget/.test(frame.className || ""));
    } catch {
      return false;      // cross-origin parent: not the buffer we care about
    }
  }

  /** Is the page an editor that renders to a canvas and has no editable DOM? */
  function isCanvasEditor() {
    try {
      if (DOC_HOST.test(window.top.location.hostname)) return true;
    } catch { /* cross-origin top */ }
    if (DOC_HOST.test(location.hostname)) return true;
    return Boolean(document.querySelector(
      ".kix-appview-editor, .docs-texteventtarget-iframe")) || inCanvasBuffer();
  }

  /* ────────────────────────────────────────────────────────── overlay ── */

  /* The chip's stylesheet, kept as text so it can be installed either way. */
  const CHIP_CSS = `
        :host { all: initial; }
        .chip {
          display: flex; align-items: center; gap: 10px;
          font: 500 13px/1.35 system-ui, -apple-system, "Segoe UI", sans-serif;
          background: #12161c; color: #e8edf4;
          border: 1px solid #2b3542; border-radius: 10px;
          padding: 9px 11px 9px 13px; box-shadow: 0 4px 14px rgba(0,0,0,.28);
          max-width: 340px;
        }
        .dot { width: 7px; height: 7px; border-radius: 50%;
               background: #4c9df0; flex: none; }
        .chip.is-done .dot { background: #3fb27f; }
        .chip.is-paused .dot { background: #d8a33a; }
        .chip.is-warn .dot { background: #d8a33a; }
        .chip.is-error .dot { background: #e5675f; }
        .msg { flex: 1; min-width: 0; }
        .bar { display: block; height: 3px; background: #2b3542;
               border-radius: 2px; margin-top: 6px; overflow: hidden; }
        .bar i { display: block; height: 100%; width: 0;
                 background: #4c9df0; transition: width .12s linear; }
        button { font: 600 12px system-ui, sans-serif; color: #e8edf4;
                 background: #2b3542; border: 0; border-radius: 6px;
                 padding: 5px 9px; cursor: pointer; flex: none; }
        button:hover { background: #3a4655; }
        @media (prefers-reduced-motion: reduce) { .bar i { transition: none; } }
  `;

  /* A status chip on the page itself. The old build reported progress only in
     the extension's own tab — the one place the user cannot be looking while
     the typing happens. Shadow DOM so page styles cannot reach it. */
  function ensureOverlay() {
    if (overlay && overlay.host.isConnected) return overlay;

    const host = document.createElement("div");
    host.id = "pacetyper-overlay";
    host.style.cssText =
      "all:initial;position:fixed;z-index:2147483647;right:16px;bottom:16px;";
    const root = host.attachShadow({ mode: "closed" });

    /* Page style-src can block a shadow-root <style>, so use a sheet object. */
    let styled = false;
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(CHIP_CSS);
      root.adoptedStyleSheets = [sheet];
      styled = true;
    } catch { /* older Firefox: fall back below */ }

    root.innerHTML =
      (styled ? "" : `<style>${CHIP_CSS}</style>`) + `
      <div class="chip">
        <span class="dot"></span>
        <span class="msg"><span class="text"></span><span class="bar"><i></i></span></span>
        <button type="button">Stop</button>
      </div>`;
    (document.body || document.documentElement).appendChild(host);
    root.querySelector("button").addEventListener("click", () => {
      cancelled = true;
      send({ kind: "cancel-request" });
    });
    overlay = {
      host,
      chip: root.querySelector(".chip"),
      text: root.querySelector(".text"),
      bar: root.querySelector(".bar i"),
      barWrap: root.querySelector(".bar"),
      button: root.querySelector("button"),
    };
    return overlay;
  }

  let hideTimer = null;
  function showOverlay(message, { progress = null, kind = "", stop = true,
                                  hideAfter = 0 } = {}) {
    const o = ensureOverlay();
    o.text.textContent = message;
    o.chip.className = "chip" + (kind ? ` is-${kind}` : "");
    o.barWrap.style.display = progress === null ? "none" : "";
    if (progress !== null) o.bar.style.width = `${Math.round(progress * 100)}%`;
    o.button.style.display = stop ? "" : "none";
    clearTimeout(hideTimer);
    if (hideAfter) hideTimer = setTimeout(hideOverlay, hideAfter);
  }

  function hideOverlay() {
    clearTimeout(hideTimer);
    if (overlay) { overlay.host.remove(); overlay = null; }
  }

  /* Progress is drawn by the top frame, but typing often happens in a child
     frame that has no visible area of its own. Route it through the
     background, which addresses the chip to frame 0. */
  const report = (text, options) =>
    send({ kind: "overlay", text, options: options || {} });

  /* ───────────────────────────────────────────────────── pick a target ── */

  /* When nothing is focused the old build gave up with an error in a tab the
     user had already left. Letting them point at the box turns a dead end
     into one click. */
  function startPicking() {
    if (unpick) return;
    showOverlay("Click the box you want typed into.", { stop: true });

    const onDown = (e) => {
      const el = e.target && e.target.closest &&
        e.target.closest("textarea, input, [contenteditable]");
      if (!isEditable(el)) return;
      e.preventDefault();
      e.stopPropagation();
      stopPicking();
      target = el;
      el.focus();
      send({ kind: "editable-focused", where: describe(el) });
      send({ kind: "target-picked", where: describe(el) });
      showOverlay(`Ready — ${describe(el)}. Press Start again.`,
                  { kind: "done", stop: false, hideAfter: 4000 });
    };
    document.addEventListener("mousedown", onDown, true);
    unpick = () => document.removeEventListener("mousedown", onDown, true);
  }

  function stopPicking() {
    if (unpick) unpick();
    unpick = null;
  }

  /* ─────────────────────────────────────────────────────────── replay ── */

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* A clock that keeps running when the tab is in the background. */
  function workerClock() {
    let worker;
    try {
      const src =
        "self.onmessage=(e)=>{const{id,ms}=e.data;" +
        "setTimeout(()=>self.postMessage(id),ms>0?ms:0)}";
      const url = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
      worker = new Worker(url);
      URL.revokeObjectURL(url);
    } catch {
      return null;
    }

    const pending = new Map();
    let alive = true;
    let seq = 0;

    worker.onmessage = (e) => {
      const done = pending.get(e.data);
      if (done) done();
    };
    // A page whose policy forbids blob: scripts lets the Worker object be
    // constructed and then blocks the script from loading — asynchronously.
    // Without this the clock simply never ticks again.
    worker.onerror = () => { alive = false; };

    return {
      get alive() { return alive; },
      wait(ms) {
        return new Promise((resolve) => {
          const id = ++seq;
          let settled = false;
          const finish = () => {
            if (settled) return;
            settled = true;
            pending.delete(id);
            resolve();
          };
          pending.set(id, finish);
          worker.postMessage({ id, ms });
          // Belt and braces: a silently dead worker must never stall a run.
          setTimeout(() => { if (!settled) { alive = false; finish(); } },
                     ms + 1500);
        });
      },
      close() { try { worker.terminate(); } catch { /* already gone */ } },
    };
  }

  /* The background page is not a tab, so tab throttling misses it. */
  function relayClock() {
    let seq = 0;
    const pending = new Map();
    relayTick = (id) => {
      const done = pending.get(id);
      if (done) { pending.delete(id); done(); }
    };
    return {
      alive: true,
      wait(ms) {
        return new Promise((resolve) => {
          const id = ++seq;
          pending.set(id, resolve);
          send({ kind: "tick-request", id, ms });
          setTimeout(() => {
            if (pending.delete(id)) resolve();
          }, ms + 2000);
        });
      },
      close() { relayTick = null; pending.clear(); },
    };
  }

  /* Pick a clock that keeps running when the tab is hidden, best first. */
  async function makeClock() {
    for (const [kind, build] of [["worker", workerClock], ["relay", relayClock]]) {
      const clock = build();
      if (!clock) continue;
      const answered = await Promise.race([
        clock.wait(0).then(() => true),
        sleep(600).then(() => false),
      ]);
      if (answered && clock.alive !== false) return { ...clock, kind };
      clock.close();
    }
    // Page timers. Typing works, but slows to a crawl if the tab is hidden.
    return { kind: "page", alive: true, wait: sleep, close() {} };
  }

  /* Accept a plan and start typing, replying as soon as it is under way. */
  async function beginReplay(strokes, jobId) {
    // A stop only sets a flag; the loop notices it at its next keystroke. A
    // run started immediately after one was stopped would otherwise arrive
    // while the old loop is still unwinding and be refused as a duplicate —
    // silently typing nothing. Wait for the old one to let go instead.
    if (running) {
      cancelled = true;
      for (let i = 0; i < 40 && running; i++) await sleep(25);
      if (running) return { ok: false, error: "Still finishing the last run." };
    }

    const el = currentTarget();
    if (!el) {
      return { ok: false, needsTarget: true,
               error: "No text box is focused on this page." };
    }

    /* A capped box accepts characters until it is full and then silently drops
       the rest, so a run that ignores the cap reports success over a truncated
       document. Refuse up front, where it can still be acted on. */
    const cap = capacityOf(el);
    if (cap !== null) {
      const needed = strokes.reduce(
        (n, s) => n + (s.action === "backspace" ? -1 : (s.text ? 1 : 0)), 0);
      if (needed > cap) {
        return { ok: false, error:
          `This box holds ${cap} more character${cap === 1 ? "" : "s"}, and the ` +
          `text needs ${needed}. Shorten it, or clear the box first.` };
      }
    }

    running = true;
    cancelled = false;
    stopPicking();
    runLoop(strokes, jobId)
      .then((result) => send({ kind: "finished", jobId, ...result }))
      // Without this an unexpected throw leaves the run looking like it is
      // still going, forever: the loop is deliberately not awaited, so a
      // rejection here has nowhere else to surface.
      .catch((err) => {
        running = false;
        paused = false;
        send({ kind: "finished", jobId, ok: false,
               error: `Typing stopped unexpectedly: ${err && err.message}` });
      });
    return { ok: true, where: describe(el) };
  }

  /* Put one character in, changing strategy if the current one stops working. */
  async function deliver(op, text, state) {
    if (!inCanvasBuffer() && isCanvasEditor()) {
      return deliverCanvas(op, text, state);
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      const el = currentTarget();
      if (!el) { state.reason = "the text box went away"; continue; }

      const order = state.method
        ? [state.method, ...strategyOrder(el).filter((m) => m !== state.method)]
        : strategyOrder(el);

      for (const method of order) {
        const strategy = STRATEGIES[method];
        let worked = false;
        try {
          worked = op === "insert" ? strategy.insert(el, text) : strategy.remove(el);
        } catch (err) {
          state.reason = err.message;
          continue;
        }
        if (worked) {
          if (state.method !== method) state.method = method;
          return true;
        }
      }
      // Everything failed against this element. Drop it and resolve again —
      // on the retry `currentTarget` re-reads activeElement and, on Docs,
      // re-finds the input frame.
      target = null;
      state.reason = state.reason || "the page refused every insertion method";
    }
    return false;
  }

  async function runLoop(strokes, jobId) {
    let collided = false;

    /* Two writers in one box produce text neither of them meant. */
    const onKey = (e) => {
      if (e.key === "Escape") { cancelled = true; return; }
      if (!e.isTrusted || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key.length === 1 || e.key === "Backspace" || e.key === "Enter") {
        collided = true;
        cancelled = true;
      }
    };
    document.addEventListener("keydown", onKey, true);

    const total = strokes.reduce(
      (n, s) => n + (!s.isBreak && s.action !== "backspace" && s.text ? 1 : 0), 0);
    const clock = await makeClock();
    const started = performance.now();
    let scheduled = 0;
    let pausedFor = 0;      // total time spent paused, kept out of the schedule
    let typed = 0;
    /* Characters standing in the document right now: insertions minus the
       corrections that took them back out. `typed` counts effort and only ever
       rises; this counts result, and is what a resume has to start from. */
    let net = 0;
    let failure = null;
    const state = { method: null, reason: null };

    if (clock.kind === "page") {
      report("This page blocks background timers — typing will slow down if " +
             "you switch tabs.", { kind: "warn", hideAfter: 6000 });
    }

    /* Pausing must not make everything after it late. Deadlines are absolute,
       so the time spent paused is measured and added back to every deadline
       that follows. */
    async function holdWhilePaused() {
      if (!paused) return;
      const from = performance.now();
      report(`Paused — ${typed} of ${total}`,
             { progress: total ? typed / total : 0, kind: "paused" });
      while (paused && !cancelled) await clock.wait(120);
      pausedFor += performance.now() - from;
      if (!cancelled) {
        report(`Typing… ${typed} of ${total}`,
               { progress: total ? typed / total : 0 });
      }
    }

    try {
      for (const stroke of strokes) {
        if (cancelled) break;
        await holdWhilePaused();
        if (cancelled) break;
        scheduled += stroke.delayMs;
        // Absolute deadlines: waiting out each gap separately accumulates the
        // cost of every insertion, and a long document finishes badly late.
        const wait = started + scheduled + pausedFor - performance.now();
        if (wait > 0) {
          const before = performance.now();
          await clock.wait(wait);
          /* Time lost to sleep is absorbed, not replayed at full speed. */
          const overshoot = performance.now() - before - wait;
          if (overshoot > SLEEP_GAP_MS) pausedFor += overshoot;
        }
        if (cancelled) break;

        if (stroke.isBreak) {
          report(`Break — ${Math.round(stroke.delayMs / 1000)}s`,
                 { progress: total ? typed / total : 0 });
          continue;
        }

        if (stroke.action === "backspace") {
          if (!await deliver("remove", null, state)) {
            // A build can accept text and still refuse corrections. Leaving
            // the typo in would silently change what was written, so this
            // ends the run rather than producing text nobody asked for.
            failure = `Typing stopped after ${typed} characters — ` +
                      `the editor would not delete a mistyped character (${state.reason}).`;
            break;
          }
          net--;
        } else if (stroke.text) {
          if (!await deliver("insert", stroke.text, state)) {
            failure = typed === 0
              ? "This page did not accept any text. Click directly inside the " +
                "box you want filled, then start again."
              : `Typing stopped after ${typed} characters — ${state.reason}.`;
            break;
          }
          typed++;
          net++;
          if (typed % 8 === 0) {
            report(`Typing… ${typed} of ${total}`, { progress: typed / total });
            send({ kind: "progress", jobId, typed, total, net });
          }
        }
      }
    } finally {
      running = false;
      paused = false;
      clock.close();
      document.removeEventListener("keydown", onKey, true);
    }

    if (failure) {
      report(failure, { kind: "error", stop: false, hideAfter: 8000 });
      return { ok: false, error: failure, typed, net };
    }
    if (collided) {
      report(`Stopped after ${typed} characters — you started typing.`,
             { kind: "done", stop: false, hideAfter: 5000 });
      return { ok: true, cancelled: true, collided: true, typed, net };
    }
    if (cancelled) {
      report(`Stopped after ${typed} characters.`,
             { kind: "done", stop: false, hideAfter: 3000 });
      return { ok: true, cancelled: true, typed, net };
    }
    report(`Done — ${typed} characters.`,
           { kind: "done", stop: false, hideAfter: 4000 });
    return { ok: true, typed, net };
  }

  /* ───────────────────────────────────────────────────────── messages ── */

  browser.runtime.onMessage.addListener((message) => {
    switch (message.kind) {
      case "ping": {
        // Stand aside if this is the hidden buffer frame: the caret looks like
        // it is here, but the frame that outlives the typing is the one that
        // should own it.
        if (inCanvasBuffer()) {
          return Promise.resolve({ ok: true, top: false, active: false,
                                   descends: false, remembered: false,
                                   hasTarget: false, where: null });
        }
        const found = currentTarget();
        const active = Boolean(found) &&
          (isEditable(document.activeElement) || isCanvasEditor());
        return Promise.resolve({
          ok: true, top: TOP,
          active,                          // focus is in an editable here, now
          descends: focusDescends(),       // focus is in one of our children
          remembered: Boolean(found) && !active,
          hasTarget: Boolean(found),
          where: describe(found),
        });
      }
      case "replay":
        return beginReplay(message.strokes, message.jobId);
      case "tick":
        if (relayTick) relayTick(message.id);
        return Promise.resolve({ ok: true });
      case "cancel":
        cancelled = true;
        paused = false;
        stopPicking();
        return Promise.resolve({ ok: true });
      case "pause":
        paused = running;
        return Promise.resolve({ ok: true, paused });
      case "resume":
        paused = false;
        return Promise.resolve({ ok: true, paused: false });
      case "pick":
        if (TOP) startPicking();
        return Promise.resolve({ ok: true });
      case "show":                       // only ever addressed to frame 0
        showOverlay(message.text, message.options || {});
        return Promise.resolve({ ok: true });
      case "hide":
        hideOverlay();
        return Promise.resolve({ ok: true });
      default:
        return undefined;
    }
  });

  send({ kind: "frame-ready", hasTarget: Boolean(currentTarget()),
         where: describe(currentTarget()) });
})();
