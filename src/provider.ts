import * as vscode from "vscode";
import {
	CancellationToken,
	LanguageModelChatInformation,
	LanguageModelChatMessage,
	LanguageModelChatProvider,
	LanguageModelChatRequestHandleOptions,
	LanguageModelResponsePart,
	Progress,
} from "vscode";

import { convertTools, convertMessages, tryParseJSONObject, validateRequest } from "./utils";
import type { LemonadeEndpoint, LemonadeModel, LemonadeModelsResponse } from "./types";
import type { Logger } from "./logger";
import { createFallbackLogger } from "./logger";

const DEFAULT_BASE_URL = "http://localhost:13305/api/v1";
const DEFAULT_MAX_OUTPUT_TOKENS = 65536;
const DEFAULT_CONTEXT_LENGTH = 262144;
const DEFAULT_API_KEY = "lemonade";
const DEFAULT_REQUEST_TIMEOUT = 300000;
const ENDPOINTS_SECRET_KEY = "lemonade.endpoints";

/**
 * Resolve the max output tokens to use. Reads from VS Code setting
 * `lemonade.maxOutputTokens`; falls back to DEFAULT_MAX_OUTPUT_TOKENS when
 * the setting is absent, not a positive integer, or when running outside VS Code.
 */
async function resolveMaxOutputTokens(): Promise<number> {
	try {
		const config = vscode.workspace.getConfiguration("lemonade");
		const raw = config.get<number>("maxOutputTokens");
		if (raw !== undefined && Number.isFinite(raw) && raw > 0) {
			return raw;
		}
	} catch {
		// Running outside VS Code (e.g., tests) — fall through to default
	}
	return DEFAULT_MAX_OUTPUT_TOKENS;
}

/**
 * Resolve the context length to use. Reads LEMONADE_CTX_SIZE from the
 * environment; falls back to DEFAULT_CONTEXT_LENGTH when the variable is
 * absent or not a positive integer.
 */
function resolveContextLength(): number {
	const raw = process.env["LEMONADE_CTX_SIZE"];
	if (raw) {
		const parsed = parseInt(raw, 10);
		if (Number.isFinite(parsed) && parsed > 0) {
			return parsed;
		}
	}
	return DEFAULT_CONTEXT_LENGTH;
}

/** Resolve the maximum time allowed for an HTTP request, including streaming. */
function resolveRequestTimeout(): number {
	try {
		const raw = vscode.workspace.getConfiguration("lemonade").get<number>("requestTimeout");
		if (raw !== undefined && Number.isFinite(raw) && raw > 0) {
			return raw;
		}
	} catch {
		// Running outside VS Code (e.g., tests) — use the default.
	}
	return DEFAULT_REQUEST_TIMEOUT;
}

/**
 * VS Code Chat provider backed by Lemonade local LLM server.
 */
export class LemonadeChatModelProvider implements LanguageModelChatProvider {
	/** Monotonically increasing counter to detect stale requests. Each call to
	 *  `provideLanguageModelChatResponse` captures the current generation; any
	 *  streaming response whose generation no longer matches the latest is
	 *  discarded. */
	private _requestGeneration = 0;
	/** Counter for stale SSE chunks discarded in the current streaming session. Used to cap logging spam. */
	private _staleChunkCount = 0;
	/** Maximum number of stale chunk discard warnings to log per streaming session. */
	private readonly _maxStaleWarnings = 5;
	/** Buffer for assembling streamed tool calls by index. */
	private _toolCallBuffers: Map<number, { id?: string; name?: string; args: string }> = new Map<
		number,
		{ id?: string; name?: string; args: string }
	>();

	/** Indices for which a tool call has been fully emitted. */
	private _completedToolCallIndices = new Set<number>();

	/** Track if we emitted any assistant text before seeing tool calls (SSE-like begin-tool-calls hint). */
	private _hasEmittedAssistantText = false;

	/** Track if we emitted the begin-tool-calls whitespace flush. */
	private _emittedBeginToolCallsHint = false;

	// Lightweight tokenizer state for tool calls embedded in text
	private _textToolParserBuffer = "";
	private _textToolActive:
		| undefined
		| {
			name?: string;
			index?: number;
			argBuffer: string;
			emitted?: boolean;
		};
	private _emittedTextToolCallKeys = new Set<string>();
	private _emittedTextToolCallIds = new Set<string>();

	/** Buffer for handling control tokens that might be split across streaming chunks. */
	private _controlTokenBuffer = "";

	/** VS Code output channel for Lemonade extension logging. */
	private readonly outputChannel: Logger;

	/** Format a timestamp as HH:MM:SS.mmm */
	private _ts(): string {
		const now = new Date();
		const h = String(now.getHours()).padStart(2, '0');
		const m = String(now.getMinutes()).padStart(2, '0');
		const s = String(now.getSeconds()).padStart(2, '0');
		const ms = String(now.getMilliseconds()).padStart(3, '0');
		return `${h}:${m}:${s}.${ms}`;
	}

