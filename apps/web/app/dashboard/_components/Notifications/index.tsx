import clsx from "clsx";
import { motion, MotionProps } from "framer-motion";
import { forwardRef, useState } from "react";
import { FilterTabs } from "./FilterTabs";
import { NotificationFooter } from "./NotificationFooter";
import { NotificationHeader } from "./NotificationHeader";
import { NotificationItem } from "./NotificationItem";
import { mockNotifications } from "./mockData";
import { filterToNotificationType, FilterType } from "./types";

type NotificationsProps = MotionProps & React.HTMLAttributes<HTMLDivElement>;

const Notifications = forwardRef<HTMLDivElement, NotificationsProps>(
  (props, ref) => {
    const { className } = props;
    const [activeFilter, setActiveFilter] = useState<FilterType>(FilterType.ALL);

    const filteredNotifications = mockNotifications.filter(notification => {
      // If the active filter is ALL or if the notification type matches the mapped type
      const mappedType = filterToNotificationType[activeFilter];
      return mappedType === null || notification.type === mappedType;
    });

    return (
      <motion.div
        ref={ref}
        initial={{ opacity: 0, y: 4, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 4, scale: 0.98 }}
        transition={{ ease: "easeOut", duration: 0.2 }}
        onClick={(e) => e.stopPropagation()}
        className={clsx(
          "flex absolute right-0 top-12 flex-col rounded-xl cursor-default w-[400px] h-[450px] bg-gray-1",
          className
        )}
        {...props}
      >
        <NotificationHeader />
        <FilterTabs activeFilter={activeFilter} setActiveFilter={setActiveFilter} />
        <div className="isolate flex-1 h-full custom-scroll">
          {filteredNotifications.map((notification, idx) => (
            <NotificationItem
              key={notification.id}
              notification={notification}
              isFirst={idx === 0}
              isLast={idx === filteredNotifications.length - 1}
            />
          ))}
        </div>

        <NotificationFooter />
      </motion.div>
    );
  }
);

export default Notifications;
