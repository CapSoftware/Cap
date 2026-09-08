"use client";

import { classNames } from "@cap/utils/helpers";
import { Check } from "lucide-react";
import { useRef } from "react";
import { CapShareWindow } from "../demo/CapShareWindow";
import { RecordingToolbar } from "../demo/CapSurfaces";
import { CapLogoMark } from "../demo/capIcons";
import { ContentWindow } from "../demo/MacDesktop";
import { MONO } from "../theme";
import { SCENE_META } from "./catalog";
import {
	clockText,
	easeInOut,
	Fit,
	noop,
	type SceneModule,
	type SceneProps,
	STAGE,
	Stage,
	span,
	typed,
	useCursor,
	useSceneClock,
	useSceneState,
	useVideo,
	type Way,
} from "./engine";

const CHAPTERS = SCENE_META.agent.chapters;

const PROMPT =
	"Record a 20 second repro of the checkout bug and send me the link";
const PLAN =
	"I'll pick the screen, record it in Instant Mode, upload it, and read back the summary.";
const DONE = "Done. The repro is live with a transcript and summary.";
const SUMMARY = "Summary: the cart total resets after a promo code is applied.";

const PROMPT_START = 250;
const PROMPT_CPS = 36;
const PLAN_AT = 2300;
const TOOL1 = { start: 2700, done: 3400 };
const RECORD = { start: 3900, end: 8900 };
const TOOL2 = { start: 3600, done: 9000 };
const TOOL3 = { start: 9400, done: 10600 };
const TOOL4 = { start: 10900, done: 12000 };
const FINAL_AT = 12200;
const LINK_AT = 12500;
const SHARE_AT = 10650;
const COMMENT_AT = 13800;
const RECORD_SECONDS = 20;

type ToolStatus = "idle" | "running" | "done";

const toolStatus = (
	t: number,
	tool: { start: number; done: number },
): ToolStatus => (t < tool.start ? "idle" : t < tool.done ? "running" : "done");

const uiAt = (t: number) => ({
	plan: t >= PLAN_AT,
	tool1: toolStatus(t, TOOL1),
	tool2: toolStatus(t, TOOL2),
	tool3: toolStatus(t, TOOL3),
	tool4: toolStatus(t, TOOL4),
	recording: t >= RECORD.start && t < RECORD.end,
	final: t >= FINAL_AT,
	link: t >= LINK_AT,
	toolbar: t >= RECORD.start - 200 && t < RECORD.end + 100,
	share: t >= SHARE_AT,
	comment: t >= COMMENT_AT,
});

const recordSeconds = (t: number) =>
	Math.min(
		RECORD_SECONDS,
		Math.floor(span(t, RECORD.start, RECORD.end) * RECORD_SECONDS),
	);

const POS = {
	content: { left: 60, top: 40, width: 560, height: 380 },
	toolbar: { left: (680 - 296) / 2, top: 428 },
	share: { left: 80, top: 24, width: 520, height: 440 },
};

const PATH: Way[] = [
	{ t: 0, x: 620, y: 440 },
	{ t: 17000, x: 620, y: 440 },
];

const AGENT_CSS = `
	@keyframes ht-agent-spin {
		to { transform: rotate(360deg); }
	}
	@keyframes ht-agent-blink {
		0%, 100% { opacity: 1; }
		50% { opacity: 0; }
	}
	@keyframes ht-agent-pulse {
		0%, 100% { opacity: 1; }
		50% { opacity: 0.35; }
	}
`;

const Status = ({ status }: { status: ToolStatus }) => (
	<span className="relative mt-[3px] grid size-4 shrink-0 place-items-center">
		<span
			className={classNames(
				"absolute inset-0 rounded-full border-2 border-[rgba(255,255,255,0.18)] border-t-[#8FC1F7] transition-opacity duration-200",
				status === "running" ? "opacity-100" : "opacity-0",
			)}
			style={{ animation: "ht-agent-spin 0.9s linear infinite" }}
		/>
		<span
			className={classNames(
				"absolute inset-0 grid place-items-center rounded-full bg-[#8FDCBB] text-[#0b2a1f] transition-[opacity,transform] duration-300",
				status === "done" ? "scale-100 opacity-100" : "scale-50 opacity-0",
			)}
		>
			<Check className="size-2.5" strokeWidth={3.5} />
		</span>
		<span
			className={classNames(
				"absolute inset-[5px] rounded-full bg-[rgba(255,255,255,0.18)] transition-opacity duration-200",
				status === "idle" ? "opacity-100" : "opacity-0",
			)}
		/>
	</span>
);

const Tokens = ({ text }: { text: string }) => {
	const parts = text.split(" ");
	const seen = new Map<string, number>();
	return parts.map((token, i) => {
		const n = seen.get(token) ?? 0;
		seen.set(token, n + 1);
		return (
			<span key={`${token}#${n}`}>
				<span className="whitespace-nowrap">{token}</span>
				{i < parts.length - 1 ? " " : ""}
			</span>
		);
	});
};

