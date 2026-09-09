import assert from "node:assert/strict";
import {
	cp,
	lstat,
	mkdir,
	readdir,
	readFile,
	realpath,
	symlink,
	writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

function inside(root, file) {
	const relative = path.relative(root, file);
	assert.ok(
		relative !== ".." &&
			!relative.startsWith(`..${path.sep}`) &&
			!path.isAbsolute(relative),
		`Path escapes deployment: ${file}`,
	);
	return relative;
}

async function validateLinks(root, directory = root) {
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const file = path.join(directory, entry.name);
		if (entry.isSymbolicLink()) inside(root, await realpath(file));
		else if (entry.isDirectory()) await validateLinks(root, file);
	}
}

function exportTargets(value) {
	if (typeof value === "string") return [value];
	if (!value || typeof value !== "object") return [];
	return Object.values(value).flatMap(exportTargets);
}

export async function deployCluster({
	buildRoot,
	dependenciesRoot,
	outputRoot,
}) {
	buildRoot = await realpath(buildRoot);
	dependenciesRoot = await realpath(dependenciesRoot);
	outputRoot = path.join(
		await realpath(path.dirname(path.resolve(outputRoot))),
		path.basename(outputRoot),
	);
	const application = "apps/web-cluster";
	const workspaces = new Map();
	async function visit(directory) {
		if (workspaces.has(directory)) return;
		inside(buildRoot, path.resolve(buildRoot, directory));
		const manifest = JSON.parse(
			await readFile(path.join(buildRoot, directory, "package.json"), "utf8"),
		);
		workspaces.set(directory, manifest);
		for (const [name, range] of Object.entries({
			...manifest.dependencies,
			...manifest.optionalDependencies,
		})) {
			if (!range.startsWith("workspace:")) continue;
			const installed = await realpath(
				path.join(dependenciesRoot, directory, "node_modules", name),
			);
			await visit(inside(dependenciesRoot, installed));
		}
	}
	await visit(application);
	await mkdir(outputRoot);
	const copy = async (source, destination) => {
		await mkdir(path.dirname(destination), { recursive: true });
		await cp(source, destination, {
			recursive: true,
			dereference: false,
			verbatimSymlinks: true,
			errorOnExist: true,
			force: false,
			filter: async (file) => {
				if (!(await lstat(file)).isSymbolicLink()) return true;
				try {
					await realpath(file);
					return true;
				} catch (error) {
					// Filtered Bun installs leave links for omitted packages and bins.
					if (error.code === "ENOENT") return false;
					throw error;
				}
			},
		});
	};
	await copy(
		path.join(dependenciesRoot, "node_modules"),
		path.join(outputRoot, "node_modules"),
	);
	// Deno applies Node resolution to dependencies physically inside node_modules.
	const workspaceRoot = path.join(outputRoot, "node_modules/.cap-workspaces");
	await mkdir(workspaceRoot);
	await symlink("..", path.join(workspaceRoot, "node_modules"), "dir");
	for (const [directory, manifest] of workspaces) {
		const destination = path.join(
			directory === application ? outputRoot : workspaceRoot,
			directory,
		);
		if (directory !== application) {
			const link = path.join(outputRoot, directory);
			await mkdir(path.dirname(link), { recursive: true });
			await symlink(
				path.relative(path.dirname(link), destination),
				link,
				"dir",
			);
		}
		await mkdir(destination, { recursive: true });
		const content = directory === application ? "src" : "dist";
		await copy(
			path.join(buildRoot, directory, content),
			path.join(destination, content),
		);
		await copy(
			path.join(dependenciesRoot, directory, "node_modules"),
			path.join(destination, "node_modules"),
		);
		const published = { ...manifest, ...manifest.publishConfig };
		delete published.devDependencies;
		delete published.publishConfig;
		delete published.scripts;
		delete published.types;
		delete published.typings;
		for (const target of exportTargets(published.exports ?? published.main)) {
			const entrypoint = path.resolve(destination, target);
			inside(destination, entrypoint);
			assert.ok(
				(await lstat(entrypoint)).isFile(),
				`Missing published entrypoint: ${entrypoint}`,
			);
		}
		await writeFile(
			path.join(destination, "package.json"),
			`${JSON.stringify(published, null, "\t")}\n`,
		);
	}
	await validateLinks(outputRoot);
	return [...workspaces.keys()].sort();
}

if (
	process.argv[1] &&
	path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	const { values } = parseArgs({
		options: {
			"build-root": { type: "string" },
			"dependencies-root": { type: "string" },
			out: { type: "string" },
		},
	});
	assert.ok(
		values["build-root"] && values["dependencies-root"] && values.out,
		"Pass --build-root, --dependencies-root and --out",
	);
	const workspaces = await deployCluster({
		buildRoot: values["build-root"],
		dependenciesRoot: values["dependencies-root"],
		outputRoot: values.out,
	});
	console.log(
		`Packaged ${workspaces.length} runtime workspaces: ${workspaces.join(", ")}`,
	);
}
