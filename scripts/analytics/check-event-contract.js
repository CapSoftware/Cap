#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROJECT_ROOT = path.resolve(MODULE_DIR, "..", "..");
const DEFAULT_REGISTRY_PATH = path.join(
	"packages",
	"analytics",
	"src",
	"event-registry.ts",
);
const DEFAULT_NATIVE_PATH = path.join(
	"apps",
	"desktop",
	"src-tauri",
	"src",
	"product_analytics.rs",
);
const SOURCE_ROOTS = ["apps", "packages", "crates"];
const SKIPPED_DIRECTORIES = new Set([
	".git",
	".next",
	".output",
	".turbo",
	"__tests__",
	"build",
	"coverage",
	"dist",
	"fixtures",
	"gen",
	"generated",
	"node_modules",
	"target",
	"test",
	"tests",
]);
const WRAPPER_PATHS = new Set([
	"apps/desktop/src/utils/analytics.ts",
	"apps/web/app/utils/analytics.ts",
	"apps/web/app/utils/product-analytics.ts",
	"apps/web/lib/analytics/server-event.ts",
	"apps/web/lib/analytics/server.ts",
	"apps/web/workflows/deliver-product-analytics-event.ts",
]);
const CAPTURE_MODULES = new Map([
	[
		"@/app/utils/analytics",
		new Map([
			["trackEvent", { kind: "name" }],
			[
				"trackToolInteraction",
				{ kind: "helper", eventName: "tool_interaction" },
			],
		]),
	],
	["~/utils/analytics", new Map([["trackEvent", { kind: "name" }]])],
	[
		"@/app/utils/product-analytics",
		new Map([
			["captureProductPageView", { kind: "helper", eventName: "page_view" }],
			[
				"captureProductPageEngagement",
				{ kind: "helper", eventName: "page_engagement" },
			],
		]),
	],
	[
		"@/lib/analytics/server",
		new Map([["queueServerProductEvent", { kind: "object" }]]),
	],
	[
		"@/lib/analytics/business-events",
		new Map([
			["userSignedUpEvent", { kind: "helper", eventName: "user_signed_up" }],
			["identityLinkedEvent", { kind: "helper", eventName: "identity_linked" }],
			[
				"shareLinkCreatedEvent",
				{ kind: "helper", eventName: "share_link_created" },
			],
			[
				"collaborationActionCreatedEvent",
				{ kind: "helper", eventName: "collaboration_action_created" },
			],
		]),
	],
	[
		"@/workflows/deliver-product-analytics-event",
		new Map([["enqueueProductAnalyticsEventStep", { kind: "object" }]]),
	],
	[
		"apps/web/app/utils/analytics",
		new Map([
			["trackEvent", { kind: "name" }],
			[
				"trackToolInteraction",
				{ kind: "helper", eventName: "tool_interaction" },
			],
		]),
	],
	[
		"apps/desktop/src/utils/analytics",
		new Map([["trackEvent", { kind: "name" }]]),
	],
	[
		"apps/web/app/utils/product-analytics",
		new Map([
			["captureProductPageView", { kind: "helper", eventName: "page_view" }],
			[
				"captureProductPageEngagement",
				{ kind: "helper", eventName: "page_engagement" },
			],
		]),
	],
	[
		"apps/web/lib/analytics/server",
		new Map([["queueServerProductEvent", { kind: "object" }]]),
	],
	[
		"apps/web/lib/analytics/business-events",
		new Map([
			["userSignedUpEvent", { kind: "helper", eventName: "user_signed_up" }],
			["identityLinkedEvent", { kind: "helper", eventName: "identity_linked" }],
			[
				"shareLinkCreatedEvent",
				{ kind: "helper", eventName: "share_link_created" },
			],
			[
				"collaborationActionCreatedEvent",
				{ kind: "helper", eventName: "collaboration_action_created" },
			],
		]),
	],
	[
		"apps/web/workflows/deliver-product-analytics-event",
		new Map([["enqueueProductAnalyticsEventStep", { kind: "object" }]]),
	],
]);
const CAPTURE_EXPORT_NAMES = new Set(
	[...CAPTURE_MODULES.values()].flatMap((exports) => [...exports.keys()]),
);

