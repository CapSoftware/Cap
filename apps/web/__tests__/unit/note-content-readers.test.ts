import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const repo = join(__dirname, "../../../..");
const roots = ["apps/web", "packages"];
const skipped = new Set([
	"node_modules",
	".next",
	".turbo",
	"dist",
	"__tests__",
	"migrations",
]);

const sources = (directory: string): string[] =>
	readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		if (skipped.has(entry.name)) return [];
		const path = join(directory, entry.name);
		if (entry.isDirectory()) return sources(path);
		return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)
			? [path]
			: [];
	});

const readers = roots
	.flatMap((root) => sources(join(repo, root)))
	.filter((path) =>
		/\bvideoNotes\b|\bvideo_notes\b/.test(readFileSync(path, "utf8")),
	)
	.map((path) => relative(repo, path))
	.sort();

const readsText = (path: string) =>
	/videoNotes\.(summaryMarkdown|notesMarkdown|transcript|participants|excerpt)\b/.test(
		readFileSync(join(repo, path), "utf8"),
	);

describe("who reads shared note content", () => {
	it("is only the share page, signed-in library lists and the note's own lifecycle", () => {
		expect(readers).toEqual([
			"apps/web/actions/spaces/get-user-videos.ts",
			"apps/web/app/(org)/dashboard/caps/caps-page-data.tsx",
			"apps/web/app/(org)/dashboard/spaces/[spaceId]/page.tsx",
			"apps/web/app/s/[videoId]/page.tsx",
			"apps/web/lib/folder.ts",
			"apps/web/lib/meetings/share.ts",
			"apps/web/workflows/agent-cap-operation.ts",
			"apps/web/workflows/transfer-organization-content.ts",
			"packages/database/schema.ts",
			"packages/web-backend/src/Organisations/index.ts",
			"packages/web-backend/src/Videos/VideosRepo.ts",
		]);
	});

	it("returns the full note from the share page alone", () => {
		expect(
			readers.filter((path) =>
				/videoNotes\.(summaryMarkdown|notesMarkdown|transcript|participants)\b/.test(
					readFileSync(join(repo, path), "utf8"),
				),
			),
		).toEqual(["apps/web/app/s/[videoId]/page.tsx"]);
	});

	it("lists an excerpt only on signed-in library pages", () => {
		expect(readers.filter(readsText)).toEqual([
			"apps/web/actions/spaces/get-user-videos.ts",
			"apps/web/app/(org)/dashboard/caps/caps-page-data.tsx",
			"apps/web/app/(org)/dashboard/spaces/[spaceId]/page.tsx",
			"apps/web/app/s/[videoId]/page.tsx",
			"apps/web/lib/folder.ts",
		]);
	});
});
