module.exports = {
  extends: [require.resolve("config/eslint/web.js")],
  parserOptions: {
    tsconfigRootDir: __dirname,
    project: "./tsconfig.json",
  },
};
