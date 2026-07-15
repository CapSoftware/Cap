import type { Metadata } from "next";
import { ApiKeysClient } from "./ApiKeysClient";

export const metadata: Metadata = {
	title: "API 密钥 — Cap",
};

export default async function ApiKeysPage() {
	return <ApiKeysClient />;
}
