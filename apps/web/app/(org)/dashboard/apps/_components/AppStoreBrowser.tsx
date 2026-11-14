"use client";

import { APP_CATEGORY_LABELS, type AppCategory } from "@cap/app-store";
import { Switch } from "@cap/ui";
import clsx from "clsx";
import { Check, Search } from "lucide-react";
import Link from "next/link";
import { useId, useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { setAppStoreAdminsOnlyAction } from "@/actions/app-store";
import type { InstallationView } from "@/lib/app-store/installations";
import { AppIcon } from "./AppIcon";
import { PlatformBadges } from "./PlatformBadges";
import type { AppListing, OrganizationOption } from "./types";

const INSTALLED = "installed";
const ALL = "all";

export function AppStoreBrowser({
	apps,
	installations,
	activeOrganization,
}: {
	apps: AppListing[];
	installations: InstallationView[];
	activeOrganization: OrganizationOption | null;
}) {
	const [query, setQuery] = useState("");
	const [filter, setFilter] = useState<string>(ALL);
	const installedIds = useMemo(
		() => new Set(installations.map((installation) => installation.appId)),
		[installations],
	);

	const categories = useMemo(() => {
		const present = new Set(apps.flatMap((app) => app.categories));
		return (Object.keys(APP_CATEGORY_LABELS) as AppCategory[]).filter(
			(category) => present.has(category),
		);
	}, [apps]);

	const visible = useMemo(() => {
		const needle = query.trim().toLowerCase();
		return apps.filter((app) => {
			if (filter === INSTALLED && !installedIds.has(app.id)) return false;
			if (
				filter !== ALL &&
				filter !== INSTALLED &&
				!app.categories.includes(filter)
			)
				return false;
			if (!needle) return true;
			return [app.name, app.description, app.author.name, ...app.keywords]
				.join(" ")
				.toLowerCase()
				.includes(needle);
		});
	}, [apps, filter, installedIds, query]);

	const filters = [
		{ id: ALL, label: "All" },
		{
			id: INSTALLED,
			label: `Installed${installedIds.size ? ` ${installedIds.size}` : ""}`,
		},
		...categories.map((category) => ({
			id: category,
			label: APP_CATEGORY_LABELS[category],
		})),
	];

	return (
		<div className="flex flex-col gap-6">
			<div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
				<div className="max-w-xl">
					<h1 className="text-xl font-medium text-gray-12">Apps</h1>
					<p className="mt-1 text-[13px] leading-relaxed text-gray-10">
						Add backgrounds, caption styles and connections to the tools you
						already use. Install an app once and it works on the web and in Cap
						Desktop.
					</p>
				</div>
				<label className="relative w-full md:w-72">
					<span className="sr-only">Search apps</span>
					<Search
						className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-gray-9"
						aria-hidden
					/>
					<input
						type="search"
						value={query}
						onChange={(event) => setQuery(event.target.value)}
						placeholder="Search apps"
						className="h-9 w-full rounded-full border border-gray-4 bg-gray-1 pl-9 pr-3 text-[13px] text-gray-12 outline-none transition-colors placeholder:text-gray-8 hover:border-gray-5 focus:border-gray-7"
					/>
				</label>
			</div>

			<div
				className="flex flex-wrap gap-1.5"
				role="tablist"
				aria-label="Filter apps"
			>
				{filters.map((item) => (
					<button
						key={item.id}
						type="button"
						role="tab"
						aria-selected={filter === item.id}
						onClick={() => setFilter(item.id)}
						className={clsx(
							"h-8 rounded-full px-3 text-[12px] font-medium transition-colors",
							filter === item.id
								? "bg-gray-12 text-gray-1"
								: "bg-gray-3 text-gray-11 hover:bg-gray-4",
						)}
					>
						{item.label}
					</button>
				))}
			</div>

			{visible.length === 0 ? (
				<div className="rounded-xl border border-dashed border-gray-4 px-6 py-12 text-center">
					<p className="text-[13px] font-medium text-gray-12">
						{filter === INSTALLED && !query
							? "You have not installed any apps yet"
							: "No apps match your search"}
					</p>
					<p className="mt-1 text-[12px] text-gray-9">
						Anyone can build a Cap App.{" "}
						<a
							href="https://github.com/CapSoftware/Cap/tree/main/app-store"
							target="_blank"
							rel="noopener noreferrer"
							className="text-gray-12 underline underline-offset-2"
						>
							Learn how
						</a>
					</p>
				</div>
			) : (
				<div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
					{visible.map((app) => (
						<AppCard
							key={app.id}
							app={app}
							installed={installedIds.has(app.id)}
						/>
					))}
				</div>
			)}

			<div className="flex flex-col gap-3 border-t border-gray-3 pt-5 md:flex-row md:items-center md:justify-between">
				<p className="text-[12px] text-gray-9">
					Want to build one? Apps are open source and live in the{" "}
					<a
						href="https://github.com/CapSoftware/Cap/tree/main/app-store"
						target="_blank"
						rel="noopener noreferrer"
						className="text-gray-12 underline underline-offset-2"
					>
						Cap repository
					</a>
					.
				</p>
				{activeOrganization?.canManage && (
					<AdminsOnlyToggle organization={activeOrganization} />
				)}
			</div>
		</div>
	);
}

function AppCard({ app, installed }: { app: AppListing; installed: boolean }) {
	return (
		<Link
			href={`/dashboard/apps/${app.id}`}
			className="group flex flex-col gap-3 rounded-xl border border-gray-3 bg-gray-1 p-4 transition-colors hover:border-gray-4 hover:bg-gray-2 focus-visible:outline-2 focus-visible:outline-blue-500"
		>
			<div className="flex items-start gap-3">
				<AppIcon src={app.icon.url} name={app.name} />
				<div className="min-w-0 flex-1">
					<p className="truncate text-[14px] font-medium text-gray-12">
						{app.name}
					</p>
					<p className="truncate text-[12px] text-gray-9">
						{app.firstParty ? "Cap" : app.author.name}
					</p>
				</div>
				{installed && (
					<span className="inline-flex shrink-0 items-center gap-1 rounded-md bg-green-500/10 px-1.5 py-0.5 text-[11px] font-medium text-green-600">
						<Check className="size-3" aria-hidden />
						Installed
					</span>
				)}
			</div>
			<p className="line-clamp-2 min-h-[2.5em] text-[12px] leading-[1.25rem] text-gray-10">
				{app.description}
			</p>
			<PlatformBadges platforms={app.platforms} />
		</Link>
	);
}

function AdminsOnlyToggle({
	organization,
}: {
	organization: OrganizationOption;
}) {
	const labelId = useId();
	const [checked, setChecked] = useState(organization.adminsOnly);
	const [pending, startTransition] = useTransition();
	return (
		<div className="flex items-center gap-3 text-[12px] text-gray-10">
			<span id={labelId} className="max-w-xs md:text-right">
				Only owners and admins of {organization.name} can install apps that
				connect to other services
			</span>
			<Switch
				aria-labelledby={labelId}
				checked={checked}
				disabled={pending}
				onCheckedChange={(next) => {
					setChecked(next);
					startTransition(async () => {
						const result = await setAppStoreAdminsOnlyAction(
							organization.id,
							next,
						);
						if (!result.ok) {
							setChecked(!next);
							toast.error(result.error);
						}
					});
				}}
			/>
		</div>
	);
}
