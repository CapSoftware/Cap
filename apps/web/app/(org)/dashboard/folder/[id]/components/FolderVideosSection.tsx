"use client";

import { UploadCapButtonWithFolder } from "./UploadCapButtonWithFolder";
import { UploadPlaceholderCard } from "../../../caps/components/UploadPlaceholderCard";
import { useUploadPlaceholders } from "./useUploadPlaceholders";
import { ClientCapCard } from "./index";
import { useRouter } from "next/navigation";

interface FolderVideosSectionProps {
  folderId: string;
  initialVideos: Array<any>; // Replace 'any' with your Video type if available
}

export default function FolderVideosSection({ folderId, initialVideos }: FolderVideosSectionProps) {
  const router = useRouter();
  const {
    uploadPlaceholders,
    handleUploadStart,
    handleUploadProgress,
    handleUploadComplete,
  } = useUploadPlaceholders();

  return (
    <>
      <div className="flex justify-between items-center mb-6 w-full">
        <h1 className="text-2xl font-medium text-gray-12">Videos</h1>
        <UploadCapButtonWithFolder
          folderId={folderId}
          onStart={(id, thumbnail) => {
            handleUploadStart(id, thumbnail);
            router.refresh();
          }}
          onProgress={handleUploadProgress}
          onComplete={(id) => {
            handleUploadComplete(id);
            router.refresh();
          }}
        />
      </div>
      <div className="grid grid-cols-1 gap-4 sm:gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
        {uploadPlaceholders.map((u) => (
          <UploadPlaceholderCard key={u.id} {...u} />
        ))}
        {initialVideos.length === 0 && uploadPlaceholders.length === 0 ? (
          <p className="col-span-full text-gray-9">No videos in this folder yet. Drag and drop into the folder or upload.</p>
        ) : (
          initialVideos.map((video: any) => (
            <ClientCapCard
              key={video.id}
              videoId={video.id}
              cap={video}
              analytics={0}
            />
          ))
        )}
      </div>
    </>
  );
}
