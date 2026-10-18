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
    extend: {},
  },
  plugins: [],
}
