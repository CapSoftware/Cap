import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";
import { activationQuery } from "../../packages/database/loops/activation";

const url = process.env.LOOPS_ACTIVATION_READONLY_TEST_URL;

describe.skipIf(!url)(
	"activation SQL against synthetic rows without database writes",
	() => {
		let database: Connection;
		beforeAll(async () => {
			if (!url) throw new Error("Missing read-only test connection");
			database = await mysql.createConnection({
				uri: url,
				dateStrings: true,
				timezone: "Z",
			});
		});
		afterAll(async () => {
			await database?.end();
		});

		async function signals(
			options: {
				screenshot?: boolean;
				upload?: boolean;
				state?: string;
				output?: string | null;
				duration?: number;
				viewed?: boolean;
				otherOwner?: boolean;
				legacyStatus?: string;
			} = {},
		) {
			const query = `WITH
			videos AS (SELECT 'video' AS id, ? AS ownerId, ? AS isScreenshot,
				? AS duration, JSON_OBJECT('type', 'desktopMP4', 'outputKey', ?) AS source,
				? AS jobStatus, CAST('2026-09-12 01:00:00' AS DATETIME) AS createdAt,
				CAST(? AS DATETIME) AS firstViewEmailSentAt),
			video_uploads AS (SELECT 'video' AS video_id WHERE ?),
			video_processing_jobs AS (SELECT 'video' AS video_id, ? AS state WHERE ?)
			${activationQuery}`;
			const [rows] = await database.query<RowDataPacket[]>(query, [
				options.otherOwner ? "other" : "owner",
				options.screenshot ? 1 : 0,
				options.duration ?? 30,
				options.output === undefined
					? "owner/video/result.mp4"
					: options.output,
				options.legacyStatus ?? null,
				options.viewed ? "2026-09-12 02:00:00" : null,
				options.upload ? 1 : 0,
				options.state ?? null,
				options.state ? 1 : 0,
				"owner",
			]);
			return rows[0];
		}

		for (const [name, options] of [
			["screenshot", { screenshot: true }],
			["another owner", { otherOwner: true }],
			["active upload", { upload: true }],
			["queued job with upload row already removed", { state: "queued" }],
			["failed processing", { state: "source-blocked" }],
			["empty output", { output: "" }],
			["null output", { output: null }],
			["zero duration", { duration: 0 }],
		] as const) {
			test(`${name} is not activation`, async () => {
				expect(Boolean((await signals(options)).hasVideo)).toBe(false);
			});
		}
		test("published MP4 and verified processing count as completed videos", async () => {
			expect((await signals()).hasVideo).toBe(1);
			expect((await signals({ state: "verified" })).hasVideo).toBe(1);
			expect(
				(await signals({ output: null, legacyStatus: "COMPLETE" })).hasVideo,
			).toBe(1);
		});
		test("public-by-default is insufficient sharing evidence", async () => {
			expect((await signals()).hasSharedVideo).toBe(0);
			expect((await signals({ viewed: true })).hasSharedVideo).toBe(1);
			expect(
				(await signals({ viewed: true, upload: true })).hasSharedVideo,
			).toBe(0);
		});
	},
);
