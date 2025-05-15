export enum NotificationType {
  RECORDING = "recording",
  COMMENT = "comment",
  VIEW = "view",
  REACTION = "reaction"
}

export type Notification = {
  id: string;
  type: NotificationType;
  user: {
    name: string;
    avatar: string;
    hasUnread?: boolean;
  };
  content: string;
  time: string;
  additionalText?: string;
};

export enum FilterType {
  ALL = "All",
  RECORDINGS = "Recordings",
  COMMENTS = "Comments",
  VIEWS = "Views",
  REACTIONS = "Reactions"
}

export const Filters = [
  FilterType.ALL,
  FilterType.RECORDINGS,
  FilterType.COMMENTS,
  FilterType.VIEWS,
  FilterType.REACTIONS,
] as const;

// Map filter types to notification types
export const filterToNotificationType: Record<FilterType, NotificationType | null> = {
  [FilterType.ALL]: null, // null means all types
  [FilterType.RECORDINGS]: NotificationType.RECORDING,
  [FilterType.COMMENTS]: NotificationType.COMMENT,
  [FilterType.VIEWS]: NotificationType.VIEW,
  [FilterType.REACTIONS]: NotificationType.REACTION
};
