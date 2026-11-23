export type LimitedBody =
	| { ok: true; bytes: Uint8Array }
	| { ok: false; reason: "too_large" | "unreadable" };

export async function readBodyLimited(
	request: Request,
	maxBytes: number,
): Promise<LimitedBody> {
	const declared = Number(request.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > maxBytes)
		return { ok: false, reason: "too_large" };
	if (!request.body) return { ok: true, bytes: new Uint8Array() };

	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > maxBytes) {
				await reader.cancel().catch(() => undefined);
				return { ok: false, reason: "too_large" };
			}
			chunks.push(value);
		}
	} catch {
		return { ok: false, reason: "unreadable" };
	}

	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return { ok: true, bytes };
}

export function formatSseEvent(event: string, data: unknown): string {
	return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

const SAFE_ERROR_NAME = /^[A-Za-z_][\w.]{0,63}$/;

// Provider SDK errors carry the request body (the meeting content) and raw
// provider responses, so only the error name and HTTP status are kept.
export function providerErrorSummary(error: unknown): string {
	if (error instanceof SanitizedProviderError) return error.message;
	if (!(error instanceof Error)) return "UnknownError";
	const name = SAFE_ERROR_NAME.test(error.name) ? error.name : "Error";
	if (error.cause instanceof SanitizedProviderError)
		return `${name}(${error.cause.message})`;
	const status = (error as { statusCode?: unknown }).statusCode;
	return typeof status === "number" ? `${name} status=${status}` : name;
}

export class SanitizedProviderError extends Error {
	constructor(error: unknown) {
		super(providerErrorSummary(error));
		this.name = "SanitizedProviderError";
	}
}

export type SseSend = (event: string, data: unknown) => void;

export const SSE_KEEP_ALIVE_MS = 15_000;

export function createSseResponse(
	run: (send: SseSend, signal: AbortSignal) => Promise<void>,
	options: { requestSignal?: AbortSignal; deadlineMs: number },
): Response {
	const abort = new AbortController();
	const signals = [abort.signal, AbortSignal.timeout(options.deadlineMs)];
	if (options.requestSignal) signals.push(options.requestSignal);
	const signal = AbortSignal.any(signals);
	const encoder = new TextEncoder();

	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			let open = true;
			const write = (chunk: string) => {
				if (!open) return;
				try {
					controller.enqueue(encoder.encode(chunk));
				} catch {
					open = false;
				}
			};
			const keepAlive = setInterval(
				() => write(": keep-alive\n\n"),
				SSE_KEEP_ALIVE_MS,
			);

			run((event, data) => write(formatSseEvent(event, data)), signal)
				.catch(() => undefined)
				.finally(() => {
					clearInterval(keepAlive);
					if (!open) return;
					open = false;
					try {
						controller.close();
					} catch {}
				});
		},
		cancel() {
			abort.abort();
		},
	});

	return new Response(stream, {
		headers: {
			"Content-Type": "text/event-stream; charset=utf-8",
			"Cache-Control": "no-cache, no-store, no-transform",
			"X-Accel-Buffering": "no",
		},
	});
}
