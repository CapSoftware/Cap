import type { UrlSourceOptions } from "mediabunny";
import {
	BrowserEditorSourceCatalog,
	type BrowserEditorSources,
} from "./browser-sources";

export type SignedSourceUrl = { url: string; expiresAt: number };

export type SourceUrlRenewRequest = {
	kind: "renew-source-url";
	id: number;
	original: string;
	rejected: string;
};

export type SourceUrlRenewReply = {
	kind: "source-url-renewed";
	id: number;
	renewed: SignedSourceUrl | null;
	message: string | null;
};

export class SourceUrlExpired extends Error {}

/// Expired signed links answer 403 (S3, CloudFront) or 400/401 from stores
/// that reject a stale signature outright.
function rejectsSignedUrl(status: number) {
	return status === 400 || status === 401 || status === 403;
}

/// A cross-origin store can refuse an expired link without CORS headers, which
/// reaches fetch as a network error; past expiry that is treated as a refusal.
const EXPIRY_MARGIN_MS = 30_000;

function messageOf(cause: unknown) {
	return cause instanceof Error ? cause.message : String(cause);
}

export class SourceUrlRenewer {
	private readonly latest = new Map<string, SignedSourceUrl>();
	private readonly pending = new Map<string, Promise<SignedSourceUrl>>();

	constructor(
		private readonly request: (
			original: string,
			rejected: string,
		) => Promise<SignedSourceUrl>,
		public expiresAt: number | null = null,
	) {}

	current(original: string): SignedSourceUrl {
		return (
			this.latest.get(original) ?? {
				url: original,
				expiresAt: this.expiresAt ?? Number.POSITIVE_INFINITY,
			}
		);
	}

	renew(original: string, rejected: string): Promise<SignedSourceUrl> {
		const current = this.current(original);
		if (current.url !== rejected) return Promise.resolve(current);
		let pending = this.pending.get(original);
		if (!pending) {
			pending = this.request(original, rejected)
				.then((renewed) => {
					this.latest.set(original, renewed);
					return renewed;
				})
				.finally(() => this.pending.delete(original));
			this.pending.set(original, pending);
		}
		return pending;
	}

	private async renewed(original: string, used: string) {
		try {
			return await this.renew(original, used);
		} catch (cause) {
			throw new SourceUrlExpired(
				`Recording link expired and could not be renewed: ${messageOf(cause)}`,
			);
		}
	}

	fetch(original: string): typeof fetch {
		return async (_input, init) => {
			const used = this.current(original);
			let response: Response;
			try {
				response = await fetch(used.url, init);
			} catch (cause) {
				if (Date.now() < used.expiresAt - EXPIRY_MARGIN_MS) throw cause;
				const renewed = await this.renewed(original, used.url);
				return fetch(renewed.url, init);
			}
			if (!rejectsSignedUrl(response.status)) return response;
			await response.body?.cancel().catch(() => undefined);
			const renewed = await this.renewed(original, used.url);
			const retried = await fetch(renewed.url, init);
			if (rejectsSignedUrl(retried.status)) {
				await retried.body?.cancel().catch(() => undefined);
				throw new SourceUrlExpired(
					`Recording could not be read after renewing its link (${retried.status})`,
				);
			}
			return retried;
		};
	}

	urlSourceOptions(original: string, maxCacheSize: number): UrlSourceOptions {
		return {
			maxCacheSize,
			fetchFn: this.fetch(original),
			getRetryDelay: (attempts, error) =>
				error instanceof SourceUrlExpired
					? null
					: Math.min(2 ** (attempts - 2), 16),
		};
	}
}

export function parentSourceUrlRenewer(
	target: { postMessage: (message: SourceUrlRenewRequest) => void },
	expiresAt: number | null = null,
) {
	let nextId = 1;
	const waiting = new Map<
		number,
		{
			resolve: (renewed: SignedSourceUrl) => void;
			reject: (error: Error) => void;
		}
	>();
	const renewer = new SourceUrlRenewer(
		(original, rejected) =>
			new Promise<SignedSourceUrl>((resolve, reject) => {
				const id = nextId++;
				waiting.set(id, { resolve, reject });
				target.postMessage({
					kind: "renew-source-url",
					id,
					original,
					rejected,
				});
			}),
		expiresAt,
	);
	const answer = (reply: SourceUrlRenewReply) => {
		const entry = waiting.get(reply.id);
		if (!entry) return;
		waiting.delete(reply.id);
		if (reply.renewed) entry.resolve(reply.renewed);
		else entry.reject(new Error(reply.message ?? "Recording link was refused"));
	};
	return { renewer, answer };
}

