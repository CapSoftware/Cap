import { classNames } from "@cap/utils/helpers";
import { ArrowLeft, Lock } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { CapFridayMark } from "@/components/pages/blackfriday/CapFridayMark";
import { htMono, htSans, htSerif } from "@/components/pages/HomeTwo/fonts";
import { HeroSky } from "@/components/pages/HomeTwo/HeroSky";
import {
	BAND,
	BODY_TEXT,
	CREAM,
	grainBg,
	H_HERO,
	MODE_THEME,
	meshStyle,
	SHELL,
} from "@/components/pages/HomeTwo/theme";

const TRUST = ["SOC 2 Type II", "ISO 27001", "HIPAA", "Open source"];

type BackLink = { href: string; label: string };

const PRICING_BACK: BackLink = { href: "/pricing", label: "Pricing" };

const PURCHASE_COPY = {
	title: "Get Cap Pro",
	subtitle:
		"Unlimited cloud sharing, Cap AI and team workspaces. Cancel anytime, and your recordings stay yours.",
};

export const purchaseCopy = (onboarding: boolean) => ({
	...PURCHASE_COPY,
	back: onboarding ? { href: "/onboarding", label: "Back" } : PRICING_BACK,
});

export const CARD =
	"rounded-[22px] bg-white p-5 shadow-[0_0_0_1px_rgba(17,17,17,0.06),0_24px_48px_-32px_rgba(17,17,17,0.28)] sm:p-8";

