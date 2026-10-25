import { classNames } from "@cap/utils/helpers";
import type { ReactNode } from "react";
import { BODY_TEXT, H_SECTION } from "../theme";
import { type Detail, DetailIcon, type Tone, toneVars } from "./layout";

export const SplitSection = ({
	anchor,
	title,
	lede,
	details,
	visual,
	flip,
	footer,
	tone,
	badge,
}: {
	tone?: Tone;
	badge?: ReactNode;
	anchor?: string;
	title: ReactNode;
	lede: ReactNode;
	details: Detail[];
	visual: ReactNode;
	flip?: boolean;
	footer?: ReactNode;
}) => (
	<section
		id={anchor}
		className="scroll-mt-24 px-5 py-20 lg:py-32"
		style={toneVars(tone)}
	>
		<div
			className={classNames(
				"mx-auto grid max-w-[1120px] items-center gap-12 lg:gap-16",
				flip
					? "lg:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)]"
					: "lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)]",
			)}
		>
			<div className={classNames("min-w-0", flip && "lg:order-2")}>
				{badge ? <div className="mb-6">{badge}</div> : null}
				<h2
					className={`${H_SECTION} text-balance text-[clamp(34px,4vw,48px)] leading-[1.02]`}
				>
					{title}
				</h2>
				<p
					className={`${BODY_TEXT} mt-5 max-w-[460px] text-[17px] leading-[1.5] text-[rgba(17,17,17,0.64)] sm:text-[18px]`}
				>
					{lede}
				</p>
				<ul className="mt-9 max-w-[460px] border-t border-[#E3E8EE]">
					{details.map((item) => (
						<li
							key={item.lead}
							className="flex gap-3.5 border-b border-[#E3E8EE] py-4 text-[15px] leading-[1.55] text-[rgba(17,17,17,0.64)]"
						>
							{item.icon ? (
								<DetailIcon className="-mt-0.5">{item.icon}</DetailIcon>
							) : null}
							<div>
								<h3 className="m-0 inline text-[length:inherit] font-medium leading-[inherit] tracking-normal text-[#111111]">
									{item.lead}
								</h3>{" "}
								{item.body}
							</div>
						</li>
					))}
				</ul>
				{footer}
			</div>
			<div className={classNames("min-w-0", flip && "lg:order-1")}>
				{visual}
			</div>
		</div>
	</section>
);