export function answerSourceUrlRenewal(
	child: { postMessage: (message: SourceUrlRenewReply) => void },
	request: SourceUrlRenewRequest,
	renew: (original: string, rejected: string) => Promise<SignedSourceUrl>,
) {
	void renew(request.original, request.rejected).then(
		(renewed) =>
			child.postMessage({
				kind: "source-url-renewed",
				id: request.id,
				renewed,
				message: null,
			}),
		(cause: unknown) =>
			child.postMessage({
				kind: "source-url-renewed",
				id: request.id,
				renewed: null,
				message: messageOf(cause),
			}),
	);
}

function hasKind(message: unknown, kind: string) {
	return (
		typeof message === "object" &&
		message !== null &&
		(message as { kind?: unknown }).kind === kind
	);
}

export function isSourceUrlRenewRequest(
	message: unknown,
): message is SourceUrlRenewRequest {
	return hasKind(message, "renew-source-url");
}

export function isSourceUrlRenewReply(
	message: unknown,
): message is SourceUrlRenewReply {
	return hasKind(message, "source-url-renewed");
}

type SourceRole = { url: string; size: number | null };

function sourceRoles(sources: BrowserEditorSources) {
	const roles = new Map<string, SourceRole>();
	const add = (
		role: string,
		source: { url: string; size?: number | null } | null,
	) => {
		if (source) roles.set(role, { url: source.url, size: source.size ?? null });
	};
	sources.segments.forEach((segment, index) => {
		add(`${index}:display`, segment.display);
		add(`${index}:camera`, segment.camera);
	});
	add("mic", sources.mic);
	add("system", sources.systemAudio);
	add("input", sources.inputEvents);
	return roles;
}

/// Links are matched to a fresh set by the part they play (segment and track),
/// since every signature in the set changes.
export class SourceUrlRefresher {
	private readonly roleOf = new Map<
		string,
		{ role: string; size: number | null }
	>();
	private fresh: {
		sources: Promise<BrowserEditorSources>;
		expiresAt: number;
	} | null = null;

	constructor(
		original: BrowserEditorSources,
		private readonly load: () => Promise<BrowserEditorSources>,
	) {
		for (const [role, source] of sourceRoles(original)) {
			if (!this.roleOf.has(source.url))
				this.roleOf.set(source.url, { role, size: source.size });
		}
	}

	knows(url: string) {
		return this.roleOf.has(url);
	}

	private freshSources() {
		const fresh = this.fresh;
		if (fresh && fresh.expiresAt > Date.now() + EXPIRY_MARGIN_MS)
			return fresh.sources;
		const sources = this.load();
		const next = { sources, expiresAt: Number.POSITIVE_INFINITY };
		this.fresh = next;
		sources.then(
			(value) => {
				next.expiresAt = value.expiresAt;
			},
			() => {
				if (this.fresh === next) this.fresh = null;
			},
		);
		return sources;
	}

	async renew(original: string, rejected: string): Promise<SignedSourceUrl> {
		const known = this.roleOf.get(original);
		if (!known) throw new Error("Recording link is not one this export uses");
		let sources = await this.freshSources();
		let replacement = sourceRoles(sources).get(known.role);
		if (replacement?.url === rejected) {
			this.fresh = null;
			sources = await this.freshSources();
			replacement = sourceRoles(sources).get(known.role);
		}
		if (!replacement) throw new Error("Recording no longer has this source");
		if (
			known.size !== null &&
			replacement.size !== null &&
			known.size !== replacement.size
		) {
			throw new Error("Recording changed while it was exporting");
		}
		return { url: replacement.url, expiresAt: sources.expiresAt };
	}
}

export function exportSourceRefresher(
	videoId: string,
	sources: BrowserEditorSources,
) {
	return new SourceUrlRefresher(sources, async () => {
		const catalog = new BrowserEditorSourceCatalog(videoId, { fresh: true });
		try {
			return await catalog.snapshot(new AbortController().signal);
		} finally {
			catalog.dispose();
		}
	});
}
