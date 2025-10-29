"use client";

import { AnimatePresence, motion } from "motion/react";
import { CompareDataFilterItem, type FilterValue } from "./CompareFilters";

interface FiltersListProps {
	filters: readonly FilterValue[];
	isFilterInUse: (value: FilterValue) => boolean;
	onFilterDragStart: (value: FilterValue) => void;
	onFilterDragEnd: (x: number, y: number) => void;
	onFilterDrag: (x: number, y: number) => void;
}

const FILTER_LABELS: Record<FilterValue, string> = {
	views: "Views",
	comments: "Comments",
	reactions: "Reactions",
	shares: "Shares",
	downloads: "Downloads",
	uploads: "Uploads",
	deletions: "Deletions",
	creations: "Creations",
	edits: "Edits",
};

export const FiltersList = ({
	filters,
	isFilterInUse,
	onFilterDragStart,
	onFilterDragEnd,
	onFilterDrag,
}: FiltersListProps) => {
	return (
		<div className="max-w-[172px] w-full border-r border-gray-4 flex-1">
			<div className="border-b border-gray-4 bg-gray-3">
				<p className="px-4 py-2 text-xs font-medium text-gray-12 will-change-auto">
					Filters
				</p>
			</div>
			<motion.div layout className="flex p-4 flex-wrap gap-1.5 h-fit w-full">
				<AnimatePresence mode="popLayout">
					{filters.map((filter) => (
						<CompareDataFilterItem
							key={filter}
							label={FILTER_LABELS[filter]}
							value={filter}
							isInUse={isFilterInUse(filter)}
							onDragStart={() => onFilterDragStart(filter)}
							onDragEnd={onFilterDragEnd}
							onDrag={onFilterDrag}
						/>
					))}
				</AnimatePresence>
			</motion.div>
		</div>
	);
};
