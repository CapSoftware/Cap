"use client";

import { Suspense, use, useEffect } from "react";
import { useAuthContext } from "./AuthContext";
import {
  identifyUser,
  initAnonymousUser,
  trackEvent,
} from "../utils/analytics";

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
