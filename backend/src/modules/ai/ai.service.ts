/**
 * AI Service — 100% Native Google Gemini 2.5 Provider
 *
 * Built with @google/generative-ai SDK.
 * Primary models:
 *  - Gemini 2.5 Pro (Deep reasoning, multi-agent problem solving, research, exam clone, Feynman evaluation)
 *  - Gemini 2.5 Flash (Low-latency streaming, quizzes, flashcards, mind maps, chat)
 *  - Gemini Multimodal Vision & Audio (Inline image analysis, camera scan, audio transcription)
 */

import {
  Injectable,
  Logger,
  BadRequestException,
  HttpException,
  HttpStatus,
  OnModuleInit,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleGenerativeAI, Content, Part } from '@google/generative-ai';
import { DatabaseService } from '../database/database.service';
import { v4 as uuidv4 } from 'uuid';

export const DEFAULT_PRO_MODEL = 'gemini-2.5-pro';
export const DEFAULT_FLASH_MODEL = 'gemini-2.5-flash';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface CompletionOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  stream?: boolean;
  responseFormat?: { type: 'json_object' | 'text' };
  systemInstruction?: string;
}

export interface CompletionResponse {
  content: string;
  model: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export interface TranscriptionResponse {
  text: string;
  duration?: number;
  language?: string;
}

@Injectable()
export class AiService implements OnModuleInit {
  private readonly logger = new Logger(AiService.name);
  private genAI: GoogleGenerativeAI | null = null;
  private defaultProModel: string;
  private defaultFlashModel: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly db: DatabaseService,
  ) {
    // GEMINI_MODEL is the documented deployment variable. Keep the more
    // specific variables as overrides, but honour GEMINI_MODEL so production
    // deployments do not silently run a different model than configured.
    const configuredModel = this.configService.get<string>('GEMINI_MODEL');
    this.defaultProModel = this.configService.get<string>(
      'GEMINI_PRO_MODEL',
      configuredModel?.includes('pro') ? configuredModel : DEFAULT_PRO_MODEL,
    );
    this.defaultFlashModel = this.configService.get<string>(
      'GEMINI_FLASH_MODEL',
      configuredModel && !configuredModel.includes('pro') ? configuredModel : DEFAULT_FLASH_MODEL,
    );
  }

  async onModuleInit() {
    this.initializeClient();
  }

  private initializeClient() {
    const apiKey =
      this.configService.get<string>('GEMINI_API_KEY') ||
      this.configService.get<string>('GOOGLE_API_KEY');

    if (apiKey && !apiKey.includes('your-')) {
      this.genAI = new GoogleGenerativeAI(apiKey);
      this.logger.log(
        `Google Gemini 2.5 SDK initialized (Pro: ${this.defaultProModel}, Flash: ${this.defaultFlashModel})`,
      );
    } else {
      this.logger.warn('GEMINI_API_KEY / GOOGLE_API_KEY missing or unconfigured in environment.');
    }
  }

  private getClient(): GoogleGenerativeAI {
    if (!this.genAI) {
      this.initializeClient();
    }
    if (!this.genAI) {
      throw new BadRequestException(
        'Gemini API key is not configured. Please set GEMINI_API_KEY in your backend .env file.',
      );
    }
    return this.genAI;
  }

  getModel(type: 'pro' | 'flash' | 'text' | 'vision' = 'flash'): string {
    if (type === 'pro') {
      return this.configService.get<string>('GEMINI_PRO_MODEL', this.defaultProModel);
    }
    return this.configService.get<string>('GEMINI_FLASH_MODEL', this.defaultFlashModel);
  }

