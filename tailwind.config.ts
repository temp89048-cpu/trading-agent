import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}', './lib/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg0: 'var(--bg-0)',
        bg1: 'var(--bg-1)',
        bg2: 'var(--bg-2)',
        bg3: 'var(--bg-3)',
        line: 'var(--line)',
        amber: 'var(--amber)',
        amberDim: 'var(--amber-dim)',
        cyan: 'var(--cyan)',
        green: 'var(--green)',
        red: 'var(--red)',
        txt0: 'var(--txt-0)',
        txt1: 'var(--txt-1)',
        txt2: 'var(--txt-2)',
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'monospace'],
        sans: ['Inter', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
export default config;
