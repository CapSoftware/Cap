export const formatRelativeDate = (input: string, now = new Date()) => {
	const date = new Date(input);
	const diffMs = now.getTime() - date.getTime();
	const diffSeconds = Math.max(0, Math.round(diffMs / 1000));
	if (diffSeconds < 45) return "a few seconds ago";
	if (diffSeconds < 90) return "a minute ago";

	const diffMinutes = Math.round(diffSeconds / 60);
	if (diffMinutes < 45) return `${diffMinutes} minutes ago`;
	if (diffMinutes < 90) return "an hour ago";

	const diffHours = Math.round(diffMinutes / 60);
	if (diffHours < 22) return `${diffHours} hours ago`;
	if (diffHours < 36) return "a day ago";

	const diffDays = Math.round(diffHours / 24);
	if (diffDays < 26) return `${diffDays} days ago`;
	if (diffDays < 45) return "a month ago";

	const diffMonths = Math.round(diffDays / 30);
	if (diffDays < 320) return `${diffMonths} months ago`;
	if (diffDays < 548) return "a year ago";

	const diffYears = Math.round(diffDays / 365);
	return `${diffYears} years ago`;
};

export const formatDuration = (seconds: number | null) => {
	if (seconds === null || !Number.isFinite(seconds)) return null;
	const safeSeconds = Math.max(0, Math.ceil(seconds));
	const hours = Math.floor(safeSeconds / 3600);
	const minutes = Math.floor(safeSeconds / 60);
	const remainingSeconds = safeSeconds % 60;
	if (hours > 0) return `${hours} hr${hours > 1 ? "s" : ""}`;
	if (minutes > 0) return `${minutes} min${minutes > 1 ? "s" : ""}`;
	if (remainingSeconds > 0) {
		return `${remainingSeconds} sec${remainingSeconds === 1 ? "" : "s"}`;
	}
	return "< 1 sec";
};

export const formatFileSize = (bytes: number | null | undefined) => {
	if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) {
		return null;
	}
	if (bytes <= 0) return null;
	if (bytes >= 1_000_000_000) return `${Math.round(bytes / 1_000_000_000)} GB`;
	if (bytes >= 1_000_000) return `${Math.round(bytes / 1_000_000)} MB`;
	if (bytes >= 1_000) return `${Math.round(bytes / 1_000)} KB`;
	return `${Math.round(bytes)} B`;
};
