/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Pure-black ink palette for the brutalist lime aesthetic.
        ink: {
          50: '#fafafa',
          100: '#e8e8e8',
          200: '#c8c8c8',
          300: '#a0a0a0',
          400: '#6b6b6b',
          500: '#4a4a4a',
          600: '#2e2e2e',
          700: '#1f1f1f',
          800: '#131313',
          900: '#0a0a0a',
          950: '#000000',
        },
        // Acid lime accent.
        accent: {
          400: '#D6FF66',
          500: '#C5FF3A',
          600: '#A8E020',
          700: '#86B515',
        },
      },
      fontFamily: {
        sans: ['"Inter"', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },
      boxShadow: {
        'glow-accent': '0 0 24px rgba(197, 255, 58, 0.45)',
        'glow-accent-lg': '0 0 40px rgba(197, 255, 58, 0.55)',
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
