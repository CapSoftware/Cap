export const LOOM_IMPORT_PATH = "/dashboard/import/loom";

const LOOM_VIDEO_ROUTES = new Set(["share", "embed"]);
const MIN_LOOM_VIDEO_ID_LENGTH = 10;

export type LoomImportMode = "single" | "csv";

export type LoomImportTarget = {
	signedIn: boolean;
	loomUrl?: string;
	mode?: LoomImportMode;
};

export const isLoomShareUrl = (value: string) => {
	try {
		const { hostname, pathname } = new URL(value.trim());
		if (hostname !== "loom.com" && !hostname.endsWith(".loom.com")) {
			return false;
		}
		const [route, videoId] = pathname.split("/").filter(Boolean);
		return (
			route !== undefined &&
			LOOM_VIDEO_ROUTES.has(route) &&
			(videoId?.length ?? 0) >= MIN_LOOM_VIDEO_ID_LENGTH
		);
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