	/**
	 * Create a provider using the given secret storage for the server URL.
	 * @param secrets VS Code secret storage.
	 * @param userAgent User-Agent header value.
	 * @param outputChannel Optional VS Code output channel for logging. Falls back to console.error.
	 */
	constructor(
		private readonly secrets: vscode.SecretStorage,
		private readonly userAgent: string,
		outputChannel?: Logger,
	) {
		this.outputChannel = outputChannel ?? createFallbackLogger();
	}

	/** Roughly estimate tokens for VS Code chat messages (text only) */
	private estimateMessagesTokens(msgs: readonly vscode.LanguageModelChatMessage[]): number {
		let total = 0;
		for (const m of msgs) {
			for (const part of m.content) {
				if (part instanceof vscode.LanguageModelTextPart) {
					total += Math.ceil(part.value.length / 4);
				}
			}
		}
		return total;
	}

	/** Rough token estimate for tool definitions by JSON size */
	private estimateToolTokens(tools: { type: string; function: { name: string; description?: string; parameters?: object } }[] | undefined): number {
		if (!tools || tools.length === 0) { return 0; }
		try {
			const json = JSON.stringify(tools);
			return Math.ceil(json.length / 4);
		} catch {
			return 0;
		}
	}

	/**
	 * Determine whether a streamed usage payload contains real token counts.
	 * OpenAI-compatible servers report `prompt_tokens` and `completion_tokens`
	 * (snake_case). VS Code reads these exact fields to render token stats, so
	 * we only emit a usage part when at least one of them is present and > 0.
	 */
	private hasUsage(usage: Record<string, unknown>): boolean {
		const prompt = usage["prompt_tokens"];
		const completion = usage["completion_tokens"];
		const hasPrompt = typeof prompt === "number" && prompt > 0;
		const hasCompletion = typeof completion === "number" && completion > 0;
		return hasPrompt || hasCompletion;
	}

	/**
	 * Get the list of available language models contributed by this provider.
	 * Fans out to all configured endpoints concurrently; failures on individual
	 * endpoints are swallowed so healthy nodes still appear.
	 */
	async prepareLanguageModelChatInformation(
		options: { silent: boolean },
		_token: CancellationToken
	): Promise<LanguageModelChatInformation[]> {
		const endpoints = await this.getEndpoints();
		const maxOutput = await resolveMaxOutputTokens();
		const maxInput = Math.max(1, resolveContextLength() - maxOutput);

		// Fetch models from all endpoints concurrently; ignore per-endpoint errors
		const results = await Promise.all(
			endpoints.map(async (ep) => {
				try {
					const models = await this.fetchModels(ep);
					return { ep, models };
				} catch {
					return { ep, models: [] as LemonadeModel[] };
				}
			})
		);

		const infos: LanguageModelChatInformation[] = [];
		for (const { ep, models } of results) {
			for (const model of models) {
				const id = `${ep.shortname}/${model.id}`;
				infos.push({
					id,
					name: id,
					tooltip: `Lemonade node: ${ep.url}`,
					family: "lemonade",
					version: "1.0.0",
					maxInputTokens: maxInput,
					maxOutputTokens: maxOutput,
					capabilities: {
						toolCalling: true,
						imageInput: false,
					},
				} satisfies LanguageModelChatInformation);
			}
		}

		if (infos.length === 0 && !options.silent) {
			vscode.window.showWarningMessage(
				"No models available from any Lemonade endpoint. Make sure at least one server is running. You can download it from lemonade-server.ai."
			);
		}

		return infos;
	}

	async provideLanguageModelChatInformation(
		options: { silent: boolean },
		_token: CancellationToken
	): Promise<LanguageModelChatInformation[]> {
		return this.prepareLanguageModelChatInformation({ silent: options.silent ?? false }, _token);
	}

	/**
	 * Return the list of configured endpoints. Falls back to a single default
	 * endpoint when nothing has been configured yet, and migrates legacy
	 * single-URL secrets on first access.
	 */
	async getEndpoints(): Promise<LemonadeEndpoint[]> {
		// Migration: promote legacy single-URL secrets to the new format
		const legacyUrl = await this.secrets.get("lemonade.serverUrl");
		if (legacyUrl) {
			const legacyKey = await this.secrets.get("lemonade.apiKey");
			const migrated: LemonadeEndpoint[] = [{
				shortname: "default",
				url: legacyUrl,
				...(legacyKey ? { apiKey: legacyKey } : {}),
			}];
			await this.secrets.store(ENDPOINTS_SECRET_KEY, JSON.stringify(migrated));
			await this.secrets.delete("lemonade.serverUrl");
			await this.secrets.delete("lemonade.apiKey");
			return migrated;
		}

		const stored = await this.secrets.get(ENDPOINTS_SECRET_KEY);
		if (stored) {
			try {
				const parsed = JSON.parse(stored) as LemonadeEndpoint[];
				if (Array.isArray(parsed) && parsed.length > 0) {
					return parsed;
				}
			} catch {
				// fall through to default
			}
		}

		// No config yet — return built-in default so extension works out of the box
		return [{ shortname: "default", url: DEFAULT_BASE_URL }];
	}

