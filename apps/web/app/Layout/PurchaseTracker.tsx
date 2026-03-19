"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect } from "react";
import { getPurchaseForMeta } from "@/actions/billing/track-meta-purchase";
import { trackMetaEvent } from "./MetaPixel";

export function PurchaseTracker() {
	const params = useSearchParams();
	const router = useRouter();
	const pathname = usePathname();

	const shouldCheck = params.get("upgrade") === "true";
	const sessionId = params.get("session_id");

	const cleanUrl = useCallback(() => {
		const next = new URLSearchParams(params.toString());
		next.delete("upgrade");
		next.delete("guest");
		next.delete("session_id");
		const query = next.toString();
		router.replace(query ? `${pathname}?${query}` : pathname);
	}, [params, pathname, router]);

	useEffect(() => {
		if (!shouldCheck) return;
		let cancelled = false;
		(async () => {
			const result = await getPurchaseForMeta({ sessionId });
			if (cancelled) return;
			if (
				result.shouldTrack &&
				typeof result.value === "number" &&
				result.currency
			) {
				trackMetaEvent(
					"Purchase",
					{ value: result.value, currency: result.currency },
					{ eventId: result.eventId },
				);
			}
			cleanUrl();
		})();
		return () => {
			cancelled = true;
		};
	}, [shouldCheck, sessionId, cleanUrl]);

	return null;
}
