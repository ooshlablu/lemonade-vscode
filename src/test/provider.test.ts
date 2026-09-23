import * as assert from "assert";
import * as vscode from "vscode";
import { LemonadeChatModelProvider } from "../provider";
import { convertMessages, convertTools, validateRequest, validateTools, tryParseJSONObject } from "../utils";
import type { LemonadeEndpoint } from "../types";
import type { Logger } from "../logger";

interface OpenAIToolCall {
	id: string;
	type: "function";
	function: { name: string; arguments: string };
}
interface ConvertedMessage {
	role: "user" | "assistant" | "tool";
	content?: string;
	name?: string;
	tool_calls?: OpenAIToolCall[];
	tool_call_id?: string;
}

// ---------------------------------------------------------------------------
// Shared helpers for streaming-based provider tests
// ---------------------------------------------------------------------------

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeSecretStorage(): vscode.SecretStorage {
	return {
		get: async () => undefined,
		store: async () => {},
		delete: async () => {},
		onDidChange: (_listener: unknown) => ({ dispose() {} }),
	} as unknown as vscode.SecretStorage;
}

function makeTestModel(): vscode.LanguageModelChatInformation {
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

/** A ReadableStream whose chunks we control from the outside. */
function controllableStream(): {
	body: ReadableStream<Uint8Array>;
	send: (s: string) => void;
	close: () => void;
} {
	const encoder = new TextEncoder();
	let enq: (c: Uint8Array) => void = () => {};
	let cls: () => void = () => {};
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			enq = (c) => controller.enqueue(c);
			cls = () => controller.close();
		},
	});
	return { body, send: (s) => enq(encoder.encode(s)), close: () => cls() };
}

/** Build a fetch mock: /models returns an empty list, /chat/completions returns a fresh controllable stream. */
function mockFetch(streams: ReturnType<typeof controllableStream>[]): unknown {
	return async (input: RequestInfo | URL) => {
		const url = String(input);
		if (url.endsWith("/models")) {
			return { ok: true, json: async () => ({ object: "list", data: [] }) };
		}
		const s = controllableStream();
		streams.push(s);
		return { ok: true, status: 200, statusText: "OK", body: s.body, text: async () => "" };
	};
}

