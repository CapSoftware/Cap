"use client";

import { buildEnv } from "@cap/env";
import Cookies from "js-cookie";
import { redirect, usePathname } from "next/navigation";
import { createContext, useContext, useEffect, useState } from "react";
import { type CurrentUser, useCurrentUser } from "@/app/Layout/AuthContext";
import { UpgradeModal } from "@/components/UpgradeModal";
import type {
	Organization,
	OrganizationSettings,
	Spaces,
	UserPreferences,
} from "./dashboard-data";

type SharedContext = {
	organizationData: Organization[] | null;
	activeOrganization: Organization | null;
	organizationSettings: OrganizationSettings | null;
	spacesData: Spaces[] | null;
	userSpaces: Spaces[] | null;
	sharedSpaces: Spaces[] | null;
	activeSpace: Spaces | null;
	user: CurrentUser;
	userCapsCount: number | null;
	toggleSidebarCollapsed: () => void;
	anyNewNotifications: boolean;
	userPreferences: UserPreferences;
	sidebarCollapsed: boolean;
	upgradeModalOpen: boolean;
	setUpgradeModalOpen: (open: boolean) => void;
	referClickedState: boolean;
	setReferClickedStateHandler: (referClicked: boolean) => void;
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
	userCapsCount,
	organizationSettings,
	userPreferences,
	anyNewNotifications,
	initialTheme,
	initialSidebarCollapsed,
	referClicked,
}: {
	children: React.ReactNode;
	organizationData: SharedContext["organizationData"];
	activeOrganization: SharedContext["activeOrganization"];
	spacesData: SharedContext["spacesData"];
	userCapsCount: SharedContext["userCapsCount"];
	organizationSettings: SharedContext["organizationSettings"];
	userPreferences: SharedContext["userPreferences"];
	anyNewNotifications: boolean;
	initialTheme: ITheme;
	initialSidebarCollapsed: boolean;
	referClicked: boolean;
}) {
	const user = useCurrentUser();
	if (!user) redirect("/login");

	const [theme, setTheme] = useState<ITheme>(initialTheme);
	const [sidebarCollapsed, setSidebarCollapsed] = useState(
		initialSidebarCollapsed,
	);
	const [upgradeModalOpen, setUpgradeModalOpen] = useState(false);
	const [referClickedState, setReferClickedState] = useState(referClicked);
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
					member.role === "member",
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
		document.body.className = newTheme;
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
	}, []);

	const toggleSidebarCollapsed = () => {
		setSidebarCollapsed(!sidebarCollapsed);
		Cookies.set("sidebarCollapsed", !sidebarCollapsed ? "true" : "false", {
			expires: 365,
		});
	};

	const setReferClickedStateHandler = (referClicked: boolean) => {
		setReferClickedState(referClicked);
		Cookies.set("referClicked", referClicked ? "true" : "false", {
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
					userCapsCount,
					anyNewNotifications,
					userPreferences,
					organizationSettings,
					userSpaces,
					sharedSpaces,
					activeSpace,
					user,
					toggleSidebarCollapsed,
					sidebarCollapsed,
					upgradeModalOpen,
					setUpgradeModalOpen,
					referClickedState,
					setReferClickedStateHandler,
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
