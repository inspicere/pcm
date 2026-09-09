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
    const STOP_WORDS = new Set([
      "i", "me", "my", "myself", "we", "our", "ours", "ourselves", "you", "your", "yours",
      "he", "him", "his", "himself", "she", "her", "hers", "herself", "it", "its", "itself",
      "they", "them", "their", "theirs", "themselves", "what", "which", "who", "whom", "this",
      "that", "these", "those", "am", "is", "are", "was", "were", "be", "been", "being",
      "have", "has", "had", "having", "do", "does", "did", "doing", "a", "an", "the", "and",
      "but", "if", "or", "because", "as", "until", "while", "of", "at", "by", "for", "with",
      "about", "against", "between", "into", "through", "during", "before", "after", "above",
      "below", "to", "from", "up", "down", "in", "out", "on", "off", "over", "under", "again",
      "further", "then", "once", "here", "there", "when", "where", "why", "how", "all", "any",
      "both", "each", "few", "more", "most", "other", "some", "such", "no", "nor", "not",
      "only", "own", "same", "so", "than", "too", "very", "can", "will", "just", "don", "should", "now",
    ]);

    const rawTokens = query.toLowerCase().split(/\W+/).filter((w) => w.length > 1 && !STOP_WORDS.has(w));
    const queryTokens = new Set<string>();

    const SYNONYM_MAP: Record<string, string[]> = {
      credentials: ["passwords", "passkeys", "tokens", "secrets", "keys", "auth"],
      securing: ["scrypt", "hashing", "encryption", "salt", "passwords", "passkeys"],
      database: ["db", "postgres", "storage", "pool", "sql", "tables"],
      test: ["bun", "jest", "mocha", "vitest", "testing", "runner"],
      failing: ["error", "fix", "fixed", "403", "failed", "bug"],
      ssh: ["proxy", "host", "fingerprint", "keyscan", "ssh_host_key_not_pinned"],
      grace: ["past_due", "billing", "subscriptions", "stripe"],
      websocket: ["ws", "socket", "dropouts", "drop", "dropping", "disconnect"],
      connections: ["connection", "keepalive", "ping", "pong", "interval"],
      railway: ["deployment", "private", "networking", "incident", "ipv6", "loopback"],
      workout: ["running", "marathon", "swimming", "fitness", "exercise", "routine", "pool", "outdoor"],
      eat: ["food", "allergy", "allergic", "shellfish", "clams", "oysters", "dinner", "lunch", "restaurant", "bar", "clam", "oyster"],
      dinner: ["food", "thai", "curry", "poisoning", "takeout", "restaurant", "starving"],
      spouse: ["alex", "architect", "wedding", "anniversary", "married", "date", "living"],
      bio: ["founder", "cto", "cogmesh", "fintech", "manager", "career", "keynote", "speaker", "introduction"],
      health: ["medical", "dental", "eye", "exam", "appointment", "wellness", "summary"],
      medical: ["health", "dental", "eye", "optometrist", "vision", "exam", "wellness", "doctor"],
      trainer: ["health", "medical", "fitness", "exercise"],
    };

    for (const t of rawTokens) {
      queryTokens.add(t);
      const syns = SYNONYM_MAP[t];
      if (syns) {
        for (const s of syns) queryTokens.add(s);
      }
    }

    const scored = documents.map((doc, index) => {
      const docTokens = doc.toLowerCase().split(/\W+/).filter((w) => w.length > 1 && !STOP_WORDS.has(w));
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
