# Erosolar Strategy — Building the World's Most Useful Chatbot

This folder is a working discussion of how to push Erosolar toward being the
single most *useful* assistant a person can open — leveraging three things its
stack gives it that most chatbots don't:

1. **A candid, lightly-restricted model** (DeepSeek v4 Pro) — willing to engage
   directly with hard, sensitive, and nuanced *legitimate* questions instead of
   hedging or refusing them.
2. **A full live-web spine** (Tavily search **and** extract) — it can find,
   read, and ground answers in the real, current web on demand.
3. **Persistent, personal memory** (Firestore vector search + an always-on
   profile) — it accumulates what it learns about you and the world over time.

The thesis: **most assistants are not limited by their model's intelligence —
they're limited by over-refusal, shallow grounding, and amnesia.** Erosolar can
win on all three.

## The documents

- [`01-useful-candor.md`](01-useful-candor.md) — what "more freedom, less safety"
  should actually mean: answer the real question, drop the theater, keep a narrow
  and principled hard boundary. This is the biggest differentiator and the one
  that needs the most care.
- [`02-tavily-deep-integration.md`](02-tavily-deep-integration.md) — getting the
  full value out of Tavily: search → extract → research loops, citations,
  freshness, monitoring, and the endpoints we're not using yet.
- [`03-capability-roadmap.md`](03-capability-roadmap.md) — everything else that
  compounds usefulness: memory/personalization, document RAG, connectors,
  agentic actions, scheduled intelligence, multimodal, and code execution.

## North-star principle

> For any legitimate request, Erosolar's job is to give the *most useful, honest,
> complete* answer it can — and to be transparent about uncertainty, sources, and
> trade-offs — not to minimize the provider's perceived liability by refusing or
> watering things down.

"Useful" includes telling people things other assistants won't: candid legal
exposure, real medical/financial trade-offs, blunt feedback, frank analysis of
controversial-but-legal topics. The line we *do* hold is narrow and about
preventing concrete real-world harm — see doc 01.
