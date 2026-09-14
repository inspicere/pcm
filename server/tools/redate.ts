/**
 * redate — bulk correction of occurred_at for memories whose timestamp is the
 * backfill wall-clock instead of the age of the knowledge, so Ebbinghaus decay
 * measures time-since-event again. Applies a mapping file (one JSON object per
 * line: {"sourceRef": "...", "occurredAt": "ISO-8601"}) to the rows carrying
 * that source_ref, scoped by --source and/or --source-ref-prefix.
 *
 * SAFETY: a scoping filter is mandatory (refuses unscoped full-table rewrites);
 * without --dry-run/--yes it only prints the would-change summary; take a ZFS
 * snapshot of the data dir before applying. The per-change JSONL report IS the
 * audit trail — the DB corrections log is per-memory and is intentionally NOT
 * written for a bulk re-date (tens of thousands of rows would flood it).
 *
 *   bun run tools/redate.ts --tenant X --file mapping.jsonl \
 *     [--source S] [--source-ref-prefix P] [--limit N] [--dry-run] [--yes] \
 *     [--report out.jsonl]
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TenantStore, type MemoryRow } from "../src/store.ts";
import { validateOccurredAt } from "../src/server.ts";

const DATA_DIR = process.env.PCM_DATA_DIR ?? "/data/tenants";

export interface RedateMappingEntry {
  sourceRef: string;
  occurredAt: string;
}

export interface RedateOptions {
  tenant: string;
  /** Scope filter: only rows with this `source`. */
  source?: string;
  /** Scope filter: only rows whose `source_ref` starts with this prefix. */
  sourceRefPrefix?: string;
  /** Cap on total rows changed across the run. */
  limit?: number;
  /** Compute and report would-change rows without writing the DB. */
  dryRun?: boolean;
  /** JSONL report path; one line per change. Null/undefined = no report. */
  reportPath?: string | null;
}

export interface RedateResult {
  tenant: string;
  entries: number;
  /** Entries whose source_ref matched at least one in-scope row. */
  matched: number;
  /** Entries that changed at least one row. */
  updated: number;
  /** Entries that matched no in-scope row. */
  noMatch: number;
  /** Entries skipped: malformed or failed validateOccurredAt (e.g. far-future). */
  invalid: number;
  /** Total rows changed (an entry can match many rows sharing a source_ref). */
  rowsChanged: number;
  dryRun: boolean;
  reportPath: string | null;
}

interface RedateChange {
  tenant: string;
  id: string;
  body_hash: string;
  source_ref: string | null;
  old_occurred_at: string;
  new_occurred_at: string;
  dry_run: boolean;
}

/**
 * Applies (or, with dryRun, rehearses) the mapping against one tenant store.
 * Throws when no scoping filter is given — unscoped full-table rewrites are
 * refused by design. Invalid entries are counted and skipped, never fatal.
 */
export function redate(store: TenantStore, mapping: RedateMappingEntry[], opts: RedateOptions): RedateResult {
  if (!opts.source && !opts.sourceRefPrefix) {
    throw new Error("refusing unscoped redate: pass --source and/or --source-ref-prefix");
  }
  const dryRun = opts.dryRun ?? false;
  const select = store.db.prepare(
    `SELECT id, body_hash, source_ref, occurred_at FROM memories
     WHERE source_ref = ?
       ${opts.source ? "AND source = ? " : ""}
       ${opts.sourceRefPrefix ? "AND source_ref LIKE ? " : ""}`,
  );
  const scopeParams = [...(opts.source ? [opts.source] : []), ...(opts.sourceRefPrefix ? [opts.sourceRefPrefix + "%"] : [])];

  const changes: RedateChange[] = [];
  const pending: Array<{ id: string; occurredAt: string }> = [];
  const result: RedateResult = {
    tenant: opts.tenant,
    entries: mapping.length,
    matched: 0,
    updated: 0,
    noMatch: 0,
    invalid: 0,
    rowsChanged: 0,
    dryRun,
    reportPath: opts.reportPath ?? null,
  };

  for (const entry of mapping) {
    if (opts.limit !== undefined && result.rowsChanged >= opts.limit) break;
    if (!entry || typeof entry.sourceRef !== "string" || typeof entry.occurredAt !== "string") {
      result.invalid += 1;
      continue;
    }
    try {
      validateOccurredAt(entry.occurredAt);
    } catch {
      // Malformed or beyond the 24h future skew: count and continue.
      result.invalid += 1;
      continue;
    }
    const rows = select.all(entry.sourceRef, ...scopeParams) as unknown as Pick<
      MemoryRow,
      "id" | "body_hash" | "source_ref" | "occurred_at"
    >[];
    if (rows.length === 0) {
      result.noMatch += 1;
      continue;
    }
    result.matched += 1;
    let entryChanged = false;
    for (const row of rows) {
      if (opts.limit !== undefined && result.rowsChanged >= opts.limit) break;
      if (row.occurred_at === entry.occurredAt) continue;
      changes.push({
        tenant: opts.tenant,
        id: row.id,
        body_hash: row.body_hash,
        source_ref: row.source_ref,
        old_occurred_at: row.occurred_at,
        new_occurred_at: entry.occurredAt,
        dry_run: dryRun,
      });
      pending.push({ id: row.id, occurredAt: entry.occurredAt });
      result.rowsChanged += 1;
      entryChanged = true;
    }
    if (entryChanged) result.updated += 1;
  }

  if (!dryRun && pending.length > 0) {
    // One transaction for the whole run: a failure mid-way rolls everything
    // back rather than leaving a half-re-dated tenant.
    const apply = store.db.transaction(() => {
      const update = store.db.prepare("UPDATE memories SET occurred_at = ? WHERE id = ?");
      for (const change of pending) update.run(change.occurredAt, change.id);
    });
    apply();
  }

  if (result.reportPath && changes.length > 0) {
    writeFileSync(result.reportPath, changes.map((c) => JSON.stringify(c)).join("\n") + "\n");
  }
  return result;
}

