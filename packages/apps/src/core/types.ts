import type { AppInstallationStatus } from "@cap/database/schema";
import type { CurrentUser, Organisation, Policy } from "@cap/web-domain";
import { Effect, Option, Schema } from "effect";

import type { AppHandlerError } from "./errors.ts";
import type { AppStatePayload } from "./state.ts";

export type OrganisationsPolicyInstance = {
	isOwner: (
		organisationId: Organisation.OrganisationId,
	) => Effect.Effect<unknown, Policy.PolicyDeniedError | unknown, unknown>;
	isMember: (
		organisationId: Organisation.OrganisationId,
	) => Effect.Effect<unknown, Policy.PolicyDeniedError | unknown, unknown>;
};

export type AppInstallationRepoRecord<AppType extends string = string> = {
	id: string;
	organizationId: string;
	spaceId: string | null;
	appType: AppType;
	status: AppInstallationStatus;
	lastCheckedAt: Date | null;
	installedByUserId: string;
	updatedByUserId: string | null;
	accessToken: string;
	refreshToken: string | null;
	expiresAt: Date | null;
	scope: string | null;
	providerExternalId: string | null;
	providerDisplayName: string | null;
	providerMetadata: Record<string, unknown> | null;
	createdAt: Date;
	updatedAt: Date;
};

export type AppInstallationRepoCreate<AppType extends string = string> = {
	organizationId: string;
	spaceId: string | null;
	appType: AppType;
	status: AppInstallationStatus;
	lastCheckedAt: Date | null;
	installedByUserId: string;
	updatedByUserId: string | null;
	accessToken: string;
	refreshToken: string | null;
	expiresAt: Date | null;
	scope: string | null;
	providerExternalId: string | null;
	providerDisplayName: string | null;
	providerMetadata: Record<string, unknown> | null;
	id?: string;
};

export type AppInstallationRepoUpdate<AppType extends string = string> = Partial<{
	organizationId: string;
	spaceId: string | null;
	appType: AppType;
	status: AppInstallationStatus;
	lastCheckedAt: Date | null;
	installedByUserId: string;
	updatedByUserId: string | null;
	accessToken: string;
	refreshToken: string | null;
	expiresAt: Date | null;
	scope: string | null;
	providerExternalId: string | null;
	providerDisplayName: string | null;
	providerMetadata: Record<string, unknown> | null;
}>;

export type AppInstallationsRepository = {
	findByOrgAndType: (
		organizationId: string,
		appType: string,
	) => Effect.Effect<
		Option.Option<AppInstallationRepoRecord>,
		unknown,
		unknown
	>;
	create: (
		installation: AppInstallationRepoCreate,
	) => Effect.Effect<string, unknown, unknown>;
	updateById: (
		id: string,
		updates: AppInstallationRepoUpdate,
	) => Effect.Effect<unknown, unknown, unknown>;
	deleteById: (id: string) => Effect.Effect<unknown, unknown, unknown>;
};

export type AppAuthorizeContext<
	Policy extends OrganisationsPolicyInstance = OrganisationsPolicyInstance,
> = {
	user: CurrentUser["Type"];
	organisationsPolicy: Policy;
};

export type AppCallbackContext<
	AppType extends string = string,
	Policy extends OrganisationsPolicyInstance = OrganisationsPolicyInstance,
	Repo extends AppInstallationsRepository = AppInstallationsRepository,
> = {
	user: CurrentUser["Type"];
	organisationsPolicy: Policy;
	repo: Repo;
	query: Record<string, string | undefined>;
	rawState: string;
	state: AppStatePayload<AppType>;
};

export type AppRefreshContext<
	Policy extends OrganisationsPolicyInstance = OrganisationsPolicyInstance,
	Repo extends AppInstallationsRepository = AppInstallationsRepository,
> = {
	user: CurrentUser["Type"];
	organisationsPolicy: Policy;
	repo: Repo;
};

export type AppOAuthHandlers<
	AppType extends string = string,
	Policy extends OrganisationsPolicyInstance = OrganisationsPolicyInstance,
	Repo extends AppInstallationsRepository = AppInstallationsRepository,
> = {
	authorize: (
		context: AppAuthorizeContext<Policy>,
	) => Effect.Effect<unknown, unknown, never>;
	callback: (
		context: AppCallbackContext<AppType, Policy, Repo>,
	) => Effect.Effect<unknown, unknown, never>;
	refresh: (
		context: AppRefreshContext<Policy, Repo>,
	) => Effect.Effect<unknown, unknown, never>;
};

export type AppCredentials = {
	accessToken: string;
	refreshToken?: string | null;
	expiresAt?: Date | null;
	scope?: string | null;
};

export type AppInstallationRecord<AppType extends string = string> = {
	id: string;
	organizationId: string;
	spaceId: string | null;
	appType: AppType;
	status: AppInstallationStatus;
	providerExternalId: string | null;
	providerDisplayName: string | null;
	providerMetadata: Record<string, unknown> | null;
};

export type AppSettingsDefinition<Settings> = {
	schema: Schema.Schema<Settings, unknown>;
	createDefault?: () => Settings;
};

export type AppDefinition<AppType extends string, Settings> = {
	type: AppType;
	displayName: string;
	description: string;
	icon: string;
	category: string;
	settings: AppSettingsDefinition<Settings>;
};

export type AppDestination = {
	id: string;
	name: string;
	type: string;
	parentId?: string | null;
};

export type AppOperationContext<
	AppType extends string,
	Settings,
> = {
	installation: AppInstallationRecord<AppType>;
	credentials: AppCredentials | null;
	settings: Settings | null;
};

export type AppDispatchContext<
	AppType extends string,
	Settings,
	Payload,
> = {
	installation: AppInstallationRecord<AppType>;
	credentials: AppCredentials | null;
	settings: Settings;
	payload: Payload;
};

export type AppDispatchResult = {
	remoteId?: string;
	metadata?: Record<string, unknown>;
};

export type AppHandlers<
	AppType extends string,
	Settings,
	Payload,
> = {
	pause: (
		context: AppOperationContext<AppType, Settings>,
	) => Effect.Effect<void, AppHandlerError>;
	resume: (
		context: AppOperationContext<AppType, Settings>,
	) => Effect.Effect<void, AppHandlerError>;
	uninstall: (
		context: AppOperationContext<AppType, Settings>,
	) => Effect.Effect<void, AppHandlerError>;
	listDestinations: (
		context: AppOperationContext<AppType, Settings>,
	) => Effect.Effect<ReadonlyArray<AppDestination>, AppHandlerError>;
	dispatch: (
		context: AppDispatchContext<AppType, Settings, Payload>,
	) => Effect.Effect<AppDispatchResult, AppHandlerError>;
};

export type AppModule<
	AppType extends string = string,
	Settings = unknown,
	Payload = unknown,
> = {
	type: AppType;
	oauth: AppOAuthHandlers<AppType>;
	definition: AppDefinition<AppType, Settings>;
	handlers: AppHandlers<AppType, Settings, Payload>;
};
