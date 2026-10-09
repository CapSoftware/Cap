"use client";

import { ArrowDown, ArrowRight } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { trackEvent } from "@/app/utils/analytics";
import { Faq } from "@/components/pages/HomeTwo/Faq";
import { htMono, htSans, htSerif } from "@/components/pages/HomeTwo/fonts";
import { HeroSky } from "@/components/pages/HomeTwo/HeroSky";
import { Testimonials } from "@/components/pages/HomeTwo/Testimonials";
import {
	BAND,
	BODY_TEXT,
	BTN_PRIMARY,
	BTN_SECONDARY,
	CREAM,
	grainBg,
	H_HERO,
	H_SECTION,
	MONO,
	SHELL,
} from "@/components/pages/HomeTwo/theme";
import { homepageCopy } from "@/data/homepage-copy";
import { ComparePlans } from "./ComparePlans";
import { DesktopLicenseCard } from "./DesktopLicenseCard";
import { EnterpriseCard } from "./EnterpriseCard";
import { ProCard } from "./ProCard";

const PRICING_FAQ = [
	"What is the difference between Cap Pro and Desktop License?",
	"Is there a free version?",
	"What happens to my recordings if I cancel?",
	"Can I use Cap for commercial purposes?",
	"Do you offer team plans?",
	"What about SOC 2, ISO 27001, GDPR, and HIPAA compliance?",
	"How does Cap AI work?",
];

const faqItems = PRICING_FAQ.map((question) =>
	homepageCopy.faq.items.find((item) => item.question === question),
).filter((item): item is (typeof homepageCopy.faq.items)[number] =>
	Boolean(item),
);

const TRUST = ["SOC 2 Type II", "ISO 27001", "HIPAA", "Open source"];

const scrollTo = (id: string) => {
	document.getElementById(id)?.scrollIntoView({ behavior: "smooth" });
};

const Hero = () => (
	<section className="relative px-5 pb-[168px] pt-12 sm:pt-14 lg:pb-[188px] lg:pt-[56px]">
		<HeroSky className="rounded-[24px] rounded-b-[28px]" />
		<div className="relative mx-auto flex max-w-[860px] flex-col items-center text-center">
			<h1 className={`${H_HERO} text-balance text-[clamp(42px,6.2vw,80px)]`}>
				Simple, honest pricing
			</h1>
			<p
				className={`${BODY_TEXT} mt-7 max-w-[600px] text-balance text-[16.5px] leading-[1.5] text-[rgba(17,17,17,0.78)] sm:text-[19px]`}
			>
				Start free. Pay when you need commercial rights or the cloud, and cancel
				whenever you like.
			</p>
			<button
				type="button"
				onClick={() => scrollTo("testimonials")}
				className="group mt-8 inline-flex max-w-full items-center gap-2.5 rounded-full bg-[#111111] py-1.5 pl-1.5 pr-3.5 text-[13px] leading-none text-white shadow-[0_1px_2px_rgba(17,17,17,0.12),0_10px_24px_-14px_rgba(17,17,17,0.6)] transition-colors duration-200 hover:bg-[#2A2A2A] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#111111] focus-visible:ring-offset-2 focus-visible:ring-offset-[#EDF1F6]"
			>
				<span
					className={`${MONO} hidden rounded-full bg-[#8DBCF0] px-2 py-[5px] text-[10.5px] uppercase leading-none tracking-[0.06em] text-[#111111] sm:inline-block`}
				>
					50,000+
				</span>
				<span className="truncate pl-2 sm:hidden">
					Trusted by 50,000+ users
				</span>
				<span className="hidden truncate sm:inline">
					Trusted by teams and creators
				</span>
				<ArrowDown className="hidden size-3.5 text-white/70 transition-transform duration-200 group-hover:translate-y-0.5 group-hover:text-white sm:block" />
			</button>
			<ul className="mt-6 flex flex-wrap items-center justify-center gap-x-1 gap-y-2">
				{TRUST.map((item, i) => (
					<li key={item} className="flex items-center gap-1">
						{i > 0 ? (
							<span
								aria-hidden="true"
								className="mx-2 size-[3px] rounded-full bg-[rgba(17,17,17,0.25)]"
							/>
						) : null}
						<span
							className={`${MONO} text-[11.5px] uppercase leading-none tracking-[0.05em] text-[rgba(17,17,17,0.55)]`}
						>
							{item}
						</span>
					</li>
				))}
			</ul>
			<span
				data-header-sentinel
				aria-hidden="true"
				className="pointer-events-none absolute bottom-0 left-0 size-px"
			/>
		</div>
	</section>
);

