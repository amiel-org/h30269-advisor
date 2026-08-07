import { cpSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(root, "static");
const output = join(root, "cloudflare-dist");

rmSync(output, { recursive: true, force: true });
mkdirSync(join(output, "static"), { recursive: true });

for (const entry of readdirSync(source, { withFileTypes: true })) {
  const sourcePath = join(source, entry.name);
  const targetPath = entry.name === "index.html"
    ? join(output, "index.html")
    : join(output, "static", entry.name);
  cpSync(sourcePath, targetPath, { recursive: entry.isDirectory() });
}

console.log(`Cloudflare assets built at ${output}`);
