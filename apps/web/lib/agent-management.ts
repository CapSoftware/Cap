import type { Agent } from "@cap/web-domain";

type ActionInput = {
	allowed: boolean;
	reason?: (typeof Agent.AgentActionReason)["Type"] | null;
	requiredScopes?: (typeof Agent.AgentScope)["Type"][];
	confirmation?: (typeof Agent.AgentActionCapability)["Type"]["confirmation"];
	sideEffect?: (typeof Agent.AgentActionCapability)["Type"]["sideEffect"];
	idempotencyRequired?: boolean;
	asynchronous?: boolean;
};

export const agentAction = ({
	allowed,
	reason = allowed ? null : "ROLE_REQUIRED",
	requiredScopes = [],
	confirmation = "none",
	sideEffect = "read",
	idempotencyRequired = sideEffect !== "read",
	asynchronous = false,
}: ActionInput): (typeof Agent.AgentActionCapability)["Type"] => ({
	allowed,
	reason,
	requiredScopes,
	confirmation,
	sideEffect,
	idempotencyRequired,
	asynchronous,
});

export const canUseScope = (
	scopes: ReadonlySet<(typeof Agent.AgentScope)["Type"]>,
	scope: (typeof Agent.AgentScope)["Type"],
) => scopes.has(scope);

export const agentViewerSettings = (
	settings: {
		disableSummary?: boolean;
		disableCaptions?: boolean;
		disableChapters?: boolean;
		disableReactions?: boolean;
		disableTranscript?: boolean;
		disableComments?: boolean;
		defaultPlaybackSpeed?: number;
	} | null,
): (typeof Agent.AgentViewerSettings)["Type"] => ({
	disableSummary: settings?.disableSummary ?? null,
	disableCaptions: settings?.disableCaptions ?? null,
	disableChapters: settings?.disableChapters ?? null,
	disableReactions: settings?.disableReactions ?? null,
	disableTranscript: settings?.disableTranscript ?? null,
	disableComments: settings?.disableComments ?? null,
	defaultPlaybackSpeed: settings?.defaultPlaybackSpeed ?? null,
});

export const agentOrganizationSettings = (
	settings: {
		disableSummary?: boolean;
		disableCaptions?: boolean;
		disableChapters?: boolean;
		disableReactions?: boolean;
		disableTranscript?: boolean;
		disableComments?: boolean;
		hideShareableLinkCapLogo?: boolean;
		shareableLinkUseOrganizationIcon?: boolean;
		aiGenerationLanguage?: (typeof Agent.AgentAiGenerationLanguage)["Type"];
		defaultPlaybackSpeed?: number;
	} | null,
): (typeof Agent.AgentOrganizationSettings)["Type"] => ({
	disableSummary: settings?.disableSummary ?? null,
	disableCaptions: settings?.disableCaptions ?? null,
	disableChapters: settings?.disableChapters ?? null,
	disableReactions: settings?.disableReactions ?? null,
	disableTranscript: settings?.disableTranscript ?? null,
	disableComments: settings?.disableComments ?? null,
	hideShareableLinkCapLogo: settings?.hideShareableLinkCapLogo ?? null,
	shareableLinkUseOrganizationIcon:
		settings?.shareableLinkUseOrganizationIcon ?? null,
	aiGenerationLanguage: settings?.aiGenerationLanguage ?? null,
	defaultPlaybackSpeed: settings?.defaultPlaybackSpeed ?? null,
});

const scopedAction = (
	scopes: ReadonlySet<(typeof Agent.AgentScope)["Type"]>,
	scope: (typeof Agent.AgentScope)["Type"],
	input: Omit<ActionInput, "allowed" | "reason" | "requiredScopes"> = {},
) =>
	agentAction({
		...input,
		allowed: scopes.has(scope),
		reason: scopes.has(scope) ? null : "SCOPE_REQUIRED",
		requiredScopes: [scope],
	});

