import { isEmailAllowedByRestriction } from "@cap/utils";

export const PUBLIC_COLLECTION_PAGE_SIZE = 15;

export type PublicCollectionKind = "folder" | "space";

export type PublicCollectionCandidate = {
	kind: PublicCollectionKind;
	public: boolean;
	organizationTombstoneAt: Date | null;
};

export type PublicCollectionAccess =
	| { state: "allowed" }
	| { state: "email_restriction_login_required" }
	| { state: "email_restriction_denied" }
	| { state: "password_required" };

export function parsePublicCollectionPage(
	page: string | string[] | undefined,
): number {
	const value = Array.isArray(page) ? page[0] : page;
	const parsed = Number(value);

	if (!Number.isInteger(parsed) || parsed < 1) return 1;

	return parsed;
}

export function getPublicCollectionHref(id: string, page: number): string {
	return page <= 1 ? `/c/${id}` : `/c/${id}?page=${page}`;
}

export function resolvePublicCollectionCandidate<
	TFolder extends PublicCollectionCandidate,
>(folder: TFolder | null, space: null): TFolder | null;
export function resolvePublicCollectionCandidate<
	TSpace extends PublicCollectionCandidate,
>(folder: null, space: TSpace | null): TSpace | null;
export function resolvePublicCollectionCandidate<
	TFolder extends PublicCollectionCandidate,
	TSpace extends PublicCollectionCandidate,
>(folder: TFolder | null, space: TSpace | null): TFolder | TSpace | null;
export function resolvePublicCollectionCandidate(
	folder: PublicCollectionCandidate | null,
	space: PublicCollectionCandidate | null,
): PublicCollectionCandidate | null {
	if (folder?.public && !folder.organizationTombstoneAt) return folder;
	if (space?.public && !space.organizationTombstoneAt) return space;

	return null;
}

export function resolvePublicCollectionAccess({
	allowedEmailDomain,
	viewerEmail,
	passwordHash,
	verifiedPasswordHashes,
}: {
	allowedEmailDomain?: string | null;
	viewerEmail?: string | null;
	passwordHash?: string | null;
	verifiedPasswordHashes?: readonly string[];
}): PublicCollectionAccess {
	const restriction = allowedEmailDomain?.trim() ?? "";

	if (restriction.length > 0) {
		if (!viewerEmail) return { state: "email_restriction_login_required" };

		if (!isEmailAllowedByRestriction(viewerEmail, restriction)) {
			return { state: "email_restriction_denied" };
		}
	}

	if (passwordHash && !verifiedPasswordHashes?.includes(passwordHash)) {
		return { state: "password_required" };
	}

	return { state: "allowed" };
}
