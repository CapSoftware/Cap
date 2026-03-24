import { createMutation } from "@tanstack/solid-query";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { onOpenUrl } from "@tauri-apps/plugin-deep-link";
import * as shell from "@tauri-apps/plugin-shell";
import { z } from "zod";
import callbackTemplate from "~/components/callback.template";
import { authStore, generalSettingsStore } from "~/store";
import { identifyUser, trackEvent } from "./analytics";
import { commands } from "./tauri";

const paramsValidator = z.union([
	z.object({
		type: z.literal("api_key"),
		api_key: z.string(),
		user_id: z.string(),
	}),
	z.object({
		token: z.string(),
		user_id: z.string(),
		expires: z.coerce.number(),
	}),
]);

type AuthParams = z.infer<typeof paramsValidator>;

export function createSignInMutation() {
	return createMutation(() => ({
		mutationFn: async (abort: AbortController) => {
			const session = import.meta.env.DEV
				? await createLocalServerSession(abort.signal)
				: await createHybridDesktopSession(abort.signal);

			await shell.open(session.url.toString());

			const res = await session.complete();
			if (res) await processAuthData(res);

			getCurrentWindow().setFocus();
		},
	}));
}

async function createSessionRequestUrl(
	port: string | null,
	platform: "web" | "desktop",
) {
	const serverUrl =
		(await generalSettingsStore.get())?.serverUrl ?? "https://cap.so";
	const callbackUrl = new URL(
		`/api/desktop/session/request?type=api_key`,
		serverUrl,
	);

	if (port !== null) callbackUrl.searchParams.set("port", port);
	callbackUrl.searchParams.set("platform", platform);

	return callbackUrl;
}

async function createLocalServerSession(signal: AbortSignal) {
	const localCallback = await startLocalCallbackSession(signal);

	return {
		url: await createSessionRequestUrl(localCallback.port, "web"),
		complete: async () => {
			const result = await localCallback.complete;
			await localCallback.dispose();

			if (!result) return null;
			if (signal.aborted) throw new Error("Sign in aborted");

			return result;
		},
	};
}

async function createHybridDesktopSession(signal: AbortSignal) {
	const deepLink = await startDeepLinkSession(signal);
	const localCallback = await startLocalCallbackSession(signal);

	return {
		url: await createSessionRequestUrl(localCallback.port, "desktop"),
		complete: async () => {
			const result = await Promise.race([
				deepLink.complete.then((data) => ({
					source: "deep-link" as const,
					data,
				})),
				localCallback.complete.then((data) => ({
					source: "local" as const,
					data,
				})),
			]);

			await deepLink.dispose();

			if (result.source === "deep-link") {
				window.setTimeout(() => {
					void localCallback.dispose();
				}, 10000);
			} else {
				await localCallback.dispose();
			}

			if (!result.data) return null;
			if (signal.aborted) throw new Error("Sign in aborted");

			return result.data;
		},
	};
}

async function startLocalCallbackSession(signal: AbortSignal) {
	await invoke("plugin:oauth|stop").catch(() => {});

	const port: string = await invoke("plugin:oauth|start", {
		config: {
			response: callbackTemplate,
			headers: {
				"Content-Type": "text/html; charset=utf-8",
				"Cache-Control": "no-store, no-cache, must-revalidate",
				Pragma: "no-cache",
			},
			cleanup: true,
		},
	});

	let settled = false;
	let stopListening: (() => void) | undefined;
	let resolvePromise: (data: AuthParams | null) => void = () => {};

	const complete = new Promise<AuthParams | null>((resolve) => {
		resolvePromise = resolve;
	});

	const settle = (value: AuthParams | null) => {
		if (settled) return;
		settled = true;
		resolvePromise(value);
	};

	stopListening = await listen("oauth://url", (data: { payload: string }) => {
		if (!(data.payload.includes("token") || data.payload.includes("api_key"))) {
			return;
		}

		settle(parseAuthParams(new URL(data.payload)));
	});

	const dispose = async () => {
		stopListening?.();
		stopListening = undefined;
		settle(null);
		await invoke("plugin:oauth|stop").catch(() => {});
	};

	signal.addEventListener("abort", () => void dispose(), { once: true });

	return { port, complete, dispose };
}

async function startDeepLinkSession(signal: AbortSignal) {
	let settled = false;
	let stopListening: (() => void) | undefined;
	let resolvePromise: (data: AuthParams | null) => void = () => {};

	const complete = new Promise<AuthParams | null>((resolve) => {
		resolvePromise = resolve;
	});

	const settle = (value: AuthParams | null) => {
		if (settled) return;
		settled = true;
		resolvePromise(value);
	};

	stopListening = await onOpenUrl(async (urls) => {
		for (const urlString of urls) {
			if (signal.aborted) return;
			const url = new URL(urlString);

			if (url.hostname === 'auth') {
				settle(parseAuthParams(url));
			}
		}
	});

	const dispose = async () => {
		stopListening?.();
		stopListening = undefined;
		settle(null);
	};

	signal.addEventListener("abort", () => void dispose(), { once: true });

	return { complete, dispose };
}

function parseAuthParams(url: URL) {
	return paramsValidator.parse(
		[...url.searchParams].reduce(
			(acc, [key, value]) => {
				acc[key] = value;
				return acc;
			},
			{} as Record<string, string>,
		),
	);
}

async function processAuthData(data: AuthParams) {
	identifyUser(data.user_id);
	trackEvent("user_signed_in", { platform: "desktop" });

	await authStore.set({
		secret:
			"api_key" in data
				? { api_key: data.api_key }
				: { token: data.token, expires: data.expires },
		user_id: data.user_id,
		plan: null,
	});

	await commands.updateAuthPlan();
}
