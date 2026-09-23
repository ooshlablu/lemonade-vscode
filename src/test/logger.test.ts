import * as assert from "assert";
import * as vscode from "vscode";
import { LemonadeChatModelProvider } from "../provider";
import { createFallbackLogger } from "../logger";
import type { Logger } from "../logger";
import { convertTools, validateRequest } from "../utils";

/** In-memory Logger that records every line it receives. */
class CaptureLogger implements Logger {
	lines: string[] = [];
	appendLine(message: string): void {
		this.lines.push(message);
	}
	show(): void {}
	hide(): void {}
	dispose(): void {}
}

function makeSecretStorage(): vscode.SecretStorage {
	return {
		get: async () => undefined,
		store: async () => {},
		delete: async () => {},
		onDidChange: (_listener: unknown) => ({ dispose() {} }),
	} as unknown as vscode.SecretStorage;
}

function makeModel(): vscode.LanguageModelChatInformation {
	return {
		id: "m",
		name: "m",
		family: "lemonade",
		version: "1.0.0",
		maxInputTokens: 1000,
		maxOutputTokens: 1000,
		capabilities: {},
	} as unknown as vscode.LanguageModelChatInformation;
}

function makeUserMessage(text: string): vscode.LanguageModelChatMessage {
	return {
		role: vscode.LanguageModelChatMessageRole.User,
		content: [new vscode.LanguageModelTextPart(text)],
		name: undefined,
	};
}

/**
 * Stub console.error for the duration of `fn`.
 * The VS Code extension host defines console.error as a getter-only accessor,
 * so a plain assignment is silently ignored; redefine the property instead.
 */
function withConsoleErrorStub<T>(capture: unknown[], fn: () => T): T {
	const original = Object.getOwnPropertyDescriptor(console, "error");
	Object.defineProperty(console, "error", { value: (...args: unknown[]) => { capture.push(args); }, configurable: true, writable: true });
	try {
		return fn();
	} finally {
		Object.defineProperty(console, "error", original!);
	}
}

/** Async variant: awaits `fn` before restoring console.error. */
async function withConsoleErrorStubAsync<T>(capture: unknown[], fn: () => Promise<T>): Promise<T> {
	const original = Object.getOwnPropertyDescriptor(console, "error");
	Object.defineProperty(console, "error", { value: (...args: unknown[]) => { capture.push(args); }, configurable: true, writable: true });
	try {
		return await fn();
	} finally {
		Object.defineProperty(console, "error", original!);
	}
}

/** Build a mocked fetch that answers /models and streams a minimal SSE chat response. */
function mockChatFetch(): unknown {
	return async (input: RequestInfo | URL) => {
		const url = String(input);
		if (url.endsWith("/models")) {
			return {
				ok: true,
				json: async () => ({ object: "list", data: [] }),
			};
		}
		const encoder = new TextEncoder();
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode("data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\n"));
				controller.enqueue(encoder.encode("data: [DONE]\n\n"));
				controller.close();
			},
		});
		return {
			ok: true,
			status: 200,
			statusText: "OK",
			body,
			text: async () => "",
		};
	};
}

