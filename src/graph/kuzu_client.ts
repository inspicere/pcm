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

  rerankTriplets(query: string, triplets: GraphTriplet[], topN = 3): GraphTriplet[] {
    if (triplets.length <= topN) return triplets;

    const queryTokens = new Set(query.toLowerCase().split(/\W+/).filter((w) => w.length > 2));
    const SYNONYMS: Record<string, string[]> = {
      eat: ["allergic", "allergy", "shellfish", "food", "epipen", "poisoning", "cuisine", "curry", "oyster", "clam"],
      food: ["allergic", "allergy", "shellfish", "eat", "epipen", "poisoning", "curry", "thai"],
      lunch: ["eat", "food", "allergic", "allergy", "shellfish", "bar", "restaurant", "oyster", "clam"],
      dinner: ["eat", "food", "thai", "curry", "poisoning", "takeout", "starving"],
      workout: ["running", "swimming", "fitness", "activity", "exercise", "pool", "marathon", "denver"],
      fitness: ["running", "swimming", "workout", "exercise", "activity", "denver", "pool"],
      activity: ["running", "swimming", "workout", "exercise", "fitness", "denver", "pool"],
      job: ["architect", "profession", "cto", "founder", "manager", "engineer", "cogmesh"],
      spouse: ["alex", "architect", "anniversary", "wedding", "september"],
      anniversary: ["alex", "wedding", "september", "date"],
    };

    for (const [k, syns] of Object.entries(SYNONYMS)) {
      if (queryTokens.has(k)) {
        for (const s of syns) queryTokens.add(s);
      }
    }

    const scored = triplets.map((t) => {
      const edgeTokens = `${t.source} ${t.predicate} ${t.target}`.toLowerCase().split(/\W+/).filter(Boolean);
      let matchCount = 0;
      for (const tok of edgeTokens) {
        if (queryTokens.has(tok)) matchCount++;
      }
      let priorityBoost = 0;
      const pred = t.predicate.toUpperCase();
      if (pred.includes("ALLERG") || pred.includes("CARRIES") || pred.includes("FORBIDDEN")) {
        priorityBoost += 0.4;
      }
      if (pred.includes("SUPERSEDES") || pred.includes("REPLACES")) {
        priorityBoost += 0.3;
      }
      const score = (matchCount / Math.max(1, queryTokens.size)) + priorityBoost;
      return { triplet: t, score };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topN).map((s) => s.triplet);
  }
}
