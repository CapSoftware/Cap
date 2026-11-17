"use client";

import { classNames } from "@cap/utils/helpers";
import { CapLogoMark } from "../demo/capIcons";
import { useIsWindowsDemo } from "../demo/platform";
import { MONO } from "../theme";
import { Loop, seg, TONES } from "./kit";
import { CAP_TITLE } from "./share";
import { AppBar, INVOICE, InvoicePage } from "./subjects";

export const CANVAS = { w: 1040, h: 450 } as const;

const PROMPT =
	"Record a 20 second repro of the invoice bug and send me the link";

const STEPS = [
	{
		at: 2100,
		done: 4200,
		command: "cap record start --mode instant --duration 20 --json",
		result: "Recorded 0:20 of screen 1",
	},
	{
		at: 4400,
		done: 5400,
		command: 'cap upload ./recording.cap --name "Invoice bug repro" --json',
		result: "Uploaded, link ready",
	},
	{
		at: 5600,
		done: 6400,
		command: "cap caps context m4k8x2qz --json",
		result: "Read the transcript and summary",
	},
];

const Spinner = () => (
	<svg aria-hidden="true" viewBox="0 0 16 16" className="size-4 animate-spin">
		<circle
			cx="8"
			cy="8"
			r="6"
			fill="none"
			stroke="rgba(255,255,255,0.18)"
			strokeWidth="2"
		/>
		<path
			d="M8 2a6 6 0 0 1 6 6"
			fill="none"
			stroke="#FFFFFF"
			strokeWidth="2"
			strokeLinecap="round"
		/>
	</svg>
);

const Check = () => (
	<svg aria-hidden="true" viewBox="0 0 16 16" className="size-4">
		<circle cx="8" cy="8" r="7" fill="#22C55E" />
		<path
			d="M4.8 8.3l2.1 2.1 4.3-4.6"
			fill="none"
			stroke="#0E0F11"
			strokeWidth="1.8"
			strokeLinecap="round"
			strokeLinejoin="round"
		/>
	</svg>
);

const AgentView = ({ t }: { t: number; playing: boolean }) => {
	const windows = useIsWindowsDemo();
	const typed = PROMPT.slice(0, Math.floor(seg(t, 200, 1700) * PROMPT.length));
	const answer = t > 6700;
	const card = seg(t, 6600, 7100);
	return (
		<div className="absolute inset-0 bg-[#0E0F11] text-white">
			<AppBar
				dark
				className="absolute inset-x-0 top-0 h-10 border-b border-white/[0.07] bg-white/[0.03]"
			>
				<span
					className={classNames(
						MONO,
						"mx-auto flex items-center gap-2 text-[12.5px] text-white/50",
					)}
				>
					<span className="size-1.5 rounded-full bg-[#22C55E]" />
					{windows ? "agent · C:\\ledgerly" : "agent · ~/ledgerly"}
				</span>
			</AppBar>
			<div
				className={classNames(
					MONO,
					"absolute left-10 top-[52px] w-[560px] text-[14px] leading-[1.6]",
				)}
			>
				<div className="mt-6 flex gap-3">
					<span className="text-[rgba(255,255,255,0.4)]">›</span>
					<span>
						{typed}
						{t < 1900 ? (
							<span className="ml-0.5 inline-block h-4 w-2 translate-y-[3px] animate-pulse bg-white/80" />
						) : null}
					</span>
				</div>
				<div className="mt-6 flex flex-col gap-4">
					{STEPS.filter((step) => t > step.at).map((step) => {
						const done = t > step.done;
						return (
							<div key={step.command} className="ht-fade-in flex gap-3">
								<span className="mt-[3px]">
									{done ? <Check /> : <Spinner />}
								</span>
								<span className="min-w-0">
									<span className="block break-words text-[rgba(255,255,255,0.78)]">
										{step.command}
									</span>
									<span className="block text-[12.5px] text-[rgba(255,255,255,0.45)]">
										{done ? step.result : "Running"}
									</span>
								</span>
							</div>
						);
					})}
				</div>
				{answer ? (
					<p className="ht-fade-in mt-6 font-sans text-[15px] leading-[1.55] text-[rgba(255,255,255,0.88)] [font-family:var(--font-ht-geist),system-ui,sans-serif]">
						Here is the repro. At 0:12 the total stays at $4,200 after the
						second line item is removed.
					</p>
				) : null}
			</div>

			<div
				className="absolute right-10 top-[88px] w-[340px] overflow-hidden rounded-[16px] bg-white text-[#1C1D21] shadow-[0_30px_80px_-30px_rgba(0,0,0,0.8)]"
				style={{
					opacity: card,
					transform: `translateY(${(1 - card) * 16}px)`,
				}}
			>
				<div className="relative h-[190px] overflow-hidden bg-[#DCE6F1]">
					<div
						className="absolute left-[22px] top-[16px] overflow-hidden rounded-[6px]"
						style={{
							width: INVOICE.w,
							height: INVOICE.h,
							transform: "scale(0.435)",
							transformOrigin: "top left",
						}}
					>
						<InvoicePage />
					</div>
				</div>
				<div className="p-4">
					<div className="flex items-center gap-1.5 text-[12px] text-[#8A8F98]">
						<CapLogoMark className="size-3.5" /> Cap.so/s/m4k8x2qz
					</div>
					<div className="mt-1 text-[15px] font-semibold">
						{CAP_TITLE.replace("Sending an invoice", "Invoice bug repro")}
					</div>
					<div className="mt-2 text-[13px] leading-[1.5] text-[#4B5059]">
						Removing a line item leaves the total unchanged until the page
						reloads.
					</div>
				</div>
			</div>
		</div>
	);
};

export const AgentsStage = () => (
	<Loop
		View={AgentView}
		duration={10500}
		pose={9000}
		canvas={CANVAS}
		crop={{ x: 16, w: 620 }}
		tone={TONES.agents}
	/>
);
