const parser = require("@typescript-eslint/parser");

module.exports = [
	{
		files: ["src/**/*.ts"],
		languageOptions: {
			ecmaVersion: "latest",
			parser,
			sourceType: "module",
		},
		rules: {},
	},
];
