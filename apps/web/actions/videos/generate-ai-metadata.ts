"use server";

import { db } from "@cap/database";
import { s3Buckets, videos } from "@cap/database/schema";
import type { VideoMetadata } from "@cap/database/types";
import { serverEnv } from "@cap/env";
import { S3Buckets } from "@cap/web-backend";
import type { Video } from "@cap/web-domain";
import { and, eq, sql } from "drizzle-orm";
import { Effect, Option } from "effect";
import { GROQ_MODEL, getGroqClient } from "@/lib/groq-client";
import { runPromise } from "@/lib/server";

const MAX_CHARS_PER_CHUNK = 24000;

interface VttSegment {
	start: number;
	text: string;
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
			console.error(
				`[generateAiMetadata] Groq API error: ${groqError}, falling back to OpenAI`,
			);
			if (serverEnv().OPENAI_API_KEY) {
				const aiRes = await fetch(
					"https://api.openai.com/v1/chat/completions",
					{
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							Authorization: `Bearer ${serverEnv().OPENAI_API_KEY}`,
						},
						body: JSON.stringify({
							model: "gpt-4o-mini",
							messages: [{ role: "user", content: prompt }],
						}),
					},
				);
				if (!aiRes.ok) {
					const errorText = await aiRes.text();
					throw new Error(`OpenAI API error: ${aiRes.status} ${errorText}`);
				}
				const aiJson = await aiRes.json();
				return aiJson.choices?.[0]?.message?.content || "{}";
			}
			throw groqError;
		}
	} else if (serverEnv().OPENAI_API_KEY) {
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
	return "{}";
}

