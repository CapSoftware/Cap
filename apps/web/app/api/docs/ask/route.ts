import { serverEnv } from "@cap/env";
import type { NextRequest } from "next/server";
import { buildDocsAskContext, buildDocsAskSystemPrompt } from "@/lib/docs-ask";
import { isRateLimited, RATE_LIMIT_IDS } from "@/lib/rate-limit";
import { getAllDocs } from "@/utils/docs";

export const dynamic = "force-dynamic";

const ASK_MODEL = "claude-sonnet-5";
const ASK_MAX_TOKENS = 800;
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

function extractDeltaText(data: string): string | null {
	try {
		const event = JSON.parse(data) as {
			type?: unknown;
			delta?: { type?: unknown; text?: unknown };
		};
		if (
			event.type === "content_block_delta" &&
			event.delta?.type === "text_delta" &&
			typeof event.delta.text === "string"
		) {
			return event.delta.text;
		}
	} catch {
		return null;
	}
	return null;
}

export async function POST(request: NextRequest) {
	const key = serverEnv().ANTHROPIC_API_KEY;
	if (!key) {
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

	const upstream = await fetch("https://api.anthropic.com/v1/messages", {
		method: "POST",
		headers: {
			"x-api-key": key,
			"anthropic-version": "2023-06-01",
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			model: ASK_MODEL,
			max_tokens: ASK_MAX_TOKENS,
			stream: true,
			system,
			messages: [...history, { role: "user", content: trimmedQuestion }],
		}),
		signal: AbortSignal.timeout(60_000),
	}).catch((error) => {
		console.error("docs-ask upstream fetch failed", error);
		return null;
	});

	if (!upstream || !upstream.ok || !upstream.body) {
		const detail = upstream ? await upstream.text().catch(() => "") : "fetch";
		console.error("docs-ask upstream error", upstream?.status, detail);
		return Response.json(
			{ error: "Ask AI is having trouble right now. Try again shortly." },
			{ status: 502 },
		);
	}

	const upstreamBody = upstream.body;
	const encoder = new TextEncoder();
	const decoder = new TextDecoder();
	let buffer = "";

	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			const reader = upstreamBody.getReader();
			const pump = (): Promise<void> =>
				reader.read().then(({ done, value }) => {
					if (done) {
						controller.close();
						return;
					}
					buffer += decoder.decode(value, { stream: true });
					const lines = buffer.split("\n");
					buffer = lines.pop() ?? "";
					for (const line of lines) {
						if (!line.startsWith("data:")) continue;
						const text = extractDeltaText(line.slice(5).trim());
						if (text) controller.enqueue(encoder.encode(text));
					}
					return pump();
				});
			return pump().catch((error) => controller.error(error));
		},
		cancel(reason) {
			upstreamBody.cancel(reason).catch(() => undefined);
		},
	});

	return new Response(stream, {
		headers: {
			"Content-Type": "text/plain; charset=utf-8",
			"Cache-Control": "no-store",
		},
	});
}
