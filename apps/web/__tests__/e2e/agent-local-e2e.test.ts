import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { parse } from "dotenv";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/password-cookie", () => ({
	getVerifiedPasswordHashes: vi.fn(async () => []),
	setVerifiedPasswordCookie: vi.fn(async () => undefined),
}));
vi.mock("workflow/api", () => ({
	start: vi.fn(async () => ({ id: "agent-e2e-workflow" })),
}));

const enabled = process.env.CAP_AGENT_E2E === "1";
const agentE2e = enabled ? describe.sequential : describe.skip;
const databaseName =
	process.env.CAP_AGENT_E2E_DATABASE ?? "cap_agent_e2e_d6e480cf";
const databaseUrl = `mysql://root@127.0.0.1:3306/${databaseName}`;
if (enabled) process.env.DATABASE_URL = databaseUrl;
const token = `cap_cli_${"A".repeat(43)}`;
const memberToken = `cap_cli_${"B".repeat(43)}`;
const userId = "usr_e2e_owner";
const memberId = "usr_e2e_member";
const organizationMemberId = "mem_e2e_user";
const organizationId = "org_e2e_main";
const videoId = "cap_e2e_owned";
const developerAppId = "dev_e2e_app";
const operationId = "op_e2e_ready";
const bucket = "capso";
const tinyPng =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9WlS8AAAAASUVORK5CYII=";
const transcriptVtt =
	"WEBVTT\n\n1\n00:00:00.000 --> 00:00:01.000\nSynthetic local transcript\n";
const scopes = [
	"caps:read",
	"caps:comment",
	"caps:write",
	"profile:read",
	"profile:write",
	"caps:upload",
	"caps:process",
	"caps:delete",
	"library:read",
	"library:write",
	"analytics:read",
	"organizations:read",
	"organizations:manage",
	"organizations:members",
	"notifications:read",
	"notifications:write",
	"integrations:read",
	"integrations:write",
	"billing:read",
	"billing:write",
	"developer:read",
	"developer:write",
	"developer:secrets",
];

type JsonObject = Record<string, unknown>;

type ApiResult = {
	status: number;
	headers: Headers;
	json: unknown;
	text: string;
};

let connection: Connection;
let server: Server;
let serverUrl: string;
let idempotencySequence = 0;
let uploadedVideoId: string | undefined;
let createdOrganizationId: string | undefined;

const asObject = (value: unknown) => {
	expect(value).toBeTypeOf("object");
	expect(value).not.toBeNull();
	return value as JsonObject;
};

const expectSuccess = (result: ApiResult) => {
	expect(result.status, result.text).toBeGreaterThanOrEqual(200);
	expect(result.status, result.text).toBeLessThan(300);
	return asObject(result.json);
};

const nextIdempotencyKey = () => {
	idempotencySequence += 1;
	return `agent-e2e-${idempotencySequence}`;
};

const api = async (
	method: string,
	path: string,
	options: {
		body?: unknown;
		text?: string;
		headers?: Record<string, string>;
		idempotencyKey?: string;
		tokenValue?: string;
	} = {},
): Promise<ApiResult> => {
	const headers = new Headers(options.headers);
	headers.set("Authorization", `Bearer ${options.tokenValue ?? token}`);
	if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
		headers.set(
			"Idempotency-Key",
			options.idempotencyKey ?? nextIdempotencyKey(),
		);
		headers.set("X-Cap-Confirmation", "user");
	}
	let body: string | undefined;
	if (options.text !== undefined) {
		headers.set("Content-Type", "text/plain");
		body = options.text;
	} else if (options.body !== undefined) {
		headers.set("Content-Type", "application/json");
		body = JSON.stringify(options.body);
	}
	const response = await fetch(`${serverUrl}${path}`, {
		method,
		headers,
		body,
	});
	const text = await response.text();
	let json: unknown = null;
	if (text && response.headers.get("content-type")?.includes("json")) {
		json = JSON.parse(text);
	}
	return { status: response.status, headers: response.headers, json, text };
};

