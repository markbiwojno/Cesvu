import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import sveltePlugin from 'eslint-plugin-svelte';
import svelteParser from 'svelte-eslint-parser';
import globals from 'globals';

// ─────────────────────────────────────────────
// TS PLUGIN (SCOPED ONLY TO TS BLOCK)
// ─────────────────────────────────────────────
const tsPlugin = tseslint.plugin;

// ─────────────────────────────────────────────
// IGNORE EVERYTHING NOT APP CODE
// ─────────────────────────────────────────────
const ignores = {
	ignores: [
		'node_modules/**',
		'.svelte-kit/**',
		'dist/**',
		'build/**',
		'coverage/**',
		'scripts/**',
		// Third-party / vendored bundles — never our code to lint.
		'static/**',
		'*.config.*',
		'**/*.test.*',
		'**/__tests__/**',
		// Legacy/audited crypto files intentionally excluded from the project
		// type-check (see tsconfig.json "exclude"). Mirror that here so
		// projectService doesn't try to load them.
		'src/lib/utils/crypto.ts',
		'src/lib/crypto/crypto.ts'
	]
};

// ─────────────────────────────────────────────
// SHARED BASE LANGUAGE SETTINGS
// ─────────────────────────────────────────────
const sharedLanguage = {
	languageOptions: {
		ecmaVersion: 2024,
		sourceType: 'module',
		globals: {
			...globals.browser,
			...globals.worker,
			...globals.serviceworker,
			// Node globals: some modules/workers reference process / global, and
			// the .mjs harnesses run in Node. Without this they trip no-undef.
			...globals.node
		}
	}
};

// ─────────────────────────────────────────────
// CORE RULES (SAFE ACROSS ALL FILES)
// ─────────────────────────────────────────────
const baseRules = {
	'prefer-const': 'off',
	'consistent-return': 'off',
	'no-empty': ['error', { allowEmptyCatch: true }],
	'no-self-assign': 'off',
	'no-param-reassign': ['error', { props: false }],
	'no-void': 'off',
	'no-console': 'off',

	// 🔥 CRITICAL: prevent ESLint core crash in Svelte AST
	'no-unused-vars': 'off'
};

// ─────────────────────────────────────────────
// TS RULES (NON-TYPE-AWARE SAFE LAYER)
// ─────────────────────────────────────────────
const tsRules = {
	...baseRules,

	'@typescript-eslint/no-unused-vars': [
		'error',
		{
			argsIgnorePattern: '^_',
			varsIgnorePattern: '^_',
			caughtErrorsIgnorePattern: '^_',
			ignoreRestSiblings: true
		}
	]
};

// ─────────────────────────────────────────────
// TS TYPE-AWARE RULES (ONLY TS FILES)
// ─────────────────────────────────────────────
const tsTypeAwareRules = {
	...tsRules,

	'@typescript-eslint/consistent-type-imports': [
		'error',
		{ prefer: 'type-imports' }
	],

	'@typescript-eslint/no-explicit-any': 'warn',
	'@typescript-eslint/no-non-null-assertion': 'warn',

	eqeqeq: ['error', 'always', { null: 'ignore' }]
};

// ─────────────────────────────────────────────
// JAVASCRIPT FILES ONLY
// ─────────────────────────────────────────────
const jsFiles = {
	files: ['src/**/*.{js,mjs,cjs}'],
	...sharedLanguage,
	rules: baseRules
};

// ─────────────────────────────────────────────
// TYPESCRIPT FILES ONLY (TYPE-AWARE ENABLED)
// Excludes .svelte.ts — those are handled by the Svelte block so runes
// ($state/$derived/$effect) are understood by the Svelte parser.
// ─────────────────────────────────────────────
const tsFiles = {
	files: ['src/**/*.{ts,tsx}'],
	ignores: ['src/**/*.svelte.ts'],
	...sharedLanguage,

	plugins: {
		'@typescript-eslint': tsPlugin
	},

	languageOptions: {
		parser: tseslint.parser,
		parserOptions: {
			projectService: true,
			tsconfigRootDir: import.meta.dirname
		}
	},

	rules: tsTypeAwareRules
};

// ─────────────────────────────────────────────
// SVELTE FILES (ISOLATED SAFELY)
// Matches .svelte AND .svelte.{ts,js} so runes-mode rune sources
// ($state/$derived in stores) are parsed with the Svelte parser.
// Declares the @typescript-eslint plugin so eslint-disable comments
// referencing @typescript-eslint/* rules resolve.
// ─────────────────────────────────────────────
const svelteFiles = {
	files: ['src/**/*.svelte', 'src/**/*.svelte.{ts,js}'],
	...sharedLanguage,

	plugins: {
		'@typescript-eslint': tsPlugin
	},

	languageOptions: {
		parser: svelteParser,
		parserOptions: {
			parser: tseslint.parser,
			svelteFeatures: { runes: true },
			extraFileExtensions: ['.svelte']
		},
		globals: {
			...globals.browser,
			...globals.worker
		}
	},

	rules: {
		'no-unused-vars': 'off',

		// TypeScript handles undefined-identifier checking. Core no-undef has
		// no type info inside the Svelte <script lang="ts">, so it false-positives
		// on type-only names (e.g. DOM types like `EventListener`). Off per the
		// typescript-eslint recommendation for TS-parsed files.
		'no-undef': 'off',

		'svelte/no-reactive-reassign': 'error',

		'svelte/no-reactive-functions': 'error',
		'svelte/valid-compile': 'warn'
	}
};

// ─────────────────────────────────────────────
// EXPORT (MINIMAL + FAST + CI SAFE)
// ─────────────────────────────────────────────
export default [
	ignores,

	js.configs.recommended,
	...sveltePlugin.configs['flat/recommended'],

	sharedLanguage,

	jsFiles,
	tsFiles,
	svelteFiles
];
