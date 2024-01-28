"use client";
import { Button } from "@cap/ui";
import { videos } from "@cap/database/schema";
import moment from "moment";

export const Caps = ({ data }: { data: (typeof videos.$inferSelect)[] }) => {
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
            <Button size="default" className="mt-8" variant="default">
              Record a Cap
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
                  <a href={`/share/${cap.id}`}>
                    <div className="aspect-video bg-gray-100"></div>
                    <div className="p-4">
                      <p className="font-medium">{cap.name}</p>
                      <p className="text-sm text-gray-400">
                        {moment(cap.createdAt).fromNow()}
                      </p>
                    </div>
                  </a>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
};
