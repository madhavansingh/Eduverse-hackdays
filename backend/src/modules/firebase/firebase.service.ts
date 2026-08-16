import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class FirebaseService implements OnModuleInit {
  private readonly logger = new Logger(FirebaseService.name);

  constructor(private readonly configService: ConfigService) {}

  onModuleInit() {
    this.logger.log('FirebaseService initialized in hackathon mode (In-app notifications enabled)');
  }

  isInitialized(): boolean {
    return true;
  }

  async sendToDevice(
    token: string,
    title: string,
    body: string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    data?: Record<string, string>,
  ): Promise<boolean> {
    this.logger.debug(
      `In-app notification sent to token [${token.substring(0, 10)}...]: ${title} - ${body}`,
    );
    return true;
  }

  async sendToMultipleDevices(
    tokens: string[],
    title: string,
    body: string,
    data?: Record<string, string>,
  ): Promise<number> {
    let count = 0;
    for (const token of tokens) {
      if (await this.sendToDevice(token, title, body, data)) {
        count++;
      }
    }
    return count;
  }
}
