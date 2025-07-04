"use client";

import { UploadCapButton } from "../../../caps/components/UploadCapButton";
import { useRouter } from "next/navigation";

export function UploadCapButtonWithFolder({
  folderId,
  onUploaded,
  onStart,
  onProgress,
  onComplete,
}: {
  folderId: string;
  onUploaded?: () => void;
  onStart?: (id: string, thumbnail?: string) => void;
  onProgress?: (id: string, progress: number, uploadProgress?: number) => void;
  onComplete?: (id: string) => void;
}) {
  const router = useRouter();

  return (
    <UploadCapButton
      onStart={onStart}
      onProgress={onProgress}
      onComplete={(id) => {
        onComplete?.(id);
        onUploaded?.();
        router.refresh();
      }}
      folderId={folderId}
      size="sm"
    />
  );
}
