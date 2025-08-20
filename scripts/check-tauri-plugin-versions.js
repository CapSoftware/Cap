#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Check for debug flag
const DEBUG = process.argv.includes("--debug") || process.env.DEBUG === "true";

function debug(message) {
	if (DEBUG) {
		console.log(`[DEBUG] ${message}`);
	}
}

// Helper function to parse semantic version
function parseVersion(version) {
	const match = version.match(/^(\d+)\.(\d+)\.(\d+)/);
	if (!match) {
		throw new Error(`Invalid version format: ${version}`);
	}
	return {
		major: parseInt(match[1], 10),
		minor: parseInt(match[2], 10),
		patch: parseInt(match[3], 10),
		full: version,
	};
}

// Parse pnpm-lock.yaml to extract Tauri plugin versions
function parsePnpmLock(lockfilePath) {
	const content = fs.readFileSync(lockfilePath, "utf8");
	const plugins = {};

	const lines = content.split("\n");
	let currentPlugin = null;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];

		// Look for @tauri-apps/plugin- packages (with or without quotes)
		const pluginMatch = line.match(
			/^\s*['"]?(@tauri-apps\/plugin-[^'":\s]+)['"]?:\s*$/,
		);
		if (pluginMatch) {
			currentPlugin = pluginMatch[1];
			debug(`Found JS plugin: ${currentPlugin} at line ${i + 1}`);
			continue;
		}

		// Look for version when we're tracking a plugin
		if (currentPlugin) {
			const versionMatch = line.match(/^\s*version:\s*['"]?([^'"]+)['"]?\s*$/);
			if (versionMatch) {
				plugins[currentPlugin] = versionMatch[1];
				debug(`  Version: ${versionMatch[1]}`);
				currentPlugin = null;
			}

			// Reset if we hit another top-level key
			if (
				line.match(/^\s*[^'":\s]+:\s*$/) &&
				!line.match(/^\s*(specifier|version):/)
			) {
				currentPlugin = null;
			}
		}

		// Also check for inline version specifications in dependency lists
		const inlineMatch = line.match(/@tauri-apps\/plugin-([^@]+)@([^)]+)/);
		if (inlineMatch) {
			const pluginName = inlineMatch[1];
			const version = inlineMatch[2];
			plugins[`@tauri-apps/plugin-${pluginName}`] = version;
			debug(
				`Found inline JS plugin: @tauri-apps/plugin-${pluginName}@${version}`,
			);
		}
	}

	return plugins;
}

// Parse Cargo.lock to extract Tauri plugin versions
function parseCargoLock(lockfilePath) {
	const content = fs.readFileSync(lockfilePath, "utf8");
	const plugins = {};

	const lines = content.split("\n");
	let currentPackage = null;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];

		// Look for package declarations
		const packageMatch = line.match(/^name = "tauri-plugin-(.+)"$/);
		if (packageMatch) {
			currentPackage = `tauri-plugin-${packageMatch[1]}`;
			debug(`Found Rust plugin: ${currentPackage} at line ${i + 1}`);
			continue;
		}

		// Look for version when we're in a tauri-plugin package
		if (currentPackage && line.match(/^version = "(.+)"$/)) {
			const versionMatch = line.match(/^version = "(.+)"$/);
			if (versionMatch) {
				plugins[currentPackage] = versionMatch[1];
				debug(`  Version: ${versionMatch[1]}`);
				currentPackage = null;
			}
		}

		// Reset when we hit a new [[package]] block
		if (line.match(/^\[\[package\]\]$/)) {
			currentPackage = null;
		}
	}

	return plugins;
}

// Map plugin names between JS and Rust
function mapPluginNames(jsName, rustPlugins) {
	// Convert @tauri-apps/plugin-clipboard-manager to tauri-plugin-clipboard-manager
	const rustName = jsName.replace("@tauri-apps/plugin-", "tauri-plugin-");
	return rustPlugins[rustName] ? rustName : null;
}

// Compare versions and report mismatches
function compareVersions(jsPlugins, rustPlugins) {
	const results = {
		matching: [],
		mismatched: [],
		jsOnly: [],
		rustOnly: [],
	};

	// Check JS plugins against Rust plugins
	for (const [jsName, jsVersion] of Object.entries(jsPlugins)) {
		const rustName = mapPluginNames(jsName, rustPlugins);

		if (!rustName) {
			results.jsOnly.push({ name: jsName, version: jsVersion });
			continue;
		}

		const rustVersion = rustPlugins[rustName];

		try {
			const jsParsed = parseVersion(jsVersion);
			const rustParsed = parseVersion(rustVersion);

			if (
				jsParsed.major === rustParsed.major &&
				jsParsed.minor === rustParsed.minor
			) {
				results.matching.push({
					jsName,
					rustName,
					jsVersion,
					rustVersion,
					majorMinor: `${jsParsed.major}.${jsParsed.minor}`,
				});
			} else {
				results.mismatched.push({
					jsName,
					rustName,
					jsVersion,
					rustVersion,
					jsMajorMinor: `${jsParsed.major}.${jsParsed.minor}`,
					rustMajorMinor: `${rustParsed.major}.${rustParsed.minor}`,
				});
			}
		} catch (error) {
			console.warn(
				`Warning: Could not parse versions for ${jsName} (${jsVersion}) / ${rustName} (${rustVersion}): ${error.message}`,
			);
		}
	}

	// Check for Rust-only plugins
	for (const [rustName, rustVersion] of Object.entries(rustPlugins)) {
		const jsName = `@tauri-apps/plugin-${rustName.replace("tauri-plugin-", "")}`;
		if (!jsPlugins[jsName]) {
			results.rustOnly.push({ name: rustName, version: rustVersion });
		}
	}

	return results;
}

