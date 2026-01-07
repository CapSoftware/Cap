# Notion Ticket Integration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a "Create Ticket" feature that transcribes Cap screen recordings and creates structured Notion tickets via AI extraction.

**Architecture:** OAuth-based Notion integration with on-demand transcription. Single LLM call extracts ticket fields, user reviews in modal before creation. Database stores encrypted tokens per user.

**Tech Stack:** Next.js 14 (App Router), Drizzle ORM (MySQL), Notion API (@notionhq/client), OpenAI GPT-4o-mini, existing Deepgram transcription.

---

## Parallel Workstreams

This implementation is split into **4 independent workstreams** that can be worked on simultaneously:

| Stream | Name | Description | Dependencies |
|--------|------|-------------|--------------|
| A | Database & Backend | Schema, migrations, server actions | None |
| B | Notion OAuth Flow | API routes for auth | Stream A (schema) |
| C | AI Extraction | Ticket field extraction from transcript | None |
| D | Frontend UI | Components, modals, settings page | Streams A, B, C |

**Recommended order if working sequentially:** A → B → C → D

---

## Stream A: Database & Backend

### Task A1: Add Notion Environment Variables

**Files:**
- Modify: `packages/env/server.ts`

**Step 1: Add Notion env vars to schema**

In `packages/env/server.ts`, add after the WorkOS section (~line 73):

```typescript
/// Notion Integration
NOTION_CLIENT_ID: z.string().optional().describe("Notion OAuth client ID"),
NOTION_CLIENT_SECRET: z.string().optional().describe("Notion OAuth client secret"),
NOTION_REDIRECT_URI: z.string().optional().describe("Notion OAuth redirect URI"),
```

**Step 2: Verify env loading works**

Run: `cd apps/web && pnpm build`
Expected: Build succeeds (env vars are optional)

**Step 3: Commit**

```bash
git add packages/env/server.ts
git commit -m "feat: add Notion OAuth environment variables"
```

---

### Task A2: Create notionIntegrations Database Schema

**Files:**
- Modify: `packages/database/schema.ts`

**Step 1: Add notionIntegrations table after s3Buckets (~line 470)**

```typescript
export const notionIntegrations = mysqlTable(
	"notion_integrations",
	{
		id: nanoId("id").notNull().primaryKey(),
		userId: nanoId("userId").notNull().$type<User.UserId>(),
		accessToken: encryptedText("accessToken").notNull(),
		workspaceId: varchar("workspaceId", { length: 255 }),
		workspaceName: varchar("workspaceName", { length: 255 }),
		workspaceIcon: varchar("workspaceIcon", { length: 1024 }),
		databaseId: varchar("databaseId", { length: 255 }),
		databaseName: varchar("databaseName", { length: 255 }),
		botId: varchar("botId", { length: 255 }),
		createdAt: timestamp("createdAt").notNull().defaultNow(),
		updatedAt: timestamp("updatedAt").notNull().defaultNow().onUpdateNow(),
	},
	(table) => ({
		userIdIndex: uniqueIndex("user_id_idx").on(table.userId),
	}),
);
```

**Step 2: Add relations after s3BucketsRelations (~line 528)**

```typescript
export const notionIntegrationsRelations = relations(
	notionIntegrations,
	({ one }) => ({
		user: one(users, {
			fields: [notionIntegrations.userId],
			references: [users.id],
		}),
	}),
);
```

**Step 3: Update usersRelations to include notionIntegration**

Find `usersRelations` (~line 505) and add to the return object:

```typescript
notionIntegration: one(notionIntegrations),
```

**Step 4: Commit**

```bash
git add packages/database/schema.ts
git commit -m "feat: add notionIntegrations database schema"
```

---

### Task A3: Generate and Run Database Migration

**Files:**
- Create: `packages/database/drizzle/XXXX_notion_integrations.sql` (auto-generated)

**Step 1: Generate migration**

```bash
cd packages/database
pnpm drizzle-kit generate
```

Expected: New migration file created in `drizzle/` folder

**Step 2: Review migration SQL**

The generated SQL should look like:

```sql
CREATE TABLE `notion_integrations` (
	`id` varchar(15) NOT NULL,
	`userId` varchar(15) NOT NULL,
	`accessToken` text NOT NULL,
	`workspaceId` varchar(255),
	`workspaceName` varchar(255),
	`workspaceIcon` varchar(1024),
	`databaseId` varchar(255),
	`databaseName` varchar(255),
	`botId` varchar(255),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `notion_integrations_id` PRIMARY KEY(`id`),
	CONSTRAINT `user_id_idx` UNIQUE(`userId`)
);
```

**Step 3: Run migration (on Railway or local)**

```bash
pnpm drizzle-kit migrate
```

**Step 4: Commit**

```bash
git add packages/database/drizzle/
git commit -m "feat: add notion_integrations migration"
```

---

### Task A4: Create Notion Integration Server Actions

**Files:**
- Create: `apps/web/actions/integrations/notion.ts`

**Step 1: Create the file with full implementation**

```typescript
"use server";

import { db } from "@cap/database";
import { notionIntegrations } from "@cap/database/schema";
import { decrypt, encrypt } from "@cap/database/crypto";
import { nanoId } from "@cap/database/helpers";
import { serverEnv } from "@cap/env";
import type { User } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { getCurrentUser } from "@cap/database/auth/session";
import { revalidatePath } from "next/cache";

export type NotionConnection = {
	connected: boolean;
	workspaceName?: string;
	workspaceIcon?: string;
	databaseName?: string;
	databaseId?: string;
};

export async function getNotionConnection(): Promise<NotionConnection> {
	const user = await getCurrentUser();
	if (!user) {
		return { connected: false };
	}

	const integration = await db()
		.select()
		.from(notionIntegrations)
		.where(eq(notionIntegrations.userId, user.id as User.UserId))
		.limit(1);

	if (integration.length === 0) {
		return { connected: false };
	}

	const record = integration[0];
	return {
		connected: true,
		workspaceName: record.workspaceName ?? undefined,
		workspaceIcon: record.workspaceIcon ?? undefined,
		databaseName: record.databaseName ?? undefined,
		databaseId: record.databaseId ?? undefined,
	};
}

export async function saveNotionDatabase(
	databaseId: string,
	databaseName: string,
): Promise<{ success: boolean; error?: string }> {
	const user = await getCurrentUser();
	if (!user) {
		return { success: false, error: "Unauthorized" };
	}

	try {
		await db()
			.update(notionIntegrations)
			.set({
				databaseId,
				databaseName,
			})
			.where(eq(notionIntegrations.userId, user.id as User.UserId));

		revalidatePath("/dashboard/settings/integrations");
		return { success: true };
	} catch (error) {
		console.error("[saveNotionDatabase] Error:", error);
		return { success: false, error: "Failed to save database selection" };
	}
}

export async function disconnectNotion(): Promise<{
	success: boolean;
	error?: string;
}> {
	const user = await getCurrentUser();
	if (!user) {
		return { success: false, error: "Unauthorized" };
	}

	try {
		await db()
			.delete(notionIntegrations)
			.where(eq(notionIntegrations.userId, user.id as User.UserId));

		revalidatePath("/dashboard/settings/integrations");
		return { success: true };
	} catch (error) {
		console.error("[disconnectNotion] Error:", error);
		return { success: false, error: "Failed to disconnect Notion" };
	}
}

export async function getNotionAccessToken(): Promise<string | null> {
	const user = await getCurrentUser();
	if (!user) return null;

	const integration = await db()
		.select({ accessToken: notionIntegrations.accessToken })
		.from(notionIntegrations)
		.where(eq(notionIntegrations.userId, user.id as User.UserId))
		.limit(1);

	if (integration.length === 0) return null;

	try {
		return await decrypt(integration[0].accessToken);
	} catch (error) {
		console.error("[getNotionAccessToken] Decryption error:", error);
		return null;
	}
}
```

