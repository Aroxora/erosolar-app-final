import { firebaseConfig, apiBase } from "./firebase-config.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
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
  getDocs,
  deleteDoc,
  query,
  orderBy,
  onSnapshot,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const provider = new GoogleAuthProvider();
setPersistence(auth, browserLocalPersistence).catch(() => {});

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
};

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
  if (force || near) m.scrollTop = m.scrollHeight;
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
  try {
    await signInWithPopup(auth, provider);
  } catch (e) {
    alert("Sign-in failed: " + (e.message || e.code));
  }
});
els.signout.addEventListener("click", () => signOut(auth));

onAuthStateChanged(auth, (user) => {
  state.user = user;
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

    const title = document.createElement("span");
    title.className = "convo-title";
    title.textContent = c.title || "New chat";
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
  if (!confirm(`Delete "${label}"?`)) return;
  try {
    await deleteDoc(convRef(id));
    if (state.activeId === id) resetToEmpty();
  } catch (e) {
    alert("Could not delete: " + e.message);
  }
}

// ---------------------------------------------------------------------------
// Composer enabled state — disabled only when the CURRENTLY VIEWED conversation
// is mid-run (prevents a double-send in the same thread; other threads are free).
// ---------------------------------------------------------------------------
function updateComposer() {
  const busy = activeBusy();
  els.input.disabled = busy;
  els.input.placeholder = busy ? "Erosolar is responding…" : "Message Erosolar…";
  els.send.disabled = busy || !els.input.value.trim();
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
  if (msg.role === "user") avatar.textContent = "🙂";
  wrap.appendChild(avatar);

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

    const content = document.createElement("div");
    content.className = "content";
    body.appendChild(content);
    msg._contentEl = content;

    const sources = document.createElement("div");
    sources.className = "sources";
    body.appendChild(sources);
    msg._sourcesEl = sources;

    if (msg.streaming) {
      det.open = true;
      det.classList.add("running");
      setReasonSummary(msg, msg.activityLabel || "Reasoning", true);
      rbody.textContent = msg.reasoning || "";
      rbody.scrollTop = rbody.scrollHeight;
      updateReasonVisibility(msg);
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
    if (m && m._contentEl && state.activeId === m.convId) {
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
function finalizeAssistant(msg) {
  if (msg._reasonDetails) {
    msg._reasonDetails.open = false;
    msg._reasonDetails.classList.remove("running");
  }
  if (msg._reasonBody) msg._reasonBody.textContent = (msg.reasoning || "").trim();
  setReasonSummary(msg, "Reasoning", false);
  updateReasonVisibility(msg);
  paintAssistant(msg);
  renderSources(msg);
  addAssistantCopy(msg);
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
  highlightActive();
  return ref.id;
}

async function sendMessage(text) {
  if (activeBusy() || !text.trim()) return;

  let convId;
  try {
    convId = await ensureConversation();
  } catch (e) {
    alert("Could not start a conversation: " + e.message);
    return;
  }

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
  const run = { convId, userMsg, aMsg };
  state.runs.set(convId, run);

  // Render optimistically if this conversation is on screen.
  if (state.activeId === convId) {
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
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + token,
      },
      body: JSON.stringify({ conversationId: convId, message: text }),
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
    aMsg.content += (aMsg.content ? "\n\n" : "") + "⚠️ " + (err.message || "Something went wrong.");
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
    case "tool":
      msg.activityLabel =
        ev.status === "start"
          ? ev.query
            ? `Searching · ${truncate(ev.query, 56)}`
            : "Searching the web"
          : "Reading results";
      if (visible) setReasonSummary(msg, msg.activityLabel, true);
      break;
    case "content":
      // Stream the answer live, as soon as tokens arrive.
      if (!msg.content) msg.activityLabel = "Writing the answer";
      msg.content += ev.delta || "";
      if (visible) {
        setReasonSummary(msg, msg.activityLabel, true);
        scheduleContentRender(msg);
      }
      break;
    case "title":
      run.title = ev.title;
      if (visible && ev.title) els.title.textContent = ev.title;
      break;
    case "done":
      msg.id = ev.messageId;
      if (ev.sources && ev.sources.length) msg.sources = ev.sources;
      break;
    case "error":
      msg.content += (msg.content ? "\n\n" : "") + "⚠️ " + (ev.message || "Error");
      if (visible) scheduleContentRender(msg);
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

// "New chat" always starts a fresh conversation (allowed even while others run).
els.newChat.addEventListener("click", () => {
  resetToEmpty();
  els.input.focus();
});

document.addEventListener("click", (e) => {
  const chip = e.target.closest(".chip-suggest");
  if (chip && !activeBusy()) {
    els.input.value = chip.textContent;
    autosize();
    els.form.requestSubmit();
  }
});

// Mobile sidebar
function closeSidebar() {
  els.app.classList.remove("sidebar-open");
  const scrim = document.querySelector(".scrim");
  if (scrim) scrim.remove();
}
els.menuToggle.addEventListener("click", () => {
  const open = els.app.classList.toggle("sidebar-open");
  if (open) {
    const scrim = document.createElement("div");
    scrim.className = "scrim";
    scrim.addEventListener("click", closeSidebar);
    els.app.appendChild(scrim);
  } else {
    closeSidebar();
  }
});
