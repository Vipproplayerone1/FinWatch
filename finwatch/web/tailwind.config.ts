import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        bg: {
          DEFAULT: "#0b0f17",
          panel: "#121826",
          ring: "#1f2937",
        },
        accent: {
          DEFAULT: "#22d3ee",
          warn: "#f59e0b",
          danger: "#ef4444",
          ok: "#10b981",
        },
      },
      fontFamily: {
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      keyframes: {
        flow: {
          "0%":   { offsetDistance: "0%",   opacity: "0" },
          "10%":  { opacity: "1" },
          "90%":  { opacity: "1" },
          "100%": { offsetDistance: "100%", opacity: "0" },
        },
        fadeIn: {
          "0%":   { opacity: "0", transform: "translateY(-6px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        slideIn: {
          "0%":   { opacity: "0", transform: "translateX(20px)" },
          "60%":  { opacity: "1", backgroundColor: "rgba(239,68,68,0.25)" },
          "100%": { opacity: "1", transform: "translateX(0)" },
        },
        pulseDot: {
          "0%, 100%": { opacity: "0.4", transform: "scale(0.9)" },
          "50%":      { opacity: "1",   transform: "scale(1.1)" },
        },
      },
      animation: {
        flow:     "flow 2.4s linear infinite",
        fadeIn:   "fadeIn 0.45s ease-out",
        slideIn:  "slideIn 0.55s ease-out",
        pulseDot: "pulseDot 1.6s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};

export default config;
