# Human Developer Preferences & Security Invariants

These are my personal core rules for all coding agents and automated workflows:

## Security Rules [NON-NEGOTIABLE]
- [CRITICAL]: NEVER log, echo, or write raw auth tokens, decrypted secrets, or private keys to stdout, console, or logger, even in DEBUG mode. Always mask or redact tokens to the first 4 characters (e.g. `token.slice(0, 4) + '...'`).
- Database credentials must only be loaded via environment variables; never hardcode passwords.

## Tech Stack & Tooling
- Always use Bun runtime and Bun test runner (`bun test`) for all TypeScript scripts and test suites. Do not install or run Vitest, Jest, or npm.
- Format with Prettier, lint with strict ESLint.
