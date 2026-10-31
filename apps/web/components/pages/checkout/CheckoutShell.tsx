import { classNames } from "@cap/utils/helpers";
import { ArrowLeft, Lock } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
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
}: {
	title: string;
	subtitle: string;
	summary: ReactNode;
	children: ReactNode;
	back?: BackLink;
}) {
	return (
		<div
			data-header-flat
			className={`${htSans.className} ${htSans.variable} ${htSerif.variable} ${htMono.variable} text-[#111111]`}
			style={grainBg(SHELL)}
		>
			<div className="px-2.5 pb-2.5 pt-[68px] sm:px-4 sm:pb-4 lg:pt-[76px]">
				<div
					className="rounded-[24px] shadow-[0_0_0_1px_rgba(17,17,17,0.045)]"
					style={grainBg(CREAM)}
				>
					<div
						className="rounded-[24px] rounded-b-[28px]"
						style={grainBg(BAND)}
					>
						<section className="relative px-5 pb-[112px] pt-6 sm:pb-[148px] sm:pt-12 lg:pb-[164px] lg:pt-[52px]">
							<HeroSky className="rounded-[24px] rounded-b-[28px]" />
							<div className="relative mx-auto flex max-w-[760px] flex-col items-center text-center">
								<Link
									href={back.href}
									className="group mb-4 inline-flex items-center gap-1.5 rounded-full bg-white/60 py-1.5 pl-2.5 pr-3.5 text-[13px] text-[rgba(17,17,17,0.7)] shadow-[0_0_0_1px_rgba(17,17,17,0.06)] backdrop-blur-sm transition-colors duration-200 hover:text-[#111111] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#111111]"
								>
									<ArrowLeft
										className="size-3.5 transition-transform duration-200 group-hover:-translate-x-0.5"
										strokeWidth={2}
									/>
									{back.label}
								</Link>
								<h1
									className={`${H_HERO} text-balance text-[clamp(38px,5.2vw,64px)]`}
								>
									{title}
								</h1>
								<p
									className={`${BODY_TEXT} mt-5 max-w-[560px] max-sm:hidden text-balance text-[16px] leading-[1.5] text-[rgba(17,17,17,0.78)] sm:text-[18px]`}
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
									className="rounded-[24px] p-[6px] shadow-[0_28px_56px_-36px_rgba(61,119,194,0.55)]"
									style={meshStyle(MODE_THEME.instant)}
								>
									<div className="rounded-[18px] bg-white p-5 sm:p-8">
										{summary}
									</div>
								</div>
							</div>
						</div>

						<div className="mx-auto mt-8 flex max-w-[1040px] flex-col items-center gap-3 text-center text-[13px] text-[rgba(17,17,17,0.55)] sm:flex-row sm:justify-center sm:gap-5">
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
												className="mx-1.5 size-[3px] rounded-full bg-[rgba(17,17,17,0.25)]"
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
