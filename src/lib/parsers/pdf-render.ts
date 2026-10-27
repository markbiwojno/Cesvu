/**
 * src/lib/parsers/pdf-render.ts — PDF visual rendering helpers (browser-only)
 *
 * This is the DISPLAY pipeline, entirely separate from the AI-text pipeline in
 * pdf.ts. It uses pdfjs-dist directly (a build-time dependency, bundled by Vite)
 * to:
 *   - render each page to a <canvas> (pixel-perfect, exactly as the PDF looks)
 *   - lay an invisible, selectable text layer on top via TextLayerBuilder so the
 *     user keeps native selection, copy, and Ctrl+F search
 *
 * Import notes (per pdf.js v4):
 *   - The worker entry is `pdfjs-dist/build/pdf.worker.min.mjs`. We wire it via
 *     `GlobalWorkerOptions.workerSrc` using a Vite `?url` import.
 *   - TextLayerBuilder lives in `pdfjs-dist/web/pdf_viewer.mjs`. Its CSS
 *     (`pdfjs-dist/web/pdf_viewer.css`) must be imported for correct positioning;
 *     we import it once here.
 *
 * Everything here is dynamically imported so SSR never touches pdf.js.
 */

// Loaded lazily so the heavy pdf.js bundle is only fetched in the browser when a
// PDF is actually displayed.
type PdfjsModule = typeof import('pdfjs-dist');
type PdfDocument = Awaited<ReturnType<PdfjsModule['getDocument']>['promise']>;
type PdfPage = Awaited<ReturnType<PdfDocument['getPage']>>;

let pdfjsPromise: Promise<PdfjsModule> | null = null;
let textLayerCssInjected = false;

/** Lazy-load pdfjs-dist and wire up the worker exactly once. */
async function loadPdfjs(): Promise<PdfjsModule> {
	if (!pdfjsPromise) {
		pdfjsPromise = (async () => {
			const pdfjs = await import('pdfjs-dist');
			// Instantiate the worker directly via Vite's native Worker support.
			// Using `workerPort` (rather than a `workerSrc` string) is the most
			// robust path with Vite + pdf.js v4: it works identically in dev and
			// in the production bundle, and sidesteps the "Invalid workerSrc type"
			// error that occurs when a `?url` import resolves to a non-string.
			try {
				const worker = new Worker(
					new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url),
					{ type: 'module' }
				);
				(pdfjs.GlobalWorkerOptions as { workerPort: Worker | null }).workerPort = worker;
			} catch {
				// Fallback: resolve a URL string for workerSrc. Coerce to string so
				// pdf.js never receives a module-namespace object.
				const mod = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
				pdfjs.GlobalWorkerOptions.workerSrc = String(mod.default);
			}
			return pdfjs;
		})();
	}
	return pdfjsPromise;
}


/**
 * Ensure the pdf.js text-layer CSS is present.
 *
 * We resolve the stylesheet's URL via Vite's `?url` import and inject it as a
 * `<link rel="stylesheet">`. This is the robust path in BOTH dev and prod:
 *
 *   - `?url` yields a plain string URL — never a JS module — so the browser is
 *     never asked to evaluate CSS as a module script.
 *   - A `<link>` element expects a `text/css` response by design, so the dev
 *     server returning `Content-Type: text/css` is exactly correct here.
 *
 * The previous `?inline` import made Vite hand the browser a `text/css`
 * response where it expected a JS module, tripping strict MIME checking
 * ("Failed to load module script… MIME type of text/css"). Using `?url` + a
 * `<link>` tag avoids that entirely. A fetch()+`<style>` fallback covers any
 * environment where the `?url` import path changes across pdf.js versions.
 */
async function ensureTextLayerCss(): Promise<void> {
	if (textLayerCssInjected || typeof document === 'undefined') return;
	textLayerCssInjected = true;
	try {
		const href = (await import('pdfjs-dist/web/pdf_viewer.css?url')).default as string;
		const link = document.createElement('link');
		link.rel = 'stylesheet';
		link.href = href;
		link.setAttribute('data-pdfjs-textlayer', '');
		document.head.appendChild(link);
	} catch {
		// Fallback: fetch the stylesheet text and inline it in a <style> tag. This
		// also dodges module-script MIME checking (it's a plain network fetch).
		try {
			const href = (await import('pdfjs-dist/web/pdf_viewer.css?url')).default as string;
			const css = await (await fetch(href)).text();
			const style = document.createElement('style');
			style.setAttribute('data-pdfjs-textlayer', '');
			style.textContent = css;
			document.head.appendChild(style);
		} catch {
			// If the path changes across versions, the minimal positioning rules in
			// app.css act as a backstop so the text layer still aligns acceptably.
		}
	}
}


