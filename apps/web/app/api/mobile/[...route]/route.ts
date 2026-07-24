import crypto from "node:crypto";
import { authOptions } from "@cap/database/auth/auth-options";
import { isEmailAllowedForSignup } from "@cap/database/auth/domain-utils";
import { hashPassword } from "@cap/database/crypto";
import { sendEmail } from "@cap/database/emails/config";
import { OTPEmail } from "@cap/database/emails/otp-email";
import { nanoId } from "@cap/database/helpers";
import * as Db from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import { userIsPro } from "@cap/utils";
import {
	Database,
	findScreenshotObjectKey,
	getCurrentUser,
	ImageUploads,
	Storage,
	Videos,
	VideosRepo,
} from "@cap/web-backend";
import {
	Comment,
	CurrentUser,
	Folder,
	Mobile,
	type Organisation,
	Space,
	User,
	Video,
} from "@cap/web-domain";
import {
	HttpApiBuilder,
	HttpApiError,
	HttpServerResponse,
} from "@effect/platform";
import type * as HttpServerRequest from "@effect/platform/HttpServerRequest";
import {
	and,
	count,
	desc,
	eq,
	exists,
	inArray,
	isNotNull,
	isNull,
	or,
	sql,
} from "drizzle-orm";
import { Effect, Layer, Option } from "effect";
import { revalidatePath } from "next/cache";
import { start } from "workflow/api";
import { downloadLoomVideo } from "@/actions/loom";
import { getOrgAnalyticsData } from "@/app/(org)/dashboard/analytics/data";
import {
	createAccountDeletionRequest,
	createMobileContentReport,
	hasPendingAccountDeletion,
} from "@/lib/account-deletion-request";
import { queueDesktopSegmentsFinalization } from "@/lib/desktop-segments-finalization";
import {
	resolveMobileRequestOrigin,
	resolveMobileWebResourceUrl,
} from "@/lib/mobile-request-origin";
import { createNotification } from "@/lib/Notification";
import { isRateLimited, RATE_LIMIT_IDS } from "@/lib/rate-limit";
import { apiToHandler } from "@/lib/server";
import { startVideoProcessingWorkflow } from "@/lib/video-processing";
import { importLoomVideoWorkflow } from "@/workflows/import-loom-video";

export const dynamic = "force-dynamic";

type CapRow = {
	id: Video.VideoId;
	ownerId: User.UserId;
	ownerPreferences: unknown;
	name: string;
	createdAt: Date;
	updatedAt: Date;
	ownerName: string | null;
	duration: number | null;
	folderId: Folder.FolderId | null;
	public: boolean;
	hasPassword: boolean;
	hasInheritedPassword: boolean;
	commentCount: number;
	reactionCount: number;
	uploadVideoId: Video.VideoId | null;
	uploadUploaded: number | null;
	uploadTotal: number | null;
	uploadPhase: Video.UploadPhase | null;
	processingProgress: number | null;
	processingMessage: string | null;
	processingError: string | null;
	metadata: unknown;
	transcriptionStatus:
		| "PROCESSING"
		| "COMPLETE"
		| "ERROR"
		| "SKIPPED"
		| "NO_AUDIO"
		| null;
};

type MobileCapSummary = (typeof Mobile.MobileCapSummary)["Type"];
type MobileFolder = (typeof Mobile.MobileFolder)["Type"];
type MobileOrganization = (typeof Mobile.MobileOrganization)["Type"];
type MobileSpace = (typeof Mobile.MobileSpace)["Type"];
type MobileFolderCreateInput = (typeof Mobile.MobileFolderCreateInput)["Type"];
type MobileUploadCreateInput = (typeof Mobile.MobileUploadCreateInput)["Type"];
type MobileRecordingCreateInput =
	(typeof Mobile.MobileRecordingCreateInput)["Type"];
type MobileRecordingCompleteInput =
	(typeof Mobile.MobileRecordingCompleteInput)["Type"];
type MobileOrganizationSettings =
	(typeof Mobile.MobileOrganizationSettings)["Type"];
type MobileOrganizationSettingsInput =
	(typeof Mobile.MobileOrganizationSettingsInput)["Type"];
type MobileOrganizationIconInput =
	(typeof Mobile.MobileOrganizationIconInput)["Type"];
type MobileProfileInput = (typeof Mobile.MobileProfileInput)["Type"];
type MobileProfileImageInput = (typeof Mobile.MobileProfileImageInput)["Type"];

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const emailCodePattern = /^\d{6}$/;
const emailCodeTtlMs = 10 * 60 * 1000;
const mobileImageMaxBytes = 1024 * 1024;
const mobileImageTypes = new Set(["image/jpeg", "image/png"]);
const domainPattern =
	/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

const toIsoString = (value: Date) => value.toISOString();

const normalizeEmail = (email: string) => email.trim().toLowerCase();

const getMobileEmailVerificationIdentifier = (email: string) =>
	`mobile:${crypto.createHash("sha256").update(email).digest("hex")}`;

const getAffectedRows = (result: unknown) => {
	if (Array.isArray(result)) {
		return (
			(result[0] as { affectedRows?: number } | undefined)?.affectedRows ?? 0
		);
	}

	return (result as { affectedRows?: number } | undefined)?.affectedRows ?? 0;
};

const hashEmailCode = (code: string) =>
	crypto
		.createHash("sha256")
		.update(`${code}${serverEnv().NEXTAUTH_SECRET}`)
		.digest("hex");

const sendMobileEmailCode = async (email: string, code: string) => {
	if (!serverEnv().RESEND_API_KEY) {
		if (process.env.NODE_ENV === "production") {
			throw new Error("RESEND_API_KEY is required to send mobile email codes");
		}
		console.log("");
		console.log("Cap mobile verification code");
		console.log(`Email: ${email}`);
		console.log(`Code: ${code}`);
		console.log("Expires in: 10 minutes");
		console.log("");
		return;
	}

	await sendEmail({
		email,
		subject: "Your Cap Verification Code",
		react: OTPEmail({ code, email }),
	});
};

const getMobileRedirectUrl = (redirectUri: string) => {
	try {
		const redirectUrl = new URL(redirectUri);
		if (!Mobile.isMobileAuthRedirectUri(redirectUri)) return null;
		return redirectUrl;
	} catch {
		return null;
	}
};

const getEmailAuthAdapter = () => {
	const adapter = authOptions().adapter;
	const { createUser, getUserByEmail, updateUser } = adapter ?? {};

	if (!createUser || !getUserByEmail || !updateUser) {
		throw new Error("Email auth adapter is not configured");
	}

	return { createUser, getUserByEmail, updateUser };
};

const createOrUpdateEmailUser = async (email: string) => {
	const { createUser, getUserByEmail, updateUser } = getEmailAuthAdapter();
	const existingUser = await getUserByEmail(email);

	if (existingUser) {
		return updateUser({
			id: existingUser.id,
			emailVerified: new Date(),
		});
	}

	return createUser({
		email,
		emailVerified: new Date(),
		image: null,
		name: null,
	});
};

const parseBearerToken = (authorization: string | undefined) => {
	if (!authorization) return null;
	const [scheme, token] = authorization.split(" ");
	if (scheme?.toLowerCase() !== "bearer" || !token) return null;
	return token;
};

const parsePositiveInteger = (
	value: string | undefined,
	fallback: number,
	max: number,
) => {
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed < 1) return fallback;
	return Math.min(Math.trunc(parsed), max);
};

const getMetadataRecord = (metadata: unknown): Record<string, unknown> => {
	if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
		return {};
	}
	return metadata as Record<string, unknown>;
};

const getMetadataString = (metadata: Record<string, unknown>, key: string) => {
	const value = metadata[key];
	return typeof value === "string" && value.length > 0 ? value : null;
};

const getMetadataChapters = (metadata: Record<string, unknown>) => {
	const chapters = metadata.chapters;
	if (!Array.isArray(chapters)) return [];

	return chapters.flatMap((chapter) => {
		if (!chapter || typeof chapter !== "object" || Array.isArray(chapter)) {
			return [];
		}
		const value = chapter as Record<string, unknown>;
		const title = value.title;
		const start = value.start;
		if (typeof title !== "string" || typeof start !== "number") return [];
		return [{ title, start }];
	});
};

const getDeploymentOrigin = () => {
	const webUrl = serverEnv().WEB_URL;
	const vercelEnv = serverEnv().VERCEL_ENV;

	if (!vercelEnv || vercelEnv === "production") return webUrl;

	if (vercelEnv === "preview") {
		const branchHost = serverEnv().VERCEL_BRANCH_URL_HOST;
		if (branchHost?.endsWith(".vercel.app")) return `https://${branchHost}`;
	}

	return webUrl;
};

const getMobilePublicOrigin = (
	request: HttpServerRequest.HttpServerRequest,
) => {
	const requestHost =
		request.headers["x-forwarded-host"] ?? request.headers.host;
	let requestUrl = request.originalUrl;
	if (requestHost) {
		try {
			const url = new URL(requestUrl);
			url.host = requestHost.split(",")[0]?.trim() ?? url.host;
			requestUrl = url.toString();
		} catch {
			requestUrl = request.originalUrl;
		}
	}

	return resolveMobileRequestOrigin(
		getDeploymentOrigin(),
		requestUrl,
		requestHost,
	);
};

const getFileExtension = (input: MobileUploadCreateInput) => {
	const fileNameExtension = input.fileName.split(".").at(-1)?.toLowerCase();
	if (
		fileNameExtension &&
		fileNameExtension !== input.fileName.toLowerCase() &&
		/^[a-z0-9]+$/.test(fileNameExtension)
	) {
		return fileNameExtension;
	}

	if (input.contentType.includes("quicktime")) return "mov";
	if (input.contentType.includes("webm")) return "webm";
	if (input.contentType.includes("matroska")) return "mkv";
	if (input.contentType.includes("x-msvideo")) return "avi";
	if (input.contentType.includes("x-m4v")) return "m4v";
	return "mp4";
};

const getUploadTitle = (fileName: string) => {
	const title = fileName.replace(/\.[^/.]+$/, "").trim();
	return title.length > 0 ? title : "Mobile Upload";
};

const toMobileCapSummary = (
	row: CapRow,
	viewCount: number,
	publicOrigin: string,
	currentUserId: User.UserId,
): MobileCapSummary => {
	const hasThumbnail =
		(!row.uploadVideoId || row.uploadPhase === "complete") &&
		(row.ownerId === currentUserId ||
			(!row.hasPassword && !row.hasInheritedPassword));
	const thumbnailVersion = row.updatedAt.getTime();
	return {
		id: row.id,
		ownerId: row.ownerId,
		shareUrl: `${publicOrigin}/s/${row.id}`,
		title: row.name,
		createdAt: toIsoString(row.createdAt),
		updatedAt: toIsoString(row.updatedAt),
		ownerName: row.ownerName ?? "",
		durationSeconds: row.duration,
		thumbnailUrl: hasThumbnail
			? `${publicOrigin}/api/mobile/caps/${encodeURIComponent(row.id)}/thumbnail?v=${thumbnailVersion}`
			: null,
		thumbnailCacheKey: hasThumbnail
			? `cap-thumbnail:${row.id}:${thumbnailVersion}`
			: null,
		folderId: row.folderId,
		public: row.public,
		protected: row.hasPassword || row.hasInheritedPassword,
		viewCount,
		commentCount: Number(row.commentCount),
		reactionCount: Number(row.reactionCount),
		upload:
			row.uploadVideoId && row.uploadPhase !== "complete"
				? {
						uploaded: Number(row.uploadUploaded ?? 0),
						total: Number(row.uploadTotal ?? 0),
						phase: row.uploadPhase ?? "uploading",
						processingProgress: Number(row.processingProgress ?? 0),
						processingMessage: row.processingMessage,
						processingError: row.processingError,
					}
				: null,
		ownedByCurrentUser: row.ownerId === currentUserId,
	};
};

const withMappedErrors = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
	effect.pipe(
		Effect.catchTags({
			DatabaseError: () => Effect.fail(new HttpApiError.InternalServerError()),
			NoSuchElementException: () => Effect.fail(new HttpApiError.NotFound()),
			PolicyDenied: () => Effect.fail(new HttpApiError.Forbidden()),
			S3Error: () => Effect.fail(new HttpApiError.InternalServerError()),
			StorageError: () => Effect.fail(new HttpApiError.InternalServerError()),
			UnknownException: () =>
				Effect.fail(new HttpApiError.InternalServerError()),
			VerifyVideoPasswordError: () => Effect.fail(new HttpApiError.Forbidden()),
			VideoNotFoundError: () => Effect.fail(new HttpApiError.NotFound()),
		}),
	);

