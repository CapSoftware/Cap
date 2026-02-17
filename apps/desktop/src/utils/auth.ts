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

export function createSignInMutation() {
	return createMutation(() => ({
		mutationFn: async (abort: AbortController) => {
			const platform = import.meta.env.DEV ? "web" : "desktop";

			let session;

			if (platform === "web")
				session = await createLocalServerSession(abort.signal);
			else session = await createDeepLinkSession(abort.signal);

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
	await invoke("plugin:oauth|stop").catch(() => {});

	const port: string = await invoke("plugin:oauth|start", {
		config: {
			response: callbackTemplate,
			headers: {
				"Content-Type": "text/html; charset=utf-8",
				"Cache-Control": "no-store, no-cache, must-revalidate",
				Pragma: "no-cache",
			},
			// Add a cleanup function to stop the server after handling the request
			cleanup: true,
		},
	});

	signal.onabort = () => {
		invoke("plugin:oauth|stop").catch(() => {});
	};

	let res: (url: URL | null) => void;

	const stopListening = await listen(
		"oauth://url",
		(data: { payload: string }) => {
			console.log(data);
			if (
				!(data.payload.includes("token") || data.payload.includes("api_key"))
			) {
				return;
			}

			const urlObject = new URL(data.payload);
			res(urlObject);
		},
	);

	signal.onabort = (_e: Event) => {
		res(null);
	};

	return {
		url: await createSessionRequestUrl(port, "web"),
		complete: async () => {
			const url = await new Promise<URL | null>((_res) => {
				res = _res;
			});

			stopListening();
			if (!url) return null;
			if (signal.aborted) throw new Error("Sign in aborted");

			const a = [...url.searchParams].reduce((acc, [k, v]) => {
				acc[k] = v;
				return acc;
			}, {} as any);

			return paramsValidator.parse(a);
		},
	};
}

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

async function createDeepLinkSession(signal: AbortSignal) {
	let res: (data: z.infer<typeof paramsValidator>) => void;
	const p = new Promise<z.infer<typeof paramsValidator>>((r) => {
		res = r;
	});
	const stopListening = await onOpenUrl(async (urls) => {
		for (const urlString of urls) {
			if (signal.aborted) return;

			const url = new URL(urlString);

			res(
				paramsValidator.parse(
					[...url.searchParams].reduce((acc, [k, v]) => {
						acc[k] = v;
						return acc;
					}, {} as any),
				),
			);
		}
	});

	signal.onabort = () => {
		stopListening();
	};

	return {
		url: await createSessionRequestUrl(null, "desktop"),
		complete: () => p,
	};
}

async function processAuthData(data: z.infer<typeof paramsValidator>) {
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
