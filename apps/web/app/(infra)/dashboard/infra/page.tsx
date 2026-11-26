import { redirect } from "next/navigation";
import { infraAppPath } from "@/lib/infra-routes";
import { FirstRun } from "./_components/first-run";
import {
	getInfraOrganizations,
	getInfraProCredit,
	getSelectedInfraApp,
} from "./infra-data";

export default async function InfraPage() {
	const app = await getSelectedInfraApp();
	if (app) redirect(infraAppPath(app.id));

	const [organizations, proCredit] = await Promise.all([
		getInfraOrganizations(),
		getInfraProCredit(),
	]);

	return <FirstRun organizations={organizations} proCredit={proCredit} />;
}