export async function generateAiMetadata(
	videoId: Video.VideoId,
	userId: string,
) {
	const groqClient = getGroqClient();
	if (!groqClient && !serverEnv().OPENAI_API_KEY) {
		console.error(
			"[generateAiMetadata] Missing Groq or OpenAI API key, skipping AI metadata generation",
		);
		return;
	}
	const videoQuery = await db()
		.select({ video: videos })
		.from(videos)
		.where(eq(videos.id, videoId));

	if (videoQuery.length === 0 || !videoQuery[0]?.video) {
		console.error(
			`[generateAiMetadata] Video ${videoId} not found in database`,
		);
		return;
	}

	const videoData = videoQuery[0].video;
	const metadata = (videoData.metadata as VideoMetadata) || {};

	if (metadata.aiProcessing === true) {
		const updatedAtTime = new Date(videoData.updatedAt).getTime();
		const currentTime = Date.now();
		const tenMinutesInMs = 10 * 60 * 1000;

		if (currentTime - updatedAtTime > tenMinutesInMs) {
			await db()
				.update(videos)
				.set({
					metadata: {
						...metadata,
						aiProcessing: false,
					},
				})
				.where(eq(videos.id, videoId));
		} else {
			return;
		}
	}

	if (metadata.summary || metadata.chapters) {
		if (metadata.aiProcessing) {
			await db()
				.update(videos)
				.set({
					metadata: {
						...metadata,
						aiProcessing: false,
					},
				})
				.where(eq(videos.id, videoId));
		}
		return;
	}

	if (videoData?.transcriptionStatus !== "COMPLETE") {
		if (metadata.aiProcessing) {
			await db()
				.update(videos)
				.set({
					metadata: {
						...metadata,
						aiProcessing: false,
					},
				})
				.where(eq(videos.id, videoId));
		}
		return;
	}

	const lockResult = await db()
		.update(videos)
		.set({
			metadata: {
				...metadata,
				aiProcessing: true,
			},
		})
		.where(
			and(
				eq(videos.id, videoId),
				sql`JSON_EXTRACT(metadata, '$.aiProcessing') IS NULL OR JSON_EXTRACT(metadata, '$.aiProcessing') = false`,
			),
		);

	const affectedRows = (lockResult[0] as { affectedRows?: number })
		?.affectedRows;
	if (typeof affectedRows !== "number") {
		console.warn(
			"[generateAiMetadata] Unable to determine lock result, proceeding cautiously",
		);
	}
	if (affectedRows === 0) {
		return;
	}

	try {
		const query = await db()
			.select({ video: videos, bucket: s3Buckets })
			.from(videos)
			.leftJoin(s3Buckets, eq(videos.bucket, s3Buckets.id))
			.where(eq(videos.id, videoId));

		if (query.length === 0 || !query[0]) {
			console.error(`[generateAiMetadata] Video data not found for ${videoId}`);
			throw new Error(`Video data not found for ${videoId}`);
		}

		const row = query[0];
		if (!row || !row.video) {
			console.error(
				`[generateAiMetadata] Video record not found for ${videoId}`,
			);
			throw new Error(`Video record not found for ${videoId}`);
		}

		const { video } = row;

		const vtt = await Effect.gen(function* () {
			const [bucket] = yield* S3Buckets.getBucketAccess(
				Option.fromNullable(row.bucket?.id),
			);

			return yield* bucket.getObject(`${userId}/${videoId}/transcription.vtt`);
		}).pipe(runPromise);

		if (Option.isNone(vtt)) {
			console.log(
				`[generateAiMetadata] Transcript is empty for ${videoId}, skipping AI metadata`,
			);
			await db()
				.update(videos)
				.set({
					metadata: {
						...metadata,
						aiProcessing: false,
						aiGenerationSkipped: true,
					},
				})
				.where(eq(videos.id, videoId));
			return;
		}

		const segments = parseVttWithTimestamps(vtt.value);
		const transcriptText = segments
			.map((s) => s.text)
			.join(" ")
			.trim();

		if (transcriptText.length < 10) {
			console.log(
				`[generateAiMetadata] Transcript content too short for ${videoId} (${transcriptText.length} chars), skipping AI metadata`,
			);
			await db()
				.update(videos)
				.set({
					metadata: {
						...metadata,
						aiProcessing: false,
						aiGenerationSkipped: true,
					},
				})
				.where(eq(videos.id, videoId));
			return;
		}

		const chunks = chunkTranscriptWithTimestamps(segments);
		console.log(
			`[generateAiMetadata] Processing ${videoId}: ${transcriptText.length} chars, ${chunks.length} chunk(s)`,
		);

		let content = "{}";

		if (chunks.length === 1) {
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
			content = await callAiApi(prompt, groqClient);
		} else {
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
				console.log(
					`[generateAiMetadata] Processing chunk ${i + 1}/${chunks.length} for ${videoId} (${chunk.startTime}s - ${chunk.endTime}s)`,
				);

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
					let cleanContent = chunkContent;
					if (chunkContent.includes("```json")) {
						cleanContent = chunkContent
							.replace(/```json\s*/g, "")
							.replace(/```\s*/g, "");
					} else if (chunkContent.includes("```")) {
						cleanContent = chunkContent.replace(/```\s*/g, "");
					}
					const parsed = JSON.parse(cleanContent.trim());
					chunkSummaries.push({
						summary: parsed.summary || "",
						keyPoints: parsed.keyPoints || [],
						chapters: parsed.chapters || [],
						startTime: chunk.startTime,
						endTime: chunk.endTime,
					});
				} catch {
					console.error(
						`[generateAiMetadata] Failed to parse chunk ${i + 1} response for ${videoId}`,
					);
				}
			}

			const allChapters = chunkSummaries.flatMap((c) => c.chapters);
			const allKeyPoints = chunkSummaries.flatMap((c) => c.keyPoints);

			const sectionDetails = chunkSummaries
				.map((c, i) => {
					const timeRange = `${Math.floor(c.startTime / 60)}:${String(c.startTime % 60).padStart(2, "0")} - ${Math.floor(c.endTime / 60)}:${String(c.endTime % 60).padStart(2, "0")}`;
					const keyPointsList =
						c.keyPoints.length > 0
							? `\nKey points: ${c.keyPoints.join("; ")}`
							: "";
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
				let cleanContent = finalContent;
				if (finalContent.includes("```json")) {
					cleanContent = finalContent
						.replace(/```json\s*/g, "")
						.replace(/```\s*/g, "");
				} else if (finalContent.includes("```")) {
					cleanContent = finalContent.replace(/```\s*/g, "");
				}
				const parsed = JSON.parse(cleanContent.trim());
				content = JSON.stringify({
					title: parsed.title,
					summary: parsed.summary,
					chapters: allChapters,
				});
			} catch {
				console.error(
					`[generateAiMetadata] Failed to parse final summary for ${videoId}`,
				);
				const fallbackSummary = chunkSummaries
					.map((c, i) => `**Part ${i + 1}:** ${c.summary}`)
					.join("\n\n");
				const keyPointsSummary =
					allKeyPoints.length > 0
						? `\n\n**Key Points:**\n${allKeyPoints.map((p) => `- ${p}`).join("\n")}`
						: "";
				content = JSON.stringify({
					title: "Video Summary",
					summary: fallbackSummary + keyPointsSummary,
					chapters: allChapters,
				});
			}
		}

		let data: {
			title?: string;
			summary?: string;
			chapters?: { title: string; start: number }[];
		} = {};
		try {
			// Remove markdown code blocks if present
			let cleanContent = content;
			if (content.includes("```json")) {
				cleanContent = content
					.replace(/```json\s*/g, "")
					.replace(/```\s*/g, "");
			} else if (content.includes("```")) {
				cleanContent = content.replace(/```\s*/g, "");
			}
			data = JSON.parse(cleanContent.trim());
		} catch (e) {
			console.error(`[generateAiMetadata] Error parsing AI response: ${e}`);
			data = {
				title: "Generated Title",
				summary:
					"The AI was unable to generate a proper summary for this content.",
				chapters: [],
			};
		}

		const currentMetadata: VideoMetadata =
			(video.metadata as VideoMetadata) || {};
		const updatedMetadata: VideoMetadata = {
			...currentMetadata,
			aiTitle: data.title || currentMetadata.aiTitle,
			summary: data.summary || currentMetadata.summary,
			chapters: data.chapters || currentMetadata.chapters,
			aiProcessing: false,
		};

		await db()
			.update(videos)
			.set({ metadata: updatedMetadata })
			.where(eq(videos.id, videoId));

		const hasDatePattern = /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(
			video.name || "",
		);

		if (
			(video.name?.startsWith("Cap Recording -") || hasDatePattern) &&
			data.title
		) {
			await db()
				.update(videos)
				.set({ name: data.title })
				.where(eq(videos.id, videoId));
		}
	} catch (error) {
		console.error(`[generateAiMetadata] Error for video ${videoId}:`, error);

		try {
			const currentVideo = await db()
				.select()
				.from(videos)
				.where(eq(videos.id, videoId));
			if (currentVideo.length > 0 && currentVideo[0]) {
				const currentMetadata: VideoMetadata =
					(currentVideo[0].metadata as VideoMetadata) || {};
				await db()
					.update(videos)
					.set({
						metadata: {
							...currentMetadata,
							aiProcessing: false,
						},
					})
					.where(eq(videos.id, videoId));
			}
		} catch (updateError) {
			console.error(
				`[generateAiMetadata] Failed to reset processing flag:`,
				updateError,
			);
		}
	}
}