const getMobileThumbnailUrl = Effect.fn("Mobile.getThumbnailUrl")(function* (
	videoId: Video.VideoId,
) {
	const repo = yield* VideosRepo;
	const storage = yield* Storage;
	const maybeVideo = yield* repo.getById(videoId);
	if (Option.isNone(maybeVideo)) return null;

	const [video] = maybeVideo.value;
	const [bucket] = yield* storage.getAccessForVideo(video);
	const response = yield* bucket.listObjects({
		prefix: `${video.ownerId}/${video.id}/`,
	});
	const thumbnailKey = findScreenshotObjectKey(response.Contents ?? []);
	if (!thumbnailKey) return null;
	return yield* bucket.getSignedObjectUrl(thumbnailKey);
});

const ensureEmailSignInAllowed = Effect.fn("Mobile.ensureEmailSignInAllowed")(
	function* (email: string) {
		if (!emailPattern.test(email)) {
			return yield* Effect.fail(new HttpApiError.BadRequest());
		}

		const allowedDomains = serverEnv().CAP_ALLOWED_SIGNUP_DOMAINS;
		if (!allowedDomains) return;

		const database = yield* Database;
		const [existingUser] = yield* database.use((db) =>
			db
				.select({ id: Db.users.id })
				.from(Db.users)
				.where(eq(Db.users.email, email))
				.limit(1),
		);

		if (!existingUser && !isEmailAllowedForSignup(email, allowedDomains)) {
			return yield* Effect.fail(new HttpApiError.Forbidden());
		}
	},
);

const ensureAccountDeletionNotPending = Effect.fn(
	"Mobile.ensureAccountDeletionNotPending",
)(function* (identity: { userId?: User.UserId; email?: string }) {
	const pending = yield* Effect.tryPromise({
		try: () => hasPendingAccountDeletion(identity),
		catch: () => new HttpApiError.InternalServerError(),
	});
	if (pending) {
		return yield* Effect.fail(new HttpApiError.Forbidden());
	}
});

const createMobileApiKey = Effect.fn("Mobile.createMobileApiKey")(function* (
	userId: User.UserId,
) {
	yield* ensureAccountDeletionNotPending({ userId });
	const database = yield* Database;
	const apiKey = crypto.randomUUID();
	yield* database.use((db) =>
		db.transaction(async (tx) => {
			await tx
				.delete(Db.authApiKeys)
				.where(
					and(
						eq(Db.authApiKeys.userId, userId),
						eq(Db.authApiKeys.source, "mobile"),
					),
				);
			await tx.insert(Db.authApiKeys).values({
				id: apiKey,
				userId,
				source: "mobile",
			});
		}),
	);

	return {
		type: "api_key" as const,
		apiKey,
		userId,
	};
});

const requestEmailSession = Effect.fn("Mobile.requestEmailSession")(function* (
	rawEmail: string,
) {
	const email = normalizeEmail(rawEmail);
	yield* ensureEmailSignInAllowed(email);
	yield* ensureAccountDeletionNotPending({ email });

	const code = crypto.randomInt(100000, 1000000).toString();
	const token = hashEmailCode(code);
	const expires = new Date(Date.now() + emailCodeTtlMs);
	const identifier = getMobileEmailVerificationIdentifier(email);
	const database = yield* Database;

	yield* database.use(async (db) => {
		const [existingToken] = await db
			.select({ identifier: Db.verificationTokens.identifier })
			.from(Db.verificationTokens)
			.where(eq(Db.verificationTokens.identifier, identifier))
			.limit(1);

		if (existingToken) {
			await db
				.update(Db.verificationTokens)
				.set({ token, expires })
				.where(eq(Db.verificationTokens.identifier, identifier));
			return;
		}

		await db.insert(Db.verificationTokens).values({
			identifier,
			token,
			expires,
		});
	});

	yield* Effect.tryPromise({
		try: () => sendMobileEmailCode(email, code),
		catch: () => new HttpApiError.InternalServerError(),
	});

	return { success: true as const };
});

const verifyEmailSession = Effect.fn("Mobile.verifyEmailSession")(function* ({
	email: rawEmail,
	code: rawCode,
}: (typeof Mobile.MobileEmailSessionVerifyInput)["Type"]) {
	const email = normalizeEmail(rawEmail);
	const code = rawCode.trim();

	if (!emailPattern.test(email) || !emailCodePattern.test(code)) {
		return yield* Effect.fail(new HttpApiError.BadRequest());
	}

	yield* ensureEmailSignInAllowed(email);
	yield* ensureAccountDeletionNotPending({ email });

	const database = yield* Database;
	const token = hashEmailCode(code);
	const identifier = getMobileEmailVerificationIdentifier(email);
	const verificationStatus = yield* database.use(async (db) => {
		const [verificationToken] = await db
			.select()
			.from(Db.verificationTokens)
			.where(eq(Db.verificationTokens.identifier, identifier))
			.limit(1);

		if (!verificationToken) return "missing" as const;

		if (verificationToken.expires.valueOf() < Date.now()) {
			await db
				.delete(Db.verificationTokens)
				.where(eq(Db.verificationTokens.identifier, identifier));
			return "expired" as const;
		}

		if (verificationToken.token !== token) {
			await db
				.delete(Db.verificationTokens)
				.where(eq(Db.verificationTokens.identifier, identifier));
			return "invalid" as const;
		}

		const result = await db
			.delete(Db.verificationTokens)
			.where(
				and(
					eq(Db.verificationTokens.identifier, identifier),
					eq(Db.verificationTokens.token, token),
				),
			);

		return getAffectedRows(result) === 1
			? ("verified" as const)
			: ("used" as const);
	});

	if (verificationStatus !== "verified") {
		return yield* Effect.fail(new HttpApiError.Forbidden());
	}

	const user = yield* Effect.tryPromise({
		try: () => createOrUpdateEmailUser(email),
		catch: () => new HttpApiError.InternalServerError(),
	});

	return yield* createMobileApiKey(User.UserId.make(user.id));
});

const requestAccountDeletion = Effect.fn("Mobile.requestAccountDeletion")(
	function* () {
		const user = yield* CurrentUser;
		yield* Effect.tryPromise({
			try: () =>
				createAccountDeletionRequest({
					user: {
						id: user.id,
						email: user.email,
					},
				}),
			catch: () => new HttpApiError.InternalServerError(),
		});

		const database = yield* Database;
		yield* database.use((db) =>
			db.transaction(async (tx) => {
				await tx
					.update(Db.users)
					.set({
						authSessionVersion: sql`${Db.users.authSessionVersion} + 1`,
					})
					.where(eq(Db.users.id, user.id));
				await tx.delete(Db.sessions).where(eq(Db.sessions.userId, user.id));
				await tx
					.delete(Db.authApiKeys)
					.where(eq(Db.authApiKeys.userId, user.id));
			}),
		);

		return { success: true as const };
	},
);

const getBlockedUserIds = (preferences: unknown) => {
	const value = getMetadataRecord(preferences).blockedUserIds;
	if (!Array.isArray(value)) return [];
	return Array.from(
		new Set(
			value.flatMap((userId) =>
				typeof userId === "string" && userId.length > 0
					? [User.UserId.make(userId)]
					: [],
			),
		),
	);
};

const getCurrentBlockedUserIds = Effect.fn("Mobile.getBlockedUserIds")(
	function* () {
		const user = yield* CurrentUser;
		const database = yield* Database;
		const [row] = yield* database.use((db) =>
			db
				.select({ preferences: Db.users.preferences })
				.from(Db.users)
				.where(eq(Db.users.id, user.id))
				.limit(1),
		);
		return getBlockedUserIds(row?.preferences);
	},
);

const blockMobileUser = Effect.fn("Mobile.blockUser")(function* (
	blockedUserId: User.UserId,
) {
	const user = yield* CurrentUser;
	if (blockedUserId === user.id) {
		return yield* Effect.fail(new HttpApiError.BadRequest());
	}

	const database = yield* Database;
	const [blockedUser] = yield* database.use((db) =>
		db
			.select({ id: Db.users.id })
			.from(Db.users)
			.where(eq(Db.users.id, blockedUserId))
			.limit(1),
	);
	if (!blockedUser) {
		return yield* Effect.fail(new HttpApiError.NotFound());
	}

	const currentUserFound = yield* database.use((db) =>
		db.transaction(async (tx) => {
			const [currentUser] = await tx
				.select({ preferences: Db.users.preferences })
				.from(Db.users)
				.where(eq(Db.users.id, user.id))
				.for("update");
			if (!currentUser) return false;

			const blockedUserIds = getBlockedUserIds(currentUser.preferences);
			if (!blockedUserIds.includes(blockedUserId)) {
				blockedUserIds.push(blockedUserId);
				await tx
					.update(Db.users)
					.set({
						preferences: sql`JSON_SET(COALESCE(${Db.users.preferences}, JSON_OBJECT()), '$.blockedUserIds', CAST(${JSON.stringify(blockedUserIds)} AS JSON))`,
					})
					.where(eq(Db.users.id, user.id));
			}
			return true;
		}),
	);
	if (!currentUserFound) {
		return yield* Effect.fail(new HttpApiError.NotFound());
	}

	return { success: true as const };
});

const getAccessibleOrganizations = Effect.fn(
	"Mobile.getAccessibleOrganizations",
)(function* (userId: User.UserId) {
	const database = yield* Database;
	const imageUploads = yield* ImageUploads;

	const rows = yield* database.use((db) =>
		db
			.select({
				id: Db.organizations.id,
				name: Db.organizations.name,
				ownerId: Db.organizations.ownerId,
				iconUrl: Db.organizations.iconUrl,
				role: Db.organizationMembers.role,
			})
			.from(Db.organizations)
			.leftJoin(
				Db.organizationMembers,
				and(
					eq(Db.organizationMembers.organizationId, Db.organizations.id),
					eq(Db.organizationMembers.userId, userId),
				),
			)
			.where(
				and(
					isNull(Db.organizations.tombstoneAt),
					or(
						eq(Db.organizations.ownerId, userId),
						eq(Db.organizationMembers.userId, userId),
					),
				),
			),
	);

	return yield* Effect.forEach(
		rows,
		(row) =>
			Effect.gen(function* () {
				const role: MobileOrganization["role"] =
					row.ownerId === userId ? "owner" : (row.role ?? "member");
				const iconUrl = row.iconUrl
					? yield* imageUploads.resolveImageUrl(row.iconUrl)
					: null;

				return {
					id: row.id,
					name: row.name,
					iconUrl,
					role,
				};
			}),
		{ concurrency: 5 },
	);
});

const getAccessibleSpaces = Effect.fn("Mobile.getAccessibleSpaces")(function* (
	organization: MobileOrganization,
) {
	const user = yield* CurrentUser;
	const database = yield* Database;
	const rows = yield* database.use((db) => {
		const membership = db
			.select({ role: Db.spaceMembers.role })
			.from(Db.spaceMembers)
			.where(
				and(
					eq(Db.spaceMembers.spaceId, Db.spaces.id),
					eq(Db.spaceMembers.userId, user.id),
				),
			)
			.limit(1);

		return db
			.select({
				id: Db.spaces.id,
				name: Db.spaces.name,
				privacy: Db.spaces.privacy,
				createdById: Db.spaces.createdById,
				memberRole: sql<"admin" | "member" | null>`(${membership})`,
				hasPassword: sql<boolean>`${Db.spaces.password} IS NOT NULL`.mapWith(
					Boolean,
				),
			})
			.from(Db.spaces)
			.where(
				and(
					eq(Db.spaces.organizationId, organization.id),
					or(
						eq(Db.spaces.createdById, user.id),
						eq(Db.spaces.privacy, "Public"),
						exists(membership),
					),
				),
			);
	});

	const spaces = rows.map((row) => {
		const role = row.createdById === user.id ? "admin" : row.memberRole;
		return {
			id: row.id,
			name: row.name,
			iconUrl: null,
			kind: "space" as const,
			privacy: row.privacy,
			role,
			canManage:
				organization.role === "owner" ||
				organization.role === "admin" ||
				role === "admin",
			hasPassword: row.hasPassword,
		};
	});
	const organizationSpace: MobileSpace = {
		id: organization.id,
		name: `All ${organization.name}`,
		iconUrl: organization.iconUrl,
		kind: "organization",
		privacy: "Public",
		role: organization.role,
		canManage: organization.role === "owner" || organization.role === "admin",
		hasPassword: false,
	};

	return [organizationSpace, ...spaces] satisfies MobileSpace[];
});

