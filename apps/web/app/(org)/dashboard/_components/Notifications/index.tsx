"use client";

import { faBellSlash } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { type MotionProps, motion } from "framer-motion";
import { forwardRef, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useDashboardContext } from "@/app/(org)/dashboard/Contexts";
import { useApiClient } from "@/utils/web-api";
import {
	FilterLabels,
	type FilterType,
	matchNotificationFilter,
} from "./Filter";
import { FilterTabs } from "./FilterTabs";
import { NotificationFooter } from "./NotificationFooter";
import { NotificationHeader } from "./NotificationHeader";
import { NotificationItem } from "./NotificationItem";
import { NotificationsSkeleton } from "./Skeleton";

type NotificationsProps = MotionProps & React.HTMLAttributes<HTMLDivElement>;

const Notifications = forwardRef<HTMLDivElement, NotificationsProps>(
	(props, ref) => {
		const { className } = props;
		const { activeOrganization } = useDashboardContext();
		const [activeFilter, setActiveFilter] = useState<FilterType>("all");
		const scrollRef = useRef<HTMLDivElement>(null);
		const api = useApiClient();

		const notifications = useQuery({
			queryKey: ["notifications", activeOrganization?.organization.id],
			queryFn: async () => {
				const resp = await api.notifications.get();
				if (resp.status !== 200) {
					toast.error("Failed to fetch notifications");
					return { notifications: [], count: {} };
				}

				return resp.body;
			},
			refetchOnWindowFocus: false,
		});

		const filteredNotifications = useMemo(
			() =>
				notifications.data?.notifications.filter((notification) =>
					matchNotificationFilter(activeFilter, notification.type),
				),
			[notifications.data, activeFilter],
		);

		const isNotificationTabEmpty = useMemo(() => {
			return filteredNotifications?.length === 0;
		}, [filteredNotifications]);

		useEffect(() => {
			if (!scrollRef.current) return;
			const handleKeyDown = (e: KeyboardEvent) => {
				const target = e.target as HTMLElement;
				// Ignore typing/navigation inside inputs/editable fields
				if (target.closest("input, textarea, [contenteditable='true']")) return;
				// Only handle when event originates within the panel's scroll area
				if (!scrollRef.current?.contains(target)) return;
				if (e.key === "ArrowUp") {
					e.preventDefault();
					scrollRef.current?.scrollBy({ top: -100, behavior: "smooth" });
				} else if (e.key === "ArrowDown") {
					e.preventDefault();
					scrollRef.current?.scrollBy({ top: 100, behavior: "smooth" });
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
				initial={{ opacity: 0, y: 4, scale: 0.98, display: "none" }}
				animate={{ opacity: 1, y: 0, scale: 1, display: "flex" }}
				exit={{ opacity: 0, y: 4, scale: 0.98, display: "none" }}
				transition={{ ease: "easeOut", duration: 0.2 }}
				onClick={(e) => e.stopPropagation()}
				className={clsx(
					"flex absolute right-0 top-12 flex-col rounded-xl origin-top-right cursor-default w-[400px] h-[450px] bg-gray-1",
					className,
				)}
				{...props}
			>
				<NotificationHeader />
				<FilterTabs
					loading={notifications.isPending}
					count={notifications.data?.count}
					activeFilter={activeFilter}
					setActiveFilter={setActiveFilter}
				/>
				<div
					ref={scrollRef}
					className="flex isolate flex-col flex-1 h-full divide-y custom-scroll border-x border-gray-3 divide-gray-3"
				>
					{notifications.isPending ? (
						<NotificationsSkeleton />
					) : isNotificationTabEmpty ? (
						<div className="flex flex-col gap-3 justify-center items-center h-full">
							<FontAwesomeIcon
								icon={faBellSlash}
								className="text-gray-10 size-10"
							/>
							<p className="text-gray-10 text-[13px]">
								No notifications{" "}
								{activeFilter !== "all" && (
									<>
										for{" "}
										<span className="font-medium text-gray-11">
											{FilterLabels[activeFilter]}
										</span>
									</>
								)}
							</p>
						</div>
					) : (
						filteredNotifications?.map((notification) => (
							<NotificationItem
								key={notification.id}
								notification={notification}
							/>
						))
					)}
					<div className="flex-1 border-t border-gray-3" />
				</div>

				<NotificationFooter />
			</motion.div>
		);
	},
);

export default Notifications;
