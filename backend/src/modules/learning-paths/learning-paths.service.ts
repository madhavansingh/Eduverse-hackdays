import { Injectable, Logger, NotFoundException, ForbiddenException } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { DatabaseService } from '../database/database.service';
import { AiService } from '../ai/ai.service';

export interface LearningPath {
  id: string;
  userId: string;
  title: string;
  description: string | null;
  subject: string;
  difficulty: 'beginner' | 'intermediate' | 'advanced';
  estimatedHours: number;
  steps: LearningStep[];
  progress: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface LearningStep {
  id: string;
  order: number;
  title: string;
  description: string;
  type: 'study' | 'quiz' | 'practice' | 'review';
  resourceId: string | null;
  resourceType: 'study_set' | 'quiz' | 'document' | null;
  estimatedMinutes: number;
  isCompleted: boolean;
  completedAt: Date | null;
}

export interface CreateLearningPathDto {
  title: string;
  subject: string;
  difficulty?: 'beginner' | 'intermediate' | 'advanced';
  goals?: string[];
}

export interface GenerateLearningPathDto {
  topic: string;
  currentLevel: 'beginner' | 'intermediate' | 'advanced';
  targetLevel: 'intermediate' | 'advanced' | 'expert';
  availableHoursPerWeek: number;
  studySetIds?: string[];
}

@Injectable()
export class LearningPathsService {
  private readonly logger = new Logger(LearningPathsService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly aiService: AiService,
  ) {}

  async create(userId: string, dto: CreateLearningPathDto): Promise<LearningPath> {
    const id = uuidv4();
    const now = new Date();

    const result = await this.db.queryOne<LearningPath>(
      `INSERT INTO learning_paths (id, user_id, title, subject, difficulty, estimated_hours, steps, progress, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 0, $6, 0, $7, $8)
       RETURNING *`,
      [
        id,
        userId,
        dto.title,
        dto.subject,
        dto.difficulty || 'beginner',
        JSON.stringify([]),
        now,
        now,
      ],
    );

    return this.mapPath(result!);
  }

  async generate(userId: string, dto: GenerateLearningPathDto): Promise<LearningPath> {
    const id = uuidv4();
    const now = new Date();

    const prompt = `Design a concise, high-impact learning path (5-7 steps total) for:
Topic: ${dto.topic}
Current Level: ${dto.currentLevel}
Target Level: ${dto.targetLevel}
Weekly Hours: ${dto.availableHoursPerWeek}

INSTRUCTIONS:
1. Provide EXACTLY 5 to 7 milestone steps. Keep titles under 6 words and descriptions under 15 words for maximum clarity.
2. Assign step type as one of: "study", "quiz", "practice", "review".
3. Return JSON ONLY matching this schema:

{
  "title": "Mastering ${dto.topic.trim()}",
  "description": "Accelerated path from ${dto.currentLevel} to ${dto.targetLevel}",
  "estimatedHours": 12,
  "steps": [
    {
      "order": 1,
      "title": "Foundations & Core Principles",
      "description": "Master fundamental concepts and terminology",
      "type": "study",
      "estimatedMinutes": 60
    }
  ]
}`;

    let title = `Mastering ${dto.topic.trim()}`;
    let description = `Personalized study path for ${dto.topic.trim()} (${dto.currentLevel} to ${dto.targetLevel})`;
    let estimatedHours = Math.min(dto.availableHoursPerWeek * 2, 20);
    let rawSteps: Array<{
      order?: number;
      title?: string;
      description?: string;
      type?: string;
      estimatedMinutes?: number;
    }> = [];

    try {
      const response = await this.aiService.completeJson<{
        title?: string;
        description?: string;
        estimatedHours?: number;
        steps?: Array<{
          order?: number;
          title?: string;
          description?: string;
          type?: string;
          estimatedMinutes?: number;
        }>;
      }>(
        [
          { role: 'system', content: 'You are an expert curriculum designer. Output ultra-concise, structured JSON.' },
          { role: 'user', content: prompt },
        ],
        { maxTokens: 2048 },
      );

      if (response) {
        if (response.title && response.title.trim()) title = response.title.trim();
        if (response.description && response.description.trim()) description = response.description.trim();
        if (typeof response.estimatedHours === 'number' && response.estimatedHours > 0) estimatedHours = response.estimatedHours;
        if (Array.isArray(response.steps) && response.steps.length > 0) rawSteps = response.steps;
      }
    } catch (err) {
      this.logger.warn(`AI Learning path generation failed or timed out, using structured fallback: ${(err as Error).message}`);
    }

    // Fallback steps if AI response was empty or failed
    if (!rawSteps || rawSteps.length === 0) {
      rawSteps = [
        {
          order: 1,
          title: `Introduction to ${dto.topic}`,
          description: `Learn the basic concepts and key terms of ${dto.topic}.`,
          type: 'study',
          estimatedMinutes: 60,
        },
        {
          order: 2,
          title: 'Core Concepts & Principles',
          description: 'Deep dive into fundamental mechanisms and rules.',
          type: 'study',
          estimatedMinutes: 90,
        },
        {
          order: 3,
          title: 'Checkpoint Quiz',
          description: 'Test your understanding of core principles.',
          type: 'quiz',
          estimatedMinutes: 30,
        },
        {
          order: 4,
          title: 'Hands-on Practice & Exercises',
          description: 'Apply your knowledge through practical problem solving.',
          type: 'practice',
          estimatedMinutes: 120,
        },
        {
          order: 5,
          title: 'Advanced Topics & Optimization',
          description: `Master complex scenarios for ${dto.targetLevel} level.`,
          type: 'study',
          estimatedMinutes: 90,
        },
        {
          order: 6,
          title: 'Final Mastery Review',
          description: 'Comprehensive review and self-assessment.',
          type: 'review',
          estimatedMinutes: 45,
        },
      ];
    }

    const steps: LearningStep[] = rawSteps.map((s, i) => ({
      id: uuidv4(),
      order: s.order || i + 1,
      title: s.title && s.title.trim() ? s.title.trim() : `Step ${i + 1}`,
      description: s.description && s.description.trim() ? s.description.trim() : `Learn key concepts for step ${i + 1}`,
      type: (['study', 'quiz', 'practice', 'review'].includes(s.type || '') ? s.type : 'study') as LearningStep['type'],
      resourceId: null,
      resourceType: null,
      estimatedMinutes: typeof s.estimatedMinutes === 'number' && s.estimatedMinutes > 0 ? s.estimatedMinutes : 60,
      isCompleted: false,
      completedAt: null,
    }));

    await this.db.query(
      `INSERT INTO learning_paths (id, user_id, title, description, subject, difficulty, estimated_hours, steps, progress, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0, $9, $10)`,
      [
        id,
        userId,
        title,
        description,
        dto.topic,
        dto.currentLevel,
        estimatedHours,
        JSON.stringify(steps),
        now,
        now,
      ],
    );

    this.logger.log(`Learning path generated successfully: ${id} (${steps.length} steps)`);
    return (await this.findById(id)) || {
      id,
      userId,
      title,
      description,
      subject: dto.topic,
      difficulty: dto.currentLevel as any,
      estimatedHours,
      steps,
      progress: 0,
      createdAt: now,
      updatedAt: now,
    };
  }

