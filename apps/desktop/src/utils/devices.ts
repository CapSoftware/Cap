import { queryOptions, useQuery } from "@tanstack/solid-query";
import { createEffect, onCleanup } from "solid-js";
import {
	type CameraInfo,
	commands,
	events,
	type OSPermissionsCheck,
} from "./tauri";

export type DevicesSnapshot = {
	cameras: CameraInfo[];
	microphones: string[];
	permissions: OSPermissionsCheck;
};

export const devicesSnapshot = queryOptions({
	queryKey: ["devicesSnapshot"] as const,
	queryFn: () => commands.getDevicesSnapshot(),
	staleTime: 3_000,
	refetchInterval: 5_000,
});

export function createDevicesQuery() {
	const query = useQuery(() => devicesSnapshot);

	createEffect(() => {
		const unlisten = events.devicesUpdated.listen((event) => {
			query.refetch();
		});

		onCleanup(() => {
			unlisten.then((fn) => fn());
		});
	});

	return query;
}
