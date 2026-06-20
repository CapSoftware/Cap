import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const srcDir = join(dirname(fileURLToPath(import.meta.url)), "../src");

const sourceFiles = readdirSync(srcDir)
	.filter((name) => name.endsWith(".ts"))
	.map((name) => ({ name, content: readFileSync(join(srcDir, name), "utf8") }));

// The extension bundles recorder-core, and a value import of @cap/web-domain
// would drag the effect runtime into every extension bundle (and break the
// devDependencies-only declaration in package.json). Comments in
// apps/web web-recorder-constants.ts and the extension's shared/api.ts rely
// on this invariant; this test is what actually enforces it.
describe("package boundaries", () => {
	it("only imports @cap/web-domain as types", () => {
		for (const { name, content } of sourceFiles) {
			const imports = content.match(
				/^import\s[^;]*from\s+["']@cap\/web-domain[^"']*["']/gms,
			);
			for (const statement of imports ?? []) {
				expect
					.soft(
						statement.startsWith("import type"),
						`${name} must import @cap/web-domain with \`import type\`, found: ${statement}`,
					)
					.toBe(true);
			}
		}
	});

	it("has no runtime dependencies", () => {
		const packageJson = JSON.parse(
			readFileSync(join(srcDir, "../package.json"), "utf8"),
		) as { dependencies?: Record<string, string> };
		expect(packageJson.dependencies ?? {}).toEqual({});
	});
});
