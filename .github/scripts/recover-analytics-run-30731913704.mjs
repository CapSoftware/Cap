import { createHash, createHmac } from "node:crypto";
import fs from "node:fs";
import process from "node:process";

import {
	STAGING_WORKSPACE_ID,
	validateTinybirdCredentials,
} from "../../scripts/analytics/staging-ci-lib.js";

const SOURCE_RUN_ID = "30731913704";
const SOURCE_SHA = "73c90e8bf64a7793f803bd4488f0bb626b89948e";
const CANDIDATE_DEPLOYMENT_ID = "27";
const PREVIOUS_DEPLOYMENT_ID = "18";
const EXACT_PREVIEW_URL = "https://cap-5qhrfm9uz-mc-ilroy.vercel.app";
const BRANCH_PREVIEW_URL =
	"https://cap-web-git-codex-first-party-analytics-mc-ilroy.vercel.app";

const requiredEnvironment = (name) => {
	const value = process.env[name]?.trim();
	if (!value) throw new Error(`${name} is required`);
	return value;
};

const option = (name) => {
	const index = process.argv.indexOf(`--${name}`);
	const value = index >= 0 ? process.argv[index + 1] : undefined;
	if (!value) throw new Error(`--${name} is required`);
	return value;
};

const readJson = (path) => JSON.parse(fs.readFileSync(path, "utf8"));

const writeJson = (path, value, mode = 0o644) => {
	fs.writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, {
		encoding: "utf8",
		mode,
	});
};

const assertRunId = (value) => {
	if (typeof value !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(value)) {
		throw new Error("The recovery checkpoint contains an invalid run ID");
	}
	return value;
};

const requestJson = async (url, token, init = {}) => {
	const response = await fetch(url, {
		...init,
		headers: {
			Accept: "application/json",
			Authorization: `Bearer ${token}`,
			...init.headers,
		},
		signal: init.signal ?? AbortSignal.timeout(60_000),
	});
	if (!response.ok) {
		throw new Error(
			`Scoped recovery request failed with HTTP ${response.status}`,
		);
	}
	return response.json();
};

const sqlQuery = async ({ origin, query, token }) => {
	const url = new URL("/v0/sql", origin);
	url.searchParams.set("q", `${query} FORMAT JSON`);
	const payload = await requestJson(url, token);
	if (!Array.isArray(payload.data)) {
		throw new Error("Scoped recovery query returned an invalid response");
	}
	return payload.data;
};

const previewCookies = (headers) => {
	const values =
		typeof headers.getSetCookie === "function"
			? headers.getSetCookie()
			: [headers.get("set-cookie")].filter(Boolean);
	return values
		.map((value) => value.split(";", 1)[0])
		.filter(Boolean)
		.join("; ");
};

