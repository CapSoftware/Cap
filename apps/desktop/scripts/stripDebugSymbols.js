import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { exec as execCb } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execCb);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const targetDir = path.join(__dirname, "../../../target");
const releaseDir = path.join(targetDir, "release");

async function main() {
  const releaseFiles = await fs.readdir(releaseDir);
  const binaryPath = path.join(
    releaseDir,
    releaseFiles.find((f) => f.startsWith("Cap"))
  );

  await exec(`dsymutil "${binaryPath}" -o "${binaryPath}.dSYM"`);
  await exec(`strip "${binaryPath}"`);
}

main();
