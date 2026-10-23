import { classNames } from "@cap/utils/helpers";
import Link from "next/link";
import type { ComponentType } from "react";
import {
	InstantIcon,
	ScreenshotIcon,
	StudioIcon,
} from "@/components/pages/HomePage/modeIcons";
import { Eyebrow } from "./Eyebrow";
import {
	BAND,
	BODY_TEXT,
	BTN_PRIMARY,
	CARD_BG,
	grainBg,
	H_SECTION,
	MODE_THEME,
	MONO,
	type ModeKey,
	type ModeTheme,
} from "./theme";

type Mode = {
	key: ModeKey;
	name: string;
	promise: string;
	steps: string[];
	bestFor: string;
	Icon: ComponentType<{ className?: string }>;
};

const MODES: Mode[] = [
	{
		key: "instant",
		name: "Instant Mode",
		promise: "From recording to shared in one step",
		steps: [
			"Press record. Cap uploads while you talk, so there is nothing to wait for.",
			"Press stop. The share link is already on your clipboard.",
			"Paste it anywhere. Viewers watch in the browser, no account needed.",
		],
		bestFor: "Bug reports, quick answers, async standups",
		Icon: InstantIcon,
	},
	{
		key: "studio",
		name: "Studio Mode",
		promise: "Full quality, polished before anyone sees it",
		steps: [
			"Record locally in 4K. Screen, camera, and mic each get their own track.",
			"The editor opens when you stop: backgrounds, auto zoom, cursor effects, captions.",
			"Export in 4K, or share it as a Cap link like everything else.",
		],
		bestFor: "Product demos, tutorials, launch videos",
		Icon: StudioIcon,
	},
	{
		key: "screenshot",
		name: "Screenshot Mode",
		promise: "Stills that look designed",
		steps: [
			"Hit the hotkey and grab any window or area.",
			"Beautify with one click: background, padding, shadow.",
			"It's on your clipboard, ready to paste or share as a link.",
		],
		bestFor: "Docs, pull requests, social posts",
		Icon: ScreenshotIcon,
	},
];

const StepRow = ({
	index,
	text,
	theme,
}: {
	index: number;
	text: string;
	theme: ModeTheme;
}) => (
	<li className="flex items-start gap-3">
		<span
			className="mt-px flex size-6 shrink-0 items-center justify-center rounded-full text-[12px] font-medium tabular-nums"
			style={{ background: theme.chip, color: theme.glyph }}
		>
			{index}
		</span>
		<span className="text-[13.5px] leading-snug text-[rgba(17,17,17,0.72)]">
			{text}
		</span>
	</li>
);

export const Workflow = () => (
	// biome-ignore lint/correctness/useUniqueElementIds: anchor target for the demo's "Learn more"
	<section id="workflow" className="scroll-mt-10 px-5 py-20 lg:py-28">
		<div className="mx-auto max-w-[1200px]">
			<div className="mx-auto flex max-w-[760px] flex-col items-center text-center">
				<Eyebrow accent={MODE_THEME.instant.accent}>Cap has 3 modes</Eyebrow>
				<h2
					className={`${H_SECTION} mt-6 text-balance text-[clamp(38px,5vw,56px)]`}
				>
					One app for every workflow
				</h2>
				<p
					className={`${BODY_TEXT} mt-6 max-w-[600px] text-balance text-[16.5px] leading-[1.5] text-[rgba(17,17,17,0.78)] sm:text-[17.5px]`}
				>
					Record and share with Instant, edit your videos with Studio, or
					capture and customize images with Screenshot.
				</p>
				<Link href="/download" className={classNames(BTN_PRIMARY, "mt-8")}>
					Download Cap free
				</Link>
			</div>

			<div className="mt-16 rounded-[20px] p-3 lg:p-4" style={grainBg(BAND)}>
				<div className="grid gap-3 md:grid-cols-3 lg:gap-4">
					{MODES.map((mode) => {
						const theme = MODE_THEME[mode.key];
						return (
							<div
								key={mode.key}
								className="flex flex-col rounded-[14px] p-6 text-left"
								style={grainBg(CARD_BG)}
							>
								<div className="flex items-center gap-2.5">
									<span
										className="grid size-8 shrink-0 place-items-center rounded-[8px]"
										style={{ background: theme.chip, color: theme.glyph }}
									>
										<mode.Icon className="size-4" />
									</span>
									<span className="text-[15px] font-medium text-[#111111]">
										{mode.name}
									</span>
								</div>

								<h3 className="mt-5 max-w-[300px] text-balance text-[22px] font-normal leading-[1.1] tracking-[-0.02em] text-[#111111]">
									{mode.promise}
								</h3>

								<div className="flex flex-1 flex-col justify-between">
									<div>
										<ol className="mt-5 space-y-3">
											{mode.steps.map((text, i) => (
												<StepRow
													key={text}
													index={i + 1}
													text={text}
													theme={theme}
												/>
											))}
										</ol>

										<div className="mt-6 border-t border-[#E1E7EE] pt-4">
											<p
												className={`${MONO} text-[11px] font-normal uppercase leading-none tracking-[0.05em] text-[rgba(17,17,17,0.45)]`}
											>
												Best for
											</p>
											<p className="mt-2 text-[13.5px] leading-snug text-[rgba(17,17,17,0.72)]">
												{mode.bestFor}
											</p>
										</div>
									</div>
								</div>
							</div>
						);
					})}
				</div>
			</div>
		</div>
	</section>
);
