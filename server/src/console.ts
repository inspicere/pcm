import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { TenantContext, TenantRegistry } from "./server.ts";
import { sha256Hex, type Importance, type MemoryRow } from "./store.ts";

/**
 * Operator console: server-rendered HTML (zero client JS) on a separate
 * listener, sharing the tenant registry with the MCP/REST listener so both
 * surfaces see identical state. Authentication is a session cookie backed by
 * a boot-random HMAC key; mutations additionally require a per-session CSRF
 * token and always write an audit row carrying the operator name.
 */

export interface OperatorIdentity {
  name: string;
  digest: Buffer;
}

export interface OperatorConsoleOptions {
  operators: OperatorIdentity[];
  /** All tenant names from PCM_TOKENS (the console does not verify bearer tokens). */
  tenants: string[];
  registry: TenantRegistry;
}

const SESSION_COOKIE = "pcm_op";
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const PAGE_LIMIT = 200;
const TEXT_PREVIEW_CHARS = 160;
const IMPORTANCES: Importance[] = ["pinned", "high", "default"];

export function createOperatorConsole(opts: OperatorConsoleOptions): {
  fetch(req: Request): Promise<Response>;
} {
  // Random per-boot HMAC key: sessions invalidate on restart by design (v1
  // keeps no session persistence; the login page footer says so).
  const secret = randomBytes(32);
  const sessions = new Map<string, { name: string; csrf: string; expiry: number }>();

  function mac(message: string): string {
    return createHmac("sha256", secret).update(message).digest("hex");
  }

  function safeEqualHex(a: string, b: string): boolean {
    const ba = Buffer.from(a, "hex");
    const bb = Buffer.from(b, "hex");
    return ba.length === bb.length && timingSafeEqual(ba, bb);
  }

  function cookieValue(req: Request, name: string): string | null {
    const raw = req.headers.get("cookie");
    if (!raw) return null;
    for (const part of raw.split(";")) {
      const idx = part.indexOf("=");
      if (idx < 0) continue;
      if (part.slice(0, idx).trim() === name) return part.slice(idx + 1).trim();
    }
    return null;
  }

  function issueSession(name: string): { cookie: string; csrf: string } {
    const expiry = Date.now() + SESSION_TTL_MS;
    const cookie = `${expiry}.${mac(`${name}.${expiry}`)}`;
    const csrf = randomBytes(16).toString("hex");
    if (sessions.size > 256) {
      const now = Date.now();
      for (const [key, session] of sessions) {
        if (session.expiry <= now) sessions.delete(key);
      }
    }
    sessions.set(cookie, { name, csrf, expiry });
    return { cookie, csrf };
  }

  /** Returns the operator name, or null when the request is unauthenticated. */
  function authenticate(req: Request): { name: string; csrf: string; cookie: string } | null {
    const cookie = cookieValue(req, SESSION_COOKIE);
    if (!cookie) return null;
    const session = sessions.get(cookie);
    if (!session) return null;
    if (session.expiry <= Date.now()) {
      sessions.delete(cookie);
      return null;
    }
    const dot = cookie.indexOf(".");
    const presented = cookie.slice(dot + 1);
    if (!safeEqualHex(presented, mac(`${session.name}.${cookie.slice(0, dot)}`))) {
      sessions.delete(cookie);
      return null;
    }
    return { name: session.name, csrf: session.csrf, cookie };
  }

  function seeOther(location: string, headers: HeadersInit = {}): Response {
    return new Response(null, { status: 303, headers: { ...headers, location } });
  }

  function redirectToLogin(): Response {
    return seeOther("/login");
  }

  function ctxFor(tenant: string): TenantContext {
    return opts.registry.get(tenant);
  }

  async function deleteFromAnnBestEffort(ctx: TenantContext, memoryId: string): Promise<void> {
    if (!ctx.pgvector) return;
    await ctx.pgvector.delete(ctx.tenant, memoryId).catch((err) => {
      console.warn(`pgvector delete failed for tenant ${ctx.tenant}: ${(err as Error).message}`);
    });
  }

  function requireReason(data: FormData): string | null {
    const reason = data.get("reason");
    if (typeof reason !== "string" || reason.trim().length === 0) return null;
    return reason.trim();
  }

  function validImportance(value: FormDataEntryValue | null): Importance | null {
    return IMPORTANCES.includes(value as Importance) ? (value as Importance) : null;
  }

  /** Open-redirect guard for post-mutation targets supplied by the form. */
  function safeNext(value: FormDataEntryValue | null, fallback: string): string {
    if (typeof value === "string" && value.startsWith("/t/") && !value.startsWith("//")) {
      return value;
    }
    return fallback;
  }

  // ---------------------------------------------------------------- rendering

  function page(title: string, body: string): string {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · pcm console</title>
<style>
body{font-family:system-ui,sans-serif;margin:0;background:#f6f7f9;color:#1c2430}
header{background:#1c2430;color:#fff;padding:0.6rem 1rem;display:flex;gap:1rem;align-items:center;flex-wrap:wrap}
header a{color:#cdd7e4;text-decoration:none}header a:hover{color:#fff}
header form{margin:0 0 0 auto}
main{padding:1rem;max-width:1100px;margin:0 auto}
table{border-collapse:collapse;width:100%;background:#fff;font-size:0.85rem}
th,td{border:1px solid #dde3ea;padding:0.35rem 0.5rem;text-align:left;vertical-align:top}
th{background:#eef1f5}
form.inline{display:inline-flex;gap:0.4rem;align-items:center;flex-wrap:wrap;margin:0.2rem 0}
input,select,textarea{font:inherit;padding:0.25rem;border:1px solid #b9c2cd;border-radius:4px}
button{font:inherit;padding:0.3rem 0.8rem;border:1px solid #1c2430;border-radius:4px;background:#1c2430;color:#fff;cursor:pointer}
button.plain{background:#fff;color:#1c2430}
nav.crumb{font-size:0.85rem;margin-bottom:0.8rem}
.muted{color:#5b6774;font-size:0.8rem}
.pill{display:inline-block;padding:0 0.4rem;border-radius:999px;font-size:0.75rem;background:#dde3ea}
.pill.pinned{background:#fde68a}.pill.high{background:#bfdbfe}.pill.retracted{background:#fecaca}
pre{white-space:pre-wrap;background:#fff;border:1px solid #dde3ea;padding:0.6rem}
.error{background:#fee2e2;border:1px solid #f87171;padding:0.8rem;border-radius:4px}
footer{padding:1rem;color:#5b6774;font-size:0.8rem}
</style>
</head>
<body>
${body}
</body>
</html>`;
  }

  function esc(value: string): string {
    return value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function shortHash(hash: string): string {
    return esc(hash.slice(0, 12));
  }

  function truncate(text: string, max = TEXT_PREVIEW_CHARS): string {
    return text.length > max ? `${text.slice(0, max)}…` : text;
  }

  function tenantHref(tenant: string, path = ""): string {
    return `/t/${encodeURIComponent(tenant)}${path}`;
  }

  function chrome(name: string, csrf: string, crumb: string, body: string): string {
    return `<header>
<strong>pcm console</strong> ${crumb}
<span class="muted">operator: ${esc(name)}</span>
<form method="post" action="/logout"><input type="hidden" name="csrf" value="${esc(csrf)}"><button class="plain" type="submit">log out</button></form>
</header>
<main>${body}</main>`;
  }

  function tenantCrumb(tenant: string, current: string): string {
    const t = esc(tenant);
    const links = [
      `<a href="/">tenants</a>`,
      `<a href="${tenantHref(tenant)}">${t}</a>`,
      `<a href="${tenantHref(tenant, "/pins")}">pins</a>`,
      `<a href="${tenantHref(tenant, "/denylist")}">denylist</a>`,
      `<a href="${tenantHref(tenant, "/audit")}">audit</a>`,
    ];
    return `<nav class="crumb">${links.join(" · ")} <span class="muted">/ ${esc(current)}</span></nav>`;
  }

  function statusPill(row: MemoryRow): string {
    return row.retracted_at !== null
      ? '<span class="pill retracted">retracted</span>'
      : '<span class="pill">live</span>';
  }

  function importancePill(importance: Importance): string {
    return `<span class="pill ${esc(importance)}">${esc(importance)}</span>`;
  }

  function errorPage(status: number, message: string): Response {
    return new Response(
      page("error", `<main><p class="error">${esc(message)}</p><p><a href="/">back to dashboard</a></p></main>`),
      { status, headers: { "content-type": "text/html; charset=utf-8" } },
    );
  }

  function html(body: string): Response {
    return new Response(page("pcm", body), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  // ------------------------------------------------------------------ routes

  function loginBody(notice = ""): string {
    return `<main style="max-width:420px;margin:3rem auto">
<h1>pcm operator console</h1>
${notice ? `<p class="error">${esc(notice)}</p>` : ""}
<form method="post" action="/login">
<p><label>name<br><input name="name" autocomplete="username" required></label></p>
<p><label>token<br><input name="token" type="password" autocomplete="current-password" required></label></p>
<p><button type="submit">sign in</button></p>
</form>
<footer>sessions reset on server restart</footer>
</main>`;
  }

  function loginPage(notice = ""): Response {
    return html(loginBody(notice));
  }

  function dashboard(name: string, csrf: string): Response {
    const rows = opts.tenants
      .map((tenant) => {
        const stats = ctxFor(tenant).store.tenantStats();
        return `<tr>
<td><a href="${tenantHref(tenant)}">${esc(tenant)}</a></td>
<td>${stats.live}</td><td>${stats.retracted}</td><td>${stats.pinned}</td><td>${stats.nullEmbedding}</td><td>${stats.total}</td>
</tr>`;
      })
      .join("\n");
    return html(
      chrome(
        name,
        csrf,
        `<nav class="crumb">tenants</nav>`,
        `<h1>tenants</h1>
<table>
<tr><th>tenant</th><th>live</th><th>retracted</th><th>pinned</th><th>no embedding</th><th>total rows</th></tr>
${rows}
</table>
<p class="muted">opening a tenant store here is the same store the MCP/REST listener uses; counts are live.</p>`,
      ),
    );
  }

  interface BrowserQuery {
    importance: string;
    status: string;
    source: string;
    q: string;
  }

  function browserPage(tenant: string, query: BrowserQuery, name: string, csrf: string): Response {
    const ctx = ctxFor(tenant);
    const sources = ctx.store.listSources();
    const { rows, truncated } = ctx.store.listMemories({
      importance: query.importance as MemoryRow["importance"] | "all",
      status: query.status as "live" | "retracted" | "all",
      source: query.source || null,
      search: query.q || undefined,
      limit: PAGE_LIMIT,
    });
    const sel = (current: string, value: string) => (current === value ? " selected" : "");
    const sourceOptions = [
      `<option value="">all</option>`,
      ...sources.map((s) => `<option value="${esc(s)}"${sel(query.source, s)}>${esc(s)}</option>`),
    ].join("");
    const bodyRows = rows
      .map((row) => {
        const src = [row.source, row.source_ref].filter(Boolean).join(" / ");
        return `<tr>
<td>${esc(row.occurred_at)}</td>
<td>${importancePill(row.importance)}</td>
<td>${statusPill(row)}</td>
<td>${esc(src)}</td>
<td><a href="${tenantHref(tenant, `/m/${encodeURIComponent(row.id)}`)}">${esc(truncate(row.text))}</a></td>
</tr>`;
      })
      .join("\n");
    const href = tenantHref(tenant);
    return html(
      chrome(
        name,
        csrf,
        tenantCrumb(tenant, "memories"),
        `<h1>${esc(tenant)} · memories</h1>
<form method="get" action="${href}" class="inline">
<label>importance <select name="importance">
<option value="all"${sel(query.importance, "all")}>all</option>
<option value="pinned"${sel(query.importance, "pinned")}>pinned</option>
<option value="high"${sel(query.importance, "high")}>high</option>
<option value="default"${sel(query.importance, "default")}>default</option>
</select></label>
<label>status <select name="status">
<option value="live"${sel(query.status, "live")}>live</option>
<option value="retracted"${sel(query.status, "retracted")}>retracted</option>
<option value="all"${sel(query.status, "all")}>all</option>
</select></label>
<label>source <select name="source">${sourceOptions}</select></label>
<label>search <input name="q" value="${esc(query.q)}"></label>
<button class="plain" type="submit">filter</button>
</form>
${truncated ? `<p class="muted">showing the ${PAGE_LIMIT} most recent only — refine the filter.</p>` : ""}
<table>
<tr><th>occurred_at</th><th>importance</th><th>status</th><th>source</th><th>text</th></tr>
${bodyRows}
</table>`,
      ),
    );
  }

  function detailPage(tenant: string, id: string, name: string, csrf: string): Response {
    const ctx = ctxFor(tenant);
    const row = ctx.store.getById(id);
    if (!row) return errorPage(404, `memory ${id} not found in tenant ${tenant}`);
    const href = tenantHref(tenant, `/m/${encodeURIComponent(row.id)}`);
    const superseded = row.superseded_by
      ? (() => {
          const target = ctx.store.getByHash(row.superseded_by!);
          return target
            ? `<a href="${tenantHref(tenant, `/m/${encodeURIComponent(target.id)}`)}">${shortHash(row.superseded_by!)}</a>`
            : shortHash(row.superseded_by!);
        })()
      : '<span class="muted">—</span>';
    const embedding = row.embedding
      ? `present (${row.dims ?? "?"} dims)`
      : '<span class="muted">NULL</span>';
    const retracted = row.retracted_at
      ? `<p>${statusPill(row)} <span class="muted">at ${esc(row.retracted_at)}</span></p>`
      : "";
    const importanceOptions = IMPORTANCES.map(
      (imp) => `<option value="${imp}"${imp === row.importance ? " selected" : ""}>${imp}</option>`,
    ).join("");
    const hidden = `<input type="hidden" name="csrf" value="${esc(csrf)}">`;

    const actions: string[] = [];
    if (row.retracted_at === null) {
      actions.push(`<h2>retract</h2>
<form method="post" action="${href}/retract" class="inline">${hidden}
<input name="reason" placeholder="reason (required)" required>
<button type="submit">retract</button>
</form>`);
    } else {
      actions.push(`<h2>unretract</h2>
<form method="post" action="${href}/unretract" class="inline">${hidden}
<input name="reason" placeholder="reason (required)" required>
<button type="submit">unretract</button>
</form>`);
    }
    actions.push(`<h2>correct</h2>
<form method="post" action="${href}/correct">${hidden}
<p><textarea name="newText" rows="3" style="width:100%" placeholder="replacement text (required)" required></textarea></p>
<p class="inline"><input name="reason" placeholder="reason (required)" required>
<label>importance <select name="importance">${IMPORTANCES.map((imp) => `<option value="${imp}"${imp === "high" ? " selected" : ""}>${imp}</option>`).join("")}</select></label>
<button type="submit">replace</button></p>
<p class="muted">the replacement never inherits pinned; it takes the selected importance.</p>
</form>`);
    actions.push(`<h2>sanitize (purge)</h2>
<p class="muted">hard-deletes the row, blocks its hash from ever re-ingesting, and best-effort evicts it from the ANN index. irreversible.</p>
<form method="post" action="${href}/sanitize" class="inline">${hidden}
<input name="reason" placeholder="reason (required)" required>
<label>type the memory id to confirm <input name="confirm" placeholder="${esc(row.id)}" required></label>
<button type="submit">purge</button>
</form>`);
    actions.push(`<h2>set importance (pin / unpin)</h2>
<form method="post" action="${href}/importance" class="inline">${hidden}
<label><select name="importance">${importanceOptions}</select></label>
<input name="reason" placeholder="reason (required)" required>
<button type="submit">apply</button>
</form>`);

    return html(
      chrome(
        name,
        csrf,
        tenantCrumb(tenant, `memory ${row.id.slice(0, 8)}`),
        `<h1>memory ${esc(row.id.slice(0, 8))}</h1>
${retracted}
<p>${importancePill(row.importance)} strength ${esc(String(row.strength))} · boost_count ${esc(String(row.boost_count))} · embedding ${embedding}</p>
<pre>${esc(row.text)}</pre>
<table>
<tr><th>id</th><td>${esc(row.id)}</td></tr>
<tr><th>body_hash</th><td>${esc(row.body_hash)}</td></tr>
<tr><th>occurred_at</th><td>${esc(row.occurred_at)}</td></tr>
<tr><th>created_at</th><td>${esc(row.created_at)}</td></tr>
<tr><th>source</th><td>${esc(row.source ?? "—")}</td></tr>
<tr><th>source_ref</th><td>${esc(row.source_ref ?? "—")}</td></tr>
<tr><th>superseded_by</th><td>${superseded}</td></tr>
</table>
${actions.join("\n")}`,
      ),
    );
  }

  function pinsPage(tenant: string, name: string, csrf: string): Response {
    const ctx = ctxFor(tenant);
    const rows = ctx.store.listPinned();
    const hidden = `<input type="hidden" name="csrf" value="${esc(csrf)}">`;
    const bodyRows = rows
      .map((row) => {
        const href = tenantHref(tenant, `/m/${encodeURIComponent(row.id)}`);
        return `<tr>
<td><a href="${href}">${esc(truncate(row.text, 100))}</a><br><span class="muted">${esc(row.occurred_at)} · boost ${esc(String(row.boost_count))}</span></td>
<td><form method="post" action="${href}/importance" class="inline">${hidden}
<input type="hidden" name="next" value="${tenantHref(tenant, "/pins")}">
<select name="importance"><option value="default">default</option><option value="high">high</option></select>
<input name="reason" placeholder="reason" required>
<button type="submit">unpin</button></form></td>
<td><form method="post" action="${href}/correct">${hidden}
<input type="hidden" name="next" value="${tenantHref(tenant, "/pins")}">
<textarea name="newText" rows="2" style="width:100%" placeholder="corrected text" required></textarea>
<span class="inline"><input name="reason" placeholder="reason" required>
<button type="submit">correct</button></span></form></td>
</tr>`;
      })
      .join("\n");
    return html(
      chrome(
        name,
        csrf,
        tenantCrumb(tenant, "pins"),
        `<h1>${esc(tenant)} · pinned set (asker context)</h1>
${rows.length === 0 ? '<p class="muted">no pinned memories.</p>' : ""}
<table>
<tr><th>memory</th><th>unpin</th><th>correct</th></tr>
${bodyRows}
</table>`,
      ),
    );
  }

  function denylistPage(tenant: string, notice: string, name: string, csrf: string): Response {
    const ctx = ctxFor(tenant);
    const denied = ctx.store.listDenied(PAGE_LIMIT);
    const hidden = `<input type="hidden" name="csrf" value="${esc(csrf)}">`;
    const bodyRows = denied
      .map(
        (row) => `<tr><td><code>${esc(row.body_hash)}</code></td><td>${esc(row.reason)}</td><td>${esc(row.created_at)}</td></tr>`,
      )
      .join("\n");
    return html(
      chrome(
        name,
        csrf,
        tenantCrumb(tenant, "denylist"),
        `<h1>${esc(tenant)} · denylist</h1>
${notice ? `<p class="muted">${esc(notice)}</p>` : ""}
<p class="muted">denied hashes can never be ingested, even after the row is gone. re-ingest of purged text is blocked on every path.</p>
<table>
<tr><th>hash</th><th>reason</th><th>denied at</th></tr>
${bodyRows}
</table>
<h2>deny text preemptively</h2>
<p class="muted">for text that was never ingested: the text is hashed server-side and the hash is denied. writes an audit row with your operator name.</p>
<form method="post" action="${tenantHref(tenant, "/denylist/deny")}">${hidden}
<p><textarea name="text" rows="3" style="width:100%" placeholder="text to deny (required)" required></textarea></p>
<p class="inline"><input name="reason" placeholder="reason (required)" required>
<button type="submit">deny</button></p>
</form>`,
      ),
    );
  }

  function auditPage(tenant: string, name: string, csrf: string): Response {
    const ctx = ctxFor(tenant);
    const events = ctx.store.listCorrections(PAGE_LIMIT);
    const bodyRows = events
      .map(
        (event) => `<tr>
<td>${esc(String(event.seq))}</td>
<td>${esc(event.created_at)}</td>
<td>${event.actor ? esc(event.actor) : '<span class="muted">agent/tool</span>'}</td>
<td>${esc(event.action)}</td>
<td><code>${shortHash(event.body_hash)}</code>${event.new_hash ? ` → <code>${shortHash(event.new_hash)}</code>` : ""}</td>
<td>${esc(event.reason)}</td>
</tr>`,
      )
      .join("\n");
    return html(
      chrome(
        name,
        csrf,
        tenantCrumb(tenant, "audit"),
        `<h1>${esc(tenant)} · corrections audit</h1>
<p class="muted">append-only log, most recent first, capped at ${PAGE_LIMIT} rows.</p>
<table>
<tr><th>seq</th><th>at</th><th>actor</th><th>action</th><th>hashes</th><th>reason</th></tr>
${bodyRows}
</table>`,
      ),
    );
  }

  // ----------------------------------------------------------------- handler

  async function handleMutation(
    req: Request,
    auth: { name: string; csrf: string; cookie: string },
  ): Promise<Response | null> {
    const url = new URL(req.url);
    const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const data = await req.formData().catch(() => null);
    if (!data) return errorPage(400, "malformed form submission");
    const csrf = data.get("csrf");
    if (typeof csrf !== "string" || !safeEqualHex(auth.csrf, csrf)) {
      return errorPage(403, "CSRF token missing or invalid");
    }
    const tenant = segments[1]!;
    if (!opts.tenants.includes(tenant)) return errorPage(404, `unknown tenant ${tenant}`);
    const reason = requireReason(data);
    if (reason === null) return errorPage(400, "a reason is required for every mutation");

    if (segments[0] === "t" && segments.length === 4 && segments[2] === "denylist" && segments[3] === "deny") {
      const text = data.get("text");
      if (typeof text !== "string" || text.trim().length === 0) {
        return errorPage(400, "text to deny cannot be empty");
      }
      const hash = sha256Hex(text.trim());
      ctxFor(tenant).store.denyHash(hash, reason, auth.name);
      return seeOther(tenantHref(tenant, "/denylist"));
    }

    if (segments[0] === "t" && segments.length === 5 && segments[2] === "m") {
      const ctx = ctxFor(tenant);
      const id = segments[3]!;
      const action = segments[4]!;
      const target = { id };
      try {
        switch (action) {
          case "retract": {
            const { row } = ctx.store.retract(target, reason, undefined, auth.name);
            await deleteFromAnnBestEffort(ctx, row.id);
            return seeOther(tenantHref(tenant, `/m/${encodeURIComponent(id)}`));
          }
          case "unretract": {
            ctx.store.unretract(target, reason, undefined, auth.name);
            return seeOther(tenantHref(tenant, `/m/${encodeURIComponent(id)}`));
          }
          case "correct": {
            const newText = data.get("newText");
            if (typeof newText !== "string" || newText.trim().length === 0) {
              return errorPage(400, "replacement text cannot be empty");
            }
            const importance = validImportance(data.get("importance")) ?? "high";
            const { oldRow, newRow } = ctx.store.correct(target, newText, reason, importance, undefined, auth.name);
            await deleteFromAnnBestEffort(ctx, oldRow.id);
            // Best-effort embedding of the replacement, mirroring the MCP tool.
            const embedding = await ctx.embedder.embed(newText.trim()).catch(() => null);
            if (embedding) {
              ctx.store.updateEmbedding(newRow.id, embedding);
              if (ctx.pgvector) {
                await ctx.pgvector
                  .upsert(ctx.tenant, newRow.id, newRow.body_hash, embedding)
                  .catch((err) => {
                    console.warn(`pgvector upsert failed for tenant ${ctx.tenant}: ${(err as Error).message}`);
                  });
              }
            }
            const fallback = tenantHref(tenant, `/m/${encodeURIComponent(newRow.id)}`);
            return seeOther(safeNext(data.get("next"), fallback));
          }
          case "sanitize": {
            if (data.get("confirm") !== id) {
              return errorPage(400, "confirmation does not match the memory id; nothing was purged");
            }
            const { row } = ctx.store.sanitize(target, reason, undefined, auth.name);
            await deleteFromAnnBestEffort(ctx, row.id);
            return seeOther(tenantHref(tenant));
          }
          case "importance": {
            const importance = validImportance(data.get("importance"));
            if (!importance) return errorPage(400, "importance must be pinned, high or default");
            ctx.store.setImportance(target, importance, reason, auth.name);
            const fallback = tenantHref(tenant, `/m/${encodeURIComponent(id)}`);
            return seeOther(safeNext(data.get("next"), fallback));
          }
          default:
            return null;
        }
      } catch (err) {
        return errorPage(400, (err as Error).message);
      }
    }
    return null;
  }

  async function fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/healthz" && req.method === "GET") {
      // Deliberately sparse: no tenant names, store state or schema detail.
      return Response.json({ status: "ok", operators: opts.operators.map((o) => o.name) });
    }

    if (path === "/login") {
      if (req.method === "GET") return loginPage();
      if (req.method === "POST") {
        const data = await req.formData().catch(() => null);
        const name = data?.get("name");
        const token = data?.get("token");
        const presented =
          typeof token === "string" && token.length > 0
            ? Buffer.from(sha256Hex(token), "hex")
            : Buffer.alloc(0);
        // Constant-time digest compare against every entry, then a name check;
        // the operator and tenant token namespaces never mix (a tenant bearer
        // token hashes to a digest that simply matches no operator entry).
        const matched = opts.operators.find(
          (entry) =>
            presented.length === entry.digest.length && timingSafeEqual(presented, entry.digest),
        );
        if (!matched || matched.name !== name) {
          return new Response(loginBody("sign-in failed"), {
            status: 401,
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        }
        const session = issueSession(matched.name);
        return seeOther("/", {
          "set-cookie": `${SESSION_COOKIE}=${session.cookie}; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}; HttpOnly; SameSite=Strict; Path=/`,
        });
      }
      return errorPage(405, "method not allowed");
    }

    if (path === "/logout" && req.method === "POST") {
      const auth = authenticate(req);
      if (auth) sessions.delete(auth.cookie);
      return seeOther("/login", {
        "set-cookie": `${SESSION_COOKIE}=; Max-Age=0; HttpOnly; SameSite=Strict; Path=/`,
      });
    }

    const auth = authenticate(req);
    if (!auth) return redirectToLogin();

    if (req.method === "POST") {
      const mutated = await handleMutation(req, auth);
      if (mutated) return mutated;
      return errorPage(404, "not found");
    }

    if (req.method !== "GET") return errorPage(405, "method not allowed");

    if (path === "/") return dashboard(auth.name, auth.csrf);

    const segments = path.split("/").filter(Boolean).map(decodeURIComponent);
    if (segments[0] === "t" && segments.length >= 2) {
      const tenant = segments[1]!;
      if (!opts.tenants.includes(tenant)) return errorPage(404, `unknown tenant ${tenant}`);
      if (segments.length === 2) {
        return browserPage(
          tenant,
          {
            importance: url.searchParams.get("importance") ?? "all",
            status: url.searchParams.get("status") ?? "live",
            source: url.searchParams.get("source") ?? "",
            q: url.searchParams.get("q") ?? "",
          },
          auth.name,
          auth.csrf,
        );
      }
      if (segments.length === 3 && segments[2] === "pins") return pinsPage(tenant, auth.name, auth.csrf);
      if (segments.length === 3 && segments[2] === "denylist") {
        return denylistPage(tenant, url.searchParams.get("denied") ?? "", auth.name, auth.csrf);
      }
      if (segments.length === 3 && segments[2] === "audit") return auditPage(tenant, auth.name, auth.csrf);
      if (segments.length === 4 && segments[2] === "m") {
        return detailPage(tenant, segments[3]!, auth.name, auth.csrf);
      }
    }
    return errorPage(404, "not found");
  }

  return { fetch };
}
