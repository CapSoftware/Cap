"use client";

import { ShareHeader } from "./_components/ShareHeader";
import { videos } from "@cap/database/schema";
import { VideoPlayer } from "./_components/VideoPlayer";
import { useState, useCallback } from "react";
import { PlayCircle, PauseCircle } from "lucide-react";

export const Share = ({ data }: { data: typeof videos.$inferSelect }) => {
  const [isPlaying, setIsPlaying] = useState(false);

  const handlePlayPause = useCallback(
    (playing: boolean | ((prevState: boolean) => boolean)) => {
      setIsPlaying(playing);
    },
    []
  );

  return (
    <div className="wrapper py-6">
      <div className="space-y-8">
        <ShareHeader title={data.name} createdAt={data.createdAt} />
        <div className="aspect-video relative bg-black flex items-center justify-center rounded-lg group overflow-hidden">
          <div className="video-player w-[175px] h-[175px] absolute bottom-4 right-12 overflow-hidden rounded-full z-10 shadow-[0px 0px 180px rgba(255, 255, 255, 0.18)]">
            <VideoPlayer
              isPlaying={isPlaying}
              onPlayPause={handlePlayPause}
              src={`${process.env.NEXT_PUBLIC_URL}/api/playlist?userId=${data.ownerId}&videoId=${data.id}&videoType=video`}
            />
          </div>
          <div className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 z-10">
            <button
              className="hidden group-hover:block w-32 h-32 z-10 relative cursor-pointer"
              onClick={() => handlePlayPause(!isPlaying)}
            >
              {isPlaying ? (
                <PauseCircle className="w-full h-auto text-white" />
              ) : (
                <PlayCircle className="w-full h-auto text-white" />
              )}
            </button>
          </div>
          <VideoPlayer
            isPlaying={isPlaying}
            onPlayPause={handlePlayPause}
            src={`${process.env.NEXT_PUBLIC_URL}/api/playlist?userId=${data.ownerId}&videoId=${data.id}&videoType=screen`}
          />
        </div>
      </div>
    </div>
  );
};
