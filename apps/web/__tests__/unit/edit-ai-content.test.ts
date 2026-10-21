import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getCurrentUser: vi.fn(),
	transaction: vi.fn(),
	revalidatePath: vi.fn(),
	entitled: vi.fn(),
	lockedRead: vi.fn(),
	write: vi.fn(),
}));
vi.mock("@cap/database", () => ({
	db: () => ({ transaction: mocks.transaction }),
}));
vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: mocks.getCurrentUser,
}));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/lib/ai-generation-entitlement", () => ({
	isAiGenerationEnabledForUser: mocks.entitled,
}));

import type { Video } from "@cap/web-domain";
import { sql } from "drizzle-orm";
import { editAiContent } from "@/actions/videos/edit-ai-content";
import { setGeneratedAiContent } from "@/lib/ai-content-metadata";

const videoId = "video-id" as Video.VideoId;
const expected = {
	summary: "Original",
	chapters: [{ title: "Intro", start: 0 }],
};
let readSql: string;
let writeSql: string;
let writeParams: unknown[];
let metadata: Record<string, unknown>;

beforeEach(() => {
	metadata = {
		...expected,
		aiGenerationStatus: "COMPLETE",
		customCreatedAt: "2026-01-01",
	};
	mocks.getCurrentUser.mockResolvedValue({ id: "owner" });
	mocks.entitled.mockReturnValue(true);
	mocks.lockedRead.mockImplementation(async () => [
		{ metadata, duration: 120 },
	]);
	mocks.write.mockResolvedValue({ rowCount: 1 });
	const dialect = new PgDialect();
	const tx = {
		select: () => ({
			from: () => ({
				where: (condition: Parameters<PgDialect["sqlToQuery"]>[0]) => {
					readSql = JSON.stringify(dialect.sqlToQuery(condition));
					return { for: mocks.lockedRead };
				},
			}),
		}),
		update: () => ({
			set: (values: { metadata: Parameters<PgDialect["sqlToQuery"]>[0] }) => {
				const query = dialect.sqlToQuery(values.metadata);
				writeSql = query.sql;
				writeParams = query.params;
				return { where: mocks.write };
			},
		}),
	};
	mocks.transaction.mockImplementation((callback) => callback(tx));
});

