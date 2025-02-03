const sharedConfig = require('../../packages/ui-solid/tailwind.config.js');

/** @type {import('tailwindcss').Config} */
module.exports = {
  presets: [sharedConfig],
  content: [
    "./src/**/*.{js,jsx,ts,tsx}",
    "../../packages/ui-solid/src/**/*.{js,jsx,ts,tsx}"
  ],
};
