/**
 * analysis.ts — LLM interaction via Transformers.js (browser-side)
 *
 * Runs entirely in the browser using WebGPU acceleration.
 * ONNX models are hosted on ai.cesvu.com (Cloudflare R2).
 * The LLM receives only the compressed summary — never raw data.
 * The LLM outputs structured JSON — never HTML/CSS/JS.
 */

import type { Template, AnalysisResult, LLMResponse, ModelTier } from './types.js';

// ============================================================
// Model Registry
// ============================================================

export const MODEL_CONFIGS = {
	default: {
		id: 'default' as ModelTier,
		name: 'Default (1.5B)',
		paramCount: '1.5B',
		quantization: 'q4',
		modelUrl: 'https://ai.cesvu.com/qwen2.5-1.5b/v1',
		requiredTier: 'free' as const,
		monthlyLimit: null
	},
	advanced: {
		id: 'advanced' as ModelTier,
		name: 'Advanced (3B)',
		paramCount: '3B',
		quantization: 'q4',
		modelUrl: 'https://ai.cesvu.com/qwen2.5-3b/v1',
		requiredTier: 'pro' as const,
		monthlyLimit: null
	},
	expert: {
		id: 'expert' as ModelTier,
		name: 'Expert (7B)',
		paramCount: '7B',
		quantization: 'q4',
		modelUrl: 'https://ai.cesvu.com/qwen2.5-7b/v1',
		requiredTier: 'pro' as const,
		monthlyLimit: 50
	}
} as const;

// ============================================================
// Prompt Construction
// ============================================================

/**
 * Build the full prompt for LLM analysis.
 * System prompt from template + compressed data summary.
 */
export function buildPrompt(compressed: string, template: Template): string {
	return `${template.systemPrompt}

=== DATA SUMMARY ===
${compressed}

=== INSTRUCTIONS ===
Analyze the data summary above and respond with a JSON object.
The JSON must have these section IDs as keys: ${template.sections.map((s) => s.id).join(', ')}.
Each value should be the analysis content for that section.
For sections of type "insights", "anomalies", or "recommendations", provide an array of strings.
For sections of type "summary" or "markdown", provide a string.
For sections of type "key_metrics", provide an object with metric names as keys and values as strings.
Do NOT generate HTML, CSS, or JavaScript. Output only valid JSON.`;
}

/**
 * Build a chat prompt for the workspace chat pane.
 */
export function buildChatPrompt(
	compressed: string,
	template: Template,
	selectionText: string | null,
	selectionContext: string | null,
	userMessage: string
): string {
	const parts: string[] = [template.systemPrompt, ''];

	parts.push('=== DOCUMENT CONTEXT ===');
	parts.push(compressed);
	parts.push('');

	if (selectionText) {
		parts.push('=== SELECTED TEXT ===');
		parts.push('The user has selected the following text from the document:');
		parts.push('---');
		parts.push(selectionText);
		parts.push('---');
		if (selectionContext) {
			parts.push('Surrounding context:');
			parts.push(selectionContext);
		}
		parts.push('');
	}

	parts.push('=== USER MESSAGE ===');
	parts.push(userMessage);
	parts.push('');

	parts.push('=== RESPONSE FORMAT ===');
	parts.push(
		'Respond with a JSON object: { "response": "markdown text", "insights": [...] }'
	);
	parts.push(
		'Each insight: { "type": "explanation|anomaly|suggestion|summary|rewrite|correlation|trend|outlier|segment", "target": { "mode": "document", "range": { "start": N, "end": N } }, "content": "...", "severity": "info|warning|critical" }'
	);
	parts.push('If no insights, use "insights": []');
	parts.push('Do NOT generate HTML, CSS, or JavaScript.');

	return parts.join('\n');
}

// ============================================================
// LLM Runner
// ============================================================

let pipeline: unknown = null;
let currentModelUrl: string | null = null;

/**
 * Load the Transformers.js pipeline (lazy, cached).
 * Downloads model from ai.cesvu.com on first call.
 * Subsequent calls use browser cache.
 */
async function getOrLoadPipeline(
	modelTier: ModelTier = 'default',
	onProgress?: (progress: number, stage: string) => void
): Promise<unknown> {
	const config = MODEL_CONFIGS[modelTier];

	if (pipeline && currentModelUrl === config.modelUrl) {
		return pipeline;
	}

	const { pipeline: createPipeline, env } = await import('@huggingface/transformers');

	// Point to our R2 bucket — never use Hugging Face CDN directly
	env.remoteHost = config.modelUrl;
	env.allowRemoteModels = true;
	env.useBrowserCache = true;

	onProgress?.(0, 'Loading model...');

	pipeline = await createPipeline('text-generation', config.modelUrl, {
		dtype: 'q4',
		device: 'webgpu',
		progress_callback: (info: { progress?: number; status?: string }) => {
			if (info.progress !== undefined) {
				onProgress?.(info.progress, info.status ?? 'Downloading...');
			}
		}
	});

	currentModelUrl = config.modelUrl;
	onProgress?.(100, 'Model ready');

	return pipeline;
}

