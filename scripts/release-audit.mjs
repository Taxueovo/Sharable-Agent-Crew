import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { extname, join, relative } from "node:path";

const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const ignoredDirectories = new Set([".git", ".next", ".vinext", ".wrangler", "dist", "node_modules", "outputs", "work", ".arbor-runtime"]);
const forbiddenFiles = [/(^|\/)\.env($|\.)/, /(^|\/)wrangler\.deploy\.jsonc$/, /\.(?:pem|key|p12|pfx|sqlite|sqlite3|db)$/i];
const textExtensions = new Set([".cjs", ".css", ".html", ".js", ".json", ".jsonc", ".jsx", ".md", ".mjs", ".sql", ".svg", ".ts", ".tsx", ".txt", ".yaml", ".yml"]);
const secretPatterns = [
  /AKIA[0-9A-Z]{16}/,
  /gh[pousr]_[A-Za-z0-9_]{30,}/,
  /sk-[A-Za-z0-9_-]{20,}/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /(?:api[_-]?key|password|secret|token)\s*[:=]\s*["'][A-Za-z0-9_./+=-]{16,}["']/i,
];
const privatePathPatterns = [
  new RegExp(["/", "Users", "/", "[^/]+", "/"].join("")),
  new RegExp(["[A-Za-z]:", "\\\\", "Users", "\\\\", "[^\\\\]+", "\\\\"].join("")),
  /(?:^|\/)data\/(?:cases|chroma|specs)(?:\/|\.)/i,
];
const files = [];

function walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Symbolic links are not publishable: ${relative(root, path)}`);
    if (entry.isDirectory()) walk(path);
    else if (entry.isFile()) files.push(path);
  }
}

walk(root);
for (const path of files) {
  const name = relative(root, path).replaceAll("\\", "/");
  if (name !== ".env.example" && forbiddenFiles.some((pattern) => pattern.test(name))) throw new Error(`Forbidden release file: ${name}`);
  if (lstatSync(path).size > 25 * 1024 * 1024) throw new Error(`File exceeds 25 MiB: ${name}`);
  if (!textExtensions.has(extname(name).toLowerCase())) continue;
  const text = readFileSync(path, "utf8");
  if (secretPatterns.some((pattern) => pattern.test(text))) throw new Error(`Possible credential in ${name}`);
  if (privatePathPatterns.some((pattern) => pattern.test(text))) throw new Error(`Private/local path in ${name}`);
}

for (const required of ["LICENSE", "README.md", ".github/SECURITY.md", ".env.example", "PUBLICATION.md"]) {
  if (!existsSync(join(root, required))) throw new Error(`Missing release file: ${required}`);
}

const archive = join(root, "vendor/xlsx-0.20.3.tgz");
if (existsSync(archive)) {
  const digest = createHash("sha256").update(readFileSync(archive)).digest("hex");
  if (digest !== "d60045c10102c70c93806380c0e2e69fd12d1a84cad134d6c352803bc4f59ff2") throw new Error("Vendored xlsx archive checksum mismatch");
  const entries = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" }).trim().split("\n");
  if (entries.some((entry) => entry.startsWith("/") || entry.split("/").includes("..") || /(?:^|\/)\.env(?:$|\.)|\.(?:pem|key)$/i.test(entry))) {
    throw new Error("Vendored archive contains an unsafe path or sensitive file");
  }
  if (!entries.some((entry) => /(?:^|\/)LICENSE$/.test(entry))) throw new Error("Vendored xlsx archive has no license file");
}

console.log(`Release audit passed (${files.length} publishable files scanned).`);
