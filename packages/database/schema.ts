import type {
	Comment,
	Folder,
	ImageUpload,
	Organisation,
	S3Bucket,
	Space,
	User,
	Video,
} from "@cap/web-domain";
import {
	boolean,
	customType,
	datetime,
	float,
	index,
	int,
	json,
	mysqlTable,
	primaryKey,
	text,
	timestamp,
	unique,
	uniqueIndex,
	varchar,
} from "drizzle-orm/mysql-core";
import { relations } from "drizzle-orm/relations";

import { nanoIdLength } from "./helpers.ts";
import type { VideoMetadata } from "./types/index.ts";

const nanoId = customType<{ data: string; notNull: true }>({
	dataType() {
		return `varchar(${nanoIdLength})`;
	},
});
// TODO: This will replace `nanoId` in: https://github.com/CapSoftware/Cap/pull/1105
const nanoIdRequired = (name: string) =>
	varchar(name, { length: nanoIdLength }).notNull();

const nanoIdNullable = customType<{ data: string; notNull: false }>({
	dataType() {
		return `varchar(${nanoIdLength})`;
	},
});

// Add a custom type for encrypted strings
const encryptedText = customType<{ data: string; notNull: true }>({
	dataType() {
		return "text";
	},
});

const encryptedTextNullable = customType<{ data: string; notNull: false }>({
	dataType() {
		return "text";
	},
});

export const users = mysqlTable(
	"users",
	{
		id: nanoId("id").notNull().primaryKey().unique().$type<User.UserId>(),
		name: varchar("name", { length: 255 }),
		lastName: varchar("lastName", { length: 255 }),
		email: varchar("email", { length: 255 }).unique().notNull(),
		emailVerified: timestamp("emailVerified"),
		image: varchar("image", { length: 255 }).$type<ImageUpload.ImageUrlOrKey>(),
		stripeCustomerId: varchar("stripeCustomerId", { length: 255 }),
		stripeSubscriptionId: varchar("stripeSubscriptionId", {
			length: 255,
		}),
		thirdPartyStripeSubscriptionId: varchar("thirdPartyStripeSubscriptionId", {
			length: 255,
		}),
		stripeSubscriptionStatus: varchar("stripeSubscriptionStatus", {
			length: 255,
		}),
		stripeSubscriptionPriceId: varchar("stripeSubscriptionPriceId", {
			length: 255,
		}),
		preferences: json("preferences")
			.$type<{
				notifications: {
					pauseComments: boolean;
					pauseReplies: boolean;
					pauseViews: boolean;
					pauseReactions: boolean;
				};
				// For analytics.
				// Adding in preferences so we don't have to
				// add a new column and can be dynamic going forward.
				trackedEvents?: {
					user_signed_up?: boolean;
				};
			} | null>()
			.default(null),
		activeOrganizationId: nanoId(
			"activeOrganizationId",
		).$type<Organisation.OrganisationId>(),
		created_at: timestamp("created_at").notNull().defaultNow(),
		updated_at: timestamp("updated_at").notNull().defaultNow().onUpdateNow(),
		onboardingSteps: json("onboardingSteps").$type<{
			welcome?: boolean;
			organizationSetup?: boolean;
			customDomain?: boolean;
			inviteTeam?: boolean;
			download?: boolean;
		}>(),
		onboarding_completed_at: timestamp("onboarding_completed_at"),
		customBucket: nanoIdNullable("customBucket"),
		inviteQuota: int("inviteQuota").notNull().default(1),
		defaultOrgId:
			nanoIdNullable("defaultOrgId").$type<Organisation.OrganisationId>(),
	},
	(table) => ({
		emailIndex: uniqueIndex("email_idx").on(table.email),
	}),
);

export const accounts = mysqlTable(
	"accounts",
	{
		id: nanoId("id").notNull().primaryKey().unique(),
		userId: nanoId("userId").notNull(),
		type: varchar("type", { length: 255 }).notNull(),
		provider: varchar("provider", { length: 255 }).notNull(),
		providerAccountId: varchar("providerAccountId", { length: 255 }).notNull(),
		access_token: text("access_token"),
		expires_in: int("expires_in"),
		id_token: text("id_token"),
		refresh_token: text("refresh_token"),
		refresh_token_expires_in: int("refresh_token_expires_in"),
		scope: varchar("scope", { length: 255 }),
		token_type: varchar("token_type", { length: 255 }),
		createdAt: timestamp("createdAt").defaultNow().notNull(),
		updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
		tempColumn: text("tempColumn"),
	},
	(table) => ({
		userIdIndex: index("user_id_idx").on(table.userId),
		providerAccountIdIndex: index("provider_account_id_idx").on(
			table.providerAccountId,
		),
	}),
);

