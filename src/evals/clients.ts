import { createHash } from "node:crypto";

export interface EmbeddingClient {
  embed(texts: string[]): Promise<number[][]>;
  readonly dimensions: number;
  readonly model: string;
}

export class MockEmbeddingClient implements EmbeddingClient {
  readonly dimensions: number;
  readonly model: string;

  constructor(dimensions = 1024, model = "mock-embedding-v1") {
    this.dimensions = dimensions;
    this.model = model;
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => {
      const hash = createHash("sha256").update(text).digest();
      const vec: number[] = new Array(this.dimensions);
      let normSq = 0;
      for (let i = 0; i < this.dimensions; i++) {
        const byte = hash[i % hash.length]!;
        const seed = (byte + i * 31) % 256;
        const val = (seed - 128) / 128;
        vec[i] = val;
        normSq += val * val;
      }
      const norm = Math.sqrt(normSq) || 1;
      return vec.map((v) => v / norm);
    });
  }
}

export interface RerankResult {
  index: number;
  relevanceScore: number;
}

export class MockRerankClient {
  readonly model = "mock-rerank-v1";

  async rerank(query: string, documents: string[], topN?: number): Promise<RerankResult[]> {
    const rawTokens = query.toLowerCase().split(/\s+/).filter(Boolean);
    const queryTokens = new Set<string>();

    const SYNONYM_MAP: Record<string, string[]> = {
      credentials: ["passwords", "passkeys", "tokens", "secrets", "keys", "auth"],
      securing: ["scrypt", "hashing", "encryption", "salt", "passwords", "passkeys"],
      database: ["db", "postgres", "storage", "pool", "sql", "tables"],
      test: ["bun", "jest", "mocha", "vitest", "testing", "runner"],
      failing: ["error", "fix", "fixed", "403", "failed", "bug"],
      ssh: ["proxy", "host", "fingerprint", "keyscan", "ssh_host_key_not_pinned"],
      grace: ["past_due", "billing", "subscriptions", "stripe"],
    };

    for (const t of rawTokens) {
      queryTokens.add(t);
      const syns = SYNONYM_MAP[t];
      if (syns) {
        for (const s of syns) queryTokens.add(s);
      }
    }

    const scored = documents.map((doc, index) => {
      const docTokens = doc.toLowerCase().split(/\s+/).filter(Boolean);
      let matches = 0;
      for (const t of docTokens) {
        if (queryTokens.has(t)) matches++;
      }
      const score = Math.min(1.0, matches / Math.max(1, queryTokens.size));
      return { index, relevanceScore: score };
    });

    scored.sort((a, b) => b.relevanceScore - a.relevanceScore);
    return typeof topN === "number" ? scored.slice(0, topN) : scored;
  }
}
