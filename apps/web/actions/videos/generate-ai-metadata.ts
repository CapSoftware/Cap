"use server";

import { db } from "@cap/database";
import { s3Buckets, videos } from "@cap/database/schema";
import type { VideoMetadata } from "@cap/database/types";
import { serverEnv } from "@cap/env";
import { eq } from "drizzle-orm";
import { GROQ_MODEL, getGroqClient } from "@/lib/groq-client";
import { createBucketProvider } from "@/utils/s3";

async function callOpenAI(prompt: string): Promise<string> {
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
		console.error(
			`[generateAiMetadata] OpenAI API error: ${aiRes.status} ${errorText}`,
		);
		throw new Error(`OpenAI API error: ${aiRes.status} ${errorText}`);
	}
	const aiJson = await aiRes.json();
	return aiJson.choices?.[0]?.message?.content || "{}";
}

async function setAiProcessingFlag(
	videoId: string,
	processing: boolean,
	currentMetadata: VideoMetadata,
) {
	await db()
		.update(videos)
		.set({
			metadata: {
				...currentMetadata,
				aiProcessing: processing,
			},
		})
		.where(eq(videos.id, videoId));
}

export async function generateAiMetadata(videoId: string, userId: string) {
	const groqClient = getGroqClient();
	if (!groqClient && !serverEnv().OPENAI_API_KEY) {
		console.error(
			"[generateAiMetadata] Missing Groq or OpenAI API key, skipping AI metadata generation",
		);
		return;
	}

	// Single optimized query to get video data with bucket info
	const query = await db()
		.select({ video: videos, bucket: s3Buckets })
		.from(videos)
		.leftJoin(s3Buckets, eq(videos.bucket, s3Buckets.id))
		.where(eq(videos.id, videoId));

	if (query.length === 0 || !query[0]?.video) {
		console.error(
			`[generateAiMetadata] Video ${videoId} not found in database`,
		);
		return;
	}

	const { video: videoData, bucket: bucketData } = query[0];
	const metadata: VideoMetadata = (videoData.metadata as VideoMetadata) || {};

	if (metadata.aiProcessing === true) {
		const updatedAtTime = new Date(videoData.updatedAt).getTime();
		const tenMinutesInMs = 10 * 60 * 1000;

		if (Date.now() - updatedAtTime > tenMinutesInMs) {
			await setAiProcessingFlag(videoId, false, metadata);
			metadata.aiProcessing = false;
		} else {
			return;
		}
	}

	if (metadata.summary || metadata.chapters) {
		if (metadata.aiProcessing) {
			await setAiProcessingFlag(videoId, false, metadata);
		}
		return;
	}

	if (videoData?.transcriptionStatus !== "COMPLETE") {
		if (metadata.aiProcessing) {
			await setAiProcessingFlag(videoId, false, metadata);
		}
		return;
	}

	try {
		// Set processing flag
		await setAiProcessingFlag(videoId, true, metadata);

		const awsBucket = videoData.awsBucket;
		if (!awsBucket) {
			console.error(
				`[generateAiMetadata] AWS bucket not found for video ${videoId}`,
			);
			throw new Error(`AWS bucket not found for video ${videoId}`);
		}

		const bucket = await createBucketProvider(bucketData);

		const transcriptKey = `${userId}/${videoId}/transcription.vtt`;
		const vtt = await bucket.getObject(transcriptKey);

		if (!vtt || vtt.length < 10) {
			console.error(
				`[generateAiMetadata] Transcript is empty or too short (${vtt?.length} chars)`,
			);
			throw new Error("Transcript is empty or too short");
		}

		const transcriptText = vtt
			.split("\n")
			.filter(
				(l) =>
					l.trim() &&
					l !== "WEBVTT" &&
					!/^\d+$/.test(l.trim()) &&
					!l.includes("-->"),
			)
			.join(" ");

		const prompt = `You are Cap AI. Summarize the transcript and provide JSON in the following format:
{
  "title": "string",
  "summary": "string (write from 1st person perspective if appropriate, e.g. 'In this video, I demonstrate...' to make it feel personable)",
  "chapters": [{"title": "string", "start": number}]
}
Return ONLY valid JSON without any markdown formatting or code blocks.
Transcript:
${transcriptText}`;

		let content = "{}";

		if (groqClient) {
			try {
				const completion = await groqClient.chat.completions.create({
					messages: [{ role: "user", content: prompt }],
					model: GROQ_MODEL,
				});
				content = completion.choices?.[0]?.message?.content || "{}";
			} catch (groqError) {
				console.error(
					`[generateAiMetadata] Groq API error: ${groqError}, falling back to OpenAI`,
				);
				// Fallback to OpenAI if Groq fails and OpenAI key exists
				if (serverEnv().OPENAI_API_KEY) {
					content = await callOpenAI(prompt);
				} else {
					throw groqError;
				}
			}
		} else if (serverEnv().OPENAI_API_KEY) {
			// Use OpenAI if Groq client is not available
			content = await callOpenAI(prompt);
		}

		// Type-safe AI response interface
		interface AIResponse {
			title?: string;
			summary?: string;
			chapters?: { title: string; start: number }[];
		}

		// Helper function to validate AI response
		function validateAIResponse(obj: unknown): AIResponse {
			const validated: AIResponse = {};

			if (typeof obj === "object" && obj !== null) {
				const data = obj as Record<string, unknown>;

				if (typeof data.title === "string" && data.title.trim()) {
					validated.title = data.title.trim();
				}

				if (typeof data.summary === "string" && data.summary.trim()) {
					validated.summary = data.summary.trim();
				}

				if (Array.isArray(data.chapters)) {
					const validChapters = data.chapters.filter(
						(chapter: unknown): chapter is { title: string; start: number } => {
							if (typeof chapter !== "object" || chapter === null) {
								return false;
							}

							const chapterObj = chapter as Record<string, unknown>;
							const title = chapterObj.title;
							const start = chapterObj.start;

							return (
								typeof title === "string" &&
								typeof start === "number" &&
								title.trim().length > 0 &&
								start >= 0
							);
						},
					);

					validated.chapters = validChapters.map((chapter) => ({
						title: chapter.title.trim(),
						start: Math.floor(chapter.start),
					}));
				}
			}

			return validated;
		}

		let data: AIResponse = {};
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

			const parsedData = JSON.parse(cleanContent.trim());
			data = validateAIResponse(parsedData);

			// Log if validation removed invalid data
			if (Object.keys(parsedData).length !== Object.keys(data).length) {
				console.warn(
					`[generateAiMetadata] Some AI response data was invalid and filtered out`,
				);
			}
		} catch (e) {
			console.error(`[generateAiMetadata] Error parsing AI response: ${e}`);
			console.error(`[generateAiMetadata] Raw content: ${content}`);
			data = {
				title: "Generated Title",
				summary:
					"The AI was unable to generate a proper summary for this content.",
				chapters: [],
			};
		}

		const currentMetadata: VideoMetadata = metadata;
		const updatedMetadata: VideoMetadata = {
			...currentMetadata,
			aiTitle: data.title || currentMetadata.aiTitle,
			summary: data.summary || currentMetadata.summary,
			chapters: data.chapters || currentMetadata.chapters,
			aiProcessing: false,
		};

		// Batch database updates
		const hasDatePattern = /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(
			videoData.name || "",
		);

		const shouldUpdateName =
			(videoData.name?.startsWith("Cap Recording -") || hasDatePattern) &&
			data.title;

		if (shouldUpdateName) {
			// Update both metadata and name in a single query
			await db()
				.update(videos)
				.set({
					metadata: updatedMetadata,
					name: data.title,
				})
				.where(eq(videos.id, videoId));
		} else {
			// Update only metadata
			await db()
				.update(videos)
				.set({ metadata: updatedMetadata })
				.where(eq(videos.id, videoId));
		}
	} catch (error) {
		console.error(`[generateAiMetadata] Error for video ${videoId}:`, error);

		try {
			// Use the metadata we already have instead of querying again
			await setAiProcessingFlag(videoId, false, metadata);
		} catch (updateError) {
			console.error(
				`[generateAiMetadata] Failed to reset processing flag:`,
				updateError,
			);
		}
	}
}
