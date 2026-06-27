import { firebaseConfig, apiBase } from "./firebase-config.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  getAdditionalUserInfo,
  signInWithCredential,
  reauthenticateWithPopup,
  signOut,
  onAuthStateChanged,
  setPersistence,
  browserLocalPersistence,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  getFirestore,
  collection,
  doc,
  addDoc,
  setDoc,
  getDoc,
  getDocs,
  deleteDoc,
  query,
  where,
  orderBy,
  limit,
  writeBatch,
  onSnapshot,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const provider = new GoogleAuthProvider();
setPersistence(auth, browserLocalPersistence).catch(() => {});

// ---------------------------------------------------------------------------
// Analytics (GA4 via Firebase)
//   Loaded lazily and gated on isSupported() so it's a clean no-op where GA4
//   can't run — notably the native iOS WKWebView wrapper and cookie-blocked
//   browsers — instead of throwing. track()/identify() are safe to call before
//   init resolves: events are queued (bounded) and the user id is applied once
//   Analytics is ready. We never let analytics block or break the app.
// ---------------------------------------------------------------------------
let _analytics = null;
let _logEvent = null;
let _setUserId = null;
let _analyticsReady = false;
let _lastUid = null;
const _eventQueue = [];

async function initAnalytics() {
  try {
    const mod = await import(
      "https://www.gstatic.com/firebasejs/10.14.1/firebase-analytics.js"
    );
    if (await mod.isSupported()) {
      _analytics = mod.getAnalytics(app);
      _logEvent = mod.logEvent;
      _setUserId = mod.setUserId;
      if (_lastUid != null) {
        try {
          _setUserId(_analytics, _lastUid);
        } catch {}
      }
      for (const [name, params] of _eventQueue) {
        try {
          _logEvent(_analytics, name, params);
        } catch {}
      }
    }
  } catch {
    // Analytics is best-effort; swallow load/init failures.
  }
  _analyticsReady = true;
  _eventQueue.length = 0;
}

function track(name, params) {
  const p = params || {};
  if (_analytics && _logEvent) {
    try {
      _logEvent(_analytics, name, p);
    } catch {}
    return;
  }
  if (!_analyticsReady && _eventQueue.length < 50) _eventQueue.push([name, p]);
}

function identify(user) {
  _lastUid = user ? user.uid : null;
  if (_analytics && _setUserId) {
    try {
      _setUserId(_analytics, _lastUid);
    } catch {}
  }
}

initAnalytics();

// Native iOS wrapper bridge: Google blocks OAuth popups inside WKWebView, so the
// Erosolar iOS app signs in natively and hands us the Google credential here.
const isNativeWrapper = () =>
  /ErosolarApp/.test(navigator.userAgent) && window.webkit?.messageHandlers?.erosolarGoogle;
window.__erosolarGoogleCredential = async (idToken, accessToken) => {
  try {
    await signInWithCredential(auth, GoogleAuthProvider.credential(idToken, accessToken || null));
    track("login", { method: "google", via: "native" });
  } catch (e) {
    toast("Sign-in failed: " + (e.message || e.code), "error");
  }
};
window.__erosolarGoogleError = (msg) => {
  if (msg) toast("Google sign-in: " + msg, "error");
};
// Native connector flow result: an access token carrying Calendar/Gmail/Drive scopes.
window.__erosolarGoogleConnect = (accessToken, expiresIn) => {
  state.googleToken = accessToken;
  state.googleTokenExp = Date.now() + Math.max(60, (Number(expiresIn) || 3300) - 300) * 1000;
  track("connect_google", { via: "native" });
  renderConnections();
};

// ---------------------------------------------------------------------------
// State
//   runs: Map<conversationId, run> — in-flight streams, one per conversation.
//   A run keeps streaming into its data model regardless of which conversation
//   is on screen; switching away / starting a new chat never cancels it.
// ---------------------------------------------------------------------------
const state = {
  user: null,
  activeId: null,
  messages: [],
  runs: new Map(),
  unsubConvos: null,
  googleToken: null,
  googleTokenExp: 0,
};

// Google connector scopes (Calendar events, Gmail read+draft, Drive read).
const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/drive.readonly",
];
const googleConnected = () => !!state.googleToken && Date.now() < state.googleTokenExp;

const $ = (s) => document.querySelector(s);
const els = {
  login: $("#login"),
  app: $("#app"),
  googleSignin: $("#google-signin"),
  signout: $("#signout"),
  newChat: $("#new-chat"),
  convList: $("#conversation-list"),
  messages: $("#messages"),
  empty: $("#empty-state"),
  form: $("#composer"),
  input: $("#input"),
  send: $("#send"),
  title: $("#chat-title"),
  userName: $("#user-name"),
  userPhoto: $("#user-photo"),
  menuToggle: $("#menu-toggle"),
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function renderMarkdown(text) {
  const html = window.marked.parse(text || "", { gfm: true, breaks: true });
  return window.DOMPurify.sanitize(html, { ADD_ATTR: ["target", "rel"] });
}
function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
function truncate(s, n) {
  s = s || "";
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
function scrollToBottom(force) {
  const m = els.messages;
  const near = m.scrollHeight - m.scrollTop - m.clientHeight < 160;
  if (force || near) {
    m.scrollTop = m.scrollHeight;
    const jb = document.getElementById("jump-latest");
    if (jb) jb.hidden = true;
  }
}
// Announce streaming status to screen readers via the polite live region.
function announce(text) {
  const el = document.getElementById("sr-status");
  if (!el || !text) return;
  // Clear then set so rapid/identical phases still register as a fresh mutation.
  el.textContent = "";
  requestAnimationFrame(() => {
    el.textContent = text;
  });
}

// ---------------------------------------------------------------------------
// Toasts + confirm dialog — on-brand replacements for native alert()/confirm(),
// which are off-theme and silently swallowed inside the iOS WKWebView wrapper.
// ---------------------------------------------------------------------------
function toast(message, kind) {
  const host = document.getElementById("toasts");
  if (!host) return;
  const el = document.createElement("div");
  el.className = "toast" + (kind ? " toast-" + kind : "");
  el.setAttribute("role", kind === "error" ? "alert" : "status");
  el.textContent = message;
  host.appendChild(el);
  requestAnimationFrame(() => el.classList.add("show"));
  setTimeout(() => {
    el.classList.remove("show");
    setTimeout(() => el.remove(), 250);
  }, kind === "error" ? 5200 : 3500);
}

function confirmDialog(message, opts = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "confirm-overlay";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-labelledby", "confirm-msg");
    const card = document.createElement("div");
    card.className = "confirm-card";
    const msg = document.createElement("p");
    msg.className = "confirm-msg";
    msg.id = "confirm-msg";
    msg.textContent = message;
    const row = document.createElement("div");
    row.className = "confirm-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "btn-cancel";
    cancel.textContent = opts.cancelText || "Cancel";
    const ok = document.createElement("button");
    ok.type = "button";
    ok.className = "btn-confirm" + (opts.danger ? " danger" : "");
    ok.textContent = opts.confirmText || "Confirm";
    row.append(cancel, ok);
    card.append(msg, row);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    const prevFocus = document.activeElement;
    const close = (result) => {
      document.removeEventListener("keydown", onKey, true);
      overlay.remove();
      if (prevFocus && prevFocus.focus) try { prevFocus.focus(); } catch {}
      resolve(result);
    };
    const onKey = (e) => {
      if (e.key !== "Escape" && e.key !== "Enter" && e.key !== "Tab") return;
      e.stopPropagation(); // don't also trip the modal/sidebar Escape behind this dialog
      e.preventDefault();
      if (e.key === "Escape") close(false);
      else if (e.key === "Enter") close(document.activeElement !== cancel); // Enter on Cancel = cancel
      else (document.activeElement === ok ? cancel : ok).focus();
    };
    document.addEventListener("keydown", onKey, true);
    cancel.addEventListener("click", () => close(false));
    ok.addEventListener("click", () => close(true));
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(false); });
    requestAnimationFrame(() => {
      overlay.classList.add("show");
      // Focus the SAFE action on destructive dialogs so an accidental keypress cancels.
      (opts.danger ? cancel : ok).focus();
    });
  });
}
const activeBusy = () => state.activeId != null && state.runs.has(state.activeId);
const userColRef = () => collection(db, "users", state.user.uid, "conversations");
const convRef = (id) => doc(db, "users", state.user.uid, "conversations", id);
const msgsColRef = (id) =>
  collection(db, "users", state.user.uid, "conversations", id, "messages");

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
els.googleSignin.addEventListener("click", async () => {
  if (isNativeWrapper()) {
    // Hand off to the iOS app's native Google Sign-In.
    window.webkit.messageHandlers.erosolarGoogle.postMessage({});
    return;
  }
  try {
    const result = await signInWithPopup(auth, provider);
    track("login", { method: "google", via: "popup" });
    if (getAdditionalUserInfo(result)?.isNewUser) track("sign_up", { method: "google" });
  } catch (e) {
    toast("Sign-in failed: " + (e.message || e.code), "error");
  }
});
els.signout.addEventListener("click", () => {
  track("logout");
  signOut(auth);
});

