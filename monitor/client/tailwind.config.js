/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{vue,js}'],
  theme: {
    extend: {
      colors: {
        base: { bg: '#0f1115', card: '#1a1d24', line: '#2a2f3a' }
      }
    }
  },
  plugins: []
}
