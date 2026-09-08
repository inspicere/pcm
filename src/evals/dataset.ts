export interface EvalTestCase {
  id: string;
  category: "precision_rerank" | "project_scoping" | "decay_savings" | "slot_budgeting" | "semantic_paraphrase";
  description: string;
  userQuery: string;
  targetProject?: string;
  targetLens?: "agent" | "personal" | "reference" | "associative";
  memoriesToIngest: Array<{
    id: string;
    text: string;
    importance: "pinned" | "high" | "default";
    project?: string;
    daysAgo?: number;
    boostCount?: number;
    isGroundTruth?: boolean;
  }>;
  expectedTopMemoryId: string;
  expectedMinimumRank?: number;
}

export const GOLDEN_EVAL_DATASET: EvalTestCase[] = [
  {
    id: "eval-01-paraphrase",
    category: "semantic_paraphrase",
    description: "Indirect semantic query with zero lexical keyword overlap",
    userQuery: "How are we securing customer credentials in the database?",
    targetProject: "skillvault",
    memoriesToIngest: [
      {
        id: "mem-auth-scrypt",
        text: "Passkeys and passwords use scrypt with 32-byte salt and N=16384 cost parameter",
        importance: "high",
        project: "skillvault",
        isGroundTruth: true,
      },
      {
        id: "mem-distractor-1",
        text: "Customer billing utilizes Stripe Elements for PCI-DSS compliance",
        importance: "default",
        project: "skillvault",
      },
      {
        id: "mem-distractor-2",
        text: "Database queries run over TLS 1.3 with SSLMode=verify-full",
        importance: "default",
        project: "skillvault",
      },
      {
        id: "mem-distractor-3",
        text: "Configured Sentry DSN for error telemetry and exception tracking",
        importance: "default",
        project: "skillvault",
      },
      {
        id: "mem-distractor-4",
        text: "Redis rate limiting runs sliding window counter across 60-second intervals",
        importance: "default",
        project: "skillvault",
      },
    ],
    expectedTopMemoryId: "mem-auth-scrypt",
    expectedMinimumRank: 1,
  },
  {
    id: "eval-02-project-bias",
    category: "project_scoping",
    description: "Disambiguates between identical keywords across different project scopes",
    userQuery: "What database ORM/client library do we use?",
    targetProject: "skillvault",
    memoriesToIngest: [
      {
        id: "mem-proj-skillvault",
        text: "SkillVault uses node-postgres Pool with raw parameterized SQL and zero ORM overhead",
        importance: "high",
        project: "skillvault",
        isGroundTruth: true,
      },
      {
        id: "mem-proj-ecommerce",
        text: "E-Commerce backend uses Prisma ORM with PostgreSQL client extensions",
        importance: "high",
        project: "ecommerce-app",
      },
      {
        id: "mem-proj-analytics",
        text: "Analytics service queries ClickHouse using clickhouse-js client",
        importance: "high",
        project: "analytics-pipeline",
      },
    ],
    expectedTopMemoryId: "mem-proj-skillvault",
    expectedMinimumRank: 1,
  },
  {
    id: "eval-03-pinned-vs-decayed",
    category: "decay_savings",
    description: "Pinned preference always outranks stale decayed decisions",
    userQuery: "Which test framework should we run?",
    memoriesToIngest: [
      {
        id: "mem-pinned-bun",
        text: "Always use Bun test runner (`bun test`) for all unit and integration test suites",
        importance: "pinned",
        daysAgo: 120, // 4 months old, but pinned
        isGroundTruth: true,
      },
      {
        id: "mem-old-jest",
        text: "Ran Jest with ts-jest in early prototype",
        importance: "default",
        daysAgo: 90,
        boostCount: 0,
      },
      {
        id: "mem-old-mocha",
        text: "Evaluated Mocha and Chai for test runner",
        importance: "default",
        daysAgo: 60,
        boostCount: 0,
      },
    ],
    expectedTopMemoryId: "mem-pinned-bun",
    expectedMinimumRank: 1,
  },
  {
    id: "eval-04-distractor-flood",
    category: "precision_rerank",
    description: "Survives 15 distractor memories to pull exact target",
    userQuery: "Where are short-lived session tokens stored?",
    memoriesToIngest: [
      {
        id: "mem-tokens-redis",
        text: "Session tokens and CSRF nonces are stored in Redis with 30-minute expiration TTL",
        importance: "high",
        project: "skillvault",
        isGroundTruth: true,
      },
      { id: "d1", text: "MinIO bucket holds user uploaded skill tarballs", importance: "default" },
      { id: "d2", text: "Railway deployment runs bun run start on port 8080", importance: "default" },
      { id: "d3", text: "Stripe webhook handles customer.subscription.deleted", importance: "default" },
      { id: "d4", text: "MailerLite syncs paid subscriber status", importance: "default" },
      { id: "d5", text: "Tailwind CSS builds styles to dist/main.css", importance: "default" },
      { id: "d6", text: "Zod schemas validate incoming JSON payloads", importance: "default" },
      { id: "d7", text: "Plausible analytics tracks page views", importance: "default" },
      { id: "d8", text: "Docker compose spins up local postgres and redis", importance: "default" },
      { id: "d9", text: "ESLint enforces no-unused-vars rule", importance: "default" },
      { id: "d10", text: "GitHub actions run CI tests on pull request", importance: "default" },
    ],
    expectedTopMemoryId: "mem-tokens-redis",
    expectedMinimumRank: 1,
  },
  {
    id: "eval-05-git-milestone",
    category: "precision_rerank",
    description: "Recalls auto-ingested git commit milestones with author and diff context",
    userQuery: "When did we add Stripe grace period handling in billing?",
    targetProject: "skillvault",
    memoriesToIngest: [
      {
        id: "mem-commit-grace-period",
        text: "Commit [7f2a1b9] by Anthony: feat(billing): add grace period for past_due stripe subscriptions\nFiles: apps/server/src/billing/service.ts",
        importance: "high",
        project: "skillvault",
        isGroundTruth: true,
      },
      {
        id: "mem-commit-ui-css",
        text: "Commit [3a9c8e1] by Anthony: fix(ui): adjust dashboard button alignment and colors",
        importance: "default",
        project: "skillvault",
      },
      {
        id: "mem-commit-docs",
        text: "Commit [1d4e5f2] by Anthony: docs: update README with install instructions",
        importance: "default",
        project: "skillvault",
      },
    ],
    expectedTopMemoryId: "mem-commit-grace-period",
    expectedMinimumRank: 1,
  },
  {
    id: "eval-06-session-wrap",
    category: "semantic_paraphrase",
    description: "Recalls bug root-causes and solutions captured via session wrap",
    userQuery: "Why were SSH proxy connections failing with 403 previously?",
    targetProject: "skillvault",
    memoriesToIngest: [
      {
        id: "mem-wrap-ssh-fix",
        text: "Fixed 403 ssh_host_key_not_pinned error by auto-detecting host fingerprint via ssh-keyscan and requesting user confirmation",
        importance: "high",
        project: "skillvault",
        isGroundTruth: true,
      },
      {
        id: "mem-wrap-other-1",
        text: "Configured CORS policy for web dashboard on port 3000",
        importance: "default",
        project: "skillvault",
      },
      {
        id: "mem-wrap-other-2",
        text: "Added rate limiting headers X-RateLimit-Remaining to API responses",
        importance: "default",
        project: "skillvault",
      },
    ],
    expectedTopMemoryId: "mem-wrap-ssh-fix",
    expectedMinimumRank: 1,
  },
];
