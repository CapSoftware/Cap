// @ts-check

import { exec as execCb, execFile as execFileCb } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { env } from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execCb);
const execFile = promisify(execFileCb);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const __root = path.resolve(path.join(__dirname, ".."));
const targetDir = path.join(__root, "target");

const arch =
	process.env.RUST_TARGET_TRIPLE?.split("-")[0] ??
	(process.arch === "arm64" ? "aarch64" : "x86_64");

const BASE_CARGO_TOML = `[env]
FFMPEG_DIR = { relative = true, force = true, value = "target/native-deps" }
`;

async function main() {
	await fs.mkdir(targetDir, { recursive: true });

	let cargoConfigContents = BASE_CARGO_TOML;
	let cargoBuildContents = "";
	const sccachePath = await findExecutable("sccache");

	if (sccachePath) {
		cargoBuildContents += `\n[build]\nrustc-wrapper = "${sccachePath.replaceAll("\\", "/")}"\n`;
		console.log(`Using sccache at ${sccachePath}`);
	} else console.log("sccache not found, using rustc directly");

	if (process.platform === "darwin") {
		const NATIVE_DEPS_VERSION = "v0.25";
		const NATIVE_DEPS_URL = `https://github.com/spacedriveapp/native-deps/releases/download/${NATIVE_DEPS_VERSION}`;

		const NATIVE_DEPS_ASSETS = {
			x86_64: "native-deps-x86_64-darwin-apple.tar.xz",
			aarch64: "native-deps-aarch64-darwin-apple.tar.xz",
		};

		const nativeDepsTar = NATIVE_DEPS_ASSETS[arch];
		const nativeDepsTarPath = path.join(targetDir, nativeDepsTar);
		let downloadedNativeDeps = false;

		if (!(await fileExists(nativeDepsTarPath))) {
			console.log(`Downloading ${nativeDepsTar}`);
			const nativeDepsBytes = await fetch(`${NATIVE_DEPS_URL}/${nativeDepsTar}`)
				.then((r) => r.blob())
				.then((b) => b.arrayBuffer());
			await fs.writeFile(nativeDepsTarPath, Buffer.from(nativeDepsBytes));
			console.log("Downloaded native deps");
			downloadedNativeDeps = true;
		} else console.log(`Using cached ${nativeDepsTar}`);

		const nativeDepsFolder = `native-deps`;
		const nativeDepsDir = path.join(targetDir, nativeDepsFolder);
		const frameworkDir = path.join(nativeDepsDir, "Spacedrive.framework");
		if (downloadedNativeDeps || !(await fileExists(nativeDepsDir))) {
			await fs.mkdir(nativeDepsDir, { recursive: true });
			await execFile("tar", ["xf", nativeDepsTarPath, "-C", nativeDepsDir]);
			console.log(`Extracted ${nativeDepsFolder}`);
		} else console.log(`Using cached ${nativeDepsFolder}`);

		const frameworkTargetDir = path.join(
			targetDir,
			"Frameworks",
			"Spacedrive.framework",
		);
		const debugDir = path.join(targetDir, "debug");
		const nativeLibDir = path.join(nativeDepsDir, "lib");
		const needsFrameworkSync =
			downloadedNativeDeps ||
			!(await fileExists(frameworkTargetDir)) ||
			(await missingFiles(debugDir, await fs.readdir(nativeLibDir)).then(
				(files) => files.length > 0,
			));

		if (needsFrameworkSync) {
			await trimMacOSFramework(frameworkDir);
			console.log("Trimmed .framework");

			console.log("Signing .framework libraries");
			await signMacOSFrameworkLibs(frameworkDir);
			console.log("Signed .framework libraries");

			await fs.rm(frameworkTargetDir, { recursive: true }).catch(() => {});
			await fs.cp(
				frameworkDir,
				path.join(targetDir, "Frameworks", "Spacedrive.framework"),
				{ recursive: true },
			);

			await fs.mkdir(debugDir, { recursive: true });
			const nativeLibs = await fs.readdir(nativeLibDir);
			for (const name of nativeLibs) {
				await fs.copyFile(
					path.join(nativeLibDir, name),
					path.join(debugDir, name),
				);
			}
			console.log("Copied ffmpeg dylibs to target/debug");
		} else console.log("Using cached macOS native deps setup");

		const onnxRuntimePath = await setupMacOSOnnxRuntime();
		cargoConfigContents += `ORT_DYLIB_PATH = { relative = true, force = true, value = "${path.relative(
			__root,
			onnxRuntimePath,
		)}" }\n`;
	} else if (process.platform === "win32") {
		const FFMPEG_VERSION = "7.1";
		const FFMPEG_ZIP_NAME = `ffmpeg-${FFMPEG_VERSION}-full_build-shared`;
		const FFMPEG_ZIP_URL = `https://github.com/GyanD/codexffmpeg/releases/download/${FFMPEG_VERSION}/${FFMPEG_ZIP_NAME}.zip`;

		await fs.mkdir(targetDir, { recursive: true });

		let downloadedFfmpeg = false;
		const ffmpegZip = `ffmpeg-${FFMPEG_VERSION}.zip`;
		const ffmpegZipPath = path.join(targetDir, ffmpegZip);
		if (!(await fileExists(ffmpegZipPath))) {
			const ffmpegZipBytes = await fetch(FFMPEG_ZIP_URL)
				.then((r) => r.blob())
				.then((b) => b.arrayBuffer());
			await fs.writeFile(ffmpegZipPath, Buffer.from(ffmpegZipBytes));
			console.log(`Downloaded ${ffmpegZip}`);
			downloadedFfmpeg = true;
		} else console.log(`Using cached ${ffmpegZip}`);

		const ffmpegDir = path.join(targetDir, "ffmpeg");
		if (!(await fileExists(ffmpegDir)) || downloadedFfmpeg) {
			await exec(
				`Expand-Archive -Path "${ffmpegZipPath}" -DestinationPath "${targetDir}" -Force`,
				{ shell: "powershell.exe" },
			);
			await fs.rm(ffmpegDir, { recursive: true, force: true }).catch(() => {});
			await fs.rename(path.join(targetDir, FFMPEG_ZIP_NAME), ffmpegDir);
			console.log("Extracted ffmpeg");
		} else console.log("Using cached ffmpeg");

		for (const profile of ["debug", "release"]) {
			await fs.mkdir(path.join(targetDir, profile), { recursive: true });
			for (const name of await fs.readdir(path.join(ffmpegDir, "bin"))) {
				await fs.copyFile(
					path.join(ffmpegDir, "bin", name),
					path.join(targetDir, profile, name),
				);
			}
		}
		console.log("Copied ffmpeg DLLs to target/debug and target/release");

		if (!(await fileExists(path.join(targetDir, "native-deps"))))
			await fs.mkdir(path.join(targetDir, "native-deps"), { recursive: true });

		await fs.cp(
			path.join(ffmpegDir, "lib"),
			path.join(targetDir, "native-deps", "lib"),
			{
				recursive: true,
				force: true,
			},
		);
		await fs.cp(
			path.join(ffmpegDir, "include"),
			path.join(targetDir, "native-deps", "include"),
			{
				recursive: true,
				force: true,
			},
		);
		console.log("Copied ffmpeg/lib and ffmpeg/include to target/native-deps");

		const { stdout: vcInstallDir } = await exec(
			// biome-ignore lint/suspicious/noTemplateCurlyInString: PowerShell syntax, not JS template literal
			'$(& "${env:ProgramFiles(x86)}/Microsoft Visual Studio/Installer/vswhere.exe" -latest -property installationPath)',
			{ shell: "powershell.exe" },
		);

		const libclangPath = path.join(
			vcInstallDir.trim(),
			"VC/Tools/LLVM/x64/bin/libclang.dll",
		);

		cargoConfigContents += `LIBCLANG_PATH = "${libclangPath.replaceAll(
			"\\",
			"/",
		)}"\n`;
	}

	await fs.mkdir(path.join(__root, ".cargo"), { recursive: true });
	await fs.writeFile(
		path.join(__root, ".cargo/config.toml"),
		cargoConfigContents + cargoBuildContents,
	);
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
			),
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
			),
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
								entry.parentPath,
								entry.name,
							)}"`,
						),
					),
			),
		);
}

