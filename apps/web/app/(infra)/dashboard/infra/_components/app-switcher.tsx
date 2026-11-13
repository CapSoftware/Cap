"use client";

import * as Menu from "@radix-ui/react-dropdown-menu";
import clsx from "clsx";
import { Check, ChevronsUpDown, Plus } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { infraAppPath, parseInfraPathname } from "@/lib/infra-routes";
import type { InfraAppSummary } from "../infra-data";
import { NewAppModal } from "./create-app";
import { infraMono, infraSans } from "./fonts";
import { rememberInfraApp } from "./remember-infra-app";
import { EnvTag, FOCUS } from "./ui";
import { useMayLeave } from "./uploads";

const ITEM =
	"flex cursor-default select-none items-center gap-3 rounded-[7px] px-2.5 py-2 text-[13.5px] text-[rgba(232,236,244,0.8)] outline-none data-[highlighted]:bg-[rgba(222,230,246,0.07)] data-[highlighted]:text-white";

export function AppSwitcher({
	apps,
	appId,
	compact = false,
}: {
	apps: InfraAppSummary[];
	appId: string;
	compact?: boolean;
}) {
	const pathname = usePathname();
	const router = useRouter();
	const [createOpen, setCreateOpen] = useState(false);
	const mayLeave = useMayLeave();
	const { section } = parseInfraPathname(pathname);
	const current = apps.find((app) => app.id === appId) ?? null;

	if (!current) return null;

	const selectApp = (id: string) => {
		if (id === current.id || !mayLeave()) return;
		rememberInfraApp(id);
		router.push(infraAppPath(id, section ?? ""));
	};

	return (
		<>
			<Menu.Root>
				<Menu.Trigger
					aria-label={`App: ${current.name}. Switch app`}
					className={clsx(
						"flex min-w-0 items-center gap-3 rounded-[10px] text-left transition-[background-color,box-shadow] duration-200 hover:bg-[rgba(222,230,246,0.05)] hover:shadow-[inset_0_0_0_1px_rgba(222,230,246,0.16)] data-[state=open]:bg-[rgba(222,230,246,0.05)]",
						compact
							? "h-9 max-w-[58vw] px-3 shadow-[inset_0_0_0_1px_rgba(222,230,246,0.12)]"
							: "w-full bg-[rgba(222,230,246,0.03)] p-2 shadow-[inset_0_0_0_1px_rgba(222,230,246,0.09)]",
						FOCUS,
					)}
				>
					{!compact && <AppMark name={current.name} />}
					<span className="min-w-0 flex-1">
						<span className="block truncate text-[14px] leading-[1.3] text-[#E8ECF4]">
							{current.name}
						</span>
						{!compact && (
							<EnvTag environment={current.environment} className="mt-1" />
						)}
					</span>
					<ChevronsUpDown
						size={14}
						className="shrink-0 text-[rgba(232,236,244,0.4)]"
					/>
				</Menu.Trigger>
				<Menu.Portal>
					<Menu.Content
						align={compact ? "end" : "start"}
						sideOffset={6}
						className={`${infraSans.variable} ${infraMono.variable} z-[500] flex max-h-[min(60vh,var(--radix-dropdown-menu-content-available-height))] w-[260px] flex-col rounded-[12px] bg-[#121317] p-1.5 shadow-[inset_0_0_0_1px_rgba(222,230,246,0.12),0_18px_60px_rgba(0,0,0,0.6)] [font-family:var(--font-infra-sans),system-ui,sans-serif]`}
					>
						<div className="min-h-0 overflow-y-auto">
							{apps.map((app) => (
								<Menu.Item
									key={app.id}
									className={ITEM}
									onSelect={() => selectApp(app.id)}
								>
									<AppMark name={app.name} small />
									<span className="min-w-0 flex-1">
										<span className="block truncate text-[#E8ECF4]">
											{app.name}
										</span>
										<EnvTag environment={app.environment} className="mt-1" />
									</span>
									{app.id === current.id && (
										<Check size={14} className="shrink-0 text-white" />
									)}
								</Menu.Item>
							))}
						</div>
						<Menu.Separator className="mx-1 my-1.5 h-px bg-[rgba(222,230,246,0.08)]" />
						<Menu.Item
							className={clsx(ITEM, "shrink-0")}
							onSelect={() => setCreateOpen(true)}
						>
							<Plus size={14} className="shrink-0" />
							New app
						</Menu.Item>
					</Menu.Content>
				</Menu.Portal>
			</Menu.Root>
			<NewAppModal open={createOpen} onOpenChange={setCreateOpen} />
		</>
	);
}

// A quiet monogram so apps can be told apart at a glance in the switcher.
function AppMark({ name, small = false }: { name: string; small?: boolean }) {
	const letter = Array.from(name.trim())[0]?.toUpperCase() ?? "A";
	return (
		<span
			aria-hidden="true"
			className={clsx(
				"grid shrink-0 place-items-center rounded-[8px] bg-[linear-gradient(160deg,rgba(232,236,244,0.2),rgba(232,236,244,0.05))] font-medium text-[#E8ECF4] shadow-[inset_0_0_0_1px_rgba(222,230,246,0.14),inset_0_1px_0_rgba(255,255,255,0.12)]",
				small ? "size-7 text-[12px]" : "size-9 text-[14px]",
			)}
		>
			{letter}
		</span>
	);
}
