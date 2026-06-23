"use strict";

/**
 * Erosolar chat backend.
 *
 * A single HTTPS function (`api`) exposed at `/api/chat` via a Firebase Hosting
 * rewrite. It:
 *   1. Verifies the caller's Firebase ID token (Google SSO).
 *   2. Loads the conversation's recent history from Firestore.
 *   3. Streams a DeepSeek v4 Pro completion, giving the model a Tavily-backed
 *      `web_search` tool it can call (multiple rounds) for live information.
 *   4. Streams reasoning, answer tokens, tool activity, and sources back to the
 *      browser as newline-delimited JSON (NDJSON).
 *   5. Persists the user and assistant messages to Firestore (Admin SDK), so
 *      every user's full history lives on the server.
 *
 * API keys are read from Secret Manager (DEEPSEEK_API_KEY, TAVILY_API_KEY) and
 * never reach the client.
 */

const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();

const DEEPSEEK_API_KEY = defineSecret("DEEPSEEK_API_KEY");
const TAVILY_API_KEY = defineSecret("TAVILY_API_KEY");

// ----- Tunables -----
const DEEPSEEK_BASE = "https://api.deepseek.com";
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || "deepseek-v4-pro";
// Full conversation history is sent every turn. This character budget is only a
// safety cap for pathologically long chats (oldest turns drop first); ~200k chars
// ≈ 50k tokens, so normal conversations are included in their entirety.
const MAX_HISTORY_CHARS = 200000;
const MAX_INPUT_CHARS = 16000; // cap on a single user message
const MAX_TOOL_ROUNDS = 4; // web_search iterations before forcing an answer
const TAVILY_MAX_RESULTS = 6;

const SYSTEM_PROMPT = `You are Erosolar, a sharp, friendly, and precise AI assistant.

- Answer clearly and concisely. Use Markdown (headings, lists, tables, fenced code blocks) when it improves readability.
- You have a web_search tool. Call it whenever the user asks about recent events, news, prices, live data, specific people/companies, or anything you are not confident is stable since your training. Do not invent facts that may have changed.
- After searching, ground your answer in the results and cite them inline as [1], [2], ... matching the numbered sources you were given.
- If search returns nothing useful, say so rather than guessing.
- Be honest about uncertainty and never fabricate URLs or quotes.`;

const TOOLS = [
  {
    type: "function",
    function: {
      name: "web_search",
      description:
        "Search the live web for current information, news, facts, prices, or anything beyond your training data. Returns ranked results with titles, URLs, and content snippets.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "A focused, self-contained search query.",
          },
        },
        required: ["query"],
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Tavily web search
// ---------------------------------------------------------------------------
async function tavilySearch(queryText, apiKey) {
  const resp = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: apiKey,
      query: queryText,
      search_depth: "advanced",
      max_results: TAVILY_MAX_RESULTS,
      include_answer: false,
    }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Tavily ${resp.status}: ${text.slice(0, 200)}`);
  }
  const data = await resp.json();
  return (data.results || []).map((r, i) => ({
    n: i + 1,
    title: r.title || r.url,
    url: r.url,
    content: (r.content || "").slice(0, 1200),
  }));
}

// ---------------------------------------------------------------------------
// DeepSeek streaming chat completion.
// Invokes onDelta({ reasoning?, content? }) for each streamed fragment.
// Returns { content, reasoning, toolCalls }.
// ---------------------------------------------------------------------------
async function streamDeepSeek({ messages, apiKey, onDelta, toolChoice = "auto" }) {
  const reqBody = {
    model: DEEPSEEK_MODEL,
    messages,
    stream: true,
    temperature: 0.6,
  };
  // toolChoice "none" => omit tools entirely so the model must answer in text.
  if (toolChoice !== "none") {
    reqBody.tools = TOOLS;
    reqBody.tool_choice = "auto";
  }

  const resp = await fetch(`${DEEPSEEK_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(reqBody),
  });

  if (!resp.ok || !resp.body) {
    const text = await resp.text().catch(() => "");
    throw new Error(`DeepSeek ${resp.status}: ${text.slice(0, 300)}`);
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let reasoning = "";
  const toolCallsByIndex = new Map();

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") continue;

      let json;
      try {
        json = JSON.parse(payload);
      } catch {
        continue;
      }
      const delta = json.choices && json.choices[0] && json.choices[0].delta;
      if (!delta) continue;

      if (delta.reasoning_content) {
        reasoning += delta.reasoning_content;
        onDelta({ reasoning: delta.reasoning_content });
      }
      if (delta.content) {
        content += delta.content;
        onDelta({ content: delta.content });
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const idx = typeof tc.index === "number" ? tc.index : 0;
          const acc =
            toolCallsByIndex.get(idx) || {
              id: "",
              type: "function",
              function: { name: "", arguments: "" },
            };
          if (tc.id) acc.id = tc.id;
          if (tc.function && tc.function.name) acc.function.name = tc.function.name;
          if (tc.function && tc.function.arguments)
            acc.function.arguments += tc.function.arguments;
          toolCallsByIndex.set(idx, acc);
        }
      }
    }
  }

  const toolCalls = [...toolCallsByIndex.values()].filter(
    (t) => t.function && t.function.name
  );
  return { content, reasoning, toolCalls };
}

