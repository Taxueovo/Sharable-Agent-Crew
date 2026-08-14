#!/usr/bin/env node
// Cross-platform wrapper for the vinext CLI. Sets WRANGLER_LOG_PATH before
// launching, so scripts work on Windows (cmd.exe) and Unix alike.
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const command = process.argv[2];
if (!command) {
  console.error("Usage: node scripts/run-vinext.mjs <dev|build|start> [extra args...]");
  process.exit(1);
}
const cli = resolve(projectDir, "node_modules/vinext/dist/cli.js");
// `--use-env-proxy` makes the dev server's Node-side fetch go through
// HTTP_PROXY/HTTPS_PROXY (corporate networks block direct connections with DNS
// filtering, so external gateways are only reachable via the proxy). `--use-system-ca`
// makes Node trust the Windows system certificate store; otherwise the proxy's TLS
// interception (MITM) of external domains such as workers.dev fails with
// UNABLE_TO_GET_ISSUER_CERT_LOCALLY (see share-api-proxy in vite.config.ts). Worker
// fetch inside workerd is unaffected; see llm-dev-proxy in vite.config.ts.
const nodeArgs = ["--use-env-proxy", "--use-system-ca", cli, command, ...process.argv.slice(3)];
const child = spawn(process.execPath, nodeArgs, {
  cwd: projectDir,
  stdio: "inherit",
  env: { ...process.env, WRANGLER_LOG_PATH: resolve(projectDir, ".wrangler/wrangler.log") },
});
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
child.on("error", (error) => {
  console.error(`Failed to start vinext: ${error.message}`);
  process.exit(1);
});