const cleanupPreviewDatabase = async ({
	anonymousIdentityHashes,
	artifact,
	recoverySha,
	state,
}) => {
	const shareSecret = requiredEnvironment("VERCEL_PREVIEW_SHARE_SECRET");
	const stagingSecret = requiredEnvironment(
		"CAP_ANALYTICS_STAGING_TEST_SECRET",
	);
	const shareUrl = new URL(
		"/api/analytics/staging-test/attest",
		artifact.vercel.accessUrl,
	);
	shareUrl.searchParams.set("_vercel_share", shareSecret);
	const handshake = await fetch(shareUrl, {
		headers: { Accept: "text/html" },
		method: "GET",
		redirect: "manual",
		signal: AbortSignal.timeout(20_000),
	});
	if (![302, 303, 307, 308].includes(handshake.status)) {
		throw new Error(
			`The staging share bootstrap failed with HTTP ${handshake.status}`,
		);
	}
	const cookie = previewCookies(handshake.headers)
		.split("; ")
		.find((value) => value.startsWith("_vercel_jwt="));
	if (!cookie) {
		throw new Error("The staging alias did not issue a Vercel share cookie");
	}
	const request = async ({ path, payload }) => {
		const body = JSON.stringify(payload);
		const signature = createHmac("sha256", stagingSecret)
			.update(`${payload.runId}:${payload.sha}`)
			.digest("hex");
		return fetch(new URL(path, artifact.vercel.accessUrl), {
			body,
			headers: {
				Authorization: `Bearer ${stagingSecret}`,
				"Content-Type": "application/json",
				Cookie: cookie,
				"x-cap-analytics-staging-signature": signature,
			},
			method: "POST",
			signal: AbortSignal.timeout(60_000),
		});
	};
	const recoveryRunId = assertRunId(`${state.runId}_recovery`);
	const attest = async () => {
		const response = await request({
			path: "/api/analytics/staging-test/attest",
			payload: { runId: recoveryRunId, sha: recoverySha },
		});
		if (!response.ok) {
			throw new Error(
				`The recovery alias attestation failed with HTTP ${response.status}`,
			);
		}
		const result = await response.json();
		if (result.sha !== recoverySha) {
			throw new Error(
				"The recovery alias is not bound to the exact recovery SHA",
			);
		}
	};
	await attest();
	const serverRunId = assertRunId(`${state.runId}_server`);
	const response = await request({
		path: "/api/analytics/staging-test/cleanup-database",
		payload: {
			anonymousIdentityHashes,
			runId: state.runId,
			scopeRunIds: [state.runId, serverRunId],
			sha: recoverySha,
		},
	});
	if (!response.ok) {
		throw new Error(
			`The exact-SHA database cleanup failed with HTTP ${response.status}`,
		);
	}
	const result = await response.json();
	if (
		result.cleaned !== true ||
		Number(result.remaining) !== 0 ||
		Number(result.runIds) !== 2 ||
		Number(result.identityHashes) < anonymousIdentityHashes.length
	) {
		throw new Error("The exact-SHA database cleanup was incomplete");
	}
	await attest();
	return {
		cleaned: true,
		identityHashes: Number(result.identityHashes),
		remaining: 0,
		runIds: 2,
	};
};

const statePath = option("state");
const artifactPath = option("artifact");
const recoverySha = requiredEnvironment("RECOVERY_SHA");
if (!/^[0-9a-f]{40}$/.test(recoverySha)) {
	throw new Error("RECOVERY_SHA must be an exact Git commit SHA");
}
const state = readJson(statePath);
const artifact = readJson(artifactPath);
if (
	state.recoveryIdentity?.repository !== "CapSoftware/Cap" ||
	state.recoveryIdentity?.runId !== SOURCE_RUN_ID ||
	state.recoveryIdentity?.expectedSha !== SOURCE_SHA ||
	state.recoveryIdentity?.workspaceId !== STAGING_WORKSPACE_ID ||
	String(state.deploymentId) !== CANDIDATE_DEPLOYMENT_ID ||
	String(state.previousLiveDeploymentId ?? state.liveBeforeDeploymentId) !==
		PREVIOUS_DEPLOYMENT_ID ||
	artifact.sha !== SOURCE_SHA ||
	artifact.githubRun?.id !== SOURCE_RUN_ID ||
	String(artifact.tinybird?.deploymentId) !== CANDIDATE_DEPLOYMENT_ID ||
	artifact.vercel?.url !== EXACT_PREVIEW_URL ||
	artifact.vercel?.accessUrl !== BRANCH_PREVIEW_URL
) {
	throw new Error(
		"The immutable recovery checkpoint is not the owned failed run",
	);
}

const origin = new URL(requiredEnvironment("TINYBIRD_STAGING_URL")).origin;
const cleanupToken = requiredEnvironment("TINYBIRD_STAGING_CLEANUP_TOKEN");
const lookupToken = requiredEnvironment(
	"TINYBIRD_STAGING_ERASURE_LOOKUP_TOKEN",
);
validateTinybirdCredentials({
	url: `${origin}/`,
	tokens: {
		TINYBIRD_STAGING_CLEANUP_TOKEN: cleanupToken,
		TINYBIRD_STAGING_ERASURE_LOOKUP_TOKEN: lookupToken,
	},
});

