# Erosolar

A clean, fast AI chatbot on **Firebase Hosting**, served at **www.ero.solar**.

- **Model:** DeepSeek **v4 Pro** (reasoning model — shows its thinking)
- **Live web search:** Tavily, exposed to the model as a `web_search` tool it calls on demand
- **Auth:** Google SSO (Firebase Auth)
- **History:** every user's chats are stored server-side in Firestore
- **Secrets:** DeepSeek + Tavily keys live only in the Cloud Function (Secret Manager) — never in the browser

## Architecture

```
Browser (Firebase Hosting, www.ero.solar)
  │  Google sign-in (Firebase Auth)
  │  reads its own history from Firestore (live)
  │  POST /api/chat  (Firebase ID token in Authorization header)
  ▼
Cloud Function `api`  (/api/** rewrite, same-origin — no CORS)
  • verifies the ID token
  • loads recent history from Firestore
  • streams DeepSeek v4 Pro  ←→  calls Tavily web_search (multi-round)
  • streams reasoning + answer + sources back as NDJSON
  • writes user + assistant messages to Firestore (Admin SDK)
```

Firestore layout: `users/{uid}/conversations/{cid}/messages/{mid}`.
Security rules let a user read only their own data; **messages are written only by the backend**, so history can't be forged client-side.

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
- **Authentication → Settings → Authorized domains →** add `ero.solar` and `www.ero.solar` (so Google sign-in works on the custom domain).

### Custom domain (www.ero.solar)

**Hosting → Add custom domain → `www.ero.solar`** (and add `ero.solar` with a redirect to `www`). Add the DNS records Firebase shows you at your registrar; the certificate provisions automatically.

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
- Tunables in `functions/index.js`: `MAX_HISTORY`, `MAX_INPUT_CHARS`, `MAX_TOOL_ROUNDS`, `TAVILY_MAX_RESULTS`.

## ⚠️ Security note — rotate these keys

The DeepSeek and Tavily keys were shared in plaintext during setup. Treat them as
compromised: rotate both, then re-run `scripts/set-secrets.sh` with the new values
and redeploy the function. The keys are never committed (they're gitignored) and
never sent to the browser.