onAuthStateChanged(auth, (user) => {
  // Auth state known — drop the first-paint splash and show the real UI.
  const splash = document.getElementById("splash");
  if (splash) splash.hidden = true;
  state.user = user;
  identify(user);
  if (state.unsubConvos) {
    state.unsubConvos();
    state.unsubConvos = null;
  }
  if (user) {
    els.login.hidden = true;
    els.app.hidden = false;
    els.userName.textContent = user.displayName || user.email || "Account";
    if (user.photoURL) els.userPhoto.src = user.photoURL;
    subscribeConversations();
    resetToEmpty();
  } else {
    els.app.hidden = true;
    els.login.hidden = false;
    state.activeId = null;
    state.messages = [];
    state.runs.clear();
    state.googleToken = null;
    state.googleTokenExp = 0;
    const mm = document.getElementById("memory-modal");
    if (mm) mm.hidden = true;
  }
});

// ---------------------------------------------------------------------------
// Conversation list (live)
// ---------------------------------------------------------------------------
function subscribeConversations() {
  const q = query(userColRef(), orderBy("updatedAt", "desc"));
  state.unsubConvos = onSnapshot(q, (snap) => {
    const convos = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderConvList(convos);
    // If the active conversation was deleted elsewhere (and isn't mid-run), reset.
    if (state.activeId && !state.runs.has(state.activeId) && !convos.some((c) => c.id === state.activeId)) {
      resetToEmpty();
    }
  });
}

function renderConvList(convos) {
  els.convList.innerHTML = "";
  for (const c of convos) {
    const row = document.createElement("div");
    row.className = "convo" + (c.id === state.activeId ? " active" : "");
    row.dataset.id = c.id;

    // The TITLE is the activatable control (a real button → native keyboard + SR),
    // not the row — so the nested Delete button stays valid and independently usable.
    const title = document.createElement("button");
    title.type = "button";
    title.className = "convo-title";
    title.textContent = c.title || "New chat";
    title.addEventListener("click", (e) => {
      e.stopPropagation();
      selectConversation(c.id, c.title);
    });
    row.appendChild(title);

    // Live indicator if this conversation is streaming.
    if (state.runs.has(c.id)) {
      const dot = document.createElement("span");
      dot.className = "convo-live";
      dot.title = "Responding…";
      row.appendChild(dot);
    }

    const del = document.createElement("button");
    del.className = "convo-del";
    del.title = "Delete conversation";
    del.setAttribute("aria-label", "Delete conversation");
    del.innerHTML =
      '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>';
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      deleteConversation(c.id, c.title || "this chat");
    });
    row.appendChild(del);

    row.addEventListener("click", () => selectConversation(c.id, c.title));
    els.convList.appendChild(row);
  }
}

async function deleteConversation(id, label) {
  if (!(await confirmDialog(`Delete "${label}"?`, { confirmText: "Delete", danger: true }))) return;
  try {
    await deleteDoc(convRef(id));
    if (state.activeId === id) resetToEmpty();
  } catch (e) {
    toast("Could not delete: " + e.message, "error");
  }
}

// ---------------------------------------------------------------------------
// Composer enabled state — disabled only when the CURRENTLY VIEWED conversation
// is mid-run (prevents a double-send in the same thread; other threads are free).
// ---------------------------------------------------------------------------
// The send button doubles as a Stop control while the active conversation streams.
const SEND_ICON = els.send.innerHTML;
const STOP_ICON =
  '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2.5"/></svg>';
function setSendMode(stop) {
  if (els.send.dataset.mode === (stop ? "stop" : "send")) return;
  els.send.dataset.mode = stop ? "stop" : "send";
  els.send.type = stop ? "button" : "submit"; // in stop mode the click must NOT submit
  els.send.innerHTML = stop ? STOP_ICON : SEND_ICON;
  els.send.classList.toggle("stop", stop);
  els.send.setAttribute("aria-label", stop ? "Stop generating" : "Send");
  els.send.title = stop ? "Stop generating" : "Send";
}
// Abort the in-flight run for the conversation currently on screen.
function stopActiveRun() {
  const run = state.activeId && state.runs.get(state.activeId);
  if (run && run.controller && !run.stopped) {
    run.stopped = true;
    try {
      run.controller.abort();
    } catch {}
  }
}

function updateComposer() {
  const busy = activeBusy();
  els.input.disabled = busy;
  els.input.placeholder = busy ? "Erosolar is responding…" : "Message Erosolar…";
  setSendMode(busy);
  els.send.disabled = busy ? false : !els.input.value.trim();
  const exp = document.getElementById("export-chat");
  if (exp) exp.hidden = state.messages.length === 0;
}

