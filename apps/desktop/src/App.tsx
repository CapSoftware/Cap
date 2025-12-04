import { Router, useCurrentMatches } from "@solidjs/router";
import { FileRoutes } from "@solidjs/start/router";
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query";
import {
	getCurrentWebviewWindow,
	type WebviewWindow,
} from "@tauri-apps/api/webviewWindow";
import { message } from "@tauri-apps/plugin-dialog";
import { createEffect, onCleanup, onMount, Suspense } from "solid-js";
import { Toaster } from "solid-toast";

import "@cap/ui-solid/main.css";
import "unfonts.css";
import "./styles/theme.css";

import { CapErrorBoundary } from "./components/CapErrorBoundary";
import { generalSettingsStore } from "./store";
import { initAnonymousUser } from "./utils/analytics";
import { type AppTheme, commands } from "./utils/tauri";
import titlebar from "./utils/titlebar-state";

const queryClient = new QueryClient({
	defaultOptions: {
		queries: {
			experimental_prefetchInRender: true,
			refetchOnWindowFocus: false,
			refetchOnReconnect: false,
		},
		mutations: {
			onError: (e) => {
				message(`Error\n${e}`);
			},
		},
	},
});

export default function App() {
	return (
		<QueryClientProvider client={queryClient}>
			<Suspense>
				<Inner />
			</Suspense>
		</QueryClientProvider>
	);
}

function Inner() {
	const currentWindow = getCurrentWebviewWindow();
	createThemeListener(currentWindow);

	onMount(() => {
		initAnonymousUser();
	});

	return (
		<>
			<Toaster
				position="bottom-right"
				containerStyle={{
					"margin-top": titlebar.height,
				}}
				toastOptions={{
					duration: 3500,
					style: {
						padding: "8px 16px",
						"border-radius": "15px",
						"border-color": "var(--gray-200)",
						"border-width": "1px",
						"font-size": "1rem",
						"background-color": "var(--gray-50)",
						color: "var(--text-secondary)",
					},
				}}
			/>
			<CapErrorBoundary>
				<Router
					root={(props) => {
						const matches = useCurrentMatches();

						onMount(() => {
							for (const match of matches()) {
								if (match.route.info?.AUTO_SHOW_WINDOW === false) return;
							}

							if (location.pathname !== "/camera") currentWindow.show();
						});

						return (
							<Suspense
								fallback={
									(() => {
										console.log("Root suspense fallback showing");
									}) as any
								}
							>
								{props.children}
							</Suspense>
						);
					}}
				>
					<FileRoutes />
				</Router>
			</CapErrorBoundary>
		</>
	);
}

function createThemeListener(currentWindow: WebviewWindow) {
	const generalSettings = generalSettingsStore.createQuery();

	createEffect(() => {
		update(generalSettings.data?.theme ?? null);
	});

	onMount(async () => {
		const unlisten = await currentWindow.onThemeChanged((_) =>
			update(generalSettings.data?.theme),
		);
		onCleanup(() => unlisten?.());
	});

	function update(appTheme: AppTheme | null | undefined) {
		if (location.pathname === "/camera") return;

		if (appTheme === undefined || appTheme === null) return;

		commands.setTheme(appTheme).then(() => {
			document.documentElement.classList.toggle(
				"dark",
				appTheme === "dark" ||
					window.matchMedia("(prefers-color-scheme: dark)").matches,
			);
		});
	}
}
