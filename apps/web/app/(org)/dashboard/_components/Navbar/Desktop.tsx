"use client";
import { Button, Logo } from "@cap/ui";
import clsx from "clsx";
import { motion } from "framer-motion";
import { useDetectPlatform } from "hooks/useDetectPlatform";
import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { useEffect } from "react";
import { Tooltip } from "@/components/Tooltip";
import { useDashboardContext } from "../../Contexts";
import AdminNavItems from "./Items";

export const DesktopNav = () => {
	const { toggleSidebarCollapsed, sidebarCollapsed } = useDashboardContext();
	const { platform } = useDetectPlatform();
	const cmdSymbol = platform === "macos" ? "⌘" : "Ctrl";

	useEffect(() => {
		const handleKeyDown = (event: KeyboardEvent) => {
			if (
				event.key === "s" &&
				(event.metaKey || event.ctrlKey) &&
				event.shiftKey
			) {
				event.preventDefault();
				toggleSidebarCollapsed();
			}
		};
		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [toggleSidebarCollapsed]);

	return (
		<motion.aside
			initial={false}
			animate={{
				width: sidebarCollapsed ? 70 : 220,
				transition: {
					duration: 0.6,
					type: "spring",
					bounce: 0.25,
				},
			}}
			className={clsx(
				"hidden relative z-50 flex-1 h-full [grid-area:sidebar] will-change-[width] lg:flex group bg-gray-1",
			)}
		>
			<div className="flex flex-col mx-auto w-full h-full">
				<div className="flex justify-between items-center px-3 pt-5 mb-3.5 w-full truncate min-h-8">
					<Link href="/dashboard">
						<Logo
							hideLogoName={sidebarCollapsed}
							viewBoxDimensions={sidebarCollapsed ? "0 0 40 40" : "0 0 120 40"}
							className={clsx(
								"w-[120px] h-[40px]",
								sidebarCollapsed ? "mx-auto" : "",
							)}
						/>
					</Link>
					<Tooltip
						kbd={[cmdSymbol, "Shift", "S"]}
						position="right"
						content="Toggle collapse"
					>
						<Button
							variant="white"
							onClick={toggleSidebarCollapsed}
							className={clsx(
								"p-0 min-w-[unset] rounded-full transition-all z-10 opacity-0 group-hover:opacity-100",
								sidebarCollapsed ? "size-5 absolute right-0.5 top-7" : "size-7",
							)}
						>
							<ChevronRight
								size={sidebarCollapsed ? 12 : 14}
								className={clsx(
									"transition-transform duration-200 text-gray-12",
									!sidebarCollapsed ? "rotate-180" : "",
								)}
							/>
						</Button>
					</Tooltip>
				</div>
				<div className="flex overflow-y-auto flex-col flex-grow">
					<div className="flex flex-col px-3 h-full">
						<AdminNavItems />
					</div>
				</div>
			</div>
		</motion.aside>
	);
};

export default DesktopNav;
