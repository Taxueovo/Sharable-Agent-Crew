import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("public model routes enforce a run session or local-only boundary", async () => {
  const turn = await read("app/api/turn/route.ts");
  const conversation = await read("app/api/conversation/route.ts");
  const run = await read("app/api/run/route.ts");
  const evolve = await read("app/api/evolve/route.ts");
  assert.match(turn, /isLocalDevelopmentRequest\(request\)/);
  assert.match(conversation, /authorizeRun\(request/);
  assert.match(conversation, /conversation-month/);
  assert.match(conversation, /output-tokens-day/);
  assert.match(run, /isLocalDevelopmentRequest\(request\)/);
  assert.match(evolve, /isLocalDevelopmentRequest\(request\)/);
});

test("run sessions support safe key rotation and observations exclude content", async () => {
  const security = await read("lib/security.ts");
  const observations = await read("lib/observability.ts");
  assert.match(security, /RUN_SESSION_SECRET_PREVIOUS/);
  assert.doesNotMatch(observations, /task|transcript|attachment/i);
});

test("publishing requires a server-side token and CORS is not wildcarded", async () => {
  const teams = await read("app/api/teams/route.ts");
  const cors = await read("lib/cors.ts");
  assert.match(teams, /PUBLISH_TOKEN/);
  assert.doesNotMatch(cors, /allow-origin["']\s*:\s*["']\*/i);
});

test("browser storage does not persist bearer management credentials", async () => {
  const page = await read("app/page.tsx");
  assert.doesNotMatch(page, /localStorage\.(?:getItem|setItem)\("arbor-(?:managed-links|admin-token)"/);
});
