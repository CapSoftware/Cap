import { createHash, randomUUID } from "node:crypto";
import { STRIPE_AVAILABLE } from "@cap/utils";
import { User } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import mysql, { type RowDataPacket } from "mysql2/promise";
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
	claimJobs,
	completeUnchangedJob,
	completeUnchangedJobs,
	deferJob,
	type Job,
	releaseJobs,
	renewLease,
} from "./jobs";
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
import {
	type LoopsProfileSource,
	readLoopsProfile,
	readLoopsProfiles,
} from "./sources";
import { profileFingerprint } from "./sync-policy";

const claimBatchSize = 50;

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

function identityChanged(
	job: Job,
	source: LoopsProfileSource | null,
): job is Job & { syncedEmail: string } {
	return Boolean(
		job.syncedEmail &&
			(!source ||
				normalizeEmail(source.input.source.email) !== job.syncedEmail),
	);
}

function needsStripeCustomer(source: LoopsProfileSource) {
	return (
		source.signedUp &&
		!source.input.sso &&
		!source.stripeCustomerId &&
		STRIPE_AVAILABLE()
	);
}

function syncFingerprint(
	job: Job,
	source: LoopsProfileSource,
	config: LoopsRuntimeConfig,
	customerCopy: CustomerCopy,
) {
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
				enrollment: enrollmentWindow(localProfile.capSignupAt, jobConfig),
				listId: config.listId,
				teammateJoinedAt: job.teammateJoinedAt,
				...(inFreeExperiment(localProfile.capSignupAt, activationSignalsAfter)
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
	return { localProfile, jobConfig, hash };
}

function unchangedUntil(
	job: Job,
	source: LoopsProfileSource | null,
	config: LoopsRuntimeConfig,
	customerCopy: CustomerCopy,
	now: Date,
) {
	try {
		if (!source || identityChanged(job, source) || needsStripeCustomer(source))
			return null;
		const { localProfile, hash } = syncFingerprint(
			job,
			source,
			config,
			customerCopy,
		);
		return job.profileHash === hash
			? nextProfileCheck(localProfile, now)
			: null;
	} catch {
		// The per-job path hits the same error and defers only this job.
		return null;
	}
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
			const syncJob = async (job: Job, token: string) => {
				try {
					let source = await readLoopsProfile(cap, license, job.userId);
					if (identityChanged(job, source)) {
						await holdRemovedIdentity(api, job.syncedEmail, job.userId);
						throw new Error("identity_change_held");
					}
					if (!source) throw new Error("user_removed");
					if (needsStripeCustomer(source)) {
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
					const { localProfile, jobConfig, hash } = syncFingerprint(
						job,
						source,
						config,
						customerCopy,
					);
					if (job.profileHash === hash) {
						await completeUnchangedJob(
							cap,
							job,
							token,
							nextProfileCheck(localProfile, new Date()),
						);
						return "unchanged";
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
					return "synced";
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
					return error instanceof LoopsRequestError &&
						[401, 403, 429].includes(error.status)
						? "stop"
						: "failed";
				}
			};
			const deadline = Date.now() + 40_000;
			let stopped = false;
			while (!stopped && processed + failed < 500 && Date.now() < deadline) {
				const token = randomUUID();
				const jobs = await claimJobs(
					cap,
					token,
					allowedUserIds,
					Math.min(claimBatchSize, 500 - processed - failed),
				);
				if (!jobs.length) break;
				const leased = new Map(jobs.map((job) => [job.userId, job]));
				try {
					const sources = await readLoopsProfiles(
						cap,
						license,
						jobs.map((job) => job.userId),
					).catch((error) => {
						console.error("Loops batch profile read failed", { error });
						return null;
					});
					const now = new Date();
					const unchanged = sources
						? jobs.flatMap((job) => {
								const nextAttemptAt = unchangedUntil(
									job,
									sources.get(job.userId) ?? null,
									config,
									customerCopy,
									now,
								);
								return nextAttemptAt ? [{ job, nextAttemptAt }] : [];
							})
						: [];
					await completeUnchangedJobs(cap, token, unchanged);
					for (const { job } of unchanged) leased.delete(job.userId);
					processed += unchanged.length;
					for (const job of leased.values()) {
						if (Date.now() >= deadline) break;
						leased.delete(job.userId);
						if (!(await renewLease(cap, job, token))) continue;
						const outcome = await syncJob(job, token);
						if (outcome === "unchanged" || outcome === "synced") processed++;
						else failed++;
						if (outcome === "stop") {
							stopped = true;
							break;
						}
						if (outcome !== "unchanged")
							await new Promise((resolve) => setTimeout(resolve, 750));
					}
				} finally {
					if (leased.size)
						await releaseJobs(cap, token, [...leased.keys()]).catch((error) =>
							console.error("Loops lease release failed", { error }),
						);
				}
			}
			return { enabled: true, processed, failed };
		} finally {
			await license.end();
		}
	} finally {
		await cap.end();
	}
}
