"use client";

import { useState } from "react";
import { UpgradeModal } from "@/components/UpgradeModal";

export function EditUpgradeGate() {
	const [open, setOpen] = useState(true);

	return (
		<div className="min-h-screen bg-gray-2">
			<UpgradeModal open={open} onOpenChange={setOpen} dismissible={false} />
		</div>
	);
}
