import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  calculateDecayedStrength,
  getInitialStrength,
  isInvariantContent,
  PinnedGuardrailsCache,
} from "../../src/index.ts";
import type { Importance, TenantStore } from "./store.ts";
import { sha256Hex, TenantStore } from "./store.ts";

export { sha256Hex };
import type { Embedder } from "./embedder.ts";
import type { AnnIndex } from "./pgvector.ts";
import { recall } from "./scoring.ts";

const OccurredAtSchema = z
  .string()
  .datetime({ offset: true })
  .optional()
  .or(z.string().datetime().optional());

/**
 * A future occurredAt clamps to zero elapsed time in the decay math, which
 * grants permanent decay immunity without needing importance=pinned (audit
 * finding 1.H2). Reject anything beyond a small clock-skew window. Callers
 * that speak HTTP should turn the throw into a 4xx; the MCP tool surface
 * surfaces it as a tool error.
 */
export const MAX_FUTURE_SKEW_MS = 24 * 60 * 60 * 1000;

export function validateOccurredAt(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`occurredAt must be an ISO-8601 datetime, got '${value}'`);
  }
  if (parsed > Date.now() + MAX_FUTURE_SKEW_MS) {
    throw new Error(`occurredAt is more than 24h in the future (${value})`);
  }
  return value;
}

export const IngestInputSchema = {
  text: z.string().trim().min(1, "Memory text cannot be empty"),
  importance: z.enum(["pinned", "high", "default"]).default("default"),
  occurredAt: OccurredAtSchema,
  source: z.string().trim().min(1).optional(),
  sourceRef: z.string().trim().min(1).optional(),
};

export const IngestOutputSchema = {
  id: z.string().nullable(),
  bodyHash: z.string(),
  strength: z.number().optional(),
  decayedStrengthNow: z.number().optional(),
  deduplicated: z.boolean(),
  blocked: z.boolean().optional(),
  reason: z.string().nullable().optional(),
};

export const RecallInputSchema = {
  query: z.string().trim().min(1, "Recall query cannot be empty"),
  k: z.coerce.number().int().positive().max(50).default(5),
  includeStale: z.coerce.boolean().default(false),
};

export const RecallOutputSchema = {
  slots: z.object({
    user_query: z.string(),
    direct_answer: z.array(z.string()),
    asker_context: z.array(
      z.object({
        memoryId: z.string(),
        text: z.string(),
        importance: z.enum(["pinned", "high", "default"]),
        strength: z.number(),
      }),
    ),
    situational_context: z.array(
      z.object({
        memoryId: z.string(),
        text: z.string(),
        occurredAt: z.string().optional(),
      }),
    ),
    anomaly_flags: z.array(z.any()),
  }),
  markdown: z.string(),
  tokenEstimate: z.number(),
  latencyMs: z.number(),
};

export const SessionWrapInputSchema = {
  sessionId: z.string().trim().min(1),
  turns: z
    .array(
      z.object({
        role: z.enum(["user", "assistant", "system"]),
        content: z.string().min(1),
      }),
    )
    .min(1),
  occurredAt: OccurredAtSchema,
};

export const SessionWrapOutputSchema = {
  sessionId: z.string(),
  ingested: z.number(),
  deduplicated: z.number(),
  blocked: z.number(),
};

export const RetractInputSchema = z
  .object({
    text: z.string().trim().min(1).optional(),
    id: z.string().trim().min(1).optional(),
    reason: z.string().trim().min(1, "reason is required"),
  })
  .refine((v) => Boolean(v.text) !== Boolean(v.id), {
    message: "exactly one of text/id must be provided",
  });

export const RetractOutputSchema = {
  id: z.string(),
  bodyHash: z.string(),
  retractedAt: z.string().nullable(),
  alreadyRetracted: z.boolean(),
  auditSeq: z.number().nullable(),
  reason: z.string(),
};

export const CorrectInputSchema = z
  .object({
    oldText: z.string().trim().min(1).optional(),
    oldId: z.string().trim().min(1).optional(),
    newText: z.string().trim().min(1, "newText cannot be empty"),
    reason: z.string().trim().min(1, "reason is required"),
    importance: z.enum(["pinned", "high", "default"]).optional(),
  })
  .refine((v) => Boolean(v.oldText) !== Boolean(v.oldId), {
    message: "exactly one of oldText/oldId must be provided",
  });

export const CorrectOutputSchema = {
  oldId: z.string(),
  oldHash: z.string(),
  newId: z.string(),
  newHash: z.string(),
  importance: z.enum(["pinned", "high", "default"]),
  auditSeq: z.number(),
  reason: z.string(),
};

export interface TenantContext {
  tenant: string;
  store: TenantStore;
  embedder: Embedder;
  pinnedCache: PinnedGuardrailsCache;
  decayRate: number;
  pgvector: AnnIndex | null;
}

