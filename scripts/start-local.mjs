import { spawn } from "node:child_process";
import { copyFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const varsSource = path.join(projectRoot, ".dev.vars");
const varsDestination = path.join(projectRoot, "dist", "server", ".dev.vars");
const wrangler = path.join(projectRoot, "node_modules", "wrangler", "bin", "wrangler.js");
await rm(varsDestination, { force: true });
await copyFile(varsSource, varsDestination);
const child = spawn(process.execPath, [
  "--import", path.join(projectRoot, "scripts", "sites-env.mjs"), wrangler,
  "dev", "--config", "dist/server/wrangler.json", "--local", "--persist-to", ".wrangler/state",
  "--ip", "127.0.0.1", "--inspector-port", "0",
], { cwd: projectRoot, stdio: "inherit" });
try {
  process.exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve(signal ? 1 : (code ?? 1)));
  });
} finally {
  await rm(varsDestination, { force: true });
}