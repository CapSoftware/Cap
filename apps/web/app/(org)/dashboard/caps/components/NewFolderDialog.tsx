"use client";

import {
	Button,
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	Input,
} from "@cap/ui";
import type { Folder, Space } from "@cap/web-domain";
import { faFolderPlus } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { type RiveFile, useRiveFile } from "@rive-app/react-canvas";
import clsx from "clsx";
import { Option } from "effect";
import { useRouter } from "next/navigation";
import React, { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useEffectMutation, useRpcClient } from "@/lib/EffectRuntime";
import {
	BlueFolder,
	type FolderHandle,
	NormalFolder,
	RedFolder,
	YellowFolder,
} from "./Folders";

interface Props {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	spaceId?: Space.SpaceIdOrOrganisationId;
}

const FolderOptions = [
	{
		value: "normal",
		label: "Normal",
		component: (
			riveFile: RiveFile | undefined,
			ref: React.Ref<FolderHandle>,
		) => <NormalFolder riveFile={riveFile} ref={ref} />,
	},
	{
		value: "blue",
		label: "Blue",
		component: (
			riveFile: RiveFile | undefined,
			ref: React.Ref<FolderHandle>,
		) => <BlueFolder riveFile={riveFile} ref={ref} />,
	},
	{
		value: "red",
		label: "Red",
		component: (
			riveFile: RiveFile | undefined,
			ref: React.Ref<FolderHandle>,
		) => <RedFolder riveFile={riveFile} ref={ref} />,
	},
	{
		value: "yellow",
		label: "Yellow",
		component: (
			riveFile: RiveFile | undefined,
			ref: React.Ref<FolderHandle>,
		) => <YellowFolder riveFile={riveFile} ref={ref} />,
	},
] as const;

export const NewFolderDialog: React.FC<Props> = ({
	open,
	onOpenChange,
	spaceId,
}) => {
	const [selectedColor, setSelectedColor] = useState<
		(typeof FolderOptions)[number]["value"] | null
	>(null);
	const [folderName, setFolderName] = useState<string>("");
	const router = useRouter();

	const { riveFile } = useRiveFile({
		src: "/rive/dashboard.riv",
	});

	useEffect(() => {
		if (!open) {
			setSelectedColor(null);
			Object.values(folderRefs.current).forEach((ref) => {
				ref.current?.stop();
			});
		}
	}, [open]);

	const folderRefs = useRef(
		FolderOptions.reduce(
			(acc, opt) => {
				acc[opt.value] = React.createRef<FolderHandle>();
				return acc;
			},
			{} as Record<
				(typeof FolderOptions)[number]["value"],
				React.RefObject<FolderHandle | null>
			>,
		),
	);

	const rpc = useRpcClient();

	const createFolder = useEffectMutation({
		mutationFn: (data: { name: string; color: Folder.FolderColor }) =>
			rpc.FolderCreate({
				name: data.name,
				color: data.color,
				spaceId: Option.fromNullable(spaceId),
				parentId: Option.none(),
			}),
		onSuccess: () => {
			setFolderName("");
			setSelectedColor(null);
			onOpenChange(false);
			router.refresh();
			toast.success("Folder created successfully");
		},
		onError: () => {
			toast.error("Failed to create folder");
		},
	});

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="w-[calc(100%-20px)]">
				<DialogHeader
					icon={<FontAwesomeIcon icon={faFolderPlus} className="size-3.5" />}
				>
					<DialogTitle>New Folder</DialogTitle>
				</DialogHeader>
				<div className="p-5">
					<Input
						value={folderName}
						onChange={(e) => setFolderName(e.target.value)}
						required
						placeholder="Folder name"
					/>
					<div className="flex flex-wrap gap-2 mt-3">
						{FolderOptions.map((option) => {
							return (
								<div
									className={clsx(
										"flex flex-col flex-1 gap-1 items-center p-2 rounded-xl border transition-colors duration-200 cursor-pointer",
										selectedColor === option.value
											? "border-gray-12 bg-gray-3 hover:bg-gray-3 hover:border-gray-12"
											: "border-gray-4 hover:bg-gray-3 hover:border-gray-5 bg-transparent",
									)}
									key={`rive-${option.value}`}
									onClick={() => {
										if (selectedColor === option.value) {
											setSelectedColor(null);
											return;
										}
										setSelectedColor(option.value);
									}}
									onMouseEnter={() => {
										if (!riveFile) return;
										const folderRef = folderRefs.current[option.value]?.current;
										if (!folderRef) return;
										folderRef.stop();
										folderRef.play("folder-open");
									}}
									onMouseLeave={() => {
										if (!riveFile) return;
										const folderRef = folderRefs.current[option.value]?.current;
										if (!folderRef) return;
										folderRef.stop();
										folderRef.play("folder-close");
									}}
								>
									{riveFile &&
										option.component(
											riveFile as RiveFile,
											folderRefs.current[option.value],
										)}
									{!riveFile && (
										<div className="w-[50px] h-[50px] bg-gray-4 rounded animate-pulse" />
									)}
									<p className="text-xs text-gray-10">{option.label}</p>
								</div>
							);
						})}
					</div>
				</div>
				<DialogFooter>
					<Button size="sm" variant="gray" onClick={() => onOpenChange(false)}>
						Cancel
					</Button>
					<Button
						onClick={() => {
							if (selectedColor === null) return;
							createFolder.mutate({ name: folderName, color: selectedColor });
						}}
						size="sm"
						spinner={createFolder.isPending}
						variant="dark"
						disabled={
							!selectedColor ||
							!folderName.trim().length ||
							createFolder.isPending
						}
					>
						{createFolder.isPending ? "Creating..." : "Create"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
};
