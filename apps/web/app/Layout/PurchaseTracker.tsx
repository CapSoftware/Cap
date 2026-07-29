"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect } from "react";

export function PurchaseTracker() {
	const params = useSearchParams();
	const router = useRouter();
	const pathname = usePathname();

	const shouldClean = params.get("upgrade") === "true";

	useEffect(() => {
		if (!shouldClean) return;

		const next = new URLSearchParams(params.toString());
		next.delete("upgrade");
		next.delete("guest");
		next.delete("session_id");
		const query = next.toString();
		router.replace(query ? `${pathname}?${query}` : pathname);
	}, [shouldClean, params, pathname, router]);

	return null;
}
