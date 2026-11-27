"use client";

import dynamic from "next/dynamic";
import { useState } from "react";
import { ShareableLinkLimitOverlay } from "../ShareableLinkLimitOverlay";

const importUpgradeModal = () =>
	import("@/components/UpgradeModal").then((module) => module.UpgradeModal);
const UpgradeModal = dynamic(importUpgradeModal, { ssr: false });

export function NoteLinkLimit({ isOwner }: { isOwner: boolean }) {
	const [upgradeOpen, setUpgradeOpen] = useState(false);
	const [upgradeMounted, setUpgradeMounted] = useState(false);

	return (
		<>
			<ShareableLinkLimitOverlay
				isOwner={isOwner}
				reason="noteLinks"
				onUpgrade={() => {
					setUpgradeMounted(true);
					setUpgradeOpen(true);
				}}
				onUpgradeHover={() => {
					void importUpgradeModal();
				}}
				className="min-h-[28rem]"
			/>
			{upgradeMounted && (
				<UpgradeModal open={upgradeOpen} onOpenChange={setUpgradeOpen} />
			)}
		</>
	);
}
