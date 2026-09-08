"use client";

import { classNames } from "@cap/utils/helpers";
import { ArrowUpRight } from "lucide-react";
import Link from "next/link";
import type { ComponentType } from "react";
import { useCallback, useId, useRef, useState } from "react";
import { Eyebrow } from "./Eyebrow";
import { Fit, SCENES, STAGE } from "./scenes";
import { LazyMount, useInView, useReducedMotion } from "./scenes/engine";
import {
	BODY_TEXT,
	H_SECTION,
	MODE_THEME,
	type ModeKey,
	meshStyle,
} from "./theme";

export type DiveItem = {
	title: string;
	body: string;
};

export type DiveChip = {
	title: string;
	description: string;
	Icon: ComponentType<{ className?: string }>;
};

export type DiveConfig = {
	mode: ModeKey;
	eyebrow: string;
	heading: string;
	intro?: string;
	items: DiveItem[];
	chips?: DiveChip[];
	href: string;
	flip?: boolean;
};

export const DeepDive = ({ config }: { config: DiveConfig }) => {
	const [active, setActive] = useState(0);
	const baseId = useId();
	const theme = MODE_THEME[config.mode];
	const scene = SCENES[config.mode];
	const visualRef = useRef<HTMLDivElement | null>(null);
	const progressRef = useRef<HTMLSpanElement | null>(null);
	const inView = useInView(visualRef);
	const reducedMotion = useReducedMotion();
	const playing = inView && !reducedMotion;
	const count = config.items.length;

	const advance = useCallback(() => {
		setActive((current) => (current + 1) % count);
	}, [count]);

	return (
		<section className="px-5 py-16 lg:py-24">
			<div className="mx-auto grid max-w-[1200px] items-start gap-12 lg:grid-cols-2 lg:gap-16">
				<div
					className={classNames(
						"order-first",
						config.flip ? "lg:order-first" : "lg:order-last",
					)}
				>
					<div ref={visualRef} className="lg:sticky lg:top-24">
						<div
							className="rounded-[24px] p-3 shadow-[0_30px_60px_-40px_rgba(17,17,17,0.35)]"
							style={meshStyle(theme)}
						>
							<LazyMount w={STAGE.w} h={STAGE.h} className="mx-auto">
								<Fit w={STAGE.w} h={STAGE.h}>
									<scene.Scene
										chapter={active}
										playing={playing}
										onChapterEnd={advance}
										progressRef={progressRef}
									/>
								</Fit>
							</LazyMount>
						</div>
					</div>
				</div>

				<div className={config.flip ? "lg:order-last" : "lg:order-first"}>
					<Eyebrow accent={theme.accent}>{config.eyebrow}</Eyebrow>

					<h2
						className={`${H_SECTION} mt-6 max-w-[480px] text-balance text-[clamp(34px,3.9vw,50px)]`}
					>
						{config.heading}
					</h2>

					{config.intro ? (
						<p
							className={`${BODY_TEXT} mt-6 max-w-[460px] text-[16.5px] leading-[1.5] text-[rgba(17,17,17,0.78)]`}
						>
							{config.intro}
						</p>
					) : null}

					<div className="mt-10">
						{config.items.map((item, i) => {
							const open = i === active;
							const panelId = `${baseId}-panel-${i}`;
							const headerId = `${baseId}-header-${i}`;
							return (
								<div
									key={item.title}
									className="relative border-t border-[#E1E7EE] last:border-b"
								>
									<span
										aria-hidden="true"
										className="absolute inset-x-0 top-[-1px] h-[2px] overflow-hidden"
										style={{ opacity: open ? 1 : 0 }}
									>
										<span
											ref={open ? progressRef : undefined}
											className="block h-full w-full origin-left"
											style={{
												background: theme.accent,
												transform: `scaleX(${open && !playing ? 1 : 0})`,
											}}
										/>
									</span>
									<h3>
										<button
											type="button"
											id={headerId}
											aria-expanded={open}
											aria-controls={panelId}
											onClick={() => setActive(i)}
											className={classNames(
												"flex w-full items-center justify-between gap-6 py-[24px] text-left text-[19px] font-normal tracking-[-0.02em] transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#111111] focus-visible:ring-offset-4 focus-visible:ring-offset-[#F8FAFC] lg:text-[21px]",
												open
													? "text-[#111111]"
													: "text-[rgba(17,17,17,0.4)] hover:text-[rgba(17,17,17,0.7)]",
											)}
										>
											{item.title}
										</button>
									</h3>
									<div
										id={panelId}
										aria-hidden={!open}
										className="grid transition-[grid-template-rows] duration-300 ease-out"
										style={{ gridTemplateRows: open ? "1fr" : "0fr" }}
									>
										<div className="overflow-hidden">
											<div className="flex items-start justify-between gap-6 pb-8">
												<p
													className={`${BODY_TEXT} max-w-[420px] text-[16px] leading-[1.5] text-[rgba(17,17,17,0.78)]`}
												>
													{item.body}
												</p>
												<Link
													href={config.href}
													tabIndex={open ? undefined : -1}
													aria-label={`Learn more about ${item.title}`}
													className="grid size-10 shrink-0 place-items-center rounded-[8px] bg-[#E7EDF3] text-[#111111] transition-colors duration-200 hover:bg-[#DCE4EC] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#111111]"
												>
													<ArrowUpRight className="size-4" />
												</Link>
											</div>
										</div>
									</div>
								</div>
							);
						})}
					</div>

					{config.chips ? (
						<ul className="mt-10 grid gap-x-8 gap-y-6 sm:grid-cols-2">
							{config.chips.map((chip) => (
								<li key={chip.title} className="flex items-start gap-3">
									<span
										className="grid size-8 shrink-0 place-items-center rounded-[8px]"
										style={{ background: theme.chip, color: theme.glyph }}
									>
										<chip.Icon className="size-4" />
									</span>
									<span className="min-w-0">
										<span className="block text-[15px] font-medium text-[#111111]">
											{chip.title}
										</span>
										<span className="mt-0.5 block text-[13.5px] leading-snug text-[rgba(17,17,17,0.55)]">
											{chip.description}
										</span>
									</span>
								</li>
							))}
						</ul>
					) : null}
				</div>
			</div>
		</section>
	);
};
