// app/PostHogPageView.tsx
"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { usePostHog } from "posthog-js/react";
import { Suspense, useEffect, useMemo } from "react";

let lastTrackedUrl: string | null = null;

function PostHogPageView(): null {
	const pathname = usePathname();
	const searchParams = useSearchParams();
	const posthog = usePostHog();
	const search = useMemo(() => searchParams?.toString() ?? "", [searchParams]);

	useEffect(() => {
		if (!pathname || !posthog) {
			return;
		}

		try {
			let url = window.location.origin + pathname;
			if (search) {
				url = `${url}?${search}`;
			}

			if (lastTrackedUrl === url) {
				return;
			}

			posthog.capture("$pageview", { $current_url: url });
			lastTrackedUrl = url;
		} catch (error) {
			console.error("Error capturing pageview:", error);
		}
	}, [pathname, search, posthog]);

	return null;
}

// Wrap this in Suspense to avoid the `useSearchParams` usage above
// from de-opting the whole app into client-side rendering
// See: https://nextjs.org/docs/messages/deopted-into-client-rendering
export default function SuspendedPostHogPageView() {
	return (
		<Suspense fallback={null}>
			<PostHogPageView />
		</Suspense>
	);
}
