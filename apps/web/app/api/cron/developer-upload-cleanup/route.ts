import { timingSafeEqual } from "node:crypto";
import { S3Buckets } from "@cap/web-backend";
import { Effect, Option } from "effect";
import { NextResponse } from "next/server";
import { runPromise } from "@/lib/server";

export const dynamic = "force-dynamic";

const DEVELOPER_UPLOAD_PREFIX = "developer/";
const INCOMPLETE_UPLOAD_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export async function GET(request: Request) {
	const cronSecret = process.env.CRON_SECRET;
	if (!cronSecret) {
		return NextResponse.json(
			{ error: "Server misconfiguration" },
			{ status: 500 },
		);
	}

	const authHeader = request.headers.get("authorization");
	const expected = `Bearer ${cronSecret}`;
	if (
		!authHeader ||
		authHeader.length !== expected.length ||
		!timingSafeEqual(Buffer.from(authHeader), Buffer.from(expected))
	) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	const startedBefore = Date.now() - INCOMPLETE_UPLOAD_MAX_AGE_MS;

	const { aborted, failed } = await Effect.gen(function* () {
		const [bucket] = yield* S3Buckets.getBucketAccess(Option.none());
		let aborted = 0;
		let failed = 0;
		let keyMarker: string | undefined;
		let uploadIdMarker: string | undefined;

		while (true) {
			const page = yield* bucket.multipart.listUploads({
				prefix: DEVELOPER_UPLOAD_PREFIX,
				keyMarker,
				uploadIdMarker,
			});

			for (const upload of page.Uploads ?? []) {
				if (!upload.Key || !upload.UploadId || !upload.Initiated) continue;
				if (upload.Initiated.getTime() > startedBefore) continue;

				const result = yield* Effect.either(
					bucket.multipart.abort(upload.Key, upload.UploadId),
				);
				if (result._tag === "Right") {
					aborted++;
				} else {
					failed++;
					console.error(
						"[developer-upload-cleanup] Failed to abort upload",
						upload.Key,
						result.left,
					);
				}
			}

			const nextKeyMarker = page.NextKeyMarker;
			const nextUploadIdMarker = page.NextUploadIdMarker;
			if (
				!page.IsTruncated ||
				!nextKeyMarker ||
				(nextKeyMarker === keyMarker && nextUploadIdMarker === uploadIdMarker)
			) {
				break;
			}
			keyMarker = nextKeyMarker;
			uploadIdMarker = nextUploadIdMarker;
		}

		return { aborted, failed };
	}).pipe(runPromise);

	return NextResponse.json(
		{ success: failed === 0, aborted, failed },
		{ status: failed === 0 ? 200 : 500 },
	);
}