// ---------------------------------------------------------------------------
// Conversation selection / rendering
// ---------------------------------------------------------------------------
function resetToEmpty() {
  state.activeId = null;
  state.messages = [];
  els.title.textContent = "Erosolar";
  els.messages.innerHTML = "";
  els.messages.appendChild(els.empty);
  els.empty.hidden = false;
  highlightActive();
  closeSidebar();
  updateComposer();
}

async function selectConversation(id, title) {
  state.activeId = id;
  els.title.textContent = title || "Erosolar";
  highlightActive();
  closeSidebar();
  updateComposer();

  els.messages.innerHTML = "";
  els.empty.hidden = true;
  state.messages = [];

  try {
    const snap = await getDocs(query(msgsColRef(id), orderBy("createdAt", "asc")));
    // Guard against a fast second switch while this load was in flight.
    if (state.activeId !== id) return;
    snap.forEach((d) => {
      const data = d.data();
      addMessageView({
        role: data.role,
        content: data.content || "",
        reasoning: data.reasoning || "",
        sources: data.sources || [],
        memoryUsed: data.memoryUsed || 0,
      });
    });
  } catch (e) {
    console.error("load messages", e);
  }

  // Re-attach an in-flight run for this conversation (its turn isn't persisted
  // until it completes, so it won't be in the loaded history).
  if (state.activeId === id && state.runs.has(id)) {
    const run = state.runs.get(id);
    addMessageView(run.userMsg);
    addMessageView(run.aMsg);
  }

  if (state.messages.length === 0) {
    els.messages.appendChild(els.empty);
    els.empty.hidden = false;
  }
  scrollToBottom(true);
  updateComposer(); // sync the export button with the loaded messages
}

function highlightActive() {
  els.convList.querySelectorAll(".convo").forEach((el) => {
    el.classList.toggle("active", el.dataset.id === state.activeId);
  });
}

// ---------------------------------------------------------------------------
// Message views
//   User turn:        avatar + text
//   Assistant (live): avatar + live "thinking" panel (streamed reasoning + status)
//   Assistant (final):avatar + answer + sources + subtle reasoning toggle
// ---------------------------------------------------------------------------
function addMessageView(msg) {
  if (els.empty.parentNode === els.messages) els.messages.removeChild(els.empty);

  const wrap = document.createElement("div");
  wrap.className = "msg " + (msg.role === "user" ? "msg-user" : "msg-assistant");

  const avatar = document.createElement("div");
  avatar.className = "msg-avatar";
  avatar.setAttribute("aria-hidden", "true"); // decorative; speaker is announced via the sr-only label
  if (msg.role === "user") avatar.textContent = "🙂";
  wrap.appendChild(avatar);

  // Screen-reader speaker label so turns aren't an ambiguous run-on of text.
  const speaker = document.createElement("span");
  speaker.className = "sr-only";
  speaker.textContent = msg.role === "user" ? "You said:" : "Erosolar said:";
  wrap.appendChild(speaker);

  const body = document.createElement("div");
  body.className = "msg-body";

  if (msg.role === "user") {
    const content = document.createElement("div");
    content.className = "content";
    content.textContent = msg.content;
    body.appendChild(content);
    addCopyButton(body, () => msg.content);
  } else {
    msg._body = body;

    // Reasoning log — collapsible, ABOVE the answer. Open and live while
    // running (its streamed content is the "what it's doing" display); collapses
    // to a quiet toggle once the answer is complete.
    const det = document.createElement("details");
    det.className = "reasoning";
    const sum = document.createElement("summary");
    const rbody = document.createElement("div");
    rbody.className = "reasoning-body";
    det.appendChild(sum);
    det.appendChild(rbody);
    body.appendChild(det);
    msg._reasonDetails = det;
    msg._reasonSummary = sum;
    msg._reasonBody = rbody;

    // "Recalled from past chats" note — sits between the reasoning log and answer.
    const memNote = document.createElement("div");
    memNote.className = "memory-note";
    memNote.hidden = true;
    body.appendChild(memNote);
    msg._memoryEl = memNote;

    const content = document.createElement("div");
    content.className = "content";
    body.appendChild(content);
    msg._contentEl = content;

    const actions = document.createElement("div");
    actions.className = "actions";
    body.appendChild(actions);
    msg._actionsEl = actions;

    const sources = document.createElement("div");
    sources.className = "sources";
    body.appendChild(sources);
    msg._sourcesEl = sources;

    if (msg.streaming) {
      det.open = !msg.content; // open while reasoning; collapsed once the answer began
      det.classList.add("running");
      setReasonSummary(msg, msg.activityLabel || "Reasoning", true);
      rbody.textContent = msg.reasoning || "";
      rbody.scrollTop = rbody.scrollHeight;
      updateReasonVisibility(msg);
      renderMemoryNote(msg);
      (msg.actions || []).forEach((a) => renderAction(msg, a)); // re-attach pending actions
      paintAssistant(msg); // render any answer already streamed (re-attach case)
    } else {
      finalizeAssistant(msg);
    }
  }

  wrap.appendChild(body);
  els.messages.appendChild(wrap);
  msg._el = wrap;
  state.messages.push(msg);
  return msg;
}

function paintAssistant(msg) {
  if (!msg._contentEl) return;
  const caret = msg.streaming && msg.content ? '<span class="caret"></span>' : "";
  msg._contentEl.innerHTML = renderMarkdown(msg.content) + caret;
  msg._contentEl.querySelectorAll("a").forEach((a) => {
    a.target = "_blank";
    a.rel = "noopener noreferrer";
  });
}

// Stream the answer live, rAF-throttled, for the on-screen message.
let rafPending = false;
let rafMsg = null;
function scheduleContentRender(msg) {
  rafMsg = msg;
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    const m = rafMsg;
    // Skip a stale frame once the turn is finalized — otherwise this repaint would
    // wipe the copy buttons / highlighting / citation links finalizeAssistant added.
    if (m && m.streaming && m._contentEl && state.activeId === m.convId) {
      paintAssistant(m);
      scrollToBottom(false);
    }
  });
}

// ---- reasoning log helpers ----
function setReasonSummary(msg, label, withSpinner) {
  if (!msg._reasonSummary) return;
  msg._reasonSummary.innerHTML = withSpinner
    ? '<span class="spinner" aria-hidden="true"></span><span class="r-label"></span>'
    : '<span class="r-label"></span>';
  msg._reasonSummary.querySelector(".r-label").textContent = label;
}
function appendReason(msg, delta) {
  if (!msg._reasonBody || !delta) return;
  msg._reasonBody.textContent += delta;
  msg._reasonBody.scrollTop = msg._reasonBody.scrollHeight;
}
function updateReasonVisibility(msg) {
  if (!msg._reasonDetails) return;
  const hasText = (msg.reasoning || "").trim().length > 0;
  // While running, always show it (summary carries live status); once final,
  // keep it only if there were actual thoughts to reveal.
  msg._reasonDetails.hidden = msg.streaming ? false : !hasText;
}
function renderMemoryNote(msg) {
  if (!msg._memoryEl) return;
  const n = msg.memoryUsed || 0;
  msg._memoryEl.hidden = n <= 0;
  if (n > 0) {
    msg._memoryEl.textContent = `🧠 Drew on ${n} note${n === 1 ? "" : "s"} from your past chats`;
  }
}

