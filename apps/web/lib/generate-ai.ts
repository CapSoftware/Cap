import { db } from "@cap/database";
import { s3Buckets, videos } from "@cap/database/schema";
import type { VideoMetadata } from "@cap/database/types";
import { serverEnv } from "@cap/env";
import { S3Buckets } from "@cap/web-backend";
import type { S3Bucket, Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { Effect, Option } from "effect";
import { GROQ_MODEL, getGroqClient } from "@/lib/groq-client";
import { runPromise } from "@/lib/server";

type GenerateAiResult = {
	success: boolean;
	message: string;
};

export async function startAiGeneration(
	videoId: Video.VideoId,
	userId: string,
): Promise<GenerateAiResult> {
	if (!serverEnv().GROQ_API_KEY && !serverEnv().OPENAI_API_KEY) {
		return {
			success: false,
			message: "Missing AI API keys (Groq or OpenAI)",
		};
	}

	if (!userId || !videoId) {
		return {
			success: false,
			message: "userId or videoId not supplied",
		};
	}

	const query = await db()
		.select({ video: videos })
		.from(videos)
		.where(eq(videos.id, videoId));

	if (query.length === 0 || !query[0]?.video) {
		return { success: false, message: "Video does not exist" };
	}

	const { video } = query[0];

	if (video.transcriptionStatus !== "COMPLETE") {
		return {
			success: false,
			message: "Transcription not complete",
		};
	}

	const metadata = (video.metadata as VideoMetadata) || {};

	if (
		metadata.aiGenerationStatus === "PROCESSING" ||
		metadata.aiGenerationStatus === "QUEUED"
	) {
		return {
			success: true,
			message: "AI generation already in progress",
		};
	}

	if (
		metadata.aiGenerationStatus === "COMPLETE" &&
		metadata.summary &&
		metadata.chapters
	) {
		return {
			success: true,
			message: "AI metadata already generated",
		};
	}

	try {
		await db()
			.update(videos)
			.set({
				metadata: {
					...metadata,
					aiGenerationStatus: "PROCESSING",
				},
			})
			.where(eq(videos.id, videoId));

		await generateAiDirect(videoId, userId);

		return {
			success: true,
			message: "AI generation completed",
		};
	} catch (error) {
		console.error("[startAiGeneration] AI generation failed:", error);

		const freshVideo = await db()
			.select({ metadata: videos.metadata })
			.from(videos)
			.where(eq(videos.id, videoId));
		const freshMetadata =
			(freshVideo[0]?.metadata as VideoMetadata) || metadata;

		await db()
			.update(videos)
			.set({
				metadata: {
					...freshMetadata,
					aiGenerationStatus: "ERROR",
				},
			})
			.where(eq(videos.id, videoId));

		return {
			success: false,
			message: "AI generation failed",
		};
	}
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

async function generateAiDirect(
	videoId: string,
	userId: string,
): Promise<void> {
	const query = await db()
		.select({ video: videos, bucket: s3Buckets })
		.from(videos)
		.leftJoin(s3Buckets, eq(videos.bucket, s3Buckets.id))
		.where(eq(videos.id, videoId as Video.VideoId));

	if (query.length === 0 || !query[0]?.video) {
		throw new Error("Video does not exist");
	}

	const { video, bucket } = query[0];
	const metadata = (video.metadata as VideoMetadata) || {};
	const bucketId = (bucket?.id ?? null) as S3Bucket.S3BucketId | null;

	if (video.transcriptionStatus !== "COMPLETE") {
		throw new Error("Transcription not complete");
	}

	const vtt = await Effect.gen(function* () {
		const [s3Bucket] = yield* S3Buckets.getBucketAccess(
			Option.fromNullable(bucketId),
		);
		return yield* s3Bucket.getObject(`${userId}/${videoId}/transcription.vtt`);
	}).pipe(runPromise);

	if (Option.isNone(vtt)) {
		await db()
			.update(videos)
			.set({ metadata: { ...metadata, aiGenerationStatus: "SKIPPED" } })
			.where(eq(videos.id, videoId as Video.VideoId));
		return;
	}

	const segments = parseVttWithTimestamps(vtt.value);
	const text = segments
		.map((s) => s.text)
		.join(" ")
		.trim();

	if (text.length < 10) {
		await db()
			.update(videos)
			.set({ metadata: { ...metadata, aiGenerationStatus: "SKIPPED" } })
			.where(eq(videos.id, videoId as Video.VideoId));
		return;
	}

	const transcript: TranscriptData = { segments, text };
	const groqClient = getGroqClient();
	const chunks = chunkTranscriptWithTimestamps(transcript.segments);

	let aiResult: AiResult;
	if (chunks.length === 1) {
		aiResult = await generateSingleChunk(transcript.text, groqClient);
	} else {
		aiResult = await generateMultipleChunks(chunks, groqClient);
	}

	const updatedMetadata: VideoMetadata = {
		...metadata,
		aiTitle: aiResult.title || metadata.aiTitle,
		summary: aiResult.summary || metadata.summary,
		chapters: aiResult.chapters || metadata.chapters,
		aiGenerationStatus: "COMPLETE",
	};

	await db()
		.update(videos)
		.set({ metadata: updatedMetadata })
		.where(eq(videos.id, videoId as Video.VideoId));

	const hasDatePattern = /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(
		video.name || "",
	);

	if (
		(video.name?.startsWith("Cap Recording -") || hasDatePattern) &&
		aiResult.title
	) {
		await db()
			.update(videos)
			.set({ name: aiResult.title })
			.where(eq(videos.id, videoId as Video.VideoId));
	}
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
	}
	if (serverEnv().OPENAI_API_KEY) {
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
	transcriptText: string,
	groqClient: ReturnType<typeof getGroqClient>,
): Promise<AiResult> {
	const prompt = `You are Cap AI, an expert at analyzing video content and creating comprehensive summaries.

Analyze this transcript thoroughly and provide a detailed JSON response:
{
  "title": "string (concise but descriptive title that captures the main topic)",
  "summary": "string (detailed summary that covers ALL key points discussed. For meetings: include decisions made, action items, and key discussion points. For tutorials: cover all steps and concepts explained. For presentations: summarize all main arguments and supporting points. Write from 1st person perspective if the speaker is teaching/presenting, e.g. 'In this video, I walk through...'. Make it comprehensive enough that someone could understand the full content without watching.)",
  "chapters": [{"title": "string (descriptive chapter title)", "start": number (seconds from start)}]
}

Guidelines:
- The summary should be detailed and comprehensive, not a brief overview
- Capture ALL important topics, not just the main theme
- For longer content, organize the summary by topic or chronologically
- Include specific details, names, numbers, and conclusions mentioned
- Chapters should mark distinct topic changes or sections

Return ONLY valid JSON without any markdown formatting or code blocks.
Transcript:
${transcriptText}`;

	const content = await callAiApi(prompt, groqClient);
	return parseAiResponse(content);
}

async function generateMultipleChunks(
	chunks: { text: string; startTime: number; endTime: number }[],
	groqClient: ReturnType<typeof getGroqClient>,
): Promise<AiResult> {
	const chunkSummaries: {
		summary: string;
		keyPoints: string[];
		chapters: { title: string; start: number }[];
		startTime: number;
		endTime: number;
	}[] = [];

	for (let i = 0; i < chunks.length; i++) {
		const chunk = chunks[i];
		if (!chunk) continue;

		const chunkPrompt = `You are Cap AI, an expert at analyzing video content. This is section ${i + 1} of ${chunks.length} from a longer video (timestamp ${Math.floor(chunk.startTime / 60)}:${String(chunk.startTime % 60).padStart(2, "0")} to ${Math.floor(chunk.endTime / 60)}:${String(chunk.endTime % 60).padStart(2, "0")}).

Analyze this section thoroughly and provide JSON:
{
  "summary": "string (detailed summary of this section - capture ALL key points, topics discussed, decisions made, or concepts explained. Include specific details like names, numbers, action items, and conclusions. This should be 3-6 sentences minimum.)",
  "keyPoints": ["string (specific key point or takeaway)", ...],
  "chapters": [{"title": "string (descriptive title for this topic/section)", "start": number (seconds from video start)}]
}

Be thorough - this summary will be combined with other sections to create a comprehensive overview.
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
		} catch (parseError) {
			console.error(
				`[generateAiDirect] Failed to parse AI chunk ${i + 1} response:`,
				parseError,
			);
		}
	}

	if (chunkSummaries.length === 0) {
		throw new Error("All AI chunk summary parses failed");
	}

	const allChapters: { title: string; start: number }[] = [];
	const sortedChapters = chunkSummaries
		.flatMap((c) => c.chapters)
		.sort((a, b) => a.start - b.start);
	for (const chapter of sortedChapters) {
		const lastChapter = allChapters[allChapters.length - 1];
		if (!lastChapter || Math.abs(chapter.start - lastChapter.start) >= 30) {
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

	const finalPrompt = `You are Cap AI, an expert at synthesizing information into comprehensive, well-organized summaries.

Based on these detailed section analyses of a video, create a thorough final summary that captures EVERYTHING important.

Section analyses:
${sectionDetails}

${allKeyPoints.length > 0 ? `All key points identified:\n${allKeyPoints.map((p, i) => `${i + 1}. ${p}`).join("\n")}\n` : ""}

Provide JSON in the following format:
{
  "title": "string (concise but descriptive title that captures the main topic/purpose)",
  "summary": "string (COMPREHENSIVE summary that covers the entire video thoroughly. This should be detailed enough that someone could understand all the important content without watching. Include: main topics covered, key decisions or conclusions, important details mentioned, action items if any. Organize it logically - for meetings use topics/agenda items, for tutorials use steps/concepts, for presentations use main arguments. Write from 1st person perspective if appropriate. This should be several paragraphs for longer content.)"
}

The summary must be detailed and comprehensive - not a brief overview. Capture all the important information from every section.
Return ONLY valid JSON without any markdown formatting or code blocks.`;

	const finalContent = await callAiApi(finalPrompt, groqClient);
	try {
		const parsed = JSON.parse(cleanJsonResponse(finalContent).trim());
		return {
			title: parsed.title,
			summary: parsed.summary,
			chapters: allChapters,
		};
	} catch (parseError) {
		console.error(
			"[generateAiDirect] Failed to parse final summary response, using fallback:",
			parseError,
		);
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

		if (data.chapters && data.chapters.length > 0) {
			const sortedChapters = data.chapters.sort(
				(a: { start: number }, b: { start: number }) => a.start - b.start,
			);
			const dedupedChapters: { title: string; start: number }[] = [];
			for (const chapter of sortedChapters) {
				const lastChapter = dedupedChapters[dedupedChapters.length - 1];
				if (!lastChapter || Math.abs(chapter.start - lastChapter.start) >= 30) {
					dedupedChapters.push(chapter);
				}
			}
			data.chapters = dedupedChapters;
		}

		return {
			title: data.title,
			summary: data.summary,
			chapters: data.chapters,
		};
	} catch (parseError) {
		console.error(
			"[generateAiDirect] Failed to parse final AI response:",
			parseError,
		);
		return {
			title: "Generated Title",
			summary:
				"The AI was unable to generate a proper summary for this content.",
			chapters: [],
		};
	}
}
