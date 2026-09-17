import { classNames } from "@cap/utils/helpers";
import { Check, ChevronDown } from "lucide-react";
import type { ReactNode } from "react";
import {
	BODY_TEXT,
	type ModeTheme,
	meshStyle,
} from "@/components/pages/HomeTwo/theme";

export type PlanToggle = {
	collapsed: boolean;
	onToggle: () => void;
};

export const PlanCard = ({
	name,
	tag,
	theme,
	featured,
	blurb,
	price,
	cadence,
	note,
	lede,
	controls,
	cta,
	ctaNote,
	featuresTitle,
	features,
	footer,
	summary,
	collapsed = false,
	onToggle,
}: {
	name: string;
	tag: string;
	theme: ModeTheme;
	featured?: boolean;
	blurb: string;
	price?: ReactNode;
	cadence?: string;
	note?: ReactNode;
	lede?: ReactNode;
	controls: ReactNode;
	cta: ReactNode;
	ctaNote: string;
	featuresTitle: string;
	features: readonly string[];
	footer?: ReactNode;
	summary: string;
	collapsed?: boolean;
	onToggle?: () => void;
}) => {
	const card = (
		<article
			className={classNames(
				"relative flex h-full flex-col bg-white p-6 lg:p-8",
				featured
					? "rounded-[18px]"
					: "rounded-[22px] shadow-[0_0_0_1px_rgba(17,17,17,0.06),0_24px_48px_-32px_rgba(17,17,17,0.28)]",
			)}
		>
			{onToggle ? (
				<button
					type="button"
					onClick={onToggle}
					aria-expanded={!collapsed}
					aria-label={`${name} plan details`}
					className={classNames(
						"absolute inset-x-0 top-0 z-10 rounded-[inherit] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#111111] lg:hidden",
						collapsed ? "bottom-0" : "h-20",
					)}
				/>
			) : null}
			<div className="flex items-start justify-between gap-3">
				<h2 className="text-[22px] font-normal leading-[1.1] tracking-[-0.02em] text-[#111111]">
					{name}
				</h2>
				<span className="flex shrink-0 items-center gap-2">
					<span
						className="hidden rounded-full px-2.5 py-[6px] text-[12px] font-medium leading-none tracking-[-0.01em] lg:inline-block"
						style={{ background: theme.chip, color: theme.glyph }}
					>
						{tag}
					</span>
					{onToggle ? (
						<span
							aria-hidden="true"
							className="grid size-7 place-items-center rounded-full bg-[#EDF1F6] text-[#111111] lg:hidden"
						>
							<ChevronDown
								className={classNames(
									"size-3.5 transition-transform duration-200",
									collapsed ? "" : "rotate-180",
								)}
							/>
						</span>
					) : null}
				</span>
			</div>

			<div className="mt-2.5 flex flex-wrap items-center gap-x-2.5 gap-y-1.5 lg:hidden">
				<span
					className="rounded-full px-2.5 py-[6px] text-[12px] font-medium leading-none tracking-[-0.01em]"
					style={{ background: theme.chip, color: theme.glyph }}
				>
					{tag}
				</span>
				{collapsed ? (
					<span className="text-[14px] text-[rgba(17,17,17,0.6)]">
						{summary}
					</span>
				) : null}
			</div>

			<div
				className={classNames(
					"flex-col lg:flex lg:flex-1",
					collapsed ? "hidden" : "flex flex-1",
				)}
			>
				<p
					className={`${BODY_TEXT} mt-3 min-h-[46px] text-[15px] leading-[1.5] text-[rgba(17,17,17,0.72)]`}
				>
					{blurb}
				</p>

				{price ? (
					<>
						<div className="mt-7 flex flex-wrap items-baseline gap-x-2 gap-y-1.5">
							<span className="whitespace-nowrap text-[46px] font-normal leading-none tracking-[-0.03em] tabular-nums text-[#111111]">
								{price}
							</span>
							<span className="text-[14px] text-[rgba(17,17,17,0.5)]">
								{cadence}
							</span>
						</div>
						<p className="mt-2 min-h-[20px] text-[13.5px] text-[rgba(17,17,17,0.5)]">
							{note}
						</p>
					</>
				) : (
					<div className="mt-7 border-t border-[#E1E7EE] pt-6">{lede}</div>
				)}

				<div className="mt-6 min-h-[132px] space-y-3">{controls}</div>

				<div className="mt-6">{cta}</div>
				<p className="mt-3 text-center text-[13px] text-[rgba(17,17,17,0.5)]">
					{ctaNote}
				</p>

				<div className="mt-8 border-t border-[#E1E7EE] pt-7">
					<p className="text-[13px] font-medium text-[#111111]">
						{featuresTitle}
					</p>
					<ul className="mt-4 space-y-3">
						{features.map((feature) => (
							<li key={feature} className="flex items-start gap-3">
								<span
									className="mt-px grid size-5 shrink-0 place-items-center rounded-full"
									style={{ background: theme.chip, color: theme.glyph }}
								>
									<Check className="size-3" strokeWidth={2.5} />
								</span>
								<span className="text-[14px] leading-snug text-[rgba(17,17,17,0.72)]">
									{feature}
								</span>
							</li>
						))}
					</ul>
					{footer ? <div className="mt-6">{footer}</div> : null}
				</div>
			</div>
		</article>
	);

	if (!featured) return card;

	return (
		<div
			className="flex rounded-[24px] p-[6px] shadow-[0_28px_56px_-36px_rgba(61,119,194,0.55)]"
			style={meshStyle(theme)}
		>
			<div className="flex-1">{card}</div>
		</div>
	);
};

export const PLAN_LINK =
	"inline-flex items-center gap-1.5 text-[14px] text-[rgba(17,17,17,0.6)] underline decoration-[rgba(17,17,17,0.25)] underline-offset-[4px] transition-colors duration-200 hover:text-[#111111] hover:decoration-[#111111] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#111111] focus-visible:ring-offset-4 focus-visible:ring-offset-white";