function describeAction(action) {
  const p = action.params || {};
  if (action.kind === "calendar_create") {
    return `📅 Create event: "${p.summary || "Untitled"}"${p.start ? ` — ${p.start}${p.end ? " → " + p.end : ""}` : ""}`;
  }
  if (action.kind === "gmail_draft") {
    return `✉️ Draft to ${p.to || "?"}: "${p.subject || "(no subject)"}"`;
  }
  return "Proposed action";
}

// Confirm-before-act card: the model proposed a Google action; nothing happens
// unless the user clicks confirm (this is also the guard against an injected
// instruction triggering an unwanted action).
function actionOkText(action) {
  return action.kind === "gmail_draft" ? "✓ Draft saved to Gmail" : "✓ Added to your calendar";
}

function renderAction(msg, action) {
  if (!msg._actionsEl || action.dismissed) return;
  const card = document.createElement("div");
  card.className = "action-card";
  const desc = document.createElement("div");
  desc.className = "action-desc";
  desc.textContent = describeAction(action);
  card.appendChild(desc);
  const status = document.createElement("span");
  status.className = "action-status";

  // Already executed (e.g. re-rendered after switching conversations mid-run) →
  // static completed card, so it can never be confirmed a second time.
  if (action.done) {
    card.classList.add("done");
    status.className = "action-status ok";
    status.textContent = actionOkText(action);
    if (action.resultLink) {
      const a = document.createElement("a");
      a.href = action.resultLink;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = " · open";
      status.appendChild(a);
    }
    card.appendChild(status);
    msg._actionsEl.appendChild(card);
    return;
  }

  const btns = document.createElement("div");
  btns.className = "action-btns";
  const confirm = document.createElement("button");
  confirm.className = "act-confirm";
  confirm.textContent = action.kind === "gmail_draft" ? "Save draft" : "Add to calendar";
  const dismiss = document.createElement("button");
  dismiss.className = "act-dismiss";
  dismiss.textContent = "Dismiss";

  confirm.addEventListener("click", async () => {
    if (!googleConnected()) {
      status.className = "action-status error";
      status.textContent = "Reconnect Google first (open Memory → Connections).";
      return;
    }
    confirm.disabled = true;
    dismiss.disabled = true;
    status.className = "action-status";
    status.textContent = "Working…";
    try {
      const token = await auth.currentUser.getIdToken();
      const params =
        action.kind === "calendar_create"
          ? { ...action.params, timeZone: action.params.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone }
          : action.params;
      const resp = await fetch(apiBase + "/api/action", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
        body: JSON.stringify({ kind: action.kind, params, actionId: action.id, googleToken: state.googleToken }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        if (data.reconnect) {
          state.googleToken = null;
          state.googleTokenExp = 0;
          renderConnections();
        }
        throw new Error(data.error || "HTTP " + resp.status);
      }
      action.done = true;
      if (data.result && data.result.link) action.resultLink = data.result.link;
      btns.remove();
      card.classList.add("done");
      status.className = "action-status ok";
      status.textContent = actionOkText(action);
      if (action.resultLink) {
        const a = document.createElement("a");
        a.href = action.resultLink;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.textContent = " · open";
        status.appendChild(a);
      }
    } catch (e) {
      confirm.disabled = false;
      dismiss.disabled = false;
      status.className = "action-status error";
      status.textContent = e.message;
    }
  });
  dismiss.addEventListener("click", () => {
    action.dismissed = true;
    card.remove();
  });

  btns.appendChild(confirm);
  btns.appendChild(dismiss);
  card.appendChild(btns);
  card.appendChild(status);
  msg._actionsEl.appendChild(card);
  scrollToBottom(false);
}

// ---- Google connections ----
function renderConnections() {
  const box = document.getElementById("connections");
  if (!box) return;
  if (googleConnected()) {
    box.innerHTML =
      '<div class="conn-row"><span class="conn-ok">● Google connected</span>' +
      '<span class="conn-sub">Calendar · Gmail · Drive</span>' +
      '<button id="google-disconnect" class="link">Disconnect</button></div>';
    box.querySelector("#google-disconnect").addEventListener("click", () => {
      state.googleToken = null;
      state.googleTokenExp = 0;
      renderConnections();
    });
  } else {
    box.innerHTML =
      '<div class="conn-row"><button id="google-connect" class="btn-connect">Connect Google</button></div>' +
      '<p class="conn-sub">Let Erosolar use your Calendar, Gmail & Drive. It only reads on request, and any draft or event needs your explicit confirmation. The connection lasts for this session.</p>';
    box.querySelector("#google-connect").addEventListener("click", connectGoogle);
  }
}

async function connectGoogle() {
  if (!auth.currentUser) return;
  // Inside the iOS app, Google blocks the OAuth popup — use the native bridge.
  if (isNativeWrapper()) {
    window.webkit.messageHandlers.erosolarConnect.postMessage({});
    return;
  }
  const provider = new GoogleAuthProvider();
  GOOGLE_SCOPES.forEach((s) => provider.addScope(s));
  try {
    const result = await reauthenticateWithPopup(auth.currentUser, provider);
    const cred = GoogleAuthProvider.credentialFromResult(result);
    if (cred && cred.accessToken) {
      state.googleToken = cred.accessToken;
      state.googleTokenExp = Date.now() + 55 * 60 * 1000;
      track("connect_google", { via: "popup" });
    }
  } catch (e) {
    toast("Could not connect Google: " + (e.message || e.code || ""), "error");
  }
  renderConnections();
}

function renderSources(msg) {
  if (!msg._sourcesEl || !msg.sources || !msg.sources.length) return;
  msg._sourcesEl.innerHTML = "";
  const label = document.createElement("span");
  label.className = "sources-label";
  label.textContent = "Sources";
  msg._sourcesEl.appendChild(label);
  msg.sources.forEach((s, i) => {
    const a = document.createElement("a");
    a.className = "source-chip";
    a.href = s.url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.title = s.title || s.url;
    a.innerHTML = `<span class="num">${i + 1}</span><span class="host"></span>`;
    a.querySelector(".host").textContent = hostOf(s.url);
    msg._sourcesEl.appendChild(a);
  });
}

// ---- copy to clipboard ----
const COPY_ICON =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
function addCopyButton(body, getText) {
  const row = document.createElement("div");
  row.className = "msg-actions";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "copy-btn";
  btn.innerHTML = COPY_ICON + "<span>Copy</span>";
  const label = btn.querySelector("span");
  btn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(getText() || "");
      btn.classList.add("copied");
      label.textContent = "Copied";
    } catch {
      label.textContent = "Copy failed";
    }
    setTimeout(() => {
      btn.classList.remove("copied");
      label.textContent = "Copy";
    }, 1500);
  });
  row.appendChild(btn);
  body.appendChild(row);
}
function addAssistantCopy(msg) {
  if (!msg._body || msg._copyAdded) return;
  msg._copyAdded = true;
  addCopyButton(msg._body, () => msg.content);
}