export const sessions = mysqlTable(
	"sessions",
	{
		id: nanoId("id").notNull().primaryKey().unique(),
		sessionToken: varchar("sessionToken", { length: 255 }).unique().notNull(),
		userId: nanoId("userId").notNull().$type<User.UserId>(),
		expires: datetime("expires").notNull(),
		created_at: timestamp("created_at").notNull().defaultNow(),
		updated_at: timestamp("updated_at").notNull().defaultNow().onUpdateNow(),
	},
	(table) => ({
		sessionTokenIndex: uniqueIndex("session_token_idx").on(table.sessionToken),
		userIdIndex: index("user_id_idx").on(table.userId),
	}),
);

export const verificationTokens = mysqlTable("verification_tokens", {
	identifier: varchar("identifier", { length: 255 }).primaryKey().notNull(),
	token: varchar("token", { length: 255 }).unique().notNull(),
	expires: datetime("expires").notNull(),
	created_at: timestamp("created_at").notNull().defaultNow(),
	updated_at: timestamp("updated_at").notNull().defaultNow().onUpdateNow(),
});

export const organizations = mysqlTable(
	"organizations",
	{
		id: nanoId("id")
			.notNull()
			.primaryKey()
			.unique()
			.$type<Organisation.OrganisationId>(),
		name: varchar("name", { length: 255 }).notNull(),
		ownerId: nanoId("ownerId").notNull().$type<User.UserId>(),
		metadata: json("metadata"),
		allowedEmailDomain: varchar("allowedEmailDomain", { length: 255 }),
		customDomain: varchar("customDomain", { length: 255 }),
		domainVerified: timestamp("domainVerified"),
		settings: json("settings").$type<{
			disableSummary?: boolean;
			disableCaptions?: boolean;
			disableChapters?: boolean;
			disableReactions?: boolean;
			disableTranscript?: boolean;
			disableComments?: boolean;
		}>(),
		iconUrl: varchar("iconUrl", {
			length: 1024,
		}).$type<ImageUpload.ImageUrlOrKey>(),
		createdAt: timestamp("createdAt").notNull().defaultNow(),
		updatedAt: timestamp("updatedAt").notNull().defaultNow().onUpdateNow(),
		workosOrganizationId: varchar("workosOrganizationId", { length: 255 }),
		workosConnectionId: varchar("workosConnectionId", { length: 255 }),
	},
	(table) => ({
		ownerIdIndex: index("owner_id_idx").on(table.ownerId),
		customDomainIndex: index("custom_domain_idx").on(table.customDomain),
	}),
);

export type OrganisationMemberRole = "owner" | "member";
export const organizationMembers = mysqlTable(
	"organization_members",
	{
		id: nanoId("id").notNull().primaryKey().unique(),
		userId: nanoId("userId").notNull().$type<User.UserId>(),
		organizationId: nanoId("organizationId")
			.notNull()
			.$type<Organisation.OrganisationId>(),
		role: varchar("role", { length: 255 })
			.notNull()
			.$type<OrganisationMemberRole>(),
		createdAt: timestamp("createdAt").notNull().defaultNow(),
		updatedAt: timestamp("updatedAt").notNull().defaultNow().onUpdateNow(),
	},
	(table) => ({
		userIdIndex: index("user_id_idx").on(table.userId),
		organizationIdIndex: index("organization_id_idx").on(table.organizationId),
		userIdOrganizationIdIndex: index("user_id_organization_id_idx").on(
			table.userId,
			table.organizationId,
		),
	}),
);

export const organizationInvites = mysqlTable(
	"organization_invites",
	{
		id: nanoId("id").notNull().primaryKey().unique(),
		organizationId: nanoId("organizationId")
			.notNull()
			.$type<Organisation.OrganisationId>(),
		invitedEmail: varchar("invitedEmail", { length: 255 }).notNull(),
		invitedByUserId: nanoId("invitedByUserId").notNull().$type<User.UserId>(),
		role: varchar("role", { length: 255 })
			.notNull()
			.$type<OrganisationMemberRole>(),
		status: varchar("status", { length: 255 }).notNull().default("pending"),
		createdAt: timestamp("createdAt").notNull().defaultNow(),
		updatedAt: timestamp("updatedAt").notNull().defaultNow().onUpdateNow(),
		expiresAt: timestamp("expiresAt"),
	},
	(table) => ({
		organizationIdIndex: index("organization_id_idx").on(table.organizationId),
		invitedEmailIndex: index("invited_email_idx").on(table.invitedEmail),
		invitedByUserIdIndex: index("invited_by_user_id_idx").on(
			table.invitedByUserId,
		),
		statusIndex: index("status_idx").on(table.status),
	}),
);

