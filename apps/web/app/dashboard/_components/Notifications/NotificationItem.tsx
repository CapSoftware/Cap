import { faComment, faEye, faVideo } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import clsx from "clsx";
import { Notification, NotificationType } from "./types";

type NotificationItemProps = {
  notification: Notification;
  isLast: boolean;
  isFirst: boolean;
};

export const NotificationItem = ({ notification, isLast, isFirst }: NotificationItemProps) => {
  return (
    <div 
      className={clsx(
        "flex gap-3 p-4 cursor-pointer border-l border-r transition-colors border-gray-3 hover:bg-gray-2", 
        !isLast && "border-b",
        isFirst && "border-b"
      )}
    >
      {/* Avatar */}
      <div className="relative flex-shrink-0">
        {notification.user.avatar ? (
          <img 
            src={notification.user.avatar} 
            alt={notification.user.name}
            className="object-cover rounded-full size-10"
          />
        ) : (
          <div className="flex justify-center items-center text-xl font-medium text-white bg-purple-500 rounded-full size-10">
            {notification.user.name.charAt(0)}
          </div>
        )}
        {notification.user.hasUnread && (
          <div className="absolute top-0 right-0 size-2.5 rounded-full bg-red-500 border-2 border-gray-1"></div>
        )}
      </div>
      
      {/* Content */}
      <div className="flex flex-col flex-1">
        <div className="flex gap-1 items-center">
          <span className="font-medium text-gray-12 text-[13px]">{notification.user.name}</span>
          <span className="text-gray-10 text-[13px]">{notification.content}</span>
        </div>
        <span className="text-xs text-gray-10">{notification.time}</span>
        
        {notification.additionalText && (
          <p className="mt-2 text-xs italic leading-4 text-gray-11">{notification.additionalText}</p>
        )}
      </div>
      
      {/* Icon */}
      <div className="flex-shrink-0 self-start mt-1">
        {notification.type === NotificationType.RECORDING && (
          <FontAwesomeIcon icon={faVideo} className="text-gray-10 size-4" />
        )}
        {notification.type === NotificationType.COMMENT && (
          <FontAwesomeIcon icon={faComment} className="text-gray-10 size-4" />
        )}
        {notification.type === NotificationType.VIEW && (
          <FontAwesomeIcon icon={faEye} className="text-gray-10 size-4" />
        )}
        {notification.type === NotificationType.REACTION && (
          <span className="text-xl">🔥</span>
        )}
      </div>
    </div>
  );
};
