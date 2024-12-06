import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { exec as execCb } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execCb);

console.log(process.env);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const targetDir = path.join(__dirname, "../../../target");

async function main() {
  const dirs = [];
  const releaseDir = path.join(targetDir, "release");
  const releaseFiles = await fs.readdir(releaseDir);
  let releaseFile = releaseFiles.find((f) => f.startsWith("Cap"));
  dirs.push(releaseDir);

  if (!releaseFile) {
    const releaseDir = path.join(
      targetDir,
      `release/${process.env.TAURI_ENV_TARGET_TRIPLE}`
    );
    dirs.push(releaseDir);
    const releaseFiles = await fs.readdir(releaseDir);
    releaseFile = releaseFiles.find((f) => f.startsWith("Cap"));
  }

  if (!releaseFile) throw new Error(`No binary found at ${dirs.join(", ")}`);

  const binaryPath = path.join(releaseDir, releaseFile);

  await exec(`dsymutil "${binaryPath}" -o "${binaryPath}.dSYM"`);
  await exec(`strip "${binaryPath}"`);
}

main();
