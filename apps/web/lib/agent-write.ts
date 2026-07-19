import "server-only";

import { createHash } from "node:crypto";
import { nanoId } from "@cap/database/helpers";
import * as Db from "@cap/database/schema";
import { Database, type DbClient } from "@cap/web-backend";
import {
	Agent,
	Comment,
	type DatabaseError,
	type Video,
} from "@cap/web-domain";
import { and, eq, sql } from "drizzle-orm";
import { Effect, Schedule, Schema } from "effect";
import { revalidatePath } from "next/cache";
import { createNotification } from "@/lib/Notification";

type TransactionCallback = Parameters<DbClient["transaction"]>[0];
type Transaction = Parameters<TransactionCallback>[0];

export type AgentMutationOutcome<A> =
	| { state: "success"; response: A }
	| { state: "not_found" }
	| { state: "forbidden" }
	| { state: "conflict" };

type IdempotencyInput = {
	userId: Agent.AgentPrincipal["Type"]["id"];
	operation: string;
	key: string;
	requestHash: string;
	expiresAt: Date;
};

const getAffectedRows = (result: unknown) => {
	if (Array.isArray(result)) {
		return (
			(result[0] as { affectedRows?: number } | undefined)?.affectedRows ?? 0
		);
	}
	return (result as { affectedRows?: number } | undefined)?.affectedRows ?? 0;
};

const hash = (value: string) =>
	createHash("sha256").update(value).digest("hex");

export const agentMutationRequestHash = (operation: string, request: unknown) =>
	hash(JSON.stringify({ operation, request }));

export const isAgentIdempotencyKey = (value: string | undefined) =>
	typeof value === "string" &&
	value.length >= 8 &&
	value.length <= 128 &&
	/^[A-Za-z0-9._-]+$/.test(value);

export const isAgentWriteAccessEnabled = (input: {
	nodeEnv: string | undefined;
	enabled: string | undefined;
}) => input.nodeEnv !== "production" || input.enabled === "true";

const acquireIdempotency = async (tx: Transaction, input: IdempotencyInput) => {
	const keyHash = hash(input.key);
	const candidateId = nanoId();
	await tx
		.insert(Db.agentApiIdempotency)
		.values({
			id: candidateId,
			userId: input.userId,
			operation: input.operation,
			keyHash,
			requestHash: input.requestHash,
			expiresAt: input.expiresAt,
		})
		.onDuplicateKeyUpdate({
			set: { keyHash: sql`${Db.agentApiIdempotency.keyHash}` },
		});
	const [record] = await tx
		.select()
		.from(Db.agentApiIdempotency)
		.where(
			and(
				eq(Db.agentApiIdempotency.userId, input.userId),
				eq(Db.agentApiIdempotency.operation, input.operation),
				eq(Db.agentApiIdempotency.keyHash, keyHash),
			),
		)
		.limit(1)
		.for("update");
	if (!record) return { state: "unavailable" as const };
	if (record.expiresAt.getTime() <= Date.now()) {
		await tx
			.update(Db.agentApiIdempotency)
			.set({
				requestHash: input.requestHash,
				state: "pending",
				statusCode: null,
				response: null,
				expiresAt: input.expiresAt,
			})
			.where(eq(Db.agentApiIdempotency.id, record.id));
		return { state: "new" as const, record };
	}
	if (record.requestHash !== input.requestHash) {
		return { state: "conflict" as const };
	}
	if (record.state === "complete") {
		return { state: "replay" as const, record };
	}
	if (record.id !== candidateId) {
		return { state: "pending" as const };
	}
	return { state: "new" as const, record };
};

const completeIdempotency = async (
	tx: Transaction,
	id: string,
	response: unknown,
) => {
	const result = await tx
		.update(Db.agentApiIdempotency)
		.set({ state: "complete", statusCode: 200, response })
		.where(
			and(
				eq(Db.agentApiIdempotency.id, id),
				eq(Db.agentApiIdempotency.state, "pending"),
			),
		);
	if (getAffectedRows(result) !== 1) {
		throw new Error("Could not complete idempotent mutation");
	}
};

const releaseIdempotency = (tx: Transaction, id: string) =>
	tx
		.delete(Db.agentApiIdempotency)
		.where(
			and(
				eq(Db.agentApiIdempotency.id, id),
				eq(Db.agentApiIdempotency.state, "pending"),
			),
		);

const commonError = (requestId: string, message: string) => ({
	message,
	retryable: false,
	retryAfterMs: null,
	requestId,
});

const badRequest = (requestId: string, message: string) =>
	new Agent.AgentBadRequestError({
		...commonError(requestId, message),
		code: "INVALID_REQUEST",
	});

