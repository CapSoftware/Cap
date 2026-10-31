import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);
export const macosBundlesDirectory = path.join(
	repoRoot,
	"apps",
	"macos-bundles",
);
const gpuiManifest = path.join(repoRoot, "apps", "desktop-gpui", "Cargo.toml");
const minimumSystemVersion = "12.3";

export const extensions = [
	{
		product: "CapQuickLookThumbnail",
		bundleId: "so.cap.desktop.quicklook.thumbnail",
	},
	{
		product: "CapQuickLookPreview",
		bundleId: "so.cap.desktop.quicklook.preview",
	},
];

const swiftArchitectures = {
	"aarch64-apple-darwin": "arm64",
	"x86_64-apple-darwin": "x86_64",
};

export function swiftArchitecture(target) {
	const architecture = swiftArchitectures[target];
	if (!architecture) {
		throw new Error(`Unsupported macOS bundle target: ${target}`);
	}
	return architecture;
}

export function signingArguments({ identity, keychain, entitlements, bundle }) {
	return [
		"--force",
		"--timestamp",
		"--options",
		"runtime",
		"--entitlements",
		entitlements,
		"--sign",
		identity,
		...(keychain ? ["--keychain", keychain] : []),
		bundle,
	];
}

export function plistVersion(source) {
	const packageStart = source.indexOf("[package]");
	if (packageStart === -1) throw new Error("[package] not found");
	const packageEnd = source.indexOf("\n[", packageStart + 1);
	const section = source.slice(
		packageStart,
		packageEnd === -1 ? source.length : packageEnd,
	);
	const match = /^version\s*=\s*"([^"]+)"$/m.exec(section);
	if (!match) throw new Error("package.version not found");
	return match[1];
}

function run(command, args, options = {}) {
	const result = spawnSync(command, args, { stdio: "inherit", ...options });
	if (result.error) throw result.error;
	if (result.status !== 0) {
		throw new Error(
			`${command} ${args.join(" ")} failed with ${result.signal ?? result.status}`,
		);
	}
}

async function assemble(extension, executable, info, version, output) {
	const contents = path.join(output, `${extension.product}.appex`, "Contents");
	await fs.rm(path.dirname(contents), { recursive: true, force: true });
	await fs.mkdir(path.join(contents, "MacOS"), { recursive: true });
	await fs.copyFile(
		executable,
		path.join(contents, "MacOS", extension.product),
	);
	await fs.chmod(path.join(contents, "MacOS", extension.product), 0o755);
	const plist = (await fs.readFile(info, "utf8"))
		.replace(
			/(<key>CFBundleShortVersionString<\/key>\s*<string>)[^<]*(<\/string>)/,
			`$1${version}$2`,
		)
		.replace(
			/(<key>CFBundleVersion<\/key>\s*<string>)[^<]*(<\/string>)/,
			`$1${version}$2`,
		);
	await fs.writeFile(path.join(contents, "Info.plist"), plist);
	return path.dirname(contents);
}

export async function buildMacosBundles(
	target,
	{
		env = process.env,
		platform = process.platform,
		outputDirectory = path.join(macosBundlesDirectory, ".build", "appex"),
	} = {},
) {
	if (platform !== "darwin") {
		throw new Error("The macOS bundles can only be built on macOS");
	}
	const architecture = swiftArchitecture(target);
	const version = plistVersion(await fs.readFile(gpuiManifest, "utf8"));
	const identity = env.APPLE_SIGNING_IDENTITY;
	const keychain = env.APPLE_KEYCHAIN;
	const ci = env.CI === "true" || env.CI === "1";
	if (ci && !identity) {
		throw new Error(
			"APPLE_SIGNING_IDENTITY is required to sign the macOS bundles in CI",
		);
	}

	const swiftArguments = [
		"-c",
		"release",
		"--package-path",
		macosBundlesDirectory,
		"--triple",
		`${architecture}-apple-macosx${minimumSystemVersion}`,
	];
	run("swift", ["build", ...swiftArguments]);
	const shown = spawnSync(
		"swift",
		["build", ...swiftArguments, "--show-bin-path"],
		{
			encoding: "utf8",
		},
	);
	if (shown.status !== 0) throw new Error("swift build --show-bin-path failed");
	const binDirectory = shown.stdout.trim();

	await fs.mkdir(outputDirectory, { recursive: true });
	const bundles = [];
	for (const extension of extensions) {
		const executable = path.join(binDirectory, extension.product);
		const info = path.join(
			macosBundlesDirectory,
			"Bundles",
			extension.product,
			"Info.plist",
		);
		const bundle = await assemble(
			extension,
			executable,
			info,
			version,
			outputDirectory,
		);
		if (identity) {
			run("codesign", [
				...signingArguments({
					identity,
					keychain,
					entitlements: path.join(
						macosBundlesDirectory,
						"Bundles",
						"Sandbox.entitlements",
					),
					bundle,
				}),
			]);
			run("codesign", ["--verify", "--strict", bundle]);
		} else {
			console.warn(
				`APPLE_SIGNING_IDENTITY is not set; ${path.basename(bundle)} is unsigned`,
			);
		}
		bundles.push(bundle);
	}
	return bundles;
}

if (
	process.argv[1] &&
	path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	const [target] = process.argv.slice(2);
	buildMacosBundles(target).catch((error) => {
		console.error(error?.message ?? error);
		process.exitCode = 1;
	});
}
