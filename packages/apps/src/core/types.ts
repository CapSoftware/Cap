import type { AppInstallationStatus } from "@cap/database/schema";
import type { CurrentUser, Organisation, Policy } from "@cap/web-domain";
import type { Effect, Option } from "effect";
import type { AppHandlerError } from "./errors.ts";
import type { AppSettingsDefinition } from "./settings.ts";
import type { AppStatePayload } from "./state.ts";

export type OrganisationsPolicyInstance = {
	isOwner: (
		organisationId: Organisation.OrganisationId,
	) => Effect.Effect<unknown, Policy.PolicyDeniedError | unknown, unknown>;
	isMember: (
		organisationId: Organisation.OrganisationId,
	) => Effect.Effect<unknown, Policy.PolicyDeniedError | unknown, unknown>;
};

export type AppInstallationRepoRecord<AppSlug extends string = string> = {
	id: string;
	organizationId: string;
	spaceId: string | null;
	appSlug: AppSlug;
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

export type AppInstallationRepoCreate<AppSlug extends string = string> = {
	organizationId: string;
	spaceId: string | null;
	appSlug: AppSlug;
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

export type AppInstallationRepoUpdate<AppSlug extends string = string> =
	Partial<{
		organizationId: string;
		spaceId: string | null;
		appSlug: AppSlug;
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
	findByOrgAndSlug: (
		organizationId: string,
		slug: string,
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
	AppSlug extends string = string,
	Policy extends OrganisationsPolicyInstance = OrganisationsPolicyInstance,
	Repo extends AppInstallationsRepository = AppInstallationsRepository,
> = {
	user: CurrentUser["Type"];
	organisationsPolicy: Policy;
	repo: Repo;
	query: Record<string, string | undefined>;
	rawState: string;
	state: AppStatePayload<AppSlug>;
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
	AppSlug extends string = string,
	Policy extends OrganisationsPolicyInstance = OrganisationsPolicyInstance,
	Repo extends AppInstallationsRepository = AppInstallationsRepository,
> = {
	authorize: (
		context: AppAuthorizeContext<Policy>,
	) => Effect.Effect<unknown, unknown, unknown>;
	callback: (
		context: AppCallbackContext<AppSlug, Policy, Repo>,
	) => Effect.Effect<unknown, unknown, unknown>;
	refresh: (
		context: AppRefreshContext<Policy, Repo>,
	) => Effect.Effect<unknown, unknown, unknown>;
};

export type AppCredentials = {
	accessToken: string;
	refreshToken?: string | null;
	expiresAt?: Date | null;
	scope?: string | null;
};

export type AppInstallationRecord<AppSlug extends string = string> = {
	id: string;
	organizationId: string;
	spaceId: string | null;
	slug: AppSlug;
	status: AppInstallationStatus;
	providerExternalId: string | null;
	providerDisplayName: string | null;
	providerMetadata: Record<string, unknown> | null;
};

export type AppDefinition<AppSlug extends string, Settings> = {
	slug: AppSlug;
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

export type AppDestinationVerificationResult = {
	status: "verified" | "missing_permissions" | "unknown_destination";
	missingPermissions?: ReadonlyArray<string>;
};

export type AppOperationContext<AppSlug extends string, Settings> = {
	installation: AppInstallationRecord<AppSlug>;
	credentials: AppCredentials | null;
	settings: Settings | null;
};

export type AppDispatchContext<AppSlug extends string, Settings, Payload> = {
	installation: AppInstallationRecord<AppSlug>;
	credentials: AppCredentials | null;
	settings: Settings;
	payload: Payload;
};

export type AppDispatchResult = {
	remoteId?: string;
	metadata?: Record<string, unknown>;
};

export type AppHandlers<AppSlug extends string, Settings, Payload> = {
	pause: (
		context: AppOperationContext<AppSlug, Settings>,
	) => Effect.Effect<void, AppHandlerError>;
	resume: (
		context: AppOperationContext<AppSlug, Settings>,
	) => Effect.Effect<void, AppHandlerError>;
	uninstall: (
		context: AppOperationContext<AppSlug, Settings>,
	) => Effect.Effect<void, AppHandlerError>;
	listDestinations: (
		context: AppOperationContext<AppSlug, Settings>,
	) => Effect.Effect<ReadonlyArray<AppDestination>, AppHandlerError>;
	verifyDestination?: (
		context: AppOperationContext<AppSlug, Settings>,
	) => Effect.Effect<AppDestinationVerificationResult, AppHandlerError>;
	dispatch: (
		context: AppDispatchContext<AppSlug, Settings, Payload>,
	) => Effect.Effect<AppDispatchResult, AppHandlerError>;
};

export type AppModule<
	AppSlug extends string = string,
	Settings = unknown,
	Payload = unknown,
> = {
	slug: AppSlug;
	oauth: AppOAuthHandlers<AppSlug>;
	definition: AppDefinition<AppSlug, Settings>;
	handlers: AppHandlers<AppSlug, Settings, Payload>;
};
