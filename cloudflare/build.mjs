import { cpSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(root, "static");
const output = join(root, "cloudflare-dist");

// A syntax error prevents the entire module from executing, including its
// error handler. Fail the build before such a script can reach production.
for (const entry of readdirSync(source, { withFileTypes: true })) {
  if (entry.isFile() && entry.name.endsWith(".js")) {
    execFileSync(process.execPath, ["--check", join(source, entry.name)], { stdio: "inherit" });
  }
}

// Keep the watched root directory: Windows locks it while wrangler dev serves
// assets. Remove its contents so obsolete assets still disappear on rebuild.
mkdirSync(output, { recursive: true });
for (const entry of readdirSync(output)) rmSync(join(output, entry), { recursive: true, force: true });
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
