import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { serverEnv } from "@cap/env";

export type RenderFarmConfig = {
	url: string;
	token: string;
	callbackSecret: string | null;
};

export function renderFarmConfig(): RenderFarmConfig | null {
	const env = serverEnv();
	if (!env.RENDER_FARM_URL || !env.RENDER_FARM_TOKEN) return null;
	return {
		url: env.RENDER_FARM_URL.replace(/\/+$/, ""),
		token: env.RENDER_FARM_TOKEN,
		callbackSecret: env.RENDER_FARM_CALLBACK_SECRET ?? null,
	};
}

export function renderFarmKeys(
	ownerId: string,
	videoId: string,
	exportId: string,
	output: "result" | "export" = "result",
) {
	const root = `${ownerId}/${videoId}/`;
	const folder = `${root}.recording/render/${exportId}`;
	return {
		root,
		recording: `${folder}/project`,
		outputKey: `${folder}/${output}.mp4`,
		hlsPrefix: `${folder}/hls`,
	};
}

export type RenderFarmJobKind = "save" | "recording" | "export";

/**
 * The job reference the farm echoes in callbacks. Saves predate kinds and
 * use the bare video id.
 */
export function renderFarmReference(kind: RenderFarmJobKind, videoId: string) {
	return kind === "save" ? videoId : `${kind}:${videoId}`;
}

export function parseRenderFarmReference(
	reference: string,
): { kind: RenderFarmJobKind; videoId: string } | null {
	const separator = reference.indexOf(":");
	const kind = separator === -1 ? "save" : reference.slice(0, separator);
	const videoId = separator === -1 ? reference : reference.slice(separator + 1);
	if (
		(kind !== "save" && kind !== "recording" && kind !== "export") ||
		!/^[A-Za-z0-9_-]{1,64}$/.test(videoId)
	) {
		return null;
	}
	return { kind, videoId };
}

export function renderFarmTranscodeKey(
	root: string,
	sourceKey: string,
	identity: string,
) {
	const digest = createHash("sha256")
		.update(`${sourceKey}\0${identity}`)
		.digest("hex")
		.slice(0, 32);
	return `${root}.recording/render/sources/${digest}.mp4`;
}

/**
 * Where the farm reports a finished render. Vercel preview deployments sit
 * behind deployment protection, which would turn the callback away; the
 * automation bypass secret lets it through (custom domains are unprotected).
 */
export function renderFarmCallbackUrl(
	origin: string,
	bypassSecret: string | undefined,
) {
	const url = new URL("/api/render-farm/callback", origin);
	if (bypassSecret && url.hostname.endsWith(".vercel.app")) {
		url.searchParams.set("x-vercel-protection-bypass", bypassSecret);
	}
	return url.toString();
}

export function verifyRenderFarmSignature(
	body: string,
	header: string | null,
	secret: string,
) {
	if (!header?.startsWith("sha256=")) return false;
	const given = Buffer.from(header.slice("sha256=".length), "hex");
	const expected = createHmac("sha256", secret).update(body).digest();
	return given.length === expected.length && timingSafeEqual(given, expected);
}

export type RenderFarmJobStatus = {
	state: "rendering" | "ready" | "error" | "gone";
	progress: number;
	playable: boolean;
	hlsUrl: string | null;
	error: string | null;
	output: {
		width: number;
		height: number;
		frames: number;
		fps: number;
		bytes: number;
	} | null;
};

function finiteNumber(value: unknown) {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function mapRenderFarmJob(
	response: { status: number; body: unknown },
	fps: number,
): RenderFarmJobStatus {
	const gone: RenderFarmJobStatus = {
		state: "gone",
		progress: 0,
		playable: false,
		hlsUrl: null,
		error: null,
		output: null,
	};
	if (response.status === 404) return gone;
	const job = response.body;
	if (response.status !== 200 || typeof job !== "object" || job === null) {
		throw new Error(`Render farm status ${response.status}`);
	}
	const record = job as Record<string, unknown>;
	const status = record.status;
	const progress = Math.min(1, Math.max(0, finiteNumber(record.progress) ?? 0));
	const hlsUrl =
		typeof record.hlsUrl === "string" && record.hlsUrl.startsWith("https://")
			? record.hlsUrl
			: null;
	const output =
		typeof record.output === "object" && record.output !== null
			? (record.output as Record<string, unknown>)
			: {};
	const width = finiteNumber(output.width) ?? 0;
	const height = finiteNumber(output.height) ?? 0;
	const frames = finiteNumber(output.frames) ?? 0;
	const bytes = finiteNumber(output.bytes) ?? 0;
	if (status === "ready") {
		return {
			state: "ready",
			progress: 1,
			playable: hlsUrl !== null,
			hlsUrl,
			error: null,
			output:
				width > 0 && height > 0 && frames > 0 && bytes > 0
					? {
							width,
							height,
							frames,
							fps: finiteNumber(record.fps) ?? fps,
							bytes,
						}
					: null,
		};
	}
	if (status === "error") {
		return {
			...gone,
			state: "error",
			error:
				typeof record.error === "string"
					? record.error.slice(0, 500)
					: "Export failed",
		};
	}
	return {
		state: "rendering",
		progress: Math.min(progress, 0.99),
		playable: hlsUrl !== null && (finiteNumber(record.hlsSegments) ?? 0) > 0,
		hlsUrl,
		error: null,
		output: null,
	};
}

export async function renderFarmFetch(
	config: RenderFarmConfig,
	path: string,
	init: RequestInit = {},
) {
	const headers = new Headers(init.headers);
	headers.set("authorization", `Bearer ${config.token}`);
	if (init.body) headers.set("content-type", "application/json");
	return fetch(`${config.url}${path}`, {
		...init,
		headers,
		redirect: "error",
		signal: init.signal ?? AbortSignal.timeout(15_000),
	});
}
