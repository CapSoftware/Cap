import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const LIB = join(import.meta.dirname, "..", "..", "lib");

// Every file the processing state reaches through relative imports.
function reachable(entry: string): string[] {
	const seen = new Set<string>();
	const visit = (path: string) => {
		if (seen.has(path)) return;
		seen.add(path);
		const source = readFileSync(path, "utf8");
		for (const match of source.matchAll(
			/^(?:import|export)\s[^;]*?from\s+"(\.[^"]+)";/gms,
		)) {
			if (/^(?:import|export)\s+type\s/.test(match[0])) continue;
			const target = join(dirname(path), `${match[1]}.ts`);
			if (existsSync(target)) visit(target);
		}
	};
	visit(entry);
	return [...seen];
}

describe("the processing state the workflow bundles", () => {
	// The workflow function imports the state module, and the workflow bundle
	// refuses anything that needs a Node module: the whole app stops building.
	it("reaches no file that imports a Node module", () => {
		const files = reachable(join(LIB, "developer-video-state.ts"));

		expect(files.map((file) => file.slice(LIB.length + 1)).sort()).toEqual([
			"developer-video-sliced-playlist.ts",
			"developer-video-slices.ts",
			"developer-video-state.ts",
		]);
		for (const file of files) {
			expect(readFileSync(file, "utf8")).not.toMatch(
				/from\s+"(node:[^"]+|crypto|fs|path|zod)"/,
			);
		}
	});
});