  private providerException(error: Error): HttpException {
    const message = error.message || '';
    if (/\b429\b|quota|rate limit/i.test(message)) {
      const retrySeconds = message.match(/retry in\s+(\d+)/i)?.[1];
      const retryHint = retrySeconds
        ? ` Please try again in about ${retrySeconds} seconds.`
        : ' Please try again in a few minutes.';
      return new HttpException(
        `The AI request limit has been reached.${retryHint}`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    this.logger.error(`Gemini provider error: ${message}`);
    return new BadRequestException(
      'The AI service could not process this request. Please try again.',
    );
  }

  private retryDelayMs(error: unknown): number | null {
    if (!(error instanceof HttpException) || error.getStatus() !== HttpStatus.TOO_MANY_REQUESTS) {
      return null;
    }

    const response = error.getResponse();
    const message =
      typeof response === 'string'
        ? response
        : String((response as Record<string, unknown>).message || '');
    const seconds = Number(message.match(/about\s+(\d+)\s+seconds/i)?.[1]);
    return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 45) * 1000 : null;
  }

  /**
   * Complete prompt or chat conversation using Gemini 2.5
   */
  async complete(
    messages: ChatMessage[],
    options: CompletionOptions = {},
  ): Promise<CompletionResponse> {
    const genAI = this.getClient();
    const modelName =
      options.model || this.getModel(options.model?.includes('pro') ? 'pro' : 'flash');

    let systemInstruction = options.systemInstruction;
    const contents: Content[] = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        systemInstruction = systemInstruction
          ? `${systemInstruction}\n\n${msg.content}`
          : msg.content;
      } else {
        contents.push({
          role: msg.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: msg.content }],
        });
      }
    }

    try {
      const model = genAI.getGenerativeModel({
        model: modelName,
        systemInstruction: systemInstruction
          ? { role: 'system', parts: [{ text: systemInstruction }] }
          : undefined,
        generationConfig: {
          temperature: options.temperature ?? 0.7,
          maxOutputTokens: options.maxTokens ?? 8192,
          topP: options.topP ?? 0.95,
          responseMimeType:
            options.responseFormat?.type === 'json_object' ? 'application/json' : 'text/plain',
        },
      });

      const responseResult = await model.generateContent({
        contents: contents.length > 0 ? contents : [{ role: 'user', parts: [{ text: 'Hello' }] }],
      });

      const content = responseResult.response.text() || '';
      const usage = responseResult.response.usageMetadata;

      return {
        content,
        model: modelName,
        usage: {
          promptTokens: usage?.promptTokenCount || 0,
          completionTokens: usage?.candidatesTokenCount || 0,
          totalTokens: usage?.totalTokenCount || 0,
        },
      };
    } catch (error: unknown) {
      const err = error as Error;
      if (modelName.includes('pro') && (err.message.includes('429') || err.message.includes('Quota') || err.message.includes('quota'))) {
        const fallbackModel = this.getModel('flash');
        this.logger.warn(`Gemini Pro quota exceeded, falling back to ${fallbackModel}: ${err.message}`);
        return this.complete(messages, { ...options, model: fallbackModel });
      }
      this.logger.error(`Gemini completion failed [Model: ${modelName}]: ${err.message}`);
      throw this.providerException(err);
    }
  }

  /**
   * Gemini Multimodal Vision analysis (Images, Diagrams, Camera Scans)
   */
  async generateWithVision(params: {
    prompt: string;
    imageData: string; // Base64 encoded string
    mimeType: string;
    temperature?: number;
    maxTokens?: number;
  }): Promise<string> {
    const genAI = this.getClient();
    const modelName = this.getModel('flash');

    try {
      const model = genAI.getGenerativeModel({
        model: modelName,
        generationConfig: {
          temperature: params.temperature ?? 0.2,
          maxOutputTokens: params.maxTokens ?? 8192,
        },
      });

      const imagePart: Part = {
        inlineData: {
          data: params.imageData,
          mimeType: params.mimeType,
        },
      };

      const result = await model.generateContent([params.prompt, imagePart]);
      return result.response.text() || '';
    } catch (error: unknown) {
      const err = error as Error;
      this.logger.error(`Gemini Vision analysis failed: ${err.message}`);
      throw this.providerException(err);
    }
  }

  /**
   * Structured JSON completion with raw response logging, markdown fence stripping,
   * boundary extraction, trailing comma cleanup, truncated JSON repair, and automatic retries.
   */
  async completeJson<T>(messages: ChatMessage[], options: CompletionOptions = {}): Promise<T> {
    const maxRetries = 2;
    let lastError: Error | null = null;
    let lastRawResponse = '';

    const modelName =
      options.model || this.getModel(options.model?.includes('pro') ? 'pro' : 'flash');

    for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
      try {
        const currentMessages = [...messages];
        const currentOptions: CompletionOptions = {
          ...options,
          maxTokens: options.maxTokens || 8192,
          responseFormat: { type: 'json_object' },
        };

        if (attempt > 1) {
          currentMessages.push({
            role: 'user',
            content:
              'CRITICAL NOTICE: Your previous response could not be parsed as valid JSON or was truncated. Return ONLY valid, complete JSON adhering strictly to the requested schema. Do NOT use markdown code blocks or additional text. Keep string fields concise so the JSON is not cut off.',
          });
        }

        const response = await this.complete(currentMessages, currentOptions);
        lastRawResponse = response.content || '';

        // REQUIREMENT 1: Log the COMPLETE raw Gemini response before parsing
        this.logger.log(
          `Raw Gemini JSON Response [Model: ${modelName}, Attempt: ${attempt}/${maxRetries + 1}, Tokens: ${response.usage.completionTokens}, Length: ${lastRawResponse.length}]:\n${lastRawResponse}`,
        );

        // REQUIREMENT 2 & 10: Strip fences, extract boundaries, sanitize, & repair truncated JSON
        const parsed = extractAndRepairJson<T>(lastRawResponse);
        return parsed;
      } catch (error: any) {
        const retryDelay = this.retryDelayMs(error);
        if (retryDelay && attempt <= maxRetries) {
          this.logger.warn(
            `Gemini request rate-limited. Retrying attempt ${attempt + 1}/${maxRetries + 1} in ${retryDelay / 1000}s.`,
          );
          await new Promise((resolve) => setTimeout(resolve, retryDelay));
          continue;
        }
        if (error instanceof HttpException) {
          throw error;
        }
        lastError = error;
        this.logger.warn(
          `Gemini completeJson attempt ${attempt}/${maxRetries + 1} failed: ${error.message}`,
        );
      }
    }

    // REQUIREMENT 5 & 9: Log full raw response before throwing exception
    this.logger.error(
      `ALL ${maxRetries + 1} RETRIES FAILED to parse Gemini JSON output. Full Raw Response:\n${lastRawResponse}`,
    );
    throw new BadRequestException(
      `Failed to parse Gemini AI response as structured JSON after ${maxRetries + 1} attempts: ${lastError?.message || 'Malformed JSON'}`,
    );
  }

  /**
   * Stream completion using Gemini 2.5 for low-latency real-time response
   */
  async *streamComplete(
    messages: ChatMessage[],
    options: CompletionOptions = {},
  ): AsyncGenerator<{ content: string; done: boolean }> {
    const genAI = this.getClient();
    const modelName = options.model || this.getModel('flash');

    let systemInstruction = options.systemInstruction;
    const contents: Content[] = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        systemInstruction = systemInstruction
          ? `${systemInstruction}\n\n${msg.content}`
          : msg.content;
      } else {
        contents.push({
          role: msg.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: msg.content }],
        });
      }
    }

    try {
      const model = genAI.getGenerativeModel({
        model: modelName,
        systemInstruction: systemInstruction
          ? { role: 'system', parts: [{ text: systemInstruction }] }
          : undefined,
        generationConfig: {
          temperature: options.temperature ?? 0.7,
          maxOutputTokens: options.maxTokens ?? 4096,
        },
      });

      const resultStream = await model.generateContentStream({ contents });

      for await (const chunk of resultStream.stream) {
        const text = chunk.text() || '';
        yield { content: text, done: false };
      }

      yield { content: '', done: true };
    } catch (error: unknown) {
      const err = error as Error;
      if (modelName.includes('pro') && (err.message.includes('429') || err.message.includes('Quota') || err.message.includes('quota'))) {
        const fallbackModel = this.getModel('flash');
        this.logger.warn(`Gemini Pro stream quota exceeded, falling back to ${fallbackModel}: ${err.message}`);
        yield* this.streamComplete(messages, { ...options, model: fallbackModel });
        return;
      }
      this.logger.error(`Gemini stream completion failed: ${err.message}`);
      throw this.providerException(err);
    }
  }

  /**
   * Native Gemini Audio Processing for transcription and explanation
   */
  async transcribeAudio(
    audioBuffer: Buffer,
    filename: string,
    mimeType: string,
  ): Promise<TranscriptionResponse> {
    const genAI = this.getClient();
    const modelName = this.getModel('flash');

    try {
      const model = genAI.getGenerativeModel({ model: modelName });
      const base64Audio = audioBuffer.toString('base64');
      const audioPart: Part = {
        inlineData: {
          data: base64Audio,
          mimeType: mimeType || 'audio/mp3',
        },
      };

      const result = await model.generateContent([
        'Provide an exact verbatim transcription of this audio. Output ONLY the raw transcript text with no extra commentary.',
        audioPart,
      ]);

      return {
        text: result.response.text() || '',
        language: 'Auto-detected by Gemini',
      };
    } catch (error: unknown) {
      const err = error as Error;
      this.logger.error(`Gemini Audio Perception failed: ${err.message}`);
      throw this.providerException(err);
    }
  }

  buildSystemPrompt(template: string, variables: Record<string, string>): string {
    let prompt = template;
    for (const [key, value] of Object.entries(variables)) {
      prompt = prompt.replace(new RegExp(`{{${key}}}`, 'g'), value);
    }
    return prompt;
  }

  async generateWithRetry(
    messages: ChatMessage[],
    options: CompletionOptions = {},
    maxRetries = 3,
  ): Promise<CompletionResponse> {
    let lastError: Error | null = null;

    for (let i = 0; i < maxRetries; i++) {
      try {
        return await this.complete(messages, options);
      } catch (error) {
        lastError = error as Error;
        this.logger.warn(`Gemini generation attempt ${i + 1} failed, retrying in ${i + 1}s...`);
        await new Promise((resolve) => setTimeout(resolve, 1000 * (i + 1)));
      }
    }

    throw lastError;
  }

  estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  isAvailable(): boolean {
    return this.genAI !== null;
  }

  getAvailableProviders(): string[] {
    return ['google-gemini-2.5'];
  }

  // ═══════════════════════════════════════════
  // Mind Map History Storage
  // ═══════════════════════════════════════════

  async saveMindMapToHistory(params: {
    userId: string;
    title: string;
    content: string;
    mindMapData: unknown;
    studySetId?: string;
    noteId?: string;
  }) {
    const id = uuidv4();

    await this.db.query(
      `INSERT INTO mind_maps (id, user_id, study_set_id, note_id, title, content_snapshot, mind_map_data, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
      [
        id,
        params.userId,
        params.studySetId || null,
        params.noteId || null,
        params.title,
        params.content,
        JSON.stringify(params.mindMapData),
      ],
    );

    this.logger.log(`Mind map saved to history: ${id}`);
    return { id };
  }

  async getMindMapHistory(userId: string) {
    const results = await this.db.queryMany(
      `SELECT id, title, study_set_id, note_id, created_at
       FROM mind_maps
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 50`,
      [userId],
    );

    return results.map((r) => ({
      id: (r as { id: string }).id,
      title: (r as { title: string }).title,
      studySetId: (r as { study_set_id: string | null }).study_set_id,
      noteId: (r as { note_id: string | null }).note_id,
      createdAt: (r as { created_at: Date }).created_at,
    }));
  }

  async getMindMapById(id: string, userId: string) {
    const result = await this.db.queryOne(`SELECT * FROM mind_maps WHERE id = $1`, [id]);

    if (!result) {
      throw new NotFoundException('Mind map not found');
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = result as any;
    if (r.user_id !== userId) {
      throw new ForbiddenException('Access denied');
    }

    return {
      id: r.id,
      title: r.title,
      contentSnapshot: r.content_snapshot,
      mindMapData:
        typeof r.mind_map_data === 'string' ? JSON.parse(r.mind_map_data) : r.mind_map_data,
      studySetId: r.study_set_id,
      noteId: r.note_id,
      createdAt: r.created_at,
    };
  }

  async deleteMindMap(id: string, userId: string) {
    const result = await this.db.queryOne(
      `DELETE FROM mind_maps WHERE id = $1 AND user_id = $2 RETURNING id`,
      [id, userId],
    );

    if (!result) {
      throw new NotFoundException('Mind map not found or access denied');
    }

    this.logger.log(`Mind map deleted: ${id}`);
  }
}

/**
 * Robustly extract, clean, and repair JSON strings from LLMs.
 * Handles:
 *  - Markdown code fences (```json ... ```)
 *  - Surrounding text/explanations
 *  - Trailing commas before } or ]
 *  - Control characters & unescaped line breaks
 *  - Truncated JSON responses (auto-closing open quotes, brackets, and braces)
 */

export function extractAndRepairJson<T = any>(rawInput: string): T {
  if (!rawInput || typeof rawInput !== 'string') {
    throw new Error('Input to extractAndRepairJson is empty or non-string');
  }

  let text = rawInput.trim();

  // 1. Strip Markdown code fences
  if (text.includes('```')) {
    text = text
      .replace(/```[a-zA-Z]*\n?/g, '')
      .replace(/```$/g, '')
      .trim();
  }

  // 2. Direct parse attempt
  try {
    return JSON.parse(text) as T;
  } catch (_) {
    // Continue to extraction & cleaning pipeline
  }

  // 3. Extract JSON object/array boundaries (first '{' or '[' to last '}' or ']')
  const firstBrace = text.indexOf('{');
  const firstBracket = text.indexOf('[');

  let startIndex = -1;
  let isArray = false;

  if (firstBrace !== -1 && firstBracket !== -1) {
    if (firstBrace < firstBracket) {
      startIndex = firstBrace;
      isArray = false;
    } else {
      startIndex = firstBracket;
      isArray = true;
    }
  } else if (firstBrace !== -1) {
    startIndex = firstBrace;
    isArray = false;
  } else if (firstBracket !== -1) {
    startIndex = firstBracket;
    isArray = true;
  }

  if (startIndex === -1) {
    throw new Error('No JSON object ({}) or array ([]) found in input');
  }

  const endChar = isArray ? ']' : '}';
  const lastIndex = text.lastIndexOf(endChar);

  let jsonCandidate = '';
  if (lastIndex > startIndex) {
    jsonCandidate = text.substring(startIndex, lastIndex + 1);
  } else {
    jsonCandidate = text.substring(startIndex);
  }

  // 4. Sanitize trailing commas and control characters
  jsonCandidate = sanitizeJsonString(jsonCandidate);

  try {
    return JSON.parse(jsonCandidate) as T;
  } catch (_) {
    // Continue to repair truncated JSON
  }

  // 5. Auto-repair truncated JSON (close unclosed quotes, brackets, braces)
  const repairedJson = repairTruncatedJson(jsonCandidate);
  try {
    return JSON.parse(repairedJson) as T;
  } catch (err: any) {
    throw new Error(
      `JSON repair failed: ${err.message}. Original text snippet: "${text.slice(0, 200)}..."`,
    );
  }
}

