import {
  customType,
  datetime,
  int,
  json,
  mysqlTable,
  text,
  timestamp,
  index,
  boolean,
  uniqueIndex,
  varchar,
  float,
} from "drizzle-orm/mysql-core";
import { relations } from "drizzle-orm/relations";
import { nanoIdLength } from "./helpers";

const nanoId = customType<{ data: string; notNull: true }>({
  dataType() {
    return `varchar(${nanoIdLength})`;
  },
});

export const users = mysqlTable(
  "users",
  {
    id: nanoId("id").notNull().primaryKey().unique(),
    name: varchar("name", { length: 255 }),
    lastName: varchar("lastName", { length: 255 }),
    email: varchar("email", { length: 255 }).unique().notNull(),
    emailVerified: timestamp("emailVerified"),
    image: varchar("image", { length: 255 }),
    stripeCustomerId: varchar("stripeCustomerId", { length: 255 }),
    stripeSubscriptionId: varchar("stripeSubscriptionId", {
      length: 255,
    }),
    stripeSubscriptionStatus: varchar("stripeSubscriptionStatus", {
      length: 255,
    }),
    stripeSubscriptionPriceId: varchar("stripeSubscriptionPriceId", {
      length: 255,
    }),
    activeSpaceId: nanoId("activeSpaceId"),
    created_at: timestamp("created_at").notNull().defaultNow(),
    updated_at: timestamp("updated_at").notNull().defaultNow().onUpdateNow(),
    onboarding_completed_at: timestamp("onboarding_completed_at"),
  },
  (table) => ({
    emailIndex: uniqueIndex("email_idx").on(table.email),
  })
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
  },
  (table) => ({
    userIdIndex: index("user_id_idx").on(table.userId),
    providerAccountIdIndex: index("provider_account_id_idx").on(
      table.providerAccountId
    ),
  })
);

export const sessions = mysqlTable(
  "sessions",
  {
    id: nanoId("id").notNull().primaryKey().unique(),
    sessionToken: varchar("sessionToken", { length: 255 }).unique().notNull(),
    userId: nanoId("userId").notNull(),
    expires: datetime("expires").notNull(),
    created_at: timestamp("created_at").notNull().defaultNow(),
    updated_at: timestamp("updated_at").notNull().defaultNow().onUpdateNow(),
  },
  (table) => ({
    sessionTokenIndex: uniqueIndex("session_token_idx").on(table.sessionToken),
    userIdIndex: index("user_id_idx").on(table.userId),
  })
);

export const verificationTokens = mysqlTable("verification_tokens", {
  identifier: varchar("identifier", { length: 255 }).primaryKey().notNull(),
  token: varchar("token", { length: 255 }).unique().notNull(),
  expires: datetime("expires").notNull(),
  created_at: timestamp("created_at").notNull().defaultNow(),
  updated_at: timestamp("updated_at").notNull().defaultNow().onUpdateNow(),
});

export const spaces = mysqlTable(
  "spaces",
  {
    id: nanoId("id").notNull().primaryKey().unique(),
    name: varchar("name", { length: 255 }).notNull(),
    ownerId: nanoId("ownerId").notNull(),
    metadata: json("metadata"),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
    updatedAt: timestamp("updatedAt").notNull().defaultNow().onUpdateNow(),
  },
  (table) => ({
    ownerIdIndex: index("owner_id_idx").on(table.ownerId),
  })
);

export const spaceMembers = mysqlTable(
  "space_members",
  {
    id: nanoId("id").notNull().primaryKey().unique(),
    userId: nanoId("userId").notNull(),
    spaceId: nanoId("spaceId").notNull(),
    role: varchar("role", { length: 255 }).notNull(),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
    updatedAt: timestamp("updatedAt").notNull().defaultNow().onUpdateNow(),
  },
  (table) => ({
    userIdIndex: index("user_id_idx").on(table.userId),
    spaceIdIndex: index("space_id_idx").on(table.spaceId),
    userIdSpaceIdIndex: index("user_id_space_id_idx").on(
      table.userId,
      table.spaceId
    ),
  })
);

