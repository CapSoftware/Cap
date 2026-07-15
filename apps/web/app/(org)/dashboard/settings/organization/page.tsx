import type { Metadata } from "next";
import { GeneralPage } from "./GeneralPage";

export const metadata: Metadata = {
	title: "组织设置 — Cap",
};

export default function OrganizationPage() {
	return <GeneralPage />;
}
