"use client";

import { classNames } from "@cap/utils/helpers";
import { Check } from "lucide-react";
import {
	type ReactNode,
	type RefObject,
	useEffect,
	useMemo,
	useRef,
} from "react";
import { CapLogoMark } from "@/components/pages/HomeTwo/demo/capIcons";
import { typed, useSceneState } from "@/components/pages/HomeTwo/scenes/engine";
import { MONO } from "@/components/pages/HomeTwo/theme";
import { usePageVisible } from "@/components/pages/HomeTwo/visibility";
import { capabilities } from "./content";

type Card =
	| { kind: "link"; title: string; meta: string }
	| { kind: "rows"; rows: readonly (readonly [string, string])[] };

type Beat =
	| { type: "prompt"; text: string }
	| { type: "plan"; text: string }
	| { type: "tool"; via?: "mcp"; cmd: string; out: string; ms?: number }
	| { type: "ask"; text: string; reply: string }
	| { type: "result"; text: string; card?: Card };

type Task = { key: string; label: string; beats: readonly Beat[] };

const TASKS: readonly Task[] = [
	{
		key: "record",
		label: "record",
		beats: [
			{
				type: "prompt",
				text: "Record a 20 second repro of the checkout bug and send me the link",
			},
			{
				type: "plan",
				text: "I'll check capture, pick the screen, record in Instant Mode, then ask before uploading.",
			},
			{
				type: "tool",
				cmd: "cap doctor --json",
				out: '{ "captureReady": true }',
			},
			{
				type: "tool",
				cmd: "cap record start --screen 1 --mode instant --duration 20 --json",
				out: '{ "type": "stopped", "recordingMetaExists": true }',
				ms: 2400,
			},
			{
				type: "ask",
				text: "Recorded 0:20 and validated the project. Upload it to Cap as “Checkout bug repro”?",
				reply: "Yes, upload it",
			},
			{
				type: "tool",
				cmd: 'cap upload ./recording.cap --export --name "Checkout bug repro" --json',
				out: '{ "type": "uploaded", "id": "x7f2k9", "link": "https://cap.so/s/x7f2k9" }',
				ms: 1200,
			},
			{
				type: "tool",
				cmd: "cap caps wait x7f2k9 --for all --json",
				out: '{ "transcript": { "status": "complete" }, "ai": { "status": "complete" } }',
				ms: 1600,
			},
			{
				type: "result",
				text: "Done. The repro is live with a transcript and summary.",
				card: {
					kind: "link",
					title: "Checkout bug repro",
					meta: "cap.so/s/x7f2k9 · 0:20 · AI summary ready",
				},
			},
		],
	},
	{
		key: "understand",
		label: "summarize",
		beats: [
			{
				type: "prompt",
				text: "Summarize cap.so/s/x7f2k9 and list the action items with timestamps",
			},
			{
				type: "plan",
				text: "Reading the summary, chapters, transcript, and comments. This is read only.",
			},
			{
				type: "tool",
				cmd: "cap caps context x7f2k9 --json",
				out: '{ "title": { "current": "Checkout bug repro" }, "summary": { "status": "available" }, "chapters": { "status": "available" }, "transcript": { "status": "complete" } }',
				ms: 1000,
			},
			{
				type: "result",
				text: "Two decisions and three action items, cited from the transcript.",
				card: {
					kind: "rows",
					rows: [
						["02:14", "Cart total resets after a promo code is applied"],
						["03:40", "Ship the fix behind a flag on Friday"],
						["04:05", "Add a regression test for stacked codes"],
					],
				},
			},
		],
	},
	{
		key: "search",
		label: "search",
		beats: [
			{
				type: "prompt",
				text: "Find my Caps about onboarding from the last month and brief me",
			},
			{
				type: "plan",
				text: "Searching your library, then reading only the top matches.",
			},
			{
				type: "tool",
				cmd: 'cap caps list --search "onboarding" --updated-after 2026-08-10 --json',
				out: '{ "caps": [ { "id": "k3m8v2", "title": "Onboarding flow v3 walkthrough" }, … ] }',
			},
			{
				type: "tool",
				via: "mcp",
				cmd: "caps_context × 3",
				out: "3 transcripts read · 41 minutes total",
				ms: 1400,
			},
			{
				type: "result",
				text: "Four Caps. The v3 flow removed the org step, but the invite email still mentions it.",
				card: {
					kind: "rows",
					rows: [
						["2d ago", "Onboarding flow v3 walkthrough"],
						["9d ago", "Invite email copy review"],
						["3w ago", "Org setup: what changed"],
					],
				},
			},
		],
	},
	{
		key: "collaborate",
		label: "comment",
		beats: [
			{
				type: "prompt",
				text: "Ask for clarification where pricing is discussed. Show me first.",
			},
			{
				type: "tool",
				cmd: "cap caps context x7f2k9 --json",
				out: '{ "chapters": { "status": "available", "value": [ … ] }, "transcript": { "status": "complete" } }',
			},
			{
				type: "ask",
				text: "Draft at 04:32: “Is the annual discount 20% or 25%? The deck says both.” Post it?",
				reply: "Yes, post it",
			},
			{
				type: "tool",
				cmd: 'cap caps comments add x7f2k9 "Is the annual discount 20% or 25%? The deck says both." --timestamp-ms 272000 --yes --json',
				out: '{ "id": "cmt_8h2k", "timestampMs": 272000 }',
			},
			{
				type: "result",
				text: "Posted at 04:32. I re-read the Cap and the comment is there.",
			},
		],
	},
	{
		key: "team",
		label: "organize",
		beats: [
			{
				type: "prompt",
				text: "Move this Cap into the Product space's Releases folder",
			},
			{
				type: "plan",
				text: "Checking where it lives now and the destination IDs before proposing a move.",
			},
			{
				type: "tool",
				cmd: "cap library spaces list org_2j4k --json",
				out: '{ "spaces": [ { "id": "sp_prod", "name": "Product" } ] }',
			},
			{
				type: "tool",
				cmd: "cap library folders list org_2j4k --space sp_prod --json",
				out: '{ "folders": [ { "id": "fld_rel", "name": "Releases" } ] }',
			},
			{
				type: "ask",
				text: "Current: Personal library. Proposed: Product / Releases. Move it?",
				reply: "Go ahead",
			},
			{
				type: "tool",
				cmd: "cap caps move x7f2k9 --container space --organization org_2j4k --space sp_prod --folder fld_rel --yes --json",
				out: '{ "resource": { "type": "cap", "id": "x7f2k9" }, "action": "moved" }',
			},
			{
				type: "tool",
				cmd: "cap caps get x7f2k9 --json",
				out: '{ "id": "x7f2k9", "organizationId": "org_2j4k", "folderId": "fld_rel" }',
			},
			{
				type: "result",
				text: "Moved and verified. The Cap now sits in Product / Releases.",
			},
		],
	},
	{
		key: "migrate",
		label: "import",
		beats: [
			{
				type: "prompt",
				text: "Import loom.com/share/7f3a9c2e into our org and wait until it's done",
			},
			{
				type: "ask",
				text: "Owner: sam@acme.com · Space: Product. Start the import? It is durable but not free to repeat.",
				reply: "Yes",
			},
			{
				type: "tool",
				cmd: "cap caps import loom https://loom.com/share/7f3a9c2e --organization org_2j4k --owner-email sam@acme.com --space Product --yes --json",
				out: '{ "id": "op_51ac", "state": "queued" }',
				ms: 900,
			},
			{
				type: "tool",
				cmd: "cap jobs wait op_51ac --json",
				out: '{ "id": "op_51ac", "state": "succeeded", "resultResourceId": "m4p2q8" }',
				ms: 2200,
			},
			{
				type: "tool",
				cmd: "cap caps context m4p2q8 --json",
				out: '{ "title": { "current": "Q3 roadmap walkthrough" }, "transcript": { "status": "complete" }, "chapters": { "status": "available" } }',
				ms: 900,
			},
			{
				type: "result",
				text: "Imported and verified. The Cap has its title, a transcript, and chapters.",
				card: {
					kind: "link",
					title: "Q3 roadmap walkthrough",
					meta: "cap.so/s/m4p2q8 · imported from Loom",
				},
			},
		],
	},
];