const getSelectedSpace = Effect.fn("Mobile.getSelectedSpace")(function* (
	spaceId: string | undefined,
) {
	if (!spaceId) return null;

	const user = yield* CurrentUser;
	const database = yield* Database;
	const [organization] = yield* database.use((db) =>
		db
			.select({
				id: Db.organizations.id,
				name: Db.organizations.name,
				ownerId: Db.organizations.ownerId,
				memberRole: Db.organizationMembers.role,
			})
			.from(Db.organizations)
			.leftJoin(
				Db.organizationMembers,
				and(
					eq(Db.organizationMembers.organizationId, Db.organizations.id),
					eq(Db.organizationMembers.userId, user.id),
				),
			)
			.where(
				and(
					eq(Db.organizations.id, user.activeOrganizationId),
					isNull(Db.organizations.tombstoneAt),
					or(
						eq(Db.organizations.ownerId, user.id),
						eq(Db.organizationMembers.userId, user.id),
					),
				),
			)
			.limit(1),
	);
	if (!organization) {
		return yield* Effect.fail(new HttpApiError.Forbidden());
	}
	const organizationRole: MobileOrganization["role"] =
		organization.ownerId === user.id
			? "owner"
			: (organization.memberRole ?? "member");
	if (spaceId === organization.id) {
		return {
			id: organization.id,
			name: `All ${organization.name}`,
			iconUrl: null,
			kind: "organization" as const,
			privacy: "Public" as const,
			role: organizationRole,
			canManage: organizationRole === "owner" || organizationRole === "admin",
			hasPassword: false,
		};
	}
	const selectedSpaceId = Space.SpaceId.make(spaceId);

	const [space] = yield* database.use((db) => {
		const membership = db
			.select({ role: Db.spaceMembers.role })
			.from(Db.spaceMembers)
			.where(
				and(
					eq(Db.spaceMembers.spaceId, Db.spaces.id),
					eq(Db.spaceMembers.userId, user.id),
				),
			)
			.limit(1);

		return db
			.select({
				id: Db.spaces.id,
				name: Db.spaces.name,
				privacy: Db.spaces.privacy,
				createdById: Db.spaces.createdById,
				memberRole: sql<"admin" | "member" | null>`(${membership})`,
				hasPassword: sql<boolean>`${Db.spaces.password} IS NOT NULL`.mapWith(
					Boolean,
				),
			})
			.from(Db.spaces)
			.where(
				and(
					eq(Db.spaces.id, selectedSpaceId),
					eq(Db.spaces.organizationId, organization.id),
					or(
						eq(Db.spaces.createdById, user.id),
						eq(Db.spaces.privacy, "Public"),
						exists(membership),
					),
				),
			)
			.limit(1);
	});
	if (!space) return yield* Effect.fail(new HttpApiError.Forbidden());
	const role = space.createdById === user.id ? "admin" : space.memberRole;
	return {
		id: space.id,
		name: space.name,
		iconUrl: null,
		kind: "space" as const,
		privacy: space.privacy,
		role,
		canManage:
			organizationRole === "owner" ||
			organizationRole === "admin" ||
			role === "admin",
		hasPassword: space.hasPassword,
	};
});

const getRootFolders = Effect.fn("Mobile.getRootFolders")(function* (
	organizationId: Organisation.OrganisationId,
) {
	const user = yield* CurrentUser;
	const database = yield* Database;

	const rows = yield* database.use((db) => {
		const videoCount = db
			.select({ value: count() })
			.from(Db.videos)
			.where(
				and(
					eq(Db.videos.folderId, Db.folders.id),
					eq(Db.videos.ownerId, user.id),
					eq(Db.videos.orgId, organizationId),
				),
			);

		return db
			.select({
				id: Db.folders.id,
				name: Db.folders.name,
				color: Db.folders.color,
				parentId: Db.folders.parentId,
				videoCount: sql<number>`(${videoCount})`.mapWith(Number),
			})
			.from(Db.folders)
			.where(
				and(
					eq(Db.folders.organizationId, organizationId),
					eq(Db.folders.createdById, user.id),
					isNull(Db.folders.parentId),
					isNull(Db.folders.spaceId),
				),
			);
	});

	return rows satisfies MobileFolder[];
});

const getSpaceRootFolders = Effect.fn("Mobile.getSpaceRootFolders")(function* (
	space: MobileSpace,
) {
	const user = yield* CurrentUser;
	const database = yield* Database;
	const rows = yield* database.use((db) => {
		const videoCount =
			space.kind === "organization"
				? db
						.select({ value: count() })
						.from(Db.sharedVideos)
						.where(
							and(
								eq(Db.sharedVideos.folderId, Db.folders.id),
								eq(Db.sharedVideos.organizationId, user.activeOrganizationId),
							),
						)
				: db
						.select({ value: count() })
						.from(Db.spaceVideos)
						.where(
							and(
								eq(Db.spaceVideos.folderId, Db.folders.id),
								eq(Db.spaceVideos.spaceId, space.id),
							),
						);

		return db
			.select({
				id: Db.folders.id,
				name: Db.folders.name,
				color: Db.folders.color,
				parentId: Db.folders.parentId,
				videoCount: sql<number>`(${videoCount})`.mapWith(Number),
			})
			.from(Db.folders)
			.where(
				and(
					eq(Db.folders.organizationId, user.activeOrganizationId),
					eq(Db.folders.spaceId, space.id),
					isNull(Db.folders.parentId),
				),
			);
	});

	return rows satisfies MobileFolder[];
});

const hasOrganizationAccess = Effect.fn("Mobile.hasOrganizationAccess")(
	function* (organizationId: Organisation.OrganisationId) {
		const user = yield* CurrentUser;
		const database = yield* Database;
		const [row] = yield* database.use((db) =>
			db
				.select({ id: Db.organizations.id })
				.from(Db.organizations)
				.leftJoin(
					Db.organizationMembers,
					and(
						eq(Db.organizationMembers.organizationId, Db.organizations.id),
						eq(Db.organizationMembers.userId, user.id),
					),
				)
				.where(
					and(
						eq(Db.organizations.id, organizationId),
						isNull(Db.organizations.tombstoneAt),
						or(
							eq(Db.organizations.ownerId, user.id),
							eq(Db.organizationMembers.userId, user.id),
						),
					),
				)
				.limit(1),
		);

		return Boolean(row);
	},
);

const assertOrganizationAccess = Effect.fn("Mobile.assertOrganizationAccess")(
	function* (organizationId: Organisation.OrganisationId) {
		if (!(yield* hasOrganizationAccess(organizationId))) {
			return yield* Effect.fail(new HttpApiError.Forbidden());
		}
	},
);

const getOrganizationSettings = Effect.fn("Mobile.getOrganizationSettings")(
	function* () {
		const user = yield* CurrentUser;
		const database = yield* Database;
		const imageUploads = yield* ImageUploads;
		const [row] = yield* database.use((db) =>
			db
				.select({
					id: Db.organizations.id,
					name: Db.organizations.name,
					ownerId: Db.organizations.ownerId,
					memberRole: Db.organizationMembers.role,
					iconUrl: Db.organizations.iconUrl,
					allowedEmailDomain: Db.organizations.allowedEmailDomain,
					customDomain: Db.organizations.customDomain,
					domainVerified: Db.organizations.domainVerified,
				})
				.from(Db.organizations)
				.leftJoin(
					Db.organizationMembers,
					and(
						eq(Db.organizationMembers.organizationId, Db.organizations.id),
						eq(Db.organizationMembers.userId, user.id),
					),
				)
				.where(
					and(
						eq(Db.organizations.id, user.activeOrganizationId),
						isNull(Db.organizations.tombstoneAt),
						or(
							eq(Db.organizations.ownerId, user.id),
							eq(Db.organizationMembers.userId, user.id),
						),
					),
				)
				.limit(1),
		);

		if (!row) return yield* Effect.fail(new HttpApiError.NotFound());

		const role: MobileOrganizationSettings["role"] =
			row.ownerId === user.id ? "owner" : (row.memberRole ?? "member");
		const iconUrl = row.iconUrl
			? yield* imageUploads.resolveImageUrl(row.iconUrl)
			: null;

		return {
			id: row.id,
			name: row.name,
			role,
			canManage: role === "owner" || role === "admin",
			iconUrl,
			allowedEmailDomain: row.allowedEmailDomain || null,
			customDomain: row.customDomain,
			domainVerified: Boolean(row.domainVerified),
		};
	},
);

const assertOrganizationSettingsManager = Effect.fn(
	"Mobile.assertOrganizationSettingsManager",
)(function* () {
	const settings = yield* getOrganizationSettings();
	if (!settings.canManage) {
		return yield* Effect.fail(new HttpApiError.Forbidden());
	}
	return settings;
});

const normalizeAllowedEmailDomain = (value: string | null) => {
	if (!value?.trim()) return null;
	if (value.length > 255) return undefined;
	const entries = value.split(",").map((entry) => entry.trim().toLowerCase());
	if (
		entries.some(
			(entry) => !emailPattern.test(entry) && !domainPattern.test(entry),
		)
	) {
		return undefined;
	}
	return entries.join(", ");
};

const updateOrganizationSettings = Effect.fn(
	"Mobile.updateOrganizationSettings",
)(function* (input: MobileOrganizationSettingsInput) {
	const settings = yield* assertOrganizationSettingsManager();
	const name = input.name.trim();
	const allowedEmailDomain = normalizeAllowedEmailDomain(
		input.allowedEmailDomain,
	);
	if (!name || name.length > 255 || allowedEmailDomain === undefined) {
		return yield* Effect.fail(new HttpApiError.BadRequest());
	}

	const database = yield* Database;
	yield* database.use((db) =>
		db
			.update(Db.organizations)
			.set({ name, allowedEmailDomain })
			.where(eq(Db.organizations.id, settings.id)),
	);
	yield* Effect.sync(() => {
		revalidatePath("/dashboard/caps");
		revalidatePath("/dashboard/settings/organization");
	});
	return yield* getOrganizationSettings();
});

const decodeMobileImage = (
	input: MobileOrganizationIconInput | MobileProfileImageInput,
) => {
	const contentType = input.contentType.toLowerCase();
	const extension = input.fileName.split(".").at(-1)?.toLowerCase();
	const validExtension =
		contentType === "image/png"
			? extension === "png"
			: extension === "jpg" || extension === "jpeg";
	if (
		!mobileImageTypes.has(contentType) ||
		!validExtension ||
		input.fileName.includes("/") ||
		input.fileName.includes("\\") ||
		input.fileName.length === 0 ||
		input.fileName.length > 255 ||
		input.data.length === 0 ||
		input.data.length > Math.ceil((mobileImageMaxBytes * 4) / 3) + 4 ||
		input.data.length % 4 !== 0 ||
		!/^[A-Za-z0-9+/]*={0,2}$/.test(input.data)
	) {
		return null;
	}

	const data = new Uint8Array(Buffer.from(input.data, "base64"));
	const isPng =
		data.length >= 8 &&
		data[0] === 0x89 &&
		data[1] === 0x50 &&
		data[2] === 0x4e &&
		data[3] === 0x47 &&
		data[4] === 0x0d &&
		data[5] === 0x0a &&
		data[6] === 0x1a &&
		data[7] === 0x0a;
	const isJpeg =
		data.length >= 3 &&
		data[0] === 0xff &&
		data[1] === 0xd8 &&
		data[2] === 0xff;
	if (
		data.length === 0 ||
		data.length > mobileImageMaxBytes ||
		(contentType === "image/png" ? !isPng : !isJpeg)
	) {
		return null;
	}

	return { contentType, data, fileName: input.fileName };
};

const updateOrganizationIcon = Effect.fn("Mobile.updateOrganizationIcon")(
	function* (input: MobileOrganizationIconInput | null) {
		const settings = yield* assertOrganizationSettingsManager();
		const image = input ? decodeMobileImage(input) : null;
		if (input && !image) {
			return yield* Effect.fail(new HttpApiError.BadRequest());
		}

		const database = yield* Database;
		const imageUploads = yield* ImageUploads;
		const [organization] = yield* database.use((db) =>
			db
				.select({ iconUrl: Db.organizations.iconUrl })
				.from(Db.organizations)
				.where(eq(Db.organizations.id, settings.id))
				.limit(1),
		);
		if (!organization) {
			return yield* Effect.fail(new HttpApiError.NotFound());
		}

		yield* imageUploads.applyUpdate({
			payload: Option.fromNullable(image),
			existing: Option.fromNullable(organization.iconUrl),
			keyPrefix: `organizations/${settings.id}`,
			update: (db, iconUrl) =>
				db
					.update(Db.organizations)
					.set({ iconUrl })
					.where(eq(Db.organizations.id, settings.id)),
		});
		yield* Effect.sync(() => {
			revalidatePath("/dashboard/caps");
			revalidatePath("/dashboard/settings/organization");
		});
		return yield* getOrganizationSettings();
	},
);

