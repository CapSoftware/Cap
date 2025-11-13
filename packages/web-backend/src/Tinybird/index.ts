import { serverEnv } from "@cap/env";
import { Effect } from "effect";

const DEFAULT_DATASOURCE = "analytics_events";

interface TinybirdResponse<T> {
	data: T[];
	error?: string;
}

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
		const env = serverEnv();
		const token = env.TINYBIRD_TOKEN;
		const host = env.TINYBIRD_HOST;

		if (!host) {
			yield* Effect.die(new Error("TINYBIRD_HOST must be set"));
		}

		yield* Effect.logDebug("Initializing Tinybird service", {
			hasToken: Boolean(token),
			host,
		});

		const enabled = Boolean(token);

		if (!enabled) {
			yield* Effect.logWarning(
				"Tinybird is disabled: TINYBIRD_TOKEN is not set",
			);
		}

		const request = <T>(path: string, init?: RequestInit) => {
			if (!enabled) return Effect.succeed<TinybirdResponse<T>>({ data: [] });

			return Effect.tryPromise({
				try: async () => {
					const url = `${host}/v0${path}`;
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

		return { enabled, appendEvents, queryPipe, querySql } as const;
	}),
}) {}
