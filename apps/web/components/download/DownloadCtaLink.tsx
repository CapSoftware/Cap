"use client";

import { useDownloadCta } from "hooks/useDownloadCta";
import Link from "next/link";
import type { ReactNode } from "react";

export const DownloadCtaLink = ({
	sourcePage,
	ctaLocation,
	className,
	children,
}: {
	sourcePage: string;
	ctaLocation: string;
	className?: string;
	children: ReactNode;
}) => {
	const cta = useDownloadCta();
	return (
		<Link
			href={cta.href}
			onClick={() => cta.trackClick(sourcePage, ctaLocation)}
			className={className}
		>
			{children}
		</Link>
	);
};
