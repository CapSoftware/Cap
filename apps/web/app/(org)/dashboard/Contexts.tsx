"use client";

import type { users } from "@cap/database/schema";
import { buildEnv } from "@cap/env";
import Cookies from "js-cookie";
import { usePathname } from "next/navigation";
import { createContext, useContext, useEffect, useState } from "react";
import { UpgradeModal } from "@/components/UpgradeModal";
import type { Organization, Spaces, UserPreferences } from "./dashboard-data";

type SharedContext = {
	organizationData: Organization[] | null;
	activeOrganization: Organization | null;
	spacesData: Spaces[] | null;
	userSpaces: Spaces[] | null;
	sharedSpaces: Spaces[] | null;
	activeSpace: Spaces | null;
	user: typeof users.$inferSelect;
	isSubscribed: boolean;
	toggleSidebarCollapsed: () => void;
	anyNewNotifications: boolean;
	userPreferences: UserPreferences;
	sidebarCollapsed: boolean;
	upgradeModalOpen: boolean;
	setUpgradeModalOpen: (open: boolean) => void;
};

type ITheme = "light" | "dark";

const DashboardContext = createContext<SharedContext>({} as SharedContext);

const ThemeContext = createContext<{
	theme: ITheme;
	setThemeHandler: (newTheme: ITheme) => void;
}>({
	theme: "light",
	setThemeHandler: () => {},
});

export const useTheme = () => useContext(ThemeContext);

export const useDashboardContext = () => useContext(DashboardContext);

export function DashboardContexts({
	children,
	organizationData,
	activeOrganization,
	spacesData,
	user,
	isSubscribed,
	userPreferences,
	anyNewNotifications,
	initialTheme,
	initialSidebarCollapsed,
}: {
	children: React.ReactNode;
	organizationData: SharedContext["organizationData"];
	activeOrganization: SharedContext["activeOrganization"];
	spacesData: SharedContext["spacesData"];
	user: SharedContext["user"];
	isSubscribed: SharedContext["isSubscribed"];
	userPreferences: SharedContext["userPreferences"];
	anyNewNotifications: boolean;
	initialTheme: ITheme;
	initialSidebarCollapsed: boolean;
}) {
	const [theme, setTheme] = useState<ITheme>(initialTheme);
	const [sidebarCollapsed, setSidebarCollapsed] = useState(
		initialSidebarCollapsed,
	);
	const [upgradeModalOpen, setUpgradeModalOpen] = useState(false);
	const pathname = usePathname();

	// Calculate user's spaces (both owned and member of)
	const userSpaces =
		spacesData?.filter((space) =>
			// User might be the space owner or a member of the space in the organization
			activeOrganization?.members.some(
				(member) =>
					member.userId === user.id &&
					member.organizationId === space.organizationId,
			),
		) || null;

	// Spaces shared with the user but not owned by them
	const sharedSpaces =
		spacesData?.filter((space) =>
			activeOrganization?.members.some(
				(member) =>
					member.userId === user.id &&
					member.organizationId === space.organizationId &&
					member.role === "MEMBER",
			),
		) || null;

	// Get activeSpace from URL if on a space page
	const [activeSpace, setActiveSpace] = useState<Spaces | null>(null);

	useEffect(() => {
		const spaceIdMatch = pathname.match(/\/dashboard\/spaces\/([^/]+)/);
		const spaceId = spaceIdMatch ? spaceIdMatch[1] : null;

		if (spaceId && spacesData) {
			const space = spacesData.find((space) => space.id === spaceId) || null;
			setActiveSpace(space);
		} else {
			setActiveSpace(null);
		}
	}, [spacesData, pathname]);

	const setThemeHandler = (newTheme: ITheme) => {
		setTheme(newTheme);
		Cookies.set("theme", newTheme, {
			expires: 365,
		});
	};
	useEffect(() => {
		if (Cookies.get("theme")) {
			document.body.className = Cookies.get("theme") as ITheme;
		}
		if (Cookies.get("sidebarCollapsed")) {
			setSidebarCollapsed(Cookies.get("sidebarCollapsed") === "true");
		}
		return () => {
			document.body.className = "light";
		};
	}, [theme]);
	const toggleSidebarCollapsed = () => {
		setSidebarCollapsed(!sidebarCollapsed);
		Cookies.set("sidebarCollapsed", !sidebarCollapsed ? "true" : "false", {
			expires: 365,
		});
	};

	return (
		<ThemeContext.Provider value={{ theme, setThemeHandler }}>
			<DashboardContext.Provider
				value={{
					organizationData,
					activeOrganization,
					spacesData,
					anyNewNotifications,
					userPreferences,
					userSpaces,
					sharedSpaces,
					activeSpace,
					user,
					isSubscribed,
					toggleSidebarCollapsed,
					sidebarCollapsed,
					upgradeModalOpen,
					setUpgradeModalOpen,
				}}
			>
				{children}

				{/* Global upgrade modal that persists regardless of navigation state */}
				{buildEnv.NEXT_PUBLIC_IS_CAP && (
					<UpgradeModal
						open={upgradeModalOpen}
						onOpenChange={setUpgradeModalOpen}
					/>
				)}
			</DashboardContext.Provider>
		</ThemeContext.Provider>
	);
}
