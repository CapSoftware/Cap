// @ts-check

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { exec as execCb, execSync } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execCb);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const binariesDir = path.join(__dirname, "../../../target/binaries");
const ffmpegUnzippedPath = path.join(binariesDir, "ffmpeg-unzipped");

const isWindows = process.platform === "win32";
const fileExtension = isWindows ? ".exe" : "";
const rustInfo = execSync("rustc -vV");
const rsTargetTriple = /host: (\S+)/.exec(rustInfo.toString())?.[1];

const FFMPEG_BINARIES = {
  "aarch64-apple-darwin": {
    url: "https://cap-ffmpeg.s3.amazonaws.com/ffmpegarm.zip",
    path: "./ffmpeg",
  },
  "x86_64-apple-darwin": {
    url: "https://cap-ffmpeg.s3.amazonaws.com/ffmpeg-7.0.1.zip",
    path: "./ffmpeg",
  },
  "x86_64-pc-windows-msvc": {
    // TODO: Select a stable version, use Cap's own ffmpeg build to also support aarch64.
    url: "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl-shared.zip",
    path: "bin/ffmpeg.exe",
  },
};

/**
 * @param {string} filePath 
 * @returns {Promise<boolean>}
 */
async function exists(filePath) {
  return fs
    .access(filePath)
    .then(() => true)
    .catch(() => false);
}

/**
 * @param {string} targetPath 
 * @param {string} outputPath 
 */
async function unzip(targetPath, outputPath) {
  console.log(`unzipping \"${targetPath}\" --> \"${outputPath}\"`);
  if (isWindows) {
    await exec(`tar -xf ${targetPath} -C ${outputPath}`);
  } else {
    await exec(`unzip -o ${targetPath} -d ${outputPath}`);
  }
}

async function prepareFfmpegSidecar() {
  const binaries = FFMPEG_BINARIES[rsTargetTriple];
  const ffmpegDownloadPath = path.join(binariesDir, "ffmpeg-download.zip");

  // Skip downloading if the archive already exists
  if (!(await exists(ffmpegDownloadPath))) {
    if (await exists(ffmpegUnzippedPath)) return;
    console.log(`Couldn't locate "ffmpeg-download.zip" in "${ffmpegDownloadPath}"`);
    console.log(`Downloading from: ${binaries.url}`);
    await fs.mkdir(binariesDir, { recursive: true });

    const response = await fetch(binaries.url);
    if (!response.ok || !response.body) throw new Error(`Failed to download: ${response.statusText}`);

    const contentLength = response.headers.get("content-length");
    if (!contentLength) throw new Error("Unable to determine file size for progress reporting.");

    const totalBytes = parseInt(contentLength, 10);
    let downloadedBytes = 0;

    const archiveBuffer = [];
    const reader = response.body.getReader();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      downloadedBytes += value.length;
      archiveBuffer.push(value);

      const progress = ((downloadedBytes / totalBytes) * 100).toFixed(2);
      process.stdout.write(`\rDownloading: ${progress}%`);
    }

    console.log("\nDownload complete.");
    const archive = Buffer.concat(archiveBuffer);
    await fs.writeFile(ffmpegDownloadPath, archive);
  }

  // Skip unzipping if the directory already exists
  if (!(await exists(ffmpegUnzippedPath))) {
    console.log("Extracting ffmpeg archive...");
    await fs.mkdir(ffmpegUnzippedPath, { recursive: true });
    await unzip(ffmpegDownloadPath, ffmpegUnzippedPath);
  }

  // Check if there's a single nested folder and move its contents to the root
  const unzippedContents = await fs.readdir(ffmpegUnzippedPath);
  if (unzippedContents.length === 1) {
    const nestedPath = path.join(ffmpegUnzippedPath, unzippedContents[0]);
    const stat = await fs.stat(nestedPath);

    if (stat.isDirectory()) {
      console.log(`Detected nested folder '${unzippedContents[0]}'. Moving contents to root.`);
      const nestedContents = await fs.readdir(nestedPath);

      for (const entry of nestedContents) {
        const srcPath = path.join(nestedPath, entry);
        const destPath = path.join(ffmpegUnzippedPath, entry);
        await fs.rename(srcPath, destPath);
      }

      // Remove the now-empty nested folder
      await fs.rmdir(nestedPath);
    }
  }

  const ffmpegBinaryPath = path.join(ffmpegUnzippedPath, binaries.path);
  const ffmpegSidecarName = `ffmpeg-${rsTargetTriple}${fileExtension}`;
  const finalDestinationPath = path.join(binariesDir, ffmpegSidecarName);
  if (await exists(finalDestinationPath)) {
    console.log(`Using ffmpeg sidecar: ${ffmpegSidecarName}`);
    return;
  };

  console.log(`Copying ffmpeg binary to '${ffmpegSidecarName}'...`);

  await fs.copyFile(
    ffmpegBinaryPath,
    path.join(binariesDir, ffmpegSidecarName)
  );
}

