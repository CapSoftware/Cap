import type { Metadata } from "next";
import { DomainsClient } from "./DomainsClient";

export const metadata: Metadata = {
	title: "允许的域名 — Cap",
};

export default async function DomainsPage() {
	return <DomainsClient />;
}
