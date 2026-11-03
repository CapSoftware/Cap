"use client";

import type { Organisation } from "@cap/web-domain";
import * as SelectPrimitive from "@radix-ui/react-select";
import clsx from "clsx";
import { motion } from "framer-motion";
import {
	ArrowLeft,
	ArrowUpRight,
	Check,
	ChevronDown,
	RotateCw,
} from "lucide-react";
import Link from "next/link";
import { useEffect } from "react";
import { useCurrentUser } from "@/app/Layout/AuthContext";
import { SignedImageUrl } from "@/components/SignedImageUrl";
import type { Organization, Spaces } from "../../dashboard-data";
import type { AnalyticsRange } from "../types";

interface HeaderProps {
	options: { value: AnalyticsRange; label: string }[];
	value: AnalyticsRange;
	onChange: (value: AnalyticsRange) => void;
	isLoading?: boolean;
	isFetching?: boolean;
	onRefresh?: () => void;
	organizations?: Organization[] | null;
	activeOrganization?: Organization | null;
	spacesData?: Spaces[] | null;
	selectedOrganizationId?: Organisation.OrganisationId | null;
	selectedSpaceId?: string | null;
	onOrganizationChange?: (organizationId: Organisation.OrganisationId) => void;
	onSpaceChange?: (spaceId: string | null) => void;
	hideCapsSelect?: boolean;
	capId?: string | null;
	capName?: string | null;
}

const chip =
	"flex items-center gap-2 h-10 rounded-xl border border-gray-4 bg-gray-1 px-3.5 shadow-[0_1px_2px_rgba(0,0,0,0.04)] outline-none transition-colors hover:bg-gray-2 focus-visible:ring-2 focus-visible:ring-blue-9/40";

