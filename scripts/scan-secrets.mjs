import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const ignored = new Set([".git", ".next", ".vinext", ".wrangler", "dist", "node_modules", "vendor"]);
const patterns = [
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ["GitHub token", /\bgh[oprsu]_[A-Za-z0-9]{30,}\b/],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["OpenAI-style key", /\bsk-[A-Za-z0-9_-]{20,}\b/],
];
const findings = [];

async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(target);
    else if (entry.isFile() && !/\.(?:png|jpe?g|gif|ico|pdf|tgz|xlsx)$/i.test(entry.name)) {
      const text = await readFile(target, "utf8").catch(() => "");
      for (const [label, pattern] of patterns) if (pattern.test(text)) findings.push(`${label}: ${path.relative(root, target)}`);
    }
  }
}

await walk(root);
if (findings.length) {
  console.error(findings.join("\n"));
  process.exitCode = 1;
} else {
  console.log("Secret scan passed.");
}
