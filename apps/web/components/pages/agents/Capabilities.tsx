"use client";

import { classNames } from "@cap/utils/helpers";
import { useRef, useState } from "react";
import { Eyebrow } from "@/components/pages/HomeTwo/Eyebrow";
import {
	BODY_TEXT,
	GRAIN,
	H_SECTION,
	MODE_THEME,
	MONO,
} from "@/components/pages/HomeTwo/theme";
import {
	useInView,
	useReducedMotion,
} from "@/components/pages/HomeTwo/visibility";
import { capabilities } from "./content";
import { TaskReel } from "./TaskReel";

const DARK = {
	backgroundColor: "#111111",
	backgroundImage: GRAIN,
	backgroundSize: "200px 200px",
} as const;

export const Capabilities = () => {
	const [active, setActive] = useState(0);
	const gridRef = useRef<HTMLDivElement | null>(null);
	const inView = useInView(gridRef, "-5% 0px -5% 0px");
	const reduced = useReducedMotion();
	const progressRef = useRef<HTMLSpanElement | null>(null);

	return (
		<section className="px-5 py-20 lg:py-28">
			<div className="mx-auto max-w-[1200px]">
				<div className="mx-auto flex max-w-[760px] flex-col items-center text-center">
					<Eyebrow accent={MODE_THEME.studio.accent}>
						No app. No dashboard.
					</Eyebrow>
					<h2
						className={`${H_SECTION} mt-6 text-balance text-[clamp(36px,4.6vw,56px)]`}
					>
						Everything Cap does, from your agent
					</h2>
					<p
						className={`${BODY_TEXT} mt-6 max-w-[640px] text-balance text-[16.5px] leading-[1.5] text-[rgba(17,17,17,0.78)] sm:text-[17.5px]`}
					>
						The CLI and MCP server cover the whole screen recorder and the
						library behind it: recording, sharing, transcripts, comments,
						folders, spaces, members, storage, billing, analytics, and
						migrations. Your agent discovers the exact contract with cap guide
						--json, so it never has to guess a flag.
					</p>
				</div>

				<div
					ref={gridRef}
					className="mt-14 grid gap-4 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] lg:gap-8"
				>
					<div
						className="rounded-[24px] p-4 lg:sticky lg:top-24 lg:self-start lg:p-5"
						style={DARK}
					>
						<TaskReel
							active={active}
							playing={inView}
							reduced={reduced}
							progressRef={progressRef}
							onEnd={() =>
								setActive((current) => (current + 1) % capabilities.length)
							}
						/>
					</div>

					<ol className="flex flex-col lg:pt-2">
						{capabilities.map((capability, i) => {
							const isActive = i === active;
							const theme = MODE_THEME[capability.mode];
							return (
								<li
									key={capability.key}
									className="border-t border-[#E1E7EE] last:border-b"
								>
									<button
										type="button"
										aria-pressed={isActive}
										onClick={() => setActive(i)}
										className="group relative w-full py-5 pl-6 pr-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#111111] focus-visible:ring-offset-4 focus-visible:ring-offset-[#F8FAFC] lg:py-6"
									>
										<span
											aria-hidden="true"
											className="absolute bottom-5 left-0 top-5 w-[2px] rounded-full bg-[#E1E7EE] lg:bottom-6 lg:top-6"
										>
											<span
												ref={isActive ? progressRef : undefined}
												className={classNames(
													"absolute inset-0 origin-top rounded-full transition-opacity duration-300",
													isActive ? "opacity-100" : "opacity-0",
												)}
												style={{
													background: theme.glyph,
													transform: "scaleY(0)",
												}}
											/>
										</span>
										<span className="flex items-baseline justify-between gap-4">
											<span
												className={classNames(
													"text-[19px] font-normal leading-[1.1] tracking-[-0.02em] transition-colors duration-300",
													isActive
														? "text-[#111111]"
														: "text-[rgba(17,17,17,0.55)] group-hover:text-[#111111]",
												)}
											>
												{capability.title}
											</span>
											<code
												className={classNames(
													MONO,
													"hidden shrink-0 text-[11.5px] transition-colors duration-300 sm:block",
													isActive
														? "text-[rgba(17,17,17,0.6)]"
														: "text-[rgba(17,17,17,0.35)]",
												)}
											>
												{capability.command}
											</code>
										</span>
										<span
											className={classNames(
												BODY_TEXT,
												"mt-1.5 block max-w-[520px] text-[14.5px] leading-[1.5] transition-colors duration-300",
												isActive
													? "text-[rgba(17,17,17,0.72)]"
													: "text-[rgba(17,17,17,0.5)]",
											)}
										>
											{capability.body}
										</span>
									</button>
								</li>
							);
						})}
					</ol>
				</div>
			</div>
		</section>
	);
};
