export const formatTimestamp = (date: Date) => {
	return new Intl.DateTimeFormat("en-US", {
		hour: "numeric",
		minute: "numeric",
		hour12: true,
		year: "numeric",
		month: "long",
		day: "numeric",
	}).format(date);
};

export const formatTimeAgo = (date: Date) => {
	const now = new Date();
	const diffInSeconds = Math.floor((now.getTime() - date.getTime()) / 1000);

	if (diffInSeconds < 60) return "now";

	const diffInMinutes = Math.floor(diffInSeconds / 60);
	if (diffInMinutes < 60) return `${diffInMinutes}m ago`;

	const diffInHours = Math.floor(diffInMinutes / 60);
	if (diffInHours < 24) return `${diffInHours}h ago`;

	const diffInDays = Math.floor(diffInHours / 24);
	if (diffInDays < 30) return `${diffInDays}d ago`;

	const diffInMonths = Math.floor(diffInDays / 30);
	if (diffInMonths < 12) return `${diffInMonths}mo ago`;

	const diffInYears = Math.floor(diffInDays / 365);
	return `${diffInYears}y ago`;
};
