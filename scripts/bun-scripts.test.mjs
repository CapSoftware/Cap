import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const manifest = JSON.parse(
	await readFile(new URL("../package.json", import.meta.url), "utf8"),
);

async function fixture(t) {
	const root = await mkdtemp(path.join(tmpdir(), "cap-bun-script-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await mkdir(path.join(root, "apps/web"), { recursive: true });
	await writeFile(
		path.join(root, "argv.mjs"),
		"console.log(JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),node:!!process.versions.node,bun:!!process.versions.bun,env:process.env.CAP_SCRIPT_ENV_PROBE??null}));",
	);
	await writeFile(
		path.join(root, ".env"),
		"CAP_SCRIPT_ENV_PROBE=from-dotenv\n",
	);
	await writeFile(
		path.join(root, "package.json"),
		JSON.stringify({
			type: "module",
			scripts: {
				dev: "node argv.mjs",
				"dev:web": manifest.scripts["dev:web"],
				web: manifest.scripts.web,
			},
		}),
	);
	await writeFile(
		path.join(root, "apps/web/package.json"),
		JSON.stringify({
			scripts: { build: "node ../../argv.mjs", test: "node ../../argv.mjs" },
		}),
	);
	return root;
}

function run(root, args) {
	const result = spawnSync("bun", ["run", ...args], {
		cwd: root,
		encoding: "utf8",
		env: { ...process.env, CAP_SCRIPT_ENV_PROBE: "inherited" },
	});
	assert.equal(result.status, 0, result.error?.message ?? result.stderr);
	return JSON.parse(result.stdout.trim());
}

test("web development alias forwards both exclusion filters and extra arguments", async (t) => {
	const root = await fixture(t);
	const result = run(root, [
		"dev:web",
		"--port",
		"4321",
		"an argument with spaces",
	]);
	assert.deepEqual(result.args, [
		"--filter=!@cap/desktop",
		"--filter=!@cap/mobile",
		"--port",
		"4321",
		"an argument with spaces",
	]);
	assert.equal(result.node, true);
	assert.equal(result.bun, false);
	assert.equal(result.env, "inherited");
});

for (const script of ["build", "test"]) {
	test(`web alias runs the package ${script} script in its workspace`, async (t) => {
		const root = await fixture(t);
		const result = run(root, ["web", script, "--", "--target", "two words"]);
		assert.deepEqual(result.args, ["--target", "two words"]);
		assert.equal(path.basename(result.cwd), "web");
		assert.equal(result.bun, false);
	});
}