suite("Lemonade Chat Provider Extension", () => {
	suite("double model call", () => {
		test("discards a stale streaming response after a new request starts", async () => {
			const logger = new CaptureLogger();
			const provider = new LemonadeChatModelProvider(makeSecretStorage(), "test/test", logger);
			const streams: ReturnType<typeof controllableStream>[] = [];
			const originalFetch = global.fetch;
			try {
				(global as unknown as Record<string, unknown>).fetch = mockFetch(streams);

				// Request 1: start but do not complete — it parks on reader.read().
				const parts1: unknown[] = [];
				const p1 = provider.provideLanguageModelChatResponse(
					makeTestModel(),
					[makeUserMessage("one")],
					{} as unknown as vscode.LanguageModelChatRequestHandleOptions,
					{ report: (p: unknown) => parts1.push(p) },
					new vscode.CancellationTokenSource().token
				);
				for (let i = 0; i < 50 && streams.length < 1; i++) {
					await sleep(5);
				}
				assert.equal(streams.length, 1, "request 1 should have opened a stream");

				// Request 2: starts while request 1 is in-flight. Depending on the
				// provider version it either runs concurrently (advancing the request
				// generation) or is queued behind request 1; both are valid — what
				// must hold in both cases is that request 1's leftover stream data is
				// never emitted to request 1's progress.
				const parts2: unknown[] = [];
				const p2 = provider.provideLanguageModelChatResponse(
					makeTestModel(),
					[makeUserMessage("two")],
					{} as unknown as vscode.LanguageModelChatRequestHandleOptions,
					{ report: (p: unknown) => parts2.push(p) },
					new vscode.CancellationTokenSource().token
				);

			// Give request 2 a moment to open its own stream (concurrent mode).
			// If it does not within this window, it is queued behind request 1.
			let concurrent = false;
			for (let i = 0; i < 100 && streams.length < 2; i++) {
				await sleep(5);
				if (streams.length === 2) {
					concurrent = true;
					break;
				}
			}

			if (!concurrent) {
					// Request 2 is queued behind request 1: complete request 1 first.
					streams[0].send('data: {"choices":[{"delta":{"content":"one"}}]}\n\n');
					streams[0].send('data: [DONE]\n\n');
					streams[0].close();
					await p1;
					for (let i = 0; i < 50 && streams.length < 2; i++) {
						await sleep(5);
					}
					assert.equal(streams.length, 2, "queued request 2 should start after request 1 completes");
					streams[1].send('data: {"choices":[{"delta":{"content":"two"}}]}\n\n');
					streams[1].send('data: [DONE]\n\n');
					streams[1].close();
					await p2;
					assert.ok(
						logger.lines.some((l) => l.includes("[WARN] Request queued (another request already in-flight)")),
						`missing queued warning:\n${logger.lines.join("\n")}`
					);
				} else {
					// Request 2 opened its own stream: complete it, then feed request 1
					// leftover data which must be treated as stale and discarded.
					streams[1].send('data: {"choices":[{"delta":{"content":"two"}}]}\n\n');
					streams[1].send('data: [DONE]\n\n');
					streams[1].close();
					await p2;

					streams[0].send('data: {"choices":[{"delta":{"content":"STALE"}}]}\n\n');
					streams[0].send('data: [DONE]\n\n');
					streams[0].close();
					await p1;
					assert.ok(
						logger.lines.some((l) => l.includes("[DONE] Stale request discarded")),
						`missing stale [DONE] log:\n${logger.lines.join("\n")}`
					);
				}

				// In neither mode may request 1's progress have received the stale text.
				const staleEmitted = parts1.some(
					(p) => p instanceof vscode.LanguageModelTextPart && (p as vscode.LanguageModelTextPart).value === "STALE"
				);
				assert.ok(!staleEmitted, "stale chunk must be discarded, not emitted");
			} finally {
				(global as unknown as Record<string, unknown>).fetch = originalFetch;
			}
		});

		test("emits a normal (non-stale) response when no newer request exists", async () => {
			const provider = new LemonadeChatModelProvider(makeSecretStorage(), "test/test", new CaptureLogger());
			const streams: ReturnType<typeof controllableStream>[] = [];
			const originalFetch = global.fetch;
			try {
				(global as unknown as Record<string, unknown>).fetch = mockFetch(streams);
				const parts: unknown[] = [];
				const p = provider.provideLanguageModelChatResponse(
					makeTestModel(),
					[makeUserMessage("solo")],
					{} as unknown as vscode.LanguageModelChatRequestHandleOptions,
					{ report: (p: unknown) => parts.push(p) },
					new vscode.CancellationTokenSource().token
				);
				for (let i = 0; i < 50 && streams.length < 1; i++) {
					await sleep(5);
				}
				streams[0].send('data: {"choices":[{"delta":{"content":"solo"}}]}\n\n');
				streams[0].send('data: [DONE]\n\n');
				streams[0].close();
				await p;

				const textEmitted = parts.some(
					(p) => p instanceof vscode.LanguageModelTextPart && (p as vscode.LanguageModelTextPart).value === "solo"
				);
				assert.ok(textEmitted, "a single request's text should be emitted");
			} finally {
				(global as unknown as Record<string, unknown>).fetch = originalFetch;
			}
		});
	});

	suite("stats and usage report", () => {
		interface CapturedPart {
			kind: string;
			value?: string;
			mimeType?: string;
		}

		function captureParts(): { parts: CapturedPart[]; report: (p: unknown) => void } {
			const parts: CapturedPart[] = [];
			const report = (p: unknown) => {
				const part = p as { constructor?: { name?: string }; data?: unknown; mimeType?: unknown };
				if (part instanceof vscode.LanguageModelDataPart) {
					parts.push({
						kind: "data",
						value: new TextDecoder().decode(part.data as Uint8Array),
						mimeType: part.mimeType,
					});
				} else {
					parts.push({ kind: part.constructor?.name ?? typeof part });
				}
			};
			return { parts, report };
		}

		/** Run one full request against a controllable stream, feeding the given SSE payload. */
		async function runRequest(
			provider: LemonadeChatModelProvider,
			streams: ReturnType<typeof controllableStream>[],
			report: (p: unknown) => void,
			ssePayloads: string[]
		): Promise<void> {
			const p = provider.provideLanguageModelChatResponse(
				makeTestModel(),
				[makeUserMessage("usage")],
				{} as unknown as vscode.LanguageModelChatRequestHandleOptions,
				{ report },
				new vscode.CancellationTokenSource().token
			);
			for (let i = 0; i < 100 && streams.length < 1; i++) {
				await sleep(5);
			}
			for (const s of ssePayloads) {
				streams[0].send(s);
			}
			streams[0].close();
			await p;
		}

		test("sends stream_options include_usage and reports a usage data part", async () => {
			const logger = new CaptureLogger();
			const provider = new LemonadeChatModelProvider(makeSecretStorage(), "test/test", logger);
			const streams: ReturnType<typeof controllableStream>[] = [];
			const bodies: string[] = [];
			const originalFetch = global.fetch;
			try {
				(global as unknown as Record<string, unknown>).fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
					const url = String(input);
					if (url.endsWith("/models")) {
						return { ok: true, json: async () => ({ object: "list", data: [] }) };
					}
					bodies.push(String(init?.body));
					const s = controllableStream();
					streams.push(s);
					return { ok: true, status: 200, statusText: "OK", body: s.body, text: async () => "" };
				};

				const { parts, report } = captureParts();
				await runRequest(
					provider,
					streams,
					report,
					[
						'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
						'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\n',
						'data: [DONE]\n\n',
					]
				);

				// The request body must ask for usage in the stream.
				assert.equal(bodies.length, 1, "one chat request expected");
				const sent = JSON.parse(bodies[0]) as Record<string, unknown>;
				assert.deepEqual(sent.stream_options, { include_usage: true }, "must send stream_options.include_usage");

				// A usage data part must be reported with the token counts.
				const usagePart = parts.find((p) => p.kind === "data" && p.mimeType === "usage");
				assert.ok(usagePart, `expected a usage data part:\n${JSON.stringify(parts)}`);
				assert.deepEqual(JSON.parse(usagePart!.value!), {
					prompt_tokens: 10,
					completion_tokens: 5,
					total_tokens: 15,
				});
				assert.ok(
					logger.lines.some((l) => l.includes("[INFO] Reported usage:")),
					`missing usage log:\n${logger.lines.join("\n")}`
				);
			} finally {
				(global as unknown as Record<string, unknown>).fetch = originalFetch;
			}
		});

		test("does not report a usage part when the server returns no token counts", async () => {
			const logger = new CaptureLogger();
			const provider = new LemonadeChatModelProvider(makeSecretStorage(), "test/test", logger);
			const streams: ReturnType<typeof controllableStream>[] = [];
			const originalFetch = global.fetch;
			try {
				(global as unknown as Record<string, unknown>).fetch = async (input: RequestInfo | URL) => {
					const url = String(input);
					if (url.endsWith("/models")) {
						return { ok: true, json: async () => ({ object: "list", data: [] }) };
					}
					const s = controllableStream();
					streams.push(s);
					return { ok: true, status: 200, statusText: "OK", body: s.body, text: async () => "" };
				};

				const { parts, report } = captureParts();
				await runRequest(
					provider,
					streams,
					report,
					[
						'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
						'data: {"choices":[],"usage":{}}\n\n',
						'data: [DONE]\n\n',
					]
				);

				const usagePart = parts.find((p) => p.kind === "data" && p.mimeType === "usage");
				assert.ok(!usagePart, `no usage part expected when counts are empty:\n${JSON.stringify(parts)}`);
				assert.ok(
					logger.lines.some((l) => l.includes("[WARN] No usage data in streaming response")),
					`missing no-usage warning:\n${logger.lines.join("\n")}`
				);
			} finally {
				(global as unknown as Record<string, unknown>).fetch = originalFetch;
			}
		});
	});

	suite("duplicate calls", () => {
		test("serializes concurrent requests — second is queued until the first completes", async () => {
			const logger = new CaptureLogger();
			const provider = new LemonadeChatModelProvider(makeSecretStorage(), "test/test", logger);
			const streams: ReturnType<typeof controllableStream>[] = [];
			const originalFetch = global.fetch;
			try {
				(global as unknown as Record<string, unknown>).fetch = mockFetch(streams);

				const text1: string[] = [];
				const text2: string[] = [];
				const p1 = provider.provideLanguageModelChatResponse(
					makeTestModel(),
					[makeUserMessage("one")],
					{} as unknown as vscode.LanguageModelChatRequestHandleOptions,
					{ report: (p: unknown) => { if (p instanceof vscode.LanguageModelTextPart) text1.push(p.value); } },
					new vscode.CancellationTokenSource().token
				);
				for (let i = 0; i < 100 && streams.length < 1; i++) {
					await sleep(5);
				}
				assert.equal(streams.length, 1, "request 1 should have opened a stream");

				// Request 2 starts while request 1 is in flight — it must be queued.
				const p2 = provider.provideLanguageModelChatResponse(
					makeTestModel(),
					[makeUserMessage("two")],
					{} as unknown as vscode.LanguageModelChatRequestHandleOptions,
					{ report: (p: unknown) => { if (p instanceof vscode.LanguageModelTextPart) text2.push(p.value); } },
					new vscode.CancellationTokenSource().token
				);
				await sleep(50);
				assert.equal(streams.length, 1, "request 2 must be queued, not open a second stream");
				assert.ok(
					logger.lines.some((l) => l.includes("[WARN] Request queued (another request already in-flight)")),
					`missing queued warning:\n${logger.lines.join("\n")}`
				);

				// Complete request 1.
				streams[0].send('data: {"choices":[{"delta":{"content":"first"}}]}\n\n');
				streams[0].send("data: [DONE]\n\n");
				streams[0].close();
				await p1;

				// Request 2 should now have been picked up from the queue.
				for (let i = 0; i < 100 && streams.length < 2; i++) {
					await sleep(5);
				}
				assert.equal(streams.length, 2, "request 2 should open its stream after request 1 completes");
				streams[1].send('data: {"choices":[{"delta":{"content":"second"}}]}\n\n');
				streams[1].send("data: [DONE]\n\n");
				streams[1].close();
				await p2;

				const out1 = text1.join("");
				const out2 = text2.join("");
				assert.ok(out1.includes("first") && !out1.includes("second"), `request 1 output leaked: ${out1}`);
				assert.ok(out2.includes("second") && !out2.includes("first"), `request 2 output leaked: ${out2}`);
			} finally {
				(global as unknown as Record<string, unknown>).fetch = originalFetch;
			}
		});

		test("exits the stream reader early on [DONE] instead of reading further", async () => {
			const logger = new CaptureLogger();
			const provider = new LemonadeChatModelProvider(makeSecretStorage(), "test/test", logger);
			const streams: ReturnType<typeof controllableStream>[] = [];
			const originalFetch = global.fetch;
			try {
				(global as unknown as Record<string, unknown>).fetch = mockFetch(streams);
				const text: string[] = [];
				const p = provider.provideLanguageModelChatResponse(
					makeTestModel(),
					[makeUserMessage("done")],
					{} as unknown as vscode.LanguageModelChatRequestHandleOptions,
					{ report: (part: unknown) => { if (part instanceof vscode.LanguageModelTextPart) text.push(part.value); } },
					new vscode.CancellationTokenSource().token
				);
				for (let i = 0; i < 100 && streams.length < 1; i++) {
					await sleep(5);
				}
				streams[0].send('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n');
				streams[0].send("data: [DONE]\n\n");
				// Do NOT close the stream — the provider must exit on [DONE] itself.
				await p;
				assert.ok(text.join("").includes("ok"), "content before [DONE] should be reported");
				assert.ok(
					logger.lines.some((l) => l.includes("[INFO] Stream reader closed normally after [DONE]")),
					`missing early-exit log:\n${logger.lines.join("\n")}`
				);
			} finally {
				streams.forEach((s) => s.close());
				(global as unknown as Record<string, unknown>).fetch = originalFetch;
			}
		});

		test("logs a warning when the stream closes without [DONE]", async () => {
			const logger = new CaptureLogger();
			const provider = new LemonadeChatModelProvider(makeSecretStorage(), "test/test", logger);
			const streams: ReturnType<typeof controllableStream>[] = [];
			const originalFetch = global.fetch;
			try {
				(global as unknown as Record<string, unknown>).fetch = mockFetch(streams);
				const p = provider.provideLanguageModelChatResponse(
					makeTestModel(),
					[makeUserMessage("trunc")],
					{} as unknown as vscode.LanguageModelChatRequestHandleOptions,
					{ report: () => {} },
					new vscode.CancellationTokenSource().token
				);
				for (let i = 0; i < 100 && streams.length < 1; i++) {
					await sleep(5);
				}
				streams[0].send('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
				streams[0].close(); // no [DONE]
				await p;
				assert.ok(
					logger.lines.some((l) => l.includes("[WARN] Stream reader closed without receiving [DONE]")),
					`missing incomplete-stream warning:\n${logger.lines.join("\n")}`
				);
			} finally {
				(global as unknown as Record<string, unknown>).fetch = originalFetch;
			}
		});
	});

	suite("provider", () => {
		test("prepareLanguageModelChatInformation returns array", async () => {
			const provider = new LemonadeChatModelProvider({
				get: async () => undefined,
				store: async () => {},
				delete: async () => {},
				onDidChange: (_listener: unknown) => ({ dispose() {} }),
			} as unknown as vscode.SecretStorage, "GitHubCopilotChat/test VSCode/test");

			const infos = await provider.prepareLanguageModelChatInformation(
				{ silent: true },
				new vscode.CancellationTokenSource().token
			);
			assert.ok(Array.isArray(infos));
		});

		test("provideTokenCount counts simple string", async () => {
			const provider = new LemonadeChatModelProvider({
				get: async () => undefined,
				store: async () => {},
				delete: async () => {},
				onDidChange: (_listener: unknown) => ({ dispose() {} }),
			} as unknown as vscode.SecretStorage, "GitHubCopilotChat/test VSCode/test");

			const est = await provider.provideTokenCount(
				{
					id: "m",
					name: "m",
					family: "lemonade",
					version: "1.0.0",
					maxInputTokens: 1000,
					maxOutputTokens: 1000,
					capabilities: {},
				} as unknown as vscode.LanguageModelChatInformation,
				"hello world",
				new vscode.CancellationTokenSource().token
			);
			assert.equal(typeof est, "number");
			assert.ok(est > 0);
		});

		test("provideTokenCount counts message parts", async () => {
			const provider = new LemonadeChatModelProvider({
				get: async () => undefined,
				store: async () => {},
				delete: async () => {},
				onDidChange: (_listener: unknown) => ({ dispose() {} }),
			} as unknown as vscode.SecretStorage, "GitHubCopilotChat/test VSCode/test");

			const msg: vscode.LanguageModelChatMessage = {
				role: vscode.LanguageModelChatMessageRole.User,
				content: [new vscode.LanguageModelTextPart("hello world")],
				name: undefined,
			};
			const est = await provider.provideTokenCount(
				{
					id: "m",
					name: "m",
					family: "lemonade",
					version: "1.0.0",
					maxInputTokens: 1000,
					maxOutputTokens: 1000,
					capabilities: {},
				} as unknown as vscode.LanguageModelChatInformation,
				msg,
				new vscode.CancellationTokenSource().token
			);
			assert.equal(typeof est, "number");
			assert.ok(est > 0);
		});

		test("provideLanguageModelChatResponse works without API key", async () => {
			const provider = new LemonadeChatModelProvider({
				get: async () => undefined,
				store: async () => {},
				delete: async () => {},
				onDidChange: (_listener: unknown) => ({ dispose() {} }),
			} as unknown as vscode.SecretStorage, "GitHubCopilotChat/test VSCode/test");

			// This should not throw since Lemonade doesn't require API keys
			// However, it will still fail due to no server running, which is expected
			let threw = false;
			try {
				await provider.provideLanguageModelChatResponse(
					{
						id: "m",
						name: "m",
						family: "lemonade",
						version: "1.0.0",
						maxInputTokens: 1000,
						maxOutputTokens: 1000,
						capabilities: {},
					} as unknown as vscode.LanguageModelChatInformation,
					[],
					{} as unknown as vscode.LanguageModelChatRequestHandleOptions,
					{ report: () => {} },
					new vscode.CancellationTokenSource().token
				);
			} catch (error) {
				// Should throw due to connection error, not missing API key
				threw = true;
				const errMsg = error instanceof Error ? error.message : String(error);
				assert.ok(!errMsg.includes("API key"), "Should not fail due to API key");
			}
			assert.ok(threw, "Should throw due to connection error");
		});

		// ------------------------------------------------------------------
		// Multi-endpoint tests
		// ------------------------------------------------------------------

		test("getEndpoints returns default when nothing stored", async () => {
			const provider = new LemonadeChatModelProvider({
				get: async () => undefined,
				store: async () => {},
				delete: async () => {},
				onDidChange: (_listener: unknown) => ({ dispose() {} }),
			} as unknown as vscode.SecretStorage, "test/test");

			const endpoints = await provider.getEndpoints();
			assert.ok(Array.isArray(endpoints) && endpoints.length === 1);
			assert.equal(endpoints[0].shortname, "default");
			assert.ok(endpoints[0].url.startsWith("http://localhost"));
		});

		test("getEndpoints migrates legacy serverUrl secret", async () => {
			const store: Record<string, string> = {
				"lemonade.serverUrl": "http://192.168.1.17:8000/api/v1",
				"lemonade.apiKey": "mykey",
			};
			const deleted: string[] = [];
			const provider = new LemonadeChatModelProvider({
				get: async (k: string) => store[k],
				store: async (k: string, v: string) => { store[k] = v; },
				delete: async (k: string) => { deleted.push(k); delete store[k]; },
				onDidChange: (_listener: unknown) => ({ dispose() {} }),
			} as unknown as vscode.SecretStorage, "test/test");

			const endpoints = await provider.getEndpoints();
			assert.equal(endpoints.length, 1);
			assert.equal(endpoints[0].shortname, "default");
			assert.equal(endpoints[0].url, "http://192.168.1.17:8000/api/v1");
			assert.equal(endpoints[0].apiKey, "mykey");
			// Legacy keys must be deleted after migration
			assert.ok(deleted.includes("lemonade.serverUrl"));
			assert.ok(deleted.includes("lemonade.apiKey"));
			// New key must be written
			assert.ok(store["lemonade.endpoints"]);
		});

		test("getEndpoints reads multiple stored endpoints", async () => {
			const endpoints: LemonadeEndpoint[] = [
				{ shortname: "node-17", url: "http://192.168.1.17:8000/api/v1" },
				{ shortname: "node-80", url: "http://192.168.1.80:8000/api/v1", apiKey: "secret" },
			];
			const provider = new LemonadeChatModelProvider({
				get: async (k: string) => k === "lemonade.endpoints" ? JSON.stringify(endpoints) : undefined,
				store: async () => {},
				delete: async () => {},
				onDidChange: (_listener: unknown) => ({ dispose() {} }),
			} as unknown as vscode.SecretStorage, "test/test");

			const result = await provider.getEndpoints();
			assert.equal(result.length, 2);
			assert.equal(result[0].shortname, "node-17");
			assert.equal(result[1].shortname, "node-80");
			assert.equal(result[1].apiKey, "secret");
		});

		test("prepareLanguageModelChatInformation prefixes model ids with shortname", async () => {
			const endpoints: LemonadeEndpoint[] = [
				{ shortname: "node-17", url: "http://192.168.1.17:8000/api/v1" },
			];
			// Mock fetch to return a single model
			const originalFetch = global.fetch;
			try {
				(global as unknown as Record<string, unknown>).fetch = async () => ({
					ok: true,
					json: async () => ({ object: "list", data: [{ id: "Llama-3.2-3B", object: "model" }] }),
				});

				const provider = new LemonadeChatModelProvider({
					get: async (k: string) => k === "lemonade.endpoints" ? JSON.stringify(endpoints) : undefined,
					store: async () => {},
					delete: async () => {},
					onDidChange: (_listener: unknown) => ({ dispose() {} }),
				} as unknown as vscode.SecretStorage, "test/test");

				const infos = await provider.prepareLanguageModelChatInformation(
					{ silent: true },
					new vscode.CancellationTokenSource().token
				);
				assert.equal(infos.length, 1);
				assert.equal(infos[0].id, "node-17/Llama-3.2-3B");
				assert.equal(infos[0].name, "node-17/Llama-3.2-3B");
			} finally {
				(global as unknown as Record<string, unknown>).fetch = originalFetch;
			}
		});
	});

	suite("utils/convertMessages", () => {
		test("maps user/assistant text", () => {
			const messages: vscode.LanguageModelChatMessage[] = [
				{
					role: vscode.LanguageModelChatMessageRole.User,
					content: [new vscode.LanguageModelTextPart("hi")],
					name: undefined,
				},
				{
					role: vscode.LanguageModelChatMessageRole.Assistant,
					content: [new vscode.LanguageModelTextPart("hello")],
					name: undefined,
				},
			];
			const out = convertMessages(messages) as ConvertedMessage[];
			assert.deepEqual(out, [
				{ role: "user", content: "hi" },
				{ role: "assistant", content: "hello" },
			]);
		});

		test("maps tool calls and results", () => {
			const toolCall = new vscode.LanguageModelToolCallPart("abc", "toolA", { foo: 1 });
			const toolResult = new vscode.LanguageModelToolResultPart("abc", [new vscode.LanguageModelTextPart("result")]);
			const messages: vscode.LanguageModelChatMessage[] = [
				{ role: vscode.LanguageModelChatMessageRole.Assistant, content: [toolCall], name: undefined },
				{ role: vscode.LanguageModelChatMessageRole.Assistant, content: [toolResult], name: undefined },
			];
			const out = convertMessages(messages) as ConvertedMessage[];
			const hasToolCalls = out.some((m: ConvertedMessage) => Array.isArray(m.tool_calls));
			const hasToolMsg = out.some((m: ConvertedMessage) => m.role === "tool");
			assert.ok(hasToolCalls && hasToolMsg);
		});

		test("handles mixed text + tool calls in one assistant message", () => {
			const toolCall = new vscode.LanguageModelToolCallPart("call1", "search", { q: "hello" });
			const msg: vscode.LanguageModelChatMessage = {
				role: vscode.LanguageModelChatMessageRole.Assistant,
				content: [
					new vscode.LanguageModelTextPart("before "),
					toolCall,
					new vscode.LanguageModelTextPart(" after"),
				],
				name: undefined,
			};
			const out = convertMessages([msg]) as ConvertedMessage[];
			assert.equal(out.length, 1);
			assert.equal(out[0].role, "assistant");
			assert.ok(out[0].content?.includes("before"));
			assert.ok(out[0].content?.includes("after"));
			assert.ok(Array.isArray(out[0].tool_calls) && out[0].tool_calls.length === 1);
			assert.equal(out[0].tool_calls?.[0].function.name, "search");
		});
	});

	suite("utils/tools", () => {
		test("convertTools returns function tool definitions", () => {
			const out = convertTools({
				tools: [
					{
						name: "do_something",
						description: "Does something",
						inputSchema: { type: "object", properties: { x: { type: "number" } }, additionalProperties: false },
					},
				],
			} satisfies vscode.LanguageModelChatRequestHandleOptions);

			assert.ok(out);
			assert.equal(out.tool_choice, "auto");
			assert.ok(Array.isArray(out.tools) && out.tools[0].type === "function");
			assert.equal(out.tools[0].function.name, "do_something");
		});

		test("convertTools respects ToolMode.Required for single tool", () => {
			const out = convertTools({
				toolMode: vscode.LanguageModelChatToolMode.Required,
				tools: [
					{
						name: "only_tool",
						description: "Only tool",
						inputSchema: {},
					},
				],
			} satisfies vscode.LanguageModelChatRequestHandleOptions);
			assert.deepEqual(out.tool_choice, { type: "function", function: { name: "only_tool" } });
		});

	test("validateTools rejects invalid names", () => {
		const badTools: vscode.LanguageModelChatTool[] = [
			{ name: "bad name!", description: "", inputSchema: {} },
		];
		assert.throws(() => validateTools(badTools));
	});
	});

	suite("utils/validation", () => {
		test("validateRequest enforces tool result pairing", () => {
			const callId = "xyz";
			const toolCall = new vscode.LanguageModelToolCallPart(callId, "toolA", { q: 1 });
			const toolRes = new vscode.LanguageModelToolResultPart(callId, [new vscode.LanguageModelTextPart("ok")]);
			const valid: vscode.LanguageModelChatMessage[] = [
				{ role: vscode.LanguageModelChatMessageRole.Assistant, content: [toolCall], name: undefined },
				{ role: vscode.LanguageModelChatMessageRole.User, content: [toolRes], name: undefined },
			];
			assert.doesNotThrow(() => validateRequest(valid));

			const invalid: vscode.LanguageModelChatMessage[] = [
				{ role: vscode.LanguageModelChatMessageRole.Assistant, content: [toolCall], name: undefined },
				{ role: vscode.LanguageModelChatMessageRole.User, content: [new vscode.LanguageModelTextPart("missing")], name: undefined },
			];
			assert.throws(() => validateRequest(invalid));
		});
	});

	suite("utils/json", () => {
		test("tryParseJSONObject handles valid and invalid JSON", () => {
			assert.deepEqual(tryParseJSONObject("{\"a\":1}"), { ok: true, value: { a: 1 } });
			assert.deepEqual(tryParseJSONObject("[1,2,3]"), { ok: false });
			assert.deepEqual(tryParseJSONObject("not json"), { ok: false });
		});
	});
});
