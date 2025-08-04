export enum NotificationType {
  COMMENT = "comment",
  VIEW = "view",
  REACTION = "reaction",
  MENTION = "mention",
  REPLY = "reply",
}

export type Notification = {
  id: string;
  content: string;
  videoId: string;
  type: NotificationType;
  readAt: string | null;
  createdAt: string;
  data: {
    comment?: {
      id: string;
      parentCommentId: string;
    };
    content?: string;
    videoId: string;
    authorId?: string;
  };
  author: {
    name: string;
    avatar: string | null;
  };
};

export enum FilterType {
  ALL = "All",
  COMMENTS = "Comments",
  REPLIES = "Replies",
  VIEWS = "Views",
  REACTIONS = "Reactions",
}

export type NotificationData = {
  notifications: Notification[];
  count: Record<NotificationType, number>;
};

export const Filters = [
  FilterType.ALL,
  FilterType.COMMENTS,
  FilterType.REPLIES,
  FilterType.VIEWS,
  FilterType.REACTIONS,
] as const;

// Map filter types to notification types
export const filterToNotificationType: Record<
  FilterType,
  NotificationType | null
> = {
  [FilterType.ALL]: null, // null means all types
  [FilterType.COMMENTS]: NotificationType.COMMENT,
  [FilterType.REPLIES]: NotificationType.REPLY,
  [FilterType.VIEWS]: NotificationType.VIEW,
  [FilterType.REACTIONS]: NotificationType.REACTION,
};