	/**
	 * Fetch the list of available models from the Lemonade server.
	 */
	private async fetchModels(endpoint: LemonadeEndpoint): Promise<LemonadeModel[]> {
		const apiKey = endpoint.apiKey || DEFAULT_API_KEY;
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), resolveRequestTimeout());

		try {
			const response = await fetch(`${endpoint.url}/models`, {
				method: "GET",
				headers: {
					Authorization: `Bearer ${apiKey}`,
					"User-Agent": this.userAgent,
				},
				signal: controller.signal,
			});

			if (!response.ok) {
				throw new Error(`[Lemonade] Failed to fetch models from ${endpoint.shortname}: ${response.status} ${response.statusText}`);
				}

			const data = (await response.json()) as LemonadeModelsResponse;
			return data.data || [];
		} finally {
			clearTimeout(timeoutId);
		}
	}

	/**
	 * Returns the response for a chat request, passing the results to the progress callback.
	 * The {@linkcode LanguageModelChatProvider} must emit the response parts to the progress callback as they are received from the language model.
	 * @param model The language model to use
	 * @param messages The messages to include in the request
	 * @param options Options for the request
	 * @param progress The progress to emit the streamed response chunks to
	 * @param token A cancellation token for the request
	 * @returns A promise that resolves when the response is complete. Results are actually passed to the progress callback.
	 */
	async provideLanguageModelChatResponse(
		model: LanguageModelChatInformation,
		messages: readonly LanguageModelChatMessage[],
		options: LanguageModelChatRequestHandleOptions,
		progress: Progress<LanguageModelResponsePart>,
		token: CancellationToken
	): Promise<void> {

		this._toolCallBuffers.clear();
		this._completedToolCallIndices.clear();
		this._staleChunkCount = 0;
		this._hasEmittedAssistantText = false;
		this._emittedBeginToolCallsHint = false;
        this._textToolParserBuffer = "";
        this._textToolActive = undefined;
        this._emittedTextToolCallKeys.clear();
        this._emittedTextToolCallIds.clear();
		this._controlTokenBuffer = "";

		// Capture the current generation — if the user switches models VS Code
		// will start a new request with a new generation; responses from the
		// old request are discarded via processStreamingResponse.
		const currentGeneration = ++this._requestGeneration;
		let finalUsage: Record<string, unknown> = {};

		let requestBody: Record<string, unknown> | undefined;
		const trackingProgress: Progress<LanguageModelResponsePart> = {
			report: (part) => {
				try {
					progress.report(part);
				} catch (e) {
					this.outputChannel.appendLine(`[${this._ts()}] [ERROR] Progress.report failed: ${e instanceof Error ? e.message : String(e)}`);
				}
			},
		};
		try {
			// Decode "<shortname>/<modelId>" from the model id
			const slashIdx = model.id.indexOf("/");
			const shortname = slashIdx >= 0 ? model.id.slice(0, slashIdx) : "default";
			const realModelId = slashIdx >= 0 ? model.id.slice(slashIdx + 1) : model.id;

			const endpoints = await this.getEndpoints();
			const endpoint = endpoints.find(ep => ep.shortname === shortname)
				?? endpoints[0]
				?? { shortname: "default", url: DEFAULT_BASE_URL };

			const baseUrl = endpoint.url;
			const apiKey = endpoint.apiKey || DEFAULT_API_KEY;

			// Check if ephemeral data filtering is enabled (default: true)
			const filterEphemeralSetting = await this.secrets.get("lemonade.filterEphemeralData");
			const filterEphemeral = filterEphemeralSetting !== "false";

            const log = (msg: string) => this.outputChannel.appendLine(`[${this._ts()}] ${msg}`);
            const openaiMessages = convertMessages(messages, filterEphemeral, log);

			validateRequest(messages, log);

            const toolConfig = convertTools(options, log);

        if (options.tools && options.tools.length > 128) {
            throw new Error("Cannot have more than 128 tools per request.");
        }

            const inputTokenCount = this.estimateMessagesTokens(messages);
            const toolTokenCount = this.estimateToolTokens(toolConfig.tools);
            const tokenLimit = Math.max(1, model.maxInputTokens);
            if (inputTokenCount + toolTokenCount > tokenLimit) {
                this.outputChannel.appendLine(`[${this._ts()}] [ERROR] Message exceeds token limit: ${inputTokenCount + toolTokenCount}/${tokenLimit}`);
                throw new Error("Message exceeds token limit.");
            }

            const maxOutputTokens = await resolveMaxOutputTokens();
            requestBody = {
                model: realModelId,
                messages: openaiMessages,
                stream: true,
                // Ask the server to include token usage in the final streamed
                // chunk. Without this, OpenAI-compatible endpoints omit `usage`
                // from the stream, so VS Code has no token stats to display.
                stream_options: { include_usage: true },
                max_tokens: Math.min(options.modelOptions?.max_tokens ?? maxOutputTokens, model.maxOutputTokens),
                temperature: options.modelOptions?.temperature ?? 0.7,
            };

			this.outputChannel.appendLine(`[${this._ts()}] [INFO] Request: model=${realModelId}, messages=${openaiMessages.length}, max_tokens=${(requestBody as Record<string, unknown>).max_tokens}, temperature=${(requestBody as Record<string, unknown>).temperature}`);

			// Allow-list model options
			if (options.modelOptions) {
				const mo = options.modelOptions as Record<string, unknown>;
				if (typeof mo.stop === "string" || Array.isArray(mo.stop)) {
					(requestBody as Record<string, unknown>).stop = mo.stop;
				}
				if (typeof mo.frequency_penalty === "number") {
					(requestBody as Record<string, unknown>).frequency_penalty = mo.frequency_penalty;
				}
				if (typeof mo.presence_penalty === "number") {
					(requestBody as Record<string, unknown>).presence_penalty = mo.presence_penalty;
				}
			}

			if (toolConfig.tools) {
				(requestBody as Record<string, unknown>).tools = toolConfig.tools;
			}
			if (toolConfig.tool_choice) {
				(requestBody as Record<string, unknown>).tool_choice = toolConfig.tool_choice;
			}
			const controller = new AbortController();
			    const requestTimeout = resolveRequestTimeout();
			    const timeoutId = setTimeout(() => {
				    this.outputChannel.appendLine(`[${this._ts()}] [WARN] HTTP request timeout (model=${model.id}, timeoutMs=${requestTimeout})`);
				    controller.abort();
			    }, requestTimeout);
			    const cancellationSubscription = token.onCancellationRequested(() => {
				    this.outputChannel.appendLine(`[${this._ts()}] [INFO] VS Code cancelled HTTP request (model=${model.id})`);
				    controller.abort();
			    });
			try {
				const response = await fetch(`${baseUrl}/chat/completions`, {
					method: "POST",
					headers: {
						Authorization: `Bearer ${apiKey}`,
						"Content-Type": "application/json",
						"User-Agent": this.userAgent,
					},
					body: JSON.stringify(requestBody),
					signal: controller.signal,
				});

				this.outputChannel.appendLine(`[${this._ts()}] [INFO] Response: status=${response.status} ${response.statusText}`);

				if (!response.ok) {
					const errorText = await response.text();
					this.outputChannel.appendLine(`[${this._ts()}] [ERROR] API error response: ${errorText}`);
					throw new Error(
						`Lemonade API error: ${response.status} ${response.statusText}${errorText ? `\n${errorText}` : ""}`
					);
				}

				if (!response.body) {
					throw new Error("No response body from Lemonade API");
				}
				this.outputChannel.appendLine(`[${this._ts()}] [INFO] Starting streaming response for model ${realModelId}`);
				await this.processStreamingResponse(response.body, trackingProgress, token, currentGeneration, finalUsage);
				// Only report usage when the server actually returned token
				// counts. VS Code reads `prompt_tokens`/`completion_tokens`
				// (snake_case) from this part to render token stats.
				if (this.hasUsage(finalUsage)) {
					trackingProgress.report(new vscode.LanguageModelDataPart(
						new TextEncoder().encode(JSON.stringify(finalUsage)),
						'usage'
					));
					this.outputChannel.appendLine(`[${this._ts()}] [INFO] Reported usage: ${JSON.stringify(finalUsage)}`);
				} else {
					this.outputChannel.appendLine(`[${this._ts()}] [WARN] No usage data in streaming response; token stats will not be shown`);
				}
			} finally {
				cancellationSubscription.dispose();
				clearTimeout(timeoutId);
			}
		} catch (err) {
			const errMsg = err instanceof Error ? err.message : String(err);
			// Abort errors are expected when VS Code cancels the request (user types a new message,
			// switches models, etc.). Swallow them silently — they're not real failures.
			if (errMsg.includes("aborted") || errMsg.includes("abort") || errMsg.includes("cancel")) {
				this.outputChannel.appendLine(`[${this._ts()}] [INFO] Request aborted (VS Code LM API cancelled)`);
				return;
			}
			this.outputChannel.appendLine(`[${this._ts()}] [ERROR] Chat request failed: model=${model.id}, messages=${messages.length}, error=${errMsg}`);
			throw err;
		}
	}

	/**
	 * Returns the number of tokens for a given text using the model specific tokenizer logic
	 * @param model The language model to use
	 * @param text The text to count tokens for
	 * @param token A cancellation token for the request
	 * @returns A promise that resolves to the number of tokens
	 */
	async provideTokenCount(
		model: LanguageModelChatInformation,
		text: string | LanguageModelChatMessage,
		_token: CancellationToken
	): Promise<number> {
		if (typeof text === "string") {
			return Math.ceil(text.length / 4);
		} else {
			let totalTokens = 0;
			for (const part of text.content) {
				if (part instanceof vscode.LanguageModelTextPart) {
					totalTokens += Math.ceil(part.value.length / 4);
				}
			}
			return totalTokens;
		}
	}

	/**
	 * Read and parse the Lemonade server streaming (SSE-like) response and report parts.
	 * @param responseBody The readable stream body.
	 * @param progress Progress reporter for streamed parts.
	 * @param token Cancellation token.
	 * @param generation The request generation captured at call start. Responses from
	 *   older generations (stale requests from model switches) are discarded.
	 */
    private async processStreamingResponse(
        responseBody: ReadableStream<Uint8Array>,
        progress: vscode.Progress<vscode.LanguageModelResponsePart>,
        token: vscode.CancellationToken,
        generation: number,
        usageAccumulator?: Record<string, unknown>,
    ): Promise<void> {
        const reader = responseBody.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

		try {
			while (!token.isCancellationRequested) {
				const { done, value } = await reader.read();
                if (done) { break; }

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";

				for (const line of lines) {
					if (!line.startsWith("data: ")) {
						continue;
					}
					const data = line.slice(6);
                    if (data === "[DONE]") {
                        // Check if this request is still the active one
                        if (generation !== this._requestGeneration) {
                            this.outputChannel.appendLine(`[${this._ts()}] [WARN] [DONE] Stale request discarded (generation ${generation} vs current ${this._requestGeneration})`);
                            return; // Stale — discard entirely
                        }
                        this.outputChannel.appendLine(`[${this._ts()}] [INFO] Stream completed with [DONE]`);
                        // Do not throw on [DONE]; any incomplete/empty buffers are ignored.
                        await this.flushToolCallBuffers(progress, /*throwOnInvalid*/ false);
                        // Flush any in-progress text-embedded tool call (silent if incomplete)
                        await this.flushActiveTextToolCall(progress);
                        continue;
                    }

					try {
						const parsed = JSON.parse(data);
						const error = parsed.error as Record<string, unknown> | undefined;
						if (error && typeof error.message === "string") {
							throw new Error(`Lemonade streaming error: ${error.message}`);
						}
						// Discard responses from stale requests (model was switched mid-stream)
						if (generation !== this._requestGeneration) {
							this._staleChunkCount++;
							if (this._staleChunkCount <= this._maxStaleWarnings) {
								this.outputChannel.appendLine(`[${this._ts()}] [WARN] Stale SSE chunk discarded (generation ${generation} vs current ${this._requestGeneration})`);
							} else if (this._staleChunkCount === this._maxStaleWarnings + 1) {
								this.outputChannel.appendLine(`[${this._ts()}] [WARN] Stale SSE chunk discard count exceeded ${this._maxStaleWarnings}; suppressing further warnings`);
							}
							continue;
						}
						// Extract usage data from the response chunk (typically in the last chunk before [DONE])
						const usage = (parsed as Record<string, unknown>).usage as Record<string, unknown> | undefined;
						if (usage && usageAccumulator) {
							Object.assign(usageAccumulator, usage);
						}
                        await this.processDelta(parsed, progress);
					} catch (error) {
						if (error instanceof SyntaxError) {
							// Ignore malformed SSE lines until the server finishes the stream.
							continue;
						}
						throw error;
                    }
                }
            }
        } finally {
            reader.releaseLock();
            if (token.isCancellationRequested) {
                this.outputChannel.appendLine(`[${this._ts()}] [WARN] Stream cancelled (VS Code LM API internal cancellation)`);
            } else {
                this.outputChannel.appendLine(`[${this._ts()}] [INFO] Stream reader closed (no [DONE] received)`);
            }
            // Clean up any leftover tool call state
            this._toolCallBuffers.clear();
            this._completedToolCallIndices.clear();
            this._staleChunkCount = 0;
            this._hasEmittedAssistantText = false;
            this._emittedBeginToolCallsHint = false;
            this._textToolParserBuffer = "";
            this._textToolActive = undefined;
            this._emittedTextToolCallKeys.clear();
			this._emittedTextToolCallIds.clear();
			this._controlTokenBuffer = "";
        }
    }

	/**
	 * Handle a single streamed delta chunk, emitting text and tool call parts.
	 * @param delta Parsed SSE chunk from the Router.
	 * @param progress Progress reporter for parts.
	 */
    private async processDelta(
        delta: Record<string, unknown>,
        progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    ): Promise<boolean> {
        let emitted = false;
        const choice = (delta.choices as Record<string, unknown>[] | undefined)?.[0];
        if (!choice) { return false; }

		const deltaObj = choice.delta as Record<string, unknown> | undefined;

		// report thinking progress if backend provides it and host supports it
		// Backend may use either 'thinking' (standard) or 'reasoning_content' (llama.cpp deepseek)
		try {
			const maybeThinking = (choice as Record<string, unknown> | undefined)?.thinking 
				?? (deltaObj as Record<string, unknown> | undefined)?.thinking 
				?? (choice as Record<string, unknown> | undefined)?.reasoning_content 
				?? (deltaObj as Record<string, unknown> | undefined)?.reasoning_content;
			if (maybeThinking !== undefined) {
				const vsAny = (vscode as unknown as Record<string, unknown>);
				const ThinkingCtor = vsAny["LanguageModelThinkingPart"] as
					| (new (text: string, id?: string, metadata?: unknown) => unknown)
					| undefined;
                    if (ThinkingCtor) {
                        let text = "";
                        let id: string | undefined;
                        let metadata: unknown;
                        if (maybeThinking && typeof maybeThinking === "object") {
                            const mt = maybeThinking as Record<string, unknown>;
                            text = typeof mt["text"] === "string" ? (mt["text"] as string) : "";
                            id = typeof mt["id"] === "string" ? (mt["id"] as string) : undefined;
                            metadata = mt["metadata"];
                        } else if (typeof maybeThinking === "string") {
                            text = maybeThinking;
                        }
                        if (text) {
                            progress.report(new (ThinkingCtor as new (text: string, id?: string, metadata?: unknown) => unknown)(text, id, metadata) as unknown as vscode.LanguageModelResponsePart);
                            emitted = true;
                        }
                    }
                }
            } catch {
                // ignore errors here temporarily
            }
            if (deltaObj?.content) {
                const content = String(deltaObj.content);
                const res = this.processTextContent(content, progress);
                if (res.emittedText) {
                    this._hasEmittedAssistantText = true;
                }
                if (res.emittedAny) {
                    emitted = true;
                }
            }

			if (deltaObj?.tool_calls) {
                const toolCalls = deltaObj.tool_calls as Array<Record<string, unknown>>;

				// SSEProcessor-like: if first tool call appears after text, emit a whitespace
				// to ensure any UI buffers/linkifiers are flushed without adding visible noise.
				if (!this._emittedBeginToolCallsHint && this._hasEmittedAssistantText && toolCalls.length > 0) {
					progress.report(new vscode.LanguageModelTextPart(" "));
					this._emittedBeginToolCallsHint = true;
				}

				for (const tc of toolCalls) {
					const idx = (tc.index as number) ?? 0;
					// Ignore any further deltas for an index we've already completed
					if (this._completedToolCallIndices.has(idx)) {
						continue;
					}
					const buf = this._toolCallBuffers.get(idx) ?? { args: "" };
					if (tc.id && typeof tc.id === "string") {
						buf.id = tc.id as string;
					}
					const func = tc.function as Record<string, unknown> | undefined;
					if (func?.name && typeof func.name === "string") {
						buf.name = func.name as string;
					}
					if (typeof func?.arguments === "string") {
						buf.args += func.arguments as string;
					}
					this._toolCallBuffers.set(idx, buf);

					// Emit immediately once arguments become valid JSON to avoid perceived hanging
                    await this.tryEmitBufferedToolCall(idx, progress);
                }
            }

        const finish = (choice.finish_reason as string | undefined) ?? undefined;
        if (finish === "tool_calls" || finish === "stop") {
            // On both 'tool_calls' and 'stop', emit any buffered calls and throw on invalid JSON
            await this.flushToolCallBuffers(progress, /*throwOnInvalid*/ true);
        }
        return emitted;
    }

	/**
	 * Strip control tokens with buffering to handle tokens split across chunks.
	 * This handles older-style control tokens like <tool_call> and <function=...
	 */
	private stripControlTokensWithBuffering(text: string): string {
		let data = this._controlTokenBuffer + text;
		let result = "";
		let pos = 0;

		while (pos < data.length) {
			let foundMatch = false;

			// Check for complete control token patterns
			const controlPatterns = [
				/<tool_call>/g,
				/<\/function>/g,
				/<\|tool_calls_section_(?:begin|end)\|>/g,
				/<\|tool_call_(?:argument_)?(?:begin|end)\|>/g,
				/<function=[a-zA-Z0-9_\-.]+>/g  // Match complete function tags
			];

			// Try to match any control pattern at current position
			for (const pattern of controlPatterns) {
				pattern.lastIndex = 0; // Reset regex state
				const remaining = data.slice(pos);
				const match = pattern.exec(remaining);

				if (match && match.index === 0) {
					// Found a complete token at current position, skip it
					pos += match[0].length;
					foundMatch = true;
					break;
				}
			}

			if (!foundMatch) {
				// Check for potential incomplete control tokens near end of chunk
				let isPartialToken = false;
				if (pos >= data.length - 50) { // Check last 50 chars for partial tokens
					const remaining = data.slice(pos);

					// Check for partial patterns that could complete in next chunk
					const partialPatterns = [
						/^<tool_cal?$/,
						/^<tool_call?$/,
						/^<\|tool_calls?$/,
						/^<\|tool_calls_section?$/,
						/^<\|tool_calls_section_(?:begin|end)?$/,
						/^<\|tool_call?$/,
						/^<\|tool_call_(?:argument_)?$/,
						/^<\|tool_call_(?:argument_)?(?:begin|end)?$/,
						/^<function?$/,
						/^<function=?$/,
						/^<function=[a-zA-Z0-9_\-.]*$/,  // Partial function name
						/^<\/function?$/
					];

					for (const pattern of partialPatterns) {
						if (pattern.test(remaining)) {
							isPartialToken = true;
							break;
						}
					}
				}

				if (isPartialToken) {
					// Keep remaining text in buffer for next chunk
					this._controlTokenBuffer = data.slice(pos);
					break;
				} else {
					// Safe to emit this character
					result += data[pos];
					pos++;
				}
			}
		}

		// If we consumed everything, clear the buffer
		if (pos >= data.length) {
			this._controlTokenBuffer = "";
		}

		return result;
	}

    /**
     * Process streamed text content for inline tool-call control tokens and emit text/tool calls.
     * Returns which parts were emitted for logging/flow control.
     */
    private processTextContent(
        input: string,
        progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    ): { emittedText: boolean; emittedAny: boolean } {
        const BEGIN = "<|tool_call_begin|>";
        const ARG_BEGIN = "<|tool_call_argument_begin|>";
        const END = "<|tool_call_end|>";

        let data = this._textToolParserBuffer + input;
        let emittedText = false;
        let emittedAny = false;
        let visibleOut = "";

        while (data.length > 0) {
            if (!this._textToolActive) {
                const b = data.indexOf(BEGIN);
                if (b === -1) {
                    // No tool-call start: emit visible portion, but keep any partial BEGIN prefix as buffer
                    const longestPartialPrefix = ((): number => {
                        for (let k = Math.min(BEGIN.length - 1, data.length - 1); k > 0; k--) {
                            if (data.endsWith(BEGIN.slice(0, k))) { return k; }
                        }
                        return 0;
                    })();
                    if (longestPartialPrefix > 0) {
                        const visible = data.slice(0, data.length - longestPartialPrefix);
                        if (visible) { visibleOut += this.stripControlTokensWithBuffering(visible); }
                        this._textToolParserBuffer = data.slice(data.length - longestPartialPrefix);
                        data = "";
                        break;
                    } else {
                        // All visible, clean other control tokens with buffering
                        visibleOut += this.stripControlTokensWithBuffering(data);
                        data = "";
                        break;
                    }
                }
                // Emit text before the token
                const pre = data.slice(0, b);
                if (pre) {
                    visibleOut += this.stripControlTokensWithBuffering(pre);
                }
                // Advance past BEGIN
                data = data.slice(b + BEGIN.length);

                // Find the delimiter that ends the name/index segment
                const a = data.indexOf(ARG_BEGIN);
                const e = data.indexOf(END);
                let delimIdx = -1;
                let delimKind: "arg" | "end" | undefined = undefined;
                if (a !== -1 && (e === -1 || a < e)) { delimIdx = a; delimKind = "arg"; }
                else if (e !== -1) { delimIdx = e; delimKind = "end"; }
                else {
                    // Incomplete header; keep for next chunk (re-add BEGIN so we don't lose it)
                    this._textToolParserBuffer = BEGIN + data;
                    data = "";
                    break;
                }

                const header = data.slice(0, delimIdx).trim();
                const m = header.match(/^([A-Za-z0-9_\-.]+)(?::(\d+))?/);
                const name = m?.[1] ?? undefined;
                const index = m?.[2] ? Number(m?.[2]) : undefined;
                this._textToolActive = { name, index, argBuffer: "", emitted: false };
                // Advance past delimiter token
                if (delimKind === "arg") {
                    data = data.slice(delimIdx + ARG_BEGIN.length);
                } else /* end */ {
                    // No args, finalize immediately
                    data = data.slice(delimIdx + END.length);
                    const did = this.emitTextToolCallIfValid(progress, this._textToolActive, "{}");
                    if (did) {
                        this._textToolActive.emitted = true;
                        emittedAny = true;
                    }
                    this._textToolActive = undefined;
                }
                continue;
            }

            // We are inside arguments, collect until END and emit as soon as JSON becomes valid
            const e2 = data.indexOf(END);
            if (e2 === -1) {
                // No end marker yet, accumulate and check for early valid JSON
                this._textToolActive.argBuffer += data;
                // Early emit when JSON becomes valid and we haven't emitted yet
                if (!this._textToolActive.emitted) {
                    const did = this.emitTextToolCallIfValid(progress, this._textToolActive, this._textToolActive.argBuffer);
                    if (did) {
                        this._textToolActive.emitted = true;
                        emittedAny = true;
                    }
                }
                data = "";
                break;
            } else {
                this._textToolActive.argBuffer += data.slice(0, e2);
                // Consume END
                data = data.slice(e2 + END.length);
                // Final attempt to emit if not already
                if (!this._textToolActive.emitted) {
                    const did = this.emitTextToolCallIfValid(progress, this._textToolActive, this._textToolActive.argBuffer);
                    if (did) {
                        emittedAny = true;
                    }
                }
                this._textToolActive = undefined;
                continue;
            }
        }

        // Emit any visible text
        const textToEmit = visibleOut;
        if (textToEmit && textToEmit.length > 0) {
            progress.report(new vscode.LanguageModelTextPart(textToEmit));
            emittedText = true;
            emittedAny = true;
        }

        // Store leftover for next chunk
        this._textToolParserBuffer = data;

        return { emittedText, emittedAny };
    }

    private emitTextToolCallIfValid(
        progress: vscode.Progress<vscode.LanguageModelResponsePart>,
        call: { name?: string; index?: number; argBuffer: string; emitted?: boolean },
        argText: string,
    ): boolean {
        const name = call.name ?? "unknown_tool";
        const parsed = tryParseJSONObject(argText);
        if (!parsed.ok) {
            return false;
        }
        const canonical = JSON.stringify(parsed.value);
        const key = `${name}:${canonical}`;
        // identity-based dedupe when index is present
        if (typeof call.index === "number") {
            const idKey = `${name}:${call.index}`;
            if (this._emittedTextToolCallIds.has(idKey)) {
                return false;
            }
            // Mark identity as emitted
            this._emittedTextToolCallIds.add(idKey);
        } else if (this._emittedTextToolCallKeys.has(key)) {
            return false;
        }
        this._emittedTextToolCallKeys.add(key);
        const id = `tct_${Math.random().toString(36).slice(2, 10)}`;
        progress.report(new vscode.LanguageModelToolCallPart(id, name, parsed.value));
        return true;
    }

    private async flushActiveTextToolCall(
        progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    ): Promise<void> {
        if (!this._textToolActive) {
            return;
        }
        const argText = this._textToolActive.argBuffer;
        const parsed = tryParseJSONObject(argText);
        if (!parsed.ok) {
            return;
        }
        // Emit (dedupe ensures we don't double-emit)
        this.emitTextToolCallIfValid(progress, this._textToolActive, argText);
        this._textToolActive = undefined;
    }

	/**
	 * Try to emit a buffered tool call when a valid name and JSON arguments are available.
	 * @param index The tool call index from the stream.
	 * @param progress Progress reporter for parts.
	 */
    private async tryEmitBufferedToolCall(
        index: number,
        progress: vscode.Progress<vscode.LanguageModelResponsePart>
    ): Promise<void> {
        const buf = this._toolCallBuffers.get(index);
        if (!buf) {
            return;
        }
        if (!buf.name) {
            return;
        }
        const canParse = tryParseJSONObject(buf.args);
        if (!canParse.ok) {
            return;
        }
        const id = buf.id ?? `call_${Math.random().toString(36).slice(2, 10)}`;
        const parameters = canParse.value;
        try {
            const canonical = JSON.stringify(parameters);
            this._emittedTextToolCallKeys.add(`${buf.name}:${canonical}`);
        } catch { /* ignore */ }
        progress.report(new vscode.LanguageModelToolCallPart(id, buf.name, parameters));
        this._toolCallBuffers.delete(index);
        this._completedToolCallIndices.add(index);
    }

	/**
	 * Flush all buffered tool calls, optionally throwing if arguments are not valid JSON.
	 * @param progress Progress reporter for parts.
	 * @param throwOnInvalid If true, throw when a tool call has invalid JSON args.
	 */
    private async flushToolCallBuffers(
        progress: vscode.Progress<vscode.LanguageModelResponsePart>,
        throwOnInvalid: boolean,
    ): Promise<void> {
        if (this._toolCallBuffers.size === 0) {
            return;
        }
        for (const [idx, buf] of Array.from(this._toolCallBuffers.entries())) {
            const parsed = tryParseJSONObject(buf.args);
            if (!parsed.ok) {
                if (throwOnInvalid) {
                    this.outputChannel.appendLine(`[${this._ts()}] [ERROR] Invalid JSON for tool call (idx=${idx}): ${(buf.args || "").slice(0, 200)}`);
                    throw new Error("Invalid JSON for tool call");
                }
                // When not throwing (e.g. on [DONE]), drop silently to reduce noise
                continue;
            }
            const id = buf.id ?? `call_${Math.random().toString(36).slice(2, 10)}`;
            const name = buf.name ?? "unknown_tool";
            try {
                const canonical = JSON.stringify(parsed.value);
                this._emittedTextToolCallKeys.add(`${name}:${canonical}`);
            } catch { /* ignore */ }
            progress.report(new vscode.LanguageModelToolCallPart(id, name, parsed.value));
            this._toolCallBuffers.delete(idx);
            this._completedToolCallIndices.add(idx);
        }
    }

}