// Main function
function main() {
	const rootDir = path.resolve(__dirname, "..");
	const pnpmLockPath = path.join(rootDir, "pnpm-lock.yaml");
	const cargoLockPath = path.join(rootDir, "Cargo.lock");

	// Check if files exist
	if (!fs.existsSync(pnpmLockPath)) {
		console.error(`❌ Error: pnpm-lock.yaml not found at ${pnpmLockPath}`);
		console.error("Please run this script from the project root directory.");
		process.exit(1);
	}

	if (!fs.existsSync(cargoLockPath)) {
		console.error(`❌ Error: Cargo.lock not found at ${cargoLockPath}`);
		console.error("Please run this script from the project root directory.");
		process.exit(1);
	}

	debug(`Reading pnpm lockfile: ${pnpmLockPath}`);
	debug(`Reading Cargo lockfile: ${cargoLockPath}`);

	console.log("🔍 Checking Tauri plugin version consistency...\n");

	try {
		// Parse both lockfiles
		const jsPlugins = parsePnpmLock(pnpmLockPath);
		const rustPlugins = parseCargoLock(cargoLockPath);

		console.log(`Found ${Object.keys(jsPlugins).length} JS Tauri plugins`);
		console.log(
			`Found ${Object.keys(rustPlugins).length} Rust Tauri plugins\n`,
		);

		if (DEBUG) {
			console.log("JS Plugins found:");
			Object.entries(jsPlugins).forEach(([name, version]) => {
				console.log(`  ${name}@${version}`);
			});
			console.log("\nRust Plugins found:");
			Object.entries(rustPlugins).forEach(([name, version]) => {
				console.log(`  ${name}@${version}`);
			});
			console.log();
		}

		// Compare versions
		const results = compareVersions(jsPlugins, rustPlugins);

		// Report results
		if (results.matching.length > 0) {
			console.log("✅ Matching versions (major.minor):");
			results.matching.forEach(
				({ jsName, rustName, jsVersion, rustVersion, majorMinor }) => {
					console.log(
						`  ${majorMinor}: ${jsName}@${jsVersion} ↔ ${rustName}@${rustVersion}`,
					);
				},
			);
			console.log();
		}

		let hasErrors = false;

		if (results.mismatched.length > 0) {
			hasErrors = true;
			console.log("❌ Version mismatches (major.minor):");
			results.mismatched.forEach(
				({
					jsName,
					rustName,
					jsVersion,
					rustVersion,
					jsMajorMinor,
					rustMajorMinor,
				}) => {
					console.log(
						`  ${jsName}@${jsVersion} (${jsMajorMinor}) ↔ ${rustName}@${rustVersion} (${rustMajorMinor})`,
					);
				},
			);
			console.log();
		}

		if (results.jsOnly.length > 0) {
			console.log("⚠️  JS-only plugins (no Rust equivalent found):");
			results.jsOnly.forEach(({ name, version }) => {
				console.log(`  ${name}@${version}`);
			});
			console.log();
		}

		if (results.rustOnly.length > 0) {
			console.log("⚠️  Rust-only plugins (no JS equivalent found):");
			results.rustOnly.forEach(({ name, version }) => {
				console.log(`  ${name}@${version}`);
			});
			console.log();
		}

		// Summary
		if (hasErrors) {
			console.log("💥 Version consistency check failed!");
			console.log(
				"Please ensure that Tauri plugins have matching major.minor versions between package.json and Cargo.toml",
			);
			process.exit(1);
		} else {
			console.log("🎉 All Tauri plugin versions are consistent!");
		}
	} catch (error) {
		console.error(`❌ Error: ${error.message}`);
		if (DEBUG) {
			console.error("Stack trace:", error.stack);
		}
		process.exit(1);
	}
}

// Show usage if help flag is passed
if (process.argv.includes("--help") || process.argv.includes("-h")) {
	console.log(`
Usage: node check-tauri-plugin-versions.js [options]

Options:
  --debug    Enable debug logging
  --help     Show this help message

Description:
  Checks that all @tauri-apps/plugin-* packages have matching major.minor
  versions with their corresponding tauri-plugin-* crates.

  The script reads pnpm-lock.yaml and Cargo.lock from the project root
  and compares versions to ensure compatibility.

Exit codes:
  0 - All versions match
  1 - Version mismatches found or error occurred
`);
	process.exit(0);
}

main();
