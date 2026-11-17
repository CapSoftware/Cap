import type { CatalogApp } from "@cap/app-store";
import type { Organisation } from "@cap/web-domain";

export type AppListing = Omit<CatalogApp, "readme">;

export type OrganizationOption = {
	id: Organisation.OrganisationId;
	name: string;
	canManage: boolean;
	adminsOnly: boolean;
};

export const toListing = ({
	readme: _readme,
	...app
}: CatalogApp): AppListing => app;
