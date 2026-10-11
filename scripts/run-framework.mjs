import { spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readExecutionProfile } from "./execution-profile.mjs";

const [command, ...args] = process.argv.slice(2);
if (!["dev", "build"].includes(command)) throw new Error("Expected dev or build.");
const managedLinux = readExecutionProfile() === "managed-linux";
const localAuthPort = (() => {
  try {
    const vars = readFileSync(new URL("../.dev.vars", import.meta.url), "utf8");
    const value = vars.match(/^AUTH_BASE_URL=(.+)$/m)?.[1]?.trim();
    return value ? new URL(value).port || "5173" : "5173";
  } catch {
    return "5173";
  }
})();

if (managedLinux && command === "build") {
  let result;
  try {
    result = spawnSync("bash", [
      fileURLToPath(new URL("./build-verified.sh", import.meta.url)), ...args,
    ], { stdio: "inherit" });
    if (result.error) throw result.error;
  } finally {
    rmSync(fileURLToPath(new URL("../dist/server/.dev.vars", import.meta.url)), { force: true });
  }
  process.exit(result.status ?? 1);
}

// Import in this process so the preview owner retains its PID and signals.
const cli = new URL(managedLinux
  ? "../node_modules/vite/bin/vite.js"
  : "../node_modules/vinext/dist/cli.js", import.meta.url);
if (command === "build") {
  try {
    // Run the CLI as a child: Vite may terminate its process after finishing,
    // which would skip cleanup if it were imported into this wrapper.
    const result = spawnSync(process.execPath, [fileURLToPath(cli), command, ...args], { stdio: "inherit" });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  } finally {
    // The plugin emits local secrets as a preview-only sidecar. Keep them out
    // of build output; `pnpm start` creates the sidecar temporarily for preview.
    rmSync(fileURLToPath(new URL("../dist/server/.dev.vars", import.meta.url)), { force: true });
  }
} else {
  process.argv = [process.execPath, fileURLToPath(cli), command,
    ...(!managedLinux ? ["--host", "::1", "--port", localAuthPort, "--strictPort"] : []), ...args];
  await import(cli.href);
}
