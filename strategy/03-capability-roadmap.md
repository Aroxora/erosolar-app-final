# 03 — Capability Roadmap: what compounds usefulness

Candor (doc 01) and live web (doc 02) are the two biggest levers. This doc is the
backlog of capabilities that compound on top — roughly in priority order, each
tied to what Erosolar already has.

## Tier 1 — already shipped
- **Cross-conversation memory** (Firestore vector search) — recalls relevant
  notes from any past chat, with sources, TTL'd and idempotent.
- **Always-on user profile** — durable facts distilled by the cheap model and
  injected every turn. Reliable "knows who you are."
- **Memory manager** — user can view/forget individual memories or clear all.
- **Live reasoning + streaming answer + source citations.**

## Tier 2 — highest leverage next
1. **Document / file RAG.** Let users upload PDFs, docs, spreadsheets, images
   (or paste URLs → already via extract); chunk + embed into the same
   `text-embedding-005` / Firestore vector store; ground answers in *their*
   material. Same stack, no new infra. This is the most-requested "make it about
   my stuff" feature.
2. **Connectors (with consent).** Gmail, Calendar, Drive are already reachable
   as tools in this environment. "What did I agree to in that email thread?",
   "summarize my week", "find the doc where we discussed X" — grounding in the
   user's real context is a step-change in usefulness.
3. **Profile/memory controls.** Let the user *edit* the profile and pin/correct
   memories ("remember this", "that's wrong, it's actually Y"). Feedback
   (thumbs) → corrections stored as high-priority memories. Turns mistakes into
   learning.

## Tier 3 — agentic & proactive
4. **Multi-step agentic actions.** Beyond read-only tools: draft and send email,
   create calendar events, file issues, fill forms — with a confirm-before-act
   step for anything outbound. The web spine becomes a *do* spine.
5. **Scheduled intelligence.** Cloud Scheduler + the function: nightly digests on
   tracked topics, "remind me / check on X", standing monitors that write fresh
   findings into memory (pairs with doc 02 §5). On Blaze already.
6. **Memory consolidation.** Periodically summarize clusters of related memories
   into higher-level notes and dedupe near-duplicates — keeps recall sharp as the
   store grows (TTL handles aging; consolidation handles quality).

## Tier 4 — modality & reach
7. **Multimodal in/out.** Accept images (analyze a photo, a chart, a screenshot,
   a whiteboard); generate images/diagrams. DeepSeek + an image model.
8. **Voice.** Speech-to-text in, TTS out — hands-free, mobile-first.
9. **Code execution sandbox.** Run code, do data analysis, render plots, verify
   math — "useful" for a huge class of technical questions where the model
   otherwise just *describes* the answer.
10. **Shareable artifacts.** Long answers → exportable docs; conversations →
    shareable links; research → a cited report (a deep-research mode).

## Cross-cutting: the things that make all of it trustworthy
- **Transparency** — always show sources, reasoning on request, and what's in
  memory/profile (done) and what actions will be taken (confirm-before-act).
- **User control** — view/edit/forget everything the assistant knows. Trust is
  the precondition for letting an assistant be this capable.
- **Latency discipline** — stream early, do expensive work (embeds, profile,
  research) in parallel, keep per-round context lean. A useful answer that's slow
  loses to a good answer that's fast.

## The shape of "most useful"
Candid + grounded + remembers you + acts for you + transparent + fast. Erosolar
already has the first three substantially in place. The roadmap above is the path
from "a very good chatbot" to "the assistant someone opens first, for anything."
