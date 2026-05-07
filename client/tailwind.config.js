/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './index.html',
    './src/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        brand: {
          50:  '#fff7ed',
          100: '#fde8c8',
          500: '#e8670a',
          600: '#c85508',
          700: '#a34506',
        },
        secondary: {
          50:  '#edf3fb',
          100: '#d0e1f5',
          500: '#1b4f8c',
          600: '#1b4f8c',
          700: '#164282',
        },
      },
    },
  },
  plugins: [],
}
