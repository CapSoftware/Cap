"use client";

import clsx from "clsx";
import { motion, MotionProps } from "framer-motion";
import { forwardRef, useEffect, useRef, useMemo, useState } from "react";
import { FilterTabs } from "./FilterTabs";
import { NotificationFooter } from "./NotificationFooter";
import { NotificationHeader } from "./NotificationHeader";
import { NotificationItem } from "./NotificationItem";
import { filterToNotificationType, FilterType } from "./types";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { NotificationData } from "./types";
import { NotificationsSkeleton } from "./Skeleton";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faBellSlash } from "@fortawesome/free-solid-svg-icons";
import { useDashboardContext } from "@/app/(org)/dashboard/Contexts";

type NotificationsProps = MotionProps & React.HTMLAttributes<HTMLDivElement>;

const Notifications = forwardRef<HTMLDivElement, NotificationsProps>(
  (props, ref) => {
    const { className } = props;
    const { activeOrganization } = useDashboardContext();
    const [activeFilter, setActiveFilter] = useState<FilterType>(FilterType.ALL);
    const scrollRef = useRef<HTMLDivElement>(null);

    const { data: notificationsData, isLoading } = useQuery<NotificationData>({
      queryKey: ["notifications", activeOrganization?.organization.id],
      queryFn: async () => {
        const response = await fetch("/api/notifications");
        if (!response.ok) {
          toast.error("Failed to fetch notifications");
          return [];
        }
        const data = await response.json();
        return data;
      },
      refetchOnWindowFocus: false,
    });

    const filteredNotifications = useMemo(() => notificationsData?.notifications.filter(notification => {
      const mappedType = filterToNotificationType[activeFilter];
      return mappedType === null || notification.type === mappedType;
    }), [notificationsData, activeFilter]);

    const isNotificationTabEmpty = useMemo(() => {
      return filteredNotifications?.length === 0;
    }, [filteredNotifications]);


    useEffect(() => {
      if (!scrollRef.current) return;
      const handleKeyDown = (e: KeyboardEvent) => {
        if (e.key === "ArrowUp") {
          scrollRef.current?.scrollBy({
            top: -100,
            behavior: "smooth"
          });
        } else if (e.key === "ArrowDown") {
          scrollRef.current?.scrollBy({
            top: 100,
            behavior: "smooth"
          });
        }
      };
      document.addEventListener("keydown", handleKeyDown);
      return () => {
        document.removeEventListener("keydown", handleKeyDown);
      };
    }, []);

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
        <FilterTabs loading={isLoading} count={notificationsData?.count} activeFilter={activeFilter} setActiveFilter={setActiveFilter} />
        <div ref={scrollRef} className="isolate flex-1 h-full custom-scroll">
          {isLoading ? (
            <NotificationsSkeleton />
          ) : (
            isNotificationTabEmpty ? (
              <div className="flex flex-col gap-3 justify-center items-center h-full">
                <FontAwesomeIcon icon={faBellSlash} className="text-gray-10 size-10" />
                <p className="text-gray-10 text-[13px]">No notifications for <span className="font-medium text-gray-11">{activeFilter}</span></p>
              </div>
            ) : (
              filteredNotifications?.map((notification) => (
                <NotificationItem
                  key={notification.id}
                  notification={notification}
                />
              ))
            )
          )}
        </div>

        <NotificationFooter />
      </motion.div>
    );
  }
);

export default Notifications;
