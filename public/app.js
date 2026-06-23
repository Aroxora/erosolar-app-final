import { firebaseConfig } from "./firebase-config.js";
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
// ---------------------------------------------------------------------------
const state = {
  user: null,
  activeId: null,
  messages: [],
  unsubConvos: null,
  sending: false,
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
    if (state.activeId && !convos.some((c) => c.id === state.activeId)) {
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
// Conversation selection
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
}

async function selectConversation(id, title) {
  if (state.sending) return;
  state.activeId = id;
  els.title.textContent = title || "Erosolar";
  highlightActive();
  closeSidebar();

  els.messages.innerHTML = "";
  els.empty.hidden = true;
  state.messages = [];

  try {
    const snap = await getDocs(query(msgsColRef(id), orderBy("createdAt", "asc")));
    snap.forEach((d) => {
      const data = d.data();
      addMessageView({
        role: data.role,
        content: data.content || "",
        reasoning: data.reasoning || "",
        sources: data.sources || [],
      });
    });
    if (state.messages.length === 0) {
      els.messages.appendChild(els.empty);
      els.empty.hidden = false;
    }
    scrollToBottom(true);
  } catch (e) {
    console.error("load messages", e);
  }
}

function highlightActive() {
  els.convList.querySelectorAll(".convo").forEach((el) => {
    el.classList.toggle("active", el.dataset.id === state.activeId);
  });
}

// ---------------------------------------------------------------------------
// Message views
//   User turn:      avatar + text
//   Assistant turn: avatar + [ephemeral activity] + answer + sources + (subtle reasoning toggle)
// ---------------------------------------------------------------------------
function addMessageView(msg) {
  if (els.empty.parentNode === els.messages) els.messages.removeChild(els.empty);

  const wrap = document.createElement("div");
  wrap.className = "msg " + (msg.role === "user" ? "msg-user" : "msg-assistant");

  const avatar = document.createElement("div");
  avatar.className = "msg-avatar";
  avatar.textContent = msg.role === "user" ? "🙂" : "";
  wrap.appendChild(avatar);

  const body = document.createElement("div");
  body.className = "msg-body";

  if (msg.role === "user") {
    const content = document.createElement("div");
    content.className = "content";
    content.textContent = msg.content;
    body.appendChild(content);
  } else {
    // Ephemeral activity line (Thinking / Searching) — removed once answering.
    const activity = document.createElement("div");
    activity.className = "activity";
    activity.hidden = true;
    body.appendChild(activity);
    msg._activityEl = activity;

    const content = document.createElement("div");
    content.className = "content";
    body.appendChild(content);
    msg._contentEl = content;

    const sources = document.createElement("div");
    sources.className = "sources";
    body.appendChild(sources);
    msg._sourcesEl = sources;

    msg._reasoningSlot = body; // reasoning toggle appended here on finalize
  }

  wrap.appendChild(body);
  els.messages.appendChild(wrap);
  msg._el = wrap;
  state.messages.push(msg);

  if (msg.role !== "user") {
    paintAssistant(msg);
    if (msg.sources && msg.sources.length) renderSources(msg);
    finalizeReasoning(msg); // for history (already-complete messages)
  }
  return msg;
}

function paintAssistant(msg) {
  const caret = msg.streaming && msg.content ? '<span class="caret"></span>' : "";
  msg._contentEl.innerHTML = renderMarkdown(msg.content) + caret;
  msg._contentEl.querySelectorAll("a").forEach((a) => {
    a.target = "_blank";
    a.rel = "noopener noreferrer";
  });
}

// One small, transient status line. Idempotent: only rebuilds when needed so
// the spinner animation stays continuous as the label updates.
function setActivity(msg, label) {
  if (!msg._activityEl) return;
  if (msg._activityLabel === label && !msg._activityEl.hidden) return;
  if (msg._activityEl.hidden || !msg._activityEl.firstChild) {
    msg._activityEl.hidden = false;
    msg._activityEl.innerHTML =
      '<span class="spinner" aria-hidden="true"></span><span class="act-label"></span>';
  }
  msg._activityEl.querySelector(".act-label").textContent = label;
  msg._activityLabel = label;
  scrollToBottom(false);
}
function clearActivity(msg) {
  if (msg._activityEl) {
    msg._activityEl.hidden = true;
    msg._activityEl.innerHTML = "";
    msg._activityLabel = null;
  }
}

let rafPending = false;
function scheduleRender(msg) {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    paintAssistant(msg);
    scrollToBottom(false);
  });
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

