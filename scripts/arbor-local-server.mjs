#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import net from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const requestedPort = Number.parseInt(process.argv[2] ?? "3000", 10);
const publicPort = Number.isInteger(requestedPort) && requestedPort > 0 ? requestedPort : 3000;

function configuredIdleMinutes() {
  if (process.env.ARBOR_IDLE_MINUTES) return Number(process.env.ARBOR_IDLE_MINUTES);
  try {
    const match = readFileSync(resolve(projectDir, ".env"), "utf8").match(/^ARBOR_IDLE_MINUTES\s*=\s*["']?([^\r\n"']+)/m);
    if (match) return Number(match[1].trim());
  } catch { /* .env is optional for the launcher itself */ }
  return 30;
}

const configuredMinutes = configuredIdleMinutes();
const idleMinutes = Number.isFinite(configuredMinutes) && configuredMinutes > 0 ? configuredMinutes : 30;
const idleMilliseconds = idleMinutes * 60_000;
let lastActivityAt = Date.now();
let shuttingDown = false;
const sockets = new Set();

// When the browser closes, the frontend sends POST /api/local-activity?close=1. After
// receiving it, keep a short grace period before exiting so that a page refresh /
// navigation back has a buffer — a newly loaded page immediately sends a heartbeat
// that cancels the shutdown.
const browserCloseGraceMs = 10_000;
let closingTimer = null;

function cancelClose() {
  if (closingTimer) {
    clearTimeout(closingTimer);
    closingTimer = null;
  }
}

function scheduleClose(reason) {
  if (closingTimer || shuttingDown) return;
  closingTimer = setTimeout(() => shutdown(`${reason} — Arbor has shut down automatically.`, 0), browserCloseGraceMs);
}

function canListen(port) {
  return new Promise((resolveResult) => {
    const probe = net.createServer();
    probe.unref();
    probe.once("error", () => resolveResult(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolveResult(true)));
  });
}

async function findInternalPort() {
  for (let port = Math.max(3100, publicPort + 100); port < Math.max(3200, publicPort + 200); port += 1) {
    if (await canListen(port)) return port;
  }
  throw new Error("No available internal port found");
}

// Vite's native fs.watch crashes on SMB / network drives (errno -4094 / UNKNOWN), and
// writing the cache to a shared drive fails with write EOF, which would make the dev
// server exit right after starting. When the project lives on a non-system drive (such
// as the W: delivery share) or a UNC path, enable ARBOR_NETWORK_DRIVE: Vite switches to
// polling and redirects the cache to the local temp drive (see vite.config.ts).
function projectUsesPollingWatch() {
  const resolved = resolve(projectDir);
  if (/^\\\\/.test(resolved)) return true;
  if (process.platform !== "win32") return false;
  const systemDrive = (process.env.SystemDrive || "C:").toLowerCase();
  return resolved.slice(0, 2).toLowerCase() !== systemDrive;
}

const internalPort = await findInternalPort();
const vinextCli = resolve(projectDir, "node_modules/vinext/dist/cli.js");
// `--use-env-proxy` makes the dev server's (Node-side) fetch go through
// HTTP_PROXY/HTTPS_PROXY; without it, direct connections to the gateway are blocked by
// corporate DNS filtering. `--use-system-ca` makes Node trust the Windows system
// certificate store: the corporate proxy does TLS interception (MITM) on some external
// domains (e.g. workers.dev), and its CA only lives in the system store — with only
// Node's built-in CAs you get UNABLE_TO_GET_ISSUER_CERT_LOCALLY, which breaks the
// /share-api relay (and any fetch to an external domain). Worker fetch inside workerd is
// unaffected; see the llm-dev-proxy relay in vite.config.ts.
const child = spawn(process.execPath, ["--use-env-proxy", "--use-system-ca", vinextCli, "dev", "--port", String(internalPort)], {
  cwd: projectDir,
  detached: process.platform !== "win32",
  env: {
    ...process.env,
    // The dev proxy binding is injected with the actual public port (the port is
    // chosen dynamically from 3000-3010 by the .bat launcher) for vite.config.ts's
    // local vars to read; the value only enters the local workerd, never the
    // Cloudflare production deployment.
    ARBOR_DEV_PROXY_URL: `http://localhost:${publicPort}/llm-proxy`,
    WRANGLER_LOG_PATH: resolve(projectDir, ".wrangler/wrangler.log"),
    ...(projectUsesPollingWatch() ? { ARBOR_NETWORK_DRIVE: "1" } : {}),
  },
  stdio: "inherit",
});

function terminateChild() {
  if (!child.pid) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    return;
  }
  try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
  setTimeout(() => {
    try { process.kill(-child.pid, "SIGKILL"); } catch { /* process already stopped */ }
  }, 4_000).unref();
}

const proxy = net.createServer((client) => {
  sockets.add(client);
  client.once("close", () => sockets.delete(client));
  client.once("error", () => sockets.delete(client));
  client.once("data", (firstChunk) => {
    client.pause();
    const requestLine = firstChunk.toString("latin1", 0, Math.min(firstChunk.length, 256)).split("\r\n", 1)[0] ?? "";
    if (/^POST \/api\/local-activity(?:[ ?])/.test(requestLine)) {
      if (/close=1/.test(requestLine)) {
        scheduleClose("Browser closed");
      } else {
        cancelClose();
        lastActivityAt = Date.now();
      }
      client.end("HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
      return;
    }
    if (/^POST \/(?:api|share-api)\//.test(requestLine)) {
      cancelClose();
      lastActivityAt = Date.now();
    }
    const upstream = net.createConnection({ host: "localhost", port: internalPort });
    sockets.add(upstream);
    upstream.once("close", () => sockets.delete(upstream));
    upstream.once("error", () => { sockets.delete(upstream); client.destroy(); });
    upstream.once("connect", () => {
      upstream.write(firstChunk);
      client.pipe(upstream);
      upstream.pipe(client);
      client.resume();
    });
  });
});

function shutdown(reason, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${reason}`);
  clearInterval(idleTimer);
  proxy.close();
  for (const socket of sockets) socket.destroy();
  terminateChild();
  setTimeout(() => process.exit(exitCode), 1_000).unref();
}

proxy.once("error", (error) => shutdown(`Failed to start the local port: ${error.message}`, 1));
proxy.listen(publicPort, () => {
  console.log(`Arbor local address: http://localhost:${publicPort}`);
  console.log(`It will shut down and free the port about 10 seconds after the browser closes, or after ${idleMinutes} minutes without activity.`);
});

const idleTimer = setInterval(() => {
  if (Date.now() - lastActivityAt >= idleMilliseconds) shutdown(`No activity for ${idleMinutes} minutes — Arbor has shut down automatically.`);
}, Math.min(10_000, Math.max(1_000, idleMilliseconds / 4)));
idleTimer.unref();

child.once("exit", (code) => {
  if (!shuttingDown) shutdown("Arbor server has stopped.", code ?? 0);
});
process.once("SIGINT", () => shutdown("Shutting down Arbor..."));
process.once("SIGTERM", () => shutdown("Shutting down Arbor..."));
