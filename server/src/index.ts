import { timingSafeEqual } from "node:crypto";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { DEFAULT_DECAY_RATE } from "../../src/index.ts";
import { createEmbedder } from "./embedder.ts";
import { createPgvectorIndex } from "./pgvector.ts";
import { createMcpServer, ingestItem, splitSessionItems, TenantRegistry, sha256Hex } from "./server.ts";
import { SCHEMA_VERSION } from "./store.ts";

export interface TenantToken {
  tenant: string;
  digest: Buffer;
}

export interface PcmConfig {
  host: string;
  port: number;
  dataDir: string;
  tokens: TenantToken[];
  ollamaBaseUrl: string | null;
  ollamaToken: string | null;
  embeddingModel: string;
  decayRate: number;
  pgvectorDsn: string | null;
}

export function parseTokens(raw: string): TenantToken[] {
  return raw
    .split(",")
    .map((pair) => pair.trim())
    .filter((pair) => pair.length > 0)
    .map((pair) => {
      const idx = pair.indexOf("=");
      if (idx <= 0) throw new Error(`invalid PCM_TOKENS entry: "${pair}" (expected name=TOKEN)`);
      const tenant = pair.slice(0, idx).trim();
      const token = pair.slice(idx + 1).trim();
      if (!tenant || !token) {
        throw new Error(`invalid PCM_TOKENS entry: "${pair}" (expected name=TOKEN)`);
      }
      return { tenant, digest: Buffer.from(sha256Hex(token), "hex") };
    });
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): PcmConfig {
  const rawTokens = env.PCM_TOKENS;
  if (!rawTokens || rawTokens.trim().length === 0) {
    throw new Error("PCM_TOKENS is required (format: hermes=TOKEN1,claude=TOKEN2)");
  }
  return {
    host: env.PCM_HOST ?? "0.0.0.0",
    port: Number(env.PCM_PORT ?? 3600),
    dataDir: env.PCM_DATA_DIR ?? "/data/tenants",
    tokens: parseTokens(rawTokens),
    ollamaBaseUrl: env.OLLAMA_BASE_URL?.trim() ? env.OLLAMA_BASE_URL.trim() : null,
    ollamaToken: env.OLLAMA_TOKEN?.trim() ? env.OLLAMA_TOKEN.trim() : null,
    embeddingModel: env.PCM_EMBEDDING_MODEL ?? "nomic-embed-text",
    decayRate: Number(env.PCM_DECAY_RATE ?? DEFAULT_DECAY_RATE),
    pgvectorDsn: env.PGVECTOR_DSN?.trim() ? env.PGVECTOR_DSN.trim() : null,
  };
}

export function verifyToken(config: PcmConfig, authorization: string | null): string | null {
  if (!authorization) return null;
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  if (!match) return null;
  const presented = Buffer.from(sha256Hex(match[1]!), "hex");
  for (const entry of config.tokens) {
    if (timingSafeEqual(presented, entry.digest)) {
      return entry.tenant;
    }
  }
  return null;
}

async function main(): Promise<void> {
  let config: PcmConfig;
  try {
    config = loadConfig();
  } catch (err) {
    console.error(`fatal: ${(err as Error).message}`);
    process.exit(1);
  }

  const embedder = createEmbedder({
    baseUrl: config.ollamaBaseUrl,
    apiKey: config.ollamaToken,
    model: config.embeddingModel,
    timeoutMs: 3000,
  });
  const pgvector = createPgvectorIndex(config.pgvectorDsn);
  if (pgvector) {
    const reachable = await pgvector.ping();
    console.log(
      `pgvector: ${pgvector.status} (host: ${pgvector.host ?? "?"})${
        reachable ? "" : " — unreachable; ANN recall disabled, sqlite fallback active"
      }`,
    );
  }
  const registry = new TenantRegistry(config.dataDir, embedder, config.decayRate, pgvector);
  const tenantNames = config.tokens.map((t) => t.tenant);

  const server = Bun.serve({
    hostname: config.host,
    port: config.port,
    async fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/healthz" && req.method === "GET") {
        return Response.json({
          status: "ok",
          tenants: tenantNames,
          embedding: embedder.mode,
          schemaVersion: SCHEMA_VERSION,
          tenantStores: registry
            .opened()
            .map((ctx) => ({ tenant: ctx.tenant, schemaVersion: ctx.store.storedSchemaVersion() })),
          pgvector: pgvector?.status ?? "disabled",
          pgvectorHost: pgvector?.host ?? null,
        });
      }

      if (url.pathname === "/ingest" && req.method === "POST") {
        const tenant = verifyToken(config, req.headers.get("authorization"));
        if (!tenant) {
          return Response.json({ error: "unauthorized" }, { status: 401 });
        }
        const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
        if (!body || typeof body.text !== "string" || body.text.trim().length === 0) {
          return Response.json({ error: "text is required" }, { status: 400 });
        }
        const ctx = registry.get(tenant);
        // Page-level granularity degrades recall; split into paragraph blocks
        // (same rule as session_wrap), sharing one sourceRef.
        const items = splitSessionItems([{ content: body.text }]);
        let ingested = 0;
        let deduplicated = 0;
        for (const text of items) {
          const result = await ingestItem(ctx, {
            text,
            importance: "default",
            occurredAt: typeof body.occurredAt === "string" ? body.occurredAt : undefined,
            source: typeof body.source === "string" ? body.source : "api",
            sourceRef: typeof body.sourceRef === "string" ? body.sourceRef : undefined,
          });
          if (result.deduplicated) deduplicated += 1;
          else ingested += 1;
        }
        return Response.json({ tenant, ingested, deduplicated });
      }

      if (url.pathname === "/mcp") {
        const tenant = verifyToken(config, req.headers.get("authorization"));
        if (!tenant) {
          return Response.json({ error: "unauthorized" }, { status: 401 });
        }
        const transport = new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });
        const server = createMcpServer(registry.get(tenant));
        try {
          await server.connect(transport);
          return await transport.handleRequest(req);
        } finally {
          transport.close();
          await server.close();
        }
      }

      return Response.json({ error: "not found" }, { status: 404 });
    },
  });

  console.log(
    `pcm-server listening on ${config.host}:${server.port} (tenants: ${tenantNames.join(", ")}, embedding: ${embedder.mode}, pgvector: ${pgvector?.status ?? "disabled"})`,
  );
}

main();
