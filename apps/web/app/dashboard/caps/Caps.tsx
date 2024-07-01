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
  Trash,
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
import { debounce } from "lodash";

type videoData = {
  id: string;
  ownerId: string;
  name: string;
  createdAt: Date;
  totalComments: number;
  totalReactions: number;
}[];

export const Caps = ({ data, count }: { data: videoData; count: number }) => {
  const { refresh } = useRouter();
  const params = useSearchParams();
  const page = Number(params.get("page")) || 1;
  console.log("page: ", page);
  const [analytics, setAnalytics] = useState<Record<string, number>>({});
  const { user } = useSharedContext();
  const limit = 16;
  const totalPages = Math.ceil(count / limit);
  const [isEditing, setIsEditing] = useState<null | string>(null);
  const [titles, setTitles] = useState<Record<string, string>>({});

  const handleTitleBlur = async ({ id }: { id: string }) => {
    setIsEditing(id);

    if (!titles[id]) {
      setIsEditing(null);
      return;
    }

    const response = await fetch(
      `${process.env.NEXT_PUBLIC_URL}/api/video/title`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: titles[id], videoId: id }),
      }
    );
    if (!response.ok) {
      toast.error("Failed to update title - please try again.");
      return;
    }

    toast.success("Video title updated");

    setIsEditing(null);
  };

  const handleTitleKeyDown = debounce(
    async ({ key, id }: { key: string; id: string }) => {
      if (key === "Enter") {
        handleTitleBlur({ id });
      }
    },
    300
  );

  useEffect(() => {
    const fetchAnalytics = async () => {
      const analyticsData: Record<string, number> = {};

      for (const video of data) {
        const response = await fetch(
          `/api/video/analytics?videoId=${video.id}`,
          {
            cache: "force-cache",
          }
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

  const deleteCap = async (videoId: string) => {
    if (
      !window.confirm(
        "Are you sure you want to delete this Cap? It cannot be undone."
      )
    ) {
      return;
    }

    const response = await fetch(`/api/video/delete?videoId=${videoId}`, {
      method: "DELETE",
    });

    if (response.ok) {
      refresh();
      toast.success("Cap deleted successfully");
    } else {
      toast.error("Failed to delete Cap - please try again later");
    }
  };

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
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6">
            {data.map((cap, index) => {
              const videoAnalytics = analytics[cap.id];

              return (
                <div
                  key={index}
                  className="rounded-xl border border-filler overflow-hidden relative"
                >
                  <div className="absolute top-2 right-2 space-y-2 z-20">
                    <button
                      type="button"
                      className="cursor-pointer border border-gray-300 relative bg-white hover:bg-gray-300 w-6 h-6 m-0 p-0 rounded-full flex items-center justify-center transition-all"
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
                    <button
                      type="button"
                      className="cursor-pointer border border-gray-300 relative bg-white hover:bg-gray-300 w-6 h-6 m-0 p-0 rounded-full flex items-center justify-center transition-all"
                      onClick={async () => {
                        await deleteCap(cap.id);
                      }}
                    >
                      <Trash className="w-3 h-3" />
                    </button>
                  </div>
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
                  <div className="flex flex-col p-4">
                    {isEditing !== null && isEditing === cap.id ? (
                      <textarea
                        rows={1}
                        value={titles[cap.id] || cap.name}
                        onChange={(e) =>
                          setTitles({
                            ...titles,
                            [cap.id]: e.target.value,
                          })
                        }
                        onBlur={() => {
                          handleTitleBlur({ id: cap.id });
                        }}
                        onKeyDown={(e) => {
                          handleTitleKeyDown({ key: e.key, id: cap.id });
                        }}
                        autoFocus
                        className="font-medium box-border"
                      />
                    ) : (
                      <p
                        className="font-medium"
                        onClick={() => {
                          if (
                            user !== null &&
                            user.id.toString() === cap.ownerId
                          ) {
                            setIsEditing(cap.id);
                          }
                        }}
                      >
                        {titles[cap.id] || cap.name}
                      </p>
                    )}
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
