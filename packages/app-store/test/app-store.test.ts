import {
	chmod,
	cp,
	mkdtemp,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildCatalog } from "../src/build";
import { platformsFor } from "../src/catalog";
import { connectionUrlProblem } from "../src/connection-url";
import { readImageInfo } from "../src/image-info";
import { type Manifest, parseManifest } from "../src/manifest";
import { parseActionResult } from "../src/protocol";
import {
	deriveSigningKey,
	signCapRequest,
	verifyCapRequest,
} from "../src/signing";
import { loadApp, validateAppStore } from "../src/validate";

const repoRoot = resolve(import.meta.dirname, "../../..");
const appsRoot = join(repoRoot, "app-store/apps");
const templatesRoot = join(repoRoot, "app-store/templates");

const scratchDirs: string[] = [];
async function scratch() {
	const dir = await mkdtemp(join(tmpdir(), "cap-app-store-test-"));
	scratchDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(
		scratchDirs
			.splice(0)
			.map((dir) => rm(dir, { recursive: true, force: true })),
	);
});

async function appFromTemplate(
	template: "content" | "connection",
	id = "my-app",
	edit?: (manifest: Record<string, unknown>) => void,
) {
	const root = await scratch();
	const dir = join(root, id);
	await cp(join(templatesRoot, template), dir, { recursive: true });
	const manifestPath = join(dir, "manifest.json");
	const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
	manifest.id = id;
	edit?.(manifest);
	await writeFile(manifestPath, JSON.stringify(manifest));
	return { root, dir };
}

const messagesFor = async (dir: string, id = "my-app") =>
	(await loadApp(dir, id)).issues.map(
		(issue) => `${issue.file}: ${issue.message}`,
	);

describe("the apps in this repo", () => {
	it("are all valid", async () => {
		const { apps, issues } = await validateAppStore(appsRoot);
		expect(issues).toEqual([]);
		expect(apps.length).toBeGreaterThan(0);
	});

	it("templates are valid apps", async () => {
		for (const template of ["content", "connection"] as const) {
			const { dir } = await appFromTemplate(template);
			expect(await messagesFor(dir)).toEqual([]);
		}
	});
});

