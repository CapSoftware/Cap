"use client";
import { Button } from "@cap/ui";
import { videos } from "@cap/database/schema";
import moment from "moment";
import { VideoThumbnail } from "@/components/VideoThumbnail";
import { useRouter } from "next/navigation";

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
        </>
      )}
    </div>
  );
};
