import { useCallback } from "react";
import { useUploadContext } from "./UploadContext";

export interface UploadPlaceholder {
  id: string;
  progress: number;
  thumbnail?: string;
  uploadProgress?: number;
}

export function useUploadPlaceholders() {
  const { uploadPlaceholders, setUploadPlaceholders, isUploading } = useUploadContext();

  const handleUploadStart = useCallback((id: string, thumbnail?: string) => {
    setUploadPlaceholders((prev) => [{ id, progress: 0, thumbnail }, ...prev]);
  }, [setUploadPlaceholders]);

  const handleUploadProgress = useCallback((id: string, progress: number, uploadProgress?: number) => {
    setUploadPlaceholders((prev) =>
      prev.map((u) => (u.id === id ? { ...u, progress, uploadProgress } : u))
    );
  }, [setUploadPlaceholders]);

  const handleUploadComplete = useCallback((id: string) => {
    setUploadPlaceholders((prev) => prev.filter((u) => u.id !== id));
  }, [setUploadPlaceholders]);

  return {
    uploadPlaceholders,
    isUploading,
    handleUploadStart,
    handleUploadProgress,
    handleUploadComplete,
  };
}
