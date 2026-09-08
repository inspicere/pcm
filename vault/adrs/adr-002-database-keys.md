---
date: 2026-03-10
status: deprecated
superseded_by: "[[adr-009-ulid-migration]]"
tags: [database, postgres, schema]
---

# ADR 002: Standardize on UUIDv4 Primary Keys

## Context
When building initial microservices, we needed globally unique identifiers for database rows to prevent enumeration attacks common with auto-incrementing serial IDs.

## Decision
All PostgreSQL tables will use UUIDv4 generated via `gen_random_uuid()` or the `uuid-ossp` extension.
Every table schema must specify:
`id UUID PRIMARY KEY DEFAULT gen_random_uuid()`

## Consequences
- Random distribution creates B-tree index fragmentation at high insert volumes.
- UUIDv4 is non-sequential.
