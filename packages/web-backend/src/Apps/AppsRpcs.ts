import { Apps as AppsDomain } from "@cap/web-domain";
import { Effect } from "effect";

import { Apps } from "./index.ts";

export const AppsRpcsLive = AppsDomain.AppsRpcs.toLayer(
	Effect.gen(function* () {
		const apps = yield* Apps;

		return {
			AppsListDefinitions: () => apps.listDefinitions(),
			AppsGetInstallation: ({ slug }: { slug: string }) =>
				apps.getInstallation(slug),
			AppsListDestinations: ({ slug }: { slug: string }) =>
				apps.listDestinations(slug),
			AppsUpdateSettings: ({
				slug,
				settings,
			}: {
				slug: string;
				settings: unknown;
			}) => apps.updateSettings(slug, settings),
			AppsPause: ({ slug }: { slug: string }) => apps.pause(slug),
			AppsResume: ({ slug }: { slug: string }) => apps.resume(slug),
			AppsUninstall: ({ slug }: { slug: string }) =>
				apps.uninstall(slug),
			AppsDispatchTest: ({ slug }: { slug: string }) =>
				apps.dispatchTest(slug),
		};
	}),
);
