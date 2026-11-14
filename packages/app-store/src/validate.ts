import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import {
	CONNECTION_URL_PROBLEM_MESSAGES,
	connectionUrlProblem,
} from "./connection-url";
import {
	EVENT_REQUIRED_PERMISSION,
	FIRST_PARTY_GITHUB_OWNER,
	LIMITS,
	RESERVED_ID_WORDS,
} from "./constants";
import { formatForPath, type ImageInfo, readImageInfo } from "./image-info";
import {
	FIRST_PARTY_CONNECTION_PREFIX,
	isFirstPartyConnectionUrl,
	isImageBackground,
	type Manifest,
	parseManifest,
} from "./manifest";

export type ValidationIssue = {
	app: string;
	file: string;
	message: string;
};

export type LoadedApp = {
	id: string;
	dir: string;
	manifest: Manifest;
	files: Map<string, Uint8Array>;
	images: Map<string, ImageInfo>;
	readme: string;
	contentHash: string;
};

export const REQUIRED_FILES = ["manifest.json", "icon.png", "README.md"];
export const OPTIONAL_FILES = ["CHANGELOG.md"];

const isFirstParty = (manifest: Manifest) =>
	manifest.author.github === FIRST_PARTY_GITHUB_OWNER;

async function walk(
	root: string,
	dir: string,
	files: string[],
	problems: string[],
): Promise<void> {
	const entries = await readdir(dir, { withFileTypes: true });
	for (const entry of entries) {
		const full = join(dir, entry.name);
		const rel = relative(root, full).split(sep).join("/");
		if (entry.name.startsWith(".")) {
			problems.push(`${rel}: hidden files are not allowed`);
			continue;
		}
		const stat = await lstat(full);
		if (stat.isSymbolicLink()) {
			problems.push(`${rel}: symlinks are not allowed`);
			continue;
		}
		if (stat.isDirectory()) {
			await walk(root, full, files, problems);
			continue;
		}
		if (!stat.isFile()) {
			problems.push(`${rel}: only regular files are allowed`);
			continue;
		}
		if ((stat.mode & 0o111) !== 0) {
			problems.push(`${rel}: executable files are not allowed`);
			continue;
		}
		files.push(rel);
	}
}

export const hashBytes = (bytes: Uint8Array) =>
	createHash("sha256").update(bytes).digest("hex");

export function contentHashOf(files: Map<string, Uint8Array>) {
	const hash = createHash("sha256");
	for (const path of [...files.keys()].sort()) {
		const bytes = files.get(path);
		if (!bytes) continue;
		hash.update(path);
		hash.update("\0");
		hash.update(hashBytes(bytes));
		hash.update("\n");
	}
	return hash.digest("hex");
}

function referencedImages(manifest: Manifest) {
	const paths = new Set<string>();
	for (const background of manifest.backgrounds ?? []) {
		if (isImageBackground(background)) paths.add(background.image);
	}
	for (const screenshot of manifest.screenshots ?? []) paths.add(screenshot);
	return paths;
}

function duplicates(values: readonly string[]) {
	const seen = new Set<string>();
	const repeated = new Set<string>();
	for (const value of values) {
		if (seen.has(value)) repeated.add(value);
		seen.add(value);
	}
	return [...repeated];
}

