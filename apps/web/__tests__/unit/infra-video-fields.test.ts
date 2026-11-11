import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
	join(process.cwd(), "app/(infra)/dashboard/infra/infra-data.ts"),
	"utf8",
);
const start = source.indexOf("export async function getDeveloperAppVideos");
const body = source.slice(start, source.indexOf("\n}\n", start));
const selectStart = body.indexOf(".select(");
const selection = body.slice(selectStart, body.indexOf(".from(", selectStart));
const selected = [...selection.matchAll(/(\w+):\s*developerVideos\.(\w+)/g)];

const SHOWN = [
	"createdAt",
	"duration",
	"externalUserId",
	"height",
	"id",
	"name",
	"width",
];

describe("console video query", () => {
	it("names the columns it sends to the browser", () => {
		expect(start).toBeGreaterThan(-1);
		expect(selectStart).toBeGreaterThan(-1);
		expect(selection).not.toMatch(/\.select\(\s*\)/);
	});

	it("sends exactly the fields the pages show and nothing else", () => {
		expect(selected.map((match) => match[1]).sort()).toEqual(SHOWN);
		expect(selected.map((match) => match[2]).sort()).toEqual(SHOWN);
		expect(selection.match(/developerVideos\./g)).toHaveLength(SHOWN.length);
		expect(selection).not.toContain("...");
	});
});
