import {
	Route,
	Router,
	useCurrentMatches,
	useIsRouting,
} from "@solidjs/router";
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query";
import { message } from "@tauri-apps/plugin-dialog";
import {
	children,
	createEffect,
	type JSX,
	lazy,
	onMount,
	type ParentProps,
	Suspense,
} from "solid-js";
import { Toaster } from "solid-toast";

import "@cap/ui-solid/main.css";
import "unfonts.css";
import "./styles/theme.css";

import { createEventListener } from "@solid-primitives/event-listener";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { CapErrorBoundary } from "./components/CapErrorBoundary";
import WindowChromeLayout from "./routes/(window-chrome)";
import SettingsLayout from "./routes/(window-chrome)/settings";
import { generalSettingsStore } from "./store";
import { initAnonymousUser } from "./utils/analytics";
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
const SettingsHotkeysPage = lazy(
	() => import("./routes/(window-chrome)/settings/hotkeys"),
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
	const prefersDark = window.matchMedia("(prefers-color-scheme: dark)");
	const apply = () =>
		document.documentElement.classList.toggle("dark", prefersDark.matches);
	apply();
	createEventListener(prefersDark, "change", apply);

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
							<Route path="/hotkeys" component={SettingsHotkeysPage} />
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
					<Route path="/capture-area" component={CaptureAreaPage} />
					<Route path="/debug" component={DebugPage} />
					<Route path="/editor" component={EditorPage} />
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
						info={{ autoShow: false }}
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

let windowShown = false;

function AutoRevealWindowOnReady() {
	const matches = useCurrentMatches();
	const isRouting = useIsRouting();

	createEffect(() => {
		if (isRouting() || windowShown) return;
		const shouldDefer = matches().some(
			(match) => match.route.info?.autoShow === false,
		);
		if (shouldDefer) return;
		windowShown = true;
		getCurrentWindow().show();
	});

	return null;
}

export function RevealWindowWithSuspense(
	props: ParentProps<{ fallback?: JSX.Element }>,
) {
	const resolved = children(() => props.children);
	const isRouting = useIsRouting();

	createEffect(() => {
		if (windowShown || !resolved() || isRouting()) return;
		windowShown = true;
		getCurrentWindow().show();
	});

	return <Suspense fallback={props.fallback}>{resolved()}</Suspense>;
}