type PlanKey = "desktop" | "pro" | "enterprise";

const Plans = () => {
	const [open, setOpen] = useState<PlanKey>("pro");
	const toggle = (key: PlanKey) => ({
		collapsed: open !== key,
		onToggle: () => setOpen(key),
	});
	return (
		// biome-ignore lint/correctness/useUniqueElementIds: stable anchor target for the closing "Get Cap Pro" button
		<section id="plans" className="relative -mt-[136px] px-5 lg:-mt-[152px]">
			<div className="mx-auto max-w-[1120px]">
				<div className="grid items-stretch gap-3 lg:grid-cols-3 lg:gap-4">
					<DesktopLicenseCard {...toggle("desktop")} />
					<ProCard {...toggle("pro")} />
					<EnterpriseCard {...toggle("enterprise")} />
				</div>

				<div className="mt-8 flex flex-col items-center justify-center gap-x-6 gap-y-2 text-center sm:flex-row">
					<p
						className={`${BODY_TEXT} text-[15.5px] text-[rgba(17,17,17,0.65)]`}
					>
						Just want to try it? Cap is free for personal use, with no time
						limit on local recordings.
					</p>
					<Link
						href="/download"
						onClick={() =>
							trackEvent("download_cta_clicked", {
								source_page: "pricing",
								cta_location: "under_plans",
								target_url: "/download",
							})
						}
						className="group inline-flex shrink-0 items-center gap-1.5 text-[14.5px] font-medium text-[#111111] underline decoration-[rgba(17,17,17,0.25)] underline-offset-[4px] transition-colors duration-200 hover:decoration-[#111111] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#111111] focus-visible:ring-offset-4 focus-visible:ring-offset-[#F8FAFC]"
					>
						Download free
						<ArrowRight className="size-3.5 transition-transform duration-200 group-hover:translate-x-0.5" />
					</Link>
				</div>
			</div>
		</section>
	);
};

const Closing = () => (
	<section className="px-5 pb-24 pt-4 lg:pb-28 lg:pt-8">
		<div className="mx-auto flex max-w-[760px] flex-col items-center text-center">
			<h2 className={`${H_SECTION} text-balance text-[clamp(36px,4.6vw,56px)]`}>
				Start free. Upgrade when it earns it.
			</h2>
			<p
				className={`${BODY_TEXT} mt-6 max-w-[520px] text-balance text-[16.5px] leading-[1.5] text-[rgba(17,17,17,0.78)] sm:text-[18px]`}
			>
				Record locally today. Move to Cap Pro the moment you need unlimited
				sharing, AI, or a team workspace.
			</p>
			<div className="mt-9 flex flex-col items-stretch gap-3 sm:flex-row sm:items-center">
				<button
					type="button"
					onClick={() => scrollTo("plans")}
					className={`${BTN_PRIMARY} cursor-pointer`}
				>
					Get Cap Pro
				</button>
				<Link href="/download" className={BTN_SECONDARY}>
					Download for free
				</Link>
			</div>
			<p className="mt-6 text-[14px] text-[rgba(17,17,17,0.5)]">
				Students save 30%.{" "}
				<Link
					href="/student-discount"
					className="text-[#111111] underline decoration-[rgba(17,17,17,0.25)] underline-offset-[4px] transition-colors duration-200 hover:decoration-[#111111]"
				>
					Claim the discount
				</Link>
			</p>
		</div>
	</section>
);

export const PricingPage = () => (
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
				<div className="rounded-[24px] rounded-b-[28px]" style={grainBg(BAND)}>
					<Hero />
				</div>
				<Plans />
				<ComparePlans />
				<Faq
					items={faqItems}
					title="Pricing questions, answered."
					eyebrow={false}
				/>
				{/* biome-ignore lint/correctness/useUniqueElementIds: stable anchor target for the hero trust pill */}
				<div id="testimonials" className="scroll-mt-24">
					<Testimonials eyebrow={false} />
				</div>
				<Closing />
			</div>
		</div>
	</div>
);
