"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { UploadingProvider } from "../dashboard/caps/UploadingContext";
import { RecorderPageContent } from "./RecorderPageContent";

export default function RecordPage() {
	const router = useRouter();
	const [mounted, setMounted] = useState(false);

	useEffect(() => {
		setMounted(true);
	}, []);

	if (!mounted) {
		return null;
	}

	return (
		<UploadingProvider>
			<div className="relative w-screen h-screen overflow-hidden bg-gradient-to-br from-pink-100 via-white to-teal-50">
			<button
				type="button"
				onClick={() => window.close()}
				className="absolute top-9 right-9 bg-black/5 hover:bg-black/10 border-none text-gray-11 cursor-pointer p-2 flex items-center justify-center rounded-lg transition-colors z-[10001]"
				aria-label="Close recorder"
			>
				<svg
					width="20"
					height="20"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="2"
				>
					<line x1="18" y1="6" x2="6" y2="18" />
					<line x1="6" y1="6" x2="18" y2="18" />
				</svg>
			</button>

			<div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-center text-gray-11 font-sans max-w-[600px] px-4">
				<h1 className="text-[28px] font-semibold mb-4 text-gray-12">
					Browser Recorder
				</h1>
				<p className="text-base text-gray-11 leading-relaxed mb-3">
					Record your screen, window, or tab directly from your browser. Select
					your recording options and start capturing.
				</p>
				<p className="text-base text-gray-11 leading-relaxed">
					Download the{" "}
					<a
						href="https://cap.so/download"
						target="_blank"
						rel="noopener noreferrer"
						className="text-blue-9 no-underline font-medium hover:underline"
					>
						Cap desktop app
					</a>{" "}
					to record over any browser or application.
				</p>
			</div>

			<div className="fixed top-5 right-5 w-[360px] z-[100] bg-white shadow-[0_20px_60px_rgba(0,0,0,0.15),0_8px_24px_rgba(0,0,0,0.1)] rounded-2xl overflow-visible">
				<RecorderPageContent />
			</div>
		</div>
		</UploadingProvider>
	);
}
