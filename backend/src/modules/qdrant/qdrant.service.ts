import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface VectorPoint {
  id: string;
  vector: number[];
  payload?: Record<string, unknown>;
}

export interface SearchResult {
  id: string;
  score: number;
  payload?: Record<string, unknown>;
}

export interface CollectionInfo {
  name: string;
  vectorSize: number;
  pointsCount: number;
}

@Injectable()
export class QdrantService implements OnModuleInit {
  private readonly logger = new Logger(QdrantService.name);
  private storage: Map<string, Map<string, VectorPoint>> = new Map();

  constructor(private readonly configService: ConfigService) {}

  onModuleInit() {
    this.logger.log('QdrantService initialized in-memory for vector search');
  }

  isConfigured(): boolean {
    return true;
  }

  async waitForInit(): Promise<boolean> {
    return true;
  }

  async createCollection(name: string): Promise<void> {
    if (!this.storage.has(name)) {
      this.storage.set(name, new Map());
    }
  }

  async deleteCollection(name: string): Promise<void> {
    this.storage.delete(name);
  }

  async upsertPoints(collectionName: string, points: VectorPoint[]): Promise<void> {
    let col = this.storage.get(collectionName);
    if (!col) {
      col = new Map();
      this.storage.set(collectionName, col);
    }

    for (const p of points) {
      col.set(p.id, p);
    }
  }

  async upsertBatch(collectionName: string, points: VectorPoint[]): Promise<void> {
    return this.upsertPoints(collectionName, points);
  }

  async deletePoints(collectionName: string, ids: string[]): Promise<void> {
    const col = this.storage.get(collectionName);
    if (col) {
      for (const id of ids) {
        col.delete(id);
      }
    }
  }

  async search(collectionName: string, vector: number[], limit = 10): Promise<SearchResult[]> {
    const col = this.storage.get(collectionName);
    if (!col || col.size === 0) return [];

    const results: SearchResult[] = [];
    for (const point of col.values()) {
      const sim = this.cosineSimilarity(vector, point.vector);
      results.push({
        id: point.id,
        score: sim,
        payload: point.payload,
      });
    }

    return results.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  async searchWithPayloadFilter(
    collectionName: string,
    vector: number[],
    limit: number,
    filter: Array<{ key: string; match: { value: string } }>,
  ): Promise<SearchResult[]> {
    const col = this.storage.get(collectionName);
    if (!col || col.size === 0) return [];

    const results: SearchResult[] = [];
    for (const point of col.values()) {
      let matches = true;
      if (point.payload) {
        for (const f of filter) {
          if (point.payload[f.key] !== f.match.value) {
            matches = false;
            break;
          }
        }
      }
      if (matches) {
        const sim = this.cosineSimilarity(vector, point.vector);
        results.push({
          id: point.id,
          score: sim,
          payload: point.payload,
        });
      }
    }

    return results.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  async deleteByFilter(collectionName: string, filter: Record<string, unknown>): Promise<void> {
    const col = this.storage.get(collectionName);
    if (!col) return;

    for (const [id, point] of col.entries()) {
      if (point.payload) {
        let match = true;
        for (const [k, v] of Object.entries(filter)) {
          if (point.payload[k] !== v) {
            match = false;
            break;
          }
        }
        if (match) col.delete(id);
      }
    }
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    if (!a || !b || a.length !== b.length) return 0;
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    if (normA === 0 || normB === 0) return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
  }
}
