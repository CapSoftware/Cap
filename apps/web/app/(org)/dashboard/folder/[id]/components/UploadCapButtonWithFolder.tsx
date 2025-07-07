"use client";

import { UploadCapButton } from "../../../caps/components/UploadCapButton";
import { useRouter } from "next/navigation";
import { useUploadingContext } from "../../../caps/UploadingContext";
export function UploadCapButtonWithFolder({
  folderId,
}: {
  folderId: string;
}) {
  const router = useRouter();
  const {
    setIsUploading,
    setUploadingCapId,
    setUploadingThumbnailUrl,
    setUploadProgress
  } = useUploadingContext();

  return (
    <UploadCapButton
      onStart={(id, thumbnail) => {
        setIsUploading(true);
        setUploadingCapId(id);
        setUploadingThumbnailUrl(thumbnail);
        setUploadProgress(0);
      }}
      onProgress={(id, progress, uploadProgress) => {
        // Update progress in the context
        if (uploadProgress !== undefined) {
          setUploadProgress(Math.round(uploadProgress * 100));
        }
      }}
      onComplete={(id) => {
        // Reset all uploading state
        setIsUploading(false);
        setUploadingCapId(null);
        setUploadingThumbnailUrl(undefined);
        setUploadProgress(0);
        router.refresh();
      }}
      folderId={folderId}
      size="sm"
    />
  );
}
