import type { Metadata } from "next";
import { LoomBatchStatus } from "./LoomBatchStatus";

export const metadata: Metadata = {
	title: "Loom import status — Cap",
};

function firstParam(value: string | string[] | undefined) {
	return Array.isArray(value) ? value[0] : value;
}

export default async function Page({
	searchParams,
}: PageProps<"/dashboard/import/loom/status">) {
	const params = await searchParams;

	return (
		<LoomBatchStatus
			operationId={firstParam(params.operationId)}
			organizationId={firstParam(params.organizationId)}
		/>
	);
}