const runIds = [
	state.runId,
	state.cutoffRunId,
	state.loadRunId,
	state.largeLoadRunId,
	state.decisionRunId,
	state.erasureControlRunId,
	state.previewRunId,
	`${state.runId}_server`,
].map(assertRunId);
const quotedRunIds = runIds.map((runId) => `'${runId}'`).join(", ");
const previewRows = await sqlQuery({
	origin,
	query: `SELECT anonymous_id, count() AS rows FROM product_events_v1 WHERE synthetic_run_id = '${assertRunId(state.previewRunId)}' AND anonymous_id != '' GROUP BY anonymous_id`,
	token: lookupToken,
});
const previewAnonymousIds = [
	...new Set(
		previewRows
			.map((row) => row.anonymous_id)
			.filter((value) => typeof value === "string" && value.length > 0),
	),
];
if (previewAnonymousIds.length === 0 || previewAnonymousIds.length > 16) {
	throw new Error("The scoped preview identity recovery was incomplete");
}
const anonymousIdentityHashes = previewAnonymousIds.map((anonymousId) =>
	createHash("sha256").update(`anonymous\0${anonymousId}`).digest("hex"),
);
const databaseCleanup = await cleanupPreviewDatabase({
	anonymousIdentityHashes,
	artifact,
	recoverySha,
	state,
});

const rawBefore = await sqlQuery({
	origin,
	query: `SELECT count() AS rows, uniqExact(event_id) AS unique_events FROM product_events_v1 WHERE synthetic_run_id IN (${quotedRunIds})`,
	token: lookupToken,
});
const deleteUrl = new URL("/v1/datasources/product_events_v1/delete", origin);
deleteUrl.searchParams.set("wait", "true");
deleteUrl.searchParams.set("wait_max_seconds", "60");
const deletion = await requestJson(deleteUrl, cleanupToken, {
	body: new URLSearchParams({
		delete_condition: `synthetic_run_id IN (${quotedRunIds})`,
	}),
	headers: { "Content-Type": "application/x-www-form-urlencoded" },
	method: "POST",
});
if (deletion.mutation?.is_done !== true) {
	throw new Error("The scoped Tinybird delete mutation did not finish");
}

let remainingRows = Number.POSITIVE_INFINITY;
for (let attempt = 0; attempt < 30; attempt += 1) {
	const remaining = await sqlQuery({
		origin,
		query: `SELECT count() AS rows FROM product_events_v1 WHERE synthetic_run_id IN (${quotedRunIds})`,
		token: lookupToken,
	});
	remainingRows = Number(remaining[0]?.rows ?? Number.NaN);
	if (remainingRows === 0) break;
	await new Promise((resolve) => setTimeout(resolve, 2_000));
}
if (remainingRows !== 0) {
	throw new Error("Scoped Tinybird raw rows remained after deletion");
}

artifact.cleanup = {
	...artifact.cleanup,
	database: databaseCleanup,
	deleteMutationCompleted: true,
	emergencyRecovery: {
		candidateDeploymentId: CANDIDATE_DEPLOYMENT_ID,
		previousDeploymentId: PREVIOUS_DEPLOYMENT_ID,
		previewIdentityCount: anonymousIdentityHashes.length,
		rawRowsBefore: Number(rawBefore[0]?.rows ?? 0),
		rawUniqueEventsBefore: Number(rawBefore[0]?.unique_events ?? 0),
		rawRowsRemaining: 0,
		recoverySha,
		sourceRunId: SOURCE_RUN_ID,
		verifiedAt: new Date().toISOString(),
	},
	rowsAffected: Number(
		deletion.mutation.rows_affected ?? deletion.rows_affected ?? 0,
	),
};
artifact.assertions = {
	...artifact.assertions,
	syntheticDatabaseCleanupPassed: true,
};
writeJson(artifactPath, artifact);
writeJson(statePath, state, 0o600);
process.stdout.write(
	`${JSON.stringify({
		candidateDeploymentId: CANDIDATE_DEPLOYMENT_ID,
		databaseRemaining: 0,
		previewIdentityCount: anonymousIdentityHashes.length,
		rawRowsRemaining: 0,
		sourceRunId: SOURCE_RUN_ID,
	})}\n`,
);
