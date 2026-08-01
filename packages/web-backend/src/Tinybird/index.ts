import { serverEnv } from "@cap/env";
import { Effect } from "effect";

import {
	type ProductAnalyticsErasureLease,
	ProductAnalyticsErasureLeaseRepo,
} from "./ProductAnalyticsErasureLeaseRepo.ts";

const DEFAULT_DATASOURCE = "analytics_events";
const PRODUCT_ANALYTICS_REBUILD_PIPES = [
	"snapshot_product_events_canonical_v1",
	"snapshot_product_events_daily_exact",
	"snapshot_product_traffic_daily_exact",
	"snapshot_product_traffic_pages_daily_exact",
	"snapshot_product_activation_daily_exact",
	"snapshot_product_creator_retention_exact",
	"snapshot_product_identity_funnel_exact",
	"snapshot_product_events_health_hourly",
] as const;

const escapeTinybirdString = (value: string) =>
	value.replace(/\\/g, "\\\\").replace(/'/g, "''");

interface TinybirdResponse<T> {
	data: T[];
	error?: string;
}

interface TinybirdJobResponse {
	id?: unknown;
	job_id?: unknown;
	status?: unknown;
	state?: unknown;
	job?: {
		id?: unknown;
		status?: unknown;
		state?: unknown;
	};
}

interface TinybirdPipeResponse {
	schedule?: { status?: string };
}

const tinybirdJobId = (response: TinybirdJobResponse) => {
	const id = response.job_id ?? response.job?.id ?? response.id;
	return typeof id === "string" && id ? id : undefined;
};

const PRODUCT_ANALYTICS_COPY_MARKERS = {
	snapshot_product_events_daily_exact: "decision_markers",
	snapshot_product_traffic_daily_exact: "traffic_markers",
	snapshot_product_traffic_pages_daily_exact: "traffic_page_markers",
	snapshot_product_activation_daily_exact: "activation_markers",
	snapshot_product_creator_retention_exact: "retention_markers",
	snapshot_product_identity_funnel_exact: "identity_markers",
	snapshot_product_events_health_hourly: "health_markers",
} as const;

export interface TinybirdEventRow {
	timestamp: string;
	session_id?: string | null;
	user_id?: string | null;
	tenant_id?: string | null;
	action: string;
	version?: string;
	pathname?: string | null;
	video_id?: string | null;
	country?: string | null;
	region?: string | null;
	city?: string | null;
	browser?: string | null;
	device?: string | null;
	os?: string | null;
}

export class Tinybird extends Effect.Service<Tinybird>()("Tinybird", {
	effect: Effect.gen(function* () {
		const erasureLeases = yield* ProductAnalyticsErasureLeaseRepo;
		const env = serverEnv();
		const token = env.TINYBIRD_TOKEN;
		const host = env.TINYBIRD_HOST;
		const productAnalyticsHost = env.PRODUCT_ANALYTICS_TINYBIRD_HOST;
		const productAnalyticsErasureToken =
			env.PRODUCT_ANALYTICS_TINYBIRD_ERASURE_TOKEN;
		const productAnalyticsErasureLookupToken =
			env.PRODUCT_ANALYTICS_TINYBIRD_ERASURE_LOOKUP_TOKEN;
		const productAnalyticsCopyToken = env.PRODUCT_ANALYTICS_TINYBIRD_COPY_TOKEN;
		const productAnalyticsReadToken = env.PRODUCT_ANALYTICS_TINYBIRD_READ_TOKEN;
		const productAnalyticsSchedulerToken =
			env.PRODUCT_ANALYTICS_TINYBIRD_SCHEDULER_TOKEN;

		const enabled = Boolean(token && host);

		yield* Effect.logDebug("Initializing Tinybird service", {
			hasToken: Boolean(token),
			hasHost: Boolean(host),
			enabled,
		});

		if (!enabled) {
			yield* Effect.logWarning(
				"Tinybird is disabled: TINYBIRD_TOKEN and/or TINYBIRD_HOST not set",
			);
		}

		const request = <T>(path: string, init?: RequestInit) => {
			if (!enabled) return Effect.succeed<TinybirdResponse<T>>({ data: [] });

			return Effect.tryPromise({
				try: async () => {
					const url = `${host}${path.startsWith("/v1/") ? "" : "/v0"}${path}`;
					const response = await fetch(url, {
						...init,
						headers: {
							Authorization: `Bearer ${token}`,
							Accept: "application/json",
							"Content-Type": "application/json",
							...(init?.headers ?? {}),
						},
					});

					const textBody = await response.text();

					if (!response.ok) {
						const errorMessage =
							textBody || `Tinybird request failed (${response.status})`;
						console.error("Tinybird request failed", {
							path,
							status: response.status,
							statusText: response.statusText,
							body: textBody,
						});
						throw new Error(errorMessage);
					}

					if (!textBody) {
						console.log("Tinybird empty response", { path });
						return { data: [] } as TinybirdResponse<T>;
					}

					let parsed: unknown;
					try {
						parsed = JSON.parse(textBody);
					} catch (parseError) {
						console.error("Tinybird JSON parse error", {
							path,
							responseBody: textBody,
							bodyLength: textBody.length,
							bodyPreview: textBody.slice(0, 500),
							parseError,
						});
						throw new Error(`Tinybird returned invalid JSON for ${path}`);
					}

					const normalized: TinybirdResponse<T> = Array.isArray(parsed)
						? ({ data: parsed } as TinybirdResponse<T>)
						: parsed && typeof parsed === "object" && "data" in parsed
							? (parsed as TinybirdResponse<T>)
							: ({ data: [parsed as T] } as TinybirdResponse<T>);

					if (normalized.error) {
						throw new Error(normalized.error);
					}

					return normalized;
				},
				catch: (cause) => cause as Error,
			});
		};

		const splitSelectColumns = (selectClause: string) => {
			const columns: string[] = [];
			let current = "";
			let depth = 0;
			let inSingle = false;
			let inDouble = false;
			for (let i = 0; i < selectClause.length; i++) {
				const ch = selectClause.charAt(i);
				if (ch === "'" && !inDouble) {
					inSingle = !inSingle;
				} else if (ch === '"' && !inSingle) {
					inDouble = !inDouble;
				}
				if (!inSingle && !inDouble) {
					if (ch === "(") depth++;
					else if (ch === ")") depth--;
					else if (ch === "," && depth === 0) {
						columns.push(current.trim());
						current = "";
						continue;
					}
				}
				current += ch;
			}
			if (current.trim()) columns.push(current.trim());
			return columns;
		};

		const extractAliases = (sql: string) => {
			const upper = sql.toUpperCase();
			const selectIdx = upper.indexOf("SELECT ");
			const fromIdx = upper.indexOf(" FROM ");
			if (selectIdx === -1 || fromIdx === -1 || fromIdx <= selectIdx) return [];
			const clause = sql.slice(selectIdx + 7, fromIdx);
			const parts = splitSelectColumns(clause);
			return parts.map((part, idx) => {
				const mAs = part.match(/\bas\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*$/i);
				if (mAs) return String(mAs[1]);
				const mSimple = part.match(/([a-zA-Z_][a-zA-Z0-9_]*)\s*$/);
				return mSimple ? String(mSimple[1]) : `col_${idx}`;
			});
		};

		const parseTsvToObjects = <T>(text: string, aliases: string[]) => {
			const lines = text.trim().split(/\r?\n/).filter(Boolean);
			const rows = lines.map((line) => line.split("\t"));
			const objects = rows.map((values) => {
				const obj: Record<string, unknown> = {};
				for (let i = 0; i < values.length; i++) {
					const key = aliases[i] ?? `col_${i}`;
					const raw = values[i] ?? "";
					obj[key] = key === "views" ? Number(raw) : raw;
				}
				return obj as T;
			});
			return objects;
		};

		const appendEvents = (rows: TinybirdEventRow[]) => {
			if (!enabled || rows.length === 0) return Effect.void;
			const body = rows
				.map((row) =>
					JSON.stringify({
						...row,
						session_id: row.session_id ?? "",
						user_id: row.user_id ?? "",
						tenant_id: row.tenant_id ?? "",
						pathname: row.pathname ?? "",
						video_id: row.video_id ?? "",
						country: row.country ?? "",
						region: row.region ?? "",
						city: row.city ?? "",
						browser: row.browser ?? "unknown",
						device: row.device ?? "desktop",
						os: row.os ?? "unknown",
					}),
				)
				.join("\n");
			const search = new URLSearchParams({
				name: DEFAULT_DATASOURCE,
				format: "ndjson",
			});
			return request(`/events?${search.toString()}`, {
				method: "POST",
				body,
				headers: {
					"Content-Type": "application/x-ndjson",
				},
			}).pipe(Effect.asVoid);
		};

		const queryPipe = <T>(
			name: string,
			params?: Record<string, string | number | boolean | undefined>,
		) => {
			if (!enabled) return Effect.succeed<TinybirdResponse<T>>({ data: [] });
			const search = new URLSearchParams();
			Object.entries(params ?? {}).forEach(([key, value]) => {
				if (value === undefined || value === null) return;
				search.set(key, String(value));
			});
			const query = search.toString();
			return request<T>(`/pipes/${name}.json${query ? `?${query}` : ""}`);
		};

		const querySql = <T>(sql: string) => {
			if (!enabled) return Effect.succeed<TinybirdResponse<T>>({ data: [] });
			const normalized = sql.replace(/\s+/g, " ").trim();
			const encoded = encodeURIComponent(normalized);
			const path = `/sql?q=${encoded}&format=JSON`;
			return Effect.tryPromise({
				try: async () => {
					const url = `${host}/v0${path}`;
					const response = await fetch(url, {
						headers: {
							Authorization: `Bearer ${token}`,
							Accept: "application/json",
						},
					});
					const textBody = await response.text();
					if (!response.ok) {
						const errorMessage =
							textBody || `Tinybird request failed (${response.status})`;
						console.error("Tinybird request failed", {
							path,
							status: response.status,
							statusText: response.statusText,
							body: textBody,
						});
						throw new Error(errorMessage);
					}
					if (!textBody) {
						console.log("Tinybird empty response", { path });
						return { data: [] } as TinybirdResponse<T>;
					}
					try {
						const parsed = JSON.parse(textBody);
						const normalizedRes: TinybirdResponse<T> = Array.isArray(parsed)
							? ({ data: parsed } as TinybirdResponse<T>)
							: parsed && typeof parsed === "object" && "data" in parsed
								? (parsed as TinybirdResponse<T>)
								: ({ data: [parsed as T] } as TinybirdResponse<T>);
						if ((normalizedRes as TinybirdResponse<T>).error) {
							throw new Error(
								(normalizedRes as TinybirdResponse<T>).error as string,
							);
						}
						return normalizedRes;
					} catch {
						const aliases = extractAliases(normalized);
						const objects = parseTsvToObjects<T>(textBody, aliases);
						return { data: objects } as TinybirdResponse<T>;
					}
				},
				catch: (cause) => cause as Error,
			});
		};

		const deleteData = (name: string, deleteCondition: string) => {
			if (!enabled || !deleteCondition.trim()) return Effect.void;
			const body = new URLSearchParams({
				delete_condition: deleteCondition,
			});
			return request(`/datasources/${encodeURIComponent(name)}/delete`, {
				method: "POST",
				body,
				headers: {
					"Content-Type": "application/x-www-form-urlencoded",
				},
			}).pipe(Effect.asVoid);
		};

		const runCopyPipe = (name: string) => {
			if (!enabled) return Effect.void;
			return request(`/pipes/${encodeURIComponent(name)}/run?wait=true`, {
				method: "POST",
			}).pipe(Effect.asVoid);
		};

		const productAnalyticsRequest = <T>(
			path: string,
			auth: { token: string | undefined; purpose: string },
			init?: RequestInit,
		) => {
			if (!productAnalyticsHost) {
				return Effect.fail(
					new Error("Product analytics erasure host is not configured"),
				);
			}
			if (!auth.token) {
				return Effect.fail(
					new Error(`Product analytics ${auth.purpose} is not configured`),
				);
			}
			return Effect.tryPromise({
				try: async () => {
					const response = await fetch(`${productAnalyticsHost}${path}`, {
						...init,
						headers: {
							Authorization: `Bearer ${auth.token}`,
							...(init?.headers ?? {}),
						},
						signal: AbortSignal.timeout(65_000),
					});
					const body = await response.text();
					if (!response.ok) {
						throw new Error(
							`Product analytics erasure request failed (${response.status})`,
						);
					}
					return body ? (JSON.parse(body) as T) : ({} as T);
				},
				catch: (cause) =>
					cause instanceof Error ? cause : new Error(String(cause)),
			});
		};

		const deleteProductAnalyticsData = (
			name: string,
			deleteCondition: string,
		) =>
			productAnalyticsRequest<{ mutation?: { is_done?: boolean } }>(
				`/v1/datasources/${encodeURIComponent(name)}/delete?wait=true&wait_max_seconds=60`,
				{
					token: productAnalyticsErasureToken,
					purpose: "erasure deletion",
				},
				{
					method: "POST",
					body: new URLSearchParams({ delete_condition: deleteCondition }),
					headers: {
						"Content-Type": "application/x-www-form-urlencoded",
					},
				},
			).pipe(
				Effect.flatMap((result) =>
					result.mutation?.is_done === true
						? Effect.void
						: Effect.fail(
								new Error("Product analytics deletion did not finish"),
							),
				),
			);

		const runProductAnalyticsCopyPipe = (name: string, copyRunId?: string) => {
			const search = new URLSearchParams({ _mode: "replace" });
			if (copyRunId) search.set("copy_run_id", copyRunId);
			return productAnalyticsRequest<TinybirdJobResponse>(
				`/v0/pipes/${encodeURIComponent(name)}/copy?${search.toString()}`,
				{ token: productAnalyticsCopyToken, purpose: "Copy execution" },
				{ method: "POST" },
			).pipe(
				Effect.flatMap((copy) =>
					tinybirdJobId(copy)
						? Effect.void
						: Effect.fail(
								new Error("Product analytics copy did not return a job ID"),
							),
				),
			);
		};

		const queryProductAnalyticsSql = <T>(sql: string) =>
			productAnalyticsRequest<{ data: T[] }>(
				`/v0/sql?q=${encodeURIComponent(sql)}&format=JSON`,
				{
					token: productAnalyticsErasureLookupToken,
					purpose: "erasure lookup",
				},
			).pipe(Effect.map((result) => result.data ?? []));

		const setProductAnalyticsCopySchedulePaused = (
			name: (typeof PRODUCT_ANALYTICS_REBUILD_PIPES)[number],
			paused: boolean,
		) => {
			const auth = {
				token: productAnalyticsSchedulerToken,
				purpose: "Copy schedule control",
			};
			const attempt = productAnalyticsRequest(
				`/v0/pipes/${encodeURIComponent(name)}/copy/${paused ? "cancel" : "resume"}`,
				auth,
				{ method: "POST" },
			).pipe(
				Effect.either,
				Effect.flatMap((mutation) =>
					productAnalyticsRequest<TinybirdPipeResponse>(
						`/v0/pipes/${encodeURIComponent(name)}`,
						auth,
					).pipe(
						Effect.flatMap((pipe) => {
							const status = pipe.schedule?.status?.toLowerCase() ?? "";
							const matches = paused
								? status === "paused"
								: status === "scheduled" || status === "active";
							if (matches) return Effect.void;
							if (mutation._tag === "Left") return Effect.fail(mutation.left);
							return Effect.fail(
								new Error(
									`Product analytics schedule state did not become ${paused ? "paused" : "active"}`,
								),
							);
						}),
					),
				),
			);
			return attempt.pipe(Effect.retry({ times: 3 }));
		};

		const resumeProductAnalyticsCopySchedules = (
			names: ReadonlyArray<(typeof PRODUCT_ANALYTICS_REBUILD_PIPES)[number]>,
		) =>
			Effect.forEach(
				names,
				(name) =>
					setProductAnalyticsCopySchedulePaused(name, false).pipe(
						Effect.either,
					),
				{ concurrency: 1 },
			).pipe(
				Effect.flatMap((outcomes) => {
					const failure = outcomes.find((outcome) => outcome._tag === "Left");
					return failure?._tag === "Left"
						? Effect.fail(failure.left)
						: Effect.void;
				}),
			);

		const pauseProductAnalyticsCopySchedules = (
			onPaused: (
				paused: ReadonlyArray<(typeof PRODUCT_ANALYTICS_REBUILD_PIPES)[number]>,
			) => Effect.Effect<void, Error>,
		) =>
			Effect.gen(function* () {
				const paused: Array<(typeof PRODUCT_ANALYTICS_REBUILD_PIPES)[number]> =
					[];
				for (const name of PRODUCT_ANALYTICS_REBUILD_PIPES) {
					const outcome = yield* setProductAnalyticsCopySchedulePaused(
						name,
						true,
					).pipe(Effect.either);
					if (outcome._tag === "Left") {
						const resumed = yield* resumeProductAnalyticsCopySchedules(
							paused,
						).pipe(Effect.either);
						if (resumed._tag === "Right") yield* onPaused([]);
						return yield* Effect.fail(outcome.left);
					}
					paused.push(name);
					yield* onPaused(paused);
				}
				return paused;
			});

		const waitForProductAnalytics = <T>(
			label: string,
			read: () => Effect.Effect<T, Error>,
			accept: (value: T) => boolean,
		) =>
			Effect.gen(function* () {
				for (let attempt = 0; attempt < 90; attempt += 1) {
					const value = yield* read();
					if (accept(value)) return value;
					yield* Effect.sleep(2_000);
				}
				return yield* Effect.fail(
					new Error(`Product analytics ${label} timed out`),
				);
			});

		const queryProductAnalyticsCopyMarker = (
			copyRunId: string,
			marker: string,
		) =>
			productAnalyticsRequest<{ data?: Array<Record<string, unknown>> }>(
				`/v0/pipes/product_analytics_copy_assertions.json?copy_run_id=${encodeURIComponent(copyRunId)}`,
				{
					token: productAnalyticsReadToken,
					purpose: "aggregate read",
				},
			).pipe(Effect.map((result) => Number(result.data?.[0]?.[marker] ?? 0)));

		const runProductAnalyticsErasure = (
			lease: ProductAnalyticsErasureLease,
		) => {
			let pausedPipes: Array<(typeof PRODUCT_ANALYTICS_REBUILD_PIPES)[number]> =
				lease.pausedPipes.filter(
					(name): name is (typeof PRODUCT_ANALYTICS_REBUILD_PIPES)[number] =>
						PRODUCT_ANALYTICS_REBUILD_PIPES.some((known) => known === name),
				);

			const requireLeaseUpdate = (updated: Effect.Effect<boolean, Error>) =>
				updated.pipe(
					Effect.flatMap((owned) =>
						owned
							? Effect.void
							: Effect.fail(
									new Error("Product analytics erasure lease was fenced"),
								),
					),
				);

			const advance = (
				phase: "pausing" | "deleting" | "rebuilding" | "resuming",
				paused: readonly string[] = pausedPipes,
			) => requireLeaseUpdate(erasureLeases.advance(lease, phase, paused));

			const heartbeat = Effect.forever(
				Effect.sleep(20_000).pipe(
					Effect.zipRight(requireLeaseUpdate(erasureLeases.heartbeat(lease))),
				),
			);

			const operation = Effect.gen(function* () {
				if (pausedPipes.length > 0) {
					yield* advance("resuming");
					yield* resumeProductAnalyticsCopySchedules(pausedPipes);
					pausedPipes = [];
					yield* advance("pausing", []);
				}
				pausedPipes = yield* pauseProductAnalyticsCopySchedules((paused) => {
					pausedPipes = [...paused];
					return advance("pausing", paused);
				});
				yield* advance("deleting");
				const conditions: string[] = [];
				if (lease.scope.organizationId) {
					conditions.push(
						`organization_id = '${escapeTinybirdString(lease.scope.organizationId)}'`,
					);
				}
				if (lease.scope.userId) {
					const escapedUserId = escapeTinybirdString(lease.scope.userId);
					const anonymousRows = yield* queryProductAnalyticsSql<{
						anonymous_id: string;
					}>(
						`SELECT anonymous_id FROM product_events_v1 WHERE anonymous_id != '' GROUP BY anonymous_id HAVING countIf(user_id = '${escapedUserId}') > 0 AND countIf(user_id != '' AND user_id != '${escapedUserId}') = 0 LIMIT 1001`,
					);
					if (anonymousRows.length > 1000) {
						return yield* Effect.fail(
							new Error(
								"Product analytics identity fanout exceeded the erasure bound",
							),
						);
					}
					conditions.push(`user_id = '${escapedUserId}'`);
					const anonymousIds = anonymousRows
						.map(({ anonymous_id: anonymousId }) => anonymousId)
						.filter(Boolean);
					if (anonymousIds.length > 0) {
						conditions.push(
							`(anonymous_id IN (${anonymousIds
								.map((anonymousId) => `'${escapeTinybirdString(anonymousId)}'`)
								.join(
									", ",
								)}) AND (user_id = '' OR user_id = '${escapedUserId}'))`,
						);
					}
				}
				if (conditions.length === 0) {
					return yield* Effect.fail(
						new Error("Product analytics erasure requires an identity"),
					);
				}
				const deleteCondition = `(${conditions.join(" OR ")})`;
				const countRows = (datasource: string) =>
					queryProductAnalyticsSql<{ matching_rows: number | string }>(
						`SELECT count() AS matching_rows FROM ${datasource} WHERE ${deleteCondition}`,
					).pipe(Effect.map((rows) => Number(rows[0]?.matching_rows ?? 0)));
				const rawRows = yield* countRows("product_events_v1");
				if (rawRows > 0) {
					yield* advance("deleting");
					yield* deleteProductAnalyticsData(
						"product_events_v1",
						deleteCondition,
					);
					yield* waitForProductAnalytics(
						"raw erasure visibility",
						() => countRows("product_events_v1"),
						(count) => count === 0,
					);
				}
				yield* advance("rebuilding");
				yield* runProductAnalyticsCopyPipe(
					"snapshot_product_events_canonical_v1",
				);
				yield* waitForProductAnalytics(
					"canonical erasure visibility",
					() => countRows("product_events_canonical_v1"),
					(count) => count === 0,
				);
				const copyRunId = `erasure_${lease.requestId.replaceAll("-", "")}`;
				for (const [pipe, marker] of Object.entries(
					PRODUCT_ANALYTICS_COPY_MARKERS,
				)) {
					yield* advance("rebuilding");
					yield* runProductAnalyticsCopyPipe(pipe, copyRunId);
					yield* waitForProductAnalytics(
						`${pipe} visibility`,
						() => queryProductAnalyticsCopyMarker(copyRunId, marker),
						(count) => count === 1,
					);
				}
				yield* waitForProductAnalytics(
					"final erasure verification",
					() =>
						Effect.all([
							countRows("product_events_v1"),
							countRows("product_events_canonical_v1"),
						]),
					([rawCount, canonicalCount]) =>
						rawCount === 0 && canonicalCount === 0,
				);
				yield* advance("resuming");
				yield* resumeProductAnalyticsCopySchedules(pausedPipes);
				pausedPipes = [];
				yield* advance("resuming", []);
				yield* requireLeaseUpdate(erasureLeases.complete(lease));
			});

			const recoverableOperation = Effect.gen(function* () {
				const outcome = yield* operation.pipe(Effect.either);
				if (outcome._tag === "Right") return;
				const resumed = yield* resumeProductAnalyticsCopySchedules(
					pausedPipes,
				).pipe(Effect.either);
				if (resumed._tag === "Right") pausedPipes = [];
				const failed = yield* erasureLeases.fail(
					lease,
					pausedPipes,
					resumed._tag === "Left" ? "resume_failed" : "erase_failed",
				);
				if (!failed) {
					return yield* Effect.fail(
						new Error("Product analytics erasure lease was fenced"),
					);
				}
				return yield* Effect.fail(outcome.left);
			});

			return Effect.raceFirst(recoverableOperation, heartbeat);
		};

		const recoverProductAnalyticsErasure = Effect.gen(function* () {
			const lease = yield* erasureLeases.claimRecovery();
			if (!lease) return { recovered: false as const };
			yield* runProductAnalyticsErasure(lease);
			return { recovered: true as const, requestId: lease.requestId };
		});

		const eraseProductAnalytics = ({
			userId,
			organizationId,
		}: {
			userId?: string;
			organizationId?: string;
		}) =>
			Effect.gen(function* () {
				if (!userId && !organizationId) {
					return yield* Effect.fail(
						new Error("Product analytics erasure requires an identity"),
					);
				}
				let lease = yield* erasureLeases.claimNew({ userId, organizationId });
				if (!lease) {
					yield* recoverProductAnalyticsErasure;
					lease = yield* erasureLeases.claimNew({ userId, organizationId });
				}
				if (!lease) {
					return yield* Effect.fail(
						new Error("Product analytics erasure is already in progress"),
					);
				}
				yield* runProductAnalyticsErasure(lease);
			});

		return {
			enabled,
			appendEvents,
			queryPipe,
			querySql,
			deleteData,
			runCopyPipe,
			deleteProductAnalyticsData,
			runProductAnalyticsCopyPipe,
			eraseProductAnalytics,
			recoverProductAnalyticsErasure,
		} as const;
	}),
	dependencies: [ProductAnalyticsErasureLeaseRepo.Default],
}) {}
