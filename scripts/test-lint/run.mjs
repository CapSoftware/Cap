import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const oxlint = path.join(here, "node_modules/oxlint/bin/oxlint");
const doublesRule = "landmines-testing(no-test-doubles)";
const doublesAllowPath = "scripts/test-lint/test-doubles-allow.json";

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

const linted = spawnSync(
	process.execPath,
	[oxlint, "-c", path.join(here, "oxlintrc.json"), "--format=json", ...files],
	{ cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
);

let report;
try {
	report = JSON.parse(linted.stdout);
} catch {
	process.stderr.write(linted.stdout);
	process.stderr.write(linted.stderr);
	process.exit(linted.status || 1);
}

const doublesAllow = JSON.parse(
	readFileSync(path.join(root, doublesAllowPath), "utf8"),
);
const problems = [];
const doublesByFile = new Map();

for (const diagnostic of report.diagnostics) {
	if (diagnostic.code === doublesRule) {
		const list = doublesByFile.get(diagnostic.filename) ?? [];
		list.push(diagnostic);
		doublesByFile.set(diagnostic.filename, list);
	} else {
		problems.push(diagnostic);
	}
}

for (const [file, diagnostics] of doublesByFile) {
	const allowed = doublesAllow[file] ?? 0;
	if (diagnostics.length > allowed) {
		problems.push(...diagnostics);
	} else if (diagnostics.length < allowed) {
		problems.push(staleDoubles(file, diagnostics.length));
	}
}

for (const file of Object.keys(doublesAllow)) {
	if (!doublesByFile.has(file)) problems.push(staleDoubles(file, 0));
}

for (const problem of problems) {
	const span = problem.labels?.[0]?.span;
	const location = span ? `${span.line}:${span.column}` : "1:1";
	console.log(
		`${problem.filename}:${location}: ${problem.code}: ${problem.message}`,
	);
}

if (problems.length > 0) {
	console.log(`\n${problems.length} test lint problems`);
	process.exit(1);
}

console.log(`Test lint passed for ${report.number_of_files} files`);

function staleDoubles(file, count) {
	return {
		filename: file,
		code: doublesRule,
		message:
			count === 0
				? `This file has no test doubles left; remove its entry from ${doublesAllowPath}.`
				: `This file now has ${count} test doubles; lower its entry in ${doublesAllowPath} to ${count}.`,
	};
}
