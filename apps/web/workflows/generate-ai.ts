import { db } from "@cap/database";
import { organizations, videos } from "@cap/database/schema";
import type { VideoMetadata } from "@cap/database/types";
import { serverEnv } from "@cap/env";
import { Storage } from "@cap/web-backend/src/Storage/index";
import {
	AI_GENERATION_LANGUAGE_AUTO,
	type AiGenerationLanguage,
	getAiGenerationLanguageName,
	parseAiGenerationLanguage,
	type Video,
} from "@cap/web-domain";
import { and, eq, sql } from "drizzle-orm";
import { Effect, Option } from "effect";
import { FatalError } from "workflow";
import { GROQ_MODEL, getGroqClient } from "@/lib/groq-client";
import { decodeStorageVideo } from "@/lib/video-storage";
import { runWorkflowPromise } from "@/lib/workflow-runtime";

interface GenerateAiWorkflowPayload {
	videoId: string;
	userId: string;
}

interface VideoData {
	video: typeof videos.$inferSelect;
	metadata: VideoMetadata;
	aiGenerationLanguage: AiGenerationLanguage;
}

interface VttSegment {
	start: number;
	text: string;
}

interface TranscriptData {
	segments: VttSegment[];
	text: string;
}

interface AiResult {
	title?: string;
	summary?: string;
	chapters?: { title: string; start: number }[];
}

const MAX_CHARS_PER_CHUNK = 24000;
const GENERATED_TITLE_PATTERN =
	/^(Cap (Recording|Upload) - .+|Cap \d{4}-\d{2}-\d{2} at \d{2}[.:]\d{2}[.:]\d{2}|Untitled|\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}|.+ \((Display|Window|Area|Camera)\) \d{4}-\d{2}-\d{2} \d{2}:\d{2} [AP]M)$/;

export function shouldReplaceVideoTitle({
	currentTitle,
	previousAiTitle,
	nextAiTitle,
	sourceName,
	titleManuallyEdited,
}: {
	currentTitle: string | null;
	previousAiTitle?: string | null;
	nextAiTitle?: string | null;
	sourceName?: string | null;
	titleManuallyEdited?: boolean | null;
}) {
	const nextTitle = nextAiTitle?.trim();
	if (!nextTitle) return false;
	if (titleManuallyEdited) return false;

	const title = currentTitle?.trim();
	if (!title) return true;
	if (previousAiTitle?.trim() && title === previousAiTitle.trim()) return true;
	if (sourceName?.trim() && title === sourceName.trim()) return true;
	return GENERATED_TITLE_PATTERN.test(title);
}

export async function generateAiWorkflow(payload: GenerateAiWorkflowPayload) {
	"use workflow";

	const { videoId, userId } = payload;

	let videoData: VideoData;
	try {
		videoData = await validateAndSetProcessing(videoId);
	} catch (error) {
		await markError(videoId);
		throw error;
	}

	try {
		const transcript = await fetchTranscript(videoId, userId, videoData.video);

		if (!transcript) {
			await markSkipped(videoId, videoData.metadata);
			return {
				success: true,
				message: "Transcript empty or too short - skipped",
			};
		}

		const result = await generateWithAi(
			transcript,
			videoData.aiGenerationLanguage,
		);

		await saveResults(videoId, videoData, result);
	} catch (error) {
		await markError(videoId);
		throw error;
	}

	return { success: true, message: "AI generation completed successfully" };
}

