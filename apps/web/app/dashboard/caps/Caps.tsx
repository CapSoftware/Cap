"use client";
import { Button } from "@cap/ui";
import moment from "moment";
import { VideoThumbnail } from "@/components/VideoThumbnail";
import { useRouter, useSearchParams } from "next/navigation";
import toast from "react-hot-toast";
import {
  EyeIcon,
  LinkIcon,
  MessageSquareIcon,
  SmileIcon,
  Video,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useSharedContext } from "@/app/dashboard/_components/DynamicSharedLayout";
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@cap/ui";

type videoData = {
  id: string;
  ownerId: string;
  name: string;
  createdAt: Date;
  totalComments: number;
  totalReactions: number;
}[];

export const Caps = ({ data, count }: { data: videoData; count: number }) => {
  const { push } = useRouter();
  const params = useSearchParams();
  const page = Number(params.get("page")) || 1;
  console.log("page: ", page);
  const [analytics, setAnalytics] = useState<Record<string, number>>({});
  const { user } = useSharedContext();
  const limit = 16;
  const totalPages = Math.ceil(count / limit);

  const nextPage = () => {
    push(`/dashboard/caps?page=${page + 1}`);
  };

  const prevPage = () => {
    if (page > 1) {
      push(`/dashboard/caps?page=${page - 1}`);
    }
  };

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
    <div>
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
              <span className="block text-gray-500">Hey, {user?.name}!</span>
              <span className="block">Record your first Cap.</span>
            </h1>
            <p className="text-xl max-w-md">
              Craft your narrative with a Cap—get projects done quicker.
            </p>
            <Button
              href="/record"
              size="default"
              className="mt-8 relative"
              variant="default"
            >
              <Video className="flex-shrink-0 w-6 h-6" aria-hidden="true" />
              <span className="ml-2.5 text-white">Record a Cap</span>
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-8">
          <div>
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
          <div>
            <Pagination>
              <PaginationContent>
                {page > 1 && (
                  <PaginationItem>
                    <PaginationPrevious
                      href={
                        process.env.NEXT_PUBLIC_URL +
                        `/dashboard/caps?page=${page === 1 ? page : page - 1}`
                      }
                    />
                  </PaginationItem>
                )}
                <PaginationItem>
                  <PaginationLink
                    href={
                      process.env.NEXT_PUBLIC_URL + `/dashboard/caps?page=1`
                    }
                    isActive={page === 1}
                  >
                    1
                  </PaginationLink>
                </PaginationItem>
                {page !== 1 && (
                  <PaginationItem>
                    <PaginationLink
                      href={
                        process.env.NEXT_PUBLIC_URL +
                        `/dashboard/caps?page=${page}`
                      }
                      isActive={true}
                    >
                      {page}
                    </PaginationLink>
                  </PaginationItem>
                )}
                {totalPages > page + 1 && (
                  <PaginationItem>
                    <PaginationLink
                      href={
                        process.env.NEXT_PUBLIC_URL +
                        `/dashboard/caps?page=${page + 1}`
                      }
                      isActive={page === page + 1}
                    >
                      {page + 1}
                    </PaginationLink>
                  </PaginationItem>
                )}
                {page > 2 && <PaginationEllipsis />}
                <PaginationItem>
                  <PaginationNext
                    href={
                      process.env.NEXT_PUBLIC_URL +
                      `/dashboard/caps?page=${
                        page === totalPages ? page : page + 1
                      }`
                    }
                  />
                </PaginationItem>
              </PaginationContent>
            </Pagination>
          </div>
        </div>
      )}
    </div>
  );
};
