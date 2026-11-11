import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
	join(process.cwd(), "app/(infra)/dashboard/infra/infra-data.ts"),
	"utf8",
);
const start = source.indexOf("export async function getDeveloperAppVideos");
const body = source.slice(start, source.indexOf("\n}\n", start));

describe("console video query", () => {
	it("names the columns it sends to the browser", () => {
		expect(start).toBeGreaterThan(-1);
		expect(body).not.toMatch(/\.select\(\s*\)/);
		for (const column of [
			"id",
			"name",
			"externalUserId",
			"duration",
			"width",
			"height",
			"createdAt",
		]) {
			expect(body).toContain(`${column}: developerVideos.${column}`);
		}
	});

	it("leaves storage keys and internal state on the server", () => {
		for (const column of ["s3Key", "metadata", "processing", "renditions"]) {
			expect(body).not.toContain(`developerVideos.${column}`);
		}
	});
});
