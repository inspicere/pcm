export interface PinnedMemoryRecord {
  id: string;
  userId: string;
  text: string;
  importance: "pinned";
  strength: number;
  project?: string;
  repo?: string;
  createdAt: Date;
}

export class PinnedGuardrailsCache {
  private cache: Map<string, { records: PinnedMemoryRecord[]; cachedAt: number }> = new Map();
  private ttlMs: number;

  constructor(ttlMs: number = 60_000) {
    this.ttlMs = ttlMs;
  }

  get(userId: string): PinnedMemoryRecord[] | null {
    const entry = this.cache.get(userId);
    if (!entry) return null;
    if (Date.now() - entry.cachedAt > this.ttlMs) {
      this.cache.delete(userId);
      return null;
    }
    return entry.records;
  }

  set(userId: string, records: PinnedMemoryRecord[]): void {
    this.cache.set(userId, {
      records,
      cachedAt: Date.now(),
    });
  }

  invalidate(userId: string): void {
    this.cache.delete(userId);
  }

  clear(): void {
    this.cache.clear();
  }
}
