import { extname } from "node:path";
import { z } from "zod";
import { ApiError, isUnanswered, LocalError, withContext } from "./errors";
import { CONTENT_TYPES } from "./files";
import { asRecord, confirmed, dataOf } from "./http";
import { Disclosed } from "./redact";
import { videoLinks } from "./shape";
import { RESOLUTION_TIERS, type Tool, type ToolDeps, tool } from "./tool";
import { MAX_PARTS, MAX_VIDEO_BYTES, PART_URL_BATCH } from "./upload";

const MEBIBYTE = 1024 * 1024;
export const HOSTED_PART_MIN_BYTES = 64 * MEBIBYTE;
export const HOSTED_MAX_PARTS = 100;
export const PART_LINK_SECONDS = 3600;
const ABORT_BUDGET_MS = 5_000;

export function planParts(size: number) {
	const partBytes = Math.max(
		HOSTED_PART_MIN_BYTES,
		Math.ceil(size / HOSTED_MAX_PARTS / MEBIBYTE) * MEBIBYTE,
	);
	return { partBytes, count: Math.ceil(size / partBytes) };
}

function required(value: unknown) {
	if (typeof value === "string" && value.length > 0) return value;
	throw new LocalError(
		"unexpected_response",
		"Cap answered in a shape this server does not understand",
		null,
	);
}

const fileTitle = (fileName: string | undefined) => {
	if (fileName === undefined) return undefined;
	const stem = fileName.slice(0, fileName.length - extname(fileName).length);
	return (stem || fileName).slice(0, 255);
};

function uploadSteps(partBytes: number, count: number) {
	const put = (file: string, part: string) =>
		`curl -sS --fail -X PUT --upload-file ${file} -D - -o /dev/null "<${part}>"`;
	const finish =
		"Call videos_complete_upload with videoId, uploadId and parts as a list of { partNumber, etag }, using the ETag header each upload answered with.";
	if (count === 1) {
		return [
			`Upload the whole file to the url of part 1 in one request, from the machine that holds it: ${put("<file>", "url of part 1")}. Keep the ETag response header.`,
			finish,
		];
	}
	return [
		`Split the file into ${count} parts of ${partBytes} bytes, in order: split -b ${partBytes} <file> cap-part- (cap-part-aa is part 1, cap-part-ab is part 2, and so on).`,
		`Upload each part to its own url: ${put("cap-part-aa", "url of part 1")}, then the same for every other part. Keep the ETag response header of each.`,
		finish,
	];
}

