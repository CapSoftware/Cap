import { execFileSync } from "node:child_process";
import {
	cp,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { JSONSchema, Schema } from "effect";
import { buildCatalog } from "./build";
import { BlockedApp } from "./catalog";
import { Manifest } from "./manifest";
import {
	type BaseApp,
	listAppFolders,
	loadApp,
	type ValidationIssue,
	validateAppStore,
} from "./validate";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const storeRoot = join(repoRoot, "app-store");
const appsRoot = join(storeRoot, "apps");
const schemaPath = join(storeRoot, "manifest.schema.json");
const blockedPath = join(storeRoot, "blocked.json");

function option(args: string[], name: string) {
	const index = args.indexOf(name);
	return index === -1 ? undefined : args[index + 1];
}

function printIssues(issues: ValidationIssue[]) {
	const byApp = new Map<string, ValidationIssue[]>();
	for (const issue of issues) {
		const list = byApp.get(issue.app) ?? [];
		list.push(issue);
		byApp.set(issue.app, list);
	}
	for (const [app, list] of byApp) {
		console.error(`\n${app}`);
		for (const issue of list) {
			console.error(`  ${issue.file}: ${issue.message}`);
		}
	}
	console.error(
		`\n${issues.length} problem${issues.length === 1 ? "" : "s"} found. See app-store/README.md for the rules.`,
	);
}

async function loadBase(ref: string): Promise<Map<string, BaseApp>> {
	const base = new Map<string, BaseApp>();
	const scratch = await mkdtemp(join(tmpdir(), "cap-app-store-base-"));
	try {
		let archive: Buffer;
		try {
			archive = execFileSync(
				"git",
				["archive", "--format=tar", ref, "app-store/apps"],
				{ cwd: repoRoot, maxBuffer: 512 * 1024 * 1024 },
			);
		} catch {
			return base;
		}
		execFileSync("tar", ["-x", "-C", scratch], { input: archive });
		const root = join(scratch, "app-store", "apps");
		for (const folder of await listAppFolders(root)) {
			const { app } = await loadApp(join(root, folder), folder);
			if (app) {
				base.set(app.id, {
					version: app.manifest.version,
					contentHash: app.contentHash,
				});
			}
		}
		return base;
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
}

async function readBlocked() {
	try {
		const raw = JSON.parse(await readFile(blockedPath, "utf8"));
		return Schema.decodeUnknownSync(Schema.Array(BlockedApp))(raw);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

export function manifestJsonSchema() {
	return `${JSON.stringify(JSONSchema.make(Manifest), null, "\t")}\n`;
}

async function validateCommand(args: string[]) {
	const ref = option(args, "--base");
	const base = ref ? await loadBase(ref) : undefined;
	const { apps, issues } = await validateAppStore(appsRoot, { base });
	const committedSchema = await readFile(schemaPath, "utf8").catch(() => "");
	const schemaDrift =
		JSON.stringify(JSON.parse(committedSchema || "null")) !==
		JSON.stringify(JSON.parse(manifestJsonSchema()));
	if (schemaDrift) {
		issues.push({
			app: "app-store",
			file: "manifest.schema.json",
			message: "is out of date. Run `bun app-store schema`",
		});
	}
	if (issues.length > 0) {
		printIssues(issues);
		process.exitCode = 1;
		return;
	}
	console.log(`${apps.length} apps are valid.`);
}

async function buildCommand(args: string[]) {
	const catalogPath = option(args, "--catalog");
	const assetsDir = option(args, "--assets");
	const assetBaseUrl = option(args, "--asset-base-url") ?? "/app-store";
	if (!catalogPath || !assetsDir) {
		throw new Error(
			"Usage: app-store build --catalog <file> --assets <dir> [--asset-base-url /app-store]",
		);
	}
	const { apps, issues } = await validateAppStore(appsRoot);
	if (issues.length > 0) {
		printIssues(issues);
		process.exitCode = 1;
		return;
	}
	const { catalog, files } = buildCatalog(apps, {
		assetBaseUrl,
		blocked: await readBlocked(),
	});
	const assetsRoot = resolve(assetsDir);
	await rm(assetsRoot, { recursive: true, force: true });
	for (const file of files) {
		const target = join(assetsRoot, file.path);
		await mkdir(dirname(target), { recursive: true });
		await writeFile(target, file.bytes);
	}
	const catalogFile = resolve(catalogPath);
	await mkdir(dirname(catalogFile), { recursive: true });
	await writeFile(catalogFile, `${JSON.stringify(catalog)}\n`);
	console.log(
		`Built the App Store catalog: ${catalog.apps.length} apps, ${files.length} assets, revision ${catalog.revision}.`,
	);
}

async function schemaCommand() {
	await writeFile(schemaPath, manifestJsonSchema());
	console.log(`Wrote ${schemaPath}`);
}

async function newCommand(args: string[]) {
	const id = args[0];
	const template = option(args, "--template") ?? "content";
	if (!id || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) {
		throw new Error(
			"Usage: app-store new <kebab-case-id> [--template content|connection]",
		);
	}
	const source = join(storeRoot, "templates", template);
	const target = join(appsRoot, id);
	if (!(await stat(source).catch(() => null))) {
		throw new Error(`Unknown template "${template}"`);
	}
	if (await stat(target).catch(() => null)) {
		throw new Error(`app-store/apps/${id} already exists`);
	}
	await cp(source, target, { recursive: true });
	const manifestPath = join(target, "manifest.json");
	const manifest = await readFile(manifestPath, "utf8");
	await writeFile(manifestPath, manifest.replaceAll("my-app", id));
	console.log(
		`Created app-store/apps/${id}. Edit manifest.json, replace icon.png and README.md, then run \`bun app-store validate\`.`,
	);
}

const [command, ...rest] = process.argv.slice(2);
const commands: Record<string, (args: string[]) => Promise<void>> = {
	validate: validateCommand,
	build: buildCommand,
	schema: schemaCommand,
	new: newCommand,
};

const run = command ? commands[command] : undefined;
if (!run) {
	console.error("Usage: app-store <validate|build|schema|new> [options]");
	process.exitCode = 1;
} else {
	run(rest).catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	});
}
