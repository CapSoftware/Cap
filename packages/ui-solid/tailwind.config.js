/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "../../apps/*/src/**/*.{js,ts,jsx,tsx,mdx}",
    "../../packages/*/src/**/*.{ts,tsx,html,stories.tsx}",
  ],
  theme: {
    colors: {
      gray: {
        50: "#FFFFFF",
        100: "#F7F8FA",
        200: "#E7EAF0",
        300: "#C9CEDB",
        400: "#8991A3",
        500: "#12161F",
      },
      "black-transparent": {
        5: "rgba(18,22,31,0.05)",
        10: "rgba(18,22,31,0.1)",
        20: "rgba(18,22,31,0.2)",
        40: "rgba(18,22,31,0.4)",
        60: "rgba(18,22,31,0.6)",
        80: "rgba(18,22,31,0.8)",
      },
      "white-transparent": {
        5: "rgba(255,255,255,0.05)",
        10: "rgba(255,255,255,0.1)",
        20: "rgba(255,255,255,0.2)",
        40: "rgba(255,255,255,0.4)",
      },
      blue: {
        50: "#EBF1FF",
        100: "#ADC9FF",
        200: "#85ADFF",
        300: "#4785FF",
        400: "#3F75E0",
      },
      "blue-transparent": {
        10: "rgba(34,64,122,0.1)",
        20: "rgba(34,64,122,0.2)",
      },
      red: {
        50: "#FFEBEE",
        100: "#FFADBB",
        200: "#FF8599",
        300: "#FF4766",
        400: "#E03F5A",
      },
      "red-transparent": {
        20: "rgba(255,71,102,0.2)",
      },
    },
    boxShadow: {
      s: "0px 8px 16px 0px rgba(18, 22, 31, 0.04)",
    },
  },
  plugins: [
    require("tailwindcss-animate"),
    require("@tailwindcss/typography"),
    require("@kobalte/tailwindcss"),
    require("tailwind-scrollbar"),
  ],
};
