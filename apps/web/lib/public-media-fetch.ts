import { isIP } from "node:net";
import {
	isBlockedS3Endpoint,
	isPrivateAddress,
} from "@/lib/s3-endpoint-policy";
import { requestPublicOnly } from "@/lib/storage-fetch";

export const PUBLIC_MEDIA_MAX_REDIRECTS = 5;
const PUBLIC_MEDIA_MAX_URL_LENGTH = 2_048;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export type PublicMediaProblem =
	| "invalid_url"
	| "unsupported_scheme"
	| "credentials_in_url"
	| "unsupported_port"
	| "private_address"
	| "too_many_redirects"
	| "bad_status"
	| "too_large";

export class PublicMediaFetchError extends Error {
	readonly problem: PublicMediaProblem;

	constructor(problem: PublicMediaProblem, message: string) {
		super(message);
		this.name = "PublicMediaFetchError";
		this.problem = problem;
	}
}

const PROBLEM_MESSAGES: Record<
	Exclude<
		PublicMediaProblem,
		"too_many_redirects" | "bad_status" | "too_large"
	>,
	string
> = {
	invalid_url: "The URL is not valid",
	unsupported_scheme: "The URL must start with http:// or https://",
	credentials_in_url: "The URL must not contain a username or password",
	unsupported_port: "The URL must use the default port for its scheme",
	private_address: "The URL must point to a public address",
};

export function publicMediaUrlProblem(
	value: string,
): keyof typeof PROBLEM_MESSAGES | null {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > PUBLIC_MEDIA_MAX_URL_LENGTH
	) {
		return "invalid_url";
	}
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return "invalid_url";
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		return "unsupported_scheme";
	}
	if (url.username || url.password) return "credentials_in_url";
	if (url.port !== "") return "unsupported_port";
	const hostname = url.hostname
		.toLowerCase()
		.replace(/^\[|\]$/g, "")
		.replace(/\.$/, "");
	if (!hostname) return "invalid_url";
	if (
		hostname === "localhost" ||
		hostname.endsWith(".localhost") ||
		hostname.endsWith(".local") ||
		hostname.endsWith(".internal")
	) {
		return "private_address";
	}
	if (isIP(hostname) && isPrivateAddress(hostname)) return "private_address";
	return null;
}

export function publicMediaProblemMessage(
	problem: keyof typeof PROBLEM_MESSAGES,
) {
	return PROBLEM_MESSAGES[problem];
}

export type PublicMediaGuards = {
	isBlocked?: (url: string) => Promise<boolean>;
	request?: (url: string, init: RequestInit) => Promise<Response>;
};

export async function assertPublicMediaUrl(
	value: string,
	isBlocked: (url: string) => Promise<boolean> = isBlockedS3Endpoint,
) {
	const problem = publicMediaUrlProblem(value);
	if (problem) {
		throw new PublicMediaFetchError(problem, PROBLEM_MESSAGES[problem]);
	}
	if (await isBlocked(value)) {
		throw new PublicMediaFetchError(
			"private_address",
			PROBLEM_MESSAGES.private_address,
		);
	}
}

export async function fetchPublicMedia(
	url: string,
	options: {
		maxBytes: number;
		signal?: AbortSignal;
		maxRedirects?: number;
	} & PublicMediaGuards,
): Promise<{
	response: Response;
	finalUrl: string;
	contentLength: number | null;
}> {
	const isBlocked = options.isBlocked ?? isBlockedS3Endpoint;
	const request = options.request ?? requestPublicOnly;
	const maxRedirects = options.maxRedirects ?? PUBLIC_MEDIA_MAX_REDIRECTS;
	let current = url;
	for (let hop = 0; ; hop++) {
		await assertPublicMediaUrl(current, isBlocked);
		const response = await request(current, {
			method: "GET",
			headers: {
				accept: "audio/*, video/*, application/octet-stream;q=0.9, */*;q=0.5",
				"accept-encoding": "identity",
				"user-agent": "CapInfra/1.0",
			},
			signal: options.signal,
		});
		if (REDIRECT_STATUSES.has(response.status)) {
			const location = response.headers.get("location");
			await response.body?.cancel().catch(() => {});
			if (!location) {
				throw new PublicMediaFetchError(
					"bad_status",
					`The URL answered ${response.status} without a location`,
				);
			}
			if (hop >= maxRedirects) {
				throw new PublicMediaFetchError(
					"too_many_redirects",
					"The URL redirected too many times",
				);
			}
			try {
				current = new URL(location, current).toString();
			} catch {
				throw new PublicMediaFetchError(
					"invalid_url",
					"The URL redirected to an invalid address",
				);
			}
			continue;
		}
		if (response.status !== 200) {
			await response.body?.cancel().catch(() => {});
			throw new PublicMediaFetchError(
				"bad_status",
				`The URL answered ${response.status}`,
			);
		}
		const declared = Number(response.headers.get("content-length"));
		const contentLength =
			response.headers.has("content-length") &&
			Number.isSafeInteger(declared) &&
			declared >= 0
				? declared
				: null;
		if (contentLength !== null && contentLength > options.maxBytes) {
			await response.body?.cancel().catch(() => {});
			throw new PublicMediaFetchError(
				"too_large",
				"The file at the URL is larger than the limit",
			);
		}
		return { response, finalUrl: current, contentLength };
	}
}

export class StreamTooLargeError extends Error {
	constructor(readonly maxBytes: number) {
		super(`The stream is larger than ${maxBytes} bytes`);
		this.name = "StreamTooLargeError";
	}
}

export function limitStreamBytes(
	stream: ReadableStream<Uint8Array>,
	maxBytes: number,
	tooLarge: () => Error = () =>
		new PublicMediaFetchError(
			"too_large",
			"The file at the URL is larger than the limit",
		),
): ReadableStream<Uint8Array> {
	let total = 0;
	return stream.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				total += chunk.byteLength;
				if (total > maxBytes) {
					controller.error(tooLarge());
					return;
				}
				controller.enqueue(chunk);
			},
		}),
	);
}

export async function readStreamBounded(
	stream: ReadableStream<Uint8Array>,
	maxBytes: number,
): Promise<Buffer> {
	const reader = limitStreamBytes(
		stream,
		maxBytes,
		() => new StreamTooLargeError(maxBytes),
	).getReader();
	const chunks: Uint8Array[] = [];
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(value);
	}
	return Buffer.concat(chunks);
}
