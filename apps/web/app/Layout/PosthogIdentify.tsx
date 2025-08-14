"use client";

import { Suspense, use, useEffect } from "react";
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
			// Track if this is the first time a user is being identified
			const isNewUser = !localStorage.getItem("user_identified");

			identifyUser(user.id);

			if (isNewUser) {
				localStorage.setItem("user_identified", "true");
				trackEvent("user_signed_up");
			}

			trackEvent("user_signed_in");
		}
	}, [user]);

	return null;
}
