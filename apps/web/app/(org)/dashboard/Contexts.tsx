"use client";

import { buildEnv } from "@cap/env";
import Cookies from "js-cookie";
import { redirect, usePathname } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { InviteDialog } from "@/app/(org)/dashboard/settings/organization/components/InviteDialog";
import { useCurrentUser } from "@/app/Layout/AuthContext";
import { UpgradeModal } from "@/components/UpgradeModal";
import {
	DashboardContext,
	type ITheme,
	type SetThemeOptions,
	type SharedContext,
	ThemeContext,
} from "./DashboardContext";
import type { Spaces } from "./dashboard-data";
import type { DeveloperApp } from "./developers/developer-data";

// The context objects and hooks live in `DashboardContext.ts` (so the share
// page can read the context without pulling this file's dialogs); re-exported
// here to keep the dashboard's existing import sites working unchanged.
export { useDashboardContext, useTheme } from "./DashboardContext";

export function DashboardContexts({
	children,
	organizationData,
	activeOrganization,
	spacesData,
	userCapsCount,
	organizationSettings,
	instanceVideoDefaultPublic,
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
	instanceVideoDefaultPublic: SharedContext["instanceVideoDefaultPublic"];
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
	const [inviteDialogOpen, setInviteDialogOpen] = useState(false);
	const [referClickedState, setReferClickedState] = useState(referClicked);
	const [developerApps, setDeveloperApps] = useState<DeveloperApp[] | null>(
		null,
	);
	const pathname = usePathname();
	const isDeveloperSection = pathname.startsWith("/dashboard/developers");

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

	const setThemeHandler = useCallback(
		(newTheme: ITheme, options?: SetThemeOptions) => {
			setTheme(newTheme);
			document.body.className = newTheme;
			if (options?.persist !== false) {
				Cookies.set("theme", newTheme, {
					expires: 365,
				});
			}
		},
		[],
	);
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
					instanceVideoDefaultPublic,
					userSpaces,
					sharedSpaces,
					activeSpace,
					user,
					toggleSidebarCollapsed,
					sidebarCollapsed,
					upgradeModalOpen,
					setUpgradeModalOpen,
					inviteDialogOpen,
					setInviteDialogOpen,
					referClickedState,
					setReferClickedStateHandler,
					isDeveloperSection,
					developerApps,
					setDeveloperApps,
				}}
			>
				{children}

				<InviteDialog
					isOpen={inviteDialogOpen}
					setIsOpen={setInviteDialogOpen}
				/>

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
