import { createHash } from "node:crypto";
import type { VideoMetadata } from "@cap/database/types";
import type { Agent } from "@cap/web-domain";

export type AgentCursor = {
	updatedAt: string;
	id: string;
};

export type AgentCapabilityInput = {
	isOwner: boolean;
	hasReadScope: boolean;
	hasCommentScope: boolean;
	hasWriteScope: boolean;
	hasProcessScope: boolean;
	hasDeleteScope: boolean;
	passwordRequired: boolean;
	transcriptStatus: string | null;
	hasSummary: boolean;
	hasChapters: boolean;
	settings: {
		disableSummary: boolean;
		disableChapters: boolean;
		disableTranscript: boolean;
		disableComments: boolean;
		disableReactions: boolean;
	};
};

const capability = (
	allowed: boolean,
	reason: (typeof Agent.CapabilityReason)["Type"] | null = null,
): (typeof Agent.AgentCapability)["Type"] => ({ allowed, reason });

export const parseAgentLimit = (value: string | undefined) => {
	if (!value) return 50;
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 1) return null;
	return Math.min(parsed, 100);
};

export const escapeAgentLikePattern = (value: string) =>
	value.replace(/[!%_]/g, (match) => `!${match}`);

export const isAgentHttpUrl = (value: string) => {
	try {
		const url = new URL(value);
		return (
			(url.protocol === "http:" || url.protocol === "https:") &&
			url.hostname.length > 0
		);
	} catch {
		return false;
	}
};

const parseAgentUtcDate = (value: string) => {
	const match = value.match(
		/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/,
	);
	if (!match) return undefined;
	const parsed = new Date(value);
	if (Number.isNaN(parsed.valueOf())) return undefined;
	const normalized = `${match[1]}.${(match[2] ?? "").padEnd(3, "0")}Z`;
	return parsed.toISOString() === normalized ? parsed : undefined;
};

export const parseAgentDate = (value: string | undefined) => {
	if (!value) return null;
	return parseAgentUtcDate(value);
};

export const encodeAgentCursor = (cursor: AgentCursor) =>
	Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");

export const decodeAgentCursor = (value: string | undefined) => {
	if (!value) return null;
	if (value.length > 1_024) return undefined;
	try {
		const parsed: unknown = JSON.parse(
			Buffer.from(value, "base64url").toString("utf8"),
		);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return undefined;
		}
		const { updatedAt, id } = parsed as Record<string, unknown>;
		if (
			typeof updatedAt !== "string" ||
			typeof id !== "string" ||
			!/^[A-Za-z0-9_-]{5,128}$/.test(id)
		) {
			return undefined;
		}
		const date = parseAgentUtcDate(updatedAt);
		if (!date) return undefined;
		return { updatedAt: date.toISOString(), id } satisfies AgentCursor;
	} catch {
		return undefined;
	}
};

const parseVttTimestamp = (value: string) => {
	const match = value.trim().match(/^(\d{1,3}):(\d{2}):(\d{2})[.,](\d{3})$/);
	if (!match) return null;
	const hours = Number(match[1]);
	const minutes = Number(match[2]);
	const seconds = Number(match[3]);
	const milliseconds = Number(match[4]);
	if (minutes > 59 || seconds > 59) return null;
	return ((hours * 60 + minutes) * 60 + seconds) * 1000 + milliseconds;
};

const stripVttCueTags = (value: string) => {
	const text: string[] = [];
	let insideTag = false;

	for (const character of value) {
		if (character === "<") {
			insideTag = true;
			continue;
		}
		if (insideTag) {
			if (character === ">") insideTag = false;
			continue;
		}
		text.push(character);
	}

	return text.join("");
};

const normalizeCueText = (lines: string[]) =>
	stripVttCueTags(lines.join("\n")).trim();

export const parseAgentVtt = (
	vtt: string,
): (typeof Agent.AgentTranscriptCue)["Type"][] => {
	const lines = vtt.replace(/\r\n?/g, "\n").split("\n");
	const cues: (typeof Agent.AgentTranscriptCue)["Type"][] = [];

	for (let index = 0; index < lines.length; index++) {
		const line = lines[index]?.trim() ?? "";
		if (!line.includes("-->")) continue;
		const [startValue, rawEnd] = line.split("-->");
		const endValue = rawEnd?.trim().split(/\s+/)[0];
		if (!startValue || !endValue) continue;
		const startMs = parseVttTimestamp(startValue);
		const endMs = parseVttTimestamp(endValue);
		if (startMs === null || endMs === null || endMs < startMs) continue;

		const textLines: string[] = [];
		for (let cueIndex = index + 1; cueIndex < lines.length; cueIndex++) {
			const cueLine = lines[cueIndex] ?? "";
			if (!cueLine.trim()) {
				index = cueIndex;
				break;
			}
			if (cueLine.includes("-->")) {
				index = cueIndex - 1;
				break;
			}
			textLines.push(cueLine);
			if (cueIndex === lines.length - 1) index = cueIndex;
		}

		const text = normalizeCueText(textLines);
		if (text) cues.push({ startMs, endMs, text });
	}

	return cues;
};

