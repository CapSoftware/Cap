export type { AppStatusKey } from "./components/AppStatusBadge.tsx";
export { AppStatusBadge } from "./components/AppStatusBadge.tsx";
export type {
	AppsUiContextValue,
	ToastApi,
	UseEffectMutationHook,
	UseEffectQueryHook,
	WithRpc,
} from "./context.tsx";
export {
	AppsUiProvider,
	useAppsUi,
} from "./context.tsx";

export { getAppManagementComponent } from "./registry";

export {
	createManagementPanel,
	ManagementPanelSection,
} from "./management/ManagementPanelBuilder.tsx";

export type {
	AppDefinitionType,
	AppDestinationType,
	AppInstallationViewType,
	AppManagementComponent,
	AppManagementComponentProps,
	AppSelection,
	AppSpace,
	AppSlug,
} from "./types.ts";
