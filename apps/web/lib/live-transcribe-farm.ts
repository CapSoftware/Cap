import { randomUUID } from "node:crypto";
import { db } from "@cap/database";
import { organizations, videos } from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import { Storage } from "@cap/web-backend/src/Storage/index";
import {
	type AiGenerationLanguage,
	parseAiGenerationLanguage,
	Video,
} from "@cap/web-domain";
import { and, eq, sql } from "drizzle-orm";
import { Option } from "effect";
import {
	ASSEMBLYAI_SUPPORTED_LANGUAGES,
	getAssemblyAITranscriptionOptions,
} from "@/lib/assemblyai";
import {
	LIVE_TRANSCRIPT_NO_SEGMENTS,
	type LiveTranscriptArtifact,
} from "@/lib/live-transcribe-core";
import {
	isCanonicalTranscriptDone,
	type LiveBucket,
	liveContextSeconds,
	liveSessionMatches,
	readLiveTranscript,
} from "@/lib/live-transcribe-runner";
import { decodeStorageVideo } from "@/lib/video-storage";
import { runWorkflowPromise } from "@/lib/workflow-runtime";

/**
 * Live transcription on the media server. The server holds one session per
 * recording: it watches the segment manifest, sends new audio to the
 * transcription API, and reports each chunk's words to
 * /api/webhooks/media-server/live-transcribe, which owns the artifact, the
 * claim, and promotion. Every report answers with fresh state, so the server
 * never needs storage credentials or database access.
 */

/** Segments signed behind the cursor, enough for the context audio. */
const SIGNED_SEGMENTS_BEHIND = 16;
/** Segments signed ahead of the cursor, more than one chunk can take. */
const SIGNED_SEGMENTS_AHEAD = 40;
const SIGNED_URL_EXPIRES_SECONDS = 60 * 60;
const START_TIMEOUT_MS = 5_000;
const START_ATTEMPTS = 2;

/** Stored in the claim instead of a session id once the workflow runs it,
 * which also fences off any media server session that may have started. */
export const WORKFLOW_LIVE_SESSION = "workflow";

export type LiveSessionState = {
	lastAudioSegmentIndex: number;
	transcribedDurationMs: number;
	transcriptionOptions: Record<string, unknown>;
	urls: {
		manifest: string;
		audioInit: string;
		segments: Record<string, string>;
	};
};

type LiveVideoRow = {
	video: typeof videos.$inferSelect;
	orgSettings: (typeof organizations.$inferSelect)["settings"] | null;
};

export function isFarmLiveTranscriptionEnabled() {
	const env = serverEnv();
	return (
		env.LIVE_TRANSCRIBE_RUNNER === "media-server" &&
		Boolean(env.MEDIA_SERVER_URL) &&
		Boolean(env.MEDIA_SERVER_WEBHOOK_SECRET) &&
		Boolean(env.ASSEMBLY_API_KEY)
	);
}

export async function loadLiveVideo(
	videoId: string,
): Promise<LiveVideoRow | null> {
	const [row] = await db()
		.select({ video: videos, orgSettings: organizations.settings })
		.from(videos)
		.leftJoin(organizations, eq(videos.orgId, organizations.id))
		.where(eq(videos.id, videoId as Video.VideoId));
	return row ?? null;
}

export function getLiveSession(video: typeof videos.$inferSelect) {
	const live = video.metadata?.liveTranscript as
		| { status?: string; session?: string }
		| undefined;
	return live?.status === "active" ? (live.session ?? null) : null;
}

export function liveTranscriptionEnded(row: LiveVideoRow): string | null {
	if (row.video.source.type !== "desktopSegments") {
		return "not a segmented recording";
	}
	if (
		row.video.settings?.disableTranscript ??
		row.orgSettings?.disableTranscript
	) {
		return "transcription disabled";
	}
	if (isCanonicalTranscriptDone(row.video.transcriptionStatus)) {
		return "canonical transcript already exists";
	}
	return null;
}

export async function getFarmLiveBucket(
	video: typeof videos.$inferSelect,
): Promise<LiveBucket | null> {
	const [bucket, customBucket] = await Storage.getAccessForVideo(
		decodeStorageVideo(video),
	).pipe(runWorkflowPromise);
	// Signed URLs for Cap's own bucket only; Drive and customer buckets stay
	// on the workflow, which reads them through their own access.
	return bucket.provider === "s3" && Option.isNone(customBucket)
		? bucket
		: null;
}

