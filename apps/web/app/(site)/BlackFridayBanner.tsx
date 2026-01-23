"use client";

import { buildEnv } from "@inflight/env";
import Link from "next/link";
import { useState } from "react";

export function BlackFridayBanner() {
	const [isHovered, setIsHovered] = useState(false);

	if (buildEnv.NEXT_PUBLIC_IS_CAP !== "true") {
		return null;
	}

	return (
		<Link
			href="https://pay.cap.so/b/aFa5kD2EnaNH2Pdg4obII00?prefilled_promo_code=BLACKFRIDAY"
			target="_blank"
			onMouseEnter={() => setIsHovered(true)}
			onMouseLeave={() => setIsHovered(false)}
			className="fixed top-0 left-0 right-0 z-[52] flex items-center justify-center gap-1 sm:gap-2 bg-black py-2 px-3 text-center text-xs sm:text-sm text-white cursor-pointer hover:bg-gray-900 transition-colors"
		>
			<span className="font-semibold">Black Friday:</span>
			<span className="hidden sm:inline">50% off Cap Pro Annual with code</span>
			<span className="sm:hidden">50% off Cap Pro</span>
			<span className="relative font-mono font-bold bg-white/20 px-1.5 sm:px-2 py-0.5 rounded text-xs sm:text-sm overflow-hidden">
				<span
					className={`inline-block transition-all duration-300 ${
						isHovered
							? "-translate-y-full opacity-0"
							: "translate-y-0 opacity-100"
					}`}
				>
					BLACKFRIDAY
				</span>
				<span
					className={`absolute inset-0 flex items-center justify-center transition-all duration-300 ${
						isHovered
							? "translate-y-0 opacity-100"
							: "translate-y-full opacity-0"
					}`}
				>
					Buy Now
				</span>
			</span>
		</Link>
	);
}
