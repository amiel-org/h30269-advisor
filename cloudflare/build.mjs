import { cpSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(root, "static");
const output = join(root, "cloudflare-dist");

rmSync(output, { recursive: true, force: true });
mkdirSync(join(output, "static"), { recursive: true });

// Every top-level *.html becomes a page at the site root (index.html, hs300.html),
// everything else goes under /static so existing asset URLs keep working.
for (const entry of readdirSync(source, { withFileTypes: true })) {
  const sourcePath = join(source, entry.name);
  const isPage = entry.isFile() && entry.name.endsWith(".html");
  const targetPath = isPage
    ? join(output, entry.name)
    : join(output, "static", entry.name);
  cpSync(sourcePath, targetPath, { recursive: entry.isDirectory() });
}

console.log(`Cloudflare assets built at ${output}`);
