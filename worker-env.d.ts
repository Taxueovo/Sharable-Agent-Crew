/**
 * Cloudflare Worker environment bindings.
 *
 * Merges with the `Env` interface inside the `Cloudflare` namespace provided by
 * `@cloudflare/workers-types` (`cloudflare:workers`). A project-side declaration
 * inside `declare global` merges with the library's global namespace. `wrangler
 * types` can regenerate an equivalent file from the deployment config when
 * bindings change.
 */
declare global {
  namespace Cloudflare {
    interface Env {
      // Cloudflare bindings (wrangler.deploy.jsonc)
      ASSETS: Fetcher;
      DB: D1Database;
      IMAGES: {
        input(stream: ReadableStream): {
          transform(options: Record<string, unknown>): {
            output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
          };
        };
      };

      // Secrets and configuration (set via `wrangler secret put` / `.env`)
      OPENAI_API_KEY: string;
      OPENAI_BASE_URL: string;
      OPENAI_MODEL: string;
      OPENAI_VISION_ENABLED: string;
      ADMIN_TOKEN: string;
      PUBLISH_TOKEN: string;
      RUN_SESSION_SECRET: string;
      RUN_SESSION_SECRET_PREVIOUS: string;
      RUN_SESSION_SECRET_ID: string;
      MAX_TEAM_RUNS_PER_MONTH: string;
      MAX_TEAM_OUTPUT_TOKENS_PER_DAY: string;
      REQUIRE_AUTHENTICATED_PUBLISHER: string;

      // Local development only (injected by vite.config.ts, guarded by ARBOR_LOCAL_DEV=1)
      OPENAI_DEV_PROXY_URL: string;
      ARBOR_LOCAL_DEV: string;
    }
  }
}

export {};
