/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './src/app/**/*.{ts,tsx}',
    './src/components/**/*.{ts,tsx}',
    './src/hooks/**/*.{ts,tsx}',
    './src/store/**/*.{ts,tsx}',
    './src/lib/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        ignis: {
          orange:  '#E85D1A',
          blue:    '#378ADD',
          green:   '#1D9E75',
          red:     '#E24B4A',
          bg:      '#0A0A0F',
          card:    'rgba(255,255,255,0.05)',
          border:  'rgba(255,255,255,0.10)',
        },
      },
      fontFamily: {
        sans: [
          '-apple-system',
          'BlinkMacSystemFont',
          '"SF Pro Display"',
          '"SF Pro Text"',
          '"Helvetica Neue"',
          'Arial',
          'sans-serif',
        ],
      },
      borderRadius: {
        '2xl':  '16px',
        '3xl':  '24px',
        '4xl':  '32px',
      },
      backdropBlur: {
        glass: '20px',
      },
      boxShadow: {
        glass: '0 25px 80px rgba(0,0,0,0.55)',
        glow:  '0 0 24px rgba(232,93,26,0.25)',
      },
      keyframes: {
        'fade-in': {
          from: { opacity: '0', transform: 'translateY(6px)' },
          to:   { opacity: '1', transform: 'translateY(0)'   },
        },
        'slide-in': {
          from: { opacity: '0', transform: 'translateX(-10px)' },
          to:   { opacity: '1', transform: 'translateX(0)'     },
        },
        pulse: {
          '0%, 100%': { opacity: '1'   },
          '50%':      { opacity: '0.4' },
        },
      },
      animation: {
        'fade-in':  'fade-in 0.3s ease both',
        'slide-in': 'slide-in 0.25s ease both',
        pulse:      'pulse 2s cubic-bezier(0.4,0,0.6,1) infinite',
      },
    },
  },
  plugins: [],
};