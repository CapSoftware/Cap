import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Agent, Organisation, User, Video } from "@cap/web-domain";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

const capability = { allowed: true, reason: null } as const;

const status = {
	id: Video.VideoId.make("cap_synthetic_1"),
	overall: "ready" as const,
	upload: { status: "complete" as const, reason: null, retryable: false },
	transcript: { status: "complete" as const, reason: null, retryable: false },
	ai: { status: "complete" as const, reason: null, retryable: false },
	updatedAt: "2026-07-18T12:00:00.000Z",
};

describe("agent API contract", () => {
	it("verifies credentials online and rate limits authorization boundaries", () => {
		const contract = readFileSync(
			join(process.cwd(), "../../packages/web-domain/src/Agent.ts"),
			"utf8",
		);
		const route = readFileSync(
			join(process.cwd(), "app/api/v1/[...route]/route.ts"),
			"utf8",
		);
		const authorize = readFileSync(
			join(process.cwd(), "app/cli/authorize/page.tsx"),
			"utf8",
		);
		expect(contract).toContain('HttpApiEndpoint.get("getAuthStatus"');
		expect(route).toContain('.handle("getAuthStatus"');
		expect(route).toContain("RATE_LIMIT_IDS.AGENT_TOKEN_EXCHANGE");
		expect(authorize).toContain("RATE_LIMIT_IDS.AGENT_AUTHORIZATION");
	});

	it("keeps every GET handler free of processing and mutation entry points", () => {
		const source = readFileSync(
			join(process.cwd(), "app/api/v1/[...route]/route.ts"),
			"utf8",
		);
		const readImplementationSource = source.slice(
			source.indexOf("const getViewableCap"),
			source.indexOf("const unlockCap"),
		);
		const readHandlerSource = source.slice(
			source.indexOf('.handle("listCaps"'),
			source.indexOf('.handle("unlockCap"'),
		);
		for (const forbidden of [
			"startVideoProcessingWorkflow",
			"generate-ai",
			"generateAi",
			"Workflows",
			".putObject(",
			".insert(",
			".update(",
			".delete(",
		]) {
			expect(readImplementationSource).not.toContain(forbidden);
			expect(readHandlerSource).not.toContain(forbidden);
		}
		expect(source).toContain("export const GET = handler");
		expect(source).toContain("export const OPTIONS = handler");
		expect(source).toContain("export const POST = handler");
		expect(source).toContain("export const PATCH = handler");
		expect(source).toContain("export const PUT = handler");
		expect(source).toContain("export const DELETE = handler");
	});

	it("pins list execution to two bounded query phases", () => {
		const source = readFileSync(
			join(process.cwd(), "app/api/v1/[...route]/route.ts"),
			"utf8",
		);
		const listSource = source.slice(
			source.indexOf("const listCaps"),
			source.indexOf("const readTranscript"),
		);

		expect(listSource.match(/database\.use/g)).toHaveLength(1);
		expect(listSource.match(/getSpaceRules/g)).toHaveLength(1);
		expect(listSource).toContain(
			"union(ownedCaps, organizationCaps, spaceCaps)",
		);
		expect(listSource).not.toContain("Effect.forEach");
		expect(listSource).not.toContain("getThumbnailURL");
		expect(listSource).not.toContain("getAnalytics");
		expect(listSource).not.toContain("getSignedObjectUrl");
	});

	it("checks viewing policy before reading password hashes", () => {
		const source = readFileSync(
			join(process.cwd(), "app/api/v1/[...route]/route.ts"),
			"utf8",
		);
		const unlockSource = source.slice(
			source.indexOf("const unlockCap"),
			source.indexOf("const requireAgentWrites"),
		);

		expect(unlockSource.indexOf("getViewableVideo(videoId)")).toBeGreaterThan(
			-1,
		);
		expect(unlockSource.indexOf("getViewableVideo(videoId)")).toBeLessThan(
			unlockSource.indexOf("Db.videos.password"),
		);
	});

	it("decodes lightweight cap summaries without heavy media fields", () => {
		const decoded = Schema.decodeUnknownSync(Agent.AgentCapSummary)({
			id: Video.VideoId.make("cap_synthetic_1"),
			shareUrl: "https://cap.so/s/cap_synthetic_1",
			title: "Synthetic roadmap review",
			aiTitle: "Roadmap review",
			createdAt: "2026-07-18T11:00:00.000Z",
			updatedAt: "2026-07-18T12:00:00.000Z",
			durationMs: 188_000,
			owner: {
				id: User.UserId.make("user_synthetic_owner"),
				name: "Synthetic Owner",
			},
			organizationId: Organisation.OrganisationId.make("org_synthetic"),
			folderId: null,
			access: "owned",
			sharing: { public: true, protected: false },
			counts: { comments: 2, reactions: 1 },
			status,
			capabilities: {
				view: capability,
				summary: capability,
				chapters: capability,
				transcript: capability,
				comments: capability,
				reactions: capability,
				download: capability,
				comment: capability,
				react: capability,
				editTitle: capability,
				editVisibility: capability,
				processTranscript: capability,
				processAi: capability,
				editTranscript: capability,
				editPassword: capability,
				duplicate: capability,
				delete: capability,
			},
		});

		expect(decoded.id).toBe("cap_synthetic_1");
		expect(decoded).not.toHaveProperty("thumbnailUrl");
		expect(decoded).not.toHaveProperty("transcript");
		expect(decoded).not.toHaveProperty("downloadUrl");
	});

	it("pins structured retry metadata on stable errors", () => {
		const decoded = Schema.decodeUnknownSync(Agent.AgentApiError)({
			_tag: "AgentNotReadyError",
			code: "NOT_READY",
			message: "Transcript is not ready",
			retryable: true,
			retryAfterMs: 2_000,
			requestId: "request_synthetic_1",
		});

		expect(decoded.code).toBe("NOT_READY");
		expect(decoded.retryAfterMs).toBe(2_000);
	});

	it("keeps transcript format vocabulary stable", () => {
		for (const format of ["text", "json", "vtt"] as const) {
			expect(
				Schema.decodeUnknownSync(Agent.AgentTranscriptParams)({ format })
					.format,
			).toBe(format);
		}
		expect(() =>
			Schema.decodeUnknownSync(Agent.AgentTranscriptParams)({ format: "srt" }),
		).toThrow();
	});

	it("pins asynchronous destructive operation state", () => {
		const operation = Schema.decodeUnknownSync(Agent.AgentOperationResponse)({
			id: "operation_123",
			kind: "delete_cap",
			state: "running",
			resourceId: Video.VideoId.make("cap_synthetic_1"),
			resultResourceId: null,
			result: null,
			error: null,
			createdAt: "2026-07-18T12:00:00.000Z",
			updatedAt: "2026-07-18T12:00:01.000Z",
			completedAt: null,
			requestId: "request_synthetic_1",
		});

		expect(operation.state).toBe("running");
	});

	it("keeps destructive storage work retry-safe and confirmation-gated", () => {
		const route = readFileSync(
			join(process.cwd(), "app/api/v1/[...route]/route.ts"),
			"utf8",
		);
		const workflow = readFileSync(
			join(process.cwd(), "workflows/agent-cap-operation.ts"),
			"utf8",
		);
		expect(route).toContain('request.headers["x-cap-confirmation"]');
		expect(route).toContain("requireUserConfirmedRequest");
		expect(workflow.indexOf("await deleteCapObjects")).toBeLessThan(
			workflow.indexOf("await deleteCapDatabase"),
		);
		expect(workflow.indexOf("await copyCapObjects")).toBeLessThan(
			workflow.indexOf("await createDuplicate"),
		);
	});

	it("keeps organization hierarchy enforcement in agent member mutations", () => {
		const source = readFileSync(
			join(process.cwd(), "app/api/v1/[...route]/route.ts"),
			"utf8",
		);
		const memberSource = source.slice(
			source.indexOf('.handle("updateOrganizationMember"'),
			source.indexOf('.handle("updateMe"'),
		);
		expect(memberSource).toContain("canChangeOrganizationMemberRole");
		expect(memberSource).toContain("canRemoveOrganizationMember");
		expect(memberSource).toContain("Db.spaceMembers");
	});

	it("ignores tombstones during organization creation", () => {
		const source = readFileSync(
			join(process.cwd(), "app/api/v1/[...route]/route.ts"),
			"utf8",
		);
		const organizationStart = source.indexOf('.handle("createOrganization"');
		const organizationSource = source.slice(
			organizationStart,
			source.indexOf('.handle("updateOrganization"', organizationStart),
		);

		expect(organizationSource).toContain(
			"isNull(Db.organizations.tombstoneAt)",
		);
		expect(organizationSource).toMatch(
			/deterministicAgentId\(\s*"organization",\s*principal\.id,\s*idempotencyKey,/,
		);
		expect(organizationSource).toContain("organization.tombstoneAt !== null");
	});

	it("stores only developer key identifiers in idempotency responses", () => {
		const source = readFileSync(
			join(process.cwd(), "app/api/v1/[...route]/route.ts"),
			"utf8",
		);
		const developerSource = source.slice(
			source.indexOf('.handle("createDeveloperApp"'),
			source.indexOf('.handle("getOperation"'),
		);
		expect(developerSource).toContain(
			"response: { appId, publicKeyId, secretKeyId }",
		);
		expect(developerSource).not.toContain(
			"response: { appId, publicKey: publicKeyRaw",
		);
		expect(developerSource).toContain("readDeveloperCredentials");
	});

	it("keeps image and S3 secret material out of idempotency records", () => {
		const source = readFileSync(
			join(process.cwd(), "app/api/v1/[...route]/route.ts"),
			"utf8",
		);
		const imageSource = source.slice(
			source.indexOf("const updateAgentImage"),
			source.indexOf("const queueAgentCapOperation"),
		);
		const s3Source = source.slice(
			source.indexOf('.handle("updateOrganizationS3"'),
			source.indexOf('.handle("removeOrganizationS3"'),
		);

		expect(imageSource).toContain('sha256: createHash("sha256")');
		expect(imageSource).not.toContain("data: input.payload.data");
		expect(s3Source).toContain("accessKeyIdHash");
		expect(s3Source).toContain("secretAccessKeyHash");
		expect(s3Source).not.toContain("accessKeyId: config.accessKeyId");
		expect(s3Source).not.toContain("secretAccessKey: config.secretAccessKey");
	});

	it("delivers organization invites with provider idempotency", () => {
		const source = readFileSync(
			join(process.cwd(), "app/api/v1/[...route]/route.ts"),
			"utf8",
		);
		const inviteSource = source.slice(
			source.indexOf('.handle("createOrganizationInvite"'),
			source.indexOf('.handle("deleteOrganizationInvite"'),
		);

		expect(inviteSource).toContain("payload.sendEmail ?? true");
		expect(inviteSource).toContain(
			'operation: "send_organization_invite_email"',
		);
		expect(inviteSource).toContain("idempotencyKey: providerIdempotencyKey");
		expect(inviteSource).toContain('emailDelivery: "accepted"');
	});

	it("requires explicit confirmation for agent-authored activity and metadata", () => {
		const source = readFileSync(
			join(process.cwd(), "app/api/v1/[...route]/route.ts"),
			"utf8",
		);
		const mutationSource = source.slice(
			source.indexOf('.handle("createComment"'),
			source.indexOf("const AgentManagementHandlersLive"),
		);

		expect(mutationSource.match(/requireUserConfirmedRequest/g)).toHaveLength(
			4,
		);
	});

	it("advertises granular dashboard-parity confirmations", () => {
		const source = readFileSync(
			join(process.cwd(), "lib/agent-management.ts"),
			"utf8",
		);

		expect(source).toContain("createOrganization: scopedAction");
		expect(source).toContain("configureS3: scopedRoleAction");
		expect(source).toContain('confirmation: "secure_input"');
		expect(source).toContain("connectGoogleDrive: scopedRoleAction");
		expect(source).toContain("purchaseCredits: scopedAction");
		expect(source).toContain("signOutAllDevices: scopedAction");
		expect(source).toContain("openReferrals: scopedAction");
	});

	it("keeps normal Google Drive callbacks while isolating CLI completion", () => {
		const source = readFileSync(
			join(process.cwd(), "app/api/desktop/[...route]/storage.ts"),
			"utf8",
		);

		expect(source).toContain(
			'const orgRedirectUrl = "/dashboard/settings/organization/integrations"',
		);
		expect(source).toContain(
			'const agentSuccessRedirectUrl = "/cli/complete?googleDrive=connected"',
		);
		expect(source).toContain(
			'const agentCancelledRedirectUrl = "/cli/complete?googleDrive=cancelled"',
		);
		expect(source).toContain("? agentSuccessRedirectUrl");
		expect(source).toContain("? agentCancelledRedirectUrl");
	});

	it("keeps developer video inventory bounded and secret-free", () => {
		const source = readFileSync(
			join(process.cwd(), "../../packages/web-backend/src/AgentManagement.ts"),
			"utf8",
		);
		const listSource = source.slice(
			source.indexOf("listDeveloperVideos: Effect.fn"),
			source.indexOf("listDeveloperTransactions: Effect.fn"),
		);

		expect(listSource).toContain(".limit(limit + 1)");
		expect(listSource).not.toContain("s3Key:");
		expect(listSource).not.toContain("metadata:");

		const decoded = Schema.decodeUnknownSync(
			Agent.AgentDeveloperVideosResponse,
		)({
			videos: [
				{
					id: "video_synthetic",
					appId: "app_synthetic",
					externalUserId: "customer_synthetic",
					name: "Synthetic SDK video",
					durationSeconds: 30,
					width: 1920,
					height: 1080,
					fps: 30,
					transcriptionStatus: "COMPLETE",
					createdAt: "2026-07-18T12:00:00.000Z",
					updatedAt: "2026-07-18T12:01:00.000Z",
					capabilities: {},
				},
			],
			nextCursor: null,
			requestId: "request_synthetic",
		});
		expect(decoded.videos[0]?.id).toBe("video_synthetic");
	});

	it("bounds folder deletion traversal", () => {
		const source = readFileSync(
			join(process.cwd(), "app/api/v1/[...route]/route.ts"),
			"utf8",
		);
		const deleteFolderStart = source.indexOf('.handle("deleteFolder"');
		const deleteFolderSource = source.slice(
			deleteFolderStart,
			source.indexOf('.handle("createSpace"', deleteFolderStart),
		);

		expect(deleteFolderSource).toContain("const seenFolderIds = new Set");
		expect(deleteFolderSource).not.toContain("folderIds.includes");
	});

	it("validates and atomically merges public collection customization", () => {
		const source = readFileSync(
			join(process.cwd(), "app/api/v1/[...route]/route.ts"),
			"utf8",
		);
		const updateSource = source.slice(
			source.indexOf("const updateAgentCollectionPublicPage"),
			source.indexOf("const queueAgentCapOperation"),
		);

		expect(updateSource).toContain("AgentCollectionPublicPageInput");
		expect(updateSource).toContain("JSON_MERGE_PATCH");
		expect(updateSource).toContain("Cap Pro is required");
		expect(updateSource).toContain("getFolderAccess");
		expect(updateSource).toContain("getSpaceAccess");

		expect(
			Schema.decodeUnknownSync(Agent.AgentCollectionPublicPageInput)({
				public: true,
				title: "Synthetic collection",
				layout: "grid",
				gridColumns: 4,
			}),
		).toMatchObject({ public: true, gridColumns: 4 });
		expect(() =>
			Schema.decodeUnknownSync(Agent.AgentCollectionPublicPageInput)({
				gridColumns: 6,
			}),
		).toThrow();

		const publicPage = {
			title: "Synthetic collection",
			layout: "grid" as const,
			gridColumns: 4 as const,
		};
		const folderResponse = Schema.decodeUnknownSync(Agent.AgentFoldersResponse)(
			{
				folders: [
					{
						id: "folder_synthetic",
						name: "Synthetic folder",
						color: "normal",
						public: true,
						organizationId: "org_synthetic",
						createdById: "user_synthetic",
						parentId: null,
						spaceId: null,
						settings: { publicPage },
						publicPage,
						createdAt: "2026-07-18T12:00:00.000Z",
						updatedAt: "2026-07-18T12:00:00.000Z",
						capabilities: {},
					},
				],
				requestId: "request_synthetic",
			},
		);
		const spaceResponse = Schema.decodeUnknownSync(Agent.AgentSpacesResponse)({
			spaces: [
				{
					id: "space_synthetic",
					name: "Synthetic space",
					description: null,
					organizationId: "org_synthetic",
					createdById: "user_synthetic",
					primary: false,
					privacy: "Public",
					public: true,
					protected: false,
					icon: null,
					settings: {
						disableSummary: null,
						disableCaptions: null,
						disableChapters: null,
						disableReactions: null,
						disableTranscript: null,
						disableComments: null,
						defaultPlaybackSpeed: null,
					},
					publicPage,
					role: "admin",
					counts: { members: 1, caps: 2, folders: 3 },
					createdAt: "2026-07-18T12:00:00.000Z",
					updatedAt: "2026-07-18T12:00:00.000Z",
					capabilities: {},
				},
			],
			requestId: "request_synthetic",
		});

		expect(folderResponse.folders[0]?.publicPage).toEqual(publicPage);
		expect(spaceResponse.spaces[0]?.publicPage).toEqual(publicPage);
	});

	it("queues Loom imports without persisting download URLs", () => {
		const route = readFileSync(
			join(process.cwd(), "app/api/v1/[...route]/route.ts"),
			"utf8",
		);
		const workflow = readFileSync(
			join(process.cwd(), "workflows/import-loom-video.ts"),
			"utf8",
		);
		const importSource = route.slice(
			route.indexOf("const queueAgentLoomImport"),
			route.indexOf("const normalizeTranscriptCues"),
		);

		expect(importSource).toContain('operation: "import_loom"');
		expect(importSource).toContain('kind: "import_loom"');
		expect(importSource).toContain("agentOperationId: operationId");
		expect(importSource).not.toContain("loomDownloadUrl:");
		expect(workflow).toContain("claimAgentImport");
		expect(workflow).toContain("completeAgentImport");
		expect(workflow).toContain("failAgentImport");
	});
});
