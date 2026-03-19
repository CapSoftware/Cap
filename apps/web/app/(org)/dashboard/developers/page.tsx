import { redirect } from "next/navigation";

export default function DevelopersPage() {
	redirect("/dashboard/developers/apps");
}
