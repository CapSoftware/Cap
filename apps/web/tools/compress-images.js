#!/usr/bin/env node

/**
 * Image Compression Tool
 *
 * This script automatically compresses JPG, PNG, and WebP images in the public directory
 * to reduce file sizes while maintaining acceptable quality. It creates a temporary
 * directory with compressed versions, shows compression statistics, and optionally
 * replaces the original files with optimized versions.
 */

const fs = require("node:fs");
const path = require("node:path");
const { execSync } = require("node:child_process");
const readline = require("node:readline");
const os = require("node:os");
const crypto = require("node:crypto");

// Create a unique temporary directory for installation
function createTempInstallDir() {
	const tmpDir = path.join(
		os.tmpdir(),
		`image-compressor-${crypto.randomBytes(6).toString("hex")}`,
	);
	fs.mkdirSync(tmpDir, { recursive: true });
	return tmpDir;
}

// Check and load dependencies from a clean temporary directory
function loadDependencies() {
	const requiredDeps = ["sharp", "glob", "chalk"];
	let tempDir = null;

	try {
		// Try to require the dependencies directly
		const sharp = require("sharp");
		const glob = require("glob");
		const chalk = require("chalk");

		return { sharp, glob, chalk };
	} catch (_e) {
		// If dependencies are missing, install them in a temporary directory
		console.log(`Required dependencies not found. Installing temporarily...`);

		tempDir = createTempInstallDir();
		const packageJson = path.join(tempDir, "package.json");

		// Create a minimal package.json
		fs.writeFileSync(
			packageJson,
			JSON.stringify({
				name: "image-compressor-temp",
				version: "1.0.0",
				private: true,
				dependencies: {},
			}),
		);

		try {
			// Install dependencies in the temporary directory
			execSync(`npm install ${requiredDeps.join(" ")}`, {
				cwd: tempDir,
				stdio: "inherit",
			});

			// Create a simple loader script
			const loaderScript = path.join(tempDir, "load-deps.js");
			fs.writeFileSync(
				loaderScript,
				`
        exports.sharp = require('sharp');
        exports.glob = require('glob');
        exports.chalk = require('chalk');
      `,
			);

			// Load dependencies from the temporary installation
			return require(loaderScript);
		} catch (error) {
			console.error(`Failed to install dependencies: ${error.message}`);
			console.error("Please install these packages globally and try again:");
			console.error(`npm install -g sharp glob chalk`);

			if (tempDir && fs.existsSync(tempDir)) {
				try {
					fs.rmSync(tempDir, { recursive: true });
				} catch (_e) {}
			}

			process.exit(1);
		}
	}
}

// Create readline interface for user input
function createInterface() {
	return readline.createInterface({
		input: process.stdin,
		output: process.stdout,
	});
}

// Ask user for confirmation
async function askForConfirmation(question) {
	const rl = createInterface();

	return new Promise((resolve) => {
		rl.question(`${question} (y/n): `, (answer) => {
			rl.close();
			resolve(answer.toLowerCase() === "y" || answer.toLowerCase() === "yes");
		});
	});
}