const getMobileUser = Effect.fn("Mobile.getUser")(function* () {
	const user = yield* CurrentUser;
	const database = yield* Database;
	const imageUploads = yield* ImageUploads;
	const [userRow] = yield* database.use((db) =>
		db
			.select({
				id: Db.users.id,
				name: Db.users.name,
				lastName: Db.users.lastName,
				email: Db.users.email,
				image: Db.users.image,
				activeOrganizationId: Db.users.activeOrganizationId,
			})
			.from(Db.users)
			.where(eq(Db.users.id, user.id))
			.limit(1),
	);
	if (!userRow) return yield* Effect.fail(new HttpApiError.Unauthorized());

	const imageUrl = userRow.image
		? yield* imageUploads.resolveImageUrl(userRow.image)
		: null;
	return {
		id: userRow.id,
		name: userRow.name,
		lastName: userRow.lastName,
		email: userRow.email,
		imageUrl,
		activeOrganizationId: userRow.activeOrganizationId,
	};
});

const updateProfile = Effect.fn("Mobile.updateProfile")(function* (
	input: MobileProfileInput,
) {
	const user = yield* CurrentUser;
	const name = input.name.trim();
	const lastName = input.lastName?.trim() || null;
	if (!name || name.length > 255 || (lastName?.length ?? 0) > 255) {
		return yield* Effect.fail(new HttpApiError.BadRequest());
	}

	const database = yield* Database;
	yield* database.use((db) =>
		db.update(Db.users).set({ name, lastName }).where(eq(Db.users.id, user.id)),
	);
	yield* Effect.sync(() => {
		revalidatePath("/dashboard/caps");
		revalidatePath("/dashboard/settings/account");
	});
	return yield* getMobileUser();
});

const updateProfileImage = Effect.fn("Mobile.updateProfileImage")(function* (
	input: MobileProfileImageInput | null,
) {
	const user = yield* CurrentUser;
	const image = input ? decodeMobileImage(input) : null;
	if (input && !image) {
		return yield* Effect.fail(new HttpApiError.BadRequest());
	}

	const imageUploads = yield* ImageUploads;
	yield* imageUploads.applyUpdate({
		payload: Option.fromNullable(image),
		existing: user.iconUrlOrKey,
		keyPrefix: `users/${user.id}`,
		update: (db, imageUrl) =>
			db
				.update(Db.users)
				.set({ image: imageUrl })
				.where(eq(Db.users.id, user.id)),
	});
	yield* Effect.sync(() => {
		revalidatePath("/dashboard/caps");
		revalidatePath("/dashboard/settings/account");
	});
	return yield* getMobileUser();
});

const getBootstrap = Effect.fn("Mobile.getBootstrap")(function* () {
	const user = yield* CurrentUser;
	const mobileUser = yield* getMobileUser();

	const organizations = yield* getAccessibleOrganizations(user.id);
	const activeOrganization =
		organizations.find((org) => org.id === mobileUser.activeOrganizationId) ??
		organizations[0] ??
		null;
	const activeOrganizationId = activeOrganization?.id ?? null;
	const [rootFolders, spaces] = activeOrganization
		? yield* Effect.all([
				getRootFolders(activeOrganization.id),
				getAccessibleSpaces(activeOrganization),
			])
		: [[], []];
	return {
		user: {
			...mobileUser,
			activeOrganizationId: activeOrganizationId ?? user.activeOrganizationId,
		},
		organizations,
		activeOrganizationId,
		rootFolders,
		spaces,
	};
});

const getCapLocations = Effect.fn("Mobile.getCapLocations")(function* ({
	folderId,
	page,
	limit,
	space,
}: {
	folderId: Folder.FolderId | null;
	page: number;
	limit: number;
	space: MobileSpace | null;
}) {
	const user = yield* CurrentUser;
	const database = yield* Database;
	const offset = (page - 1) * limit;

	if (!space) {
		const folderFilter = folderId
			? eq(Db.videos.folderId, folderId)
			: isNull(Db.videos.folderId);
		const collectionWhereClause = and(
			eq(Db.videos.ownerId, user.id),
			eq(Db.videos.orgId, user.activeOrganizationId),
			isNull(Db.organizations.tombstoneAt),
		);
		const whereClause = and(collectionWhereClause, folderFilter);
		const [locations, [countRow]] = yield* Effect.all([
			database.use((db) =>
				db
					.select({ id: Db.videos.id, folderId: Db.videos.folderId })
					.from(Db.videos)
					.leftJoin(Db.organizations, eq(Db.videos.orgId, Db.organizations.id))
					.where(whereClause)
					.orderBy(desc(Db.videos.effectiveCreatedAt))
					.limit(limit)
					.offset(offset),
			),
			database.use((db) =>
				db
					.select({
						total:
							sql<number>`COUNT(CASE WHEN ${folderFilter} THEN 1 END)`.mapWith(
								Number,
							),
						collectionTotal: count(),
					})
					.from(Db.videos)
					.leftJoin(Db.organizations, eq(Db.videos.orgId, Db.organizations.id))
					.where(collectionWhereClause),
			),
		]);
		return {
			locations,
			total: countRow?.total ?? 0,
			collectionTotal: countRow?.collectionTotal ?? 0,
		};
	}

	if (space.kind === "organization") {
		const folderFilter = folderId
			? eq(Db.sharedVideos.folderId, folderId)
			: isNull(Db.sharedVideos.folderId);
		const collectionWhereClause = and(
			eq(Db.sharedVideos.organizationId, user.activeOrganizationId),
			isNull(Db.organizations.tombstoneAt),
		);
		const whereClause = and(collectionWhereClause, folderFilter);
		const [locations, [countRow]] = yield* Effect.all([
			database.use((db) =>
				db
					.select({
						id: Db.sharedVideos.videoId,
						folderId: Db.sharedVideos.folderId,
					})
					.from(Db.sharedVideos)
					.innerJoin(Db.videos, eq(Db.sharedVideos.videoId, Db.videos.id))
					.leftJoin(Db.organizations, eq(Db.videos.orgId, Db.organizations.id))
					.where(whereClause)
					.orderBy(desc(Db.videos.effectiveCreatedAt))
					.limit(limit)
					.offset(offset),
			),
			database.use((db) =>
				db
					.select({
						total:
							sql<number>`COUNT(DISTINCT CASE WHEN ${folderFilter} THEN ${Db.sharedVideos.videoId} END)`.mapWith(
								Number,
							),
						collectionTotal:
							sql<number>`COUNT(DISTINCT ${Db.sharedVideos.videoId})`.mapWith(
								Number,
							),
					})
					.from(Db.sharedVideos)
					.innerJoin(Db.videos, eq(Db.sharedVideos.videoId, Db.videos.id))
					.leftJoin(Db.organizations, eq(Db.videos.orgId, Db.organizations.id))
					.where(collectionWhereClause),
			),
		]);
		return {
			locations,
			total: countRow?.total ?? 0,
			collectionTotal: countRow?.collectionTotal ?? 0,
		};
	}

	const folderFilter = folderId
		? eq(Db.spaceVideos.folderId, folderId)
		: isNull(Db.spaceVideos.folderId);
	const collectionWhereClause = and(
		eq(Db.spaceVideos.spaceId, space.id),
		isNull(Db.organizations.tombstoneAt),
	);
	const whereClause = and(collectionWhereClause, folderFilter);
	const [locations, [countRow]] = yield* Effect.all([
		database.use((db) =>
			db
				.select({
					id: Db.spaceVideos.videoId,
					folderId: Db.spaceVideos.folderId,
				})
				.from(Db.spaceVideos)
				.innerJoin(Db.videos, eq(Db.spaceVideos.videoId, Db.videos.id))
				.leftJoin(Db.organizations, eq(Db.videos.orgId, Db.organizations.id))
				.where(whereClause)
				.orderBy(desc(Db.videos.effectiveCreatedAt))
				.limit(limit)
				.offset(offset),
		),
		database.use((db) =>
			db
				.select({
					total:
						sql<number>`COUNT(DISTINCT CASE WHEN ${folderFilter} THEN ${Db.spaceVideos.videoId} END)`.mapWith(
							Number,
						),
					collectionTotal:
						sql<number>`COUNT(DISTINCT ${Db.spaceVideos.videoId})`.mapWith(
							Number,
						),
				})
				.from(Db.spaceVideos)
				.innerJoin(Db.videos, eq(Db.spaceVideos.videoId, Db.videos.id))
				.leftJoin(Db.organizations, eq(Db.videos.orgId, Db.organizations.id))
				.where(collectionWhereClause),
		),
	]);
	return {
		locations,
		total: countRow?.total ?? 0,
		collectionTotal: countRow?.collectionTotal ?? 0,
	};
});

const getCapRows = Effect.fn("Mobile.getCapRows")(function* (
	locations: ReadonlyArray<{
		id: Video.VideoId;
		folderId: Folder.FolderId | null;
	}>,
) {
	if (locations.length === 0) return [];

	const database = yield* Database;
	const folderIds = new Map(
		locations.map((location) => [location.id, location.folderId]),
	);
	const rows = yield* database.use((db) => {
		const inheritedPassword = db
			.select({ value: sql`1` })
			.from(Db.spaceVideos)
			.innerJoin(Db.spaces, eq(Db.spaces.id, Db.spaceVideos.spaceId))
			.where(
				and(
					eq(Db.spaceVideos.videoId, Db.videos.id),
					isNotNull(Db.spaces.password),
				),
			);

		return db
			.select({
				id: Db.videos.id,
				ownerId: Db.videos.ownerId,
				name: Db.videos.name,
				createdAt: Db.videos.createdAt,
				updatedAt: Db.videos.updatedAt,
				ownerName: Db.users.name,
				duration: Db.videos.duration,
				folderId: Db.videos.folderId,
				public: Db.videos.public,
				hasPassword: sql<boolean>`${Db.videos.password} IS NOT NULL`.mapWith(
					Boolean,
				),
				hasInheritedPassword: exists(inheritedPassword).mapWith(Boolean),
				commentCount: sql<number>`COUNT(DISTINCT CASE WHEN ${Db.comments.type} = 'text' THEN ${Db.comments.id} END)`,
				reactionCount: sql<number>`COUNT(DISTINCT CASE WHEN ${Db.comments.type} = 'emoji' THEN ${Db.comments.id} END)`,
				uploadVideoId: Db.videoUploads.videoId,
				uploadUploaded: Db.videoUploads.uploaded,
				uploadTotal: Db.videoUploads.total,
				uploadPhase: Db.videoUploads.phase,
				processingProgress: Db.videoUploads.processingProgress,
				processingMessage: Db.videoUploads.processingMessage,
				processingError: Db.videoUploads.processingError,
				metadata: Db.videos.metadata,
				transcriptionStatus: Db.videos.transcriptionStatus,
			})
			.from(Db.videos)
			.leftJoin(Db.comments, eq(Db.videos.id, Db.comments.videoId))
			.leftJoin(Db.users, eq(Db.videos.ownerId, Db.users.id))
			.leftJoin(Db.videoUploads, eq(Db.videos.id, Db.videoUploads.videoId))
			.where(
				inArray(
					Db.videos.id,
					locations.map((location) => location.id),
				),
			)
			.groupBy(
				Db.videos.id,
				Db.videos.ownerId,
				Db.videos.name,
				Db.videos.createdAt,
				Db.videos.updatedAt,
				Db.users.name,
				Db.videos.duration,
				Db.videos.folderId,
				Db.videos.public,
				Db.videos.password,
				Db.videoUploads.videoId,
				Db.videoUploads.uploaded,
				Db.videoUploads.total,
				Db.videoUploads.phase,
				Db.videoUploads.processingProgress,
				Db.videoUploads.processingMessage,
				Db.videoUploads.processingError,
				Db.videos.metadata,
				Db.videos.transcriptionStatus,
			)
			.orderBy(desc(Db.videos.effectiveCreatedAt));
	});
	if (rows.length === 0) return [];
	const ownerIds = Array.from(new Set(rows.map((row) => row.ownerId)));
	const owners = yield* database.use((db) =>
		db
			.select({ id: Db.users.id, preferences: Db.users.preferences })
			.from(Db.users)
			.where(inArray(Db.users.id, ownerIds)),
	);
	const ownerPreferences = new Map(
		owners.map((owner) => [owner.id, owner.preferences]),
	);

	return rows.map((row) => ({
		...row,
		folderId: folderIds.get(row.id) ?? null,
		ownerPreferences: ownerPreferences.get(row.ownerId) ?? null,
	}));
});

