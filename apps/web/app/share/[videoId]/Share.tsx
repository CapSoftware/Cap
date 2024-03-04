"use client";

import moment from "moment";
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
        <ShareHeader data={data} />
        <ShareVideo data={data} />
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl">{data.name}</h1>
            <p className="text-gray-400">
              about {moment(data.createdAt).fromNow()}
            </p>
          </div>
          <div className="flex">
            <Toolbar />
          </div>
        </div>
      </div>
    </div>
  );
};
