const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);
const blockList = config.resolver.blockList;

config.resolver.blockList = [
	...(Array.isArray(blockList) ? blockList : blockList ? [blockList] : []),
	/[/\\]\.next[/\\].*/,
];

module.exports = config;
