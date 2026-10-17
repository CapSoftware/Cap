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
	{ text: "Studio 与 Instant", value: "both" },
	{ text: "仅 Studio", value: "studio" },
	{ text: "仅 Instant", value: "instant" },
];

const DIAGNOSTIC_DURATIONS = [
	{ text: "20 秒", value: 20 },
	{ text: "40 秒", value: 40 },
	{ text: "60 秒", value: 60 },
];

/** Stage names come from the CLI verbatim; unknown ones are shown as-is. */
const SYNC_STAGE_LABELS: Record<string, string> = {
	collecting: "正在准备测试",
	recording: "正在录制测试图案",
	"pattern-run": "正在播放闪光与提示音序列",
	remuxing: "正在完成录制",
	analyzing: "正在分析闪光与提示音时序",
	exporting: "正在导出测试录像",
	done: "正在收尾同步测试",
};

const VERDICT_STYLES: Record<string, string> = {
	pass: "bg-green-500/20 text-green-400",
	warn: "bg-amber-500/20 text-amber-400",
	fail: "bg-red-500/20 text-red-400",
	inconclusive: "bg-gray-4 text-gray-11",
};

function progressLabel(payload: DiagnosticProgress) {
	if (payload.phase === "collecting") return "正在收集系统信息…";
	if (payload.phase === "done") return "即将完成…";
	const stage = payload.stage
		? (SYNC_STAGE_LABELS[payload.stage] ?? payload.stage)
		: "正在运行同步测试";
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
			{ title: "要运行诊断吗？", kind: "warning", okLabel: "运行诊断" },
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
			toast.error("运行诊断失败");
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
			toast.success("诊断报告已发送给 Cap");
		} catch (error) {
			toast.error("发送诊断报告失败");
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
			toast.error("显示诊断报告失败");
			console.error("Failed to reveal diagnostic report:", error);
		}
	};

	const handleUploadLogs = async () => {
		setUploadingLogs(true);
		try {
			await commands.uploadLogs();
			toast.success("日志上传成功");
		} catch (error) {
			toast.error("上传日志失败");
			console.error("Failed to upload logs:", error);
		} finally {
			setUploadingLogs(false);
		}
	};

	return (
		<div class="cap-settings-page flex flex-col w-full h-full custom-scroll">
			<SettingsPageContent>
				<Section
					title="反馈"
					description="提交反馈或报告问题，帮助我们改进 Cap，我们会尽快处理。"
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
									placeholder="告诉我们你对 Cap 的看法…"
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
								<p class="text-sm text-primary">感谢你的反馈！</p>
							)}

							<Button
								type="submit"
								size="md"
								variant="dark"
								disabled={feedback().trim().length < 4}
								class="mt-2"
							>
								{submission.pending ? "Submitting..." : "提交反馈"}
							</Button>
						</fieldset>
					</form>
				</Section>

				<Section
					title="加入社区"
					description="有疑问、想交流想法，或者只是想聊聊天？欢迎加入 Cap 的 Discord 社区。"
				>
					<Button
						onClick={() => shell.open("https://cap.link/discord")}
						size="md"
						variant="gray"
					>
						加入 Discord
					</Button>
				</Section>

				<Section
					title="诊断报告"
					description="Runs an audio/video sync test and collects your hardware, displays, cameras, microphones, Cap settings, details of your recent recordings and a copy of Cap's log file, so we can reproduce your setup instead of guessing at it. You can read the whole report before sending it."
				>
					<div class="space-y-2.5">
						<div class="flex gap-2.5 items-start px-3 py-2.5 rounded-xl border border-amber-500/30 bg-amber-500/10">
							<IconLucideAlertTriangle class="mt-0.5 size-3.5 shrink-0 text-amber-400" />
							<p class="text-xs leading-relaxed text-gray-11">
								同步测试会接管你的屏幕，播放闪烁图案和响亮的提示音，持续约 {durationSecs()} 秒（每条流水线）。请摘下耳机并保持音量可闻（麦克风测试需要从扬声器听到提示音），测试结束前请不要使用这台电脑。
							</p>
						</div>

						<fieldset disabled={running()}>
							<SectionRows>
								<SelectDiagnosticItem
									label="待测试的流水线"
									description="Studio 录制、Instant 录制，或两者同时进行。"
									value={mode()}
									options={DIAGNOSTIC_MODES}
									onChange={setMode}
								/>
								<SelectDiagnosticItem
									label="测试时长"
									description="运行时间越长，越容易受缓慢漂移影响。"
									value={durationSecs()}
									options={DIAGNOSTIC_DURATIONS}
									onChange={setDurationSecs}
								/>
								<ToggleSettingItem
									label="同时测试麦克风"
									description="同时录制麦克风，并与听到的提示音进行比对。"
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
								{running() ? "Running..." : "运行诊断"}
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
												同步测试无法运行： {error()}。报告仍包含你的系统信息。
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
											{sendingReport() ? "Sending..." : "发送到 Cap"}
										</Button>
										<Button
											onClick={handleRevealReport}
											size="md"
											variant="gray"
										>
											显示文件
										</Button>
									</div>
								</div>
							)}
						</Show>
					</div>
				</Section>

				<Section
					title="调试信息"
					description="上传 Cap 的日志文件，帮助我们排查问题。日志记录了应用的行为，可能包含文件路径和你录制的对象名称。"
				>
					<Button
						onClick={handleUploadLogs}
						size="md"
						variant="gray"
						disabled={uploadingLogs()}
					>
						{uploadingLogs() ? "Uploading..." : "上传日志"}
					</Button>
				</Section>

				<Section title="系统信息">
					<Show
						when={!diagnostics.loading && diagnostics()}
						fallback={
							<p class="text-xs leading-relaxed text-gray-10">
								正在加载系统信息…
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
												<p class="text-gray-11 font-medium">操作系统</p>
												<p class="text-gray-10 bg-gray-2 px-2 py-1.5 rounded-sm font-mono text-xs">
													{ver().displayName}
												</p>
											</div>
										)}
									</Show>

									<div class="space-y-1">
										<p class="text-gray-11 font-medium">捕获支持</p>
										<div class="flex gap-2 flex-wrap">
											<span
												class={`px-2 py-1 rounded text-xs ${
													captureSupported
														? "bg-green-500/20 text-green-400"
														: "bg-red-500/20 text-red-400"
												}`}
											>
												屏幕捕获：{" "}
												{captureSupported ? "支持" : "不支持"}
											</span>
										</div>
									</div>

									<Show when={(d.availableEncoders as string[])?.length > 0}>
										<div class="space-y-1">
											<p class="text-gray-11 font-medium">可用编码器</p>
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
