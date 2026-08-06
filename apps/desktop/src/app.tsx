import { Route, Router } from "@solidjs/router";
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query";
import { message } from "@tauri-apps/plugin-dialog";
import { createEffect, lazy, onMount, Suspense } from "solid-js";
import { Toaster } from "solid-toast";

import "@cap/ui-solid/main.css";
import "unfonts.css";
import "./styles/theme.css";

import { CapErrorBoundary } from "./components/CapErrorBoundary";
import WindowChromeLayout from "./routes/(window-chrome)";
import SettingsLayout from "./routes/(window-chrome)/settings";
import { authStore, generalSettingsStore } from "./store";
import { identifyUser, initAnonymousUser } from "./utils/analytics";
import { appearanceIsDark } from "./utils/appearance";
import { AutoRevealWindowOnReady } from "./utils/RevealWindow";
import titlebar from "./utils/titlebar-state";
import { usePrefersDarkMode } from "./utils/use-media-query";

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
const TeleprompterPage = lazy(() => import("./routes/teleprompter"));

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
	const generalSettings = generalSettingsStore.createQuery();
	const prefersDark = usePrefersDarkMode();

	createEffect(() =>
		document.documentElement.classList.toggle(
			"dark",
			appearanceIsDark(generalSettings.data?.appearance, prefersDark()),
		),
	);

	onMount(() => {
		initAnonymousUser();
		// OpenPanel keeps profileId in memory only (PostHog persisted it), so
		// sign-in-time identify alone loses attribution after an app restart.
		void authStore.get().then((auth) => {
			if (auth?.user_id) identifyUser(auth.user_id);
		});
		prewarmFontCaches();
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
					root={(props) => (
						<Suspense fallback={null}>
							{props.children}
							<AutoRevealWindowOnReady />
						</Suspense>
					)}
				>
					<Route path="/" component={WindowChromeLayout}>
						<Route path="/" component={NewMainPage} />
						<Route
							path="/settings"
							component={SettingsLayout}
							info={{ autoShow: false }}
						>
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
					<Route
						path="/camera"
						component={CameraPage}
						info={{ autoShow: false }}
					/>
					<Route path="/debug" component={DebugPage} />
					<Route path="/editor" component={EditorPage} />
					<Route
						path="/in-progress-recording"
						component={InProgressRecordingPage}
					/>
					<Route path="/mode-select" component={ModeSelectPage} />
					<Route path="/notifications" component={NotificationsPage} />
					<Route path="/recordings-overlay" component={RecordingsOverlayPage} />
					<Route
						path="/screenshot-editor"
						info={{ autoShow: false }}
						component={ScreenshotEditorPage}
					/>
					<Route
						path="/target-select-overlay"
						component={TargetSelectOverlayPage}
						info={{ autoShow: false }}
					/>
					<Route
						path="/window-capture-occluder"
						component={WindowCaptureOccluderPage}
					/>
					<Route
						path="/teleprompter"
						info={{ autoShow: false }}
						component={TeleprompterPage}
					/>
				</Router>
			</CapErrorBoundary>
		</>
	);
}

// WebKit resolves the emoji fallback chain lazily on first glyph paint, which
// can jank the first list/text render containing emoji (e.g. recording
// titles). Drawing once to an offscreen canvas at idle warms the per-process
// font caches instead.
function prewarmFontCaches() {
	const warm = () => {
		try {
			const canvas = document.createElement("canvas");
			canvas.width = 32;
			canvas.height = 32;
			const ctx = canvas.getContext("2d");
			if (!ctx) return;
			ctx.font = "16px 'Geist Sans'";
			ctx.fillText("Ag", 0, 24);
			ctx.font = "16px system-ui";
			ctx.fillText("😀", 0, 24);
		} catch { }
	};

	if ("requestIdleCallback" in window) requestIdleCallback(warm);
	else setTimeout(warm, 250);
}