export interface IngestItemInput {
  text: string;
  importance?: Importance;
  occurredAt?: string;
  source?: string;
  sourceRef?: string;
  /**
   * Invariant auto-pinning (isInvariantContent) applies only to deliberate
   * single-item ingests (the memvault_ingest tool). Bulk pipelines (/ingest,
   * session_wrap) leave it off: on a real corpus the vendor's invariant
   * patterns false-positive ("never disclosed at signup" etc.) and flood the
   * pinned cache (finding F4).
   */
  autoPinInvariant?: boolean;
}

export type IngestResult =
  | {
      id: string;
      bodyHash: string;
      strength: number;
      decayedStrengthNow: number;
      deduplicated: false;
      blocked: false;
    }
  | { id: string; bodyHash: string; deduplicated: true }
  | { id: null; bodyHash: string; blocked: true; reason: string | null; deduplicated: false };

export async function ingestItem(ctx: TenantContext, input: IngestItemInput): Promise<IngestResult> {
  const text = input.text.trim();
  const bodyHash = sha256Hex(text);
  // Denylist first: a purged hash has no row left, and even when a live row
  // still exists the policy block must win over dedup. A block is a normal
  // policy outcome, not an error, so this returns instead of throwing.
  if (ctx.store.isDenied(bodyHash)) {
    return { id: null, bodyHash, blocked: true, reason: ctx.store.deniedReason(bodyHash), deduplicated: false };
  }
  const existing = ctx.store.getByHash(bodyHash);
  if (existing) {
    return { id: existing.id, bodyHash, deduplicated: true };
  }

  const importance: Importance =
    input.importance === "pinned" || (input.autoPinInvariant && isInvariantContent(text))
      ? "pinned"
      : (input.importance ?? "default");
  // getInitialStrength also auto-pins invariant text internally; only consult
  // text-patterns when the caller opted into invariant auto-pinning (F4).
  const strength = getInitialStrength(importance, input.autoPinInvariant ? text : undefined);
  // Throws on malformed or far-future values; a NaN date would otherwise
  // flow into scoring and defeat the stale filter (finding 2.H2).
  const occurredAt = validateOccurredAt(input.occurredAt) ?? new Date().toISOString();

  const embedding = await ctx.embedder.embed(text);
  const row = ctx.store.insert({
    id: crypto.randomUUID(),
    bodyHash,
    text,
    importance,
    strength,
    occurredAt,
    embedding,
    source: input.source,
    sourceRef: input.sourceRef,
  });
  if (embedding && ctx.pgvector) {
    await ctx.pgvector.upsert(ctx.tenant, row.id, row.body_hash, embedding).catch((err) => {
      console.warn(`pgvector upsert failed for tenant ${ctx.tenant}: ${(err as Error).message}`);
    });
  }
  return {
    id: row.id,
    bodyHash,
    strength: row.strength,
    decayedStrengthNow: calculateDecayedStrength(
      row.strength,
      0,
      row.boost_count,
      row.importance,
      ctx.decayRate,
      row.text,
    ),
    deduplicated: false,
    blocked: false,
  };
}

export function splitSessionItems(turns: Array<{ content: string }>, maxChars = 500): string[] {
  const items: string[] = [];
  for (const turn of turns) {
    const paragraphs = turn.content.split(/\n{2,}/);
    for (const paragraph of paragraphs) {
      const cleaned = paragraph.replace(/\s+/g, " ").trim();
      if (cleaned.length < 40) continue;
      for (let start = 0; start < cleaned.length; start += maxChars) {
        const chunk = cleaned.slice(start, start + maxChars).trim();
        if (chunk.length >= 40) items.push(chunk);
      }
    }
  }
  return items;
}

/** SQLite stays authoritative; the ANN index is only ever best-effort. */
async function deleteFromAnnBestEffort(ctx: TenantContext, memoryId: string): Promise<void> {
  if (!ctx.pgvector) return;
  await ctx.pgvector.delete(ctx.tenant, memoryId).catch((err) => {
    console.warn(`pgvector delete failed for tenant ${ctx.tenant}: ${(err as Error).message}`);
  });
}

