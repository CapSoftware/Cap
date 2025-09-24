"use client";

import { useStore } from "@tanstack/react-store";
import { Store } from "@tanstack/store";
import type React from "react";
import { createContext, useContext, useEffect, useRef } from "react";

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

interface UploadingStore {
	uploadStatus: UploadStatus | undefined;
}

interface UploadingContextType {
	uploadStatus: UploadStatus | undefined;
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

export function UploadingProvider({ children }: { children: React.ReactNode }) {
	const uploadingStoreRef = useRef(
		new Store<UploadingStore>({
			uploadStatus: undefined,
		}),
	);

	const uploadStatus = useStore(
		uploadingStoreRef.current,
		(state) => state.uploadStatus,
	);

	const setUploadStatus = (status: UploadStatus | undefined) => {
		uploadingStoreRef.current.setState((state) => ({
			...state,
			uploadStatus: status,
		}));
	};

	// Prevent the user closing the tab while uploading
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

	return (
		<UploadingContext.Provider
			value={{
				uploadStatus,
				setUploadStatus,
			}}
		>
			{children}
		</UploadingContext.Provider>
	);
}
