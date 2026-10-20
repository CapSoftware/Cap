import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireMigrationOperator } from "@/lib/loom-concierge";
import { LoomMigrationQueue } from "./LoomMigrationQueue";

export const metadata: Metadata = {
	title: "Loom Migration Queue — Cap",
};

export default async function Page() {
	try {
		await requireMigrationOperator();
	} catch {
		notFound();
	}
	return <LoomMigrationQueue />;
}
