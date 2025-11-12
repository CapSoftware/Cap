#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { PROJECT_ROOT, resolveTinybirdAuth } from "./shared.js";

const DEFAULT_PYTHON = process.env.PYTHON || "python3";
const TB_BINARY = process.env.TB_BIN || "tb";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tinybirdProjectDir = path.join(__dirname, "tinybird");
const projectTinybPath = path.join(tinybirdProjectDir, ".tinyb");
const rootTinybPath = path.join(PROJECT_ROOT, ".tinyb");

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    ...options,
  });
  if (result.error || result.status !== 0) {
    const message = result.error?.message || `Command ${command} ${args.join(" ")} failed.`;
    throw new Error(message);
  }
};

const ensureTinybirdCli = () => {
  try {
    run(TB_BINARY, ["--version"], { stdio: "ignore" });
  } catch {
    console.log("Tinybird CLI not found. Installing via pip...");
    run(DEFAULT_PYTHON, ["-m", "pip", "install", "--user", "tinybird-cli"], { stdio: "inherit" });
    console.log("Tinybird CLI installed. Re-running version check...");
    run(TB_BINARY, ["--version"], { stdio: "inherit" });
  }
};

const ensureTinybirdLogin = () => {
  if (fs.existsSync(rootTinybPath)) {
    return;
  }
  console.log("Tinybird credentials not found. Launching `tb login`...");
  run(TB_BINARY, ["login"], { cwd: PROJECT_ROOT, stdio: "inherit" });
  if (!fs.existsSync(rootTinybPath)) {
    throw new Error("Tinybird login did not create a .tinyb file. Please rerun `tb login` and try again.");
  }
};

const syncProjectTinyb = () => {
  if (!fs.existsSync(rootTinybPath)) return;
  fs.copyFileSync(rootTinybPath, projectTinybPath);
};

const deployTinybirdProject = (auth) => {
  console.log(
    "⚠️  Running `tb --cloud deploy --allow-destructive-operations --wait` inside scripts/analytics/tinybird. This will synchronize the Tinybird workspace to the resources defined in that folder and remove any other datasources/pipes in the workspace."
  );
  run(
    TB_BINARY,
    ["--cloud", "deploy", "--allow-destructive-operations", "--wait"],
    {
      cwd: tinybirdProjectDir,
      env: {
        ...process.env,
        TB_HOST: auth.host,
        TB_TOKEN: auth.token,
        TB_LOCAL: "0",
        ...(auth.userToken ? { TB_USER_TOKEN: auth.userToken } : {}),
      },
    },
  );
};

function main() {
  try {
    ensureTinybirdCli();
    ensureTinybirdLogin();
    const auth = resolveTinybirdAuth();
    syncProjectTinyb();
    deployTinybirdProject(auth);
    console.log("✅ Tinybird analytics resources are ready.");
  } catch (error) {
    console.error("❌ Failed to set up Tinybird analytics:", error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

main();
