export type LoomVideoLookup =
	| {
			status: "ok";
			title: string | null;
			createdAt: string | null;
			durationSeconds: number | null;
			width: number | null;
			height: number | null;
			thumbnailUrl: string | null;
	  }
	| { status: "private" }
	| { status: "password" }
	| { status: "not_found" }
	| { status: "error" };

type LookupOptions = {
	batchSize?: number;
	concurrency?: number;
	attempts?: number;
	fetchImpl?: typeof fetch;
	onBatch?: (results: Map<string, LoomVideoLookup>) => Promise<void> | void;
};

type GraphqlVideo = {
	__typename?: string;
	name?: string | null;
	createdAt?: string | null;
	thumbnails?: { default?: string | null } | null;
	video_properties?: {
		duration?: number | null;
		width?: number | null;
		height?: number | null;
	} | null;
} | null;

const LOOM_GRAPHQL_URL = "https://www.loom.com/graphql";
const VIDEO_FIELDS = `__typename
... on RegularUserVideo { name createdAt thumbnails { default } video_properties { duration width height } }
... on PrivateVideo { id }
... on VideoPasswordMissingOrIncorrect { id }`;

function positiveNumber(value: unknown) {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? value
		: null;
}

function validIsoDate(value: unknown) {
	if (typeof value !== "string") return null;
	return Number.isNaN(Date.parse(value)) ? null : value;
}

function httpsUrl(value: unknown) {
	if (typeof value !== "string") return null;
	try {
		return new URL(value).protocol === "https:" ? value : null;
	} catch {
		return null;
	}
}

export function toLoomVideoLookup(video: GraphqlVideo): LoomVideoLookup {
	if (!video) return { status: "not_found" };
	switch (video.__typename) {
		case "RegularUserVideo":
			return {
				status: "ok",
				title: video.name?.trim().slice(0, 255) || null,
				createdAt: validIsoDate(video.createdAt),
				durationSeconds: positiveNumber(video.video_properties?.duration),
				width: positiveNumber(video.video_properties?.width),
				height: positiveNumber(video.video_properties?.height),
				thumbnailUrl: httpsUrl(video.thumbnails?.default),
			};
		case "PrivateVideo":
			return { status: "private" };
		case "VideoPasswordMissingOrIncorrect":
			return { status: "password" };
		default:
			return { status: "not_found" };
	}
}

export function buildLoomVideosQuery(ids: string[]) {
	const variables = ids.map((_, index) => `$id${index}: ID!`).join(", ");
	const selections = ids
		.map(
			(_, index) =>
				`v${index}: getVideo(id: $id${index}, password: null) { ${VIDEO_FIELDS} }`,
		)
		.join("\n");
	return {
		operationName: "CapImportVideos",
		query: `query CapImportVideos(${variables}) {\n${selections}\n}`,
		variables: Object.fromEntries(ids.map((id, index) => [`id${index}`, id])),
	};
}

async function lookupBatch(
	ids: string[],
	fetchImpl: typeof fetch,
	attempts: number,
): Promise<Map<string, LoomVideoLookup>> {
	const body = JSON.stringify(buildLoomVideosQuery(ids));
	for (let attempt = 0; attempt < attempts; attempt++) {
		try {
			const response = await fetchImpl(LOOM_GRAPHQL_URL, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Accept: "application/json",
					"x-loom-request-source": "loom_web",
				},
				body,
				signal: AbortSignal.timeout(15_000),
			});
			if (response.ok) {
				const json = (await response.json()) as {
					data?: Record<string, GraphqlVideo> | null;
				};
				if (json.data) {
					const results = new Map<string, LoomVideoLookup>();
					ids.forEach((id, index) => {
						results.set(
							id,
							toLoomVideoLookup(json.data?.[`v${index}`] ?? null),
						);
					});
					return results;
				}
			} else if (response.status < 500 && response.status !== 429) {
				break;
			}
		} catch {}
		if (attempt < attempts - 1) {
			await new Promise((resolve) => setTimeout(resolve, 400 * 2 ** attempt));
		}
	}
	return new Map(ids.map((id) => [id, { status: "error" } as const]));
}

export async function lookupLoomVideos(
	ids: string[],
	{
		batchSize = 25,
		concurrency = 4,
		attempts = 3,
		fetchImpl = fetch,
		onBatch,
	}: LookupOptions = {},
): Promise<Map<string, LoomVideoLookup>> {
	const unique = Array.from(new Set(ids));
	const batches: string[][] = [];
	for (let index = 0; index < unique.length; index += batchSize) {
		batches.push(unique.slice(index, index + batchSize));
	}

	const results = new Map<string, LoomVideoLookup>();
	let next = 0;
	const workers = Array.from(
		{ length: Math.min(concurrency, batches.length) },
		async () => {
			while (next < batches.length) {
				const batch = batches[next++];
				if (!batch) continue;
				const batchResults = await lookupBatch(batch, fetchImpl, attempts);
				for (const [id, lookup] of batchResults) results.set(id, lookup);
				await onBatch?.(batchResults);
			}
		},
	);
	await Promise.all(workers);
	return results;
}

export function loomLookupError(lookup: LoomVideoLookup) {
	switch (lookup.status) {
		case "private":
			return "This Loom is private. Ask the owner to share it with anyone who has the link.";
		case "password":
			return "This Loom is password protected.";
		case "not_found":
			return "We couldn't find this Loom. It may have been deleted.";
		case "error":
			return "Loom didn't respond. Try again in a minute.";
		default:
			return null;
	}
}
