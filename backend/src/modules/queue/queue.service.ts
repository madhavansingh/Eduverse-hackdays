import { Injectable, Logger } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';

export type JobProcessor<T = unknown, R = unknown> = (job: {
  id: string;
  name: string;
  data: T;
}) => Promise<R>;

@Injectable()
export class QueueService {
  private readonly logger = new Logger(QueueService.name);
  private processors: Map<string, JobProcessor> = new Map();

  registerWorker<T = unknown, R = unknown>(queueName: string, processor: JobProcessor<T, R>) {
    this.processors.set(queueName, processor as JobProcessor);
    this.logger.log(`Inline worker registered for queue '${queueName}'`);
  }

  async addJob<T = unknown>(
    queueName: string,
    name: string,
    data: T,
  ): Promise<{ id: string; name: string; data: T }> {
    const id = uuidv4();
    const job = { id, name, data };

    this.logger.debug(`Adding inline job '${name}' [${id}] to queue '${queueName}'`);

    const processor = this.processors.get(queueName);
    if (processor) {
      // Execute asynchronously without blocking caller
      setImmediate(async () => {
        try {
          await processor(job);
          this.logger.debug(`Inline job '${name}' [${id}] completed successfully`);
        } catch (error) {
          this.logger.error(`Inline job '${name}' [${id}] failed:`, error);
        }
      });
    } else {
      this.logger.warn(`No inline processor registered for queue '${queueName}'`);
    }

    return job;
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }
}
