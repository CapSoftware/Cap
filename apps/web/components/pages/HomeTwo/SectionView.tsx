"use client";

import { useEffect, useRef } from "react";
import { trackEvent } from "@/app/utils/analytics";

export const SectionView = ({ section }: { section: string }) => {
	const ref = useRef<HTMLSpanElement | null>(null);

	useEffect(() => {
		const node = ref.current;
		if (!node || typeof IntersectionObserver === "undefined") return;
		const observer = new IntersectionObserver((entries) => {
			if (!entries.some((entry) => entry.isIntersecting)) return;
			observer.disconnect();
			trackEvent("home_section_viewed", { section });
		});
		observer.observe(node);
		return () => observer.disconnect();
	}, [section]);

	return (
		<span ref={ref} aria-hidden="true" className="-mb-px block h-px w-full" />
	);
};
