---
tags: [monitoring, sentry, logging]
---

# Sentry Telemetry Configuration

- Sentry SDK initialized in `src/telemetry/sentry.ts`.
- Environment tag injected from Railway `RAILWAY_ENVIRONMENT_NAME`.
- Scrub sensitive headers: `Authorization`, `Cookie`, `X-Vault-Token` before sending events.
