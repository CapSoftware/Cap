import { readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workflowEntries = [
	"workflows/process-video.ts",
	"workflows/finalize-desktop-recording.ts",
	"workflows/transcribe.ts",
	"workflows/generate-ai.ts",
	"workflows/edit-video.ts",
	"workflows/admin-reprocess-video.ts",
	"workflows/import-loom-video.ts",
	"workflows/agent-cap-operation.ts",
];

const forbiddenModules = new Set([
	"@cap/utils",
	"@cap/web-backend",
	"@/lib/server",
]);

const importPattern = /(?:from\s+|import\s*)["']([^"']+)["']/g;

async function resolveSourceFile(path: string) {
	for (const candidate of [
		path,
		`${path}.ts`,
		`${path}.tsx`,
		join(path, "index.ts"),
	]) {
		try {
			await readFile(candidate, "utf8");
			return candidate;
		} catch {}
	}

	return null;
}

async function resolveImport(from: string, specifier: string) {
	if (specifier.startsWith("@/")) {
		return resolveSourceFile(join(process.cwd(), specifier.slice(2)));
	}

	if (specifier.startsWith("@cap/web-backend/src/")) {
		return resolveSourceFile(
			join(
				process.cwd(),
				"../../packages/web-backend/src",
				specifier.slice("@cap/web-backend/src/".length),
			),
		);
	}

	if (specifier.startsWith(".")) {
		return resolveSourceFile(resolve(dirname(from), specifier));
	}

	return null;
}

async function findForbiddenImports(entry: string) {
	const pending = [join(process.cwd(), entry)];
	const visited = new Set<string>();
	const violations: string[] = [];

	while (pending.length > 0) {
		const file = pending.pop();
		if (!file || visited.has(file)) continue;
		visited.add(file);

		const source = await readFile(file, "utf8");
		for (const match of source.matchAll(importPattern)) {
			const specifier = match[1];
			if (!specifier) continue;

			if (forbiddenModules.has(specifier)) {
				violations.push(`${relative(process.cwd(), file)} -> ${specifier}`);
				continue;
			}

			const dependency = await resolveImport(file, specifier);
			if (dependency) pending.push(dependency);
		}
	}

	return violations;
}

describe("customer video workflow runtime boundary", () => {
	it.each(workflowEntries)(
		"keeps %s out of the full web runtime",
		async (entry) => {
			expect(await findForbiddenImports(entry)).toEqual([]);
		},
	);
});
