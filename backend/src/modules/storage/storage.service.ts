import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { v4 as uuidv4 } from 'uuid';
import { Readable } from 'stream';
import * as fs from 'fs';
import * as path from 'path';

export interface UploadOptions {
  contentType?: string;
  metadata?: Record<string, string>;
  folder?: string;
}

export interface FileInfo {
  key: string;
  size: number;
  lastModified: Date;
  contentType?: string;
}

@Injectable()
export class StorageService implements OnModuleInit {
  private readonly logger = new Logger(StorageService.name);
  private supabaseClient: SupabaseClient | null = null;
  private bucketName: string;
  private uploadDir: string;
  private publicUrl: string;
  private useSupabase = false;

  constructor(private readonly configService: ConfigService) {}

  async onModuleInit() {
    const provider = this.configService.get<string>('STORAGE_PROVIDER', 'supabase');
    const supabaseUrl = this.configService.get<string>('SUPABASE_URL');
    const supabaseKey =
      this.configService.get<string>('SUPABASE_SERVICE_ROLE_KEY') ||
      this.configService.get<string>('SUPABASE_ANON_KEY');
    this.bucketName = this.configService.get<string>('SUPABASE_STORAGE_BUCKET', 'eduverse-uploads');

    if ((provider === 'supabase' || supabaseUrl) && supabaseUrl && supabaseKey) {
      this.supabaseClient = createClient(supabaseUrl, supabaseKey, {
        auth: {
          // Server-side: no browser session, no auto-refresh
          persistSession: false,
          autoRefreshToken: false,
          detectSessionInUrl: false,
        },
        global: {
          headers: {
            'x-application-name': 'eduverse-backend',
          },
        },
      });
      this.useSupabase = true;
      this.logger.log(
        `Supabase StorageService initialized — Bucket: "${this.bucketName}", URL: ${supabaseUrl}`,
      );
    } else {
      this.uploadDir = path.resolve(process.cwd(), 'uploads');
      const backendUrl = this.configService.get<string>('BACKEND_URL', 'http://localhost:3010');
      this.publicUrl = this.configService.get<string>(
        'STORAGE_PUBLIC_URL',
        `${backendUrl}/uploads`,
      );

      if (!fs.existsSync(this.uploadDir)) {
        fs.mkdirSync(this.uploadDir, { recursive: true });
      }
      this.logger.log(`Local disk StorageService initialized — Dir: ${this.uploadDir}`);
    }
  }

  private generateKey(filename: string, folder?: string): string {
    const ext = filename.split('.').pop() || '';
    const key = `${uuidv4()}.${ext}`;
    return folder ? `${folder}/${key}` : key;
  }

  private getFilePath(key: string): string {
    return path.join(this.uploadDir || path.resolve(process.cwd(), 'uploads'), key);
  }

  async upload(
    file: Buffer | Readable,
    filename: string,
    options?: UploadOptions,
  ): Promise<{ key: string; url: string }> {
    const key = this.generateKey(filename, options?.folder);
    let buffer: Buffer;

    if (Buffer.isBuffer(file)) {
      buffer = file;
    } else {
      const chunks: Buffer[] = [];
      for await (const chunk of file) {
        chunks.push(Buffer.from(chunk));
      }
      buffer = Buffer.concat(chunks);
    }

    if (this.useSupabase && this.supabaseClient) {
      const { data, error } = await this.supabaseClient.storage
        .from(this.bucketName)
        .upload(key, buffer, {
          contentType: options?.contentType || 'application/octet-stream',
          upsert: true,
        });

      if (error) {
        this.logger.error(`Supabase upload failed (${error.message}) for key ${key}`);
        throw error;
      }

      const { data: publicData } = this.supabaseClient.storage
        .from(this.bucketName)
        .getPublicUrl(data.path);

      const url = publicData.publicUrl;
      this.logger.log(`File uploaded to Supabase Storage — Key: ${key}, URL: ${url}`);
      return { key, url };
    } else {
      const filePath = this.getFilePath(key);
      const folderPath = path.dirname(filePath);

      if (!fs.existsSync(folderPath)) {
        fs.mkdirSync(folderPath, { recursive: true });
      }

      await fs.promises.writeFile(filePath, buffer);
      const url = `${this.publicUrl}/${key}`;
      this.logger.log(`File uploaded to local disk — Key: ${key}`);
      return { key, url };
    }
  }

  async uploadWithKey(
    file: Buffer,
    key: string,
    options?: Omit<UploadOptions, 'folder'>,
  ): Promise<{ key: string; url: string }> {
    if (this.useSupabase && this.supabaseClient) {
      const { data, error } = await this.supabaseClient.storage
        .from(this.bucketName)
        .upload(key, file, {
          contentType: options?.contentType || 'application/octet-stream',
          upsert: true,
        });

      if (error) {
        this.logger.error(`Supabase uploadWithKey failed (${error.message}) for key ${key}`);
        throw error;
      }

      const { data: publicData } = this.supabaseClient.storage
        .from(this.bucketName)
        .getPublicUrl(data.path);

      return { key, url: publicData.publicUrl };
    } else {
      const filePath = this.getFilePath(key);
      const folderPath = path.dirname(filePath);

      if (!fs.existsSync(folderPath)) {
        fs.mkdirSync(folderPath, { recursive: true });
      }

      await fs.promises.writeFile(filePath, file);
      const url = `${this.publicUrl}/${key}`;
      return { key, url };
    }
  }

