import { createHash, randomUUID } from "node:crypto";
import { STRIPE_AVAILABLE } from "@cap/utils";
import { User } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";
import { provisionStripeCustomer } from "../auth/stripe-customer";
import { db } from "../index";
import { users } from "../schema";
import {
	createLoopsClient,
	type LoopsClient,
	LoopsRequestError,
} from "./client";
import { activationSignalsAfter, inFreeExperiment } from "./experiment";
import {
	activationFollowUps,
	enrollmentWindow,
	type LifecycleContact,
	type LoopsRuntimeConfig,
	lifecycleUpdate,
	nextProfileCheck,
	retryDelay,
} from "./lifecycle";
import { type CustomerCopy, classifyProfile, normalizeEmail } from "./profile";
import { type LoopsProfileSource, readLoopsProfile } from "./sources";
import { profileFingerprint } from "./sync-policy";

type Job = RowDataPacket & {
	userId: string;
	revision: number;
	failures: number;
	syncedEmail: string | null;
	lastSyncedAt: string | null;
	profileHash: string | null;
	teammateJoinedAt: string | null;
};

export async function syncLoopsContact(
	api: LoopsClient,
	source: LoopsProfileSource,
	previous: { syncedEmail: string | null; lastSyncedAt: string | null },
	config: LoopsRuntimeConfig,
	customerCopy: CustomerCopy,
) {
	const email = normalizeEmail(source.input.source.email);
	if (config.allowedEmails && !config.allowedEmails.has(email))
		throw new Error("outside_test_allowlist");
	if (!source.signedUp) throw new Error("signup_not_complete");
	if (!source.input.sso && !source.stripeCustomerId)
		throw new Error("stripe_signup_not_complete");
	if (previous.syncedEmail && previous.syncedEmail !== email)
		throw new Error("email_changed_requires_reconciliation");
	const contacts = await api.request<LifecycleContact[]>(
		`contacts/find?email=${encodeURIComponent(email)}`,
	);
	if (contacts.length > 1) throw new Error("ambiguous_contact");
	let remote = contacts[0];
	if (!remote) {
		if (previous.lastSyncedAt) throw new Error("remote_contact_removed");
		if (!source.input.sso) throw new Error("awaiting_stripe_contact");
		await api.request("contacts/create", "POST", {
			email,
			mailingLists: { [config.listId]: true },
			userId: source.input.user?.id,
			source: "Cap SSO signup",
			capTeammate: true,
			capAudience: "teammate",
			capPromotionalEligible: false,
			capOnboardingEligible: false,
			capLifecycleEnabled: false,
			capLifecycleStage: "idle",
		});
		const created = await api.request<LifecycleContact[]>(
			`contacts/find?email=${encodeURIComponent(email)}`,
		);
		if (created.length !== 1) throw new Error("created_contact_not_found");
		remote = created[0];
	}
	const update = lifecycleUpdate(source, remote, config, customerCopy);
	await api.request("contacts/update", "PUT", update);
	return update;
}

async function holdRemovedIdentity(
	api: LoopsClient,
	email: string,
	userId: string,
) {
	const contacts = await api.request<LifecycleContact[]>(
		`contacts/find?email=${encodeURIComponent(email)}`,
	);
	if (contacts.length > 1) throw new Error("ambiguous_contact");
	const contact = contacts[0];
	if (!contact) return;
	if (contact.userId && contact.userId !== userId)
		throw new Error("identity_conflict");
	await api.request("contacts/update", "PUT", {
		email,
		subscribed: false,
		capPromotionalEligible: false,
		capLifecycleEnabled: false,
		capOnboardingEligible: false,
		capLifecycleStage: "idle",
	});
}

export async function claimJob(
	database: Connection,
	token: string,
	allowedUserIds: string[] | null,
) {
	await database.beginTransaction();
	try {
		const [jobs] = await database.query<Job[]>(
			`SELECT * FROM loops_sync_jobs WHERE nextAttemptAt<=UTC_TIMESTAMP() AND (leaseUntil IS NULL OR leaseUntil<UTC_TIMESTAMP()) ${allowedUserIds ? "AND userId IN (?)" : ""} ORDER BY nextAttemptAt LIMIT 1 FOR UPDATE SKIP LOCKED`,
			allowedUserIds ? [allowedUserIds] : [],
		);
		const job = jobs[0];
		if (job)
			await database.execute(
				"UPDATE loops_sync_jobs SET leaseToken=?,leaseUntil=DATE_ADD(UTC_TIMESTAMP(),INTERVAL 2 MINUTE) WHERE userId=?",
				[token, job.userId],
			);
		await database.commit();
		return job;
	} catch (error) {
		await database.rollback();
		throw error;
	}
}

