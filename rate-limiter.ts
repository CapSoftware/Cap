export interface RateLimitConfig {
	windowMs: number;
	maxRequests: number;
}

export class WorkspaceRateLimiter {
	private requests: Map<string, number[]> = new Map();

	constructor(private config: RateLimitConfig) {}

	public isAllowed(workspaceId: string): boolean {
		const now = Date.now();
		const timestamps = (this.requests.get(workspaceId) || []).filter(
			(ts) => now - ts < this.config.windowMs
		);
		if (timestamps.length >= this.config.maxRequests) {
			return false;
		}
		timestamps.push(now);
		this.requests.set(workspaceId, timestamps);
		return true;
	}
}
