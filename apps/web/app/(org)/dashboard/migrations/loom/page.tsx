import type { Metadata } from "next";
import { LoomMigrationPage } from "./LoomMigrationPage";

export const metadata: Metadata = {
	title: "Loom Migration — Cap",
};

export default function Page() {
	return <LoomMigrationPage />;
}