export const videos = mysqlTable(
  "videos",
  {
    id: nanoId("id").notNull().primaryKey().unique(),
    ownerId: nanoId("ownerId").notNull(),
    name: varchar("name", { length: 255 }).notNull().default("My Video"),
    awsRegion: varchar("awsRegion", { length: 255 }),
    awsBucket: varchar("awsBucket", { length: 255 }),
    metadata: json("metadata"),
    public: boolean("public").notNull().default(true),
    videoStartTime: varchar("videoStartTime", { length: 255 }),
    audioStartTime: varchar("audioStartTime", { length: 255 }),
    xStreamInfo: text("xStreamInfo"),
    jobId: varchar("jobId", { length: 255 }),
    jobStatus: varchar("jobStatus", { length: 255 }),
    skipProcessing: boolean("skipProcessing").notNull().default(false),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
    updatedAt: timestamp("updatedAt").notNull().defaultNow().onUpdateNow(),
  },
  (table) => ({
    idIndex: index("id_idx").on(table.id),
    ownerIdIndex: index("owner_id_idx").on(table.ownerId),
    publicIndex: index("is_public_idx").on(table.public),
  })
);

export const sharedVideos = mysqlTable(
  "shared_videos",
  {
    id: nanoId("id").notNull().primaryKey().unique(),
    videoId: nanoId("videoId").notNull(),
    spaceId: nanoId("spaceId").notNull(),
    sharedByUserId: nanoId("sharedByUserId").notNull(),
    sharedAt: timestamp("sharedAt").notNull().defaultNow(),
  },
  (table) => ({
    videoIdIndex: index("video_id_idx").on(table.videoId),
    spaceIdIndex: index("space_id_idx").on(table.spaceId),
    sharedByUserIdIndex: index("shared_by_user_id_idx").on(
      table.sharedByUserId
    ),
    videoIdSpaceIdIndex: index("video_id_space_id_idx").on(
      table.videoId,
      table.spaceId
    ),
  })
);

export const comments = mysqlTable(
  "comments",
  {
    id: nanoId("id").notNull().primaryKey().unique(),
    type: varchar("type", { length: 6, enum: ["emoji", "text"] }).notNull(),
    content: text("content").notNull(),
    timestamp: float("timestamp"),
    authorId: nanoId("authorId").notNull(),
    videoId: nanoId("videoId").notNull(),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
    updatedAt: timestamp("updatedAt").notNull().defaultNow().onUpdateNow(),
    parentCommentId: nanoId("parentCommentId"),
  },
  (table) => ({
    videoIdIndex: index("video_id_idx").on(table.videoId),
    authorIdIndex: index("author_id_idx").on(table.authorId),
    parentCommentIdIndex: index("parent_comment_id_idx").on(
      table.parentCommentId
    ),
  })
);

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
export const usersRelations = relations(users, ({ many }) => ({
  accounts: many(accounts),
  sessions: many(sessions),
  spaceMembers: many(spaceMembers),
  videos: many(videos),
  sharedVideos: many(sharedVideos),
}));

export const accountsRelations = relations(accounts, ({ one }) => ({
  user: one(users, {
    fields: [accounts.userId],
    references: [users.id],
  }),
}));

export const spacesRelations = relations(spaces, ({ one, many }) => ({
  owner: one(users, {
    fields: [spaces.ownerId],
    references: [users.id],
  }),
  spaceMembers: many(spaceMembers),
  sharedVideos: many(sharedVideos),
}));

export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, {
    fields: [sessions.userId],
    references: [users.id],
  }),
}));

export const verificationTokensRelations = relations(
  verificationTokens,
  ({}) => ({
    // No relations defined
  })
);

export const spaceMembersRelations = relations(spaceMembers, ({ one }) => ({
  user: one(users, {
    fields: [spaceMembers.userId],
    references: [users.id],
  }),
  space: one(spaces, {
    fields: [spaceMembers.spaceId],
    references: [spaces.id],
  }),
}));

export const videosRelations = relations(videos, ({ one, many }) => ({
  owner: one(users, {
    fields: [videos.ownerId],
    references: [users.id],
  }),
  sharedVideos: many(sharedVideos),
}));

export const sharedVideosRelations = relations(sharedVideos, ({ one }) => ({
  video: one(videos, {
    fields: [sharedVideos.videoId],
    references: [videos.id],
  }),
  space: one(spaces, {
    fields: [sharedVideos.spaceId],
    references: [spaces.id],
  }),
  sharedByUser: one(users, {
    fields: [sharedVideos.sharedByUserId],
    references: [users.id],
  }),
}));
