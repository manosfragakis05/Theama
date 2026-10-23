/** @type {import('tailwindcss').Config} */
export default {
  content: ["./*.{html,js}",
    "./pages/**/*.{html,js}",
    "./services/**/*.{html,js}",
    "./metadata/**/*.js",
    "./user-data/**/*.js",
    "./user-addons/**/*.js",
    "./streaming/**/*.{html,js}"],
  theme: {
    extend: {
      colors: {
        slate: {
          950: '#090b10',
          900: '#10131b',
          800: '#1c212d',
          700: '#303847',
          600: '#4b5669',
          500: '#7c899e',
          400: '#a0abbd',
          300: '#c4ccda',
        },
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'sans-serif'],
      },
    },
  },
  plugins: [],
}