// ---------------------------------------------------------------------------
// HTTPS entry point
// ---------------------------------------------------------------------------
exports.api = onRequest(
  {
    region: "us-central1",
    secrets: [DEEPSEEK_API_KEY, TAVILY_API_KEY],
    timeoutSeconds: 300,
    memory: "512MiB",
    cors: true,
  },
  async (req, res) => {
    if (req.method === "OPTIONS") {
      res.status(204).send("");
      return;
    }
    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }

    // --- Auth: verify the Firebase ID token ---
    const authz = req.get("Authorization") || "";
    const match = authz.match(/^Bearer (.+)$/);
    if (!match) {
      res.status(401).json({ error: "Missing authentication token" });
      return;
    }
    let uid;
    try {
      const decoded = await admin.auth().verifyIdToken(match[1]);
      uid = decoded.uid;
    } catch {
      res.status(401).json({ error: "Invalid or expired authentication token" });
      return;
    }

    // --- Validate input ---
    const body = req.body || {};
    const conversationId = body.conversationId;
    const message = body.message;
    if (
      typeof conversationId !== "string" ||
      !conversationId ||
      typeof message !== "string" ||
      !message.trim()
    ) {
      res.status(400).json({ error: "conversationId and message are required" });
      return;
    }
    const userText = message.trim().slice(0, MAX_INPUT_CHARS);

    // Path is always scoped to the authenticated uid — a client cannot reach
    // another user's data even by passing a foreign conversationId.
    const convRef = db
      .collection("users")
      .doc(uid)
      .collection("conversations")
      .doc(conversationId);
    const msgsRef = convRef.collection("messages");

    // --- Begin NDJSON stream ---
    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("X-Accel-Buffering", "no");
    const send = (obj) => {
      res.write(JSON.stringify(obj) + "\n");
    };

    try {
      // Load the FULL conversation history (oldest → newest) so Erosolar always
      // considers everything said in this chat.
      const histSnap = await msgsRef.orderBy("createdAt", "asc").get();
      const allHistory = histSnap.docs
        .map((d) => d.data())
        .map((d) => ({
          role: d.role === "assistant" ? "assistant" : "user",
          content: typeof d.content === "string" ? d.content : "",
        }))
        .filter((m) => m.content);
      // Keep within the context budget, preferring the most recent turns; for
      // normal-length conversations this includes every message.
      let budget = MAX_HISTORY_CHARS;
      const kept = [];
      for (let i = allHistory.length - 1; i >= 0; i--) {
        budget -= allHistory[i].content.length;
        if (budget < 0 && kept.length) break;
        kept.push(allHistory[i]);
      }
      const history = kept.reverse();

      // Decide the conversation title from the first message — sent live now,
      // but persisted only on success (below) so failed turns don't litter the
      // sidebar with titled-but-empty conversations.
      const convSnap = await convRef.get();
      const convExists = convSnap.exists;
      const existingTitle = convExists ? convSnap.data().title : null;
      let titleToSet = null;
      if (!existingTitle || existingTitle === "New chat") {
        titleToSet = userText.replace(/\s+/g, " ").slice(0, 60);
        send({ type: "title", title: titleToSet });
      }

      // Build the model conversation.
      const messages = [
        { role: "system", content: SYSTEM_PROMPT },
        ...history,
        { role: "user", content: userText },
      ];

      const deepseekKey = DEEPSEEK_API_KEY.value();
      const tavilyKey = TAVILY_API_KEY.value();
      const sources = []; // deduped {title, url} across all searches

      let assembled = "";
      let finalReasoning = "";

      for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
        const isLastRound = round === MAX_TOOL_ROUNDS;
        const { content, reasoning, toolCalls } = await streamDeepSeek({
          messages,
          apiKey: deepseekKey,
          // Final round forbids tools, so the model must produce an answer
          // instead of ending the turn on an unanswerable tool_calls.
          toolChoice: isLastRound ? "none" : "auto",
          onDelta: ({ reasoning: r, content: c }) => {
            if (r) send({ type: "reasoning", delta: r });
            if (c) send({ type: "content", delta: c });
          },
        });
        finalReasoning += reasoning;
        // Accumulate exactly what the client renders (it appends every delta),
        // so the persisted answer matches what the user saw stream in.
        if (content) assembled += content;

        const wantsTools = toolCalls.length > 0 && !isLastRound;
        if (!wantsTools) break;

        // Record the assistant's tool-call turn, then run each search.
        messages.push({ role: "assistant", content: content || "", tool_calls: toolCalls });
        for (const tc of toolCalls) {
          let query = "";
          try {
            query = String(JSON.parse(tc.function.arguments || "{}").query || "");
          } catch {
            query = "";
          }
          send({ type: "tool", status: "start", name: "web_search", query });

          let results = [];
          try {
            results = await tavilySearch(query, tavilyKey);
          } catch (e) {
            logger.warn("Tavily search failed", { query, error: e.message });
            results = [];
          }
          for (const r of results) {
            if (!sources.some((s) => s.url === r.url)) {
              sources.push({ title: r.title, url: r.url });
            }
          }
          send({
            type: "tool",
            status: "done",
            name: "web_search",
            query,
            count: results.length,
            sources: results.map((r) => ({ title: r.title, url: r.url })),
          });

          messages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: JSON.stringify(
              results.length ? results : [{ note: "No results found." }]
            ),
          });
        }
      }

      const finalContent = assembled;
      if (!finalContent.trim()) {
        // No answer text produced — surface an error instead of saving a blank
        // turn (keeps history clean, avoids an empty assistant bubble).
        send({
          type: "error",
          message: "The model finished without an answer. Please try again or rephrase.",
        });
        res.end();
        return;
      }

      // Persist the user + assistant turn together, and only on success, so a
      // failed request can never orphan a user message and corrupt history.
      const batch = db.batch();
      const ts = admin.firestore.Timestamp.now();
      const userMsgRef = msgsRef.doc();
      batch.set(userMsgRef, { role: "user", content: userText, createdAt: ts });
      const assistantRef = msgsRef.doc();
      batch.set(assistantRef, {
        role: "assistant",
        content: finalContent,
        reasoning: finalReasoning || "",
        sources,
        model: DEEPSEEK_MODEL,
        // +1ms guarantees user-before-assistant ordering under orderBy(createdAt).
        createdAt: admin.firestore.Timestamp.fromMillis(ts.toMillis() + 1),
      });
      const convUpdate = { updatedAt: admin.firestore.FieldValue.serverTimestamp() };
      if (!convExists) convUpdate.createdAt = admin.firestore.FieldValue.serverTimestamp();
      if (titleToSet) convUpdate.title = titleToSet;
      batch.set(convRef, convUpdate, { merge: true });
      await batch.commit();

      send({ type: "done", messageId: assistantRef.id, sources });
      res.end();
    } catch (err) {
      logger.error("chat handler error", { error: err.message, uid });
      try {
        send({ type: "error", message: err.message || "Internal error" });
      } catch {
        /* response already closed */
      }
      res.end();
    }
  }
);
