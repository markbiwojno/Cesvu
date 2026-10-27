/**
 * src/lib/llm/index.ts — Re-export LLM inference utilities
 */
export {
	loadModel,
	runInference,
	getCachedModel,
	isWebGPUAvailable,
	type ModelLoadProgress,
	type InferenceResult,
	type LLMPipeline
} from './inference.js';