// Finalize the assistant turn: collapse the reasoning log (still above the
// answer), ensure the full answer + sources are rendered, add the copy button.
// Recoverable failed turn: re-stream the same prompt. The failed turn was never
// persisted server-side, so this is a clean re-run, not a duplicate.
function retryTurn(failedMsg) {
  const text = failedMsg._retryText;
  const convId = failedMsg.convId;
  if (!text || !convId || activeBusy()) return;
  if (failedMsg._el) failedMsg._el.remove();
  const i = state.messages.indexOf(failedMsg);
  if (i >= 0) state.messages.splice(i, 1);
  const aMsg = {
    role: "assistant", content: "", reasoning: "", sources: [],
    streaming: true, convId, activityLabel: "Reasoning",
  };
  const run = { convId, userMsg: { role: "user", content: text }, aMsg, controller: new AbortController() };
  state.runs.set(convId, run);
  if (state.activeId === convId) {
    addMessageView(aMsg);
    scrollToBottom(true);
  }
  updateComposer();
  refreshConvLiveDot(convId);
  streamRun(run, text);
}

// Render a recoverable error block (with Retry) under a failed assistant turn.
function renderError(msg) {
  if (!msg.error || !msg._body) return;
  const box = document.createElement("div");
  box.className = "turn-error";
  const label = document.createElement("span");
  label.textContent = "⚠️ " + msg.error;
  box.appendChild(label);
  if (msg._retryText) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "retry-btn";
    btn.textContent = "Retry";
    btn.addEventListener("click", () => retryTurn(msg));
    box.appendChild(btn);
  }
  msg._body.appendChild(box);
}

// Lazy-load highlight.js (and its theme) only when a code block actually appears.
let _hljs = null;
let _hljsLoading = null;
function loadHljs() {
  if (_hljs) return Promise.resolve(_hljs);
  if (!_hljsLoading) {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "https://cdn.jsdelivr.net/npm/highlight.js@11/styles/github-dark.min.css";
    document.head.appendChild(link);
    _hljsLoading = import("https://cdn.jsdelivr.net/npm/highlight.js@11/+esm")
      .then((m) => ((_hljs = m.default || m), _hljs))
      .catch(() => null);
  }
  return _hljsLoading;
}

// Per-block Copy button (immediate) + lazy syntax highlighting for each code block.
function enhanceCodeBlocks(root) {
  if (!root) return;
  const blocks = [...root.querySelectorAll("pre > code")].filter((c) => !c.dataset.enh);
  if (!blocks.length) return;
  for (const code of blocks) {
    code.dataset.enh = "1";
    const pre = code.parentElement;
    if (!pre || pre.tagName !== "PRE") continue;
    // Wrap <pre> in a NON-scrolling container so the copy button stays pinned to the
    // visible corner instead of scrolling away with wide code.
    let wrap = pre.parentElement;
    if (!wrap || !wrap.classList.contains("code-wrap")) {
      wrap = document.createElement("div");
      wrap.className = "code-wrap";
      pre.parentNode.insertBefore(wrap, pre);
      wrap.appendChild(pre);
    }
    if (!wrap.querySelector(".code-copy")) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "code-copy";
      btn.textContent = "Copy";
      btn.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(code.textContent || "");
          btn.textContent = "Copied";
        } catch {
          btn.textContent = "Failed";
        }
        setTimeout(() => (btn.textContent = "Copy"), 1500);
      });
      wrap.appendChild(btn);
    }
  }
  loadHljs().then((hljs) => {
    if (hljs) for (const code of blocks) try { hljs.highlightElement(code); } catch {}
  });
}

// Turn inline [n] citation markers into superscript links to the matching source.
function linkCitations(root, sources) {
  if (!root || !sources || !sources.length) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      node.parentElement &&
      !node.parentElement.closest("pre, code, a, sup") &&
      /\[\d+\]/.test(node.nodeValue)
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT,
  });
  const targets = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) targets.push(n);
  for (const textNode of targets) {
    const text = textNode.nodeValue;
    const frag = document.createDocumentFragment();
    const re = /\[(\d+)\]/g;
    let last = 0;
    let m;
    while ((m = re.exec(text))) {
      const before = m.index > 0 ? text[m.index - 1] : "";
      const src = sources[parseInt(m[1], 10) - 1];
      frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      // Link only safe http(s) sources; skip identifier-like "arr[2]" (a letter / _ /
      // $ right before the bracket — a digit prefix still links).
      if (src && /^https?:\/\//i.test(src.url || "") && !/[A-Za-z_$]/.test(before)) {
        const sup = document.createElement("sup");
        const a = document.createElement("a");
        a.href = src.url;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.className = "cite";
        a.textContent = m[0];
        a.title = src.title || src.url;
        sup.appendChild(a);
        frag.appendChild(sup);
      } else {
        frag.appendChild(document.createTextNode(m[0]));
      }
      last = m.index + m[0].length;
    }
    frag.appendChild(document.createTextNode(text.slice(last)));
    textNode.parentNode.replaceChild(frag, textNode);
  }
}

function finalizeAssistant(msg) {
  if (msg._reasonDetails) {
    msg._reasonDetails.open = false;
    msg._reasonDetails.classList.remove("running");
  }
  if (msg._reasonBody) msg._reasonBody.textContent = (msg.reasoning || "").trim();
  setReasonSummary(msg, "Reasoning", false);
  updateReasonVisibility(msg);
  renderMemoryNote(msg);
  paintAssistant(msg);
  enhanceCodeBlocks(msg._contentEl);
  linkCitations(msg._contentEl, msg.sources);
  renderSources(msg);
  if (msg.content && msg.content.trim()) addAssistantCopy(msg); // no copy on a pure-error turn
  renderError(msg);
}