export function CheckoutShell({
	title,
	subtitle,
	summary,
	children,
	back = PRICING_BACK,
	capFriday = false,
	summaryTone = "dark",
}: {
	title: string;
	subtitle: string;
	summary: ReactNode;
	children: ReactNode;
	back?: BackLink;
	capFriday?: boolean;
	summaryTone?: "dark" | "light";
}) {
	const fade = "transition-[opacity,color] duration-700 ease-out";
	return (
		<div
			data-header-flat
			data-site-banner-off
			className={`${htSans.className} ${htSans.variable} ${htSerif.variable} ${htMono.variable} text-[#111111]`}
			style={grainBg(SHELL)}
		>
			<div className="px-2.5 pb-2.5 pt-[68px] sm:px-4 sm:pb-4 lg:pt-[76px]">
				<div
					className="relative isolate rounded-[24px] shadow-[0_0_0_1px_rgba(17,17,17,0.045)]"
					style={grainBg(CREAM)}
				>
					<div
						aria-hidden="true"
						className={classNames(
							"pointer-events-none absolute inset-0 overflow-hidden rounded-[24px] bg-[#0A0A0B]",
							fade,
							capFriday ? "opacity-100" : "opacity-0",
						)}
					>
						<div className="absolute inset-x-0 top-0 h-[640px] bg-[radial-gradient(60%_60%_at_50%_0%,rgba(255,111,142,0.26),rgba(255,179,107,0.08)_45%,rgba(10,10,11,0)_75%)]" />
					</div>
					<div
						className="rounded-[24px] rounded-b-[28px]"
						style={grainBg(BAND)}
					>
						<section className="relative px-5 pb-[112px] pt-6 sm:pb-[148px] sm:pt-12 lg:pb-[164px] lg:pt-[52px]">
							<HeroSky
								className={classNames(
									"rounded-[24px] rounded-b-[28px]",
									fade,
									capFriday && "opacity-0",
								)}
							/>
							<div className="relative mx-auto flex max-w-[760px] flex-col items-center text-center">
								<div className="relative mb-4">
									{capFriday ? (
										<CapFridayMark
											animate
											className="pointer-events-none absolute left-1/2 top-1/2 w-[200px] -translate-x-1/2 -translate-y-[58%]"
										/>
									) : null}
									<Link
										href={back.href}
										aria-hidden={capFriday}
										tabIndex={capFriday ? -1 : undefined}
										className={classNames(
											"group inline-flex items-center gap-1.5 rounded-full bg-white/60 py-1.5 pl-2.5 pr-3.5 text-[13px] text-[rgba(17,17,17,0.7)] shadow-[0_0_0_1px_rgba(17,17,17,0.06)] backdrop-blur-sm transition-[color,opacity] duration-200 hover:text-[#111111] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#111111]",
											capFriday && "pointer-events-none opacity-0",
										)}
									>
										<ArrowLeft
											className="size-3.5 transition-transform duration-200 group-hover:-translate-x-0.5"
											strokeWidth={2}
										/>
										{back.label}
									</Link>
								</div>
								<h1
									key={title}
									className={`${H_HERO} text-balance text-[clamp(38px,5.2vw,64px)] ${fade} ${capFriday ? "!text-[#F5F1EA] animate-bf-rise motion-reduce:animate-none" : ""}`}
								>
									{title}
								</h1>
								<p
									key={subtitle}
									className={classNames(
										BODY_TEXT,
										"mt-5 max-w-[560px] max-sm:hidden text-balance text-[16px] leading-[1.5] sm:text-[18px]",
										fade,
										capFriday
											? "text-[rgba(245,241,234,0.7)] animate-bf-rise [animation-delay:0.08s] motion-reduce:animate-none"
											: "text-[rgba(17,17,17,0.78)]",
									)}
								>
									{subtitle}
								</p>
							</div>
						</section>
					</div>

					<section className="relative -mt-[88px] px-3 pb-16 sm:-mt-[116px] sm:px-5 lg:-mt-[128px] lg:pb-24">
						<div className="mx-auto grid max-w-[1040px] items-start gap-3 lg:grid-cols-[minmax(0,1.12fr)_minmax(0,1fr)] lg:gap-4">
							<div className="order-2 lg:order-1">{children}</div>
							<div className="order-1 lg:sticky lg:top-24 lg:order-2">
								<div
									className={classNames(
										"relative isolate rounded-[24px] p-[6px] transition-shadow duration-700",
										capFriday
											? "shadow-[0_28px_70px_-30px_rgba(255,77,141,0.55)]"
											: "shadow-[0_28px_56px_-36px_rgba(61,119,194,0.55)]",
									)}
									style={meshStyle(MODE_THEME.instant)}
								>
									<div
										aria-hidden="true"
										className={classNames(
											"absolute inset-0 -z-10 rounded-[24px] bg-[linear-gradient(140deg,#FFD68C,#FF4D8D_55%,#B0369F)]",
											fade,
											capFriday ? "opacity-100" : "opacity-0",
										)}
									/>
									<div
										className={classNames(
											"rounded-[18px] p-5 transition-colors duration-700 sm:p-8",
											capFriday && summaryTone === "dark"
												? "bg-[#141113] text-[#F5F1EA]"
												: "bg-white",
										)}
									>
										{summary}
									</div>
								</div>
							</div>
						</div>

						<div
							className={classNames(
								"mx-auto mt-8 flex max-w-[1040px] flex-col items-center gap-3 text-center text-[13px] transition-colors duration-700 sm:flex-row sm:justify-center sm:gap-5",
								capFriday
									? "text-[rgba(245,241,234,0.5)]"
									: "text-[rgba(17,17,17,0.55)]",
							)}
						>
							<span className="flex items-center gap-1.5">
								<Lock className="size-3.5" strokeWidth={1.75} />
								Payments are encrypted and processed by Stripe
							</span>
							<ul className="flex flex-wrap items-center justify-center gap-x-1 gap-y-1">
								{TRUST.map((item, index) => (
									<li key={item} className="flex items-center gap-1">
										{index > 0 ? (
											<span
												aria-hidden="true"
												className={classNames(
													"mx-1.5 size-[3px] rounded-full",
													capFriday
														? "bg-[rgba(245,241,234,0.25)]"
														: "bg-[rgba(17,17,17,0.25)]",
												)}
											/>
										) : null}
										{item}
									</li>
								))}
							</ul>
						</div>
					</section>
				</div>
			</div>
		</div>
	);
}

const SKELETON = "animate-pulse rounded-[8px] bg-[#EDF1F6]";

export function SummarySkeleton() {
	return (
		<div aria-hidden className="flex flex-col gap-4">
			<div className={classNames(SKELETON, "h-6 w-24")} />
			<div className={classNames(SKELETON, "h-11 w-40")} />
			<div className={classNames(SKELETON, "mt-3 h-9 w-full rounded-full")} />
			<div className={classNames(SKELETON, "h-8 w-full")} />
			<div className={classNames(SKELETON, "mt-3 h-4 w-full")} />
			<div className={classNames(SKELETON, "h-4 w-2/3")} />
		</div>
	);
}

export function PaymentSkeleton() {
	return (
		<div aria-busy className={classNames(CARD, "flex flex-col gap-4")}>
			<span className="sr-only">Loading checkout</span>
			<div className={classNames(SKELETON, "h-7 w-40")} />
			<div className={classNames(SKELETON, "mt-2 h-12 w-full")} />
			<div className={classNames(SKELETON, "mt-4 h-4 w-20")} />
			<div className={classNames(SKELETON, "h-11 w-full")} />
			<div className={classNames(SKELETON, "mt-4 h-[188px] w-full")} />
			<div className={classNames(SKELETON, "mt-2 h-12 w-full")} />
		</div>
	);
}
