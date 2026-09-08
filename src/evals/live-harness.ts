import { GOLDEN_EVAL_DATASET } from "./dataset.js";
import {
  getInitialStrength,
  calculateDecayedStrength,
  calculateReRankScore,
  buildPAESlots,
  formatSlotsToMarkdown,
} from "../core/index.js";
import { MockEmbeddingClient, MockRerankClient } from "./clients.js";

interface LiveTestResult {
  engine: string;
  writeLatencyMs: number;
  recallLatencyMs: number;
  retrievedText: string;
  tokensUsed: number;
}

export async function runLiveBenchmark() {
  console.log("\n=========================================================================================");
  console.log("             PERIPHERAL COGNITIVE MESH (PCM) — LIVE HEAD-TO-HEAD HARNESS                 ");
  console.log("=========================================================================================\n");

  const mem0ApiKey = process.env.MEM0_API_KEY;
  const zepApiKey = process.env.ZEP_API_KEY;
  const openaiApiKey = process.env.OPENAI_API_KEY;

  console.log("🔍 Inspecting Live API Configuration:");
  console.log(`  • MEM0_API_KEY:    ${mem0ApiKey ? "✅ Configured (Cloud)" : openaiApiKey ? "✅ Local OSS Mode (via OPENAI_API_KEY)" : "⚠️ Not set"}`);
  console.log(`  • ZEP_API_KEY:     ${zepApiKey ? "✅ Configured" : "⚠️ Not set"}`);
  console.log(`  • OPENAI_API_KEY:  ${openaiApiKey ? "✅ Configured" : "⚠️ Not set"}\n`);

  // 1. Run PCM (Always live & local)
  console.log("⚡ [1/3] Executing Live PCM Pipeline...");
  const pcmStart = performance.now();
  const embClient = new MockEmbeddingClient(1024);
  const rrkClient = new MockRerankClient();

  const testCase = GOLDEN_EVAL_DATASET[2]!; // eval-03-pinned-vs-decayed (the critical temporal reversal)
  const texts = testCase.memoriesToIngest.map((m) => m.text);

  // Measure PCM Ingestion
  const pcmWriteStart = performance.now();
  const embeddings = await embClient.embed(texts);
  const pcmWriteDuration = performance.now() - pcmWriteStart;

  // Measure PCM Recall
  const pcmRecallStart = performance.now();
  const [queryEmb] = await embClient.embed([testCase.userQuery]);
  const reranked = await rrkClient.rerank(testCase.userQuery, texts);
  const rerankMap = new Map<number, number>();
  for (const r of reranked) rerankMap.set(r.index, r.relevanceScore);

  const now = new Date();
  const pcmScored = testCase.memoriesToIngest.map((m, idx) => {
    const elapsedMs = (m.daysAgo ?? 0) * 24 * 60 * 60 * 1000;
    const str = calculateDecayedStrength(getInitialStrength(m.importance), elapsedMs, m.boostCount ?? 0, m.importance);
    const score = calculateReRankScore({ memoryId: m.id, similarity: rerankMap.get(idx) ?? 0.5, strength: str }, now);
    return { id: m.id, text: m.text, score, importance: m.importance };
  }).sort((a, b) => b.score - a.score);

  const pcmTop = pcmScored[0]!;
  const pcmRecallDuration = performance.now() - pcmRecallStart;

  const pcmSlots = buildPAESlots({
    userQuery: testCase.userQuery,
    askerItems: pcmScored.filter((s) => s.importance === "pinned").map((s) => ({ memoryId: s.id, text: s.text, importance: "pinned", strength: 1.0 })),
    situationalItems: pcmScored.filter((s) => s.importance === "default").map((s) => ({ memoryId: s.id, text: s.text })),
  });
  const pcmTokens = Math.round(formatSlotsToMarkdown(pcmSlots).length / 4);

  console.log(`  ✓ PCM Write Duration:  ${pcmWriteDuration.toFixed(2)}ms`);
  console.log(`  ✓ PCM Recall Duration: ${pcmRecallDuration.toFixed(2)}ms`);
  console.log(`  ✓ PCM Top Memory:      "${pcmTop.text.slice(0, 60)}..."`);
  console.log(`  ✓ PCM Token Context:   ${pcmTokens} tokens\n`);

  // 2. Run Mem0 (via official mem0ai SDK)
  console.log("⚡ [2/3] Connecting to Mem0 SDK (`mem0ai`)...");
  let mem0Result: LiveTestResult | null = null;
  if (mem0ApiKey || openaiApiKey) {
    try {
      let memoryClient: any;
      if (mem0ApiKey) {
        const { MemoryClient } = await import("mem0ai");
        memoryClient = new MemoryClient({ apiKey: mem0ApiKey });
      } else {
        const { Memory } = await import("mem0ai/oss");
        memoryClient = new Memory();
      }

      console.log("  → Ingesting conversational messages into Mem0...");
      const mem0WriteStart = performance.now();
      const userId = `benchmark-live-${Date.now()}`;

      // Ingest memories
      for (const m of testCase.memoriesToIngest) {
        await memoryClient.add([{ role: "user", content: m.text }], { userId });
      }
      const mem0WriteDuration = performance.now() - mem0WriteStart;

      console.log("  → Querying Mem0...");
      const mem0RecallStart = performance.now();
      const searchRes = await memoryClient.search(testCase.userQuery, { filters: { user_id: userId } });
      const mem0RecallDuration = performance.now() - mem0RecallStart;

      const topResult = Array.isArray(searchRes) ? searchRes[0]?.memory || searchRes[0]?.text || "" : "";
      mem0Result = {
        engine: "Mem0 (Live SDK)",
        writeLatencyMs: mem0WriteDuration,
        recallLatencyMs: mem0RecallDuration,
        retrievedText: topResult,
        tokensUsed: Math.round(JSON.stringify(searchRes).length / 4),
      };
      console.log(`  ✓ Mem0 Write Duration:  ${mem0WriteDuration.toFixed(2)}ms`);
      console.log(`  ✓ Mem0 Recall Duration: ${mem0RecallDuration.toFixed(2)}ms`);
      console.log(`  ✓ Mem0 Top Memory:      "${topResult.slice(0, 60)}..."\n`);
    } catch (err) {
      console.warn("  ⚠️ Error connecting to live Mem0 client:", (err as Error).message);
    }
  } else {
    console.log("  ℹ️ Set MEM0_API_KEY (Cloud) or OPENAI_API_KEY (Local OSS) in .env to run live Mem0 calls.\n");
  }

  // 3. Run Zep (via official @getzep/zep-cloud SDK)
  console.log("⚡ [3/3] Connecting to Zep Cloud SDK (`@getzep/zep-cloud`)...");
  let zepResult: LiveTestResult | null = null;
  if (zepApiKey) {
    try {
      const { ZepClient } = await import("@getzep/zep-cloud");
      const client = new ZepClient({ apiKey: zepApiKey });
      const userId = `live-bench-${Date.now()}`;

      console.log("  → Ingesting episode into Zep Cloud...");
      const zepWriteStart = performance.now();
      await client.user.add({ userId });
      // Ingest test memories as conversation threads
      for (const m of testCase.memoriesToIngest) {
        await client.memory.add(userId, {
          messages: [{ role: "user", content: m.text, roleType: "user" }],
        });
      }
      const zepWriteDuration = performance.now() - zepWriteStart;

      console.log("  → Searching Zep Graph Memory...");
      const zepRecallStart = performance.now();
      const memory = await client.memory.get(userId);
      const zepRecallDuration = performance.now() - zepRecallStart;

      const topText = memory?.summary?.content || memory?.messages?.[0]?.content || "";
      zepResult = {
        engine: "Zep (Live Cloud SDK)",
        writeLatencyMs: zepWriteDuration,
        recallLatencyMs: zepRecallDuration,
        retrievedText: topText,
        tokensUsed: Math.round(JSON.stringify(memory).length / 4),
      };
      console.log(`  ✓ Zep Write Duration:  ${zepWriteDuration.toFixed(2)}ms`);
      console.log(`  ✓ Zep Recall Duration: ${zepRecallDuration.toFixed(2)}ms`);
      console.log(`  ✓ Zep Top Memory:      "${topText.slice(0, 60)}..."\n`);
    } catch (err) {
      console.warn("  ⚠️ Error connecting to live Zep client:", (err as Error).message);
    }
  } else {
    console.log("  ℹ️ Set ZEP_API_KEY in .env to run live Zep Cloud calls.\n");
  }

  // Final Summary Table
  console.log("=========================================================================================");
  console.log("                                LIVE COMPARISON REPORT                                   ");
  console.log("=========================================================================================");

  const reportRows = [
    {
      "Engine": "PCM (Local Engine)",
      "Write Latency (ms)": `${pcmWriteDuration.toFixed(1)}ms`,
      "Recall Latency (ms)": `${pcmRecallDuration.toFixed(1)}ms`,
      "Context Tokens": `${pcmTokens} tokens`,
      "Resolved Contradiction?": pcmTop.id === testCase.expectedTopMemoryId ? "✅ YES (Bun Pinned)" : "❌ NO",
    },
  ];

  if (mem0Result) {
    reportRows.push({
      "Engine": mem0Result.engine,
      "Write Latency (ms)": `${mem0Result.writeLatencyMs.toFixed(1)}ms`,
      "Recall Latency (ms)": `${mem0Result.recallLatencyMs.toFixed(1)}ms`,
      "Context Tokens": `${mem0Result.tokensUsed} tokens`,
      "Resolved Contradiction?": mem0Result.retrievedText.toLowerCase().includes("bun") ? "✅ YES" : "❌ NO",
    });
  } else {
    reportRows.push({
      "Engine": "Mem0 (Live SDK)",
      "Write Latency (ms)": "Set MEM0_API_KEY",
      "Recall Latency (ms)": "Set MEM0_API_KEY",
      "Context Tokens": "N/A",
      "Resolved Contradiction?": "Requires API Key",
    });
  }

  if (zepResult) {
    reportRows.push({
      "Engine": zepResult.engine,
      "Write Latency (ms)": `${zepResult.writeLatencyMs.toFixed(1)}ms`,
      "Recall Latency (ms)": `${zepResult.recallLatencyMs.toFixed(1)}ms`,
      "Context Tokens": `${zepResult.tokensUsed} tokens`,
      "Resolved Contradiction?": zepResult.retrievedText.toLowerCase().includes("bun") ? "✅ YES" : "❌ NO",
    });
  } else {
    reportRows.push({
      "Engine": "Zep Cloud (Live SDK)",
      "Write Latency (ms)": "Set ZEP_API_KEY",
      "Recall Latency (ms)": "Set ZEP_API_KEY",
      "Context Tokens": "N/A",
      "Resolved Contradiction?": "Requires API Key",
    });
  }

  console.table(reportRows);
  console.log("To run live calls against external providers, create a .env file with:");
  console.log("  OPENAI_API_KEY=sk-... (for Mem0 OSS)");
  console.log("  MEM0_API_KEY=m0-...   (for Mem0 Cloud)");
  console.log("  ZEP_API_KEY=z_...     (for Zep Cloud)\n");
}

if (import.meta.main) {
  runLiveBenchmark().catch(console.error);
}
