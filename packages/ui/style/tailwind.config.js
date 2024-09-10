module.exports = function (app, options) {
  const config = {
    content: [
      `../../apps/*/pages/**/*.{js,ts,jsx,tsx,mdx}`,
      `../../apps/*/components/**/*.{js,ts,jsx,tsx,mdx}`,
      `../../apps/*/app/**/*.{js,ts,jsx,tsx,mdx}`,
      `../../apps/*/src/**/*.{js,ts,jsx,tsx,mdx}`,
      "../../packages/*/src/**/*.{ts,tsx,html,stories.tsx}",
    ],
    theme: {
      fontWeight: {
        thin: "300",
        hairline: "300",
        extralight: "300",
        light: "300",
        normal: "400",
        medium: "500",
        semibold: "500",
        bold: "600",
        extrabold: "600",
        "extra-bold": "600",
      },
      extend: {
        colors: {
          border: "hsl(var(--border))",
          input: "hsl(var(--input))",
          ring: "hsl(var(--ring))",
          background: "hsl(var(--background))",
          foreground: "hsl(var(--foreground))",
          primary: {
            DEFAULT: "var(--primary)",
            foreground: "hsl(var(--primary-foreground))",
          },
          "primary-2": "var(--primary-2)",
          "primary-3": "var(--primary-3)",
          secondary: {
            DEFAULT: "var(--secondary)",
            foreground: "var(--secondary-foreground)",
          },
          "secondary-2": "var(--secondary-2)",
          "secondary-3": "var(--secondary-3)",
          tertiary: "var(--tertiary)",
          "tertiary-2": "var(--tertiary-2)",
          "tertiary-3": "var(--tertiary-3)",
          filler: "var(--filler)",
          "filler-2": "var(--filler-2)",
          "filler-3": "var(--filler-3)",
          "filler-txt": "var(--filler-txt)",
          "hover-1": "var(--hover-1)",
          "hover-2": "var(--hover-2)",
          destructive: {
            DEFAULT: "hsl(var(--destructive))",
            foreground: "hsl(var(--destructive-foreground))",
          },
          muted: {
            DEFAULT: "hsl(var(--muted))",
            foreground: "hsl(var(--muted-foreground))",
          },
          accent: {
            DEFAULT: "hsl(var(--accent))",
            foreground: "hsl(var(--accent-foreground))",
          },
          popover: {
            DEFAULT: "hsl(var(--popover))",
            foreground: "hsl(var(--popover-foreground))",
          },
          card: {
            DEFAULT: "hsl(var(--card))",
            foreground: "hsl(var(--card-foreground))",
          },
        },
        backgroundImage: {
          "gradient-radial": "radial-gradient(var(--tw-gradient-stops))",
          "gradient-conic":
            "conic-gradient(from 180deg at 50% 50%, var(--tw-gradient-stops))",
        },
        fontFamily: {
          primary: ["Geist", "sans-serif"],
        },
        keyframes: {
          flyEmoji: {
            "0%": {
              transform: "translateY(0) scale(1)",
              opacity: "0.7",
            },
            "100%": {
              transform: "translateY(-150px) scale(2.5)",
              opacity: "0",
            },
          },
        },
        animation: {
          flyEmoji: "flyEmoji 1.5s forwards",
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
  return config;
};
