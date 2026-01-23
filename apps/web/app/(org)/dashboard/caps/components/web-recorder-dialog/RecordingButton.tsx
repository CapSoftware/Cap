"use client";

import { Button } from "@inflight/ui";
import type { SVGProps } from "react";

interface RecordingButtonProps {
	isRecording: boolean;
	disabled?: boolean;
	onStart: () => void;
	onStop: () => void;
}

const InstantIcon = ({ className, ...props }: SVGProps<SVGSVGElement>) => (
	<svg
		width="152"
		height="223"
		viewBox="0 0 152 223"
		fill="none"
		xmlns="http://www.w3.org/2000/svg"
		className={className}
		{...props}
	>
		<path
			d="M150.167 109.163L53.4283 220.65C52.4032 221.826 51.05 222.613 49.573 222.89C48.0959 223.167 46.5752 222.919 45.2403 222.185C43.9054 221.451 42.8287 220.27 42.1727 218.82C41.5167 217.369 41.317 215.729 41.6038 214.146L54.2661 146.019L4.48901 125.914C3.41998 125.484 2.46665 124.776 1.7142 123.853C0.961745 122.93 0.433602 121.82 0.176954 120.624C-0.0796948 119.428 -0.0568536 118.182 0.243435 116.997C0.543723 115.813 1.1121 114.727 1.8978 113.837L98.6363 2.35043C99.6614 1.17365 101.015 0.387451 102.492 0.110461C103.969 -0.166529 105.489 0.080724 106.824 0.814909C108.159 1.54909 109.236 2.73037 109.892 4.18049C110.548 5.63061 110.748 7.27088 110.461 8.85379L97.7639 77.0554L147.541 97.1322C148.602 97.5652 149.548 98.2727 150.294 99.1922C151.041 100.112 151.566 101.215 151.822 102.404C152.078 103.593 152.058 104.832 151.763 106.011C151.468 107.19 150.908 108.273 150.132 109.163H150.167Z"
			fill="currentColor"
		/>
	</svg>
);

export const RecordingButton = ({
	isRecording,
	disabled = false,
	onStart,
	onStop,
}: RecordingButtonProps) => {
	return (
		<div className="flex items-center space-x-1 w-full">
			<Button
				variant="blue"
				size="md"
				disabled={disabled}
				onClick={isRecording ? onStop : onStart}
				className="flex flex-grow justify-center items-center"
			>
				{isRecording ? (
					"Stop Recording"
				) : (
					<>
						<InstantIcon className="size-[0.8rem] mr-1.5" />
						Start recording
					</>
				)}
			</Button>
		</div>
	);
};
