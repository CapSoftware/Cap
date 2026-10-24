"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { usePublicEnv } from "@/utils/public-env";

/**
 * Canonical public collection link + copy-to-clipboard with the shared
 * 2s "copied" feedback state. Builds the URL from the configured web URL so
 * every dashboard surface produces the same link regardless of the origin the
 * dashboard happens to be served from.
 */
export function useCopyCollectionLink(collectionId: string | undefined) {
	const { webUrl } = usePublicEnv();
	const [copied, setCopied] = useState(false);
	const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(
		() => () => {
			if (timeoutRef.current) clearTimeout(timeoutRef.current);
		},
		[],
	);

	const url = `${webUrl}/c/${collectionId ?? ""}`;

	const copy = async () => {
		if (!collectionId) return false;
		try {
			await navigator.clipboard.writeText(url);
		} catch {
			toast.error("Failed to copy public collection link");
			return false;
		}
		toast.success("Public collection link copied");
		if (timeoutRef.current) clearTimeout(timeoutRef.current);
		setCopied(true);
		timeoutRef.current = setTimeout(() => setCopied(false), 2000);
		return true;
	};

	return { url, copied, copy };
}
