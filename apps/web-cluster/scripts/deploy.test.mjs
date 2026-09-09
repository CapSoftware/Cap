import assert from "node:assert/strict";
import {
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rename,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { deployCluster } from "./deploy.mjs";

async function fixture(t) {
	const root = await mkdtemp(path.join(tmpdir(), "cap-cluster-deploy-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const buildRoot = path.join(root, "build");
	const dependenciesRoot = path.join(root, "deps");
	const outputRoot = path.join(root, "out");
	async function write(directory, relative, value) {
		const file = path.join(directory, relative);
		await mkdir(path.dirname(file), { recursive: true });
		await writeFile(
			file,
			typeof value === "string" ? value : JSON.stringify(value),
		);
	}
	await write(buildRoot, "apps/web-cluster/package.json", {
		name: "@cap/web-cluster",
		type: "module",
		dependencies: { "@cap/runtime": "workspace:*" },
		devDependencies: { "@cap/dev-only": "workspace:*" },
	});
	await write(
		buildRoot,
		"apps/web-cluster/src/index.js",
		'export { value } from "@cap/runtime";',
	);
	await write(buildRoot, "packages/runtime/package.json", {
		name: "@cap/runtime",
		type: "module",
		exports: { ".": "./src/index.ts" },
		publishConfig: { exports: { ".": "./dist/index.js" } },
		dependencies: { external: "1.0.0" },
	});
	await write(
		buildRoot,
		"packages/runtime/dist/index.js",
		'export { value } from "external";',
	);
	await write(
		dependenciesRoot,
		"node_modules/.bun/external@1.0.0/node_modules/external/package.json",
		{ name: "external", version: "1.0.0", type: "module", main: "index.js" },
	);
	await write(
		dependenciesRoot,
		"node_modules/.bun/external@1.0.0/node_modules/external/index.js",
		"export const value = 42;",
	);
	await mkdir(
		path.join(dependenciesRoot, "apps/web-cluster/node_modules/@cap"),
		{ recursive: true },
	);
	await mkdir(path.join(dependenciesRoot, "packages/runtime/node_modules"), {
		recursive: true,
	});
	await symlink(
		"../../../../packages/runtime",
		path.join(dependenciesRoot, "apps/web-cluster/node_modules/@cap/runtime"),
	);
	await symlink(
		"../../../node_modules/.bun/external@1.0.0/node_modules/external",
		path.join(dependenciesRoot, "packages/runtime/node_modules/external"),
	);
	return { root, buildRoot, dependenciesRoot, outputRoot, write };
}

test("cluster dependencies load after relocation with compiled exports and no dev workspaces", async (t) => {
	const f = await fixture(t);
	assert.deepEqual(await deployCluster(f), [
		"apps/web-cluster",
		"packages/runtime",
	]);
	const relocated = path.join(f.root, "relocated");
	await rename(f.outputRoot, relocated);
	const module = await import(
		pathToFileURL(path.join(relocated, "apps/web-cluster/src/index.js"))
	);
	assert.equal(module.value, 42);
	assert.ok(
		(await realpath(path.join(relocated, "packages/runtime"))).includes(
			`${path.sep}node_modules${path.sep}`,
		),
	);
	const manifest = JSON.parse(
		await readFile(
			path.join(relocated, "apps/web-cluster/package.json"),
			"utf8",
		),
	);
	assert.equal(manifest.devDependencies, undefined);
	await assert.rejects(
		readFile(path.join(relocated, "packages/dev-only/package.json")),
		{ code: "ENOENT" },
	);
});

test("deployment rejects workspace exports that still require unpublished sources", async (t) => {
	const f = await fixture(t);
	await f.write(f.buildRoot, "packages/runtime/package.json", {
		name: "@cap/runtime",
		exports: { ".": "./src/index.ts" },
	});
	await assert.rejects(deployCluster(f), { code: "ENOENT" });
});

test("deployment rejects dependency links outside the output", async (t) => {
	const f = await fixture(t);
	await symlink(
		f.buildRoot,
		path.join(f.dependenciesRoot, "node_modules/outside"),
	);
	await assert.rejects(deployCluster(f), /Path escapes deployment/);
});

test("deployment never replaces an existing output directory", async (t) => {
	const f = await fixture(t);
	await mkdir(f.outputRoot);
	await writeFile(path.join(f.outputRoot, "keep"), "original");
	await assert.rejects(deployCluster(f), { code: "EEXIST" });
	assert.equal(
		await readFile(path.join(f.outputRoot, "keep"), "utf8"),
		"original",
	);
});

test("omitted optional package links do not break an otherwise complete deployment", async (t) => {
	const f = await fixture(t);
	const bins = path.join(
		f.dependenciesRoot,
		"node_modules/.bun/omitted/node_modules/.bin",
	);
	await mkdir(bins, { recursive: true });
	await symlink("../omitted/bin.js", path.join(bins, "omitted"));
	await deployCluster(f);
	await assert.rejects(
		readFile(
			path.join(
				f.outputRoot,
				"node_modules/.bun/omitted/node_modules/.bin/omitted",
			),
		),
		{ code: "ENOENT" },
	);
	const module = await import(
		pathToFileURL(path.join(f.outputRoot, "apps/web-cluster/src/index.js"))
	);
	assert.equal(module.value, 42);
});

test("hoisted workspace and external dependencies load after relocation", async (t) => {
	const f = await fixture(t);
	const modules = path.join(f.dependenciesRoot, "node_modules");
	await rm(path.join(f.dependenciesRoot, "apps/web-cluster/node_modules"), {
		recursive: true,
	});
	await rm(path.join(f.dependenciesRoot, "packages/runtime/node_modules"), {
		recursive: true,
	});
	await mkdir(path.join(modules, "@cap"));
	await symlink("../../packages/runtime", path.join(modules, "@cap/runtime"));
	await symlink(
		".bun/external@1.0.0/node_modules/external",
		path.join(modules, "external"),
	);
	await deployCluster(f);
	const relocated = path.join(f.root, "relocated");
	await rename(f.outputRoot, relocated);
	const module = await import(
		pathToFileURL(path.join(relocated, "apps/web-cluster/src/index.js"))
	);
	assert.equal(module.value, 42);
});
