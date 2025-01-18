/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "../../apps/*/src/**/*.{js,ts,jsx,tsx,mdx}",
    "../../packages/*/src/**/*.{ts,tsx,html,stories.tsx}",
  ],
  darkMode: "class",
  theme: {
    colors: {
      transparent: "rgba(0,0,0,0)",
      gray: {
        50: "var(--gray-50)",
        100: "var(--gray-100)",
        200: "var(--gray-200)",
        300: "var(--gray-300)",
        400: "var(--gray-400)",
        500: "var(--gray-500)",
      },
      "black-transparent": {
        5: "var(--black-transparent-5)",
        10: "var(--black-transparent-10)",
        20: "var(--black-transparent-20)",
        40: "var(--black-transparent-40)",
        60: "var(--black-transparent-60)",
        80: "var(--black-transparent-80)",
      },
      "white-transparent": {
        5: "var(--white-transparent-5)",
        10: "var(--white-transparent-10)",
        20: "var(--white-transparent-20)",
        40: "var(--white-transparent-40)",
      },
      blue: {
        50: "var(--blue-50)",
        100: "var(--blue-100)",
        200: "var(--blue-200)",
        300: "var(--blue-300)",
        400: "var(--blue-400)",
      },
      "blue-transparent": {
        10: "var(--blue-transparent-10)",
        20: "var(--blue-transparent-20)",
      },
      red: {
        50: "var(--red-50)",
        100: "var(--red-100)",
        200: "var(--red-200)",
        300: "var(--red-300)",
        400: "var(--red-400)",
      },
      "red-transparent": {
        20: "var(--red-transparent-20)",
      },
    },
    boxShadow: {
      s: "var(--shadow-s)",
    },
  },
  plugins: [
    require("tailwindcss-animate"),
    require("@tailwindcss/typography"),
    require("@kobalte/tailwindcss"),
    require("tailwind-scrollbar"),
  ],
};
