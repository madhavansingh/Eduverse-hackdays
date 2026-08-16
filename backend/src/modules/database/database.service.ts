import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name);
  private pool: Pool;
  public isConnected = false;

  constructor(private readonly configService: ConfigService) {}

  async onModuleInit() {
    const connectionString = this.configService.get<string>('DATABASE_URL');

    if (connectionString) {
      this.pool = new Pool({
        connectionString,
        min: this.configService.get<number>('DATABASE_POOL_MIN', 1),
        max: this.configService.get<number>('DATABASE_POOL_MAX', 10),
        keepAlive: true,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 3000,
        ssl:
          connectionString.includes('supabase') ||
          connectionString.includes('render.com') ||
          connectionString.includes('pooler.supabase.com') ||
          this.configService.get<string>('NODE_ENV') === 'production'
            ? { rejectUnauthorized: false }
            : false,
      });
    } else {
      this.pool = new Pool({
        host: this.configService.get<string>('DATABASE_HOST', 'localhost'),
        port: this.configService.get<number>('DATABASE_PORT', 5432),
        user: this.configService.get<string>('DATABASE_USER', 'postgres'),
        password: this.configService.get<string>('DATABASE_PASSWORD', 'postgres'),
        database: this.configService.get<string>('DATABASE_NAME', 'eduverse_dev'),
        min: this.configService.get<number>('DATABASE_POOL_MIN', 1),
        max: this.configService.get<number>('DATABASE_POOL_MAX', 10),
        keepAlive: true,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 3000,
      });
    }

    this.pool.on('error', (err) => {
      this.logger.error('Unexpected error on idle client', err);
    });

    try {
      const client = await this.pool.connect();
      client.release();
      this.isConnected = true;
      this.logger.log('Database connection established successfully');
    } catch (error) {
      this.isConnected = false;
      this.logger.warn(`Initial database connection test pending/failed (${error.message}). Application continues running in resilient mode.`);
    }
  }

  async onModuleDestroy() {
    if (this.pool) {
      await this.pool.end();
      this.logger.log('Database connection pool closed');
    }
  }

  async query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: unknown[],
  ): Promise<QueryResult<T>> {
    const start = Date.now();
    try {
      const result = await this.pool.query<T>(text, params);
      const duration = Date.now() - start;
      this.isConnected = true;
      this.logger.debug(`Query executed in ${duration}ms: ${text.substring(0, 100)}...`);
      return result;
    } catch (error: any) {
      this.isConnected = false;
      this.logger.error(`Query failed (${error.message}): ${text.substring(0, 80)}`);
      throw error;
    }
  }

  async queryOne<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: unknown[],
  ): Promise<T | null> {
    const result = await this.query<T>(text, params);
    return result.rows[0] || null;
  }

  async queryMany<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: unknown[],
  ): Promise<T[]> {
    const result = await this.query<T>(text, params);
    return result.rows;
  }

  async getClient(): Promise<PoolClient> {
    return this.pool.connect();
  }

  async transaction<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }
}
