"use client";

import { Suspense, useEffect } from "react";
import { checkAndMarkUserSignedUpTracked } from "@/actions/analytics/track-user-signed-up";
import { trackEvent } from "../utils/analytics";
import { useCurrentUser } from "./AuthContext";

export function SignupAnalytics() {
	return (
		<Suspense>
			<Inner />
		</Suspense>
	);
}

function Inner() {
	const user = useCurrentUser();

	useEffect(() => {
		if (!user) return;

		void checkAndMarkUserSignedUpTracked().then(({ shouldTrack }) => {
			if (shouldTrack) trackEvent("user_signed_up");
		});
	}, [user]);

	return null;
}
