"use client";

import type { User } from "@cap/web-domain";
import Cookies from "js-cookie";
import { useCallback, useEffect, useRef } from "react";
import { trackEvent } from "@/app/utils/analytics";
import { useEffectMutation, useRpcClient } from "@/lib/EffectRuntime";
import { clearOnboardingNextPath } from "../../onboarding-next";
import { THEME_COOKIE } from "../onboarding-flow";

const carryThemeToDashboard = () => {
	if (Cookies.get(THEME_COOKIE)) return;
	if (!window.matchMedia("(prefers-color-scheme: dark)").matches) return;
	Cookies.set(THEME_COOKIE, "dark", { expires: 365 });
};

export const useGetStarted = (
	initiallyComplete: boolean,
	autoCompletePath?: User.OnboardingStartPath,
) => {
	const rpc = useRpcClient();
	const completeRef = useRef(initiallyComplete);
	const pendingRef = useRef<Promise<void> | null>(null);

	const { mutateAsync, isPending } = useEffectMutation({
		mutationFn: (path: User.OnboardingStartPath) =>
			rpc.UserCompleteOnboardingStep({ step: "getStarted", data: { path } }),
	});

	const complete = useCallback(
		async (path: User.OnboardingStartPath) => {
			if (completeRef.current) return;
			if (!pendingRef.current) {
				pendingRef.current = mutateAsync(path)
					.then(() => {
						completeRef.current = true;
						clearOnboardingNextPath();
						carryThemeToDashboard();
						trackEvent("onboarding_completed", { path });
					})
					.finally(() => {
						pendingRef.current = null;
					});
			}
			await pendingRef.current;
		},
		[mutateAsync],
	);

	useEffect(() => {
		if (!autoCompletePath) return;
		complete(autoCompletePath).catch(() => undefined);
	}, [autoCompletePath, complete]);

	return { complete, isCompleting: isPending };
};
