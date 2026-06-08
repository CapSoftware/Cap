export function isRetryableDesktopSegmentsFinalizationError(
	error: string | null | undefined,
) {
	if (!error) return false;

	return (
		error.includes("Mux failed: 500") ||
		error.includes("Mux failed: 502") ||
		error.includes("Mux failed: 503") ||
		error.includes("Mux failed: 504") ||
		error.includes("Application failed to respond") ||
		error.includes("SERVER_BUSY") ||
		error.includes("Server is at capacity") ||
		error.includes("Failed to start segment muxing") ||
		error.includes("fetch failed") ||
		error.includes("Segment manifest not found") ||
		error.includes("Segment manifest is not marked as complete") ||
		error.includes("timed out") ||
		error.includes("timeout")
	);
}
