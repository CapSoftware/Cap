import { notFound } from "next/navigation";
import type { PropsWithChildren } from "react";
import { AppProviders } from "../Layout/AppProviders";
import { getInfraAccess } from "./dashboard/infra/infra-data";

export const dynamic = "force-dynamic";

// Thrown here, above the console's own layout, so an account outside the
// preview gets the same plain page as any unknown address.
export default async function InfraGroupLayout({
	children,
}: PropsWithChildren) {
	if ((await getInfraAccess()) === "outside_preview") notFound();
	return <AppProviders>{children}</AppProviders>;
}
