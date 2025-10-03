"use client";

import type React from "react";
import { createContext, useContext, useState } from "react";

interface UploadingContextType {
	isUploading: boolean;
	setIsUploading: (value: boolean) => void;
	uploadingCapId: string | null;
	setUploadingCapId: (id: string | null) => void;
	uploadingThumbnailUrl: string | undefined;
	setUploadingThumbnailUrl: (url: string | undefined) => void;
	uploadProgress: number;
	setUploadProgress: (progress: number) => void;
}

const UploadingContext = createContext<UploadingContextType | undefined>(
	undefined,
);

export function useUploadingContext() {
	const context = useContext(UploadingContext);
	if (!context) {
		throw new Error(
			"useUploadingContext must be used within an UploadingProvider",
		);
	}
	return context;
}

export function UploadingProvider({ children }: { children: React.ReactNode }) {
	const [isUploading, setIsUploading] = useState(false);
	const [uploadingCapId, setUploadingCapId] = useState<string | null>(null);
	const [uploadingThumbnailUrl, setUploadingThumbnailUrl] = useState<
		string | undefined
	>(undefined);
	const [uploadProgress, setUploadProgress] = useState(0);

	return (
		<UploadingContext.Provider
			value={{
				isUploading,
				setIsUploading,
				uploadingCapId,
				setUploadingCapId,
				uploadingThumbnailUrl,
				setUploadingThumbnailUrl,
				uploadProgress,
				setUploadProgress,
			}}
		>
			{children}
		</UploadingContext.Provider>
	);
}
