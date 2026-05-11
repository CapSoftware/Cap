import { Button } from "@cap/ui-solid";
import { action, useAction, useSubmission } from "@solidjs/router";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { type OsType, type as ostype } from "@tauri-apps/plugin-os";
import * as shell from "@tauri-apps/plugin-shell";
import { createResource, createSignal, For, Show } from "solid-js";
import toast from "solid-toast";

import {
	authStore,
	generalSettingsStore,
	hotkeysStore,
	presetsStore,
	recordingSettingsStore,
} from "~/store";
import { commands, type SystemDiagnostics } from "~/utils/tauri";
import { apiClient, protectedHeaders } from "~/utils/web-api";

type CollectedValue<T> =
	| {
			ok: true;
			value: T;
	  }
	| {
			ok: false;
			error: string;
	  };

type GeneralSettingsDebugState = Awaited<
	ReturnType<typeof generalSettingsStore.get>
>;

const getFeedbackOs = (): Extract<OsType, "macos" | "windows"> => {
	const os = ostype();
	if (os === "macos" || os === "windows") return os;
	throw new Error(`Unsupported OS for feedback submission: ${os}`);
};

const errorToString = (error: unknown) => {
	if (error instanceof Error) return error.message;
	if (typeof error === "string") return error;
	try {
		return JSON.stringify(error);
	} catch {
		return "Unknown error";
	}
};

const collectValue = async <T,>(
	fn: () => Promise<T>,
): Promise<CollectedValue<T>> => {
	try {
		return { ok: true, value: await fn() };
	} catch (error) {
		return { ok: false, error: errorToString(error) };
	}
};

const localStorageDebugKeys = [
	"export_settings",
	"selectedTranscriptionModel",
	"selectedTranscriptionLanguage",
	"modelDownloadState",
	"cap-theme",
	"cap.settings.scrollToSection",
];

const createReportId = () => {
	if (typeof crypto !== "undefined" && crypto.randomUUID) {
		return crypto.randomUUID();
	}

	return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
};

function collectRuntimeContext() {
	if (typeof window === "undefined") return null;

	const colorScheme = window.matchMedia?.("(prefers-color-scheme: dark)")
		.matches
		? "dark"
		: "light";

	return {
		userAgent: navigator.userAgent,
		locale: navigator.language,
		languages: navigator.languages,
		timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
		platform: navigator.platform,
		online: navigator.onLine,
		devicePixelRatio: window.devicePixelRatio,
		colorScheme,
		route: window.location.href,
		viewport: {
			width: window.innerWidth,
			height: window.innerHeight,
		},
		screen: {
			width: window.screen.width,
			height: window.screen.height,
			availWidth: window.screen.availWidth,
			availHeight: window.screen.availHeight,
		},
	};
}

function collectLocalStorageDebugState() {
	const values: Record<string, string | null> = {};
	if (typeof window === "undefined") return values;

	for (const key of localStorageDebugKeys) {
		try {
			values[key] = window.localStorage.getItem(key);
		} catch (error) {
			values[key] = `Failed to read: ${errorToString(error)}`;
		}
	}

	return values;
}

async function collectAuthDebugState() {
	const auth = await authStore.get();
	if (!auth) return null;

	return {
		userId: auth.user_id,
		plan: auth.plan,
		secretType: "api_key" in auth.secret ? "apiKey" : "sessionToken",
		organizations: auth.organizations?.map((organization) => ({
			id: organization.id,
			name: organization.name,
			ownerId: organization.ownerId,
		})),
	};
}

function sanitizeGeneralSettings(settings: GeneralSettingsDebugState) {
	if (!settings?.commercialLicense) return settings;

	return {
		...settings,
		commercialLicense: {
			...settings.commercialLicense,
			licenseKey: settings.commercialLicense.licenseKey ? "present" : "",
		},
	};
}

