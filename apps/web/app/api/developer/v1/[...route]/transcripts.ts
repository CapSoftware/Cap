import { Hono } from "hono";
import { z } from "zod";
import { apiErrorBody } from "@/lib/api-errors";
import { parseDeveloperListQuery } from "@/lib/developer-pagination";
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
	transcriptUploadExpiry,
} from "@/lib/developer-transcripts";
import { developerZValidator } from "@/utils/zod-validator";
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

const INCLUDE_VALUES = ["words", "segments"] as const;

const invalidIdempotencyKey = apiErrorBody(
	"invalid_idempotency_key",
	"Idempotency-Key is not valid",
	"Send 8 to 128 characters from letters, digits, dot, dash and underscore.",
);

app.post(
	"/",
	developerZValidator(
		"json",
		z.strictObject({ url: z.string().min(1), ...optionsSchema }),
	),
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
	developerZValidator(
		"json",
		z.strictObject({
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
	const parsed = parseDeveloperListQuery(c.req.query(), ["userId", "status"]);
	if (!parsed.ok) {
		return c.json(apiErrorBody(parsed.code, parsed.message, parsed.hint), 400);
	}
	const { limit, offset } = parsed;
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

	const userId = c.req.query("userId")?.trim();
	if (userId === "") {
		return c.json(
			apiErrorBody(
				"invalid_user_id",
				"userId filter is empty",
				"Send the user ID to filter by, or leave userId out to list every transcript.",
			),
			400,
		);
	}

	const { transcripts, hasMore } = await listTranscripts(
		c.get("developerAppId"),
		{
			limit,
			offset,
			userId: userId ?? null,
			status: status ?? null,
		},
	);

	return c.json({
		data: transcripts.map((transcript) => serializeTranscript(transcript)),
		pagination: { limit, offset, hasMore },
	});
});

app.get("/:id", async (c) => {
	const include = new Set(
		(c.req.query("include") ?? "")
			.split(",")
			.map((part) => part.trim())
			.filter(Boolean),
	);
	const unknown = [...include].find(
		(value) => !INCLUDE_VALUES.some((known) => known === value),
	);
	if (unknown !== undefined) {
		return c.json(
			apiErrorBody(
				"invalid_include",
				`include has an unknown value: ${unknown.slice(0, 64)}`,
				`Use ${INCLUDE_VALUES.join(", ")} or both, separated by a comma.`,
			),
			400,
		);
	}

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

	const data = {
		...serializeTranscript(transcript, { includeText: true }),
		...(transcript.status === "uploading"
			? {
					upload: {
						expiresAt: transcriptUploadExpiry(transcript).toISOString(),
					},
				}
			: {}),
	};
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
