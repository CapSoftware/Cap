import { getCurrentUser } from "@cap/database/auth/session";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { DeveloperSidebarRegistrar } from "./_components/DeveloperSidebarRegistrar";
import { DeveloperThemeForcer } from "./_components/DeveloperThemeForcer";
import { DevelopersProvider } from "./DevelopersContext";
import { getDeveloperApps } from "./developer-data";

export const metadata: Metadata = {
	title: "Developers — Cap",
};

export default async function DevelopersLayout({
	children,
}: {
	children: React.ReactNode;
}) {
	const user = await getCurrentUser();
	if (!user) redirect("/auth/signin");

	const apps = await getDeveloperApps(user);

	return (
		<DevelopersProvider apps={apps}>
			<DeveloperThemeForcer>
				<DeveloperSidebarRegistrar apps={apps} />
				{children}
			</DeveloperThemeForcer>
		</DevelopersProvider>
	);
}
