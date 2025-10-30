import clsx from "clsx";
import { motion } from "framer-motion";
import { useEffect, useMemo, useRef } from "react";
import type { NotificationType } from "@/lib/Notification";
import { FilterLabels, Filters, type FilterType } from "./Filter";

type FilterTabsProps = {
	activeFilter: FilterType;
	setActiveFilter: (filter: FilterType) => void;
	loading: boolean;
	count?: Record<NotificationType, number>;
};

export const FilterTabs = ({
	activeFilter,
	setActiveFilter,
	loading,
	count,
}: FilterTabsProps) => {
	const scrollContainerRef = useRef<HTMLDivElement>(null);
	const totalCount = useMemo(() => {
		return Object.values(count ?? {}).reduce((acc, val) => acc + val, 0);
	}, [count]);

	useEffect(() => {
		const container = scrollContainerRef.current;
		if (!container) return;

		const handleWheel = (e: WheelEvent) => {
			// Only hijack vertical scroll if not already scrolling horizontally
			if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
			if (!e.ctrlKey) {
				e.preventDefault();
			}
			container.scrollLeft += e.deltaY;
		};

		container.addEventListener("wheel", handleWheel, { passive: false });

		return () => {
			container.removeEventListener("wheel", handleWheel);
		};
	}, []);

	return (
		<div
			ref={scrollContainerRef}
			className="flex isolate overflow-x-auto relative gap-4 items-center px-6 border-r border-b border-l hide-scroll border-gray-3"
		>
			{Filters.map((filter) => (
				<div key={filter} className="relative min-w-fit">
					<div
						onClick={() => setActiveFilter(filter)}
						className="flex relative gap-2 items-center py-4 cursor-pointer group"
					>
						<p
							className={clsx(
								"text-[13px] transition-colors",
								activeFilter === filter
									? "text-gray-12"
									: "text-gray-10 group-hover:text-gray-11",
							)}
						>
							{FilterLabels[filter]}
						</p>
						<div className="flex justify-center items-center rounded-md size-4 bg-gray-4">
							{loading ? (
								<span className="size-1.5 rounded-full bg-gray-10" />
							) : (
								<p
									className={clsx(
										"text-[10px] transition-colors",
										activeFilter === filter
											? "text-gray-12"
											: "text-gray-10 group-hover:text-gray-11",
									)}
								>
									{filter === "all" ? totalCount : (count?.[filter] ?? 0)}
								</p>
							)}
						</div>
					</div>

					{/* Indicator */}
					{activeFilter === filter && (
						<motion.div
							layoutId="indicator"
							className="absolute right-0 bottom-0 w-full h-px rounded-full bg-gray-12"
							transition={{ ease: "easeOut", duration: 0.2 }}
						/>
					)}
				</div>
			))}
		</div>
	);
};
