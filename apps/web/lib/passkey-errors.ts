export function isPasskeyCancellation(error: unknown) {
	if (!error || typeof error !== "object") return false;
	const { name, code } = error as { name?: unknown; code?: unknown };
	return (
		name === "NotAllowedError" ||
		name === "AbortError" ||
		code === "ERROR_CEREMONY_ABORTED"
	);
}