const PROMPT_CPS = 40;
const REPLY_CPS = 26;
const REPLY_DELAY = 1400;
const HOLD = 2800;

type Scheduled = { beat: Beat; start: number; end: number };

const schedule = (task: Task) => {
	let t = 260;
	const items: Scheduled[] = [];
	for (const beat of task.beats) {
		switch (beat.type) {
			case "prompt": {
				const end = t + (beat.text.length / PROMPT_CPS) * 1000;
				items.push({ beat, start: t, end });
				t = end + 420;
				break;
			}
			case "plan": {
				items.push({ beat, start: t, end: t + 420 });
				t += 760;
				break;
			}
			case "tool": {
				const end = t + (beat.ms ?? 820);
				items.push({ beat, start: t, end });
				t = end + 340;
				break;
			}
			case "ask": {
				const end = t + REPLY_DELAY + (beat.reply.length / REPLY_CPS) * 1000;
				items.push({ beat, start: t, end });
				t = end + 460;
				break;
			}
			case "result": {
				items.push({ beat, start: t, end: t + 480 });
				t += 480;
				break;
			}
		}
	}
	return { items, duration: t + HOLD };
};

type Status = "hidden" | "typing" | "running" | "asked" | "done";

const statusOf = ({ beat, start, end }: Scheduled, t: number): Status => {
	if (t < start) return "hidden";
	if (beat.type === "prompt") return t < end ? "typing" : "done";
	if (beat.type === "tool") return t < end ? "running" : "done";
	if (beat.type === "ask") {
		if (t < start + REPLY_DELAY) return "asked";
		return t < end ? "typing" : "done";
	}
	return "done";
};

