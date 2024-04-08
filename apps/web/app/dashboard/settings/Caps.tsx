"use client";
import { Button } from "@cap/ui";
import moment from "moment";
import { VideoThumbnail } from "@/components/VideoThumbnail";
import { useRouter } from "next/navigation";
import toast from "react-hot-toast";
import { EyeIcon, LinkIcon, MessageSquareIcon, SmileIcon } from "lucide-react";
import { useEffect, useState } from "react";

type videoData = {
  id: string;
  ownerId: string;
  name: string;
  createdAt: Date;
  totalComments: number;
  totalReactions: number;
}[];

export const Caps = ({ data }: { data: videoData }) => {
  const { push } = useRouter();
  const [analytics, setAnalytics] = useState<Record<string, number>>({});

  useEffect(() => {
    const fetchAnalytics = async () => {
      const analyticsData: Record<string, number> = {};

      for (const video of data) {
        const response = await fetch(
          `/api/video/analytics?videoId=${video.id}`
        );
        const data = await response.json();

        if (!data.count) {
          analyticsData[video.id] = 0;
        } else {
          analyticsData[video.id] = data.count;
        }
      }
      setAnalytics(analyticsData);
    };

    fetchAnalytics();
  }, [data]);

  return (
    <div className="py-12">
      {data.length === 0 ? (
        <div className="min-h-full h-full flex flex-col items-center justify-center">
          <div className="w-full max-w-md mx-auto">
            <img
              className="w-full h-auto"
              src="/illustrations/person-microphone.svg"
              alt="Person using microphone"
            />
          </div>
          <div className="text-center">
            <h1 className="text-2xl font-semibold mb-3">
              Record your first Cap.
            </h1>
            <p className="text-xl max-w-md">
              Craft your narrative with a Cap—get projects done quicker.
            </p>
            <Button
              onClick={() => {
                push("/download");
              }}
              size="default"
              className="mt-8 relative"
              variant="default"
            >
              Download Cap
            </Button>
          </div>
        </div>
      ) : (
        <>
          <div className="mb-8">
            <h1 className="text-3xl font-semibold mb-1">My Caps</h1>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
            {data.map((cap, index) => {
              const videoAnalytics = analytics[cap.id];

              return (
                <div
                  key={index}
                  className="rounded-xl border border-filler overflow-hidden relative"
                >
                  <button
                    type="button"
                    className="cursor-pointer border border-gray-300 absolute top-2 right-2 z-20 bg-white hover:bg-gray-300 w-6 h-6 m-0 p-0 rounded-full flex items-center justify-center transition-all"
                    onClick={() => {
                      if (
                        process.env.NEXT_PUBLIC_IS_CAP &&
                        process.env.NEXT_ENV === "production"
                      ) {
                        navigator.clipboard.writeText(
                          `https://cap.link/${cap.id}`
                        );
                      } else {
                        navigator.clipboard.writeText(
                          `${process.env.NEXT_PUBLIC_URL}/s/${cap.id}`
                        );
                      }
                      toast.success("Link copied to clipboard!");
                    }}
                  >
                    <LinkIcon className="w-3 h-3" />
                  </button>
                  <a
                    className="group block"
                    href={
                      process.env.NEXT_PUBLIC_IS_CAP &&
                      process.env.NEXT_ENV === "production"
                        ? `https://cap.link/${cap.id}`
                        : `${process.env.NEXT_PUBLIC_URL}/s/${cap.id}`
                    }
                  >
                    <VideoThumbnail
                      userId={cap.ownerId}
                      videoId={cap.id}
                      alt={`${cap.name} Thumbnail`}
                    />
                  </a>
                  <div className="p-4">
                    <p className="font-medium">{cap.name}</p>
                    <p className="text-sm text-gray-400">
                      {moment(cap.createdAt).fromNow()}
                    </p>
                    <div className="flex items-center space-x-3 mt-2 text-sm text-gray-600">
                      <div className="flex items-center">
                        <EyeIcon className="w-4 h-4 mr-1" />
                        <span className="text-gray-600">
                          {videoAnalytics ?? "-"}
                        </span>
                      </div>
                      <div className="flex items-center">
                        <MessageSquareIcon className="w-4 h-4 mr-1" />
                        <span className="text-gray-600">
                          {cap.totalComments}
                        </span>
                      </div>
                      <div className="flex items-center">
                        <SmileIcon className="w-4 h-4 mr-1" />
                        <span className="text-gray-600">
                          {cap.totalReactions}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
};
