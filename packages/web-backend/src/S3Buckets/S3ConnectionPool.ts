import { Agent as HttpAgent } from "node:http";
import { Agent as HttpsAgent } from "node:https";
import { Socket } from "node:net";
import { Effect } from "effect";

function boundIdleConnections<T extends HttpAgent>(agent: T) {
	// Idle custom hosts must release their slots without timing out an active copy.
	const keepSocketAlive = agent.keepSocketAlive.bind(agent);
	const reuseSocket = agent.reuseSocket.bind(agent);
	agent.keepSocketAlive = (socket) => {
		const keep: unknown = keepSocketAlive(socket);
		if (keep !== false && socket instanceof Socket)
			socket.setTimeout(Math.min(socket.timeout || 30_000, 30_000));
		return keep;
	};
	agent.reuseSocket = (socket, request) => {
		if (socket instanceof Socket) socket.setTimeout(0);
		reuseSocket(socket, request);
	};
	return agent;
}

const makeS3ConnectionPool = (maxFreeSockets: number, maxSockets = 50) =>
	Effect.acquireRelease(
		Effect.sync(() => {
			const options = {
				keepAlive: true,
				maxSockets,
				maxTotalSockets: Math.max(128, maxSockets * 2),
				maxFreeSockets,
			};
			return {
				httpAgent: boundIdleConnections(new HttpAgent(options)),
				httpsAgent: boundIdleConnections(new HttpsAgent(options)),
			};
		}),
		(pool) =>
			Effect.sync(() => {
				pool.httpAgent.destroy();
				pool.httpsAgent.destroy();
			}),
	);

export const s3ConnectionPool = makeS3ConnectionPool(8);
// Desktop source commits copy 256 objects at once in Cap's own bucket, page after page; keeping those
// sockets between pages (they still expire after 30 s idle) avoids re-opening TLS to S3 for every page.
export const defaultBucketS3ConnectionPool = makeS3ConnectionPool(256, 256);
