"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

const POLL_INTERVAL_MS = 2500;
const MAX_POLLS = 12;

export const useUpgradeConfirmation = ({
	justUpgraded,
	isPro,
}: {
	justUpgraded: boolean;
	isPro: boolean;
}) => {
	const router = useRouter();
	const [awaiting] = useState(justUpgraded && !isPro);
	const [polls, setPolls] = useState(0);
	const pending = awaiting && !isPro;

	useEffect(() => {
		if (!pending || polls >= MAX_POLLS) return;
		const timer = window.setTimeout(() => {
			router.refresh();
			setPolls((count) => count + 1);
		}, POLL_INTERVAL_MS);
		return () => window.clearTimeout(timer);
	}, [pending, polls, router]);

	return {
		waiting: pending && polls < MAX_POLLS,
		timedOut: pending && polls >= MAX_POLLS,
	};
};
