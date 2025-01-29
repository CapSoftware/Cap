// @ts-check
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { exec as execCb } from "node:child_process";
import { env } from "node:process";
import { promisify } from "node:util";

const exec = promisify(execCb);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const __root = path.resolve(path.join(__dirname, ".."));
const targetDir = path.join(__root, "target");

const arch = process.arch === "arm64" ? "aarch64" : "x86_64";

async function main() {
  if (process.platform === "darwin") {
    const NATIVE_DEPS_URL =
      "https://github.com/spacedriveapp/native-deps/releases/latest/download";

    const NATIVE_DEPS_ASSETS = {
      x86_64: "native-deps-x86_64-darwin-apple.tar.xz",
      aarch64: "native-deps-aarch64-darwin-apple.tar.xz",
    };

    await fs.mkdir(targetDir, { recursive: true });

    const nativeDepsTar = path.join(targetDir, "/native-deps.tar.xz");
    if (!(await fileExists(nativeDepsTar))) {
      const nativeDepsBytes = await fetch(
        `${NATIVE_DEPS_URL}/${NATIVE_DEPS_ASSETS[arch]}`
      )
        .then((r) => r.blob())
        .then((b) => b.arrayBuffer());
      await fs.writeFile(nativeDepsTar, Buffer.from(nativeDepsBytes));
      console.log("Downloaded native deps");
    } else console.log("Using cached native-deps.tar.xz");

    const nativeDepsDir = path.join(targetDir, "/native-deps");
    const frameworkDir = path.join(nativeDepsDir, "Spacedrive.framework");
    if (!(await fileExists(nativeDepsDir))) {
      await fs.mkdir(nativeDepsDir, { recursive: true });
      await exec(
        `tar xf ${path.join(
          targetDir,
          "native-deps.tar.xz"
        )} -C ${nativeDepsDir}`
      );
      console.log("Extracted native-deps");
    } else console.log("Using cached native-deps");

    await trimMacOSFramework(frameworkDir);
    console.log("Trimmed .framework");

    console.log("Signing .framework libraries");
    await signMacOSFrameworkLibs(frameworkDir);
    console.log("Signed .framework libraries");

    const frameworkTargetDir = path.join(
      targetDir,
      "Frameworks",
      "Spacedrive.framework"
    );
    await fs.rm(frameworkTargetDir, { recursive: true }).catch(() => {});
    await fs.cp(
      frameworkDir,
      path.join(targetDir, "Frameworks", "Spacedrive.framework"),
      { recursive: true }
    );

    // alternative to specifying dylibs as linker args
    await fs.mkdir(path.join(targetDir, "/debug"), { recursive: true });
    for (const name of await fs.readdir(path.join(nativeDepsDir, "lib"))) {
      await fs.copyFile(
        path.join(nativeDepsDir, "lib", name),
        path.join(targetDir, "debug", name)
      );
    }
    console.log("Copied ffmpeg dylibs to target/debug");
  } else if (process.platform === "win32") {
    const FFMPEG_ZIP_NAME = "ffmpeg-7.1-full_build-shared";
    const FFMPEG_ZIP_URL = `https://github.com/GyanD/codexffmpeg/releases/download/7.1/${FFMPEG_ZIP_NAME}.zip`;

    await fs.mkdir(targetDir, { recursive: true });

    const ffmpegZip = path.join(targetDir, "ffmpeg.zip");
    if (!(await fileExists(ffmpegZip))) {
      const ffmpegZipBytes = await fetch(FFMPEG_ZIP_URL)
        .then((r) => r.blob())
        .then((b) => b.arrayBuffer());
      await fs.writeFile(ffmpegZip, Buffer.from(ffmpegZipBytes));
      console.log("Downloaded ffmpeg.zip");
    } else console.log("Using cached ffmpeg.zip");

    const ffmpegDir = path.join(targetDir, "ffmpeg");
    if (!(await fileExists(ffmpegDir))) {
      await exec(`tar xf ${ffmpegZip} -C ${targetDir}`);
      await fs.rename(path.join(targetDir, FFMPEG_ZIP_NAME), ffmpegDir);
      console.log("Extracted ffmpeg");
    } else console.log("Using cached ffmpeg");

    // alternative to adding ffmpeg/bin to PATH
    await fs.mkdir(path.join(targetDir, "debug"), { recursive: true });
    for (const name of await fs.readdir(path.join(ffmpegDir, "bin"))) {
      await fs.copyFile(
        path.join(ffmpegDir, "bin", name),
        path.join(targetDir, "debug", name)
      );
    }
    console.log("Copied ffmpeg dylibs to target/debug");

    if (!(await fileExists(path.join(targetDir, "native-deps"))))
      await fs.mkdir(path.join(targetDir, "native-deps"), { recursive: true });

    await fs.cp(
      path.join(ffmpegDir, "lib"),
      path.join(targetDir, "native-deps", "lib"),
      {
        recursive: true,
        force: true,
      }
    );
    await fs.cp(
      path.join(ffmpegDir, "include"),
      path.join(targetDir, "native-deps", "include"),
      {
        recursive: true,
        force: true,
      }
    );
    console.log("Copied ffmpeg/lib and ffmpeg/include to target/native-deps");
  }
}

main();

async function trimMacOSFramework(frameworkDir) {
  const headersDir = path.join(frameworkDir, "Headers");
  const librariesDir = path.join(frameworkDir, "Libraries");

  const libraries = await fs.readdir(librariesDir);

  const unnecessaryLibraries = libraries.filter(
    (v) =>
      !(
        v.startsWith("libav") ||
        v.startsWith("libsw") ||
        v.startsWith("libpostproc")
      )
  );

  for (const lib of unnecessaryLibraries) {
    await fs.rm(path.join(librariesDir, lib), { recursive: true });
  }

  const headers = await fs.readdir(headersDir);

  const unnecessaryHeaders = headers.filter(
    (v) =>
      !(
        v.startsWith("libav") ||
        v.startsWith("libsw") ||
        v.startsWith("libpostproc")
      )
  );

  for (const header of unnecessaryHeaders) {
    await fs.rm(path.join(headersDir, header), { recursive: true });
  }

  const modelsPath = path.join(frameworkDir, "Resources", "Models");
  if (await fileExists(modelsPath))
    await fs.rm(modelsPath, {
      recursive: true,
    });
}

async function signMacOSFrameworkLibs(frameworkDir) {
  const signId = env.APPLE_SIGNING_IDENTITY || "-";
  const keychain = env.APPLE_KEYCHAIN ? `--keychain ${env.APPLE_KEYCHAIN}` : "";

  // Sign dylibs (Required for them to work on macOS 13+)
  await fs
    .readdir(path.join(frameworkDir, "Libraries"), {
      recursive: true,
      withFileTypes: true,
    })
    .then((files) =>
      Promise.all(
        files
          .filter((entry) => entry.isFile() && entry.name.endsWith(".dylib"))
          .map((entry) =>
            exec(
              `codesign ${keychain} -s "${signId}" -f "${path.join(
                entry.path,
                entry.name
              )}"`
            )
          )
      )
    );
}

async function fileExists(path) {
  return await fs
    .access(path)
    .then(() => true)
    .catch(() => false);
}
