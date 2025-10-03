"use client";

import { Button } from "@cap/ui";
import clsx from "clsx";
import { useDetectPlatform } from "hooks/useDetectPlatform";
import { Clapperboard, Zap } from "lucide-react";
import { useState } from "react";
import {
	getDownloadButtonText,
	getDownloadUrl,
	getPlatformIcon,
} from "@/utils/platform";
import { homepageCopy } from "../../../data/homepage-copy";

interface Mode {
	name: "Instant Mode" | "Studio Mode";
	icon: JSX.Element;
	description: string;
}

const RecordingModes = () => {
	const modes: Mode[] = [
		{
			name: "Instant Mode",
			icon: (
				<Zap fill="yellow" className="size-5 md:size-6" strokeWidth={1.5} />
			),
			description:
				homepageCopy.recordingModes.modes.find((m) => m.name === "Instant Mode")
					?.description || "",
		},
		{
			name: "Studio Mode",
			icon: (
				<Clapperboard
					fill="var(--blue-9)"
					className="size-5 md:size-6"
					strokeWidth={1.5}
				/>
			),
			description:
				homepageCopy.recordingModes.modes.find((m) => m.name === "Studio Mode")
					?.description || "",
		},
	];

	const [activeMode, setActiveMode] = useState<Mode | undefined>(modes[0]);
	const { platform, isIntel } = useDetectPlatform();
	const loading = platform === null;

	const handleModeSwitch = (mode: Mode) => {
		setActiveMode(mode);
	};

	return (
		<div className="w-full max-w-[1000px] mx-auto px-5">
			<div className="flex flex-col gap-2 justify-center items-center text-center">
				<h1 className="text-4xl font-medium text-12">
					{homepageCopy.recordingModes.title}
				</h1>
				<p className="text-lg text-gray-10">
					{homepageCopy.recordingModes.subtitle}
				</p>
			</div>
			{/*Toggles*/}
			<div className="flex flex-col sm:flex-row gap-2 sm:gap-5 mt-[52px]">
				{modes.map((mode) => (
					<div
						onClick={() => handleModeSwitch(mode)}
						key={mode.name}
						className={clsx(
							"flex overflow-hidden relative",
							"flex-1 gap-3 justify-center items-center px-6 py-4 text-lg md:text-2xl font-medium rounded-2xl border transition-colors duration-200",
							"cursor-pointer",
							activeMode?.name === mode.name
								? "bg-blue-2 border-blue-6 text-blue-12"
								: "text-gray-12 bg-gray-1 border-gray-5 hover:bg-gray-3",
						)}
					>
						<div className="flex gap-1.5 z-[2] items-center">
							{mode.icon}
							{mode.name}
						</div>
					</div>
				))}
			</div>
			{/* Video*/}
			<div className="mt-5 w-full rounded-2xl border shadow-xl h-fit bg-gray-1 border-gray-5 shadow-black/5">
				{/*Video Content*/}
				<div className="relative h-full">
					{activeMode?.name === "Instant Mode" ? (
						<div
							key="instant-mode"
							className="overflow-hidden w-full rounded-t-xl"
							style={{
								position: "relative",
								paddingBottom: "56.25%",
								height: 0,
							}}
						>
							<iframe
								src="https://cap.so/embed/8cq21vmz12tm1zf"
								frameBorder="0"
								allowFullScreen
								style={{
									position: "absolute",
									top: 0,
									left: 0,
									width: "100%",
									height: "100%",
									borderTopLeftRadius: "0.75rem",
									borderTopRightRadius: "0.75rem",
								}}
							/>
						</div>
					) : (
						<div
							key="studio-mode"
							className="overflow-hidden w-full rounded-t-xl"
							style={{
								position: "relative",
								paddingBottom: "56.25%",
								height: 0,
							}}
						>
							<iframe
								src="https://cap.so/embed/qk8gt56e1q1r735"
								frameBorder="0"
								allowFullScreen
								style={{
									position: "absolute",
									top: 0,
									left: 0,
									width: "100%",
									height: "100%",
									borderTopLeftRadius: "0.75rem",
									borderTopRightRadius: "0.75rem",
								}}
							/>
						</div>
					)}
				</div>
				{/*Video Description*/}
				<div className="p-4 border-t border-b bg-gray-2 border-gray-5">
					<p className="mx-auto w-full text-sm text-center md:text-xl text-gray-12">
						{activeMode?.description}
					</p>
				</div>
				<div className="p-6">
					<div className="flex flex-col items-center space-y-2 sm:flex-row sm:space-y-0 sm:space-x-4 sm:justify-center">
						<Button
							variant="gray"
							href={
								platform === "windows"
									? "/download"
									: getDownloadUrl(platform, isIntel)
							}
							size="lg"
							className="flex justify-center items-center w-full font-medium sm:w-auto"
						>
							{!loading && getPlatformIcon(platform)}
							{getDownloadButtonText(platform, loading, isIntel)}
						</Button>
						<Button
							variant="blue"
							href="/pricing"
							size="lg"
							className="w-full font-medium sm:w-auto"
						>
							{homepageCopy.header.cta.primaryButton}
						</Button>
					</div>
				</div>
			</div>
		</div>
	);
};

export default RecordingModes;