/**
 * Run full document analysis.
 * Returns structured AnalysisResult with section content.
 */
export async function runAnalysis(
	compressed: string,
	template: Template,
	modelTier: ModelTier = 'default',
	onProgress?: (progress: number, stage: string) => void
): Promise<AnalysisResult> {
	const prompt = buildPrompt(compressed, template);

	onProgress?.(0, 'Loading model...');
	const pipe = await getOrLoadPipeline(modelTier, onProgress);

	onProgress?.(90, 'Analyzing...');

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const output = await (pipe as any)(prompt, {
		max_new_tokens: 1024,
		temperature: 0.1,
		do_sample: false,
		return_full_text: false
	});

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const rawOutput: string = (output as any)[0]?.generated_text ?? '';

	onProgress?.(95, 'Parsing response...');

	// Extract JSON from response
	const sections = parseAnalysisJSON(rawOutput, template);

	onProgress?.(100, 'Done');

	return {
		templateId: template.id,
		sections,
		rawOutput,
		compressedInput: compressed,
		createdAt: new Date().toISOString()
	};
}

/**
 * Run a chat message through the LLM.
 * Returns structured LLMResponse with chat text and insights.
 */
export async function runChat(
	compressed: string,
	template: Template,
	selectionText: string | null,
	selectionContext: string | null,
	userMessage: string,
	modelTier: ModelTier = 'default',
	onProgress?: (progress: number, stage: string) => void
): Promise<LLMResponse> {
	const prompt = buildChatPrompt(
		compressed,
		template,
		selectionText,
		selectionContext,
		userMessage
	);

	const pipe = await getOrLoadPipeline(modelTier, onProgress);

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const output = await (pipe as any)(prompt, {
		max_new_tokens: 512,
		temperature: 0.3,
		do_sample: true,
		return_full_text: false
	});

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const rawOutput: string = (output as any)[0]?.generated_text ?? '';

	return parseChatJSON(rawOutput);
}

// ============================================================
// JSON Parsing
// ============================================================

/**
 * Extract and parse JSON from LLM output.
 * LLMs sometimes wrap JSON in markdown code blocks.
 */
function extractJSON(text: string): unknown {
	// Try direct parse first
	try {
		return JSON.parse(text.trim());
	} catch {
		// Try to extract from markdown code block
		const match = text.match(/```(?:json)?\s*([\s\S]*?)```/);
		if (match) {
			try {
				return JSON.parse(match[1].trim());
			} catch {
				// fall through
			}
		}

		// Try to find first { ... } block
		const start = text.indexOf('{');
		const end = text.lastIndexOf('}');
		if (start !== -1 && end !== -1 && end > start) {
			try {
				return JSON.parse(text.slice(start, end + 1));
			} catch {
				// fall through
			}
		}

		return null;
	}
}

function parseAnalysisJSON(
	rawOutput: string,
	template: Template
): Record<string, unknown> {
	const parsed = extractJSON(rawOutput);

	if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
		return parsed as Record<string, unknown>;
	}

	// Fallback: create empty sections
	const fallback: Record<string, unknown> = {};
	for (const section of template.sections) {
		fallback[section.id] = section.type === 'insights' || section.type === 'anomalies'
			? ['Analysis could not be parsed. Please try again.']
			: 'Analysis could not be parsed. Please try again.';
	}
	return fallback;
}

function parseChatJSON(rawOutput: string): LLMResponse {
	const parsed = extractJSON(rawOutput);

	if (
		parsed &&
		typeof parsed === 'object' &&
		!Array.isArray(parsed) &&
		'response' in (parsed as object)
	) {
		return parsed as LLMResponse;
	}

	// Fallback: treat entire output as response text
	return {
		response: rawOutput || 'I was unable to generate a response. Please try again.',
		insights: []
	};
}

// ============================================================
// Model availability check
// ============================================================

/**
 * Check if WebGPU is available in this browser.
 */
export function isWebGPUAvailable(): boolean {
	return 'gpu' in navigator;
}

/**
 * Unload the current model to free GPU memory.
 */
export function unloadModel(): void {
	pipeline = null;
	currentModelUrl = null;
}