const runCli = async (
	args: string[],
	environment: Record<string, string> = {},
) => {
	const child = spawn(
		resolve(process.cwd(), "../../target/release/cap"),
		args,
		{
			env: {
				...process.env,
				CAP_AGENT_TOKEN: token,
				CAP_SERVER_URL: serverUrl,
				...environment,
			},
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (value: string) => {
		stdout += value;
	});
	child.stderr.on("data", (value: string) => {
		stderr += value;
	});
	const status = await new Promise<number | null>((resolveStatus, reject) => {
		child.once("error", reject);
		child.once("close", resolveStatus);
	});
	expect(status, stderr).toBe(0);
	return stdout.trim() ? (JSON.parse(stdout) as unknown) : null;
};

const seedDatabase = async () => {
	const [tables] = await connection.query<RowDataPacket[]>("SHOW TABLES");
	await connection.query("SET FOREIGN_KEY_CHECKS = 0");
	for (const row of tables) {
		const tableName = String(Object.values(row)[0]);
		await connection.query(`TRUNCATE TABLE \`${tableName}\``);
	}
	for (const tableName of [
		"agent_api_authorization_codes",
		"agent_api_idempotency",
		"agent_api_keys",
		"agent_api_operations",
	]) {
		await connection.query(`DELETE FROM \`${tableName}\``);
	}
	await connection.query("SET FOREIGN_KEY_CHECKS = 1");
	await connection.execute(
		`INSERT INTO users
			(id, name, lastName, email, stripeSubscriptionId, stripeSubscriptionStatus, activeOrganizationId, defaultOrgId, inviteQuota, preferences)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			userId,
			"Agent",
			"Owner",
			"agent-owner@cap.local",
			"sub_e2e_owner",
			"active",
			organizationId,
			organizationId,
			10,
			JSON.stringify({
				notifications: {
					pauseComments: false,
					pauseReplies: false,
					pauseViews: false,
					pauseReactions: false,
					pauseAnonViews: false,
				},
			}),
			memberId,
			"Agent",
			"Member",
			"agent-member@cap.local",
			null,
			null,
			organizationId,
			organizationId,
			1,
			JSON.stringify({
				notifications: {
					pauseComments: false,
					pauseReplies: false,
					pauseViews: false,
					pauseReactions: false,
					pauseAnonViews: false,
				},
			}),
		],
	);
	await connection.execute(
		"INSERT INTO organizations (id, name, ownerId, settings) VALUES (?, ?, ?, ?)",
		[
			organizationId,
			"Agent E2E Organization",
			userId,
			JSON.stringify({ aiGenerationLanguage: "auto" }),
		],
	);
	await connection.execute(
		`INSERT INTO organization_members (id, userId, organizationId, role, hasProSeat)
		 VALUES (?, ?, ?, ?, ?), (?, ?, ?, ?, ?)`,
		[
			"mem_e2e_owner",
			userId,
			organizationId,
			"owner",
			true,
			"mem_e2e_user",
			memberId,
			organizationId,
			"member",
			false,
		],
	);
	await connection.execute(
		`INSERT INTO videos
			(id, ownerId, orgId, name, duration, width, height, fps, metadata, public, settings, transcriptionStatus, source, createdAt, updatedAt)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
		[
			videoId,
			userId,
			organizationId,
			"Synthetic Agent Cap",
			1,
			1280,
			720,
			30,
			JSON.stringify({
				aiTitle: "Synthetic AI title",
				summary: "Synthetic local summary",
				chapters: [{ title: "Opening", start: 0 }],
				aiGenerationStatus: "COMPLETE",
			}),
			true,
			JSON.stringify({ defaultPlaybackSpeed: 1 }),
			"COMPLETE",
			JSON.stringify({ type: "webMP4" }),
		],
	);
	await connection.execute(
		`INSERT INTO video_uploads
			(video_id, uploaded, total, mode, phase, processing_progress, processing_message, raw_file_key)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			videoId,
			1024,
			1024,
			"singlepart",
			"complete",
			100,
			"Complete",
			`${userId}/${videoId}/result.mp4`,
		],
	);
	await connection.execute(
		`INSERT INTO comments (id, type, content, timestamp, authorId, videoId)
		 VALUES (?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?)`,
		[
			"cmt_e2e_text",
			"text",
			"Seeded comment",
			0.25,
			memberId,
			videoId,
			"cmt_e2e_emoji",
			"emoji",
			"👍",
			0.5,
			memberId,
			videoId,
		],
	);
	await connection.execute(
		`INSERT INTO notifications (id, orgId, recipientId, type, data, videoId, dedupKey)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		[
			"ntf_e2e_item",
			organizationId,
			userId,
			"comment",
			JSON.stringify({ videoId, authorId: memberId }),
			videoId,
			"agent-e2e-notification",
		],
	);
	await connection.execute(
		`INSERT INTO agent_api_keys (id, userId, tokenHash, name, scopes, expiresAt)
		 VALUES (?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL 1 DAY)),
			(?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL 1 DAY))`,
		[
			"key_e2e_agent",
			userId,
			createHash("sha256").update(token).digest("hex"),
			"Agent E2E",
			JSON.stringify(scopes),
			"key_e2e_member",
			memberId,
			createHash("sha256").update(memberToken).digest("hex"),
			"Agent E2E Member",
			JSON.stringify(["caps:read", "caps:comment", "caps:write"]),
		],
	);
	await connection.execute(
		`INSERT INTO developer_apps (id, ownerId, name, environment)
		 VALUES (?, ?, ?, ?)`,
		[developerAppId, userId, "Seeded Developer App", "development"],
	);
	await connection.execute(
		`INSERT INTO developer_credit_accounts
			(id, appId, ownerId, balanceMicroCredits, autoTopUpEnabled, autoTopUpThresholdMicroCredits, autoTopUpAmountCents)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		["dca_e2e_main", developerAppId, userId, 500_000, false, 0, 0],
	);
	await connection.execute(
		`INSERT INTO developer_videos (id, appId, externalUserId, name, duration, width, height, fps)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			"dvid_e2e_item",
			developerAppId,
			"synthetic-user",
			"Synthetic SDK Video",
			2,
			1920,
			1080,
			30,
		],
	);
	await connection.execute(
		`INSERT INTO developer_credit_transactions
			(id, accountId, type, amountMicroCredits, balanceAfterMicroCredits, referenceId, referenceType)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		[
			"dtx_e2e_item",
			"dca_e2e_main",
			"adjustment",
			500_000,
			500_000,
			"agent-e2e",
			"manual",
		],
	);
	await connection.execute(
		`INSERT INTO agent_api_operations
			(id, userId, kind, resourceId, resultResourceId, state, payload, result, completedAt)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
		[
			operationId,
			userId,
			"duplicate_cap",
			videoId,
			"cap_e2e_copy",
			"succeeded",
			JSON.stringify({ videoId }),
			JSON.stringify({ id: "cap_e2e_copy" }),
		],
	);
};

const startApiServer = async () => {
	const route = await import("@/app/api/v1/[...route]/route");
	const progressWebhook = await import(
		"@/app/api/webhooks/media-server/progress/route"
	);
	const handlers = new Map<string, (request: Request) => Promise<Response>>([
		["GET", route.GET],
		["POST", route.POST],
		["PATCH", route.PATCH],
		["PUT", route.PUT],
		["DELETE", route.DELETE],
		["OPTIONS", route.OPTIONS],
	]);
	server = createServer(async (incoming, outgoing) => {
		try {
			const chunks: Buffer[] = [];
			for await (const chunk of incoming) {
				chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
			}
			const method = incoming.method ?? "GET";
			const handler = handlers.get(method);
			if (!handler) {
				outgoing.writeHead(405).end();
				return;
			}
			const body = Buffer.concat(chunks);
			const request = new Request(
				`http://${incoming.headers.host}${incoming.url ?? "/"}`,
				{
					method,
					headers: incoming.headers as HeadersInit,
					body: method === "GET" || method === "HEAD" ? undefined : body,
				},
			);
			const response = incoming.url?.startsWith(
				"/api/webhooks/media-server/progress",
			)
				? await progressWebhook.POST(
						Object.assign(request, {
							nextUrl: new URL(request.url),
						}) as Parameters<typeof progressWebhook.POST>[0],
					)
				: await handler(request);
			const responseBody = Buffer.from(await response.arrayBuffer());
			outgoing.writeHead(response.status, Object.fromEntries(response.headers));
			outgoing.end(responseBody);
		} catch (error) {
			console.error("Agent E2E request failed", error);
			outgoing.writeHead(500, { "Content-Type": "text/plain" });
			outgoing.end("Internal Server Error");
		}
	});
	await new Promise<void>((resolveListen, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolveListen);
	});
	const address = server.address() as AddressInfo;
	serverUrl = `http://127.0.0.1:${address.port}`;
	process.env.WEB_URL = serverUrl;
	process.env.NEXT_PUBLIC_WEB_URL = serverUrl;
	process.env.NEXTAUTH_URL = serverUrl;
	process.env.MEDIA_SERVER_WEBHOOK_URL = serverUrl;
};