async function collectDesktopDebugContext({
	reportId,
	issue,
	os,
	version,
}: {
	reportId: string;
	issue: string;
	os: Extract<OsType, "macos" | "windows">;
	version: string;
}) {
	const [
		diagnostics,
		devicesSnapshot,
		permissions,
		currentRecording,
		captureDisplays,
		captureWindows,
		cameras,
		microphones,
		recordings,
		screenshots,
		generalSettings,
		recordingSettings,
		hotkeys,
		presets,
		auth,
	] = await Promise.all([
		collectValue(() => commands.getSystemDiagnostics()),
		collectValue(() => commands.getDevicesSnapshot()),
		collectValue(() => commands.doPermissionsCheck(false)),
		collectValue(() =>
			commands.getCurrentRecording().then((recording) => recording[0]),
		),
		collectValue(() => commands.listCaptureDisplays()),
		collectValue(() => commands.listCaptureWindows()),
		collectValue(() => commands.listCameras()),
		collectValue(() => commands.listAudioDevices()),
		collectValue(() =>
			commands.listRecordings().then((entries) => entries.slice(0, 20)),
		),
		collectValue(() =>
			commands.listScreenshots().then((entries) => entries.slice(0, 20)),
		),
		collectValue(async () =>
			sanitizeGeneralSettings(await generalSettingsStore.get()),
		),
		collectValue(() => recordingSettingsStore.get()),
		collectValue(() => hotkeysStore.get()),
		collectValue(() => presetsStore.get()),
		collectValue(collectAuthDebugState),
	]);

	return {
		reportId,
		submittedAt: new Date().toISOString(),
		issue,
		app: {
			version,
			os,
			route: typeof window !== "undefined" ? window.location.href : null,
		},
		runtime: collectRuntimeContext(),
		native: {
			diagnostics,
			devicesSnapshot,
			permissions,
			currentRecording,
			captureDisplays,
			captureWindows,
			cameras,
			microphones,
			recordings,
			screenshots,
		},
		stores: {
			generalSettings,
			recordingSettings,
			hotkeys,
			presets,
			auth,
		},
		localStorage: collectLocalStorageDebugState(),
	};
}

const sendFeedbackAction = action(async (feedback: string) => {
	const trimmedFeedback = feedback.trim();
	const response = await apiClient.desktop.submitFeedback({
		body: {
			feedback: trimmedFeedback,
			os: getFeedbackOs(),
			version: await getVersion(),
			kind: "feedback",
		},
		headers: await protectedHeaders(),
	});

	if (response.status !== 200) throw new Error("Failed to submit feedback");
	return response.body;
});

const sendDebugReportAction = action(async (feedback: string) => {
	const trimmedFeedback = feedback.trim();
	if (trimmedFeedback.length < 10) {
		throw new Error("Please describe the issue before sending a debug report");
	}

	const headers = await protectedHeaders();
	const os = getFeedbackOs();
	const version = await getVersion();
	const reportId = createReportId();
	const context = await collectDesktopDebugContext({
		reportId,
		issue: trimmedFeedback,
		os,
		version,
	});
	const clientContext = JSON.stringify(context, null, "\t");

	await invoke<null>("upload_debug_report", {
		reportId,
		userFeedback: trimmedFeedback,
		clientContext,
	});

	const response = await apiClient.desktop.submitFeedback({
		body: {
			feedback: trimmedFeedback,
			os,
			version,
			reportId,
			kind: "debugReport",
			debugReport: clientContext,
		},
		headers,
	});

	if (response.status !== 200) throw new Error("Failed to submit debug report");
	return { ...response.body, reportId };
});

async function fetchDiagnostics(): Promise<SystemDiagnostics | null> {
	try {
		return await commands.getSystemDiagnostics();
	} catch (e) {
		console.error("Failed to fetch diagnostics:", e);
		return null;
	}
}