const getCapsList = Effect.fn("Mobile.getCapsList")(function* (
	params: (typeof Mobile.MobileCapsListParams)["Type"],
	publicOrigin: string,
) {
	const page = parsePositiveInteger(params.page, 1, 10_000);
	const limit = parsePositiveInteger(params.limit, 20, 50);
	const folderId = params.folderId
		? Folder.FolderId.make(params.folderId)
		: null;
	const videos = yield* Videos;
	const user = yield* CurrentUser;
	const space = yield* getSelectedSpace(params.spaceId);

	const [{ locations, total, collectionTotal }, folders] = yield* Effect.all([
		getCapLocations({ folderId, page, limit, space }),
		folderId
			? Effect.succeed([])
			: space
				? getSpaceRootFolders(space)
				: getRootFolders(user.activeOrganizationId),
	]);
	const rows = yield* getCapRows(locations);
	const blockedUserIds = yield* getCurrentBlockedUserIds();
	const visibleRows = rows.filter(
		(row) =>
			!blockedUserIds.includes(row.ownerId) &&
			!getBlockedUserIds(row.ownerPreferences).includes(user.id),
	);
	const ownedRows = visibleRows.filter((row) => row.ownerId === user.id);
	const analytics = yield* videos
		.getAnalyticsBulkForOwner(
			ownedRows.map((row) => row.id),
			user.id,
		)
		.pipe(Effect.catchAll(() => Effect.succeed([])));
	const viewCounts = new Map<Video.VideoId, number>();

	ownedRows.forEach((row, index) => {
		viewCounts.set(row.id, analytics[index]?.count ?? 0);
	});

	const caps = visibleRows.map((row) =>
		toMobileCapSummary(row, viewCounts.get(row.id) ?? 0, publicOrigin, user.id),
	);

	return {
		folders,
		caps,
		page,
		limit,
		total,
		collectionTotal,
		hasMore: page * limit < total,
	};
});

const getCapStatuses = Effect.fn("Mobile.getCapStatuses")(function* (
	rawIds: readonly Video.VideoId[],
) {
	const ids = Array.from(new Set(rawIds));
	if (ids.length === 0 || ids.length > 25) {
		return yield* Effect.fail(new HttpApiError.BadRequest());
	}

	const user = yield* CurrentUser;
	const database = yield* Database;
	const rows = yield* database.use((db) =>
		db
			.select({
				id: Db.videos.id,
				uploadVideoId: Db.videoUploads.videoId,
				uploaded: Db.videoUploads.uploaded,
				total: Db.videoUploads.total,
				phase: Db.videoUploads.phase,
				processingProgress: Db.videoUploads.processingProgress,
				processingMessage: Db.videoUploads.processingMessage,
				processingError: Db.videoUploads.processingError,
			})
			.from(Db.videos)
			.leftJoin(Db.videoUploads, eq(Db.videos.id, Db.videoUploads.videoId))
			.where(and(eq(Db.videos.ownerId, user.id), inArray(Db.videos.id, ids))),
	);

	return {
		caps: rows.map((row) => ({
			id: row.id,
			upload:
				row.uploadVideoId && row.phase !== "complete"
					? {
							uploaded: Number(row.uploaded ?? 0),
							total: Number(row.total ?? 0),
							phase: row.phase ?? "uploading",
							processingProgress: Number(row.processingProgress ?? 0),
							processingMessage: row.processingMessage,
							processingError: row.processingError,
						}
					: null,
		})),
	};
});

const createMobileFolder = Effect.fn("Mobile.createFolder")(function* (
	input: MobileFolderCreateInput,
) {
	const user = yield* CurrentUser;
	const name = input.name.trim();
	if (!name) return yield* Effect.fail(new HttpApiError.BadRequest());

	const organizationId = user.activeOrganizationId;
	yield* assertOrganizationAccess(organizationId);
	const space = yield* getSelectedSpace(input.spaceId);
	if (space && !space.canManage) {
		return yield* Effect.fail(new HttpApiError.Forbidden());
	}

	const color = input.color ?? "normal";
	const id = Folder.FolderId.make(nanoId());
	const database = yield* Database;

	yield* database.use((db) =>
		db.insert(Db.folders).values({
			id,
			name,
			color,
			organizationId,
			createdById: user.id,
			parentId: null,
			spaceId: space?.id ?? null,
		}),
	);

	yield* Effect.sync(() => {
		revalidatePath("/dashboard/caps");
		if (space) revalidatePath(`/dashboard/spaces/${space.id}`);
	});

	return {
		id,
		name,
		color,
		parentId: null,
		videoCount: 0,
	};
});

const assertMobileVideoAccess = Effect.fn("Mobile.assertVideoAccess")(
	function* (videoId: Video.VideoId) {
		const user = yield* CurrentUser;
		const blockedUserIds = yield* getCurrentBlockedUserIds();
		yield* assertOrganizationAccess(user.activeOrganizationId);
		const database = yield* Database;
		const [row] = yield* database.use((db) => {
			const inheritedPassword = db
				.select({ value: sql`1` })
				.from(Db.spaceVideos)
				.innerJoin(Db.spaces, eq(Db.spaces.id, Db.spaceVideos.spaceId))
				.where(
					and(
						eq(Db.spaceVideos.videoId, Db.videos.id),
						isNotNull(Db.spaces.password),
					),
				);
			const sharedWithOrganization = db
				.select({ value: sql`1` })
				.from(Db.sharedVideos)
				.where(
					and(
						eq(Db.sharedVideos.videoId, Db.videos.id),
						eq(Db.sharedVideos.organizationId, user.activeOrganizationId),
					),
				);
			const spaceMembership = db
				.select({ value: sql`1` })
				.from(Db.spaceMembers)
				.where(
					and(
						eq(Db.spaceMembers.spaceId, Db.spaces.id),
						eq(Db.spaceMembers.userId, user.id),
					),
				);
			const sharedWithAccessibleSpace = db
				.select({ value: sql`1` })
				.from(Db.spaceVideos)
				.innerJoin(Db.spaces, eq(Db.spaces.id, Db.spaceVideos.spaceId))
				.where(
					and(
						eq(Db.spaceVideos.videoId, Db.videos.id),
						eq(Db.spaces.organizationId, user.activeOrganizationId),
						or(
							eq(Db.spaces.createdById, user.id),
							eq(Db.spaces.privacy, "Public"),
							exists(spaceMembership),
						),
					),
				);

			return db
				.select({
					ownerId: Db.videos.ownerId,
					ownerPreferences: Db.users.preferences,
					hasPassword: sql<boolean>`${Db.videos.password} IS NOT NULL`.mapWith(
						Boolean,
					),
					hasInheritedPassword: exists(inheritedPassword).mapWith(Boolean),
					sharedWithOrganization: exists(sharedWithOrganization).mapWith(
						Boolean,
					),
					sharedWithAccessibleSpace: exists(sharedWithAccessibleSpace).mapWith(
						Boolean,
					),
				})
				.from(Db.videos)
				.leftJoin(Db.users, eq(Db.videos.ownerId, Db.users.id))
				.where(eq(Db.videos.id, videoId))
				.limit(1);
		});

		if (!row) return yield* Effect.fail(new HttpApiError.NotFound());
		if (
			blockedUserIds.includes(row.ownerId) ||
			getBlockedUserIds(row.ownerPreferences).includes(user.id)
		) {
			return yield* Effect.fail(new HttpApiError.NotFound());
		}
		if (row.ownerId === user.id) return row;
		if (!row.sharedWithOrganization && !row.sharedWithAccessibleSpace) {
			return yield* Effect.fail(new HttpApiError.NotFound());
		}
		if (row.hasPassword || row.hasInheritedPassword) {
			return yield* Effect.fail(new HttpApiError.Forbidden());
		}
		return row;
	},
);

const assertMobileVideoOwner = Effect.fn("Mobile.assertVideoOwner")(function* (
	videoId: Video.VideoId,
) {
	const user = yield* CurrentUser;
	const video = yield* assertMobileVideoAccess(videoId);
	if (video.ownerId !== user.id) {
		return yield* Effect.fail(new HttpApiError.NotFound());
	}
});

const getCapById = Effect.fn("Mobile.getCapById")(function* (
	videoId: Video.VideoId,
	publicOrigin: string,
) {
	const user = yield* CurrentUser;
	const access = yield* assertMobileVideoAccess(videoId);
	const database = yield* Database;

	const [row] = yield* database.use((db) =>
		db
			.select({
				id: Db.videos.id,
				ownerId: Db.videos.ownerId,
				name: Db.videos.name,
				createdAt: Db.videos.createdAt,
				updatedAt: Db.videos.updatedAt,
				ownerName: Db.users.name,
				duration: Db.videos.duration,
				folderId: Db.videos.folderId,
				public: Db.videos.public,
				hasPassword: sql<boolean>`${Db.videos.password} IS NOT NULL`.mapWith(
					Boolean,
				),
				commentCount: sql<number>`COUNT(DISTINCT CASE WHEN ${Db.comments.type} = 'text' THEN ${Db.comments.id} END)`,
				reactionCount: sql<number>`COUNT(DISTINCT CASE WHEN ${Db.comments.type} = 'emoji' THEN ${Db.comments.id} END)`,
				uploadVideoId: Db.videoUploads.videoId,
				uploadUploaded: Db.videoUploads.uploaded,
				uploadTotal: Db.videoUploads.total,
				uploadPhase: Db.videoUploads.phase,
				processingProgress: Db.videoUploads.processingProgress,
				processingMessage: Db.videoUploads.processingMessage,
				processingError: Db.videoUploads.processingError,
				metadata: Db.videos.metadata,
				transcriptionStatus: Db.videos.transcriptionStatus,
			})
			.from(Db.videos)
			.leftJoin(Db.comments, eq(Db.videos.id, Db.comments.videoId))
			.leftJoin(Db.users, eq(Db.videos.ownerId, Db.users.id))
			.leftJoin(Db.videoUploads, eq(Db.videos.id, Db.videoUploads.videoId))
			.where(eq(Db.videos.id, videoId))
			.groupBy(
				Db.videos.id,
				Db.videos.ownerId,
				Db.videos.name,
				Db.videos.createdAt,
				Db.videos.updatedAt,
				Db.users.name,
				Db.videos.duration,
				Db.videos.folderId,
				Db.videos.public,
				Db.videos.password,
				Db.videoUploads.videoId,
				Db.videoUploads.uploaded,
				Db.videoUploads.total,
				Db.videoUploads.phase,
				Db.videoUploads.processingProgress,
				Db.videoUploads.processingMessage,
				Db.videoUploads.processingError,
				Db.videos.metadata,
				Db.videos.transcriptionStatus,
			),
	);

	if (!row) return yield* Effect.fail(new HttpApiError.NotFound());
	const capRow: CapRow = {
		...row,
		hasInheritedPassword: access.hasInheritedPassword,
		ownerPreferences: access.ownerPreferences,
	};

	const analytics =
		capRow.ownerId === user.id
			? yield* Effect.flatMap(Videos, (videos) =>
					videos.getAnalytics(capRow.id),
				).pipe(
					Effect.map((result) => result.count),
					Effect.catchAll(() => Effect.succeed(0)),
				)
			: 0;

	return {
		row: capRow,
		cap: toMobileCapSummary(capRow, analytics, publicOrigin, user.id),
	};
});

const assertCanCreateFeedback = Effect.fn("Mobile.assertCanCreateFeedback")(
	function* (videoId: Video.VideoId) {
		yield* assertMobileVideoAccess(videoId);
	},
);

