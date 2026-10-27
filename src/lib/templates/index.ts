/**
 * src/lib/templates/index.ts — Template registry
 *
 * Imports all 6 template JSON files and exports them as a typed array.
 * Use getTemplate(id) or getTemplatesForFileType(fileType) to query.
 */

import type { Template } from '$lib/types.js';

import general from './general.json';
import financial from './financial.json';
import legal from './legal.json';
import sales from './sales.json';
import research from './research.json';
import executive from './executive.json';

// Cast JSON imports to Template — JSON structure matches the interface
export const TEMPLATES: Template[] = [
	general as unknown as Template,
	financial as unknown as Template,
	legal as unknown as Template,
	sales as unknown as Template,
	research as unknown as Template,
	executive as unknown as Template
];

/**
 * Get a template by its ID.
 * Returns undefined if not found.
 */
export function getTemplate(id: string): Template | undefined {
	return TEMPLATES.find((t) => t.id === id);
}

/**
 * Get all templates that support a given file type.
 * Uses the `fileTypes` array on each template.
 * Falls back to `bestFor` for backward compatibility.
 */
export function getTemplatesForFileType(fileType: string): Template[] {
	return TEMPLATES.filter((t) => {
		const types = (t as unknown as { fileTypes?: string[]; bestFor?: string[] }).fileTypes
			?? (t as unknown as { bestFor?: string[] }).bestFor
			?? [];
		return types.includes(fileType);
	});
}
