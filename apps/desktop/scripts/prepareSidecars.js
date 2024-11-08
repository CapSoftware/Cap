import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { exec as execCb } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execCb);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const binariesDir = path.join(__dirname, "../../../target/binaries");

const FFMPEG_BINARIES = {
  "aarch64-apple-darwin": {
    url: "https://cap-ffmpeg.s3.amazonaws.com/ffmpegarm.zip",
    path: "./ffmpeg",
  },
  "x86_64-apple-darwin": {
    url: "https://cap-ffmpeg.s3.amazonaws.com/ffmpeg-7.0.1.zip",
    path: "./ffmpeg",
  },
};

async function getRustupTarget() {
  const { stdout } = await exec("rustup show");
  const line = stdout
    .split("\n")
    .find((line) => line.includes("Default host:"));

  return line.split(":")[1].trim();
}

async function exists(path) {
  return await fs
    .access(path)
    .then(() => true)
    .catch(() => false);
}

async function main() {
  const targetTriple = process.env.TARGET_TRIPLE ?? (await getRustupTarget());
  const binaries = FFMPEG_BINARIES[targetTriple];
  if (!binaries) return;

  const ffmpegDownloadPath = path.join(binariesDir, "ffmpeg-download");
  if (!(await exists(ffmpegDownloadPath))) {
    await fs.mkdir(binariesDir, { recursive: true });
    console.log("downloading ffmpeg archive");
    const archive = await fetch(binaries.url)
      .then((r) => r.blob())
      .then((b) => b.arrayBuffer())
      .then((a) => Buffer.from(a));

    await fs.writeFile(ffmpegDownloadPath, archive);
  }

  const ffmpegUnzippedPath = path.join(binariesDir, "ffmpeg-unzipped");
  if (!(await exists(ffmpegUnzippedPath))) {
    console.log("extracting ffmpeg archive");
    await exec(`unzip ${ffmpegDownloadPath} -d ${ffmpegUnzippedPath}`);
  }

  const ffmpegSidecarName = `ffmpeg-${targetTriple}`;
  console.log(`copying ffmpeg binary '${ffmpegSidecarName}`);
  await fs.copyFile(
    path.join(ffmpegUnzippedPath, binaries.path),
    path.join(binariesDir, ffmpegSidecarName)
  );
}

main();