/**
 * Creates a Microsoft Windows Installer (TM) compatible version from the provided crate's semver version.
 * `major.minor.patch.build`
 * 
 * @see {@link https://tauri.app/reference/config/#version-1}
 * @param {string} cargoFilePath 
 * @returns {Promise<string>}
 */
async function semverToWIXCompatibleVersion(cargoFilePath) {
  const config = await fs.readFile(cargoFilePath, "utf-8");
  const match = /version\s*=\s*"([\w.-]+)"/.exec(config);
  if (!match) throw new Error(
    "Failed to extract version from \"Cargo.toml\". Have you removed the main crate version by accident?"
  );

  const ver = match[1];
  const [core, buildOrPrerelease] = ver.includes('+') ? ver.split('+') : ver.split('-');
  const [major, minor, patch] = core.split(".");
  let build = 0;
  if (buildOrPrerelease) {
    const numMatch = buildOrPrerelease.match(/\d+$/);
    build = numMatch ? parseInt(numMatch[0]) : 0;
  }
  const wixVersion = `${major}.${minor}.${patch}${build === 0 ? "" : `.${build}`}`;
  if (wixVersion !== ver) console.log(`Using wix-compatible version ${ver} --> ${wixVersion}`);
  return wixVersion;
}
/**
 * Deeply merges two objects
 * 
 * @param {Object} target
 * @param {Object} source
 * @returns {Object}
 */
function deepMerge(target, source) {
  for (const key of Object.keys(source)) {
    if (source[key] instanceof Object && key in target && target[key] instanceof Object) {
      Object.assign(source[key], deepMerge(target[key], source[key]));
    }
  }
  return { ...target, ...source };
}

/**
 * Writes platform-specific tauri configs
 * 
 * @param {NodeJS.Platform} platform 
 * @param {{} | undefined} configOptions
 */
export async function createTauriPlatformConfigs(platform, configOptions = undefined) {
  const srcTauri = path.join(__dirname, "../src-tauri/");
  let baseConfig = {};
  let configFileName = "";

  console.log(`Updating Platform (${platform}) Tauri config...`);
  if (platform === "win32") {
    configFileName = "tauri.windows.conf.json";
    baseConfig = {
      ...baseConfig,
      bundle: {
        resources: {
          "../../../target/binaries/ffmpeg-unzipped/bin/*.dll": ""
        },
        windows: {
          wix: {
            version: await semverToWIXCompatibleVersion(path.join(srcTauri, "Cargo.toml"))
          }
        },
      },
    };
  } else if (platform === "darwin") {
    configFileName = "tauri.macos.conf.json";
    baseConfig = {
      ...baseConfig,
      bundle: {
        icon: ["icons/macos/icon.icns"],
      },
    };
  } else {
    throw new Error("Unsupported platform!");
  }
  const mergedConfig = configOptions ? deepMerge(baseConfig, configOptions) : baseConfig;
  await fs.writeFile(`${srcTauri}/${configFileName}`, JSON.stringify(mergedConfig, null, 2));
}

async function main() {
  console.log("--- Preparing sidecars and configs...");
  const targetTripleEnv = process.env.TARGET_TRIPLE || rsTargetTriple;
  const binaries = FFMPEG_BINARIES[targetTripleEnv];
  if (!binaries) {
    console.error(`Unsupported target: ${targetTripleEnv}`);
    return;
  }
  console.log(`Target is ${targetTripleEnv}`);

  await prepareFfmpegSidecar();
  await createTauriPlatformConfigs(process.platform);
  console.log("--- Preparation finished");
}

main().catch((err) => {
  console.error("--- Preparation Failed");
  console.error(err);
  console.error("---");
  process.exit(1);
});