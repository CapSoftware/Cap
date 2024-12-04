"use client";

import { useState } from "react";
import { Activity } from "./tabs/Activity";
import { Transcript } from "./tabs/Transcript";
import { Settings } from "./tabs/Settings";
import { comments as commentsSchema, videos } from "@cap/database/schema";
import { userSelectProps } from "@cap/database/auth/session";
import { classNames } from "@cap/utils";

type TabType = "activity" | "transcript" | "settings";

type CommentType = typeof commentsSchema.$inferSelect & {
  authorName?: string | null;
};

type VideoWithSpaceInfo = typeof videos.$inferSelect & {
  spaceMembers?: string[];
  spaceId?: string;
};

interface Analytics {
  views: number;
  comments: number;
  reactions: number;
}

interface SidebarProps {
  data: VideoWithSpaceInfo;
  user: typeof userSelectProps | null;
  comments: CommentType[];
  analytics: Analytics;
  onSeek?: (time: number) => void;
  videoId: string;
}

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
      (data.spaceId && data.spaceMembers?.includes(user?.id ?? ""))
  );

  const [activeTab, setActiveTab] = useState<TabType>("activity");

  const tabs = [
    { id: "activity", label: "Comments" },
    { id: "transcript", label: "Transcript" },
  ];

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
    <div className="new-card-style overflow-hidden h-full flex flex-col lg:aspect-video">
      <div className="flex-none">
        <div className="flex border-b border-gray-200">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id as TabType)}
              className={classNames(
                "flex-1 px-6 py-3 text-sm font-medium text-gray-600 hover:text-gray-900 relative",
                activeTab === tab.id && "text-gray-900"
              )}
            >
              {tab.label}
              {activeTab === tab.id && (
                <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-blue-500" />
              )}
            </button>
          ))}
        </div>
      </div>
      <div className="flex-1 min-h-0">{renderTabContent()}</div>
    </div>
  );
};