const notFound = (requestId: string) =>
	new Agent.AgentNotFoundError({
		...commonError(requestId, "The requested resource was not found"),
		code: "NOT_FOUND",
	});

const temporarilyUnavailable = (requestId: string) =>
	new Agent.AgentTemporaryUnavailableError({
		message: "The mutation could not be completed",
		code: "TEMPORARY_UNAVAILABLE",
		retryable: true,
		retryAfterMs: 500,
		requestId,
	});

const idempotencyConflict = (requestId: string) =>
	new Agent.AgentConflictError({
		...commonError(
			requestId,
			"Idempotency key was already used for a different request",
		),
		code: "IDEMPOTENCY_CONFLICT",
	});

export const runAgentMutation = <A>(input: {
	principal: Agent.AgentPrincipal["Type"];
	operation: string;
	idempotencyKey: string;
	request: unknown;
	requestId: string;
	decodeReplay: (value: unknown) => A;
	execute: (tx: Transaction) => Promise<AgentMutationOutcome<NoInfer<A>>>;
}): Effect.Effect<
	A,
	| Agent.AgentBadRequestError
	| Agent.AgentConflictError
	| Agent.AgentTemporaryUnavailableError
	| Agent.AgentNotFoundError
	| Agent.AgentForbiddenError
	| DatabaseError,
	Database
> =>
	Effect.gen(function* () {
		if (!isAgentIdempotencyKey(input.idempotencyKey)) {
			return yield* badRequest(
				input.requestId,
				"A valid Idempotency-Key header is required",
			);
		}
		const database = yield* Database;
		const requestHash = agentMutationRequestHash(
			input.operation,
			input.request,
		);
		const result = yield* database.use((db) =>
			db.transaction(async (tx) => {
				const idempotency = await acquireIdempotency(tx, {
					userId: input.principal.id,
					operation: input.operation,
					key: input.idempotencyKey,
					requestHash,
					expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
				});
				if (idempotency.state === "conflict") {
					return { state: "idempotency_conflict" as const };
				}
				if (idempotency.state === "unavailable") {
					return { state: "unavailable" as const };
				}
				if (idempotency.state === "pending") {
					return { state: "pending" as const };
				}
				if (idempotency.state === "replay") {
					return {
						state: "replay" as const,
						response: input.decodeReplay(idempotency.record.response),
					};
				}
				const outcome = await input.execute(tx);
				if (outcome.state !== "success") {
					await releaseIdempotency(tx, idempotency.record.id);
					return outcome;
				}
				await completeIdempotency(tx, idempotency.record.id, outcome.response);
				return outcome;
			}),
		);
		if (result.state === "idempotency_conflict") {
			return yield* idempotencyConflict(input.requestId);
		}
		if (result.state === "unavailable" || result.state === "pending") {
			return yield* temporarilyUnavailable(input.requestId);
		}
		if (result.state === "not_found") return yield* notFound(input.requestId);
		if (result.state === "forbidden") {
			return yield* new Agent.AgentForbiddenError({
				...commonError(input.requestId, "Access is not allowed"),
				code: "FORBIDDEN",
			});
		}
		if (result.state === "conflict") {
			return yield* new Agent.AgentConflictError({
				...commonError(
					input.requestId,
					"The resource changed; refresh and retry",
				),
				code: "CONFLICT",
			});
		}
		if (result.state === "success" || result.state === "replay") {
			return result.response;
		}
		return yield* temporarilyUnavailable(input.requestId);
	});

export const runAgentExternalMutation = <A, E, R>(input: {
	principal: Agent.AgentPrincipal["Type"];
	operation: string;
	idempotencyKey: string;
	request: unknown;
	requestId: string;
	decodeReplay: (value: unknown) => A;
	execute: (providerIdempotencyKey: string) => Effect.Effect<A, E, R>;
}): Effect.Effect<
	A,
	| E
	| Agent.AgentBadRequestError
	| Agent.AgentConflictError
	| Agent.AgentTemporaryUnavailableError
	| DatabaseError,
	R | Database