export const folders = mysqlTable(
	"folders",
	{
		id: nanoId("id").notNull().primaryKey().unique().$type<Folder.FolderId>(),
		name: varchar("name", { length: 255 }).notNull(),
		color: varchar("color", {
			length: 16,
			enum: ["normal", "blue", "red", "yellow"],
		})
			.notNull()
			.default("normal"),
		organizationId: nanoId("organizationId")
			.notNull()
			.$type<Organisation.OrganisationId>(),
		createdById: nanoId("createdById").notNull().$type<User.UserId>(),
		parentId: nanoIdNullable("parentId").$type<Folder.FolderId>(),
		spaceId: nanoIdNullable("spaceId").$type<Space.SpaceIdOrOrganisationId>(),
		createdAt: timestamp("createdAt").notNull().defaultNow(),
		updatedAt: timestamp("updatedAt").notNull().defaultNow().onUpdateNow(),
	},
	(table) => ({
		organizationIdIndex: index("organization_id_idx").on(table.organizationId),
		createdByIdIndex: index("created_by_id_idx").on(table.createdById),
		parentIdIndex: index("parent_id_idx").on(table.parentId),
		spaceIdIndex: index("space_id_idx").on(table.spaceId),
	}),
);

export const videos = mysqlTable(
	"videos",
	{
		id: nanoId("id").notNull().primaryKey().unique().$type<Video.VideoId>(),
		ownerId: nanoId("ownerId").notNull().$type<User.UserId>(),
		orgId: nanoIdRequired("orgId").$type<Organisation.OrganisationId>(),
		name: varchar("name", { length: 255 }).notNull().default("My Video"),
		bucket: nanoIdNullable("bucket").$type<S3Bucket.S3BucketId>(),
		// in seconds
		duration: float("duration"),
		width: int("width"),
		height: int("height"),
		fps: int("fps"),
		metadata: json("metadata").$type<VideoMetadata>(),
		public: boolean("public").notNull().default(true),
		settings: json("settings").$type<{
			disableSummary?: boolean;
			disableCaptions?: boolean;
			disableChapters?: boolean;
			disableReactions?: boolean;
			disableTranscript?: boolean;
			disableComments?: boolean;
		}>(),
		transcriptionStatus: varchar("transcriptionStatus", { length: 255 }).$type<
			"PROCESSING" | "COMPLETE" | "ERROR" | "SKIPPED"
		>(),
		source: json("source")
			.$type<
				{ type: "MediaConvert" } | { type: "local" } | { type: "desktopMP4" }
			>()
			.notNull()
			.default({ type: "MediaConvert" }),
		folderId: nanoIdNullable("folderId").$type<Folder.FolderId>(),
		createdAt: timestamp("createdAt").notNull().defaultNow(),
		updatedAt: timestamp("updatedAt").notNull().defaultNow().onUpdateNow(),
		// PRIVATE
		password: encryptedTextNullable("password"),
		// LEGACY
		xStreamInfo: text("xStreamInfo"),
		isScreenshot: boolean("isScreenshot").notNull().default(false),
		// DEPRECATED
		awsRegion: varchar("awsRegion", { length: 255 }),
		awsBucket: varchar("awsBucket", { length: 255 }),
		videoStartTime: varchar("videoStartTime", { length: 255 }),
		audioStartTime: varchar("audioStartTime", { length: 255 }),
		jobId: varchar("jobId", { length: 255 }),
		jobStatus: varchar("jobStatus", { length: 255 }),
		skipProcessing: boolean("skipProcessing").notNull().default(false),
	},
	(table) => [
		index("id_idx").on(table.id),
		index("owner_id_idx").on(table.ownerId),
		index("is_public_idx").on(table.public),
		index("folder_id_idx").on(table.folderId),
	],
);

