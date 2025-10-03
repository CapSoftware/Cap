"use client";

import { useStore } from "@tanstack/react-store";
import { Store } from "@tanstack/store";
import type React from "react";
import { createContext, useContext, useEffect, useState } from "react";

export type UploadStatus =
	| {
			status: "parsing";
	  }
	| {
			status: "creating";
	  }
	| {
			status: "converting";
			capId: string;
			progress: number;
	  }
	| {
			status: "uploadingThumbnail";
			capId: string;
			progress: number;
	  }
	| {
			status: "uploadingVideo";
			capId: string;
			progress: number;
			thumbnailUrl: string | undefined;
	  };

interface UploadingContextType {
	uploadingStore: Store<{ uploadStatus?: UploadStatus }>;
	setUploadStatus: (state: UploadStatus | undefined) => void;
}

const UploadingContext = createContext<UploadingContextType | undefined>(
	undefined,
);

export function useUploadingContext() {
	const context = useContext(UploadingContext);
	if (!context)
		throw new Error(
			"useUploadingContext must be used within an UploadingProvider",
		);
	return context;
}

export function useUploadingStatus() {
	const { uploadingStore } = useUploadingContext();
	return useStore(
		uploadingStore,
		(s) =>
			[
				s.uploadStatus !== undefined,
				s.uploadStatus && "capId" in s.uploadStatus
					? s.uploadStatus.capId
					: null,
			] as const,
	);
}

export function UploadingProvider({ children }: { children: React.ReactNode }) {
	const [uploadingStore] = useState<Store<{ uploadStatus?: UploadStatus }>>(
		() => new Store({}),
	);

	return (
		<UploadingContext.Provider
			value={{
				uploadingStore,
				setUploadStatus: (status: UploadStatus | undefined) => {
					uploadingStore.setState((state) => ({
						...state,
						uploadStatus: status,
					}));
				},
			}}
		>
			{children}

			<ForbidLeaveWhenUploading />
		</UploadingContext.Provider>
	);
}

// Separated to prevent rerendering whole tree
function ForbidLeaveWhenUploading() {
	const { uploadingStore } = useUploadingContext();
	const uploadStatus = useStore(uploadingStore, (state) => state.uploadStatus);

	useEffect(() => {
		const handleBeforeUnload = (e: BeforeUnloadEvent) => {
			if (uploadStatus?.status) {
				e.preventDefault();
				// Chrome requires returnValue to be set
				e.returnValue = "";
				return "";
			}
		};

		window.addEventListener("beforeunload", handleBeforeUnload);
		return () => window.removeEventListener("beforeunload", handleBeforeUnload);
	}, [uploadStatus]);

	return null;
}
