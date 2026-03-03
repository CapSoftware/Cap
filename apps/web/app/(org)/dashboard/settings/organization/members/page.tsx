import { redirect } from "next/navigation";

export default function MembersPage() {
	redirect("/dashboard/settings/organization/billing");
}
