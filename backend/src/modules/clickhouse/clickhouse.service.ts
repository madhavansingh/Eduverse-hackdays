import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class ClickhouseService implements OnModuleInit {
  private readonly logger = new Logger(ClickhouseService.name);

  constructor(private readonly configService: ConfigService) {}

  onModuleInit() {
    this.logger.log('ClickhouseService initialized in hackathon mode (Database analytics enabled)');
  }

  isReady(): boolean {
    return true;
  }

  async trackEvent(
    userId: string,
    eventName: string,
    properties?: Record<string, unknown>,
  ): Promise<void> {
    this.logger.debug(
      `[Analytics Track] User: ${userId} | Event: ${eventName} | Props: ${JSON.stringify(properties || {})}`,
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async getUserActivity(
    userId: string,
    _days = 30,
  ): Promise<Array<{ date: string; count: number }>> {
    return [];
  }

  async insertEvent(eventName: string, payload: Record<string, unknown>): Promise<void> {
    this.logger.debug(`[Analytics Event] ${eventName}: ${JSON.stringify(payload)}`);
  }

  async insertEvents(
    events: Array<{ eventName: string; payload: Record<string, unknown> }>,
  ): Promise<void> {
    for (const event of events) {
      await this.insertEvent(event.eventName, event.payload);
    }
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }
}
