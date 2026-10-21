import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type pg from "pg";
import {
	activationQuery,
	legacyActivationQuery,
} from "../../packages/database/loops/activation";
import { connectCapDatabase } from "../../packages/database/loops/connection";

const url = process.env.LOOPS_ACTIVATION_READONLY_TEST_URL;

describe.skipIf(!url)(
	"activation SQL against synthetic rows without database writes",
	() => {
		let database: pg.Client;
		beforeAll(async () => {
			if (!url) throw new Error("Missing read-only test connection");
			database = await connectCapDatabase(url);
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
			videos AS (SELECT 'video'::text AS id, $2::text AS "ownerId", $3::boolean AS "isScreenshot",
				$4::real AS duration, jsonb_build_object('type', 'desktopMP4', 'outputKey', $5::text) AS source,
				$6::text AS "jobStatus", timestamp '2026-09-12 01:00:00' AS "createdAt",
				$7::timestamp AS "firstViewEmailSentAt"),
			video_uploads AS (SELECT 'video'::text AS video_id WHERE $8::boolean),
			video_processing_jobs AS (SELECT 'video'::text AS video_id, $9::text AS state WHERE $10::boolean)
			${activationQuery}`;
			const { rows } = await database.query(query, [
				"owner",
				options.otherOwner ? "other" : "owner",
				options.screenshot ?? false,
				options.duration ?? 30,
				options.output === undefined
					? "owner/video/result.mp4"
					: options.output,
				options.legacyStatus ?? null,
				options.viewed ? "2026-09-12 02:00:00" : null,
				options.upload ?? false,
				options.state ?? null,
				Boolean(options.state),
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

		for (const [name, videos] of [
			["no videos", []],
			["private video", [{ ownerId: "owner", public: false }]],
			["public video", [{ ownerId: "owner", public: true }]],
			["another owner's public video", [{ ownerId: "other", public: true }]],
			["null visibility", [{ ownerId: "owner", public: null }]],
			[
				"mixed ownership and visibility",
				[
					{ ownerId: "other", public: true },
					{ ownerId: "owner", public: false },
					{ ownerId: "owner", public: true },
				],
			],
		] as const) {
			test(`legacy activation preserves both previous reads for ${name}`, async () => {
				const fixture = videos.length
					? videos
							.map(
								(_, index) =>
									`SELECT 'video'::text AS id, $${index * 2 + 2}::text AS "ownerId", $${index * 2 + 3}::boolean AS public`,
							)
							.join(" UNION ALL ")
					: `SELECT NULL::text AS id, NULL::text AS "ownerId", NULL::boolean AS public WHERE FALSE`;
				const cte = `WITH videos AS (${fixture})`;
				const values = videos.flatMap((video) => [video.ownerId, video.public]);
				const { rows: previousVideo } = await database.query(
					`${cte} SELECT id FROM videos WHERE "ownerId" = $1 LIMIT 1`,
					["owner", ...values],
				);
				const { rows: previousShared } = await database.query(
					`${cte} SELECT id FROM videos WHERE "ownerId" = $1 AND public = true LIMIT 1`,
					["owner", ...values],
				);
				const { rows: combined } = await database.query(
					`${cte} ${legacyActivationQuery}`,
					["owner", ...values],
				);
				expect(Boolean(combined[0].hasVideo)).toBe(previousVideo.length > 0);
				expect(Boolean(combined[0].hasSharedVideo)).toBe(
					previousShared.length > 0,
				);
			});
		}
	},
);