function checkManifestRules(
	manifest: Manifest,
	folderName: string,
	report: (file: string, message: string) => void,
) {
	const firstParty = isFirstParty(manifest);
	if (manifest.id !== folderName) {
		report(
			"manifest.json",
			`id "${manifest.id}" must match the folder name "${folderName}"`,
		);
	}
	if (!firstParty) {
		const segments = manifest.id.split("-");
		for (const word of RESERVED_ID_WORDS) {
			if (segments.includes(word)) {
				report("manifest.json", `id must not contain the word "${word}"`);
			}
		}
	}
	if (manifest.builtin && !firstParty) {
		report("manifest.json", "only apps published by Cap can be built-in");
	}
	if (manifest.builtin && manifest.connection) {
		report(
			"manifest.json",
			"a built-in app uses Cap's own integration and cannot also declare a connection",
		);
	}
	const contributes =
		manifest.builtin ||
		manifest.backgrounds ||
		manifest.captionStyles ||
		manifest.colorLooks ||
		manifest.connection;
	if (!contributes) {
		report(
			"manifest.json",
			"an app must contribute something: backgrounds, captionStyles, colorLooks or connection",
		);
	}
	for (const category of duplicates(manifest.categories)) {
		report("manifest.json", `category "${category}" is listed twice`);
	}
	for (const [label, items] of [
		["backgrounds", manifest.backgrounds],
		["captionStyles", manifest.captionStyles],
		["colorLooks", manifest.colorLooks],
	] as const) {
		for (const id of duplicates((items ?? []).map((item) => item.id))) {
			report("manifest.json", `${label} id "${id}" is used twice`);
		}
	}
	const connection = manifest.connection;
	if (!connection) return;
	const problem = isFirstPartyConnectionUrl(connection.url)
		? null
		: connectionUrlProblem(connection.url);
	if (isFirstPartyConnectionUrl(connection.url)) {
		if (!firstParty) {
			report(
				"manifest.json",
				"connection.url must be an https:// URL on your own server",
			);
		} else if (
			connection.url !== `${FIRST_PARTY_CONNECTION_PREFIX}${manifest.id}`
		) {
			report(
				"manifest.json",
				`connection.url must be ${FIRST_PARTY_CONNECTION_PREFIX}${manifest.id}`,
			);
		}
	}
	if (problem) {
		report(
			"manifest.json",
			`connection.url ${CONNECTION_URL_PROBLEM_MESSAGES[problem]}`,
		);
	}
	if (!manifest.privacyPolicy) {
		report(
			"manifest.json",
			"apps with a connection must link a privacyPolicy, because Cap sends them data",
		);
	}
	const events = connection.events ?? [];
	const actions = connection.actions ?? [];
	if (events.length === 0 && actions.length === 0) {
		report(
			"manifest.json",
			"a connection must subscribe to at least one event or declare at least one action",
		);
	}
	for (const event of duplicates(events)) {
		report("manifest.json", `event "${event}" is listed twice`);
	}
	const permissions = connection.permissions ?? [];
	for (const permission of duplicates(permissions)) {
		report("manifest.json", `permission "${permission}" is listed twice`);
	}
	for (const event of events) {
		const required = EVENT_REQUIRED_PERMISSION[event];
		if (required && !permissions.includes(required)) {
			report(
				"manifest.json",
				`event "${event}" needs the "${required}" permission`,
			);
		}
	}
	for (const id of duplicates(actions.map((action) => action.id))) {
		report("manifest.json", `action id "${id}" is used twice`);
	}
	const settings = connection.settings ?? [];
	for (const key of duplicates(settings.map((setting) => setting.key))) {
		report("manifest.json", `setting key "${key}" is used twice`);
	}
	for (const setting of settings) {
		if (setting.type !== "select") continue;
		const values = setting.options.map((option) => option.value);
		for (const value of duplicates(values)) {
			report(
				"manifest.json",
				`setting "${setting.key}" lists option "${value}" twice`,
			);
		}
		if (setting.default !== undefined && !values.includes(setting.default)) {
			report(
				"manifest.json",
				`setting "${setting.key}" default must be one of its options`,
			);
		}
	}
}

function checkImage(
	path: string,
	info: ImageInfo | null,
	bytes: Uint8Array,
	rule: {
		label: string;
		format?: ImageInfo["format"];
		exact?: { width: number; height: number };
		min?: { width: number; height: number };
		maxDimension?: number;
		maxBytes: number;
	},
	report: (file: string, message: string) => void,
) {
	if (!info) {
		report(path, `${rule.label} is not a readable PNG, JPEG or WebP image`);
		return;
	}
	const expected = formatForPath(path);
	if (expected !== info.format) {
		report(path, `${rule.label} extension does not match its contents`);
	}
	if (rule.format && info.format !== rule.format) {
		report(path, `${rule.label} must be a ${rule.format.toUpperCase()}`);
	}
	if (
		rule.exact &&
		(info.width !== rule.exact.width || info.height !== rule.exact.height)
	) {
		report(
			path,
			`${rule.label} must be ${rule.exact.width}x${rule.exact.height}, found ${info.width}x${info.height}`,
		);
	}
	if (
		rule.min &&
		(info.width < rule.min.width || info.height < rule.min.height)
	) {
		report(
			path,
			`${rule.label} must be at least ${rule.min.width}x${rule.min.height}, found ${info.width}x${info.height}`,
		);
	}
	if (
		rule.maxDimension &&
		(info.width > rule.maxDimension || info.height > rule.maxDimension)
	) {
		report(
			path,
			`${rule.label} must be at most ${rule.maxDimension} pixels on each side`,
		);
	}
	if (bytes.byteLength > rule.maxBytes) {
		report(
			path,
			`${rule.label} must be at most ${Math.round(rule.maxBytes / 1024)} KB`,
		);
	}
}

