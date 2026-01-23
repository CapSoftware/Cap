"use client";

import type { users } from "@inflight/database/schema";
import { usePathname } from "next/navigation";
import Script from "next/script";
import { useEffect } from "react";

declare global {
	interface Window {
		bento?: any;
	}
}

export function BentoScript({
	user,
}: {
	user?: typeof users.$inferSelect | null;
}) {
	const _pathname = usePathname();

	useEffect(() => {
		if (window.bento !== undefined) {
			if (user) {
				window.bento.identify(user.email);
			}
			window.bento.view();
		}
	}, [user]);

	return (
		<Script
			id="bento-script"
			src={
				"https://fast.bentonow.com?site_uuid=7d5c45ace4c02e5587c4449b1f0efb5c"
			}
			strategy="afterInteractive"
		/>
	);
}
