const PEER_LOOKUP_HEADER = "x-cap-peer-lookup";
const PEER_STATUS_TIMEOUT_MS = 2_000;
// The owner replies to a cancel only after delivering its webhook (up to three 5 s attempts).
const PEER_CANCEL_TIMEOUT_MS = 30_000;

// Jobs live in the memory of the instance that runs them. Behind a load
// balancer a status or cancel request can land on another instance, so it asks
// the configured peers once before answering that the job does not exist.
export function mediaServerPeers(
	env: Record<string, string | undefined> = process.env,
): string[] {
	return (env.MEDIA_SERVER_PEERS ?? "")
		.split(",")
		.map((value) => value.trim().replace(/\/+$/, ""))
		.filter((value) => {
			try {
				const url = new URL(value);
				return url.protocol === "http:" || url.protocol === "https:";
			} catch {
				return false;
			}
		});
}

export function isPeerLookup(request: Request): boolean {
	return request.headers.get(PEER_LOOKUP_HEADER) === "1";
}

// What the peers said about a job this instance does not hold. "missing"
// means every peer answered and none has it. "unavailable" means at least
// one peer could not be asked, so the job may still exist.
export type PeerJobLookup =
	| { found: Response }
	| { found: null; outcome: "missing" | "unavailable" };

const NOT_ON_PEER = "Job is not on this peer";

export async function lookUpJobOnPeers(
	path: string,
	method: "GET" | "POST",
): Promise<PeerJobLookup> {
	const secret = process.env.MEDIA_SERVER_WEBHOOK_SECRET;
	const peers = mediaServerPeers();
	if (!secret || peers.length === 0) return { found: null, outcome: "missing" };
	const controller = new AbortController();
	const timeout = setTimeout(
		() => controller.abort(),
		method === "POST" ? PEER_CANCEL_TIMEOUT_MS : PEER_STATUS_TIMEOUT_MS,
	);
	try {
		const found = await Promise.any(
			peers.map(async (peer) => {
				const response = await fetch(`${peer}${path}`, {
					method,
					headers: {
						"x-media-server-secret": secret,
						[PEER_LOOKUP_HEADER]: "1",
						Accept: "application/json",
					},
					signal: controller.signal,
					redirect: "error",
				});
				// Only a peer that owns the job answers 200, or 400 for a finished job's cancel.
				if (response.status !== 200 && response.status !== 400) {
					await response.body?.cancel().catch(() => {});
					// A 404 or a refused secret is an answer. Anything else
					// (a peer that is starting, overloaded or failing) is not.
					throw new Error(
						response.status === 404 ||
							response.status === 401 ||
							response.status === 403
							? NOT_ON_PEER
							: `Peer answered ${response.status}`,
					);
				}
				const body = await response.text();
				return new Response(body, {
					status: response.status,
					headers: {
						"Content-Type":
							response.headers.get("content-type") ?? "application/json",
					},
				});
			}),
		);
		return { found };
	} catch (error) {
		const failures = error instanceof AggregateError ? error.errors : [error];
		const allAnswered = failures.every(
			(failure) => failure instanceof Error && failure.message === NOT_ON_PEER,
		);
		return { found: null, outcome: allAnswered ? "missing" : "unavailable" };
	} finally {
		clearTimeout(timeout);
		controller.abort();
	}
}

export async function findJobOnPeer(
	path: string,
	method: "GET" | "POST",
): Promise<Response | null> {
	return (await lookUpJobOnPeers(path, method)).found;
}
