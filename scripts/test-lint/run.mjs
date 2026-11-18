import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const oxlint = path.join(here, "node_modules/oxlint/bin/oxlint");

if (!existsSync(oxlint)) {
	console.error(
		"Test lint tools are missing. Run: bun install --frozen-lockfile --cwd scripts/test-lint",
	);
	process.exit(1);
}

const listed = spawnSync(
	"git",
	[
		"ls-files",
		"-z",
		"--cached",
		"--others",
		"--exclude-standard",
		"--",
		"*.test.*",
		"*.spec.*",
	],
	{ cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
);

if (listed.status !== 0) {
	process.stderr.write(listed.stderr);
	process.exit(1);
}

const files = [
	...new Set(
		listed.stdout
			.split("\0")
			.filter((file) => /^(apps|packages|scripts)\//.test(file))
			.filter((file) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(file))
			.filter((file) => existsSync(path.join(root, file))),
	),
];

const result = spawnSync(
	process.execPath,
	[oxlint, "-c", path.join(here, "oxlintrc.json"), ...files],
	{ cwd: root, stdio: "inherit" },
);

process.exit(result.status ?? 1);