> =>
	Effect.gen(function* () {
		if (!isAgentIdempotencyKey(input.idempotencyKey)) {
			return yield* badRequest(
				input.requestId,
				"A valid Idempotency-Key header is required",
			);
		}
		const database = yield* Database;
		const requestHash = agentMutationRequestHash(
			input.operation,
			input.request,
		);
		const acquired = yield* database.use((db) =>
			db.transaction(async (tx) => {
				const idempotency = await acquireIdempotency(tx, {
					userId: input.principal.id,
					operation: input.operation,
					key: input.idempotencyKey,
					requestHash,
					expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
				});
				if (idempotency.state === "replay") {
					return {
						state: "replay" as const,
						response: input.decodeReplay(idempotency.record.response),
					};
				}
				return idempotency;
			}),
		);
		if (acquired.state === "conflict") {
			return yield* idempotencyConflict(input.requestId);
		}
		if (acquired.state === "unavailable" || acquired.state === "pending") {
			return yield* temporarilyUnavailable(input.requestId);
		}
		if (acquired.state === "replay") return acquired.response;
		const providerIdempotencyKey = hash(
			`${input.principal.id}\0${input.operation}\0${input.idempotencyKey}`,
		);
		const response = yield* input
			.execute(providerIdempotencyKey)
			.pipe(
				Effect.tapErrorCause(() =>
					database.use((db) =>
						db
							.delete(Db.agentApiIdempotency)
							.where(
								and(
									eq(Db.agentApiIdempotency.id, acquired.record.id),
									eq(Db.agentApiIdempotency.state, "pending"),
								),
							),
					),
				),
			);
		return yield* database
			.use((db) =>
				db.transaction(async (tx) => {
					const [record] = await tx
						.select()
						.from(Db.agentApiIdempotency)
						.where(eq(Db.agentApiIdempotency.id, acquired.record.id))
						.limit(1)
						.for("update");
					if (!record || record.requestHash !== requestHash) {
						throw new Error("Could not complete external agent mutation");
					}
					if (record.state === "complete") {
						return input.decodeReplay(record.response);
					}
					await completeIdempotency(tx, record.id, response);
					return response;
				}),
			)
			.pipe(
				Effect.retry({
					times: 3,
					schedule: Schedule.exponential("25 millis"),
				}),
			);
	});

export const createAgentFeedback = Effect.fn("Agent.createFeedback")(
	function* (input: {
		videoId: Video.VideoId;
		principal: Agent.AgentPrincipal["Type"];
		type: "text" | "emoji";
		content: string;
		timestampMs: number | null;
		parentCommentId: Comment.CommentId | null;
		idempotencyKey: string;
		requestId: string;
		durationMs: number | null;
	}) {
		const content = input.content.trim();
		const maximumLength = input.type === "emoji" ? 64 : 10_000;
		if (content.length === 0 || content.length > maximumLength) {
			return yield* badRequest(input.requestId, "Feedback content is invalid");
		}
		if (
			input.timestampMs !== null &&
			(!Number.isFinite(input.timestampMs) ||
				input.timestampMs < 0 ||
				(input.durationMs !== null &&
					input.timestampMs > input.durationMs + 1_000))
		) {
			return yield* badRequest(input.requestId, "timestampMs is invalid");
		}
		if (!isAgentIdempotencyKey(input.idempotencyKey)) {
			return yield* badRequest(
				input.requestId,
				"A valid Idempotency-Key header is required",
			);
		}

		const database = yield* Database;
		const operation = input.parentCommentId
			? "create_reply"
			: input.type === "emoji"
				? "create_reaction"
				: "create_comment";
		const requestHash = hash(
			JSON.stringify({
				videoId: input.videoId,
				type: input.type,
				content,
				timestampMs: input.timestampMs,
				parentCommentId: input.parentCommentId,
			}),
		);
		const result = yield* database.use((db) =>
			db.transaction(async (tx) => {
				const idempotency = await acquireIdempotency(tx, {
					userId: input.principal.id,
					operation,
					key: input.idempotencyKey,
					requestHash,
					expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
				});
				if (idempotency.state === "conflict") {
					return { state: "conflict" as const };
				}
				if (idempotency.state === "unavailable") {
					return { state: "unavailable" as const };
				}
				if (idempotency.state === "pending") {
					return { state: "pending" as const };
				}
				if (idempotency.state === "replay") {
					return {
						state: "replay" as const,
						response: Schema.decodeUnknownSync(Agent.AgentFeedbackResponse)(
							idempotency.record.response,
						),
					};
				}
				if (input.parentCommentId) {
					const [parent] = await tx
						.select({ id: Db.comments.id })
						.from(Db.comments)
						.where(
							and(
								eq(Db.comments.id, input.parentCommentId),
								eq(Db.comments.videoId, input.videoId),
								eq(Db.comments.type, "text"),
							),
						)
						.limit(1);
					if (!parent) {
						await releaseIdempotency(tx, idempotency.record.id);
						return { state: "not_found" as const };
					}
				}
				const now = new Date();
				const id = Comment.CommentId.make(nanoId());
				await tx.insert(Db.comments).values({
					id,
					authorId: input.principal.id,
					type: input.type,
					content,
					videoId: input.videoId,
					timestamp:
						input.timestampMs === null ? null : input.timestampMs / 1_000,
					parentCommentId: input.parentCommentId,
					createdAt: now,
					updatedAt: now,
				});
				const response = {
					id,
					videoId: input.videoId,
					type: input.type,
					content,
					timestampMs: input.timestampMs,
					parentCommentId: input.parentCommentId,
					createdAt: now.toISOString(),
					updatedAt: now.toISOString(),
					author: { id: input.principal.id, name: null },
					requestId: input.requestId,
				};
				await completeIdempotency(tx, idempotency.record.id, response);
				return { state: "created" as const, response };
			}),
		);

		if (result.state === "conflict") {
			return yield* idempotencyConflict(input.requestId);
		}
		if (result.state === "unavailable" || result.state === "pending") {
			return yield* temporarilyUnavailable(input.requestId);
		}
		if (result.state === "not_found") {
			return yield* notFound(input.requestId);
		}
		if (result.state === "created") {
			const notificationType = input.parentCommentId
				? "reply"
				: input.type === "emoji"
					? "reaction"
					: "comment";
			yield* Effect.tryPromise(() =>
				createNotification({
					type: notificationType,
					videoId: input.videoId,
					authorId: input.principal.id,
					comment: {
						id: result.response.id,
						content: result.response.content,
					},
					parentCommentId: input.parentCommentId ?? undefined,
				}),
			).pipe(Effect.catchAll(() => Effect.void));
		}
		yield* Effect.try(() => revalidatePath(`/s/${input.videoId}`)).pipe(
			Effect.catchAll(() => Effect.void),
		);
		return result.response;
	},
);

