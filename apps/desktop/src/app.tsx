import { Route, Router, useCurrentMatches } from "@solidjs/router";
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query";
import {
	getCurrentWebviewWindow,
	type WebviewWindow,
} from "@tauri-apps/api/webviewWindow";
import { message } from "@tauri-apps/plugin-dialog";
import {
	createEffect,
	createSignal,
	lazy,
	onCleanup,
	onMount,
	Suspense,
} from "solid-js";
import { Toaster } from "solid-toast";

import "@cap/ui-solid/main.css";
import "unfonts.css";
import "./styles/theme.css";

import { CapErrorBoundary } from "./components/CapErrorBoundary";
import WindowChromeLayout from "./routes/(window-chrome)";
import SettingsLayout from "./routes/(window-chrome)/settings";
import { generalSettingsStore } from "./store";
import { initAnonymousUser } from "./utils/analytics";
import { type AppTheme, commands } from "./utils/tauri";
import titlebar from "./utils/titlebar-state";

const NewMainPage = lazy(() => import("./routes/(window-chrome)/new-main"));
const SettingsGeneralPage = lazy(
	() => import("./routes/(window-chrome)/settings/general"),
);
const SettingsRecordingsPage = lazy(
	() => import("./routes/(window-chrome)/settings/recordings"),
);
const SettingsTranscriptionPage = lazy(
	() => import("./routes/(window-chrome)/settings/transcription"),
);
const SettingsScreenshotsPage = lazy(
	() => import("./routes/(window-chrome)/settings/screenshots"),
);
const SettingsAutomationsPage = lazy(
	() => import("./routes/(window-chrome)/settings/automations"),
);
const SettingsHotkeysPage = lazy(
	() => import("./routes/(window-chrome)/settings/hotkeys"),
);
const SettingsCliPage = lazy(
	() => import("./routes/(window-chrome)/settings/cli"),
);
const SettingsChangelogPage = lazy(
	() => import("./routes/(window-chrome)/settings/changelog"),
);
const SettingsFeedbackPage = lazy(
	() => import("./routes/(window-chrome)/settings/feedback"),
);
const SettingsExperimentalPage = lazy(
	() => import("./routes/(window-chrome)/settings/experimental"),
);
const SettingsLicensePage = lazy(
	() => import("./routes/(window-chrome)/settings/license"),
);
const SettingsIntegrationsPage = lazy(
	() => import("./routes/(window-chrome)/settings/integrations"),
);
const SettingsS3ConfigPage = lazy(
	() => import("./routes/(window-chrome)/settings/integrations/s3-config"),
);
const SettingsGoogleDriveConfigPage = lazy(
	() =>
		import(
			"./routes/(window-chrome)/settings/integrations/google-drive-config"
		),
);
const OnboardingPage = lazy(
	() => import("./routes/(window-chrome)/onboarding"),
);
const UpgradePage = lazy(() => import("./routes/(window-chrome)/upgrade"));
const UpdatePage = lazy(() => import("./routes/(window-chrome)/update"));
const CameraPage = lazy(() => import("./routes/camera"));
const CaptureAreaPage = lazy(() => import("./routes/capture-area"));
const DebugPage = lazy(() => import("./routes/debug"));
const EditorPage = lazy(() => import("./routes/editor"));
const InProgressRecordingPage = lazy(
	() => import("./routes/in-progress-recording"),
);
const ModeSelectPage = lazy(() => import("./routes/mode-select"));
const NotificationsPage = lazy(() => import("./routes/notifications"));
const RecordingsOverlayPage = lazy(() => import("./routes/recordings-overlay"));
const ScreenshotEditorPage = lazy(() => import("./routes/screenshot-editor"));
const TargetSelectOverlayPage = lazy(
	() => import("./routes/target-select-overlay"),
);
const WindowCaptureOccluderPage = lazy(
	() => import("./routes/window-capture-occluder"),
);

