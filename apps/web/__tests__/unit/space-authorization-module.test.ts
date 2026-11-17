import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const modulePath = join(
	process.cwd(),
	"actions/organization/space-authorization.ts",
);

function moduleDirectives(source: string) {
	const file = ts.createSourceFile("module.ts", source, ts.ScriptTarget.Latest);
	const directives: string[] = [];
	for (const statement of file.statements) {
		if (
			!ts.isExpressionStatement(statement) ||
			!ts.isStringLiteral(statement.expression)
		)
			break;
		directives.push(statement.expression.text);
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
