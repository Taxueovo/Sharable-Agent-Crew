# Public release checklist

This repository is safe to publish as source only after `pnpm release:check` passes.
The check scans the public tree for credentials, local paths, runtime databases,
private configuration and unsafe vendored-archive entries, then runs lint, type
checking, production build, tests and all migrations against a fresh local D1.
Also run `pnpm audit --prod --audit-level high` immediately before publication.

## Source publication

1. Publish this clean repository history, not an older private repository history.
2. Keep `.env`, `wrangler.deploy.jsonc`, D1 state, build output and runtime work files ignored.
3. Enable GitHub secret scanning, push protection, Dependabot alerts and private vulnerability reporting.
4. Require the CI workflow before merging to `main`.

## Deployment is separate

Making the source public does not configure a deployment. Copy
`wrangler.deploy.example.jsonc` to the ignored `wrangler.deploy.jsonc`, create a
D1 database, apply migrations, and install secrets with `wrangler secret put`.
Never commit the real database id, account metadata, API keys, publish/admin
tokens or signing secrets.

For a public deployment, set `REQUIRE_AUTHENTICATED_PUBLISHER=1`, configure
ChatGPT authentication or Cloudflare Access, set conservative quotas, and verify
the model provider's data-retention policy before accepting user content.