export async function deferJob(
	database: Connection,
	job: Pick<Job, "userId" | "revision">,
	token: string,
	reason: string,
	nextAttemptAt: Date,
) {
	await database.execute(
		"UPDATE loops_sync_jobs SET failures=CASE WHEN revision=? THEN failures+1 ELSE 0 END,lastError=CASE WHEN revision=? THEN ? ELSE NULL END,nextAttemptAt=CASE WHEN revision=? THEN ? ELSE UTC_TIMESTAMP() END,leaseToken=NULL,leaseUntil=NULL WHERE userId=? AND leaseToken=?",
		[
			job.revision,
			job.revision,
			reason,
			job.revision,
			nextAttemptAt,
			job.userId,
			token,
		],
	);
}

export async function completeUnchangedJob(
	database: Connection,
	job: Pick<Job, "userId" | "revision">,
	token: string,
	nextAttemptAt: Date,
) {
	await database.execute(
		"UPDATE loops_sync_jobs SET failures=0,lastError=NULL,nextAttemptAt=CASE WHEN revision=? THEN ? ELSE UTC_TIMESTAMP() END,leaseToken=NULL,leaseUntil=NULL WHERE userId=? AND leaseToken=?",
		[job.revision, nextAttemptAt, job.userId, token],
	);
}

export function loopsRuntimeConfig(env: NodeJS.ProcessEnv): LoopsRuntimeConfig {
	const listId = env.LOOPS_MAILING_LIST_ID;
	const enrollmentAfter = new Date(env.LOOPS_ENROLLMENT_AFTER ?? "");
	if (!listId || !Number.isFinite(enrollmentAfter.getTime()))
		throw new Error("Loops list and cutover date are required");
	const production = env.LOOPS_SYNC_MODE === "production";
	const allowedEmails = production
		? null
		: new Set(
				(env.LOOPS_TEST_EMAILS ?? "")
					.split(",")
					.map(normalizeEmail)
					.filter(Boolean),
			);
	if (allowedEmails && !allowedEmails.size)
		throw new Error("Test mode requires LOOPS_TEST_EMAILS");
	const freeExperimentAfter = env.LOOPS_FREE_EXPERIMENT_AFTER
		? new Date(env.LOOPS_FREE_EXPERIMENT_AFTER)
		: undefined;
	if (freeExperimentAfter && !Number.isFinite(freeExperimentAfter.getTime()))
		throw new Error("Invalid free onboarding experiment date");
	if (freeExperimentAfter && freeExperimentAfter < activationSignalsAfter)
		throw new Error("Experiment date predates activation signal rollout");
	if (env.LOOPS_FREE_EXPERIMENT_ENABLED === "true" && !freeExperimentAfter)
		throw new Error("Enabled free experiment requires a start date");
	return {
		listId,
		enrollmentAfter,
		allowedEmails,
		enrollmentEnabled: env.LOOPS_ENROLLMENT_ENABLED === "true",
		freeExperimentAfter,
		freeExperimentEnrollmentEnabled:
			env.LOOPS_FREE_EXPERIMENT_ENABLED === "true",
	};
}

