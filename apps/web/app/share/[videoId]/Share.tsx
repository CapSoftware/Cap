"use client";

import { ShareHeader } from "./_components/ShareHeader";
import { ShareVideo } from "./_components/ShareVideo";
import { videos } from "@cap/database/schema";
import { userSelectProps } from "@cap/database/auth/session";
import { Toolbar } from "./_components/Toolbar";
// million-ignore
export const Share = ({
  data,
  user,
}: {
  data: typeof videos.$inferSelect;
  user: typeof userSelectProps | null;
}) => {
  return (
    <div className="wrapper py-5">
      <div className="space-y-6">
        <ShareHeader data={data} user={user} />
        <ShareVideo data={data} user={user} />
        <div className="flex justify-center">
          <Toolbar />
        </div>
      </div>
    </div>
  );
};
