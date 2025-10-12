import { getAppEnvVarsForModule, getAppSlugForModule } from "./app-env.ts";

/**
 * Small helper for app modules to lazily resolve their app slug and environment block once.
 */
export const createAppModuleContext = <AppSlug extends string = string>(
	importMetaUrl: string,
) => {
	const resolveAppSlug = () => {
		return getAppSlugForModule(importMetaUrl) as AppSlug;
	};

	const resolveAppEnv = () => {
		return getAppEnvVarsForModule(importMetaUrl);
	};

	return { resolveAppSlug, resolveAppEnv } as const;
};
