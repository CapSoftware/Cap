import crypto from "node:crypto";
import { authOptions } from "@cap/database/auth/auth-options";
import { isEmailAllowedForSignup } from "@cap/database/auth/domain-utils";
import { hashPassword } from "@cap/database/crypto";
import { sendEmail } from "@cap/database/emails/config";
import { OTPEmail } from "@cap/database/emails/otp-email";
import { nanoId } from "@cap/database/helpers";
import * as Db from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import {
	Database,
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
	User,
	Video,
} from "@cap/web-domain";
import {
	HttpApiBuilder,
	HttpApiError,
	HttpServerResponse,
} from "@effect/platform";
import { and, count, desc, eq, isNull, or, sql } from "drizzle-orm";
import { Effect, Exit, Layer, Option } from "effect";
import { revalidatePath } from "next/cache";
import { queueDesktopSegmentsFinalization } from "@/lib/desktop-segments-finalization";
import { resolveMobileRequestOrigin } from "@/lib/mobile-request-origin";
import { createNotification } from "@/lib/Notification";
import { apiToHandler } from "@/lib/server";
import { startVideoProcessingWorkflow } from "@/lib/video-processing";

export const dynamic = "force-dynamic";

type CapRow = {
	id: Video.VideoId;
	name: string;
	createdAt: Date;
	updatedAt: Date;
	ownerName: string | null;
	duration: number | null;
	folderId: Folder.FolderId | null;
	public: boolean;
	hasPassword: boolean;
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
type MobileFolderCreateInput = (typeof Mobile.MobileFolderCreateInput)["Type"];
type MobileUploadCreateInput = (typeof Mobile.MobileUploadCreateInput)["Type"];
type MobileRecordingCreateInput =
	(typeof Mobile.MobileRecordingCreateInput)["Type"];
type MobileRecordingCompleteInput =
	(typeof Mobile.MobileRecordingCompleteInput)["Type"];

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const emailCodePattern = /^\d{6}$/;
const emailCodeTtlMs = 10 * 60 * 1000;

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

const getMobilePublicOrigin = (requestUrl: string) =>
	resolveMobileRequestOrigin(getDeploymentOrigin(), requestUrl);

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
	thumbnailUrl: string | null,
	viewCount: number,
	publicOrigin: string,
): MobileCapSummary => ({
	id: row.id,
	shareUrl: `${publicOrigin}/s/${row.id}`,
	title: row.name,
	createdAt: toIsoString(row.createdAt),
	updatedAt: toIsoString(row.updatedAt),
	ownerName: row.ownerName ?? "",
	durationSeconds: row.duration,
	thumbnailUrl,
	folderId: row.folderId,
	public: row.public,
	protected: row.hasPassword,
	viewCount,
	commentCount: Number(row.commentCount),
	reactionCount: Number(row.reactionCount),
	upload: row.uploadVideoId
		? {
				uploaded: Number(row.uploadUploaded ?? 0),
				total: Number(row.uploadTotal ?? 0),
				phase: row.uploadPhase ?? "uploading",
				processingProgress: Number(row.processingProgress ?? 0),
				processingMessage: row.processingMessage,
				processingError: row.processingError,
			}
		: null,
});

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