const getComments = Effect.fn("Mobile.getComments")(function* (
	videoId: Video.VideoId,
	commentId?: Comment.CommentId,
) {
	const user = yield* CurrentUser;
	const database = yield* Database;
	const imageUploads = yield* ImageUploads;
	const blockedUserIds = yield* getCurrentBlockedUserIds();

	const rows = yield* database.use((db) =>
		db
			.select({
				id: Db.comments.id,
				videoId: Db.comments.videoId,
				type: Db.comments.type,
				content: Db.comments.content,
				timestamp: Db.comments.timestamp,
				parentCommentId: Db.comments.parentCommentId,
				createdAt: Db.comments.createdAt,
				updatedAt: Db.comments.updatedAt,
				authorId: Db.comments.authorId,
				authorName: Db.users.name,
				authorImage: Db.users.image,
				authorPreferences: Db.users.preferences,
			})
			.from(Db.comments)
			.leftJoin(Db.users, eq(Db.comments.authorId, Db.users.id))
			.where(
				commentId
					? and(eq(Db.comments.videoId, videoId), eq(Db.comments.id, commentId))
					: eq(Db.comments.videoId, videoId),
			)
			.orderBy(Db.comments.createdAt),
	);
	const visibleRows = rows.filter(
		(row) =>
			!blockedUserIds.includes(row.authorId) &&
			!getBlockedUserIds(row.authorPreferences).includes(user.id),
	);

	const authorImages = Array.from(
		new Set(
			visibleRows.flatMap((row) => (row.authorImage ? [row.authorImage] : [])),
		),
	);
	const imageUrls = yield* Effect.forEach(
		authorImages,
		(image) =>
			imageUploads
				.resolveImageUrl(image)
				.pipe(Effect.catchAll(() => Effect.succeed(null))),
		{ concurrency: 5 },
	);
	const imageUrlByKey = new Map(
		authorImages.map((image, index) => [image, imageUrls[index] ?? null]),
	);

	return visibleRows.map((row) => ({
		id: row.id,
		videoId: row.videoId,
		type: row.type,
		content: row.content,
		timestamp: row.timestamp,
		parentCommentId: row.parentCommentId,
		createdAt: toIsoString(row.createdAt),
		updatedAt: toIsoString(row.updatedAt),
		author: {
			id: row.authorId,
			name: row.authorName,
			imageUrl: row.authorImage
				? (imageUrlByKey.get(row.authorImage) ?? null)
				: null,
		},
	}));
});

const getCapDetail = Effect.fn("Mobile.getCapDetail")(function* (
	videoId: Video.VideoId,
	publicOrigin: string,
) {
	const { row, cap } = yield* getCapById(videoId, publicOrigin);
	const metadata = getMetadataRecord(row.metadata);
	const comments = yield* getComments(videoId);

	return {
		cap,
		summary: getMetadataString(metadata, "summary"),
		chapters: getMetadataChapters(metadata),
		transcriptionStatus: row.transcriptionStatus,
		comments,
		shareUrl: `${publicOrigin}/s/${videoId}`,
	};
});

const reportMobileCap = Effect.fn("Mobile.reportCap")(function* (
	videoId: Video.VideoId,
	reason: (typeof Mobile.MobileContentReportInput)["Type"]["reason"],
	publicOrigin: string,
) {
	const user = yield* CurrentUser;
	const { row } = yield* getCapById(videoId, publicOrigin);
	yield* Effect.tryPromise({
		try: () =>
			createMobileContentReport({
				reporter: {
					id: user.id,
					email: user.email,
				},
				content: {
					id: row.id,
					ownerId: row.ownerId,
					title: row.name,
				},
				reason,
			}),
		catch: () => new HttpApiError.InternalServerError(),
	});
	return { success: true as const };
});

const createMobileComment = Effect.fn("Mobile.createComment")(function* ({
	videoId,
	content,
	timestamp,
	parentCommentId,
	type,
}: {
	videoId: Video.VideoId;
	content: string;
	timestamp: number | null;
	parentCommentId: Comment.CommentId | null;
	type: "text" | "emoji";
}) {
	const user = yield* CurrentUser;
	yield* assertCanCreateFeedback(videoId);

	const trimmedContent = content.trim();
	if (trimmedContent.length === 0) {
		return yield* Effect.fail(new HttpApiError.BadRequest());
	}

	const id = Comment.CommentId.make(nanoId());
	const now = new Date();
	const database = yield* Database;
	yield* database.use((db) =>
		db.insert(Db.comments).values({
			id,
			authorId: user.id,
			type,
			content: trimmedContent,
			videoId,
			timestamp,
			parentCommentId,
			createdAt: now,
			updatedAt: now,
		}),
	);

	const notificationType = parentCommentId
		? "reply"
		: type === "emoji"
			? "reaction"
			: "comment";

	yield* Effect.tryPromise(() =>
		createNotification({
			type: notificationType,
			videoId,
			authorId: user.id,
			comment: { id, content: trimmedContent },
			parentCommentId: parentCommentId ?? undefined,
		}),
	).pipe(Effect.catchAll(() => Effect.void));

	const comments = yield* getComments(videoId, id);
	const created = comments.find((comment) => comment.id === id);
	if (!created)
		return yield* Effect.fail(new HttpApiError.InternalServerError());
	return created;
});

const getPlayback = Effect.fn("Mobile.getPlayback")(function* (
	videoId: Video.VideoId,
	publicOrigin: string,
) {
	yield* assertMobileVideoAccess(videoId);
	const repo = yield* VideosRepo;
	const storage = yield* Storage;
	const maybeVideo = yield* repo.getById(videoId);
	if (Option.isNone(maybeVideo)) {
		return yield* Effect.fail(new HttpApiError.NotFound());
	}
	const [video] = maybeVideo.value;

	const [bucket] = yield* storage.getAccessForVideo(video);
	const source = Video.Video.getSource(video);

	const transcriptKey = `${video.ownerId}/${video.id}/transcription.vtt`;
	const transcriptUrl = yield* bucket.headObject(transcriptKey).pipe(
		Effect.flatMap(() => bucket.getSignedObjectUrl(transcriptKey)),
		Effect.map((url) =>
			resolveMobileWebResourceUrl(url, serverEnv().WEB_URL, publicOrigin),
		),
		Effect.catchAll(() => Effect.succeed(null)),
	);

	if (source instanceof Video.Mp4Source) {
		const signedUrl = yield* bucket.getSignedObjectUrl(source.getFileKey());
		const url = resolveMobileWebResourceUrl(
			signedUrl,
			serverEnv().WEB_URL,
			publicOrigin,
		);
		return { kind: "mp4" as const, url, transcriptUrl };
	}

	if (source instanceof Video.M3U8Source) {
		const signedUrl = yield* bucket.getSignedObjectUrl(
			source.getPlaylistFileKey(),
		);
		const url = resolveMobileWebResourceUrl(
			signedUrl,
			serverEnv().WEB_URL,
			publicOrigin,
		);
		return { kind: "hls" as const, url, transcriptUrl };
	}

	if (source instanceof Video.SegmentsSource) {
		return {
			kind: "hls" as const,
			url: `${publicOrigin}/api/playlist?videoId=${video.id}&videoType=segments-master`,
			transcriptUrl,
		};
	}

	return yield* Effect.fail(new HttpApiError.NotFound());
});

const getCapAnalytics = Effect.fn("Mobile.getCapAnalytics")(function* (
	videoId: Video.VideoId,
	range: (typeof Mobile.MobileAnalyticsRange)["Type"],
) {
	const user = yield* CurrentUser;
	const database = yield* Database;
	const [video] = yield* database.use((db) =>
		db
			.select({ name: Db.videos.name, orgId: Db.videos.orgId })
			.from(Db.videos)
			.where(and(eq(Db.videos.id, videoId), eq(Db.videos.ownerId, user.id)))
			.limit(1),
	);
	if (!video) return yield* Effect.fail(new HttpApiError.NotFound());

	const [userRow] = yield* database.use((db) =>
		db
			.select({
				stripeSubscriptionStatus: Db.users.stripeSubscriptionStatus,
				thirdPartyStripeSubscriptionId: Db.users.thirdPartyStripeSubscriptionId,
			})
			.from(Db.users)
			.where(eq(Db.users.id, user.id))
			.limit(1),
	);
	if (!userIsPro(userRow)) {
		return { available: false as const, data: null };
	}

	const data = yield* Effect.tryPromise({
		try: () => getOrgAnalyticsData(video.orgId, range, undefined, videoId),
		catch: () => new HttpApiError.InternalServerError(),
	});
	const chartLimit = 96;
	const chartGroupSize = Math.ceil(data.chart.length / chartLimit);
	const chart =
		chartGroupSize <= 1
			? data.chart
			: Array.from(
					{ length: Math.ceil(data.chart.length / chartGroupSize) },
					(_, groupIndex) => {
						const group = data.chart.slice(
							groupIndex * chartGroupSize,
							(groupIndex + 1) * chartGroupSize,
						);
						return {
							bucket: group.at(-1)?.bucket ?? "",
							caps: group.reduce((total, point) => total + point.caps, 0),
							views: group.reduce((total, point) => total + point.views, 0),
							comments: group.reduce(
								(total, point) => total + point.comments,
								0,
							),
							reactions: group.reduce(
								(total, point) => total + point.reactions,
								0,
							),
						};
					},
				);
	return {
		available: true as const,
		data: {
			...data,
			capName: data.capName ?? video.name,
			chart,
			breakdowns: {
				...data.breakdowns,
				topCaps: data.breakdowns.topCaps.map((cap) => ({
					...cap,
					id: Video.VideoId.make(cap.id),
				})),
			},
		},
	};
});

const isLoomUrl = (value: string) => {
	try {
		const url = new URL(value);
		return (
			url.protocol === "https:" &&
			(url.hostname === "loom.com" || url.hostname.endsWith(".loom.com"))
		);
	} catch {
		return false;
	}
};

const toHeaders = (headers: Record<string, string>) => {
	const result = new Headers();
	for (const [key, value] of Object.entries(headers)) result.set(key, value);
	return result;
};

const importLoom = Effect.fn("Mobile.importLoom")(function* (
	loomUrlInput: string,
	request: HttpServerRequest.HttpServerRequest,
) {
	const loomUrl = loomUrlInput.trim();
	if (!isLoomUrl(loomUrl)) {
		return yield* Effect.fail(new HttpApiError.BadRequest());
	}

	const user = yield* CurrentUser;
	const database = yield* Database;
	const [userRow] = yield* database.use((db) =>
		db.select().from(Db.users).where(eq(Db.users.id, user.id)).limit(1),
	);
	if (!userRow) return yield* Effect.fail(new HttpApiError.Forbidden());
	if (!userIsPro(userRow)) {
		return yield* Effect.fail(new HttpApiError.Forbidden());
	}
	yield* assertOrganizationAccess(user.activeOrganizationId);

	const limited = yield* Effect.promise(() =>
		isRateLimited(RATE_LIMIT_IDS.AGENT_LOOM_IMPORT, {
			key: `loom-import:${user.id}`,
			headers: toHeaders(request.headers),
		}),
	);
	if (limited) return yield* Effect.fail(new HttpApiError.BadRequest());

	const download = yield* Effect.tryPromise({
		try: () => downloadLoomVideo(loomUrl),
		catch: () => new HttpApiError.InternalServerError(),
	});
	if (!download.success || !download.videoId || !download.downloadUrl) {
		return yield* Effect.fail(new HttpApiError.BadRequest());
	}
	const loomVideoId = download.videoId;

	const storage = yield* Storage;
	const writable = yield* storage.getWritableAccessForUser(
		user.id,
		user.activeOrganizationId,
	);
	const videoId = Video.VideoId.make(nanoId());
	const now = new Date();
	const importState = yield* database.use((db) =>
		db.transaction(async (tx) => {
			const [existing] = await tx
				.select({
					importId: Db.importedVideos.id,
					videoId: Db.videos.id,
				})
				.from(Db.importedVideos)
				.leftJoin(
					Db.videos,
					and(
						eq(Db.videos.id, Db.importedVideos.id),
						eq(Db.videos.orgId, Db.importedVideos.orgId),
					),
				)
				.where(
					and(
						eq(Db.importedVideos.orgId, user.activeOrganizationId),
						eq(Db.importedVideos.source, "loom"),
						eq(Db.importedVideos.sourceId, loomVideoId),
					),
				)
				.limit(1);
			if (existing?.videoId) return "conflict" as const;
			if (existing) {
				await tx
					.delete(Db.importedVideos)
					.where(
						and(
							eq(Db.importedVideos.orgId, user.activeOrganizationId),
							eq(Db.importedVideos.source, "loom"),
							eq(Db.importedVideos.sourceId, loomVideoId),
						),
					);
			}

			await tx.insert(Db.videos).values({
				id: videoId,
				name:
					download.videoName?.slice(0, 255) ??
					`Loom Import - ${now.toISOString().slice(0, 10)}`,
				ownerId: user.id,
				orgId: user.activeOrganizationId,
				source: { type: "webMP4" },
				bucket: Option.getOrNull(writable.bucketId),
				storageIntegrationId: Option.getOrNull(writable.storageIntegrationId),
				public: serverEnv().CAP_VIDEOS_DEFAULT_PUBLIC,
				duration: download.durationSeconds,
				width: download.width,
				height: download.height,
			});
			await tx.insert(Db.videoUploads).values({
				videoId,
				phase: "uploading",
				processingProgress: 0,
				processingMessage: "Importing from Loom...",
			});
			await tx.insert(Db.importedVideos).values({
				id: videoId,
				orgId: user.activeOrganizationId,
				source: "loom",
				sourceId: loomVideoId,
			});
			return "ready" as const;
		}),
	);
	if (importState === "conflict") {
		return yield* Effect.fail(new HttpApiError.BadRequest());
	}

	const rawFileKey = `${user.id}/${videoId}/raw-upload.mp4`;
	yield* Effect.tryPromise({
		try: () =>
			start(importLoomVideoWorkflow, [
				{
					videoId,
					userId: user.id,
					rawFileKey,
					bucketId: Option.getOrNull(writable.bucketId),
					loomVideoId,
				},
			]),
		catch: () => new HttpApiError.InternalServerError(),
	});
	yield* Effect.sync(() => revalidatePath("/dashboard/caps"));
	return {
		id: videoId,
		shareUrl: `${getMobilePublicOrigin(request)}/s/${videoId}`,
	};
});

