import { Button } from "@cap/ui-solid";
import { action, useAction, useSubmission } from "@solidjs/router";
import { getVersion } from "@tauri-apps/api/app";
import { CheckMenuItem, Menu } from "@tauri-apps/api/menu";
import { confirm } from "@tauri-apps/plugin-dialog";
import { type OsType, type as ostype } from "@tauri-apps/plugin-os";
import * as shell from "@tauri-apps/plugin-shell";
import { createResource, createSignal, For, Show } from "solid-js";
import toast from "solid-toast";
import {
	commands,
	type DiagnosticProgress,
	type DiagnosticRunResult,
	events,
	type SystemDiagnostics,
} from "~/utils/tauri";
import { apiClient, protectedHeaders } from "~/utils/web-api";
import IconLucideAlertTriangle from "~icons/lucide/alert-triangle";
import {
	Section,
	SectionRows,
	SettingItem,
	SettingsPageContent,
	ToggleSettingItem,
} from "./Setting";

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

const DIAGNOSTIC_MODES = [
	{ text: "Studio and Instant", value: "both" },
	{ text: "Studio only", value: "studio" },
	{ text: "Instant only", value: "instant" },
];

const DIAGNOSTIC_DURATIONS = [
	{ text: "20 seconds", value: 20 },
	{ text: "40 seconds", value: 40 },
	{ text: "60 seconds", value: 60 },
];

/** Stage names come from the CLI verbatim; unknown ones are shown as-is. */
const SYNC_STAGE_LABELS: Record<string, string> = {
	collecting: "Preparing the test",
	recording: "Recording the test pattern",
	"pattern-run": "Playing the flash and beep pattern",
	remuxing: "Finalizing the recording",
	analyzing: "Analyzing flash and beep timing",
	exporting: "Exporting the test recording",
	done: "Wrapping up the sync test",
};

const VERDICT_STYLES: Record<string, string> = {
	pass: "bg-green-500/20 text-green-400",
	warn: "bg-amber-500/20 text-amber-400",
	fail: "bg-red-500/20 text-red-400",
	inconclusive: "bg-gray-4 text-gray-11",
};

function progressLabel(payload: DiagnosticProgress) {
	if (payload.phase === "collecting") return "Collecting system info...";
	if (payload.phase === "done") return "Finishing up...";
	const stage = payload.stage
		? (SYNC_STAGE_LABELS[payload.stage] ?? payload.stage)
		: "Running sync test";
	return payload.mode ? `${stage} (${payload.mode})...` : `${stage}...`;
}

function SelectDiagnosticItem<T extends string | number>(props: {
	label: string;
	description: string;
	value: T;
	options: { text: string; value: T }[];
	onChange: (value: T) => void;
}) {
	return (
		<SettingItem label={props.label} description={props.description}>
			<button
				type="button"
				class="flex flex-row gap-1.5 text-xs items-center px-2.5 py-1.5 rounded-lg border transition-colors bg-gray-3 hover:bg-gray-4 text-gray-12 border-gray-4 disabled:opacity-60"
				onClick={async () => {
					const currentValue = props.value;
					const items = props.options.map((option) =>
						CheckMenuItem.new({
							text: option.text,
							checked: currentValue === option.value,
							action: () => props.onChange(option.value),
						}),
					);
					const menu = await Menu.new({ items: await Promise.all(items) });
					await menu.popup();
					await menu.close();
				}}
			>
				{props.options.find((option) => option.value === props.value)?.text ??
					String(props.value)}
				<IconCapChevronDown class="size-3.5 text-gray-10" />
			</button>
		</SettingItem>
	);
}

