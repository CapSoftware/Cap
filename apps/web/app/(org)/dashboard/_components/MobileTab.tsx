"use client";

import { Avatar } from "@cap/ui";
import { useClickAway } from "@uidotdev/usehooks";
import clsx from "clsx";
import { Check, ChevronDown } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
	type Dispatch,
	type LegacyRef,
	type MutableRefObject,
	type SetStateAction,
	useRef,
	useState,
} from "react";
import { useDashboardContext } from "../Contexts";
import { CapIcon, CogIcon, LayersIcon } from "./AnimatedIcons";
import { updateActiveOrganization } from "./Navbar/server";

const Tabs = [
	{ icon: <LayersIcon size={20} />, href: "/dashboard/spaces/browse" },
	{ icon: <CapIcon size={25} />, href: "/dashboard/caps" },
	{
		icon: <CogIcon size={22} />,
		href: "/dashboard/settings/organization",
		ownerOnly: true,
	},
];

const MobileTab = () => {
	const [open, setOpen] = useState(false);
	const containerRef = useRef<HTMLDivElement>(null);
	const { activeOrganization: activeOrg, user } = useDashboardContext();
	const isOwner = activeOrg?.organization.ownerId === user.id;
	const menuRef = useClickAway((e) => {
		if (
			containerRef.current &&
			!containerRef.current.contains(e.target as Node)
		) {
			setOpen(false);
		}
	});
	return (
		<div className="flex sticky bottom-0 z-50 flex-1 justify-between items-center px-5 w-screen h-16 border-t lg:hidden border-gray-5 bg-gray-1">
			<AnimatePresence>
				{open && <OrgsMenu setOpen={setOpen} menuRef={menuRef} />}
			</AnimatePresence>
			<Orgs open={open} setOpen={setOpen} containerRef={containerRef} />
			<div className="flex gap-6 justify-between items-center h-full text-gray-11">
				{Tabs.filter((i) => !i.ownerOnly || isOwner).map((tab) => (
					<Link href={tab.href} key={tab.href}>
						{tab.icon}
					</Link>
				))}
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
	containerRef: MutableRefObject<HTMLDivElement | null>;
}) => {
	const { activeOrganization: activeOrg } = useDashboardContext();
	return (
		<div
			onClick={() => setOpen((p) => !p)}
			ref={containerRef}
			className="flex gap-1.5 items-center p-2 rounded-full border bg-gray-3 border-gray-5"
		>
			{activeOrg?.organization.iconUrl ? (
				<div className="overflow-hidden relative flex-shrink-0 rounded-full size-[24px]">
					<Image
						src={activeOrg.organization.iconUrl}
						alt={activeOrg.organization.name || "Organization icon"}
						fill
						className="object-cover"
					/>
				</div>
			) : (
				<Avatar
					letterClass="text-xs"
					className="relative flex-shrink-0 mx-auto size-6"
					name={activeOrg?.organization.name ?? "No organization found"}
				/>
			)}
			<p className="text-xs mr-2 text-gray-12 truncate w-fit max-w-[90px]">
				{activeOrg?.organization.name}
			</p>
			<ChevronDown
				className={clsx(
					"text-gray-11 size-4 transition-transform",
					open && "rotate-180",
				)}
			/>
		</div>
	);
};

const OrgsMenu = ({
	setOpen,
	menuRef,
}: {
	setOpen: Dispatch<SetStateAction<boolean>>;
	menuRef: MutableRefObject<HTMLDivElement | null>;
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
				"isolate absolute overscroll-contain bottom-14 p-2 space-y-1.5 w-full rounded-xl h-fit border bg-gray-3 max-h-[325px] custom-scroll max-w-[200px] border-gray-4"
			}
		>
			{orgData?.map((organization) => {
				const isSelected =
					activeOrg?.organization.id === organization.organization.id;
				return (
					<div
						className={clsx(
							"p-2 rounded-lg transition-colors duration-300 group",
							isSelected
								? "pointer-events-none"
								: "text-gray-10 hover:text-gray-12 hover:bg-gray-6",
						)}
						key={organization.organization.name + "-organization"}
						onClick={async () => {
							await updateActiveOrganization(organization.organization.id);
							setOpen(false);
							router.push("/dashboard/caps");
						}}
					>
						<div className="flex gap-2 items-center w-full">
							{organization.organization.iconUrl ? (
								<div className="overflow-hidden relative flex-shrink-0 rounded-full size-5">
									<Image
										src={organization.organization.iconUrl}
										alt={organization.organization.name || "Organization icon"}
										fill
										className="object-cover"
									/>
								</div>
							) : (
								<Avatar
									letterClass="text-xs"
									className="relative flex-shrink-0 size-5"
									name={organization.organization.name}
								/>
							)}
							<p
								className={clsx(
									"flex-1 text-sm transition-colors duration-200 group-hover:text-gray-12",
									isSelected ? "text-gray-12" : "text-gray-10",
								)}
							>
								{organization.organization.name}
							</p>
							{isSelected && (
								<Check size={18} className={"ml-auto text-gray-12"} />
							)}
						</div>
					</div>
				);
			})}
		</motion.div>
	);
};

export default MobileTab;
