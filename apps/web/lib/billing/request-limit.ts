const windows = new Map<string, { count: number; resetAt: number }>();

export function allowInvoiceRequest(userId: string) {
	const now = Date.now();
	const current = windows.get(userId);
	if (current && current.resetAt > now) {
		if (current.count >= 30) return false;
		current.count++;
		return true;
	}
	for (const [id, window] of windows) {
		if (window.resetAt <= now) windows.delete(id);
	}
	if (windows.size >= 10_000) return false;
	windows.set(userId, { count: 1, resetAt: now + 60_000 });
	return true;
}
