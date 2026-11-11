import type { developerVideos } from "@cap/database/schema";
import type { DeveloperVideoProcessingState } from "@cap/database/types";

export type DeveloperVideoFixture = typeof developerVideos.$inferSelect;

export function processingState(
	overrides: Partial<DeveloperVideoProcessingState> = {},
): DeveloperVideoProcessingState {
	return {
		encodeId: "encode-1",
		startedAt: 1_000,
		probe: { duration: 12, width: 1920, height: 1080, fps: 30 },
		hls: { state: "pending" },
		mp4: { state: "pending" },
		attempts: { hls: 0, mp4: 0 },
		poster: null,
		bytes: { source: 1_000, hls: 0, mp4: 0 },
		...overrides,
	};
}

export function developerVideo(
	overrides: Partial<DeveloperVideoFixture> = {},
): DeveloperVideoFixture {
	return {
		id: "video-1",
		appId: "app-1",
		externalUserId: null,
		name: "Untitled",
		duration: 12,
		width: 1920,
		height: 1080,
		fps: 30,
		s3Key: "developer/app-1/video-1/video",
		transcriptionStatus: null,
		metadata: null,
		status: "processing",
		playbackId: "playback-id-0123456789ab",
		maxResolutionTier: "1080p",
		renditions: null,
		storedBytes: null,
		errorReason: null,
		processing: processingState(),
		deletedAt: null,
		createdAt: new Date("2026-11-01T00:00:00Z"),
		updatedAt: new Date("2026-11-01T00:00:00Z"),
		...overrides,
	};
}

export interface DeveloperVideoStore {
	video: DeveloperVideoFixture | null;
	appDeleted: boolean;
	updates: Partial<DeveloperVideoFixture>[];
}

export async function createDeveloperVideoDatabase(store: DeveloperVideoStore) {
	const { MySqlDialect } = await import("drizzle-orm/mysql-core");
	const dialect = new MySqlDialect();
	type Condition = Parameters<typeof dialect.sqlToQuery>[0];

	const select = (fields?: Record<string, unknown>) => {
		let joined = false;
		const rows = (condition: Condition) => {
			const video = store.video;
			if (!video || (joined && store.appDeleted)) return [];
			const query = dialect.sqlToQuery(condition);
			const identified =
				(!query.sql.includes("`id` = ?") || query.params.includes(video.id)) &&
				(!query.sql.includes("`playbackId` = ?") ||
					(video.playbackId !== null &&
						query.params.includes(video.playbackId)));
			const scoped =
				!query.sql.includes("`appId` = ?") ||
				query.params.includes(video.appId);
			const live =
				!query.sql.includes("`deletedAt` is null") || video.deletedAt === null;
			if (!identified || !scoped || !live) return [];
			return fields && "video" in fields ? [{ video }] : [video];
		};
		const chain = {
			from: () => chain,
			innerJoin: () => {
				joined = true;
				return chain;
			},
			where: (condition: Condition) => {
				const result = rows(condition);
				return Object.assign(Promise.resolve(result), {
					limit: async () => result,
					for: async () => result,
					orderBy: () => ({
						limit: () => ({ offset: async () => result }),
					}),
				});
			},
		};
		return chain;
	};

	const database = {
		select,
		update: () => ({
			set: (updates: Partial<DeveloperVideoFixture>) => ({
				where: async () => {
					store.updates.push(updates);
					if (store.video) store.video = { ...store.video, ...updates };
				},
			}),
		}),
		transaction: async (run: (tx: unknown) => Promise<unknown>) =>
			run(database),
	};
	return database;
}