export async function runLoopsSync(customerCopy: CustomerCopy) {
	if (process.env.LOOPS_SYNC_ENABLED !== "true")
		return { enabled: false, processed: 0, failed: 0 };
	const config = loopsRuntimeConfig(process.env);
	const capUrl = process.env.DATABASE_URL;
	const licenseUrl = process.env.LOOPS_LICENSE_DATABASE_URL;
	if (!capUrl || !licenseUrl)
		throw new Error("Loops source databases are required");
	const api = createLoopsClient(process.env.LOOPS_API_KEY ?? "");
	const identity = await api.request<{ success: boolean; teamName: string }>(
		"api-key",
	);
	if (!identity.success || identity.teamName !== "Cap Software, Inc.")
		throw new Error("Wrong Loops team");
	const cap = await mysql.createConnection({
		uri: capUrl,
		dateStrings: true,
		timezone: "Z",
	});
	let processed = 0;
	let failed = 0;
	try {
		const license = await mysql.createConnection({
			uri: licenseUrl,
			dateStrings: true,
			timezone: "Z",
		});
		try {
			let allowedUserIds: string[] | null = null;
			if (config.allowedEmails) {
				const [owned] = await cap.query<(RowDataPacket & { id: string })[]>(
					"SELECT id FROM users WHERE email IN (?)",
					[[...config.allowedEmails]],
				);
				allowedUserIds = owned.map((user) => user.id);
				if (!allowedUserIds.length) return { enabled: true, processed, failed };
			}
			const deadline = Date.now() + 40_000;
			while (processed + failed < 500 && Date.now() < deadline) {
				const token = randomUUID();
				const job = await claimJob(cap, token, allowedUserIds);
				if (!job) break;
				try {
					let source = await readLoopsProfile(cap, license, job.userId);
					if (
						job.syncedEmail &&
						(!source ||
							normalizeEmail(source.input.source.email) !== job.syncedEmail)
					) {
						await holdRemovedIdentity(api, job.syncedEmail, job.userId);
						throw new Error("identity_change_held");
					}
					if (!source) throw new Error("user_removed");
					if (
						source.signedUp &&
						!source.input.sso &&
						!source.stripeCustomerId &&
						STRIPE_AVAILABLE()
					) {
						const [user] = await db()
							.select()
							.from(users)
							.where(eq(users.id, User.UserId.make(job.userId)))
							.limit(1);
						if (!user) throw new Error("user_removed");
						await provisionStripeCustomer(db(), user);
						source = await readLoopsProfile(cap, license, job.userId);
						if (!source) throw new Error("user_removed");
					}
					const localProfile = classifyProfile(source.input, customerCopy);
					const jobConfig = {
						...config,
						teammateJoinedAt: job.teammateJoinedAt,
					};
					const hash = createHash("sha256")
						.update(
							JSON.stringify({
								profile: profileFingerprint(localProfile),
								signedUp: source.signedUp,
								pendingInvite: source.pendingInvite,
								enrollment: enrollmentWindow(
									localProfile.capSignupAt,
									jobConfig,
								),
								listId: config.listId,
								teammateJoinedAt: job.teammateJoinedAt,
								...(inFreeExperiment(
									localProfile.capSignupAt,
									activationSignalsAfter,
								)
									? {
											freeExperiment: activationFollowUps(source.input),
											freeExperimentEnrollmentEnabled:
												config.freeExperimentEnrollmentEnabled &&
												inFreeExperiment(
													localProfile.capSignupAt,
													config.freeExperimentAfter,
												),
										}
									: {}),
							}),
						)
						.digest("hex");
					if (job.profileHash === hash) {
						await completeUnchangedJob(
							cap,
							job,
							token,
							nextProfileCheck(localProfile, new Date()),
						);
						processed++;
						continue;
					}
					const update = await syncLoopsContact(
						api,
						source,
						job,
						jobConfig,
						customerCopy,
					);
					if (update.capTeammate)
						await cap.execute(
							"UPDATE users SET marketingOrigin='teammate' WHERE id=? AND marketingOrigin<>'teammate'",
							[job.userId],
						);
					const next = nextProfileCheck(update, new Date());
					await cap.execute(
						"UPDATE loops_sync_jobs SET syncedEmail=?,profileHash=?,lastSyncedAt=UTC_TIMESTAMP(),failures=0,lastError=NULL,nextAttemptAt=CASE WHEN revision=? THEN ? ELSE UTC_TIMESTAMP() END,leaseToken=NULL,leaseUntil=NULL WHERE userId=? AND leaseToken=?",
						[update.email, hash, job.revision, next, job.userId, token],
					);
					processed++;
				} catch (error) {
					const reason =
						error instanceof LoopsRequestError
							? `loops_http_${error.status}`
							: error instanceof Error && /^[a-z_]+$/.test(error.message)
								? error.message
								: "sync_failed";
					await deferJob(
						cap,
						job,
						token,
						reason,
						new Date(Date.now() + retryDelay(job.failures)),
					);
					console.error("Loops sync deferred", { userId: job.userId, reason });
					failed++;
					if (
						error instanceof LoopsRequestError &&
						[401, 403, 429].includes(error.status)
					)
						break;
				}
				await new Promise((resolve) => setTimeout(resolve, 750));
			}
			return { enabled: true, processed, failed };
		} finally {
			await license.end();
		}
	} finally {
		await cap.end();
	}
}
