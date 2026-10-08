import "./onboarding.css";
import { getCurrentUser } from "@cap/database/auth/session";
import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { OnboardingHeader } from "./components/OnboardingHeader";
import { PaperRoot } from "./components/PaperRoot";
import { onboardingThemeFromCookie, THEME_COOKIE } from "./onboarding-flow";

export const metadata: Metadata = {
	title: "Get started — Cap",
};

export default async function OnboardingLayout({
	children,
}: {
	children: React.ReactNode;
}) {
	const user = await getCurrentUser();
	if (!user) redirect("/login");
	const theme = onboardingThemeFromCookie(
		(await cookies()).get(THEME_COOKIE)?.value,
	);

	return (
		<PaperRoot initialTheme={theme}>
			<OnboardingHeader email={user.email} />
			<main className="flex flex-1 flex-col">{children}</main>
		</PaperRoot>
	);
}