async function setupMacOSOnnxRuntime() {
	const asset =
		arch === "aarch64"
			? {
					version: "1.24.2",
					name: "onnxruntime-osx-arm64-1.24.2.tgz",
				}
			: {
					version: "1.23.2",
					name: "onnxruntime-osx-x86_64-1.23.2.tgz",
				};
	const url = `https://github.com/microsoft/onnxruntime/releases/download/v${asset.version}/${asset.name}`;
	const archivePath = path.join(targetDir, asset.name);
	const extractDir = path.join(targetDir, asset.name.replace(/\.tgz$/, ""));
	const outputDir = path.join(targetDir, "native-deps", "onnxruntime", "lib");
	const outputPath = path.join(outputDir, "libonnxruntime.dylib");
	const markerPath = path.join(outputDir, "asset.txt");
	const marker = await fs
		.readFile(markerPath, "utf-8")
		.then((value) => value.trim())
		.catch(() => null);

	if (!(await fileExists(archivePath))) {
		console.log(`Downloading ${asset.name}`);
		const bytes = await fetch(url)
			.then((r) => r.blob())
			.then((b) => b.arrayBuffer());
		await fs.writeFile(archivePath, Buffer.from(bytes));
		console.log(`Downloaded ${asset.name}`);
	} else console.log(`Using cached ${asset.name}`);

	if (!(await fileExists(outputPath)) || marker !== asset.name) {
		await fs.rm(extractDir, { recursive: true, force: true }).catch(() => {});
		await execFile("tar", ["xf", archivePath, "-C", targetDir]);
		await fs.mkdir(outputDir, { recursive: true });
		await fs.copyFile(
			path.join(extractDir, "lib", "libonnxruntime.dylib"),
			outputPath,
		);
		await signMacOSDylib(outputPath);
		await fs.writeFile(markerPath, asset.name);
		console.log("Prepared ONNX Runtime dylib");
	} else console.log("Using cached ONNX Runtime dylib");

	return outputPath;
}

async function signMacOSDylib(filePath) {
	const signId = env.APPLE_SIGNING_IDENTITY || "-";
	const keychain = env.APPLE_KEYCHAIN ? `--keychain ${env.APPLE_KEYCHAIN}` : "";

	await exec(`codesign ${keychain} -s "${signId}" -f "${filePath}"`);
}

async function fileExists(path) {
	return await fs
		.access(path)
		.then(() => true)
		.catch(() => false);
}

async function missingFiles(dir, names) {
	if (!(await fileExists(dir))) return names;

	const present = new Set(await fs.readdir(dir));
	return names.filter((name) => !present.has(name));
}

async function findExecutable(name) {
	const command = process.platform === "win32" ? "where.exe" : "which";

	return await execFile(command, [name])
		.then(({ stdout }) => stdout.trim().split(/\r?\n/).find(Boolean) ?? null)
		.catch(() => null);
}
