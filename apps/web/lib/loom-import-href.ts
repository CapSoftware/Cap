export const LOOM_IMPORT_PATH = "/dashboard/import/loom";

export type LoomImportMode = "single" | "csv";

export type LoomImportTarget = {
	signedIn: boolean;
	loomUrl?: string;
	mode?: LoomImportMode;
};

export const isLoomShareUrl = (value: string) => {
	try {
		const { hostname } = new URL(value.trim());
		return hostname === "loom.com" || hostname.endsWith(".loom.com");
	} catch {
		return false;
	}
};

export const buildLoomImportHref = ({
	signedIn,
	loomUrl,
	mode,
}: LoomImportTarget) => {
	const params = new URLSearchParams();
	if (loomUrl) params.set("url", loomUrl);
	if (mode === "csv") params.set("mode", "csv");
	const query = params.toString();
	const target = query ? `${LOOM_IMPORT_PATH}?${query}` : LOOM_IMPORT_PATH;
	return signedIn ? target : `/signup?next=${encodeURIComponent(target)}`;
};
