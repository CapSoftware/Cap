import { timingSafeEqual } from "node:crypto";
import { AwsCredentials } from "@cap/web-backend";
import { Effect } from "effect";
import { NextResponse } from "next/server";
import {
	readDeliveryLogLocation,
	runDeliveryMetering,
} from "@/lib/infra-delivery-metering";
import {
	databaseDeliveryStore,
	s3DeliveryLogSource,
	storageDeliveryResolver,
} from "@/lib/infra-delivery-store";
import { runPromise } from "@/lib/server";

export const maxDuration = 300;

const FILES_UNTIL_MS = 200_000;
const MAX_FILES_PER_RUN = 600;

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

	const location = readDeliveryLogLocation(process.env.CAP_INFRA_DELIVERY_LOGS);
	if (!location) {
		return NextResponse.json({ success: true, skipped: "not configured" });
	}

	const startedAt = Date.now();
	const credentials = await runPromise(
		Effect.map(AwsCredentials, (value) => value.credentials),
	);
	const result = await runDeliveryMetering({
		source: s3DeliveryLogSource(
			location,
			credentials,
			process.env.CAP_INFRA_DELIVERY_LOGS_REGION || "us-east-1",
		),
		store: databaseDeliveryStore,
		resolver: storageDeliveryResolver,
		now: new Date(startedAt),
		maxFiles: MAX_FILES_PER_RUN,
		outOfTime: () => Date.now() - startedAt >= FILES_UNTIL_MS,
	});

	return NextResponse.json({
		success: true,
		...result,
		durationMs: Date.now() - startedAt,
	});
}
