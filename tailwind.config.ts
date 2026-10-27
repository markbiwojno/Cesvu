import type { Config } from 'tailwindcss';
import typography from '@tailwindcss/typography';

// NOTE: Tailwind CSS v4 no longer auto-loads this JS config file (it would
// require an explicit `@config` directive in app.css, which this project
// does not use). This file is kept only for editor/IntelliSense theme
// extension support; `content` and `darkMode` below are INERT at build
// time. The actual dark-mode strategy lives in src/app.css via
// `@custom-variant dark (&:where(.dark, .dark *));` — keep that in sync
// with the intent expressed here if it ever changes.
export default {
	darkMode: 'class',
	content: ['./src/**/*.{html,js,svelte,ts}'],
	theme: {
		extend: {
			colors: {
				surface: '#fafafa',
				brand: {
					50: '#f0f9ff',
					100: '#e0f2fe',
					200: '#bae6fd',
					300: '#7dd3fc',
					400: '#38bdf8',
					500: '#0ea5e9',
					600: '#0284c7',
					700: '#0369a1',
					800: '#075985',
					900: '#0c4a6e',
					950: '#082f49'
				}
			},
			fontFamily: {
				sans: ['Inter', 'system-ui', 'sans-serif'],
				mono: ['JetBrains Mono', 'Fira Code', 'monospace']
			}
		}
	},
	plugins: [typography]
} satisfies Config;
