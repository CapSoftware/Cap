import { classNames } from "@cap/utils/helpers";
import type { CSSProperties, ReactNode } from "react";
import { BODY_TEXT, GRAIN, H_SECTION } from "../theme";

// Server-safe building blocks for the landing sections: headings, badges,
// detail lists and the stage panel. No client code, so the copy renders as
// plain HTML and ships no JavaScript.

export type Tone = { accent: string; ink: string; wash: string };

export const TONES = {
	instant: { accent: "#3B82F6", ink: "#1D4ED8", wash: "#EAF2FF" },
	studio: { accent: "#8B5CF6", ink: "#6D28D9", wash: "#F2EDFF" },
	screenshot: { accent: "#10B981", ink: "#047857", wash: "#E8F8F1" },
	ai: { accent: "#F59E0B", ink: "#B45309", wash: "#FFF4E2" },
	storage: { accent: "#0EA5E9", ink: "#0369A1", wash: "#E6F5FD" },
	agents: { accent: "#22C55E", ink: "#15803D", wash: "#EAF9EF" },
	platforms: { accent: "#64748B", ink: "#334155", wash: "#F1F4F8" },
} satisfies Record<string, Tone>;

export const Em = ({ children }: { children: ReactNode }) => (
	<span className="font-normal text-[var(--tone-ink,#111111)]">{children}</span>
);

export const toneVars = (tone?: Tone) =>
	(tone
		? {
				"--tone-ink": tone.ink,
				"--tone-accent": tone.accent,
				"--tone-wash": tone.wash,
			}
		: {}) as CSSProperties;

export const Badge = ({
	icon,
	children,
}: {
	icon: ReactNode;
	children: ReactNode;
}) => (
	<span
		className="inline-flex items-center gap-2 rounded-full bg-white py-1 pl-1 pr-3.5 text-[14px] font-medium tracking-[-0.01em] text-[var(--tone-ink,#111111)]"
		style={{
			boxShadow:
				"0 0 0 1px color-mix(in srgb, var(--tone-accent, #111111) 22%, transparent), 0 8px 20px -12px color-mix(in srgb, var(--tone-accent, #111111) 70%, transparent)",
		}}
	>
		<span
			aria-hidden="true"
			className="grid size-6 place-items-center rounded-full text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.35),inset_0_-1px_0_rgba(0,0,0,0.12)] [&>svg]:size-3"
			style={{
				background:
					"linear-gradient(160deg, var(--tone-accent, #111111) 0%, var(--tone-ink, #111111) 100%)",
			}}
		>
			{icon}
		</span>
		{children}
	</span>
);

export const SectionHead = ({
	title,
	badge,
	children,
	align = "center",
	className,
}: {
	title: ReactNode;
	badge?: ReactNode;
	children?: ReactNode;
	align?: "center" | "left";
	className?: string;
}) => (
	<div
		className={classNames(
			"flex flex-col",
			align === "center"
				? "mx-auto max-w-[760px] items-center text-center"
				: "max-w-[520px] items-start text-left",
			className,
		)}
	>
		{badge ? <div className="mb-6">{badge}</div> : null}
		<h2
			className={`${H_SECTION} text-balance text-[clamp(34px,4.6vw,54px)] leading-[1.02]`}
		>
			{title}
		</h2>
		{children ? (
			<p
				className={classNames(
					BODY_TEXT,
					"mt-5 text-balance text-[17px] leading-[1.5] text-[rgba(17,17,17,0.64)] sm:text-[18px]",
					align === "center" ? "max-w-[600px]" : "max-w-[480px]",
				)}
			>
				{children}
			</p>
		) : null}
	</div>
);

export const Panel = ({
	tone,
	className,
	children,
}: {
	tone?: Tone;
	className?: string;
	children: ReactNode;
}) => (
	<div
		className={classNames(
			"relative overflow-hidden rounded-[28px] bg-white shadow-[0_0_0_1px_rgba(17,17,17,0.06),0_1px_2px_rgba(17,17,17,0.03),0_30px_60px_-40px_rgba(17,24,39,0.25)]",
			className,
		)}
		style={
			tone
				? {
						backgroundColor: "#FFFFFF",
						backgroundImage: `${GRAIN}, linear-gradient(180deg, ${tone.wash} 0%, #FFFFFF 78%)`,
						backgroundSize: "200px 200px, auto",
					}
				: undefined
		}
	>
		{children}
	</div>
);

export type Detail = { lead: string; body: string; icon?: ReactNode };

export const DetailIcon = ({
	children,
	className = "mb-3",
}: {
	children: ReactNode;
	className?: string;
}) => (
	<span
		aria-hidden="true"
		className={`${className} grid size-8 shrink-0 place-items-center rounded-[10px] text-[var(--tone-ink,#111111)] shadow-[inset_0_0_0_1px_rgba(17,17,17,0.05)] [&>svg]:size-4`}
		style={{
			background: "color-mix(in srgb, var(--tone-accent, #111111) 12%, white)",
		}}
	>
		{children}
	</span>
);

export const Details = ({
	items,
	className,
}: {
	items: Detail[];
	className?: string;
}) => (
	<ul
		className={classNames(
			"grid gap-x-10 gap-y-6 border-t border-[#E3E8EE] pt-8 sm:grid-cols-2 lg:grid-cols-3",
			className,
		)}
	>
		{items.map((item) => (
			<li
				key={item.lead}
				className="text-[15px] leading-[1.55] text-[rgba(17,17,17,0.64)]"
			>
				{item.icon ? <DetailIcon>{item.icon}</DetailIcon> : null}
				<h3 className="m-0 inline text-[length:inherit] font-medium leading-[inherit] tracking-normal text-[#111111]">
					{item.lead}
				</h3>{" "}
				{item.body}
			</li>
		))}
	</ul>
);

export const Section = ({
	anchor,
	tone,
	className,
	children,
}: {
	anchor?: string;
	tone?: Tone;
	className?: string;
	children: ReactNode;
}) => (
	<section
		id={anchor}
		className={classNames("scroll-mt-24 px-5 py-20 lg:py-32", className)}
		style={toneVars(tone)}
	>
		<div className="mx-auto max-w-[1120px]">{children}</div>
	</section>
);

export const FADE_CSS = `
	@keyframes ht-fade-in { from { opacity: 0; transform: translateY(3px); } to { opacity: 1; transform: none; } }
	.ht-fade-in { animation: ht-fade-in 400ms cubic-bezier(0.16,1,0.3,1) both; }
	@media (prefers-reduced-motion: reduce) { .ht-fade-in { animation: none; } }
`;

export const POP_CSS = `
	@keyframes ht-pop-in { 0% { opacity: 0; transform: translateY(8px) scale(0.96); } 60% { opacity: 1; transform: translateY(-2px) scale(1.01); } 100% { opacity: 1; transform: none; } }
	.ht-pop-in { animation: ht-pop-in 520ms cubic-bezier(0.16,1,0.3,1) both; }
	@media (prefers-reduced-motion: reduce) { .ht-pop-in { animation: none; } }
`;

/**
 * What each tab of a stage shows, as real text: crawlers and screen readers
 * get every feature, while sighted visitors see the same words as the
 * stage's tabs and caption.
 */
export const StageFeatures = ({
	items,
}: {
	items: { key: string; lead: string; body: string }[];
}) => (
	<ul className="sr-only">
		{items.map((item) => (
			<li key={item.key}>
				<h3>{item.lead}</h3> {item.body}
			</li>
		))}
	</ul>
);
