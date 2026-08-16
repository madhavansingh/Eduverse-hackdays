import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD, APP_INTERCEPTOR, APP_FILTER } from '@nestjs/core';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';

// Core Infrastructure
import { DatabaseModule } from './modules/database';
import { AiModule } from './modules/ai';
import { QueueModule } from './modules/queue';
import { QdrantModule } from './modules/qdrant';
import { StorageModule } from './modules/storage';
import { SubscriptionModule } from './modules/subscription';
import { EmailModule } from './modules/email';
import { ClickhouseModule } from './modules/clickhouse';
import { RedisModule } from './modules/redis';
import { GatewayModule } from './common/gateways/gateway.module';

// Feature Modules
import { AuthModule } from './modules/auth';
import { UsersModule } from './modules/users';
import { ContentModule } from './modules/content';
import { KnowledgeBaseModule } from './modules/knowledge-base';
import { ChatModule } from './modules/chat';
import { QuizModule } from './modules/quiz';
import { ExamCloneModule } from './modules/exam-clone';
import { ProblemSolverModule } from './modules/problem-solver';

import { TeachBackModule } from './modules/teach-back';
import { ResearchModule } from './modules/research';
import { CodeSandboxModule } from './modules/code-sandbox';
import { LearningPathsModule } from './modules/learning-paths';
import { AnalyticsModule } from './modules/analytics';
import { NotificationsModule } from './modules/notifications';
import { BlogModule } from './modules/blog';

// Common Interceptors & Guards
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { RolesGuard } from './common/guards/roles.guard';
import { CamelCaseInterceptor } from './common/interceptors/camel-case.interceptor';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';

// Health Check Controller
import { HealthController } from './health.controller';

@Module({
  imports: [
    // Global Configuration
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env'],
    }),

    // Rate Limiting
    ThrottlerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        throttlers: [
          {
            ttl: config.get<number>('RATE_LIMIT_TTL', 60) * 1000,
            limit: config.get<number>('RATE_LIMIT_MAX', 100),
          },
        ],
      }),
    }),

    // Core Infrastructure
    DatabaseModule,
    AiModule,
    QueueModule,
    QdrantModule,
    StorageModule,
    SubscriptionModule,
    EmailModule,
    ClickhouseModule,
    RedisModule,
    GatewayModule,

    // Feature Modules
    AuthModule,
    UsersModule,
    ContentModule,
    KnowledgeBaseModule,
    ChatModule,
    QuizModule,
    ExamCloneModule,
    ProblemSolverModule,
    TeachBackModule,
    ResearchModule,
    CodeSandboxModule,
    LearningPathsModule,
    AnalyticsModule,
    NotificationsModule,
    BlogModule,
  ],
  controllers: [HealthController],
  providers: [
    // Global JWT Auth Guard
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
    // Global Roles Guard
    {
      provide: APP_GUARD,
      useClass: RolesGuard,
    },
    // Global Rate Limiting Guard
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
    // Global Interceptors
    {
      provide: APP_INTERCEPTOR,
      useClass: CamelCaseInterceptor,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: LoggingInterceptor,
    },
    // Global Exception Filter
    {
      provide: APP_FILTER,
      useClass: HttpExceptionFilter,
    },
  ],
})
export class AppModule {}
