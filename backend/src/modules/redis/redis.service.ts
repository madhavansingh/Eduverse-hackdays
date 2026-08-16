import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

interface CacheItem {
  value: string;
  expiresAt?: number;
}

@Injectable()
export class RedisService implements OnModuleInit {
  private readonly logger = new Logger(RedisService.name);
  private cache = new Map<string, CacheItem>();

  constructor(private readonly configService: ConfigService) {}

  onModuleInit() {
    this.logger.log('RedisService initialized in-memory cache');
  }

  isReady(): boolean {
    return true;
  }

  async get(key: string): Promise<string | null> {
    const item = this.cache.get(key);
    if (!item) return null;

    if (item.expiresAt && Date.now() > item.expiresAt) {
      this.cache.delete(key);
      return null;
    }

    return item.value;
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<'OK'> {
    const expiresAt = ttlSeconds ? Date.now() + ttlSeconds * 1000 : undefined;
    this.cache.set(key, { value, expiresAt });
    return 'OK';
  }

  async del(key: string): Promise<number> {
    return this.cache.delete(key) ? 1 : 0;
  }

  async delPattern(pattern: string): Promise<number> {
    const regex = new RegExp(`^${pattern.replace('*', '.*')}$`);
    let deleted = 0;
    for (const key of this.cache.keys()) {
      if (regex.test(key)) {
        this.cache.delete(key);
        deleted++;
      }
    }
    return deleted;
  }

  async exists(key: string): Promise<boolean> {
    const val = await this.get(key);
    return val !== null;
  }

  async flushDb(): Promise<'OK'> {
    this.cache.clear();
    return 'OK';
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }
}