export interface LoadedPdf {
	doc: PdfDocument;
	numPages: number;
}

/** Open a PDF from raw bytes for rendering. Caller owns the returned doc. */
export async function loadPdfForRender(bytes: ArrayBuffer): Promise<LoadedPdf> {
	const pdfjs = await loadPdfjs();
	await ensureTextLayerCss();
	// pdf.js may detach the buffer — give it a copy.
	const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes.slice(0)) }).promise;
	return { doc, numPages: doc.numPages };
}

export interface RenderedPage {
	/** Natural CSS pixel width at the chosen scale */
	width: number;
	height: number;
	/** Cleanup function — cancels in-flight render and clears the text layer */
	destroy: () => void;
}

/**
 * Render a single page into the provided container:
 *   container
 *     ├── <canvas>            (visual)
 *     └── <div class="textLayer">  (invisible, selectable — positioned by pdf.js)
 *
 * Both are absolutely positioned at the same origin. The text layer uses pdf.js's
 * stylesheet (transparent text, real glyph boxes) so selection lines up with the
 * rendered pixels.
 */
export async function renderPageInto(
	page: PdfPage,
	container: HTMLElement,
	scale: number
): Promise<RenderedPage> {
	const pdfjs = await loadPdfjs();
	const viewport = page.getViewport({ scale });

	// Reset container.
	container.replaceChildren();
	container.style.position = 'relative';
	container.style.width = `${viewport.width}px`;
	container.style.height = `${viewport.height}px`;

	// --- Canvas (visual) ---
	const canvas = document.createElement('canvas');
	const ctx = canvas.getContext('2d');
	const outputScale = window.devicePixelRatio || 1;
	canvas.width = Math.floor(viewport.width * outputScale);
	canvas.height = Math.floor(viewport.height * outputScale);
	canvas.style.width = `${viewport.width}px`;
	canvas.style.height = `${viewport.height}px`;
	canvas.style.position = 'absolute';
	canvas.style.top = '0';
	canvas.style.left = '0';
	container.appendChild(canvas);

	const renderTask = page.render({
		canvas,
		canvasContext: ctx as CanvasRenderingContext2D,
		viewport,
		transform: outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : undefined
	});

	// --- Text layer (invisible, selectable) ---
	const textLayerDiv = document.createElement('div');
	textLayerDiv.className = 'textLayer';
	textLayerDiv.style.position = 'absolute';
	textLayerDiv.style.top = '0';
	textLayerDiv.style.left = '0';
	textLayerDiv.style.width = `${viewport.width}px`;
	textLayerDiv.style.height = `${viewport.height}px`;
	// pdf.js v4 uses a CSS var for scale-aware glyph sizing.
	textLayerDiv.style.setProperty('--scale-factor', String(scale));
	container.appendChild(textLayerDiv);

	let textLayer: { cancel?: () => void } | null = null;
	try {
		await renderTask.promise;
		const textContent = await page.getTextContent();
		// pdf.js v4 exposes a `TextLayer` class; older builds used `renderTextLayer`.
		const TextLayerCtor = (pdfjs as unknown as { TextLayer?: new (opts: unknown) => {
			render: () => Promise<void>;
			cancel?: () => void;
		} }).TextLayer;
		if (TextLayerCtor) {
			const tl = new TextLayerCtor({ textContentSource: textContent, container: textLayerDiv, viewport });
			textLayer = tl;
			await tl.render();
		} else {
			const renderTextLayer = (pdfjs as unknown as {
				renderTextLayer?: (opts: unknown) => { promise: Promise<void>; cancel?: () => void };
			}).renderTextLayer;
			if (renderTextLayer) {
				const task = renderTextLayer({
					textContentSource: textContent,
					container: textLayerDiv,
					viewport
				});
				textLayer = task;
				await task.promise;
			}
		}
	} catch {
		// Render cancelled (e.g. page scrolled out of view) — ignore.
	}

	return {
		width: viewport.width,
		height: viewport.height,
		destroy: () => {
			try {
				renderTask.cancel();
			} catch {
				/* already done */
			}
			try {
				textLayer?.cancel?.();
			} catch {
				/* noop */
			}
			container.replaceChildren();
		}
	};
}
