import { classNames } from "@cap/utils/helpers";
import Link from "next/link";
import { Eyebrow } from "@/components/pages/HomeTwo/Eyebrow";
import {
	BODY_TEXT,
	H_SECTION,
	MODE_THEME,
	MONO,
	meshStyle,
} from "@/components/pages/HomeTwo/theme";
import { headlessNote, safetyPrinciples } from "./content";
import { Tokens } from "./tokens";

export const Safety = () => (
	<section className="px-5 py-20 lg:py-28">
		<div className="mx-auto grid max-w-[1100px] gap-12 lg:grid-cols-[minmax(0,340px)_minmax(0,1fr)] lg:gap-20">
			<div className="lg:sticky lg:top-28 lg:self-start">
				<Eyebrow accent={MODE_THEME.screenshot.accent}>Safe by design</Eyebrow>
				<h2
					className={`${H_SECTION} mt-6 text-balance text-[clamp(34px,3.9vw,48px)]`}
				>
					Safe to hand to an agent
				</h2>
				<p
					className={`${BODY_TEXT} mt-5 max-w-[320px] text-[16px] leading-[1.5] text-[rgba(17,17,17,0.72)]`}
				>
					The boundaries are part of the product, not a prompt you have to
					remember. Read the full rules in{" "}
					<Link
						href="/docs/agents/safety"
						className="underline decoration-[rgba(17,17,17,0.3)] underline-offset-[5px] transition-colors duration-200 hover:decoration-[#111111]"
					>
						Safety &amp; Troubleshooting
					</Link>
					.
				</p>
			</div>

			<div>
				<ul>
					{safetyPrinciples.map((principle) => {
						const theme = MODE_THEME[principle.mode];
						return (
							<li
								key={principle.title}
								className="grid gap-4 border-t border-[#E1E7EE] py-7 last:border-b sm:grid-cols-[minmax(0,1fr)_220px] sm:gap-8"
							>
								<div className="flex gap-4">
									<span
										aria-hidden="true"
										className="mt-[7px] block size-[7px] shrink-0"
										style={{ background: theme.accent }}
									/>
									<div>
										<h3 className="text-[19px] font-normal leading-[1.1] tracking-[-0.02em] text-[#111111]">
											{principle.title}
										</h3>
										<p
											className={`${BODY_TEXT} mt-2.5 max-w-[520px] text-[15px] leading-[1.55] text-[rgba(17,17,17,0.72)]`}
										>
											{principle.body}
										</p>
									</div>
								</div>
								<code
									className={classNames(
										MONO,
										"self-start whitespace-pre-wrap break-words rounded-[10px] bg-white px-3 py-2 text-[12px] leading-[1.6] text-[#111111] shadow-[0_0_0_1px_rgba(17,17,17,0.06)] sm:justify-self-end",
									)}
								>
									<span className="text-[rgba(17,17,17,0.4)]">$ </span>
									<Tokens text={principle.command} />
								</code>
							</li>
						);
					})}
				</ul>

				<div
					className="mt-6 grid gap-5 rounded-[20px] p-6 sm:grid-cols-[minmax(0,1fr)_minmax(0,300px)] sm:items-center lg:p-7"
					style={meshStyle(MODE_THEME.screenshot)}
				>
					<div>
						<h3 className="text-[21px] font-normal leading-[1.1] tracking-[-0.02em] text-[#111111]">
							{headlessNote.title}
						</h3>
						<p
							className={`${BODY_TEXT} mt-2.5 text-[14.5px] leading-[1.5] text-[rgba(17,17,17,0.75)]`}
						>
							{headlessNote.body}
						</p>
					</div>
					<pre
						className={classNames(
							MONO,
							"m-0 overflow-x-auto rounded-[12px] bg-[#111111] px-4 py-3.5 text-[12.5px] leading-[1.7] text-[#F8FAFC] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)]",
						)}
					>
						{headlessNote.lines.map((line) => (
							<span
								key={line}
								className="block whitespace-pre-wrap break-words"
							>
								<span className="select-none text-[rgba(255,255,255,0.38)]">
									${" "}
								</span>
								<Tokens text={line} />
							</span>
						))}
					</pre>
				</div>
			</div>
		</div>
	</section>
);
