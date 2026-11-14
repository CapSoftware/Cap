"use client";

import { Button } from "@cap/ui";
import { faUpload } from "@fortawesome/free-solid-svg-icons/faUpload";
import clsx from "clsx";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { useDashboardContext } from "@/app/(org)/dashboard/Contexts";
import { FontAwesomeIcon } from "@/components/FontAwesomeIcon";
import { UpgradeModal } from "@/components/UpgradeModal";
import {
	loomImportDestinationFromPathname,
	loomImportPageHref,
} from "@/lib/loom-import-destination";

export const UploadCapButton = ({
	size = "md",
}: {
	size?: "sm" | "lg" | "md";
	grey?: boolean;
}) => {
	const { user } = useDashboardContext();
	const [upgradeModalOpen, setUpgradeModalOpen] = useState(false);
	const router = useRouter();
	const pathname = usePathname();

	const handleClick = () => {
		if (!user) return;

		if (!user.isPro) {
			setUpgradeModalOpen(true);
			return;
		}

		router.push(
			loomImportPageHref(loomImportDestinationFromPathname(pathname)),
		);
	};

	return (
		<>
			<Button
				onClick={handleClick}
				variant="secondary"
				className={clsx("flex gap-2 items-center", size === "sm" && "px-4 h-9")}
				size={size}
			>
				<FontAwesomeIcon className="size-3.5 text-gray-10" icon={faUpload} />
				Import media
			</Button>
			<UpgradeModal
				open={upgradeModalOpen}
				onOpenChange={setUpgradeModalOpen}
			/>
		</>
	);
};
