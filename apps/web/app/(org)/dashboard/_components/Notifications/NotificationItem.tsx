import { faComment, faEye, faReply } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import clsx from "clsx";
import Link from "next/link";
import moment from "moment";
import { NotificationType } from "@/lib/Notification";
import { Notification as APINotification } from "@cap/web-api-contract";

type NotificationItemProps = {
  notification: APINotification;
  className?: string;
};

const descriptionMap: Record<NotificationType, string> = {
  comment: `commented on your video`,
  reply: `replied to your comment`,
  view: `viewed your video`,
  reaction: `reacted to your video`,
  // mention: `mentioned you in a comment`,
};

export const NotificationItem = ({
  notification,
  className,
}: NotificationItemProps) => {
  const link = getLink(notification);

  return (
    <Link
      href={link}
      className={clsx(
        "flex gap-3 p-4 transition-colors cursor-pointer border-gray-3 hover:bg-gray-2",
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
          <span className="font-medium text-gray-12 text-[13px]">
            {notification.author.name}
          </span>
          <span className="text-gray-10 text-[13px]">
            {descriptionMap[notification.type]}
          </span>
        </div>

        {notification.type === "comment" ||
          (notification.type === "reply" && (
            <p className="mb-2 text-[13px] italic leading-4 text-gray-11 line-clamp-2">
              {notification.comment.content}
            </p>
          ))}
        <p className="text-xs text-gray-10">
          {moment(notification.createdAt).fromNow()}
        </p>
      </div>

      {/* Icon */}
      <div className="flex flex-shrink-0 items-center mt-1">
        {notification.type === "comment" && (
          <FontAwesomeIcon icon={faComment} className="text-gray-10 size-4" />
        )}
        {notification.type === "reply" && (
          <FontAwesomeIcon icon={faReply} className="text-gray-10 size-4" />
        )}
        {notification.type === "view" && (
          <FontAwesomeIcon icon={faEye} className="text-gray-10 size-4" />
        )}
        {notification.type === "reaction" && (
          <span className="text-xl">{notification.comment.content}</span>
        )}
      </div>
    </Link>
  );
};

function getLink(notification: APINotification) {
  switch (notification.type) {
    case "comment":
    case "reply":
    case "reaction":
      // case "mention":
      return `/s/${notification.videoId}/?comment=${notification.comment.id}`;
    default:
      return `/s/${notification.videoId}`;
  }
}
