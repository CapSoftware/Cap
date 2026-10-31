export function getClientIp(
	getHeader: (name: string) => string | null | undefined,
): string | null {
	const realIp = getHeader("x-real-ip")?.trim();
	if (realIp) return realIp;
	const forwarded = getHeader("x-forwarded-for")?.split(",")[0]?.trim();
	return forwarded || null;
}
