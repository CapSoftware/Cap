"use client";

import type React from "react";
import { createContext, useContext, useEffect, useState } from "react";

interface UploadingContextType {
	uploadStatus: UploadStatus | undefined;
	setUploadStatus: (state: UploadStatus | undefined) => void;
}

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
	const [state, setState] = useState<UploadStatus>();

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
				uploadStatus: state,
				setUploadStatus: setState,
			}}
		>
			{children}
		</UploadingContext.Provider>
	);
}
