import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { z } from "zod";
import { creditLinkFor } from "./credit-link";
import { createDocsTool, fetchDocs } from "./docs";
import {
	ApiError,
	isCreditCode,
	isUnanswered,
	LocalError,
	withContext,
} from "./errors";
import { inspectFile, storageTimeoutMs } from "./files";
import { createHostedUploadTools } from "./hosted-upload";
import { asRecord, confirmed, dataOf, listOf, storagePut } from "./http";
import {
	captionsNext,
	page,
	transactionRow,
	transcriptView,
	videoDetail,
	videoDurationSeconds,
	videoImport,
	videoLinks,
	videoRow,
} from "./shape";
import {
	RESOLUTION_TIERS,
	type Tool,
	type ToolCall,
	type ToolDeps,
	tool,
} from "./tool";
import { uploadVideo } from "./upload";
import { singleCheckBelowSeconds, waitFor } from "./wait";

export type {
	Tool,
	ToolCall,
	ToolDeps,
	ToolKind,
	ToolSurface,
} from "./tool";
export { RESOLUTION_TIERS } from "./tool";

export const TRANSCRIPT_MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024;
export const TRANSCRIPT_STATUSES = [
	"uploading",
	"queued",
	"processing",
	"complete",
	"error",
] as const;
export const VIDEO_OUTPUTS = ["all", "hls", "mp4", "any"] as const;
export const MAX_WAIT_SECONDS = 900;
const START_ATTEMPTS = 2;
const MEGABYTE = 1_000_000;

type VideoOutput = (typeof VIDEO_OUTPUTS)[number];

const OUTPUT_LINKS: Record<VideoOutput, readonly ("hlsUrl" | "mp4Url")[]> = {
	all: ["hlsUrl", "mp4Url"],
	hls: ["hlsUrl"],
	mp4: ["mp4Url"],
	any: [],
};

const megabytes = (bytes: number) => (bytes / MEGABYTE).toFixed(1);

const HLS_ADVICE =
	"The HLS link has not arrived since the video became ready and may not be coming. The video plays with mp4Url, shareUrl and embedUrl. If you need adaptive streaming, read the video later with videos_get.";

const MISSING_LINK_ADVICE: Record<
	"local" | "hosted",
	Record<"hlsUrl" | "mp4Url", string>
> = {
	local: {
		mp4Url:
			"The MP4 link has not arrived since the video became ready and may not be coming. The video plays with hlsUrl, shareUrl and embedUrl. An MP4 is needed only for download and for transcripts_create with videoId. If you need one of those, read the video later with videos_get, or transcribe the original file with transcripts_create and path.",
		hlsUrl: HLS_ADVICE,
	},
	hosted: {
		mp4Url:
			"The MP4 link has not arrived since the video became ready and may not be coming. The video plays with hlsUrl, shareUrl and embedUrl. An MP4 is needed only for download and for transcripts_create with videoId. If you need one of those, read the video later with videos_get, or transcribe a public link to the original file with transcripts_create and url.",
		hlsUrl: HLS_ADVICE,
	},
};

const videoCanPlay = (video: Record<string, unknown>) =>
	video.ready === true || video.status === "ready";

const videoIsDownloading = (video: Record<string, unknown>) =>
	asRecord(video.import).state === "downloading";

const videoIsFinal = (video: Record<string, unknown>) =>
	video.status === "errored" ||
	(video.status === "uploading" && !videoIsDownloading(video)) ||
	(videoCanPlay(video) && video.playbackId === null);

const videoId = z.string().min(1).describe("The video id");
const localPath = z
	.string()
	.min(1)
	.optional()
	.describe("Absolute path of an audio or video file on this machine");
const transcriptId = z.string().min(1).describe("The transcript id");
const userScope = z
	.string()
	.min(1)
	.max(255)
	.optional()
	.describe("Only match a video created with exactly this userId");
const limit = z
	.number()
	.int()
	.min(1)
	.max(100)
	.optional()
	.describe("How many to return, 1 to 100 (default 50)");
const offset = z
	.number()
	.int()
	.min(0)
	.optional()
	.describe("How many to skip (default 0)");
