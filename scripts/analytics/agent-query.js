#!/usr/bin/env node

import process from "node:process";
import { pathToFileURL } from "node:url";

const ENDPOINTS = {
	daily: {
		name: "product_events_daily",
		parameters: new Set([
			"start_date",
			"end_date",
			"event_name",
			"source",
			"platform",
			"payment_status",
			"subscription_status",
			"limit",
		]),
	},
	health: {
		name: "product_events_health",
		parameters: new Set(["start_time", "end_time"]),
	},
};

function parseHealthTimestamp(value) {
	const input = /^\d{4}-\d{2}-\d{2}$/.test(value)
		? `${value}T00:00:00Z`
		: /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)
			? value
			: `${value.replace(" ", "T")}Z`;
	return Date.parse(input);
}

function formatHealthTimestamp(timestamp) {
	return new Date(timestamp).toISOString().replace("T", " ").replace("Z", "");
}

export function buildAgentQuery(endpointName, args, env = process.env) {
	const endpoint = ENDPOINTS[endpointName];
	if (!endpoint) {
		throw new Error("Expected endpoint daily or health.");
	}
	const token = env.TINYBIRD_AGENT_TOKEN?.trim();
	const host = env.TINYBIRD_URL?.trim();
	if (!token || !host) {
		throw new Error("TINYBIRD_AGENT_TOKEN and TINYBIRD_URL are required.");
	}

	const url = new URL(`/v0/pipes/${endpoint.name}.json`, host);
	for (const arg of args) {
		const separator = arg.indexOf("=");
		if (separator < 1) throw new Error(`Expected key=value, received ${arg}.`);
		const key = arg.slice(0, separator);
		const value = arg.slice(separator + 1);
		if (!endpoint.parameters.has(key)) {
			throw new Error(`Unsupported ${endpointName} parameter ${key}.`);
		}
		url.searchParams.set(key, value);
	}
	if (
		endpointName === "health" &&
		(!url.searchParams.has("start_time") || !url.searchParams.has("end_time"))
	) {
		throw new Error("Health queries require start_time and end_time.");
	}
	if (endpointName === "health") {
		const start = parseHealthTimestamp(url.searchParams.get("start_time"));
		const end = parseHealthTimestamp(url.searchParams.get("end_time"));
		if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
			throw new Error("Health query timestamps are invalid or reversed.");
		}
		if (end - start > 31 * 24 * 60 * 60 * 1000) {
			throw new Error("Health query windows cannot exceed 31 days.");
		}
		url.searchParams.set("start_time", formatHealthTimestamp(start));
		url.searchParams.set("end_time", formatHealthTimestamp(end));
	}

	return { url, token };
}

export async function runAgentQuery(
	endpointName,
	args,
	env = process.env,
	fetchImpl = fetch,
) {
	const { url, token } = buildAgentQuery(endpointName, args, env);
	const response = await fetchImpl(url, {
		headers: { Authorization: `Bearer ${token}` },
		signal: AbortSignal.timeout(10_000),
	});
	const body = await response.text();
	if (!response.ok) {
		throw new Error(`Tinybird query failed (${response.status}): ${body}`);
	}
	return body;
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	try {
		const output = await runAgentQuery(
			process.argv[2] ?? "daily",
			process.argv.slice(3),
		);
		console.log(output);
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	}
}
