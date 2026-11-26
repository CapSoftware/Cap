import type { Video } from "@cap/web-domain";
import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { editDate } from "@/actions/videos/edit-date";
import { renameTranscriptSpeaker } from "@/actions/videos/rename-transcript-speaker";

const state = vi.hoisted(() => ({
	metadata: {} as Record<string, unknown> | null,
	beforeUpdate: undefined as (() => Promise<void>) | undefined,
	user: { id: "owner" },
	writes: [] as string[],
}));
vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: async () => state.user,
}));
vi.mock("@cap/database/auth/request-site", () => ({
	isCrossSiteCookieWrite: () => false,
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@cap/database/schema", async () => {
	const { mysqlTable, varchar, json } = await import("drizzle-orm/mysql-core");
	return {
		videos: mysqlTable("videos", {
			id: varchar("id", { length: 32 }),
			ownerId: varchar("ownerId", { length: 32 }),
			metadata: json("metadata"),
		}),
	};
});
vi.mock("@cap/database", async () => {
	const { SQL } = await import("drizzle-orm");
	const { MySqlDialect } = await import("drizzle-orm/mysql-core");
	const database = {
		select: () => ({
			from: () => ({
				where: () => {
					const snapshot = [
						{
							id: "recording",
							ownerId: "owner",
							updatedAt: new Date("2025-01-01"),
							metadata: structuredClone(state.metadata),
						},
					];
					return Object.assign(Promise.resolve(snapshot), {
						for: async () => snapshot,
					});
				},
			}),
		}),
		update: () => ({
			set: (payload: { metadata: unknown }) => ({
				where: async () => {
					const interleave = state.beforeUpdate;
					state.beforeUpdate = undefined;
					await interleave?.();
					if (!(payload.metadata instanceof SQL)) {
						state.writes.push("whole-object replacement");
						state.metadata = structuredClone(payload.metadata) as Record<
							string,
							unknown
						>;
						return;
					}
					const query = new MySqlDialect().sqlToQuery(payload.metadata);
					state.writes.push(query.sql);
					const path = query.sql.match(
						/'\$\.(customCreatedAt|transcriptSpeakerNames)'/,
					);
					if (!path?.[1])
						throw new Error(`Unsupported simulated SQL: ${query.sql}`);
					const value = query.params[0];
					state.metadata = {
						...state.metadata,
						[path[1]]: query.sql.includes(" AS JSON)")
							? JSON.parse(String(value))
							: value,
					};
				},
			}),
		}),
		transaction: async (
			run: (tx: unknown) => Promise<unknown>,
		): Promise<unknown> => run(database),
	};
	return { db: () => database };
});
const id = "recording" as Video.VideoId;
const date = "2025-02-03T04:05:06.000Z";
beforeEach(() => {
	state.metadata = {
		customCreatedAt: "2024-01-01T00:00:00.000Z",
		transcriptSpeakerNames: { B: "Bob" },
		summary: "Keep this summary",
		nested: { enabled: true },
	};
	state.beforeUpdate = undefined;
	state.user = { id: "owner" };
	state.writes = [];
});
describe("metadata action interleaving (mocked DB, not live MySQL)", () => {
	it("preserves a successful rename committed between editDate's read and write", async () => {
		state.beforeUpdate = async () => {
			expect((await renameTranscriptSpeaker(id, "A", "Alice")).success).toBe(
				true,
			);
		};
		expect(await editDate(id, date)).toEqual({ success: true });
		expect(state.metadata).toEqual({
			customCreatedAt: date,
			transcriptSpeakerNames: { A: "Alice", B: "Bob" },
			summary: "Keep this summary",
			nested: { enabled: true },
		});
		expect(state.writes).toHaveLength(2);
		expect(state.writes.every((query) => query.startsWith("JSON_SET("))).toBe(
			true,
		);
	});
	it("preserves a custom date when a later rename and reset commit", async () => {
		await editDate(id, date);
		await renameTranscriptSpeaker(id, "A", "Alice");
		await renameTranscriptSpeaker(id, "B", "");
		expect(state.metadata).toMatchObject({
			customCreatedAt: date,
			transcriptSpeakerNames: { A: "Alice" },
			summary: "Keep this summary",
			nested: { enabled: true },
		});
	});
	it("initializes null metadata without replacing a rename committed meanwhile", async () => {
		state.metadata = null;
		state.beforeUpdate = async () => {
			expect((await renameTranscriptSpeaker(id, "A", "Alice")).success).toBe(
				true,
			);
		};
		await editDate(id, date);
		expect(state.metadata).toEqual({
			customCreatedAt: date,
			transcriptSpeakerNames: { A: "Alice" },
		});
	});
	it("rejects a non-owner before any mutation", async () => {
		state.user = { id: "viewer" };
		await expect(editDate(id, date)).rejects.toThrow("permission");
		expect(state.writes).toEqual([]);
	});
	it("preserves server fields and omitted metadata when an older client payload arrives after a rename", async () => {
		const { PUT } = await import("@/app/api/video/metadata/route");
		await editDate(id, date);
		await renameTranscriptSpeaker(id, "A", "Alice");
		const request = new Request("http://localhost/api/video/metadata", {
			method: "PUT",
			body: JSON.stringify({
				videoId: id,
				metadata: {
					sourceName: "updated.mp4",
					transcriptSpeakerNames: { B: "Stale Bob" },
					customCreatedAt: "2020-01-01T00:00:00.000Z",
					agentUpload: { state: "forged" },
				},
			}),
		});
		expect((await PUT(request as NextRequest)).status).toBe(200);
		expect(state.metadata).toEqual({
			customCreatedAt: date,
			transcriptSpeakerNames: { A: "Alice", B: "Bob" },
			summary: "Keep this summary",
			nested: { enabled: true },
			sourceName: "updated.mp4",
		});
	});
});