export const transcriptTextFromCues = (
	cues: ReadonlyArray<(typeof Agent.AgentTranscriptCue)["Type"]>,
) => cues.map((cue) => cue.text).join("\n");

const formatVttTimestamp = (milliseconds: number) => {
	const hours = Math.floor(milliseconds / 3_600_000);
	const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
	const seconds = Math.floor((milliseconds % 60_000) / 1_000);
	const remainder = milliseconds % 1_000;
	return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}.${remainder.toString().padStart(3, "0")}`;
};

export const renderAgentVtt = (
	cues: ReadonlyArray<(typeof Agent.AgentTranscriptCue)["Type"]>,
) =>
	[
		"WEBVTT",
		"",
		...cues.flatMap((cue, index) => [
			String(index + 1),
			`${formatVttTimestamp(cue.startMs)} --> ${formatVttTimestamp(cue.endMs)}`,
			cue.text.replace(/\s+/g, " ").trim(),
			"",
		]),
	].join("\n");

export const agentTranscriptRevision = (vtt: string) =>
	createHash("sha256").update(vtt, "utf8").digest("hex");

export const normalizeAgentMetadata = (metadata: unknown) => {
	if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
		return {} as VideoMetadata;
	}
	return metadata as VideoMetadata;
};

export const agentCapabilities = ({
	isOwner,
	hasReadScope,
	hasCommentScope,
	hasWriteScope,
	hasProcessScope,
	hasDeleteScope,
	passwordRequired,
	transcriptStatus,
	hasSummary,
	hasChapters,
	settings,
}: AgentCapabilityInput): (typeof Agent.AgentCapabilities)["Type"] => {
	if (passwordRequired) {
		const locked = capability(false, "PASSWORD_REQUIRED");
		return {
			view: locked,
			summary: locked,
			chapters: locked,
			transcript: locked,
			comments: locked,
			reactions: locked,
			download: locked,
			comment: locked,
			react: locked,
			editTitle: isOwner && hasWriteScope ? capability(true) : locked,
			editVisibility: isOwner && hasWriteScope ? capability(true) : locked,
			processTranscript: isOwner && hasProcessScope ? capability(true) : locked,
			processAi: isOwner && hasProcessScope ? capability(true) : locked,
			editTranscript: isOwner && hasWriteScope ? capability(true) : locked,
			editPassword: isOwner && hasWriteScope ? capability(true) : locked,
			duplicate: isOwner && hasWriteScope ? capability(true) : locked,
			delete: isOwner && hasDeleteScope ? capability(true) : locked,
		};
	}

	const summary = !hasReadScope
		? capability(false, "SCOPE_REQUIRED")
		: settings.disableSummary
			? capability(false, "CONTENT_DISABLED")
			: hasSummary
				? capability(true)
				: capability(false, "NOT_READY");
	const chapters = !hasReadScope
		? capability(false, "SCOPE_REQUIRED")
		: settings.disableChapters
			? capability(false, "CONTENT_DISABLED")
			: hasChapters
				? capability(true)
				: capability(false, "NOT_READY");
	const transcript = !hasReadScope
		? capability(false, "SCOPE_REQUIRED")
		: settings.disableTranscript
			? capability(false, "CONTENT_DISABLED")
			: transcriptStatus === "COMPLETE"
				? capability(true)
				: capability(false, "NOT_READY");
	const comments = settings.disableComments
		? capability(false, "CONTENT_DISABLED")
		: capability(true);
	const reactions = settings.disableReactions
		? capability(false, "CONTENT_DISABLED")
		: capability(true);

	return {
		view: hasReadScope ? capability(true) : capability(false, "SCOPE_REQUIRED"),
		summary,
		chapters,
		transcript,
		comments,
		reactions,
		download: hasReadScope
			? capability(true)
			: capability(false, "SCOPE_REQUIRED"),
		comment: settings.disableComments
			? capability(false, "CONTENT_DISABLED")
			: hasCommentScope
				? capability(true)
				: capability(false, "SCOPE_REQUIRED"),
		react: settings.disableReactions
			? capability(false, "CONTENT_DISABLED")
			: hasCommentScope
				? capability(true)
				: capability(false, "SCOPE_REQUIRED"),
		editTitle: !isOwner
			? capability(false, "OWNER_ONLY")
			: hasWriteScope
				? capability(true)
				: capability(false, "SCOPE_REQUIRED"),
		editVisibility: !isOwner
			? capability(false, "OWNER_ONLY")
			: hasWriteScope
				? capability(true)
				: capability(false, "SCOPE_REQUIRED"),
		processTranscript: !isOwner
			? capability(false, "OWNER_ONLY")
			: settings.disableTranscript
				? capability(false, "CONTENT_DISABLED")
				: hasProcessScope
					? capability(true)
					: capability(false, "SCOPE_REQUIRED"),
		processAi: !isOwner
			? capability(false, "OWNER_ONLY")
			: !hasProcessScope
				? capability(false, "SCOPE_REQUIRED")
				: transcriptStatus === "COMPLETE"
					? capability(true)
					: capability(false, "NOT_READY"),
		editTranscript: !isOwner
			? capability(false, "OWNER_ONLY")
			: settings.disableTranscript
				? capability(false, "CONTENT_DISABLED")
				: !hasWriteScope
					? capability(false, "SCOPE_REQUIRED")
					: transcriptStatus === "COMPLETE"
						? capability(true)
						: capability(false, "NOT_READY"),
		editPassword: !isOwner
			? capability(false, "OWNER_ONLY")
			: hasWriteScope
				? capability(true)
				: capability(false, "SCOPE_REQUIRED"),
		duplicate: !isOwner
			? capability(false, "OWNER_ONLY")
			: hasWriteScope
				? capability(true)
				: capability(false, "SCOPE_REQUIRED"),
		delete: !isOwner
			? capability(false, "OWNER_ONLY")
			: hasDeleteScope
				? capability(true)
				: capability(false, "SCOPE_REQUIRED"),
	};
};

const processState = (
	status: (typeof Agent.AgentProcessState)["Type"]["status"],
	reason: string | null = null,
	retryable = false,
): (typeof Agent.AgentProcessState)["Type"] => ({
	status,
	reason,
	retryable,
});

const normalizeTranscriptStatus = (status: string | null) => {
	switch (status) {
		case "PROCESSING":
			return processState("processing");
		case "COMPLETE":
			return processState("complete");
		case "ERROR":
			return processState("error", "TRANSCRIPTION_FAILED", true);
		case "SKIPPED":
			return processState("skipped", "TRANSCRIPTION_SKIPPED");
		case "NO_AUDIO":
			return processState("no_audio", "NO_AUDIO");
		default:
			return processState("not_started", "NOT_REQUESTED");
	}
};

const normalizeAiStatus = (status: string | undefined) => {
	switch (status) {
		case "QUEUED":
			return processState("queued");
		case "PROCESSING":
			return processState("processing");
		case "COMPLETE":
			return processState("complete");
		case "ERROR":
			return processState("error", "AI_GENERATION_FAILED", true);
		case "SKIPPED":
			return processState("skipped", "AI_GENERATION_SKIPPED");
		default:
			return processState("not_started", "NOT_REQUESTED");
	}
};

const normalizeUploadStatus = (input: {
	phase: string | null;
	error: string | null;
}) => {
	switch (input.phase) {
		case "uploading":
		case "processing":
		case "generating_thumbnail":
			return processState("processing");
		case "error":
			return processState("error", input.error ?? "PROCESSING_FAILED", true);
		case "complete":
		case null:
			return processState("complete");
		default:
			return processState("unavailable", "UNKNOWN_PROCESSING_STATE");
	}
};

export const agentStatus = ({
	id,
	updatedAt,
	transcriptionStatus,
	aiGenerationStatus,
	uploadPhase,
	uploadError,
}: {
	id: (typeof Agent.AgentCapStatus)["Type"]["id"];
	updatedAt: Date;
	transcriptionStatus: string | null;
	aiGenerationStatus?: string;
	uploadPhase: string | null;
	uploadError: string | null;
}): (typeof Agent.AgentCapStatus)["Type"] => {
	const upload = normalizeUploadStatus({
		phase: uploadPhase,
		error: uploadError,
	});
	const transcript = normalizeTranscriptStatus(transcriptionStatus);
	const ai = normalizeAiStatus(aiGenerationStatus);
	const states = [upload.status, transcript.status, ai.status];
	const overall = states.includes("error")
		? "error"
		: states.some((state) => state === "processing" || state === "queued")
			? "processing"
			: transcript.status === "complete" &&
					(ai.status === "complete" || ai.status === "skipped")
				? "ready"
				: "partial";

	return {
		id,
		overall,
		upload,
		transcript,
		ai,
		updatedAt: updatedAt.toISOString(),
	};
};

export const safeDownloadFileName = (title: string) => {
	const normalized = title
		.normalize("NFKD")
		.replace(/[^a-zA-Z0-9._ -]+/g, "")
		.trim()
		.replace(/\s+/g, "-")
		.slice(0, 120);
	return `${normalized || "cap-recording"}.mp4`;
};
