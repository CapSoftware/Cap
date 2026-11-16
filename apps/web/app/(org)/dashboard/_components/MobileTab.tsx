"use client";

import { buildEnv } from "@cap/env";
import { useClickAway } from "@uidotdev/usehooks";
import clsx from "clsx";
import { Check, ChevronDown } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
	type Dispatch,
	type LegacyRef,
	type MutableRefObject,
	type SetStateAction,
	useRef,
	useState,
} from "react";
import { SignedImageUrl } from "@/components/SignedImageUrl";
import { canUseInfra } from "@/lib/infra-access";
import {
	canViewOrganizationSettings,
	getEffectiveOrganizationRole,
} from "@/lib/permissions/roles";
import { useDashboardContext } from "../Contexts";
import { CapIcon, CodeIcon, CogIcon, LayersIcon } from "./AnimatedIcons";
import { updateActiveOrganization } from "./Navbar/server";

const Tabs = [
	{
		icon: <LayersIcon size={20} />,
		href: "/dashboard/spaces/browse",
		label: "Spaces",
		match: ["/dashboard/spaces"],
	},
	{
		icon: <CapIcon size={25} />,
		href: "/dashboard/caps",
		label: "My Caps",
		match: ["/dashboard/caps", "/dashboard/folder"],
	},
	{
		icon: <CogIcon size={22} />,
		href: "/dashboard/settings/organization",
		label: "Settings",
		match: ["/dashboard/settings"],
		adminOnly: true,
	},
	{
		icon: <CodeIcon size={22} />,
		href: "/dashboard/infra",
		label: "Infra",
		match: ["/dashboard/infra"],
		infraOnly: true,
	},
];

const MobileTab = () => {
	const [open, setOpen] = useState(false);
	const containerRef = useRef<HTMLButtonElement>(null);
	const pathname = usePathname();
	const { activeOrganization: activeOrg, user } = useDashboardContext();
	const currentMember = activeOrg?.members.find(
		(member) => member.userId === user.id,
	);
	const currentRole = getEffectiveOrganizationRole({
		userId: user.id,
		ownerId: activeOrg?.organization.ownerId,
		memberRole: currentMember?.role,
	});
	const canViewSettings = canViewOrganizationSettings(currentRole);
	const showInfra =
		buildEnv.NEXT_PUBLIC_IS_CAP === "true" &&
		canUseInfra(user.email) &&
		activeOrg?.organization.ownerId === user.id;
	const menuRef = useClickAway((e) => {
		if (
			containerRef.current &&
			!containerRef.current.contains(e.target as Node)
		) {
			setOpen(false);
		}
	});
	return (
		<div className="flex sticky bottom-0 z-50 flex-1 gap-4 justify-between items-center px-4 w-screen h-16 border-t lg:hidden border-gray-3 bg-gray-1">
			<div className="relative flex-1 min-w-0">
				<AnimatePresence>
					{open && <OrgsMenu setOpen={setOpen} menuRef={menuRef} />}
				</AnimatePresence>
				<Orgs open={open} setOpen={setOpen} containerRef={containerRef} />
			</div>
			<div className="flex gap-1 items-center h-full shrink-0">
				{Tabs.filter((i) => !i.adminOnly || canViewSettings)
					.filter((i) => !i.infraOnly || showInfra)
					.map((tab) => {
						const isActive = tab.match.some((prefix) =>
							pathname?.startsWith(prefix),
						);
						return (
							<Link
								href={tab.href}
								key={tab.href}
								aria-label={tab.label}
								aria-current={isActive ? "page" : undefined}
								prefetch={tab.infraOnly ? false : undefined}
								className={clsx(
									"flex justify-center items-center rounded-lg transition-colors size-10",
									isActive
										? "bg-gray-3 text-gray-12"
										: "text-gray-10 hover:bg-gray-3 hover:text-gray-12",
								)}
							>
								{tab.icon}
							</Link>
						);
					})}
			</div>
		</div>
	);
};

const Orgs = ({
	setOpen,
	open,
	containerRef,
}: {
	setOpen: Dispatch<SetStateAction<boolean>>;
	open: boolean;
	containerRef: MutableRefObject<HTMLButtonElement | null>;
}) => {
	const { activeOrganization: activeOrg } = useDashboardContext();
	return (
		<button
			type="button"
			onClick={() => setOpen((p) => !p)}
			ref={containerRef}
			className="flex gap-2 items-center w-full max-w-[224px] h-10 pl-1.5 pr-2.5 rounded-full border bg-gray-1 border-gray-4 shadow-[0_1px_2px_rgba(0,0,0,0.05)] transition-colors hover:bg-gray-2 hover:border-gray-5"
		>
			<SignedImageUrl
				image={activeOrg?.organization.iconUrl}
				name={activeOrg?.organization.name ?? "No organization found"}
				letterClass="text-xs"
				className="relative flex-shrink-0 mx-auto size-6"
			/>
			<p className="flex-1 min-w-0 text-sm font-medium text-left truncate text-gray-12">
				{activeOrg?.organization.name}
			</p>
			<ChevronDown
				className={clsx(
					"text-gray-10 size-4 shrink-0 transition-transform",
					open && "rotate-180",
				)}
			/>
		</button>
	);
};

const OrgsMenu = ({
	setOpen,
	menuRef,
}: {
	setOpen: Dispatch<SetStateAction<boolean>>;
	menuRef: MutableRefObject<Element>;
}) => {
	const { activeOrganization: activeOrg, organizationData: orgData } =
		useDashboardContext();
	const router = useRouter();
	return (
		<motion.div
			initial={{ scale: 0.98, opacity: 0 }}
			animate={{ scale: 1, opacity: 1 }}
			exit={{ scale: 0.9, opacity: 0 }}
			transition={{ duration: 0.15 }}
			ref={menuRef as LegacyRef<HTMLDivElement>}
			className={
				"isolate absolute overscroll-contain bottom-12 p-1 space-y-0.5 w-[min(300px,calc(100vw-2rem))] rounded-xl h-fit border bg-gray-1 max-h-[min(60vh,325px)] custom-scroll border-gray-4 shadow-[0_12px_32px_-12px_rgba(0,0,0,0.25)]"
			}
		>
			{orgData?.map((organization) => {
				const isSelected =
					activeOrg?.organization.id === organization.organization.id;
				return (
					<button
						type="button"
						className={clsx(
							"p-2 rounded-lg transition-colors duration-300 group w-full text-left",
							isSelected
								? "pointer-events-none"
								: "text-gray-10 hover:text-gray-12 hover:bg-gray-3",
						)}
						key={`${organization.organization.name}-organization`}
						onClick={async () => {
							await updateActiveOrganization(organization.organization.id);
							setOpen(false);
							router.push("/dashboard/caps");
						}}
					>
						<div className="flex gap-2 items-center w-full">
							<SignedImageUrl
								image={organization.organization.iconUrl}
								name={organization.organization.name}
								letterClass="text-xs"
								className="relative flex-shrink-0 size-5"
							/>
							<p
								className={clsx(
									"flex-1 text-sm truncate transition-colors duration-200 group-hover:text-gray-12",
									isSelected ? "text-gray-12" : "text-gray-10",
								)}
							>
								{organization.organization.name}
							</p>
							{isSelected && (
								<Check size={18} className={"ml-auto text-gray-12"} />
							)}
						</div>
					</button>
				);
			})}
		</motion.div>
	);
};

export default MobileTab;
