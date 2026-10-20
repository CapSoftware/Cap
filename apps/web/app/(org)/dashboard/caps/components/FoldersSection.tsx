"use client";

import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@cap/ui";
import {
	faArrowDownAZ,
	faArrowDownWideShort,
	faArrowUpWideShort,
	faArrowUpZA,
	faCheck,
	faChevronDown,
	faGrip,
	faList,
} from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import clsx from "clsx";
import { useEffect, useMemo, useState } from "react";
import {
	DEFAULT_FOLDER_SORT,
	FOLDER_SORT_OPTIONS,
	type FolderSort,
	isFolderSort,
	sortFolders,
} from "@/lib/folder-sort";
import FolderCard, { type FolderDataType, type FolderLayout } from "./Folder";

const SORT_STORAGE_KEY = "cap-dashboard-folder-sort";
const LAYOUT_STORAGE_KEY = "cap-dashboard-folder-layout";
const COLLAPSED_STORAGE_KEY = "cap-dashboard-folders-collapsed";

const SORT_ICONS: Record<FolderSort, typeof faArrowDownAZ> = {
	"name-asc": faArrowDownAZ,
	"name-desc": faArrowUpZA,
	newest: faArrowDownWideShort,
	oldest: faArrowUpWideShort,
};

const isFolderLayout = (value: unknown): value is FolderLayout =>
	value === "grid" || value === "list";

const isBooleanString = (value: unknown): value is "true" | "false" =>
	value === "true" || value === "false";

const readStored = <T,>(key: string, guard: (v: unknown) => v is T) => {
	try {
		const raw = window.localStorage.getItem(key);
		return guard(raw) ? raw : null;
	} catch {
		return null;
	}
};

const writeStored = (key: string, value: string) => {
	try {
		window.localStorage.setItem(key, value);
	} catch {
		// Storage may be unavailable (private mode, quota); the choice still
		// applies for this page view.
	}
};

// Preferences are remembered per location ("personal", or one space), so a
// numbered-folder scheme in My Caps doesn't force its sort onto every space.
// Subfolder pages share their container's setting.
const useFolderViewPreferences = (scope: string) => {
	const sortKey = `${SORT_STORAGE_KEY}:${scope}`;
	const layoutKey = `${LAYOUT_STORAGE_KEY}:${scope}`;
	const collapsedKey = `${COLLAPSED_STORAGE_KEY}:${scope}`;
	const [sort, setSort] = useState<FolderSort>(DEFAULT_FOLDER_SORT);
	const [layout, setLayout] = useState<FolderLayout>("grid");
	const [collapsed, setCollapsed] = useState(false);

	useEffect(() => {
		setSort(readStored(sortKey, isFolderSort) ?? DEFAULT_FOLDER_SORT);
		setLayout(readStored(layoutKey, isFolderLayout) ?? "grid");
		setCollapsed(readStored(collapsedKey, isBooleanString) === "true");
	}, [sortKey, layoutKey, collapsedKey]);

	return {
		sort,
		layout,
		collapsed,
		toggleCollapsed: () => {
			setCollapsed((current) => {
				writeStored(collapsedKey, String(!current));
				return !current;
			});
		},
		updateSort: (next: FolderSort) => {
			setSort(next);
			writeStored(sortKey, next);
		},
		updateLayout: (next: FolderLayout) => {
			setLayout(next);
			writeStored(layoutKey, next);
		},
	};
};

const controlClass =
	"flex items-center justify-center h-8 text-[13px] font-medium rounded-lg border transition-colors duration-200 text-gray-11 bg-gray-3 border-gray-5 hover:bg-gray-4 hover:border-gray-6 hover:text-gray-12";

type FolderItem = Omit<FolderDataType, "layout" | "canMove" | "moveRootLabel">;

interface FoldersSectionProps {
	title: string;
	/** Preference scope: "personal" for My Caps and its subfolders, or a space id. */
	scope: string;
	folders: FolderItem[];
	canMove?: boolean;
	moveRootLabel?: string;
	headingSize?: "lg" | "md";
}