export const sharedVideos = mysqlTable(
	"shared_videos",
	{
		id: nanoId("id").notNull().primaryKey().unique(),
		videoId: nanoId("videoId").notNull().$type<Video.VideoId>(),
		folderId: nanoIdNullable("folderId").$type<Folder.FolderId>(),
		organizationId: nanoId("organizationId")
			.notNull()
			.$type<Organisation.OrganisationId>(),
		sharedByUserId: nanoId("sharedByUserId").notNull().$type<User.UserId>(),
		sharedAt: timestamp("sharedAt").notNull().defaultNow(),
	},
	(table) => ({
		videoIdIndex: index("video_id_idx").on(table.videoId),
		folderIdIndex: index("folder_id_idx").on(table.folderId),
		organizationIdIndex: index("organization_id_idx").on(table.organizationId),
		sharedByUserIdIndex: index("shared_by_user_id_idx").on(
			table.sharedByUserId,
		),
		videoIdOrganizationIdIndex: index("video_id_organization_id_idx").on(
			table.videoId,
			table.organizationId,
		),
		videoIdFolderIdIndex: index("video_id_folder_id_idx").on(
			table.videoId,
			table.folderId,
		),
	}),
);

export const comments = mysqlTable(
	"comments",
	{
		id: nanoId("id").notNull().primaryKey().unique().$type<Comment.CommentId>(),
		type: varchar("type", { length: 6, enum: ["emoji", "text"] }).notNull(),
		content: text("content").notNull(),
		timestamp: float("timestamp"),
		authorId: nanoId("authorId").notNull().$type<User.UserId>(),
		videoId: nanoId("videoId").notNull().$type<Video.VideoId>(),
		createdAt: timestamp("createdAt").notNull().defaultNow(),
		updatedAt: timestamp("updatedAt").notNull().defaultNow().onUpdateNow(),
		parentCommentId:
			nanoIdNullable("parentCommentId").$type<Comment.CommentId>(),
	},
	(table) => ({
		videoIdIndex: index("video_id_idx").on(table.videoId),
		authorIdIndex: index("author_id_idx").on(table.authorId),
		parentCommentIdIndex: index("parent_comment_id_idx").on(
			table.parentCommentId,
		),
	}),
);

export const notifications = mysqlTable(
	"notifications",
	{
		id: nanoId("id").notNull().primaryKey().unique(),
		orgId: nanoId("orgId").notNull().$type<Organisation.OrganisationId>(),
		recipientId: nanoId("recipientId").notNull().$type<User.UserId>(),
		type: varchar("type", { length: 10 })
			.notNull()
			.$type<"view" | "comment" | "reply" | "reaction" /*| "mention"*/>(),
		data: json("data")
			.$type<{
				videoId?: string;
				authorId?: string;
				comment?: {
					id: string;
					content: string;
				};
			}>()
			.notNull(),
		readAt: timestamp("readAt"),
		createdAt: timestamp("createdAt").notNull().defaultNow(),
	},
	(table) => ({
		recipientIdIndex: index("recipient_id_idx").on(table.recipientId),
		orgIdIndex: index("org_id_idx").on(table.orgId),
		typeIndex: index("type_idx").on(table.type),
		readAtIndex: index("read_at_idx").on(table.readAt),
		createdAtIndex: index("created_at_idx").on(table.createdAt),
		recipientReadIndex: index("recipient_read_idx").on(
			table.recipientId,
			table.readAt,
		),
		recipientCreatedIndex: index("recipient_created_idx").on(
			table.recipientId,
			table.createdAt,
		),
	}),
);

export const s3Buckets = mysqlTable("s3_buckets", {
	id: nanoId("id").notNull().primaryKey().unique().$type<S3Bucket.S3BucketId>(),
	ownerId: nanoId("ownerId").notNull().$type<User.UserId>(),
	// Use encryptedText for sensitive fields
	region: encryptedText("region").notNull(),
	endpoint: encryptedTextNullable("endpoint"),
	bucketName: encryptedText("bucketName").notNull(),
	accessKeyId: encryptedText("accessKeyId").notNull(),
	secretAccessKey: encryptedText("secretAccessKey").notNull(),
	provider: text("provider").notNull().default("aws"),
});

export const notificationsRelations = relations(notifications, ({ one }) => ({
	org: one(organizations, {
		fields: [notifications.orgId],
		references: [organizations.id],
	}),
	recipient: one(users, {
		fields: [notifications.recipientId],
		references: [users.id],
	}),
}));

