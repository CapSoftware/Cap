import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	copyFileSync,
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
