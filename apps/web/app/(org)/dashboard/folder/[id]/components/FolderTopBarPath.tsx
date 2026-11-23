"use client";

import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@cap/ui";
import type { Folder, Space } from "@cap/web-domain";
import clsx from "clsx";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
	TopBarCrumbSeparator,
	TopBarTitle,
	useTopBarTitleWidth,
} from "../../../_components/TopBarTitle";
import { AllFolders } from "../../../caps/components/Folders";
import { BreadcrumbItem } from "./BreadcrumbItem";
import { ClientMyCapsLink } from "./ClientMyCapsLink";

type Crumb = {
	id: Folder.FolderId;
	name: string;
	color: "normal" | "blue" | "red" | "yellow";
};

const folderHref = (id: string, spaceId?: string) =>
	spaceId
		? `/dashboard/spaces/${spaceId}/folder/${id}`
		: `/dashboard/folder/${id}`;

function HiddenFoldersMenu({
	hidden,
	spaceId,
}: {
	hidden: Crumb[];
	spaceId?: string;
}) {
	const router = useRouter();
	return (
		<span className="flex items-center shrink-0">
			<TopBarCrumbSeparator />
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<button
						type="button"
						aria-label={`Show ${hidden.length} more ${hidden.length === 1 ? "folder" : "folders"}`}
						className="px-1.5 rounded-md transition-colors outline-none text-gray-10 hover:text-gray-12 hover:bg-gray-3 focus-visible:ring-2 focus-visible:ring-blue-8 data-[state=open]:bg-gray-3 data-[state=open]:text-gray-12"
					>
						…
					</button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="start" className="max-w-[min(360px,90vw)]">
					{hidden.map((crumb) => (
						<DropdownMenuItem
							key={crumb.id}
							onSelect={() => router.push(folderHref(crumb.id, spaceId))}
							className="flex gap-2 items-start"
						>
							<AllFolders
								color={crumb.color}
								className="mt-0.5 size-4 shrink-0"
							/>
							<span className="min-w-0 [overflow-wrap:anywhere]">
								{crumb.name}
							</span>
						</DropdownMenuItem>
					))}
				</DropdownMenuContent>
			</DropdownMenu>
		</span>
	);
}

function DesktopPath({
	breadcrumb,
	spaceId,
}: {
	breadcrumb: Crumb[];
	spaceId?: Space.SpaceIdOrOrganisationId;
}) {
	const rowRef = useRef<HTMLDivElement>(null);
	const ancestors = breadcrumb.slice(0, -1);
	const current = breadcrumb[breadcrumb.length - 1];
	const prefixSteps = spaceId ? 1 : 0;
	const alwaysHidden = Math.max(0, ancestors.length - 2);
	const maxLevel = prefixSteps + ancestors.length - alwaysHidden + 1;
	const [fit, setFit] = useState({ level: 0 });
	const level = fit.level;
	const { setWidth } = useTopBarTitleWidth();

	const showSpacesPrefix = Boolean(spaceId) && level < 1;
	const collapsed = Math.min(
		alwaysHidden + Math.max(level - prefixSteps, 0),
		ancestors.length,
	);
	const hidden = ancestors.slice(0, collapsed);
	const visibleAncestors = ancestors.slice(collapsed);
	const truncateCurrent = level >= maxLevel;

	useLayoutEffect(() => {
		const row = rowRef.current;
		if (!row || row.clientWidth === 0) return;
		// The row fills the title column, so its own width says nothing about
		// how much the path needs. Sum the parts instead.
		if (fit.level === 0)
			setWidth(
				Math.ceil(
					Array.from(row.children).reduce(
						(total, child) => total + child.scrollWidth,
						0,
					),
				),
			);
		if (fit.level >= maxLevel) return;
		if (row.scrollWidth > row.clientWidth + 1) setFit({ level: fit.level + 1 });
	}, [fit, maxLevel, setWidth]);

	useEffect(() => () => setWidth(0), [setWidth]);

	useEffect(() => {
		const row = rowRef.current;
		if (!row) return;
		let lastWidth = row.clientWidth;
		const observer = new ResizeObserver(() => {
			if (row.clientWidth === lastWidth) return;
			lastWidth = row.clientWidth;
			setFit({ level: 0 });
		});
		observer.observe(row);
		return () => observer.disconnect();
	}, []);

	return (
		<div
			ref={rowRef}
			className="hidden overflow-hidden items-center w-full min-w-0 whitespace-nowrap lg:flex"
		>
			{showSpacesPrefix && (
				<span className="flex items-center shrink-0">
					<Link
						href="/dashboard/spaces/browse"
						className="transition-colors text-gray-10 hover:text-gray-12"
					>
						Spaces
					</Link>
					<TopBarCrumbSeparator />
				</span>
			)}
			<ClientMyCapsLink
				spaceId={spaceId}
				className={truncateCurrent ? "min-w-[48px] shrink-[3]" : undefined}
			/>
			{hidden.length > 0 && (
				<HiddenFoldersMenu hidden={hidden} spaceId={spaceId} />
			)}
			{visibleAncestors.map((crumb) => (
				<div key={crumb.id} className="flex items-center shrink-0">
					<TopBarCrumbSeparator />
					<BreadcrumbItem
						spaceId={spaceId}
						id={crumb.id}
						name={crumb.name}
						color={crumb.color}
						isLast={false}
					/>
				</div>
			))}
			{current && (
				<div
					className={clsx(
						"flex items-center",
						truncateCurrent ? "max-w-[65%] shrink-0" : "shrink-0",
					)}
				>
					<TopBarCrumbSeparator />
					<BreadcrumbItem
						spaceId={spaceId}
						id={current.id}
						name={current.name}
						color={current.color}
						isLast
					/>
				</div>
			)}
		</div>
	);
}

function MobilePath({
	breadcrumb,
	spaceId,
}: {
	breadcrumb: Crumb[];
	spaceId?: Space.SpaceIdOrOrganisationId;
}) {
	const current = breadcrumb[breadcrumb.length - 1];
	const parent =
		breadcrumb.length > 1 ? breadcrumb[breadcrumb.length - 2] : null;

	return (
		<div className="flex flex-col gap-0.5 min-w-0 lg:hidden">
			<div className="flex flex-wrap items-center text-xs font-normal tracking-normal leading-4 text-gray-10 [&_*]:leading-4">
				<ClientMyCapsLink spaceId={spaceId} compact />
				{breadcrumb.length > 2 && (
					<span aria-hidden className="px-1">
						/ …
					</span>
				)}
				{parent && (
					<>
						<span aria-hidden className="px-1">
							/
						</span>
						<BreadcrumbItem
							spaceId={spaceId}
							id={parent.id}
							name={parent.name}
							color={parent.color}
							isLast={false}
							compact
						/>
					</>
				)}
			</div>
			{current && (
				<span className="text-gray-12 [overflow-wrap:anywhere]">
					{current.name}
				</span>
			)}
		</div>
	);
}

export function FolderTopBarPath({
	breadcrumb,
	spaceId,
}: {
	breadcrumb: Crumb[];
	spaceId?: Space.SpaceIdOrOrganisationId;
}) {
	return (
		<TopBarTitle>
			<h1 className="sr-only">{breadcrumb[breadcrumb.length - 1]?.name}</h1>
			<DesktopPath breadcrumb={breadcrumb} spaceId={spaceId} />
			<MobilePath breadcrumb={breadcrumb} spaceId={spaceId} />
		</TopBarTitle>
	);
}