export default function FeedbackTab() {
	const [feedback, setFeedback] = createSignal("");
	const [uploadingLogs, setUploadingLogs] = createSignal(false);
	const [diagnostics] = createResource(fetchDiagnostics);

	const submission = useSubmission(sendFeedbackAction);
	const sendFeedback = useAction(sendFeedbackAction);
	const debugSubmission = useSubmission(sendDebugReportAction);
	const sendDebugReport = useAction(sendDebugReportAction);

	const handleUploadLogs = async () => {
		setUploadingLogs(true);
		try {
			await commands.uploadLogs();
			toast.success("Logs uploaded successfully");
		} catch (error) {
			toast.error("Failed to upload logs");
			console.error("Failed to upload logs:", error);
		} finally {
			setUploadingLogs(false);
		}
	};

	return (
		<div class="flex flex-col w-full h-full">
			<div class="flex-1 custom-scroll">
				<div class="p-4 space-y-4">
					<div class="flex flex-col pb-4 border-b border-gray-2">
						<h2 class="text-lg font-medium text-gray-12">Send Feedback</h2>
						<p class="text-sm text-gray-10">
							Help us improve Cap by submitting feedback or reporting bugs.
							We'll get right on it.
						</p>
					</div>
					<form
						class="space-y-4"
						onSubmit={(e) => {
							e.preventDefault();
							sendFeedback(feedback());
						}}
					>
						<fieldset disabled={submission.pending || debugSubmission.pending}>
							<div>
								<textarea
									value={feedback()}
									onInput={(e) => setFeedback(e.currentTarget.value)}
									placeholder="Tell us what happened, what you expected, and anything you already tried..."
									required
									minLength={10}
									class="p-2 w-full h-32 text-[13px] rounded-md border transition-colors duration-200 resize-none bg-gray-2 placeholder:text-gray-10 border-gray-3 text-primary focus:outline-none focus:ring-1 focus:ring-gray-8 hover:border-gray-6"
								/>
							</div>

							{submission.error && (
								<p class="mt-2 text-sm text-red-400">
									{submission.error.toString()}
								</p>
							)}

							{submission.result?.success && (
								<p class="text-sm text-primary">Thank you for your feedback!</p>
							)}

							<Button
								type="submit"
								size="md"
								variant="dark"
								disabled={feedback().trim().length < 4}
								class="mt-2"
							>
								{submission.pending ? "Submitting..." : "Submit Feedback"}
							</Button>
						</fieldset>
					</form>

					<div class="pt-6 border-t border-gray-2">
						<h3 class="text-sm font-medium text-gray-12 mb-2">
							Join the Community
						</h3>
						<p class="text-sm text-gray-10 mb-3">
							Have questions, want to share ideas, or just hang out? Join the
							Cap Discord community.
						</p>
						<Button
							onClick={() => shell.open("https://cap.link/discord")}
							size="md"
							variant="gray"
						>
							Join Discord
						</Button>
					</div>

					<div class="pt-6 border-t border-gray-2">
						<h3 class="text-sm font-medium text-gray-12 mb-2">Debug Report</h3>
						<p class="text-sm text-gray-10 mb-3">
							Send the issue description above with logs, device and display
							diagnostics, permissions, settings, recent recording metadata,
							current capture state, and editor/export state. This can include
							device names, window titles, file paths, and logs, but no
							recording media is attached.
						</p>
						<div class="flex gap-2 flex-wrap">
							<Button
								onClick={() => sendDebugReport(feedback())}
								size="md"
								variant="dark"
								disabled={
									feedback().trim().length < 10 || debugSubmission.pending
								}
							>
								{debugSubmission.pending ? "Sending..." : "Send Debug Report"}
							</Button>
							<Button
								onClick={handleUploadLogs}
								size="md"
								variant="gray"
								disabled={uploadingLogs() || debugSubmission.pending}
							>
								{uploadingLogs() ? "Uploading..." : "Upload Logs Only"}
							</Button>
						</div>
						{debugSubmission.error && (
							<p class="mt-2 text-sm text-red-400">
								{debugSubmission.error.toString()}
							</p>
						)}
						{debugSubmission.result?.success && (
							<p class="mt-2 text-sm text-primary">
								Debug report sent. Report ID: {debugSubmission.result.reportId}
							</p>
						)}
					</div>

					<div class="pt-6 border-t border-gray-2">
						<h3 class="text-sm font-medium text-gray-12 mb-3">
							System Information
						</h3>
						<Show
							when={!diagnostics.loading && diagnostics()}
							fallback={
								<p class="text-sm text-gray-10">
									Loading system information...
								</p>
							}
						>
							{(diag) => {
								const d = diag() as Record<string, unknown>;
								const osVersion =
									"macosVersion" in d
										? (d.macosVersion as { displayName: string } | null)
										: "windowsVersion" in d
											? (d.windowsVersion as { displayName: string } | null)
											: null;
								const captureSupported =
									"screenCaptureSupported" in d
										? (d.screenCaptureSupported as boolean)
										: "graphicsCaptureSupported" in d
											? (d.graphicsCaptureSupported as boolean)
											: false;
								return (
									<div class="space-y-3 text-sm">
										<Show when={osVersion}>
											{(ver) => (
												<div class="space-y-1">
													<p class="text-gray-11 font-medium">
														Operating System
													</p>
													<p class="text-gray-10 bg-gray-2 px-2 py-1.5 rounded font-mono text-xs">
														{ver().displayName}
													</p>
												</div>
											)}
										</Show>

										<div class="space-y-1">
											<p class="text-gray-11 font-medium">Capture Support</p>
											<div class="flex gap-2 flex-wrap">
												<span
													class={`px-2 py-1 rounded text-xs ${
														captureSupported
															? "bg-green-500/20 text-green-400"
															: "bg-red-500/20 text-red-400"
													}`}
												>
													Screen Capture:{" "}
													{captureSupported ? "Supported" : "Not Supported"}
												</span>
											</div>
										</div>

										<Show when={(d.availableEncoders as string[])?.length > 0}>
											<div class="space-y-1">
												<p class="text-gray-11 font-medium">
													Available Encoders
												</p>
												<div class="flex gap-1.5 flex-wrap">
													<For each={d.availableEncoders as string[]}>
														{(encoder) => (
															<span class="px-2 py-1 bg-gray-2 rounded text-xs text-gray-10 font-mono">
																{encoder}
															</span>
														)}
													</For>
												</div>
											</div>
										</Show>
									</div>
								);
							}}
						</Show>
					</div>
				</div>
			</div>
		</div>
	);
}
