"use client";

import { videos } from "@cap/database/schema";
import { ShareHeader } from "./_components/ShareHeader";
import { ShareVideo } from "./_components/ShareVideo";

export const Share = async ({ data }: { data: typeof videos.$inferSelect }) => {
  return (
    <div className="wrapper py-6">
      <div className="space-y-8">
        <ShareHeader title={data.name} />
        <ShareVideo
          data={{ title: data.name, created: data.createdAt.toISOString() }}
        />
      </div>
    </div>
  );
};