/**
 * Remove trailing commas before closing braces/brackets and clean unescaped control chars
 */
function sanitizeJsonString(jsonStr: string): string {
  return jsonStr
    .replace(/,\s*([\}\]])/g, '$1')
    .replace(/[\x00-\x1F\x7F-\x9F]/g, (c) => {
      if (c === '\n' || c === '\r' || c === '\t') return c;
      return '';
    });
}

/**
 * Auto-close truncated JSON strings, arrays, and objects in LIFO stack order
 */
function repairTruncatedJson(jsonStr: string): string {
  let cleaned = sanitizeJsonString(jsonStr);

  const stack: string[] = [];
  let inString = false;
  let isEscaped = false;

  for (let i = 0; i < cleaned.length; i++) {
    const char = cleaned[i];

    if (inString) {
      if (isEscaped) {
        isEscaped = false;
      } else if (char === '\\') {
        isEscaped = true;
      } else if (char === '"') {
        inString = false;
      }
    } else {
      if (char === '"') {
        inString = true;
      } else if (char === '{') {
        stack.push('}');
      } else if (char === '[') {
        stack.push(']');
      } else if (char === '}' || char === ']') {
        if (stack.length > 0 && stack[stack.length - 1] === char) {
          stack.pop();
        }
      }
    }
  }

  if (inString) {
    if (cleaned.endsWith('\\')) {
      cleaned = cleaned.slice(0, -1);
    }
    cleaned += '"';
  }

  cleaned = cleaned.trim();
  cleaned = cleaned.replace(/,\s*("[^"]*")?\s*:?\s*$/, '');
  cleaned = sanitizeJsonString(cleaned);

  while (stack.length > 0) {
    cleaned += stack.pop();
  }

  return cleaned;
}
