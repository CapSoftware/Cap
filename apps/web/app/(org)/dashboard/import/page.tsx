import type { Metadata } from "next";
import {
	loomImportDestinationFromSearchParams,
	loomImportPageHref,
} from "@/lib/loom-import-destination";
import { ImportPage } from "./ImportPage";

export const metadata: Metadata = {
	title: "Import — Cap",
};

export default async function Page({
	searchParams,
}: {
	searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
	const destination = loomImportDestinationFromSearchParams(await searchParams);
	return (
		<ImportPage
			key={loomImportPageHref(destination)}
			initialDestination={destination}
		/>
	);
}
