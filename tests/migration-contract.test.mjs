import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("publisher identity migration is journaled", async () => {
  const journal = JSON.parse(await readFile(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"));
  const tag = journal.entries.at(-1).tag;
  const sql = await readFile(new URL(`../drizzle/${tag}.sql`, import.meta.url), "utf8");
  assert.match(sql, /owner_user_hash/);
  assert.match(tag, /^0003_/);
});
