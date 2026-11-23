import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// users.preferences defaults to the JSON literal null, which COALESCE keeps,
// so a JSON_SET merge built on COALESCE silently writes nothing. Writers must
// use userPreferencesObject() from lib/user-preferences-sql.ts.

const webRoot = join(__dirname, "..", "..");
const skip = new Set(["node_modules", ".next", "__tests__", ".well-known"]);

const sourceFiles = (dir: string): string[] =>
	readdirSync(dir).flatMap((name) => {
		if (skip.has(name)) return [];
		const path = join(dir, name);
		if (statSync(path).isDirectory()) return sourceFiles(path);
		return /\.(ts|tsx)$/.test(name) ? [path] : [];
	});

describe("users.preferences writers", () => {
	it("never merge into COALESCE(preferences, ...)", () => {
		const offenders = ["actions", "app", "lib", "utils", "workflows"]
			.flatMap((dir) => {
				try {
					return sourceFiles(join(webRoot, dir));
				} catch {
					return [];
				}
			})
			.filter((path) =>
				/COALESCE\(\s*\$\{[\w.]*users\.preferences\}/.test(
					readFileSync(path, "utf8"),
				),
			)
			.map((path) => relative(webRoot, path));
		expect(offenders).toEqual([]);
	});
});
