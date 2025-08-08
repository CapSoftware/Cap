import { NotificationType } from "@/lib/Notification";

export type FilterType = "all" | "comments" | "replies" | "views" | "reactions";

export const Filters: Array<FilterType> = [
  "all",
  "comments",
  "replies",
  "views",
  "reactions",
];

export const FilterLabels: Record<FilterType, string> = {
  all: "All",
  comments: "Comments",
  replies: "Replies",
  views: "Views",
  reactions: "Reactions",
};

export const matchNotificationFilter = (
  filter: FilterType,
  type: NotificationType
): boolean => {
  switch (filter) {
    case "all":
      return true;
    case "comments":
      return type === "comment";
    case "replies":
      return type === "reply";
    case "views":
      return type === "view";
    case "reactions":
      return type === "reaction";
  }
};
