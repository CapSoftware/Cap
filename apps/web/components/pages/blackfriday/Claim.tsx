"use client";

import { classNames } from "@cap/utils/helpers";
import Link from "next/link";
import { useEffect, useState } from "react";
import { trackEvent } from "@/app/utils/analytics";
import { useInAppCheckout } from "@/components/pages/checkout/useInAppCheckout";
import { checkoutPath } from "@/lib/checkout/plans";
import { CODE, ENDS_AT } from "./content";
import { CLAIM, CLAIM_SMALL } from "./theme";

/** False on the server and the first render, then whether the offer is over. */
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

/**
 * The one action on the page: a yearly checkout with BLACKFRIDAY applied.
 * Opens the in-app checkout (Stripe warmed on hover), or the pricing page
 * where that checkout is not available, and after the offer has ended.
 */
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
				{ended ? "See Cap Pro pricing" : label}
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
			{checkout.pending ? "Opening checkout..." : label}
		</a>
	);
}