async function validateAndSetProcessing(videoId: string): Promise<VideoData> {
	"use step";

	const groqClient = getGroqClient();
	if (!groqClient && !serverEnv().OPENAI_API_KEY) {
		throw new FatalError("Missing Groq or OpenAI API key");
	}

	const query = await db()
		.select({ video: videos, orgSettings: organizations.settings })
		.from(videos)
		.leftJoin(organizations, eq(videos.orgId, organizations.id))
		.where(eq(videos.id, videoId as Video.VideoId));

	if (query.length === 0 || !query[0]?.video) {
		throw new FatalError("Video does not exist");
	}

	const { video } = query[0];
	const metadata = (video.metadata as VideoMetadata) || {};

	if (video.transcriptionStatus !== "COMPLETE") {
		throw new FatalError("Transcription not complete");
	}

	if (metadata.summary && metadata.chapters) {
		throw new FatalError("AI metadata already generated");
	}

	await db()
		.update(videos)
		.set({
			metadata: {
				...metadata,
				aiGenerationStatus: "PROCESSING",
			},
		})
		.where(eq(videos.id, videoId as Video.VideoId));

	return {
		video,
		metadata,
		aiGenerationLanguage: parseAiGenerationLanguage(
			query[0]?.orgSettings?.aiGenerationLanguage,
		),
	};
}

async function fetchTranscript(
	videoId: string,
	userId: string,
	video: typeof videos.$inferSelect,
): Promise<TranscriptData | null> {
	"use step";

	const vtt = await Effect.gen(function* () {
		const [bucket] = yield* Storage.getAccessForVideo(
			decodeStorageVideo(video),
		);
		return yield* bucket.getObject(`${userId}/${videoId}/transcription.vtt`);
	}).pipe(runWorkflowPromise);

	if (Option.isNone(vtt)) {
		return null;
	}

	const segments = parseVttWithTimestamps(vtt.value);
	const text = segments
		.map((s) => s.text)
		.join(" ")
		.trim();

	if (text.length < 10) {
		return null;
	}

	return { segments, text };
}

async function markError(videoId: string): Promise<void> {
	"use step";

	await db()
		.update(videos)
		.set({
			metadata: sql`JSON_SET(COALESCE(${videos.metadata}, JSON_OBJECT()), '$.aiGenerationStatus', 'ERROR')`,
		})
		.where(
			and(
				eq(videos.id, videoId as Video.VideoId),
				sql`NOT (
					COALESCE(JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.aiGenerationStatus')), '') = 'COMPLETE'
					AND JSON_EXTRACT(${videos.metadata}, '$.summary') IS NOT NULL
					AND JSON_EXTRACT(${videos.metadata}, '$.chapters') IS NOT NULL
				)`,
			),
		);
}

async function markSkipped(
	videoId: string,
	metadata: VideoMetadata,
): Promise<void> {
	"use step";

	const currentMetadata = await getCurrentVideoMetadata(videoId, metadata);

	await db()
		.update(videos)
		.set({
			metadata: {
				...currentMetadata,
				aiGenerationStatus: "SKIPPED",
			},
		})
		.where(eq(videos.id, videoId as Video.VideoId));
}

async function generateWithAi(
	transcript: TranscriptData,
	language: AiGenerationLanguage,
): Promise<AiResult> {
	"use step";

	const groqClient = getGroqClient();
	const chunks = chunkTranscriptWithTimestamps(transcript.segments);

	const videoDuration = getVideoDuration(transcript.segments);
	const languageInstruction = getAiLanguageInstruction(language);

	let result: AiResult;
	if (chunks.length === 1) {
		result = await generateSingleChunk(
			transcript.segments,
			videoDuration,
			groqClient,
			languageInstruction,
		);
	} else {
		result = await generateMultipleChunks(
			chunks,
			videoDuration,
			groqClient,
			languageInstruction,
		);
	}

	if (result.chapters) {
		result.chapters = clampChapters(result.chapters, videoDuration);
	}

	return result;
}

export function getAiLanguageInstruction(
	language: AiGenerationLanguage,
): string {
	if (language === AI_GENERATION_LANGUAGE_AUTO) {
		return "Write the title, summary, chapter titles, section summaries, and key points in the same language as the transcript.";
	}

	return `Write the title, summary, chapter titles, section summaries, and key points in ${getAiGenerationLanguageName(language)}.`;
}

