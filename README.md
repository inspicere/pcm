# Peripheral Cognitive Mesh (PCM)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Tests](https://img.shields.io/badge/Tests-Passing-brightgreen.svg)]()
[![Benchmark](https://img.shields.io/badge/Top--1%20Accuracy-100%25-success.svg)]()
[![Recall Latency](https://img.shields.io/badge/Recall%20Latency-%3C30ms-blue.svg)]()

**A biologically inspired agent memory architecture designed for autonomous AI agents.**

PCM replaces uncurated document RAG and heavy entity graph traversals with an active **attentional cognitive priming mesh** that models continuous Ebbinghaus decay, pinned guardrail immunity, Hebbian spreading activation, and strict token-budgeted prompt slotting.

---

## 🚀 Why Not Standard RAG, Mem0, or Zep?

Traditional RAG and early agent memory systems treat memory like enterprise document search or static fact logging:
- **Naive RAG** causes **decision paralysis**—old 6-month-old discarded decisions score as high as yesterday's updates, confusing the agent with contradictory instructions.
- **Mem0** incurs an **LLM call on every single write** (800ms–2,500ms latency) and lacks continuous time dynamics, resulting in stale rule accumulation.
- **Zep (Graphiti)** forces developer behavioral constraints into **entity-relation triples**, fragmenting rules and inflating recall latency to **155ms–250ms** with heavy token bloat.

**PCM solves this through mathematical cognitive mechanics:**
1. **Mathematical Ebbinghaus Retention:** Memories decay along an empirical forgetting curve $S(t) = \exp\left(-\frac{\lambda \Delta t}{1 + \ln(1 + B)}\right)$, with a reinforcement "savings effect" ($B$).
2. **Pinned Guardrail Invariance ($S=1.0$ Forever):** Critical developer rules and safety preferences are mathematically exempt from decay and served from a sub-millisecond in-memory cache.
3. **Peripheral Attention Engineering (PAE):** Recalled context is slotted into strict token budgets (`[ASKER CONTEXT]`, `[SITUATIONAL CONTEXT]`) at **~93 tokens**, preventing the "Lost in the Middle" phenomenon.
4. **Conditional Fast-Path Latency:** Sub-30ms median recall via a margin heuristic gate $\mathcal{H}(\mathbf{s})$, and sub-2ms hot-path writes.

---

## 📊 Benchmark Results

Reproducible across 6 real-world agent memory challenges (paraphrased search, cross-project disambiguation, temporal contradictions, distractor floods, git milestones, and session wraps):

```
=====================================================================================================================
             PERIPHERAL COGNITIVE MESH (PCM) vs. AGENT MEMORIES & RETRIEVAL BASELINES                                 
=====================================================================================================================

┌───┬─────────────────────────────────┬──────────────┬──────────────┬───────┬─────────────────┬────────────────┬─────────────────┬────────────────────────┐
│   │ Memory Architecture             │ Hit Rate @ 1 │ Hit Rate @ 3 │ MRR   │ Avg Tokens/Turn │ Recall Latency │ Ingest Latency  │ Temporal Contradiction │
├───┼─────────────────────────────────┼──────────────┼──────────────┼───────┼─────────────────┼────────────────┼─────────────────┼────────────────────────┤
│ 0 │ Peripheral Cognitive Mesh (PCM) │ 100.0%       │ 100.0%       │ 1.000 │ 93 tokens       │ < 30ms (p50)   │ < 2ms (p50)     │ ✅ Resolved            │
│ 1 │ Temporal Graph (Zep / Graphiti) │ 66.7%        │ 83.3%        │ 0.783 │ 145 tokens      │ 155ms – 250ms  │ 800ms – 1,500ms │ ✅ Resolved            │
│ 2 │ Fact Vector (Mem0)              │ 16.7%        │ 83.3%        │ 0.478 │ 195 tokens      │ 55ms – 600ms   │ 800ms – 2,500ms │ ❌ Failed (Amnesia)    │
│ 3 │ Hybrid RAG (Vector + BM25)      │ 66.7%        │ 83.3%        │ 0.783 │ 264 tokens      │ 45ms – 80ms    │ 25ms – 50ms     │ ✅ Resolved            │
│ 4 │ Naive RAG (Vector Dump)         │ 16.7%        │ 83.3%        │ 0.478 │ 325 tokens      │ 35ms – 60ms    │ 20ms – 40ms     │ ❌ Failed (Amnesia)    │
└───┴─────────────────────────────────┴──────────────┴──────────────┴───────┴─────────────────┴────────────────┴─────────────────┴────────────────────────┘
```

---

## 🛠️ Quickstart

### 1. Clone & Install
```bash
git clone https://github.com/anthonylee991/pcm.git
cd pcm
bun install
```

### 2. Run the Unit Test Suite
```bash
bun test
```

### 3. Run the Comparative Benchmark
```bash
bun run benchmark
```

### 4. Run the Live Head-to-Head Harness (against real Mem0 and Zep SDKs)
```bash
# Optional: Set keys in .env to call real external services
# OPENAI_API_KEY=sk-... (for Mem0 OSS)
# MEM0_API_KEY=m0-...   (for Mem0 Cloud)
# ZEP_API_KEY=z_...     (for Zep Cloud)

bun run benchmark:live
```

---

## 💻 Usage Example

```typescript
import {
  calculateDecayedStrength,
  calculateReRankScore,
  buildPAESlots,
  formatSlotsToMarkdown,
  PinnedGuardrailsCache,
} from "@skillvault/pcm-core";

// 1. In-memory pinned guardrail cache (< 0.5ms)
const pinnedCache = new PinnedGuardrailsCache();
pinnedCache.set("user-1", [{
  id: "rule-1",
  userId: "user-1",
  text: "Always use Bun runtime for scripts; never run ts-node or npm",
  importance: "pinned",
  strength: 1.0,
  createdAt: new Date(),
}]);

// 2. Compute dynamic decay for situational context
const daysAgo = 14;
const elapsedMs = daysAgo * 24 * 60 * 60 * 1000;
const strength = calculateDecayedStrength(0.70, elapsedMs, 0, "default");

// 3. Peripheral Attention Engineering (PAE) Slotted Output
const slots = buildPAESlots({
  userQuery: "How should I run the database migration?",
  askerItems: [
    { memoryId: "rule-1", text: "Always use Bun runtime for scripts", importance: "pinned", strength: 1.0 },
  ],
  situationalItems: [
    { memoryId: "mem-2", text: "Database migrations run via bun scripts/migrate.ts" },
  ],
});

const promptPriming = formatSlotsToMarkdown(slots);
console.log(promptPriming);
```

---

## 📄 Technical Specification & Whitepaper

Read the complete mathematical proofs, activation decay equations, and architecture breakdown in [`PCM-SPEC.md`](PCM-SPEC.md).

---

## 📜 License & Citation

MIT License © 2026 Anthony Lee.

```bibtex
@article{skillvault2026pcm,
  title={Peripheral Cognitive Mesh (PCM): A Biologically-Inspired Memory Architecture for Autonomous AI Agents},
  author={Anthony Lee},
  year={2026},
  url={https://github.com/anthonylee991/pcm}
}
```