  async download(key: string): Promise<Buffer> {
    if (this.useSupabase && this.supabaseClient) {
      const { data, error } = await this.supabaseClient.storage
        .from(this.bucketName)
        .download(key);

      if (error || !data) {
        throw new Error(`Supabase download failed (${error?.message || 'File not found'}): ${key}`);
      }

      const arrayBuffer = await data.arrayBuffer();
      return Buffer.from(arrayBuffer);
    } else {
      const filePath = this.getFilePath(key);
      if (!fs.existsSync(filePath)) {
        throw new Error(`File not found: ${key}`);
      }
      return fs.promises.readFile(filePath);
    }
  }

  async getStream(key: string): Promise<Readable> {
    const buffer = await this.download(key);
    return Readable.from(buffer);
  }

  async delete(key: string): Promise<void> {
    if (this.useSupabase && this.supabaseClient) {
      const { error } = await this.supabaseClient.storage.from(this.bucketName).remove([key]);
      if (error) {
        this.logger.error(`Supabase delete failed (${error.message}) for key ${key}`);
      }
    } else {
      const filePath = this.getFilePath(key);
      if (fs.existsSync(filePath)) {
        await fs.promises.unlink(filePath);
      }
    }
  }

  async deleteMany(keys: string[]): Promise<void> {
    if (this.useSupabase && this.supabaseClient) {
      await this.supabaseClient.storage.from(this.bucketName).remove(keys);
    } else {
      await Promise.all(keys.map((key) => this.delete(key)));
    }
  }

  async exists(key: string): Promise<boolean> {
    if (this.useSupabase && this.supabaseClient) {
      const { data } = await this.supabaseClient.storage.from(this.bucketName).list('', {
        search: key,
      });
      return Boolean(data && data.length > 0);
    } else {
      const filePath = this.getFilePath(key);
      return fs.existsSync(filePath);
    }
  }

  async getInfo(key: string): Promise<FileInfo | null> {
    if (this.useSupabase && this.supabaseClient) {
      const folder = path.dirname(key);
      const filename = path.basename(key);
      const searchPath = folder === '.' ? '' : folder;

      const { data } = await this.supabaseClient.storage
        .from(this.bucketName)
        .list(searchPath, { search: filename });

      if (data && data.length > 0) {
        const item = data.find((f) => f.name === filename) || data[0];
        return {
          key,
          size: item.metadata?.size || 0,
          lastModified: new Date(item.created_at || Date.now()),
          contentType: item.metadata?.mimetype,
        };
      }
      return null;
    } else {
      const filePath = this.getFilePath(key);
      if (!fs.existsSync(filePath)) return null;

      const stats = await fs.promises.stat(filePath);
      return {
        key,
        size: stats.size,
        lastModified: stats.mtime,
      };
    }
  }

  async list(prefix?: string): Promise<FileInfo[]> {
    if (this.useSupabase && this.supabaseClient) {
      const { data } = await this.supabaseClient.storage
        .from(this.bucketName)
        .list(prefix || '');

      if (!data) return [];
      return data.map((item) => ({
        key: prefix ? `${prefix}/${item.name}` : item.name,
        size: item.metadata?.size || 0,
        lastModified: new Date(item.created_at || Date.now()),
        contentType: item.metadata?.mimetype,
      }));
    } else {
      if (!fs.existsSync(this.uploadDir)) return [];
      const files = await fs.promises.readdir(this.uploadDir);
      const results: FileInfo[] = [];

      for (const f of files) {
        if (!prefix || f.startsWith(prefix)) {
          const stats = await fs.promises.stat(path.join(this.uploadDir, f));
          results.push({
            key: f,
            size: stats.size,
            lastModified: stats.mtime,
          });
        }
      }
      return results;
    }
  }

  async copy(sourceKey: string, destinationKey: string): Promise<void> {
    const buffer = await this.download(sourceKey);
    await this.uploadWithKey(buffer, destinationKey);
  }

  async move(sourceKey: string, destinationKey: string): Promise<void> {
    await this.copy(sourceKey, destinationKey);
    await this.delete(sourceKey);
  }

  async getSignedUploadUrl(key: string): Promise<string> {
    if (this.useSupabase && this.supabaseClient) {
      const { data } = await this.supabaseClient.storage
        .from(this.bucketName)
        .createSignedUploadUrl(key);
      return data?.signedUrl || this.getPublicUrl(key);
    }
    return `${this.publicUrl}/${key}`;
  }

  async getSignedDownloadUrl(key: string): Promise<string> {
    if (this.useSupabase && this.supabaseClient) {
      const { data } = await this.supabaseClient.storage
        .from(this.bucketName)
        .createSignedUrl(key, 3600);
      return data?.signedUrl || this.getPublicUrl(key);
    }
    return `${this.publicUrl}/${key}`;
  }

  getPublicUrl(key: string): string {
    if (this.useSupabase && this.supabaseClient) {
      const { data } = this.supabaseClient.storage.from(this.bucketName).getPublicUrl(key);
      return data.publicUrl;
    }
    return `${this.publicUrl}/${key}`;
  }

  extractKeyFromUrl(url: string): string {
    if (this.useSupabase && this.supabaseClient) {
      const base = `${this.configService.get<string>('SUPABASE_URL')}/storage/v1/object/public/${this.bucketName}/`;
      if (url.startsWith(base)) {
        return url.replace(base, '');
      }
    }
    if (this.publicUrl && url.startsWith(this.publicUrl)) {
      return url.replace(`${this.publicUrl}/`, '');
    }
    return url;
  }

  async healthCheck(): Promise<boolean> {
    if (this.useSupabase && this.supabaseClient) {
      const { data, error } = await this.supabaseClient.storage.getBucket(this.bucketName);
      return Boolean(data && !error);
    }
    return true;
  }
}
