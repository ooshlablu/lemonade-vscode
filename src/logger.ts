/**
 * Minimal logger interface used by the Lemonade VS Code extension.
 * In production this is backed by a VS Code OutputChannel; in tests
 * or outside VS Code a fallback that writes to console.error is used.
 */
export interface Logger {
	appendLine(message: string): void;
	show(): void;
	hide(): void;
	dispose(): void;
}

/**
 * Create a fallback logger that writes to console.error.
 * Used when no VS Code OutputChannel is available (e.g., tests).
 */
export function createFallbackLogger(): Logger {
	const formatTimestamp = (): string => {
		const now = new Date();
		const h = String(now.getHours()).padStart(2, '0');
		const m = String(now.getMinutes()).padStart(2, '0');
		const s = String(now.getSeconds()).padStart(2, '0');
		const ms = String(now.getMilliseconds()).padStart(3, '0');
		return `${h}:${m}:${s}.${ms}`;
	};
	return {
		appendLine: (msg: string) => console.error(`[Lemonade] [${formatTimestamp()}] ${msg}`),
		show: () => { },
		hide: () => { },
		dispose: () => { },
	};
}