// ---------------------------------------------------------------------------
// Sending + streaming (per-conversation, concurrent)
// ---------------------------------------------------------------------------
async function ensureConversation() {
  if (state.activeId) return state.activeId;
  const ref = await addDoc(userColRef(), {
    title: "New chat",
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  state.activeId = ref.id;
  track("conversation_started");
  highlightActive();
  return ref.id;
}

async function sendMessage(text) {
  if (activeBusy() || !text.trim()) return;

  let convId;
  try {
    convId = await ensureConversation();
  } catch (e) {
    toast("Could not start a conversation: " + e.message, "error");
    return;
  }
  track("message_sent", { length: text.length });

  const userMsg = { role: "user", content: text };
  const aMsg = {
    role: "assistant",
    content: "",
    reasoning: "",
    sources: [],
    streaming: true,
    convId,
    activityLabel: "Reasoning",
  };
  const run = { convId, userMsg, aMsg, controller: new AbortController() };
  state.runs.set(convId, run);

  // Render optimistically if this conversation is on screen.
  if (state.activeId === convId) {
    // A new turn supersedes any earlier failed turn — drop stale Retry controls so
    // an out-of-order retry can't reorder the conversation.
    els.messages.querySelectorAll(".retry-btn").forEach((b) => b.remove());
    addMessageView(userMsg);
    addMessageView(aMsg);
    scrollToBottom(true);
  }
  updateComposer();
  refreshConvLiveDot(convId);

  streamRun(run, text); // fire-and-forget; lifecycle handled inside
}

async function streamRun(run, text) {
  const { convId, aMsg } = run;
  try {
    const token = await auth.currentUser.getIdToken();
    const resp = await fetch(apiBase + "/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
      body: JSON.stringify({
        conversationId: convId,
        message: text,
        ...(googleConnected() ? { googleToken: state.googleToken } : {}),
      }),
      signal: run.controller.signal,
    });
    if (!resp.ok || !resp.body) {
      let detail = "HTTP " + resp.status;
      try {
        detail = (await resp.json()).error || detail;
      } catch {}
      throw new Error(detail);
    }

    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let ev;
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        handleEvent(run, ev);
      }
    }
  } catch (err) {
    if (run.stopped || err.name === "AbortError") {
      // User hit Stop — keep whatever streamed in; mark an empty turn as stopped.
      aMsg.stopped = true;
      if (!aMsg.content.trim()) aMsg.content = "_Stopped._";
    } else {
      // Recoverable error. Only offer Retry when NOTHING streamed: once answer
      // content has begun, a mid-stream disconnect means the server best-effort-
      // persisted a partial turn, so re-running would DUPLICATE it. (Server
      // type:error events stay retryable — they never persist; see handleEvent.)
      aMsg.error = err.message || "Something went wrong.";
      if (!aMsg.content.trim()) aMsg._retryText = text;
    }
  } finally {
    aMsg.streaming = false;
    state.runs.delete(convId);
    if (state.activeId === convId) {
      finalizeAssistant(aMsg);
      scrollToBottom(true);
      updateComposer();
      els.input.focus();
    }
    refreshConvLiveDot(convId);
  }
}

function handleEvent(run, ev) {
  const msg = run.aMsg;
  const visible = state.activeId === run.convId; // only touch the DOM when on screen
  switch (ev.type) {
    case "reasoning":
      // The streamed reasoning log IS the live display (no "Thinking" placeholder).
      msg.reasoning += ev.delta || "";
      msg.activityLabel = "Reasoning";
      if (visible) {
        setReasonSummary(msg, "Reasoning", true);
        appendReason(msg, ev.delta || "");
        updateReasonVisibility(msg);
      }
      break;
    case "tool": {
      const isExtract = ev.name === "web_extract";
      if (ev.status === "start") {
        if (isExtract) {
          const hosts = (ev.query || "")
            .split(",")
            .map((u) => hostOf(u.trim()))
            .filter(Boolean)
            .join(", ");
          msg.activityLabel = hosts ? `Reading ${truncate(hosts, 56)}` : "Reading page";
        } else {
          msg.activityLabel = ev.query ? `Searching · ${truncate(ev.query, 56)}` : "Searching the web";
        }
      } else {
        msg.activityLabel = isExtract ? "Reading page content" : "Reading results";
      }
      if (visible) {
        setReasonSummary(msg, msg.activityLabel, true);
        announce(msg.activityLabel);
      }
      break;
    }
    case "content": {
      // Stream the answer live, as soon as tokens arrive.
      const firstToken = !msg.content;
      if (firstToken) msg.activityLabel = "Writing the answer";
      msg.content += ev.delta || "";
      if (visible) {
        // Auto-collapse the reasoning log once the answer starts streaming.
        if (firstToken && msg._reasonDetails) msg._reasonDetails.open = false;
        if (firstToken) announce("Writing the answer");
        setReasonSummary(msg, msg.activityLabel, true);
        scheduleContentRender(msg);
      }
      break;
    }
    case "memory":
      // Recalled relevant context from the user's other conversations.
      msg.memoryUsed = ev.count || 0;
      if (visible) {
        setReasonSummary(msg, "Recalling from past chats", true);
        renderMemoryNote(msg);
      }
      break;
    case "action":
      // The model proposed a Google action — show a confirm card (never auto-run).
      if (!msg.actions) msg.actions = [];
      msg.actions.push(ev);
      if (visible) renderAction(msg, ev);
      break;
    case "title":
      run.title = ev.title;
      if (visible && ev.title) els.title.textContent = ev.title;
      break;
    case "done":
      msg.id = ev.messageId;
      if (typeof ev.memoryUsed === "number") msg.memoryUsed = ev.memoryUsed;
      if (ev.sources && ev.sources.length) msg.sources = ev.sources;
      if (visible) announce("Answer ready");
      break;
    case "error":
      msg.error = ev.message || "Error";
      msg._retryText = run.userMsg.content; // preserve the prompt for one-click Retry
      if (visible) announce("Something went wrong");
      break;
  }
}

// Toggle the little "responding" dot on a conversation row without a full relist.
function refreshConvLiveDot(convId) {
  const row = els.convList.querySelector(`.convo[data-id="${CSS.escape(convId)}"]`);
  if (!row) return;
  const existing = row.querySelector(".convo-live");
  const running = state.runs.has(convId);
  if (running && !existing) {
    const dot = document.createElement("span");
    dot.className = "convo-live";
    dot.title = "Responding…";
    row.insertBefore(dot, row.querySelector(".convo-del"));
  } else if (!running && existing) {
    existing.remove();
  }
}

// ---------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------
function autosize() {
  els.input.style.height = "auto";
  els.input.style.height = Math.min(els.input.scrollHeight, 200) + "px";
}
els.input.addEventListener("input", () => {
  autosize();
  els.send.disabled = activeBusy() || !els.input.value.trim();
});
els.input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    els.form.requestSubmit();
  }
});
els.form.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = els.input.value.trim();
  if (!text || activeBusy()) return;
  els.input.value = "";
  autosize();
  sendMessage(text);
});
// While streaming, the send button becomes a Stop control (type="button"): abort
// the active run instead of submitting. In send mode this is a no-op (form submits).
els.send.addEventListener("click", (e) => {
  if (els.send.dataset.mode === "stop") {
    e.preventDefault();
    stopActiveRun();
  }
});

// "New chat" always starts a fresh conversation (allowed even while others run).
els.newChat.addEventListener("click", () => {
  track("new_chat");
  resetToEmpty();
  els.input.focus();
});

