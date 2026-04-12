"use client";

import { Fit, Layout, type RiveFile, useRive } from "@rive-app/react-canvas";
import React, { useImperativeHandle } from "react";
import { useTheme } from "../../Contexts";

export interface FolderHandle {
	play: (animationName: string) => void;
	stop: () => void;
}

export const NormalFolder = React.forwardRef<
	FolderHandle,
	{ riveFile: RiveFile | undefined }
>((props, ref) => {
	const { theme } = useTheme();
	const { rive, RiveComponent: NormalFolderRive } = useRive({
		riveFile: props.riveFile,
		artboard: theme === "dark" ? "folder" : "folder-dark",
		animations: "idle",
		autoplay: false,
		layout: new Layout({
			fit: Fit.Contain,
		}),
	});

	useImperativeHandle(
		ref,
		() => ({
			play: (animationName: string) => {
				if (!rive) return;
				try {
					rive.play(animationName);
				} catch (error) {
					console.warn("Failed to play folder animation", error);
				}
			},
			stop: () => {
				if (!rive) return;
				try {
					rive.stop();
				} catch (error) {
					console.warn("Failed to stop folder animation", error);
				}
			},
		}),
		[rive],
	);

	return (
		<NormalFolderRive
			key={`${theme}folder-normal`}
			className="w-[50px] h-[50px]"
		/>
	);
});

export const BlueFolder = React.forwardRef<
	FolderHandle,
	{ riveFile: RiveFile | undefined }
>((props, ref) => {
	const { rive, RiveComponent: BlueFolderRive } = useRive({
		riveFile: props.riveFile,
		artboard: "folder-blue",
		animations: "idle",
		autoplay: false,
		layout: new Layout({
			fit: Fit.Contain,
		}),
	});

	useImperativeHandle(
		ref,
		() => ({
			play: (animationName: string) => {
				if (!rive) return;
				try {
					rive.play(animationName);
				} catch (error) {
					console.warn("Failed to play folder animation", error);
				}
			},
			stop: () => {
				if (!rive) return;
				try {
					rive.stop();
				} catch (error) {
					console.warn("Failed to stop folder animation", error);
				}
			},
		}),
		[rive],
	);

	return <BlueFolderRive className="w-[50px] h-[50px]" />;
});

export const RedFolder = React.forwardRef<
	FolderHandle,
	{ riveFile: RiveFile | undefined }
>((props, ref) => {
	const { rive, RiveComponent: RedFolderRive } = useRive({
		riveFile: props.riveFile,
		artboard: "folder-red",
		animations: "idle",
		autoplay: false,
		layout: new Layout({
			fit: Fit.Contain,
		}),
	});

	useImperativeHandle(
		ref,
		() => ({
			play: (animationName: string) => {
				if (!rive) return;
				try {
					rive.play(animationName);
				} catch (error) {
					console.warn("Failed to play folder animation", error);
				}
			},
			stop: () => {
				if (!rive) return;
				try {
					rive.stop();
				} catch (error) {
					console.warn("Failed to stop folder animation", error);
				}
			},
		}),
		[rive],
	);

	return <RedFolderRive className="w-[50px] h-[50px]" />;
});

export const YellowFolder = React.forwardRef<
	FolderHandle,
	{ riveFile: RiveFile | undefined }
>((props, ref) => {
	const { rive, RiveComponent: YellowFolderRive } = useRive({
		riveFile: props.riveFile,
		artboard: "folder-yellow",
		animations: "idle",
		autoplay: false,
		layout: new Layout({
			fit: Fit.Contain,
		}),
	});

	useImperativeHandle(
		ref,
		() => ({
			play: (animationName: string) => {
				if (!rive) return;
				try {
					rive.play(animationName);
				} catch (error) {
					console.warn("Failed to play folder animation", error);
				}
			},
			stop: () => {
				if (!rive) return;
				try {
					rive.stop();
				} catch (error) {
					console.warn("Failed to stop folder animation", error);
				}
			},
		}),
		[rive],
	);

	return <YellowFolderRive className="w-[50px] h-[50px]" />;
});

interface AllFoldersProps {
	color: "normal" | "blue" | "red" | "yellow";
	className?: string;
}

export const AllFolders = React.forwardRef<FolderHandle, AllFoldersProps>(
	(props, ref) => {
		const { theme } = useTheme();

		const artboard =
			theme === "dark" && props.color === "normal"
				? "folder"
				: props.color === "blue"
					? "folder-blue"
					: props.color === "red"
						? "folder-red"
						: props.color === "yellow"
							? "folder-yellow"
							: "folder-dark";
		const { rive, RiveComponent: AllFoldersRive } = useRive({
			src: "/rive/dashboard.riv",
			artboard,
			animations: "idle",
			autoplay: false,
			layout: new Layout({
				fit: Fit.Contain,
			}),
		});

		useImperativeHandle(
			ref,
			() => ({
				play: (animationName: string) => {
					if (!rive) return;
					try {
						rive.play(animationName);
					} catch (error) {
						console.warn("Failed to play folder animation", error);
					}
				},
				stop: () => {
					if (!rive) return;
					try {
						rive.stop();
					} catch (error) {
						console.warn("Failed to stop folder animation", error);
					}
				},
			}),
			[rive],
		);

		return (
			<AllFoldersRive key={theme + props.color} className={props.className} />
		);
	},
);
