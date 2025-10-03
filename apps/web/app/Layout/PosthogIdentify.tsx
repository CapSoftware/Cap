"use client";

import { Suspense, use, useEffect } from "react";
import { checkAndMarkUserSignedUpTracked } from "@/actions/analytics/track-user-signed-up";
import {
	identifyUser,
	initAnonymousUser,
	trackEvent,
} from "../utils/analytics";
import { useAuthContext } from "./AuthContext";

export function PosthogIdentify() {
	return (
		<Suspense>
			<Inner />
		</Suspense>
	);
}

function Inner() {
	const user = use(useAuthContext().user);

	useEffect(() => {
		if (!user) {
			initAnonymousUser();
			return;
		} else {
			identifyUser(user.id);

			(async () => {
				const { shouldTrack } = await checkAndMarkUserSignedUpTracked();
				if (shouldTrack) {
					trackEvent("user_signed_up");
				}
				trackEvent("user_signed_in");
			})();
		}
	}, [user]);

	return null;
}
