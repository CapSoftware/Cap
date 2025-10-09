import type { Apps } from "@cap/web-domain";
import type { ComponentType } from "react";

export type AppDefinitionType = typeof Apps.AppDefinition.Type;
export type AppInstallationViewType = typeof Apps.AppInstallationView.Type;
export type AppDestinationType = typeof Apps.AppDestination.Type;
export type AppSlug = typeof Apps.AppSlug.Type;

export type AppSelection = {
	definition: AppDefinitionType;
	installation: AppInstallationViewType | null;
};

export type AppSpace = {
	id: string;
	name: string;
};

export type AppManagementComponentProps = {
	selection: AppSelection;
	spaces: AppSpace[];
	onClose: () => void;
	onSelectionChange: (selection: AppSelection | null) => void;
};

export type AppManagementComponent = ComponentType<AppManagementComponentProps>;
