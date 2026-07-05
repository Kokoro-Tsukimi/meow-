/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        latte: 'var(--latte)',
        'paw-pink': 'var(--paw-pink)',
        parchment: 'var(--parchment)',
        cream: 'var(--cream)',
        mocha: 'var(--mocha)',
        foam: 'var(--foam)',
      }
    },
  },
  plugins: [],
}