const createMobileApiKey = Effect.fn("Mobile.createMobileApiKey")(function* (
	userId: User.UserId,
) {
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

const getRootFolders = Effect.fn("Mobile.getRootFolders")(function* (
	organizationId: Organisation.OrganisationId,
) {
	const user = yield* CurrentUser;
	const database = yield* Database;

	const rows = yield* database.use((db) =>
		db
			.select({
				id: Db.folders.id,
				name: Db.folders.name,
				color: Db.folders.color,
				parentId: Db.folders.parentId,
				videoCount: sql<number>`(
					SELECT COUNT(*)
					FROM ${Db.videos}
					WHERE ${Db.videos.folderId} = ${Db.folders.id}
						AND ${Db.videos.ownerId} = ${user.id}
						AND ${Db.videos.orgId} = ${organizationId}
				)`,
			})
			.from(Db.folders)
			.where(
				and(
					eq(Db.folders.organizationId, organizationId),
					eq(Db.folders.createdById, user.id),
					isNull(Db.folders.parentId),
					isNull(Db.folders.spaceId),
				),
			),
	);

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

const getBootstrap = Effect.fn("Mobile.getBootstrap")(function* () {
	const user = yield* CurrentUser;
	const database = yield* Database;
	const imageUploads = yield* ImageUploads;

	const [userRow] = yield* database.use((db) =>
		db
			.select({
				id: Db.users.id,
				name: Db.users.name,
				email: Db.users.email,
				image: Db.users.image,
				activeOrganizationId: Db.users.activeOrganizationId,
			})
			.from(Db.users)
			.where(eq(Db.users.id, user.id)),
	);
	if (!userRow) return yield* Effect.fail(new HttpApiError.Unauthorized());

	const organizations = yield* getAccessibleOrganizations(user.id);
	const activeOrganization =
		organizations.find((org) => org.id === userRow.activeOrganizationId) ??
		organizations[0] ??
		null;
	const activeOrganizationId = activeOrganization?.id ?? null;
	const rootFolders = activeOrganizationId
		? yield* getRootFolders(activeOrganizationId)
		: [];
	const imageUrl = userRow.image
		? yield* imageUploads.resolveImageUrl(userRow.image)
		: null;

	return {
		user: {
			id: userRow.id,
			name: userRow.name,
			email: userRow.email,
			imageUrl,
			activeOrganizationId: activeOrganizationId ?? user.activeOrganizationId,
		},
		organizations,
		activeOrganizationId,
		rootFolders,
	};
});

const getCapRows = Effect.fn("Mobile.getCapRows")(function* ({
	folderId,
	page,
	limit,
}: {
	folderId: Folder.FolderId | null;
	page: number;
	limit: number;
}) {
	const user = yield* CurrentUser;
	const database = yield* Database;
	const offset = (page - 1) * limit;
	const folderFilter = folderId
		? eq(Db.videos.folderId, folderId)
		: isNull(Db.videos.folderId);
	const whereClause = and(
		eq(Db.videos.ownerId, user.id),
		eq(Db.videos.orgId, user.activeOrganizationId),
		folderFilter,
		isNull(Db.organizations.tombstoneAt),
	);

	const [totalRow] = yield* database.use((db) =>
		db
			.select({ value: count() })
			.from(Db.videos)
			.leftJoin(Db.organizations, eq(Db.videos.orgId, Db.organizations.id))
			.where(whereClause),
	);

	const rows = yield* database.use((db) =>
		db
			.select({
				id: Db.videos.id,
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
			.leftJoin(Db.organizations, eq(Db.videos.orgId, Db.organizations.id))
			.where(whereClause)
			.groupBy(
				Db.videos.id,
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
			.orderBy(desc(Db.videos.effectiveCreatedAt))
			.limit(limit)
			.offset(offset),
	);

	return { rows, total: totalRow?.value ?? 0 };
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

	const [{ rows, total }, folders] = yield* Effect.all([
		getCapRows({ folderId, page, limit }),
		folderId ? Effect.succeed([]) : getRootFolders(user.activeOrganizationId),
	]);
	const analyticsExits = yield* videos
		.getAnalyticsBulk(rows.map((row) => row.id))
		.pipe(Effect.catchAll(() => Effect.succeed([])));
	const viewCounts = new Map<Video.VideoId, number>();

	rows.forEach((row, index) => {
		const result = analyticsExits[index];
		viewCounts.set(
			row.id,
			result && Exit.isSuccess(result) ? result.value.count : 0,
		);
	});

	const caps = yield* Effect.forEach(
		rows,
		(row) =>
			videos.getThumbnailURL(row.id).pipe(
				Effect.map(Option.getOrNull),
				Effect.catchAll(() => Effect.succeed(null)),
				Effect.map((thumbnailUrl) =>
					toMobileCapSummary(
						row,
						thumbnailUrl,
						viewCounts.get(row.id) ?? 0,
						publicOrigin,
					),
				),
			),
		{ concurrency: 5 },
	);

	return {
		folders,
		caps,
		page,
		limit,
		total,
		hasMore: page * limit < total,
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
			spaceId: null,
		}),
	);

	yield* Effect.sync(() => {
		revalidatePath("/dashboard/caps");
	});

	return {
		id,
		name,
		color,
		parentId: null,
		videoCount: 0,
	};
});

const getCapById = Effect.fn("Mobile.getCapById")(function* (
	videoId: Video.VideoId,
	publicOrigin: string,
) {
	const user = yield* CurrentUser;
	const database = yield* Database;
	const videos = yield* Videos;

	const [row] = yield* database.use((db) =>
		db
			.select({
				id: Db.videos.id,
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
			.where(and(eq(Db.videos.id, videoId), eq(Db.videos.ownerId, user.id)))
			.groupBy(
				Db.videos.id,
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

	const thumbnailUrl = yield* videos.getThumbnailURL(row.id).pipe(
		Effect.map(Option.getOrNull),
		Effect.catchAll(() => Effect.succeed(null)),
	);
	const analytics = yield* videos.getAnalytics(row.id).pipe(
		Effect.map((result) => result.count),
		Effect.catchAll(() => Effect.succeed(0)),
	);

	return {
		row,
		cap: toMobileCapSummary(row, thumbnailUrl, analytics, publicOrigin),
	};
});

const assertCanCreateFeedback = Effect.fn("Mobile.assertCanCreateFeedback")(
	function* (videoId: Video.VideoId) {
		const user = yield* CurrentUser;
		const database = yield* Database;
		const [row] = yield* database.use((db) =>
			db
				.select({
					ownerId: Db.videos.ownerId,
					sharedOrganizationId: Db.sharedVideos.organizationId,
				})
				.from(Db.videos)
				.leftJoin(
					Db.sharedVideos,
					and(
						eq(Db.sharedVideos.videoId, Db.videos.id),
						eq(Db.sharedVideos.organizationId, user.activeOrganizationId),
					),
				)
				.where(eq(Db.videos.id, videoId))
				.limit(1),
		);

		if (!row) return yield* Effect.fail(new HttpApiError.NotFound());
		if (row.ownerId === user.id) return;
		if (
			row.sharedOrganizationId &&
			(yield* hasOrganizationAccess(row.sharedOrganizationId))
		) {
			return;
		}

		return yield* Effect.fail(new HttpApiError.NotFound());
	},
);

const getComments = Effect.fn("Mobile.getComments")(function* (
	videoId: Video.VideoId,
) {
	const database = yield* Database;
	const imageUploads = yield* ImageUploads;

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
			})
			.from(Db.comments)
			.leftJoin(Db.users, eq(Db.comments.authorId, Db.users.id))
			.where(eq(Db.comments.videoId, videoId))
			.orderBy(Db.comments.createdAt),
	);

	return yield* Effect.forEach(
		rows,
		(row) =>
			Effect.gen(function* () {
				const imageUrl = row.authorImage
					? yield* imageUploads
							.resolveImageUrl(row.authorImage)
							.pipe(Effect.catchAll(() => Effect.succeed(null)))
					: null;

				return {
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
						imageUrl,
					},
				};
			}),
		{ concurrency: 5 },
	);
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

	const comments = yield* getComments(videoId);
	const created = comments.find((comment) => comment.id === id);
	if (!created)
		return yield* Effect.fail(new HttpApiError.InternalServerError());
	return created;
});

const getPlayback = Effect.fn("Mobile.getPlayback")(function* (
	videoId: Video.VideoId,
	publicOrigin: string,
) {
	const user = yield* CurrentUser;
	const videos = yield* Videos;
	const storage = yield* Storage;
	const [video] = yield* videos.getByIdForViewing(videoId).pipe(
		Effect.flatten,
		Effect.catchTag("NoSuchElementException", () =>
			Effect.fail(new Video.NotFoundError()),
		),
	);

	if (video.ownerId !== user.id) {
		return yield* Effect.fail(new HttpApiError.NotFound());
	}

	const [bucket] = yield* storage.getAccessForVideo(video);
	const source = Video.Video.getSource(video);

	const transcriptKey = `${video.ownerId}/${video.id}/transcription.vtt`;
	const transcriptUrl = yield* bucket.headObject(transcriptKey).pipe(
		Effect.flatMap(() => bucket.getSignedObjectUrl(transcriptKey)),
		Effect.catchAll(() => Effect.succeed(null)),
	);

	if (source instanceof Video.Mp4Source) {
		const url = yield* bucket.getSignedObjectUrl(source.getFileKey());
		return { kind: "mp4" as const, url, transcriptUrl };
	}

	if (source instanceof Video.M3U8Source) {
		const url = yield* bucket.getSignedObjectUrl(source.getPlaylistFileKey());
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
	const { cap } = yield* getCapById(videoId, publicOrigin);

	return {
		id: videoId,
		shareUrl: `${publicOrigin}/s/${videoId}`,
		rawFileKey,
		upload,
		cap,
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

	const { cap } = yield* getCapById(videoId, publicOrigin);
	return {
		id: videoId,
		shareUrl: `${publicOrigin}/s/${videoId}`,
		cap,
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

	const storage = yield* Storage;
	const database = yield* Database;
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
							googleAuthAvailable: Boolean(serverEnv().GOOGLE_CLIENT_ID),
							workosAuthAvailable: Boolean(serverEnv().WORKOS_CLIENT_ID),
						}),
					)
					.handle("requestSession", ({ request, urlParams }) =>
						withMappedErrors(
							Effect.gen(function* () {
								const user = yield* getCurrentUser;
								if (Option.isNone(user)) {
									const redirectOrigin = getDeploymentOrigin();
									const requestUrl = new URL(request.url);
									const loginRedirectUrl = new URL(`${redirectOrigin}/login`);
									loginRedirectUrl.searchParams.set(
										"next",
										new URL(
											`${redirectOrigin}${requestUrl.pathname}${requestUrl.search}`,
										).toString(),
									);
									if (urlParams.provider === "google") {
										loginRedirectUrl.searchParams.set(
											"mobileProvider",
											"google",
										);
									} else if (urlParams.provider === "workos") {
										loginRedirectUrl.searchParams.set(
											"mobileProvider",
											"workos",
										);
										if (urlParams.organizationId) {
											loginRedirectUrl.searchParams.set(
												"organizationId",
												urlParams.organizationId,
											);
										}
									}
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
					.handle("listCaps", ({ request, urlParams }) =>
						withMappedErrors(
							getCapsList(
								urlParams,
								getMobilePublicOrigin(request.originalUrl),
							),
						),
					)
					.handle("createFolder", ({ payload }) =>
						withMappedErrors(createMobileFolder(payload)),
					)
					.handle("getCap", ({ path, request }) =>
						withMappedErrors(
							getCapDetail(path.id, getMobilePublicOrigin(request.originalUrl)),
						),
					)
					.handle("updateCapSharing", ({ path, payload, request }) =>
						withMappedErrors(
							Effect.gen(function* () {
								const publicOrigin = getMobilePublicOrigin(request.originalUrl);
								const user = yield* CurrentUser;
								yield* getCapById(path.id, publicOrigin);
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
								const publicOrigin = getMobilePublicOrigin(request.originalUrl);
								const user = yield* CurrentUser;
								yield* getCapById(path.id, publicOrigin);
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
								const publicOrigin = getMobilePublicOrigin(request.originalUrl);
								const user = yield* CurrentUser;
								yield* getCapById(path.id, publicOrigin);
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
							getPlayback(path.id, getMobilePublicOrigin(request.originalUrl)),
						),
					)
					.handle("getDownload", ({ path }) =>
						withMappedErrors(
							Effect.gen(function* () {
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
													url: info.downloadUrl,
												}),
										}),
									),
								);
							}),
						),
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
							createUpload(payload, getMobilePublicOrigin(request.originalUrl)),
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
							createRecording(
								payload,
								getMobilePublicOrigin(request.originalUrl),
							),
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
export const PATCH = handler;
export const DELETE = handler;