export const FoldersSection = ({
	title,
	scope,
	folders,
	canMove,
	moveRootLabel,
	headingSize = "lg",
}: FoldersSectionProps) => {
	const { sort, layout, collapsed, toggleCollapsed, updateSort, updateLayout } =
		useFolderViewPreferences(scope);

	const sorted = useMemo(() => sortFolders(folders, sort), [folders, sort]);
	const activeSort =
		FOLDER_SORT_OPTIONS.find((option) => option.value === sort) ??
		FOLDER_SORT_OPTIONS[0];

	if (folders.length === 0) return null;

	return (
		<section className={collapsed ? "mb-6" : "mb-10"}>
			<div
				className={clsx(
					"flex flex-wrap gap-3 justify-between items-center w-full",
					!collapsed && "mb-6",
				)}
			>
				<button
					type="button"
					onClick={toggleCollapsed}
					aria-expanded={!collapsed}
					className="flex gap-2.5 items-center min-w-0 text-left rounded-lg group -ml-1 pl-1 pr-2 py-0.5 transition-colors hover:bg-gray-3"
				>
					<h1
						className={clsx(
							"font-medium truncate text-gray-12",
							headingSize === "lg" ? "text-2xl" : "text-xl",
						)}
					>
						{title}
					</h1>
					<span className="text-sm tabular-nums text-gray-10">
						{folders.length}
					</span>
					<FontAwesomeIcon
						icon={faChevronDown}
						className={clsx(
							"size-3 text-gray-9 transition-transform duration-200 group-hover:text-gray-11",
							collapsed && "-rotate-90",
						)}
					/>
				</button>
				{!collapsed && (
					<div className="flex gap-2 items-center">
						<DropdownMenu>
							<DropdownMenuTrigger asChild>
								<button
									type="button"
									aria-label={`Sort folders: ${activeSort?.label}`}
									className={clsx(controlClass, "gap-2 px-3")}
								>
									<FontAwesomeIcon
										icon={SORT_ICONS[sort]}
										className="size-3.5 text-gray-10"
									/>
									<span>{activeSort?.label}</span>
									<FontAwesomeIcon
										icon={faChevronDown}
										className="size-2.5 text-gray-9"
									/>
								</button>
							</DropdownMenuTrigger>
							<DropdownMenuContent align="end" className="min-w-44">
								{FOLDER_SORT_OPTIONS.map((option) => (
									<DropdownMenuItem
										key={option.value}
										onClick={() => updateSort(option.value)}
										className={clsx(
											"gap-2 rounded-lg",
											option.value === sort && "text-gray-12",
										)}
									>
										<FontAwesomeIcon
											icon={SORT_ICONS[option.value]}
											className="size-3 text-gray-10"
										/>
										<span className="flex-1">{option.label}</span>
										{option.value === sort && (
											<FontAwesomeIcon
												icon={faCheck}
												className="size-3 text-gray-12"
											/>
										)}
									</DropdownMenuItem>
								))}
							</DropdownMenuContent>
						</DropdownMenu>
						<fieldset className="flex overflow-hidden rounded-lg border border-gray-5 bg-gray-3">
							<legend className="sr-only">Folder layout</legend>
							{(
								[
									{ value: "grid", icon: faGrip, label: "Grid" },
									{ value: "list", icon: faList, label: "List" },
								] as const
							).map((option) => (
								<button
									key={option.value}
									type="button"
									aria-label={`${option.label} layout`}
									aria-pressed={layout === option.value}
									onClick={() => updateLayout(option.value)}
									className={clsx(
										"flex justify-center items-center w-8 h-8 transition-colors duration-200",
										layout === option.value
											? "bg-gray-5 text-gray-12"
											: "text-gray-10 hover:bg-gray-4 hover:text-gray-12",
									)}
								>
									<FontAwesomeIcon icon={option.icon} className="size-3.5" />
								</button>
							))}
						</fieldset>
					</div>
				)}
			</div>
			{!collapsed && (
				<div
					className={clsx(
						layout === "grid"
							? "grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-4"
							: "flex flex-col gap-2",
					)}
				>
					{sorted.map((folder) => (
						<FolderCard
							key={folder.id}
							{...folder}
							layout={layout}
							canMove={canMove}
							moveRootLabel={moveRootLabel}
						/>
					))}
				</div>
			)}
		</section>
	);
};

export default FoldersSection;
