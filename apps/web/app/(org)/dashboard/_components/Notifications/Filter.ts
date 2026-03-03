import type { NotificationType } from "@/lib/Notification";

export type FilterType = "all" | NotificationType;

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
	anon_view: "Views",
};

export const matchNotificationFilter = (
	filter: FilterType,
	type: NotificationType,
): boolean => {
	if (filter === "all") return true;
	if (filter === "view") return type === "view" || type === "anon_view";
	return type === filter;
};
