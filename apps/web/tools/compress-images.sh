#!/bin/bash

# Image Compression Shell Script Wrapper
# 
# This script creates a temporary environment with Node.js dependencies for image compression,
# generates a Node.js script that handles the actual compression logic, and runs it within
# the temporary environment. It handles setup, dependency installation, and cleanup automatically.

RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[0;33m'
NC='\033[0m'

echo -e "${BLUE}📦 Cap Image Compression Tool${NC}"
echo -e "${BLUE}---------------------------${NC}\n"

PROJECT_ROOT=$(cd "$(dirname "$0")/.." && pwd)
echo -e "${BLUE}Project root: ${YELLOW}${PROJECT_ROOT}${NC}"

TEMP_DIR=$(mktemp -d)
cd "$TEMP_DIR"

cat > package.json << EOF
{
  "name": "image-compressor-temp",
  "version": "1.0.0",
  "private": true,
  "dependencies": {
    "sharp": "^0.33.2",
    "glob": "^10.3.10",
    "chalk": "^4.1.2"
  }
}
EOF

cat > compress-images.js << 'EOL'
const fs = require('fs');
const path = require('path');
const readline = require('readline');

try {
  var sharp = require('sharp');
  var glob = require('glob');
  var chalk = require('chalk');
} catch (error) {
  console.error('Error loading dependencies:', error.message);
  console.error('Please run "npm install" in the temporary directory before running this script.');
  process.exit(1);
}

function createInterface() {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
}

async function askForConfirmation(question) {
  const rl = createInterface();
  
  return new Promise((resolve) => {
    rl.question(question + ' (y/n): ', (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
    });
  });
}

function formatBytes(bytes, decimals = 2) {
  if (bytes === 0) return '0 Bytes';
  
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

function checkDirectoryForImages(dir, types) {
  if (!fs.existsSync(dir)) {
    console.log(chalk.red(`Directory does not exist: ${dir}`));
    return false;
  }
  
  console.log(chalk.blue(`Checking directory: ${dir}`));
  try {
    const allFiles = fs.readdirSync(dir, { recursive: true });
    console.log(chalk.yellow(`Total files found: ${allFiles.length}`));
    
    const imageFiles = allFiles.filter(file => {
      const ext = path.extname(file).toLowerCase();
      return types.includes(ext.replace('.', ''));
    });
    
    console.log(chalk.yellow(`Image files found: ${imageFiles.length}`));
    return imageFiles.length > 0;
  } catch (err) {
    console.log(chalk.red(`Error reading directory: ${err.message}`));
    return false;
  }
}

async function main() {
  const forceApply = process.argv.includes('--apply');
  const detailedOutput = !process.argv.includes('--quiet');
  
  const scriptDir = process.env.PROJECT_ROOT;
  console.log(chalk.blue(`Project root from environment: ${scriptDir}`));
  
  const possiblePublicDirs = [
    path.join(scriptDir, 'public'),
    path.join(scriptDir, 'static'),
    scriptDir,
    path.join(scriptDir, '..', 'public')
  ];
  
  let publicDir = null;
  const imageExtensions = ['jpeg', 'jpg', 'png', 'webp'];
  
  for (const dir of possiblePublicDirs) {
    console.log(chalk.blue(`Checking potential public directory: ${dir}`));
    if (fs.existsSync(dir)) {
      publicDir = dir;
      break;
    }
  }
  
  if (!publicDir) {
    console.log(chalk.red('Could not find a valid public directory!'));
    process.exit(1);
  }
  
  console.log(chalk.green(`Using public directory: ${publicDir}`));
  
  const compressedDir = path.join(scriptDir, 'public-compressed');
  
  console.log(chalk.blue('🔍 Scanning for images in public folder...'));
  
  if (fs.existsSync(compressedDir)) {
    console.log(chalk.yellow('Removing existing compressed folder...'));
    fs.rmSync(compressedDir, { recursive: true, force: true });
  }
  
  fs.mkdirSync(compressedDir, { recursive: true });
  
  if (!checkDirectoryForImages(publicDir, imageExtensions)) {
    console.log(chalk.yellow(`\nNo images found in ${publicDir}.`));
    console.log(chalk.yellow('Please check if this is the correct directory for your images.'));
    
    const shouldContinue = await askForConfirmation(chalk.blue('Do you want to manually specify a different directory?'));
    
    if (shouldContinue) {
      console.log(chalk.blue('\nPlease run the script again with the correct path.'));
      process.exit(0);
    } else {
      process.exit(0);
    }
  }
  
  const imageTypes = ['jpeg', 'jpg', 'png', 'webp'];
  const imagePatterns = imageTypes.map(type => `${publicDir}/**/*.${type}`);
  
  let images = [];
  imagePatterns.forEach(pattern => {
    console.log(chalk.blue(`Searching with pattern: ${pattern}`));
    const matches = glob.sync(pattern, { nocase: true });
    console.log(chalk.yellow(`  Found ${matches.length} matches`));
    images = [...images, ...matches];
  });
  
  if (images.length === 0) {
    console.log(chalk.yellow('No images found in the public directory.'));
    process.exit(0);
  }
  
  console.log(chalk.green(`📷 Found ${images.length} images to compress\n`));
  
  const totalSize = { original: 0, compressed: 0 };
  const failedImages = [];
  const compressionResults = [];
  const skippedImages = [];
  
  let processedCount = 0;
  
  console.log(chalk.blue('🔄 Starting compression process...\n'));
  
  if (detailedOutput) {
    console.log(chalk.blue('File'.padEnd(60) + 'Original'.padEnd(15) + 'Compressed'.padEnd(15) + 'Savings'.padEnd(15) + 'Percent'));
    console.log(chalk.blue('-'.repeat(105)));
  }
  
  for (const imagePath of images) {
    const relativePath = path.relative(publicDir, imagePath);
    const outputPath = path.join(compressedDir, relativePath);
    const outputDir = path.dirname(outputPath);
    
    processedCount++;
    
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    
    const stats = fs.statSync(imagePath);
    
    const ext = path.extname(imagePath).toLowerCase();
    
    try {
      let sharpImage = sharp(imagePath);
      
      if (ext === '.jpg' || ext === '.jpeg') {
        sharpImage = sharpImage.jpeg({ quality: 85, mozjpeg: true });
      } else if (ext === '.png') {
        sharpImage = sharpImage.png({ compressionLevel: 8, adaptiveFiltering: true });
      } else if (ext === '.webp') {
        sharpImage = sharpImage.webp({ quality: 85 });
      }
      
      await sharpImage.toFile(outputPath);
      
      const compressedStats = fs.statSync(outputPath);
      
      const savings = stats.size - compressedStats.size;
      const savingsPercent = (savings / stats.size * 100).toFixed(2);
      
      if (compressedStats.size >= stats.size) {
        skippedImages.push({
          path: relativePath,
          original: stats.size,
          compressed: compressedStats.size,
          difference: compressedStats.size - stats.size
        });
        
        fs.unlinkSync(outputPath);
        
        if (detailedOutput) {
          const displayPath = relativePath.length > 59 ? '...' + relativePath.slice(-56) : relativePath.padEnd(60);
          console.log(
            chalk.yellow(displayPath.padEnd(60) + 
            formatBytes(stats.size).padEnd(15) + 
            formatBytes(compressedStats.size).padEnd(15) + 
            `+${formatBytes(compressedStats.size - stats.size)}`.padEnd(15) + 
            `SKIPPED (would increase size)`)
          );
        }
      } else {
        totalSize.original += stats.size;
        totalSize.compressed += compressedStats.size;
        
        compressionResults.push({
          path: relativePath,
          original: stats.size,
          compressed: compressedStats.size,
          savings,
          savingsPercent
        });
        
        if (detailedOutput) {
          const displayPath = relativePath.length > 59 ? '...' + relativePath.slice(-56) : relativePath.padEnd(60);
          console.log(
            displayPath.padEnd(60) + 
            formatBytes(stats.size).padEnd(15) + 
            formatBytes(compressedStats.size).padEnd(15) + 
            formatBytes(savings).padEnd(15) + 
            `${savingsPercent}%`
          );
        }
      }
      
      if (!detailedOutput && (processedCount % 10 === 0 || processedCount === images.length)) {
        process.stdout.write(`\r${chalk.blue('⏳ Progress:')} ${chalk.yellow(`${Math.floor((processedCount / images.length) * 100)}%`)} - Processed ${processedCount}/${images.length} images`);
      }
    } catch (error) {
      failedImages.push({ path: relativePath, error: error.message });
      if (detailedOutput) {
        console.log(chalk.red(`${relativePath.padEnd(60)} ERROR: ${error.message}`));
      }
    }
  }
  
  if (!detailedOutput) {
    process.stdout.write('\r' + ' '.repeat(100) + '\r');
  }
  
  const totalSavingsMB = ((totalSize.original - totalSize.compressed) / (1024 * 1024)).toFixed(2);
  const totalSavingsPercent = totalSize.original > 0 ? ((totalSize.original - totalSize.compressed) / totalSize.original * 100).toFixed(2) : "0.00";
  
  console.log('\n\n' + chalk.blue('📊 ===== Compression Summary ====='));
  console.log(chalk.blue(`📦 Original Size: ${chalk.yellow(formatBytes(totalSize.original))}`));
  console.log(chalk.blue(`📦 Compressed Size: ${chalk.yellow(formatBytes(totalSize.compressed))}`));
  console.log(chalk.blue(`💰 Saved: ${chalk.green(formatBytes(totalSize.original - totalSize.compressed))} (${chalk.green(totalSavingsPercent + '%')})`) + '\n');
  
  if (skippedImages.length > 0) {
    console.log(chalk.yellow(`⚠️ Skipped ${skippedImages.length} images that would become larger when compressed`));
    
    skippedImages.sort((a, b) => b.difference - a.difference);
    
    const worstOffenders = skippedImages.slice(0, Math.min(3, skippedImages.length));
    console.log(chalk.yellow('   Top skipped images:'));
    worstOffenders.forEach(img => {
      console.log(chalk.yellow(`   - ${img.path}: Would increase by ${formatBytes(img.difference)} (${formatBytes(img.original)} → ${formatBytes(img.compressed)})`));
    });
    console.log();
  }
  
  if (compressionResults.length > 0) {
    compressionResults.sort((a, b) => b.savingsPercent - a.savingsPercent);
    
    const bestResult = compressionResults[0];
    const worstResult = compressionResults[compressionResults.length - 1];
    
    console.log(chalk.blue('🏆 Best compression: ') + 
      chalk.green(`${bestResult.path} - ${bestResult.savingsPercent}% reduction (${formatBytes(bestResult.original)} → ${formatBytes(bestResult.compressed)})`));
    
    console.log(chalk.blue('⚠️ Least compression: ') + 
      chalk.yellow(`${worstResult.path} - ${worstResult.savingsPercent}% reduction (${formatBytes(worstResult.original)} → ${formatBytes(worstResult.compressed)})`));
    
    console.log();
  }
  
  if (failedImages.length > 0) {
    console.log(chalk.red(`❌ Failed to compress ${failedImages.length} images:`));
    failedImages.forEach(img => {
      console.log(chalk.red(`   - ${img.path}: ${img.error}`));
    });
    console.log('');
  }
  
  if (compressionResults.length === 0) {
    console.log(chalk.yellow('No images were successfully compressed. No changes to apply.'));
    
    fs.rmSync(compressedDir, { recursive: true, force: true });
    process.exit(0);
  }
  
  console.log(chalk.blue(`🔍 Compressed images are available in: ${chalk.yellow(compressedDir)}`));
  console.log(chalk.blue('   You can compare the quality before applying changes.') + '\n');
  
  let shouldApply = forceApply;
  
  if (!forceApply) {
    shouldApply = await askForConfirmation(chalk.yellow('Do you want to replace the original images with the compressed versions?'));
  }
  
  if (shouldApply) {
    console.log(chalk.blue('\n🔄 Replacing original images with compressed versions...'));
    
    let replacedCount = 0;
    for (const imagePath of images) {
      const relativePath = path.relative(publicDir, imagePath);
      const compressedPath = path.join(compressedDir, relativePath);
      
      if (fs.existsSync(compressedPath)) {
        fs.copyFileSync(compressedPath, imagePath);
        replacedCount++;
        
        const percentage = Math.floor((replacedCount / compressionResults.length) * 100);
        process.stdout.write(`\r${chalk.blue('⏳ Progress:')} ${chalk.yellow(`${percentage}%`)} - Replacing image ${replacedCount}/${compressionResults.length}`);
      }
    }
    
    process.stdout.write('\r' + ' '.repeat(100) + '\r');
    
    fs.rmSync(compressedDir, { recursive: true, force: true });
    console.log(chalk.green(`\n✅ Success! ${replacedCount} images have been optimized and replaced.`));
    if (skippedImages.length > 0) {
      console.log(chalk.yellow(`   Note: ${skippedImages.length} images were skipped because compression would have increased their size.`));
    }
    console.log(chalk.green(`🧹 Temporary compressed folder has been removed.`));
  } else {
    console.log(chalk.blue('\n👀 No changes applied. You can:'));
    console.log(chalk.blue(`   1. View the compressed images in ${chalk.yellow(compressedDir)}`));
    console.log(chalk.blue('   2. Run this tool again if you decide to apply changes'));
    console.log(chalk.blue('   3. Or manually replace images you want to use') + '\n');
  }
}

main().catch(err => {
  console.error('Error during image compression:', err);
  process.exit(1);
});
EOL

echo -e "${YELLOW}Installing dependencies (this may take a moment)...${NC}"
npm install --no-fund --no-audit --silent

if [ $? -ne 0 ]; then
  echo -e "${RED}Failed to install dependencies.${NC}"
  rm -rf "$TEMP_DIR"
  exit 1
fi

echo -e "${GREEN}Dependencies installed. ${BLUE}Running image compression...${NC}\n"
PROJECT_ROOT="$PROJECT_ROOT" node compress-images.js "$@"

cd - > /dev/null
rm -rf "$TEMP_DIR" 