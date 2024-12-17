import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { exec as execCb } from "node:child_process";
import { env } from "node:process";
import { promisify } from "node:util";
import { createTauriPlatformConfigs } from "../apps/desktop/scripts/prepare.js";

const exec = promisify(execCb);
const signId = env.APPLE_SIGNING_IDENTITY || "-";
const keychain = env.APPLE_KEYCHAIN ? `--keychain ${env.APPLE_KEYCHAIN}` : "";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const __root = path.resolve(path.join(__dirname, ".."));
const nativeDeps = path.join(__root, "native-deps");
const srcTauri = path.join(__root, "apps/desktop/src-tauri");

async function main() {
  await fs.mkdir(path.join(__root, ".cargo"), { recursive: true });

  await fs.writeFile(
    path.join(__root, ".cargo/config.toml"),
    `[env]
FFMPEG_DIR = { force = true, value = "${nativeDeps}" }

[target.x86_64-apple-darwin]
rustflags = [
"-L",
"${nativeDeps}/lib",
"-Csplit-debuginfo=unpacked",
]

[target.aarch64-apple-darwin]
rustflags = [
"-L",
"${nativeDeps}/lib",
"-Csplit-debuginfo=unpacked",
]`
  );

  const os = process.argv[2];
  const arch = process.argv[3];

  if (!os) throw new Error("OS not provided");
  if (!arch) throw new Error("Arch not provided");

  await fs.rm(nativeDeps, { recursive: true, force: true });
  await fs.mkdir(nativeDeps, { recursive: true });
  const res = await fetch(`${NATIVE_DEPS_URL}/${NATIVE_DEPS_ASSETS[os][arch]}`);
  const body = await res.blob();

  await fs.writeFile(
    `${__root}/native-deps.tar.xz`,
    Buffer.from(await body.arrayBuffer())
  );

  await exec(`tar xf ${__root}/native-deps.tar.xz -C ${nativeDeps}`);

  if (os === "darwin") {
    const frameworkDir = path.join(nativeDeps, "Spacedrive.framework");

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

    await fs.rm(path.join(frameworkDir, "Resources", "Models"), {
      recursive: true,
    });

    await symlinkSharedLibsMacOS(nativeDeps).catch((e) => {
      console.error(`Failed to symlink shared libs.`);
      throw e;
    });

    createTauriPlatformConfigs("darwin", {
      bundle: {
        macOS: {
          frameworks: [path.join(nativeDeps, "Spacedrive.framework")],
        },
      },
    });
  } else if (os === "windows") {
    // const binFiles = await fs.readdir(path.join(nativeDeps, "bin"));
    // await fs.writeFile(
    //   `${srcTauri}/tauri.windows.conf.json`,
    //   JSON.stringify(
    //     {
    //       bundle: {
    //         resources: binFiles.filter(
    //           (f) =>
    //             f.endsWith(".dll") && (f.startsWith("av") || f.startsWith("sw"))
    //         ),
    //       },
    //     },
    //     null,
    //     4
    //   )
    // );
  }
}

main();

const NATIVE_DEPS_URL =
  "https://github.com/spacedriveapp/native-deps/releases/latest/download";

const NATIVE_DEPS_ASSETS = {
  darwin: {
    x86_64: "native-deps-x86_64-darwin-apple.tar.xz",
    aarch64: "native-deps-aarch64-darwin-apple.tar.xz",
  },
  windows: {
    x86_64: "native-deps-x86_64-windows-gnu.tar.xz",
    aarch64: "native-deps-aarch64-windows-gnu.tar.xz",
  },
};

async function symlinkSharedLibsMacOS(nativeDeps) {
  // Framework
  const framework = path.join(nativeDeps, "Spacedrive.framework");

  // Sign dylibs (Required for them to work on macOS 13+)
  await fs
    .readdir(path.join(framework, "Libraries"), {
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