const Tool = ({
	status,
	command,
	via = "$",
	children,
}: {
	status: ToolStatus;
	command: string;
	via?: string;
	children?: React.ReactNode;
}) => (
	<div
		className={classNames(
			"transition-[opacity,transform] duration-[420ms] ease-out",
			status === "idle"
				? "translate-y-2 opacity-0"
				: "translate-y-0 opacity-100",
		)}
	>
		<div className="flex items-start gap-2.5">
			<Status status={status} />
			<p
				className={classNames(
					MONO,
					"min-w-0 flex-1 text-[12.5px] leading-[1.6] text-[#F8FAFC]",
				)}
			>
				<span className="text-[rgba(255,255,255,0.45)]">{via} </span>
				<Tokens text={command} />
			</p>
		</div>
		<div
			className={classNames(
				MONO,
				"flex items-start gap-2 pl-[26px] text-[12px] leading-[1.6] text-[rgba(255,255,255,0.55)] transition-opacity duration-300",
			)}
			style={{ opacity: status === "idle" ? 0 : 1 }}
		>
			<span className="shrink-0">⎿</span>
			<div className="min-w-0 flex-1">{children}</div>
		</div>
	</div>
);

const Json = ({ children }: { children: React.ReactNode }) => (
	<span className="text-[rgba(255,255,255,0.7)]">{children}</span>
);
const Key = ({ children }: { children: React.ReactNode }) => (
	<span className="text-[#8FC1F7]">{children}</span>
);
const Str = ({ children }: { children: React.ReactNode }) => (
	<span className="text-[#8FDCBB]">{children}</span>
);
const Num = ({ children }: { children: React.ReactNode }) => (
	<span className="text-[#F5BE85]">{children}</span>
);

const Message = ({
	show,
	children,
}: {
	show: boolean;
	children: React.ReactNode;
}) => (
	<div
		className={classNames(
			"flex items-start gap-2.5 transition-[opacity,transform] duration-[420ms] ease-out",
			show ? "translate-y-0 opacity-100" : "translate-y-2 opacity-0",
		)}
	>
		<span className="mt-[5px] size-2.5 shrink-0 rounded-[3px] bg-[#B9A5F2]" />
		<div className="min-w-0 flex-1">{children}</div>
	</div>
);

