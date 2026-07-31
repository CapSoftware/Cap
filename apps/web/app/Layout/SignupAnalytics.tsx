"use client";

import { Suspense, useEffect } from "react";
import { checkAndMarkUserSignedUpTracked } from "@/actions/analytics/track-user-signed-up";
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

		void checkAndMarkUserSignedUpTracked();
	}, [user]);

	return null;
}