document.addEventListener("click", (e) => {
  const chip = e.target.closest(".chip-suggest");
  if (chip && !activeBusy()) {
    track("chip_suggest");
    els.input.value = chip.textContent;
    autosize();
    els.form.requestSubmit();
  }
});

// ---------------------------------------------------------------------------
// Memory manager — view the curated profile + stored memories, delete/clear them
// ---------------------------------------------------------------------------
const memEls = {
  open: $("#open-memory"),
  modal: $("#memory-modal"),
  close: $("#memory-close"),
  profile: $("#memory-profile"),
  list: $("#memory-list"),
  clear: $("#memory-clear"),
};

memEls.open.addEventListener("click", openMemory);
function closeMemory() {
  memEls.modal.hidden = true;
  memEls.open.focus(); // return focus to the trigger
}
memEls.close.addEventListener("click", closeMemory);
memEls.modal.addEventListener("click", (e) => {
  if (e.target === memEls.modal) closeMemory();
});
memEls.clear.addEventListener("click", clearAllMemories);
// Escape closes the memory dialog, else the mobile sidebar.
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!memEls.modal.hidden) closeMemory();
  else if (els.app.classList.contains("sidebar-open")) closeSidebar();
});
// Trap Tab within the open dialog (aria-modal) so focus can't drift to the chat behind it.
memEls.modal.addEventListener("keydown", (e) => {
  if (e.key !== "Tab") return;
  const f = memEls.modal.querySelectorAll(
    'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])'
  );
  if (!f.length) return;
  const first = f[0];
  const last = f[f.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
});

async function openMemory() {
  if (!state.user) return;
  memEls.modal.hidden = false;
  memEls.close.focus(); // move focus into the dialog
  renderConnections();
  loadDocuments();
  memEls.profile.className = "profile-box";
  memEls.profile.textContent = "Loading…";
  memEls.list.innerHTML = '<div class="mem-empty">Loading…</div>';

  try {
    const snap = await getDoc(doc(db, "users", state.user.uid));
    const ci = document.getElementById("custom-instructions");
    if (ci) ci.value = snap.exists() ? snap.data().customInstructions || "" : "";
    const profile = snap.exists() ? snap.data().profile || "" : "";
    if (profile.trim()) {
      memEls.profile.innerHTML = renderMarkdown(profile);
    } else {
      memEls.profile.className = "profile-box empty";
      memEls.profile.textContent = "No profile yet — Erosolar builds one as you chat.";
    }
  } catch {
    memEls.profile.className = "profile-box empty";
    memEls.profile.textContent = "Could not load profile.";
  }

  try {
    const snap = await getDocs(
      query(collection(db, "users", state.user.uid, "memories"), orderBy("createdAt", "desc"), limit(100))
    );
    renderMemoryList(snap.docs);
  } catch (e) {
    memEls.list.innerHTML = '<div class="mem-empty">Could not load memories.</div>';
    console.error("memory list", e);
  }
}

function memEmpty() {
  memEls.list.innerHTML = '<div class="mem-empty">No stored memories yet.</div>';
}

function renderMemoryList(docs) {
  memEls.list.innerHTML = "";
  if (!docs.length) return memEmpty();
  for (const d of docs) {
    const m = d.data();
    const role = m.role || "user";
    const item = document.createElement("div");
    item.className = "mem-item";

    const main = document.createElement("div");
    main.className = "mem-main";
    const badge = document.createElement("span");
    badge.className = "mem-badge " + (role === "assistant" ? "assistant" : role === "web" ? "web" : "user");
    badge.textContent = role;
    const text = document.createElement("div");
    text.className = "mem-text";
    text.textContent = truncate(m.text || "", 280);
    main.appendChild(badge);
    main.appendChild(text);
    if (m.url) {
      const meta = document.createElement("div");
      meta.className = "mem-meta";
      const a = document.createElement("a");
      a.href = m.url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = hostOf(m.url);
      meta.appendChild(a);
      main.appendChild(meta);
    }

    const del = document.createElement("button");
    del.className = "mem-del";
    del.title = "Forget this";
    del.innerHTML =
      '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>';
    del.addEventListener("click", async () => {
      del.disabled = true;
      try {
        await deleteDoc(doc(db, "users", state.user.uid, "memories", d.id));
        item.remove();
        if (!memEls.list.children.length) memEmpty();
      } catch (e) {
        del.disabled = false;
        toast("Could not delete: " + e.message, "error");
      }
    });

    item.appendChild(main);
    item.appendChild(del);
    memEls.list.appendChild(item);
  }
}

async function clearAllMemories() {
  if (!state.user) return;
  if (!(await confirmDialog("Forget ALL stored memories? This can't be undone. (Your chat history is not affected.)", { confirmText: "Forget all", danger: true }))) return;
  memEls.clear.disabled = true;
  try {
    for (;;) {
      const snap = await getDocs(query(collection(db, "users", state.user.uid, "memories"), limit(400)));
      if (snap.empty) break;
      const batch = writeBatch(db);
      snap.docs.forEach((d) => batch.delete(d.ref));
      await batch.commit();
      if (snap.size < 400) break;
    }
    memEmpty();
  } catch (e) {
    toast("Could not clear: " + e.message, "error");
  } finally {
    memEls.clear.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Document upload / RAG — extract text client-side, send to /api/ingest
// ---------------------------------------------------------------------------
const upEls = {
  attach: $("#attach-btn"),
  fileInput: $("#file-input"),
  status: $("#upload-status"),
  docUpload: $("#doc-upload"),
  docList: $("#doc-list"),
};

upEls.attach.addEventListener("click", () => upEls.fileInput.click());
upEls.docUpload.addEventListener("click", () => upEls.fileInput.click());
upEls.fileInput.addEventListener("change", () => {
  const file = upEls.fileInput.files && upEls.fileInput.files[0];
  upEls.fileInput.value = "";
  if (file) ingestFile(file);
});

function showUpload(text, kind) {
  upEls.status.hidden = false;
  upEls.status.className = "upload-status" + (kind ? " " + kind : "");
  upEls.status.innerHTML = (kind === "busy" ? '<span class="spinner"></span>' : "") + "<span></span>";
  upEls.status.querySelector("span:last-child").textContent = text;
}
function hideUploadLater(ms) {
  setTimeout(() => {
    upEls.status.hidden = true;
    upEls.status.innerHTML = "";
  }, ms);
}

async function extractText(file) {
  const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
  if (!isPdf) return await file.text();
  const pdfjs = await import("https://cdn.jsdelivr.net/npm/pdfjs-dist@4/build/pdf.min.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4/build/pdf.worker.min.mjs";
  const buf = await file.arrayBuffer();
  const pdf = await pdfjs.getDocument({ data: buf }).promise;
  let out = "";
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const tc = await page.getTextContent();
    out += tc.items.map((it) => it.str).join(" ") + "\n\n";
    if (out.length > 400000) break;
  }
  return out;
}

async function ingestFile(file) {
  if (!state.user) return;
  if (file.size > 10 * 1024 * 1024) {
    showUpload("File too large (max 10 MB).", "error");
    return hideUploadLater(4000);
  }
  showUpload(`Reading ${truncate(file.name, 40)}…`, "busy");
  let text = "";
  try {
    text = await extractText(file);
  } catch (e) {
    console.error("extract", e);
    showUpload("Couldn't read that file.", "error");
    return hideUploadLater(4000);
  }
  if (!text || !text.trim()) {
    showUpload("No text found in that file.", "error");
    return hideUploadLater(4000);
  }
  showUpload(`Indexing ${truncate(file.name, 40)}…`, "busy");
  try {
    const token = await auth.currentUser.getIdToken();
    const resp = await fetch(apiBase + "/api/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
      body: JSON.stringify({ filename: file.name, text }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.error || "HTTP " + resp.status);
    track("document_upload", {
      chunks: Number(data.chunks) || 0,
      // Extension only — never the filename. A dotless name has no extension, so
      // send a sentinel rather than leaking the name's first chars into GA4.
      type: file.name.includes(".") ? file.name.split(".").pop().toLowerCase().slice(0, 8) : "none",
    });
    showUpload(`✓ Added ${truncate(file.name, 40)} · ${data.chunks} excerpt${data.chunks === 1 ? "" : "s"}`, "ok");
    hideUploadLater(5000);
    const modal = document.getElementById("memory-modal");
    if (modal && !modal.hidden) loadDocuments();
  } catch (e) {
    track("document_upload_failed");
    showUpload("Indexing failed: " + e.message, "error");
    hideUploadLater(5000);
  }
}

async function loadDocuments() {
  upEls.docList.innerHTML = '<div class="mem-empty">Loading…</div>';
  try {
    const snap = await getDocs(
      query(collection(db, "users", state.user.uid, "documents"), orderBy("createdAt", "desc"))
    );
    if (snap.empty) {
      upEls.docList.innerHTML = '<div class="mem-empty">No documents uploaded yet.</div>';
      return;
    }
    upEls.docList.innerHTML = "";
    snap.forEach((d) => {
      const data = d.data();
      const item = document.createElement("div");
      item.className = "mem-item";
      const main = document.createElement("div");
      main.className = "mem-main";
      const t = document.createElement("div");
      t.className = "mem-text";
      t.textContent = data.filename || "document";
      const meta = document.createElement("div");
      meta.className = "mem-meta";
      meta.textContent = `${data.chunks || 0} excerpt${data.chunks === 1 ? "" : "s"} indexed`;
      main.appendChild(t);
      main.appendChild(meta);
      const del = document.createElement("button");
      del.className = "mem-del";
      del.title = "Delete document";
      del.innerHTML =
        '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>';
      del.addEventListener("click", () => deleteDocument(d.id, item, del));
      item.appendChild(main);
      item.appendChild(del);
      upEls.docList.appendChild(item);
    });
  } catch (e) {
    upEls.docList.innerHTML = '<div class="mem-empty">Could not load documents.</div>';
    console.error("docs", e);
  }
}

async function deleteDocument(docId, item, del) {
  if (!(await confirmDialog("Delete this document and everything Erosolar learned from it?", { confirmText: "Delete", danger: true }))) return;
  del.disabled = true;
  try {
    for (;;) {
      const snap = await getDocs(
        query(collection(db, "users", state.user.uid, "memories"), where("docId", "==", docId), limit(400))
      );
      if (snap.empty) break;
      const batch = writeBatch(db);
      snap.docs.forEach((d) => batch.delete(d.ref));
      await batch.commit();
      if (snap.size < 400) break;
    }
    await deleteDoc(doc(db, "users", state.user.uid, "documents", docId));
    item.remove();
    if (!upEls.docList.children.length)
      upEls.docList.innerHTML = '<div class="mem-empty">No documents uploaded yet.</div>';
  } catch (e) {
    del.disabled = false;
    toast("Could not delete: " + e.message, "error");
  }
}

// Mobile sidebar
function closeSidebar() {
  els.app.classList.remove("sidebar-open");
  els.menuToggle.setAttribute("aria-expanded", "false");
  const scrim = document.querySelector(".scrim");
  if (scrim) scrim.remove();
}
els.menuToggle.addEventListener("click", () => {
  const open = els.app.classList.toggle("sidebar-open");
  els.menuToggle.setAttribute("aria-expanded", String(open));
  if (open) {
    const scrim = document.createElement("div");
    scrim.className = "scrim";
    scrim.addEventListener("click", closeSidebar);
    els.app.appendChild(scrim);
  } else {
    closeSidebar();
  }
});

// ---------------------------------------------------------------------------
// Service worker — app-shell cache for fast repeat loads + offline support.
// Best-effort: if it's unsupported or registration fails, the app runs exactly
// as before (no precache, no offline) — nothing here can break normal loads.
// ---------------------------------------------------------------------------
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  });
}

// ---------------------------------------------------------------------------
// Export the current conversation as a Markdown file (with sources).
// ---------------------------------------------------------------------------
function exportConversation() {
  if (!state.messages.length) return;
  const lines = ["# " + (els.title.textContent || "Erosolar chat"), ""];
  for (const m of state.messages) {
    if (m.role === "user") {
      lines.push("## You", "", m.content || "", "");
    } else if (m.content && m.content.trim()) {
      lines.push("## Erosolar", "", m.content, "");
      if (m.sources && m.sources.length) {
        lines.push("**Sources**");
        m.sources.forEach((s, i) => lines.push(`${i + 1}. [${s.title || s.url}](${s.url})`));
        lines.push("");
      }
    }
  }
  const blob = new Blob([lines.join("\n")], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download =
    ((els.title.textContent || "erosolar-chat").replace(/[^\w-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "chat") + ".md";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
document.getElementById("export-chat")?.addEventListener("click", exportConversation);

// ---------------------------------------------------------------------------
// Jump-to-latest pill — appears while scrolled up; returns to the live tail.
// ---------------------------------------------------------------------------
(() => {
  const jb = document.getElementById("jump-latest");
  if (!jb) return;
  els.messages.addEventListener("scroll", () => {
    const m = els.messages;
    jb.hidden = m.scrollHeight - m.scrollTop - m.clientHeight <= 240;
  });
  jb.addEventListener("click", () => scrollToBottom(true));
})();

// ---------------------------------------------------------------------------
// Custom instructions — always-on guidance saved from the Memory panel.
// ---------------------------------------------------------------------------
document.getElementById("ci-save")?.addEventListener("click", async () => {
  if (!state.user) return;
  const ci = document.getElementById("custom-instructions");
  if (!ci) return;
  try {
    await setDoc(doc(db, "users", state.user.uid), { customInstructions: ci.value.trim().slice(0, 2000) }, { merge: true });
    toast("Custom instructions saved");
  } catch (e) {
    toast("Could not save: " + (e.message || ""), "error");
  }
});