export function getAiContentGuidelines(videoDuration: number): {
	summary: string;
	chapters: string;
} {
	let lengthInstruction: string;
	if (videoDuration < 60) {
		lengthInstruction = "Use no more than 35 words and one or two sentences.";
	} else if (videoDuration < 180) {
		lengthInstruction =
			"Aim for 50-90 words in one concise paragraph, but use fewer when that fully communicates the video.";
	} else if (videoDuration < 600) {
		lengthInstruction =
			"Aim for 80-150 words in one concise paragraph, but use fewer when that fully communicates the video.";
	} else if (videoDuration < 1800) {
		lengthInstruction =
			"Aim for 150-250 words. Use short paragraphs or Markdown bullets only when they materially improve clarity.";
	} else {
		lengthInstruction =
			"Aim for 250-400 words. Exceed 400 only when necessary to preserve important decisions, responsibilities, or next steps.";
	}

	return {
		summary: `- Write a standalone summary that lets someone understand the video without watching it.
- State the subject and the speaker's intention first: what the video is about and why it was recorded. If the intention is not explicit, describe only what the transcript supports.
- Then include only the essential explanation, outcomes, decisions, action items, and next steps needed to understand or act on the video.
- Prioritize meaning and useful information over chronological retelling.
- Omit filler, greetings, reactions, apologies, repetition, incidental conversation, minor UI actions, and timestamps unless a timestamp is essential to the viewer.
- Use the speaker's perspective when it is clear, but do not invent intent, outcomes, or actions.
- Be concise, but never omit information required to understand or act on the video. Do not pad the summary to reach a target length.
- For example, summarize a short drawing-feature test as "I test the drawing and highlighting tools, including how highlights behave on moving elements" rather than enumerating every utterance and interaction.
- ${lengthInstruction}`,
		chapters:
			videoDuration < 120
				? 'Return an empty "chapters" array because videos shorter than two minutes do not need chapters.'
				: "Create the fewest chapters needed to identify meaningful topic or phase changes. Do not create chapters for filler, minor UI actions, or every transcript segment.",
	};
}

function getVideoDuration(segments: VttSegment[]): number {
	if (segments.length === 0) return 0;
	const lastSegment = segments[segments.length - 1];
	return lastSegment ? lastSegment.start + 3 : 0;
}

function clampChapters(
	chapters: { title: string; start: number }[],
	videoDuration: number,
): { title: string; start: number }[] {
	const filtered = chapters.filter((ch) => ch.start < videoDuration);

	if (filtered.length === 0 && chapters.length > 0) {
		const first = chapters[0];
		return first ? [{ title: first.title, start: 0 }] : [];
	}

	const minGap = Math.max(5, Math.floor(videoDuration / 10));
	const deduped: { title: string; start: number }[] = [];
	for (const chapter of filtered) {
		const last = deduped[deduped.length - 1];
		if (!last || Math.abs(chapter.start - last.start) >= minGap) {
			deduped.push(chapter);
		}
	}

	return deduped;
}

async function saveResults(
	videoId: string,
	videoData: VideoData,
	result: AiResult,
): Promise<void> {
	"use step";

	const { video, metadata } = videoData;
	const generatedTitle = result.title?.trim();
	const currentVideo = await getCurrentVideo(videoId);
	const currentMetadata = currentVideo
		? (currentVideo.metadata as VideoMetadata) || {}
		: metadata;
	const currentTitle = currentVideo?.name ?? video.name;

	const updatedMetadata: VideoMetadata = {
		...currentMetadata,
		aiTitle: generatedTitle || currentMetadata.aiTitle,
		summary: result.summary || currentMetadata.summary,
		chapters: result.chapters || currentMetadata.chapters,
		aiGenerationStatus: "COMPLETE",
	};

	await db()
		.update(videos)
		.set({ metadata: updatedMetadata })
		.where(eq(videos.id, videoId as Video.VideoId));

	if (
		generatedTitle &&
		shouldReplaceVideoTitle({
			currentTitle,
			previousAiTitle: currentMetadata.aiTitle,
			nextAiTitle: generatedTitle,
			sourceName: currentMetadata.sourceName,
			titleManuallyEdited: currentMetadata.titleManuallyEdited,
		})
	) {
		await db()
			.update(videos)
			.set({ name: generatedTitle })
			.where(
				and(
					eq(videos.id, videoId as Video.VideoId),
					eq(videos.name, currentTitle),
				),
			);
	}
}

