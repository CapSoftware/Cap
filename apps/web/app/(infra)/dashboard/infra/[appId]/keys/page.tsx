import type { Metadata } from "next";
import { requireInfraApp } from "../../infra-data";
import { ApiKeysClient } from "./api-keys-client";

export const metadata: Metadata = {
	title: "API keys | Cap Infra",
};

export default async function InfraKeysPage({
	params,
}: {
	params: Promise<{ appId: string }>;
}) {
	const { appId } = await params;
	const { app } = await requireInfraApp(appId);
	const publicKey = app.apiKeys.find((k) => k.keyType === "public");
	const secretKey = app.apiKeys.find((k) => k.keyType === "secret");

	return (
		<ApiKeysClient
			appId={app.id}
			publicKey={
				publicKey ? (publicKey.fullKey ?? `${publicKey.keyPrefix}...`) : null
			}
			secretKeyPrefix={secretKey?.keyPrefix ?? null}
		/>
	);
}
