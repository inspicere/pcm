import { z } from "zod";

export const ImportanceSchema = z.enum(["pinned", "high", "default"]);
export type Importance = z.infer<typeof ImportanceSchema>;

export const MemoryStateSchema = z.enum(["stm", "ltm", "archived"]);
export type MemoryState = z.infer<typeof MemoryStateSchema>;

export const MemoryScopeSchema = z.object({
  project: z.string().trim().min(1).optional(),
  repo: z.string().trim().min(1).optional(),
  harness: z.string().trim().min(1).optional(),
  branch: z.string().trim().min(1).optional(),
}).optional();
export type MemoryScope = z.infer<typeof MemoryScopeSchema>;

export const IngestTextRequestSchema = z.object({
  text: z.string().trim().min(1, "Memory text cannot be empty"),
  importance: ImportanceSchema.default("default"),
  occurredAt: z.string().datetime({ offset: true }).optional().or(z.string().datetime().optional()),
  scope: MemoryScopeSchema,
  source: z.enum(["cli", "api", "upload", "mcp", "webhook"]).default("api"),
  sourceRef: z.string().optional(),
});
export type IngestTextRequest = z.infer<typeof IngestTextRequestSchema>;

export const IngestBatchRequestSchema = z.object({
  items: z.array(IngestTextRequestSchema).min(1, "Batch must contain at least one item"),
});
export type IngestBatchRequest = z.infer<typeof IngestBatchRequestSchema>;

export const MemoryLensSchema = z.enum(["agent", "personal", "reference", "associative"]);
export type MemoryLens = z.infer<typeof MemoryLensSchema>;

export const RecallRequestSchema = z.object({
  query: z.string().trim().min(1, "Recall query cannot be empty"),
  k: z.coerce.number().int().positive().max(50).default(5),
  lens: MemoryLensSchema.default("agent"),
  scope: MemoryScopeSchema,
  format: z.enum(["slotted", "text", "json"]).default("slotted"),
  includeStale: z.coerce.boolean().default(false),
});
export type RecallRequest = z.infer<typeof RecallRequestSchema>;

export const AskerContextItemSchema = z.object({
  memoryId: z.string().uuid(),
  text: z.string(),
  importance: ImportanceSchema,
  strength: z.number(),
  scope: MemoryScopeSchema.optional(),
});
export type AskerContextItem = z.infer<typeof AskerContextItemSchema>;

export const SituationalContextItemSchema = z.object({
  memoryId: z.string().uuid(),
  text: z.string(),
  occurredAt: z.string().optional(),
  trajectory: z.string().optional(),
  scope: MemoryScopeSchema.optional(),
});
export type SituationalContextItem = z.infer<typeof SituationalContextItemSchema>;

export const AnomalyFlagItemSchema = z.object({
  metric: z.string(),
  value: z.number(),
  baseline: z.number(),
  direction: z.enum(["high", "low"]),
  description: z.string(),
});
export type AnomalyFlagItem = z.infer<typeof AnomalyFlagItemSchema>;

export const PAESlotsSchema = z.object({
  user_query: z.string(),
  direct_answer: z.array(z.string()).default([]),
  asker_context: z.array(AskerContextItemSchema).default([]),
  situational_context: z.array(SituationalContextItemSchema).default([]),
  anomaly_flags: z.array(AnomalyFlagItemSchema).default([]),
});
export type PAESlots = z.infer<typeof PAESlotsSchema>;

export const RecallResponseSchema = z.object({
  slots: PAESlotsSchema,
  format: z.enum(["pae-slotted-v1", "text", "json"]),
  lens: MemoryLensSchema,
  rawText: z.string().optional(),
});
export type RecallResponse = z.infer<typeof RecallResponseSchema>;
