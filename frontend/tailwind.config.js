/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,jsx}",
  ],
  theme: {
    extend: {
      colors: {
        kalshi: {
          bg: '#F8F6F1',
          surface: '#FFFFFF',
          text: '#1F1F1F',
          accent: '#FF6B3D',
          success: '#2DD4BF',
          danger: '#FF6B6B',
          border: '#E5E1DB',
        }
      },
      fontFamily: {
        sans: ['Inter', 'sans-serif'],  // Changed from 'kalshi' to 'sans'
      },
    },
  },
  plugins: [],
}

