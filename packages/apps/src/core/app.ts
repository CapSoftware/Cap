import type { AppModule } from "./types.ts";

export const createAppRegistry = <
	Modules extends Record<string, AppModule<any, any, any>>,
>(
	modules: Modules,
) => {
  type AppKey = Extract<keyof Modules, string>;
  const appTypes = Object.freeze(Object.keys(modules) as AppKey[]);

  const isAppType = (value: string): value is AppKey =>
    Object.prototype.hasOwnProperty.call(modules, value);

  const getAppModule = (type: AppKey) => modules[type];

  const getAppModuleByName = (value: string) =>
    isAppType(value) ? modules[value] : undefined;

  return {
    modules,
    appTypes,
    isAppType,
    getAppModule,
    getAppModuleByName,
  } as const;
};

export type InferAppType<Registry extends { readonly appTypes: readonly string[] }> =
  Registry["appTypes"][number];