export async function loadApp(
	dir: string,
	folderName: string,
): Promise<{ app: LoadedApp | null; issues: ValidationIssue[] }> {
	const issues: ValidationIssue[] = [];
	const report = (file: string, message: string) =>
		issues.push({ app: folderName, file, message });

	const paths: string[] = [];
	const problems: string[] = [];
	await walk(dir, dir, paths, problems);
	for (const problem of problems) {
		const [file, message] = problem.split(": ");
		report(file ?? problem, message ?? problem);
	}

	for (const required of REQUIRED_FILES) {
		if (!paths.includes(required)) report(required, "is required");
	}
	if (!paths.includes("manifest.json")) return { app: null, issues };

	const files = new Map<string, Uint8Array>();
	for (const path of paths) {
		files.set(path, new Uint8Array(await readFile(join(dir, path))));
	}

	let raw: unknown;
	try {
		raw = JSON.parse(
			new TextDecoder().decode(files.get("manifest.json") ?? new Uint8Array()),
		);
	} catch (error) {
		report(
			"manifest.json",
			`is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
		return { app: null, issues };
	}

	const parsed = parseManifest(raw);
	if (!parsed.ok) {
		for (const issue of parsed.issues) {
			report("manifest.json", `${issue.path}: ${issue.message}`);
		}
		return { app: null, issues };
	}
	const manifest = parsed.manifest;
	checkManifestRules(manifest, folderName, report);

	const images = new Map<string, ImageInfo>();
	const referenced = referencedImages(manifest);
	const allowed = new Set([
		...REQUIRED_FILES,
		...OPTIONAL_FILES,
		...referenced,
	]);
	for (const path of paths) {
		if (!allowed.has(path)) {
			report(
				path,
				"is not used by the manifest. Remove it, or reference it from manifest.json",
			);
		}
	}
	for (const path of referenced) {
		if (!files.has(path))
			report(path, "is referenced by the manifest but missing");
	}

	let total = 0;
	for (const bytes of files.values()) total += bytes.byteLength;
	if (total > LIMITS.appMaxBytes) {
		report(
			".",
			`the app folder must be at most ${LIMITS.appMaxBytes / 1024 / 1024} MB, found ${(total / 1024 / 1024).toFixed(1)} MB`,
		);
	}

	const icon = files.get("icon.png");
	if (icon) {
		const info = readImageInfo(icon);
		if (info) images.set("icon.png", info);
		checkImage(
			"icon.png",
			info,
			icon,
			{
				label: "icon",
				format: "png",
				exact: { width: LIMITS.iconSize, height: LIMITS.iconSize },
				maxBytes: LIMITS.iconMaxBytes,
			},
			report,
		);
	}

	for (const background of manifest.backgrounds ?? []) {
		if (!isImageBackground(background)) continue;
		const bytes = files.get(background.image);
		if (!bytes) continue;
		const info = readImageInfo(bytes);
		if (info) images.set(background.image, info);
		checkImage(
			background.image,
			info,
			bytes,
			{
				label: `background "${background.id}"`,
				min: {
					width: LIMITS.backgroundMinWidth,
					height: LIMITS.backgroundMinHeight,
				},
				maxDimension: LIMITS.backgroundMaxDimension,
				maxBytes: LIMITS.backgroundMaxBytes,
			},
			report,
		);
	}

	for (const screenshot of manifest.screenshots ?? []) {
		const bytes = files.get(screenshot);
		if (!bytes) continue;
		const info = readImageInfo(bytes);
		if (info) images.set(screenshot, info);
		checkImage(
			screenshot,
			info,
			bytes,
			{
				label: "screenshot",
				exact: {
					width: LIMITS.screenshotWidth,
					height: LIMITS.screenshotHeight,
				},
				maxBytes: LIMITS.screenshotMaxBytes,
			},
			report,
		);
	}

	const readmeBytes = files.get("README.md");
	const readme = readmeBytes ? new TextDecoder().decode(readmeBytes) : "";
	if (readmeBytes) {
		if (readmeBytes.byteLength > LIMITS.readmeMaxBytes) {
			report("README.md", "must be at most 64 KB");
		}
		if (readme.trim().length < 40) {
			report(
				"README.md",
				"must explain what the app does and how to set it up",
			);
		}
		if (/<\s*(script|iframe|style|object|embed)\b/i.test(readme)) {
			report(
				"README.md",
				"must not contain script, iframe, style or embed tags",
			);
		}
	}

	return {
		app: {
			id: manifest.id,
			dir,
			manifest,
			files,
			images,
			readme,
			contentHash: contentHashOf(files),
		},
		issues,
	};
}

export function compareSemver(a: string, b: string) {
	const left = a.split(".").map(Number);
	const right = b.split(".").map(Number);
	for (let i = 0; i < 3; i++) {
		const diff = (left[i] ?? 0) - (right[i] ?? 0);
		if (diff !== 0) return Math.sign(diff);
	}
	return 0;
}

export type BaseApp = {
	version: string;
	contentHash: string;
	secretKeys?: string[];
};

export const secretKeysOf = (manifest: Manifest) =>
	(manifest.connection?.settings ?? [])
		.filter((setting) => setting.type === "secret")
		.map((setting) => setting.key);

export async function listAppFolders(appsRoot: string) {
	const entries = await readdir(appsRoot, { withFileTypes: true }).catch(
		() => [],
	);
	return entries
		.filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
		.map((entry) => entry.name)
		.sort();
}

export async function validateAppStore(
	appsRoot: string,
	options: { base?: Map<string, BaseApp> } = {},
): Promise<{ apps: LoadedApp[]; issues: ValidationIssue[] }> {
	const issues: ValidationIssue[] = [];
	const apps: LoadedApp[] = [];
	const rootEntries = await readdir(appsRoot, { withFileTypes: true }).catch(
		() => [],
	);
	for (const entry of rootEntries) {
		if (!entry.isDirectory()) {
			issues.push({
				app: entry.name,
				file: entry.name,
				message: "only app folders are allowed in app-store/apps",
			});
		}
	}
	for (const folder of await listAppFolders(appsRoot)) {
		const result = await loadApp(join(appsRoot, folder), folder);
		issues.push(...result.issues);
		if (result.app) apps.push(result.app);
	}

	const names = new Map<string, string>();
	for (const app of apps) {
		const key = app.manifest.name.toLowerCase();
		const other = names.get(key);
		if (other) {
			issues.push({
				app: app.id,
				file: "manifest.json",
				message: `name "${app.manifest.name}" is already used by ${other}`,
			});
		}
		names.set(key, app.id);
	}

	if (options.base) {
		for (const app of apps) {
			const previous = options.base.get(app.id);
			if (!previous || previous.contentHash === app.contentHash) continue;
			for (const key of previous.secretKeys ?? []) {
				const setting = app.manifest.connection?.settings?.find(
					(candidate) => candidate.key === key,
				);
				if (setting && setting.type !== "secret") {
					issues.push({
						app: app.id,
						file: "manifest.json",
						message: `setting "${key}" was a secret and must stay one. Use a new key for a different kind of value`,
					});
				}
			}
			if (compareSemver(app.manifest.version, previous.version) <= 0) {
				issues.push({
					app: app.id,
					file: "manifest.json",
					message: `the app changed, so version must go above ${previous.version}`,
				});
			}
		}
	}

	return { apps, issues };
}
