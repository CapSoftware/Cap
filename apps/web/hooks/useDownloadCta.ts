import { useDetectPlatform } from "hooks/useDetectPlatform";
import { trackEvent } from "@/app/utils/analytics";
import { type DownloadFamily, getDownloadStartedUrl } from "@/lib/download";
import { getDownloadUrl } from "@/utils/platform";

const FAMILY_NAME: Record<DownloadFamily, string> = {
	macos: "macOS",
	windows: "Windows",
	linux: "Linux",
};

export const useDownloadCta = () => {
	const { platform, isIntel, isIOS } = useDetectPlatform();
	const detected = platform !== null;
	const isPhone = isIOS || platform === "android";
	const family: DownloadFamily =
		platform === "windows" || platform === "linux" ? platform : "macos";
	const installerUrl = getDownloadUrl(family, isIntel);
	const href = isPhone ? "/download" : getDownloadStartedUrl(installerUrl);

	const trackClick = (sourcePage: string, ctaLocation: string) =>
		trackEvent("download_cta_clicked", {
			source_page: sourcePage,
			cta_location: ctaLocation,
			target_url: isPhone ? "/download" : installerUrl,
			detected_platform: isIOS ? "ios" : (platform ?? "unknown"),
			is_intel: Boolean(isIntel),
		});

	return {
		detected,
		isPhone,
		family,
		platformName: FAMILY_NAME[family],
		installerUrl,
		href,
		trackClick,
	};
};