const waitSeconds = (
	max: number,
	pollSeconds: number,
	singleCheckBelow: number,
) =>
	z
		.number()
		.int()
		.min(1)
		.max(max)
		.optional()
		.describe(
			`Longest time to wait, in seconds (default and maximum ${max}). Checks are at least ${pollSeconds} seconds apart, so a timeout below ${singleCheckBelow} makes one check and returns at once`,
		);
const metadata = z
	.record(z.string(), z.unknown())
	.optional()
	.describe("Your own JSON object to store with it, under 8 KB");

const waitAgain = (toolName: string) =>
	`Still in progress when the wait ended. Call ${toolName} again to keep waiting.`;

const UPLOADING_NEXT = {
	local:
		"This video has no file yet. Upload one with videos_upload and this videoId, or remove it with videos_delete.",
	hosted:
		"This video has no file yet. Upload one with videos_create_upload and this videoId, or remove it with videos_delete.",
} as const;

export function createTools(deps: ToolDeps): Tool[] {
	const { client, config } = deps;
	const surface = deps.surface ?? "local";
	const local = surface === "local";
	const maxWaitSeconds = deps.maxWaitSeconds ?? MAX_WAIT_SECONDS;
	const timeoutSeconds = waitSeconds(
		maxWaitSeconds,
		deps.wait.pollIntervalMs / 1000,
		singleCheckBelowSeconds(deps.wait),
	);
	const credit = deps.credit ?? creditLinkFor(config.consoleUrl, client);
	const transcript = async (
		fields: Record<string, unknown>,
		text = false,
		signal?: AbortSignal,
	) =>
		transcriptView(
			fields,
			isCreditCode(asRecord(fields.error).code)
				? await credit.resolve(signal)
				: credit.url,
			{ text },
		);

	const waitOutcome = (
		outcome: { settled: boolean; waitedSeconds: number; lastError: unknown },
		toolName: string,
	) =>
		outcome.settled
			? { waitedSeconds: outcome.waitedSeconds }
			: {
					timedOut: true,
					waitedSeconds: outcome.waitedSeconds,
					...(outcome.lastError instanceof Error
						? { lastPollError: outcome.lastError.message }
						: {}),
					next: waitAgain(toolName),
				};

	const transcriptFromFile = async (
		path: string,
		options: Record<string, unknown>,
		headers: Record<string, string> | undefined,
		call: ToolCall,
	) => {
		const file = await inspectFile(path, {
			maxBytes: TRANSCRIPT_MAX_FILE_BYTES,
			what: "a transcript file",
		});
		const created = dataOf(
			await client.call("createTranscriptUpload", {
				body: { fileName: file.fileName, contentLength: file.size, ...options },
				headers,
				signal: call.signal,
			}),
		);
		const id = String(created.id ?? "");
		const target = created.upload === null ? null : asRecord(created.upload);
		if (id === "" || (target !== null && typeof target.url !== "string")) {
			throw new LocalError(
				"unexpected_response",
				"Cap answered in a shape this server does not understand",
				null,
			);
		}
		call.announce("transcript_created", { transcriptId: id });
		if (target === null) return transcript(created, false, call.signal);

		let stored = false;
		try {
			const stream = createReadStream(file.path);
			const put = await storagePut(
				String(target.url),
				Readable.toWeb(stream) as ReadableStream<Uint8Array>,
				{
					headers: Object.fromEntries(
						Object.entries(asRecord(target.headers)).map(([name, value]) => [
							name,
							String(value),
						]),
					),
					signal: call.signal,
					timeoutMs: storageTimeoutMs(file.size),
				},
			).finally(() => stream.destroy());
			if (put.status < 200 || put.status >= 300) {
				throw new LocalError(
					"file_upload_failed",
					`The file could not be stored (status ${put.status})`,
					null,
				);
			}
			stored = true;
			for (let attempt = 1; ; attempt++) {
				try {
					return await transcript(
						dataOf(
							await client.call("startTranscript", { id, signal: call.signal }),
						),
						false,
						call.signal,
					);
				} catch (error) {
					if (!isUnanswered(error) || attempt >= START_ATTEMPTS) throw error;
				}
			}
		} catch (error) {
			const refused = error instanceof ApiError && error.status < 500;
			throw withContext(
				error,
				!stored
					? {
							transcriptId: id,
							transcriptStatus: "uploading",
							next: "The transcript exists without its file, so it has not started and is not charged. Remove it with transcripts_delete, then create it again.",
						}
					: refused
						? {
								transcriptId: id,
								transcriptStatus: "uploading",
								next: "The file is stored but Cap refused to start the transcript, so it is not charged. Fix what the error says, then remove it with transcripts_delete and create it again.",
							}
						: {
								transcriptId: id,
								transcriptStatus: "unknown",
								next: "The file is stored and the transcript may be running, so it may complete and be billed. Check it with transcripts_get or transcripts_wait before anything else. Do not delete it or create it again until you know its status.",
							},
			);
		}
	};

	const videoTranscriptSource = async (
		id: string,
		call: ToolCall,
	): Promise<{ url: string; name: string | undefined }> => {
		const outcome = await waitFor({
			poll: async (deadlineAt) =>
				dataOf(
					await client.call("getVideo", {
						id,
						signal: call.signal,
						deadlineAt,
						once: true,
					}),
				),
			settled: (video) =>
				typeof video.mp4Url === "string" || videoIsFinal(video),
			tuning: deps.wait,
			timeoutMs: deps.wait.mp4WaitMs,
			signal: call.signal,
		});
		const video = outcome.last ?? {};
		if (typeof video.mp4Url !== "string") {
			const context = { videoId: id, videoStatus: video.status ?? "unknown" };
			if (videoCanPlay(video)) {
				throw withContext(
					new LocalError(
						"video_has_no_mp4",
						"This video has no MP4",
						"Transcribe the original file with path, or a public link to it with url.",
					),
					context,
				);
			}
			throw withContext(
				new LocalError(
					"video_not_ready",
					"This video has no MP4 to transcribe yet",
					video.status === "errored"
						? "The video failed to encode, so it has no MP4. Transcribe the original file with path instead."
						: video.status === "uploading"
							? "The video has no file yet. Upload it with videos_upload, or transcribe the original file with path instead."
							: "Call videos_wait until the video is ready, then create the transcript again.",
				),
				context,
			);
		}
		return {
			url: video.mp4Url,
			name: typeof video.name === "string" ? video.name : undefined,
		};
	};

	const tools = [
		tool({
			name: "videos_upload",
			title: "Upload a video",
			description:
				"Upload a local video file to Cap Infra and start encoding it. Returns the video id with its share and embed links; call videos_wait for the playback links once it is ready. Uploading and encoding are free. Stored video is billed by its length and resolution tier: one month when it becomes ready, then daily until it is deleted. Pass videoId to retry a failed upload into the same video.",
			kind: "write",
			input: {
				path: z
					.string()
					.min(1)
					.describe("Absolute path of the video file on this machine"),
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
				metadata,
				durationSeconds: z
					.number()
					.positive()
					.max(4 * 60 * 60)
					.optional()
					.describe(
						"Length of the video if known. Cap measures it after the upload either way",
					),
				videoId: z
					.string()
					.min(1)
					.optional()
					.describe(
						"Retry into this existing video whose upload never completed, instead of creating a new one",
					),
			},
			run: async (args, call) => {
				const uploaded = await uploadVideo(client, deps.upload, args, {
					signal: call.signal,
					onVideo: (id) => call.announce("video_created", { videoId: id }),
					onProgress: call.wantsProgress
						? (sent, total) =>
								call.progress(
									sent,
									total,
									`Uploaded ${megabytes(sent)} of ${megabytes(total)} MB`,
								)
						: undefined,
				});
				return {
					videoId: uploaded.videoId,
					status: "processing",
					bytes: uploaded.bytes,
					...videoLinks(uploaded),
					next: "Call videos_wait with this videoId to get the playback links when encoding finishes.",
				};
			},
		}),
		tool({
			name: "videos_import",
			title: "Import a video from a URL",
			description:
				"Create a video from a public https link to a video file, such as an .mp4 on a CDN or storage bucket (not a page that plays it). Cap downloads and encodes it, so nothing is uploaded from here. Returns the video id with its share and embed links; call videos_wait, which keeps waiting while the file downloads. A link that is not public https, does not answer, is a web page or is over the size limit is refused straight away. The download must finish within 12 minutes; for larger or slower files upload them instead. Billed like an upload.",
			kind: "write",
			input: {
				url: z
					.string()
					.url()
					.max(2048)
					.describe("Public https URL of the video file itself"),
				name: z.string().max(255).optional().describe("Video name"),
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
				metadata,
				idempotencyKey: z
					.string()
					.regex(/^[A-Za-z0-9._-]{8,128}$/)
					.optional()
					.describe(
						"Repeat the same key to get the same video back instead of a second download",
					),
			},
			run: async (args, call) => {
				const { idempotencyKey, ...body } = args;
				const video = dataOf(
					await client.call("importVideo", {
						body,
						headers:
							idempotencyKey === undefined
								? undefined
								: { "Idempotency-Key": idempotencyKey },
						signal: call.signal,
					}),
				);
				const id = String(video.id ?? "");
				call.announce("video_created", { videoId: id });
				return {
					videoId: id,
					status: video.status ?? "uploading",
					...videoImport(video),
					...videoLinks(video),
					next: "Call videos_wait with this videoId to get the playback links once the file is downloaded and encoded.",
				};
			},
		}),
		tool({
			name: "videos_get",
			title: "Get a video",
			description:
				"Get one video: its status, length, playback links (HLS, MP4, poster) and share and embed links. Free to call.",
			kind: "read",
			input: { videoId, userId: userScope },
			run: async (args, call) =>
				videoDetail(
					dataOf(
						await client.call("getVideo", {
							id: args.videoId,
							query: { userId: args.userId },
							signal: call.signal,
						}),
					),
				),
		}),
		tool({
			name: "videos_wait",
			title: "Wait for a video",
			description:
				"Wait until a video has the playback links you need, or has failed, then return its status, length, playback id and HLS, MP4, poster, share and embed links. A video is ready when its first link exists, so by default this allows the other link up to 30 seconds more; set output to wait for one. A result with missing is final: the video plays with the links it has and the missing one may not be coming. If the time runs out before the video is ready, the result has timedOut set with the last known status, so call it again. Free to call.",
			kind: "read",
			input: {
				videoId,
				userId: userScope,
				output: z
					.enum(VIDEO_OUTPUTS)
					.optional()
					.describe(
						"Which playback link must exist before this returns: all (default, HLS and MP4), hls, mp4, or any (as soon as the video can play)",
					),
				timeoutSeconds,
			},
			run: async (args, call) => {
				const needed = OUTPUT_LINKS[args.output ?? "all"];
				let pages: Record<string, unknown> | null = null;
				const firstLook = () => pages ?? {};
				const missing = (video: Record<string, unknown>) =>
					needed.filter((link) => typeof video[link] !== "string");
				let playableAt: number | null = null;
				const outcome = await waitFor({
					poll: async (deadlineAt) => {
						const reply = await client.call(
							pages === null ? "getVideo" : "getVideoStatus",
							{
								id: args.videoId,
								query: { userId: args.userId },
								signal: call.signal,
								deadlineAt,
								once: true,
							},
						);
						const video = dataOf(reply);
						pages ??= video;
						return video;
					},
					settled: (video) => {
						if (videoIsFinal(video)) return true;
						if (!videoCanPlay(video)) return false;
						if (missing(video).length === 0) return true;
						playableAt ??= Date.now();
						return Date.now() - playableAt >= deps.wait.outputGraceMs;
					},
					tuning: deps.wait,
					timeoutMs: (args.timeoutSeconds ?? maxWaitSeconds) * 1000,
					signal: call.signal,
					onPoll: (video, polls) =>
						call.progress(
							polls,
							undefined,
							`Video is ${String(video?.status ?? "unknown")}`,
						),
				});
				const last = outcome.last ?? {};
				const absent =
					videoCanPlay(last) && !videoIsFinal(last) ? missing(last) : [];
				const [firstAbsent] = absent;
				return {
					videoId: args.videoId,
					status: last.status ?? "unknown",
					...(last.errorReason ? { errorReason: last.errorReason } : {}),
					duration: last.duration ?? null,
					durationSeconds: videoDurationSeconds(last),
					...videoLinks({ ...firstLook(), ...last }),
					...(firstAbsent === undefined
						? waitOutcome(outcome, "videos_wait")
						: {
								missing: absent,
								waitedSeconds: outcome.waitedSeconds,
								next: MISSING_LINK_ADVICE[surface][firstAbsent],
							}),
					...videoImport(last),
					...(last.status === "uploading" && !videoIsDownloading(last)
						? {
								next: UPLOADING_NEXT[surface],
							}
						: {}),
				};
			},
		}),
		tool({
			name: "videos_list",
			title: "List videos",
			description:
				"List the app's videos, newest first, with status, length and share link. Filter by userId and page with limit and offset. Free to call.",
			kind: "read",
			input: {
				userId: z
					.string()
					.min(1)
					.max(255)
					.optional()
					.describe("Only videos created with exactly this userId"),
				limit,
				offset,
			},
			run: async (args, call) => {
				const size = args.limit ?? 50;
				const skip = args.offset ?? 0;
				const reply = await client.call("listVideos", {
					query: { userId: args.userId, limit: size, offset: skip },
					signal: call.signal,
				});
				const videos = listOf(reply).map(videoRow);
				return { videos, ...page(reply, size, skip, videos.length) };
			},
		}),
		tool({
			name: "videos_delete",
			title: "Delete a video",
			description:
				"Delete a video and its files for good. This cannot be undone, breaks its playback, share and embed links, and stops its daily storage charge. The first month, charged when it became ready, is not given back.",
			kind: "delete",
			input: { videoId, userId: userScope },
			run: async (args, call) => {
				confirmed(
					await client.call("deleteVideo", {
						id: args.videoId,
						query: { userId: args.userId },
						signal: call.signal,
					}),
				);
				return { videoId: args.videoId, deleted: true };
			},
		}),
		tool({
			name: "transcripts_create",
			title: "Create a transcript",
			description: local
				? "Turn speech into text from exactly one source: url (a public audio or video link), path (a local file up to 2 GB) or videoId (a stored video that is ready). Returns the transcript id; call transcripts_wait for the result. Transcription is billed per audio hour when it completes, and a transcript that fails is not charged."
				: "Turn speech into text from exactly one source: url (a public audio or video link) or videoId (a stored video that is ready, which also gets captions when it completes). Returns the transcript id; call transcripts_wait for the result. Transcription is billed per audio hour when it completes, and a transcript that fails is not charged.",
			kind: "write",
			input: {
				url: z
					.string()
					.min(1)
					.max(2048)
					.optional()
					.describe("Public http or https link to an audio or video file"),
				...(local ? { path: localPath } : {}),
				videoId: z
					.string()
					.min(1)
					.optional()
					.describe(
						"A stored video with status ready, transcribed from its MP4",
					),
				name: z.string().max(255).optional().describe("Display name"),
				language: z
					.string()
					.max(16)
					.optional()
					.describe(
						"Language of the audio as a two-letter code such as en, if known. Leave out to detect it",
					),
				userId: z
					.string()
					.min(1)
					.max(255)
					.optional()
					.describe(
						"Your own user id for this transcript, used to filter lists. With videoId, leave it out to use the video's userId",
					),
				metadata,
				idempotencyKey: z
					.string()
					.regex(/^[A-Za-z0-9._-]{8,128}$/)
					.optional()
					.describe(
						"Repeat the same key to get the same transcript back instead of a second, billed one",
					),
			},
			run: async (args, call) => {
				const path = typeof args.path === "string" ? args.path : undefined;
				const sources = [args.url, path, args.videoId].filter(
					(source) => source !== undefined,
				);
				if (sources.length !== 1) {
					throw new ApiError(
						400,
						"invalid_source",
						local
							? "Send exactly one of url, path or videoId"
							: "Send exactly one of url or videoId",
						local
							? "Use url for a public audio or video link, path for a file on this machine, or videoId for a ready video in this app. Send only one of them."
							: "Use url for a public audio or video link, or videoId for a ready video in this app. Send only one of them.",
					);
				}
				const headers =
					args.idempotencyKey === undefined
						? undefined
						: { "Idempotency-Key": args.idempotencyKey };
				const options = {
					...(args.name === undefined ? {} : { name: args.name }),
					...(args.language === undefined ? {} : { language: args.language }),
					...(args.userId === undefined ? {} : { userId: args.userId }),
				};
				const next =
					"Call transcripts_wait with this id, then transcripts_text for the text.";

				if (path !== undefined) {
					return {
						...(await transcriptFromFile(
							path,
							{
								...options,
								...(args.metadata === undefined
									? {}
									: { metadata: args.metadata }),
							},
							headers,
							call,
						)),
						next,
					};
				}

				if (!local && args.videoId !== undefined) {
					const created = dataOf(
						await client.call("createTranscript", {
							body: {
								videoId: args.videoId,
								...options,
								...(args.metadata === undefined
									? {}
									: { metadata: args.metadata }),
							},
							headers,
							signal: call.signal,
						}),
					);
					return { ...(await transcript(created, false, call.signal)), next };
				}

				const fromVideo =
					args.videoId === undefined
						? null
						: await videoTranscriptSource(args.videoId, call);
				const url = fromVideo?.url ?? args.url;
				const name = args.name ?? fromVideo?.name;
				const stored =
					args.videoId === undefined
						? args.metadata
						: { ...args.metadata, videoId: args.videoId };

				const created = dataOf(
					await client.call("createTranscript", {
						body: {
							url,
							...options,
							...(name === undefined ? {} : { name }),
							...(stored === undefined ? {} : { metadata: stored }),
						},
						headers,
						signal: call.signal,
					}),
				);
				return { ...(await transcript(created, false, call.signal)), next };
			},
		}),
		tool({
			name: "transcripts_get",
			title: "Get a transcript",
			description:
				"Get one transcript: status, length, word count, cost and, once complete, its text. Set words or segments to add timings in seconds. Free to call.",
			kind: "read",
			input: {
				transcriptId,
				words: z
					.boolean()
					.optional()
					.describe("Include every word with start and end times"),
				segments: z
					.boolean()
					.optional()
					.describe("Include sentence-sized segments with start and end times"),
			},
			run: async (args, call) => {
				const include = [
					args.words ? "words" : null,
					args.segments ? "segments" : null,
				].filter((part) => part !== null);
				const found = dataOf(
					await client.call("getTranscript", {
						id: args.transcriptId,
						query: {
							include: include.length > 0 ? include.join(",") : undefined,
						},
						signal: call.signal,
					}),
				);
				return {
					...(await transcript(found, true, call.signal)),
					...(args.words ? { words: found.words ?? null } : {}),
					...(args.segments ? { segments: found.segments ?? null } : {}),
					...captionsNext(found),
				};
			},
		}),
		tool({
			name: "transcripts_wait",
			title: "Wait for a transcript",
			description:
				"Wait until a transcript is complete or has failed, then return its status, length, word count and cost, without the text. If the time runs out, the result has timedOut set with the last known status, so call it again. Free to call.",
			kind: "read",
			input: { transcriptId, timeoutSeconds },
			run: async (args, call) => {
				const outcome = await waitFor({
					poll: async (deadlineAt) =>
						dataOf(
							await client.call("getTranscript", {
								id: args.transcriptId,
								signal: call.signal,
								deadlineAt,
								once: true,
							}),
						),
					settled: (found) =>
						found.status === "complete" ||
						found.status === "error" ||
						found.status === "uploading",
					tuning: deps.wait,
					timeoutMs: (args.timeoutSeconds ?? maxWaitSeconds) * 1000,
					signal: call.signal,
					onPoll: (found, polls) =>
						call.progress(
							polls,
							undefined,
							`Transcript is ${String(found?.status ?? "unknown")}`,
						),
				});
				const last = outcome.last;
				return {
					...(last === null
						? { id: args.transcriptId, status: "unknown" }
						: await transcript(last, false, call.signal)),
					...waitOutcome(outcome, "transcripts_wait"),
					...(outcome.settled && last !== null ? captionsNext(last) : {}),
					...(last?.status === "uploading"
						? {
								next: "This transcript never received its file. Remove it with transcripts_delete, then create it again.",
							}
						: {}),
				};
			},
		}),
		tool({
			name: "transcripts_text",
			title: "Get transcript text",
			description:
				"Get only the text of a complete transcript. The text is null until the transcript is complete, and empty when the audio has no speech. Free to call.",
			kind: "read",
			input: { transcriptId },
			run: async (args, call) => {
				const found = dataOf(
					await client.call("getTranscript", {
						id: args.transcriptId,
						signal: call.signal,
					}),
				);
				return {
					id: found.id ?? args.transcriptId,
					status: found.status ?? "unknown",
					text: found.status === "complete" ? (found.text ?? "") : null,
					...(found.status === "error" && found.error !== null
						? { error: asRecord(found.error) }
						: {}),
					...(found.status === "complete" || found.status === "error"
						? {}
						: {
								next: "The transcript is not complete yet, so there is no text. Call transcripts_wait with this id, then transcripts_text again.",
							}),
				};
			},
		}),
		tool({
			name: "transcripts_list",
			title: "List transcripts",
			description:
				"List the app's transcripts, newest first, without their text. Filter by userId or status and page with limit and offset. Free to call.",
			kind: "read",
			input: {
				userId: z
					.string()
					.min(1)
					.max(255)
					.optional()
					.describe("Only transcripts created with exactly this userId"),
				status: z
					.enum(TRANSCRIPT_STATUSES)
					.optional()
					.describe("Only transcripts in this status"),
				limit,
				offset,
			},
			run: async (args, call) => {
				const size = args.limit ?? 50;
				const skip = args.offset ?? 0;
				const reply = await client.call("listTranscripts", {
					query: {
						userId: args.userId,
						status: args.status,
						limit: size,
						offset: skip,
					},
					signal: call.signal,
				});
				const transcripts = await Promise.all(
					listOf(reply).map((row) => transcript(row, false, call.signal)),
				);
				return { transcripts, ...page(reply, size, skip, transcripts.length) };
			},
		}),
		tool({
			name: "transcripts_delete",
			title: "Delete a transcript",
			description:
				"Delete a transcript, its text and its stored files for good. This cannot be undone. A transcript deleted before it completes is not charged.",
			kind: "delete",
			input: { transcriptId },
			run: async (args, call) => {
				confirmed(
					await client.call("deleteTranscript", {
						id: args.transcriptId,
						signal: call.signal,
					}),
				);
				return { transcriptId: args.transcriptId, deleted: true };
			},
		}),
		tool({
			name: "account_usage",
			title: "Get usage and balance",
			description:
				"Get the app's credit balance, standing, whether it can take an upload, stored minutes, what storage costs per day and the current rates. When the app needs credit, the result carries addCreditAt with the console link, because credit cannot be added through this server. Free to call.",
			kind: "read",
			input: {},
			run: async (_args, call) => {
				const usage = dataOf(
					await client.call("getUsage", { signal: call.signal }),
				);
				credit.learn(usage);
				const standing = asRecord(usage.standing).state;
				const needsCredit =
					asRecord(usage.upload).allowed === false ||
					standing === "grace" ||
					standing === "paused";
				return {
					...usage,
					...(typeof usage.totalDurationMinutes === "number"
						? {
								totalDurationMinutes:
									Math.round(usage.totalDurationMinutes * 100) / 100,
							}
						: {}),
					...(needsCredit ? { addCreditAt: credit.url } : {}),
				};
			},
		}),
		tool({
			name: "account_transactions",
			title: "List transactions",
			description:
				"List the app's ledger, newest first: every credit added and every charge taken, with the balance after each. Free to call.",
			kind: "read",
			input: { limit, offset },
			run: async (args, call) => {
				const size = args.limit ?? 50;
				const skip = args.offset ?? 0;
				const reply = await client.call("listTransactions", {
					query: { limit: size, offset: skip },
					signal: call.signal,
				});
				const transactions = listOf(reply).map(transactionRow);
				return {
					transactions,
					...page(reply, size, skip, transactions.length),
				};
			},
		}),
		createDocsTool(config.apiUrl, deps.docs ?? fetchDocs(config.apiUrl)),
	];

	if (local) return tools;
	return [
		...createHostedUploadTools(deps),
		...tools.filter((entry) => entry.name !== "videos_upload"),
	];
}