// Subtle, collapsed-by-default reasoning toggle (only if reasoning exists).
function finalizeReasoning(msg) {
  if (!msg._reasoningSlot || msg._reasoningBuilt) return;
  const text = (msg.reasoning || "").trim();
  if (!text) return;
  msg._reasoningBuilt = true;
  const det = document.createElement("details");
  det.className = "reasoning";
  const sum = document.createElement("summary");
  sum.textContent = "Reasoning";
  const bodyEl = document.createElement("div");
  bodyEl.className = "reasoning-body";
  bodyEl.textContent = text;
  det.appendChild(sum);
  det.appendChild(bodyEl);
  msg._reasoningSlot.appendChild(det);
}

// ---------------------------------------------------------------------------
// Sending + streaming
// ---------------------------------------------------------------------------
function setSending(on) {
  state.sending = on;
  els.send.disabled = on || !els.input.value.trim();
  els.input.disabled = on;
}

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
  if (state.sending || !text.trim()) return;
  setSending(true);

  let convId;
  try {
    convId = await ensureConversation();
  } catch (e) {
    setSending(false);
    alert("Could not start a conversation: " + e.message);
    return;
  }

  addMessageView({ role: "user", content: text });
  const aMsg = addMessageView({
    role: "assistant",
    content: "",
    reasoning: "",
    sources: [],
    streaming: true,
  });
  setActivity(aMsg, "Thinking");
  scrollToBottom(true);

  try {
    const token = await auth.currentUser.getIdToken();
    const resp = await fetch("/api/chat", {
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
        handleEvent(aMsg, ev);
      }
    }
  } catch (err) {
    aMsg.content += (aMsg.content ? "\n\n" : "") + "⚠️ " + (err.message || "Something went wrong.");
  } finally {
    aMsg.streaming = false;
    clearActivity(aMsg);
    paintAssistant(aMsg);
    finalizeReasoning(aMsg);
    setSending(false);
    els.input.focus();
    scrollToBottom(false);
  }
}

function handleEvent(aMsg, ev) {
  switch (ev.type) {
    case "reasoning":
      // Don't display raw thinking — just keep the activity line alive.
      aMsg.reasoning += ev.delta || "";
      if (!aMsg.content) setActivity(aMsg, "Thinking");
      break;
    case "content":
      if (!aMsg.content) clearActivity(aMsg); // first token → drop the status line
      aMsg.content += ev.delta || "";
      scheduleRender(aMsg);
      break;
    case "tool":
      if (ev.status === "start") {
        setActivity(aMsg, ev.query ? `Searching · ${truncate(ev.query, 48)}` : "Searching the web");
      } else {
        setActivity(aMsg, "Reading results");
      }
      break;
    case "title":
      if (ev.title) els.title.textContent = ev.title;
      break;
    case "done":
      aMsg.id = ev.messageId;
      if (ev.sources && ev.sources.length) {
        aMsg.sources = ev.sources;
        renderSources(aMsg);
      }
      break;
    case "error":
      aMsg.content += (aMsg.content ? "\n\n" : "") + "⚠️ " + (ev.message || "Error");
      scheduleRender(aMsg);
      break;
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
  els.send.disabled = state.sending || !els.input.value.trim();
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
  if (!text) return;
  els.input.value = "";
  autosize();
  els.send.disabled = true;
  sendMessage(text);
});
els.newChat.addEventListener("click", () => {
  if (state.sending) return;
  resetToEmpty();
  els.input.focus();
});

document.addEventListener("click", (e) => {
  const chip = e.target.closest(".chip-suggest");
  if (chip && !state.sending) {
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
