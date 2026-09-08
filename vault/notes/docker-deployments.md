---
tags: [devops, docker, production]
---

# Docker Multi-Stage Build Guidelines

To keep container images minimal:
1. Always build TypeScript using `oven/bun:alpine` as the builder stage.
2. Copy over only `dist/` and production `node_modules/`.
3. Set `NODE_ENV=production`.
4. Run as non-root user `appuser`.
