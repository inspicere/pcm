export type EmbeddingMode = "ready" | "fallback";

export interface EmbedderConfig {
  baseUrl: string | null;
  model: string;
  timeoutMs: number;
  /** Bearer token for authenticated fronts (Caddy -> ollama). */
  apiKey?: string | null;
}

export interface Embedder {
  readonly mode: EmbeddingMode;
  readonly model: string;
  embed(text: string): Promise<Float32Array | null>;
}

export function createEmbedder(config: EmbedderConfig): Embedder {
  // Start "fallback"; promote to "ready" only after a verified embed so
  // /healthz never claims a working pipeline it hasn't exercised (this
  // masked a network-blocked Ollama for a day).
  let mode: EmbeddingMode = "fallback";

  return {
    get mode() {
      return mode;
    },
    model: config.model,

    async embed(text: string): Promise<Float32Array | null> {
      if (!config.baseUrl) return null;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.timeoutMs);
      try {
        const headers: Record<string, string> = { "content-type": "application/json" };
        if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;
        // OpenAI-compatible /v1/embeddings: served both by the Caddy front
        // (the only route reachable from the memory containers) and by native
        // ollama. The native /api/embeddings path is NOT proxied by the front.
        const res = await fetch(`${config.baseUrl}/v1/embeddings`, {
          method: "POST",
          headers,
          body: JSON.stringify({ model: config.model, input: text }),
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`ollama embeddings HTTP ${res.status}`);
        const data = (await res.json()) as { data?: Array<{ embedding?: number[] }> };
        const vector = data.data?.[0]?.embedding;
        if (!Array.isArray(vector) || vector.length === 0) {
          throw new Error("ollama embeddings response missing embedding array");
        }
        mode = "ready";
        return Float32Array.from(vector);
      } catch {
        mode = "fallback";
        return null;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
