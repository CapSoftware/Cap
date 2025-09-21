"use client";

import type React from "react";
import { createContext, useContext, useEffect, useState } from "react";

interface UploadingContextType {
	// TODO: Rename these
	state: UploadState | undefined;
	setState: (state: UploadState | undefined) => void;

	isUploading: boolean;
	uploadingCapId: string | null;
}

export type UploadState =
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
	const [state, setState] = useState<UploadState>();

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
				state,
				setState,
				isUploading: state !== undefined,
				uploadingCapId: state && "capId" in state ? state.capId : null,
			}}
		>
			{children}
		</UploadingContext.Provider>
	);
}
