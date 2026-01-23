"use client";

import type { Organisation } from "@inflight/web-domain";
import * as SelectPrimitive from "@radix-ui/react-select";
import clsx from "clsx";
import {
	ArrowLeft,
	ChevronDown,
	ChevronLeft,
	ChevronRight,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useCurrentUser } from "@/app/Layout/AuthContext";
import { SignedImageUrl } from "@/components/SignedImageUrl";
import type { Organization, Spaces } from "../../dashboard-data";
import type { AnalyticsRange } from "../types";

interface HeaderProps {
	options: { value: AnalyticsRange; label: string }[];
	value: AnalyticsRange;
	onChange: (value: AnalyticsRange) => void;
	isLoading?: boolean;
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

const DATE_RANGE_OPTIONS = [
	{ value: "today", label: "Today" },
	{ value: "yesterday", label: "Yesterday" },
	{ value: "24h", label: "Last 24 hours" },
	{ value: "7d", label: "Last 7 days" },
	{ value: "30d", label: "Last 30 days" },
	{ value: "wtd", label: "Week to date" },
	{ value: "mtd", label: "Month to date" },
	{ value: "lifetime", label: "Lifetime" },
] as const;

const mapToBackendRange = (value: string): AnalyticsRange => {
	if (
		value === "24h" ||
		value === "7d" ||
		value === "30d" ||
		value === "lifetime"
	) {
		return value as AnalyticsRange;
	}
	if (value === "today" || value === "yesterday") {
		return "24h";
	}
	if (value === "wtd") {
		return "7d";
	}
	if (value === "mtd") {
		return "30d";
	}
	return "7d";
};

const getDisplayValue = (
	backendValue: AnalyticsRange,
	lastUISelection?: string,
): string => {
	if (
		lastUISelection &&
		(lastUISelection === "today" || lastUISelection === "yesterday")
	) {
		if (backendValue === "24h") {
			return lastUISelection;
		}
	}
	if (lastUISelection && lastUISelection === "wtd") {
		if (backendValue === "7d") {
			return lastUISelection;
		}
	}
	if (lastUISelection && lastUISelection === "mtd") {
		if (backendValue === "30d") {
			return lastUISelection;
		}
	}
	if (backendValue === "lifetime") return "lifetime";
	if (backendValue === "24h") return "24h";
	if (backendValue === "7d") return "7d";
	if (backendValue === "30d") return "30d";
	return "7d";
};

export default function Header({
	options: _options,
	value,
	onChange,
	isLoading,
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
	const router = useRouter();
	const [open, setOpen] = useState(false);
	const [orgOpen, setOrgOpen] = useState(false);
	const [lastUISelection, setLastUISelection] = useState<string | undefined>(
		undefined,
	);

	useEffect(() => {
		if (!lastUISelection) {
			if (value === "24h") {
				setLastUISelection("24h");
			} else if (value === "7d") {
				setLastUISelection("7d");
			} else if (value === "30d") {
				setLastUISelection("30d");
			} else if (value === "lifetime") {
				setLastUISelection("lifetime");
			}
		}
	}, [value, lastUISelection]);

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

	const selectedOption =
		DATE_RANGE_OPTIONS.find(
			(opt) => opt.value === getDisplayValue(value, lastUISelection),
		) || DATE_RANGE_OPTIONS[3];

	const handleValueChange = (newValue: string) => {
		setLastUISelection(newValue);
		const backendRange = mapToBackendRange(newValue);
		onChange(backendRange);
		setOpen(false);
	};

	const handlePrevious = () => {
		const currentIndex = DATE_RANGE_OPTIONS.findIndex(
			(opt) => opt.value === selectedOption.value,
		);
		if (currentIndex > 0) {
			const prevOption = DATE_RANGE_OPTIONS[currentIndex - 1];
			handleValueChange(prevOption?.value ?? "");
		}
	};

	const handleNext = () => {
		const currentIndex = DATE_RANGE_OPTIONS.findIndex(
			(opt) => opt.value === selectedOption.value,
		);
		if (currentIndex < DATE_RANGE_OPTIONS.length - 1) {
			const nextOption = DATE_RANGE_OPTIONS[currentIndex + 1];
			handleValueChange(nextOption?.value ?? "");
		}
	};

	const canGoPrevious =
		DATE_RANGE_OPTIONS.findIndex((opt) => opt.value === selectedOption.value) >
		0;
	const canGoNext =
		DATE_RANGE_OPTIONS.findIndex((opt) => opt.value === selectedOption.value) <
		DATE_RANGE_OPTIONS.length - 1;

	const selectedOrgId =
		selectedOrganizationId || activeOrganization?.organization.id;
	const selectedOrg =
		organizations?.find((org) => org.organization.id === selectedOrgId) ||
		activeOrganization ||
		organizations?.[0];

	const filteredSpaces = spacesData?.filter(
		(space) => space.organizationId === selectedOrgId,
	);

	const handleOrgChange = (value: string) => {
		if (value.startsWith("space:")) {
			const spaceId = value.replace("space:", "");
			const space = filteredSpaces?.find((s) => s.id === spaceId);
			if (space) {
				onSpaceChange?.(spaceId);
				onOrganizationChange?.(
					space.organizationId as Organisation.OrganisationId,
				);
			}
		} else {
			onSpaceChange?.(null);
			onOrganizationChange?.(value as Organisation.OrganisationId);
		}
		setOrgOpen(false);
	};

	const selectedSpace = selectedSpaceId
		? filteredSpaces?.find((s) => s.id === selectedSpaceId)
		: null;

	const isMyCapsSelected =
		!selectedSpaceId &&
		selectedOrg?.organization.id === activeOrganization?.organization.id;

	const displayName = selectedSpace
		? selectedSpace.name
		: isMyCapsSelected
			? user?.name
				? `${user.name}'s Caps`
				: "My Caps"
			: selectedOrg?.organization.name || "Select organization";

	const displayIcon = selectedSpace
		? selectedSpace.iconUrl
		: isMyCapsSelected
			? user?.imageUrl || selectedOrg?.organization.iconUrl || undefined
			: selectedOrg?.organization.iconUrl;

	const displayIconName = selectedSpace
		? selectedSpace.name
		: isMyCapsSelected
			? user?.name || selectedOrg?.organization.name || "My Caps"
			: selectedOrg?.organization.name || "Select organization";

	if (!activeOrganization) {
		return null;
	}

	const selectValue = selectedSpaceId
		? `space:${selectedSpaceId}`
		: selectedOrgId || activeOrganization.organization.id;

	const handleBackClick = () => {
		router.push("/dashboard/analytics");
	};

	return (
		<div className="flex gap-2 items-center">
			{capId && (
				<div className="flex items-center rounded-xl border border-gray-4 bg-gray-2 overflow-hidden">
					<button
						type="button"
						onClick={handleBackClick}
						className="flex items-center justify-center px-3 py-2.5 border-r border-gray-4 transition-colors text-gray-11 cursor-pointer"
					>
						<ArrowLeft className="size-4" />
					</button>
					<div className="flex items-center px-4 py-2.5">
						{capName ? (
							<span className="text-sm font-semibold text-gray-12">
								{capName}
							</span>
						) : (
							<div className="h-4 w-32 rounded bg-gray-4 animate-pulse" />
						)}
					</div>
				</div>
			)}
			{!hideCapsSelect && (
				<SelectPrimitive.Root
					value={selectValue}
					onValueChange={handleOrgChange}
					open={orgOpen}
					onOpenChange={setOrgOpen}
					disabled={isLoading}
				>
					<SelectPrimitive.Trigger className="flex items-center gap-2 rounded-xl border border-gray-4 bg-gray-2 px-4 py-2.5 outline-none transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
						{displayIconName && (
							<SignedImageUrl
								image={displayIcon}
								name={displayIconName}
								className="size-5 flex-shrink-0"
							/>
						)}
						<span className="text-sm font-semibold text-gray-12">
							{displayName}
						</span>
						<SelectPrimitive.Icon className="ml-1">
							<ChevronDown className="size-4 text-gray-9" />
						</SelectPrimitive.Icon>
					</SelectPrimitive.Trigger>

					<SelectPrimitive.Portal>
						<SelectPrimitive.Content
							className="z-50 min-w-[200px] rounded-xl border border-gray-4 bg-gray-2 shadow-lg overflow-hidden data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2"
							position="popper"
							sideOffset={4}
						>
							<SelectPrimitive.Viewport className="p-1">
								<SelectPrimitive.Item
									key={activeOrganization.organization.id}
									value={activeOrganization.organization.id}
									className="relative flex w-full cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-sm outline-none transition-colors font-semibold text-gray-12 data-[state=checked]:bg-gray-3 data-[highlighted]:bg-gray-3 data-[highlighted]:text-gray-12"
								>
									<SignedImageUrl
										image={
											user?.imageUrl || activeOrganization.organization.iconUrl
										}
										name={user?.name || activeOrganization.organization.name}
										className="size-5 flex-shrink-0"
									/>
									<SelectPrimitive.ItemText>
										{user?.name ? `${user.name}'s Caps` : "My Caps"}
									</SelectPrimitive.ItemText>
								</SelectPrimitive.Item>
								{filteredSpaces && filteredSpaces.length > 0 && (
									<>
										<div className="px-3 py-2 text-xs font-semibold text-gray-9 uppercase tracking-wider">
											Spaces
										</div>
										{filteredSpaces.map((space) => {
											return (
												<SelectPrimitive.Item
													key={space.id}
													value={`space:${space.id}`}
													className="relative flex w-full cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-sm outline-none transition-colors text-gray-12 data-[state=checked]:bg-gray-3 data-[highlighted]:bg-gray-3 data-[highlighted]:text-gray-12"
												>
													<SignedImageUrl
														image={space.iconUrl}
														name={space.name}
														className="size-5 flex-shrink-0"
													/>
													<SelectPrimitive.ItemText>
														{space.name}
													</SelectPrimitive.ItemText>
												</SelectPrimitive.Item>
											);
										})}
									</>
								)}
							</SelectPrimitive.Viewport>
						</SelectPrimitive.Content>
					</SelectPrimitive.Portal>
				</SelectPrimitive.Root>
			)}

			<SelectPrimitive.Root
				value={selectedOption.value}
				onValueChange={handleValueChange}
				open={open}
				onOpenChange={setOpen}
				disabled={isLoading}
			>
				<div className="flex items-center rounded-xl border border-gray-4 bg-gray-2 overflow-hidden">
					<button
						type="button"
						onClick={handlePrevious}
						disabled={!canGoPrevious || isLoading}
						className={clsx(
							"flex items-center justify-center px-3 py-2.5 border-r border-gray-4 transition-colors",
							canGoPrevious && !isLoading
								? "text-gray-11 cursor-pointer"
								: "text-gray-6 cursor-not-allowed",
						)}
					>
						<ChevronLeft className="size-4" />
					</button>

					<SelectPrimitive.Trigger className="flex-1 flex items-center justify-between px-4 py-2.5 border-r border-gray-4 outline-none hover:bg-gray-3 transition-colors disabled:opacity-50 disabled:cursor-not-allowed space-x-1">
						<span className="text-sm font-semibold text-gray-12">
							{selectedOption.label}
						</span>
						<SelectPrimitive.Icon>
							<ChevronDown className="size-4 text-gray-9" />
						</SelectPrimitive.Icon>
					</SelectPrimitive.Trigger>

					<button
						type="button"
						onClick={handleNext}
						disabled={!canGoNext || isLoading}
						className={clsx(
							"flex items-center justify-center px-3 py-2.5 transition-colors",
							canGoNext && !isLoading
								? "text-gray-6 cursor-pointer"
								: "text-gray-4 cursor-not-allowed",
						)}
					>
						<ChevronRight className="size-4" />
					</button>
				</div>

				<SelectPrimitive.Portal>
					<SelectPrimitive.Content
						className="z-50 min-w-[200px] rounded-xl border border-gray-4 bg-gray-2 shadow-lg overflow-hidden data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2"
						position="popper"
						sideOffset={4}
					>
						<SelectPrimitive.Viewport className="p-1">
							{DATE_RANGE_OPTIONS.map((option) => {
								const isSelected = selectedOption.value === option.value;
								return (
									<SelectPrimitive.Item
										key={option.value}
										value={option.value}
										className={clsx(
											"relative flex w-full cursor-pointer items-center rounded-lg px-3 py-2 text-sm outline-none transition-colors font-semibold",
											isSelected
												? "bg-gray-3 text-gray-12 data-[highlighted]:bg-gray-3 data-[highlighted]:text-gray-12"
												: "text-gray-12 data-[highlighted]:bg-gray-3 data-[highlighted]:text-gray-12",
										)}
									>
										<SelectPrimitive.ItemText>
											{option.label}
										</SelectPrimitive.ItemText>
									</SelectPrimitive.Item>
								);
							})}
						</SelectPrimitive.Viewport>
					</SelectPrimitive.Content>
				</SelectPrimitive.Portal>
			</SelectPrimitive.Root>
		</div>
	);
}