const queryClient = new QueryClient({
	defaultOptions: {
		queries: {
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
							let autoShow = true;
							for (const match of matches()) {
								if (match.route.info?.AUTO_SHOW_WINDOW === false)
									autoShow = false;
							}

							if (
								location.pathname === "/" ||
								location.pathname === "/camera"
							) {
								return;
							}

							if (autoShow) {
								void currentWindow.show();
								void currentWindow.setFocus();
							} else {
								// The route reveals itself after its first themed paint to
								// avoid a load flash. Safety net so the window is never left
								// hidden if that self-reveal never runs (e.g. chunk load error).
								setTimeout(() => void currentWindow.show(), 2000);
							}
						});

						return <Suspense fallback={null}>{props.children}</Suspense>;
					}}
				>
					<Route path="/" component={WindowChromeLayout}>
						<Route path="/" component={NewMainPage} />
						<Route path="/settings" component={SettingsLayout}>
							<Route path="/" component={SettingsGeneralPage} />
							<Route path="/general" component={SettingsGeneralPage} />
							<Route path="/recordings" component={SettingsRecordingsPage} />
							<Route
								path="/transcription"
								component={SettingsTranscriptionPage}
							/>
							<Route path="/screenshots" component={SettingsScreenshotsPage} />
							<Route path="/automations" component={SettingsAutomationsPage} />
							<Route path="/hotkeys" component={SettingsHotkeysPage} />
							<Route path="/cli" component={SettingsCliPage} />
							<Route path="/changelog" component={SettingsChangelogPage} />
							<Route path="/feedback" component={SettingsFeedbackPage} />
							<Route
								path="/experimental"
								component={SettingsExperimentalPage}
							/>
							<Route path="/license" component={SettingsLicensePage} />
							<Route
								path="/integrations"
								component={SettingsIntegrationsPage}
							/>
							<Route
								path="/integrations/s3-config"
								component={SettingsS3ConfigPage}
							/>
							<Route
								path="/integrations/google-drive-config"
								component={SettingsGoogleDriveConfigPage}
							/>
						</Route>
						<Route path="/onboarding" component={OnboardingPage} />
						<Route path="/upgrade" component={UpgradePage} />
						<Route path="/update" component={UpdatePage} />
					</Route>
					<Route path="/camera" component={CameraPage} />
					<Route path="/capture-area" component={CaptureAreaPage} />
					<Route path="/debug" component={DebugPage} />
					<Route
						path="/editor"
						info={{ AUTO_SHOW_WINDOW: false }}
						component={EditorPage}
					/>
					<Route
						path="/in-progress-recording"
						component={InProgressRecordingPage}
					/>
					<Route path="/mode-select" component={ModeSelectPage} />
					<Route path="/notifications" component={NotificationsPage} />
					<Route path="/recordings-overlay" component={RecordingsOverlayPage} />
					<Route path="/screenshot-editor" component={ScreenshotEditorPage} />
					<Route
						path="/target-select-overlay"
						component={TargetSelectOverlayPage}
					/>
					<Route
						path="/window-capture-occluder"
						component={WindowCaptureOccluderPage}
					/>
				</Router>
			</CapErrorBoundary>
		</>
	);
}

function createThemeListener(currentWindow: WebviewWindow) {
	const [appTheme, setAppTheme] = createSignal<AppTheme | null | undefined>();
	let disposed = false;
	let stopSettingsListening: (() => void) | undefined;
	let stopThemeListening: (() => void) | undefined;

	createEffect(() => {
		update(appTheme());
	});

	onMount(() => {
		void generalSettingsStore
			.get()
			.then((settings) => {
				if (!disposed) setAppTheme(settings?.theme ?? null);
			})
			.catch((error) =>
				console.error("Failed to load general settings:", error),
			);

		void generalSettingsStore
			.listen((settings) => {
				setAppTheme(settings?.theme ?? null);
			})
			.then((unlisten) => {
				if (disposed) {
					unlisten();
					return;
				}
				stopSettingsListening = unlisten;
			})
			.catch((error) =>
				console.error("Failed to listen to general settings:", error),
			);

		void currentWindow
			.onThemeChanged(() => update(appTheme()))
			.then((unlisten) => {
				if (disposed) {
					unlisten();
					return;
				}
				stopThemeListening = unlisten;
			})
			.catch((error) =>
				console.error("Failed to listen to window theme changes:", error),
			);
	});

	onCleanup(() => {
		disposed = true;
		stopSettingsListening?.();
		stopThemeListening?.();
	});

	function update(appTheme: AppTheme | null | undefined) {
		if (location.pathname === "/camera") return;

		if (appTheme === undefined || appTheme === null) return;

		const isDark =
			appTheme === "dark" ||
			(appTheme === "system" &&
				window.matchMedia("(prefers-color-scheme: dark)").matches);

		try {
			if (appTheme === "system") {
				localStorage.removeItem("cap-theme");
			} else {
				localStorage.setItem("cap-theme", appTheme);
			}
		} catch {}

		commands.setTheme(appTheme).then(() => {
			document.documentElement.classList.toggle("dark", isDark);
		});
	}
}
