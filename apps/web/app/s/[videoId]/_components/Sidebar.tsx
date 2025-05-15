"use client";

import { userSelectProps } from "@cap/database/auth/session";
import { comments as commentsSchema, videos } from "@cap/database/schema";
import { classNames } from "@cap/utils";
import { AnimatePresence, motion } from "framer-motion";
import { useState } from "react";
import { Activity } from "./tabs/Activity";
import { Settings } from "./tabs/Settings";
import { Transcript } from "./tabs/Transcript";

type TabType = "activity" | "transcript" | "settings";

type CommentType = typeof commentsSchema.$inferSelect & {
  authorName?: string | null;
};

type VideoWithOrganizationInfo = typeof videos.$inferSelect & {
  organizationMembers?: string[];
  organizationId?: string;
};

interface Analytics {
  views: number;
  comments: number;
  reactions: number;
}

interface SidebarProps {
  data: VideoWithOrganizationInfo;
  user: typeof userSelectProps | null;
  comments: CommentType[];
  analytics: Analytics;
  onSeek?: (time: number) => void;
  videoId: string;
}

const TabContent = motion.div;

const tabVariants = {
  enter: (direction: number) => ({
    x: direction > 0 ? 1000 : -1000,
    opacity: 0,
  }),
  center: {
    zIndex: 1,
    x: 0,
    opacity: 1,
  },
  exit: (direction: number) => ({
    zIndex: 0,
    x: direction < 0 ? 1000 : -1000,
    opacity: 0,
  }),
};

const tabTransition = {
  x: { type: "spring", stiffness: 300, damping: 30 },
  opacity: { duration: 0.2 },
};

export const Sidebar: React.FC<SidebarProps> = ({
  data,
  user,
  comments,
  analytics,
  onSeek,
  videoId,
}) => {
  const isOwnerOrMember: boolean = Boolean(
    user?.id === data.ownerId ||
      (data.organizationId &&
        data.organizationMembers?.includes(user?.id ?? ""))
  );

  const [activeTab, setActiveTab] = useState<TabType>("activity");
  const [[page, direction], setPage] = useState([0, 0]);

  const tabs = [
    { id: "activity", label: "Comments" },
    { id: "transcript", label: "Transcript" },
  ];

  const paginate = (newDirection: number, tabId: TabType) => {
    const currentIndex = tabs.findIndex((tab) => tab.id === activeTab);
    const newIndex = tabs.findIndex((tab) => tab.id === tabId);
    const direction = newIndex > currentIndex ? 1 : -1;

    setPage([page + direction, direction]);
    setActiveTab(tabId);
  };

  const renderTabContent = () => {
    switch (activeTab) {
      case "activity":
        return (
          <Activity
            analytics={analytics}
            comments={comments}
            user={user}
            onSeek={onSeek}
            videoId={videoId}
            isOwnerOrMember={isOwnerOrMember}
          />
        );
      case "transcript":
        return <Transcript data={data} onSeek={onSeek} />;
      case "settings":
        return <Settings />;
      default:
        return null;
    }
  };

  return (
    <div className="new-card-style overflow-hidden h-[calc(100vh-16rem)] lg:h-full flex flex-col lg:aspect-video">
      <div className="flex-none">
        <div className="flex border-b border-gray-200">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() =>
                paginate(tab.id === activeTab ? 0 : 1, tab.id as TabType)
              }
              className={classNames(
                "flex-1 px-6 py-3 text-sm font-medium relative transition-colors duration-200",
                "hover:bg-gray-1",
                activeTab === tab.id ? "bg-gray-3" : ""
              )}
            >
              <span
                className={classNames(
                  "relative z-10",
                  activeTab === tab.id ? "text-gray-12" : "text-gray-9"
                )}
              >
                {tab.label}
              </span>
              {activeTab === tab.id && (
                <motion.div
                  layoutId="activeTab"
                  className="absolute bottom-0 left-0 right-0 h-0.5 bg-blue-500"
                  initial={false}
                  transition={{
                    type: "spring",
                    stiffness: 500,
                    damping: 30,
                  }}
                />
              )}
            </button>
          ))}
        </div>
      </div>
      <div className="flex-1 min-h-0">
        <div className="h-full relative overflow-hidden">
          <AnimatePresence initial={false} custom={direction}>
            <TabContent
              key={activeTab}
              custom={direction}
              variants={tabVariants}
              initial="enter"
              animate="center"
              exit="exit"
              transition={tabTransition}
              className="absolute inset-0 overflow-auto"
            >
              <div className="h-full">{renderTabContent()}</div>
            </TabContent>
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
};
