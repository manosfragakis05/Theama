/** @type {import('tailwindcss').Config} */
export default {
  content: ["./*.{html,js}",
    "./services/**/*.{html,js}",
    "./user-data/**/*.js",
    "./user-addons/**/*.js",
    "./streaming/**/*.{html,js}"],
  theme: {
    extend: {},
  },
  plugins: [],
}
