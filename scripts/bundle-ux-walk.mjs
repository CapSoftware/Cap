import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { brand, brandBuiltApp, brandEngineText } from "./fork-brand.mjs";
import { verifyUxWalkSource } from "./sync-ux-walk.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "vendor", "ux-walk");
export const bundledNodeMajor = 22;
const nodeAdvice = `Run this script with a self-contained Node ${bundledNodeMajor}, such as the nodejs.org build. Package manager builds often link libraries the app does not carry.`;

function run(command, args) {
	return execFileSync(command, args, {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
}

export function linkedLibraries(otoolOutput) {
	return [
		...new Set(
			otoolOutput
				.split("\n")
				.filter((line) => /^\s+\S/.test(line))
				.map((line) => line.trim().replace(/ \(compatibility version .*$/, "")),
		),
	];
}

export function isSystemLibrary(library) {
	return (
		!library.split("/").includes("..") &&
		(library.startsWith("/usr/lib/") || library.startsWith("/System/"))
	);
}

export function verifyBundledNode(node) {
	const libraries = linkedLibraries(run("otool", ["-L", "-arch", "all", node]));
	if (libraries.length === 0) {
		throw new Error(`Could not read the libraries of ${node}. ${nodeAdvice}`);
	}
	const foreign = libraries.filter((library) => !isSystemLibrary(library));
	if (foreign.length > 0) {
		throw new Error(
			`The bundled Node links libraries outside the system (${foreign.length}), including ${foreign.slice(0, 3).join(", ")}. ${nodeAdvice}`,
		);
	}
	let version;
	try {
		// An empty environment keeps DYLD_* settings from hiding a load failure.
		version = execFileSync(node, ["--version"], {
			encoding: "utf8",
			env: {},
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 60000,
		}).trim();
	} catch (error) {
		throw new Error(
			`The bundled Node could not run: ${error.message}\n${nodeAdvice}`,
		);
	}
	if (!version.startsWith(`v${bundledNodeMajor}.`)) {
		throw new Error(
			`The bundled Node reported "${version}", expected version ${bundledNodeMajor}. ${nodeAdvice}`,
		);
	}
	return version;
}

export const entitlements = path.join(
	root,
	"apps/desktop-gpui/packaging/macos/Entitlements.plist",
);
const bundleExtensions = new Set([
	".app",
	".appex",
	".bundle",
	".framework",
	".plugin",
	".xpc",
]);
const machOMagics = new Set([
	"feedface",
	"cefaedfe",
	"feedfacf",
	"cffaedfe",
	"cafebabe",
	"bebafeca",
	"cafebabf",
	"bfbafeca",
]);

async function isMachO(file) {
	const handle = await fs.open(file, "r");
	try {
		const { buffer, bytesRead } = await handle.read(Buffer.alloc(4), 0, 4, 0);
		return bytesRead === 4 && machOMagics.has(buffer.toString("hex"));
	} finally {
		await handle.close();
	}
}

async function collectNestedCode(directory, skip, order) {
	const entries = await fs.readdir(directory, { withFileTypes: true });
	entries.sort((a, b) => a.name.localeCompare(b.name));
	for (const entry of entries) {
		const item = path.join(directory, entry.name);
		if (entry.isDirectory()) {
			await collectNestedCode(item, skip, order);
			if (bundleExtensions.has(path.extname(entry.name))) order.push(item);
		} else if (entry.isFile() && item !== skip && (await isMachO(item))) {
			order.push(item);
		}
	}
	return order;
}

export async function nestedCode(app, executable) {
	const contents = path.join(path.resolve(app), "Contents");
	return collectNestedCode(
		contents,
		path.join(contents, "MacOS", executable),
		[],
	);
}

// Tauri leaves Contents/Frameworks unsigned when no signing identity is set,
// and codesign refuses to seal an app over unsigned nested code. Signing every
// nested binary and bundle before its parent avoids --deep, which would also
// overwrite the entitlements Node ships with.
export async function signApp(app, identity) {
	const appPath = path.resolve(app);
	const { CFBundleExecutable: executable } = JSON.parse(
		run("plutil", [
			"-convert",
			"json",
			"-o",
			"-",
			path.join(appPath, "Contents", "Info.plist"),
		]),
	);
	for (const target of await nestedCode(appPath, executable)) {
		run("codesign", [
			"--force",
			"--sign",
			identity,
			"--preserve-metadata=entitlements",
			target,
		]);
	}
	run("codesign", [
		"--force",
		"--sign",
		identity,
		"--entitlements",
		entitlements,
		appPath,
	]);
	run("codesign", ["--verify", "--deep", "--strict", appPath]);
}

export async function bundleUxWalk(app) {
	if (process.platform !== "darwin") throw new Error("Bundle UX Walk on macOS");
	const contents = path.join(path.resolve(app), "Contents");
	const parent = JSON.parse(
		run("plutil", [
			"-convert",
			"json",
			"-o",
			"-",
			path.join(contents, "Info.plist"),
		]),
	);
	if (!String(parent.CFBundleIdentifier).startsWith(brand.bundle_id)) {
		throw new Error(
			`UX Walk can only be bundled into a ${brand.display_name} app`,
		);
	}
	const { revision } = await verifyUxWalkSource(source);
	await fs.access(
		path.join(source, "node_modules/playwright-core/package.json"),
	);
	const resources = path.join(contents, "Resources");
	const engine = path.join(resources, "ux-walk");
	await fs.mkdir(engine, { recursive: true });
	for (const item of [
		"src",
		"bin",
		"prompts",
		"assets",
		"skills",
		"glossary.example.txt",
		"package.json",
		"package-lock.json",
		"LICENSE",
		"SOURCE.json",
	]) {
		await fs.cp(path.join(source, item), path.join(engine, item), {
			recursive: true,
		});
	}
	await brandEngineText(path.join(engine, "src"));
	await fs.cp(
		path.join(source, "node_modules", "playwright-core"),
		path.join(engine, "node_modules", "playwright-core"),
		{ recursive: true },
	);
	const node = path.join(engine, "bin", "node");
	await fs.copyFile(process.execPath, node);
	await fs.chmod(node, 0o755);
	let nodeVersion;
	try {
		nodeVersion = verifyBundledNode(node);
	} catch (error) {
		await fs.rm(engine, { recursive: true, force: true });
		throw error;
	}
	const nodeLicense = path.resolve(
		path.dirname(process.execPath),
		"..",
		"LICENSE",
	);
	await fs.copyFile(nodeLicense, path.join(resources, "NODE-LICENSE"));
	await fs.copyFile(
		path.join(root, "LICENSE"),
		path.join(resources, "CAP-LICENSE"),
	);
	for (const file of [
		"native-walk.mjs",
		"native-audio.mjs",
		"checkpoint-store.mjs",
		"walk-lock.mjs",
		"chapter-attribution.mjs",
		"checkpoint-jobs.mjs",
		"checkpoint-worker.mjs",
		"checkpoint-transcript.mjs",
		"fragmented-audio.mjs",
		"recovery-transport.mjs",
		"restore-checkpoint.mjs",
		"native-browser.mjs",
		"browser-evidence.mjs",
	]) {
		await fs.copyFile(
			path.join(root, "apps/desktop-gpui/ux-walk", file),
			path.join(engine, file),
		);
	}
	await fs.writeFile(
		path.join(resources, "engine-source.json"),
		`${JSON.stringify({ repository: "https://github.com/CantrellJax/ux-walk-cap", sourceURL: `${parent.UXWalkSourceURL ?? `https://github.com/CantrellJax/ux-walk-cap/tree/${run("git", ["-C", root, "rev-parse", "HEAD"]).trim()}`}/vendor/ux-walk`, revision, node: nodeVersion }, null, 2)}\n`,
	);
	await brandBuiltApp(contents, parent);
	await signApp(app, process.env.CAP_UX_SIGNING_IDENTITY || "-");
	verifyBundledNode(node);
	console.log(
		`Bundled the native UX Walk engine ${revision} into ${path.basename(app)}`,
	);
}

if (
	process.argv[1] &&
	path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	const app = process.argv[2];
	if (!app)
		throw new Error(
			`Usage: node scripts/bundle-ux-walk.mjs <${brand.display_name}.app>`,
		);
	bundleUxWalk(app).catch((error) => {
		console.error(error.message);
		process.exitCode = 1;
	});
}
