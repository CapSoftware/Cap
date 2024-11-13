import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { exec as execCb } from "node:child_process";
import { env } from "node:process";
import { promisify } from "node:util";

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
    await symlinkSharedLibsMacOS(nativeDeps).catch((e) => {
      console.error(`Failed to symlink shared libs.`);
      throw e;
    });

    await fs.writeFile(
      `${srcTauri}/tauri.macos.conf.json`,
      JSON.stringify(
        {
          bundle: {
            macOS: {
              frameworks: [path.join(nativeDeps, "Spacedrive.framework")],
            },
          },
        },
        null,
        4
      )
    );
  } else if (os === "windows") {
    const binFiles = await fs.readdir(path.join(nativeDeps, "bin"));

    await fs.writeFile(
      `${srcTauri}/tauri.windows.conf.json`,
      JSON.stringify(
        {
          bundle: {
            resources: binFiles.filter(
              (f) =>
                f.endsWith(".dll") && (f.startsWith("av") || f.startsWith("sw"))
            ),
          },
        },
        null,
        4
      )
    );

    console.log();
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
