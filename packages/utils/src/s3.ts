export const isNeonObjectStorageEndpoint = (endpoint?: string | null) => {
	if (!endpoint) return false;
	try {
		const labels = new URL(endpoint).hostname.toLowerCase().split(".");
		return (
			labels.slice(-2).join(".") === "neon.tech" && labels[1] === "storage"
		);
	} catch {
		return false;
	}
};

// Neon Object Storage only serves path-style requests. Virtual-hosted bucket
// hostnames fail TLS verification against its certificate.
export const s3CompatibleClientOptions = (endpoint?: string | null) =>
	isNeonObjectStorageEndpoint(endpoint) ? { forcePathStyle: true } : {};