export function createHostedUploadTools(deps: ToolDeps): Tool[] {
	const { client } = deps;

	return [
		tool({
			name: "videos_create_upload",
			title: "Create a video upload",
			description: `Create a video and get signed links to upload its file directly to storage, for when this server cannot read your files. Send the file size in bytes. Returns the video id, an uploadId and one link per part with the exact upload steps; links work for ${PART_LINK_SECONDS / 60} minutes. Then call videos_complete_upload. Uploading and encoding are free, and stored video is billed daily by its length and resolution tier until it is deleted. Pass videoId to start a failed upload again in the same video.`,
			kind: "write",
			input: {
				contentLength: z
					.number()
					.int()
					.min(1)
					.max(MAX_VIDEO_BYTES)
					.describe("Size of the video file in bytes"),
				fileName: z
					.string()
					.min(1)
					.max(255)
					.optional()
					.describe(
						"Name of the file, used for its type and as the default video name",
					),
				contentType: z
					.string()
					.min(1)
					.max(255)
					.optional()
					.describe("MIME type of the file, such as video/mp4"),
				name: z
					.string()
					.max(255)
					.optional()
					.describe("Video name (defaults to the file name)"),
				userId: z
					.string()
					.min(1)
					.max(255)
					.optional()
					.describe("Your own user id for this video, used to filter lists"),
				maxResolutionTier: z
					.enum(RESOLUTION_TIERS)
					.optional()
					.describe(
						"Highest resolution to encode and bill (default 1080p, the cheapest)",
					),
				metadata: z
					.record(z.string(), z.unknown())
					.optional()
					.describe("Your own JSON object to store with it, under 8 KB"),
				videoId: z
					.string()
					.min(1)
					.optional()
					.describe(
						"Start again in this existing video whose upload never completed, instead of creating a new one",
					),
			},
			run: async (args, call) => {
				const plan = planParts(args.contentLength);
				const name = args.name ?? fileTitle(args.fileName);
				const contentType =
					args.contentType ??
					(args.fileName === undefined
						? undefined
						: CONTENT_TYPES[extname(args.fileName).toLowerCase()]) ??
					"application/octet-stream";

				let pages: Record<string, unknown>;
				let token: string;
				if (args.videoId === undefined) {
					pages = dataOf(
						await client.call("createUpload", {
							body: {
								...(name === undefined ? {} : { name }),
								...(args.userId === undefined ? {} : { userId: args.userId }),
								...(args.maxResolutionTier === undefined
									? {}
									: { maxResolutionTier: args.maxResolutionTier }),
								...(args.metadata === undefined
									? {}
									: { metadata: args.metadata }),
							},
							signal: call.signal,
						}),
					);
					token = required(pages.token);
					call.announce("video_created", {
						videoId: required(pages.videoId ?? pages.id),
					});
				} else {
					pages = dataOf(
						await client.call("getVideo", {
							id: args.videoId,
							signal: call.signal,
						}),
					);
					token = required(
						dataOf(
							await client.call("renewUploadToken", {
								id: args.videoId,
								signal: call.signal,
							}),
						).token,
					);
				}
				const videoId = args.videoId ?? required(pages.videoId ?? pages.id);

				let uploadId: string | null = null;
				try {
					uploadId = required(
						asRecord(
							await client.call("initiateUpload", {
								body: {
									videoId,
									contentType,
									contentLength: args.contentLength,
								},
								token,
								signal: call.signal,
							}),
						).uploadId,
					);
					const parts: { partNumber: number; bytes: number; url: Disclosed }[] =
						[];
					for (let first = 1; first <= plan.count; first += PART_URL_BATCH) {
						const partNumbers = Array.from(
							{ length: Math.min(PART_URL_BATCH, plan.count - first + 1) },
							(_, offset) => first + offset,
						);
						const reply = asRecord(
							await client.call("partUrls", {
								body: { videoId, uploadId, partNumbers },
								token,
								signal: call.signal,
							}),
						);
						const signed = new Map<number, string>();
						for (const part of Array.isArray(reply.parts) ? reply.parts : []) {
							const { partNumber, presignedUrl } = asRecord(part);
							if (
								typeof partNumber === "number" &&
								typeof presignedUrl === "string"
							) {
								signed.set(partNumber, presignedUrl);
							}
						}
						for (const partNumber of partNumbers) {
							const offset = (partNumber - 1) * plan.partBytes;
							parts.push({
								partNumber,
								bytes: Math.min(plan.partBytes, args.contentLength - offset),
								url: new Disclosed(required(signed.get(partNumber))),
							});
						}
					}
					return {
						videoId,
						uploadId,
						status: "uploading",
						bytes: args.contentLength,
						partBytes: plan.partBytes,
						parts,
						linksExpireInSeconds: PART_LINK_SECONDS,
						...videoLinks(pages),
						steps: uploadSteps(plan.partBytes, plan.count),
						next: "Upload the parts as the steps say, then call videos_complete_upload. If the links expire first, call videos_create_upload again with this videoId: it continues the same upload, so parts already stored keep their ETags.",
					};
				} catch (error) {
					// A retry with videoId gets back the open upload and the parts
					// already stored in it, so only an upload opened for a new video
					// is safe to abort.
					if (uploadId !== null && args.videoId === undefined) {
						await client
							.call("abortUpload", {
								body: { videoId, uploadId },
								token,
								deadlineAt: Date.now() + ABORT_BUDGET_MS,
							})
							.catch(() => {});
					}
					throw withContext(error, {
						videoId,
						videoStatus: "uploading",
						next: "The video exists with no file. Call videos_create_upload again with this videoId to retry, or remove it with videos_delete.",
					});
				}
			},
		}),
		tool({
			name: "videos_complete_upload",
			title: "Complete a video upload",
			description:
				"Finish an upload started with videos_create_upload once every part is stored, and start encoding. Send the ETag that storage answered with for each part. Then call videos_wait for the playback links.",
			kind: "write",
			input: {
				videoId: z.string().min(1).describe("The video id"),
				uploadId: z
					.string()
					.min(1)
					.max(1024)
					.describe("The uploadId from videos_create_upload"),
				parts: z
					.array(
						z.object({
							partNumber: z.number().int().min(1).max(MAX_PARTS),
							etag: z
								.string()
								.min(1)
								.max(256)
								.describe("The ETag response header of that part's upload"),
						}),
					)
					.min(1)
					.max(MAX_PARTS)
					.describe("Every uploaded part"),
				durationSeconds: z
					.number()
					.positive()
					.max(4 * 60 * 60)
					.optional()
					.describe(
						"Length of the video if known. Cap measures it after the upload either way",
					),
			},
			run: async (args, call) => {
				let token: string;
				try {
					token = required(
						dataOf(
							await client.call("renewUploadToken", {
								id: args.videoId,
								signal: call.signal,
							}),
						).token,
					);
				} catch (error) {
					if (
						error instanceof ApiError &&
						error.code === "upload_already_completed"
					) {
						return {
							videoId: args.videoId,
							status: "processing",
							next: "This upload was already completed. Call videos_wait with this videoId to get the playback links.",
						};
					}
					throw error;
				}
				try {
					confirmed(
						await client.call("completeUpload", {
							body: {
								videoId: args.videoId,
								uploadId: args.uploadId,
								// Complete measures every part from storage and ignores size.
								parts: args.parts.map((part) => ({ ...part, size: 0 })),
								durationInSecs: args.durationSeconds ?? 1,
							},
							token,
							signal: call.signal,
						}),
					);
				} catch (error) {
					const unclear =
						isUnanswered(error) ||
						(error instanceof ApiError &&
							(error.status >= 500 || error.code === "completion_in_progress"));
					throw withContext(
						error,
						unclear
							? {
									videoId: args.videoId,
									videoStatus: "unknown",
									next: "The upload may have completed. Check it with videos_get before uploading again, and call videos_complete_upload again with the same parts if it is still uploading.",
								}
							: {
									videoId: args.videoId,
									videoStatus: "uploading",
									next: "The video still has no file and its stored parts are kept. Fix what the error says and call videos_complete_upload again, or call videos_create_upload with this videoId for new links.",
								},
					);
				}
				return {
					videoId: args.videoId,
					status: "processing",
					next: "Call videos_wait with this videoId to get the playback links when encoding finishes.",
				};
			},
		}),
	];
}
