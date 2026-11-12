import { Hono } from "hono";
import { z } from "zod";
import { apiErrorBody } from "@/lib/api-errors";
import { parseDeveloperVideosPagination } from "@/lib/developer-pagination";
import {
	createTranscriptFromUrl,
	createTranscriptUpload,
	deleteTranscript,
	getTranscript,
	getTranscriptResult,
	isTranscriptIdempotencyKey,
	listTranscripts,
	startTranscriptUpload,
	type TranscriptFailure,
} from "@/lib/developer-transcript-store";
import {
	isTranscriptStatus,
	serializeTranscript,
	TRANSCRIPT_STATUSES,
} from "@/lib/developer-transcripts";
import { zValidator } from "@/utils/zod-validator";
import { withDeveloperSecretAuth } from "../../../utils";

export const app = new Hono<{
	Variables: {
		developerAppId: string;
		developerKeyType: "secret";
	};
}>().use(withDeveloperSecretAuth);

const failureBody = (failure: TranscriptFailure) =>
	apiErrorBody(failure.code, failure.message, failure.hint);

const optionsSchema = {
	name: z.string().max(255).optional(),
	language: z.string().max(16).optional(),
	userId: z.string().max(255).optional(),
	metadata: z.record(z.string(), z.unknown()).optional(),
};

const readIdempotencyKey = (header: string | undefined) => {
	if (header === undefined) return { ok: true as const, key: undefined };
	return isTranscriptIdempotencyKey(header)
		? { ok: true as const, key: header }
		: { ok: false as const };
};

const invalidIdempotencyKey = apiErrorBody(
	"invalid_idempotency_key",
	"Idempotency-Key is not valid",
	"Send 8 to 128 characters from letters, digits, dot, dash and underscore.",
);

app.post(
	"/",
	zValidator("json", z.object({ url: z.string().min(1), ...optionsSchema })),
	async (c) => {
		const idempotency = readIdempotencyKey(c.req.header("idempotency-key"));
		if (!idempotency.ok) return c.json(invalidIdempotencyKey, 400);

		const result = await createTranscriptFromUrl(c.get("developerAppId"), {
			...c.req.valid("json"),
			idempotencyKey: idempotency.key,
		});
		if (!result.ok) return c.json(failureBody(result), result.status);
		return c.json({ data: serializeTranscript(result.transcript) });
	},
);

app.post(
	"/uploads",
	zValidator(
		"json",
		z.object({
			fileName: z.string().max(255).optional(),
			contentLength: z.number().int().positive(),
			...optionsSchema,
		}),
	),
	async (c) => {
		const idempotency = readIdempotencyKey(c.req.header("idempotency-key"));
		if (!idempotency.ok) return c.json(invalidIdempotencyKey, 400);

		const result = await createTranscriptUpload(c.get("developerAppId"), {
			...c.req.valid("json"),
			idempotencyKey: idempotency.key,
		});
		if (!result.ok) return c.json(failureBody(result), result.status);
		return c.json(
			{
				data: {
					...serializeTranscript(result.transcript),
					upload: result.upload,
				},
			},
			200,
		);
	},
);

app.post("/:id/start", async (c) => {
	const result = await startTranscriptUpload(
		c.get("developerAppId"),
		c.req.param("id"),
	);
	if (!result.ok) return c.json(failureBody(result), result.status);
	return c.json({ data: serializeTranscript(result.transcript) });
});

app.get("/", async (c) => {
	const { limit, offset } = parseDeveloperVideosPagination(
		c.req.query("limit"),
		c.req.query("offset"),
	);
	const status = c.req.query("status");
	if (status !== undefined && !isTranscriptStatus(status)) {
		return c.json(
			apiErrorBody(
				"invalid_status",
				"Status filter is not valid",
				`Use one of ${TRANSCRIPT_STATUSES.join(", ")}.`,
			),
			400,
		);
	}

	const { transcripts, hasMore } = await listTranscripts(
		c.get("developerAppId"),
		{
			limit,
			offset,
			userId: c.req.query("userId")?.trim() || null,
			status: status ?? null,
		},
	);

	return c.json({
		data: transcripts.map((transcript) => serializeTranscript(transcript)),
		pagination: { limit, offset, hasMore },
	});
});

app.get("/:id", async (c) => {
	const transcript = await getTranscript(
		c.get("developerAppId"),
		c.req.param("id"),
	);
	if (!transcript) {
		return c.json(
			apiErrorBody(
				"transcript_not_found",
				"Transcript not found",
				"Check the transcript ID and that it belongs to this app.",
			),
			404,
		);
	}

	const include = new Set(
		(c.req.query("include") ?? "")
			.split(",")
			.map((part) => part.trim())
			.filter(Boolean),
	);
	const data = serializeTranscript(transcript, { includeText: true });
	if (!include.has("words") && !include.has("segments")) {
		return c.json({ data });
	}

	const result = await getTranscriptResult(transcript);
	return c.json({
		data: {
			...data,
			...(include.has("words") ? { words: result?.words ?? null } : {}),
			...(include.has("segments")
				? { segments: result?.segments ?? null }
				: {}),
		},
	});
});

app.delete("/:id", async (c) => {
	const result = await deleteTranscript(
		c.get("developerAppId"),
		c.req.param("id"),
	);
	if (!result.ok) return c.json(failureBody(result), result.status);
	return c.json({ success: true });
});