async function getCurrentVideo(
	videoId: string,
): Promise<typeof videos.$inferSelect | null> {
	const [currentVideo] = await db()
		.select()
		.from(videos)
		.where(eq(videos.id, videoId as Video.VideoId));

	return currentVideo ?? null;
}

async function getCurrentVideoMetadata(
	videoId: string,
	fallback: VideoMetadata,
): Promise<VideoMetadata> {
	const currentVideo = await getCurrentVideo(videoId);
	return currentVideo
		? (currentVideo.metadata as VideoMetadata) || {}
		: fallback;
}

function parseVttWithTimestamps(vttContent: string): VttSegment[] {
	const lines = vttContent.split("\n");
	const segments: VttSegment[] = [];
	let currentStart = 0;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]?.trim() ?? "";
		if (line.includes("-->")) {
			const timeMatch = line.match(/(\d{2}):(\d{2}):(\d{2})[.,](\d{3})/);
			if (timeMatch) {
				currentStart =
					parseInt(timeMatch[1] ?? "0", 10) * 3600 +
					parseInt(timeMatch[2] ?? "0", 10) * 60 +
					parseInt(timeMatch[3] ?? "0", 10);
			}
		} else if (
			line &&
			line !== "WEBVTT" &&
			!/^\d+$/.test(line) &&
			!line.includes("-->")
		) {
			segments.push({ start: currentStart, text: line });
		}
	}

	return segments;
}

function chunkTranscriptWithTimestamps(
	segments: VttSegment[],
): { text: string; startTime: number; endTime: number }[] {
	const chunks: { text: string; startTime: number; endTime: number }[] = [];
	let currentChunk: VttSegment[] = [];
	let currentLength = 0;

	for (const segment of segments) {
		if (
			currentLength + segment.text.length > MAX_CHARS_PER_CHUNK &&
			currentChunk.length > 0
		) {
			chunks.push({
				text: currentChunk.map((s) => s.text).join(" "),
				startTime: currentChunk[0]?.start ?? 0,
				endTime: currentChunk[currentChunk.length - 1]?.start ?? 0,
			});
			currentChunk = [];
			currentLength = 0;
		}
		currentChunk.push(segment);
		currentLength += segment.text.length + 1;
	}

	if (currentChunk.length > 0) {
		chunks.push({
			text: currentChunk.map((s) => s.text).join(" "),
			startTime: currentChunk[0]?.start ?? 0,
			endTime: currentChunk[currentChunk.length - 1]?.start ?? 0,
		});
	}

	return chunks;
}

async function callAiApi(
	prompt: string,
	groqClient: ReturnType<typeof getGroqClient>,
): Promise<string> {
	if (groqClient) {
		try {
			const completion = await groqClient.chat.completions.create({
				messages: [{ role: "user", content: prompt }],
				model: GROQ_MODEL,
			});
			return completion.choices?.[0]?.message?.content || "{}";
		} catch (groqError) {
			if (serverEnv().OPENAI_API_KEY) {
				return callOpenAi(prompt);
			}
			throw groqError;
		}
	} else if (serverEnv().OPENAI_API_KEY) {
		return callOpenAi(prompt);
	}
	return "{}";
}

