import { serverEnv } from "@cap/env";
import { FatalError } from "workflow";
import {
	acquireProductAnalyticsRefreshLease,
	releaseProductAnalyticsRefreshLease,
	renewProductAnalyticsRefreshLease,
} from "@/lib/analytics/product-analytics-refresh-state";

const REFRESH_COPIES = [
	["snapshot_product_events_daily_exact", "decision_markers"],
	["snapshot_product_traffic_daily_exact", "traffic_markers"],
	["snapshot_product_traffic_pages_daily_exact", "traffic_page_markers"],
	["snapshot_product_activation_daily_exact", "activation_markers"],
	["snapshot_product_creator_retention_exact", "retention_markers"],
	["snapshot_product_identity_funnel_exact", "identity_markers"],
	["snapshot_product_attribution_daily_exact", "attribution_markers"],
	["snapshot_product_experiment_outcomes_exact", "experiment_markers"],
] as const;

type TinybirdJobResponse = {
	id?: unknown;
	job_id?: unknown;
	status?: unknown;
	state?: unknown;
	job?: { id?: unknown; status?: unknown; state?: unknown };
};

const request = async <T>(url: URL, token: string, init?: RequestInit) => {
	const response = await fetch(url, {
		...init,
		headers: {
			Accept: "application/json",
			Authorization: `Bearer ${token}`,
			...(init?.headers ?? {}),
		},
		signal: AbortSignal.timeout(20_000),
	});
	if (!response.ok) {
		throw new Error(
			`Tinybird refresh request failed with HTTP ${response.status}`,
		);
	}
	const body = await response.text();
	return body ? (JSON.parse(body) as T) : ({} as T);
};

const jobId = (response: TinybirdJobResponse) => {
	const value = response.job_id ?? response.job?.id ?? response.id;
	return typeof value === "string" && /^[A-Za-z0-9_-]{8,128}$/.test(value)
		? value
		: undefined;
};

const jobStatus = (response: TinybirdJobResponse) =>
	String(
		response.status ??
			response.state ??
			response.job?.status ??
			response.job?.state ??
			"",
	).toLowerCase();

const formatTinybirdDateTime64 = (value: string) => {
	const parsed = new Date(value);
	if (!Number.isFinite(parsed.getTime())) {
		throw new FatalError("Product analytics refresh cutoff is invalid");
	}
	return parsed.toISOString().replace("T", " ").replace(/Z$/, "");
};

export async function acquireProductAnalyticsRefreshStep(sourceCutoff: string) {
	"use step";
	const parsed = new Date(sourceCutoff);
	if (!Number.isFinite(parsed.getTime())) {
		throw new FatalError("Product analytics refresh cutoff is invalid");
	}
	return acquireProductAnalyticsRefreshLease(parsed);
}

export async function runProductAnalyticsCopyStep(
	ownerId: string,
	sourceCutoff: string,
	copyRunId: string,
	pipe: (typeof REFRESH_COPIES)[number][0],
	marker: (typeof REFRESH_COPIES)[number][1],
) {
	"use step";
	if (!(await renewProductAnalyticsRefreshLease(ownerId))) {
		throw new FatalError("Product analytics refresh lease was lost");
	}
	const env = serverEnv();
	const host = env.PRODUCT_ANALYTICS_TINYBIRD_HOST;
	const copyToken = env.PRODUCT_ANALYTICS_TINYBIRD_COPY_TOKEN;
	const readToken = env.PRODUCT_ANALYTICS_TINYBIRD_READ_TOKEN;
	const schedulerToken = env.PRODUCT_ANALYTICS_TINYBIRD_SCHEDULER_TOKEN;
	if (!host || !copyToken || !readToken || !schedulerToken) {
		throw new FatalError("Product analytics refresh is not configured");
	}
	const origin = new URL(host);
	if (origin.protocol !== "https:") {
		throw new FatalError("Product analytics refresh host must use HTTPS");
	}
	const copyUrl = new URL(`/v0/pipes/${encodeURIComponent(pipe)}/copy`, origin);
	copyUrl.searchParams.set("_mode", "replace");
	copyUrl.searchParams.set("copy_max_threads", "2");
	copyUrl.searchParams.set("copy_run_id", copyRunId);
	copyUrl.searchParams.set(
		"source_cutoff",
		formatTinybirdDateTime64(sourceCutoff),
	);
	const created = await request<TinybirdJobResponse>(copyUrl, copyToken, {
		method: "POST",
	});
	const id = jobId(created);
	if (!id) throw new Error("Tinybird refresh did not return a job ID");
	const deadline = Date.now() + 15 * 60 * 1_000;
	let lastLeaseRenewal = Date.now();
	while (Date.now() < deadline) {
		const job = await request<TinybirdJobResponse>(
			new URL(`/v0/jobs/${encodeURIComponent(id)}`, origin),
			schedulerToken,
		);
		const status = jobStatus(job);
		if (["done", "success", "finished", "completed"].includes(status)) break;
		if (["failed", "error", "cancelled", "canceled"].includes(status)) {
			throw new Error(`Tinybird refresh job ended in ${status}`);
		}
		if (Date.now() - lastLeaseRenewal >= 60_000) {
			if (!(await renewProductAnalyticsRefreshLease(ownerId))) {
				throw new FatalError("Product analytics refresh lease was lost");
			}
			lastLeaseRenewal = Date.now();
		}
		await new Promise((resolve) => setTimeout(resolve, 2_000));
	}
	if (Date.now() >= deadline) {
		throw new Error("Tinybird refresh job exceeded its time budget");
	}
	const markerUrl = new URL(
		"/v0/pipes/product_analytics_copy_assertions.json",
		origin,
	);
	markerUrl.searchParams.set("copy_run_id", copyRunId);
	const markerResponse = await request<{
		data?: Array<Record<string, unknown>>;
	}>(markerUrl, readToken);
	if (Number(markerResponse.data?.[0]?.[marker] ?? 0) !== 1) {
		throw new Error(`Tinybird refresh marker was missing for ${pipe}`);
	}
	return { jobId: id, marker, pipe };
}

export async function releaseProductAnalyticsRefreshStep(
	ownerId: string,
	errorCode?: string,
) {
	"use step";
	await releaseProductAnalyticsRefreshLease(ownerId, errorCode);
}

export async function refreshProductAnalyticsWorkflow(input: {
	scheduledAt: string;
}) {
	"use workflow";
	const sourceCutoff = new Date(input.scheduledAt).toISOString();
	const lease = await acquireProductAnalyticsRefreshStep(sourceCutoff);
	if (!lease) return { refreshed: false as const, reason: "lease_unavailable" };
	const copyRunId = `refresh_${sourceCutoff.replace(/\D/g, "")}`;
	try {
		const jobs = [];
		for (const [pipe, marker] of REFRESH_COPIES) {
			jobs.push(
				await runProductAnalyticsCopyStep(
					lease.ownerId,
					lease.sourceCutoff,
					copyRunId,
					pipe,
					marker,
				),
			);
		}
		await releaseProductAnalyticsRefreshStep(lease.ownerId);
		return { copyRunId, jobs, refreshed: true as const, sourceCutoff };
	} catch (error) {
		await releaseProductAnalyticsRefreshStep(lease.ownerId, "refresh_failed");
		throw error;
	}
}
