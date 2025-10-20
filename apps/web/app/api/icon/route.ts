import { S3Buckets } from "@cap/web-backend";
import { Effect, Option } from "effect";
import { type NextRequest, NextResponse } from "next/server";
import { runPromise } from "@/lib/server";

export async function GET(request: NextRequest) {
	try {
		const { searchParams } = request.nextUrl;
		const key = searchParams.get("key");

		if (!key) {
			return NextResponse.json(
				{ error: "Missing key parameter" },
				{ status: 400 },
			);
		}

		// Validate that the key looks like an organization/space/user icon path
		if (!key.startsWith("organizations/") && !key.startsWith("users/")) {
			return NextResponse.json(
				{ error: "Invalid key format" },
				{ status: 400 },
			);
		}

		const signedUrl = await Effect.gen(function* () {
			const [bucket] = yield* S3Buckets.getBucketAccess(Option.none());
			return yield* bucket.getSignedObjectUrl(key);
		}).pipe(runPromise);

		return NextResponse.redirect(signedUrl);
	} catch (error) {
		console.error("Error generating signed URL for icon:", error);
		return NextResponse.json(
			{
				error: "Failed to generate signed URL",
				details: error instanceof Error ? error.message : "Unknown error",
			},
			{ status: 500 },
		);
	}
}
