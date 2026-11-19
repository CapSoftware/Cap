"use client";

import { classNames } from "@cap/utils/helpers";
import Link from "next/link";
import { useEffect, useState } from "react";
import { trackEvent } from "@/app/utils/analytics";
import { useInAppCheckout } from "@/components/pages/checkout/useInAppCheckout";
import { checkoutPath } from "@/lib/checkout/plans";
import { CODE, ENDS_AT } from "./content";
import { CLAIM, CLAIM_SMALL } from "./theme";

export function useEnded() {
	const [ended, setEnded] = useState(false);
	useEffect(() => {
		const check = () => setEnded(Date.now() >= ENDS_AT);
		check();
		const timer = window.setInterval(check, 30_000);
		return () => window.clearInterval(timer);
	}, []);
	return ended;
}

export function Claim({
	location,
	seats = 1,
	small,
	label = "Claim 50% off",
	className,
}: {
	location: string;
	seats?: number;
	small?: boolean;
	label?: string;
	className?: string;
}) {
	const checkout = useInAppCheckout();
	const ended = useEnded();
	const classes = classNames(CLAIM, small && CLAIM_SMALL, className);

	if (ended || !checkout) {
		return (
			<Link href="/pricing" className={classes}>
				<Sheen />
				{ended ? "See Cap Pro pricing" : label}
				<Arrow small={small} />
			</Link>
		);
	}

	return (
		<a
			href={checkoutPath({ plan: "yearly", seats, promo: CODE })}
			className={classes}
			aria-busy={checkout.pending}
			onPointerEnter={checkout.warm}
			onFocus={checkout.warm}
			onTouchStart={checkout.warm}
			onClick={(event) => {
				if (event.metaKey || event.ctrlKey || event.shiftKey) return;
				event.preventDefault();
				trackEvent("black_friday_cta_clicked", {
					cta_location: location,
					quantity: seats,
					target_billing_period: "annual",
				});
				checkout.open({ plan: "yearly", seats, promo: CODE });
			}}
		>
			<Sheen />
			{checkout.pending ? "Opening checkout..." : label}
			<Arrow small={small} />
		</a>
	);
}

function Sheen() {
	return (
		<span
			aria-hidden="true"
			className="pointer-events-none absolute inset-y-0 left-0 -z-10 w-1/3 -translate-x-[150%] skew-x-[-20deg] bg-[linear-gradient(90deg,rgba(255,255,255,0),rgba(255,214,190,0.75),rgba(255,255,255,0))] transition-transform duration-700 ease-out group-hover/claim:translate-x-[380%] motion-reduce:hidden"
		/>
	);
}

function Arrow({ small }: { small?: boolean }) {
	return (
		<span
			aria-hidden="true"
			className={classNames(
				"grid shrink-0 place-items-center rounded-full bg-[#141012] text-[#F5F1EA] transition-transform duration-300 [transition-timing-function:cubic-bezier(0.2,0.8,0.2,1)] group-hover/claim:scale-110 motion-reduce:transition-none",
				small ? "size-8" : "size-10",
			)}
		>
			<svg
				viewBox="0 0 16 16"
				className={classNames(
					"transition-transform duration-300 group-hover/claim:translate-x-0.5 motion-reduce:transition-none",
					small ? "size-3" : "size-3.5",
				)}
			>
				<path
					d="M3 8h9.5M8.5 4l4 4-4 4"
					fill="none"
					stroke="currentColor"
					strokeWidth="1.8"
					strokeLinecap="round"
					strokeLinejoin="round"
				/>
			</svg>
		</span>
	);
}