describe("editing AI content", () => {
	it("does not treat existing surrounding whitespace as a manual edit", async () => {
		const original = {
			summary: " Original ",
			chapters: [{ title: " Intro ", start: 0 }],
		};
		metadata = { ...original, aiGenerationStatus: "COMPLETE" };
		expect(
			await editAiContent(videoId, { expected: original, value: original }),
		).toEqual({ success: true, data: original });
		expect(mocks.write).not.toHaveBeenCalled();
		await editAiContent(videoId, {
			expected: original,
			value: { ...original, summary: "Changed" },
		});
		expect(writeSql).not.toContain("chaptersManuallyEdited");
	});
	it("compares chapters independently of MySQL JSON key ordering", async () => {
		metadata.chapters = [{ start: 0, title: "Intro" }];
		expect(
			(
				await editAiContent(videoId, {
					expected,
					value: { ...expected, chapters: [{ title: "Renamed", start: 0 }] },
				})
			).success,
		).toBe(true);
	});
	it("blocks edits during transcription after a media change", async () => {
		mocks.lockedRead.mockResolvedValueOnce([
			{ metadata, duration: 120, transcriptionStatus: "PROCESSING" },
		]);
		expect(
			(
				await editAiContent(videoId, {
					expected,
					value: { ...expected, summary: "Edited" },
				})
			).success,
		).toBe(false);
		expect(mocks.write).not.toHaveBeenCalled();
	});
	it("requires authentication and Pro entitlement", async () => {
		mocks.getCurrentUser.mockResolvedValueOnce(null);
		expect((await editAiContent(videoId, {})).success).toBe(false);
		mocks.entitled.mockReturnValueOnce(false);
		expect((await editAiContent(videoId, {})).success).toBe(false);
		expect(mocks.transaction).not.toHaveBeenCalled();
	});
	it("scopes the locked row to its owner", async () => {
		mocks.lockedRead.mockResolvedValueOnce([]);
		expect(
			(
				await editAiContent(videoId, {
					expected,
					value: { ...expected, summary: "Edited" },
				})
			).success,
		).toBe(false);
		expect(readSql).toContain("ownerId");
		expect(readSql).toContain("owner");
		expect(mocks.lockedRead).toHaveBeenCalledWith("update");
		expect(mocks.write).not.toHaveBeenCalled();
	});
	it("updates only the summary while retaining concurrently updated chapters", async () => {
		metadata.chapters = [{ title: "Updated elsewhere", start: 10 }];
		const result = await editAiContent(videoId, {
			expected,
			value: { ...expected, summary: "  **Edited**  " },
		});
		expect(result).toEqual({
			success: true,
			data: { summary: "**Edited**", chapters: metadata.chapters },
		});
		expect(writeParams).toContain(
			JSON.stringify({ summary: "**Edited**", summaryManuallyEdited: true }),
		);
		expect(JSON.stringify(writeParams)).not.toContain("chaptersManuallyEdited");
		expect(mocks.revalidatePath).toHaveBeenCalledWith("/s/video-id");
	});
	it("updates chapters as JSON and preserves a concurrent summary edit", async () => {
		metadata.summary = "Updated elsewhere";
		const result = await editAiContent(videoId, {
			expected,
			value: { ...expected, chapters: [{ title: "  Changed  ", start: 20 }] },
		});
		expect(result).toEqual({
			success: true,
			data: {
				summary: "Updated elsewhere",
				chapters: [{ title: "Changed", start: 20 }],
			},
		});
		expect(writeParams).toContain(
			JSON.stringify({
				chapters: [{ title: "Changed", start: 20 }],
				chaptersManuallyEdited: true,
			}),
		);
		expect(JSON.stringify(writeParams)).not.toContain("summaryManuallyEdited");
	});
	it("rejects stale edits without writing", async () => {
		metadata.summary = "Newer saved summary";
		const result = await editAiContent(videoId, {
			expected,
			value: { ...expected, summary: "Stale edit" },
		});
		expect(result).toMatchObject({
			success: false,
			message: expect.stringContaining("changed since"),
		});
		expect(mocks.write).not.toHaveBeenCalled();
	});
	it.each(["QUEUED", "PROCESSING"])(
		"rejects edits while %s",
		async (status) => {
			metadata.aiGenerationStatus = status;
			expect(
				(
					await editAiContent(videoId, {
						expected,
						value: { ...expected, summary: "Edited" },
					})
				).success,
			).toBe(false);
			expect(mocks.write).not.toHaveBeenCalled();
		},
	);
	it.each([
		{ summary: 123, chapters: [] },
		{ summary: "x", chapters: [{ title: "Bad", start: Number.NaN }] },
		{ summary: "x", chapters: [{ title: "Bad", start: 120 }] },
		{ summary: "x", chapters: [{ title: "", start: 0 }] },
		{
			summary: "x",
			chapters: [
				{ title: "A", start: 10 },
				{ title: "B", start: 10 },
			],
		},
	])("rejects malformed or invalid content", async (value) => {
		expect((await editAiContent(videoId, { expected, value })).success).toBe(
			false,
		);
		expect(mocks.write).not.toHaveBeenCalled();
	});
	it("allows deliberate removal and avoids writing unchanged data", async () => {
		expect(
			(await editAiContent(videoId, { expected, value: expected })).success,
		).toBe(true);
		expect(mocks.write).not.toHaveBeenCalled();
		expect(
			await editAiContent(videoId, {
				expected,
				value: { summary: "", chapters: [] },
			}),
		).toEqual({ success: true, data: { summary: "", chapters: [] } });
		expect(JSON.stringify(writeParams)).toContain("summaryManuallyEdited");
		expect(JSON.stringify(writeParams)).toContain("chaptersManuallyEdited");
	});
	it("reports storage failures without pretending the draft was saved", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		mocks.write.mockRejectedValueOnce(new Error("database unavailable"));
		expect(
			(
				await editAiContent(videoId, {
					expected,
					value: { ...expected, summary: "Edited" },
				})
			).success,
		).toBe(false);
		expect(mocks.revalidatePath).not.toHaveBeenCalled();
	});
});

describe("generation preserves manual content", () => {
	it.each(["summary", "chapters"] as const)(
		"guards %s using the current row and permits regeneration after content removal",
		(field) => {
			const query = new PgDialect().sqlToQuery(
				setGeneratedAiContent(
					sql`'{}'::jsonb`,
					field,
					field === "summary" ? "Generated" : [],
				),
			);
			expect(query.sql).toContain("CASE");
			expect(query.sql).toContain("IS NOT NULL");
			expect(query.params).toContain(`{${field}ManuallyEdited}`);
			expect(query.params).toContain(`{${field}}`);
			expect(query.params).toContain("false");
		},
	);
});