function normalizePath(value) {
	return value.split(path.sep).join("/");
}

function sourceLocation(sourceFile, node) {
	const location = sourceFile.getLineAndCharacterOfPosition(
		node.getStart(sourceFile),
	);
	return { line: location.line + 1, column: location.character + 1 };
}

function diagnostic(code, file, message, location = {}) {
	return {
		code,
		file: normalizePath(file),
		line: location.line ?? 1,
		column: location.column ?? 1,
		message,
	};
}

function unwrapExpression(node) {
	let current = node;
	while (
		ts.isAsExpression(current) ||
		ts.isSatisfiesExpression(current) ||
		ts.isParenthesizedExpression(current) ||
		ts.isTypeAssertionExpression(current)
	) {
		current = current.expression;
	}
	return current;
}

function propertyNameText(name) {
	if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text;
	return undefined;
}

function objectProperty(node, name) {
	return node.properties.find(
		(property) =>
			ts.isPropertyAssignment(property) &&
			propertyNameText(property.name) === name,
	);
}

function validateStringPropertyRules(sourceFile, file, diagnostics) {
	const allowedFormats = new Set([
		"attribution",
		"category",
		"hostname",
		"identifier",
	]);
	const visit = (node) => {
		if (ts.isObjectLiteralExpression(node)) {
			const typeProperty = objectProperty(node, "type");
			if (
				typeProperty &&
				ts.isStringLiteralLike(typeProperty.initializer) &&
				typeProperty.initializer.text === "string"
			) {
				const valuesProperty = objectProperty(node, "values");
				const formatProperty = objectProperty(node, "format");
				const hasValues =
					valuesProperty &&
					ts.isArrayLiteralExpression(valuesProperty.initializer) &&
					valuesProperty.initializer.elements.length > 0;
				const hasFormat =
					formatProperty &&
					ts.isStringLiteralLike(formatProperty.initializer) &&
					allowedFormats.has(formatProperty.initializer.text);
				if (!hasValues && !hasFormat) {
					diagnostics.push(
						diagnostic(
							"unbounded-string-property",
							file,
							"String analytics properties require a non-empty values enum or an approved format",
							sourceLocation(sourceFile, node),
						),
					);
				}
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
}

export function parseEventRegistry(sourceText, file = DEFAULT_REGISTRY_PATH) {
	const sourceFile = ts.createSourceFile(
		file,
		sourceText,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS,
	);
	const diagnostics = (sourceFile.parseDiagnostics ?? []).map((entry) => {
		const start = entry.start ?? 0;
		const location = sourceFile.getLineAndCharacterOfPosition(start);
		return diagnostic(
			"registry-parse-error",
			file,
			ts.flattenDiagnosticMessageText(entry.messageText, " "),
			{ line: location.line + 1, column: location.character + 1 },
		);
	});
	validateStringPropertyRules(sourceFile, file, diagnostics);
	let registryDeclaration;
	for (const statement of sourceFile.statements) {
		if (!ts.isVariableStatement(statement)) continue;
		for (const declaration of statement.declarationList.declarations) {
			if (
				ts.isIdentifier(declaration.name) &&
				declaration.name.text === "EVENT_REGISTRY"
			) {
				registryDeclaration = declaration;
			}
		}
	}
	if (!registryDeclaration?.initializer) {
		diagnostics.push(
			diagnostic(
				"registry-not-found",
				file,
				"EVENT_REGISTRY must be a top-level initialized variable",
			),
		);
		return { events: new Map(), diagnostics };
	}
	const initializer = unwrapExpression(registryDeclaration.initializer);
	if (!ts.isObjectLiteralExpression(initializer)) {
		diagnostics.push(
			diagnostic(
				"registry-not-object",
				file,
				"EVENT_REGISTRY must be an object literal",
				sourceLocation(sourceFile, initializer),
			),
		);
		return { events: new Map(), diagnostics };
	}
	const events = new Map();
	for (const property of initializer.properties) {
		if (ts.isSpreadAssignment(property)) {
			diagnostics.push(
				diagnostic(
					"registry-spread",
					file,
					"EVENT_REGISTRY cannot use top-level spreads",
					sourceLocation(sourceFile, property),
				),
			);
			continue;
		}
		const name = propertyNameText(property.name);
		if (!name) {
			diagnostics.push(
				diagnostic(
					"registry-computed-name",
					file,
					"EVENT_REGISTRY keys must be static identifiers or strings",
					sourceLocation(sourceFile, property),
				),
			);
			continue;
		}
		if (events.has(name)) {
			diagnostics.push(
				diagnostic(
					"registry-duplicate-event",
					file,
					`EVENT_REGISTRY declares ${name} more than once`,
					sourceLocation(sourceFile, property),
				),
			);
			continue;
		}
		events.set(name, {
			name,
			file: normalizePath(file),
			...sourceLocation(sourceFile, property),
		});
	}
	return { events, diagnostics };
}

function importDescriptor(moduleName, exportName) {
	return CAPTURE_MODULES.get(moduleName)?.get(exportName);
}

function canonicalModuleName(moduleName, file) {
	if (!moduleName.startsWith(".")) return moduleName;
	return path.posix
		.normalize(
			path.posix.join(path.posix.dirname(normalizePath(file)), moduleName),
		)
		.replace(/\.(?:js|jsx|ts|tsx)$/, "");
}

function captureBindings(sourceFile, file) {
	const identifiers = new Map();
	const namespaces = new Map();
	for (const statement of sourceFile.statements) {
		if (!ts.isImportDeclaration(statement)) continue;
		if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
		const moduleName = canonicalModuleName(
			statement.moduleSpecifier.text,
			file,
		);
		const moduleExports = CAPTURE_MODULES.get(moduleName);
		if (!moduleExports || !statement.importClause) continue;
		const bindings = statement.importClause.namedBindings;
		if (bindings && ts.isNamedImports(bindings)) {
			for (const element of bindings.elements) {
				if (element.isTypeOnly) continue;
				const exportName = element.propertyName?.text ?? element.name.text;
				const descriptor = moduleExports.get(exportName);
				if (descriptor) identifiers.set(element.name.text, descriptor);
			}
		} else if (bindings && ts.isNamespaceImport(bindings)) {
			namespaces.set(bindings.name.text, moduleName);
		}
	}
	return { identifiers, namespaces };
}

function callDescriptor(expression, bindings) {
	if (ts.isIdentifier(expression))
		return bindings.identifiers.get(expression.text);
	if (
		ts.isPropertyAccessExpression(expression) &&
		ts.isIdentifier(expression.expression)
	) {
		const moduleName = bindings.namespaces.get(expression.expression.text);
		if (moduleName) return importDescriptor(moduleName, expression.name.text);
	}
	return undefined;
}

function staticEventName(expression) {
	const value = unwrapExpression(expression);
	if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) {
		return { eventName: value.text, kind: "static" };
	}
	if (ts.isTemplateExpression(value)) return { kind: "template" };
	return { kind: "dynamic" };
}

function eventNameProperty(expression, bindings) {
	const value = unwrapExpression(expression);
	if (ts.isCallExpression(value)) {
		const descriptor = callDescriptor(value.expression, bindings);
		if (descriptor?.kind === "helper") {
			return {
				eventName: descriptor.eventName,
				kind: "static",
				node: value,
			};
		}
	}
	if (!ts.isObjectLiteralExpression(value))
		return { kind: "non-object", node: value };
	for (const property of value.properties) {
		if (
			ts.isPropertyAssignment(property) &&
			propertyNameText(property.name) === "eventName"
		) {
			return {
				...staticEventName(property.initializer),
				node: property.initializer,
			};
		}
	}
	return { kind: "missing", node: value };
}

export function analyzeTypeScriptSource({
	sourceText,
	file,
	registeredEvents,
}) {
	const scriptKind = file.endsWith(".tsx")
		? ts.ScriptKind.TSX
		: ts.ScriptKind.TS;
	const sourceFile = ts.createSourceFile(
		file,
		sourceText,
		ts.ScriptTarget.Latest,
		true,
		scriptKind,
	);
	const diagnostics = (sourceFile.parseDiagnostics ?? []).map((entry) => {
		const start = entry.start ?? 0;
		const location = sourceFile.getLineAndCharacterOfPosition(start);
		return diagnostic(
			"source-parse-error",
			file,
			ts.flattenDiagnosticMessageText(entry.messageText, " "),
			{ line: location.line + 1, column: location.character + 1 },
		);
	});
	const emissions = [];
	const bindings = captureBindings(sourceFile, file);
	const registerEmission = (eventName, node) => {
		const location = sourceLocation(sourceFile, node);
		emissions.push({ eventName, file: normalizePath(file), ...location });
		if (!registeredEvents.has(eventName)) {
			diagnostics.push(
				diagnostic(
					"unregistered-event",
					file,
					`Analytics event ${eventName} is not declared in EVENT_REGISTRY`,
					location,
				),
			);
		}
	};
	const visit = (node) => {
		if (ts.isCallExpression(node)) {
			const descriptor = callDescriptor(node.expression, bindings);
			if (descriptor?.kind === "helper") {
				registerEmission(descriptor.eventName, node);
			} else if (descriptor?.kind === "name") {
				const argument = node.arguments[0];
				if (!argument) {
					diagnostics.push(
						diagnostic(
							"missing-event-name",
							file,
							"Analytics capture call is missing its event name",
							sourceLocation(sourceFile, node),
						),
					);
				} else {
					const result = staticEventName(argument);
					if (result.kind === "static") {
						registerEmission(result.eventName, argument);
					} else {
						diagnostics.push(
							diagnostic(
								result.kind === "template"
									? "dynamic-event-template"
									: "dynamic-event-name",
								file,
								"Analytics event names must be static string literals",
								sourceLocation(sourceFile, argument),
							),
						);
					}
				}
			} else if (descriptor?.kind === "object") {
				const argument = node.arguments[0];
				if (!argument) {
					diagnostics.push(
						diagnostic(
							"missing-event-object",
							file,
							"Analytics capture call is missing its event object",
							sourceLocation(sourceFile, node),
						),
					);
				} else {
					const result = eventNameProperty(argument, bindings);
					if (result.kind === "static") {
						registerEmission(result.eventName, result.node);
					} else {
						const messages = {
							"non-object":
								"Analytics event objects must be inline object literals",
							missing: "Analytics event object is missing eventName",
							template: "Analytics eventName must not be a dynamic template",
							dynamic: "Analytics eventName must be a static string literal",
						};
						diagnostics.push(
							diagnostic(
								`invalid-event-object-${result.kind}`,
								file,
								messages[result.kind],
								sourceLocation(sourceFile, result.node),
							),
						);
					}
				}
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
	return { emissions, diagnostics };
}

function rustStringValue(raw) {
	if (raw.startsWith("r")) {
		const openingQuote = raw.indexOf('"');
		const hashCount = openingQuote - 1;
		return raw.slice(openingQuote + 1, raw.length - hashCount - 1);
	}
	const value = raw.startsWith('b"') ? raw.slice(1) : raw;
	try {
		return JSON.parse(value);
	} catch {
		return value.slice(1, -1);
	}
}

export function tokenizeRust(sourceText) {
	const tokens = [];
	let index = 0;
	let line = 1;
	let column = 1;
	const advance = (count = 1) => {
		for (let offset = 0; offset < count; offset += 1) {
			if (sourceText[index] === "\n") {
				line += 1;
				column = 1;
			} else {
				column += 1;
			}
			index += 1;
		}
	};
	const push = (type, value, startLine, startColumn) => {
		tokens.push({ type, value, line: startLine, column: startColumn });
	};
	while (index < sourceText.length) {
		const current = sourceText[index];
		const next = sourceText[index + 1];
		if (/\s/.test(current)) {
			advance();
			continue;
		}
		if (current === "/" && next === "/") {
			while (index < sourceText.length && sourceText[index] !== "\n") advance();
			continue;
		}
		if (current === "/" && next === "*") {
			let depth = 1;
			advance(2);
			while (index < sourceText.length && depth > 0) {
				if (sourceText[index] === "/" && sourceText[index + 1] === "*") {
					depth += 1;
					advance(2);
				} else if (sourceText[index] === "*" && sourceText[index + 1] === "/") {
					depth -= 1;
					advance(2);
				} else {
					advance();
				}
			}
			continue;
		}
		const rawMatch = sourceText.slice(index).match(/^(?:b)?r(#+)?"/);
		if (rawMatch) {
			const startLine = line;
			const startColumn = column;
			const hashCount = rawMatch[1]?.length ?? 0;
			const closing = `"${"#".repeat(hashCount)}`;
			const start = index;
			advance(rawMatch[0].length);
			while (
				index < sourceText.length &&
				!sourceText.startsWith(closing, index)
			) {
				advance();
			}
			if (sourceText.startsWith(closing, index)) advance(closing.length);
			const raw = sourceText.slice(start, index).replace(/^b/, "");
			push("string", rustStringValue(raw), startLine, startColumn);
			continue;
		}
		if (current === '"' || (current === "b" && next === '"')) {
			const startLine = line;
			const startColumn = column;
			const start = index;
			if (current === "b") advance();
			advance();
			while (index < sourceText.length) {
				if (sourceText[index] === "\\") {
					advance(Math.min(2, sourceText.length - index));
				} else if (sourceText[index] === '"') {
					advance();
					break;
				} else {
					advance();
				}
			}
			push(
				"string",
				rustStringValue(sourceText.slice(start, index)),
				startLine,
				startColumn,
			);
			continue;
		}
		if (/[A-Za-z_]/.test(current)) {
			const startLine = line;
			const startColumn = column;
			const start = index;
			while (/[A-Za-z0-9_]/.test(sourceText[index] ?? "")) advance();
			push(
				"identifier",
				sourceText.slice(start, index),
				startLine,
				startColumn,
			);
			continue;
		}
		const startLine = line;
		const startColumn = column;
		if (
			(current === ":" && next === ":") ||
			(current === "=" && next === ">")
		) {
			push("punctuation", `${current}${next}`, startLine, startColumn);
			advance(2);
		} else {
			push("punctuation", current, startLine, startColumn);
			advance();
		}
	}
	return tokens;
}

function functionBody(tokens, functionName) {
	for (let index = 0; index < tokens.length - 2; index += 1) {
		if (
			tokens[index]?.value !== "fn" ||
			tokens[index + 1]?.value !== functionName
		) {
			continue;
		}
		let opening = index + 2;
		while (opening < tokens.length && tokens[opening]?.value !== "{")
			opening += 1;
		if (opening >= tokens.length) return undefined;
		let depth = 1;
		for (let cursor = opening + 1; cursor < tokens.length; cursor += 1) {
			if (tokens[cursor]?.value === "{") depth += 1;
			if (tokens[cursor]?.value === "}") depth -= 1;
			if (depth === 0) return tokens.slice(opening + 1, cursor);
		}
	}
	return undefined;
}

function isTokenSequence(tokens, index, values) {
	return values.every(
		(value, offset) => tokens[index + offset]?.value === value,
	);
}

function matchingTokenIndex(tokens, start, opening, closing) {
	let depth = 0;
	for (let index = start; index < tokens.length; index += 1) {
		if (tokens[index]?.value === opening) depth += 1;
		if (tokens[index]?.value === closing) depth -= 1;
		if (depth === 0) return index;
	}
	return undefined;
}

function rustMacroStrings(tokens, macroName) {
	for (let index = 0; index < tokens.length - 2; index += 1) {
		if (!isTokenSequence(tokens, index, [macroName, "!", "("])) continue;
		const closing = matchingTokenIndex(tokens, index + 2, "(", ")");
		if (closing === undefined) return [];
		return tokens
			.slice(index + 3, closing)
			.filter((token) => token.type === "string")
			.map((token) => token.value);
	}
	return [];
}

function pascalToSnake(value) {
	return value
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
		.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
		.toLowerCase();
}

export function analyzeRustNativeContract({
	sourceText,
	file = DEFAULT_NATIVE_PATH,
	registeredEvents,
}) {
	const tokens = tokenizeRust(sourceText);
	const diagnostics = [];
	const mappings = new Map();
	const body = functionBody(tokens, "event_data");
	if (!body) {
		diagnostics.push(
			diagnostic(
				"native-event-data-not-found",
				file,
				"Native analytics must define event_data",
			),
		);
		return { mappings, coreEvents: new Set(), diagnostics };
	}
	const variantIndexes = [];
	for (let index = 0; index < body.length - 2; index += 1) {
		if (isTokenSequence(body, index, ["ProductAnalyticsEvent", "::"])) {
			variantIndexes.push(index);
		}
	}
	for (let offset = 0; offset < variantIndexes.length; offset += 1) {
		const start = variantIndexes[offset];
		const end = variantIndexes[offset + 1] ?? body.length;
		const variantToken = body[start + 2];
		const variant = variantToken?.value;
		if (!variant) continue;
		const names = [];
		for (let index = start; index < end - 4; index += 1) {
			if (!isTokenSequence(body, index, ["EventData", "::", "new", "("])) {
				continue;
			}
			const nameToken = body[index + 4];
			if (nameToken?.type === "string") names.push(nameToken);
			else {
				diagnostics.push(
					diagnostic(
						"native-dynamic-event-name",
						file,
						`Native variant ${variant} must map to a static event string`,
						nameToken ?? variantToken,
					),
				);
			}
		}
		if (names.length !== 1) {
			diagnostics.push(
				diagnostic(
					"native-event-mapping-count",
					file,
					`Native variant ${variant} must map to exactly one EventData name`,
					variantToken,
				),
			);
			continue;
		}
		const eventName = names[0].value;
		const expectedName = pascalToSnake(variant);
		if (eventName !== expectedName) {
			diagnostics.push(
				diagnostic(
					"native-event-name-diverged",
					file,
					`Native variant ${variant} maps to ${eventName}; expected ${expectedName}`,
					names[0],
				),
			);
		}
		if (
			[...mappings.values()].some((mapping) => mapping.eventName === eventName)
		) {
			diagnostics.push(
				diagnostic(
					"native-duplicate-event-name",
					file,
					`Native event name ${eventName} is mapped by multiple variants`,
					names[0],
				),
			);
		}
		mappings.set(variant, {
			variant,
			eventName,
			file: normalizePath(file),
			line: names[0].line,
			column: names[0].column,
		});
		if (!registeredEvents.has(eventName)) {
			diagnostics.push(
				diagnostic(
					"native-unregistered-event",
					file,
					`Native event ${eventName} is not declared in EVENT_REGISTRY`,
					names[0],
				),
			);
		}
	}
	const coreBody = functionBody(tokens, "is_core_product_event");
	const coreEvents = new Set(
		coreBody ? rustMacroStrings(coreBody, "matches") : [],
	);
	if (!coreBody) {
		diagnostics.push(
			diagnostic(
				"native-core-catalog-not-found",
				file,
				"Native analytics must define is_core_product_event",
			),
		);
	} else {
		const mappedEvents = new Set(
			[...mappings.values()].map((mapping) => mapping.eventName),
		);
		for (const eventName of mappedEvents) {
			if (!coreEvents.has(eventName)) {
				diagnostics.push(
					diagnostic(
						"native-core-catalog-missing",
						file,
						`Native core catalog is missing mapped event ${eventName}`,
					),
				);
			}
		}
		for (const eventName of coreEvents) {
			if (!mappedEvents.has(eventName)) {
				diagnostics.push(
					diagnostic(
						"native-core-catalog-extra",
						file,
						`Native core catalog contains unmapped event ${eventName}`,
					),
				);
			}
		}
	}
	return { mappings, coreEvents, diagnostics };
}

function rustTokensWithoutTestItems(tokens) {
	const excluded = [];
	for (let index = 0; index < tokens.length - 2; index += 1) {
		if (!isTokenSequence(tokens, index, ["#", "["])) continue;
		const attributeEnd = matchingTokenIndex(tokens, index + 1, "[", "]");
		if (attributeEnd === undefined) continue;
		const attributeValues = new Set(
			tokens.slice(index + 2, attributeEnd).map((token) => token.value),
		);
		if (!attributeValues.has("cfg") || !attributeValues.has("test")) continue;
		let itemStart = attributeEnd + 1;
		while (isTokenSequence(tokens, itemStart, ["#", "["])) {
			const nextAttributeEnd = matchingTokenIndex(
				tokens,
				itemStart + 1,
				"[",
				"]",
			);
			if (nextAttributeEnd === undefined) break;
			itemStart = nextAttributeEnd + 1;
		}
		let itemEnd = itemStart;
		while (
			itemEnd < tokens.length &&
			tokens[itemEnd]?.value !== "{" &&
			tokens[itemEnd]?.value !== ";"
		) {
			itemEnd += 1;
		}
		if (tokens[itemEnd]?.value === "{") {
			itemEnd = matchingTokenIndex(tokens, itemEnd, "{", "}") ?? itemEnd;
		}
		excluded.push([index, itemEnd]);
		index = itemEnd;
	}
	return tokens.filter(
		(_token, index) =>
			!excluded.some(([start, end]) => index >= start && index <= end),
	);
}

export function rustProductionVariantUses(sourceText) {
	const tokens = rustTokensWithoutTestItems(tokenizeRust(sourceText));
	const variants = new Set();
	for (let index = 0; index < tokens.length - 2; index += 1) {
		if (isTokenSequence(tokens, index, ["ProductAnalyticsEvent", "::"])) {
			const variant = tokens[index + 2];
			if (variant?.type === "identifier") variants.add(variant.value);
		}
	}
	return variants;
}

function isProductionSource(relativePath) {
	const normalized = normalizePath(relativePath);
	const fileName = path.basename(normalized);
	if (WRAPPER_PATHS.has(normalized)) return false;
	if (
		fileName.endsWith(".d.ts") ||
		fileName === "tauri.ts" ||
		/\.(?:test|spec|stories)\.[^.]+$/.test(fileName)
	) {
		return false;
	}
	return normalized
		.split("/")
		.every((segment) => !SKIPPED_DIRECTORIES.has(segment));
}

function sourceFiles(projectRoot) {
	const files = [];
	const visit = (absoluteDirectory) => {
		for (const entry of fs.readdirSync(absoluteDirectory, {
			withFileTypes: true,
		})) {
			if (entry.isSymbolicLink()) continue;
			const absolutePath = path.join(absoluteDirectory, entry.name);
			if (entry.isDirectory()) {
				if (!SKIPPED_DIRECTORIES.has(entry.name)) visit(absolutePath);
				continue;
			}
			if (!entry.isFile() || !/\.(?:rs|ts|tsx)$/.test(entry.name)) continue;
			const relativePath = path.relative(projectRoot, absolutePath);
			if (isProductionSource(relativePath)) files.push(relativePath);
		}
	};
	for (const root of SOURCE_ROOTS) {
		const absoluteRoot = path.join(projectRoot, root);
		if (fs.existsSync(absoluteRoot)) visit(absoluteRoot);
	}
	return files.sort();
}

export function findMissingEmitters(registryEvents, emissions) {
	const emittedNames = new Set(emissions.map((emission) => emission.eventName));
	const diagnostics = [];
	for (const event of registryEvents.values()) {
		if (emittedNames.has(event.name)) continue;
		diagnostics.push(
			diagnostic(
				"registry-event-without-emitter",
				event.file,
				`Registry event ${event.name} has no production emitter`,
				event,
			),
		);
	}
	return diagnostics;
}

function diagnosticSort(left, right) {
	return (
		left.file.localeCompare(right.file) ||
		left.line - right.line ||
		left.column - right.column ||
		left.code.localeCompare(right.code)
	);
}

export function runEventContractCheck({
	projectRoot = DEFAULT_PROJECT_ROOT,
	registryPath = DEFAULT_REGISTRY_PATH,
	nativePath = DEFAULT_NATIVE_PATH,
} = {}) {
	const absoluteRoot = path.resolve(projectRoot);
	const registrySource = fs.readFileSync(
		path.join(absoluteRoot, registryPath),
		"utf8",
	);
	const registry = parseEventRegistry(registrySource, registryPath);
	const registeredEvents = new Set(registry.events.keys());
	const diagnostics = [...registry.diagnostics];
	const emissions = [];
	const files = sourceFiles(absoluteRoot);
	for (const relativePath of files) {
		const absolutePath = path.join(absoluteRoot, relativePath);
		const sourceText = fs.readFileSync(absolutePath, "utf8");
		if (relativePath.endsWith(".ts") || relativePath.endsWith(".tsx")) {
			if (
				![...CAPTURE_EXPORT_NAMES].some((name) => sourceText.includes(name))
			) {
				continue;
			}
			const result = analyzeTypeScriptSource({
				sourceText,
				file: relativePath,
				registeredEvents,
			});
			diagnostics.push(...result.diagnostics);
			emissions.push(...result.emissions);
		}
	}
	const nativeSource = fs.readFileSync(
		path.join(absoluteRoot, nativePath),
		"utf8",
	);
	const native = analyzeRustNativeContract({
		sourceText: nativeSource,
		file: nativePath,
		registeredEvents,
	});
	diagnostics.push(...native.diagnostics);
	const usedNativeVariants = new Set();
	for (const relativePath of files) {
		if (
			!relativePath.endsWith(".rs") ||
			normalizePath(relativePath) === normalizePath(nativePath)
		) {
			continue;
		}
		const sourceText = fs.readFileSync(
			path.join(absoluteRoot, relativePath),
			"utf8",
		);
		if (!sourceText.includes("ProductAnalyticsEvent")) continue;
		for (const variant of rustProductionVariantUses(sourceText))
			usedNativeVariants.add(variant);
	}
	for (const variant of usedNativeVariants) {
		const mapping = native.mappings.get(variant);
		if (mapping) {
			emissions.push(mapping);
		} else {
			diagnostics.push(
				diagnostic(
					"native-variant-without-mapping",
					nativePath,
					`Production uses native analytics variant ${variant} without an event_data mapping`,
				),
			);
		}
	}
	diagnostics.push(...findMissingEmitters(registry.events, emissions));
	diagnostics.sort(diagnosticSort);
	return {
		diagnostics,
		emissions,
		registryEvents: registry.events,
		nativeMappings: native.mappings,
	};
}

function commandOptions(argumentsList) {
	const options = {};
	for (let index = 0; index < argumentsList.length; index += 1) {
		const argument = argumentsList[index];
		if (argument === "--root") {
			const value = argumentsList[index + 1];
			if (!value) throw new Error("--root requires a path");
			options.projectRoot = value;
			index += 1;
		} else {
			throw new Error(`Unknown argument: ${argument}`);
		}
	}
	return options;
}

function formatDiagnostic(entry) {
	return `${entry.file}:${entry.line}:${entry.column} [${entry.code}] ${entry.message}`;
}

function main() {
	let result;
	try {
		result = runEventContractCheck(commandOptions(process.argv.slice(2)));
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
		return;
	}
	if (result.diagnostics.length > 0) {
		console.error(
			`Analytics event contract failed with ${result.diagnostics.length} issue(s):`,
		);
		for (const entry of result.diagnostics)
			console.error(formatDiagnostic(entry));
		process.exitCode = 1;
		return;
	}
	console.log(
		`Analytics event contract passed: ${result.registryEvents.size} registered events, ${new Set(result.emissions.map((emission) => emission.eventName)).size} emitted event names, ${result.emissions.length} production call sites, ${result.nativeMappings.size} native mappings.`,
	);
}

if (
	process.argv[1] &&
	path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
	main();
}
