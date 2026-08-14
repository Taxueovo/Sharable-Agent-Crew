import os from "node:os";
import path from "node:path";
import vinext from "vinext";
import { defineConfig, type Plugin } from "vite";
import { PUBLIC_BASE_URL } from "./lib/public-worker";
import { sites } from "./build/sites-vite-plugin";

// Development only: workerd's worker fetch does not support HTTP proxies (direct
// connections only), while corporate networks require a proxy to reach the LLM gateway.
// This plugin exposes a /llm-proxy relay endpoint on the Vite (Node) side: the worker
// POSTs LLM requests here, Node-side fetch forwards them to the real gateway (the dev
// process runs with --use-env-proxy, going through HTTP_PROXY/HTTPS_PROXY), and returns
// the response unchanged. Not enabled in production (Cloudflare), where the worker
// connects to the gateway directly.
function llmDevProxyPlugin(): Plugin {
  return {
    name: "llm-dev-proxy",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (req.method !== "POST" || !req.url?.startsWith("/llm-proxy")) return next();
        try {
          let body = "";
          for await (const chunk of req) body += chunk;
          const { targetUrl, body: payload, headers } = JSON.parse(body || "{}") as {
            targetUrl?: unknown;
            body?: unknown;
            headers?: Record<string, string>;
          };
          if (typeof targetUrl !== "string" || typeof payload !== "object" || payload === null) {
            res.statusCode = 400;
            res.end("bad request");
            return;
          }
          const upstream = await fetch(targetUrl, {
            method: "POST",
            headers: { "content-type": "application/json", ...(headers ?? {}) },
            body: JSON.stringify(payload),
          });
          res.statusCode = upstream.status;
          const upstreamContentType = upstream.headers.get("content-type");
          if (upstreamContentType) res.setHeader("content-type", upstreamContentType);
          res.end(await upstream.text());
        } catch (error) {
          res.statusCode = 502;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ error: String(error instanceof Error ? error.message : error) }));
        }
      });
    },
  };
}

// Sharing API relay (development only): the leader console runs on local localhost, but
// share-link creation/management must be written to the deployed Cloudflare worker
// (PUBLIC_BASE_URL). Browsers cannot reach workers.dev cross-origin from a corporate
// network — the proxy/firewall blocks it with a fetch error — so this plugin exposes a
// /share-api relay on the Vite (Node) side: the browser only requests the local
// same-origin address, and Node-side fetch forwards to the worker. The Node process runs
// with --use-env-proxy, going through HTTP_PROXY/HTTPS_PROXY — the same proven egress
// path as llm-dev-proxy. Not enabled in production (Cloudflare); worker endpoints
// are unchanged.
function shareApiProxyPlugin(): Plugin {
  return {
    name: "share-api-proxy",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (req.method !== "POST" || !req.url?.startsWith("/share-api")) return next();
        try {
          // Decode UTF-8 in one shot with Buffer.concat: per-chunk toString would
          // corrupt multi-byte characters that got split across TCP segments.
          const chunks: Uint8Array[] = [];
          for await (const chunk of req) chunks.push(Buffer.from(chunk));
          const body = Buffer.concat(chunks).toString("utf8");
          // Strip the /share-api prefix and forward to the worker's same-named API route
          // (slice keeps the query string).
          const upstream = await fetch(PUBLIC_BASE_URL + req.url.slice("/share-api".length), {
            method: "POST",
            headers: { "content-type": req.headers["content-type"] ?? "application/json" },
            body,
          });
          res.statusCode = upstream.status;
          const upstreamContentType = upstream.headers.get("content-type");
          if (upstreamContentType) res.setHeader("content-type", upstreamContentType);
          res.end(await upstream.text());
        } catch (error) {
          res.statusCode = 502;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ error: String(error instanceof Error ? error.message : error) }));
        }
      });
    },
  };
}

const SITE_CREATOR_PLACEHOLDER_DATABASE_ID =
  "00000000-0000-4000-8000-000000000000";

// Local-development bindings for the Cloudflare plugin. The binding names must
// match the worker's Env interface (DB, IMAGES). Production deployment reads
// wrangler.deploy.jsonc, which is not part of this repository.
const d1 = "DB";
const r2 = "IMAGES";

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";
// Running from a network drive (e.g. the W: delivery share) breaks two things:
// native fs.watch dies with errno -4094 / UNKNOWN, and writing the dep-optimizer
// cache / wrangler state to the share fails with write EOF. The launcher sets
// ARBOR_NETWORK_DRIVE=1 so we poll instead of watching and keep all write-heavy
// state on the local temp drive.
const isNetworkDrive = process.env.ARBOR_NETWORK_DRIVE === "1";
const usePolling = isCodexSeatbeltSandbox || isNetworkDrive;
const localStateDir = path.join(os.tmpdir(), "arbor-state", "site-creator");

const localBindingConfig = {
  main: "./worker/index.ts",
  compatibility_flags: ["nodejs_compat"],
  d1_databases: d1
    ? [
        {
          binding: d1,
          database_name: "site-creator-d1",
          database_id: SITE_CREATOR_PLACEHOLDER_DATABASE_ID,
        },
      ]
    : [],
  r2_buckets: r2
    ? [
        {
          binding: r2,
          bucket_name: "site-creator-r2",
        },
      ]
    : [],
  // Local-development-only bindings: these vars enter only the local workerd
  // (miniflare); the production deployment reads wrangler.deploy.jsonc and never sees
  // these values. ARBOR_LOCAL_DEV is the explicit switch that makes llm.ts use the dev
  // proxy; OPENAI_DEV_PROXY_URL is injected with the actual port by
  // scripts/arbor-local-server.mjs, falling back to the default 3000 when running
  // npm run dev directly.
  vars: {
    ARBOR_LOCAL_DEV: "1",
    OPENAI_DEV_PROXY_URL: process.env.ARBOR_DEV_PROXY_URL ?? "http://localhost:3000/llm-proxy",
  },
};

export default defineConfig(async () => {
  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  // On a network drive the share rejects writes, so move state to the local temp dir.
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH = isNetworkDrive
    ? path.join(localStateDir, "wrangler-logs")
    : (process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs");
  process.env.MINIFLARE_REGISTRY_PATH = isNetworkDrive
    ? path.join(localStateDir, "registry")
    : (process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry");

  // Wrangler snapshots its log path while the Cloudflare plugin is imported.
  const { cloudflare } = await import("@cloudflare/vite-plugin");

  return {
    server: usePolling
      ? { watch: { useFsEvents: false, usePolling: true } }
      : undefined,
    // Dep-optimizer cache normally lives in node_modules/.vite. An earlier version
    // redirected it to the local temp drive on network shares, but that broke the RSC
    // optimizer (vite-plugin-commonjs double-default-exports on the pre-bundled entry),
    // and the original EOF write failure was actually the workerd.exe crash, not the
    // share. Keep the default cache location.
    cacheDir: undefined,
    plugins: [
      llmDevProxyPlugin(),
      shareApiProxyPlugin(),
      vinext(),
      sites(),
      cloudflare({
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
        config: localBindingConfig,
        // On a network drive, workerd cannot write persistent files to .wrangler/state
        // and crashes with write EOF on startup. Redirect the miniflare persistence
        // directory to the local temp drive (consistent with
        // WRANGLER_LOG_PATH / MINIFLARE_REGISTRY_PATH).
        persistState: isNetworkDrive
          ? { path: path.join(localStateDir, "miniflare") }
          : undefined,
      }),
    ],
  };
});
