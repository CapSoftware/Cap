import { DiscordManagementPanel } from "../discord/ui/ManagementPanel.tsx";
import type { AppManagementComponent, AppSlug } from "./types";

const managementPanels: Partial<Record<AppSlug, AppManagementComponent>> = {
	discord: DiscordManagementPanel,
};

const getAppManagementComponent = (
	slug: AppSlug,
): AppManagementComponent | null => managementPanels[slug] ?? null;

export { getAppManagementComponent };
