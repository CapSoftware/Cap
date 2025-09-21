"use client";

import type React from "react";
import { createContext, useContext, useEffect, useState } from "react";

interface UploadingContextType {
	isUploading: boolean;
	// setIsUploading: (value: boolean) => void;
	uploadingCapId: string | null;
	// setUploadingCapId: (id: string | null) => void;
	uploadingThumbnailUrl: string | undefined;
	setUploadingThumbnailUrl: (url: string | undefined) => void;
	uploadProgress: number;
	setUploadProgress: (progress: number) => void;

	state: UploadState | undefined;
	setState: (state: UploadState | undefined) => void;
}

type UploadState =
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
			status: "uploading";
			capId: string;
			progress: number;
	  };

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
	const [state, setState] = useState<UploadState>();

	const [uploadingThumbnailUrl, setUploadingThumbnailUrl] = useState<
		string | undefined
	>(undefined);
	const [uploadProgress, setUploadProgress] = useState(0);

	// Prevent the user closing the tab while uploading
	useEffect(() => {
		const handleBeforeUnload = (e: BeforeUnloadEvent) => {
			if (state?.status) {
				e.preventDefault();
				// Chrome requires returnValue to be set
				e.returnValue = "";
				return "";
			}
		};

		window.addEventListener("beforeunload", handleBeforeUnload);
		return () => window.removeEventListener("beforeunload", handleBeforeUnload);
	}, [state]);

	return (
		<UploadingContext.Provider
			value={{
				isUploading: state !== undefined,
				uploadingCapId: state?.capId ?? null,
				state,
				setState,
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
