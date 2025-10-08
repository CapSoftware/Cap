import { Effect } from "effect";

import { Apps as AppsDomain } from "@cap/web-domain";

import { Apps } from "./index.ts";

export const AppsRpcsLive = AppsDomain.AppsRpcs.toLayer(
	Effect.gen(function* () {
		const apps = yield* Apps;

		return {
			AppsListDefinitions: () => apps.listDefinitions(),
			AppsGetInstallation: ({ appType }: { appType: string }) => apps.getInstallation(appType),
			AppsListDestinations: ({ appType }: { appType: string }) => apps.listDestinations(appType),
			AppsUpdateSettings: ({ appType, settings }: { appType: string; settings: unknown }) =>
				apps.updateSettings(appType, settings),
			AppsPause: ({ appType }: { appType: string }) => apps.pause(appType),
			AppsResume: ({ appType }: { appType: string }) => apps.resume(appType),
			AppsUninstall: ({ appType }: { appType: string }) => apps.uninstall(appType),
			AppsDispatchTest: ({ appType }: { appType: string }) => apps.dispatchTest(appType),
		};
	}),
);