  async findById(id: string): Promise<LearningPath | null> {
    const result = await this.db.queryOne<LearningPath>(
      'SELECT * FROM learning_paths WHERE id = $1',
      [id],
    );
    return result ? this.mapPath(result) : null;
  }

  async findByUser(userId: string): Promise<LearningPath[]> {
    const results = await this.db.queryMany<LearningPath>(
      'SELECT * FROM learning_paths WHERE user_id = $1 ORDER BY updated_at DESC',
      [userId],
    );
    return results.map((r) => this.mapPath(r));
  }

  async completeStep(pathId: string, stepId: string, userId: string): Promise<LearningPath> {
    const path = await this.findById(pathId);
    if (!path) throw new NotFoundException('Learning path not found');
    if (path.userId !== userId) throw new ForbiddenException('Access denied');

    const steps = path.steps.map((s) => {
      if (s.id === stepId) {
        return { ...s, isCompleted: true, completedAt: new Date() };
      }
      return s;
    });

    const completedCount = steps.filter((s) => s.isCompleted).length;
    const progress = Math.round((completedCount / steps.length) * 100);

    await this.db.query(
      `UPDATE learning_paths SET steps = $1, progress = $2, updated_at = $3 WHERE id = $4`,
      [JSON.stringify(steps), progress, new Date(), pathId],
    );

    return this.findById(pathId) as Promise<LearningPath>;
  }

  async delete(id: string, userId: string): Promise<void> {
    const path = await this.findById(id);
    if (!path) throw new NotFoundException('Learning path not found');
    if (path.userId !== userId) throw new ForbiddenException('Access denied');

    await this.db.query('DELETE FROM learning_paths WHERE id = $1', [id]);
  }

  private mapPath(row: unknown): LearningPath {
    const r = row as Record<string, unknown>;
    return {
      id: r.id as string,
      userId: r.user_id as string,
      title: r.title as string,
      description: r.description as string | null,
      subject: r.subject as string,
      difficulty: r.difficulty as LearningPath['difficulty'],
      estimatedHours: r.estimated_hours as number,
      steps: typeof r.steps === 'string' ? JSON.parse(r.steps) : (r.steps as LearningStep[]) || [],
      progress: r.progress as number,
      createdAt: new Date(r.created_at as string),
      updatedAt: new Date(r.updated_at as string),
    };
  }
}
