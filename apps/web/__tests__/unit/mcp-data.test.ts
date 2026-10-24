import { User } from "@cap/web-domain";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const databaseState = vi.hoisted(() => ({
	results: [] as unknown[][],
	selectCount: 0,
}));
const runPromise = vi.hoisted(() => vi.fn());
vi.mock("@cap/database", () => ({
	db: () => ({
		select: () => {
			const rows = databaseState.results[databaseState.selectCount++] ?? [];
			const whereResult = Object.assign(Promise.resolve(rows), {
				limit: async () => rows,
				orderBy: () => ({ limit: async () => rows }),
			});
			const chain = {
				from: () => chain,
				innerJoin: () => chain,
				where: () => whereResult,
			};
			return chain;
		},
	}),
}));
vi.mock("@/lib/server", () => ({ runPromise }));
vi.mock("@/lib/mcp-auth", () => ({ mcpIssuer: () => "https://cap.so" }));

import { getMcpCapContext, listMcpCaps } from "@/lib/mcp-data";

const ownedRow = {
	id: "video-1",
	ownerId: "owner",
	name: "Demo recording",
	duration: 120,
	createdAt: new Date("2026-09-20T10:00:00.000Z"),
	updatedAt: new Date("2026-09-21T10:00:00.000Z"),
	metadata: { summary: "Private notes" },
	videoSettings: null,
	organizationSettings: null,
	transcriptionStatus: "COMPLETE",
};

describe("hosted MCP data limits", () => {
	beforeEach(() => {
		databaseState.results = [];
		databaseState.selectCount = 0;
		runPromise.mockReset();
	});

	it("returns no context when the owner-scoped lookup finds no Cap", async () => {
		databaseState.results = [[]];
		expect(
			await getMcpCapContext(User.UserId.make("other"), "video-1"),
		).toBeNull();
		expect(databaseState.selectCount).toBe(1);
		expect(runPromise).not.toHaveBeenCalled();
	});

	it("honors disabled summary and transcript settings before accessing storage", async () => {
		databaseState.results = [
			[
				{
					...ownedRow,
					videoSettings: { disableSummary: true, disableTranscript: true },
				},
			],
			[],
		];
		const context = await getMcpCapContext(
			User.UserId.make("owner"),
			"video-1",
		);
		expect(context).toMatchObject({
			summary: null,
			transcriptStatus: "disabled",
			cues: [],
		});
		expect(runPromise).not.toHaveBeenCalled();
	});

	it("returns bounded timestamp links for a selected transcript", async () => {
		databaseState.results = [[ownedRow], []];
		runPromise.mockResolvedValue(
			"WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello Cap\n\n00:00:03.000 --> 00:00:04.000\nAnother moment\n",
		);
		const context = await getMcpCapContext(
			User.UserId.make("owner"),
			"video-1",
			"hello",
		);
		expect(context).toMatchObject({
			summary: "Private notes",
			transcriptStatus: "available",
			cues: [{ text: "Hello Cap", url: "https://cap.so/s/video-1?t=1" }],
			hasMoreCues: false,
		});
	});

	it("limits a list page to 20 recordings", async () => {
		databaseState.results = [
			Array.from({ length: 21 }, (_, index) => ({
				...ownedRow,
				id: `video-${index + 1}`,
			})),
		];
		const page = await listMcpCaps(User.UserId.make("owner"), {});
		expect(page.caps).toHaveLength(20);
		expect(page.nextCursor).toEqual(expect.any(String));
	});
});