// Main function
async function main() {
	// Load dependencies
	console.log("Preparing image compression tool...");
	const { sharp, glob, chalk } = loadDependencies();

	// Force apply mode without asking (for script compatibility)
	const forceApply = process.argv.includes("--apply");

	const publicDir = path.join(__dirname, "../public");
	const compressedDir = path.join(__dirname, "../public-compressed");

	console.log(chalk.blue("🔍 Scanning for images in public folder..."));

	// Create compressed directory if it doesn't exist
	if (!fs.existsSync(compressedDir)) {
		fs.mkdirSync(compressedDir, { recursive: true });
	}

	// Find all images in public folder
	const imageTypes = ["jpeg", "jpg", "png", "webp"];
	const imagePatterns = imageTypes.map((type) => `${publicDir}/**/*.${type}`);

	let images = [];
	imagePatterns.forEach((pattern) => {
		const matches = glob.sync(pattern, { nocase: true });
		images = [...images, ...matches];
	});

	if (images.length === 0) {
		console.log(chalk.yellow("No images found in the public directory."));
		process.exit(0);
	}

	console.log(chalk.green(`📷 Found ${images.length} images to compress\n`));

	// Process each image
	const totalSize = { original: 0, compressed: 0 };
	const failedImages = [];

	// Use a progress indicator
	let processedCount = 0;

	console.log(chalk.blue("🔄 Starting compression process..."));

	for (const imagePath of images) {
		const relativePath = path.relative(publicDir, imagePath);
		const outputPath = path.join(compressedDir, relativePath);
		const outputDir = path.dirname(outputPath);

		processedCount++;
		const percentage = Math.floor((processedCount / images.length) * 100);
		process.stdout.write(
			`\r${chalk.blue("⏳ Progress:")} ${chalk.yellow(`${percentage}%`)} - Processing image ${processedCount}/${images.length}`,
		);

		// Create output directory if it doesn't exist
		if (!fs.existsSync(outputDir)) {
			fs.mkdirSync(outputDir, { recursive: true });
		}

		// Get original file size
		const stats = fs.statSync(imagePath);
		totalSize.original += stats.size;

		// Get image extension
		const ext = path.extname(imagePath).toLowerCase();

		try {
			let sharpImage = sharp(imagePath);

			// Apply appropriate compression based on file type
			if (ext === ".jpg" || ext === ".jpeg") {
				sharpImage = sharpImage.jpeg({ quality: 75, mozjpeg: true });
			} else if (ext === ".png") {
				sharpImage = sharpImage.png({
					compressionLevel: 6,
					adaptiveFiltering: true,
				});
			} else if (ext === ".webp") {
				sharpImage = sharpImage.webp({ quality: 75 });
			}

			// Save compressed image
			await sharpImage.toFile(outputPath);

			// Get compressed file size
			const compressedStats = fs.statSync(outputPath);
			totalSize.compressed += compressedStats.size;
		} catch (error) {
			failedImages.push({ path: relativePath, error: error.message });
		}
	}

	// Clear the progress line
	process.stdout.write(`\r${" ".repeat(100)}\r`);

	// Calculate total savings
	const totalSavingsMB = (
		(totalSize.original - totalSize.compressed) /
		(1024 * 1024)
	).toFixed(2);
	const totalSavingsPercent = (
		((totalSize.original - totalSize.compressed) / totalSize.original) *
		100
	).toFixed(2);

	console.log(`\n\n${chalk.blue("📊 ===== Compression Summary =====")}`);
	console.log(
		chalk.blue(
			`📦 Original Size: ${chalk.yellow(`${(totalSize.original / (1024 * 1024)).toFixed(2)} MB`)}`,
		),
	);
	console.log(
		chalk.blue(
			`📦 Compressed Size: ${chalk.yellow(`${(totalSize.compressed / (1024 * 1024)).toFixed(2)} MB`)}`,
		),
	);
	console.log(
		`${chalk.blue(
			`💰 Saved: ${chalk.green(`${totalSavingsMB} MB`)} (${chalk.green(`${totalSavingsPercent}%`)})`,
		)}\n`,
	);

	if (failedImages.length > 0) {
		console.log(
			chalk.red(`❌ Failed to compress ${failedImages.length} images:`),
		);
		failedImages.forEach((img) => {
			console.log(chalk.red(`   - ${img.path}: ${img.error}`));
		});
		console.log("");
	}

	console.log(
		chalk.blue(
			`🔍 Compressed images are available in: ${chalk.yellow(compressedDir)}`,
		),
	);
	console.log(
		chalk.blue("   You can compare the quality before applying changes.") +
			"\n",
	);

	// Ask for confirmation or use force apply
	let shouldApply = forceApply;

	if (!forceApply) {
		shouldApply = await askForConfirmation(
			chalk.yellow(
				"Do you want to replace the original images with the compressed versions?",
			),
		);
	}

	if (shouldApply) {
		console.log(
			chalk.blue("\n🔄 Replacing original images with compressed versions..."),
		);

		let replacedCount = 0;
		for (const imagePath of images) {
			const relativePath = path.relative(publicDir, imagePath);
			const compressedPath = path.join(compressedDir, relativePath);

			if (fs.existsSync(compressedPath)) {
				fs.copyFileSync(compressedPath, imagePath);
				replacedCount++;

				const percentage = Math.floor((replacedCount / images.length) * 100);
				process.stdout.write(
					`\r${chalk.blue("⏳ Progress:")} ${chalk.yellow(`${percentage}%`)} - Replacing image ${replacedCount}/${images.length}`,
				);
			}
		}

		// Clear the progress line
		process.stdout.write(`\r${" ".repeat(100)}\r`);

		// Remove compressed directory
		fs.rmSync(compressedDir, { recursive: true, force: true });
		console.log(
			chalk.green(
				`\n✅ Success! All ${replacedCount} images have been optimized and replaced.`,
			),
		);
		console.log(
			chalk.green(`🧹 Temporary compressed folder has been removed.`),
		);
	} else {
		console.log(chalk.blue("\n👀 No changes applied. You can:"));
		console.log(
			chalk.blue(
				`   1. View the compressed images in ${chalk.yellow(compressedDir)}`,
			),
		);
		console.log(
			chalk.blue("   2. Run this tool again if you decide to apply changes"),
		);
		console.log(
			`${chalk.blue("   3. Or manually replace images you want to use")}\n`,
		);
	}
}

main().catch((err) => {
	console.error("Error during image compression:", err);
	process.exit(1);
});
