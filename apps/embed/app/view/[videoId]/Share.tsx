"use client";

import { ShareVideo } from "./_components/ShareVideo";
import { comments as commentsSchema, videos } from "@cap/database/schema";
import { userSelectProps } from "@cap/database/auth/session";

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
    <div>
      <div className="space-y-6">
        <ShareVideo data={data} user={user} comments={comments} />
      </div>
    </div>
  );
};