**Step 2: Verify TypeScript compiles**

```bash
cd apps/web && pnpm tsc --noEmit
```

Expected: No type errors

**Step 3: Commit**

```bash
git add apps/web/actions/integrations/notion.ts
git commit -m "feat: add Notion integration server actions"
```

---

## Stream B: Notion OAuth Flow

### Task B1: Create Notion OAuth Initiation Route

**Files:**
- Create: `apps/web/app/api/integrations/notion/auth/route.ts`

**Step 1: Create the route file**

```typescript
import { serverEnv } from "@cap/env";
import { getCurrentUser } from "@cap/database/auth/session";
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { nanoId } from "@cap/database/helpers";

export async function GET() {
	const user = await getCurrentUser();
	if (!user) {
		return NextResponse.redirect(new URL("/login", serverEnv().WEB_URL));
	}

	const env = serverEnv();
	if (!env.NOTION_CLIENT_ID || !env.NOTION_REDIRECT_URI) {
		return NextResponse.json(
			{ error: "Notion integration not configured" },
			{ status: 500 },
		);
	}

	// Generate state for CSRF protection
	const state = nanoId();
	const cookieStore = await cookies();
	cookieStore.set("notion_oauth_state", state, {
		httpOnly: true,
		secure: process.env.NODE_ENV === "production",
		sameSite: "lax",
		maxAge: 60 * 10, // 10 minutes
		path: "/",
	});

	const authUrl = new URL("https://api.notion.com/v1/oauth/authorize");
	authUrl.searchParams.set("client_id", env.NOTION_CLIENT_ID);
	authUrl.searchParams.set("response_type", "code");
	authUrl.searchParams.set("owner", "user");
	authUrl.searchParams.set("redirect_uri", env.NOTION_REDIRECT_URI);
	authUrl.searchParams.set("state", state);

	return NextResponse.redirect(authUrl.toString());
}
```

**Step 2: Verify route loads**

```bash
cd apps/web && pnpm build
```

Expected: Build succeeds

**Step 3: Commit**

```bash
git add apps/web/app/api/integrations/notion/auth/route.ts
git commit -m "feat: add Notion OAuth initiation route"
```

---

### Task B2: Create Notion OAuth Callback Route

**Files:**
- Create: `apps/web/app/api/integrations/notion/callback/route.ts`

**Step 1: Create the callback route**

```typescript
import { db } from "@cap/database";
import { notionIntegrations } from "@cap/database/schema";
import { encrypt } from "@cap/database/crypto";
import { nanoId } from "@cap/database/helpers";
import { serverEnv } from "@cap/env";
import { getCurrentUser } from "@cap/database/auth/session";
import type { User } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";

export async function GET(request: NextRequest) {
	const user = await getCurrentUser();
	if (!user) {
		return NextResponse.redirect(new URL("/login", serverEnv().WEB_URL));
	}

	const searchParams = request.nextUrl.searchParams;
	const code = searchParams.get("code");
	const state = searchParams.get("state");
	const error = searchParams.get("error");

	if (error) {
		console.error("[Notion OAuth] Error from Notion:", error);
		return NextResponse.redirect(
			new URL(
				"/dashboard/settings/integrations?error=oauth_denied",
				serverEnv().WEB_URL,
			),
		);
	}

	if (!code || !state) {
		return NextResponse.redirect(
			new URL(
				"/dashboard/settings/integrations?error=missing_params",
				serverEnv().WEB_URL,
			),
		);
	}

	// Verify state
	const cookieStore = await cookies();
	const storedState = cookieStore.get("notion_oauth_state")?.value;
	cookieStore.delete("notion_oauth_state");

	if (state !== storedState) {
		console.error("[Notion OAuth] State mismatch");
		return NextResponse.redirect(
			new URL(
				"/dashboard/settings/integrations?error=invalid_state",
				serverEnv().WEB_URL,
			),
		);
	}

	const env = serverEnv();
	if (!env.NOTION_CLIENT_ID || !env.NOTION_CLIENT_SECRET || !env.NOTION_REDIRECT_URI) {
		return NextResponse.redirect(
			new URL(
				"/dashboard/settings/integrations?error=not_configured",
				serverEnv().WEB_URL,
			),
		);
	}

	try {
		// Exchange code for access token
		const tokenResponse = await fetch("https://api.notion.com/v1/oauth/token", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Basic ${Buffer.from(
					`${env.NOTION_CLIENT_ID}:${env.NOTION_CLIENT_SECRET}`,
				).toString("base64")}`,
			},
			body: JSON.stringify({
				grant_type: "authorization_code",
				code,
				redirect_uri: env.NOTION_REDIRECT_URI,
			}),
		});

		if (!tokenResponse.ok) {
			const errorText = await tokenResponse.text();
			console.error("[Notion OAuth] Token exchange failed:", errorText);
			return NextResponse.redirect(
				new URL(
					"/dashboard/settings/integrations?error=token_exchange_failed",
					serverEnv().WEB_URL,
				),
			);
		}

		const tokenData = await tokenResponse.json();
		const {
			access_token,
			workspace_id,
			workspace_name,
			workspace_icon,
			bot_id,
		} = tokenData;

		// Encrypt access token before storing
		const encryptedToken = await encrypt(access_token);

		// Upsert integration record
		const existing = await db()
			.select()
			.from(notionIntegrations)
			.where(eq(notionIntegrations.userId, user.id as User.UserId))
			.limit(1);

		if (existing.length > 0) {
			await db()
				.update(notionIntegrations)
				.set({
					accessToken: encryptedToken,
					workspaceId: workspace_id,
					workspaceName: workspace_name,
					workspaceIcon: workspace_icon,
					botId: bot_id,
					databaseId: null, // Reset database selection on reconnect
					databaseName: null,
				})
				.where(eq(notionIntegrations.userId, user.id as User.UserId));
		} else {
			await db().insert(notionIntegrations).values({
				id: nanoId(),
				userId: user.id as User.UserId,
				accessToken: encryptedToken,
				workspaceId: workspace_id,
				workspaceName: workspace_name,
				workspaceIcon: workspace_icon,
				botId: bot_id,
			});
		}

		return NextResponse.redirect(
			new URL(
				"/dashboard/settings/integrations?success=notion_connected",
				serverEnv().WEB_URL,
			),
		);
	} catch (error) {
		console.error("[Notion OAuth] Error:", error);
		return NextResponse.redirect(
			new URL(
				"/dashboard/settings/integrations?error=unknown",
				serverEnv().WEB_URL,
			),
		);
	}
}
```

**Step 2: Commit**

```bash
git add apps/web/app/api/integrations/notion/callback/route.ts
git commit -m "feat: add Notion OAuth callback route"
```

---

### Task B3: Create Notion Databases List Route

**Files:**
- Create: `apps/web/app/api/integrations/notion/databases/route.ts`

**Step 1: Create the databases route**

```typescript
import { getNotionAccessToken } from "@/actions/integrations/notion";
import { getCurrentUser } from "@cap/database/auth/session";
import { NextResponse } from "next/server";

