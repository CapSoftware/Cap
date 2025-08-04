import { faComment, faEye, faReply } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import clsx from "clsx";
import Link from "next/link";
import moment from "moment";
import { Notification, NotificationType } from "./types";

type NotificationItemProps = {
  notification: Notification;
  className?: string;
};

const descriptionMap: Record<Notification["type"], string> = {
  [NotificationType.COMMENT]: `commented on your video`,
  [NotificationType.REPLY]: `replied to your comment`,
  [NotificationType.VIEW]: `viewed your video`,
  [NotificationType.REACTION]: `reacted to your video`,
  [NotificationType.MENTION]: `mentioned you in a comment`,
};

export const NotificationItem = ({ notification, className }: NotificationItemProps) => {
  const commentTypes = [
    NotificationType.REPLY,
    NotificationType.COMMENT,
    NotificationType.REACTION
  ];
  const commentId = notification.data?.comment?.id;
  const link = commentTypes.includes(notification.type) && commentId
    ? `/s/${notification.videoId}/?comment=${commentId}`
    : `/s/${notification.videoId}`;

  return (
    <Link href={link}>
      <div
        className={clsx(
          "flex gap-3 p-4 border-r border-b border-l transition-colors cursor-pointer border-gray-3 hover:bg-gray-2",
          className
        )}
      >
        {/* Avatar */}
        <div className="relative flex-shrink-0">
          {notification.author.avatar ? (
            <img
              src={notification.author.avatar}
              alt={notification.author.name}
              className="object-cover rounded-full size-10"
            />
          ) : (
            <div className="flex justify-center items-center text-xl font-medium text-white bg-purple-500 rounded-full size-10">
              {notification.author.name.charAt(0)}
            </div>
          )}
          {notification.readAt === null && (
            <div className="absolute top-0 right-0 size-2.5 rounded-full bg-red-500 border-2 border-gray-1"></div>
          )}
        </div>

        {/* Content */}
        <div className="flex flex-col flex-1 justify-center">
          <div className="flex gap-1 items-center">
            <span className="font-medium text-gray-12 text-[13px]">{notification.author.name}</span>
            <span className="text-gray-10 text-[13px]">{descriptionMap[notification.type]}</span>
          </div>

          {notification.type === NotificationType.COMMENT || notification.type === NotificationType.REPLY && (
            <p className="mb-2 text-[13px] italic leading-4 text-gray-11 line-clamp-2">{notification.content}</p>
          )}
          <p className="text-xs text-gray-10">{moment(notification.createdAt).fromNow()}</p>
        </div>

        {/* Icon */}
        <div className="flex flex-shrink-0 items-center mt-1">
          {notification.type === NotificationType.COMMENT && (
            <FontAwesomeIcon icon={faComment} className="text-gray-10 size-4" />
          )}
          {notification.type === NotificationType.REPLY && (
            <FontAwesomeIcon icon={faReply} className="text-gray-10 size-4" />
          )}
          {notification.type === NotificationType.VIEW && (
            <FontAwesomeIcon icon={faEye} className="text-gray-10 size-4" />
          )}
          {notification.type === NotificationType.REACTION && (
            <span className="text-xl">{notification.content}</span>
          )}
        </div>
      </div>
    </Link>
  );
};
