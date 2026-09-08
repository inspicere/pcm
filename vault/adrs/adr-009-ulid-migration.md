---
date: 2026-09-02
status: accepted
supersedes: "[[adr-002-database-keys]]"
tags: [database, postgres, performance, schema]
---

# ADR 009: ULID Migration for Database Primary Keys

## Context
UUIDv4 generated severe B-tree write amplification and random page splits under high throughput. We evaluated Snowflake IDs, KSUID, and ULIDs.

## Decision
Supersedes [[adr-002-database-keys]].
All new database tables must use ULID (26-character Crockford base32 monotonic string) as the primary key.
Do NOT use UUIDv4 or auto-incrementing integers for any new tables.

Example schema definition:
```sql
CREATE TABLE billing_invoices (
  id VARCHAR(26) PRIMARY KEY, -- ULID
  user_id VARCHAR(26) NOT NULL,
  amount_cents INT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

## Consequences
- Preserves natural B-tree index insertion order.
- Time-sortable within milliseconds.
