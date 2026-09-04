import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

type ComposeService = {
	container_name?: string;
	image?: string;
	build?: {
		context?: string;
		dockerfile?: string;
	};
	ports?: Array<number | string>;
	volumes?: string[];
	depends_on?: string[];
	environment?: Record<string, string | number>;
};

type ComposeFile = {
	name?: string;
	services?: Record<string, ComposeService>;
	volumes?: Record<string, unknown>;
};

const composePath = fileURLToPath(
	new URL("./docker-compose.yml", import.meta.url),
);

async function readCompose() {
	const source = await readFile(composePath, "utf8");
	return parse(source) as ComposeFile;
}

describe("local Docker compose file", () => {
	it("keeps the expected local development services wired", async () => {
		const compose = await readCompose();

		expect(compose.name).toBe("cap-so-dev");
		expect(Object.keys(compose.services ?? {}).sort()).toEqual([
			"cap-media-server",
			"createbuckets",
			"minio",
			"ps-mysql",
		]);

		expect(compose.services?.["ps-mysql"]).toMatchObject({
			image: "mysql:8.0",
			container_name: "mysql-primary-db",
		});
		expect(compose.services?.["cap-media-server"]?.build).toEqual({
			context: "../..",
			dockerfile: "apps/media-server/Dockerfile",
		});
		expect(compose.services?.minio?.ports).toEqual(["9000:9000", "9001:9001"]);
		expect(compose.services?.createbuckets?.depends_on).toEqual(["minio"]);
	});

	it("does not declare stale named volumes", async () => {
		const compose = await readCompose();
		const declaredVolumes = new Set(Object.keys(compose.volumes ?? {}));
		const usedNamedVolumes = new Set(
			Object.values(compose.services ?? {})
				.flatMap((service) => service.volumes ?? [])
				.map((volume) => volume.split(":")[0])
				.filter(
					(source) =>
						source &&
						!source.startsWith(".") &&
						!source.startsWith("/") &&
						!source.startsWith("~"),
				),
		);

		expect([...declaredVolumes].sort()).toEqual([...usedNamedVolumes].sort());
	});
});
