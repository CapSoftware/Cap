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
const rsTargetTriple =
  process.env.TARGET_TRIPLE || /host: (\S+)/.exec(rustInfo.toString())?.[1];

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
  if (!match)
    throw new Error(
      'Failed to extract version from "Cargo.toml". Have you removed the main crate version by accident?'
    );

  const ver = match[1];
  const [core, buildOrPrerelease] = ver.includes("+")
    ? ver.split("+")
    : ver.split("-");
  const [major, minor, patch] = core.split(".");
  let build = 0;
  if (buildOrPrerelease) {
    const numMatch = buildOrPrerelease.match(/\d+$/);
    build = numMatch ? parseInt(numMatch[0]) : 0;
  }
  const wixVersion = `${major}.${minor}.${patch}${
    build === 0 ? "" : `.${build}`
  }`;
  if (wixVersion !== ver)
    console.log(`Using wix-compatible version ${ver} --> ${wixVersion}`);
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
    if (
      source[key] instanceof Object &&
      key in target &&
      target[key] instanceof Object
    ) {
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
export async function createTauriPlatformConfigs(
  platform,
  configOptions = undefined
) {
  const srcTauri = path.join(__dirname, "../src-tauri/");
  let baseConfig = {};
  let configFileName = "";

  console.log(`Updating Platform (${platform}) Tauri config...`);
  if (platform === "win32") {
    configFileName = "tauri.windows.conf.json";
    baseConfig = {
      ...baseConfig,
      bundle: {
        windows: {
          wix: {
            version: await semverToWIXCompatibleVersion(
              path.join(srcTauri, "Cargo.toml")
            ),
          },
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
  const mergedConfig = configOptions
    ? deepMerge(baseConfig, configOptions)
    : baseConfig;
  await fs.writeFile(
    `${srcTauri}/${configFileName}`,
    JSON.stringify(mergedConfig, null, 2)
  );
}

async function main() {
  console.log("--- Preparing sidecars and configs...");
  const targetTripleEnv = process.env.TARGET_TRIPLE || rsTargetTriple;
  console.log(`Target is ${targetTripleEnv}`);

  await createTauriPlatformConfigs(process.platform);
  console.log("--- Preparation finished");
}

main().catch((err) => {
  console.error("\n--- Preparation Failed");
  console.error(err);
  console.error("---");
});
