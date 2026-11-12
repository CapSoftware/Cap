import type { TranscriptErrorCode } from "@/lib/developer-transcripts";

export type TranscriptRequestError = {
	status: 400 | 402 | 403 | 404 | 409 | 503;
	code: string;
	meaning: string;
};

export const TRANSCRIPT_REQUEST_ERRORS = [
	{
		status: 400,
		code: "invalid_url",
		meaning:
			"The URL is missing, longer than 2,048 characters, not http or https, on a port other than the default, or carries a username or password",
	},
	{
		status: 400,
		code: "url_not_public",
		meaning: "The URL points to a private or local address",
	},
	{
		status: 400,
		code: "invalid_name",
		meaning: "The name is longer than 255 characters",
	},
	{
		status: 400,
		code: "invalid_language",
		meaning:
			"The language is not auto or one of the supported codes. The hint lists them",
	},
	{
		status: 400,
		code: "invalid_user_id",
		meaning: "The user ID is longer than 255 characters",
	},
	{
		status: 400,
		code: "invalid_metadata",
		meaning: "The metadata is not a JSON object under 8 KB",
	},
	{
		status: 400,
		code: "invalid_content_length",
		meaning: "contentLength is not a whole number of bytes from 1 to 2 GB",
	},
	{
		status: 400,
		code: "invalid_file_name",
		meaning: "The file name is longer than 255 characters",
	},
	{
		status: 400,
		code: "file_too_large",
		meaning: "The uploaded file is larger than 2 GB",
	},
	{
		status: 400,
		code: "invalid_idempotency_key",
		meaning:
			"The Idempotency-Key is not 8 to 128 characters of letters, digits, dot, dash and underscore",
	},
	{
		status: 400,
		code: "invalid_status",
		meaning: "The status filter is not one of the transcript statuses",
	},
	{
		status: 400,
		code: "invalid_include",
		meaning:
			"include has a value other than words or segments. The message names it",
	},
	{
		status: 402,
		code: "out_of_credit",
		meaning:
			"The app is in grace or paused because a daily storage charge could not be paid. The message says how much to add",
	},
	{
		status: 402,
		code: "insufficient_credits",
		meaning:
			"The available balance is under $0.01. The message says how much to add",
	},
	{
		status: 403,
		code: "infra_not_available",
		meaning: "Cap Infra is not enabled for this account",
	},
	{
		status: 404,
		code: "transcript_not_found",
		meaning: "No transcript with this ID belongs to the app",
	},
	{
		status: 409,
		code: "idempotency_conflict",
		meaning:
			"The Idempotency-Key was already used with a different request, or for a transcript that was deleted. The message names the field that differs",
	},
	{
		status: 409,
		code: "upload_not_found",
		meaning:
			"The file has not been uploaded yet. If the upload URL expired, repeat the create request with the same Idempotency-Key to get a new one",
	},
	{
		status: 503,
		code: "speech_unavailable",
		meaning: "Transcription is temporarily unavailable. Retry later",
	},
] as const satisfies readonly TranscriptRequestError[];

export const TRANSCRIPT_FAILURE_CODES = [
	{
		code: "insufficient_credits",
		meaning:
			"The available balance could not cover the hold for the transcript, or the transcript itself. The message says how much was needed",
	},
	{
		code: "source_unreachable",
		meaning:
			"The URL could not be downloaded: it answered with an error, redirected too many times, ended early, or did not finish within 15 minutes. The message says which",
	},
	{
		code: "source_blocked",
		meaning:
			"The URL, or a redirect from it, did not point to a public address",
	},
	{ code: "source_too_large", meaning: "The file is larger than 2 GB" },
	{ code: "source_missing", meaning: "The uploaded file was not found" },
	{ code: "no_audio_track", meaning: "The file has no audio" },
	{
		code: "unsupported_format",
		meaning:
			"The file is not a self-contained audio or video file. Playlists and manifests are not accepted",
	},
	{
		code: "no_speech",
		meaning:
			"No longer returned. Audio with no speech now completes with empty text. Transcripts that failed this way before the change keep the code",
	},
	{
		code: "duration_too_long",
		meaning: "The audio is longer than 4 hours",
	},
	{
		code: "upload_expired",
		meaning: "The file was not uploaded within 24 hours",
	},
	{ code: "timed_out", meaning: "The transcript did not finish in time" },
	{ code: "transcription_failed", meaning: "Anything else" },
] as const satisfies readonly {
	code: TranscriptErrorCode;
	meaning: string;
}[];

export const transcriptRequestErrorsText = () =>
	TRANSCRIPT_REQUEST_ERRORS.map(
		(error) => `${error.status} ${error.code}: ${error.meaning}.`,
	).join(" ");

export const transcriptFailureCodesText = () =>
	TRANSCRIPT_FAILURE_CODES.map(
		(failure) => `${failure.code}: ${failure.meaning}.`,
	).join(" ");
