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
          gray: {
            50: "#FFFFFF",
            100: "#F7F8FA",
            200: "#E7EAF0",
            300: "#C9CEDB",
            400: "#8991A3",
            500: "#12161F",
          },
          purple: {
            50: "#F5F3FF",
            100: "#EDE9FE",
            200: "#DDD6FE",
            300: "#C4B5FD",
            400: "#A78BFA",
            500: "#8B5CF6",
            600: "#7C3AED",
            700: "#6D28D9",
            800: "#5B21B6",
            900: "#4C1D95",
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
        backgroundImage: {
          "gradient-radial": "radial-gradient(var(--tw-gradient-stops))",
          "gradient-conic":
            "conic-gradient(from 180deg at 50% 50%, var(--tw-gradient-stops))",
          "gradient-primary": "linear-gradient(180deg, var(--primary) 0%, var(--primary-2) 100%)",
        },
        fontFamily: {
          primary: ['var(--font-geist-sans)', 'sans-serif'],
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
