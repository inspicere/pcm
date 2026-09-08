---
tags: [redis, caching, performance]
---

# Redis Cache Invalidation Policies

- Session tokens: 7-day TTL with sliding window extension on active API requests.
- Rate limits: 60-second sliding window counter using Redis sorted sets (`ZADD`, `ZREMRANGEBYSCORE`).
- Vault tokens: Cached for 60 seconds with explicit invalidation upon revocation.
