"use client";

import { buildEnv } from "@cap/env";
import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import type { UpgradeModalProps } from "./UpgradeModal";

const UpgradeModal = dynamic(
	() => import("./UpgradeModal").then((module) => module.UpgradeModal),
	{ ssr: false },
);

export function LazyUpgradeModal(props: UpgradeModalProps) {
	const [mounted, setMounted] = useState(props.open);

	useEffect(() => {
		if (props.open) setMounted(true);
	}, [props.open]);

	useEffect(() => {
		if (typeof window.requestIdleCallback === "function") {
			const id = window.requestIdleCallback(() => setMounted(true), {
				timeout: 3000,
			});
			return () => window.cancelIdleCallback(id);
		}
		const id = window.setTimeout(() => setMounted(true), 1500);
		return () => window.clearTimeout(id);
	}, []);

	if (buildEnv.NEXT_PUBLIC_IS_CAP !== "true") return null;
	return mounted ? <UpgradeModal {...props} /> : null;
}
