import { getAppEnvVarsForModule, getAppSlugForModule } from "./app-env.ts";

/**
 * Small helper for app modules to lazily resolve their app slug and environment block once.
 */
export const createAppModuleContext = <AppSlug extends string = string>(
	importMetaUrl: string,
) => {
	let cachedAppSlug: AppSlug | undefined;
	let cachedEnv: ReturnType<typeof getAppEnvVarsForModule> | undefined;

	const resolveAppSlug = () => {
		if (cachedAppSlug !== undefined) {
			return cachedAppSlug;
		}

		cachedAppSlug = getAppSlugForModule(importMetaUrl) as AppSlug;
		return cachedAppSlug;
	};

	const resolveAppEnv = () => {
		if (cachedEnv !== undefined) {
			return cachedEnv;
		}

		cachedEnv = getAppEnvVarsForModule(importMetaUrl);
		return cachedEnv;
	};

	return { resolveAppSlug, resolveAppEnv } as const;
};