describe("manifest schema", () => {
	const base = {
		apiVersion: 1,
		id: "my-app",
		name: "My App",
		version: "1.0.0",
		description: "Adds something useful to Cap.",
		author: { name: "Someone", github: "someone" },
		license: "MIT",
		categories: ["backgrounds"],
		backgrounds: [{ id: "a", name: "A", color: "#112233" }],
	};

	it("accepts a minimal manifest", () => {
		expect(parseManifest(base).ok).toBe(true);
	});

	it("rejects unknown keys", () => {
		const result = parseManifest({ ...base, surprise: true });
		expect(result.ok).toBe(false);
	});

	it("rejects unsupported api versions, bad ids and bad versions", () => {
		for (const patch of [
			{ apiVersion: 2 },
			{ id: "My_App" },
			{ id: "ab" },
			{ version: "1.0" },
			{ version: "01.0.0" },
			{ categories: [] },
			{ categories: ["games"] },
			{ license: "GPL-9" },
			{ name: " Padded" },
		]) {
			expect(
				parseManifest({ ...base, ...patch }).ok,
				JSON.stringify(patch),
			).toBe(false);
		}
	});

	it("rejects out of range content values", () => {
		const look = {
			id: "x",
			name: "X",
			values: { saturation: 2 },
		};
		expect(parseManifest({ ...base, colorLooks: [look] }).ok).toBe(false);
	});

	it("reports paths for problems", () => {
		const result = parseManifest({
			...base,
			author: { name: "x", github: "-bad" },
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(
				result.issues.some((issue) => issue.path === "author.github"),
			).toBe(true);
		}
	});
});

describe("validator guards", () => {
	it("requires the id to match the folder", async () => {
		const { dir } = await appFromTemplate("content", "my-app", (manifest) => {
			manifest.id = "other-app";
		});
		expect((await messagesFor(dir)).join("\n")).toContain(
			'must match the folder name "my-app"',
		);
	});

	it("reserves words for first-party apps", async () => {
		const { dir } = await appFromTemplate("content", "cap-themes");
		expect((await messagesFor(dir, "cap-themes")).join("\n")).toContain(
			'must not contain the word "cap"',
		);
	});

	it("rejects files the manifest does not use, hidden files and symlinks", async () => {
		const { dir } = await appFromTemplate("content");
		await writeFile(join(dir, "notes.txt"), "hi");
		await writeFile(join(dir, ".env"), "SECRET=1");
		await symlink("/etc/hosts", join(dir, "hosts"));
		const messages = (await messagesFor(dir)).join("\n");
		expect(messages).toContain("notes.txt: is not used by the manifest");
		expect(messages).toContain(".env: hidden files are not allowed");
		expect(messages).toContain("hosts: symlinks are not allowed");
	});

	it("rejects executables", async () => {
		const { dir } = await appFromTemplate("content");
		await chmod(join(dir, "README.md"), 0o755);
		expect((await messagesFor(dir)).join("\n")).toContain(
			"executable files are not allowed",
		);
	});

	it("checks the icon size", async () => {
		const { dir } = await appFromTemplate("content");
		await cp(
			join(appsRoot, "aurora-backgrounds/backgrounds/dawn.jpg"),
			join(dir, "icon.png"),
		);
		const messages = (await messagesFor(dir)).join("\n");
		expect(messages).toContain("icon extension does not match its contents");
		expect(messages).toContain("icon must be 512x512");
	});

	it("checks background images", async () => {
		const { dir } = await appFromTemplate("content", "my-app", (manifest) => {
			manifest.backgrounds = [
				{ id: "small", name: "Small", image: "small.png" },
			];
		});
		await cp(join(dir, "icon.png"), join(dir, "small.png"));
		expect((await messagesFor(dir)).join("\n")).toContain(
			'background "small" must be at least 1920x1080',
		);
	});

	it("requires a privacy policy, a public https url and matching permissions for connections", async () => {
		const { dir } = await appFromTemplate(
			"connection",
			"my-app",
			(manifest) => {
				delete manifest.privacyPolicy;
				const connection = manifest.connection as Record<string, unknown>;
				connection.url = "https://localhost/cap";
				connection.permissions = [];
			},
		);
		const messages = (await messagesFor(dir)).join("\n");
		expect(messages).toContain("must link a privacyPolicy");
		expect(messages).toContain("must use a public hostname");
		expect(messages).toContain('needs the "cap.transcript" permission');
	});

	it("keeps first-party connection paths and built-ins to Cap", async () => {
		const { dir } = await appFromTemplate(
			"connection",
			"my-app",
			(manifest) => {
				(manifest.connection as Record<string, unknown>).url =
					"/api/app-store/first-party/my-app";
			},
		);
		expect((await messagesFor(dir)).join("\n")).toContain(
			"must be an https:// URL on your own server",
		);
		const builtin = await appFromTemplate("content", "my-app", (manifest) => {
			manifest.builtin = "slack";
		});
		expect((await messagesFor(builtin.dir)).join("\n")).toContain(
			"only apps published by Cap can be built-in",
		);
	});

	it("rejects duplicate setting keys and a select default outside its options", async () => {
		const { dir } = await appFromTemplate(
			"connection",
			"my-app",
			(manifest) => {
				(manifest.connection as Record<string, unknown>).settings = [
					{ key: "a", type: "text", label: "A" },
					{ key: "a", type: "text", label: "Again" },
					{
						key: "mode",
						type: "select",
						label: "Mode",
						options: [{ value: "x", label: "X" }],
						default: "y",
					},
				];
			},
		);
		const messages = (await messagesFor(dir)).join("\n");
		expect(messages).toContain('setting key "a" is used twice');
		expect(messages).toContain(
			'setting "mode" default must be one of its options',
		);
	});

	it("requires a version bump when an app changes", async () => {
		const { root, dir } = await appFromTemplate("content");
		const before = await loadApp(dir, "my-app");
		await writeFile(
			join(dir, "README.md"),
			"# My App\n\nA longer description of the app and how to use it.",
		);
		const base = new Map([
			[
				"my-app",
				{ version: "1.0.0", contentHash: before.app?.contentHash ?? "" },
			],
		]);
		const changed = await validateAppStore(root, { base });
		expect(changed.issues.map((issue) => issue.message)).toContain(
			"the app changed, so version must go above 1.0.0",
		);
		const manifestPath = join(dir, "manifest.json");
		const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
		manifest.version = "1.0.1";
		await writeFile(manifestPath, JSON.stringify(manifest));
		expect((await validateAppStore(root, { base })).issues).toEqual([]);
	});
});

describe("secret settings across versions", () => {
	it("refuses an update that turns a secret into plain text", async () => {
		const { root, dir } = await appFromTemplate("connection");
		const before = await loadApp(dir, "my-app");
		const manifestPath = join(dir, "manifest.json");
		const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
		manifest.version = "1.1.0";
		manifest.connection.settings[0].type = "text";
		await writeFile(manifestPath, JSON.stringify(manifest));
		const base = new Map([
			[
				"my-app",
				{
					version: "1.0.0",
					contentHash: before.app?.contentHash ?? "",
					secretKeys: ["apiKey"],
				},
			],
		]);
		const { issues } = await validateAppStore(root, { base });
		expect(issues.map((issue) => issue.message).join("\n")).toContain(
			'setting "apiKey" was a secret and must stay one',
		);
	});
});

describe("connection urls", () => {
	it("accepts public https urls only", () => {
		expect(connectionUrlProblem("https://example.com/cap")).toBeNull();
		expect(connectionUrlProblem("http://example.com")).toBe("https_required");
		expect(connectionUrlProblem("https://user:pw@example.com")).toBe(
			"credentials",
		);
		expect(connectionUrlProblem("https://example.com:8443")).toBe("port");
		expect(connectionUrlProblem("https://example.com/cap?x=1")).toBe(
			"query_or_fragment",
		);
		expect(connectionUrlProblem("https://example.com/cap/")).toBe(
			"trailing_slash",
		);
		expect(connectionUrlProblem("https://10.0.0.1/cap")).toBe("not_public");
		expect(connectionUrlProblem("https://[::1]/cap")).toBe("not_public");
		expect(connectionUrlProblem("https://intranet/cap")).toBe("not_public");
	});
});

describe("image headers", () => {
	it("reads png and jpeg sizes", async () => {
		const icon = new Uint8Array(
			await readFile(join(appsRoot, "discord/icon.png")),
		);
		expect(readImageInfo(icon)).toEqual({
			format: "png",
			width: 512,
			height: 512,
		});
		const jpeg = new Uint8Array(
			await readFile(join(appsRoot, "aurora-backgrounds/backgrounds/dawn.jpg")),
		);
		expect(readImageInfo(jpeg)).toEqual({
			format: "jpeg",
			width: 2560,
			height: 1440,
		});
		expect(readImageInfo(new Uint8Array([1, 2, 3]))).toBeNull();
	});
});

describe("catalog", () => {
	it("is deterministic, content addressed and honours the block list", async () => {
		const { apps } = await validateAppStore(appsRoot);
		const first = buildCatalog(apps, { assetBaseUrl: "/app-store" });
		const second = buildCatalog([...apps].reverse(), {
			assetBaseUrl: "/app-store",
		});
		expect(second.catalog).toEqual(first.catalog);
		for (const file of first.files) {
			expect(file.path).toMatch(/^[a-z0-9-]+\/[0-9a-f]{32}\.(png|jpg|webp)$/);
		}
		const blocked = buildCatalog(apps, {
			assetBaseUrl: "/app-store",
			blocked: [{ id: "discord", reason: "test" }],
		});
		expect(blocked.catalog.apps.some((app) => app.id === "discord")).toBe(
			false,
		);
		expect(blocked.files.some((file) => file.path.startsWith("discord/"))).toBe(
			false,
		);
		expect(blocked.catalog.revision).not.toBe(first.catalog.revision);
	});

	it("derives platforms from contributions", () => {
		const manifest = (patch: Partial<Manifest>) =>
			({
				apiVersion: 1,
				id: "x-app",
				name: "X",
				version: "1.0.0",
				description: "Something useful.",
				author: { name: "x", github: "x" },
				license: "MIT",
				categories: ["color"],
				...patch,
			}) as Manifest;
		expect(platformsFor(manifest({ colorLooks: [] }))).toEqual(["desktop"]);
		expect(
			platformsFor(
				manifest({
					connection: { url: "https://x.dev", events: ["cap.ready"] },
				}),
			),
		).toEqual(["web"]);
		expect(
			platformsFor(
				manifest({
					connection: {
						url: "https://x.dev",
						actions: [{ id: "a", title: "Do it", target: "cap" }],
					},
				}),
			),
		).toEqual(["web", "desktop"]);
		expect(platformsFor(manifest({ builtin: "slack" }))).toEqual(["web"]);
	});
});

describe("request signing", () => {
	const key = deriveSigningKey("a-long-enough-server-secret-value");
	const keys = { keys: [key.publicKey] };

	it("derives a stable key from the server secret", () => {
		expect(
			deriveSigningKey("a-long-enough-server-secret-value").publicKey,
		).toEqual(key.publicKey);
		expect(
			deriveSigningKey("another-long-server-secret-value").publicKey.x,
		).not.toBe(key.publicKey.x);
	});

	it("verifies signed requests and rejects tampering, replays and unknown keys", () => {
		const now = 1_800_000_000_000;
		const body = JSON.stringify({ kind: "event", id: "evt_1" });
		const headers = signCapRequest({
			key,
			body,
			requestId: "req_1",
			kind: "event",
			now,
		});
		expect(verifyCapRequest({ headers, body, keys, now })).toEqual({
			ok: true,
			requestId: "req_1",
			kind: "event",
		});
		expect(verifyCapRequest({ headers, body: `${body} `, keys, now })).toEqual({
			ok: false,
			reason: "bad_signature",
		});
		expect(
			verifyCapRequest({
				headers: { ...headers, "Cap-Request-Id": "req_2" },
				body,
				keys,
				now,
			}),
		).toEqual({ ok: false, reason: "bad_signature" });
		expect(
			verifyCapRequest({ headers, body, keys, now: now + 10 * 60 * 1000 }),
		).toEqual({ ok: false, reason: "stale_timestamp" });
		const other = deriveSigningKey("another-long-server-secret-value");
		expect(
			verifyCapRequest({
				headers,
				body,
				keys: { keys: [other.publicKey] },
				now,
			}),
		).toEqual({ ok: false, reason: "unknown_key" });
		const web = new Headers(headers);
		expect(verifyCapRequest({ headers: web, body, keys, now }).ok).toBe(true);
	});
});

describe("action results", () => {
	it("accepts toast and https open results only", () => {
		expect(parseActionResult({ type: "toast", message: "Posted" })).toEqual({
			type: "toast",
			message: "Posted",
		});
		expect(
			parseActionResult({ type: "open", url: "https://example.com/x" }),
		).toEqual({ type: "open", url: "https://example.com/x" });
		expect(
			parseActionResult({ type: "open", url: "javascript:alert(1)" }),
		).toBeNull();
		expect(parseActionResult({ type: "html", body: "<b>" })).toBeNull();
		expect(parseActionResult({ type: "toast", message: "" })).toBeNull();
	});
});
