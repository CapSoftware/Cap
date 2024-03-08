"use client";
import { Button } from "@cap/ui";
import { videos } from "@cap/database/schema";
import moment from "moment";
import { VideoThumbnail } from "@/components/VideoThumbnail";
import { useRouter } from "next/navigation";
import toast from "react-hot-toast";

export const Caps = ({ data }: { data: (typeof videos.$inferSelect)[] }) => {
  const { push } = useRouter();

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
            <h1 className="text-2xl font-semibold mb-1">My Caps</h1>
            <p>These are all of your videos created with Cap.</p>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
            {data.map((cap, index) => {
              return (
                <div
                  key={index}
                  className="rounded-xl border border-filler overflow-hidden"
                >
                  <a className="group" href={`/share/${cap.id}`}>
                    <div>
                      <VideoThumbnail
                        userId={cap.ownerId}
                        videoId={cap.id}
                        alt={`${cap.name} Thumbnail`}
                      />
                    </div>
                  </a>
                  <div className="p-4">
                    <p className="font-medium">{cap.name}</p>
                    <p className="text-sm text-gray-400">
                      {moment(cap.createdAt).fromNow()}
                    </p>
                    <div className="mt-3">
                      <input
                        className="text-sm cursor-pointer bg-white p-2 w-full rounded-lg flex items-center justify-center border hover:border-primary-3 transition-all"
                        onClick={(event) => {
                          if (process.env.NEXT_PUBLIC_IS_CAP) {
                            navigator.clipboard.writeText(
                              `https://cap.link/${cap.id}`
                            );
                          } else {
                            navigator.clipboard.writeText(
                              `${process.env.NEXT_PUBLIC_URL}/share/${cap.id}`
                            );
                          }
                          toast.success("Link copied to clipboard!");
                        }}
                        value={
                          process.env.NEXT_PUBLIC_IS_CAP
                            ? `https://cap.link/${cap.id}`
                            : `${process.env.NEXT_PUBLIC_URL}/share/${cap.id}`
                        }
                      ></input>
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
