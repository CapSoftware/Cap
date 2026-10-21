CREATE TABLE "accounts" (
	"id" varchar(15) PRIMARY KEY NOT NULL,
	"userId" varchar(15) NOT NULL,
	"type" varchar(255) NOT NULL,
	"provider" varchar(255) NOT NULL,
	"providerAccountId" varchar(255) NOT NULL,
	"access_token" text,
	"expires_in" integer,
	"id_token" text,
	"refresh_token" text,
	"refresh_token_expires_in" integer,
	"scope" varchar(255),
	"token_type" varchar(255),
	"createdAt" timestamp (3) DEFAULT timezone('utc', now()) NOT NULL,
	"updatedAt" timestamp (3) DEFAULT timezone('utc', now()) NOT NULL,
	"tempColumn" text
);
--> statement-breakpoint
CREATE TABLE "agent_api_authorization_codes" (
	"id" varchar(15) PRIMARY KEY NOT NULL,
	"userId" varchar(15) NOT NULL,
	"codeHash" varchar(64) NOT NULL,
	"codeChallenge" varchar(64) NOT NULL,
	"redirectUri" varchar(512) NOT NULL,
	"scopes" jsonb NOT NULL,
	"expiresAt" timestamp (3) NOT NULL,
	"consumedAt" timestamp (3),
	"createdAt" timestamp (3) DEFAULT timezone('utc', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_api_idempotency" (
	"id" varchar(15) PRIMARY KEY NOT NULL,
	"userId" varchar(15) NOT NULL,
	"operation" varchar(64) NOT NULL,
	"keyHash" varchar(64) NOT NULL,
	"requestHash" varchar(64) NOT NULL,
	"state" varchar(16) DEFAULT 'pending' NOT NULL,
	"statusCode" integer,
	"response" jsonb,
	"expiresAt" timestamp (3) NOT NULL,
	"createdAt" timestamp (3) DEFAULT timezone('utc', now()) NOT NULL,
	"updatedAt" timestamp (3) DEFAULT timezone('utc', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_api_keys" (
	"id" varchar(15) PRIMARY KEY NOT NULL,
	"userId" varchar(15) NOT NULL,
	"tokenHash" varchar(64) NOT NULL,
	"name" varchar(100) DEFAULT 'Cap CLI' NOT NULL,
	"scopes" jsonb NOT NULL,
	"expiresAt" timestamp (3) NOT NULL,
	"revokedAt" timestamp (3),
	"createdAt" timestamp (3) DEFAULT timezone('utc', now()) NOT NULL,
	"lastUsedAt" timestamp (3)
);
--> statement-breakpoint
CREATE TABLE "agent_api_operations" (
	"id" varchar(15) PRIMARY KEY NOT NULL,
	"userId" varchar(15) NOT NULL,
	"kind" varchar(32) NOT NULL,
	"resourceId" varchar(15) NOT NULL,
	"resultResourceId" varchar(15),
	"state" varchar(16) DEFAULT 'queued' NOT NULL,
	"payload" jsonb NOT NULL,
	"result" jsonb,
	"errorCode" varchar(64),
	"errorMessage" text,
	"createdAt" timestamp (3) DEFAULT timezone('utc', now()) NOT NULL,
	"updatedAt" timestamp (3) DEFAULT timezone('utc', now()) NOT NULL,
	"completedAt" timestamp (3)
);
--> statement-breakpoint
CREATE TABLE "auth_api_keys" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"userId" varchar(15) NOT NULL,
	"source" varchar(32) DEFAULT 'unknown' NOT NULL,
	"createdAt" timestamp (3) DEFAULT timezone('utc', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "comments" (
	"id" varchar(15) PRIMARY KEY NOT NULL,
	"type" varchar(6) NOT NULL,
	"content" text NOT NULL,
	"timestamp" real,
	"authorId" varchar(15) NOT NULL,
	"videoId" varchar(15) NOT NULL,
	"createdAt" timestamp (3) DEFAULT timezone('utc', now()) NOT NULL,
	"updatedAt" timestamp (3) DEFAULT timezone('utc', now()) NOT NULL,
	"parentCommentId" varchar(15),
	"mediaKey" varchar(512),
	"mediaDuration" real,
	"mediaMeta" jsonb
);
--> statement-breakpoint
CREATE TABLE "developer_api_keys" (
	"id" varchar(15) PRIMARY KEY NOT NULL,
	"appId" varchar(15) NOT NULL,
	"keyType" varchar(8) NOT NULL,
	"keyPrefix" varchar(12) NOT NULL,
	"keyHash" varchar(64) NOT NULL,
	"encryptedKey" text NOT NULL,
	"lastUsedAt" timestamp (3),
	"revokedAt" timestamp (3),
	"createdAt" timestamp (3) DEFAULT timezone('utc', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "developer_app_domains" (
	"id" varchar(15) PRIMARY KEY NOT NULL,
	"appId" varchar(15) NOT NULL,
	"domain" varchar(253) NOT NULL,
	"createdAt" timestamp (3) DEFAULT timezone('utc', now()) NOT NULL,
	CONSTRAINT "app_domain_unique" UNIQUE("appId","domain")
);
--> statement-breakpoint
CREATE TABLE "developer_apps" (
	"id" varchar(15) PRIMARY KEY NOT NULL,
	"ownerId" varchar(15) NOT NULL,
	"name" varchar(255) NOT NULL,
	"environment" varchar(16) NOT NULL,
	"logoUrl" varchar(1024),
	"deletedAt" timestamp (3),
	"createdAt" timestamp (3) DEFAULT timezone('utc', now()) NOT NULL,
	"updatedAt" timestamp (3) DEFAULT timezone('utc', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "developer_credit_accounts" (
	"id" varchar(15) PRIMARY KEY NOT NULL,
	"appId" varchar(15) NOT NULL,
	"ownerId" varchar(15) NOT NULL,
	"balanceMicroCredits" bigint DEFAULT 0 NOT NULL,
	"stripeCustomerId" varchar(255),
	"stripePaymentMethodId" varchar(255),
	"autoTopUpEnabled" boolean DEFAULT false NOT NULL,
	"autoTopUpThresholdMicroCredits" bigint DEFAULT 0 NOT NULL,
	"autoTopUpAmountCents" integer DEFAULT 0 NOT NULL,
	"createdAt" timestamp (3) DEFAULT timezone('utc', now()) NOT NULL,
	"updatedAt" timestamp (3) DEFAULT timezone('utc', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "developer_credit_transactions" (
	"id" varchar(15) PRIMARY KEY NOT NULL,
	"accountId" varchar(15) NOT NULL,
	"type" varchar(16) NOT NULL,
	"amountMicroCredits" bigint NOT NULL,
	"balanceAfterMicroCredits" bigint NOT NULL,
	"referenceId" varchar(255),
	"referenceType" varchar(32),
	"metadata" jsonb,
	"createdAt" timestamp (3) DEFAULT timezone('utc', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "developer_daily_storage_snapshots" (
	"id" varchar(15) PRIMARY KEY NOT NULL,
	"appId" varchar(15) NOT NULL,
	"snapshotDate" varchar(10) NOT NULL,
	"totalDurationMinutes" real DEFAULT 0 NOT NULL,
	"videoCount" integer DEFAULT 0 NOT NULL,
	"microCreditsCharged" bigint DEFAULT 0 NOT NULL,
	"processedAt" timestamp (3),
	"createdAt" timestamp (3) DEFAULT timezone('utc', now()) NOT NULL,
	CONSTRAINT "app_date_unique" UNIQUE("appId","snapshotDate")
);
--> statement-breakpoint
CREATE TABLE "developer_videos" (
	"id" varchar(15) PRIMARY KEY NOT NULL,
	"appId" varchar(15) NOT NULL,
	"externalUserId" varchar(255),
	"name" varchar(255) DEFAULT 'Untitled' NOT NULL,
	"duration" real,
	"width" integer,
	"height" integer,
	"fps" integer,
	"s3Key" varchar(512),
	"transcriptionStatus" varchar(16),
	"metadata" jsonb,
	"deletedAt" timestamp (3),
	"createdAt" timestamp (3) DEFAULT timezone('utc', now()) NOT NULL,
	"updatedAt" timestamp (3) DEFAULT timezone('utc', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "folders" (
	"id" varchar(15) PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"color" varchar(16) DEFAULT 'normal' NOT NULL,
	"public" boolean DEFAULT false NOT NULL,
	"settings" jsonb,
	"organizationId" varchar(15) NOT NULL,
	"createdById" varchar(15) NOT NULL,
	"parentId" varchar(15),
	"spaceId" varchar(15),
	"createdAt" timestamp (3) DEFAULT timezone('utc', now()) NOT NULL,
	"updatedAt" timestamp (3) DEFAULT timezone('utc', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "imported_videos" (
	"id" varchar(15) NOT NULL,
	"orgId" varchar(15) NOT NULL,
	"source" varchar(255) NOT NULL,
	"source_id" varchar(255) NOT NULL,
	CONSTRAINT "imported_videos_orgId_source_source_id_pk" PRIMARY KEY("orgId","source","source_id")
);
--> statement-breakpoint
CREATE TABLE "integration_installations" (
	"id" varchar(15) PRIMARY KEY NOT NULL,
	"provider" varchar(64) NOT NULL,
	"externalId" varchar(255) NOT NULL,
	"displayName" varchar(255) NOT NULL,
	"organizationId" varchar(15) NOT NULL,
	"installedByUserId" varchar(15) NOT NULL,
	"encryptedCredentials" text NOT NULL,
	"metadata" jsonb NOT NULL,
	"createdAt" timestamp (3) DEFAULT timezone('utc', now()) NOT NULL,
	"updatedAt" timestamp (3) DEFAULT timezone('utc', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "loom_migration_imports" (
	"videoId" varchar(15) PRIMARY KEY NOT NULL,
	"requestId" varchar(15) NOT NULL,
	"createdAt" timestamp (3) DEFAULT timezone('utc', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "loom_migration_requests" (
	"id" varchar(15) PRIMARY KEY NOT NULL,
	"organizationId" varchar(15) NOT NULL,
	"activeOrganizationId" varchar(15),
	"requestedByUserId" varchar(15) NOT NULL,
	"workspaceName" varchar(255),
	"customerNote" text,
	"customerReply" text,
	"invitedAt" timestamp (3),
	"status" varchar(32) DEFAULT 'pending' NOT NULL,
	"capMessage" text,
	"expectedVideoCount" integer,
	"importedVideoCount" integer DEFAULT 0 NOT NULL,
	"queuedVideoCount" integer DEFAULT 0 NOT NULL,
	"activeImportCount" integer DEFAULT 0 NOT NULL,
	"activeImportLeaseToken" varchar(36),
	"activeImportLeaseUntil" timestamp (3),
	"lastOperatorUserId" varchar(15),
	"lastOperatorAt" timestamp (3),
	"completedAt" timestamp (3),
	"createdAt" timestamp (3) DEFAULT timezone('utc', now()) NOT NULL,
	"updatedAt" timestamp (3) DEFAULT timezone('utc', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "loops_sync_jobs" (
	"userId" varchar(15) PRIMARY KEY NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"nextAttemptAt" timestamp (3) NOT NULL,
	"leaseToken" varchar(36),
	"leaseUntil" timestamp (3),
	"failures" integer DEFAULT 0 NOT NULL,
	"lastError" varchar(64),
	"profileHash" varchar(64),
	"teammateJoinedAt" timestamp (3),
	"syncedEmail" varchar(255),
	"lastSyncedAt" timestamp (3)
);
--> statement-breakpoint
CREATE TABLE "mcp_oauth_clients" (
	"id" varchar(15) PRIMARY KEY NOT NULL,
	"clientId" varchar(128) NOT NULL,
	"clientName" varchar(100) NOT NULL,
	"redirectUris" jsonb NOT NULL,
	"activatedAt" timestamp (3),
	"createdAt" timestamp (3) DEFAULT timezone('utc', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mcp_oauth_codes" (
	"id" varchar(15) PRIMARY KEY NOT NULL,
	"userId" varchar(15) NOT NULL,
	"clientId" varchar(128) NOT NULL,
	"codeHash" varchar(64) NOT NULL,
	"codeChallenge" varchar(64) NOT NULL,
	"redirectUri" varchar(512) NOT NULL,
	"resource" varchar(512) NOT NULL,
	"expiresAt" timestamp (3) NOT NULL,
	"consumedAt" timestamp (3),
	"createdAt" timestamp (3) DEFAULT timezone('utc', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mcp_oauth_registration_quotas" (
	"windowId" varchar(10) PRIMARY KEY NOT NULL,
	"registrations" integer DEFAULT 0 NOT NULL,
	"expiresAt" timestamp (3) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mcp_oauth_tokens" (
	"id" varchar(15) PRIMARY KEY NOT NULL,
	"userId" varchar(15) NOT NULL,
	"clientId" varchar(128) NOT NULL,
	"familyId" varchar(15) NOT NULL,
	"resource" varchar(512) NOT NULL,
	"accessHash" varchar(64) NOT NULL,
	"refreshHash" varchar(64) NOT NULL,
	"accessExpiresAt" timestamp (3) NOT NULL,
	"refreshExpiresAt" timestamp (3) NOT NULL,
	"revokedAt" timestamp (3),
	"createdAt" timestamp (3) DEFAULT timezone('utc', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "media_processing_budgets" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"reserved_bytes" bigint DEFAULT 0 NOT NULL,
	"limit_bytes" bigint NOT NULL,
	"expires_at" timestamp (3) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messenger_conversations" (
	"id" varchar(15) PRIMARY KEY NOT NULL,
	"agent" varchar(32) NOT NULL,
	"mode" varchar(16) DEFAULT 'agent' NOT NULL,
	"userId" varchar(15),
	"anonymousId" varchar(64),
	"takeoverByUserId" varchar(15),
	"takeoverAt" timestamp (3),
	"createdAt" timestamp (3) DEFAULT timezone('utc', now()) NOT NULL,
	"updatedAt" timestamp (3) DEFAULT timezone('utc', now()) NOT NULL,
	"lastMessageAt" timestamp (3) DEFAULT timezone('utc', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messenger_messages" (
	"id" varchar(15) PRIMARY KEY NOT NULL,
	"conversationId" varchar(15) NOT NULL,
	"role" varchar(16) NOT NULL,
	"content" text NOT NULL,
	"userId" varchar(15),
	"anonymousId" varchar(64),
	"createdAt" timestamp (3) DEFAULT timezone('utc', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messenger_support_emails" (
	"id" varchar(15) PRIMARY KEY NOT NULL,
	"conversationId" varchar(15) NOT NULL,
	"userId" varchar(15) NOT NULL,
	"userEmail" varchar(255) NOT NULL,
	"subject" varchar(255) NOT NULL,
	"message" text NOT NULL,
	"createdAt" timestamp (3) DEFAULT timezone('utc', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" varchar(15) PRIMARY KEY NOT NULL,
	"orgId" varchar(15) NOT NULL,
	"recipientId" varchar(15) NOT NULL,
	"type" varchar(16) NOT NULL,
	"data" jsonb NOT NULL,
	"videoId" varchar(50),
	"dedupKey" varchar(128),
	"readAt" timestamp (3),
	"createdAt" timestamp (3) DEFAULT timezone('utc', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organization_invites" (
	"id" varchar(15) PRIMARY KEY NOT NULL,
	"organizationId" varchar(15) NOT NULL,
	"invitedEmail" varchar(255) NOT NULL,
	"invitedByUserId" varchar(15) NOT NULL,
	"role" varchar(255) NOT NULL,
	"status" varchar(255) DEFAULT 'pending' NOT NULL,
	"createdAt" timestamp (3) DEFAULT timezone('utc', now()) NOT NULL,
	"updatedAt" timestamp (3) DEFAULT timezone('utc', now()) NOT NULL,
	"expiresAt" timestamp (3)
);
--> statement-breakpoint
CREATE TABLE "organization_members" (
	"id" varchar(15) PRIMARY KEY NOT NULL,
	"userId" varchar(15) NOT NULL,
	"organizationId" varchar(15) NOT NULL,
	"role" varchar(255) NOT NULL,
	"hasProSeat" boolean DEFAULT false NOT NULL,
	"createdAt" timestamp (3) DEFAULT timezone('utc', now()) NOT NULL,
	"updatedAt" timestamp (3) DEFAULT timezone('utc', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organization_sso" (
	"organizationId" varchar(15) PRIMARY KEY NOT NULL,
	"purchasedByUserId" varchar(15) NOT NULL,
	"stripeCustomerId" varchar(255),
	"stripeSubscriptionId" varchar(255),
	"stripePriceId" varchar(255),
	"status" varchar(32) DEFAULT 'unpaid' NOT NULL,
	"paidThrough" timestamp (3),
	"currentPeriodEnd" timestamp (3),
	"cancelAtPeriodEnd" boolean DEFAULT false NOT NULL,
	"checkoutAttemptId" varchar(36),
	"checkoutCurrency" varchar(3),
	"checkoutPriceId" varchar(255),
	"checkoutSessionId" varchar(255),
	"checkoutStartedAt" timestamp (3),
	"createdAt" timestamp (3) DEFAULT timezone('utc', now()) NOT NULL,
	"updatedAt" timestamp (3) DEFAULT timezone('utc', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" varchar(15) PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"ownerId" varchar(15) NOT NULL,
	"metadata" jsonb,
	"tombstoneAt" timestamp (3),
	"allowedEmailDomain" varchar(255),
	"defaultVideoVisibility" varchar(7),
	"customDomain" varchar(255),
	"domainVerified" timestamp (3),
	"settings" jsonb,
	"iconUrl" varchar(1024),
	"shareableLinkIconUrl" varchar(1024),
	"createdAt" timestamp (3) DEFAULT timezone('utc', now()) NOT NULL,
	"updatedAt" timestamp (3) DEFAULT timezone('utc', now()) NOT NULL,
	"workosOrganizationId" varchar(255),
	"workosConnectionId" varchar(255)
);
--> statement-breakpoint
CREATE TABLE "s3_buckets" (
	"id" varchar(15) PRIMARY KEY NOT NULL,
	"ownerId" varchar(15) NOT NULL,
	"organizationId" varchar(15),
	"region" text NOT NULL,
	"endpoint" text,
	"bucketName" text NOT NULL,
	"accessKeyId" text NOT NULL,
	"secretAccessKey" text NOT NULL,
	"provider" text DEFAULT 'aws' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"createdAt" timestamp (3) DEFAULT timezone('utc', now()) NOT NULL,
	"updatedAt" timestamp (3) DEFAULT timezone('utc', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" varchar(15) PRIMARY KEY NOT NULL,
	"sessionToken" varchar(255) NOT NULL,
	"userId" varchar(15) NOT NULL,
	"expires" timestamp (3) NOT NULL,
	"created_at" timestamp (3) DEFAULT timezone('utc', now()) NOT NULL,
	"updated_at" timestamp (3) DEFAULT timezone('utc', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shared_videos" (
	"id" varchar(15) PRIMARY KEY NOT NULL,
	"videoId" varchar(15) NOT NULL,
	"folderId" varchar(15),
	"organizationId" varchar(15) NOT NULL,
	"sharedByUserId" varchar(15) NOT NULL,
	"sharedAt" timestamp (3) DEFAULT timezone('utc', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "signed_baas" (
	"id" varchar(15) PRIMARY KEY NOT NULL,
	"organizationId" varchar(15) NOT NULL,
	"userId" varchar(15) NOT NULL,
	"status" varchar(255) DEFAULT 'pending' NOT NULL,
	"stripeSubscriptionId" varchar(255),
	"entityName" varchar(255) NOT NULL,
	"entityType" varchar(255) NOT NULL,
	"entityAddress" varchar(500) NOT NULL,
	"signerName" varchar(255) NOT NULL,
	"signerTitle" varchar(255) NOT NULL,
	"noticesEmail" varchar(255) NOT NULL,
	"signatureData" text NOT NULL,
	"signedAt" timestamp (3),
	"emailSentAt" timestamp (3),
	"createdAt" timestamp (3) DEFAULT timezone('utc', now()) NOT NULL,
	"updatedAt" timestamp (3) DEFAULT timezone('utc', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "space_members" (
	"id" varchar(15) PRIMARY KEY NOT NULL,
	"spaceId" varchar(15) NOT NULL,
	"userId" varchar(15) NOT NULL,
	"role" varchar(255) DEFAULT 'member' NOT NULL,
	"createdAt" timestamp (3) DEFAULT timezone('utc', now()) NOT NULL,
	"updatedAt" timestamp (3) DEFAULT timezone('utc', now()) NOT NULL,
	CONSTRAINT "space_id_user_id_unique" UNIQUE("spaceId","userId")
);
--> statement-breakpoint
CREATE TABLE "space_videos" (
	"id" varchar(15) PRIMARY KEY NOT NULL,
	"spaceId" varchar(15) NOT NULL,
	"folderId" varchar(15),
	"videoId" varchar(15) NOT NULL,
	"addedById" varchar(15) NOT NULL,
	"addedAt" timestamp (3) DEFAULT timezone('utc', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "spaces" (
	"id" varchar(15) PRIMARY KEY NOT NULL,
	"primary" boolean DEFAULT false NOT NULL,
	"name" varchar(255) NOT NULL,
	"organizationId" varchar(15) NOT NULL,
	"createdById" varchar(15) NOT NULL,
	"iconUrl" varchar(255),
	"description" varchar(1000),
	"settings" jsonb,
	"password" text,
	"createdAt" timestamp (3) DEFAULT timezone('utc', now()) NOT NULL,
	"updatedAt" timestamp (3) DEFAULT timezone('utc', now()) NOT NULL,
	"privacy" varchar(255) DEFAULT 'Private' NOT NULL,
	"public" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "storage_integrations" (
	"id" varchar(15) PRIMARY KEY NOT NULL,
	"ownerId" varchar(15) NOT NULL,
	"organizationId" varchar(15),
	"provider" varchar(64) NOT NULL,
	"displayName" varchar(255) NOT NULL,
	"status" varchar(32) DEFAULT 'active' NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"encryptedConfig" text NOT NULL,
	"googleDriveAccessToken" text,
	"googleDriveAccessTokenExpiresAt" timestamp (3),
	"googleDriveTokenRefreshLeaseId" varchar(64),
	"googleDriveTokenRefreshLeaseExpiresAt" timestamp (3),
	"googleDriveStorageQuotaCache" jsonb,
	"createdAt" timestamp (3) DEFAULT timezone('utc', now()) NOT NULL,
	"updatedAt" timestamp (3) DEFAULT timezone('utc', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "storage_objects" (
	"id" varchar(15) PRIMARY KEY NOT NULL,
	"integrationId" varchar(15) NOT NULL,
	"ownerId" varchar(15) NOT NULL,
	"videoId" varchar(15),
	"objectKey" text NOT NULL,
	"objectKeyHash" varchar(64) NOT NULL,
	"providerObjectId" varchar(255) NOT NULL,
	"uploadSessionUrl" text,
	"uploadStatus" varchar(32) DEFAULT 'pending' NOT NULL,
	"contentType" varchar(255),
	"contentLength" bigint,
	"metadata" jsonb,
	"createdAt" timestamp (3) DEFAULT timezone('utc', now()) NOT NULL,
	"updatedAt" timestamp (3) DEFAULT timezone('utc', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" varchar(15) PRIMARY KEY NOT NULL,
	"name" varchar(255),
	"lastName" varchar(255),
	"email" varchar(255) NOT NULL,
	"emailVerified" timestamp (3),
	"image" varchar(255),
	"stripeCustomerId" varchar(255),
	"stripeSubscriptionId" varchar(255),
	"thirdPartyStripeSubscriptionId" varchar(255),
	"stripeSubscriptionStatus" varchar(255),
	"stripeSubscriptionPriceId" varchar(255),
	"preferences" jsonb DEFAULT 'null'::jsonb,
	"activeOrganizationId" varchar(15),
	"created_at" timestamp (3) DEFAULT timezone('utc', now()) NOT NULL,
	"updated_at" timestamp (3) DEFAULT timezone('utc', now()) NOT NULL,
	"onboardingSteps" jsonb,
	"onboarding_completed_at" timestamp (3),
	"customBucket" varchar(15),
	"inviteQuota" integer DEFAULT 1 NOT NULL,
	"defaultOrgId" varchar(15),
	"authSessionVersion" integer DEFAULT 0 NOT NULL,
	"marketingOrigin" varchar(20) DEFAULT 'unknown' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verification_tokens" (
	"identifier" varchar(255) PRIMARY KEY NOT NULL,
	"token" varchar(255) NOT NULL,
	"expires" timestamp (3) NOT NULL,
	"created_at" timestamp (3) DEFAULT timezone('utc', now()) NOT NULL,
	"updated_at" timestamp (3) DEFAULT timezone('utc', now()) NOT NULL,
	CONSTRAINT "verification_tokens_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "video_edits" (
	"videoId" varchar(15) PRIMARY KEY NOT NULL,
	"sourceKey" varchar(512) NOT NULL,
	"editSpec" jsonb NOT NULL,
	"createdAt" timestamp (3) DEFAULT timezone('utc', now()) NOT NULL,
	"updatedAt" timestamp (3) DEFAULT timezone('utc', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "video_processing_jobs" (
	"video_id" varchar(15) PRIMARY KEY NOT NULL,
	"owner_id" varchar(15) NOT NULL,
	"generation" varchar(64) NOT NULL,
	"manifest_sha256" varchar(64),
	"state" varchar(32) DEFAULT 'committing' NOT NULL,
	"attempt_id" varchar(64),
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"lease_expires_at" timestamp (3),
	"next_retry_at" timestamp (3) NOT NULL,
	"workflow_run_id" varchar(255),
	"remote_job_id" varchar(255),
	"source" jsonb,
	"verification" jsonb,
	"output" jsonb,
	"error_code" varchar(64),
	"error_message" text,
	"created_at" timestamp (3) DEFAULT timezone('utc', now()) NOT NULL,
	"updated_at" timestamp (3) DEFAULT timezone('utc', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "video_uploads" (
	"video_id" varchar(15) PRIMARY KEY NOT NULL,
	"uploaded" bigint DEFAULT 0 NOT NULL,
	"total" bigint DEFAULT 0 NOT NULL,
	"started_at" timestamp (3) DEFAULT timezone('utc', now()) NOT NULL,
	"updated_at" timestamp (3) DEFAULT timezone('utc', now()) NOT NULL,
	"mode" varchar(255),
	"phase" varchar(32) DEFAULT 'uploading' NOT NULL,
	"processing_progress" integer DEFAULT 0 NOT NULL,
	"processing_message" varchar(255),
	"processing_error" text,
	"raw_file_key" varchar(512)
);
--> statement-breakpoint
CREATE TABLE "video_viewer_grants" (
	"id" varchar(15) PRIMARY KEY NOT NULL,
	"videoId" varchar(15) NOT NULL,
	"email" varchar(255) NOT NULL,
	"invitedByUserId" varchar(15) NOT NULL,
	"createdAt" timestamp (3) DEFAULT timezone('utc', now()) NOT NULL,
	"revokedAt" timestamp (3)
);
--> statement-breakpoint
CREATE TABLE "videos" (
	"id" varchar(15) PRIMARY KEY NOT NULL,
	"ownerId" varchar(15) NOT NULL,
	"orgId" varchar(15) NOT NULL,
	"name" varchar(255) DEFAULT 'My Video' NOT NULL,
	"bucket" varchar(15),
	"storageIntegrationId" varchar(15),
	"duration" real,
	"width" integer,
	"height" integer,
	"fps" integer,
	"metadata" jsonb,
	"public" boolean DEFAULT true NOT NULL,
	"settings" jsonb,
	"transcriptionStatus" varchar(255),
	"source" jsonb DEFAULT '{"type":"MediaConvert"}'::jsonb NOT NULL,
	"folderId" varchar(15),
	"createdAt" timestamp (3) DEFAULT timezone('utc', now()) NOT NULL,
	"effectiveCreatedAt" timestamp (3) GENERATED ALWAYS AS (COALESCE(CASE WHEN ("metadata"->>'customCreatedAt') ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$' THEN make_timestamp(substr("metadata"->>'customCreatedAt', 1, 4)::int, substr("metadata"->>'customCreatedAt', 6, 2)::int, substr("metadata"->>'customCreatedAt', 9, 2)::int, substr("metadata"->>'customCreatedAt', 12, 2)::int, substr("metadata"->>'customCreatedAt', 15, 2)::int, substr("metadata"->>'customCreatedAt', 18, 2)::double precision + ('0' || substr("metadata"->>'customCreatedAt', 20, length("metadata"->>'customCreatedAt') - 20))::double precision) END, "createdAt")) STORED,
	"updatedAt" timestamp (3) DEFAULT timezone('utc', now()) NOT NULL,
	"password" text,
	"xStreamInfo" text,
	"firstViewEmailSentAt" timestamp (3),
	"isScreenshot" boolean DEFAULT false NOT NULL,
	"awsRegion" varchar(255),
	"awsBucket" varchar(255),
	"videoStartTime" varchar(255),
	"audioStartTime" varchar(255),
	"jobId" varchar(255),
	"jobStatus" varchar(255),
	"skipProcessing" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
ALTER TABLE "developer_api_keys" ADD CONSTRAINT "developer_api_keys_appId_developer_apps_id_fk" FOREIGN KEY ("appId") REFERENCES "public"."developer_apps"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "developer_app_domains" ADD CONSTRAINT "developer_app_domains_appId_developer_apps_id_fk" FOREIGN KEY ("appId") REFERENCES "public"."developer_apps"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "developer_credit_accounts" ADD CONSTRAINT "developer_credit_accounts_appId_developer_apps_id_fk" FOREIGN KEY ("appId") REFERENCES "public"."developer_apps"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "developer_credit_transactions" ADD CONSTRAINT "dev_credit_txn_account_fk" FOREIGN KEY ("accountId") REFERENCES "public"."developer_credit_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "developer_daily_storage_snapshots" ADD CONSTRAINT "developer_daily_storage_snapshots_appId_developer_apps_id_fk" FOREIGN KEY ("appId") REFERENCES "public"."developer_apps"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "developer_videos" ADD CONSTRAINT "developer_videos_appId_developer_apps_id_fk" FOREIGN KEY ("appId") REFERENCES "public"."developer_apps"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messenger_messages" ADD CONSTRAINT "messenger_messages_conversationId_messenger_conversations_id_fk" FOREIGN KEY ("conversationId") REFERENCES "public"."messenger_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messenger_support_emails" ADD CONSTRAINT "support_email_conversation_fk" FOREIGN KEY ("conversationId") REFERENCES "public"."messenger_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_objects" ADD CONSTRAINT "storage_objects_integrationId_storage_integrations_id_fk" FOREIGN KEY ("integrationId") REFERENCES "public"."storage_integrations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_edits" ADD CONSTRAINT "video_edits_videoId_videos_id_fk" FOREIGN KEY ("videoId") REFERENCES "public"."videos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_viewer_grants" ADD CONSTRAINT "video_viewer_grants_videoId_videos_id_fk" FOREIGN KEY ("videoId") REFERENCES "public"."videos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "videos" ADD CONSTRAINT "videos_storageIntegrationId_storage_integrations_id_fk" FOREIGN KEY ("storageIntegrationId") REFERENCES "public"."storage_integrations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "accounts_user_id_idx" ON "accounts" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "provider_account_id_idx" ON "accounts" USING btree ("providerAccountId");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_api_authorization_codes_code_hash_idx" ON "agent_api_authorization_codes" USING btree ("codeHash");--> statement-breakpoint
CREATE INDEX "agent_api_authorization_codes_expires_at_idx" ON "agent_api_authorization_codes" USING btree ("expiresAt");--> statement-breakpoint
CREATE INDEX "agent_api_authorization_codes_user_created_at_idx" ON "agent_api_authorization_codes" USING btree ("userId","createdAt");--> statement-breakpoint
CREATE UNIQUE INDEX "user_operation_key_idx" ON "agent_api_idempotency" USING btree ("userId","operation","keyHash");--> statement-breakpoint
CREATE INDEX "agent_api_idempotency_expires_at_idx" ON "agent_api_idempotency" USING btree ("expiresAt");--> statement-breakpoint
CREATE UNIQUE INDEX "token_hash_idx" ON "agent_api_keys" USING btree ("tokenHash");--> statement-breakpoint
CREATE INDEX "agent_api_keys_user_created_at_idx" ON "agent_api_keys" USING btree ("userId","createdAt");--> statement-breakpoint
CREATE INDEX "agent_api_keys_expires_at_idx" ON "agent_api_keys" USING btree ("expiresAt");--> statement-breakpoint
CREATE INDEX "agent_api_operations_user_created_at_idx" ON "agent_api_operations" USING btree ("userId","createdAt");--> statement-breakpoint
CREATE INDEX "state_updated_at_idx" ON "agent_api_operations" USING btree ("state","updatedAt");--> statement-breakpoint
CREATE INDEX "resource_id_idx" ON "agent_api_operations" USING btree ("resourceId");--> statement-breakpoint
CREATE INDEX "user_id_created_at_idx" ON "auth_api_keys" USING btree ("userId","createdAt");--> statement-breakpoint
CREATE INDEX "video_type_created_idx" ON "comments" USING btree ("videoId","type","createdAt","id");--> statement-breakpoint
CREATE INDEX "author_id_idx" ON "comments" USING btree ("authorId");--> statement-breakpoint
CREATE INDEX "parent_comment_id_idx" ON "comments" USING btree ("parentCommentId");--> statement-breakpoint
CREATE UNIQUE INDEX "key_hash_idx" ON "developer_api_keys" USING btree ("keyHash");--> statement-breakpoint
CREATE INDEX "app_key_type_idx" ON "developer_api_keys" USING btree ("appId","keyType");--> statement-breakpoint
CREATE INDEX "owner_deleted_idx" ON "developer_apps" USING btree ("ownerId","deletedAt");--> statement-breakpoint
CREATE UNIQUE INDEX "app_id_unique" ON "developer_credit_accounts" USING btree ("appId");--> statement-breakpoint
CREATE INDEX "account_type_created_idx" ON "developer_credit_transactions" USING btree ("accountId","type","createdAt");--> statement-breakpoint
CREATE INDEX "account_ref_dedup_idx" ON "developer_credit_transactions" USING btree ("accountId","referenceId","referenceType");--> statement-breakpoint
CREATE INDEX "app_created_idx" ON "developer_videos" USING btree ("appId","createdAt");--> statement-breakpoint
CREATE INDEX "app_user_idx" ON "developer_videos" USING btree ("appId","externalUserId");--> statement-breakpoint
CREATE INDEX "app_deleted_idx" ON "developer_videos" USING btree ("appId","deletedAt");--> statement-breakpoint
CREATE INDEX "folders_organization_id_idx" ON "folders" USING btree ("organizationId");--> statement-breakpoint
CREATE INDEX "folders_created_by_id_idx" ON "folders" USING btree ("createdById");--> statement-breakpoint
CREATE INDEX "parent_id_idx" ON "folders" USING btree ("parentId");--> statement-breakpoint
CREATE INDEX "space_id_idx" ON "folders" USING btree ("spaceId");--> statement-breakpoint
CREATE INDEX "public_parent_id_idx" ON "folders" USING btree ("public","parentId");--> statement-breakpoint
CREATE INDEX "public_space_parent_id_idx" ON "folders" USING btree ("public","spaceId","parentId");--> statement-breakpoint
CREATE INDEX "id_idx" ON "imported_videos" USING btree ("id");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_external_id_idx" ON "integration_installations" USING btree ("provider","externalId");--> statement-breakpoint
CREATE INDEX "organization_provider_display_name_idx" ON "integration_installations" USING btree ("organizationId","provider","displayName");--> statement-breakpoint
CREATE INDEX "loom_migration_imports_request_idx" ON "loom_migration_imports" USING btree ("requestId");--> statement-breakpoint
CREATE UNIQUE INDEX "loom_migration_active_org_idx" ON "loom_migration_requests" USING btree ("activeOrganizationId");--> statement-breakpoint
CREATE INDEX "loom_migration_org_created_idx" ON "loom_migration_requests" USING btree ("organizationId","createdAt");--> statement-breakpoint
CREATE INDEX "loom_migration_status_created_idx" ON "loom_migration_requests" USING btree ("status","createdAt");--> statement-breakpoint
CREATE INDEX "loops_sync_due_idx" ON "loops_sync_jobs" USING btree ("nextAttemptAt");--> statement-breakpoint
CREATE UNIQUE INDEX "client_id_idx" ON "mcp_oauth_clients" USING btree ("clientId");--> statement-breakpoint
CREATE INDEX "inactive_created_at_idx" ON "mcp_oauth_clients" USING btree ("activatedAt","createdAt");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_oauth_codes_code_hash_idx" ON "mcp_oauth_codes" USING btree ("codeHash");--> statement-breakpoint
CREATE INDEX "mcp_oauth_codes_expires_at_idx" ON "mcp_oauth_codes" USING btree ("expiresAt");--> statement-breakpoint
CREATE INDEX "mcp_oauth_registration_quotas_expires_at_idx" ON "mcp_oauth_registration_quotas" USING btree ("expiresAt");--> statement-breakpoint
CREATE UNIQUE INDEX "access_hash_idx" ON "mcp_oauth_tokens" USING btree ("accessHash");--> statement-breakpoint
CREATE UNIQUE INDEX "refresh_hash_idx" ON "mcp_oauth_tokens" USING btree ("refreshHash");--> statement-breakpoint
CREATE INDEX "family_id_idx" ON "mcp_oauth_tokens" USING btree ("familyId");--> statement-breakpoint
CREATE INDEX "client_active_idx" ON "mcp_oauth_tokens" USING btree ("clientId","revokedAt","refreshExpiresAt");--> statement-breakpoint
CREATE INDEX "refresh_expires_at_idx" ON "mcp_oauth_tokens" USING btree ("refreshExpiresAt");--> statement-breakpoint
CREATE INDEX "media_budget_expiry_idx" ON "media_processing_budgets" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "user_last_message_idx" ON "messenger_conversations" USING btree ("userId","lastMessageAt");--> statement-breakpoint
CREATE INDEX "anonymous_last_message_idx" ON "messenger_conversations" USING btree ("anonymousId","lastMessageAt");--> statement-breakpoint
CREATE INDEX "mode_last_message_idx" ON "messenger_conversations" USING btree ("mode","lastMessageAt");--> statement-breakpoint
CREATE INDEX "updated_at_idx" ON "messenger_conversations" USING btree ("updatedAt");--> statement-breakpoint
CREATE INDEX "conversation_created_at_idx" ON "messenger_messages" USING btree ("conversationId","createdAt");--> statement-breakpoint
CREATE INDEX "role_created_at_idx" ON "messenger_messages" USING btree ("role","createdAt");--> statement-breakpoint
CREATE INDEX "support_email_user_created_at_idx" ON "messenger_support_emails" USING btree ("userId","createdAt");--> statement-breakpoint
CREATE INDEX "support_email_conversation_created_at_idx" ON "messenger_support_emails" USING btree ("conversationId","createdAt");--> statement-breakpoint
CREATE INDEX "org_id_idx" ON "notifications" USING btree ("orgId");--> statement-breakpoint
CREATE INDEX "type_idx" ON "notifications" USING btree ("type");--> statement-breakpoint
CREATE INDEX "read_at_idx" ON "notifications" USING btree ("readAt");--> statement-breakpoint
CREATE INDEX "created_at_idx" ON "notifications" USING btree ("createdAt");--> statement-breakpoint
CREATE INDEX "recipient_read_idx" ON "notifications" USING btree ("recipientId","readAt");--> statement-breakpoint
CREATE INDEX "recipient_created_idx" ON "notifications" USING btree ("recipientId","createdAt");--> statement-breakpoint
CREATE UNIQUE INDEX "dedup_key_idx" ON "notifications" USING btree ("dedupKey");--> statement-breakpoint
CREATE INDEX "type_recipient_created_idx" ON "notifications" USING btree ("type","recipientId","createdAt");--> statement-breakpoint
CREATE INDEX "type_recipient_video_created_idx" ON "notifications" USING btree ("type","recipientId","videoId","createdAt");--> statement-breakpoint
CREATE INDEX "organization_invites_organization_id_idx" ON "organization_invites" USING btree ("organizationId");--> statement-breakpoint
CREATE INDEX "invited_email_idx" ON "organization_invites" USING btree ("invitedEmail");--> statement-breakpoint
CREATE INDEX "invited_by_user_id_idx" ON "organization_invites" USING btree ("invitedByUserId");--> statement-breakpoint
CREATE INDEX "status_idx" ON "organization_invites" USING btree ("status");--> statement-breakpoint
CREATE INDEX "organization_members_organization_id_idx" ON "organization_members" USING btree ("organizationId");--> statement-breakpoint
CREATE INDEX "user_id_organization_id_idx" ON "organization_members" USING btree ("userId","organizationId");--> statement-breakpoint
CREATE UNIQUE INDEX "sso_stripe_subscription_id_idx" ON "organization_sso" USING btree ("stripeSubscriptionId");--> statement-breakpoint
CREATE INDEX "owner_id_tombstone_idx" ON "organizations" USING btree ("ownerId","tombstoneAt");--> statement-breakpoint
CREATE INDEX "custom_domain_idx" ON "organizations" USING btree ("customDomain");--> statement-breakpoint
CREATE UNIQUE INDEX "workos_organization_id_idx" ON "organizations" USING btree ("workosOrganizationId");--> statement-breakpoint
CREATE INDEX "owner_organization_idx" ON "s3_buckets" USING btree ("ownerId","organizationId");--> statement-breakpoint
CREATE INDEX "s3_buckets_organization_id_idx" ON "s3_buckets" USING btree ("organizationId");--> statement-breakpoint
CREATE INDEX "s3_buckets_organization_active_idx" ON "s3_buckets" USING btree ("organizationId","active","updatedAt");--> statement-breakpoint
CREATE UNIQUE INDEX "session_token_idx" ON "sessions" USING btree ("sessionToken");--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "sessions" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "shared_videos_folder_id_idx" ON "shared_videos" USING btree ("folderId");--> statement-breakpoint
CREATE INDEX "shared_videos_organization_id_idx" ON "shared_videos" USING btree ("organizationId");--> statement-breakpoint
CREATE INDEX "shared_by_user_id_idx" ON "shared_videos" USING btree ("sharedByUserId");--> statement-breakpoint
CREATE INDEX "video_id_organization_id_idx" ON "shared_videos" USING btree ("videoId","organizationId");--> statement-breakpoint
CREATE INDEX "video_id_folder_id_idx" ON "shared_videos" USING btree ("videoId","folderId");--> statement-breakpoint
CREATE UNIQUE INDEX "signed_baa_organization_id_idx" ON "signed_baas" USING btree ("organizationId");--> statement-breakpoint
CREATE INDEX "signed_baa_stripe_subscription_idx" ON "signed_baas" USING btree ("stripeSubscriptionId");--> statement-breakpoint
CREATE INDEX "space_members_user_id_idx" ON "space_members" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "space_videos_folder_id_idx" ON "space_videos" USING btree ("folderId");--> statement-breakpoint
CREATE INDEX "space_videos_video_id_idx" ON "space_videos" USING btree ("videoId");--> statement-breakpoint
CREATE INDEX "added_by_id_idx" ON "space_videos" USING btree ("addedById");--> statement-breakpoint
CREATE INDEX "space_id_video_id_idx" ON "space_videos" USING btree ("spaceId","videoId");--> statement-breakpoint
CREATE INDEX "space_id_folder_id_idx" ON "space_videos" USING btree ("spaceId","folderId");--> statement-breakpoint
CREATE INDEX "spaces_organization_id_idx" ON "spaces" USING btree ("organizationId");--> statement-breakpoint
CREATE INDEX "spaces_created_by_id_idx" ON "spaces" USING btree ("createdById");--> statement-breakpoint
CREATE INDEX "public_organization_id_idx" ON "spaces" USING btree ("public","organizationId");--> statement-breakpoint
CREATE INDEX "owner_provider_idx" ON "storage_integrations" USING btree ("ownerId","provider");--> statement-breakpoint
CREATE INDEX "owner_active_idx" ON "storage_integrations" USING btree ("ownerId","active");--> statement-breakpoint
CREATE INDEX "organization_provider_idx" ON "storage_integrations" USING btree ("organizationId","provider");--> statement-breakpoint
CREATE INDEX "storage_integrations_organization_active_idx" ON "storage_integrations" USING btree ("organizationId","active","status");--> statement-breakpoint
CREATE UNIQUE INDEX "integration_key_hash_idx" ON "storage_objects" USING btree ("integrationId","objectKeyHash");--> statement-breakpoint
CREATE INDEX "integration_status_idx" ON "storage_objects" USING btree ("integrationId","uploadStatus");--> statement-breakpoint
CREATE INDEX "integration_object_key_prefix_idx" ON "storage_objects" USING btree ("integrationId","objectKey" text_pattern_ops);--> statement-breakpoint
CREATE INDEX "storage_objects_video_id_idx" ON "storage_objects" USING btree ("videoId");--> statement-breakpoint
CREATE INDEX "storage_objects_owner_id_idx" ON "storage_objects" USING btree ("ownerId");--> statement-breakpoint
CREATE UNIQUE INDEX "email_idx" ON "users" USING btree ("email");--> statement-breakpoint
CREATE INDEX "processing_state_retry_video_idx" ON "video_processing_jobs" USING btree ("state","next_retry_at","video_id");--> statement-breakpoint
CREATE INDEX "processing_state_lease_video_idx" ON "video_processing_jobs" USING btree ("state","lease_expires_at","video_id");--> statement-breakpoint
CREATE INDEX "phase_updated_at_video_id_idx" ON "video_uploads" USING btree ("phase","updated_at","video_id");--> statement-breakpoint
CREATE UNIQUE INDEX "video_email_idx" ON "video_viewer_grants" USING btree ("videoId","email");--> statement-breakpoint
CREATE INDEX "videos_owner_id_idx" ON "videos" USING btree ("ownerId");--> statement-breakpoint
CREATE INDEX "owner_updated_id_idx" ON "videos" USING btree ("ownerId","updatedAt","id");--> statement-breakpoint
CREATE INDEX "is_public_idx" ON "videos" USING btree ("public");--> statement-breakpoint
CREATE INDEX "videos_folder_id_idx" ON "videos" USING btree ("folderId");--> statement-breakpoint
CREATE INDEX "storage_integration_id_idx" ON "videos" USING btree ("storageIntegrationId");--> statement-breakpoint
CREATE INDEX "org_owner_folder_idx" ON "videos" USING btree ("orgId","ownerId","folderId");--> statement-breakpoint
CREATE INDEX "org_effective_created_idx" ON "videos" USING btree ("orgId","effectiveCreatedAt");--> statement-breakpoint
CREATE INDEX "screenshot_transcription_created_idx" ON "videos" USING btree ("isScreenshot","transcriptionStatus","createdAt");