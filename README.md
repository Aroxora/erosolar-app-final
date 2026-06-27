# Erosolar

*Erosolar is the AI assistant built by **ErosolarAI**, the company behind it.*

A clean, fast AI assistant on **Firebase Hosting**, served at **www.ero.solar** — and as a native **iOS** app.

- **Model:** DeepSeek **v4 Pro** — a reasoning model that *shows its thinking* before it answers
- **Live web search:** Tavily, exposed to the model as a `web_search` tool it calls on demand (multi-round)
- **Cited answers:** every web-grounded reply links the sources it used
- **Memory:** remembers what matters about you across chats — you can view it, remove individual entries, and clear it all
- **Documents (RAG):** upload a PDF / text file and ask questions grounded in your own material
- **Connectors:** connect Google Calendar / Gmail / Drive and let Erosolar act on your behalf (confirm-before-act)
- **Auth:** Google SSO (Firebase Auth) · **History:** stored per-user in Firestore

---

## What it's good at — a field guide of use cases

These are real prompts you can paste in. Each one is tagged with the capability it
exercises — `web` (live search), `reason` (visible chain-of-thought), `multi`
(multi-round search), `memory`, `rag` (your uploaded docs), `connect` (Google
connectors). They double as a manual test suite: if these all behave well, the app
is healthy.

> Erosolar is an analysis tool. On contested questions it's built to *steelman then
> rebut* — give it a thesis and it argues both sides from current sources, rather
> than just agreeing with you.

### 🌍 Geopolitics & macro — stress-test a thesis from live data

- **`web` `multi` `reason`** — "Is the US dollar's share of global FX reserves actually
  shrinking? Pull the latest IMF COFER numbers, chart the trend since 2000, and tell
  me how much of the decline is real diversification vs. just dollar-valuation effects."
- **`web` `reason`** — "Federal debt is rising while reserve-currency demand for dollars
  softens. Steelman the bear case that this ends in a dollar crisis — then rebut it.
  What would actually have to break, and on what timeline?"
- **`web` `multi`** — "Can the US afford a ~$1.6T annual defense budget given current
  deficits, net interest costs, and debt-to-GDP? Show the math against the latest CBO
  projections and name the tradeoffs."
- **`web` `reason`** — "Compare the survivability of large surface combatants against
  modern anti-ship ballistic and hypersonic missiles (DF-21D / DF-17 class). What does
  the open-source analysis actually say about carrier and battleship vulnerability in
  a contested A2/AD environment?"
- **`web` `multi`** — "Give me the current US–China balance across four axes —
  shipbuilding capacity, semiconductors, energy, and public debt — each with a number
  and a source, then a one-paragraph synthesis of who's gaining."
- **`reason`** — "Lay out the macro mechanics of how a reserve currency *loses* that
  status historically (sterling → dollar). Which preconditions are present today and
  which aren't?"

### 🏗️ Founders & company-building — turn a plan into a checklist

- **`web` `reason`** — "I want to build an AI company under the English name *ErosolarAI*,
  headquartered in Beijing, and incorporate it as a PRC entity rather than a Delaware
  C-corp. Walk me through the real tradeoffs: IP ownership, WFOE vs. VIE structures,
  foreign-investment rules, capital controls, and how each choice affects raising money."
- **`web` `multi`** — "If my app ships from a PRC company, what changes for Apple App
  Store and Google Play distribution, data-residency, and cross-border data transfer
  (PIPL)? Give me a compliance checklist."
- **`web`** — "What does it actually take to build and occupy a commercial skyscraper in
  Beijing's CBD — land-use rights, approvals, rough timeline and capex bands? Cite
  recent examples."
- **`reason` `memory`** — "Remember that I'm pre-incorporation, solo founder, optimizing
  for control over the cap table. Given that, when should I *not* take outside money?"

### ☀️ Energy & solar — the home turf

- **`web` `multi`** — "What's the current record cell efficiency for perovskite-silicon
  tandems, who holds it, and how far is it from the Shockley-Queisser limit?"
- **`web`** — "Summarize this year's biggest shifts in utility-scale battery storage
  costs ($/kWh) and what's driving them."
- **`reason`** — "Explain how a perovskite solar cell works to a smart non-physicist,
  then to a materials engineer. Two passes."

### 🔬 Research & current events — answers that cite themselves

- **`web` `multi`** — "What happened in [topic] this week? Give me the five most
  important developments, each with a primary source, and flag anything still unconfirmed."
- **`web`** — "Compare three competing claims about [contested topic] and tell me where
  the sources disagree and why."

### 📄 Your documents — ground answers in your own material (RAG)

- **`rag`** — Upload a contract / spec / paper, then: "What are the obligations and
  deadlines in this document? Quote the exact clauses."
- **`rag` `reason`** — "Cross-check the claims in the PDF I uploaded against what you can
  find on the web today. Where is it out of date?"
- **`rag` `memory`** — "Summarize my uploaded doc into five bullets and remember the
  summary so I can ask follow-ups next week."

### 🧠 Memory — it learns you, on your terms

- **`memory`** — "From now on, default to metric units and answer in British English."
- **`memory`** — Open **Memory** in the sidebar to *see* exactly what it has stored about
  you, remove anything you don't want it to keep, or clear all of it. Nothing is hidden.

