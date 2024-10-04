"use client";

import { ShareHeader } from "./_components/ShareHeader";
import { ShareVideo } from "./_components/ShareVideo";
import { comments as commentsSchema, videos } from "@cap/database/schema";
import { userSelectProps } from "@cap/database/auth/session";
import { Toolbar } from "./_components/Toolbar";
import { Logo } from "@cap/ui";

export const Share = ({
  data,
  user,
  comments,
  individualFiles,
}: {
  data: typeof videos.$inferSelect;
  user: typeof userSelectProps | null;
  comments: (typeof commentsSchema.$inferSelect)[];
  individualFiles: {
    fileName: string;
    url: string;
  }[];
}) => {
  return (
    <div className="wrapper py-8">
      <div className="space-y-6">
        <ShareHeader
          data={data}
          user={user}
          individualFiles={individualFiles}
        />
        <ShareVideo data={data} user={user} comments={comments} />
        <div className="flex justify-center mb-4">
          <Toolbar data={data} user={user} />
        </div>
        <div className="flex justify-center items-center">
          <a
            target="_blank"
            href={`${process.env.NEXT_PUBLIC_URL}?ref=video_${data.id}`}
            className="flex items-center justify-center space-x-2 py-2 px-4 bg-gray-100 border border-gray-200 rounded-full mx-0"
          >
            <span className="text-sm">Recorded with</span>
            <Logo className="w-14 h-auto" />
          </a>
        </div>
      </div>
    </div>
  );
};
