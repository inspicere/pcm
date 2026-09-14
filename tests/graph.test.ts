import { describe, it, expect } from "bun:test";
import { CodeGraphParser } from "../src/graph/code-graph-parser.ts";
import { UpgradedPCMKuzuClient } from "../src/graph/kuzu_client.ts";

describe("CodeGraphParser AST Extraction", () => {
  const parser = new CodeGraphParser();

  it("extracts symbols, functions, classes, and calls from TypeScript code", () => {
    const code = `
      export class AuthService {
        verifyToken(token: string) {
          return validateJwt(token);
        }
      }
      export function validateJwt(raw: string) {
        return raw.length > 0;
      }
    `;

    const result = parser.parseFile("src/auth.ts", code, "test-project");

    expect(result.files.length).toBe(1);
    expect(result.files[0].path).toBe("src/auth.ts");
    expect(result.symbols.length).toBeGreaterThanOrEqual(2);

    const classSym = result.symbols.find((s) => s.name === "AuthService");
    expect(classSym).toBeDefined();
    expect(classSym?.kind).toBe("class");

    const funcSym = result.symbols.find((s) => s.name === "validateJwt");
    expect(funcSym).toBeDefined();
    expect(funcSym?.kind).toBe("function");

    const call = result.calls.find((c) => c.callee_name === "validateJwt");
    expect(call).toBeDefined();
  });
});

describe("UpgradedPCMKuzuClient Graph Re-ranking", () => {
  const client = new UpgradedPCMKuzuClient();

  it("prioritizes safety and invariant edges over generic background edges", () => {
    const triplets = [
      {
        source: "User",
        source_type: "Entity",
        predicate: "LIVES_IN",
        target: "Denver",
        target_type: "Entity",
        confidence: 0.9,
        memory_id: "m-1",
        project: "test",
      },
      {
        source: "User",
        source_type: "Entity",
        predicate: "ALLERGIC_TO",
        target: "Shellfish",
        target_type: "Entity",
        confidence: 1.0,
        memory_id: "m-2",
        project: "test",
      },
    ];

    const ranked = client.rerankTriplets("Where can we eat for lunch?", triplets, 1);
    expect(ranked.length).toBe(1);
    expect(ranked[0].predicate).toBe("ALLERGIC_TO");
  });
});
