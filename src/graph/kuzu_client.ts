export interface GraphTriplet {
  source: string;
  source_type: string;
  predicate: string;
  target: string;
  target_type: string;
  confidence: number;
  memory_id: string;
  project: string;
}

export class UpgradedPCMKuzuClient {
  private daemonUrl: string;

  constructor(daemonUrl = "http://127.0.0.1:8765") {
    this.daemonUrl = daemonUrl;
  }

  async querySubgraph(query: string, projectScope = ""): Promise<{ latencyMs: number; triplets: GraphTriplet[] }> {
    const t0 = performance.now();
    try {
      const res = await fetch(`${this.daemonUrl}/query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, project_scope: projectScope }),
        signal: AbortSignal.timeout(1000),
      });
      const data = (await res.json()) as { latency_ms: number; triplets: GraphTriplet[] };
      return {
        latencyMs: performance.now() - t0,
        triplets: data.triplets || [],
      };
    } catch {
      return { latencyMs: performance.now() - t0, triplets: [] };
    }
  }
}
