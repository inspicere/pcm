import ts from "typescript";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { resolve, relative, extname, dirname, join } from "node:path";

export interface ParsedSymbol {
  id: string;
  name: string;
  kind: "function" | "class" | "interface" | "type" | "variable";
  file_path: string;
  project?: string;
}

export interface ParsedImport {
  source: string;
  target: string;
  project?: string;
}

export interface ParsedDefine {
  file_path: string;
  symbol_id: string;
  project?: string;
}

export interface ParsedCall {
  caller_id: string;
  callee_id?: string;
  callee_name: string;
  project?: string;
}

export interface ParsedFile {
  path: string;
  language: string;
  project?: string;
}

export interface CodeTopologyPayload {
  files: ParsedFile[];
  symbols: ParsedSymbol[];
  imports: ParsedImport[];
  defines: ParsedDefine[];
  calls: ParsedCall[];
  project_scope?: string;
}

/**
 * Lightweight local AST Parser using TypeScript's compiler API.
 * Extracts symbols, definitions, imports, and call sites on the client machine
 * without ever sending raw source code across the wire.
 */
export class CodeGraphParser {
  /**
   * Parses raw file content into code topology nodes and edges.
   */
  parseFile(filePath: string, content: string, projectScope = ""): CodeTopologyPayload {
    const ext = extname(filePath).toLowerCase();
    const language = ext === ".py" ? "python" : ext.includes("ts") ? "typescript" : "javascript";
    const normalizedPath = filePath.replace(/\\/g, "/");

    const files: ParsedFile[] = [
      {
        path: normalizedPath,
        language,
        project: projectScope,
      },
    ];

    const symbols: ParsedSymbol[] = [];
    const defines: ParsedDefine[] = [];
    const imports: ParsedImport[] = [];
    const calls: ParsedCall[] = [];

    // Use TypeScript AST parser for TS/JS files
    if (language === "typescript" || language === "javascript") {
      const sourceFile = ts.createSourceFile(
        normalizedPath,
        content,
        ts.ScriptTarget.Latest,
        true,
        ext.includes("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
      );

      let currentFunction: string | null = null;

      const visit = (node: ts.Node) => {
        // 1. Exported / Top-level Functions
        if (ts.isFunctionDeclaration(node) && node.name) {
          const symName = node.name.text;
          const symId = `sym:${normalizedPath}:${symName}`;
          symbols.push({
            id: symId,
            name: symName,
            kind: "function",
            file_path: normalizedPath,
            project: projectScope,
          });
          defines.push({
            file_path: normalizedPath,
            symbol_id: symId,
            project: projectScope,
          });

          const prevFunc = currentFunction;
          currentFunction = symId;
          ts.forEachChild(node, visit);
          currentFunction = prevFunc;
          return;
        }

        // 2. Class Declarations
        if (ts.isClassDeclaration(node) && node.name) {
          const symName = node.name.text;
          const symId = `sym:${normalizedPath}:${symName}`;
          symbols.push({
            id: symId,
            name: symName,
            kind: "class",
            file_path: normalizedPath,
            project: projectScope,
          });
          defines.push({
            file_path: normalizedPath,
            symbol_id: symId,
            project: projectScope,
          });

          const prevFunc = currentFunction;
          currentFunction = symId;
          ts.forEachChild(node, visit);
          currentFunction = prevFunc;
          return;
        }

        // 3. Interface Declarations
        if (ts.isInterfaceDeclaration(node)) {
          const symName = node.name.text;
          const symId = `sym:${normalizedPath}:${symName}`;
          symbols.push({
            id: symId,
            name: symName,
            kind: "interface",
            file_path: normalizedPath,
            project: projectScope,
          });
          defines.push({
            file_path: normalizedPath,
            symbol_id: symId,
            project: projectScope,
          });
        }

        // 4. Arrow Functions & Variable Statements
        if (ts.isVariableStatement(node)) {
          for (const decl of node.declarationList.declarations) {
            if (ts.isIdentifier(decl.name) && decl.initializer && (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))) {
              const symName = decl.name.text;
              const symId = `sym:${normalizedPath}:${symName}`;
              symbols.push({
                id: symId,
                name: symName,
                kind: "function",
                file_path: normalizedPath,
                project: projectScope,
              });
              defines.push({
                file_path: normalizedPath,
                symbol_id: symId,
                project: projectScope,
              });

              const prevFunc = currentFunction;
              currentFunction = symId;
              ts.forEachChild(decl.initializer, visit);
              currentFunction = prevFunc;
              return;
            }
          }
        }

        // 5. Import Declarations
        if (ts.isImportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
          const modulePath = node.moduleSpecifier.text;
          if (modulePath.startsWith(".")) {
            const dir = dirname(normalizedPath);
            const resolvedTarget = join(dir, modulePath).replace(/\\/g, "/");
            imports.push({
              source: normalizedPath,
              target: resolvedTarget,
              project: projectScope,
            });
          }
        }

        // 6. Function Invocations / Call Expressions
        if (ts.isCallExpression(node) && currentFunction) {
          let calleeName: string | null = null;
          if (ts.isIdentifier(node.expression)) {
            calleeName = node.expression.text;
          } else if (ts.isPropertyAccessExpression(node.expression)) {
            calleeName = node.expression.name.text;
          }

          if (calleeName) {
            calls.push({
              caller_id: currentFunction,
              callee_name: calleeName,
              project: projectScope,
            });
          }
        }

        ts.forEachChild(node, visit);
      };

      visit(sourceFile);
    }

    return {
      files,
      symbols,
      imports,
      defines,
      calls,
      project_scope: projectScope,
    };
  }

