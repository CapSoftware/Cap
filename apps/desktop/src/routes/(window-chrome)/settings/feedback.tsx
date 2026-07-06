import { Button } from "@cap/ui-solid";
import { action, useAction, useSubmission } from "@solidjs/router";
import { getVersion } from "@tauri-apps/api/app";
import { type OsType, type as ostype } from "@tauri-apps/plugin-os";
import * as shell from "@tauri-apps/plugin-shell";
import { createResource, createSignal, For, onCleanup, Show } from "solid-js";
import toast from "solid-toast";

import {
	commands,
	events,
	type SessionProfileProgress,
	type SessionProfileRecording,
	type SessionProfileStatus,
	type SessionProfileUploadResult,
	type SystemDiagnostics,
} from "~/utils/tauri";
import { apiClient, protectedHeaders } from "~/utils/web-api";
import { Section, SettingsPageContent } from "./Setting";

const MAX_PROFILE_NOTE_LENGTH = 4000;

function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
	const units = ["B", "KB", "MB", "GB", "TB"];
	const exponent = Math.min(
		Math.floor(Math.log(bytes) / Math.log(1024)),
		units.length - 1,
	);
	const value = bytes / 1024 ** exponent;
	return `${value.toFixed(exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

function formatRecordingDate(modifiedAt: number | null): string | null {
	if (modifiedAt == null || !Number.isFinite(modifiedAt)) return null;
	try {
		return new Date(modifiedAt).toLocaleString();
	} catch {
		return null;
	}
}

const getFeedbackOs = (): Extract<OsType, "macos" | "windows" | "linux"> => {
	const os = ostype();
	if (os === "macos" || os === "windows" || os === "linux") return os;
	throw new Error(`Unsupported OS for feedback submission: ${os}`);
};

const sendFeedbackAction = action(async (feedback: string) => {
	const response = await apiClient.desktop.submitFeedback({
		body: { feedback, os: getFeedbackOs(), version: await getVersion() },
		headers: await protectedHeaders(),
	});

	if (response.status !== 200) throw new Error("Failed to submit feedback");
	return response.body;
});

async function fetchDiagnostics(): Promise<SystemDiagnostics | null> {
	try {
		return await commands.getSystemDiagnostics();
	} catch (e) {
		console.error("Failed to fetch diagnostics:", e);
		return null;
	}
}

async function fetchSessionProfileStatus(): Promise<SessionProfileStatus | null> {
	try {
		return await commands.getSessionProfileStatus();
	} catch (e) {
		console.error("Failed to fetch session profile status:", e);
		return null;
	}
}

export default function FeedbackTab() {
	const [feedback, setFeedback] = createSignal("");
	const [uploadingLogs, setUploadingLogs] = createSignal(false);
	const [diagnostics] = createResource(fetchDiagnostics);

	const [profileStatus, { refetch: refetchProfileStatus }] = createResource(
		fetchSessionProfileStatus,
	);
	const [profileNote, setProfileNote] = createSignal("");
	const [sendingProfile, setSendingProfile] = createSignal(false);
	const [profileProgress, setProfileProgress] =
		createSignal<SessionProfileProgress | null>(null);
	const [profileResult, setProfileResult] =
		createSignal<SessionProfileUploadResult | null>(null);

	const availableRecordings = () => {
		const status = profileStatus();
		if (!status) return [] as SessionProfileRecording[];
		return [status.studio, status.instant].filter(
			(recording): recording is SessionProfileRecording => recording != null,
		);
	};

	const submission = useSubmission(sendFeedbackAction);
	const sendFeedback = useAction(sendFeedbackAction);

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

	let currentUnlisten: (() => void) | undefined;

	const handleSendProfile = async () => {
		setSendingProfile(true);
		setProfileResult(null);
		setProfileProgress(null);

		try {
			currentUnlisten = await events.sessionProfileProgress.listen((event) =>
				setProfileProgress(event.payload),
			);
			const note = profileNote().trim().slice(0, MAX_PROFILE_NOTE_LENGTH);
			const result = await commands.uploadSessionProfile(note || null);
			setProfileResult(result);
			setProfileNote("");
			toast.success("Session profile sent. Thank you!");
		} catch (error) {
			console.error("Failed to send session profile:", error);
			toast.error(
				typeof error === "string"
					? error
					: "Failed to send session profile. Please try again.",
			);
		} finally {
			currentUnlisten?.();
			currentUnlisten = undefined;
			setProfileProgress(null);
			setSendingProfile(false);
		}
	};

	onCleanup(() => {
		currentUnlisten?.();
		currentUnlisten = undefined;
		setProfileProgress(null);
	});

	return (
		<div class="cap-settings-page flex flex-col w-full h-full custom-scroll">
			<SettingsPageContent>
				<Section
					title="Feedback"
					description="Help us improve Cap by submitting feedback or reporting bugs. We'll get right on it."
				>
					<form
						class="space-y-4"
						onSubmit={(e) => {
							e.preventDefault();
							sendFeedback(feedback());
						}}
					>
						<fieldset disabled={submission.pending}>
							<div>
								<textarea
									value={feedback()}
									onInput={(e) => setFeedback(e.currentTarget.value)}
									placeholder="Tell us what you think about Cap..."
									required
									minLength={10}
									class="p-2 w-full h-32 text-[13px] rounded-md border transition-colors duration-200 resize-none bg-gray-2 placeholder:text-gray-10 border-gray-3 text-primary focus:outline-hidden focus:ring-1 focus:ring-gray-8 hover:border-gray-6"
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
				</Section>

				<Section
					title="Share a Session Profile"
					description="Bundle your latest Studio and Instant recordings together with full system diagnostics and logs, then send it to the Cap team so we can reproduce and fix issues fast."
				>
					<Show
						when={!profileStatus.loading}
						fallback={
							<p class="text-xs leading-relaxed text-gray-10">
								Looking for recent recordings...
							</p>
						}
					>
						<Show
							when={availableRecordings().length > 0}
							fallback={
								<div class="rounded-md border border-gray-3 bg-gray-2 p-3 text-[13px] text-gray-11">
									No Studio or Instant recordings found yet. Record something
									first, then come back here to share a session profile with the
									team.
								</div>
							}
						>
							<div class="space-y-4">
								<div class="space-y-2">
									<p class="text-gray-11 font-medium text-[13px]">
										Recordings to include
									</p>
									<div class="space-y-1.5">
										<For each={availableRecordings()}>
											{(recording) => (
												<div class="flex items-center gap-2 rounded-md border border-gray-3 bg-gray-2 px-3 py-2">
													<span
														class={`px-2 py-0.5 rounded text-[11px] font-medium ${
															recording.mode === "studio"
																? "bg-blue-500/20 text-blue-400"
																: "bg-purple-500/20 text-purple-400"
														}`}
													>
														{recording.mode === "studio" ? "Studio" : "Instant"}
													</span>
													<div class="flex flex-col min-w-0">
														<span class="text-[13px] text-gray-12 truncate">
															{recording.prettyName}
														</span>
														<span class="text-[11px] text-gray-10">
															{formatBytes(recording.sizeBytes)}
															<Show
																when={formatRecordingDate(recording.modifiedAt)}
															>
																{(date) => <> · {date()}</>}
															</Show>
														</span>
													</div>
												</div>
											)}
										</For>
									</div>
								</div>

								<textarea
									value={profileNote()}
									onInput={(e) => setProfileNote(e.currentTarget.value)}
									disabled={sendingProfile()}
									maxLength={MAX_PROFILE_NOTE_LENGTH}
									placeholder="Optional: describe the bug or what you were doing when it happened..."
									class="p-2 w-full h-24 text-[13px] rounded-md border transition-colors duration-200 resize-none bg-gray-2 placeholder:text-gray-10 border-gray-3 text-primary focus:outline-hidden focus:ring-1 focus:ring-gray-8 hover:border-gray-6 disabled:opacity-50"
								/>

								<Show when={sendingProfile() && profileProgress()}>
									{(progress) => (
										<div class="space-y-1.5">
											<div class="h-1.5 w-full overflow-hidden rounded-full bg-gray-3">
												<div
													class="h-full rounded-full bg-blue-9 transition-[width] duration-200"
													style={{
														width: `${Math.round(
															Math.min(Math.max(progress().progress, 0), 1) *
																100,
														)}%`,
													}}
												/>
											</div>
											<p class="text-[11px] text-gray-10">
												{progress().message}
											</p>
										</div>
									)}
								</Show>

								<div class="flex items-center gap-3">
									<Button
										onClick={handleSendProfile}
										size="md"
										variant="dark"
										disabled={sendingProfile()}
									>
										{sendingProfile() ? "Sending..." : "Send Session Profile"}
									</Button>
									<button
										type="button"
										class="text-[12px] text-gray-10 underline transition-colors hover:text-gray-12 disabled:opacity-50"
										disabled={sendingProfile()}
										onClick={() => refetchProfileStatus()}
									>
										Refresh
									</button>
								</div>

								<Show when={profileResult()?.uploaded}>
									<p class="text-[13px] text-primary">
										Session profile sent to the Cap team. Thank you for helping
										us improve Cap!
									</p>
								</Show>
							</div>
						</Show>
					</Show>
				</Section>

				<Section
					title="Join the Community"
					description="Have questions, want to share ideas, or just hang out? Join the Cap Discord community."
				>
					<Button
						onClick={() => shell.open("https://cap.link/discord")}
						size="md"
						variant="gray"
					>
						Join Discord
					</Button>
				</Section>

				<Section
					title="Debug Information"
					description="Upload your logs to help us diagnose issues with Cap. No personal information is included."
				>
					<Button
						onClick={handleUploadLogs}
						size="md"
						variant="gray"
						disabled={uploadingLogs()}
					>
						{uploadingLogs() ? "Uploading..." : "Upload Logs"}
					</Button>
				</Section>

				<Section title="System Information">
					<Show
						when={!diagnostics.loading && diagnostics()}
						fallback={
							<p class="text-xs leading-relaxed text-gray-10">
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
										: "linuxVersion" in d
											? (d.linuxVersion as { displayName: string } | null)
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
												<p class="text-gray-11 font-medium">Operating System</p>
												<p class="text-gray-10 bg-gray-2 px-2 py-1.5 rounded-sm font-mono text-xs">
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
											<p class="text-gray-11 font-medium">Available Encoders</p>
											<div class="flex gap-1.5 flex-wrap">
												<For each={d.availableEncoders as string[]}>
													{(encoder) => (
														<span class="px-2 py-1 bg-gray-2 rounded-sm text-xs text-gray-10 font-mono">
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
				</Section>
			</SettingsPageContent>
		</div>
	);
}