export const profileCapabilities = (
	scopes: ReadonlySet<(typeof Agent.AgentScope)["Type"]>,
) => ({
	read: scopedAction(scopes, "profile:read"),
	update: scopedAction(scopes, "profile:write", {
		confirmation: "user",
		sideEffect: "write",
	}),
	updateImage: scopedAction(scopes, "profile:write", {
		confirmation: "user",
		sideEffect: "write",
	}),
	createOrganization: scopedAction(scopes, "organizations:manage", {
		confirmation: "user",
		sideEffect: "write",
	}),
	signOutAllDevices: scopedAction(scopes, "profile:write", {
		confirmation: "user",
		sideEffect: "destructive",
	}),
	openReferrals: scopedAction(scopes, "profile:read", {
		confirmation: "browser",
		sideEffect: "external",
	}),
});

export const organizationCapabilities = (
	role: "owner" | "admin" | "member",
	scopes: ReadonlySet<(typeof Agent.AgentScope)["Type"]>,
) => {
	const manager = role === "owner" || role === "admin";
	const owner = role === "owner";
	const scopedRoleAction = (
		scope: (typeof Agent.AgentScope)["Type"],
		roleAllowed: boolean,
		input: Omit<ActionInput, "allowed" | "reason" | "requiredScopes"> = {},
	) => {
		const scopeAllowed = scopes.has(scope);
		return agentAction({
			...input,
			allowed: scopeAllowed && roleAllowed,
			reason: !scopeAllowed
				? "SCOPE_REQUIRED"
				: roleAllowed
					? null
					: "ROLE_REQUIRED",
			requiredScopes: [scope],
		});
	};
	return {
		read: scopedRoleAction("organizations:read", true),
		update: scopedRoleAction("organizations:manage", manager, {
			confirmation: "user",
			sideEffect: "write",
		}),
		manageMembers: scopedRoleAction("organizations:members", manager, {
			confirmation: "user",
			sideEffect: "external",
		}),
		manageSeats: scopedRoleAction("organizations:members", manager, {
			confirmation: "user",
			sideEffect: "write",
		}),
		manageIntegrations: scopedRoleAction("integrations:write", manager, {
			confirmation: "user",
			sideEffect: "external",
		}),
		configureS3: scopedRoleAction("integrations:write", manager, {
			confirmation: "secure_input",
			sideEffect: "external",
		}),
		connectGoogleDrive: scopedRoleAction("integrations:write", manager, {
			confirmation: "browser",
			sideEffect: "external",
		}),
		selectStorageProvider: scopedRoleAction("integrations:write", manager, {
			confirmation: "user",
			sideEffect: "write",
		}),
		manageBranding: scopedRoleAction("organizations:manage", manager, {
			confirmation: "user",
			sideEffect: "write",
		}),
		manageDomain: scopedRoleAction("organizations:manage", owner, {
			confirmation: "user",
			sideEffect: "external",
			asynchronous: true,
		}),
		manageBilling: scopedRoleAction("billing:write", owner, {
			confirmation: "browser",
			sideEffect: "paid",
		}),
		delete: scopedRoleAction("organizations:manage", owner, {
			confirmation: "browser",
			sideEffect: "destructive",
			asynchronous: true,
		}),
	};
};

export const libraryCapabilities = (
	canManage: boolean,
	scopes: ReadonlySet<(typeof Agent.AgentScope)["Type"]>,
) => {
	const scopeAllowed = scopes.has("library:write");
	const write = (destructive = false) =>
		agentAction({
			allowed: scopeAllowed && canManage,
			reason: !scopeAllowed
				? "SCOPE_REQUIRED"
				: canManage
					? null
					: "ROLE_REQUIRED",
			requiredScopes: ["library:write"],
			confirmation: "user",
			sideEffect: destructive ? "destructive" : "write",
		});
	return {
		read: scopedAction(scopes, "library:read"),
		update: write(),
		manageMembers: write(),
		delete: write(true),
	};
};

