import { randomBytes } from "node:crypto";
import { sendEmail } from "@cap/database/emails/config";
import { RecordingRepairRequest } from "@cap/database/emails/recording-repair-request";
import { S3Buckets } from "@cap/web-backend";
import { Effect, Option } from "effect";
import { z } from "zod";
import { runPromise } from "@/lib/server";

export const MAX_SUBMISSION_BYTES = 200 * 1024 ** 3;
const MIN_PART_SIZE = 16 * 1024 * 1024;
const MAX_PARTS = 10_000;
const REPAIR_INBOX = "hello@cap.so";

export const submissionRequestSchema = z.object({
	sizeBytes: z.number().int().min(1).max(MAX_SUBMISSION_BYTES),
	operation: z.enum(["recover", "open"]),
	appVersion: z.string().max(64),
	os: z.string().max(32),
	errorMessage: z.string().max(4000),
	diagnosis: z.string().max(4000).nullable(),
	sessionId: z.string().max(64).nullable(),
});

export type SubmissionRequest = z.infer<typeof submissionRequestSchema>;

export function isSubmissionId(value: string) {
	return /^sub_[a-f0-9]{24}$/.test(value);
}

export function partSizeFor(sizeBytes: number) {
	const mib = 1024 * 1024;
	const needed = Math.ceil(sizeBytes / (MAX_PARTS - 1));
	return Math.max(MIN_PART_SIZE, Math.ceil(needed / mib) * mib);
}

const prefix = (userId: string, submissionId: string) =>
	`recording-repairs/${userId}/${submissionId}`;
export const archiveKey = (userId: string, submissionId: string) =>
	`${prefix(userId, submissionId)}/recording.tar`;
const requestKey = (userId: string, submissionId: string) =>
	`${prefix(userId, submissionId)}/request.json`;

export async function createSubmission(
	userId: string,
	request: SubmissionRequest,
) {
	const submissionId = `sub_${randomBytes(12).toString("hex")}`;
	const uploadId = await Effect.gen(function* () {
		const [bucket] = yield* S3Buckets.getBucketAccess(Option.none());
		yield* bucket.putObject(
			requestKey(userId, submissionId),
			JSON.stringify({ ...request, createdAt: new Date().toISOString() }),
			{ contentType: "application/json" },
		);
		const { UploadId } = yield* bucket.multipart.create(
			archiveKey(userId, submissionId),
			{
				ContentType: "application/x-tar",
				Metadata: { userId, source: "cap-desktop-recording-repair" },
			},
		);
		if (!UploadId) return yield* Effect.fail(new Error("No upload id"));
		return UploadId;
	}).pipe(runPromise);
	return { submissionId, uploadId, partSize: partSizeFor(request.sizeBytes) };
}

export async function presignParts(
	userId: string,
	submissionId: string,
	uploadId: string,
	partNumbers: number[],
) {
	const key = archiveKey(userId, submissionId);
	const entries = await Effect.gen(function* () {
		const [bucket] = yield* S3Buckets.getBucketAccess(Option.none());
		return yield* Effect.all(
			partNumbers.map((partNumber) =>
				bucket.multipart
					.getPresignedUploadPartUrl(key, uploadId, partNumber)
					.pipe(Effect.map((url) => [String(partNumber), url] as const)),
			),
			{ concurrency: 10 },
		);
	}).pipe(runPromise);
	return Object.fromEntries(entries);
}

export async function completeSubmission(args: {
	userId: string;
	userEmail: string;
	submissionId: string;
	uploadId: string;
	parts: { partNumber: number; etag: string }[];
}) {
	const key = archiveKey(args.userId, args.submissionId);
	const request = await Effect.gen(function* () {
		const [bucket] = yield* S3Buckets.getBucketAccess(Option.none());
		const raw = yield* bucket.getObject(
			requestKey(args.userId, args.submissionId),
		);
		if (Option.isNone(raw))
			return yield* Effect.fail(new Error("Unknown submission"));
		yield* bucket.multipart.complete(key, args.uploadId, {
			MultipartUpload: {
				Parts: [...args.parts]
					.sort((a, b) => a.partNumber - b.partNumber)
					.map((part) => ({ PartNumber: part.partNumber, ETag: part.etag })),
			},
		});
		return submissionRequestSchema.parse(JSON.parse(raw.value));
	}).pipe(runPromise);

	await sendEmail({
		email: REPAIR_INBOX,
		subject: `Recording repair request from ${args.userEmail}`,
		react: RecordingRepairRequest({
			userEmail: args.userEmail,
			userId: args.userId,
			operation: request.operation,
			os: request.os,
			version: request.appVersion,
			sizeBytes: request.sizeBytes,
			objectKey: key,
			errorMessage: request.errorMessage,
			diagnosis: request.diagnosis,
		}),
		replyTo: args.userEmail,
		fromOverride: "Cap <richie@send.cap.so>",
	});
}
