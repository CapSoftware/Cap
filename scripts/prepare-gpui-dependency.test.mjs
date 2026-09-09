import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const patchDirectory = "apps/desktop-gpui/patches";

test("GPUI patches remain applicable after a Windows-style Git checkout", (t) => {
	const fixture = mkdtempSync(path.join(tmpdir(), "cap-gpui-patch-checkout-"));
	t.after(() => rmSync(fixture, { recursive: true, force: true }));
	const emptyConfig = path.join(fixture, "empty.gitconfig");
	writeFileSync(emptyConfig, "");
	const env = {
		...Object.fromEntries(
			Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
		),
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: emptyConfig,
		GIT_ATTR_NOSYSTEM: "1",
	};
	const git = (...args) => {
		const result = spawnSync("git", args, {
			cwd: fixture,
			env,
			encoding: "utf8",
			maxBuffer: 4 * 1024 * 1024,
		});
		assert.ifError(result.error);
		assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
		return result.stdout;
	};

	git("init", "--quiet");
	git("config", "core.autocrlf", "true");
	git("config", "core.attributesFile", emptyConfig);
	copyFileSync(
		path.join(repositoryRoot, ".gitattributes"),
		path.join(fixture, ".gitattributes"),
	);
	mkdirSync(path.join(fixture, patchDirectory), { recursive: true });
	const patches = readdirSync(path.join(repositoryRoot, patchDirectory))
		.filter((file) => file.endsWith(".patch"))
		.map((file) => `${patchDirectory}/${file}`);
	assert.ok(patches.length > 0);
	const originalBytes = new Map();
	for (const patch of patches) {
		const bytes = readFileSync(path.join(repositoryRoot, patch));
		assert.equal(bytes.includes(Buffer.from("\r\n")), false, patch);
		originalBytes.set(patch, bytes);
		writeFileSync(path.join(fixture, patch), bytes);
	}
	git("add", "--", ".gitattributes", ...patches);
	for (const patch of patches) rmSync(path.join(fixture, patch));
	git("checkout-index", "--force", "--", ...patches);
	for (const patch of patches) {
		assert.deepEqual(
			readFileSync(path.join(fixture, patch)),
			originalBytes.get(patch),
			`${patch} must retain LF line endings`,
		);
		assert.notEqual(
			git("apply", "--numstat", "--unidiff-zero", "--", patch),
			"",
		);
	}
});

test("dependency verification handles overlapping patches without changing the checkout", async (t) => {
	const fixture = mkdtempSync(path.join(tmpdir(), "cap-gpui-patch-stack-"));
	t.after(() => rmSync(fixture, { recursive: true, force: true }));
	const emptyConfig = path.join(fixture, "empty.gitconfig");
	writeFileSync(emptyConfig, "");
	const env = {
		...Object.fromEntries(
			Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
		),
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: emptyConfig,
		GIT_ATTR_NOSYSTEM: "1",
	};
	const run = (cwd, command, args) => {
		const result = spawnSync(command, args, {
			cwd,
			env,
			encoding: "utf8",
			timeout: 30_000,
		});
		assert.ifError(result.error);
		return result;
	};
	const git = (cwd, ...args) => {
		const result = run(cwd, "git", args);
		assert.equal(result.status, 0, result.stderr);
		return result.stdout;
	};
	const upstream = path.join(fixture, "upstream");
	const cap = path.join(fixture, "Cap checkout");
	const zed = path.join(fixture, "zed-cap");
	mkdirSync(upstream);
	mkdirSync(path.join(cap, "scripts"), { recursive: true });
	mkdirSync(path.join(cap, patchDirectory), { recursive: true });
	git(upstream, "init", "--quiet");
	git(upstream, "config", "user.name", "Fixture");
	git(upstream, "config", "user.email", "fixture@example.invalid");
	const commit = () => {
		git(upstream, "add", "--all");
		git(upstream, "commit", "--quiet", "-m", "Fixture state");
	};
	writeFileSync(path.join(upstream, "renderer.rs"), "base\n");
	writeFileSync(path.join(upstream, "windows.rs"), "base\n");
	commit();
	const base = git(upstream, "rev-parse", "HEAD").trim();
	const patch = (name) => {
		git(upstream, "add", "--all");
		writeFileSync(
			path.join(cap, patchDirectory, name),
			git(upstream, "diff", "--cached", "--binary"),
		);
		commit();
	};
	writeFileSync(path.join(upstream, "renderer.rs"), "shared renderer\n");
	writeFileSync(path.join(upstream, "temporary.rs"), "intermediate\n");
	patch("zed-gpui.patch");
	writeFileSync(path.join(upstream, "windows.rs"), "Windows renderer\n");
	patch("zed-windows.patch");
	writeFileSync(path.join(upstream, "renderer.rs"), "Linux renderer\n");
	rmSync(path.join(upstream, "temporary.rs"));
	patch("zed-linux.patch");
	const script = path.join(cap, "scripts/prepare-gpui-dependency.sh");
	writeFileSync(
		script,
		readFileSync(
			path.join(repositoryRoot, "scripts/prepare-gpui-dependency.sh"),
			"utf8",
		)
			.replace("5d1f83d9f27a19bec1fb241dc33b42238af9cf8d", base)
			.replace("https://github.com/wingleeio/zed.git", upstream),
	);

	await t.test("fresh preparation validates the complete ordered stack", () => {
		const result = run(cap, "bash", [script]);
		assert.equal(result.status, 0, result.stderr);
		assert.equal(
			readFileSync(path.join(zed, "renderer.rs"), "utf8"),
			"Linux renderer\n",
		);
		assert.equal(existsSync(path.join(zed, "temporary.rs")), false);
	});

	writeFileSync(path.join(zed, "unrelated.txt"), "preserve staged work\n");
	git(zed, "add", "unrelated.txt");
	writeFileSync(path.join(zed, "unrelated.txt"), "preserve unstaged work\n");
	const fingerprint = () => ({
		index: readFileSync(path.join(zed, ".git/index")),
		renderer: readFileSync(path.join(zed, "renderer.rs")),
		unrelated: readFileSync(path.join(zed, "unrelated.txt")),
		status: git(zed, "status", "--porcelain"),
		head: git(zed, "rev-parse", "HEAD"),
	});

	await t.test(
		"repeat verification preserves source, index, and unrelated work",
		() => {
			const before = fingerprint();
			for (let repeat = 0; repeat < 2; repeat++) {
				const result = run(cap, "bash", [script]);
				assert.equal(result.status, 0, result.stderr);
				assert.deepEqual(fingerprint(), before);
			}
		},
	);

	await t.test(
		"a missing final patch fails without repairing or overwriting files",
		() => {
			git(
				zed,
				"apply",
				"--reverse",
				path.join(cap, patchDirectory, "zed-linux.patch"),
			);
			const before = fingerprint();
			const result = run(cap, "bash", [script]);
			assert.equal(result.status, 1);
			assert.match(result.stderr, /does not contain Cap's pinned GPUI patch/);
			assert.deepEqual(fingerprint(), before);
			assert.equal(existsSync(path.join(zed, "temporary.rs")), true);
		},
	);
});