export const updateAgentCap = Effect.fn("Agent.updateCap")(function* (input: {
	videoId: Video.VideoId;
	principal: Agent.AgentPrincipal["Type"];
	title: string | undefined;
	public: boolean | undefined;
	idempotencyKey: string;
	requestId: string;
}) {
	const title = input.title?.trim();
	if (
		(title === undefined && input.public === undefined) ||
		(title !== undefined && (title.length === 0 || title.length > 200)) ||
		!isAgentIdempotencyKey(input.idempotencyKey)
	) {
		return yield* badRequest(input.requestId, "The Cap update is invalid");
	}
	const requestHash = hash(
		JSON.stringify({ videoId: input.videoId, title, public: input.public }),
	);
	const database = yield* Database;
	const result = yield* database.use((db) =>
		db.transaction(async (tx) => {
			const idempotency = await acquireIdempotency(tx, {
				userId: input.principal.id,
				operation: "update_cap",
				key: input.idempotencyKey,
				requestHash,
				expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
			});
			if (idempotency.state === "conflict") {
				return { state: "conflict" as const };
			}
			if (idempotency.state === "unavailable") {
				return { state: "unavailable" as const };
			}
			if (idempotency.state === "pending") {
				return { state: "pending" as const };
			}
			if (idempotency.state === "replay") {
				return {
					state: "replay" as const,
					response: Schema.decodeUnknownSync(Agent.AgentCapUpdateResponse)(
						idempotency.record.response,
					),
				};
			}
			const [video] = await tx
				.select({
					name: Db.videos.name,
					public: Db.videos.public,
					metadata: Db.videos.metadata,
				})
				.from(Db.videos)
				.where(
					and(
						eq(Db.videos.id, input.videoId),
						eq(Db.videos.ownerId, input.principal.id),
					),
				)
				.limit(1)
				.for("update");
			if (!video) {
				await releaseIdempotency(tx, idempotency.record.id);
				return { state: "not_found" as const };
			}
			const now = new Date();
			const metadata =
				video.metadata &&
				typeof video.metadata === "object" &&
				!Array.isArray(video.metadata)
					? video.metadata
					: {};
			await tx
				.update(Db.videos)
				.set({
					name: title ?? video.name,
					public: input.public ?? video.public,
					updatedAt: now,
					metadata:
						title === undefined
							? metadata
							: { ...metadata, titleManuallyEdited: true },
				})
				.where(eq(Db.videos.id, input.videoId));
			const response = {
				id: input.videoId,
				title: title ?? video.name,
				public: input.public ?? video.public,
				updatedAt: now.toISOString(),
				requestId: input.requestId,
			};
			await completeIdempotency(tx, idempotency.record.id, response);
			return { state: "updated" as const, response };
		}),
	);
	if (result.state === "conflict") {
		return yield* idempotencyConflict(input.requestId);
	}
	if (result.state === "unavailable" || result.state === "pending") {
		return yield* temporarilyUnavailable(input.requestId);
	}
	if (result.state === "not_found") return yield* notFound(input.requestId);
	yield* Effect.try(() => {
		revalidatePath("/dashboard/caps");
		revalidatePath("/dashboard/shared-caps");
		revalidatePath(`/s/${input.videoId}`);
	}).pipe(Effect.catchAll(() => Effect.void));
	return result.response;
});