const createUpload = Effect.fn("Mobile.createUpload")(function* (
	input: MobileUploadCreateInput,
	publicOrigin: string,
) {
	const user = yield* CurrentUser;
	const organizationId = input.organizationId ?? user.activeOrganizationId;
	yield* assertOrganizationAccess(organizationId);

	if (!input.contentType.startsWith("video/")) {
		return yield* Effect.fail(new HttpApiError.BadRequest());
	}

	const database = yield* Database;
	const storage = yield* Storage;
	const repo = yield* VideosRepo;
	const folderId = input.folderId;

	if (folderId) {
		const [folder] = yield* database.use((db) =>
			db
				.select({ id: Db.folders.id })
				.from(Db.folders)
				.where(
					and(
						eq(Db.folders.id, folderId),
						eq(Db.folders.organizationId, organizationId),
						eq(Db.folders.createdById, user.id),
						isNull(Db.folders.spaceId),
					),
				),
		);
		if (!folder) return yield* Effect.fail(new HttpApiError.NotFound());
	}

	const writable = yield* storage.getWritableAccessForUser(
		user.id,
		organizationId,
	);
	const videoId = yield* repo.create({
		ownerId: user.id,
		orgId: organizationId,
		name: getUploadTitle(input.fileName),
		public: serverEnv().CAP_VIDEOS_DEFAULT_PUBLIC,
		source: { type: "webMP4" },
		bucketId: writable.bucketId,
		storageIntegrationId: writable.storageIntegrationId,
		folderId: Option.fromNullable(folderId),
		width: Option.fromNullable(input.width),
		height: Option.fromNullable(input.height),
		duration: Option.fromNullable(input.durationSeconds),
		metadata: Option.none(),
		transcriptionStatus: Option.none(),
	});

	yield* database.use((db) =>
		db.insert(Db.videoUploads).values({
			videoId,
			total: input.contentLength ?? 0,
			mode: "singlepart",
		}),
	);

	const rawFileKey = `${user.id}/${videoId}/raw-upload.${getFileExtension(input)}`;
	const upload = yield* writable.access.createUploadTarget(rawFileKey, {
		contentType: input.contentType,
		method: "put",
		fields: {
			"Content-Type": input.contentType,
			"x-amz-meta-userid": user.id,
			"x-amz-meta-source": "cap-mobile-ios",
		},
	});
	return {
		id: videoId,
		shareUrl: `${publicOrigin}/s/${videoId}`,
		rawFileKey,
		upload,
	};
});

const mobileRecordingSegmentPattern =
	/^segments\/(?:video|audio)\/(?:init\.mp4|segment_[0-9]{3,6}\.m4s)$/;

const createRecording = Effect.fn("Mobile.createRecording")(function* (
	input: MobileRecordingCreateInput,
	publicOrigin: string,
) {
	const user = yield* CurrentUser;
	const organizationId = input.organizationId ?? user.activeOrganizationId;
	yield* assertOrganizationAccess(organizationId);

	if (
		input.fileName.trim().length === 0 ||
		input.fileName.length > 255 ||
		!Number.isInteger(input.width) ||
		input.width < 1 ||
		input.width > 7680 ||
		!Number.isInteger(input.height) ||
		input.height < 1 ||
		input.height > 7680 ||
		!Number.isInteger(input.fps) ||
		input.fps < 1 ||
		input.fps > 120
	) {
		return yield* Effect.fail(new HttpApiError.BadRequest());
	}

	const database = yield* Database;
	const storage = yield* Storage;
	const repo = yield* VideosRepo;
	const folderId = input.folderId;

	if (folderId) {
		const [folder] = yield* database.use((db) =>
			db
				.select({ id: Db.folders.id })
				.from(Db.folders)
				.where(
					and(
						eq(Db.folders.id, folderId),
						eq(Db.folders.organizationId, organizationId),
						eq(Db.folders.createdById, user.id),
						isNull(Db.folders.spaceId),
					),
				),
		);
		if (!folder) return yield* Effect.fail(new HttpApiError.NotFound());
	}

	const writable = yield* storage.getWritableAccessForUser(
		user.id,
		organizationId,
	);
	const videoId = yield* repo.create({
		ownerId: user.id,
		orgId: organizationId,
		name: getUploadTitle(input.fileName),
		public: serverEnv().CAP_VIDEOS_DEFAULT_PUBLIC,
		source: { type: "desktopSegments" },
		bucketId: writable.bucketId,
		storageIntegrationId: writable.storageIntegrationId,
		folderId: Option.fromNullable(folderId),
		width: Option.some(input.width),
		height: Option.some(input.height),
		duration: Option.none(),
		metadata: Option.some({ source: "mobileCamera", fps: input.fps }),
		transcriptionStatus: Option.none(),
	});

	yield* database.use((db) =>
		db.insert(Db.videoUploads).values({
			videoId,
			total: 0,
			mode: "singlepart",
		}),
	);

	return {
		id: videoId,
		shareUrl: `${publicOrigin}/s/${videoId}`,
	};
});

const getOwnedRecording = Effect.fn("Mobile.getOwnedRecording")(function* (
	videoId: Video.VideoId,
) {
	const user = yield* CurrentUser;
	const repo = yield* VideosRepo;
	const maybeVideo = yield* repo.getById(videoId);
	if (Option.isNone(maybeVideo)) {
		return yield* Effect.fail(new HttpApiError.NotFound());
	}
	const [video] = maybeVideo.value;
	if (video.ownerId !== user.id) {
		return yield* Effect.fail(new HttpApiError.NotFound());
	}
	return video;
});

const createRecordingUploadTargets = Effect.fn(
	"Mobile.createRecordingUploadTargets",
)(function* (videoId: Video.VideoId, rawSubpaths: readonly string[]) {
	const subpaths = Array.from(new Set(rawSubpaths));
	if (
		subpaths.length === 0 ||
		subpaths.length > 25 ||
		subpaths.some((subpath) => !mobileRecordingSegmentPattern.test(subpath))
	) {
		return yield* Effect.fail(new HttpApiError.BadRequest());
	}

	const video = yield* getOwnedRecording(videoId);
	if (video.source.type !== "desktopSegments") {
		return yield* Effect.fail(new HttpApiError.BadRequest());
	}

	const storage = yield* Storage;
	const [bucket] = yield* storage.getAccessForVideo(video);
	const entries = yield* Effect.all(
		subpaths.map((subpath) =>
			bucket
				.createUploadTarget(`${video.ownerId}/${video.id}/${subpath}`, {
					contentType: "video/mp4",
					method: "put",
				})
				.pipe(Effect.map((upload) => [subpath, upload] as const)),
		),
		{ concurrency: 6 },
	);

	return { uploads: Object.fromEntries(entries) };
});

const completeRecording = Effect.fn("Mobile.completeRecording")(function* (
	videoId: Video.VideoId,
	input: MobileRecordingCompleteInput,
) {
	const user = yield* CurrentUser;
	const video = yield* getOwnedRecording(videoId);
	if (video.source.type === "desktopMP4") {
		return { success: true as const };
	}
	if (video.source.type !== "desktopSegments") {
		return yield* Effect.fail(new HttpApiError.BadRequest());
	}

	const videoSegments = [...input.videoSegments].sort(
		(a, b) => a.index - b.index,
	);
	const audioSegments = [...input.audioSegments].sort(
		(a, b) => a.index - b.index,
	);
	const validTrack = (segments: typeof videoSegments, required: boolean) =>
		(!required || segments.length > 0) &&
		segments.length <= 18_000 &&
		segments.every(
			(segment, position) =>
				Number.isInteger(segment.index) &&
				segment.index === position + 1 &&
				Number.isFinite(segment.duration) &&
				segment.duration > 0 &&
				segment.duration <= 10,
		);
	if (
		!validTrack(videoSegments, true) ||
		!validTrack(audioSegments, false) ||
		!Number.isFinite(input.durationSeconds) ||
		input.durationSeconds <= 0 ||
		input.durationSeconds > 43_200 ||
		!Number.isSafeInteger(input.totalBytes) ||
		input.totalBytes < 0 ||
		input.totalBytes > 2_000_000_000_000
	) {
		return yield* Effect.fail(new HttpApiError.BadRequest());
	}

	const database = yield* Database;
	const [userRow] = yield* database.use((db) =>
		db
			.select({
				stripeSubscriptionStatus: Db.users.stripeSubscriptionStatus,
				thirdPartyStripeSubscriptionId: Db.users.thirdPartyStripeSubscriptionId,
			})
			.from(Db.users)
			.where(eq(Db.users.id, user.id))
			.limit(1),
	);
	if (
		!Mobile.isMobileRecordingDurationAllowed({
			durationSeconds: input.durationSeconds,
			isPro: userIsPro(userRow),
		})
	) {
		return yield* Effect.fail(new HttpApiError.Forbidden());
	}

	const storage = yield* Storage;
	const [bucket] = yield* storage.getAccessForVideo(video);
	const source = new Video.SegmentsSource({
		videoId: video.id,
		ownerId: video.ownerId,
	});
	const manifest = JSON.stringify({
		version: 2,
		video_init_uploaded: true,
		audio_init_uploaded: audioSegments.length > 0,
		video_segments: videoSegments,
		audio_segments: audioSegments,
		is_complete: true,
	});

	yield* bucket.putObject(source.getManifestKey(), manifest, {
		contentType: "application/json",
		contentLength: Buffer.byteLength(manifest),
	});
	yield* database.use(async (db) => {
		await db
			.update(Db.videos)
			.set({ duration: input.durationSeconds })
			.where(and(eq(Db.videos.id, video.id), eq(Db.videos.ownerId, user.id)));
		await db
			.update(Db.videoUploads)
			.set({
				uploaded: Math.trunc(input.totalBytes),
				total: Math.trunc(input.totalBytes),
				updatedAt: new Date(),
			})
			.where(eq(Db.videoUploads.videoId, video.id));
	});

	yield* Effect.tryPromise({
		try: () =>
			queueDesktopSegmentsFinalization({ videoId: video.id, userId: user.id }),
		catch: () => new HttpApiError.InternalServerError(),
	});

	yield* Effect.sync(() => {
		revalidatePath("/dashboard/caps");
		revalidatePath(`/s/${video.id}`);
	});
	return { success: true as const };
});

