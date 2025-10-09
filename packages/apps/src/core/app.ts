import type { AppModule } from "./types.ts";

export const createAppRegistry = <
	Modules extends Record<string, AppModule<any, any, any>>,
>(
	modules: Modules,
) => {
	type AppKey = Extract<keyof Modules, string>;
	const appSlugs = Object.freeze(Object.keys(modules) as AppKey[]);

	const isAppSlug = (value: string): value is AppKey =>
		Object.hasOwn(modules, value);

	const getAppModule = (type: AppKey) => modules[type];

	const getAppModuleByName = (value: string) =>
		isAppSlug(value) ? modules[value] : undefined;

	return {
		modules,
		appSlugs,
		isAppSlug,
		getAppModule,
		getAppModuleByName,
	} as const;
};

export type InferAppSlug<
	Registry extends { readonly appSlugs: readonly string[] },
> = Registry["appSlugs"][number];