  /**
   * Recursively parses an entire directory tree locally on the client.
   */
  parseDirectory(rootDir: string, projectScope = "", maxFiles = 100): CodeTopologyPayload {
    const combined: CodeTopologyPayload = {
      files: [],
      symbols: [],
      imports: [],
      defines: [],
      calls: [],
      project_scope: projectScope,
    };

    const scan = (dir: string) => {
      if (combined.files.length >= maxFiles) return;

      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (combined.files.length >= maxFiles) break;

        const fullPath = resolve(dir, entry.name);
        const relPath = relative(rootDir, fullPath).replace(/\\/g, "/");

        if (entry.isDirectory()) {
          if (
            entry.name === "node_modules" ||
            entry.name === ".git" ||
            entry.name === "dist" ||
            entry.name === ".next" ||
            entry.name === "coverage" ||
            entry.name === "build" ||
            entry.name.startsWith(".")
          ) {
            continue;
          }
          scan(fullPath);
        } else if (entry.isFile()) {
          const ext = extname(entry.name).toLowerCase();
          if ([".ts", ".tsx", ".js", ".jsx"].includes(ext)) {
            try {
              const stat = statSync(fullPath);
              if (stat.size < 500 * 1024) {
                const content = readFileSync(fullPath, "utf8");
                const parsed = this.parseFile(relPath, content, projectScope);
                combined.files.push(...parsed.files);
                combined.symbols.push(...parsed.symbols);
                combined.imports.push(...parsed.imports);
                combined.defines.push(...parsed.defines);
                combined.calls.push(...parsed.calls);
              }
            } catch {}
          }
        }
      }
    };

    scan(rootDir);
    return combined;
  }

  /**
   * Parses an explicit list of modified files locally on the client.
   * Extracts AST topology without transmitting raw source code.
   */
  parseFileList(filePaths: string[], rootDir: string, projectScope = ""): CodeTopologyPayload {
    const combined: CodeTopologyPayload = {
      files: [],
      symbols: [],
      imports: [],
      defines: [],
      calls: [],
      project_scope: projectScope,
    };

    for (const relPath of filePaths) {
      const fullPath = resolve(rootDir, relPath);
      const ext = extname(fullPath).toLowerCase();
      if ([".ts", ".tsx", ".js", ".jsx", ".py"].includes(ext)) {
        try {
          if (existsSync(fullPath)) {
            const stat = statSync(fullPath);
            if (stat.size < 500 * 1024) {
              const content = readFileSync(fullPath, "utf8");
              const normalizedRel = relPath.replace(/\\/g, "/");
              const parsed = this.parseFile(normalizedRel, content, projectScope);
              combined.files.push(...parsed.files);
              combined.symbols.push(...parsed.symbols);
              combined.imports.push(...parsed.imports);
              combined.defines.push(...parsed.defines);
              combined.calls.push(...parsed.calls);
            }
          }
        } catch {}
      }
    }
    return combined;
  }
}
