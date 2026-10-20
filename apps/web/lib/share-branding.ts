import type { ImageUpload } from "@cap/web-domain";

/**
 * Branding shown on public-facing pages (`/s/[videoId]` and `/c/[id]`).
 * Pro organizations can show a custom icon or hide the Cap logo entirely;
 * free organizations always fall back to the Cap logo.
 */
export type SharePageBranding =
	| {
			type: "custom";
			imageUrl: ImageUpload.ImageUrl;
			name: string;
	  }
	| {
			type: "cap";
	  };

export type SharePageBrandingInput = {
	owner: { isPro: boolean };
	orgSettings?: {
		shareableLinkUseOrganizationIcon?: boolean;
		hideShareableLinkCapLogo?: boolean;
	} | null;
	organizationName?: string | null;
	organizationIconUrl?: ImageUpload.ImageUrl | null;
	shareableLinkIconUrl?: ImageUpload.ImageUrl | null;
};

/**
 * Resolves how a shared page should be branded. Returns `null` when a Pro
 * organization has opted to hide the Cap logo and has no custom icon set.
 */
export function getSharePageBranding(
	data: SharePageBrandingInput,
): SharePageBranding | null {
	if (!data.owner.isPro) {
		return { type: "cap" };
	}

	const brandedIcon = data.orgSettings?.shareableLinkUseOrganizationIcon
		? data.organizationIconUrl
		: data.shareableLinkIconUrl;

	if (brandedIcon) {
		return {
			type: "custom",
			imageUrl: brandedIcon,
			name: data.organizationName ?? "Organization",
		};
	}

	if (data.orgSettings?.hideShareableLinkCapLogo) {
		return null;
	}

	return { type: "cap" };
}
