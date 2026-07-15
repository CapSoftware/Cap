export const formatTimestamp = (date: Date) => {
	return new Intl.DateTimeFormat("zh-CN", {
		hour: "numeric",
		minute: "numeric",
		hour12: false,
		year: "numeric",
		month: "long",
		day: "numeric",
	}).format(date);
};

export const formatTimeAgo = (date: Date) => {
	const now = new Date();
	const diffInSeconds = Math.floor((now.getTime() - date.getTime()) / 1000);

	if (diffInSeconds < 60) return "刚刚";

	const diffInMinutes = Math.floor(diffInSeconds / 60);
	if (diffInMinutes < 60) return `${diffInMinutes} 分钟前`;

	const diffInHours = Math.floor(diffInMinutes / 60);
	if (diffInHours < 24) return `${diffInHours} 小时前`;

	const diffInDays = Math.floor(diffInHours / 24);
	if (diffInDays < 30) return `${diffInDays} 天前`;

	const diffInMonths = Math.floor(diffInDays / 30);
	if (diffInMonths < 12) return `${diffInMonths} 个月前`;

	const diffInYears = Math.floor(diffInDays / 365);
	return `${diffInYears} 年前`;
};