suite("logger", () => {
	suite("createFallbackLogger", () => {
		test("appendLine writes '[Lemonade] [HH:MM:SS.mmm] <msg>' to console.error", () => {
			const logger = createFallbackLogger();
			const captured: unknown[] = [];
			withConsoleErrorStub(captured, () => {
				logger.appendLine("hello world");
			});
			assert.equal(captured.length, 1);
			const [only] = captured[0] as [string];
			assert.ok(only.startsWith("[Lemonade] ["), `unexpected prefix: ${only}`);
			assert.ok(only.endsWith("hello world"), `unexpected suffix: ${only}`);
			// Timestamp format: [HH:MM:SS.mmm]
			assert.match(only, /^\[Lemonade\] \[\d{2}:\d{2}:\d{2}\.\d{3}\] hello world$/);
		});

		test("show/hide/dispose are safe no-ops", () => {
			const logger = createFallbackLogger();
			assert.doesNotThrow(() => {
				logger.show();
				logger.hide();
				logger.dispose();
			});
		});
	});

	suite("provider logging", () => {
		test("falls back to console logger when no logger is provided", async () => {
			const provider = new LemonadeChatModelProvider(makeSecretStorage(), "test/test");
			const captured: unknown[] = [];
			await withConsoleErrorStubAsync(captured, async () => {
				// Pass a VALID message so the failure happens at the HTTP request
				// stage (no server running). An empty message list would fail
				// validation, which is not part of the logged request lifecycle.
				try {
					await provider.provideLanguageModelChatResponse(
						makeModel(),
						[makeUserMessage("hello")],
						{} as unknown as vscode.LanguageModelChatRequestHandleOptions,
						{ report: () => {} },
						new vscode.CancellationTokenSource().token
					);
				} catch {
					// Expected: no server running -> request fails
				}
			});
			const flat = captured.map((a) => String((a as unknown[])[0])).join("\n");
			assert.ok(flat.includes("[Lemonade]"), "fallback logger should prefix lines with [Lemonade]");
			assert.ok(flat.includes("[ERROR] Chat request failed"), "failure should be logged");
		});

		test("logs request lifecycle to the injected logger", async () => {
			const logger = new CaptureLogger();
			const provider = new LemonadeChatModelProvider(makeSecretStorage(), "test/test", logger);
			const originalFetch = global.fetch;
			try {
				(global as unknown as Record<string, unknown>).fetch = mockChatFetch();
				await provider.provideLanguageModelChatResponse(
					makeModel(),
					[makeUserMessage("hello")],
					{} as unknown as vscode.LanguageModelChatRequestHandleOptions,
					{ report: () => {} },
					new vscode.CancellationTokenSource().token
				);
			} finally {
				(global as unknown as Record<string, unknown>).fetch = originalFetch;
			}

			const flat = logger.lines.join("\n");
			assert.ok(flat.includes("[INFO] Request: model=m"), `missing request log:\n${flat}`);
			assert.ok(flat.includes("[INFO] Response: status=200"), `missing response log:\n${flat}`);
			assert.ok(flat.includes("[INFO] Starting streaming response for model m"), `missing streaming log:\n${flat}`);
			assert.ok(flat.includes("[INFO] Stream reader closed"), `missing stream-close log:\n${flat}`);
			// Every line carries a timestamp
			for (const line of logger.lines) {
				assert.match(line, /^\[\d{2}:\d{2}:\d{2}\.\d{3}\] /, `line missing timestamp: ${line}`);
			}
		});

		test("logs API error responses and logs then throws", async () => {
			const logger = new CaptureLogger();
			const provider = new LemonadeChatModelProvider(makeSecretStorage(), "test/test", logger);
			const originalFetch = global.fetch;
			try {
				(global as unknown as Record<string, unknown>).fetch = async () => ({
					ok: false,
					status: 500,
					statusText: "Internal Server Error",
					text: async () => "boom",
				});
				let threw = false;
				try {
					await provider.provideLanguageModelChatResponse(
						makeModel(),
						[makeUserMessage("hello")],
						{} as unknown as vscode.LanguageModelChatRequestHandleOptions,
						{ report: () => {} },
						new vscode.CancellationTokenSource().token
					);
				} catch (error) {
					threw = true;
					assert.ok((error as Error).message.includes("500"));
				}
				assert.ok(threw, "should throw on API error");
			} finally {
				(global as unknown as Record<string, unknown>).fetch = originalFetch;
			}
			const flat = logger.lines.join("\n");
			assert.ok(flat.includes("[ERROR] API error response: boom"), `missing error log:\n${flat}`);
		});

		test("logs Progress.report failures to the injected logger", async () => {
			const logger = new CaptureLogger();
			const provider = new LemonadeChatModelProvider(makeSecretStorage(), "test/test", logger);
			const originalFetch = global.fetch;
			try {
				(global as unknown as Record<string, unknown>).fetch = mockChatFetch();
				// progress.report throws -> provider must catch and log it
				await provider.provideLanguageModelChatResponse(
					makeModel(),
					[makeUserMessage("hello")],
					{} as unknown as vscode.LanguageModelChatRequestHandleOptions,
					{ report: () => { throw new Error("report broken"); } },
					new vscode.CancellationTokenSource().token
				);
			} catch {
				// The rethrown report error may propagate; that's fine here
			} finally {
				(global as unknown as Record<string, unknown>).fetch = originalFetch;
			}
			assert.ok(
				logger.lines.some((l) => l.includes("[ERROR] Progress.report failed: report broken")),
				`missing Progress.report failure log:\n${logger.lines.join("\n")}`
			);
		});
	});

	suite("utils log threading", () => {
		test("convertTools reports errors through the provided logger", () => {
			const logger = new CaptureLogger();
			const log = (msg: string) => logger.appendLine(msg);
			assert.throws(() =>
				convertTools(
					{
						toolMode: vscode.LanguageModelChatToolMode.Required,
						tools: [
							{ name: "a", description: "", inputSchema: {} },
							{ name: "b", description: "", inputSchema: {} },
						],
					} satisfies vscode.LanguageModelChatRequestHandleOptions,
					log
				)
			);
			assert.ok(
				logger.lines.some((l) => l.includes("ToolMode.Required but multiple tools: 2")),
				`missing tool-mode log:\n${logger.lines.join("\n")}`
			);
		});

		test("convertTools falls back to console.error when no logger is provided", () => {
			const captured: unknown[] = [];
			withConsoleErrorStub(captured, () => {
				assert.throws(() =>
					convertTools({
						toolMode: vscode.LanguageModelChatToolMode.Required,
						tools: [
							{ name: "a", description: "", inputSchema: {} },
							{ name: "b", description: "", inputSchema: {} },
						],
					} satisfies vscode.LanguageModelChatRequestHandleOptions)
				);
			});
			assert.ok(captured.length > 0, "should log to console.error by default");
		});

		test("validateRequest reports missing tool results through the provided logger", () => {
			const logger = new CaptureLogger();
			const log = (msg: string) => logger.appendLine(msg);
			const callId = "xyz";
			const toolCall = new vscode.LanguageModelToolCallPart(callId, "toolA", { q: 1 });
			// The tool call must be followed by a NON-User message to trip the
			// "missing tool result for call IDs" validation path.
			const invalid: vscode.LanguageModelChatMessage[] = [
				{ role: vscode.LanguageModelChatMessageRole.Assistant, content: [toolCall], name: undefined },
				{ role: vscode.LanguageModelChatMessageRole.Assistant, content: [new vscode.LanguageModelTextPart("missing")], name: undefined },
			];
			assert.throws(() => validateRequest(invalid, log));
			assert.ok(
				logger.lines.some((l) => l.includes("Validation failed: missing tool result for call IDs: xyz")),
				`missing validation log:\n${logger.lines.join("\n")}`
			);
		});
	});
});