async function callOpenAi(prompt: string): Promise<string> {
	const aiRes = await fetch("https://api.openai.com/v1/chat/completions", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${serverEnv().OPENAI_API_KEY}`,
		},
		body: JSON.stringify({
			model: "gpt-4o-mini",
			messages: [{ role: "user", content: prompt }],
		}),
	});
	if (!aiRes.ok) {
		const errorText = await aiRes.text();
		throw new Error(`OpenAI API error: ${aiRes.status} ${errorText}`);
	}
	const aiJson = await aiRes.json();
	return aiJson.choices?.[0]?.message?.content || "{}";
}

function cleanJsonResponse(content: string): string {
	if (content.includes("```json")) {
		return content.replace(/```json\s*/g, "").replace(/```\s*/g, "");
	}
	if (content.includes("```")) {
		return content.replace(/```\s*/g, "");
	}
	return content;
}

async function generateSingleChunk(
	segments: VttSegment[],
	videoDuration: number,
	groqClient: ReturnType<typeof getGroqClient>,
	languageInstruction: string,
): Promise<AiResult> {
	const transcriptWithTimestamps = segments
		.map(
			(s) =>
				`[${Math.floor(s.start / 60)}:${String(s.start % 60).padStart(2, "0")}] ${s.text}`,
		)
		.join("\n");
	const contentGuidelines = getAiContentGuidelines(videoDuration);

	const prompt = `You are Cap AI, an expert at turning video transcripts into useful, concise summaries.

The video is ${videoDuration} seconds long (${Math.floor(videoDuration / 60)}:${String(Math.floor(videoDuration % 60)).padStart(2, "0")} total). Analyze this timestamped transcript and provide JSON:
{
  "title": "string (concise but descriptive title that captures the main topic)",
  "summary": "string (standalone summary of the subject, intention, essential information, outcome, and next steps)",
  "chapters": [{"title": "string (descriptive chapter title)", "start": number (seconds from start)}]
}

Summary requirements:
${contentGuidelines.summary}

Chapter requirements:
${contentGuidelines.chapters}

Additional requirements:
- ${languageInstruction}
- Keep JSON property names exactly as shown.
- Include specific names, numbers, decisions, and conclusions only when they help someone understand or act on the video.
- IMPORTANT: All chapter "start" values MUST be between 0 and ${videoDuration} seconds. Use the timestamps from the transcript to determine accurate chapter start times.

Return ONLY valid JSON without any markdown formatting or code blocks.
Transcript:
${transcriptWithTimestamps}`;

	const content = await callAiApi(prompt, groqClient);
	return parseAiResponse(content);
}

async function generateMultipleChunks(
	chunks: { text: string; startTime: number; endTime: number }[],
	videoDuration: number,
	groqClient: ReturnType<typeof getGroqClient>,
	languageInstruction: string,
): Promise<AiResult> {
	const chunkSummaries: {
		summary: string;
		keyPoints: string[];
		chapters: { title: string; start: number }[];
		startTime: number;
		endTime: number;
	}[] = [];
	const contentGuidelines = getAiContentGuidelines(videoDuration);

	for (let i = 0; i < chunks.length; i++) {
		const chunk = chunks[i];
		if (!chunk) continue;

		const chunkPrompt = `You are Cap AI, analyzing one section of a video for a later final summary. This is section ${i + 1} of ${chunks.length} from a video that is ${videoDuration} seconds long (${Math.floor(videoDuration / 60)}:${String(Math.floor(videoDuration % 60)).padStart(2, "0")} total). This section covers timestamp ${Math.floor(chunk.startTime / 60)}:${String(chunk.startTime % 60).padStart(2, "0")} to ${Math.floor(chunk.endTime / 60)}:${String(chunk.endTime % 60).padStart(2, "0")}.

Extract only the information needed to understand this section's contribution to the full video and provide JSON:
{
  "summary": "string (concise factual notes about the subject, intention, essential explanation, outcomes, decisions, or next steps in this section)",
  "keyPoints": ["string (essential key point or takeaway, or an empty array when there is none)", ...],
  "chapters": [{"title": "string (descriptive title for this topic/section)", "start": number (seconds from video start)}]
}

- Preserve specific names, numbers, decisions, responsibilities, and conclusions that matter to the final summary.
- Omit filler, greetings, reactions, apologies, repetition, incidental conversation, and minor UI actions.
- Do not narrate the transcript chronologically or pad the section analysis.
- ${contentGuidelines.chapters}
- ${languageInstruction}
- Keep JSON property names exactly as shown.
IMPORTANT: All chapter "start" values MUST be between ${chunk.startTime} and ${chunk.endTime} seconds. The total video is only ${videoDuration} seconds long.
Return ONLY valid JSON without any markdown formatting or code blocks.
Transcript section:
${chunk.text}`;

		const chunkContent = await callAiApi(chunkPrompt, groqClient);
		try {
			const parsed = JSON.parse(cleanJsonResponse(chunkContent).trim());
			chunkSummaries.push({
				summary: parsed.summary || "",
				keyPoints: parsed.keyPoints || [],
				chapters: parsed.chapters || [],
				startTime: chunk.startTime,
				endTime: chunk.endTime,
			});
		} catch {}
	}

	const allChapters: { title: string; start: number }[] = [];
	const sortedChapters = chunkSummaries
		.flatMap((c) => c.chapters)
		.sort((a, b) => a.start - b.start);
	const minGap = Math.max(5, Math.floor(videoDuration / 10));
	for (const chapter of sortedChapters) {
		const lastChapter = allChapters[allChapters.length - 1];
		if (!lastChapter || Math.abs(chapter.start - lastChapter.start) >= minGap) {
			allChapters.push(chapter);
		}
	}

	const allKeyPoints = chunkSummaries.flatMap((c) => c.keyPoints);

	const sectionDetails = chunkSummaries
		.map((c, i) => {
			const timeRange = `${Math.floor(c.startTime / 60)}:${String(c.startTime % 60).padStart(2, "0")} - ${Math.floor(c.endTime / 60)}:${String(c.endTime % 60).padStart(2, "0")}`;
			const keyPointsList =
				c.keyPoints.length > 0 ? `\nKey points: ${c.keyPoints.join("; ")}` : "";
			return `Section ${i + 1} (${timeRange}):\n${c.summary}${keyPointsList}`;
		})
		.join("\n\n");

	const finalPrompt = `You are Cap AI, an expert at turning video analyses into useful, concise summaries.

Using these section analyses, create a standalone final summary that lets someone understand the video without watching it.

Section analyses:
${sectionDetails}

${allKeyPoints.length > 0 ? `All key points identified:\n${allKeyPoints.map((p, i) => `${i + 1}. ${p}`).join("\n")}\n` : ""}

Provide JSON in the following format:
{
  "title": "string (concise but descriptive title that captures the main topic/purpose)",
  "summary": "string (standalone summary of the subject, intention, essential information, outcome, and next steps)"
}

Summary requirements:
${contentGuidelines.summary}

Additional requirements:
- ${languageInstruction}
- Keep JSON property names exactly as shown.
Return ONLY valid JSON without any markdown formatting or code blocks.`;

	const finalContent = await callAiApi(finalPrompt, groqClient);
	try {
		const parsed = JSON.parse(cleanJsonResponse(finalContent).trim());
		return {
			title: parsed.title,
			summary: parsed.summary,
			chapters: allChapters,
		};
	} catch {
		const fallbackSummary = chunkSummaries
			.map((c, i) => `**Part ${i + 1}:** ${c.summary}`)
			.join("\n\n");
		const keyPointsSummary =
			allKeyPoints.length > 0
				? `\n\n**Key Points:**\n${allKeyPoints.map((p) => `- ${p}`).join("\n")}`
				: "";
		return {
			title: "Video Summary",
			summary: fallbackSummary + keyPointsSummary,
			chapters: allChapters,
		};
	}
}

function parseAiResponse(content: string): AiResult {
	try {
		const data = JSON.parse(cleanJsonResponse(content).trim());

		const chapters = Array.isArray(data.chapters)
			? data.chapters
					.filter(
						(ch: { start?: number }) =>
							typeof ch.start === "number" && ch.start >= 0,
					)
					.sort(
						(a: { start: number }, b: { start: number }) => a.start - b.start,
					)
			: [];

		return {
			title: data.title,
			summary: data.summary,
			chapters,
		};
	} catch {
		return {
			title: "Generated Title",
			summary:
				"The AI was unable to generate a proper summary for this content.",
			chapters: [],
		};
	}
}
