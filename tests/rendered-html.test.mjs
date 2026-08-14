import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    {
      ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
    },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the Arbor team builder", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>Arbor · Multi-Agent Teams<\/title>/i);
  assert.match(html, /Start your team from Planner–Worker/);
  assert.match(html, /Configure members/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape/);
});

test("keeps the Cloudflare deploy scripts configured", async () => {
  const packageJson = await readFile(new URL("../package.json", import.meta.url), "utf8");

  assert.match(packageJson, /"deploy:cloudflare"/);
  assert.match(packageJson, /"db:migrate:cloudflare"/);
});
