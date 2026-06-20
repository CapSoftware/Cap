import type { Extension, Video } from "@cap/web-domain";

import type {
	BootstrapData,
	ExtensionAuth,
	ExtensionSettings,
	InstantRecordingCreation,
} from "./types";

// The JSON request body matches the encoded side of the server schema, so
// contract drift fails to compile instead of surfacing at runtime.
type CreateInstantRecordingInput =
	typeof Video.InstantRecordingCreateInput.Encoded;

// A hung request would otherwise leave the recorder UI stuck with no way out
// (the floating bar shows "creating" until the start call settles).
const API_REQUEST_TIMEOUT_MS = 30_000;
const AUTH_CHECK_TIMEOUT_MS = 10_000;

// Literal copies of the contract paths. A value import of @cap/web-domain
// would drag the effect runtime into every extension bundle, so the import
// above is type-only and these `satisfies` checks make any drift from the
// contract fail to compile instead of surfacing at runtime.
const EXTENSION_HTTP_PREFIX =
	"/extension" satisfies typeof Extension.EXTENSION_HTTP_PREFIX;

const ExtensionApiPaths = {
	startAuth: "/auth/start",
	approveAuth: "/auth/approve",
	revokeAuth: "/auth/revoke",
	bootstrap: "/bootstrap",
	createInstantRecording: "/instant-recordings",
	updateInstantRecordingProgress: "/instant-recordings/progress",
	deleteInstantRecording: (videoId: string) =>
		`/instant-recordings/${encodeURIComponent(videoId)}` as const,
} as const satisfies typeof Extension.ExtensionApiPaths;

// The web app mounts the HTTP API under /api (web-domain Http/Api.ts).
const EXTENSION_API_PREFIX = `/api${EXTENSION_HTTP_PREFIX}`;

const extensionApiPath = (path: string) => `${EXTENSION_API_PREFIX}${path}`;

const apiUrl = (settings: ExtensionSettings, path: string) =>
	new URL(path, settings.apiBaseUrl).toString();

const checkAuthStartRoute = async (
	settings: ExtensionSettings,
	url: URL,
	redirectUri: string,
) => {
	try {
		const response = await fetch(url, {
			redirect: "manual",
			signal: AbortSignal.timeout(AUTH_CHECK_TIMEOUT_MS),
		});
		if (response.type === "opaqueredirect" || response.status === 302) return;
		if (response.ok) return;
		throw new Error(`${response.status} ${await response.text()}`);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(
			`Could not reach Cap extension auth at ${url.origin}. Start the local web server with pnpm dev:extension and make sure the extension Options Cap URL is ${settings.apiBaseUrl}. Redirect URI: ${redirectUri}. ${message}`,
		);
	}
};

// Carries the HTTP status so callers can tell a definitive server answer
// (the request was processed and rejected) from a failure where the request
// may never have arrived.
export class ApiRequestError extends Error {
	readonly status: number;

	constructor(status: number, message: string) {
		super(message || `Request failed with status ${status}`);
		this.name = "ApiRequestError";
		this.status = status;
	}
}

const requestJson = async <TResponse>({
	settings,
	auth,
	path,
	method,
	body,
}: {
	settings: ExtensionSettings;
	auth: ExtensionAuth;
	path: string;
	method: "GET" | "POST" | "DELETE";
	body?: unknown;
}) => {
	const response = await fetch(apiUrl(settings, path), {
		method,
		headers: {
			Authorization: `Bearer ${auth.authApiKey}`,
			"Content-Type": "application/json",
		},
		body: body === undefined ? undefined : JSON.stringify(body),
		signal: AbortSignal.timeout(API_REQUEST_TIMEOUT_MS),
	});

	if (!response.ok) {
		throw new ApiRequestError(response.status, await response.text());
	}

	return (await response.json()) as TResponse;
};

export const createAuthStart = async (settings: ExtensionSettings) => {
	const redirectUri = chrome.identity.getRedirectURL();
	const state = crypto.randomUUID();
	const url = new URL(
		apiUrl(settings, extensionApiPath(ExtensionApiPaths.startAuth)),
	);
	url.searchParams.set("redirectUri", redirectUri);
	url.searchParams.set("state", state);

	await checkAuthStartRoute(settings, url, redirectUri);

	return { redirectUri, state, url: url.toString() };
};

export const parseAuthResponse = (responseUrl: string, state: string) => {
	const hash = new URL(responseUrl).hash.slice(1);
	const params = new URLSearchParams(hash);
	if (params.get("state") !== state) {
		throw new Error("Auth state did not match");
	}

	// The consent page's Cancel link redirects back with an error in the
	// fragment instead of a key.
	const error = params.get("error");
	if (error) {
		throw new Error(
			error === "access_denied"
				? "Sign-in was canceled."
				: `Sign-in failed: ${error}`,
		);
	}

	const authApiKey = params.get("authApiKey");
	const userId = params.get("userId");
	if (!authApiKey || !userId) {
		throw new Error("Auth response did not include a token");
	}

	return { authApiKey, userId };
};

export const revokeAuth = (settings: ExtensionSettings, auth: ExtensionAuth) =>
	requestJson<{ success: boolean }>({
		settings,
		auth,
		path: extensionApiPath(ExtensionApiPaths.revokeAuth),
		method: "POST",
	});

export const fetchBootstrap = (
	settings: ExtensionSettings,
	auth: ExtensionAuth,
) =>
	requestJson<BootstrapData>({
		settings,
		auth,
		path: extensionApiPath(ExtensionApiPaths.bootstrap),
		method: "GET",
	});

export const createInstantRecording = ({
	settings,
	auth,
	input,
}: {
	settings: ExtensionSettings;
	auth: ExtensionAuth;
	input: CreateInstantRecordingInput;
}) =>
	requestJson<InstantRecordingCreation>({
		settings,
		auth,
		path: extensionApiPath(ExtensionApiPaths.createInstantRecording),
		method: "POST",
		body: input,
	});

export const updateUploadProgress = ({
	settings,
	auth,
	videoId,
	uploaded,
	total,
}: {
	settings: ExtensionSettings;
	auth: ExtensionAuth;
	videoId: string;
	uploaded: number;
	total: number;
}) =>
	requestJson<{ success: boolean }>({
		settings,
		auth,
		path: extensionApiPath(ExtensionApiPaths.updateInstantRecordingProgress),
		method: "POST",
		body: {
			videoId,
			uploaded,
			total,
			updatedAt: new Date().toISOString(),
		},
	});

export const deleteInstantRecording = (
	settings: ExtensionSettings,
	auth: ExtensionAuth,
	videoId: string,
) =>
	requestJson<{ success: boolean }>({
		settings,
		auth,
		path: extensionApiPath(ExtensionApiPaths.deleteInstantRecording(videoId)),
		method: "DELETE",
	});
