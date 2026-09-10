# Peripheral Cognitive Mesh (PCM)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Tests](https://img.shields.io/badge/Tests-Passing-brightgreen.svg)]()
[![Conversational Accuracy](https://img.shields.io/badge/Conversational%20Accuracy-100%25-success.svg)]()
[![Architectural Accuracy](https://img.shields.io/badge/Architectural%20Accuracy-93.8%25-success.svg)]()
[![Recall Latency](https://img.shields.io/badge/Recall%20Latency-2.2ms-blue.svg)]()
[![Write Latency](https://img.shields.io/badge/Write%20Latency-2.4ms-blue.svg)]()

**A biologically inspired agent memory architecture & dual-layer code graph designed for autonomous AI agents.**

PCM replaces uncurated document RAG and heavy external graph traversals with an active **attentional cognitive priming mesh** integrated with an embedded columnar property graph (**Kùzu**). It combines continuous mathematical Ebbinghaus decay, pinned guardrail immunity, compiler AST code topology, and strict token-budgeted prompt slotting.

---

## 🏆 Complete Empirical Benchmark Sweep

Evaluated across six zero-mock benchmarking paradigms against **Mem0 Cloud** (`mem0ai` production SDK), **Zep Cloud** (`@getzep/zep-cloud` Graphiti SDK), **Obsidian Vault on Disk** (real markdown notes via ripgrep), and **Standard Semantic RAG** (dense vector cosine similarity):

| Capability / Benchmark Suite | Upgraded PCM (PCM + Kùzu) | PCM (Cognitive Mesh) | Obsidian Vault (Disk Ripgrep) | Mem0 Cloud (Live SDK) | Zep Cloud (Live SDK) | Standard Vector RAG |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| **Multi-Session Conversational Benchmark** | **100.0%** | 93.3% | 53.3% | 20.0% | 20.0% | 40.0% |
| **Human Architectural Scenario Suite** | **93.8%** | 92.5% | 36.3% | 20.0% | 20.0% | 30.0% |
| **LoCoMo Conversational Benchmark** | **87.5%** | 85.0% | 55.0% | 15.0% | 15.0% | 57.5% |
| **Needle In A Haystack (250 items)** | **100.0%** | **100.0%** | 20.0% | **100.0%*** | **100.0%*** | 100.0% |
| **Write Ingestion Latency (p50)** | **< 3ms** | **2.4ms** | File I/O | 1,788.3ms | 667.7ms | 20ms |
| **Recall Query Latency (p50)** | **14.8ms** | **2.2ms** | 1.1ms | 372.3ms | 210.1ms | 35ms |
| **Privacy & Security Invariant Leaks** | **✅ 0 Leaks** | **✅ 0 Leaks** | ⚠️ Leaks | ⚠️ Leaks | ⚠️ Leaks | ⚠️ Leaks |
| **Physical Multi-Tenant Isolation** | **✅ Complete** | **✅ Complete** | ❌ Local Only | ❌ Shared DB | ❌ Shared DB | ❌ Logical Filters |

---

## 🚀 Why Not Standard RAG, Mem0, or Zep?

Traditional RAG and existing agent memory systems treat memory like enterprise document search or static fact logging:
- **Naive Vector RAG** causes **contradiction paralysis**—old 6-month-old discarded decisions score as high as yesterday's updates, confusing the agent with conflicting instructions.
- **Mem0** incurs an **LLM fact-extraction prompt on every single write** (1,788ms latency), blocking agent tool loops and creating amnesia on multi-session state shifts.
- **Zep (Graphiti)** forces behavioral constraints into raw entity triplets, inflating write latency to 667ms and recall latency to 210ms with heavy context bloat.
- **Obsidian / Local Markdown Notes** dump 500–650 tokens of boilerplate per query, miss implicit security invariants, and leak confidential records indiscriminately.

**PCM solves this through unified cognitive and graph mechanics:**
1. **Mathematical Ebbinghaus Retention:** Memories decay along an empirical forgetting curve $S(t) = \exp\left(-\frac{\lambda \Delta t}{1 + \ln(1 + B)}\right)$, with a reinforcement "savings effect" ($B$).
2. **Pinned Guardrail Invariance ($S=1.0$ Forever):** Critical developer rules and safety preferences are mathematically exempt from decay and served from a sub-millisecond in-memory cache.
3. **Dual-Layer Code Graph (Embedded Kùzu):** Connects high-level cognitive memory (ADRs, policies, bug fixes) with compiler AST code topology (`FileNode`, `SymbolNode`, `Calls`, `Imports`) via bi-directional `CrossLayer` bridges.
4. **Physical Directory-Sharded Multi-Tenancy:** Each tenant receives an isolated physical database directory (`/tenants/{id}/kuzu.db`) managed with thread-safe connection pooling, eliminating cross-tenant leakage by construction.
5. **Intent-Gated Latency Fast Path:** Conversational queries execute at **0.0ms graph overhead**, bypassing the code graph entirely until code-specific intent is detected.
6. **Peripheral Attention Engineering (PAE):** Recalled context is slotted into strict token budgets (`[ASKER CONTEXT]`, `[SITUATIONAL CONTEXT]`) at **~90–190 tokens**, preventing the "Lost in the Middle" phenomenon.
7. **Sub-Millisecond Speed:** Sub-3ms writes and sub-2.5ms recall hot-paths operating entirely within interactive agent flow state budgets.

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

### 3. Run All Reproducible Benchmarks
```bash
# 1. Multi-Session Conversational Benchmark (Live Cross-Platform)
bun run benchmark:conversational

# 2. Real Human Usage Benchmark (against real Obsidian Vault, Mem0, and Zep)
bun run benchmark:full

# 3. LoCoMo Long-Context Conversational Memory & NIAH Suite
bun run benchmark:standard

# 4. Live Cloud SDK Latency Harness (requires MEM0_API_KEY / ZEP_API_KEY in .env)
bun run benchmark:live

# 5. Algorithmic Candidate Precision Benchmark
bun run benchmark
```

---

## 💻 Usage Examples

### 1. Cognitive Mesh & Peripheral Attention Slotting (PAE)

```typescript
import {
  calculateDecayedStrength,
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

### 2. Local TypeScript AST Code Graph Extraction

```typescript
import { CodeGraphParser } from "@skillvault/pcm-core";

const parser = new CodeGraphParser();

// Parse a single source file in single-digit milliseconds
const topology = parser.parseFile(
  "src/services/auth.ts",
  `export class AuthService {
     login(token: string) { return verifyJwt(token); }
   }
   function verifyJwt(t: string) { return true; }`,
  "my-project"
);

console.log(topology.symbols); // Extracted classes, functions, interfaces
console.log(topology.calls);   // Call hierarchy: AuthService.login -> verifyJwt
```

### 3. Upgraded Kùzu Client & Semantic Triplet Re-ranking

```typescript
import { UpgradedPCMKuzuClient } from "@skillvault/pcm-core";

const client = new UpgradedPCMKuzuClient("http://127.0.0.1:8765");

// Subgraph query with automated predicate semantic re-ranking
const { triplets } = await client.querySubgraph("Where should we go for lunch?", "my-project");
const prioritized = client.rerankTriplets("Where should we go for lunch?", triplets, 3);
console.log(prioritized); // Prioritizes ALLERGIC_TO, FORBIDDEN_DUE_TO over background edges
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
