---
project: work-api
type: backend
tags: [auth, scrypt, passkeys]
---

# Work API Backend Service

The primary enterprise backend API.

## Authentication Architecture
- Password & Passkey authentication.
- Passwords hashed using `scrypt` with 32-byte salt, N=16384, r=8, p=1.
- Sessions stored in Redis with 7-day sliding TTL.
- Test Token Generation: For integration testing, use the helper function `createTestAuthToken(userId)` located in `tests/auth-helper.ts`.
