"use client";

import { Suspense, useEffect } from "react";
import { checkAndMarkUserSignedUpTracked } from "@/actions/analytics/track-user-signed-up";
import { identifyUser, trackEvent } from "../utils/analytics";
import { useCurrentUser } from "./AuthContext";

export function AnalyticsIdentify() {
	return (
		<Suspense>
			<Inner />
		</Suspense>
	);
}

function Inner() {
	const user = useCurrentUser();

	useEffect(() => {
		// Anonymous visitors need no setup: OpenPanel assigns a device profile on
		// its own and merges it into the identified profile once `identify` runs.
		if (!user) return;

		identifyUser({
			id: user.id,
			email: user.email,
			name: user.name,
			lastName: user.lastName,
		});

		(async () => {
			const { shouldTrack } = await checkAndMarkUserSignedUpTracked();
			if (shouldTrack) {
				trackEvent("user_signed_up");
			}
			trackEvent("user_signed_in");
		})();
	}, [user]);

	return null;
}
