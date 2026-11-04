import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const modulePath = join(
	process.cwd(),
	"actions/organization/space-authorization.ts",
);

function moduleDirectives(source: string) {
	const directives: string[] = [];
	const prologue = /^(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*(["'])([^"'\n]+)\1;?/;
	let rest = source;
	for (let match = prologue.exec(rest); match; match = prologue.exec(rest)) {
		directives.push(match[2] as string);
		rest = rest.slice(match[0].length);
	}
	return directives;
}

describe("space authorization module", () => {
	it("reads directives from a module prologue", () => {
		expect(moduleDirectives('// note\n"use server";\n\nimport x;')).toEqual([
			"use server",
		]);
		expect(moduleDirectives('import x;\n"use server";')).toEqual([]);
	});

	it("is a server-only helper module rather than a client-callable action module", () => {
		expect(moduleDirectives(readFileSync(modulePath, "utf8"))).not.toContain(
			"use server",
		);
	});
});
