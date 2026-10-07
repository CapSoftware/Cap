import "./onboarding.css";
import { getCurrentUser } from "@cap/database/auth/session";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { OnboardingHeader } from "./components/OnboardingHeader";
import { PaperRoot } from "./components/PaperRoot";

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

	return (
		<PaperRoot>
			<OnboardingHeader email={user.email} />
			<main className="flex flex-1 flex-col">{children}</main>
		</PaperRoot>
	);
}