export const integrationCapabilities = (
	canManage: boolean,
	scopes: ReadonlySet<(typeof Agent.AgentScope)["Type"]>,
) => {
	const read = scopedAction(scopes, "integrations:read");
	const scopeAllowed = scopes.has("integrations:write");
	const manage = agentAction({
		allowed: scopeAllowed && canManage,
		reason: !scopeAllowed
			? "SCOPE_REQUIRED"
			: canManage
				? null
				: "ROLE_REQUIRED",
		requiredScopes: ["integrations:write"],
		confirmation: "user",
		sideEffect: "external",
	});
	return {
		read,
		update: manage,
		configureS3: { ...manage, confirmation: "secure_input" as const },
		connectGoogleDrive: { ...manage, confirmation: "browser" as const },
		selectProvider: { ...manage, sideEffect: "write" as const },
		disconnect: { ...manage, sideEffect: "destructive" as const },
	};
};

export const developerCapabilities = (
	scopes: ReadonlySet<(typeof Agent.AgentScope)["Type"]>,
) => ({
	read: scopedAction(scopes, "developer:read"),
	update: scopedAction(scopes, "developer:write", {
		confirmation: "user",
		sideEffect: "write",
	}),
	rotateSecrets: scopedAction(scopes, "developer:secrets", {
		confirmation: "user",
		sideEffect: "destructive",
	}),
	purchaseCredits: scopedAction(scopes, "billing:write", {
		confirmation: "browser",
		sideEffect: "paid",
	}),
	deleteVideos: scopedAction(scopes, "developer:write", {
		confirmation: "user",
		sideEffect: "destructive",
	}),
});

export const normalizeOrganization = (
	row: {
		id: (typeof Agent.AgentOrganization)["Type"]["id"];
		name: string;
		ownerId: (typeof Agent.AgentOrganization)["Type"]["ownerId"];
		role: string;
		hasProSeat: boolean;
		allowedEmailDomain: string | null;
		customDomain: string | null;
		domainVerifiedAt: Date | null;
		settings: Parameters<typeof agentOrganizationSettings>[0];
		icon: string | null;
		shareableLinkIcon: string | null;
		ownerSubscriptionStatus: string | null;
		ownerThirdPartySubscriptionId: string | null;
		createdAt: Date;
		updatedAt: Date;
	},
	scopes: ReadonlySet<(typeof Agent.AgentScope)["Type"]>,
): (typeof Agent.AgentOrganization)["Type"] => {
	const role =
		row.role === "owner" || row.role === "admin" ? row.role : "member";
	return {
		id: row.id,
		name: row.name,
		ownerId: row.ownerId,
		role,
		hasProSeat: row.hasProSeat,
		allowedEmailDomain: row.allowedEmailDomain,
		customDomain: row.customDomain,
		domainVerifiedAt: row.domainVerifiedAt?.toISOString() ?? null,
		icon: row.icon,
		shareableLinkIcon: row.shareableLinkIcon,
		settings: agentOrganizationSettings(row.settings),
		billing: {
			status: row.ownerSubscriptionStatus,
			plan:
				row.ownerThirdPartySubscriptionId !== null ||
				["active", "trialing", "complete", "paid"].includes(
					row.ownerSubscriptionStatus ?? "",
				)
					? "pro"
					: "free",
		},
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
		capabilities: organizationCapabilities(role, scopes),
	};
};

export const encodeNotificationCursor = (cursor: {
	createdAt: Date;
	id: string;
}) =>
	Buffer.from(
		JSON.stringify({
			createdAt: cursor.createdAt.toISOString(),
			id: cursor.id,
		}),
		"utf8",
	).toString("base64url");

export const decodeNotificationCursor = (value: string | undefined) => {
	if (!value) return null;
	if (value.length > 1_024) return undefined;
	try {
		const parsed: unknown = JSON.parse(
			Buffer.from(value, "base64url").toString("utf8"),
		);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return undefined;
		}
		const { createdAt, id } = parsed as Record<string, unknown>;
		if (
			typeof createdAt !== "string" ||
			typeof id !== "string" ||
			!/^[A-Za-z0-9_-]{5,128}$/.test(id)
		) {
			return undefined;
		}
		const date = new Date(createdAt);
		if (Number.isNaN(date.valueOf()) || date.toISOString() !== createdAt) {
			return undefined;
		}
		return { createdAt: date, id };
	} catch {
		return undefined;
	}
};