### 🗓️ Connectors — act, with a confirmation step (Google)

- **`connect`** — "What's on my calendar tomorrow, and is there a free 45-minute slot in
  the afternoon?"
- **`connect`** — "Draft a reply to the most recent email from [person] and show it to me
  before sending."
- **`connect`** — "Find files matching *Q3 plan* in my Drive and give me the links and
  last-modified dates." *(Drive search returns file metadata + links; content summarization
  would need a Drive read tool added to the backend.)*

### 💻 Coding & technical work

- **`reason`** — "Here's a stack trace and the function it points at — find the bug,
  explain it, and give me the minimal fix."
- **`web`** — "What's the current recommended way to do [X] in [framework] as of the
  latest release? Link the docs."

### 🧪 Quick smoke test (paste these in order)

1. "Search the web: what's the latest on ero.solar?" → expect a **web-grounded** answer with **source chips**.
2. "Explain your reasoning for that." → expect a visible **reasoning** section above the answer.
3. Upload any PDF, then "What is this document about?" → expect a **doc-grounded** answer.
4. "Remember that my name is Bo." → next chat, "What's my name?" → expect **memory** recall.
5. Open **Memory** → confirm the stored fact is listed and removable.

---

## Architecture

```
Browser (Firebase Hosting, www.ero.solar)  ·  iOS app (WKWebView + native Google Sign-In)
  │  Google sign-in (Firebase Auth)
  │  reads its own history from Firestore (live)
  │  POST /api/chat  (Firebase ID token in Authorization header)
  ▼
Cloud Function `api`  (called directly at its Cloud Run URL for true SSE streaming)
  • verifies the ID token
  • loads recent history + relevant memories + uploaded-doc excerpts from Firestore
  • streams DeepSeek v4 Pro  ←→  calls Tavily web_search (multi-round)
  • streams reasoning + answer + sources back as NDJSON
  • writes user + assistant messages to Firestore (Admin SDK)
```

Firestore layout: `users/{uid}/conversations/{cid}/messages/{mid}`.
Security rules let a user read only their own data; **messages are written only by the
backend**, so history can't be forged client-side.

> Note: the browser calls the function's Cloud Run URL directly rather than the Hosting
> `/api/**` rewrite — Hosting buffers rewrite responses (~60s cap), which would break
> token streaming. CORS is enabled on the function; auth is still enforced via the ID token.

## Analytics

Firebase Analytics (GA4, `measurementId` in `public/firebase-config.js`) is loaded
lazily and **gated on `isSupported()`**, so it's a clean no-op inside the native iOS
WKWebView and cookie-blocked browsers. Instrumented events: `login` / `sign_up` /
`logout`, `conversation_started`, `message_sent`, `new_chat`, `chip_suggest`,
`document_upload`(`_failed`), and `connect_google`. No message content, filenames, or
other PII is sent — only coarse params (e.g. message length, file extension).

## SEO

The public surface is the sign-in page, so SEO targets that single page:
canonical URL, Open Graph + Twitter card (`public/og-image.png`, 1200×630), JSON-LD
(`WebApplication`), plus `public/robots.txt` and `public/sitemap.xml`. Update
`<lastmod>` in the sitemap when the landing page changes materially.

## Deploy

Prereqs: the project is on the **Blaze** (pay-as-you-go) plan — Cloud Functions require billing.

```bash
# 1. Install backend deps
cd functions && npm install && cd ..

# 2. Store the API keys in Secret Manager (gitignored helper with live keys)
bash scripts/set-secrets.sh

# 3. Deploy everything (hosting + function + Firestore rules)
firebase deploy
```

In the **Firebase console** (one-time):
- **Authentication → Sign-in method →** enable **Google**.
- **Firestore Database →** create a database (Native mode) if it doesn't exist.
- **Authentication → Settings → Authorized domains →** add `ero.solar` and `www.ero.solar`.

### Custom domain (www.ero.solar)

**Hosting → Add custom domain → `www.ero.solar`** (and add `ero.solar` with a redirect to
`www`). Add the DNS records Firebase shows you at your registrar; the certificate
provisions automatically.

## Local development

```bash
cd functions && npm install && cd ..
# Give the emulator the keys (gitignored):
printf 'DEEPSEEK_API_KEY="sk-..."\nTAVILY_API_KEY="tvly-..."\n' > functions/.secret.local
firebase emulators:start
```

Open the Hosting emulator URL; `/api/**` is proxied to the local function.

## Configuration

- Model id is `deepseek-v4-pro` (env `DEEPSEEK_MODEL` overrides it in `functions/index.js`).
- Tunables in `functions/index.js`: `MAX_HISTORY_CHARS`, `MAX_INPUT_CHARS`, `MAX_TOOL_ROUNDS`, `TAVILY_MAX_RESULTS`.

## ⚠️ Security note — rotate these keys

The DeepSeek and Tavily keys were shared in plaintext during setup. Treat them as
compromised: rotate both, then re-run `scripts/set-secrets.sh` with the new values and
redeploy the function. The keys are never committed (they're gitignored) and never sent
to the browser.
