import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { makeTmpDir, trackDir } from "./helpers.ts";

const PORT = 3791;
const BASE = `http://127.0.0.1:${PORT}`;
const ALICE = "alice-test-token";
const BOB = "bob-test-token";
const PROTOCOL_VERSION = "2025-03-26";

let proc: Subprocess;
let dataDir: string;

async function rpc(
  token: string | null,
  body: unknown,
): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": PROTOCOL_VERSION,
  };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}/mcp`, { method: "POST", headers, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json() };
}

beforeAll(async () => {
  dataDir = trackDir(makeTmpDir());
  proc = Bun.spawn(["bun", "run", "src/index.ts"], {
    cwd: import.meta.dir + "/..",
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      PCM_PORT: String(PORT),
      PCM_HOST: "127.0.0.1",
      PCM_DATA_DIR: dataDir,
      PCM_TOKENS: `alice=${ALICE},bob=${BOB}`,
      PCM_OPERATOR_TOKENS: "ops=ops-test-token",
      PCM_OPERATOR_HOST: "127.0.0.1",
      PCM_OPERATOR_PORT: "3796",
    },
    stdout: "inherit",
    stderr: "inherit",
  });

  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      const res = await fetch(`${BASE}/healthz`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error("pcm-server did not start in time");
    await new Promise((r) => setTimeout(r, 150));
  }
});

afterAll(() => {
  proc?.kill();
});

describe("pcm-server http", () => {
  test("healthz reports fallback embedding without OLLAMA_BASE_URL", async () => {
    const res = await fetch(`${BASE}/healthz`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe("ok");
    expect(json.embedding).toBe("fallback");
    expect(json.schemaVersion).toBe(3);
    expect(json.pgvector).toBe("disabled");
    expect(json.pgvectorHost).toBeNull();
    expect(json.tenants.sort()).toEqual(["alice", "bob"]);
  });

  test("unknown or missing token gets 401", async () => {
    for (const token of [null, "nope-not-a-token"]) {
      const res = await rpc(token, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "test", version: "0" },
        },
      });
      expect(res.status).toBe(401);
      expect(res.json.error).toBe("unauthorized");
    }
  });

  test("MCP initialize + ingest + recall roundtrip, with tenant isolation", async () => {
    const init = await rpc(ALICE, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "test", version: "0" },
      },
    });
    expect(init.status).toBe(200);
    expect(init.json.result.serverInfo.name).toBe("pcm-memvault");

    const toolsRes = await rpc(ALICE, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });
    const toolNames = toolsRes.json.result.tools.map((t: { name: string }) => t.name).sort();
    expect(toolNames).toEqual([
      "memvault_correct",
      "memvault_ingest",
      "memvault_recall",
      "memvault_retract",
      "memvault_session_wrap",
    ]);

    const ingest = await rpc(ALICE, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "memvault_ingest",
        arguments: {
          text: "The ansible deploy for the forgejo runner pins the bun image digest to avoid drift.",
          importance: "high",
          source: "mcp",
          sourceRef: "http-test",
        },
      },
    });
    expect(ingest.status).toBe(200);
    const ingestedPayload = ingest.json.result.structuredContent;
    expect(ingestedPayload.deduplicated).toBe(false);
    expect(ingestedPayload.strength).toBeCloseTo(0.85);
    expect(ingestedPayload.bodyHash).toMatch(/^[0-9a-f]{64}$/);

    const recallAlice = await rpc(ALICE, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "memvault_recall",
        arguments: { query: "forgejo runner bun image deploy" },
      },
    });
    expect(recallAlice.status).toBe(200);
    const recallPayload = recallAlice.json.result.structuredContent;
    const situational = recallPayload.slots.situational_context.map(
      (item: { text: string }) => item.text,
    );
    expect(situational.some((t: string) => t.includes("forgejo runner"))).toBe(true);
    expect(recallPayload.tokenEstimate).toBe(
      Math.ceil(recallPayload.markdown.length / 4),
    );

    const recallBob = await rpc(BOB, {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: {
        name: "memvault_recall",
        arguments: { query: "forgejo runner bun image deploy" },
      },
    });
    expect(recallBob.status).toBe(200);
    expect(recallBob.json.result.structuredContent.slots.situational_context).toHaveLength(0);

    const wrap = await rpc(ALICE, {
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: {
        name: "memvault_session_wrap",
        arguments: {
          sessionId: "http-sess-1",
          turns: [
            { role: "user", content: "hi" },
            {
              role: "assistant",
              content:
                "Summarized the vault-watcher dual-write plan: reuse the body_hash idempotency gate so vault notes and pcm memories never drift apart during migration.",
            },
          ],
        },
      },
    });
    expect(wrap.status).toBe(200);
    expect(wrap.json.result.structuredContent).toEqual({
      sessionId: "http-sess-1",
      ingested: 1,
      deduplicated: 0,
      blocked: 0,
    });
  });

  test("REST /ingest splits pages into blocks and requires auth", async () => {
    const page = [
      "The memory-01 host runs both the Graphiti Neo4j stack and the PCM sidecar on the same ZFS pool.",
      "",
      "A second paragraph with enough substance to qualify as its own memory block about snapshot cadence.",
    ].join("\n");

    const unauth = await fetch(`${BASE}/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: page }),
    });
    expect(unauth.status).toBe(401);

    const res = await fetch(`${BASE}/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${ALICE}` },
      body: JSON.stringify({ text: page, source: "vault-watcher", sourceRef: "daily/2026-09-11.md" }),
    });
    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload.tenant).toBe("alice");
    expect(payload.ingested).toBe(2);
    expect(payload.deduplicated).toBe(0);

    const recall = await rpc(ALICE, {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "memvault_recall", arguments: { query: "snapshot cadence" } },
    });
    const texts = recall.json.result.structuredContent.slots.situational_context.map(
      (item: { text: string }) => item.text,
    );
    expect(texts.some((t: string) => t.includes("snapshot cadence"))).toBe(true);
  });

  test("REST /ingest rejects malformed and far-future occurredAt", async () => {
    const headers = { "content-type": "application/json", authorization: `Bearer ${ALICE}` };

    for (const occurredAt of ["not-a-date", "2036-01-01T00:00:00Z"]) {
      const res = await fetch(`${BASE}/ingest`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          text: "A perfectly ordinary memory block with enough characters to pass the splitter.",
          occurredAt,
        }),
      });
      expect(res.status).toBe(400);
      const payload = await res.json();
      expect(payload.error).toMatch(/occurredAt/);
    }
  });

  test("memvault_ingest rejects far-future occurredAt as a tool error", async () => {
    const res = await rpc(ALICE, {
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: {
        name: "memvault_ingest",
        arguments: {
          text: "Another ordinary memory block, long enough to be its own paragraph here.",
          occurredAt: "2036-01-01T00:00:00Z",
        },
      },
    });
    expect(res.status).toBe(200);
    expect(res.json.result.isError).toBe(true);
  });

  test("a row with an unparseable occurred_at never passes the stale filter", async () => {
    const { TenantStore } = await import("../src/store.ts");
    const store = new TenantStore(dataDir, "alice");
    store.insert({
      id: "deadbeef-dead-4ead-bead-deadbeef0001",
      bodyHash: "0".repeat(64),
      text: "Corrupt dated memory about the VLAN70 dhcp migration scope leftovers.",
      importance: "default",
      strength: 0.7,
      occurredAt: "banana",
      embedding: null,
    });
    store.close();

    const live = await rpc(ALICE, {
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: { name: "memvault_recall", arguments: { query: "VLAN70 dhcp migration" } },
    });
    const liveTexts = live.json.result.structuredContent.slots.situational_context.map(
      (item: { text: string }) => item.text,
    );
    expect(liveTexts.some((t: string) => t.includes("Corrupt dated memory"))).toBe(false);

    const withStale = await rpc(ALICE, {
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: { name: "memvault_recall", arguments: { query: "VLAN70 dhcp migration", includeStale: true } },
    });
    const staleTexts = withStale.json.result.structuredContent.slots.situational_context.map(
      (item: { text: string }) => item.text,
    );
    expect(staleTexts.some((t: string) => t.includes("Corrupt dated memory"))).toBe(true);
  });
});
