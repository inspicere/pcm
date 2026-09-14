import { describe, expect, test } from "bun:test";
import { ingestItem, splitSessionItems } from "../src/server.ts";
import { recall } from "../src/scoring.ts";
import { daysAgoIso, makeRegistry, makeTmpDir, trackDir } from "./helpers.ts";

describe("memvault core", () => {
  test("ingest + recall roundtrip returns the memory in situational context", async () => {
    const dir = trackDir(makeTmpDir());
    const ctx = makeRegistry(dir).get("hermes");

    const ingested = await ingestItem(ctx, {
      text: "Postgres backups run nightly at 02:00 via pg_dump to the NAS snapshot pool.",
    });
    expect(ingested.deduplicated).toBe(false);
    expect(ingested.strength).toBeCloseTo(0.7);

    const result = await recall(ctx.store, ctx.embedder, "how do I back up postgres", {
      k: 5,
      includeStale: false,
      decayRate: ctx.decayRate,
    });
    const texts = result.slots.situational_context.map((item) => item.text);
    expect(texts.some((t) => t.includes("Postgres backups"))).toBe(true);
    expect(result.markdown).toContain("[SITUATIONAL CONTEXT");
    expect(result.tokenEstimate).toBe(Math.ceil(result.markdown.length / 4));
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  test("ingest idempotency: same text twice deduplicates to a single row", async () => {
    const dir = trackDir(makeTmpDir());
    const ctx = makeRegistry(dir).get("hermes");

    const first = await ingestItem(ctx, { text: "Rotate the unifi controller certificate yearly." });
    const second = await ingestItem(ctx, { text: "Rotate the unifi controller certificate yearly." });

    expect(first.deduplicated).toBe(false);
    expect(second.deduplicated).toBe(true);
    expect(second.id).toBe(first.id);
    expect(second.bodyHash).toBe(first.bodyHash);
    expect(ctx.store.count()).toBe(1);
  });

  test("invariant pinned memory is recalled with a fully unrelated query", async () => {
    const dir = trackDir(makeTmpDir());
    const ctx = makeRegistry(dir).get("hermes");

    const ingested = await ingestItem(ctx, {
      text: "Never disclose the staging vault token in chat logs or tickets.",
      autoPinInvariant: true,
    });
    expect(ingested.strength).toBe(1.0);

    const result = await recall(ctx.store, ctx.embedder, "zebra quantum plugh unrelated", {
      k: 5,
      includeStale: false,
      decayRate: ctx.decayRate,
    });
    const askerTexts = result.slots.asker_context.map((item) => item.text);
    expect(askerTexts.some((t) => t.includes("Never disclose"))).toBe(true);
  });

  test("bulk ingest does NOT auto-pin invariant-looking corpus text (F4)", async () => {
    const dir = trackDir(makeTmpDir());
    const ctx = makeRegistry(dir).get("hermes");

    const ingested = await ingestItem(ctx, {
      text: "The signup flow never disclosed at signup topic filtering; neutral framing only.",
    });
    expect(ingested.strength).toBeLessThan(1.0);

    const recalled = await ingestItem(ctx, {
      text: "Never disclose the staging vault token in chat logs or tickets.",
    });
    expect(recalled.strength).toBeLessThan(1.0);
  });

  test("decay ordering: fresh memory outranks a 200-day-old one at default decay", async () => {
    const dir = trackDir(makeTmpDir());
    const ctx = makeRegistry(dir).get("hermes");

    await ingestItem(ctx, {
      text: "Decision: use restic for offsite backups with a 30-day retention window.",
      occurredAt: daysAgoIso(200),
    });
    await ingestItem(ctx, {
      text: "Decision: use restic for offsite backups with a 14-day retention window.",
      occurredAt: daysAgoIso(1),
    });

    const result = await recall(ctx.store, ctx.embedder, "restic offsite backup retention decision", {
      k: 5,
      includeStale: true,
      decayRate: ctx.decayRate,
    });
    const texts = result.slots.situational_context.map((item) => item.text);
    expect(texts.length).toBe(2);
    expect(texts[0]).toContain("14-day");
    expect(texts[1]).toContain("30-day");
  });

  test("session_wrap splits turns, skips noise, and tags sourceRef", async () => {
    const dir = trackDir(makeTmpDir());
    const ctx = makeRegistry(dir).get("claude");

    const turns = [
      { role: "user" as const, content: "ok" },
      {
        role: "assistant" as const,
        content:
          "We migrated the grafana dashboards to the new postgres datasource and verified all panels render.\n\nNext: update the alerting contact points to route through the on-call webhook instead of email.",
      },
      {
        role: "user" as const,
        content:
          "Reminder: the snapshot rollback procedure for the memory graph container requires stopping neo4j first, then restoring the volume from the latest zfs snapshot, then restarting the stack and checking the apoc warmup query.",
      },
    ];

    const items = splitSessionItems(turns);
    expect(items.length).toBe(3);

    let ingested = 0;
    let deduplicated = 0;
    for (const text of items) {
      const result = await ingestItem(ctx, {
        text,
        importance: "default",
        source: "session",
        sourceRef: "sess-42",
      });
      if (result.deduplicated) deduplicated += 1;
      else ingested += 1;
    }
    expect(ingested).toBe(3);
    expect(deduplicated).toBe(0);

    const rows = ctx.store.listNonPinned();
    expect(rows.length).toBe(3);
    for (const row of rows) {
      expect(row.source).toBe("session");
      expect(row.source_ref).toBe("sess-42");
    }
    for (const item of items) {
      expect(item.length).toBeLessThanOrEqual(500);
    }
  });
});
