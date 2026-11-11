"use client";

import { useEffect } from "react";
import { useDashboardContext } from "../../Contexts";
import type { InfraAppSummary } from "../infra-data";
import { rememberInfraApp } from "./remember-infra-app";

export function InfraSidebarRegistrar({
	apps,
	appId,
}: {
	apps: InfraAppSummary[];
	appId: string;
}) {
	const { setInfraApps } = useDashboardContext();

	useEffect(() => {
		setInfraApps(apps);
		return () => {
			setInfraApps(null);
		};
	}, [apps, setInfraApps]);

	useEffect(() => {
		rememberInfraApp(appId);
	}, [appId]);

	return null;
}
