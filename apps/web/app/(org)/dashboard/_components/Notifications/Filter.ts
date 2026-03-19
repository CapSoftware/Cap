import type { Notification } from "@cap/web-api-contract";

type NotificationType = Notification["type"];

export type FilterType = "all" | Exclude<NotificationType, "anon_view">;

export const Filters: Array<FilterType> = [
	"all",
	"comment",
	"reply",
	"view",
	"reaction",
];

export const FilterLabels: Record<FilterType, string> = {
	all: "All",
	comment: "Comments",
	reply: "Replies",
	view: "Views",
	reaction: "Reactions",
};

export const matchNotificationFilter = (
	filter: FilterType,
	type: NotificationType,
): boolean => {
	if (filter === "all") return true;
	if (filter === "view") return type === "view" || type === "anon_view";
	return type === filter;
};
