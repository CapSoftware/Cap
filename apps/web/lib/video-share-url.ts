import { buildEnv, NODE_ENV } from "@cap/env";

type ShareDomainOrganization =
	| {
			customDomain?: string | null;
			domainVerified?: Date | string | null;
	  }
	| null
	| undefined;

export const videoShareUrl = (
	webUrl: string,
	videoId: string,
	organization: ShareDomainOrganization,
) => {
	const customDomain = organization?.customDomain;
	if (
		customDomain &&
		organization?.domainVerified &&
		NODE_ENV !== "development" &&
		buildEnv.NEXT_PUBLIC_IS_CAP
	)
		return `https://${customDomain}/s/${videoId}`;
	return `${webUrl}/s/${videoId}`;
};