const ApiLive = HttpApiBuilder.api(Mobile.MobileApiContract).pipe(
	Layer.provide(
		HttpApiBuilder.group(Mobile.MobileApiContract, "mobile", (handlers) =>
			Effect.gen(function* () {
				const videos = yield* Videos;
				const database = yield* Database;

				return handlers
					.handle("getAuthConfig", () =>
						Effect.succeed({
							appleAuthAvailable: Boolean(
								serverEnv().APPLE_CLIENT_ID && serverEnv().APPLE_CLIENT_SECRET,
							),
							googleAuthAvailable: Boolean(serverEnv().GOOGLE_CLIENT_ID),
							workosAuthAvailable: Boolean(serverEnv().WORKOS_CLIENT_ID),
						}),
					)
					.handle("requestSession", ({ request, urlParams }) =>
						withMappedErrors(
							Effect.gen(function* () {
								const user = yield* getCurrentUser;
								if (Option.isNone(user)) {
									const loginRedirectUrl =
										Mobile.createMobileSessionLoginRedirectUrl({
											deploymentOrigin: getDeploymentOrigin(),
											requestUrl: request.url,
											provider: urlParams.provider,
											organizationId: urlParams.organizationId,
										});
									return HttpServerResponse.redirect(
										loginRedirectUrl.toString(),
									);
								}

								const session = yield* createMobileApiKey(user.value.id);

								if (urlParams.redirectUri) {
									const redirectUrl = getMobileRedirectUrl(
										urlParams.redirectUri,
									);
									if (!redirectUrl) {
										return yield* Effect.fail(new HttpApiError.BadRequest());
									}

									redirectUrl.searchParams.set("api_key", session.apiKey);
									redirectUrl.searchParams.set("user_id", user.value.id);
									return HttpServerResponse.redirect(redirectUrl.toString());
								}

								return session;
							}),
						),
					)
					.handle("requestEmailSession", ({ payload }) =>
						withMappedErrors(requestEmailSession(payload.email)),
					)
					.handle("verifyEmailSession", ({ payload }) =>
						withMappedErrors(verifyEmailSession(payload)),
					)
					.handle("revokeSession", ({ headers }) =>
						withMappedErrors(
							Effect.gen(function* () {
								const token = parseBearerToken(headers.authorization);
								if (!token)
									return yield* Effect.fail(new HttpApiError.Unauthorized());
								yield* database.use((db) =>
									db.delete(Db.authApiKeys).where(eq(Db.authApiKeys.id, token)),
								);
								return { success: true as const };
							}),
						),
					)
					.handle("requestAccountDeletion", () =>
						withMappedErrors(requestAccountDeletion()),
					)
					.handle("blockUser", ({ payload }) =>
						withMappedErrors(blockMobileUser(payload.userId)),
					)
					.handle("bootstrap", () => withMappedErrors(getBootstrap()))
					.handle("setActiveOrganization", ({ payload }) =>
						withMappedErrors(
							Effect.gen(function* () {
								const user = yield* CurrentUser;
								yield* assertOrganizationAccess(payload.organizationId);
								yield* database.use((db) =>
									db
										.update(Db.users)
										.set({ activeOrganizationId: payload.organizationId })
										.where(eq(Db.users.id, user.id)),
								);
								return yield* getBootstrap();
							}),
						),
					)
					.handle("updateProfile", ({ payload }) =>
						withMappedErrors(updateProfile(payload)),
					)
					.handle("updateProfileImage", ({ payload }) =>
						withMappedErrors(updateProfileImage(payload)),
					)
					.handle("removeProfileImage", () =>
						withMappedErrors(updateProfileImage(null)),
					)
					.handle("listCaps", ({ request, urlParams }) =>
						withMappedErrors(
							getCapsList(urlParams, getMobilePublicOrigin(request)),
						),
					)
					.handle("getCapStatuses", ({ payload }) =>
						withMappedErrors(getCapStatuses(payload.ids)),
					)
					.handle("createFolder", ({ payload }) =>
						withMappedErrors(createMobileFolder(payload)),
					)
					.handle("getCap", ({ path, request }) =>
						withMappedErrors(
							getCapDetail(path.id, getMobilePublicOrigin(request)),
						),
					)
					.handle("reportCap", ({ path, payload, request }) =>
						withMappedErrors(
							reportMobileCap(
								path.id,
								payload.reason,
								getMobilePublicOrigin(request),
							),
						),
					)
					.handle("getCapThumbnail", ({ path }) =>
						withMappedErrors(
							Effect.gen(function* () {
								yield* assertMobileVideoAccess(path.id);
								const thumbnailUrl = yield* getMobileThumbnailUrl(path.id);
								if (!thumbnailUrl) {
									return yield* Effect.fail(new HttpApiError.NotFound());
								}
								return HttpServerResponse.redirect(thumbnailUrl).pipe(
									HttpServerResponse.setHeaders({
										"Cache-Control": "private, max-age=300",
									}),
								);
							}),
						),
					)
					.handle("updateCapSharing", ({ path, payload, request }) =>
						withMappedErrors(
							Effect.gen(function* () {
								const publicOrigin = getMobilePublicOrigin(request);
								const user = yield* CurrentUser;
								yield* assertMobileVideoOwner(path.id);
								yield* database.use((db) =>
									db
										.update(Db.videos)
										.set({ public: payload.public })
										.where(
											and(
												eq(Db.videos.id, path.id),
												eq(Db.videos.ownerId, user.id),
											),
										),
								);
								const { cap } = yield* getCapById(path.id, publicOrigin);
								return cap;
							}),
						),
					)
					.handle("updateCapTitle", ({ path, payload, request }) =>
						withMappedErrors(
							Effect.gen(function* () {
								const publicOrigin = getMobilePublicOrigin(request);
								const user = yield* CurrentUser;
								yield* assertMobileVideoOwner(path.id);
								const title = payload.title.trim();
								if (!title) {
									return yield* Effect.fail(new HttpApiError.BadRequest());
								}

								yield* database.use((db) =>
									db
										.update(Db.videos)
										.set({ name: title })
										.where(
											and(
												eq(Db.videos.id, path.id),
												eq(Db.videos.ownerId, user.id),
											),
										),
								);
								yield* Effect.sync(() => {
									revalidatePath("/dashboard/caps");
									revalidatePath("/dashboard/shared-caps");
									revalidatePath(`/s/${path.id}`);
								});
								const { cap } = yield* getCapById(path.id, publicOrigin);
								return cap;
							}),
						),
					)
					.handle("updateCapPassword", ({ path, payload, request }) =>
						withMappedErrors(
							Effect.gen(function* () {
								const publicOrigin = getMobilePublicOrigin(request);
								const user = yield* CurrentUser;
								yield* assertMobileVideoOwner(path.id);
								const trimmedPassword = payload.password?.trim() ?? null;
								const nextPassword = trimmedPassword
									? yield* Effect.tryPromise({
											try: () => hashPassword(trimmedPassword),
											catch: () => new HttpApiError.InternalServerError(),
										})
									: null;

								yield* database.use((db) =>
									db
										.update(Db.videos)
										.set({ password: nextPassword })
										.where(
											and(
												eq(Db.videos.id, path.id),
												eq(Db.videos.ownerId, user.id),
											),
										),
								);
								const { cap } = yield* getCapById(path.id, publicOrigin);
								return cap;
							}),
						),
					)
					.handle("deleteCap", ({ path }) =>
						withMappedErrors(
							videos
								.delete(path.id)
								.pipe(Effect.map(() => ({ success: true as const }))),
						),
					)
					.handle("getPlayback", ({ path, request }) =>
						withMappedErrors(
							getPlayback(path.id, getMobilePublicOrigin(request)),
						),
					)
					.handle("getDownload", ({ path, request }) =>
						withMappedErrors(
							Effect.gen(function* () {
								const publicOrigin = getMobilePublicOrigin(request);
								const user = yield* CurrentUser;
								const repo = yield* VideosRepo;
								const maybeVideo = yield* repo.getById(path.id);
								if (Option.isNone(maybeVideo)) {
									return yield* Effect.fail(new HttpApiError.NotFound());
								}
								const [video] = maybeVideo.value;
								if (video.ownerId !== user.id) {
									return yield* Effect.fail(new HttpApiError.NotFound());
								}

								return yield* videos.getDownloadInfo(path.id).pipe(
									Effect.flatMap(
										Option.match({
											onNone: () => Effect.fail(new HttpApiError.NotFound()),
											onSome: (info) =>
												Effect.succeed({
													fileName: info.fileName,
													url: resolveMobileWebResourceUrl(
														info.downloadUrl,
														serverEnv().WEB_URL,
														publicOrigin,
													),
												}),
										}),
									),
								);
							}),
						),
					)
					.handle("getCapAnalytics", ({ path, urlParams }) =>
						withMappedErrors(getCapAnalytics(path.id, urlParams.range ?? "7d")),
					)
					.handle("getOrganizationSettings", () =>
						withMappedErrors(getOrganizationSettings()),
					)
					.handle("updateOrganizationSettings", ({ payload }) =>
						withMappedErrors(updateOrganizationSettings(payload)),
					)
					.handle("updateOrganizationIcon", ({ payload }) =>
						withMappedErrors(updateOrganizationIcon(payload)),
					)
					.handle("removeOrganizationIcon", () =>
						withMappedErrors(updateOrganizationIcon(null)),
					)
					.handle("importLoom", ({ payload, request }) =>
						withMappedErrors(importLoom(payload.loomUrl, request)),
					)
					.handle("createComment", ({ path, payload }) =>
						withMappedErrors(
							createMobileComment({
								videoId: path.id,
								content: payload.content,
								timestamp: payload.timestamp,
								parentCommentId: payload.parentCommentId ?? null,
								type: "text",
							}),
						),
					)
					.handle("deleteComment", ({ path }) =>
						withMappedErrors(
							Effect.gen(function* () {
								const user = yield* CurrentUser;
								const result = yield* database.use((db) =>
									db
										.delete(Db.comments)
										.where(
											and(
												eq(Db.comments.id, path.id),
												eq(Db.comments.authorId, user.id),
											),
										),
								);
								const affectedRows = getAffectedRows(result);
								if (affectedRows === 0) {
									return yield* Effect.fail(new HttpApiError.NotFound());
								}
								return { success: true as const };
							}),
						),
					)
					.handle("createReaction", ({ path, payload }) =>
						withMappedErrors(
							createMobileComment({
								videoId: path.id,
								content: payload.content,
								timestamp: payload.timestamp,
								parentCommentId: null,
								type: "emoji",
							}),
						),
					)
					.handle("createUpload", ({ payload, request }) =>
						withMappedErrors(
							createUpload(payload, getMobilePublicOrigin(request)),
						),
					)
					.handle("updateUploadProgress", ({ path, payload }) =>
						withMappedErrors(
							Effect.gen(function* () {
								const user = yield* CurrentUser;
								const [video] = yield* database.use((db) =>
									db
										.select({ id: Db.videos.id })
										.from(Db.videos)
										.where(
											and(
												eq(Db.videos.id, path.id),
												eq(Db.videos.ownerId, user.id),
											),
										),
								);
								if (!video)
									return yield* Effect.fail(new HttpApiError.NotFound());

								yield* videos.updateUploadProgress({
									videoId: path.id,
									uploaded: Math.max(0, Math.trunc(payload.uploaded)),
									total: Math.max(0, Math.trunc(payload.total)),
									updatedAt: new Date(),
								});
								return { success: true as const };
							}),
						),
					)
					.handle("completeUpload", ({ path, payload }) =>
						withMappedErrors(
							Effect.gen(function* () {
								const user = yield* CurrentUser;
								const [video] = yield* database.use((db) =>
									db
										.select({
											id: Db.videos.id,
											ownerId: Db.videos.ownerId,
											bucketId: Db.videos.bucket,
										})
										.from(Db.videos)
										.where(
											and(
												eq(Db.videos.id, path.id),
												eq(Db.videos.ownerId, user.id),
											),
										),
								);
								if (!video)
									return yield* Effect.fail(new HttpApiError.NotFound());

								const prefix = `${user.id}/${path.id}/`;
								if (!payload.rawFileKey.startsWith(prefix)) {
									return yield* Effect.fail(new HttpApiError.BadRequest());
								}

								if (payload.contentLength !== undefined) {
									yield* database.use((db) =>
										db
											.update(Db.videoUploads)
											.set({
												uploaded: payload.contentLength,
												total: payload.contentLength,
												updatedAt: new Date(),
											})
											.where(eq(Db.videoUploads.videoId, path.id)),
									);
								}

								yield* Effect.tryPromise(() =>
									startVideoProcessingWorkflow({
										videoId: path.id,
										userId: user.id,
										rawFileKey: payload.rawFileKey,
										bucketId: video.bucketId,
										processingMessage: "Starting video processing...",
										startFailureMessage:
											"Video uploaded, but processing could not start.",
										mode: "singlepart",
									}),
								).pipe(
									Effect.catchAll((error) =>
										Effect.logError(error).pipe(
											Effect.flatMap(() =>
												Effect.fail(new HttpApiError.InternalServerError()),
											),
										),
									),
								);

								return { success: true as const };
							}),
						),
					)
					.handle("createRecording", ({ payload, request }) =>
						withMappedErrors(
							createRecording(payload, getMobilePublicOrigin(request)),
						),
					)
					.handle("createRecordingUploadTargets", ({ path, payload }) =>
						withMappedErrors(
							createRecordingUploadTargets(path.id, payload.subpaths),
						),
					)
					.handle("completeRecording", ({ path, payload }) =>
						withMappedErrors(completeRecording(path.id, payload)),
					);
			}),
		),
	),
);

const handler = apiToHandler(ApiLive);

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const PATCH = handler;
export const DELETE = handler;
