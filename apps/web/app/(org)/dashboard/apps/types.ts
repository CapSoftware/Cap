import type { AppDefinitionType } from "@cap/apps/ui";

export type SerializableAppDefinition = {
	slug: AppDefinitionType["slug"];
	displayName: string;
	description: string;
	icon: string;
	category: string;
	requiredEnvVars: string[];
	image: string;
	documentation: string;
	content: string;
	contentPath: string | null;
	publisher: {
		name: string;
		email: string;
	};
};