export default function FeedbackTab() {
	const [feedback, setFeedback] = createSignal("");
	const [uploadingLogs, setUploadingLogs] = createSignal(false);
	const [diagnostics] = createResource(fetchDiagnostics);

	const [mode, setMode] = createSignal("both");
	const [durationSecs, setDurationSecs] = createSignal(20);
	const [includeMicrophone, setIncludeMicrophone] = createSignal(false);
	const [running, setRunning] = createSignal(false);
	const [status, setStatus] = createSignal<string | null>(null);
	const [result, setResult] = createSignal<DiagnosticRunResult | null>(null);
	const [sendingReport, setSendingReport] = createSignal(false);

	const submission = useSubmission(sendFeedbackAction);
	const sendFeedback = useAction(sendFeedbackAction);

	const handleRunDiagnostic = async () => {
		const confirmed = await confirm(
			`Cap will take over your screen with a flashing test pattern and play loud beeps for about ${durationSecs()} seconds per pipeline. Take your headphones off, leave the volume audible, and don't use the machine until it finishes.`,
			{ title: "Run diagnostic?", kind: "warning", okLabel: "Run Diagnostic" },
		);
		if (!confirmed) return;

		setRunning(true);
		setResult(null);
		setStatus("Starting...");

		const unlisten = await events.diagnosticProgress.listen((event) =>
			setStatus(progressLabel(event.payload)),
		);

		try {
			setResult(
				await commands.runDiagnostic({
					includeSyncTest: true,
					mode: mode(),
					durationSecs: durationSecs(),
					includeMicrophone: includeMicrophone(),
					micName: null,
					skipExport: false,
				}),
			);
		} catch (error) {
			toast.error("Failed to run diagnostic");
			console.error("Failed to run diagnostic:", error);
		} finally {
			unlisten();
			setRunning(false);
			setStatus(null);
		}
	};

	const handleSendReport = async () => {
		const report = result();
		if (!report) return;

		setSendingReport(true);
		try {
			await commands.uploadDiagnosticReport(report.reportPath);
			toast.success("Diagnostic report sent to Cap");
		} catch (error) {
			toast.error("Failed to send diagnostic report");
			console.error("Failed to send diagnostic report:", error);
		} finally {
			setSendingReport(false);
		}
	};

	const handleRevealReport = async () => {
		const report = result();
		if (!report) return;

		try {
			await commands.revealDiagnosticReport(report.reportPath);
		} catch (error) {
			toast.error("Failed to show diagnostic report");
			console.error("Failed to reveal diagnostic report:", error);
		}
	};

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
					title="Diagnostic Report"
					description="Runs an audio/video sync test and collects your hardware, displays, cameras, microphones, Cap settings, details of your recent recordings and a copy of Cap's log file, so we can reproduce your setup instead of guessing at it. You can read the whole report before sending it."
				>
					<div class="space-y-2.5">
						<div class="flex gap-2.5 items-start px-3 py-2.5 rounded-xl border border-amber-500/30 bg-amber-500/10">
							<IconLucideAlertTriangle class="mt-0.5 size-3.5 shrink-0 text-amber-400" />
							<p class="text-xs leading-relaxed text-gray-11">
								The sync test takes over your screen with a flashing pattern and
								plays loud beeps for about {durationSecs()} seconds per
								pipeline. Take your headphones off and leave the volume audible
								(the microphone test needs to hear the beeps through your
								speakers), and don't use the machine until it finishes.
							</p>
						</div>

						<fieldset disabled={running()}>
							<SectionRows>
								<SelectDiagnosticItem
									label="Pipelines to test"
									description="Studio recordings, Instant recordings, or both in one run."
									value={mode()}
									options={DIAGNOSTIC_MODES}
									onChange={setMode}
								/>
								<SelectDiagnosticItem
									label="Test duration"
									description="Longer runs are more sensitive to slow drift."
									value={durationSecs()}
									options={DIAGNOSTIC_DURATIONS}
									onChange={setDurationSecs}
								/>
								<ToggleSettingItem
									label="Test microphone too"
									description="Also records your microphone and checks it against the beeps it can hear."
									value={includeMicrophone()}
									onChange={setIncludeMicrophone}
								/>
							</SectionRows>
						</fieldset>

						<div class="flex gap-3 items-center">
							<Button
								onClick={handleRunDiagnostic}
								size="md"
								variant="dark"
								disabled={running()}
							>
								{running() ? "Running..." : "Run Diagnostic"}
							</Button>
							<Show when={running() && status()}>
								{(label) => <p class="text-xs text-gray-10">{label()}</p>}
							</Show>
						</div>

						<Show when={result()}>
							{(report) => (
								<div class="px-4 py-3.5 space-y-2.5 rounded-xl border border-gray-3 bg-gray-2">
									<div class="flex gap-2 items-center flex-wrap">
										<span
											class={`px-2 py-1 rounded text-xs ${
												VERDICT_STYLES[report().verdict ?? ""] ??
												"bg-gray-4 text-gray-11"
											}`}
										>
											{report().verdict?.toUpperCase() ?? "SYSTEM INFO ONLY"}
										</span>
										<Show when={report().summary}>
											{(summary) => (
												<p class="text-xs text-gray-11">{summary()}</p>
											)}
										</Show>
									</div>

									<Show when={report().syncTestError}>
										{(error) => (
											<p class="text-xs leading-relaxed text-amber-400">
												The sync test couldn't run: {error()}. The report still
												contains your system information.
											</p>
										)}
									</Show>

									<div class="flex gap-2 items-center">
										<Button
											onClick={handleSendReport}
											size="md"
											variant="dark"
											disabled={sendingReport()}
										>
											{sendingReport() ? "Sending..." : "Send to Cap"}
										</Button>
										<Button
											onClick={handleRevealReport}
											size="md"
											variant="gray"
										>
											Show File
										</Button>
									</div>
								</div>
							)}
						</Show>
					</div>
				</Section>

				<Section
					title="Debug Information"
					description="Upload Cap's log file to help us diagnose issues. It records what the app did, which can include file paths and the names of things you recorded."
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