function printSummary(result: RedateResult): void {
  const mode = result.dryRun ? "dry-run" : "applied";
  console.log(`redate ${mode} (tenant=${result.tenant}):`);
  console.log(`  entries:  ${result.entries}`);
  console.log(`  matched:  ${result.matched}`);
  console.log(`  updated:  ${result.updated}  (rows changed: ${result.rowsChanged})`);
  console.log(`  no-match: ${result.noMatch}`);
  console.log(`  invalid:  ${result.invalid}`);
  if (result.reportPath) {
    console.log(`  report:   ${result.reportPath}`);
    console.log("  The report file is the audit trail for this bulk correction;");
    console.log("  the per-memory corrections log is intentionally not written.");
  }
}

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) throw new Error(`unexpected argument '${arg}'`);
    const key = arg.slice(2);
    if (key === "dry-run" || key === "yes") {
      args[key] = true;
    } else {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`--${key} requires a value`);
      args[key] = value;
      i += 1;
    }
  }
  return args;
}

function defaultReportPath(tenant: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return `redate-report-${tenant}-${ts}.jsonl`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const tenant = args["tenant"] as string | undefined;
  const file = args["file"] as string | undefined;
  if (!tenant || !file) {
    console.error("usage: redate --tenant X --file mapping.jsonl [--source S] [--source-ref-prefix P] [--limit N] [--dry-run] [--yes] [--report out.jsonl]");
    process.exit(1);
  }
  const limit = args["limit"] !== undefined ? Number.parseInt(String(args["limit"]), 10) : undefined;
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    console.error(`redate: --limit must be a positive integer, got '${String(args["limit"])}'`);
    process.exit(1);
  }

  const dbPath = join(DATA_DIR, tenant, "memory.db");
  if (!existsSync(dbPath)) {
    console.error(`redate: no memory.db for tenant '${tenant}' under ${DATA_DIR} (typo? refusing to create an empty store)`);
    process.exit(1);
  }

  const mapping: RedateMappingEntry[] = [];
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!.trim();
    if (!line) continue;
    try {
      mapping.push(JSON.parse(line) as RedateMappingEntry);
    } catch (err) {
      console.error(`redate: ${file}:${i + 1}: malformed JSON (${(err as Error).message})`);
      process.exit(1);
    }
  }

  const store = new TenantStore(DATA_DIR, tenant);
  try {
    const scope = { source: args["source"] as string | undefined, sourceRefPrefix: args["source-ref-prefix"] as string | undefined };
    if (!scope.source && !scope.sourceRefPrefix) {
      console.error("redate: refusing unscoped run — pass --source and/or --source-ref-prefix");
      process.exit(1);
    }
    if (!args["dry-run"] && !args["yes"]) {
      // Prompt mode: rehearse, print, change nothing.
      console.log("reminder: ensure a ZFS snapshot of the data dir exists before applying.");
      const preview = redate(store, mapping, { tenant, ...scope, limit, dryRun: true });
      printSummary(preview);
      console.log("no changes made — re-run with --yes to apply (or --dry-run to also write a report file).");
      return;
    }
    const reportPath = (args["report"] as string | undefined) ?? defaultReportPath(tenant);
    if (!args["dry-run"]) {
      console.log("reminder: ensure a ZFS snapshot of the data dir exists before applying.");
    }
    const result = redate(store, mapping, { tenant, ...scope, limit, dryRun: Boolean(args["dry-run"]), reportPath });
    printSummary(result);
  } finally {
    store.close();
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`redate failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