export const authApiKeys = mysqlTable("auth_api_keys", {
	id: varchar("id", { length: 36 }).notNull().primaryKey().unique(),
	userId: nanoId("userId").notNull().$type<User.UserId>(),
	createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const commentsRelations = relations(comments, ({ one }) => ({
	author: one(users, {
		fields: [comments.authorId],
		references: [users.id],
	}),
	video: one(videos, {
		fields: [comments.videoId],
		references: [videos.id],
	}),
	parentComment: one(comments, {
		fields: [comments.parentCommentId],
		references: [comments.id],
	}),
}));

// Define Relationships
export const usersRelations = relations(users, ({ many, one }) => ({
	accounts: many(accounts),
	sessions: many(sessions),
	organizationMembers: many(organizationMembers),
	videos: many(videos),
	sharedVideos: many(sharedVideos),
	customBucket: one(s3Buckets),
	spaces: many(spaces),
	spaceMembers: many(spaceMembers),
}));

export const accountsRelations = relations(accounts, ({ one }) => ({
	user: one(users, {
		fields: [accounts.userId],
		references: [users.id],
	}),
}));

export const s3BucketsRelations = relations(s3Buckets, ({ one }) => ({
	owner: one(users, {
		fields: [s3Buckets.ownerId],
		references: [users.id],
	}),
}));

export const organizationsRelations = relations(
	organizations,
	({ one, many }) => ({
		owner: one(users, {
			fields: [organizations.ownerId],
			references: [users.id],
		}),
		organizationMembers: many(organizationMembers),
		sharedVideos: many(sharedVideos),
		organizationInvites: many(organizationInvites),
		spaces: many(spaces),
	}),
);

export const sessionsRelations = relations(sessions, ({ one }) => ({
	user: one(users, {
		fields: [sessions.userId],
		references: [users.id],
	}),
}));

export const verificationTokensRelations = relations(
	verificationTokens,
	() => ({
		// No relations defined
	}),
);

export const organizationMembersRelations = relations(
	organizationMembers,
	({ one }) => ({
		user: one(users, {
			fields: [organizationMembers.userId],
			references: [users.id],
		}),
		organization: one(organizations, {
			fields: [organizationMembers.organizationId],
			references: [organizations.id],
		}),
	}),
);

export const organizationInvitesRelations = relations(
	organizationInvites,
	({ one }) => ({
		organization: one(organizations, {
			fields: [organizationInvites.organizationId],
			references: [organizations.id],
		}),
		invitedByUser: one(users, {
			fields: [organizationInvites.invitedByUserId],
			references: [users.id],
		}),
	}),
);

export const videosRelations = relations(videos, ({ one, many }) => ({
	owner: one(users, {
		fields: [videos.ownerId],
		references: [users.id],
	}),
	sharedVideos: many(sharedVideos),
	spaceVideos: many(spaceVideos),
	folder: one(folders, {
		fields: [videos.folderId],
		references: [folders.id],
	}),
}));

export const sharedVideosRelations = relations(sharedVideos, ({ one }) => ({
	video: one(videos, {
		fields: [sharedVideos.videoId],
		references: [videos.id],
	}),
	organization: one(organizations, {
		fields: [sharedVideos.organizationId],
		references: [organizations.id],
	}),
	sharedByUser: one(users, {
		fields: [sharedVideos.sharedByUserId],
		references: [users.id],
	}),
}));

export const spaces = mysqlTable(
	"spaces",
	{
		id: nanoId("id")
			.notNull()
			.primaryKey()
			.unique()
			.$type<Space.SpaceIdOrOrganisationId>(),
		primary: boolean("primary").notNull().default(false),
		name: varchar("name", { length: 255 }).notNull(),
		organizationId: nanoId("organizationId")
			.notNull()
			.$type<Organisation.OrganisationId>(),
		createdById: nanoId("createdById").notNull().$type<User.UserId>(),
		iconUrl: varchar("iconUrl", {
			length: 255,
		}).$type<ImageUpload.ImageUrlOrKey>(),
		description: varchar("description", { length: 1000 }),
		createdAt: timestamp("createdAt").notNull().defaultNow(),
		updatedAt: timestamp("updatedAt").notNull().defaultNow().onUpdateNow(),
		privacy: varchar("privacy", { length: 255, enum: ["Public", "Private"] })
			.notNull()
			.default("Private"),
	},
	(table) => ({
		organizationIdIndex: index("organization_id_idx").on(table.organizationId),
		createdByIdIndex: index("created_by_id_idx").on(table.createdById),
	}),
);

export const spaceMembers = mysqlTable(
	"space_members",
	{
		id: nanoId("id").notNull().primaryKey().unique(),
		spaceId: nanoId("spaceId").notNull().$type<Space.SpaceIdOrOrganisationId>(),
		userId: nanoId("userId").notNull().$type<User.UserId>(),
		role: varchar("role", { length: 255 })
			.notNull()
			.default("member")
			.$type<"member" | "Admin">(),
		createdAt: timestamp("createdAt").notNull().defaultNow(),
		updatedAt: timestamp("updatedAt").notNull().defaultNow().onUpdateNow(),
	},
	(table) => ({
		spaceIdIndex: index("space_id_idx").on(table.spaceId),
		userIdIndex: index("user_id_idx").on(table.userId),
		spaceIdUserIdIndex: index("space_id_user_id_idx").on(
			table.spaceId,
			table.userId,
		),
		spaceIdUserIdUnique: unique("space_id_user_id_unique").on(
			table.spaceId,
			table.userId,
		),
	}),
);

export const spaceVideos = mysqlTable(
	"space_videos",
	{
		id: nanoId("id").notNull().primaryKey().unique(),
		spaceId: nanoId("spaceId").notNull().$type<Space.SpaceIdOrOrganisationId>(),
		folderId: nanoIdNullable("folderId").$type<Folder.FolderId>(),
		videoId: nanoId("videoId").notNull().$type<Video.VideoId>(),
		addedById: nanoId("addedById").notNull().$type<User.UserId>(),
		addedAt: timestamp("addedAt").notNull().defaultNow(),
	},
	(table) => ({
		spaceIdIndex: index("space_id_idx").on(table.spaceId),
		folderIdIndex: index("folder_id_idx").on(table.folderId),
		videoIdIndex: index("video_id_idx").on(table.videoId),
		addedByIdIndex: index("added_by_id_idx").on(table.addedById),
		spaceIdVideoIdIndex: index("space_id_video_id_idx").on(
			table.spaceId,
			table.videoId,
		),
	}),
);

export const spacesRelations = relations(spaces, ({ one, many }) => ({
	organization: one(organizations, {
		fields: [spaces.organizationId],
		references: [organizations.id],
	}),
	createdBy: one(users, {
		fields: [spaces.createdById],
		references: [users.id],
	}),
	spaceMembers: many(spaceMembers),
	spaceVideos: many(spaceVideos),
}));

export const spaceMembersRelations = relations(spaceMembers, ({ one }) => ({
	space: one(spaces, {
		fields: [spaceMembers.spaceId],
		references: [spaces.id],
	}),
	user: one(users, {
		fields: [spaceMembers.userId],
		references: [users.id],
	}),
}));

export const spaceVideosRelations = relations(spaceVideos, ({ one }) => ({
	space: one(spaces, {
		fields: [spaceVideos.spaceId],
		references: [spaces.id],
	}),
	video: one(videos, {
		fields: [spaceVideos.videoId],
		references: [videos.id],
	}),
	addedBy: one(users, {
		fields: [spaceVideos.addedById],
		references: [users.id],
	}),
}));

export const foldersRelations = relations(folders, ({ one, many }) => ({
	organization: one(organizations, {
		fields: [folders.organizationId],
		references: [organizations.id],
	}),
	createdBy: one(users, {
		fields: [folders.createdById],
		references: [users.id],
	}),
	parentFolder: one(folders, {
		fields: [folders.parentId],
		references: [folders.id],
		relationName: "parentChild",
	}),
	childFolders: many(folders, { relationName: "parentChild" }),
	videos: many(videos),
}));

export const videoUploads = mysqlTable("video_uploads", {
	videoId: nanoId("video_id").primaryKey().notNull().$type<Video.VideoId>(),
	uploaded: int("uploaded").notNull().default(0),
	total: int("total").notNull().default(0),
	startedAt: timestamp("started_at").notNull().defaultNow(),
	updatedAt: timestamp("updated_at").notNull().defaultNow(),
	mode: varchar("mode", { length: 255, enum: ["singlepart", "multipart"] }),
});

export const importedVideos = mysqlTable(
	"imported_videos",
	{
		id: nanoId("id").notNull(),
		orgId: nanoIdNullable("orgId")
			.notNull()
			.$type<Organisation.OrganisationId>(),
		source: varchar("source", { length: 255, enum: ["loom"] }).notNull(),
		sourceId: varchar("source_id", { length: 255 }).notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.orgId, table.source, table.sourceId] }),
	],
);