agentE2e("Cap agent local Docker E2E", () => {
	beforeAll(async () => {
		const workspaceEnvironment = parse(
			await readFile(resolve(process.cwd(), "../../.env")),
		);
		Object.assign(process.env, {
			DATABASE_URL: databaseUrl,
			DATABASE_ENCRYPTION_KEY: "11".repeat(32),
			NEXTAUTH_SECRET: "synthetic-agent-e2e-secret-that-is-long-enough",
			NEXTAUTH_URL: "http://127.0.0.1",
			WEB_URL: "http://127.0.0.1",
			NEXT_PUBLIC_WEB_URL: "http://127.0.0.1",
			NEXT_PUBLIC_IS_CAP: "false",
			NODE_ENV: "test",
			CAP_AWS_BUCKET: bucket,
			CAP_AWS_REGION: "us-east-1",
			CAP_AWS_ACCESS_KEY: "capS3root",
			CAP_AWS_SECRET_KEY: "capS3root",
			CAP_AWS_ENDPOINT: "http://127.0.0.1:9000",
			CAP_AWS_BUCKET_URL: "http://127.0.0.1:9000/capso",
			S3_PATH_STYLE: "true",
			MEDIA_SERVER_URL: "http://127.0.0.1:3456",
			MEDIA_SERVER_WEBHOOK_SECRET:
				workspaceEnvironment.MEDIA_SERVER_WEBHOOK_SECRET ??
				"local-media-server-secret",
		});
		connection = await mysql.createConnection({
			host: "127.0.0.1",
			port: 3306,
			user: "root",
			database: databaseName,
		});
		await seedDatabase();
		const s3 = new S3Client({
			endpoint: "http://127.0.0.1:9000",
			region: "us-east-1",
			forcePathStyle: true,
			credentials: {
				accessKeyId: "capS3root",
				secretAccessKey: "capS3root",
			},
		});
		await Promise.all([
			s3.send(
				new PutObjectCommand({
					Bucket: bucket,
					Key: `${userId}/${videoId}/transcription.vtt`,
					Body: transcriptVtt,
					ContentType: "text/vtt",
				}),
			),
			s3.send(
				new PutObjectCommand({
					Bucket: bucket,
					Key: `${userId}/${videoId}/result.mp4`,
					Body: Buffer.alloc(1024, 1),
					ContentType: "video/mp4",
				}),
			),
		]);
		await startApiServer();
	}, 60_000);

	afterAll(async () => {
		if (server) {
			await new Promise<void>((resolveClose) =>
				server.close(() => resolveClose()),
			);
		}
		if (connection) await connection.end();
	});

	it("walks every local read family through the real handler", async () => {
		const reads = [
			["/api/v1/auth/status", "authenticated"],
			["/api/v1/caps?scope=all&limit=50", "caps"],
			[`/api/v1/caps/${videoId}`, "id"],
			[`/api/v1/caps/${videoId}/context`, "cap"],
			[`/api/v1/caps/${videoId}/status`, "id"],
			[`/api/v1/caps/${videoId}/settings`, "overrides"],
			[`/api/v1/caps/${videoId}/shares`, "organizations"],
			["/api/v1/me", "id"],
			["/api/v1/organizations", "organizations"],
			[`/api/v1/organizations/${organizationId}`, "organization"],
			[`/api/v1/organizations/${organizationId}/members`, "members"],
			[`/api/v1/organizations/${organizationId}/invites`, "invites"],
			[`/api/v1/organizations/${organizationId}/folders`, "folders"],
			[`/api/v1/organizations/${organizationId}/spaces`, "spaces"],
			[
				`/api/v1/organizations/${organizationId}/storage-integrations`,
				"integrations",
			],
			[`/api/v1/organizations/${organizationId}/billing`, "organizationId"],
			["/api/v1/me/notifications", "notifications"],
			["/api/v1/me/notification-preferences", "pauseComments"],
			["/api/v1/developer/apps", "apps"],
			[`/api/v1/developer/apps/${developerAppId}/context`, "app"],
			[`/api/v1/developer/apps/${developerAppId}/videos`, "videos"],
			[`/api/v1/developer/apps/${developerAppId}/transactions`, "transactions"],
			[`/api/v1/operations/${operationId}`, "id"],
		] as const;
		for (const [path, expectedField] of reads) {
			const result = await api("GET", path);
			expect(result.status, `${path}: ${result.text}`).toBeGreaterThanOrEqual(
				200,
			);
			expect(result.status, `${path}: ${result.text}`).toBeLessThan(300);
			const body = asObject(result.json);
			expect(body).toHaveProperty(expectedField);
		}
		const analytics = await api(
			"GET",
			`/api/v1/analytics?organizationId=${organizationId}&range=month`,
		);
		expect(analytics.status).toBe(200);
		expect(asObject(analytics.json).data).toBeTypeOf("object");

		const transcriptText = await api(
			"GET",
			`/api/v1/caps/${videoId}/transcript?format=text`,
		);
		expect(transcriptText.status).toBe(200);
		expect(transcriptText.text).toContain("Synthetic local transcript");
		const transcriptJson = expectSuccess(
			await api("GET", `/api/v1/caps/${videoId}/transcript?format=json`),
		);
		expect(transcriptJson.cues).toHaveLength(1);
		const transcriptVttResponse = await api(
			"GET",
			`/api/v1/caps/${videoId}/transcript?format=vtt`,
		);
		expect(transcriptVttResponse.status).toBe(200);
		expect(transcriptVttResponse.text).toBe(transcriptVtt);
		const download = expectSuccess(
			await api("GET", `/api/v1/caps/${videoId}/download`),
		);
		expect(download.url).toBeTypeOf("string");
		const downloaded = await fetch(String(download.url));
		expect(downloaded.status).toBe(200);
		expect((await downloaded.arrayBuffer()).byteLength).toBe(1024);
	});

	it("runs the compiled CLI against the local HTTP and database stack", async () => {
		const list = asObject(await runCli(["--json", "caps", "list"]));
		expect(list.caps).toHaveLength(1);
		const cap = asObject(await runCli(["--json", "caps", "get", videoId]));
		expect(cap.id).toBe(videoId);
		const context = asObject(
			await runCli(["--json", "caps", "context", videoId]),
		);
		expect(asObject(context.cap).id).toBe(videoId);
		const status = asObject(
			await runCli(["--json", "caps", "status", videoId]),
		);
		expect(status.id).toBe(videoId);
		const account = asObject(await runCli(["--json", "account", "get"]));
		expect(account.id).toBe(userId);
		const authentication = asObject(await runCli(["--json", "auth", "status"]));
		expect(authentication.authenticated).toBe(true);
		expect(authentication.source).toBe("env");
		const organizations = asObject(
			await runCli(["--json", "organizations", "list"]),
		);
		expect(organizations.organizations).toHaveLength(1);
		const folders = asObject(
			await runCli(["--json", "library", "folders", "list", organizationId]),
		);
		expect(folders.folders).toHaveLength(0);
		const notifications = asObject(
			await runCli(["--json", "notifications", "list"]),
		);
		expect(notifications.notifications).toHaveLength(1);
		const developers = asObject(await runCli(["--json", "developers", "list"]));
		expect(developers.apps).toHaveLength(1);
		expect(
			asObject(await runCli(["--json", "organizations", "get", organizationId]))
				.organization,
		).toBeTypeOf("object");
		expect(
			asObject(
				await runCli([
					"--json",
					"organizations",
					"storage",
					"list",
					organizationId,
				]),
			).integrations,
		).toHaveLength(0);
		expect(
			asObject(await runCli(["--json", "developers", "get", developerAppId]))
				.app,
		).toBeTypeOf("object");
		expect(
			asObject(await runCli(["--json", "jobs", "get", operationId])).state,
		).toBe("succeeded");
		expect(
			asObject(
				await runCli(["--json", "analytics", "--organization", organizationId]),
			).data,
		).toBeTypeOf("object");

		const cliComment = asObject(
			await runCli([
				"--json",
				"caps",
				"comments",
				"add",
				videoId,
				"Comment through CLI",
				"--timestamp-ms",
				"100",
				"--yes",
			]),
		);
		expect(cliComment.type).toBe("text");
		expect(
			asObject(
				await runCli([
					"--json",
					"caps",
					"comments",
					"reply",
					videoId,
					String(cliComment.id),
					"Reply through CLI",
					"--yes",
				]),
			).parentCommentId,
		).toBe(cliComment.id);
		expect(
			asObject(
				await runCli([
					"--json",
					"caps",
					"reactions",
					"add",
					videoId,
					"👏",
					"--yes",
				]),
			).type,
		).toBe("emoji");
		expect(
			asObject(
				await runCli([
					"--json",
					"caps",
					"update",
					videoId,
					"--title",
					"Updated through CLI",
					"--yes",
				]),
			).title,
		).toBe("Updated through CLI");
		expect(
			asObject(
				await runCli([
					"--json",
					"caps",
					"sharing",
					"set",
					videoId,
					"--private",
					"--yes",
				]),
			).public,
		).toBe(false);
		expect(
			asObject(
				await runCli([
					"--json",
					"caps",
					"process",
					videoId,
					"--target",
					"transcript",
					"--yes",
				]),
			).requested,
		).toBe("transcript");
		expect(
			asObject(
				await runCli([
					"--json",
					"notifications",
					"preferences",
					"--pause-views",
					"true",
					"--yes",
				]),
			).pauseViews,
		).toBe(true);

		const outputDirectory = await mkdtemp(
			resolve(tmpdir(), "cap-agent-cli-e2e-"),
		);
		try {
			const transcriptPath = resolve(outputDirectory, "transcript.vtt");
			const transcriptResult = asObject(
				await runCli([
					"--json",
					"caps",
					"transcript",
					videoId,
					"--format",
					"vtt",
					"--output",
					transcriptPath,
				]),
			);
			expect(transcriptResult.bytes).toBe(Buffer.byteLength(transcriptVtt));
			expect(await readFile(transcriptPath, "utf8")).toBe(transcriptVtt);

			const downloadPath = resolve(outputDirectory, "download.mp4");
			const downloadResult = asObject(
				await runCli([
					"--json",
					"caps",
					"download",
					videoId,
					"--output",
					downloadPath,
				]),
			);
			expect(downloadResult.bytes).toBe(1024);
			expect((await stat(downloadPath)).size).toBe(1024);
			expect(
				await runCli([
					"--json",
					"caps",
					"wait",
					videoId,
					"--for",
					"all",
					"--timeout",
					"1",
				]),
			).not.toBeNull();
		} finally {
			await rm(outputDirectory, { recursive: true, force: true });
		}
	});

	it("uploads and processes a real MP4 through CLI, MinIO, and the media server", async () => {
		const fixture = resolve(
			process.cwd(),
			"../media-server/src/__tests__/fixtures/test-no-audio.mp4",
		);
		const uploaded = asObject(
			await runCli([
				"--json",
				"upload",
				fixture,
				"--name",
				"Agent E2E Uploaded Cap",
			]),
		);
		uploadedVideoId = String(uploaded.id);
		expect(uploaded.type).toBe("uploaded");
		expect(uploaded.link).toBe(`${serverUrl}/s/${uploadedVideoId}`);

		const [uploads] = await connection.execute<RowDataPacket[]>(
			"SELECT raw_file_key AS rawFileKey, phase FROM video_uploads WHERE video_id = ?",
			[uploadedVideoId],
		);
		expect(uploads[0]?.phase).toBe("processing");
		const rawFileKey = String(uploads[0]?.rawFileKey);
		expect(rawFileKey).toMatch(
			new RegExp(`^${userId}/${uploadedVideoId}/verified-upload-[^.]+\\.mp4$`),
		);

		const { processVideoWorkflow } = await import("@/workflows/process-video");
		const result = await processVideoWorkflow({
			videoId: uploadedVideoId,
			userId,
			rawFileKey,
			bucketId: null,
		});
		expect(result.success).toBe(true);
		expect(result.metadata?.width).toBeGreaterThan(0);
		expect(result.metadata?.height).toBeGreaterThan(0);

		const cap = asObject(
			await runCli(["--json", "caps", "get", uploadedVideoId]),
		);
		expect(cap.title).toBe("Agent E2E Uploaded Cap");
		const outputDirectory = await mkdtemp(
			resolve(tmpdir(), "cap-agent-upload-e2e-"),
		);
		try {
			const downloadPath = resolve(outputDirectory, "processed.mp4");
			const downloaded = asObject(
				await runCli([
					"--json",
					"caps",
					"download",
					uploadedVideoId,
					"--output",
					downloadPath,
				]),
			);
			expect(Number(downloaded.bytes)).toBeGreaterThan(0);
			expect((await stat(downloadPath)).size).toBe(Number(downloaded.bytes));
		} finally {
			await rm(outputDirectory, { recursive: true, force: true });
		}
	}, 60_000);

	it("installs the skill and MCP config only into an isolated selected agent", async () => {
		const home = await mkdtemp(resolve(tmpdir(), "cap-agent-install-e2e-"));
		const codexHome = resolve(home, ".codex");
		try {
			const preview = asObject(
				await runCli(
					[
						"--json",
						"agents",
						"install",
						"--target",
						"codex",
						"--component",
						"all",
						"--dry-run",
						"--yes",
					],
					{ HOME: home, CODEX_HOME: codexHome },
				),
			);
			expect(preview.applied).toBe(false);
			expect(preview.changes).toHaveLength(2);

			const installed = asObject(
				await runCli(
					[
						"--json",
						"agents",
						"install",
						"--target",
						"codex",
						"--component",
						"all",
						"--yes",
					],
					{ HOME: home, CODEX_HOME: codexHome },
				),
			);
			expect(installed.applied).toBe(true);
			expect(
				await readFile(resolve(codexHome, "skills/cap/SKILL.md"), "utf8"),
			).toContain("cap guide --json");
			expect(
				await readFile(resolve(codexHome, "config.toml"), "utf8"),
			).toContain('command = "cap"');
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});

	it("persists confirmed mutations, permissions, idempotency, and secure input", async () => {
		const updatedProfile = expectSuccess(
			await api("PATCH", "/api/v1/me", {
				body: { name: "Updated Agent", lastName: "E2E" },
			}),
		);
		expect(updatedProfile.name).toBe("Updated Agent");

		const preferences = expectSuccess(
			await api("PATCH", "/api/v1/me/notification-preferences", {
				body: { pauseComments: true, pauseAnonymousViews: true },
			}),
		);
		expect(preferences.pauseComments).toBe(true);
		expectSuccess(
			await api("POST", "/api/v1/me/notifications/read", {
				body: { all: true },
			}),
		);

		const commentKey = nextIdempotencyKey();
		const firstComment = expectSuccess(
			await api("POST", `/api/v1/caps/${videoId}/comments`, {
				body: { content: "Agent E2E comment", timestampMs: 200 },
				idempotencyKey: commentKey,
			}),
		);
		const replayedComment = expectSuccess(
			await api("POST", `/api/v1/caps/${videoId}/comments`, {
				body: { content: "Agent E2E comment", timestampMs: 200 },
				idempotencyKey: commentKey,
			}),
		);
		expect(replayedComment.id).toBe(firstComment.id);
		const missingReplyKey = nextIdempotencyKey();
		for (let attempt = 0; attempt < 2; attempt += 1) {
			const missingReply = await api(
				"POST",
				`/api/v1/caps/${videoId}/comments/missingcomment1/replies`,
				{
					body: { content: "Missing parent" },
					idempotencyKey: missingReplyKey,
				},
			);
			expect(missingReply.status).toBe(404);
			expect(asObject(missingReply.json).code).toBe("NOT_FOUND");
		}
		const reply = expectSuccess(
			await api(
				"POST",
				`/api/v1/caps/${videoId}/comments/${String(firstComment.id)}/replies`,
				{ body: { content: "Agent E2E reply" } },
			),
		);
		const reaction = expectSuccess(
			await api("POST", `/api/v1/caps/${videoId}/reactions`, {
				body: { content: "🚀", timestampMs: 400 },
			}),
		);
		expect(reply.parentCommentId).toBe(firstComment.id);
		expect(reaction.type).toBe("emoji");

		const updatedCap = expectSuccess(
			await api("PATCH", `/api/v1/caps/${videoId}`, {
				body: { title: "Updated Agent Cap", public: false },
			}),
		);
		expect(updatedCap.title).toBe("Updated Agent Cap");
		expect(updatedCap.public).toBe(false);
		expectSuccess(
			await api("PATCH", `/api/v1/caps/${videoId}/settings`, {
				body: { defaultPlaybackSpeed: 1.25, disableReactions: false },
			}),
		);
		expectSuccess(
			await api("PATCH", `/api/v1/caps/${videoId}/date`, {
				body: { createdAt: "2026-07-18T12:00:00.000Z" },
			}),
		);

		const transcript = expectSuccess(
			await api("GET", `/api/v1/caps/${videoId}/transcript?format=json`),
		);
		const replaced = expectSuccess(
			await api("PUT", `/api/v1/caps/${videoId}/transcript`, {
				body: {
					expectedRevision: transcript.revision,
					cues: [{ startMs: 0, endMs: 1000, text: "Replaced transcript" }],
				},
			}),
		);
		expect(replaced.cueCount).toBe(1);

		expectSuccess(
			await api("PUT", `/api/v1/caps/${videoId}/password`, {
				text: "local-agent-password",
			}),
		);
		expectSuccess(
			await api("PATCH", `/api/v1/caps/${videoId}`, {
				body: { public: true },
			}),
		);
		const locked = await api("GET", `/api/v1/caps/${videoId}/context`, {
			tokenValue: memberToken,
		});
		expect(locked.status).toBe(403);
		expect(asObject(locked.json).code).toBe("PASSWORD_REQUIRED");
		const unlock = expectSuccess(
			await api("POST", `/api/v1/caps/${videoId}/unlock`, {
				text: "local-agent-password",
				tokenValue: memberToken,
			}),
		);
		const unlocked = await api("GET", `/api/v1/caps/${videoId}/context`, {
			headers: { "X-Cap-Access-Grant": String(unlock.accessGrant) },
			tokenValue: memberToken,
		});
		expect(unlocked.status).toBe(200);
		expectSuccess(
			await api("PUT", `/api/v1/caps/${videoId}/password`, { text: "" }),
		);

		expectSuccess(
			await api(
				"DELETE",
				`/api/v1/caps/${videoId}/comments/${String(reply.id)}`,
			),
		);
		expectSuccess(
			await api(
				"DELETE",
				`/api/v1/caps/${videoId}/comments/${String(reaction.id)}`,
			),
		);
	});

	it("walks organization, library, storage, image, and developer management", async () => {
		const createdOrganization = expectSuccess(
			await api("POST", "/api/v1/organizations", {
				body: { name: "Created by Agent E2E" },
			}),
		);
		expect(createdOrganization.action).toBe("created");
		createdOrganizationId = String(asObject(createdOrganization.resource).id);

		expectSuccess(
			await api("PATCH", `/api/v1/organizations/${organizationId}`, {
				body: {
					name: "Updated E2E Organization",
					allowedEmailDomain: "cap.local",
				},
			}),
		);
		expectSuccess(
			await api("PATCH", `/api/v1/organizations/${organizationId}/settings`, {
				body: {
					disableComments: false,
					aiGenerationLanguage: "en",
					defaultPlaybackSpeed: 1.5,
				},
			}),
		);

		const invite = expectSuccess(
			await api("POST", `/api/v1/organizations/${organizationId}/invites`, {
				body: {
					email: "invitee@cap.local",
					role: "member",
					sendEmail: false,
				},
			}),
		);
		expectSuccess(
			await api(
				"DELETE",
				`/api/v1/organizations/${organizationId}/invites/${String(asObject(invite.invite).id)}`,
			),
		);
		expectSuccess(
			await api(
				"PATCH",
				`/api/v1/organizations/${organizationId}/members/${organizationMemberId}`,
				{ body: { role: "admin" } },
			),
		);
		expectSuccess(
			await api(
				"PATCH",
				`/api/v1/organizations/${organizationId}/members/${organizationMemberId}/seat`,
				{ body: { enabled: true } },
			),
		);

		const folder = expectSuccess(
			await api("POST", `/api/v1/organizations/${organizationId}/folders`, {
				body: {
					name: "Agent Folder",
					color: "blue",
					spaceId: organizationId,
				},
			}),
		);
		const folderId = String(asObject(folder.resource).id);
		const space = expectSuccess(
			await api("POST", `/api/v1/organizations/${organizationId}/spaces`, {
				body: {
					name: "Agent Space",
					description: "Synthetic E2E space",
					privacy: "Private",
				},
			}),
		);
		const spaceId = String(asObject(space.resource).id);
		expectSuccess(
			await api("PATCH", `/api/v1/folders/${folderId}`, {
				body: { name: "Updated Agent Folder", color: "yellow" },
			}),
		);
		expectSuccess(
			await api("PATCH", `/api/v1/spaces/${spaceId}`, {
				body: { name: "Updated Agent Space", privacy: "Public" },
			}),
		);
		expectSuccess(
			await api("POST", `/api/v1/spaces/${spaceId}/members`, {
				body: { userId: memberId, role: "member" },
			}),
		);
		expectSuccess(
			await api("PATCH", `/api/v1/spaces/${spaceId}/members/${memberId}`, {
				body: { role: "admin" },
			}),
		);
		const spaceMembers = expectSuccess(
			await api("GET", `/api/v1/spaces/${spaceId}/members`),
		);
		expect(spaceMembers.members).toHaveLength(2);
		expectSuccess(
			await api("PATCH", `/api/v1/folders/${folderId}/public-page`, {
				body: {
					public: true,
					title: "Agent Folder Collection",
					layout: "grid",
					gridColumns: 3,
				},
			}),
		);
		expectSuccess(
			await api("PATCH", `/api/v1/spaces/${spaceId}/public-page`, {
				body: {
					public: true,
					title: "Agent Space Collection",
					layout: "list",
				},
			}),
		);

		const moveBeforeShare = await api(
			"PATCH",
			`/api/v1/caps/${videoId}/location`,
			{
				body: {
					container: "space",
					organizationId,
					spaceId,
					folderId: null,
				},
			},
		);
		expect(moveBeforeShare.status).toBe(404);
		expect(asObject(moveBeforeShare.json).code).toBe("NOT_FOUND");
		expectSuccess(
			await api(
				"PUT",
				`/api/v1/caps/${videoId}/shares/organizations/${organizationId}`,
				{ body: { folderId } },
			),
		);
		expectSuccess(
			await api("PUT", `/api/v1/caps/${videoId}/shares/spaces/${spaceId}`, {
				body: { folderId: null },
			}),
		);
		expectSuccess(
			await api("PATCH", `/api/v1/caps/${videoId}/location`, {
				body: {
					container: "space",
					organizationId,
					spaceId,
					folderId: null,
				},
			}),
		);

		const image = {
			data: tinyPng,
			contentType: "image/png",
			fileName: "agent-e2e.png",
		};
		for (const path of [
			"/api/v1/me/image",
			`/api/v1/organizations/${organizationId}/icon`,
			`/api/v1/organizations/${organizationId}/shareable-link-icon`,
			`/api/v1/folders/${folderId}/logo`,
			`/api/v1/spaces/${spaceId}/logo`,
		]) {
			expectSuccess(await api("PUT", path, { body: image }));
			expectSuccess(await api("DELETE", path));
		}

		const s3Config = {
			provider: "minio",
			accessKeyId: "capS3root",
			secretAccessKey: "capS3root",
			endpoint: "http://127.0.0.1:9000",
			bucketName: bucket,
			region: "us-east-1",
		};
		expectSuccess(
			await api(
				"POST",
				`/api/v1/organizations/${organizationId}/storage/s3/test`,
				{
					body: s3Config,
				},
			),
		);
		expectSuccess(
			await api("PUT", `/api/v1/organizations/${organizationId}/storage/s3`, {
				body: s3Config,
			}),
		);
		expectSuccess(
			await api(
				"PATCH",
				`/api/v1/organizations/${organizationId}/storage/provider`,
				{
					body: { provider: "s3" },
				},
			),
		);
		expectSuccess(
			await api("DELETE", `/api/v1/organizations/${organizationId}/storage/s3`),
		);
		for (const result of [
			await api(
				"GET",
				`/api/v1/organizations/${organizationId}/storage/google-drive/folders`,
			),
			await api(
				"PUT",
				`/api/v1/organizations/${organizationId}/storage/google-drive/location`,
				{ body: { folderId: "root" } },
			),
			await api(
				"DELETE",
				`/api/v1/organizations/${organizationId}/storage/google-drive`,
			),
		]) {
			expect(result.status).toBeGreaterThanOrEqual(400);
			expect(asObject(result.json).code).toBeTypeOf("string");
		}

		const developer = expectSuccess(
			await api("POST", "/api/v1/developer/apps", {
				body: { name: "Agent Created App", environment: "development" },
			}),
		);
		const createdAppId = String(developer.appId);
		expect(developer.publicKey).toMatch(/^cpk_/);
		expect(developer.secretKey).toMatch(/^csk_/);
		expectSuccess(
			await api("PATCH", `/api/v1/developer/apps/${createdAppId}`, {
				body: { name: "Updated Agent App", environment: "production" },
			}),
		);
		const domain = expectSuccess(
			await api("POST", `/api/v1/developer/apps/${createdAppId}/domains`, {
				body: { domain: "https://agent-e2e.cap.local" },
			}),
		);
		expectSuccess(
			await api(
				"DELETE",
				`/api/v1/developer/apps/${createdAppId}/domains/${String(asObject(domain.resource).id)}`,
			),
		);
		const rotated = expectSuccess(
			await api("POST", `/api/v1/developer/apps/${createdAppId}/keys/rotate`),
		);
		expect(rotated.secretKey).toMatch(/^csk_/);
		expectSuccess(
			await api("PATCH", `/api/v1/developer/apps/${createdAppId}/auto-top-up`, {
				body: {
					enabled: true,
					thresholdMicroCredits: 100_000,
					amountCents: 1_000,
				},
			}),
		);
		const creditCheckout = await api(
			"POST",
			`/api/v1/developer/apps/${createdAppId}/credits/checkout`,
			{ body: { amountCents: 500 } },
		);
		expect(creditCheckout.status).toBeGreaterThanOrEqual(400);
		expect(asObject(creditCheckout.json).code).toBeTypeOf("string");
		expectSuccess(
			await api("DELETE", `/api/v1/developer/apps/${createdAppId}`),
		);
		expectSuccess(
			await api(
				"DELETE",
				`/api/v1/developer/apps/${developerAppId}/videos/dvid_e2e_item`,
			),
		);

		expectSuccess(
			await api("DELETE", `/api/v1/caps/${videoId}/shares/spaces/${spaceId}`),
		);
		expectSuccess(
			await api(
				"DELETE",
				`/api/v1/caps/${videoId}/shares/organizations/${organizationId}`,
			),
		);
		expectSuccess(
			await api("DELETE", `/api/v1/spaces/${spaceId}/members/${memberId}`),
		);
		expectSuccess(await api("DELETE", `/api/v1/folders/${folderId}`));
		expectSuccess(await api("DELETE", `/api/v1/spaces/${spaceId}`));
	});

	it("executes durable duplicate, delete, domain, and organization workflows", async () => {
		const processResult = expectSuccess(
			await api("POST", `/api/v1/caps/${videoId}/process`, {
				body: { target: "transcript", retry: false },
			}),
		);
		expect(processResult.requested).toBe("transcript");

		const { agentCapOperationWorkflow } = await import(
			"@/workflows/agent-cap-operation"
		);
		const duplicateOperation = expectSuccess(
			await api("POST", `/api/v1/caps/${videoId}/duplicate`),
		);
		expect(duplicateOperation.state).toBe("queued");
		await agentCapOperationWorkflow({
			operationId: String(duplicateOperation.id),
		});
		const completedDuplicate = expectSuccess(
			await api("GET", `/api/v1/operations/${String(duplicateOperation.id)}`),
		);
		expect(completedDuplicate.state).toBe("succeeded");
		const duplicateId = String(completedDuplicate.resultResourceId);
		expectSuccess(await api("GET", `/api/v1/caps/${duplicateId}`));
		const duplicateDownload = expectSuccess(
			await api("GET", `/api/v1/caps/${duplicateId}/download`),
		);
		expect((await fetch(String(duplicateDownload.url))).status).toBe(200);

		const deleteDuplicate = expectSuccess(
			await api("DELETE", `/api/v1/caps/${duplicateId}`),
		);
		await agentCapOperationWorkflow({
			operationId: String(deleteDuplicate.id),
		});
		const deletedDuplicate = expectSuccess(
			await api("GET", `/api/v1/operations/${String(deleteDuplicate.id)}`),
		);
		expect(deletedDuplicate.state).toBe("succeeded");
		expect((await api("GET", `/api/v1/caps/${duplicateId}`)).status).toBe(404);

		if (!uploadedVideoId) throw new Error("Upload E2E did not produce a Cap");
		const deleteUpload = expectSuccess(
			await api("DELETE", `/api/v1/caps/${uploadedVideoId}`),
		);
		await agentCapOperationWorkflow({
			operationId: String(deleteUpload.id),
		});
		expect(
			asObject(
				expectSuccess(
					await api("GET", `/api/v1/operations/${String(deleteUpload.id)}`),
				).result,
			).deleted,
		).toBe(true);

		const invalidDomain = await api(
			"PUT",
			`/api/v1/organizations/${organizationId}/domain`,
			{ body: { domain: "invalid domain" } },
		);
		expect(invalidDomain.status).toBe(400);
		expect(asObject(invalidDomain.json).code).toBe("INVALID_REQUEST");
		for (const [method, path] of [
			["DELETE", `/api/v1/organizations/${organizationId}/domain`],
			["POST", `/api/v1/organizations/${organizationId}/domain/verify`],
		] as const) {
			const operation = expectSuccess(await api(method, path));
			await agentCapOperationWorkflow({ operationId: String(operation.id) });
			const completed = expectSuccess(
				await api("GET", `/api/v1/operations/${String(operation.id)}`),
			);
			expect(completed.state).toBe("succeeded");
		}

		if (!createdOrganizationId) {
			throw new Error(
				"Organization management E2E did not create an organization",
			);
		}
		const deleteOrganization = expectSuccess(
			await api("DELETE", `/api/v1/organizations/${createdOrganizationId}`),
		);
		await agentCapOperationWorkflow({
			operationId: String(deleteOrganization.id),
		});
		const completedOrganizationDelete = expectSuccess(
			await api("GET", `/api/v1/operations/${String(deleteOrganization.id)}`),
		);
		expect(completedOrganizationDelete.state).toBe("succeeded");
		expect(
			(await api("GET", `/api/v1/organizations/${createdOrganizationId}`))
				.status,
		).toBe(403);

		expectSuccess(
			await api(
				"DELETE",
				`/api/v1/organizations/${organizationId}/members/${organizationMemberId}`,
			),
		);
	}, 60_000);

	it("exercises token exchange, revocation, and external dependency boundaries", async () => {
		const verifier = randomBytes(32).toString("base64url");
		const challenge = createHash("sha256").update(verifier).digest("base64url");
		const code = randomBytes(32).toString("base64url");
		const redirectUri = "http://127.0.0.1:45678/callback";
		await connection.execute(
			`INSERT INTO agent_api_authorization_codes
				(id, userId, codeHash, codeChallenge, redirectUri, scopes, expiresAt)
			 VALUES (?, ?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL 10 MINUTE))`,
			[
				"cod_e2e_login",
				userId,
				createHash("sha256").update(code).digest("hex"),
				challenge,
				redirectUri,
				JSON.stringify(["caps:read", "caps:comment", "caps:write"]),
			],
		);
		const exchanged = expectSuccess(
			await api("POST", "/api/v1/auth/token", {
				body: { code, codeVerifier: verifier, redirectUri },
				tokenValue: "unused",
			}),
		);
		const issuedToken = String(exchanged.accessToken);
		expect(issuedToken).toMatch(/^cap_cli_/);
		const issuedRead = await api("GET", "/api/v1/caps", {
			tokenValue: issuedToken,
		});
		expect(issuedRead.status).toBe(200);
		const revoked = expectSuccess(
			await api("POST", "/api/v1/auth/revoke", { tokenValue: issuedToken }),
		);
		expect(revoked.revoked).toBe(true);
		const revokedRead = await api("GET", "/api/v1/caps", {
			tokenValue: issuedToken,
		});
		expect(revokedRead.status).toBe(401);
		expect(asObject(revokedRead.json).code).toBe("TOKEN_EXPIRED");

		const guardedCalls = [
			api("POST", `/api/v1/organizations/${organizationId}/billing/checkout`, {
				body: { interval: "monthly" },
			}),
			api("POST", `/api/v1/organizations/${organizationId}/billing/portal`),
			api(
				"POST",
				`/api/v1/organizations/${organizationId}/storage/google-drive/connect`,
			),
			api("POST", "/api/v1/me/referrals"),
			api("POST", `/api/v1/organizations/${organizationId}/imports/loom`, {
				body: { loomUrl: "not-a-loom-url" },
			}),
		];
		for (const result of await Promise.all(guardedCalls)) {
			expect(result.status).toBeGreaterThanOrEqual(400);
			expect(asObject(result.json).code).toBeTypeOf("string");
		}
	});

	it("runs MCP inventory, resources, reads, and confirmed writes through stdio", async () => {
		const child = spawn(
			resolve(process.cwd(), "../../target/release/cap"),
			["mcp", "serve"],
			{
				env: {
					...process.env,
					CAP_AGENT_TOKEN: token,
					CAP_SERVER_URL: serverUrl,
				},
				stdio: ["pipe", "pipe", "pipe"],
			},
		);
		const lines = createInterface({ input: child.stdout });
		const iterator = lines[Symbol.asyncIterator]();
		const send = (value: unknown) => {
			child.stdin.write(`${JSON.stringify(value)}\n`);
		};
		const readMessage = async () =>
			asObject(JSON.parse(String((await iterator.next()).value)) as unknown);
		send({
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: {
				protocolVersion: "2025-03-26",
				capabilities: {},
				clientInfo: { name: "cap-agent-e2e", version: "1" },
			},
		});
		const initialized = await readMessage();
		expect(initialized.id).toBe(1);
		send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
		send({
			jsonrpc: "2.0",
			id: 2,
			method: "tools/list",
			params: {},
		});
		const listedTools = await readMessage();
		expect(listedTools.id).toBe(2);
		const tools = asObject(listedTools.result).tools;
		expect(tools).toHaveLength(76);
		expect(
			new Set((tools as unknown[]).map((tool) => String(asObject(tool).name)))
				.size,
		).toBe(76);
		send({
			jsonrpc: "2.0",
			id: 3,
			method: "tools/call",
			params: { name: "caps_get", arguments: { cap: videoId } },
		});
		const read = await readMessage();
		expect(read.id).toBe(3);
		expect(JSON.stringify(read)).toContain(videoId);
		send({
			jsonrpc: "2.0",
			id: 4,
			method: "tools/call",
			params: {
				name: "caps_update_title",
				arguments: {
					cap: videoId,
					title: "Updated through MCP",
					confirmed: true,
				},
			},
		});
		const write = await readMessage();
		expect(write.id).toBe(4);
		expect(JSON.stringify(write)).toContain("Updated through MCP");
		send({
			jsonrpc: "2.0",
			id: 5,
			method: "resources/templates/list",
			params: {},
		});
		const templates = await readMessage();
		expect(templates.id).toBe(5);
		expect(asObject(templates.result).resourceTemplates).toHaveLength(3);
		send({
			jsonrpc: "2.0",
			id: 6,
			method: "resources/read",
			params: { uri: `cap://caps/${videoId}/transcript` },
		});
		const resource = await readMessage();
		expect(resource.id).toBe(6);
		expect(JSON.stringify(resource)).toContain("Replaced transcript");
		child.kill();
		await new Promise<void>((resolveExit) =>
			child.once("close", () => resolveExit()),
		);
	});

	it("verifies database state and that reads do not start work", async () => {
		const [videoRows] = await connection.execute<RowDataPacket[]>(
			"SELECT name, transcriptionStatus, metadata FROM videos WHERE id = ?",
			[videoId],
		);
		expect(videoRows[0]?.name).toBe("Updated through MCP");
		expect(videoRows[0]?.transcriptionStatus).toBe("COMPLETE");
		const metadata =
			typeof videoRows[0]?.metadata === "string"
				? JSON.parse(videoRows[0].metadata)
				: videoRows[0]?.metadata;
		expect(metadata.aiGenerationStatus).toBe("COMPLETE");
		const [comments] = await connection.execute<RowDataPacket[]>(
			"SELECT COUNT(*) AS count FROM comments WHERE videoId = ? AND content = ?",
			[videoId, "Agent E2E comment"],
		);
		expect(Number(comments[0]?.count)).toBe(1);
		const [idempotency] = await connection.execute<RowDataPacket[]>(
			"SELECT COUNT(*) AS count FROM agent_api_idempotency WHERE state = 'complete'",
		);
		expect(Number(idempotency[0]?.count)).toBeGreaterThan(10);
	});

	it("deletes only expired agent records in bounded cleanup batches", async () => {
		await connection.execute(
			`INSERT INTO agent_api_authorization_codes
				(id, userId, codeHash, codeChallenge, redirectUri, scopes, expiresAt)
			 VALUES
				('cod_e2e_expired', ?, ?, ?, 'http://127.0.0.1:45678/callback', ?, DATE_SUB(NOW(), INTERVAL 1 DAY)),
				('cod_e2e_live', ?, ?, ?, 'http://127.0.0.1:45678/callback', ?, DATE_ADD(NOW(), INTERVAL 1 DAY))`,
			[
				userId,
				"c".repeat(64),
				"d".repeat(43),
				JSON.stringify(["caps:read"]),
				userId,
				"e".repeat(64),
				"f".repeat(43),
				JSON.stringify(["caps:read"]),
			],
		);
		await connection.execute(
			`INSERT INTO agent_api_idempotency
				(id, userId, operation, keyHash, requestHash, state, expiresAt)
			 VALUES
				('ide_e2e_expired', ?, 'cleanup_test', ?, ?, 'complete', DATE_SUB(NOW(), INTERVAL 1 DAY)),
				('ide_e2e_live', ?, 'cleanup_test', ?, ?, 'complete', DATE_ADD(NOW(), INTERVAL 1 DAY))`,
			[
				userId,
				"1".repeat(64),
				"2".repeat(64),
				userId,
				"3".repeat(64),
				"4".repeat(64),
			],
		);
		await connection.execute(
			`INSERT INTO agent_api_operations
				(id, userId, kind, resourceId, state, payload, updatedAt, completedAt)
			 VALUES
				('op_e2e_old', ?, 'duplicate_cap', ?, 'succeeded', ?, DATE_SUB(NOW(), INTERVAL 31 DAY), DATE_SUB(NOW(), INTERVAL 31 DAY)),
				('op_e2e_run', ?, 'duplicate_cap', ?, 'running', ?, DATE_SUB(NOW(), INTERVAL 31 DAY), NULL)`,
			[
				userId,
				videoId,
				JSON.stringify({ videoId }),
				userId,
				videoId,
				JSON.stringify({ videoId }),
			],
		);
		await connection.execute(
			`INSERT INTO agent_api_keys
				(id, userId, tokenHash, name, scopes, expiresAt, revokedAt)
			 VALUES
				('key_e2e_old', ?, ?, 'Expired cleanup key', ?, DATE_SUB(NOW(), INTERVAL 31 DAY), NULL),
				('key_e2e_live2', ?, ?, 'Live cleanup key', ?, DATE_ADD(NOW(), INTERVAL 1 DAY), NULL),
				('key_e2e_rvold', ?, ?, 'Old revoked cleanup key', ?, DATE_ADD(NOW(), INTERVAL 1 DAY), DATE_SUB(NOW(), INTERVAL 31 DAY)),
				('key_e2e_rvnew', ?, ?, 'Recent revoked cleanup key', ?, DATE_ADD(NOW(), INTERVAL 1 DAY), NOW())`,
			[
				userId,
				"5".repeat(64),
				JSON.stringify(["caps:read"]),
				userId,
				"6".repeat(64),
				JSON.stringify(["caps:read"]),
				userId,
				"7".repeat(64),
				JSON.stringify(["caps:read"]),
				userId,
				"8".repeat(64),
				JSON.stringify(["caps:read"]),
			],
		);
		process.env.CRON_SECRET = "synthetic-agent-cleanup-secret";
		const { GET: cleanupAgentApi } = await import(
			"@/app/api/cron/cleanup-agent-api/route"
		);
		const unauthorized = await cleanupAgentApi(
			new Request("http://localhost/api/cron/cleanup-agent-api"),
		);
		expect(unauthorized.status).toBe(401);
		const cleanupResponse = await cleanupAgentApi(
			new Request("http://localhost/api/cron/cleanup-agent-api", {
				headers: {
					Authorization: "Bearer synthetic-agent-cleanup-secret",
				},
			}),
		);
		delete process.env.CRON_SECRET;
		expect(cleanupResponse.status).toBe(200);
		const cleanupBody = asObject(await cleanupResponse.json());
		const deleted = asObject(cleanupBody.deleted);
		expect(Number(deleted.authorizationCodes)).toBeGreaterThanOrEqual(1);
		expect(Number(deleted.idempotencyRecords)).toBeGreaterThanOrEqual(1);
		expect(Number(deleted.operations)).toBeGreaterThanOrEqual(1);
		expect(Number(deleted.accessTokens)).toBeGreaterThanOrEqual(2);
		const [remaining] = await connection.execute<RowDataPacket[]>(
			`SELECT
				(SELECT COUNT(*) FROM agent_api_authorization_codes WHERE id = 'cod_e2e_live') AS liveCodes,
				(SELECT COUNT(*) FROM agent_api_idempotency WHERE id = 'ide_e2e_live') AS liveIdempotency,
				(SELECT COUNT(*) FROM agent_api_operations WHERE id = 'op_e2e_ready') AS recentOperations,
				(SELECT COUNT(*) FROM agent_api_operations WHERE id = 'op_e2e_run') AS runningOperations,
				(SELECT COUNT(*) FROM agent_api_keys WHERE id = 'key_e2e_live2') AS liveKeys,
				(SELECT COUNT(*) FROM agent_api_keys WHERE id = 'key_e2e_rvnew') AS recentRevokedKeys,
				(SELECT COUNT(*) FROM agent_api_authorization_codes WHERE id = 'cod_e2e_expired') AS expiredCodes,
				(SELECT COUNT(*) FROM agent_api_idempotency WHERE id = 'ide_e2e_expired') AS expiredIdempotency,
				(SELECT COUNT(*) FROM agent_api_operations WHERE id = 'op_e2e_old') AS oldOperations,
				(SELECT COUNT(*) FROM agent_api_keys WHERE id = 'key_e2e_old') AS expiredKeys,
				(SELECT COUNT(*) FROM agent_api_keys WHERE id = 'key_e2e_rvold') AS oldRevokedKeys`,
		);
		expect(Number(remaining[0]?.liveCodes)).toBe(1);
		expect(Number(remaining[0]?.liveIdempotency)).toBe(1);
		expect(Number(remaining[0]?.recentOperations)).toBe(1);
		expect(Number(remaining[0]?.runningOperations)).toBe(1);
		expect(Number(remaining[0]?.liveKeys)).toBe(1);
		expect(Number(remaining[0]?.recentRevokedKeys)).toBe(1);
		expect(Number(remaining[0]?.expiredCodes)).toBe(0);
		expect(Number(remaining[0]?.expiredIdempotency)).toBe(0);
		expect(Number(remaining[0]?.oldOperations)).toBe(0);
		expect(Number(remaining[0]?.expiredKeys)).toBe(0);
		expect(Number(remaining[0]?.oldRevokedKeys)).toBe(0);
	});

	it("revokes every session only as the final destructive account action", async () => {
		const signedOut = expectSuccess(
			await api("POST", "/api/v1/me/sign-out-all"),
		);
		expect(signedOut.action).toBe("revoked");
		const revoked = await api("GET", "/api/v1/me");
		expect(revoked.status).toBe(401);
		expect(asObject(revoked.json).code).toBe("TOKEN_EXPIRED");
	});
});
