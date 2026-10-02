"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

const REFRESH_MS = 5000;

/** Re-renders the page until the export it shows has finished. */
export function ExportRefresh() {
	const router = useRouter();
	useEffect(() => {
		const timer = setInterval(() => router.refresh(), REFRESH_MS);
		return () => clearInterval(timer);
	}, [router]);
	return null;
}
