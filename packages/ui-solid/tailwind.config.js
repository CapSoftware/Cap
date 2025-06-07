function getColorScale(name, alpha = false) {
  let scale = {};
  for (let i = 1; i <= 12; i++) {
    scale[i] = `var(--${name}-${i})`;
    // next line only needed if using alpha values
    if (alpha) scale[`a${i}`] = `var(--${name}-a${i})`;
  }

  return scale;
}

/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "../../apps/*/src/**/*.{js,ts,jsx,tsx,mdx}",
    "../../packages/*/src/**/*.{ts,tsx,html,stories.tsx}",
  ],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        "gray-a": getColorScale("gray", true),
        indigo: getColorScale("indigo"),
        transparent: "rgba(0,0,0,0)",
        "solid-white": "#ffffff",
        "transparent-window": "var(--transparent-window)",
        gray: {
          50: "var(--gray-50)",
          100: "var(--gray-100)",
          200: "var(--gray-200)",
          300: "var(--gray-300)",
          400: "var(--gray-400)",
          450: "var(--gray-450)",
          500: "var(--gray-500)",
          ...getColorScale("gray"),
        },
        "gray-transparent": {
          50: "var(--gray-50-transparent-50)",
          100: "var(--gray-100-transparent-50)",
          200: "var(--gray-200-transparent-50)",
          300: "var(--gray-300-transparent-50)",
          400: "var(--gray-400-transparent-50)",
          450: "var(--gray-450-transparent-50)",
          500: "var(--gray-500-transparent-50)",
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
          60: "var(--white-transparent-60)",
          80: "var(--white-transparent-80)",
        },
        blue: {
          50: "var(--blue-50)",
          100: "var(--blue-100)",
          200: "var(--blue-200)",
          300: "var(--blue-300)",
          400: "var(--blue-400)",
          ...getColorScale("blue"),
        },
        "blue-transparent": {
          0: "var(--blue-transparent-0)",
          10: "var(--blue-transparent-10)",
          20: "var(--blue-transparent-20)",
        },
        red: {
          50: "var(--red-50)",
          100: "var(--red-100)",
          200: "var(--red-200)",
          300: "var(--red-300)",
          400: "var(--red-400)",
          ...getColorScale("red"),
        },
        "red-transparent": {
          20: "var(--red-transparent-20)",
        },
      },
      boxShadow: {
        s: "var(--shadow-s)",
      },
      keyframes: {
        "collapsible-down": {
          from: { height: 0 },
          to: { height: "var(--kb-collapsible-content-height)" },
        },
        "collapsible-up": {
          from: { height: "var(--kb-collapsible-content-height)" },
          to: { height: 0 },
        },
      },
      animation: {
        "collapsible-down": "collapsible-down 0.2s ease-out",
        "collapsible-up": "collapsible-up 0.2s ease-out",
      },
    },
  },
  plugins: [
    require("tailwindcss-animate"),
    require("@tailwindcss/typography"),
    require("@kobalte/tailwindcss"),
    require("tailwind-scrollbar"),
  ],
};
