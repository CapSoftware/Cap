"use client";

import { useEffect, useState } from "react";

const ProgressCircle = ({ isUploading }: { isUploading: boolean }) => {
	const [uploadProgress, setUploadProgress] = useState(0);

	// Animate progress from 0 to 100
	useEffect(() => {
		if (isUploading) {
			const interval = setInterval(() => {
				setUploadProgress((prev) => {
					if (prev >= 100) {
						clearInterval(interval);
						return 100;
					}
					return prev + 1;
				});
			}, 50); // Update every 50ms for smooth animation

			return () => clearInterval(interval);
		}
	}, [isUploading]);

	return (
		<div className="relative size-full">
			<svg className="transform -rotate-90 size-full" viewBox="0 0 100 100">
				<title>Progress Circle</title>
				{/* Background circle */}
				<circle
					cx="50"
					cy="50"
					r="45"
					fill="none"
					stroke="rgba(255, 255, 255, 0.2)"
					strokeWidth="5"
				/>
				{/* Progress circle */}
				<circle
					cx="50"
					cy="50"
					r="45"
					fill="none"
					stroke="#3b82f6"
					strokeWidth="5"
					strokeLinecap="round"
					strokeDasharray={`${2 * Math.PI * 45}`}
					strokeDashoffset={`${2 * Math.PI * 45 * (1 - uploadProgress / 100)}`}
					className="transition-all duration-300 ease-out"
				/>
			</svg>
			{/* Progress text */}
			<div className="flex absolute inset-0 flex-col justify-center items-center">
				<span className="text-xs font-semibold tabular-nums text-white xs:text-sm md:text-lg">
					{Math.round(uploadProgress)}%
				</span>
				<span className="text-[11px] relative bottom-1.5 text-white opacity-75">
					Uploading Video...
				</span>
			</div>
		</div>
	);
};

export default ProgressCircle;
