import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "bun:test";
import { createEmbedder } from "../src/embedder.ts";
import { TenantRegistry } from "../src/server.ts";
import { DEFAULT_DECAY_RATE } from "../../src/index.ts";

export function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "pcm-test-"));
}

export const cleanupDirs: string[] = [];

export function trackDir(dir: string): string {
  cleanupDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of cleanupDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

export function makeRegistry(dataDir: string): TenantRegistry {
  const embedder = createEmbedder({ baseUrl: null, model: "nomic-embed-text", timeoutMs: 3000 });
  return new TenantRegistry(dataDir, embedder, DEFAULT_DECAY_RATE);
}

export function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}