const REEL_CSS = `
	@keyframes ag-reel-spin { to { transform: rotate(360deg); } }
	@keyframes ag-reel-blink { 0%, 100% { opacity: 1; } 50% { opacity: 0; } }
	@keyframes ag-reel-in {
		from { opacity: 0; transform: translateY(8px); }
		to { opacity: 1; transform: none; }
	}
	.ag-reel-in { animation: ag-reel-in 420ms cubic-bezier(0.22, 1, 0.36, 1); }
	@media (prefers-reduced-motion: reduce) {
		.ag-reel-in { animation: none; }
	}
`;

const Dot = ({ status }: { status: Status }) => (
	<span className="relative mt-[3px] grid size-4 shrink-0 place-items-center">
		<span
			className={classNames(
				"absolute inset-0 rounded-full border-2 border-[rgba(255,255,255,0.18)] border-t-[#8FC1F7] transition-opacity duration-200",
				status === "running" ? "opacity-100" : "opacity-0",
			)}
			style={{ animation: "ag-reel-spin 0.9s linear infinite" }}
		/>
		<span
			className={classNames(
				"absolute inset-0 grid place-items-center rounded-full bg-[#8FDCBB] text-[#0b2a1f] transition-[opacity,transform] duration-300",
				status === "done" ? "scale-100 opacity-100" : "scale-50 opacity-0",
			)}
		>
			<Check className="size-2.5" strokeWidth={3.5} />
		</span>
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

const Row = ({ show, children }: { show: boolean; children: ReactNode }) => (
	<div
		className={classNames(
			"transition-[opacity,transform] duration-[420ms] ease-out",
			show ? "translate-y-0 opacity-100" : "translate-y-2 opacity-0",
		)}
	>
		{children}
	</div>
);

const Caret = ({ on }: { on: boolean }) => (
	<span
		className="ml-0.5 inline-block h-[14px] w-[7px] translate-y-[2px] bg-[#F8FAFC] transition-opacity duration-150"
		style={{
			animation: "ag-reel-blink 1s steps(1) infinite",
			opacity: on ? 1 : 0,
		}}
	/>
);

const AgentLine = ({ children }: { children: ReactNode }) => (
	<div className="flex items-start gap-2.5">
		<span className="mt-[6px] size-2.5 shrink-0 rounded-[3px] bg-[#B9A5F2]" />
		<div className="min-w-0 flex-1 text-[14px] leading-[1.55] text-[rgba(255,255,255,0.84)]">
			{children}
		</div>
	</div>
);

const UserLine = ({
	textRef,
	caret,
}: {
	textRef: RefObject<HTMLSpanElement | null>;
	caret: boolean;
}) => (
	<div className="flex items-start gap-2.5">
		<span className={classNames(MONO, "mt-px text-[13px] text-[#8FC1F7]")}>
			›
		</span>
		<p className="min-w-0 flex-1 text-[14.5px] leading-[1.55] text-[#F8FAFC]">
			<span ref={textRef} />
			<Caret on={caret} />
		</p>
	</div>
);

const ResultCard = ({ card }: { card: Card }) =>
	card.kind === "link" ? (
		<div className="mt-3 flex items-center gap-3 rounded-[12px] bg-white p-2.5 pr-4 text-[#111111]">
			<span className="grid size-9 shrink-0 place-items-center rounded-[9px] bg-[#E4F0FB]">
				<CapLogoMark className="size-5" />
			</span>
			<span className="min-w-0 flex-1 leading-tight">
				<span className="block truncate text-[13.5px] font-medium">
					{card.title}
				</span>
				<span className="block truncate text-[12px] text-[rgba(17,17,17,0.55)]">
					{card.meta}
				</span>
			</span>
		</div>
	) : (
		<ul className="mt-3 flex flex-col gap-1.5 rounded-[12px] bg-white p-3 text-[#111111]">
			{card.rows.map(([at, text]) => (
				<li key={text} className="flex items-baseline gap-3">
					<span
						className={classNames(
							MONO,
							"shrink-0 text-[11.5px] text-[rgba(17,17,17,0.5)]",
						)}
					>
						{at}
					</span>
					<span className="text-[13px] leading-[1.4]">{text}</span>
				</li>
			))}
		</ul>
	);

export const TaskReel = ({
	active,
	playing,
	reduced,
	progressRef,
	onEnd,
}: {
	active: number;
	playing: boolean;
	reduced: boolean;
	progressRef: RefObject<HTMLSpanElement | null>;
	onEnd: () => void;
}) => {
	const task = TASKS[active % TASKS.length] ?? TASKS[0];
	const { items, duration } = useMemo(
		() => schedule(task ?? TASKS[0] ?? { key: "", label: "", beats: [] }),
		[task],
	);
	const pageVisible = usePageVisible();
	const run = playing && pageVisible && !reduced;
	const [statuses, setStatuses] = useSceneState<Status[]>([]);
	const tRef = useRef(0);
	const promptRef = useRef<HTMLSpanElement | null>(null);
	const replyRef = useRef<HTMLSpanElement | null>(null);
	const onEndRef = useRef(onEnd);
	onEndRef.current = onEnd;

	const tickRef = useRef((_t: number) => {});
	tickRef.current = (t: number) => {
		setStatuses(items.map((item) => statusOf(item, t)));
		for (const item of items) {
			if (item.beat.type === "prompt" && promptRef.current) {
				promptRef.current.textContent = typed(
					item.beat.text,
					t,
					item.start,
					PROMPT_CPS,
				);
			}
			if (item.beat.type === "ask" && replyRef.current) {
				replyRef.current.textContent = typed(
					item.beat.reply,
					t,
					item.start + REPLY_DELAY,
					REPLY_CPS,
				);
			}
		}
		const bar = progressRef.current;
		if (bar) bar.style.transform = `scaleY(${Math.min(1, t / duration)})`;
	};

	useEffect(() => {
		if (items.length === 0) return;
		tRef.current = reduced ? duration : 0;
		tickRef.current(tRef.current);
	}, [items, duration, reduced]);

	useEffect(() => {
		if (!run) return;
		let raf = 0;
		let last = performance.now();
		const frame = (now: number) => {
			const dt = Math.min(48, now - last);
			last = now;
			const t = tRef.current + dt;
			if (t >= duration) {
				tRef.current = duration;
				tickRef.current(duration);
				onEndRef.current();
				return;
			}
			tRef.current = t;
			tickRef.current(t);
			raf = requestAnimationFrame(frame);
		};
		raf = requestAnimationFrame(frame);
		return () => cancelAnimationFrame(raf);
	}, [run, duration]);

	const capability = capabilities[active % capabilities.length];

	return (
		<div className="flex min-h-[460px] flex-col rounded-[18px] bg-[rgba(255,255,255,0.03)] p-5 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)] lg:min-h-[520px] lg:p-6">
			<style>{REEL_CSS}</style>
			<div className="flex items-center gap-2 border-b border-white/10 pb-4">
				<span className="size-2 rounded-full bg-[#FF5F57]" />
				<span className="size-2 rounded-full bg-[#FEBC2E]" />
				<span className="size-2 rounded-full bg-[#28C840]" />
				<span
					className={classNames(
						MONO,
						"ml-3 truncate text-[11px] uppercase tracking-[0.05em] text-[rgba(255,255,255,0.45)]",
					)}
				>
					agent session · {task?.label}
				</span>
				<span
					className={classNames(
						MONO,
						"ml-auto shrink-0 text-[11px] uppercase tracking-[0.05em] text-[rgba(255,255,255,0.35)]",
					)}
				>
					{String(active + 1).padStart(2, "0")} /{" "}
					{String(TASKS.length).padStart(2, "0")}
				</span>
			</div>

			<div key={task?.key} className="ag-reel-in flex flex-col gap-4 pt-5">
				{items.map((item, i) => {
					const status = statuses[i] ?? "hidden";
					const { beat } = item;
					if (beat.type === "prompt") {
						return (
							<UserLine
								key={`${task?.key}-${i}`}
								textRef={promptRef}
								caret={status === "typing"}
							/>
						);
					}
					if (beat.type === "plan") {
						return (
							<Row key={`${task?.key}-${i}`} show={status !== "hidden"}>
								<AgentLine>{beat.text}</AgentLine>
							</Row>
						);
					}
					if (beat.type === "tool") {
						return (
							<Row key={`${task?.key}-${i}`} show={status !== "hidden"}>
								<div className="flex items-start gap-2.5">
									<Dot status={status} />
									<p
										className={classNames(
											MONO,
											"min-w-0 flex-1 text-[12.5px] leading-[1.6] text-[#F8FAFC]",
										)}
									>
										<span className="text-[rgba(255,255,255,0.45)]">
											{beat.via ?? "$"}{" "}
										</span>
										<Tokens text={beat.cmd} />
									</p>
								</div>
								<div
									className={classNames(
										MONO,
										"flex items-start gap-2 pl-[26px] text-[12px] leading-[1.6] text-[rgba(255,255,255,0.6)] transition-opacity duration-300",
										status === "done" ? "opacity-100" : "opacity-0",
									)}
								>
									<span className="shrink-0">⎿</span>
									<span className="min-w-0 flex-1 break-words">{beat.out}</span>
								</div>
							</Row>
						);
					}
					if (beat.type === "ask") {
						return (
							<div key={`${task?.key}-${i}`} className="flex flex-col gap-4">
								<Row show={status !== "hidden"}>
									<AgentLine>{beat.text}</AgentLine>
								</Row>
								<div
									className={classNames(
										"transition-opacity duration-200",
										status === "typing" || status === "done"
											? "opacity-100"
											: "opacity-0",
									)}
								>
									<UserLine textRef={replyRef} caret={status === "typing"} />
								</div>
							</div>
						);
					}
					return (
						<Row key={`${task?.key}-${i}`} show={status !== "hidden"}>
							<AgentLine>
								<p>{beat.text}</p>
								{beat.card ? <ResultCard card={beat.card} /> : null}
							</AgentLine>
						</Row>
					);
				})}
			</div>

			<p
				className={classNames(
					MONO,
					"mt-auto pt-6 text-[11px] uppercase leading-none tracking-[0.05em] text-[rgba(255,255,255,0.35)]",
				)}
			>
				{capability?.command}
			</p>
		</div>
	);
};
