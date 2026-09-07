"use server";

import { getCurrentUser } from "@cap/database/auth/session";
import { userIsPro } from "@cap/utils";
import type { Organisation } from "@cap/web-domain";
import {
	getOrganizationAccess,
	requireOrganizationAccess,
} from "@/actions/organization/authorization";
import {
	downloadLoomVideo as downloadLoomVideoInternal,
	importLoomCsvForUser,
	importLoomVideoForOwner,
	type LoomCsvImportResult,
	type LoomCsvImportRow,
	type LoomImportResult,
} from "@/lib/loom-import";
import { canManageOrganizationSettings } from "@/lib/permissions/roles";

export type {
	LoomCsvImportResult,
	LoomCsvImportRow,
	LoomCsvImportRowResult,
	LoomImportResult,
} from "@/lib/loom-import";

export async function downloadLoomVideo(
	...args: Parameters<typeof downloadLoomVideoInternal>
) {
	return downloadLoomVideoInternal(...args);
}

const LOOM_CSV_PERMISSION_ERROR =
	"Only organization admins and owners can import Loom videos from a CSV.";

export async function importFromLoom({
	loomUrl,
	orgId,
}: {
	loomUrl: string;
	orgId: Organisation.OrganisationId;
}): Promise<LoomImportResult> {
	const user = await getCurrentUser();

	if (!user) {
		return { success: false, error: "Unauthorized" };
	}

	if (!userIsPro(user)) {
		return {
			success: false,
			error: "Importing from Loom requires a Cap Pro subscription.",
		};
	}

	await requireOrganizationAccess(user.id, orgId);

	return importLoomVideoForOwner({
		loomUrl,
		orgId,
		ownerId: user.id,
	});
}

export async function importFromLoomCsv({
	rows,
	orgId,
}: {
	rows: LoomCsvImportRow[];
	orgId: Organisation.OrganisationId;
}): Promise<LoomCsvImportResult> {
	const user = await getCurrentUser();

	if (!user) {
		return {
			success: false,
			importedCount: 0,
			failedCount: 0,
			results: [],
			error: "Unauthorized",
		};
	}

	if (!userIsPro(user)) {
		return {
			success: false,
			importedCount: 0,
			failedCount: 0,
			results: [],
			error: "Importing from Loom requires a Cap Pro subscription.",
		};
	}

	const access = await getOrganizationAccess(user.id, orgId);
	if (!access || !canManageOrganizationSettings(access.role)) {
		return {
			success: false,
			importedCount: 0,
			failedCount: 0,
			results: [],
			error: LOOM_CSV_PERMISSION_ERROR,
		};
	}

	return importLoomCsvForUser({ rows, orgId, user });
}
