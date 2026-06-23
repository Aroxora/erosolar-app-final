# 02 — Tavily Deep Integration: a real live-web spine

Erosolar already exposes two Tavily tools to the model: `web_search` (ranked
snippets) and `web_extract` (full page text for specific URLs), and it persists
what it learns to memory. That's the foundation. This doc is about getting the
*full* value out of the integration.

## What we have today

- **web_search** — `/search`, advanced depth, 6 results, snippets fed to the model.
- **web_extract** — `/extract`, up to 5 URLs, full text (3k chars to the model,
  6k kept for memory), idempotent per-URL memory.
- **Multi-round loop** — up to 4 tool rounds, then a forced text answer.
- **Sources surfaced** to the user and **persisted with citations** in memory.

## Where the leverage is

### 1. A real research loop (search → triage → extract → synthesize)
Snippets are often not enough. The high-value pattern is: search broadly →
let the model pick the 1–3 best results → `web_extract` those for full text →
synthesize a grounded, cited answer. We already *enable* this (the model can
chain the tools), but we can make it the default behavior for research-shaped
questions via the system prompt, and reward "extract the best source before
answering" over "answer from snippets."

### 2. Endpoints we're not using yet
- **`/crawl`** — follow a site's internal links from a starting URL. Perfect for
  "read this whole docs site / this company's blog and summarize." Add a
  `web_crawl` tool (cap depth/pages) for deep single-domain understanding.
- **`/map`** — get a site's URL structure fast, cheaply, before deciding what to
  extract. Good as a pre-step to crawl/extract so the model spends its budget
  wisely.
- **Search parameters we ignore** — `topic: "news"` for fresher news ranking,
  `time_range` / `days` for recency windows, `include_domains` /
  `exclude_domains` to trust or avoid specific sources, `include_answer` for a
  quick Tavily-synthesized answer to seed reasoning, `include_raw_content` to
  skip a second extract call when a search result is already promising.

### 3. Freshness as a first-class signal
For anything time-sensitive (news, prices, releases, scores, "latest"), use
`topic:"news"` + `time_range` and *say the retrieval date* in the answer. Pair
with memory: when a stored web memory is older than its likely shelf-life,
re-fetch instead of trusting the cached fact (the system prompt already nudges
"unless they may have changed" — make it concrete with timestamps).

### 4. Trust and citation quality
- Always cite, always link, never fabricate a URL (already in the prompt).
- Prefer primary sources; let the model down-rank content farms via
  `exclude_domains`.
- When sources disagree, *say so* and show the split rather than averaging into
  a bland claim — this is where candor (doc 01) and grounding reinforce.

### 5. Standing/monitoring research
Combine Tavily with scheduled execution (doc 03): a nightly job that searches
the user's tracked topics, extracts what's new, and writes a "what changed"
digest into memory — so the next time they ask, Erosolar is already current.

## Cost/quality guardrails (don't skip)
The recent review flagged the real risks here, already partly addressed:
- Extract payloads are re-billed on every tool round — keep the model-facing
  slice small (3k) while persisting the richer text (6k). Done; keep it that way
  if adding `/crawl` (crawls can be huge — summarize per-page before feeding).
- Persisted web memory is idempotent per URL and TTL'd — keep new web tools on
  the same discipline so the memory store doesn't bloat.
- Cap crawl depth/pages hard; a runaway crawl is the easiest way to blow latency
  and Tavily quota.

## Net
Tavily turns Erosolar from "a model that sometimes guesses" into "an assistant
that reads the actual web and shows its work." Search + extract is the floor;
crawl + map + freshness params + a deliberate research loop + monitoring is the
ceiling — and it's most of what "most useful" means in practice.
