import fs from "node:fs";
import path from "node:path";

const splitTopLevel = (value) => {
	const parts = [];
	let current = "";
	let depth = 0;
	let quote = null;
	for (const character of value) {
		if (quote) {
			current += character;
			if (character === quote) quote = null;
			continue;
		}
		if (character === "'" || character === '"' || character === "`") {
			quote = character;
			current += character;
			continue;
		}
		if (character === "(") depth += 1;
		if (character === ")" && depth > 0) depth -= 1;
		if (character === "," && depth === 0) {
			if (current.trim()) parts.push(current.trim());
			current = "";
			continue;
		}
		current += character;
	}
	if (current.trim()) parts.push(current.trim());
	return parts;
};

const readBlock = (contents, directive) => {
	const lines = contents.split(/\r?\n/);
	const start = lines.findIndex(
		(line) => line.trim().toUpperCase() === `${directive.toUpperCase()} >`,
	);
	if (start === -1) return null;
	const block = [];
	for (const line of lines.slice(start + 1)) {
		if (line.trim() && !/^\s/.test(line)) break;
		block.push(line.trim());
	}
	return block.join("\n").trim();
};

const readDirective = (contents, directive) => {
	const match = contents.match(new RegExp(`^${directive}\\s+(.+?)\\s*$`, "im"));
	return match?.[1]?.replace(/^(["'])(.*)\1$/, "$2") ?? null;
};

const parseColumns = (schema) =>
	splitTopLevel(schema).map((column) => {
		const withoutJsonPath = column.replace(/\s+`json:[^`]+`/gi, "");
		const withoutDefault = withoutJsonPath.replace(/\s+DEFAULT\s+.+$/i, "");
		const withoutCodec = withoutDefault.replace(/\s+CODEC\(.+\)$/i, "");
		const match = withoutCodec.trim().match(/^`?([A-Za-z0-9_]+)`?\s+(.+)$/);
		if (!match)
			throw new Error(`Invalid Tinybird column definition: ${column}`);
		return { name: match[1], type: match[2].trim() };
	});

const parseTokens = (contents) =>
	[...contents.matchAll(/^TOKEN\s+(\S+)\s+(READ|APPEND)\s*$/gim)].map(
		([, name, scope]) => ({ name, scope: scope.toUpperCase() }),
	);

const parseDatasource = (filePath) => {
	const contents = fs.readFileSync(filePath, "utf8");
	const schema = readBlock(contents, "SCHEMA");
	if (!schema) throw new Error(`Missing SCHEMA block in ${filePath}`);
	return {
		name: path.basename(filePath, ".datasource"),
		filePath,
		columns: parseColumns(schema),
		engine: readDirective(contents, "ENGINE") ?? "MergeTree",
		partitionKey: readDirective(contents, "ENGINE_PARTITION_KEY"),
		sortingKey: readDirective(contents, "ENGINE_SORTING_KEY"),
		primaryKey: readDirective(contents, "ENGINE_PRIMARY_KEY"),
		versionColumn: readDirective(contents, "ENGINE_VER"),
		ttl: readDirective(contents, "ENGINE_TTL"),
		settings: readDirective(contents, "ENGINE_SETTINGS"),
		tokens: parseTokens(contents),
	};
};

const parsePipe = (filePath) => {
	const contents = fs.readFileSync(filePath, "utf8");
	return {
		name: path.basename(filePath, ".pipe"),
		filePath,
		type: (readDirective(contents, "TYPE") ?? "generic").toLowerCase(),
		targetDatasource:
			readDirective(contents, "DATASOURCE") ??
			readDirective(contents, "TARGET_DATASOURCE"),
		tokens: parseTokens(contents),
	};
};

const listFiles = (directory, extension) => {
	if (!fs.existsSync(directory)) return [];
	return fs
		.readdirSync(directory)
		.filter((fileName) => fileName.endsWith(extension))
		.sort()
		.map((fileName) => path.join(directory, fileName));
};

const loadTinybirdProject = (projectDir) => ({
	datasources: listFiles(
		path.join(projectDir, "datasources"),
		".datasource",
	).map(parseDatasource),
	pipes: listFiles(path.join(projectDir, "pipes"), ".pipe").map(parsePipe),
});

export {
	loadTinybirdProject,
	parseColumns,
	parseDatasource,
	parsePipe,
	readBlock,
	readDirective,
	splitTopLevel,
};
