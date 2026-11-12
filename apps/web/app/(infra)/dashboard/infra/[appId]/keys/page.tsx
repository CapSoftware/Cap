import { infraPageMetadata, requireInfraApp } from "../../infra-data";
import { ApiKeysClient } from "./api-keys-client";

export const generateMetadata = infraPageMetadata("API keys");

export default async function InfraKeysPage({
	params,
}: {
	params: Promise<{ appId: string }>;
}) {
	const { appId } = await params;
	const { app } = await requireInfraApp(appId);
	const secretKey = app.apiKeys.find((k) => k.keyType === "secret");

	return (
		<ApiKeysClient
			appId={app.id}
			secretKeyPrefix={secretKey?.keyPrefix ?? null}
		/>
	);
}
