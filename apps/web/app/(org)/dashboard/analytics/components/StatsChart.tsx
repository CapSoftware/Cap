"use client";

import {
	cloneElement,
	type HTMLAttributes,
	type SVGProps,
	useRef,
	useState,
} from "react";
import {
	CapIcon,
	ChatIcon,
	ClapIcon,
	ReactionIcon,
} from "@/app/(org)/dashboard/_components/AnimatedIcons";
import { classNames } from "@/utils/helpers";
import type { CapIconHandle } from "../../_components/AnimatedIcons/Cap";
import ChartArea from "./ChartArea";

export default function StatsBox() {
	const [selectedBox, setSelectedBox] = useState<
		"caps" | "views" | "chats" | "reactions" | null
	>(null);

	const capsBoxRef = useRef<CapIconHandle | null>(null);
	const viewsBoxRef = useRef<CapIconHandle | null>(null);
	const chatsBoxRef = useRef<CapIconHandle | null>(null);
	const reactionsBoxRef = useRef<CapIconHandle | null>(null);

	const selectHandler = (box: "caps" | "views" | "chats" | "reactions") => {
		setSelectedBox(box);
		if (selectedBox === box) {
			setSelectedBox(null);
		}
	};

	return (
		<div className="flex flex-col gap-4 px-8 pt-8 w-full rounded-xl border bg-gray-1 border-gray-3">
			<div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
				<StatBox
					onClick={() => selectHandler("caps")}
					isSelected={selectedBox === "caps"}
					title="Caps"
					value="100"
					onMouseEnter={() => capsBoxRef.current?.startAnimation()}
					onMouseLeave={() => capsBoxRef.current?.stopAnimation()}
					icon={<CapIcon ref={capsBoxRef} size={20} />}
				/>
				<StatBox
					onClick={() => selectHandler("views")}
					isSelected={selectedBox === "views"}
					title="Views"
					value="2,768"
					onMouseEnter={() => viewsBoxRef.current?.startAnimation()}
					onMouseLeave={() => viewsBoxRef.current?.stopAnimation()}
					icon={<ClapIcon ref={viewsBoxRef} size={20} />}
				/>
				<StatBox
					onClick={() => selectHandler("chats")}
					isSelected={selectedBox === "chats"}
					title="Comments"
					value="100"
					onMouseEnter={() => chatsBoxRef.current?.startAnimation()}
					onMouseLeave={() => chatsBoxRef.current?.stopAnimation()}
					icon={<ChatIcon ref={chatsBoxRef} size={20} />}
				/>
				<StatBox
					onClick={() => selectHandler("reactions")}
					isSelected={selectedBox === "reactions"}
					title="Reactions"
					value="100"
					onMouseEnter={() => reactionsBoxRef.current?.startAnimation()}
					onMouseLeave={() => reactionsBoxRef.current?.stopAnimation()}
					icon={<ReactionIcon ref={reactionsBoxRef} size={20} />}
				/>
			</div>
			<ChartArea />
		</div>
	);
}

interface StatBoxProps extends HTMLAttributes<HTMLDivElement> {
	title: string;
	value: string;
	icon: React.ReactElement<SVGProps<SVGSVGElement>>;
	isSelected?: boolean;
}
function StatBox({
	title,
	value,
	icon,
	isSelected = false,
	...props
}: StatBoxProps) {
	return (
		<div
			{...props}
			className={classNames(
				"flex flex-col flex-1 gap-2 px-8 py-6 bg-transparent rounded-xl border transition-all duration-200 cursor-pointer group h-fit hover:bg-gray-3 border-gray-5",
				isSelected && "bg-gray-3 border-gray-8",
			)}
		>
			<div className="flex gap-2 items-center h-fit">
				{cloneElement(icon, {
					className: classNames(
						"group-hover:text-gray-12 transition-colors duration-200",
						isSelected ? "text-gray-12" : "text-gray-10",
					),
				})}
				<p
					className={classNames(
						"text-base font-medium transition-colors duration-200 group-hover:text-gray-12 text-gray-10",
						isSelected && "text-gray-12",
					)}
				>
					{title}
				</p>
			</div>
			<p className="text-2xl font-medium transition-colors duration-200 text-gray-12">
				{value}
			</p>
		</div>
	);
}
