"use client";

import {
	DropdownMenuItem,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
} from "@cap/ui";
import { type ReactNode, type RefObject, useEffect } from "react";
import type { ShareLadderPlayback } from "./share-ladder-playback";
import {
	type ShareLadderEngine,
	type ShareLadderQualityMenu,
	useShareLadder,
} from "./use-share-ladder";

// The outline Badge from ./video/badge and lucide's CheckIcon, as they render
// in the settings menu. Importing either here made Turbopack move it out of
// the shared player chunk into a copy in every player route's chunk, which
// grew shares without a ladder.
const BADGE_CLASS =
	"inline-flex items-center border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 text-foreground rounded";

function CheckMark() {
	return (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			width="24"
			height="24"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
			className="lucide lucide-check"
			aria-hidden="true"
		>
			<path d="M20 6 9 17l-5-5" />
		</svg>
	);
}

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
				<div className={BADGE_CLASS}>{selected}</div>
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
						{option.id === menu.selected && <CheckMark />}
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
