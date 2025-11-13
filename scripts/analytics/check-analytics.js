#!/usr/bin/env node

import process from "node:process";

import {
	buildSchemaLines,
	createTinybirdClient,
	normalizeWhitespace,
	PIPE_DEFINITIONS,
	TABLE_DEFINITIONS,
} from "./shared.js";

const normalizeColumnDef = (definition) =>
	normalizeWhitespace(
		definition
			.replace(/`/g, "")
			.replace(/\bjson:\$[^\s,)]+/gi, "")
			.replace(/\bdefault\s+(?:'[^']*'|"[^"]*"|[^\s,)]+)/gi, ""),
	).toLowerCase();

const buildExpectedSchema = (table) =>
	buildSchemaLines(table).map((column) => normalizeColumnDef(column));

const splitSchema = (schema) => {
	const parts = [];
	let depth = 0;
	let current = "";
	for (const char of schema) {
		if (char === "(") depth += 1;
		if (char === ")" && depth > 0) depth -= 1;
		if (char === "," && depth === 0) {
			if (current.trim()) parts.push(current.trim());
			current = "";
			continue;
		}
		current += char;
	}
	if (current.trim()) parts.push(current.trim());
	return parts;
};

async function validateTables(client) {
	const issues = [];
	for (const table of TABLE_DEFINITIONS) {
		try {
			const datasource = await client.getDatasource(table.name);
			if (!datasource) {
				issues.push(`Missing data source ${table.name}`);
				continue;
			}

			const remoteSchema = datasource?.schema?.sql_schema;
			if (!remoteSchema) {
				issues.push(
					`Data source ${table.name} does not expose schema metadata`,
				);
				continue;
			}

			const remoteColumns = splitSchema(remoteSchema).map(normalizeColumnDef);
			const expectedColumns = buildExpectedSchema(table);

			let hasIssue = false;

			if (remoteColumns.length !== expectedColumns.length) {
				issues.push(
					`Schema mismatch for ${table.name}. Expected ${expectedColumns.length} columns, got ${remoteColumns.length}.`,
				);
				hasIssue = true;
			}

			const missingColumns = expectedColumns.filter(
				(column, index) => remoteColumns[index] !== column,
			);
			if (missingColumns.length > 0) {
				issues.push(
					`Schema mismatch for ${table.name}. Expected columns (${expectedColumns.join(", ")}), got (${remoteColumns.join(", ")}).`,
				);
				hasIssue = true;
			}

			if (table.engine) {
				const actualEngine =
					typeof datasource.engine === "string"
						? datasource.engine
						: datasource.engine?.engine;
				if (actualEngine && actualEngine !== table.engine) {
					issues.push(
						`Data source ${table.name} has engine ${actualEngine}, expected ${table.engine}.`,
					);
					hasIssue = true;
				}
			}

			if (!hasIssue) {
				console.log(`✔ Data source ${table.name} schema matches`);
			}
		} catch (error) {
			issues.push(
				`Failed to inspect ${table.name}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	return issues;
}

async function validatePipes(client) {
	const issues = [];
	for (const pipeDef of PIPE_DEFINITIONS) {
		try {
			const pipe = await client.getPipe(pipeDef.name);
			if (!pipe) {
				issues.push(`Missing pipe ${pipeDef.name}`);
				continue;
			}

			if ((pipe.type || "").toLowerCase() !== "materialized") {
				issues.push(
					`Pipe ${pipeDef.name} is not materialized (type=${pipe.type ?? "unknown"}).`,
				);
				continue;
			}

			const materializedNode = pipe.nodes?.find(
				(node) =>
					(node.type || "").toLowerCase() === "materialized" ||
					(node.node_type || "").toLowerCase() === "materialized" ||
					node.materialized,
			);

			const targetDatasource =
				materializedNode?.tags?.materializing_target_datasource ||
				materializedNode?.materialized?.datasource ||
				materializedNode?.datasource ||
				materializedNode?.params?.datasource;

			if (targetDatasource !== pipeDef.targetDatasource) {
				issues.push(
					`Pipe ${pipeDef.name} does not target ${pipeDef.targetDatasource} (found ${targetDatasource ?? "unknown"}).`,
				);
				continue;
			}

			console.log(`✔ Pipe ${pipeDef.name} feeds ${pipeDef.targetDatasource}`);
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			const errorDetails =
				error instanceof Error && error.cause ? ` (cause: ${error.cause})` : "";
			issues.push(
				`Failed to inspect pipe ${pipeDef.name}: ${errorMessage}${errorDetails}`,
			);
		}
	}
	return issues;
}

async function main() {
	try {
		const client = createTinybirdClient();
		const tableIssues = await validateTables(client);
		const pipeIssues = await validatePipes(client);
		const issues = [...tableIssues, ...pipeIssues];

		if (issues.length > 0) {
			console.error("❌ Tinybird analytics validation failed:");
			for (const issue of issues) {
				console.error(`  - ${issue}`);
			}
			process.exit(1);
		}

		console.log("✅ Tinybird analytics setup is valid.");
	} catch (error) {
		console.error(
			"❌ Tinybird analytics validation crashed:",
			error instanceof Error ? error.message : error,
		);
		process.exit(1);
	}
}

main();
