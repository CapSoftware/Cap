"use client";

import {
	DropdownMenuItem,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
} from "@cap/ui";
import { CheckIcon } from "lucide-react";
import { type ReactNode, type RefObject, useEffect } from "react";
import type { ShareLadderPlayback } from "./share-ladder-playback";
import {
	type ShareLadderEngine,
	type ShareLadderQualityMenu,
	useShareLadder,
} from "./use-share-ladder";
import { Badge } from "./video/badge";

function QualitySubmenu({ menu }: { menu: ShareLadderQualityMenu }) {
	const selected =
		menu.selected === "original"
			? "Original"
			: (menu.options.find((option) => option.id === menu.selected)?.label ??
				"Auto");
	return (
		<DropdownMenuSub>
			<DropdownMenuSubTrigger>
				<span className="flex-1">Quality</span>
				<Badge variant="outline" className="rounded">
					{selected}
				</Badge>
			</DropdownMenuSubTrigger>
			<DropdownMenuSubContent>
				{menu.options.map((option) => (
					<DropdownMenuItem
						key={option.id}
						className="justify-between"
						onSelect={() => menu.onSelect(option.id)}
					>
						{option.id === "original"
							? `Original (${option.label})`
							: option.label}
						{option.id === menu.selected && <CheckIcon />}
					</DropdownMenuItem>
				))}
			</DropdownMenuSubContent>
		</DropdownMenuSub>
	);
}

export default function ShareLadder({
	ladder,
	videoRef,
	active,
	mediaKey,
	engine,
	onEngineChange,
	onQualitySubmenu,
}: {
	ladder: ShareLadderPlayback;
	videoRef: RefObject<HTMLVideoElement | null>;
	active: boolean;
	mediaKey: string | undefined;
	engine: ShareLadderEngine;
	onEngineChange: (engine: ShareLadderEngine) => void;
	onQualitySubmenu: (submenu: ReactNode) => void;
}) {
	const menu = useShareLadder({
		ladder,
		videoRef,
		active,
		mediaKey,
		engine,
		setEngine: onEngineChange,
	});

	useEffect(() => {
		onQualitySubmenu(menu ? <QualitySubmenu menu={menu} /> : null);
	}, [menu, onQualitySubmenu]);

	useEffect(() => () => onQualitySubmenu(null), [onQualitySubmenu]);

	return null;
}
