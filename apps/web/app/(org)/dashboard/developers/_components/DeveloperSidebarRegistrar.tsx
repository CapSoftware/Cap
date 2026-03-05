"use client";

import { useEffect } from "react";
import { useDashboardContext } from "../../Contexts";
import type { DeveloperApp } from "../developer-data";

export function DeveloperSidebarRegistrar({ apps }: { apps: DeveloperApp[] }) {
	const { setDeveloperApps } = useDashboardContext();

	useEffect(() => {
		setDeveloperApps(apps);
		return () => {
			setDeveloperApps(null);
		};
	}, [apps, setDeveloperApps]);

	return null;
}
