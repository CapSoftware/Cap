"use client";
import { Button } from "@cap/ui";
import moment from "moment";
import { VideoThumbnail } from "@/components/VideoThumbnail";
import { useRouter, useSearchParams } from "next/navigation";
import toast, { Toaster } from "react-hot-toast";
import {
  EyeIcon,
  LinkIcon,
  MessageSquareIcon,
  SmileIcon,
  Video,
  Trash,
  DownloadIcon,
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
import { playlistToMp4 } from "@/utils/video/ffmpeg/helpers";
import { Tooltip } from "react-tooltip";

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
  const [analytics, setAnalytics] = useState<Record<string, number>>({});
  const { user } = useSharedContext();
  const limit = 15;
  const totalPages = Math.ceil(count / limit);
  const [isEditing, setIsEditing] = useState<null | string>(null);
  const [isDownloading, setIsDownloading] = useState<null | string>(null);
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

  const downloadCap = async (videoId: string) => {
    if (isDownloading !== null) {
      toast.error(
        "You are already downloading a Cap. Please wait for it to finish downloading."
      );
      return;
    }

    setIsDownloading(videoId);

    toast
      .promise(
        (async () => {
          const video = data.find((cap) => cap.id === videoId);
          if (!video) {
            throw new Error("Video not found");
          }

          const videoName = video.name || "Cap Video";
          const mp4Blob = await playlistToMp4(user.id, video.id, video.name);
          const downloadUrl = window.URL.createObjectURL(mp4Blob);
          const a = document.createElement("a");
          a.style.display = "none";
          a.href = downloadUrl;
          a.download = `${videoName}.mp4`;
          document.body.appendChild(a);
          a.click();
          window.URL.revokeObjectURL(downloadUrl);
        })(),
        {
          loading: "Downloading Cap...",
          success: "Cap downloaded",
          error: "Failed to download Cap",
        }
      )
      .finally(() => {
        setIsDownloading(null);
      });
  };

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
          <div className="grid grid-cols-2 xl:grid-cols-3 gap-6">
            {data.map((cap, index) => {
              const videoAnalytics = analytics[cap.id];

              return (
                <div
                  key={index}
                  className="rounded-xl border border-filler relative"
                >
                  <div className="absolute top-2 right-2 space-y-2 z-20">
                    <button
                      type="button"
                      className="cursor-pointer border border-gray-300 relative bg-white hover:bg-gray-200 w-8 h-8 m-0 p-0 rounded-full flex items-center justify-center transition-all"
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
                      data-tooltip-id={cap.id + "_copy"}
                      data-tooltip-content="Copy shareable Cap link"
                    >
                      <LinkIcon className="w-4 h-4" />
                      <Tooltip id={cap.id + "_copy"} />
                    </button>
                    <button
                      type="button"
                      className="cursor-pointer border border-gray-300 relative bg-white hover:bg-gray-200 w-8 h-8 m-0 p-0 rounded-full flex items-center justify-center transition-all"
                      onClick={async () => {
                        if (isDownloading === cap.id) {
                          return;
                        }

                        await downloadCap(cap.id);
                      }}
                      data-tooltip-id={cap.id + "_download"}
                      data-tooltip-content="Download your Cap recording"
                    >
                      {isDownloading === cap.id ? (
                        <svg
                          xmlns="http://www.w3.org/2000/svg"
                          className="w-6 h-6"
                          viewBox="0 0 24 24"
                        >
                          <style>
                            {
                              "@keyframes spinner_AtaB{to{transform:rotate(360deg)}}"
                            }
                          </style>
                          <path
                            fill="#000"
                            d="M12 1a11 11 0 1 0 11 11A11 11 0 0 0 12 1Zm0 19a8 8 0 1 1 8-8 8 8 0 0 1-8 8Z"
                            opacity={0.25}
                          />
                          <path
                            fill="#00"
                            d="M10.14 1.16a11 11 0 0 0-9 8.92A1.59 1.59 0 0 0 2.46 12a1.52 1.52 0 0 0 1.65-1.3 8 8 0 0 1 6.66-6.61A1.42 1.42 0 0 0 12 2.69a1.57 1.57 0 0 0-1.86-1.53Z"
                            style={{
                              transformOrigin: "center",
                              animation: "spinner_AtaB .75s infinite linear",
                            }}
                          />
                        </svg>
                      ) : (
                        <>
                          <DownloadIcon className="w-4 h-4" />
                          <Tooltip id={cap.id + "_download"} />
                        </>
                      )}
                    </button>
                    <button
                      type="button"
                      className="cursor-pointer border border-gray-300 relative bg-white hover:bg-gray-200 w-8 h-8 m-0 p-0 rounded-full flex items-center justify-center transition-all"
                      onClick={async () => {
                        await deleteCap(cap.id);
                      }}
                      data-tooltip-id={cap.id + "_delete"}
                      data-tooltip-content="Delete your Cap recording"
                    >
                      <Trash className="w-4 h-4" />
                      <Tooltip id={cap.id + "_delete"} />
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
                    <p>
                      <span
                        className="text-sm text-gray-400"
                        data-tooltip-id={cap.id + "_createdAt"}
                        data-tooltip-content={`Cap created at ${cap.createdAt}`}
                      >
                        {moment(cap.createdAt).fromNow()}
                      </span>
                      <Tooltip id={cap.id + "_createdAt"} />
                    </p>
                    <div className="flex items-center space-x-3 mt-2 text-sm text-gray-60">
                      <div
                        className="flex items-center"
                        data-tooltip-id={cap.id + "_analytics"}
                        data-tooltip-content={`${videoAnalytics} unique views via your shareable Cap.link. Refreshed every 5 minutes.`}
                      >
                        <EyeIcon className="w-4 h-4 mr-1" />
                        <span className="text-gray-600">
                          {videoAnalytics ?? "-"}
                        </span>
                        <Tooltip id={cap.id + "_analytics"} />
                      </div>
                      <div
                        className="flex items-center"
                        data-tooltip-id={cap.id + "_comments"}
                        data-tooltip-content={`${cap.totalComments} comments`}
                      >
                        <MessageSquareIcon className="w-4 h-4 mr-1" />
                        <span className="text-gray-600">
                          {cap.totalComments}
                        </span>
                        <Tooltip id={cap.id + "_comments"} />
                      </div>
                      <div
                        className="flex items-center"
                        data-tooltip-id={cap.id + "_reactions"}
                        data-tooltip-content={`${cap.totalReactions} reactions`}
                      >
                        <SmileIcon className="w-4 h-4 mr-1" />
                        <span className="text-gray-600">
                          {cap.totalReactions}
                        </span>
                        <Tooltip id={cap.id + "_reactions"} />
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          {(data.length > limit || data.length === limit || page !== 1) && (
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
          )}
        </div>
      )}
    </div>
  );
};
