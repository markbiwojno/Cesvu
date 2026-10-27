/**
 * templates.svelte.ts — Template registry store
 *
 * Loads and manages the 6 analysis templates.
 * All templates are free — no tier restrictions.
 */

import type { Template } from '$lib/utils/types.js';

// Static imports of all template JSON files
import generalJson from '$lib/templates/general.json';
import financialJson from '$lib/templates/financial.json';
import legalJson from '$lib/templates/legal.json';
import salesJson from '$lib/templates/sales.json';
import researchJson from '$lib/templates/research.json';
import executiveJson from '$lib/templates/executive.json';

// ============================================================
// Template Registry
// ============================================================

const ALL_TEMPLATES: Template[] = [
	generalJson as Template,
	financialJson as Template,
	legalJson as Template,
	salesJson as Template,
	researchJson as Template,
	executiveJson as Template
];

// ============================================================
// State
// ============================================================

let templates = $state<Template[]>(ALL_TEMPLATES);
let activeTemplateId = $state<string>('general');

// ============================================================
// Derived
// ============================================================

let activeTemplate = $derived(
	templates.find((t) => t.id === activeTemplateId) ?? templates[0]
);

// ============================================================
// Actions
// ============================================================

function setActiveTemplate(id: string) {
	if (templates.some((t) => t.id === id)) {
		activeTemplateId = id;
	}
}

function getTemplate(id: string): Template | undefined {
	return templates.find((t) => t.id === id);
}

// ============================================================
// Export
// ============================================================

export const templateStore = {
	get templates() { return templates; },
	get activeTemplateId() { return activeTemplateId; },
	get activeTemplate() { return activeTemplate; },
	setActiveTemplate,
	getTemplate
};
