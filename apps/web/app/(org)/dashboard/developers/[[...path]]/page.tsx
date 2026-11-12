import { redirect } from "next/navigation";
import { getSelectedInfraApp } from "@/app/(infra)/dashboard/infra/infra-data";
import {
	INFRA_BASE_PATH,
	infraAppPath,
	resolveLegacyDeveloperPath,
} from "@/lib/infra-routes";

export default async function LegacyDevelopersPage({
	params,
	searchParams,
}: {
	params: Promise<{ path?: string[] }>;
	searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
	const [{ path = [] }, query] = await Promise.all([params, searchParams]);
	const target = resolveLegacyDeveloperPath(path);

	let destination = INFRA_BASE_PATH;
	if (target.kind === "app") {
		destination = infraAppPath(target.appId, target.section);
	} else if (target.kind === "selected") {
		const app = await getSelectedInfraApp();
		if (app) destination = infraAppPath(app.id, target.section);
	}

	const search = new URLSearchParams();
	for (const [key, value] of Object.entries(query)) {
		for (const item of Array.isArray(value) ? value : [value]) {
			if (item !== undefined) search.append(key, item);
		}
	}
	const queryString = search.toString();

	redirect(queryString ? `${destination}?${queryString}` : destination);
}
