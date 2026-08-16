import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleGenerativeAI } from '@google/generative-ai';

export interface EmbeddingResult {
  vector: number[];
  tokens: number;
}

export const GEMINI_EMBEDDING_MODEL = 'text-embedding-004';
export const GEMINI_VECTOR_DIMENSION = 768;

@Injectable()
export class EmbeddingService implements OnModuleInit {
  private readonly logger = new Logger(EmbeddingService.name);
  private genAI: GoogleGenerativeAI | null = null;
  private readonly embeddingModel: string;
  private readonly vectorDimension: number;

  constructor(private readonly configService: ConfigService) {
    this.embeddingModel = this.configService.get<string>(
      'GEMINI_EMBEDDING_MODEL',
      GEMINI_EMBEDDING_MODEL,
    );
    this.vectorDimension = GEMINI_VECTOR_DIMENSION;
  }

  onModuleInit() {
    this.initializeClient();
  }

  private initializeClient() {
    const apiKey =
      this.configService.get<string>('GEMINI_API_KEY') ||
      this.configService.get<string>('GOOGLE_API_KEY');

    if (apiKey && !apiKey.includes('your-')) {
      this.genAI = new GoogleGenerativeAI(apiKey);
      this.logger.log(
        `Gemini EmbeddingService initialized with model '${this.embeddingModel}' (${this.vectorDimension} dimensions)`,
      );
    }
  }

  private getClient(): GoogleGenerativeAI {
    if (!this.genAI) {
      this.initializeClient();
    }
    if (!this.genAI) {
      throw new Error('Gemini API key is missing. Set GEMINI_API_KEY in environment variables.');
    }
    return this.genAI;
  }

  getVectorDimension(): number {
    return this.vectorDimension;
  }

  async embed(text: string): Promise<EmbeddingResult> {
    const genAI = this.getClient();

    try {
      const model = genAI.getGenerativeModel({ model: this.embeddingModel });
      const response = await model.embedContent(text);

      const embeddingValues = response.embedding?.values;
      if (!embeddingValues) {
        throw new Error('No embedding values returned from Gemini API');
      }

      return {
        vector: embeddingValues,
        tokens: Math.ceil(text.length / 4),
      };
    } catch (error: unknown) {
      const err = error as Error;
      this.logger.error(`Gemini embedding failed: ${err.message}`);
      throw new Error(`Gemini embedding failed: ${err.message}`);
    }
  }

  async embedBatch(texts: string[]): Promise<EmbeddingResult[]> {
    if (texts.length === 0) return [];

    const results: EmbeddingResult[] = [];
    for (const text of texts) {
      const res = await this.embed(text);
      results.push(res);
    }
    return results;
  }

  async embedWithChunking(texts: string[], batchSize = 50): Promise<EmbeddingResult[]> {
    const results: EmbeddingResult[] = [];

    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      const batchResults = await this.embedBatch(batch);
      results.push(...batchResults);
    }

    return results;
  }

  cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) {
      throw new Error(`Vector dimensions must match. Received ${a.length} and ${b.length}`);
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  async findMostSimilar(
    query: string,
    candidates: Array<{ id: string; text: string }>,
    topK = 5,
  ): Promise<Array<{ id: string; text: string; similarity: number }>> {
    const queryEmbedding = await this.embed(query);
    const candidateEmbeddings = await this.embedBatch(candidates.map((c) => c.text));

    const results = candidates.map((candidate, index) => ({
      id: candidate.id,
      text: candidate.text,
      similarity: this.cosineSimilarity(queryEmbedding.vector, candidateEmbeddings[index].vector),
    }));

    return results.sort((a, b) => b.similarity - a.similarity).slice(0, topK);
  }
}
