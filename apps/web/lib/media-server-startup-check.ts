export type MediaServerUrlCheck =
	| { status: "unset" }
	| { status: "invalid"; message: string }
	| { status: "unreachable"; url: string; message: string }
	| { status: "ok"; url: string };

export function parseMediaServerUrl(
	raw: string,
): { ok: true; url: URL } | { ok: false; message: string } {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return {
			ok: false,
			message: `MEDIA_SERVER_URL "${raw}" is not a valid URL (expected e.g. http://media-server:3456)`,
		};
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		return {
			ok: false,
			message: `MEDIA_SERVER_URL must use http or https, got "${url.protocol}"`,
		};
	}
	if (!url.hostname) {
		return { ok: false, message: "MEDIA_SERVER_URL has no host" };
	}
	return { ok: true, url };
}

export async function checkMediaServerUrl(
	raw: string | undefined,
	options: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<MediaServerUrlCheck> {
	if (!raw?.trim()) return { status: "unset" };
	const parsed = parseMediaServerUrl(raw.trim());
	if (!parsed.ok) return { status: "invalid", message: parsed.message };

	const healthUrl = new URL("/health", parsed.url).toString();
	const fetchImpl = options.fetchImpl ?? fetch;
	try {
		const response = await fetchImpl(healthUrl, {
			signal: AbortSignal.timeout(options.timeoutMs ?? 3000),
		});
		if (!response.ok) {
			return {
				status: "unreachable",
				url: healthUrl,
				message: `${healthUrl} returned HTTP ${response.status}`,
			};
		}
		return { status: "ok", url: healthUrl };
	} catch (error) {
		const reason =
			error instanceof Error
				? (error.cause instanceof Error ? error.cause.message : null) ||
					error.message
				: String(error);
		return {
			status: "unreachable",
			url: healthUrl,
			message: `${healthUrl} is not reachable (${reason})`,
		};
	}
}

const MEDIA_SERVER_CHECK_ATTEMPTS = 5;
const MEDIA_SERVER_CHECK_RETRY_MS = 2_000;

export async function logMediaServerUrlCheck(
	raw: string | undefined = process.env.MEDIA_SERVER_URL,
) {
	let result = await checkMediaServerUrl(raw);
	for (
		let attempt = 1;
		result.status === "unreachable" && attempt < MEDIA_SERVER_CHECK_ATTEMPTS;
		attempt++
	) {
		await new Promise((resolve) =>
			setTimeout(resolve, MEDIA_SERVER_CHECK_RETRY_MS),
		);
		result = await checkMediaServerUrl(raw);
	}
	switch (result.status) {
		case "unset":
			console.warn(
				"⚠️  MEDIA_SERVER_URL is not set: video conversion, thumbnails and audio processing are disabled.",
			);
			return result;
		case "invalid":
			console.warn(
				`⚠️  ${result.message}. Video processing will fail until it is fixed.`,
			);
			return result;
		case "unreachable":
			console.warn(
				`⚠️  Media server check failed: ${result.message}. Check that the media server is running and that MEDIA_SERVER_URL points at its service name/private host.`,
			);
			return result;
		case "ok":
			console.log(`✅ Media server reachable at ${result.url}`);
			return result;
	}
}