export default function Header({
	options,
	value,
	onChange,
	isLoading,
	isFetching,
	onRefresh,
	organizations,
	activeOrganization,
	spacesData,
	selectedOrganizationId,
	selectedSpaceId,
	onOrganizationChange,
	onSpaceChange,
	hideCapsSelect = false,
	capId,
	capName,
}: HeaderProps) {
	const user = useCurrentUser();

	useEffect(() => {
		const currentOrgId =
			selectedOrganizationId || activeOrganization?.organization.id;

		if (selectedSpaceId) {
			const space = spacesData?.find((s) => s.id === selectedSpaceId);
			if (!space || space.organizationId !== currentOrgId) {
				onSpaceChange?.(null);
			}
		}
	}, [
		selectedOrganizationId,
		selectedSpaceId,
		spacesData,
		activeOrganization,
		onSpaceChange,
	]);

	if (!activeOrganization) {
		return null;
	}

	const selectedOrgId =
		selectedOrganizationId || activeOrganization.organization.id;
	const selectedOrg =
		organizations?.find((org) => org.organization.id === selectedOrgId) ||
		activeOrganization;

	const filteredSpaces = spacesData?.filter(
		(space) => space.organizationId === selectedOrgId,
	);

	const handleOrgChange = (next: string) => {
		if (next.startsWith("space:")) {
			const spaceId = next.replace("space:", "");
			const space = filteredSpaces?.find((s) => s.id === spaceId);
			if (space) {
				onSpaceChange?.(spaceId);
				onOrganizationChange?.(
					space.organizationId as Organisation.OrganisationId,
				);
			}
		} else {
			onSpaceChange?.(null);
			onOrganizationChange?.(next as Organisation.OrganisationId);
		}
	};

	const selectedSpace = selectedSpaceId
		? filteredSpaces?.find((s) => s.id === selectedSpaceId)
		: null;

	const myCapsLabel = user?.name ? `${user.name}'s Caps` : "My Caps";
	const displayName = selectedSpace ? selectedSpace.name : myCapsLabel;
	const displayIcon = selectedSpace
		? selectedSpace.iconUrl
		: user?.imageUrl || selectedOrg?.organization.iconUrl || undefined;
	const displayIconName = selectedSpace
		? selectedSpace.name
		: user?.name || selectedOrg?.organization.name || "My Caps";

	const selectValue = selectedSpaceId
		? `space:${selectedSpaceId}`
		: activeOrganization.organization.id;

	return (
		<div className="flex flex-wrap gap-2.5 items-center">
			{capId && (
				<>
					<Link
						href="/dashboard/analytics"
						className={clsx(chip, "justify-center w-10 px-0")}
						aria-label="Back to all analytics"
					>
						<ArrowLeft className="size-4 text-gray-11" />
					</Link>
					<a
						href={`/s/${capId}`}
						target="_blank"
						rel="noreferrer"
						className={clsx(chip, "group max-w-[min(420px,100%)]")}
					>
						<span className="flex flex-shrink-0 justify-center items-center rounded-md size-5 bg-[#4785ff]">
							<svg viewBox="0 0 12 12" className="size-2" aria-hidden="true">
								<path d="M3 1.8v8.4L10 6z" fill="white" />
							</svg>
						</span>
						{capName ? (
							<span className="text-sm font-semibold truncate text-gray-12">
								{capName}
							</span>
						) : (
							<span className="w-32 h-4 rounded animate-pulse bg-gray-4" />
						)}
						<ArrowUpRight className="flex-shrink-0 transition-transform size-3.5 text-gray-10 group-hover:translate-x-px group-hover:-translate-y-px" />
					</a>
				</>
			)}

			{!hideCapsSelect && (
				<SelectPrimitive.Root
					value={selectValue}
					onValueChange={handleOrgChange}
					disabled={isLoading}
				>
					<SelectPrimitive.Trigger
						className={clsx(
							chip,
							"disabled:opacity-50 disabled:cursor-not-allowed",
						)}
					>
						<SignedImageUrl
							image={displayIcon}
							name={displayIconName}
							className="flex-shrink-0 size-5"
						/>
						<span className="text-sm font-semibold text-gray-12">
							{displayName}
						</span>
						<SelectPrimitive.Icon>
							<ChevronDown className="size-4 text-gray-9" />
						</SelectPrimitive.Icon>
					</SelectPrimitive.Trigger>

					<SelectPrimitive.Portal>
						<SelectPrimitive.Content
							className="z-50 min-w-[220px] rounded-xl border border-gray-4 bg-gray-1 shadow-lg overflow-hidden data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2"
							position="popper"
							sideOffset={6}
						>
							<SelectPrimitive.Viewport className="p-1">
								<SelectItem value={activeOrganization.organization.id}>
									<SignedImageUrl
										image={
											user?.imageUrl || activeOrganization.organization.iconUrl
										}
										name={user?.name || activeOrganization.organization.name}
										className="flex-shrink-0 size-5"
									/>
									<SelectPrimitive.ItemText>
										{myCapsLabel}
									</SelectPrimitive.ItemText>
								</SelectItem>
								{filteredSpaces && filteredSpaces.length > 0 && (
									<>
										<div className="px-3 pt-3 pb-1 text-xs font-medium text-gray-10">
											Spaces
										</div>
										{filteredSpaces.map((space) => (
											<SelectItem key={space.id} value={`space:${space.id}`}>
												<SignedImageUrl
													image={space.iconUrl}
													name={space.name}
													className="flex-shrink-0 size-5"
												/>
												<SelectPrimitive.ItemText>
													{space.name}
												</SelectPrimitive.ItemText>
											</SelectItem>
										))}
									</>
								)}
							</SelectPrimitive.Viewport>
						</SelectPrimitive.Content>
					</SelectPrimitive.Portal>
				</SelectPrimitive.Root>
			)}

			<fieldset className="flex items-center gap-0.5 p-1 h-10 rounded-xl border shadow-[0_1px_2px_rgba(0,0,0,0.04)] border-gray-4 bg-gray-1 m-0 min-w-0">
				<legend className="sr-only">Date range</legend>
				{options.map((option) => {
					const selected = option.value === value;
					return (
						<button
							key={option.value}
							type="button"
							aria-pressed={selected}
							onClick={() => onChange(option.value)}
							className={clsx(
								"relative h-full px-3 text-[13px] font-medium rounded-lg transition-colors outline-none focus-visible:ring-2 focus-visible:ring-blue-9/40",
								selected ? "text-gray-1" : "text-gray-10 hover:text-gray-12",
							)}
						>
							{selected && (
								<motion.span
									layoutId="analytics-range-pill"
									className="absolute inset-0 rounded-lg bg-gray-12"
									transition={{ type: "spring", stiffness: 500, damping: 38 }}
								/>
							)}
							<span className="relative whitespace-nowrap">{option.label}</span>
						</button>
					);
				})}
			</fieldset>

			{onRefresh && (
				<button
					type="button"
					onClick={onRefresh}
					disabled={isFetching}
					className={clsx(
						chip,
						"justify-center w-10 px-0 disabled:cursor-default",
					)}
					aria-label="Refresh analytics"
				>
					<RotateCw
						className={clsx(
							"size-4 text-gray-11",
							isFetching && "animate-spin [animation-duration:0.8s]",
						)}
					/>
				</button>
			)}
		</div>
	);
}

function SelectItem({
	value,
	children,
}: {
	value: string;
	children: React.ReactNode;
}) {
	return (
		<SelectPrimitive.Item
			value={value}
			className="flex relative gap-2 items-center py-2 pr-8 pl-3 w-full text-sm rounded-lg transition-colors cursor-pointer outline-none text-gray-12 data-[highlighted]:bg-gray-3"
		>
			{children}
			<SelectPrimitive.ItemIndicator className="absolute right-2.5">
				<Check className="size-3.5 text-gray-11" />
			</SelectPrimitive.ItemIndicator>
		</SelectPrimitive.Item>
	);
}