export const AgentScene = (props: SceneProps) => {
	const promptRef = useRef<HTMLSpanElement | null>(null);
	const clockRef = useRef<HTMLSpanElement | null>(null);
	const timerRef = useRef<HTMLSpanElement | null>(null);
	const layerRef = useRef<HTMLDivElement | null>(null);
	const scrollRef = useRef<HTMLDivElement | null>(null);
	const shareVideoRef = useRef<HTMLVideoElement | null>(null);
	const [ui, setUi] = useSceneState(uiAt(0));
	const cursor = useCursor(layerRef);
	useVideo(props.playing && ui.share, shareVideoRef);

	useSceneClock({
		...props,
		chapters: CHAPTERS,
		tick: (t, seek) => {
			setUi(uiAt(t));
			if (promptRef.current) {
				promptRef.current.textContent = typed(
					PROMPT,
					t,
					PROMPT_START,
					PROMPT_CPS,
				);
			}
			const seconds = recordSeconds(t);
			if (clockRef.current) {
				clockRef.current.textContent =
					t < RECORD.start
						? "Starting"
						: t < RECORD.end
							? `Recording ${clockText(seconds * 1000)}`
							: `Recorded ${clockText(RECORD_SECONDS * 1000)}`;
			}
			if (timerRef.current) {
				timerRef.current.textContent = clockText(seconds * 1000);
			}
			if (scrollRef.current) {
				scrollRef.current.style.transform = `translateY(${
					-120 * easeInOut(span(t, RECORD.start + 800, RECORD.end - 600))
				}px)`;
			}
			cursor.tick(PATH, t, seek);
		},
	});

	return (
		<div className="grid gap-4 lg:grid-cols-[1.05fr_1fr] lg:gap-6">
			<style>{AGENT_CSS}</style>
			<div className="flex min-h-[420px] flex-col rounded-[18px] bg-[rgba(255,255,255,0.03)] p-5 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)] lg:p-6">
				<div className="flex items-center gap-2 border-b border-white/10 pb-4">
					<span className="size-2 rounded-full bg-[#FF5F57]" />
					<span className="size-2 rounded-full bg-[#FEBC2E]" />
					<span className="size-2 rounded-full bg-[#28C840]" />
					<span
						className={classNames(
							MONO,
							"ml-3 text-[11px] uppercase tracking-[0.05em] text-[rgba(255,255,255,0.45)]",
						)}
					>
						agent session · ~/checkout
					</span>
				</div>

				<div className="flex flex-1 flex-col gap-4 pt-5">
					<div className="flex items-start gap-2.5">
						<span
							className={classNames(MONO, "mt-px text-[13px] text-[#8FC1F7]")}
						>
							›
						</span>
						<p className="text-[14.5px] leading-[1.55] text-[#F8FAFC]">
							<span ref={promptRef} />
							<span
								className="ml-0.5 inline-block h-[15px] w-[7px] translate-y-[2px] bg-[#F8FAFC]"
								style={{
									animation: "ht-agent-blink 1s steps(1) infinite",
									opacity: ui.plan ? 0 : 1,
								}}
							/>
						</p>
					</div>

					<Message show={ui.plan}>
						<p className="text-[14px] leading-[1.55] text-[rgba(255,255,255,0.82)]">
							{PLAN}
						</p>
					</Message>

					<div className="flex flex-col gap-3">
						<Tool status={ui.tool1} command="cap targets --json">
							<Json>
								{"{"} <Key>"screens"</Key>: [{"{"} <Key>"id"</Key>: <Num>1</Num>
								, <Key>"name"</Key>: <Str>"Built-in Retina Display"</Str> {"}"}]{" "}
								{"}"}
							</Json>
						</Tool>
						<Tool
							status={ui.tool2}
							command="cap record start --screen 1 --mode instant --duration 20 --json"
						>
							<span className="block">
								<Json>
									{"{"}
									<Key>"type"</Key>:<Str>"started"</Str>
									{"}"}
								</Json>
							</span>
							<span className="flex items-center gap-2">
								<span
									className={classNames(
										"size-2 rounded-full transition-colors duration-300",
										ui.recording
											? "bg-[#ff4766]"
											: "bg-[rgba(255,255,255,0.35)]",
									)}
									style={
										ui.recording
											? {
													animation: "ht-agent-pulse 1.2s ease-in-out infinite",
												}
											: undefined
									}
								/>
								<span ref={clockRef} className="tabular-nums text-[#F8FAFC]" />
							</span>
							<span
								className="block transition-opacity duration-300"
								style={{ opacity: ui.tool2 === "done" ? 1 : 0 }}
							>
								<Json>
									{"{"}
									<Key>"type"</Key>:<Str>"stopped"</Str>,
									<Key>"recordingMetaExists"</Key>:<Num>true</Num>
									{"}"}
								</Json>
							</span>
						</Tool>
						<Tool
							status={ui.tool3}
							command={
								'cap upload ./recording.cap --export --name "Checkout bug repro" --json'
							}
						>
							<Json>
								{"{"} <Key>"url"</Key>: <Str>"https://cap.so/s/x7f2k9"</Str>{" "}
								{"}"}
							</Json>
						</Tool>
						<Tool
							status={ui.tool4}
							via="mcp"
							command="caps_wait, caps_context x7f2k9"
						>
							<span className="text-[rgba(255,255,255,0.7)]">{SUMMARY}</span>
						</Tool>
					</div>

					<Message show={ui.final}>
						<p className="text-[14px] leading-[1.55] text-[rgba(255,255,255,0.82)]">
							{DONE}
						</p>
						<div
							className={classNames(
								"mt-3 flex items-center gap-3 rounded-[12px] bg-white p-2.5 pr-4 text-[#111111] transition-[opacity,transform] duration-[480ms] ease-[cubic-bezier(0.16,1,0.3,1)]",
								ui.link
									? "translate-y-0 scale-100 opacity-100"
									: "translate-y-2 scale-[0.97] opacity-0",
							)}
						>
							<span className="grid size-9 shrink-0 place-items-center rounded-[9px] bg-[#E4F0FB]">
								<CapLogoMark className="size-5" />
							</span>
							<span className="min-w-0 flex-1 leading-tight">
								<span className="block truncate text-[13.5px] font-medium">
									Checkout bug repro
								</span>
								<span className="block text-[12px] text-[rgba(17,17,17,0.55)]">
									cap.so/s/x7f2k9 · 0:20 · AI summary ready
								</span>
							</span>
						</div>
					</Message>
				</div>
			</div>

			<div className="flex flex-col justify-center">
				<Fit w={STAGE.w} h={STAGE.h} className="mx-auto">
					<Stage
						wallpaper="/backgrounds/santorini.webp"
						recording={ui.recording}
						layerRef={layerRef}
					>
						<div
							className="absolute"
							style={{ left: POS.content.left, top: POS.content.top }}
						>
							<ContentWindow
								width={POS.content.width}
								height={POS.content.height}
								scrollRef={scrollRef}
							/>
						</div>
						<div className="absolute z-10" style={POS.share}>
							<CapShareWindow
								visible={ui.share}
								width={POS.share.width}
								height={POS.share.height}
								commentVisible={ui.comment}
								videoRef={shareVideoRef}
								title="Checkout bug repro"
								url="cap.so/s/x7f2k9"
								duration="0:20"
							/>
						</div>
						<div className="absolute z-20" style={POS.toolbar}>
							<RecordingToolbar
								visible={ui.toolbar}
								paused={false}
								timerRef={timerRef}
								onStop={noop}
								onTogglePause={noop}
								onRestart={noop}
								onMiss={noop}
							/>
						</div>
						{cursor.Cursor}
					</Stage>
				</Fit>
			</div>
		</div>
	);
};

export const AGENT: SceneModule = {
	Scene: AgentScene,
	chapters: CHAPTERS,
	poster: SCENE_META.agent.poster,
};
