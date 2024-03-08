"use client";

import { ShareHeader } from "./_components/ShareHeader";
import { ShareVideo } from "./_components/ShareVideo";
import { comments as commentsSchema, videos } from "@cap/database/schema";
import { userSelectProps } from "@cap/database/auth/session";
import { Toolbar } from "./_components/Toolbar";
// million-ignore
export const Share = ({
  data,
  user,
  comments,
}: {
  data: typeof videos.$inferSelect;
  user: typeof userSelectProps | null;
  comments: (typeof commentsSchema.$inferSelect)[];
}) => {
  return (
    <div className="wrapper py-8">
      <div className="space-y-6">
        <ShareHeader data={data} user={user} />
        <ShareVideo data={data} user={user} comments={comments} />
        <div className="flex justify-center">
          <Toolbar data={data} user={user} />
        </div>
      </div>
    </div>
  );
};
