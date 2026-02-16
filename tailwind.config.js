/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        // Warm cream surface palette
        cream: {
          50: "#fdfcfa",
          100: "#faf8f5",
          200: "#f2efe9",
          300: "#e8e4db",
          400: "#d5cfc3",
          500: "#b8b0a2",
          600: "#8f877a",
          700: "#6b6459",
          800: "#4a453d",
          900: "#2d2a25",
          950: "#1a1815",
        },
        // Sage green accents
        sage: {
          50: "#f0f5f1",
          100: "#dce8de",
          200: "#bbd4bf",
          300: "#8fb396",
          400: "#6b8f71",
          500: "#4a6e50",
          600: "#3a5840",
          700: "#2f4633",
          800: "#273929",
          900: "#1f2f22",
        },
        // Legacy carbon scale (for gradual migration)
        carbon: {
          50: "#fdfcfa",
          100: "#f7f5f0",
          200: "#ede9e0",
          300: "#e8e4db",
          400: "#b8b0a2",
          500: "#8f877a",
          600: "#6b6459",
          700: "#4a453d",
          800: "#2d2a25",
          900: "#1a1815",
          950: "#0f0e0c",
        },
        // Sidebar dark (keep sidebar dark for contrast)
        sidebar: {
          DEFAULT: "#1e2328",
          hover: "#2a2f35",
          border: "#2f353c",
        },
        // Status accent colors (slightly muted for light theme)
        accent: {
          green: "#3d9970",
          blue: "#4a8fe7",
          amber: "#d4940a",
          red: "#d9534f",
          purple: "#8b5cf6",
          pink: "#d946a8",
        },
      },
      fontFamily: {
        mono: ['"JetBrains Mono"', "monospace"],
        sans: ['"DM Sans"', "system-ui", "sans-serif"],
      },
      animation: {
        "pulse-slow": "pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite",
        "fade-in": "fadeIn 0.5s ease-out forwards",
        "slide-up": "slideUp 0.4s ease-out forwards",
      },
      keyframes: {
        fadeIn: {
          "0%": { opacity: "0" },
          "100%": { opacity: "1" },
        },
        slideUp: {
          "0%": { opacity: "0", transform: "translateY(10px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
      },
    },
  },
  plugins: [],
};
