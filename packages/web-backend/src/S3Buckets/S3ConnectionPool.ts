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

export const s3ConnectionPool = Effect.acquireRelease(
	Effect.sync(() => {
		const options = {
			keepAlive: true,
			maxSockets: 50,
			maxTotalSockets: 128,
			maxFreeSockets: 8,
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
