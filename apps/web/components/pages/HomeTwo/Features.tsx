import { classNames } from "@cap/utils/helpers";
import {
	ArrowDownToLine,
	Captions,
	Gauge,
	Github,
	HardDrive,
	Lock,
	MessageSquare,
	MonitorSmartphone,
} from "lucide-react";
import Link from "next/link";
import type { ComponentType } from "react";
import { Eyebrow } from "./Eyebrow";
import {
	BAND,
	BODY_TEXT,
	BTN_SECONDARY,
	grainBg,
	H_SECTION,
	MODE_THEME,
	type ModeKey,
} from "./theme";

type Feature = {
	title: string;
	body: string;
	accent: ModeKey;
	Icon: ComponentType<{ className?: string }>;
};

const FEATURES: Feature[] = [
	{
		title: "Your storage, your rules",
		body: "Connect your own Google Drive or S3 bucket, use Cap Cloud, or keep everything local. You are never locked into our infrastructure.",
		accent: "instant",
		Icon: HardDrive,
	},
	{
		title: "Privacy by default, sharing by choice",
		body: "Share publicly or privately, password protect the sensitive ones, or keep a recording on your machine and never upload it at all.",
		accent: "studio",
		Icon: Lock,
	},
	{
		title: "Async collaboration that works",
		body: "Comments, reactions, and transcripts keep the conversation moving. See who watched and turn a recording into the next step, not another meeting.",
		accent: "screenshot",
		Icon: MessageSquare,
	},
	{
		title: "Cross platform for your whole team",
		body: "Native apps for macOS and Windows that feel at home on each, plus a Chrome extension when recording in the browser is the right call.",
		accent: "share",
		Icon: MonitorSmartphone,
	},
	{
		title: "Quality that makes you look good",
		body: "4K recording, 60fps capture, and compression smart enough to keep the file sizes sane.",
		accent: "studio",
		Icon: Gauge,
	},
	{
		title: "Truly open source",
		body: "See exactly how Cap works, contribute the feature you need, or self host the whole thing. No black boxes.",
		accent: "instant",
		Icon: Github,
	},
	{
		title: "Cap AI does the busywork",
		body: "Titles, summaries, clickable chapters, and transcripts write themselves for every recording, with no usage limits on Pro.",
		accent: "share",
		Icon: Captions,
	},
	{
		title: "Import your Loom videos",
		body: "Switching from Loom? Bring your existing library across with the built in importer and keep everything in one place.",
		accent: "screenshot",
		Icon: ArrowDownToLine,
	},
];

export const Features = () => (
	<section className="px-5 py-20 lg:py-28">
		<div className="mx-auto max-w-[1200px]">
			<div className="mx-auto flex max-w-[760px] flex-col items-center text-center">
				<Eyebrow accent={MODE_THEME.studio.accent}>Why Cap</Eyebrow>
				<h2
					className={`${H_SECTION} mt-6 text-balance text-[clamp(38px,5vw,56px)]`}
				>
					Built for how you actually work
				</h2>
				<p
					className={`${BODY_TEXT} mt-6 max-w-[560px] text-balance text-[16.5px] leading-[1.5] text-[rgba(17,17,17,0.78)] sm:text-[17.5px]`}
				>
					We obsessed over the details so you do not have to. Every feature here
					exists to save you time and make you look good.
				</p>
			</div>

			<ul className="mt-14 grid gap-3 sm:grid-cols-2 lg:grid-cols-4 lg:gap-4">
				{FEATURES.map((feature) => {
					const theme = MODE_THEME[feature.accent];
					return (
						<li
							key={feature.title}
							className="flex flex-col rounded-[14px] p-6"
							style={grainBg(BAND)}
						>
							<span
								className="grid size-9 shrink-0 place-items-center rounded-[9px]"
								style={{ background: theme.chip, color: theme.glyph }}
							>
								<feature.Icon className="size-[18px]" />
							</span>
							<h3 className="mt-5 text-balance text-[19px] font-normal leading-[1.15] tracking-[-0.02em] text-[#111111]">
								{feature.title}
							</h3>
							<p
								className={`${BODY_TEXT} mt-3 text-[15px] leading-[1.5] text-[rgba(17,17,17,0.72)]`}
							>
								{feature.body}
							</p>
						</li>
					);
				})}
			</ul>

			<div className="mt-10 flex justify-center">
				<Link href="/features" className={classNames(BTN_SECONDARY)}>
					View all features
				</Link>
			</div>
		</div>
	</section>
);
