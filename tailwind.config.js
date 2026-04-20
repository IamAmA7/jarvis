/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Muted ink palette — minimal, easy on the eyes for long listening sessions.
        ink: {
          50:  '#f6f7f9',
          100: '#eceff3',
          200: '#d3d9e2',
          300: '#a9b3c2',
          400: '#7a8699',
          500: '#54607a',
          600: '#3b4559',
          700: '#29324a',
          800: '#1a2138',
          900: '#10162a',
          950: '#080b18',
        },
        accent: {
          500: '#7c5cff',
          600: '#6a49ef',
        },
      },
      fontFamily: {
        sans: ['"Inter"', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },
      keyframes: {
        pulseDot: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.35' },
        },
      },
      animation: {
        pulseDot: 'pulseDot 1.2s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};
