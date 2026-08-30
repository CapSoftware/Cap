import { streamText } from "ai";
import type { NextRequest } from "next/server";
import { isAiConfigured } from "@/lib/ai/provider";
import { runWithAiProviders } from "@/lib/ai/run";
import { buildDocsAskContext, buildDocsAskSystemPrompt } from "@/lib/docs-ask";
import { isRateLimited, RATE_LIMIT_IDS } from "@/lib/rate-limit";
import { getAllDocs } from "@/utils/docs";

export const dynamic = "force-dynamic";

const MAX_QUESTION_LENGTH = 500;
const MAX_HISTORY_TURNS = 6;
const MAX_HISTORY_CONTENT_LENGTH = 4000;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 10;

const requestLog = new Map<string, number[]>();

function isLocallyRateLimited(key: string): boolean {
	const now = Date.now();
	const recent = (requestLog.get(key) ?? []).filter(
		(timestamp) => now - timestamp < RATE_LIMIT_WINDOW_MS,
	);
	if (recent.length >= RATE_LIMIT_MAX_REQUESTS) {
		requestLog.set(key, recent);
		return true;
	}
	recent.push(now);
	requestLog.set(key, recent);
	if (requestLog.size > 5000) {
		for (const [entryKey, timestamps] of requestLog) {
			if (timestamps.every((ts) => now - ts >= RATE_LIMIT_WINDOW_MS)) {
				requestLog.delete(entryKey);
			}
		}
	}
	return false;
}

interface HistoryTurn {
	role: "user" | "assistant";
	content: string;
}

function parseHistory(value: unknown): HistoryTurn[] {
	if (!Array.isArray(value)) return [];
	return value
		.flatMap((entry): HistoryTurn[] => {
			if (!entry || typeof entry !== "object") return [];
			const role = (entry as { role?: unknown }).role;
			const content = (entry as { content?: unknown }).content;
			if (role !== "user" && role !== "assistant") return [];
			if (typeof content !== "string" || !content.trim()) return [];
			return [{ role, content: content.slice(0, MAX_HISTORY_CONTENT_LENGTH) }];
		})
		.slice(-MAX_HISTORY_TURNS * 2);
}

function toStreamError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

export async function POST(request: NextRequest) {
	if (!isAiConfigured("chat-streaming")) {
		return Response.json(
			{ error: "Ask AI is not available right now. Try searching instead." },
			{ status: 503 },
		);
	}

	let payload: unknown;
	try {
		payload = await request.json();
	} catch {
		return Response.json({ error: "Invalid request." }, { status: 400 });
	}

	const question =
		payload && typeof payload === "object"
			? (payload as { question?: unknown }).question
			: undefined;
	const trimmedQuestion = typeof question === "string" ? question.trim() : "";
	if (
		trimmedQuestion.length < 3 ||
		trimmedQuestion.length > MAX_QUESTION_LENGTH
	) {
		return Response.json(
			{ error: "Ask a question between 3 and 500 characters." },
			{ status: 400 },
		);
	}

	const history = parseHistory(
		payload && typeof payload === "object"
			? (payload as { history?: unknown }).history
			: undefined,
	);

	const ip =
		request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
	if (
		isLocallyRateLimited(ip) ||
		(await isRateLimited(RATE_LIMIT_IDS.DOCS_ASK, {
			headers: request.headers,
		}))
	) {
		return Response.json(
			{ error: "Too many questions right now. Try again in a minute." },
			{ status: 429 },
		);
	}

	const docs = getAllDocs();
	const rankingQuery = [
		...history
			.filter((turn) => turn.role === "user")
			.map((turn) => turn.content),
		trimmedQuestion,
	].join(" ");
	const { context } = buildDocsAskContext(rankingQuery, docs);
	const system = buildDocsAskSystemPrompt({
		pages: docs.map((doc) => ({ slug: doc.slug, title: doc.metadata.title })),
		context,
	});

	const upstream = await runWithAiProviders("chat-streaming", (selection) => {
		const result = streamText({
			model: selection.model(),
			system,
			messages: [...history, { role: "user", content: trimmedQuestion }],
			maxOutputTokens: selection.defaultMaxOutputTokens,
			abortSignal: AbortSignal.timeout(60_000),
		});

		const reader = result.fullStream.getReader();
		const buffered: string[] = [];

		// Read ahead to the first text delta so provider setup failures fall
		// through to the next provider before any bytes reach the client.
		// Once streaming has started, mid-stream breaks behave as before.
		const readAhead = async () => {
			while (buffered.length === 0) {
				const { done, value } = await reader.read();
				if (done) break;
				if (value.type === "error") throw toStreamError(value.error);
				if (value.type === "abort")
					throw new Error(value.reason ?? "docs-ask stream aborted");
				if (value.type === "text-delta" && value.text)
					buffered.push(value.text);
			}
			if (buffered.length === 0) {
				// A completion with no visible text (eg. thinking consumed the
				// whole token budget) is a failure — let the chain try the next
				// provider rather than streaming an empty answer.
				throw new Error("docs-ask stream produced no text");
			}
			return { reader, buffered };
		};

		return readAhead();
	}).catch((error) => {
		console.error("docs-ask upstream error", error);
		return null;
	});

	if (!upstream) {
		return Response.json(
			{ error: "Ask AI is having trouble right now. Try again shortly." },
			{ status: 502 },
		);
	}

	const encoder = new TextEncoder();

	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const text of upstream.buffered) {
				controller.enqueue(encoder.encode(text));
			}
			const pump = (): Promise<void> =>
				upstream.reader.read().then(({ done, value }) => {
					if (done) {
						controller.close();
						return;
					}
					if (value.type === "error") throw toStreamError(value.error);
					if (value.type === "abort")
						throw new Error(value.reason ?? "docs-ask stream aborted");
					if (value.type === "text-delta" && value.text) {
						controller.enqueue(encoder.encode(value.text));
					}
					return pump();
				});
			return pump().catch((error) => controller.error(error));
		},
		cancel(reason) {
			upstream.reader.cancel(reason).catch(() => undefined);
		},
	});

	return new Response(stream, {
		headers: {
			"Content-Type": "text/plain; charset=utf-8",
			"Cache-Control": "no-store",
		},
	});
}
