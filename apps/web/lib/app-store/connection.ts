import "server-only";

import {
	type CapRequest,
	type CapRequestKind,
	CONNECTION_TIMEOUT_MS,
	isFirstPartyConnectionUrl,
	signCapRequest,
} from "@cap/app-store";
import { nanoId } from "@cap/database/helpers";
import { serverEnv } from "@cap/env";
import { checkWebhookUrl } from "@/lib/developer-webhook-delivery";
import { requestPublicOnly } from "@/lib/storage-fetch";
import { firstPartyConnectionHandler } from "./first-party";
import { appStoreSigningKey } from "./signing";

export const RESPONSE_BODY_MAX_BYTES = 64 * 1024;

export type ConnectionErrorCode =
	| "invalid_url"
	| "private_address"
	| "timeout"
	| "connection_failed"
	| "redirect"
	| "http_error"
	| "response_too_large";

export type ConnectionResult =
	| { ok: true; status: number; body: string | null; durationMs: number }
	| {
			ok: false;
			status: number | null;
			errorCode: ConnectionErrorCode;
			durationMs: number;
	  };

export type ConnectionTarget = { appId: string; url: string };

export const connectionPath = (
	request: CapRequest,
): "lifecycle" | "events" | `actions/${string}` =>
	request.kind === "lifecycle"
		? "lifecycle"
		: request.kind === "event"
			? "events"
			: `actions/${encodeURIComponent(request.action)}`;

const requestKind = (request: CapRequest): CapRequestKind => request.kind;

async function readLimited(response: Response): Promise<string | null> {
	if (!response.body) return "";
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > RESPONSE_BODY_MAX_BYTES) {
			await reader.cancel().catch(() => {});
			return null;
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(bytes);
}

export async function sendConnectionRequest(
	target: ConnectionTarget,
	request: CapRequest,
	options: {
		readBody?: boolean;
		timeoutMs?: number;
		requestId?: string;
		fetcher?: (url: string, init: RequestInit) => Promise<Response>;
	} = {},
): Promise<ConnectionResult> {
	const started = Date.now();
	const elapsed = () => Date.now() - started;
	const body = JSON.stringify(request);
	const requestId = options.requestId ?? `req_${nanoId()}`;
	const headers = {
		"content-type": "application/json",
		"user-agent": "Cap-App-Store/1.0",
		...signCapRequest({
			key: appStoreSigningKey(),
			body,
			requestId,
			kind: requestKind(request),
		}),
	};
	const path = connectionPath(request);
	const firstParty = isFirstPartyConnectionUrl(target.url);
	const url = firstParty
		? `${serverEnv().WEB_URL}${target.url}/${path}`
		: `${target.url}/${path}`;

	const abort = new AbortController();
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		abort.abort();
	}, options.timeoutMs ?? CONNECTION_TIMEOUT_MS);

	try {
		let response: Response;
		if (firstParty) {
			const handler = firstPartyConnectionHandler(target.appId);
			if (!handler) {
				return {
					ok: false,
					status: null,
					errorCode: "connection_failed",
					durationMs: elapsed(),
				};
			}
			response = await handler(
				new Request(url, {
					method: "POST",
					headers,
					body,
					signal: abort.signal,
				}),
			);
		} else {
			const problem = await checkWebhookUrl(url);
			if (problem) {
				return {
					ok: false,
					status: null,
					errorCode:
						problem === "private_address" ? "private_address" : "invalid_url",
					durationMs: elapsed(),
				};
			}
			response = await (options.fetcher ?? requestPublicOnly)(url, {
				method: "POST",
				headers,
				body,
				signal: abort.signal,
			});
		}

		const status = response.status;
		if (status >= 300 && status < 400) {
			await response.body?.cancel().catch(() => {});
			return {
				ok: false,
				status,
				errorCode: "redirect",
				durationMs: elapsed(),
			};
		}
		if (status < 200 || status >= 300) {
			await response.body?.cancel().catch(() => {});
			return {
				ok: false,
				status,
				errorCode: "http_error",
				durationMs: elapsed(),
			};
		}
		if (!options.readBody) {
			await response.body?.cancel().catch(() => {});
			return { ok: true, status, body: null, durationMs: elapsed() };
		}
		const text = await readLimited(response);
		if (text === null) {
			return {
				ok: false,
				status,
				errorCode: "response_too_large",
				durationMs: elapsed(),
			};
		}
		return { ok: true, status, body: text, durationMs: elapsed() };
	} catch (error) {
		if (timedOut) {
			return {
				ok: false,
				status: null,
				errorCode: "timeout",
				durationMs: elapsed(),
			};
		}
		return {
			ok: false,
			status: null,
			errorCode:
				error instanceof Error && /private address/i.test(error.message)
					? "private_address"
					: "connection_failed",
			durationMs: elapsed(),
		};
	} finally {
		clearTimeout(timer);
		abort.abort();
	}
}