export async function buildLiveSessionState(options: {
	bucket: LiveBucket;
	video: typeof videos.$inferSelect;
	orgSettings: LiveVideoRow["orgSettings"];
	artifact: LiveTranscriptArtifact | null;
}): Promise<LiveSessionState> {
	const { bucket, video, artifact } = options;
	const source = new Video.SegmentsSource({
		videoId: video.id,
		ownerId: video.ownerId,
	});
	const lastAudioSegmentIndex =
		artifact?.lastAudioSegmentIndex ?? LIVE_TRANSCRIPT_NO_SEGMENTS;
	const sign = (key: string) =>
		bucket
			.getInternalSignedObjectUrl(key, {
				expiresIn: SIGNED_URL_EXPIRES_SECONDS,
			})
			.pipe(runWorkflowPromise);

	const first = Math.max(0, lastAudioSegmentIndex + 1 - SIGNED_SEGMENTS_BEHIND);
	const last = lastAudioSegmentIndex + SIGNED_SEGMENTS_AHEAD;
	const indices = Array.from(
		{ length: last - first + 1 },
		(_, offset) => first + offset,
	);
	const [manifest, audioInit, ...segmentUrls] = await Promise.all([
		sign(source.getManifestKey()),
		sign(source.getAudioInitKey()),
		...indices.map((index) => sign(source.getAudioSegmentKey(index))),
	]);
	const segments: Record<string, string> = {};
	for (const [offset, index] of indices.entries()) {
		const url = segmentUrls[offset];
		if (url) segments[String(index)] = url;
	}

	const preferred =
		artifact?.languageCode ??
		parseAiGenerationLanguage(options.orgSettings?.aiGenerationLanguage);
	const language = (
		ASSEMBLYAI_SUPPORTED_LANGUAGES as readonly string[]
	).includes(preferred)
		? (preferred as AiGenerationLanguage)
		: ("auto" as AiGenerationLanguage);

	return {
		lastAudioSegmentIndex,
		transcribedDurationMs: artifact?.transcribedDurationMs ?? 0,
		transcriptionOptions: getAssemblyAITranscriptionOptions(language),
		urls: { manifest: manifest ?? "", audioInit: audioInit ?? "", segments },
	};
}

const getAffectedRows = (result: unknown) => {
	if (Array.isArray(result)) {
		return (
			(result[0] as { affectedRows?: number } | undefined)?.affectedRows ?? 0
		);
	}
	return (result as { affectedRows?: number } | undefined)?.affectedRows ?? 0;
};

/**
 * Move the active claim from `from` (null: no session yet) to `to`. Exactly
 * one caller wins, so two runners can never both own a recording.
 */
export async function rotateLiveSession(
	videoId: string,
	from: string | null,
	to: string,
): Promise<boolean> {
	const result = await db()
		.update(videos)
		.set({
			metadata: sql`JSON_SET(COALESCE(${videos.metadata}, JSON_OBJECT()), '$.liveTranscript.session', ${to}, '$.liveTranscript.updatedAt', ${new Date().toISOString()})`,
			updatedAt: sql`${videos.updatedAt}`,
		})
		.where(
			and(
				eq(videos.id, videoId as Video.VideoId),
				sql`JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.liveTranscript.status')) = 'active'`,
				from === null
					? sql`JSON_EXTRACT(${videos.metadata}, '$.liveTranscript.session') IS NULL`
					: liveSessionMatches(from),
			),
		);
	return getAffectedRows(result) > 0;
}

export type FarmLiveStart =
	| { status: "started" }
	/** Another caller moved the claim first; it owns the recording now. */
	| { status: "lost" }
	/** Not handed over. `session` is the claim's session now: a declined
	 * start after rotation leaves a fresh id that no server holds, so the
	 * workflow can take over without racing a server that accepted after
	 * the timeout. */
	| { status: "declined"; session: string | null };

export async function startFarmLiveTranscription(
	videoId: string,
	from: string | null,
): Promise<FarmLiveStart> {
	if (!isFarmLiveTranscriptionEnabled()) {
		return { status: "declined", session: from };
	}

	const row = await loadLiveVideo(videoId);
	if (!row || liveTranscriptionEnded(row)) {
		return { status: "declined", session: from };
	}
	const bucket = await getFarmLiveBucket(row.video);
	if (!bucket) return { status: "declined", session: from };

	const session = randomUUID();
	if (!(await rotateLiveSession(videoId, from, session))) {
		return { status: "lost" };
	}

	const env = serverEnv();
	try {
		const artifact = await readLiveTranscript(
			bucket,
			row.video.ownerId,
			videoId,
		);
		const state = await buildLiveSessionState({
			bucket,
			video: row.video,
			orgSettings: row.orgSettings,
			artifact,
		});
		const webhookBaseUrl = env.MEDIA_SERVER_WEBHOOK_URL || env.WEB_URL;
		const body = JSON.stringify({
			videoId,
			session,
			callbackUrl: new URL(
				"/api/webhooks/media-server/live-transcribe",
				webhookBaseUrl,
			).toString(),
			asr: {
				baseUrl: env.ASSEMBLY_BASE_URL || "https://api.assemblyai.com",
				apiKey: env.ASSEMBLY_API_KEY,
			},
			contextSeconds: liveContextSeconds(),
			state,
		});

		for (let attempt = 0; attempt < START_ATTEMPTS; attempt++) {
			try {
				const response = await fetch(
					`${(env.MEDIA_SERVER_URL as string).replace(/\/$/, "")}/live-transcribe/sessions`,
					{
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							"x-media-server-secret":
								env.MEDIA_SERVER_WEBHOOK_SECRET as string,
						},
						body,
						signal: AbortSignal.timeout(START_TIMEOUT_MS),
					},
				);
				await response.body?.cancel().catch(() => {});
				if (response.ok) return { status: "started" };
				// A busy or draining server refused it, so another try under the
				// same session can't duplicate it; the load balancer usually
				// picks another server.
				if (response.status !== 503) break;
			} catch {
				// A timed-out start may still have been accepted: never resend it.
				break;
			}
		}
	} catch (error) {
		console.warn(
			`[liveTranscribe] Media server start failed for ${videoId}`,
			error,
		);
	}

	return { status: "declined", session };
}
