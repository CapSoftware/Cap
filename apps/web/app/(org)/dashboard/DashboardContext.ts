"use client";

import { createContext, useContext } from "react";
import type { CurrentUser } from "@/app/Layout/AuthContext";
import type {
	Organization,
	OrganizationSettings,
	Spaces,
	UserPreferences,
} from "./dashboard-data";
import type { DeveloperApp } from "./developers/developer-data";

/**
 * The context objects and hooks, split from `Contexts.tsx` so consumers
 * outside the dashboard (the share page header reads it for shared spaces)
 * don't drag the provider's dialog imports — InviteDialog, UpgradeModal and
 * its Rive runtime — into their bundle.
 */

export type SharedContext = {
	organizationData: Organization[] | null;
	activeOrganization: Organization | null;
	organizationSettings: OrganizationSettings | null;
	instanceVideoDefaultPublic: boolean;
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
	inviteDialogOpen: boolean;
	setInviteDialogOpen: (open: boolean) => void;
	referClickedState: boolean;
	setReferClickedStateHandler: (referClicked: boolean) => void;
	isDeveloperSection: boolean;
	developerApps: DeveloperApp[] | null;
	setDeveloperApps: (apps: DeveloperApp[] | null) => void;
};

export type ITheme = "light" | "dark";
export type SetThemeOptions = {
	persist?: boolean;
};

export const DashboardContext = createContext<SharedContext>(
	{} as SharedContext,
);

export const ThemeContext = createContext<{
	theme: ITheme;
	setThemeHandler: (newTheme: ITheme, options?: SetThemeOptions) => void;
}>({
	theme: "light",
	setThemeHandler: () => {},
});

export const useTheme = () => useContext(ThemeContext);

export const useDashboardContext = () => useContext(DashboardContext);
