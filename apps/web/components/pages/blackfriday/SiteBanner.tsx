"use client";

import Link from "next/link";
import { trackEvent } from "@/app/utils/analytics";
import { CapFridayMark } from "./CapFridayMark";
import { useEnded } from "./Claim";
import { Countdown } from "./Countdown";
import { CODE } from "./content";

export const PRICING_OFFER_ANCHOR = "pro";

const HREF = `/pricing?promo=${CODE}#${PRICING_OFFER_ANCHOR}`;

// The site header is taken out of the flow and pinned to the top of the page.
// With the banner in front of it, a flat header starts under the banner and
// scrolls away with it, and a fixed header sticks once the banner has gone.
const HEADER_CSS = `
[data-site-banner] ~ header[data-island="false"]:has(~ [data-header-flat]) { top: auto; }
[data-site-banner] ~ header[data-island="false"]:not(:has(~ [data-header-flat])) { position: sticky; height: 0; }
`;

export function SiteBanner() {
	const ended = useEnded();
	if (ended) return null;

	return (
		<>
			<style>{HEADER_CSS}</style>
			<Link
				href={HREF}
				data-site-banner
				onClick={() =>
					trackEvent("black_friday_cta_clicked", {
						cta_location: "site_banner",
						target_billing_period: "annual",
					})
				}
				className="group/banner relative isolate flex h-11 items-center justify-center gap-2.5 overflow-hidden bg-[#0A0A0B] px-4 text-[#F5F1EA] [-webkit-tap-highlight-color:transparent] focus-visible:outline-none has-[~[data-site-banner-off]]:hidden sm:gap-3.5"
			>
				<span
					aria-hidden="true"
					className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(42%_180%_at_50%_-40%,rgba(255,111,142,0.34),rgba(255,179,107,0.12)_48%,rgba(10,10,11,0)_78%)] opacity-80 transition-opacity duration-500 group-hover/banner:opacity-100 motion-reduce:transition-none"
				/>
				<span
					aria-hidden="true"
					className="pointer-events-none absolute inset-y-0 left-0 -z-10 w-[22%] -translate-x-[120%] skew-x-[-20deg] bg-[linear-gradient(90deg,rgba(255,255,255,0),rgba(255,214,190,0.16),rgba(255,255,255,0))] transition-transform duration-1000 ease-out group-hover/banner:translate-x-[580%] motion-reduce:hidden"
				/>
				<span
					aria-hidden="true"
					className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-[linear-gradient(90deg,rgba(255,214,140,0),#FFD68C_22%,#FF8078_42%,#FF4D8D_60%,#B0369F_80%,rgba(176,54,159,0))] opacity-70"
				/>
				<span
					aria-hidden="true"
					className="pointer-events-none absolute inset-0 rounded-[2px] opacity-0 shadow-[inset_0_0_0_2px_#F5F1EA] group-focus-visible/banner:opacity-100"
				/>
				<CapFridayMark className="w-[72px] shrink-0 sm:w-[84px]" />
				<span className="truncate text-[13.5px] font-medium leading-none tracking-[-0.01em] sm:text-[14.5px]">
					50% off Cap Pro Yearly
				</span>
				<span className="hidden items-center gap-3.5 text-[13.5px] leading-none text-[rgba(245,241,234,0.62)] md:flex">
					<span
						aria-hidden="true"
						className="size-[3px] rounded-full bg-[rgba(245,241,234,0.32)]"
					/>
					<Countdown />
				</span>
				<span className="flex shrink-0 items-center gap-1.5 rounded-full bg-[linear-gradient(180deg,#FFFFFF_0%,#F3EEE6_100%)] p-1 text-[13px] font-medium leading-none tracking-[-0.01em] text-[#141012] shadow-[inset_0_1px_0_rgba(255,255,255,0.95),0_1px_2px_rgba(0,0,0,0.5),0_8px_22px_-10px_rgba(255,170,140,0.7)] transition-[transform,box-shadow] duration-300 [transition-timing-function:cubic-bezier(0.2,0.8,0.2,1)] group-hover/banner:scale-[1.04] group-hover/banner:shadow-[inset_0_1px_0_rgba(255,255,255,0.95),0_1px_2px_rgba(0,0,0,0.5),0_10px_26px_-8px_rgba(255,160,130,0.95)] motion-reduce:transition-none motion-reduce:group-hover/banner:transform-none sm:pl-3">
					<span className="hidden sm:inline">Claim</span>
					<span className="grid size-5 place-items-center rounded-full bg-[#141012] text-[#F5F1EA]">
						<svg
							viewBox="0 0 16 16"
							aria-hidden="true"
							className="size-2.5 transition-transform duration-300 group-hover/banner:translate-x-px motion-reduce:transition-none"
						>
							<path
								d="M3 8h9.5M8.5 4l4 4-4 4"
								fill="none"
								stroke="currentColor"
								strokeWidth="2"
								strokeLinecap="round"
								strokeLinejoin="round"
							/>
						</svg>
					</span>
				</span>
			</Link>
		</>
	);
}
