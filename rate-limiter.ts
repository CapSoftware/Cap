export interface RateLimitConfig {
  windowMs: number;
  maxRequests: number;
}

export class WorkspaceRateLimiter {
  private cache = new Map<string, { count: number; resetTime: number }>();

  isAllowed(workspaceId: string, config: RateLimitConfig): boolean {
    const now = Date.now();
    const entry = this.cache.get(workspaceId);
    if (!entry || now > entry.resetTime) {
      this.cache.set(workspaceId, { count: 1, resetTime: now + config.windowMs });
      return true;
    }
    if (entry.count >= config.maxRequests) {
      return false;
    }
    entry.count += 1;
    return true;
  }
}
