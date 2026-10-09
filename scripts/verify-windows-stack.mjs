import { readFileSync } from "node:fs";

const filePath = process.argv[2];
if (!filePath) {
	throw new Error("Usage: node scripts/verify-windows-stack.mjs <executable>");
}

const binary = readFileSync(filePath);
if (binary.toString("ascii", 0, 2) !== "MZ") {
	throw new Error(`${filePath} is not a Windows executable`);
}
const peOffset = binary.readUInt32LE(0x3c);
if (binary.readUInt32LE(peOffset) !== 0x4550) {
	throw new Error(`${filePath} has an invalid PE signature`);
}
const optionalHeader = peOffset + 24;
const magic = binary.readUInt16LE(optionalHeader);
if (magic !== 0x20b && magic !== 0x10b) {
	throw new Error(`${filePath} has an unsupported PE optional header`);
}
const stackReserve =
	magic === 0x20b
		? binary.readBigUInt64LE(optionalHeader + 72)
		: BigInt(binary.readUInt32LE(optionalHeader + 72));
if (stackReserve < 16n * 1024n * 1024n) {
	throw new Error(
		`${filePath} reserves only ${stackReserve} bytes for its Windows UI stack; media dispatch requires at least 16 MiB`,
	);
}
console.log(`Verified Windows UI stack reserve: ${stackReserve} bytes`);
