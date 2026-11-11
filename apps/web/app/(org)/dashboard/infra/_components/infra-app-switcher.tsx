"use client";

import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	commandScore,
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@cap/ui";
import clsx from "clsx";
import { Check, ChevronDown, Plus } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { SignedImageUrl } from "@/components/SignedImageUrl";
import { Tooltip } from "@/components/Tooltip";
import { infraAppPath, parseInfraPathname } from "@/lib/infra-routes";
import { useDashboardContext } from "../../Contexts";
import { CreateAppDialog } from "./create-app-dialog";
import { EnvironmentBadge } from "./environment-badge";
import { rememberInfraApp } from "./remember-infra-app";

export function InfraAppSwitcher({
	collapsed = false,
	placement = "sidebar",
}: {
	collapsed?: boolean;
	placement?: "sidebar" | "mobile";
}) {
	const { infraApps } = useDashboardContext();
	const pathname = usePathname();
	const router = useRouter();
	const [open, setOpen] = useState(false);
	const [createOpen, setCreateOpen] = useState(false);
	const { appId, section } = parseInfraPathname(pathname);
	const apps = infraApps ?? [];
	const current = apps.find((app) => app.id === appId) ?? null;

	const searchText = useMemo(
		() => new Map(apps.map((app) => [app.id, app.name.toLowerCase()])),
		[apps],
	);

	if (!current) return null;

	const selectApp = (id: string) => {
		setOpen(false);
		if (id === current.id) return;
		rememberInfraApp(id);
		router.push(infraAppPath(id, section ?? ""));
	};

	return (
		<>
			<Popover open={open} onOpenChange={setOpen}>
				<Tooltip
					disable={open || !collapsed}
					position="right"
					content={current.name}
				>
					<PopoverTrigger asChild>
						<button
							type="button"
							aria-label={`Current app ${current.name}. Switch app`}
							className={clsx(
								"flex items-center text-left rounded-xl transition-colors outline-none bg-gray-3 hover:bg-gray-4 focus-visible:ring-2 focus-visible:ring-gray-8",
								collapsed
									? "justify-center mx-auto size-10"
									: "gap-2.5 p-2 w-full",
								placement === "mobile" && "max-w-[224px] border border-gray-5",
							)}
						>
							<SignedImageUrl
								image={null}
								name={current.name}
								letterClass="text-xs"
								className={clsx(
									"relative flex-shrink-0",
									collapsed ? "size-6" : "size-7",
								)}
							/>
							{!collapsed && (
								<>
									<span className="flex flex-col flex-1 gap-0.5 min-w-0">
										<span className="text-sm leading-tight truncate text-gray-12">
											{current.name}
										</span>
										<span>
											<EnvironmentBadge
												environment={current.environment}
												size="xs"
											/>
										</span>
									</span>
									<ChevronDown
										data-state={open ? "open" : "closed"}
										className="transition-transform duration-200 size-4 shrink-0 text-gray-10 data-[state=open]:rotate-180"
									/>
								</>
							)}
						</button>
					</PopoverTrigger>
				</Tooltip>
				<PopoverContent
					side={placement === "mobile" ? "top" : "bottom"}
					align="start"
					className="p-0 w-[260px] z-[120]"
				>
					<Command
						filter={(value, search) =>
							commandScore(searchText.get(value) ?? value, search)
						}
					>
						{apps.length > 6 && <CommandInput placeholder="Search apps" />}
						<CommandEmpty>No apps found</CommandEmpty>
						<CommandGroup>
							{apps.map((app) => {
								const selected = app.id === current.id;
								return (
									<CommandItem
										key={app.id}
										value={app.id}
										onSelect={() => selectApp(app.id)}
										className="flex gap-2 items-center rounded-lg"
									>
										<SignedImageUrl
											image={null}
											name={app.name}
											letterClass="text-[10px]"
											className="relative flex-shrink-0 size-5"
										/>
										<span
											className={clsx(
												"flex-1 text-sm truncate",
												selected ? "text-gray-12" : "text-gray-11",
											)}
										>
											{app.name}
										</span>
										<EnvironmentBadge environment={app.environment} size="xs" />
										<Check
											size={16}
											className={clsx(
												"shrink-0 text-gray-12",
												selected ? "opacity-100" : "opacity-0",
											)}
										/>
									</CommandItem>
								);
							})}
						</CommandGroup>
						<div className="p-1 border-t border-gray-4">
							<button
								type="button"
								onClick={() => {
									setOpen(false);
									setCreateOpen(true);
								}}
								className="flex gap-2 items-center px-2 py-1.5 w-full text-sm rounded-lg transition-colors text-gray-11 hover:bg-gray-4 hover:text-gray-12"
							>
								<Plus size={16} />
								New app
							</button>
						</div>
					</Command>
				</PopoverContent>
			</Popover>
			<CreateAppDialog open={createOpen} onOpenChange={setCreateOpen} />
		</>
	);
}
