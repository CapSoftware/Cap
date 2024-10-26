"use client";

import { ShareHeader } from "./_components/ShareHeader";
import { ShareVideo } from "./_components/ShareVideo";
import { comments as commentsSchema, videos } from "@cap/database/schema";
import { userSelectProps } from "@cap/database/auth/session";
import { Toolbar } from "./_components/Toolbar";
import { Logo } from "@cap/ui";

// Add this type definition at the top of the file
type CommentWithAuthor = typeof commentsSchema.$inferSelect & {
  authorName: string | null;
};

// million-ignore
export const Share = ({
  data,
  user,
  comments,
  individualFiles,
}: {
  data: typeof videos.$inferSelect;
  user: typeof userSelectProps | null;
  comments: CommentWithAuthor[];
  individualFiles: {
    fileName: string;
    url: string;
  }[];
}) => {
  return (
    <>
      <div className="flex flex-col h-screen max-w-6xl mx-auto px-4">
        <div className="flex-shrink-0 py-4">
          <ShareHeader
            data={data}
            user={user}
            individualFiles={individualFiles}
          />
        </div>
        <div className="md:flex-grow md:flex md:flex-col min-h-0">
          <div className="flex-grow relative">
            <div className="md:absolute inset-0">
              <ShareVideo data={data} user={user} comments={comments} />
            </div>
          </div>
          <div className="flex-shrink-0 py-4">
            <Toolbar data={data} user={user} />
          </div>
        </div>
      </div>
      <div className="flex-shrink-0 py-4">
        <a
          target="_blank"
          href={`${process.env.NEXT_PUBLIC_URL}?ref=video_${data.id}`}
          className="flex items-center justify-center space-x-2 py-2 px-4 bg-gray-100 border border-gray-200 rounded-full mx-auto w-fit"
        >
          <span className="text-sm">Recorded with</span>
          <Logo className="w-14 h-auto" />
        </a>
      </div>
    </>
  );
};