export async function GET() {
	const user = await getCurrentUser();
	if (!user) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	const accessToken = await getNotionAccessToken();
	if (!accessToken) {
		return NextResponse.json(
			{ error: "Notion not connected" },
			{ status: 400 },
		);
	}

	try {
		const response = await fetch("https://api.notion.com/v1/search", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${accessToken}`,
				"Content-Type": "application/json",
				"Notion-Version": "2022-06-28",
			},
			body: JSON.stringify({
				filter: {
					value: "database",
					property: "object",
				},
				sort: {
					direction: "descending",
					timestamp: "last_edited_time",
				},
			}),
		});

		if (!response.ok) {
			const errorText = await response.text();
			console.error("[Notion Databases] API error:", errorText);
			return NextResponse.json(
				{ error: "Failed to fetch databases" },
				{ status: response.status },
			);
		}

		const data = await response.json();
		const databases = data.results.map((db: any) => ({
			id: db.id,
			name: db.title?.[0]?.plain_text || "Untitled",
			icon: db.icon?.emoji || db.icon?.external?.url || null,
		}));

		return NextResponse.json({ databases });
	} catch (error) {
		console.error("[Notion Databases] Error:", error);
		return NextResponse.json(
			{ error: "Failed to fetch databases" },
			{ status: 500 },
		);
	}
}
```

**Step 2: Commit**

```bash
git add apps/web/app/api/integrations/notion/databases/route.ts
git commit -m "feat: add Notion databases list route"
```

---

## Stream C: AI Extraction

### Task C1: Create Ticket Extraction Action

**Files:**
- Create: `apps/web/actions/integrations/extract-ticket.ts`

**Step 1: Create the extraction action**

```typescript
"use server";

import { db } from "@cap/database";
import { s3Buckets, videos } from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import { S3Buckets } from "@cap/web-backend";
import type { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { Effect, Option } from "effect";
import { getCurrentUser } from "@cap/database/auth/session";
import { runPromise } from "@/lib/server";

export type ExtractedTicket = {
	title: string;
	ticketType: "Bug" | "Feature" | "Enhancement" | "Task";
	priority: "Low" | "Medium" | "High" | "Critical";
	description: string;
	stepsToReproduce: string[];
};

export async function extractTicketFromVideo(
	videoId: Video.VideoId,
): Promise<{ success: true; data: ExtractedTicket } | { success: false; error: string }> {
	const user = await getCurrentUser();
	if (!user) {
		return { success: false, error: "Unauthorized" };
	}

	const env = serverEnv();
	if (!env.OPENAI_API_KEY) {
		return { success: false, error: "OpenAI API key not configured" };
	}

	try {
		// Fetch video and verify ownership
		const query = await db()
			.select({ video: videos, bucket: s3Buckets })
			.from(videos)
			.leftJoin(s3Buckets, eq(videos.bucket, s3Buckets.id))
			.where(eq(videos.id, videoId));

		if (query.length === 0 || !query[0]?.video) {
			return { success: false, error: "Video not found" };
		}

		const { video } = query[0];

		// Verify transcription is complete
		if (video.transcriptionStatus !== "COMPLETE") {
			return {
				success: false,
				error: "Video transcription not complete. Please wait for transcription to finish.",
			};
		}

		// Get transcript VTT file
		const vtt = await Effect.gen(function* () {
			const [bucket] = yield* S3Buckets.getBucketAccess(
				Option.fromNullable(query[0]!.bucket?.id),
			);
			return yield* bucket.getObject(`${video.ownerId}/${videoId}/transcription.vtt`);
		}).pipe(runPromise);

		if (Option.isNone(vtt)) {
			return { success: false, error: "Transcript not found" };
		}

		// Parse VTT to plain text
		const transcriptText = vtt.value
			.split("\n")
			.filter(
				(l) =>
					l.trim() &&
					l !== "WEBVTT" &&
					!/^\d+$/.test(l.trim()) &&
					!l.includes("-->"),
			)
			.join(" ")
			.trim();

		if (transcriptText.length < 10) {
			return { success: false, error: "Transcript too short to extract ticket" };
		}

		// Call OpenAI for extraction
		const prompt = `You are analyzing a transcript from a screen recording that reports a bug, requests a feature, or describes a task. Extract the following information:

1. Title: A concise ticket title (max 80 characters)
2. Ticket Type: One of [Bug, Feature, Enhancement, Task]
   - Bug: Something is broken or not working as expected
   - Feature: A new capability being requested
   - Enhancement: Improvement to existing functionality
   - Task: General work item or action
3. Priority: One of [Low, Medium, High, Critical] based on:
   - Critical: System down, data loss, security issue
   - High: Major functionality broken, many users affected
   - Medium: Moderate impact, workaround exists
   - Low: Minor issue, cosmetic, nice-to-have
4. Description: 2-3 sentence summary of the issue or request
5. Steps to Reproduce: Numbered list of actions to reproduce the issue (if applicable, otherwise empty array)

Transcript:
${transcriptText}

Respond ONLY with valid JSON in this exact format:
{
  "title": "string",
  "ticketType": "Bug" | "Feature" | "Enhancement" | "Task",
  "priority": "Low" | "Medium" | "High" | "Critical",
  "description": "string",
  "stepsToReproduce": ["step 1", "step 2", ...]
}`;

		const response = await fetch("https://api.openai.com/v1/chat/completions", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${env.OPENAI_API_KEY}`,
			},
			body: JSON.stringify({
				model: "gpt-4o-mini",
				messages: [{ role: "user", content: prompt }],
				temperature: 0.3,
			}),
		});

		if (!response.ok) {
			const errorText = await response.text();
			console.error("[extractTicketFromVideo] OpenAI error:", errorText);
			return { success: false, error: "AI extraction failed" };
		}

		const data = await response.json();
		let content = data.choices?.[0]?.message?.content || "{}";

		// Clean markdown code blocks if present
		if (content.includes("```json")) {
			content = content.replace(/```json\s*/g, "").replace(/```\s*/g, "");
		} else if (content.includes("```")) {
			content = content.replace(/```\s*/g, "");
		}

		const extracted = JSON.parse(content.trim()) as ExtractedTicket;

		// Validate and normalize
		const validTypes = ["Bug", "Feature", "Enhancement", "Task"];
		const validPriorities = ["Low", "Medium", "High", "Critical"];

		if (!validTypes.includes(extracted.ticketType)) {
			extracted.ticketType = "Task";
		}
		if (!validPriorities.includes(extracted.priority)) {
			extracted.priority = "Medium";
		}
		if (!Array.isArray(extracted.stepsToReproduce)) {
			extracted.stepsToReproduce = [];
		}

		return { success: true, data: extracted };
	} catch (error) {
		console.error("[extractTicketFromVideo] Error:", error);
		return { success: false, error: "Failed to extract ticket information" };
	}
}
```

**Step 2: Commit**

```bash
git add apps/web/actions/integrations/extract-ticket.ts
git commit -m "feat: add AI ticket extraction from video transcript"
```

---

### Task C2: Create Notion Ticket Creation Action

**Files:**
- Create: `apps/web/actions/integrations/create-notion-ticket.ts`

**Step 1: Create the ticket creation action**

```typescript
"use server";

import { db } from "@cap/database";
import { notionIntegrations, videos } from "@cap/database/schema";
import { decrypt } from "@cap/database/crypto";
import { serverEnv } from "@cap/env";
import type { User, Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { getCurrentUser } from "@cap/database/auth/session";

export type CreateTicketInput = {
	videoId: Video.VideoId;
	title: string;
	ticketType: "Bug" | "Feature" | "Enhancement" | "Task";
	priority: "Low" | "Medium" | "High" | "Critical";
	productArea?: string;
	description: string;
	stepsToReproduce: string[];
};

export type CreateTicketResult =
	| { success: true; notionUrl: string }
	| { success: false; error: string };

export async function createNotionTicket(
	input: CreateTicketInput,
): Promise<CreateTicketResult> {
	const user = await getCurrentUser();
	if (!user) {
		return { success: false, error: "Unauthorized" };
	}

	try {
		// Get Notion integration
		const integration = await db()
			.select()
			.from(notionIntegrations)
			.where(eq(notionIntegrations.userId, user.id as User.UserId))
			.limit(1);

		if (integration.length === 0) {
			return { success: false, error: "Notion not connected" };
		}

		const { accessToken: encryptedToken, databaseId } = integration[0];

		if (!databaseId) {
			return { success: false, error: "No Notion database selected" };
		}

		const accessToken = await decrypt(encryptedToken);

		// Get video URL for embedding
		const video = await db()
			.select({ id: videos.id })
			.from(videos)
			.where(eq(videos.id, input.videoId))
			.limit(1);

		if (video.length === 0) {
			return { success: false, error: "Video not found" };
		}

		const videoUrl = `${serverEnv().WEB_URL}/s/${input.videoId}`;

		// Build description with steps and video link
		let fullDescription = input.description;

		if (input.stepsToReproduce.length > 0) {
			fullDescription += "\n\n## Steps to Reproduce\n";
			input.stepsToReproduce.forEach((step, index) => {
				fullDescription += `${index + 1}. ${step}\n`;
			});
		}

		fullDescription += `\n\n## Video Reference\n[View original recording](${videoUrl})`;

		// Create Notion page
		const response = await fetch("https://api.notion.com/v1/pages", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${accessToken}`,
				"Content-Type": "application/json",
				"Notion-Version": "2022-06-28",
			},
			body: JSON.stringify({
				parent: { database_id: databaseId },
				properties: {
					// Name/Title - required, type: title
					Name: {
						title: [{ text: { content: input.title } }],
					},
					// Status - optional, skip if not present (Notion defaults to first option)
					// Ticket Type - optional, type: select
					...(input.ticketType && {
						"Ticket Type": {
							select: { name: input.ticketType },
						},
					}),
					// Priority - optional, type: select
					...(input.priority && {
						Priority: {
							select: { name: input.priority },
						},
					}),
					// Product Area - optional, type: rich_text
					...(input.productArea && {
						"Product Area": {
							rich_text: [{ text: { content: input.productArea } }],
						},
					}),
				},
				// Page content (description)
				children: [
					{
						object: "block",
						type: "heading_2",
						heading_2: {
							rich_text: [{ type: "text", text: { content: "Summary" } }],
						},
					},
					{
						object: "block",
						type: "paragraph",
						paragraph: {
							rich_text: [{ type: "text", text: { content: input.description } }],
						},
					},
					...(input.stepsToReproduce.length > 0
						? [
								{
									object: "block",
									type: "heading_2",
									heading_2: {
										rich_text: [
											{ type: "text", text: { content: "Steps to Reproduce" } },
										],
									},
								},
								{
									object: "block",
									type: "numbered_list_item",
									numbered_list_item: {
										rich_text: input.stepsToReproduce.map((step) => ({
											type: "text",
											text: { content: step },
										})),
									},
								},
							]
						: []),
					{
						object: "block",
						type: "heading_2",
						heading_2: {
							rich_text: [
								{ type: "text", text: { content: "Video Reference" } },
							],
						},
					},
					{
						object: "block",
						type: "bookmark",
						bookmark: {
							url: videoUrl,
						},
					},
				],
			}),
		});

		if (!response.ok) {
			const errorData = await response.json();
			console.error("[createNotionTicket] Notion API error:", errorData);

			// Handle common errors
			if (errorData.code === "validation_error") {
				return {
					success: false,
					error:
						"Database schema mismatch. Please check your Notion database has the required properties.",
				};
			}

			return { success: false, error: "Failed to create Notion page" };
		}

		const pageData = await response.json();
		return { success: true, notionUrl: pageData.url };
	} catch (error) {
		console.error("[createNotionTicket] Error:", error);
		return { success: false, error: "Failed to create ticket" };
	}
}
```

**Step 2: Commit**

```bash
git add apps/web/actions/integrations/create-notion-ticket.ts
git commit -m "feat: add Notion ticket creation action"
```

---

## Stream D: Frontend UI

### Task D1: Create Integrations Settings Page

**Files:**
- Create: `apps/web/app/(org)/dashboard/settings/integrations/page.tsx`

**Step 1: Create the settings page**

```typescript
import type { Metadata } from "next";
import { IntegrationsSettings } from "./IntegrationsSettings";

export const metadata: Metadata = {
	title: "Integrations — Cap",
};

export default function IntegrationsPage() {
	return <IntegrationsSettings />;
}
```

**Step 2: Create the settings component**

Create file: `apps/web/app/(org)/dashboard/settings/integrations/IntegrationsSettings.tsx`

```typescript
"use client";

import { Button } from "@cap/ui";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
	disconnectNotion,
	getNotionConnection,
	saveNotionDatabase,
	type NotionConnection,
} from "@/actions/integrations/notion";

type NotionDatabase = {
	id: string;
	name: string;
	icon: string | null;
};

export function IntegrationsSettings() {
	const [connection, setConnection] = useState<NotionConnection | null>(null);
	const [databases, setDatabases] = useState<NotionDatabase[]>([]);
	const [selectedDb, setSelectedDb] = useState<string>("");
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [disconnecting, setDisconnecting] = useState(false);

	useEffect(() => {
		loadConnection();
	}, []);

	const loadConnection = async () => {
		setLoading(true);
		const conn = await getNotionConnection();
		setConnection(conn);

		if (conn.connected) {
			setSelectedDb(conn.databaseId || "");
			// Load databases
			try {
				const res = await fetch("/api/integrations/notion/databases");
				if (res.ok) {
					const data = await res.json();
					setDatabases(data.databases || []);
				}
			} catch (error) {
				console.error("Failed to load databases:", error);
			}
		}

		setLoading(false);
	};

	const handleConnect = () => {
		window.location.href = "/api/integrations/notion/auth";
	};

	const handleDisconnect = async () => {
		setDisconnecting(true);
		const result = await disconnectNotion();
		if (result.success) {
			toast.success("Notion disconnected");
			setConnection({ connected: false });
			setDatabases([]);
			setSelectedDb("");
		} else {
			toast.error(result.error || "Failed to disconnect");
		}
		setDisconnecting(false);
	};

	const handleSaveDatabase = async () => {
		if (!selectedDb) {
			toast.error("Please select a database");
			return;
		}

		const db = databases.find((d) => d.id === selectedDb);
		if (!db) return;

		setSaving(true);
		const result = await saveNotionDatabase(selectedDb, db.name);
		if (result.success) {
			toast.success("Database saved");
			setConnection((prev) =>
				prev
					? { ...prev, databaseId: selectedDb, databaseName: db.name }
					: prev,
			);
		} else {
			toast.error(result.error || "Failed to save");
		}
		setSaving(false);
	};

	if (loading) {
		return (
			<div className="p-6">
				<div className="animate-pulse space-y-4">
					<div className="h-8 w-48 bg-gray-3 rounded" />
					<div className="h-32 bg-gray-3 rounded" />
				</div>
			</div>
		);
	}

	return (
		<div className="p-6 space-y-6">
			<div>
				<h1 className="text-2xl font-semibold text-gray-12">Integrations</h1>
				<p className="text-gray-11 mt-1">
					Connect external services to enhance your workflow
				</p>
			</div>

			<div className="border border-gray-5 rounded-xl p-6 space-y-4">
				<div className="flex items-center justify-between">
					<div className="flex items-center gap-3">
						<div className="w-10 h-10 bg-black rounded-lg flex items-center justify-center">
							<svg
								className="w-6 h-6 text-white"
								viewBox="0 0 24 24"
								fill="currentColor"
							>
								<path d="M4.459 4.208c.746.606 1.026.56 2.428.466l13.215-.793c.28 0 .047-.28-.046-.326L17.86 1.968c-.42-.326-.98-.7-2.055-.607L3.01 2.295c-.466.046-.56.28-.374.466zm.793 3.08v13.904c0 .747.373 1.027 1.214.98l14.523-.84c.841-.046.935-.56.935-1.167V6.354c0-.606-.233-.933-.748-.887l-15.177.887c-.56.047-.747.327-.747.933zm14.337.745c.093.42 0 .84-.42.888l-.7.14v10.264c-.608.327-1.168.514-1.635.514-.748 0-.935-.234-1.495-.933l-4.577-7.186v6.952l1.448.327s0 .84-1.168.84l-3.22.186c-.094-.186 0-.653.327-.746l.84-.233V9.854L7.822 9.76c-.094-.42.14-1.026.793-1.073l3.454-.233 4.763 7.279v-6.44l-1.215-.14c-.093-.514.28-.887.747-.933zM2.877 1.355l13.17-.98c1.634-.14 2.055-.047 3.08.7l4.249 2.986c.7.514.934.653.934 1.213v16.378c0 1.026-.373 1.634-1.68 1.726l-15.458.934c-.98.047-1.448-.093-1.962-.747l-3.127-4.06c-.56-.747-.793-1.306-.793-1.96V2.895c0-.84.374-1.447 1.587-1.54z" />
							</svg>
						</div>
						<div>
							<h3 className="font-medium text-gray-12">Notion</h3>
							<p className="text-sm text-gray-10">
								Create tickets from video recordings
							</p>
						</div>
					</div>

					{connection?.connected ? (
						<Button
							variant="outline"
							onClick={handleDisconnect}
							disabled={disconnecting}
						>
							{disconnecting ? "Disconnecting..." : "Disconnect"}
						</Button>
					) : (
						<Button onClick={handleConnect}>Connect Notion</Button>
					)}
				</div>

				{connection?.connected && (
					<div className="border-t border-gray-5 pt-4 space-y-4">
						<div className="flex items-center gap-2 text-sm text-gray-11">
							<span className="w-2 h-2 bg-green-500 rounded-full" />
							Connected to {connection.workspaceName}
						</div>

						<div className="space-y-2">
							<label className="text-sm font-medium text-gray-12">
								Default Database
							</label>
							<p className="text-xs text-gray-10">
								Tickets will be created in this database
							</p>
							<div className="flex gap-2">
								<select
									value={selectedDb}
									onChange={(e) => setSelectedDb(e.target.value)}
									className="flex-1 px-3 py-2 border border-gray-5 rounded-lg bg-gray-1 text-gray-12"
								>
									<option value="">Select a database...</option>
									{databases.map((db) => (
										<option key={db.id} value={db.id}>
											{db.icon ? `${db.icon} ` : ""}
											{db.name}
										</option>
									))}
								</select>
								<Button
									onClick={handleSaveDatabase}
									disabled={saving || !selectedDb}
								>
									{saving ? "Saving..." : "Save"}
								</Button>
							</div>
							{connection.databaseName && (
								<p className="text-xs text-gray-10">
									Currently using: {connection.databaseName}
								</p>
							)}
						</div>
					</div>
				)}
			</div>
		</div>
	);
}
```

**Step 3: Commit**

```bash
git add apps/web/app/\(org\)/dashboard/settings/integrations/
git commit -m "feat: add Integrations settings page with Notion connection"
```

---

### Task D2: Create CreateTicketButton Component

**Files:**
- Create: `apps/web/app/s/[videoId]/_components/CreateTicketButton.tsx`

**Step 1: Create the button component**

```typescript
"use client";

import { Button } from "@cap/ui";
import type { Video } from "@cap/web-domain";
import { FileText } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import {
	getNotionConnection,
	type NotionConnection,
} from "@/actions/integrations/notion";
import { CreateTicketModal } from "./CreateTicketModal";

interface CreateTicketButtonProps {
	videoId: Video.VideoId;
	videoName: string;
	transcriptionStatus?: "PROCESSING" | "COMPLETE" | "ERROR" | "SKIPPED" | null;
}

export function CreateTicketButton({
	videoId,
	videoName,
	transcriptionStatus,
}: CreateTicketButtonProps) {
	const [isModalOpen, setIsModalOpen] = useState(false);
	const [connection, setConnection] = useState<NotionConnection | null>(null);
	const [loading, setLoading] = useState(false);

	const handleClick = async () => {
		if (transcriptionStatus !== "COMPLETE") {
			toast.error(
				"Video transcription required. Please wait for transcription to complete.",
			);
			return;
		}

		setLoading(true);
		const conn = await getNotionConnection();
		setConnection(conn);

		if (!conn.connected) {
			toast.error("Please connect Notion in Settings > Integrations first");
			setLoading(false);
			return;
		}

		if (!conn.databaseId) {
			toast.error(
				"Please select a Notion database in Settings > Integrations",
			);
			setLoading(false);
			return;
		}

		setLoading(false);
		setIsModalOpen(true);
	};

	return (
		<>
			<Button
				variant="gray"
				onClick={handleClick}
				disabled={loading}
				className="gap-2"
			>
				<FileText className="w-4 h-4" />
				{loading ? "Loading..." : "Create Ticket"}
			</Button>

			{isModalOpen && connection?.connected && (
				<CreateTicketModal
					isOpen={isModalOpen}
					onClose={() => setIsModalOpen(false)}
					videoId={videoId}
					videoName={videoName}
					databaseName={connection.databaseName || "Notion"}
				/>
			)}
		</>
	);
}
```

**Step 2: Commit**

```bash
git add apps/web/app/s/\[videoId\]/_components/CreateTicketButton.tsx
git commit -m "feat: add CreateTicketButton component"
```

---

### Task D3: Create CreateTicketModal Component

**Files:**
- Create: `apps/web/app/s/[videoId]/_components/CreateTicketModal.tsx`

**Step 1: Create the modal component**

```typescript
"use client";

import { Button } from "@cap/ui";
import type { Video } from "@cap/web-domain";
import { AnimatePresence, motion } from "framer-motion";
import { Loader2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
	createNotionTicket,
	type CreateTicketInput,
} from "@/actions/integrations/create-notion-ticket";
import {
	extractTicketFromVideo,
	type ExtractedTicket,
} from "@/actions/integrations/extract-ticket";

interface CreateTicketModalProps {
	isOpen: boolean;
	onClose: () => void;
	videoId: Video.VideoId;
	videoName: string;
	databaseName: string;
}

type TicketType = "Bug" | "Feature" | "Enhancement" | "Task";
type Priority = "Low" | "Medium" | "High" | "Critical";

export function CreateTicketModal({
	isOpen,
	onClose,
	videoId,
	videoName,
	databaseName,
}: CreateTicketModalProps) {
	const [loading, setLoading] = useState(true);
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// Form state
	const [title, setTitle] = useState("");
	const [ticketType, setTicketType] = useState<TicketType>("Task");
	const [priority, setPriority] = useState<Priority>("Medium");
	const [productArea, setProductArea] = useState("");
	const [description, setDescription] = useState("");
	const [stepsToReproduce, setStepsToReproduce] = useState<string[]>([]);

	useEffect(() => {
		if (isOpen) {
			extractTicket();
		}
	}, [isOpen]);

	const extractTicket = async () => {
		setLoading(true);
		setError(null);

		const result = await extractTicketFromVideo(videoId);

		if (!result.success) {
			setError(result.error);
			setLoading(false);
			return;
		}

		const { data } = result;
		setTitle(data.title);
		setTicketType(data.ticketType);
		setPriority(data.priority);
		setDescription(data.description);
		setStepsToReproduce(data.stepsToReproduce);
		setLoading(false);
	};

	const handleSubmit = async () => {
		if (!title.trim()) {
			toast.error("Title is required");
			return;
		}

		setSubmitting(true);

		const input: CreateTicketInput = {
			videoId,
			title: title.trim(),
			ticketType,
			priority,
			productArea: productArea.trim() || undefined,
			description: description.trim(),
			stepsToReproduce: stepsToReproduce.filter((s) => s.trim()),
		};

		const result = await createNotionTicket(input);

		if (result.success) {
			toast.success(
				<div className="flex flex-col gap-1">
					<span>Ticket created!</span>
					<a
						href={result.notionUrl}
						target="_blank"
						rel="noopener noreferrer"
						className="text-blue-500 underline text-sm"
					>
						Open in Notion
					</a>
				</div>,
			);
			onClose();
		} else {
			toast.error(result.error);
		}

		setSubmitting(false);
	};

	const handleStepChange = (index: number, value: string) => {
		const newSteps = [...stepsToReproduce];
		newSteps[index] = value;
		setStepsToReproduce(newSteps);
	};

	const addStep = () => {
		setStepsToReproduce([...stepsToReproduce, ""]);
	};

	const removeStep = (index: number) => {
		setStepsToReproduce(stepsToReproduce.filter((_, i) => i !== index));
	};

	return (
		<AnimatePresence>
			{isOpen && (
				<motion.div
					initial={{ opacity: 0 }}
					animate={{ opacity: 1 }}
					exit={{ opacity: 0 }}
					className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
					onClick={onClose}
				>
					<motion.div
						initial={{ scale: 0.95, opacity: 0 }}
						animate={{ scale: 1, opacity: 1 }}
						exit={{ scale: 0.95, opacity: 0 }}
						className="bg-white rounded-xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-hidden"
						onClick={(e) => e.stopPropagation()}
					>
						{/* Header */}
						<div className="flex items-center justify-between p-4 border-b border-gray-5">
							<div>
								<h2 className="text-lg font-semibold text-gray-12">
									Create Ticket
								</h2>
								<p className="text-sm text-gray-10">
									Creating in {databaseName}
								</p>
							</div>
							<button
								onClick={onClose}
								className="p-2 hover:bg-gray-3 rounded-lg transition-colors"
							>
								<X className="w-5 h-5 text-gray-10" />
							</button>
						</div>

						{/* Content */}
						<div className="p-4 overflow-y-auto max-h-[calc(90vh-140px)]">
							{loading ? (
								<div className="flex flex-col items-center justify-center py-12 gap-3">
									<Loader2 className="w-8 h-8 animate-spin text-blue-500" />
									<p className="text-gray-11">Analyzing video transcript...</p>
								</div>
							) : error ? (
								<div className="text-center py-8">
									<p className="text-red-500 mb-4">{error}</p>
									<Button onClick={extractTicket}>Retry</Button>
								</div>
							) : (
								<div className="space-y-4">
									{/* Title */}
									<div>
										<label className="block text-sm font-medium text-gray-12 mb-1">
											Title
										</label>
										<input
											type="text"
											value={title}
											onChange={(e) => setTitle(e.target.value)}
											className="w-full px-3 py-2 border border-gray-5 rounded-lg bg-gray-1 text-gray-12"
											placeholder="Ticket title"
										/>
									</div>

									{/* Type and Priority row */}
									<div className="grid grid-cols-2 gap-4">
										<div>
											<label className="block text-sm font-medium text-gray-12 mb-1">
												Type
											</label>
											<select
												value={ticketType}
												onChange={(e) =>
													setTicketType(e.target.value as TicketType)
												}
												className="w-full px-3 py-2 border border-gray-5 rounded-lg bg-gray-1 text-gray-12"
											>
												<option value="Bug">Bug</option>
												<option value="Feature">Feature</option>
												<option value="Enhancement">Enhancement</option>
												<option value="Task">Task</option>
											</select>
										</div>
										<div>
											<label className="block text-sm font-medium text-gray-12 mb-1">
												Priority
											</label>
											<select
												value={priority}
												onChange={(e) =>
													setPriority(e.target.value as Priority)
												}
												className="w-full px-3 py-2 border border-gray-5 rounded-lg bg-gray-1 text-gray-12"
											>
												<option value="Low">Low</option>
												<option value="Medium">Medium</option>
												<option value="High">High</option>
												<option value="Critical">Critical</option>
											</select>
										</div>
									</div>

									{/* Product Area */}
									<div>
										<label className="block text-sm font-medium text-gray-12 mb-1">
											Product Area{" "}
											<span className="text-gray-10 font-normal">
												(optional)
											</span>
										</label>
										<input
											type="text"
											value={productArea}
											onChange={(e) => setProductArea(e.target.value)}
											className="w-full px-3 py-2 border border-gray-5 rounded-lg bg-gray-1 text-gray-12"
											placeholder="e.g., Dashboard, API, Mobile"
										/>
									</div>

									{/* Description */}
									<div>
										<label className="block text-sm font-medium text-gray-12 mb-1">
											Description
										</label>
										<textarea
											value={description}
											onChange={(e) => setDescription(e.target.value)}
											rows={3}
											className="w-full px-3 py-2 border border-gray-5 rounded-lg bg-gray-1 text-gray-12 resize-none"
											placeholder="Describe the issue or request"
										/>
									</div>

									{/* Steps to Reproduce */}
									<div>
										<label className="block text-sm font-medium text-gray-12 mb-1">
											Steps to Reproduce
										</label>
										<div className="space-y-2">
											{stepsToReproduce.map((step, index) => (
												<div key={index} className="flex gap-2">
													<span className="flex-none w-6 h-9 flex items-center justify-center text-sm text-gray-10">
														{index + 1}.
													</span>
													<input
														type="text"
														value={step}
														onChange={(e) =>
															handleStepChange(index, e.target.value)
														}
														className="flex-1 px-3 py-2 border border-gray-5 rounded-lg bg-gray-1 text-gray-12"
														placeholder={`Step ${index + 1}`}
													/>
													<button
														onClick={() => removeStep(index)}
														className="flex-none p-2 text-gray-10 hover:text-red-500 transition-colors"
													>
														<X className="w-4 h-4" />
													</button>
												</div>
											))}
											<button
												onClick={addStep}
												className="text-sm text-blue-500 hover:text-blue-600"
											>
												+ Add step
											</button>
										</div>
									</div>
								</div>
							)}
						</div>

						{/* Footer */}
						{!loading && !error && (
							<div className="flex justify-end gap-2 p-4 border-t border-gray-5">
								<Button variant="outline" onClick={onClose}>
									Cancel
								</Button>
								<Button onClick={handleSubmit} disabled={submitting}>
									{submitting ? (
										<>
											<Loader2 className="w-4 h-4 animate-spin mr-2" />
											Creating...
										</>
									) : (
										"Create in Notion"
									)}
								</Button>
							</div>
						)}
					</motion.div>
				</motion.div>
			)}
		</AnimatePresence>
	);
}
```

**Step 2: Commit**

```bash
git add apps/web/app/s/\[videoId\]/_components/CreateTicketModal.tsx
git commit -m "feat: add CreateTicketModal with form fields"
```

---

### Task D4: Integrate CreateTicketButton into ShareHeader

**Files:**
- Modify: `apps/web/app/s/[videoId]/_components/ShareHeader.tsx`

**Step 1: Add import at top of file (~line 17)**

```typescript
import { CreateTicketButton } from "./CreateTicketButton";
```

**Step 2: Update VideoData type usage or add transcriptionStatus prop**

Update the component props to include transcriptionStatus. Find the props interface and add:

```typescript
transcriptionStatus?: "PROCESSING" | "COMPLETE" | "ERROR" | "SKIPPED" | null;
```

**Step 3: Add button in the header actions area**

Find the section with `{user !== null && (` around line 257. Add the CreateTicketButton alongside the existing buttons:

```typescript
{user !== null && (
	<div className="flex space-x-2">
		<div>
			<div className="flex gap-2 items-center">
				{/* Add CreateTicketButton here */}
				{isOwner && (
					<CreateTicketButton
						videoId={data.id}
						videoName={data.name}
						transcriptionStatus={data.transcriptionStatus}
					/>
				)}
				{data.password && (
					<FontAwesomeIcon
						className="text-amber-600 size-4"
						icon={faLock}
					/>
				)}
				{/* ... rest of existing code */}
```

**Step 4: Update VideoData type to include transcriptionStatus**

Check `apps/web/app/s/[videoId]/types.ts` and ensure transcriptionStatus is included.

**Step 5: Commit**

```bash
git add apps/web/app/s/\[videoId\]/_components/ShareHeader.tsx
git commit -m "feat: integrate CreateTicketButton into ShareHeader"
```

---

### Task D5: Add Integrations Tab to Sidebar

**Files:**
- Modify: `apps/web/app/s/[videoId]/_components/Sidebar.tsx`
- Create: `apps/web/app/s/[videoId]/_components/tabs/Integrations.tsx`

**Step 1: Create the Integrations tab component**

```typescript
"use client";

import { Button } from "@cap/ui";
import type { Video } from "@cap/web-domain";
import { FileText, Settings } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import {
	getNotionConnection,
	type NotionConnection,
} from "@/actions/integrations/notion";
import { CreateTicketButton } from "../CreateTicketButton";

interface IntegrationsProps {
	videoId: Video.VideoId;
	videoName: string;
	transcriptionStatus?: "PROCESSING" | "COMPLETE" | "ERROR" | "SKIPPED" | null;
	isOwner: boolean;
}

export function Integrations({
	videoId,
	videoName,
	transcriptionStatus,
	isOwner,
}: IntegrationsProps) {
	const [connection, setConnection] = useState<NotionConnection | null>(null);
	const [loading, setLoading] = useState(true);

	useEffect(() => {
		loadConnection();
	}, []);

	const loadConnection = async () => {
		const conn = await getNotionConnection();
		setConnection(conn);
		setLoading(false);
	};

	if (!isOwner) {
		return (
			<div className="p-4 text-center text-gray-10">
				<p>Only the video owner can create tickets.</p>
			</div>
		);
	}

	if (loading) {
		return (
			<div className="p-4">
				<div className="animate-pulse space-y-3">
					<div className="h-16 bg-gray-3 rounded-lg" />
				</div>
			</div>
		);
	}

	return (
		<div className="p-4 space-y-4">
			<div className="border border-gray-5 rounded-lg p-4">
				<div className="flex items-center gap-3 mb-3">
					<div className="w-8 h-8 bg-black rounded flex items-center justify-center">
						<svg
							className="w-5 h-5 text-white"
							viewBox="0 0 24 24"
							fill="currentColor"
						>
							<path d="M4.459 4.208c.746.606 1.026.56 2.428.466l13.215-.793c.28 0 .047-.28-.046-.326L17.86 1.968c-.42-.326-.98-.7-2.055-.607L3.01 2.295c-.466.046-.56.28-.374.466zm.793 3.08v13.904c0 .747.373 1.027 1.214.98l14.523-.84c.841-.046.935-.56.935-1.167V6.354c0-.606-.233-.933-.748-.887l-15.177.887c-.56.047-.747.327-.747.933zm14.337.745c.093.42 0 .84-.42.888l-.7.14v10.264c-.608.327-1.168.514-1.635.514-.748 0-.935-.234-1.495-.933l-4.577-7.186v6.952l1.448.327s0 .84-1.168.84l-3.22.186c-.094-.186 0-.653.327-.746l.84-.233V9.854L7.822 9.76c-.094-.42.14-1.026.793-1.073l3.454-.233 4.763 7.279v-6.44l-1.215-.14c-.093-.514.28-.887.747-.933zM2.877 1.355l13.17-.98c1.634-.14 2.055-.047 3.08.7l4.249 2.986c.7.514.934.653.934 1.213v16.378c0 1.026-.373 1.634-1.68 1.726l-15.458.934c-.98.047-1.448-.093-1.962-.747l-3.127-4.06c-.56-.747-.793-1.306-.793-1.96V2.895c0-.84.374-1.447 1.587-1.54z" />
						</svg>
					</div>
					<div>
						<h3 className="font-medium text-gray-12">Notion</h3>
						{connection?.connected ? (
							<p className="text-xs text-green-600">
								Connected to {connection.workspaceName}
							</p>
						) : (
							<p className="text-xs text-gray-10">Not connected</p>
						)}
					</div>
				</div>

				{connection?.connected ? (
					<div className="space-y-3">
						{connection.databaseName && (
							<p className="text-xs text-gray-10">
								Database: {connection.databaseName}
							</p>
						)}
						<CreateTicketButton
							videoId={videoId}
							videoName={videoName}
							transcriptionStatus={transcriptionStatus}
						/>
					</div>
				) : (
					<Link href="/dashboard/settings/integrations">
						<Button variant="outline" size="sm" className="w-full gap-2">
							<Settings className="w-4 h-4" />
							Connect in Settings
						</Button>
					</Link>
				)}
			</div>
		</div>
	);
}
```

**Step 2: Update Sidebar.tsx to include Integrations tab**

Add import:
```typescript
import { Integrations } from "./tabs/Integrations";
```

Add to TabType:
```typescript
type TabType = "activity" | "transcript" | "summary" | "integrations" | "settings";
```

Add to tabs array:
```typescript
{
	id: "integrations",
	label: "Integrations",
	disabled: false,
},
```

Add to renderTabContent switch:
```typescript
case "integrations":
	return (
		<Integrations
			videoId={data.id}
			videoName={data.name}
			transcriptionStatus={data.transcriptionStatus}
			isOwner={isOwner}
		/>
	);
```

**Step 3: Commit**

```bash
git add apps/web/app/s/\[videoId\]/_components/tabs/Integrations.tsx
git add apps/web/app/s/\[videoId\]/_components/Sidebar.tsx
git commit -m "feat: add Integrations tab to video sidebar"
```

---

## Final Integration Tasks

### Task F1: Update VideoData Type

**Files:**
- Modify: `apps/web/app/s/[videoId]/types.ts`

**Step 1: Ensure transcriptionStatus is included in VideoData type**

Check the file and add if missing:
```typescript
transcriptionStatus?: "PROCESSING" | "COMPLETE" | "ERROR" | "SKIPPED" | null;
```

**Step 2: Commit**

```bash
git add apps/web/app/s/\[videoId\]/types.ts
git commit -m "feat: add transcriptionStatus to VideoData type"
```

---

### Task F2: Add Navigation Link to Integrations Settings

**Files:**
- Find and modify the settings navigation component (likely in dashboard layout)

**Step 1: Find settings navigation**

```bash
grep -r "settings/account" apps/web --include="*.tsx" | head -5
```

**Step 2: Add Integrations link alongside existing settings links**

Add navigation item:
```typescript
{
	href: "/dashboard/settings/integrations",
	label: "Integrations",
	icon: <PlugIcon className="w-4 h-4" />,
}
```

**Step 3: Commit**

```bash
git add [modified files]
git commit -m "feat: add Integrations to settings navigation"
```

---

### Task F3: End-to-End Testing

**Steps:**

1. Set environment variables on Railway:
   ```
   NOTION_CLIENT_ID=<your-notion-client-id>
   NOTION_CLIENT_SECRET=<your-notion-client-secret>
   NOTION_REDIRECT_URI=https://cap-web-production-d5ac.up.railway.app/api/integrations/notion/callback
   ```

2. Update Notion integration redirect URI to match

3. Deploy and test:
   - Go to Settings > Integrations
   - Click "Connect Notion"
   - Authorize and select database
   - Go to a video with completed transcription
   - Click "Create Ticket" button
   - Review and submit
   - Verify ticket appears in Notion

---

## Summary

| Stream | Tasks | Est. Files Changed |
|--------|-------|-------------------|
| A: Database & Backend | A1-A4 | 3 files |
| B: Notion OAuth | B1-B3 | 3 files |
| C: AI Extraction | C1-C2 | 2 files |
| D: Frontend UI | D1-D5 | 7 files |
| Final | F1-F3 | 2 files |

**Total new files:** ~12
**Total modified files:** ~5

---

Plan complete and saved to `docs/plans/2026-01-07-notion-ticket-implementation.md`.

**Two execution options:**

1. **Subagent-Driven (this session)** - I dispatch fresh subagent per task, review between tasks, fast iteration

2. **Parallel Session (separate)** - Open new session with executing-plans, batch execution with checkpoints

Which approach?
