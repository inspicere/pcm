export interface EdgeCandidate {
  sourceMemoryId: string;
  targetMemoryId: string;
  weight: number;
}

export function computeAssociationWeight(
  similarity: number,
  coOccurrenceCount: number = 1,
): number {
  const baseWeight = Math.max(0, similarity);
  const reinforcement = 1 + Math.log10(coOccurrenceCount);
  return Math.min(1.0, baseWeight * reinforcement);
}

export function computeSpreadingActivation(
  activeNodes: Array<{ id: string; activation: number }>,
  edges: Array<{ sourceId: string; targetId: string; weight: number }>,
  decayFactor: number = 0.65,
): Map<string, number> {
  const activated = new Map<string, number>();

  for (const node of activeNodes) {
    activated.set(node.id, node.activation);
  }

  for (const node of activeNodes) {
    const connectedEdges = edges.filter((e) => e.sourceId === node.id);
    for (const edge of connectedEdges) {
      const current = activated.get(edge.targetId) ?? 0;
      const pulse = node.activation * edge.weight * decayFactor;
      activated.set(edge.targetId, Math.max(current, pulse));
    }
  }

  return activated;
}
