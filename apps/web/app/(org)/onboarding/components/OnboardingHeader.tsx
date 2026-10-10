"use client";

import { usePathname } from "next/navigation";
import { signOut } from "next-auth/react";
import { useState } from "react";
import { resetUser } from "@/app/utils/analytics";
import { clearOnboardingNextPath } from "../../onboarding-next";
import { isOnboardingStep, onboardingProgressIndex } from "../onboarding-flow";
import { ThemeToggle } from "./PaperRoot";
import { CapWordmark, ProgressMarks } from "./paper";

export const OnboardingHeader = ({ email }: { email: string }) => {
	const pathname = usePathname();
	const [signingOut, setSigningOut] = useState(false);
	const segment = pathname?.split("/")[2] ?? "";
	const step = isOnboardingStep(segment) ? segment : null;

	return (
		<header className="relative z-10 mx-auto grid w-full max-w-[1180px] grid-cols-[1fr_auto_1fr] items-center gap-3 px-5 pt-5 sm:px-8 sm:pt-7">
			<CapWordmark className="h-[26px] w-auto text-[var(--ob-ink)] sm:h-7" />
			<div className="justify-self-center">
				{step && <ProgressMarks index={onboardingProgressIndex(step)} />}
			</div>
			<div className="flex min-w-0 items-center justify-end gap-2.5 sm:gap-3">
				<span className="hidden max-w-[220px] truncate text-[13px] text-[var(--ob-ink-soft)] lg:inline">
					{email}
				</span>
				<ThemeToggle />
				<button
					type="button"
					className="ob-link shrink-0 !text-[13px]"
					disabled={signingOut}
					onClick={() => {
						setSigningOut(true);
						clearOnboardingNextPath();
						resetUser();
						signOut({ callbackUrl: "/login" });
					}}
				>
					{signingOut ? "Signing out…" : "Sign out"}
				</button>
			</div>
		</header>
	);
};