export function createMcpServer(ctx: TenantContext): McpServer {
  const server = new McpServer({ name: "pcm-memvault", version: "0.1.0" });

  server.registerTool(
    "memvault_ingest",
    {
      title: "Ingest a memory",
      description:
        "Store a memory item for this tenant. Idempotent on sha256(text): re-ingesting the same text returns deduplicated=true. importance=pinned pins at strength 1.0; deliberate single ingests also auto-promote invariant content. Bulk paths (REST /ingest, session_wrap) do not auto-promote.",
      inputSchema: IngestInputSchema,
      outputSchema: IngestOutputSchema,
    },
    async (params) => {
      const result = await ingestItem(ctx, { ...params, autoPinInvariant: true });
      return {
        structuredContent: result,
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    },
  );

  server.registerTool(
    "memvault_retract",
    {
      title: "Retract a memory",
      description:
        "Soft-delete a memory (exactly one of text/id): excluded from all recall read paths, but the row stays so re-ingesting the same text still deduplicates and never un-retracts (D1). Idempotent — retracting an already-retracted memory writes no second audit row. Writes a 'retract' row to the append-only corrections log.",
      inputSchema: RetractInputSchema,
      outputSchema: RetractOutputSchema,
    },
    async (params) => {
      const target = params.id ? { id: params.id } : { bodyHash: sha256Hex(params.text!.trim()) };
      const { row, correction } = ctx.store.retract(target, params.reason);
      await deleteFromAnnBestEffort(ctx, row.id);
      const result = {
        id: row.id,
        bodyHash: row.body_hash,
        retractedAt: row.retracted_at,
        alreadyRetracted: correction === null,
        auditSeq: correction?.seq ?? null,
        reason: params.reason,
      };
      return {
        structuredContent: result,
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    },
  );

  server.registerTool(
    "memvault_correct",
    {
      title: "Correct a memory",
      description:
        "Replace a memory (exactly one of oldText/oldId) with corrected text: the old row is retracted and a new live row is inserted with superseded_by linkage, transactionally, with a 'correct' audit row carrying both hashes. The replacement takes the caller-specified importance (default 'high') and never inherits 'pinned' from the target (D4). Rejects self-correction (newText identical to the old text).",
      inputSchema: CorrectInputSchema,
      outputSchema: CorrectOutputSchema,
    },
    async (params) => {
      const target = params.oldId ? { id: params.oldId } : { bodyHash: sha256Hex(params.oldText!.trim()) };
      const { oldRow, newRow, correction } = ctx.store.correct(
        target,
        params.newText,
        params.reason,
        params.importance ?? "high",
      );
      await deleteFromAnnBestEffort(ctx, oldRow.id);
      // Best-effort embedding of the replacement, mirroring ingestItem's policy.
      const embedding = await ctx.embedder.embed(params.newText.trim()).catch(() => null);
      if (embedding) {
        ctx.store.updateEmbedding(newRow.id, embedding);
        if (ctx.pgvector) {
          await ctx.pgvector
            .upsert(ctx.tenant, newRow.id, newRow.body_hash, embedding)
            .catch((err) => {
              console.warn(`pgvector upsert failed for tenant ${ctx.tenant}: ${(err as Error).message}`);
            });
        }
      }
      const result = {
        oldId: oldRow.id,
        oldHash: oldRow.body_hash,
        newId: newRow.id,
        newHash: newRow.body_hash,
        importance: newRow.importance,
        auditSeq: correction.seq,
        reason: params.reason,
      };
      return {
        structuredContent: result,
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    },
  );

  server.registerTool(
    "memvault_recall",
    {
      title: "Recall memories (PAE slots)",
      description:
        "Recall tenant memories as PAE slots: pinned guardrails in asker context (invariants always included), situational context ranked by retrievalScore x Ebbinghaus-decayed strength. Recalled rows get a boost (B savings effect).",
      inputSchema: RecallInputSchema,
      outputSchema: RecallOutputSchema,
    },
    async (params) => {
      const result = await recall(ctx.store, ctx.embedder, params.query, {
        k: params.k,
        includeStale: params.includeStale,
        decayRate: ctx.decayRate,
      }, ctx.pgvector);
      return { structuredContent: result, content: [{ type: "text", text: result.markdown }] };
    },
  );

  server.registerTool(
    "memvault_session_wrap",
    {
      title: "Wrap a session into memories",
      description:
        "Split session turns into <=500-char memory items (paragraph-split, sub-40-char noise skipped) and ingest each with source=session, sourceRef=sessionId, importance=default.",
      inputSchema: SessionWrapInputSchema,
      outputSchema: SessionWrapOutputSchema,
    },
    async (params) => {
      const items = splitSessionItems(params.turns);
      let ingested = 0;
      let deduplicated = 0;
      let blocked = 0;
      for (const text of items) {
        const result = await ingestItem(ctx, {
          text,
          importance: "default",
          occurredAt: params.occurredAt,
          source: "session",
          sourceRef: params.sessionId,
        });
        if (result.deduplicated) deduplicated += 1;
        else if (result.blocked) blocked += 1;
        else ingested += 1;
      }
      const result = { sessionId: params.sessionId, ingested, deduplicated, blocked };
      return {
        structuredContent: result,
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    },
  );

  return server;
}

export class TenantRegistry {
  private tenants = new Map<string, TenantContext>();

  constructor(
    private dataDir: string,
    private embedder: Embedder,
    private decayRate: number,
    private pgvector: AnnIndex | null = null,
  ) {}

  get(tenant: string): TenantContext {
    let ctx = this.tenants.get(tenant);
    if (!ctx) {
      ctx = {
        tenant,
        store: new TenantStore(this.dataDir, tenant),
        embedder: this.embedder,
        pinnedCache: new PinnedGuardrailsCache(),
        decayRate: this.decayRate,
        pgvector: this.pgvector,
      };
      this.tenants.set(tenant, ctx);
    }
    return ctx;
  }

  tenantNames(): string[] {
    return [...this.tenants.keys()];
  }

  /** Already-opened tenant contexts; never opens new stores. */
  opened(): TenantContext[] {
    return [...this.tenants.values()];
  }
}
