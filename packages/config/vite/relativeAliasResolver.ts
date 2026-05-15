import fs from "node:fs/promises";
import path from "node:path";
import type { Alias } from "vite";

const pkgJsonCache = new Map();

const isPathRoot = (value: string) => path.dirname(value) === value;

const resolver: Alias = {
	find: /^(~\/.+)/,
	replacement: "$1",
	async customResolver(source, importer) {
		let root: null | string = null;
		const normalizedImporter = importer?.replace(/\\/g, "/");

		const [_, sourcePath] = source.split("~/");

		if (normalizedImporter?.includes("/src/")) {
			const [pkg] = normalizedImporter.split("/src/");

			root = path.normalize(`${pkg}/src`);
		} else {
			if (!importer) throw new Error(`Failed to resolve import path ${source}`);

			let parent = importer;

			while (!isPathRoot(parent)) {
				parent = path.dirname(parent);

				let hasPkgJson = pkgJsonCache.get(parent);

				if (hasPkgJson === undefined)
					try {
						await fs.stat(`${parent}/package.json`);
						hasPkgJson = true;
						pkgJsonCache.set(parent, hasPkgJson);
					} catch {
						hasPkgJson = false;
						pkgJsonCache.set(parent, hasPkgJson);
					}

				if (hasPkgJson) {
					root = parent;
					break;
				}
			}

			if (root === null)
				throw new Error(
					`Failed to resolve import path ${source} in file ${importer}`,
				);
		}

		const absolutePath = path.join(root, sourcePath);

		const folderItems = await fs.readdir(path.join(absolutePath, "../"));
		const basename = sourcePath.split("/").at(-1);

		if (!basename)
			throw new Error(
				`Failed to resolve import path ${source} in file ${importer}`,
			);

		const item = folderItems.find((i) => i.startsWith(basename));

		if (!item)
			throw new Error(
				`Failed to resolve import path ${source} in file ${importer}`,
			);

		const fullPath = absolutePath + path.extname(item);

		const stats = await fs.stat(fullPath);

		if (stats.isDirectory()) {
			const directoryItems = await fs.readdir(
				absolutePath + path.extname(item),
			);

			const indexFile = directoryItems.find((i) => i.startsWith("index"));

			if (!indexFile)
				throw new Error(
					`Failed to resolve index file for ${source} in file ${importer}`,
				);

			return path.join(absolutePath, indexFile);
		} else {
			return fullPath;
		}
	},
};

export default resolver;
