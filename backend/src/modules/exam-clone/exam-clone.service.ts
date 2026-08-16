import { Injectable, Logger, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { DatabaseService } from '../database/database.service';
import { AiService } from '../ai/ai.service';
import { StorageService } from '../storage/storage.service';
import { QueueService } from '../queue/queue.service';
import pdfParse from 'pdf-parse';

export interface ExamClone {
  id: string;
  userId: string;
  title: string;
  subject: string | null;
  originalFileUrl: string | null;
  originalText: string | null;
  extractedStyle: ExamStyle | null;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  originalQuestionCount: number;
  generatedQuestionCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface ExamStyle {
  questionTypes: string[];
  difficultyDistribution: { easy: number; medium: number; hard: number };
  averageQuestionLength: number;
  topicsCovered: string[];
  formatPatterns: string[];
  languageStyle: string;
}

export interface ExamQuestion {
  id: string;
  examCloneId: string;
  isOriginal: boolean;
  type: string;
  question: string;
  options: string[] | null;
  correctAnswer: string;
  explanation: string | null;
  difficulty: string;
  topic: string | null;
  order: number;
}

export interface CreateExamCloneDto {
  title: string;
  subject?: string;
  examText?: string;
}

export interface GenerateQuestionsDto {
  count?: number;
  difficulty?: 'easy' | 'medium' | 'hard' | 'match_original';
  topics?: string[];
}

@Injectable()
export class ExamCloneService {
  private readonly logger = new Logger(ExamCloneService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly aiService: AiService,
    private readonly storageService: StorageService,
    private readonly queueService: QueueService,
  ) {}

  private extractFallbackQuestions(examText: string, subject: string | null) {
    const normalized = examText.replace(/\r\n?/g, '\n').trim();
    const numbered = normalized
      .split(/(?=^\s*(?:question\s*)?(?:q\s*)?\d+\s*[.):\-])/im)
      .map((part) => part.trim())
      .filter((part) => /^(?:question\s*)?(?:q\s*)?\d+\s*[.):\-]/i.test(part) && part.length >= 12)
      .slice(0, 50);

    // Some papers omit question numbers in extracted text. Preserve useful
    // paragraph-sized prompts rather than marking the complete upload failed.
    const candidates = numbered.length > 0
      ? numbered
      : normalized
          .split(/\n{2,}/)
          .map((part) => part.trim())
          .filter((part) => part.length >= 25 && /[?]/.test(part))
          .slice(0, 20);

    return candidates.map((question, index) => ({
      id: uuidv4(),
      type: 'short_answer',
      question: question.slice(0, 4000),
      correctAnswer: 'Refer to the original exam paper or your instructor’s marking scheme.',
      difficulty: 'medium',
      topic: subject || 'Exam material',
      order: index,
    }));
  }

  private async completeWithTextFallback(examClone: ExamClone): Promise<boolean> {
    const fallbackQuestions = this.extractFallbackQuestions(
      examClone.originalText || '',
      examClone.subject,
    );
    if (fallbackQuestions.length === 0) return false;

    const fallbackStyle: ExamStyle = {
      questionTypes: ['short_answer'],
      difficultyDistribution: { easy: 25, medium: 50, hard: 25 },
      averageQuestionLength: Math.round(
        fallbackQuestions.reduce((total, question) => total + question.question.length, 0) /
          fallbackQuestions.length,
      ),
      topicsCovered: [examClone.subject || 'Exam material'],
      formatPatterns: ['Extracted from the uploaded exam paper'],
      languageStyle: 'academic',
    };

    // Re-analysis must replace prior originals rather than duplicate them.
    await this.db.query(
      'DELETE FROM exam_questions WHERE exam_clone_id = $1 AND is_original = true',
      [examClone.id],
    );

    for (const question of fallbackQuestions) {
      await this.db.query(
        `INSERT INTO exam_questions (id, exam_clone_id, is_original, type, question, options, correct_answer, difficulty, topic, "order")
         VALUES ($1, $2, true, $3, $4, $5, $6, $7, $8, $9)`,
        [
          question.id,
          examClone.id,
          question.type,
          question.question,
          null,
          question.correctAnswer,
          question.difficulty,
          question.topic,
          question.order,
        ],
      );
    }

    await this.db.query(
      `UPDATE exam_clones
       SET extracted_style = $1, original_question_count = $2, updated_at = $3
       WHERE id = $4`,
      [JSON.stringify(fallbackStyle), fallbackQuestions.length, new Date(), examClone.id],
    );
    await this.updateStatus(examClone.id, 'completed');
    this.logger.warn(
      `Exam ${examClone.id} completed with text-extraction fallback (${fallbackQuestions.length} questions).`,
    );
    return true;
  }

  async create(userId: string, dto: CreateExamCloneDto): Promise<ExamClone> {
    const id = uuidv4();
    const now = new Date();

    const result = await this.db.queryOne<ExamClone>(
      `INSERT INTO exam_clones (id, user_id, title, subject, original_text, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7)
       RETURNING *`,
      [id, userId, dto.title, dto.subject || null, dto.examText || null, now, now],
    );

    if (dto.examText) {
      // Process analysis directly for immediate UI readiness
      this.analyze(id).catch((err) =>
        this.logger.error(`Direct text analysis failed for exam ${id}: ${err.message}`),
      );
    }

    this.logger.log(`Exam clone created: ${id}`);
    return this.mapExamClone(result!);
  }

  async uploadExam(
    examCloneId: string,
    userId: string,
    file: Buffer,
    filename: string,
    mimeType: string,
  ): Promise<void> {
    await this.findByIdWithAccess(examCloneId, userId);
    await this.updateStatus(examCloneId, 'processing');

    try {
      let extractedText = '';

      if (mimeType === 'application/pdf') {
        extractedText = await this.extractTextFromPDF(file);
      } else if (mimeType.startsWith('text/')) {
        extractedText = file.toString('utf-8').trim();
      } else {
        // Fallback for image files or scans (PNG, JPG)
        extractedText = await this.aiService.generateWithVision({
          prompt:
            'You are an expert document parser. Extract all questions, headings, options, and text from this exam paper image.',
          imageData: file.toString('base64'),
          mimeType,
        });
      }

      if (!extractedText || extractedText.trim().length === 0) {
        throw new Error('Could not extract readable text from the uploaded file.');
      }

      // Save extracted text into database
      await this.db.query(
        `UPDATE exam_clones SET original_text = $1, updated_at = $2 WHERE id = $3`,
        [extractedText, new Date(), examCloneId],
      );

      // Attempt background upload to storage for file preview URL (optional)
      try {
        const { url } = await this.storageService.upload(file, filename, {
          contentType: mimeType,
          folder: `exams/${userId}`,
        });
        await this.db.query(
          `UPDATE exam_clones SET original_file_url = $1 WHERE id = $2`,
          [url, examCloneId],
        );
      } catch (storageErr) {
        this.logger.warn(`Storage upload skipped/failed: ${(storageErr as Error).message}`);
      }

      // Perform AI Analysis and question extraction in background asynchronously
      this.analyze(examCloneId).catch((err) => {
        this.logger.error(
          `Background AI analysis failed for exam ${examCloneId}: ${(err as Error).message}`,
        );
        this.updateStatus(examCloneId, 'failed');
      });
    } catch (error) {
      this.logger.error(`Failed to process uploaded file for exam ${examCloneId}`, error);
      await this.updateStatus(examCloneId, 'failed');
      throw error;
    }
  }

  /**
   * Process file directly without storage
   */
  async processFileDirectly(
    examCloneId: string,
    fileBuffer: Buffer,
    mimeType: string,
  ): Promise<void> {
    await this.uploadExam(examCloneId, 'system', fileBuffer, 'uploaded-file', mimeType);
  }

  /**
   * Extract text from PDF with native pdf-parse AND Gemini Multimodal OCR fallback
   */
  private async extractTextFromPDF(fileBuffer: Buffer): Promise<string> {
    // 1. First attempt native PDF text extraction via pdf-parse
    try {
      const pdfData = await pdfParse(fileBuffer);
      const text = pdfData.text ? pdfData.text.trim() : '';

      if (text.length >= 50) {
        this.logger.log(`PDF text successfully parsed via pdf-parse: ${text.length} characters`);
        return text;
      }
      this.logger.warn(
        `PDF text parsed via pdf-parse was minimal (${text.length} chars). Falling back to Gemini Multimodal PDF Vision OCR...`,
      );
    } catch (error) {
      this.logger.warn(
        `pdf-parse failed (${(error as Error).message}). Falling back to Gemini Multimodal PDF Vision OCR...`,
      );
    }

    // 2. Fallback: Use Gemini Multimodal PDF Perception / OCR directly on PDF buffer
    try {
      const base64Pdf = fileBuffer.toString('base64');
      const ocrText = await this.aiService.generateWithVision({
        prompt:
          'You are an expert academic document OCR engine. Perform complete, exhaustive text extraction of all text, headings, questions, sub-parts, options, and mathematical expressions from this PDF document. Output all content clearly.',
        imageData: base64Pdf,
        mimeType: 'application/pdf',
      });

      if (ocrText && ocrText.trim().length > 0) {
        this.logger.log(
          `PDF text successfully extracted via Gemini Multimodal OCR: ${ocrText.length} chars`,
        );
        return ocrText.trim();
      }
    } catch (visionError) {
      this.logger.error(
        `Gemini Multimodal PDF OCR failed: ${(visionError as Error).message}`,
      );
    }

    throw new Error(
      'Failed to extract text from PDF. The document may be empty, encrypted, or corrupted.',
    );
  }

  /**
   * Process uploaded file from storage
   */
  async processFile(examCloneId: string, fileUrl: string, mimeType: string): Promise<void> {
    const examClone = await this.findById(examCloneId);
    if (!examClone) {
      throw new NotFoundException('Exam clone not found');
    }

    await this.updateStatus(examCloneId, 'processing');

    try {
      const key = this.storageService.extractKeyFromUrl(fileUrl);
      const fileBuffer = await this.storageService.download(key);

      let extractedText = '';
      if (mimeType === 'application/pdf') {
        extractedText = await this.extractTextFromPDF(fileBuffer);
      } else if (mimeType.startsWith('text/')) {
        extractedText = fileBuffer.toString('utf-8').trim();
      } else {
        extractedText = await this.aiService.generateWithVision({
          prompt: 'Extract all questions and text from this exam document.',
          imageData: fileBuffer.toString('base64'),
          mimeType,
        });
      }

      if (!extractedText) {
        throw new Error('Could not extract text from file');
      }

      await this.db.query(
        `UPDATE exam_clones SET original_text = $1, updated_at = $2 WHERE id = $3`,
        [extractedText, new Date(), examCloneId],
      );

      await this.analyze(examCloneId);
    } catch (error) {
      this.logger.error(`Failed to process file for exam ${examCloneId}`, error);
      await this.updateStatus(examCloneId, 'failed');
      throw error;
    }
  }

  async analyze(examCloneId: string): Promise<void> {
    const examClone = await this.findById(examCloneId);
    if (!examClone) {
      throw new NotFoundException('Exam clone not found');
    }

    await this.updateStatus(examCloneId, 'processing');

    try {
      const examText = examClone.originalText || '';

      const analysisPrompt = `You are a master academic exam parser. Your job is to extract EVERY question from the exam text below and make each question FULLY SELF-CONTAINED with all data needed to answer it.

═══════════════════════════════════════
ABSOLUTE RULE — SELF-CONTAINED QUESTIONS
═══════════════════════════════════════
Every extracted question MUST include ALL specific data inline. Never say "the given graph", "the given recurrence", "the given sequence", or "the table below" — REPLACE every such reference with the ACTUAL data embedded directly in the question text.

Rules by question type:

▶ RECURRENCE RELATIONS
- Extract the EXACT formula from the exam text and embed it.
- BAD:  "Solve the given recurrence relation."
- GOOD: "Solve the recurrence relation: T(n) = 2T(n/2) + n, with T(1) = 1, using the Master's Theorem."
- If the exact formula is not in the text, GENERATE a representative example: "T(n) = 2T(n/2) + Θ(n)"

▶ GRAPH PROBLEMS (Floyd-Warshall, Dijkstra, BFS, DFS, Hamiltonian Cycle, etc.)
- Embed a Mermaid diagram of the graph. Use adjacency/edge data from the exam text.
- If no edge data is in the text, GENERATE a small realistic example graph.
- BAD:  "Solve Floyd-Warshall for the given graph."
- GOOD: "Apply Floyd-Warshall algorithm to find all-pairs shortest paths for the following graph:\\n\\n\`\`\`mermaid\\ngraph LR\\n  1 -- \\"3\\" --> 2\\n  1 -- \\"8\\" --> 4\\n  2 -- \\"2\\" --> 3\\n  3 -- \\"5\\" --> 4\\n  4 -- \\"1\\" --> 2\\n\`\`\`\\n\\nFind the shortest distance matrix D and the path matrix P."
- Mermaid syntax for directed weighted graph: use  A -- "weight" --> B
- Mermaid syntax for undirected weighted graph: use  A -- "weight" --- B
- Mermaid syntax for unweighted directed: use  A --> B

▶ TREE / BST / AVL / HEAP QUESTIONS
- Embed the actual input sequence of numbers or values.
- BAD:  "Construct a Binary Search Tree / Find Traversals."
- GOOD: "Construct a Binary Search Tree (BST) by inserting the following keys in order: 50, 30, 70, 20, 40, 60, 80. Then find its Inorder, Preorder, and Postorder traversals."
- If data is not in the text, generate a realistic 6-8 element example.

▶ MATRIX / TABLE / DP PROBLEMS
- Embed the actual matrix values.
- BAD:  "Solve the given matrix chain multiplication problem."
- GOOD: "Solve Matrix Chain Multiplication for matrices: A₁(10×30), A₂(30×5), A₃(5×60). Find the minimum number of multiplications."

▶ SORTING / SEARCHING PROBLEMS
- Include the actual array or generate one.
- GOOD: "Sort the array [64, 34, 25, 12, 22, 11, 90] using Quick Sort. Show each partition step."

▶ CODE / ALGORITHM QUESTIONS
- If the question refers to a specific code snippet or pseudocode, include it.

═══════════════════════════════════════
GRAPH MERMAID FORMAT REFERENCE
═══════════════════════════════════════
Directed weighted:   A -- "5" --> B
Undirected weighted: A -- "5" --- B  
Directed:            A --> B
Undirected:          A --- B
Top-down tree:       graph TD  (parent --> child)
Left-right graph:    graph LR

═══════════════════════════════════════
QUESTION FORMAT REQUIREMENT (MCQ ONLY)
═══════════════════════════════════════
- EVERY extracted question MUST be a Multiple Choice Question (type: "multiple_choice").
- EVERY question MUST include an "options" array with exactly 4 choices (e.g. ["Option A text", "Option B text", "Option C text", "Option D text"]).
- Exactly ONE of the options MUST be the correct answer (or correct solution/value), matching "correctAnswer".
- The other 3 options MUST be plausible incorrect distractors.
- NEVER return null for "options" and NEVER output short_answer, essay, or fill_blank type questions.

Return valid JSON ONLY in this exact structure:
{
  "style": {
    "questionTypes": ["multiple_choice"],
    "difficultyDistribution": { "easy": 30, "medium": 50, "hard": 20 },
    "averageQuestionLength": 80,
    "topicsCovered": ["Graph Algorithms", "Dynamic Programming"],
    "formatPatterns": ["Multiple choice questions"],
    "languageStyle": "academic"
  },
  "questions": [
    {
      "type": "multiple_choice",
      "question": "COMPLETE self-contained question text with all data embedded",
      "options": ["Option A", "Option B", "Option C", "Option D"],
      "correctAnswer": "Option A",
      "difficulty": "medium",
      "topic": "Specific Topic Name"
    }
  ]
}

Exam text:
${examText.slice(0, 16000)}`;

      const analysis = await this.aiService.completeJson<{
        style?: Partial<ExamStyle>;
        questions?: Array<{
          type?: string;
          question?: string;
          options?: string[];
          correctAnswer?: string;
          difficulty?: string;
          topic?: string;
        }>;
      }>(
        [
          { role: 'system', content: 'You are an expert exam analyzer and question extractor.' },
          { role: 'user', content: analysisPrompt },
        ],
        { maxTokens: 8192 },
      );

      // Clean & fallback style metadata
      const rawStyle = analysis.style || {};
      const extractedStyle: ExamStyle = {
        questionTypes:
          Array.isArray(rawStyle.questionTypes) && rawStyle.questionTypes.length > 0
            ? rawStyle.questionTypes
            : ['short_answer', 'essay'],
        difficultyDistribution: {
          easy: typeof rawStyle.difficultyDistribution?.easy === 'number' ? rawStyle.difficultyDistribution.easy : 30,
          medium: typeof rawStyle.difficultyDistribution?.medium === 'number' ? rawStyle.difficultyDistribution.medium : 50,
          hard: typeof rawStyle.difficultyDistribution?.hard === 'number' ? rawStyle.difficultyDistribution.hard : 20,
        },
        averageQuestionLength: rawStyle.averageQuestionLength || 45,
        topicsCovered:
          Array.isArray(rawStyle.topicsCovered) && rawStyle.topicsCovered.length > 0
            ? rawStyle.topicsCovered
            : [examClone.subject || 'General Topics'],
        formatPatterns:
          Array.isArray(rawStyle.formatPatterns) && rawStyle.formatPatterns.length > 0
            ? rawStyle.formatPatterns
            : ['Standard Exam Format'],
        languageStyle: rawStyle.languageStyle || 'academic',
      };

      // Clean & validate extracted questions
      const rawQuestions = Array.isArray(analysis.questions) ? analysis.questions : [];
      const validQuestions = rawQuestions
        .filter((q) => q && typeof q.question === 'string' && q.question.trim().length > 3)
        .map((q) => ({
          type: q.type || 'short_answer',
          question: q.question!.trim(),
          options: Array.isArray(q.options) && q.options.length > 0 ? q.options : null,
          correctAnswer:
            (q.correctAnswer && q.correctAnswer.trim()) ||
            'Model solution and step-by-step breakdown provided upon review.',
          difficulty: q.difficulty || 'medium',
          topic: q.topic || examClone.subject || 'General Concepts',
        }));

      await this.db.query(
        `UPDATE exam_clones SET extracted_style = $1, original_question_count = $2, updated_at = $3 WHERE id = $4`,
        [JSON.stringify(extractedStyle), validQuestions.length, new Date(), examCloneId],
      );

      let insertedCount = 0;
      for (let i = 0; i < validQuestions.length; i++) {
        const q = validQuestions[i];
        try {
          await this.db.query(
            `INSERT INTO exam_questions (id, exam_clone_id, is_original, type, question, options, correct_answer, difficulty, topic, "order")
             VALUES ($1, $2, true, $3, $4, $5, $6, $7, $8, $9)`,
            [
              uuidv4(),
              examCloneId,
              q.type,
              q.question,
              q.options ? JSON.stringify(q.options) : null,
              q.correctAnswer,
              q.difficulty,
              q.topic,
              i,
            ],
          );
          insertedCount++;
        } catch (insertErr) {
          this.logger.warn(`Failed to insert question ${i} for exam ${examCloneId}: ${insertErr}`);
        }
      }

      await this.updateStatus(examCloneId, 'completed');
      this.logger.log(
        `Exam analyzed: ${examCloneId}, ${insertedCount}/${validQuestions.length} questions inserted`,
      );

      // Auto-generate initial clone questions if original questions were parsed
      if (insertedCount > 0) {
        try {
          await this.generateQuestions(examCloneId, examClone.userId, {
            count: 3,
            difficulty: 'match_original',
          });
        } catch (genErr) {
          this.logger.warn(`Initial question generation skipped for exam ${examCloneId}: ${(genErr as Error).message}`);
        }
      }
    } catch (error) {
      this.logger.error(`Failed to analyze exam ${examCloneId}`, error);
      // An uploaded text-based PDF is still useful when the external AI
      // provider is rate-limited or unavailable. Keep the user's paper
      // usable, rather than showing an unrecoverable Failed status.
      if (await this.completeWithTextFallback(examClone)) {
        return;
      }
      await this.updateStatus(examCloneId, 'failed');
      throw error;
    }
  }

  async generateQuestions(
    examCloneId: string,
    userId: string,
    dto: GenerateQuestionsDto,
  ): Promise<ExamQuestion[]> {
    const examClone = await this.findByIdWithAccess(examCloneId, userId);

    if (!examClone.extractedStyle) {
      throw new Error('Exam has not been analyzed yet');
    }

    const style = examClone.extractedStyle;
    const originalQuestions = await this.getQuestions(examCloneId, true);

    const generationPrompt = `Generate ${dto.count || 5} new exam questions that match this style:

Style characteristics:
- Question types: ${style.questionTypes.join(', ')}
- Difficulty distribution: Easy ${style.difficultyDistribution.easy}%, Medium ${style.difficultyDistribution.medium}%, Hard ${style.difficultyDistribution.hard}%
- Topics: ${dto.topics?.join(', ') || style.topicsCovered.join(', ')}
- Format: ${style.formatPatterns.join('; ')}
- Language: ${style.languageStyle}

Original questions for reference (match this style closely):
${originalQuestions
  .slice(0, 3)
  .map((q) => `- ${q.question}`)
  .join('\n')}

CRITICAL RULE: EVERY question MUST be a multiple choice question ("type": "multiple_choice") with exactly 4 options in the "options" array. One of the 4 options MUST be identical to "correctAnswer". Never output null for options or write-in type questions.

Return in JSON format:
{
  "questions": [
    {
      "type": "multiple_choice",
      "question": "Question text matching the style",
      "options": ["Option A", "Option B", "Option C", "Option D"],
      "correctAnswer": "Option A",
      "explanation": "Why this option is correct",
      "difficulty": "easy|medium|hard",
      "topic": "topic name"
    }
  ]
}`;

    const generated = await this.aiService.completeJson<{
      questions: Array<{
        type: string;
        question: string;
        options?: string[];
        correctAnswer: string;
        explanation?: string;
        difficulty: string;
        topic?: string;
      }>;
    }>(
      [
        {
          role: 'system',
          content:
            'You are an expert exam question generator that precisely matches the style of existing exams.',
        },
        { role: 'user', content: generationPrompt },
      ],
      { maxTokens: 8192 },
    );

    const existingCount = await this.db.queryOne<{ count: string }>(
      'SELECT COUNT(*) as count FROM exam_questions WHERE exam_clone_id = $1',
      [examCloneId],
    );
    let order = parseInt(existingCount?.count || '0', 10);

    const newQuestions: ExamQuestion[] = [];

    for (const q of generated.questions) {
      const questionId = uuidv4();
      await this.db.query(
        `INSERT INTO exam_questions (id, exam_clone_id, is_original, type, question, options, correct_answer, explanation, difficulty, topic, "order")
         VALUES ($1, $2, false, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          questionId,
          examCloneId,
          q.type,
          q.question,
          q.options ? JSON.stringify(q.options) : null,
          q.correctAnswer,
          q.explanation || null,
          q.difficulty,
          q.topic || null,
          order++,
        ],
      );

      newQuestions.push({
        id: questionId,
        examCloneId,
        isOriginal: false,
        type: q.type,
        question: q.question,
        options: q.options || null,
        correctAnswer: q.correctAnswer,
        explanation: q.explanation || null,
        difficulty: q.difficulty,
        topic: q.topic || null,
        order: order - 1,
      });
    }

    await this.db.query(
      `UPDATE exam_clones SET generated_question_count = generated_question_count + $1, updated_at = $2 WHERE id = $3`,
      [newQuestions.length, new Date(), examCloneId],
    );

    this.logger.log(`Generated ${newQuestions.length} questions for exam ${examCloneId}`);
    return newQuestions;
  }

  async reanalyze(examCloneId: string, userId: string): Promise<void> {
    const examClone = await this.findByIdWithAccess(examCloneId, userId);

    if (!examClone.originalText) {
      throw new BadRequestException('No extracted text found for this exam clone. Please re-upload the PDF file.');
    }

    // Re-analysis can include several long AI calls. Start it in the
    // background just like an upload so the client can immediately poll the
    // status instead of timing out before work has finished.
    await this.updateStatus(examCloneId, 'processing');
    void this.analyze(examCloneId).catch((error: Error) => {
      this.logger.error(`Re-analysis failed for exam ${examCloneId}: ${error.message}`);
    });
  }

  async findById(id: string): Promise<ExamClone | null> {
    const result = await this.db.queryOne<ExamClone>('SELECT * FROM exam_clones WHERE id = $1', [
      id,
    ]);
    return result ? this.mapExamClone(result) : null;
  }

  async findByIdWithAccess(id: string, userId: string): Promise<ExamClone> {
    const examClone = await this.findById(id);
    if (!examClone) {
      throw new NotFoundException('Exam clone not found');
    }
    if (examClone.userId !== userId) {
      throw new ForbiddenException('Access denied');
    }
    return examClone;
  }

  async findByUser(userId: string): Promise<ExamClone[]> {
    const results = await this.db.queryMany<ExamClone>(
      'SELECT * FROM exam_clones WHERE user_id = $1 ORDER BY created_at DESC',
      [userId],
    );
    return results.map((r) => this.mapExamClone(r));
  }

  async getQuestions(examCloneId: string, originalOnly = false): Promise<ExamQuestion[]> {
    let query = 'SELECT * FROM exam_questions WHERE exam_clone_id = $1';
    if (originalOnly) {
      query += ' AND is_original = true';
    }
    query += ' ORDER BY "order" ASC';

    const results = await this.db.queryMany<ExamQuestion>(query, [examCloneId]);
    return results.map((r) => this.mapQuestion(r));
  }

  async delete(id: string, userId: string): Promise<void> {
    await this.findByIdWithAccess(id, userId);

    await this.db.query('DELETE FROM exam_questions WHERE exam_clone_id = $1', [id]);
    await this.db.query('DELETE FROM exam_clones WHERE id = $1', [id]);

    this.logger.log(`Exam clone deleted: ${id}`);
  }

  /**
   * Get AI explanation for a question (why answer is correct/wrong)
   */
  async getExplanation(
    questionId: string,
    userAnswer: string,
    _userId: string,
  ): Promise<{ explanation: string; isCorrect: boolean; correctAnswer: string }> {
    const question = await this.db.queryOne<ExamQuestion>(
      'SELECT * FROM exam_questions WHERE id = $1',
      [questionId],
    );

    if (!question) {
      throw new NotFoundException('Question not found');
    }

    const q = this.mapQuestion(question);
    const isCorrect = userAnswer.toLowerCase().trim() === q.correctAnswer.toLowerCase().trim();

    // If already has explanation stored, return it
    if (q.explanation) {
      return { explanation: q.explanation, isCorrect, correctAnswer: q.correctAnswer };
    }

    // Generate AI explanation
    const prompt = `Question: ${q.question}
${q.options ? `Options: ${q.options.join(', ')}` : ''}

Correct Answer: ${q.correctAnswer}
User's Answer: ${userAnswer}

${isCorrect ? 'The user answered correctly.' : 'The user answered incorrectly.'}

Provide a clear, educational explanation (2-3 sentences) of:
1. Why the correct answer is correct
2. ${!isCorrect ? "Why the user's answer is wrong" : 'Any additional context'}

Be concise and helpful.`;

    const response = await this.aiService.complete(
      [
        { role: 'system', content: 'You are a helpful tutor explaining exam answers.' },
        { role: 'user', content: prompt },
      ],
      { maxTokens: 300, temperature: 0.3 },
    );

    const explanation = response.content.trim();

    // Cache the explanation in the database
    await this.db.query('UPDATE exam_questions SET explanation = $1 WHERE id = $2', [
      explanation,
      questionId,
    ]);

    return { explanation, isCorrect, correctAnswer: q.correctAnswer };
  }

  /**
   * Submit practice attempt and get results
   */
  async submitAttempt(
    examCloneId: string,
    userId: string,
    answers: Array<{ questionId: string; answer: string; timeSpent: number }>,
    totalTime: number,
  ): Promise<{
    id: string;
    score: number;
    correct: number;
    wrong: number;
    unanswered: number;
    totalQuestions: number;
    timeSpent: number;
    results: Array<{
      questionId: string;
      isCorrect: boolean;
      userAnswer: string;
      correctAnswer: string;
    }>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    newBadges: any[];
  }> {
    await this.findByIdWithAccess(examCloneId, userId);

    const questions = await this.getQuestions(examCloneId);
    const questionMap = new Map(questions.map((q) => [q.id, q]));

    let correct = 0;
    let wrong = 0;
    const results: Array<{
      questionId: string;
      isCorrect: boolean;
      userAnswer: string;
      correctAnswer: string;
    }> = [];

    for (const ans of answers) {
      const q = questionMap.get(ans.questionId);
      if (!q) continue;

      let isCorrect = false;

      // For multiple choice questions, use exact match
      if (q.options && q.options.length > 0) {
        isCorrect = ans.answer.toLowerCase().trim() === q.correctAnswer.toLowerCase().trim();
      }
      // For written answers, use AI evaluation
      else if (ans.answer && ans.answer.trim().length > 0) {
        isCorrect = await this.evaluateWrittenAnswer(q.question, q.correctAnswer, ans.answer);
      }

      if (ans.answer) {
        if (isCorrect) correct++;
        else wrong++;
      }

      results.push({
        questionId: ans.questionId,
        isCorrect,
        userAnswer: ans.answer,
        correctAnswer: q.correctAnswer,
      });
    }

    const unanswered = answers.filter((a) => !a.answer).length;
    const totalQuestions = answers.length;
    const score = Math.round((correct / totalQuestions) * 100);

    // Save attempt to database
    const attemptId = uuidv4();
    await this.db.query(
      `INSERT INTO exam_attempts (id, exam_clone_id, user_id, score, correct_count, wrong_count, unanswered_count, total_questions, time_spent, answers, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        attemptId,
        examCloneId,
        userId,
        score,
        correct,
        wrong,
        unanswered,
        totalQuestions,
        totalTime,
        JSON.stringify(answers),
        new Date(),
      ],
    );

    // Update spaced repetition queue for wrong answers
    for (const result of results) {
      if (!result.isCorrect && result.userAnswer) {
        await this.addToReviewQueue(userId, result.questionId);
      }
    }

    // Check and award badges
    const newBadges = await this.checkAndAwardBadges(userId, examCloneId);

    this.logger.log(
      `Attempt submitted for exam ${examCloneId}: ${score}% (${correct}/${totalQuestions})`,
    );

    return {
      id: attemptId,
      score,
      correct,
      wrong,
      unanswered,
      totalQuestions,
      timeSpent: totalTime,
      results,
      newBadges,
    };
  }

  /**
   * Get user's performance analytics for an exam
   */
  async getAnalytics(
    examCloneId: string,
    userId: string,
  ): Promise<{
    totalAttempts: number;
    averageScore: number;
    bestScore: number;
    totalTimeSpent: number;
    topicPerformance: Array<{ topic: string; correct: number; total: number; percentage: number }>;
    difficultyPerformance: Array<{
      difficulty: string;
      correct: number;
      total: number;
      percentage: number;
    }>;
    recentAttempts: Array<{ id: string; score: number; createdAt: Date }>;
    improvementTrend: number;
  }> {
    await this.findByIdWithAccess(examCloneId, userId);

    // Get all attempts
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const attempts = await this.db.queryMany<any>(
      'SELECT * FROM exam_attempts WHERE exam_clone_id = $1 AND user_id = $2 ORDER BY created_at DESC',
      [examCloneId, userId],
    );

    if (attempts.length === 0) {
      return {
        totalAttempts: 0,
        averageScore: 0,
        bestScore: 0,
        totalTimeSpent: 0,
        topicPerformance: [],
        difficultyPerformance: [],
        recentAttempts: [],
        improvementTrend: 0,
      };
    }

    const scores = attempts.map((a) => parseInt(a.score, 10));
    const totalAttempts = attempts.length;
    const averageScore = Math.round(scores.reduce((a, b) => a + b, 0) / totalAttempts);
    const bestScore = Math.max(...scores);
    const totalTimeSpent = attempts.reduce((acc, a) => acc + parseInt(a.time_spent || 0, 10), 0);

    // Calculate improvement trend (compare last 3 vs previous 3)
    let improvementTrend = 0;
    if (attempts.length >= 2) {
      const recent = scores.slice(0, Math.min(3, scores.length));
      const older = scores.slice(Math.min(3, scores.length), Math.min(6, scores.length));
      if (older.length > 0) {
        const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length;
        const olderAvg = older.reduce((a, b) => a + b, 0) / older.length;
        improvementTrend = Math.round(recentAvg - olderAvg);
      }
    }

    // Get topic and difficulty performance from questions
    const questions = await this.getQuestions(examCloneId);
    const topicStats = new Map<string, { correct: number; total: number }>();
    const difficultyStats = new Map<string, { correct: number; total: number }>();

    // Analyze from most recent attempt
    const latestAttempt = attempts[0];
    const latestAnswers = JSON.parse(latestAttempt.answers || '[]');

    for (const ans of latestAnswers) {
      const q = questions.find((q) => q.id === ans.questionId);
      if (!q) continue;

      const isCorrect = ans.answer?.toLowerCase().trim() === q.correctAnswer.toLowerCase().trim();
      const topic = q.topic || 'General';
      const difficulty = q.difficulty || 'medium';

      if (!topicStats.has(topic)) topicStats.set(topic, { correct: 0, total: 0 });
      if (!difficultyStats.has(difficulty))
        difficultyStats.set(difficulty, { correct: 0, total: 0 });

      topicStats.get(topic)!.total++;
      difficultyStats.get(difficulty)!.total++;
      if (isCorrect) {
        topicStats.get(topic)!.correct++;
        difficultyStats.get(difficulty)!.correct++;
      }
    }

    const topicPerformance = Array.from(topicStats.entries()).map(([topic, stats]) => ({
      topic,
      correct: stats.correct,
      total: stats.total,
      percentage: Math.round((stats.correct / stats.total) * 100),
    }));

    const difficultyPerformance = Array.from(difficultyStats.entries()).map(
      ([difficulty, stats]) => ({
        difficulty,
        correct: stats.correct,
        total: stats.total,
        percentage: Math.round((stats.correct / stats.total) * 100),
      }),
    );

    const recentAttempts = attempts.slice(0, 10).map((a) => ({
      id: a.id,
      score: parseInt(a.score, 10),
      createdAt: new Date(a.created_at),
    }));

    return {
      totalAttempts,
      averageScore,
      bestScore,
      totalTimeSpent,
      topicPerformance,
      difficultyPerformance,
      recentAttempts,
      improvementTrend,
    };
  }

  /**
   * Add question to spaced repetition review queue
   */
  private async addToReviewQueue(userId: string, questionId: string): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const existing = await this.db.queryOne<any>(
      'SELECT * FROM exam_review_queue WHERE user_id = $1 AND question_id = $2',
      [userId, questionId],
    );

    if (existing) {
      // SM-2: Decrease ease factor and reset interval
      const newEaseFactor = Math.max(1.3, parseFloat(existing.ease_factor) - 0.2);
      await this.db.query(
        `UPDATE exam_review_queue SET
         repetitions = 0,
         interval_days = 1,
         ease_factor = $1,
         next_review_at = $2,
         updated_at = $3
         WHERE id = $4`,
        [newEaseFactor, new Date(), new Date(), existing.id],
      );
    } else {
      // New entry
      await this.db.query(
        `INSERT INTO exam_review_queue (id, user_id, question_id, repetitions, interval_days, ease_factor, next_review_at, created_at, updated_at)
         VALUES ($1, $2, $3, 0, 1, 2.5, $4, $5, $6)`,
        [uuidv4(), userId, questionId, new Date(), new Date(), new Date()],
      );
    }
  }

  /**
   * Get questions due for spaced repetition review
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getReviewQueue(userId: string, limit = 10): Promise<any[]> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dueItems = await this.db.queryMany<any>(
      `SELECT q.*, rq.repetitions, rq.ease_factor, rq.next_review_at,
              ec.title as exam_clone_name
       FROM exam_review_queue rq
       JOIN exam_questions q ON rq.question_id = q.id
       JOIN exam_clones ec ON q.exam_clone_id = ec.id
       WHERE rq.user_id = $1 AND rq.next_review_at <= NOW()
       ORDER BY rq.next_review_at ASC
       LIMIT $2`,
      [userId, limit],
    );

    return dueItems.map((r) => ({
      ...this.mapQuestion(r),
      repetitions: parseInt(r.repetitions, 10) || 0,
      easeFactor: parseFloat(r.ease_factor) || 2.5,
      nextReviewAt: r.next_review_at,
      examCloneName: r.exam_clone_name || 'Unknown Exam',
    }));
  }

  /**
   * Mark review item as completed (correct or wrong)
   * Uses modified SM-2 with shorter intervals for active learning
   */
  async completeReview(userId: string, questionId: string, correct: boolean): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const item = await this.db.queryOne<any>(
      'SELECT * FROM exam_review_queue WHERE user_id = $1 AND question_id = $2',
      [userId, questionId],
    );

    if (!item) return;

    let repetitions = parseInt(item.repetitions, 10);
    let easeFactor = parseFloat(item.ease_factor);

    const nextReview = new Date();

    if (correct) {
      // Modified SM-2 with shorter initial intervals for active learning
      repetitions++;
      easeFactor = Math.max(1.3, easeFactor + 0.1 - (5 - 4) * (0.08 + (5 - 4) * 0.02));

      if (repetitions === 1) {
        // First correct: review in 10 minutes
        nextReview.setMinutes(nextReview.getMinutes() + 10);
      } else if (repetitions === 2) {
        // Second correct: review in 1 hour
        nextReview.setHours(nextReview.getHours() + 1);
      } else if (repetitions === 3) {
        // Third correct: review in 1 day
        nextReview.setDate(nextReview.getDate() + 1);
      } else if (repetitions === 4) {
        // Fourth correct: review in 3 days
        nextReview.setDate(nextReview.getDate() + 3);
      } else {
        // After that: exponential growth (6 days, then * easeFactor)
        const intervalDays = Math.round(6 * Math.pow(easeFactor, repetitions - 4));
        nextReview.setDate(nextReview.getDate() + intervalDays);
      }
    } else {
      // Wrong answer: review in 5 minutes for immediate reinforcement
      repetitions = 0;
      easeFactor = Math.max(1.3, easeFactor - 0.2);
      nextReview.setMinutes(nextReview.getMinutes() + 5);
    }

    await this.db.query(
      `UPDATE exam_review_queue SET
       repetitions = $1, ease_factor = $2, next_review_at = $3, updated_at = $4
       WHERE user_id = $5 AND question_id = $6`,
      [repetitions, easeFactor, nextReview, new Date(), userId, questionId],
    );
  }

  /**
   * Get questions with adaptive difficulty based on recent performance
   */
  async getAdaptiveQuestions(
    examCloneId: string,
    userId: string,
    count: number,
    recentPerformance: Array<{ questionId: string; correct: boolean }>,
  ): Promise<ExamQuestion[]> {
    const questions = await this.getQuestions(examCloneId);

    // Calculate recent success rate
    const recentCorrect = recentPerformance.filter((p) => p.correct).length;
    const recentTotal = recentPerformance.length;
    const successRate = recentTotal > 0 ? recentCorrect / recentTotal : 0.5;

    // Determine target difficulty
    let targetDifficulties: string[];
    if (successRate >= 0.8) {
      // Doing great - give harder questions
      targetDifficulties = ['hard', 'medium'];
    } else if (successRate >= 0.5) {
      // Average - mix of medium
      targetDifficulties = ['medium', 'easy', 'hard'];
    } else {
      // Struggling - give easier questions
      targetDifficulties = ['easy', 'medium'];
    }

    // Filter and prioritize by difficulty
    const answeredIds = new Set(recentPerformance.map((p) => p.questionId));
    const unanswered = questions.filter((q) => !answeredIds.has(q.id));

    // Sort by target difficulty priority
    const sorted = unanswered.sort((a, b) => {
      const aIndex = targetDifficulties.indexOf(a.difficulty);
      const bIndex = targetDifficulties.indexOf(b.difficulty);
      return (aIndex === -1 ? 999 : aIndex) - (bIndex === -1 ? 999 : bIndex);
    });

    // Shuffle within same priority and return
    const result = sorted.slice(0, count);
    return result.sort(() => Math.random() - 0.5);
  }

  // ==================== EXAM TEMPLATES ====================

  /**
   * Get all available exam templates
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getTemplates(): Promise<any[]> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const templates = await this.db.queryMany<any>(
      'SELECT * FROM exam_templates WHERE is_active = true ORDER BY category, name',
      [],
    );
    return templates.map((t) => ({
      id: t.id,
      name: t.name,
      slug: t.slug,
      description: t.description,
      category: t.category,
      questionTypes: t.question_types,
      difficultyDistribution: t.difficulty_distribution,
      timePerQuestion: t.time_per_question,
      totalQuestions: t.total_questions,
      subjects: t.subjects,
    }));
  }

  /**
   * Generate questions using a template style
   */
  async generateFromTemplate(
    examCloneId: string,
    userId: string,
    templateSlug: string,
    subject: string,
    count: number,
  ): Promise<ExamQuestion[]> {
    await this.findByIdWithAccess(examCloneId, userId);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const template = await this.db.queryOne<any>('SELECT * FROM exam_templates WHERE slug = $1', [
      templateSlug,
    ]);

    if (!template) {
      throw new NotFoundException('Template not found');
    }

    const examClone = await this.findById(examCloneId);
    const topics = examClone?.extractedStyle?.topicsCovered || [subject];

    const prompt = `Generate ${count} exam questions in the style of ${template.name} exam.

Template characteristics:
- Format: ${template.name} (${template.description})
- Question types: ${JSON.stringify(template.question_types)}
- Difficulty distribution: ${JSON.stringify(template.difficulty_distribution)}
- Style patterns: ${JSON.stringify(template.format_patterns)}

Subject: ${subject}
Topics to cover: ${topics.join(', ')}

Return in JSON format:
{
  "questions": [
    {
      "type": "question_type",
      "question": "Question text in ${template.name} style",
      "options": ["A", "B", "C", "D"],
      "correctAnswer": "The correct answer",
      "explanation": "Why this is correct",
      "difficulty": "easy|medium|hard",
      "topic": "topic name"
    }
  ]
}`;

    const generated = await this.aiService.completeJson<{
      questions: Array<{
        type: string;
        question: string;
        options?: string[];
        correctAnswer: string;
        explanation?: string;
        difficulty: string;
        topic?: string;
      }>;
    }>(
      [
        { role: 'system', content: `You are an expert ${template.name} exam question writer.` },
        { role: 'user', content: prompt },
      ],
      { maxTokens: 8192 },
    );

    const existingCount = await this.db.queryOne<{ count: string }>(
      'SELECT COUNT(*) as count FROM exam_questions WHERE exam_clone_id = $1',
      [examCloneId],
    );
    let order = parseInt(existingCount?.count || '0', 10);

    const newQuestions: ExamQuestion[] = [];

    for (const q of generated.questions) {
      const questionId = uuidv4();
      await this.db.query(
        `INSERT INTO exam_questions (id, exam_clone_id, is_original, type, question, options, correct_answer, explanation, difficulty, topic, "order")
         VALUES ($1, $2, false, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          questionId,
          examCloneId,
          q.type,
          q.question,
          q.options ? JSON.stringify(q.options) : null,
          q.correctAnswer,
          q.explanation || null,
          q.difficulty,
          q.topic || subject,
          order++,
        ],
      );

      newQuestions.push({
        id: questionId,
        examCloneId,
        isOriginal: false,
        type: q.type,
        question: q.question,
        options: q.options || null,
        correctAnswer: q.correctAnswer,
        explanation: q.explanation || null,
        difficulty: q.difficulty,
        topic: q.topic || subject,
        order: order - 1,
      });
    }

    await this.db.query(
      `UPDATE exam_clones SET generated_question_count = generated_question_count + $1, updated_at = $2 WHERE id = $3`,
      [newQuestions.length, new Date(), examCloneId],
    );

    this.logger.log(`Generated ${newQuestions.length} questions using ${template.name} template`);
    return newQuestions;
  }

  private async updateStatus(id: string, status: ExamClone['status']): Promise<void> {
    await this.db.query('UPDATE exam_clones SET status = $1, updated_at = $2 WHERE id = $3', [
      status,
      new Date(),
      id,
    ]);
  }

  private mapExamClone(row: unknown): ExamClone {
    const r = row as Record<string, unknown>;
    return {
      id: r.id as string,
      userId: r.user_id as string,
      title: r.title as string,
      subject: r.subject as string | null,
      originalFileUrl: r.original_file_url as string | null,
      originalText: r.original_text as string | null,
      extractedStyle: r.extracted_style
        ? typeof r.extracted_style === 'string'
          ? JSON.parse(r.extracted_style)
          : (r.extracted_style as ExamStyle)
        : null,
      status: r.status as ExamClone['status'],
      originalQuestionCount: parseInt(String(r.original_question_count || 0), 10),
      generatedQuestionCount: parseInt(String(r.generated_question_count || 0), 10),
      createdAt: new Date(r.created_at as string),
      updatedAt: new Date(r.updated_at as string),
    };
  }

  /**
   * Public method to evaluate a single answer using AI (for review queue)
   */
  async evaluateAnswerAI(
    questionId: string,
    userAnswer: string,
  ): Promise<{
    isCorrect: boolean;
    score: number;
    feedback: string;
    correctAnswer: string;
  }> {
    const question = await this.db.queryOne<ExamQuestion>(
      'SELECT * FROM exam_questions WHERE id = $1',
      [questionId],
    );

    if (!question) {
      throw new NotFoundException('Question not found');
    }

    const q = this.mapQuestion(question);

    // For multiple choice, simple comparison
    if (q.options && q.options.length > 0) {
      const isCorrect = userAnswer.toLowerCase().trim() === q.correctAnswer.toLowerCase().trim();
      return {
        isCorrect,
        score: isCorrect ? 100 : 0,
        feedback: isCorrect ? 'Correct!' : 'Incorrect. Check the correct answer below.',
        correctAnswer: q.correctAnswer,
      };
    }

    // For written answers, use AI evaluation
    try {
      const evaluationPrompt = `You are evaluating a student's answer to an exam question.

Question: ${q.question}

Expected Answer: ${q.correctAnswer}

Student's Answer: ${userAnswer}

Evaluate the student's answer based on:
1. Factual accuracy
2. Completeness of key points
3. Understanding of concepts

Respond in JSON format:
{
  "score": <number 0-100>,
  "isCorrect": <boolean>,
  "feedback": "<constructive feedback: what was good and what could be improved>"
}

Consider the answer correct (isCorrect: true) if the score is >= 70.
Be fair and encouraging - if the student demonstrates understanding even with different wording, give credit.`;

      const evaluation = await this.aiService.completeJson<{
        score: number;
        isCorrect: boolean;
        feedback: string;
      }>(
        [
          { role: 'system', content: 'You are an expert exam grader who is fair and encouraging.' },
          { role: 'user', content: evaluationPrompt },
        ],
        { maxTokens: 500 },
      );

      return {
        isCorrect: evaluation.isCorrect,
        score: evaluation.score,
        feedback: evaluation.feedback,
        correctAnswer: q.correctAnswer,
      };
    } catch (error) {
      this.logger.error(`AI evaluation failed for question ${questionId}: ${error.message}`);
      // Fallback to string comparison
      const isCorrect = userAnswer.toLowerCase().trim() === q.correctAnswer.toLowerCase().trim();
      return {
        isCorrect,
        score: isCorrect ? 100 : 0,
        feedback: isCorrect
          ? 'Correct!'
          : 'Your answer differs from the expected answer. Please review.',
        correctAnswer: q.correctAnswer,
      };
    }
  }

  /**
   * Evaluate written answer using AI semantic comparison
   * Returns true if answer is semantically correct (>= 70% match)
   */
  private async evaluateWrittenAnswer(
    question: string,
    correctAnswer: string,
    userAnswer: string,
  ): Promise<boolean> {
    try {
      const evaluationPrompt = `You are evaluating a student's answer to an exam question.

Question: ${question}

Expected Answer: ${correctAnswer}

Student's Answer: ${userAnswer}

Evaluate the student's answer based on:
1. Factual accuracy
2. Completeness of key points
3. Understanding of concepts

Respond in JSON format:
{
  "score": <number 0-100>,
  "isCorrect": <boolean>,
  "feedback": "<brief feedback on what was good or missing>"
}

Consider the answer correct (isCorrect: true) if the score is >= 70.
Be fair - if the student demonstrates understanding even with different wording, give credit.`;

      const evaluation = await this.aiService.completeJson<{
        score: number;
        isCorrect: boolean;
        feedback: string;
      }>(
        [
          { role: 'system', content: 'You are an expert exam grader.' },
          { role: 'user', content: evaluationPrompt },
        ],
        { maxTokens: 500 },
      );

      this.logger.debug(
        `AI Evaluation: Question="${question.substring(0, 50)}...", ` +
          `Score=${evaluation.score}, IsCorrect=${evaluation.isCorrect}, ` +
          `Feedback="${evaluation.feedback.substring(0, 100)}..."`,
      );

      return evaluation.isCorrect;
    } catch (error) {
      this.logger.error(`AI evaluation failed, falling back to string match: ${error.message}`);
      // Fallback to simple string comparison if AI fails
      return userAnswer.toLowerCase().trim() === correctAnswer.toLowerCase().trim();
    }
  }

  private mapQuestion(row: unknown): ExamQuestion {
    const r = row as Record<string, unknown>;
    return {
      id: r.id as string,
      examCloneId: r.exam_clone_id as string,
      isOriginal: r.is_original as boolean,
      type: r.type as string,
      question: r.question as string,
      options: r.options
        ? typeof r.options === 'string'
          ? JSON.parse(r.options)
          : (r.options as string[])
        : null,
      correctAnswer: r.correct_answer as string,
      explanation: r.explanation as string | null,
      difficulty: r.difficulty as string,
      topic: r.topic as string | null,
      order: r.order as number,
    };
  }

  // ==================== BOOKMARKS ====================

  async bookmarkQuestion(userId: string, questionId: string, note?: string): Promise<void> {
    await this.db.query(
      `INSERT INTO exam_bookmarks (id, user_id, question_id, note, created_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, question_id) DO UPDATE SET note = $4`,
      [uuidv4(), userId, questionId, note || null, new Date()],
    );
    this.logger.log(`Question ${questionId} bookmarked by user ${userId}`);
  }

  async unbookmarkQuestion(userId: string, questionId: string): Promise<void> {
    await this.db.query('DELETE FROM exam_bookmarks WHERE user_id = $1 AND question_id = $2', [
      userId,
      questionId,
    ]);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getBookmarkedQuestions(userId: string): Promise<any[]> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const results = await this.db.queryMany<any>(
      `SELECT q.*, b.note as bookmark_note, b.created_at as bookmarked_at, ec.title as exam_title
       FROM exam_bookmarks b
       JOIN exam_questions q ON b.question_id = q.id
       JOIN exam_clones ec ON q.exam_clone_id = ec.id
       WHERE b.user_id = $1
       ORDER BY b.created_at DESC`,
      [userId],
    );
    return results.map((r) => ({
      ...this.mapQuestion(r),
      bookmarkNote: r.bookmark_note,
      bookmarkedAt: r.bookmarked_at,
      examTitle: r.exam_title,
    }));
  }

  async isQuestionBookmarked(userId: string, questionId: string): Promise<boolean> {
    const result = await this.db.queryOne<{ count: string }>(
      'SELECT COUNT(*) as count FROM exam_bookmarks WHERE user_id = $1 AND question_id = $2',
      [userId, questionId],
    );
    return parseInt(result?.count || '0', 10) > 0;
  }

  // ==================== BADGES ====================

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getBadges(): Promise<any[]> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const badges = await this.db.queryMany<any>(
      'SELECT * FROM exam_badges WHERE is_active = true ORDER BY category, requirement_value',
      [],
    );
    return badges.map((b) => ({
      id: b.id,
      slug: b.slug,
      name: b.name,
      description: b.description,
      icon: b.icon,
      color: b.color,
      category: b.category,
      requirementType: b.requirement_type,
      requirementValue: b.requirement_value,
      xpReward: b.xp_reward,
    }));
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getUserBadges(userId: string): Promise<any[]> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const badges = await this.db.queryMany<any>(
      `SELECT b.*, ub.earned_at, ec.title as exam_title
       FROM user_exam_badges ub
       JOIN exam_badges b ON ub.badge_id = b.id
       LEFT JOIN exam_clones ec ON ub.exam_clone_id = ec.id
       WHERE ub.user_id = $1
       ORDER BY ub.earned_at DESC`,
      [userId],
    );
    return badges.map((b) => ({
      id: b.id,
      slug: b.slug,
      name: b.name,
      description: b.description,
      icon: b.icon,
      color: b.color,
      category: b.category,
      earnedAt: b.earned_at,
      examTitle: b.exam_title,
    }));
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async checkAndAwardBadges(userId: string, examCloneId?: string): Promise<any[]> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const newBadges: any[] = [];

    // Get user stats
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stats = await this.db.queryOne<any>(
      `SELECT
         COUNT(DISTINCT id) as total_exams,
         COALESCE(AVG(score), 0) as avg_score,
         COALESCE(SUM(correct_count), 0) as total_correct,
         COALESCE(MAX(score), 0) as best_score
       FROM exam_attempts WHERE user_id = $1`,
      [userId],
    );

    const totalExams = parseInt(stats?.total_exams || '0', 10);
    const bestScore = parseInt(stats?.best_score || '0', 10);
    const totalCorrect = parseInt(stats?.total_correct || '0', 10);

    // Get review stats
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const reviewStats = await this.db.queryOne<any>(
      `SELECT COUNT(*) as review_count FROM exam_review_queue WHERE user_id = $1 AND repetitions > 0`,
      [userId],
    );
    const reviewCount = parseInt(reviewStats?.review_count || '0', 10);

    // Get already earned badges
    const earnedBadges = await this.db.queryMany<{ badge_id: string }>(
      'SELECT badge_id FROM user_exam_badges WHERE user_id = $1',
      [userId],
    );
    const earnedBadgeIds = new Set(earnedBadges.map((b) => b.badge_id));

    // Get all badges
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const allBadges = await this.db.queryMany<any>(
      'SELECT * FROM exam_badges WHERE is_active = true',
      [],
    );

    for (const badge of allBadges) {
      if (earnedBadgeIds.has(badge.id)) continue;

      let earned = false;

      switch (badge.slug) {
        case 'first_exam':
          earned = totalExams >= 1;
          break;
        case 'ten_exams':
          earned = totalExams >= 10;
          break;
        case 'fifty_exams':
          earned = totalExams >= 50;
          break;
        case 'hundred_exams':
          earned = totalExams >= 100;
          break;
        case 'perfect_score':
          earned = bestScore >= 100;
          break;
        case 'hundred_questions':
          earned = totalCorrect >= 100;
          break;
        case 'thousand_questions':
          earned = totalCorrect >= 1000;
          break;
        case 'review_starter':
          earned = reviewCount >= 10;
          break;
        case 'review_master':
          earned = reviewCount >= 100;
          break;
      }

      if (earned) {
        await this.db.query(
          `INSERT INTO user_exam_badges (id, user_id, badge_id, exam_clone_id, earned_at)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (user_id, badge_id) DO NOTHING`,
          [uuidv4(), userId, badge.id, examCloneId || null, new Date()],
        );
        newBadges.push({
          id: badge.id,
          slug: badge.slug,
          name: badge.name,
          description: badge.description,
          icon: badge.icon,
          color: badge.color,
          xpReward: badge.xp_reward,
        });
        this.logger.log(`Badge ${badge.slug} awarded to user ${userId}`);
      }
    }

    return newBadges;
  }

  // ==================== LEADERBOARD ====================

  async getLeaderboard(
    period: 'weekly' | 'monthly' | 'all_time' = 'weekly',
    limit = 10,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<any[]> {
    let dateFilter = '';
    if (period === 'weekly') {
      dateFilter = "AND ea.created_at >= NOW() - INTERVAL '7 days'";
    } else if (period === 'monthly') {
      dateFilter = "AND ea.created_at >= NOW() - INTERVAL '30 days'";
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const results = await this.db.queryMany<any>(
      `SELECT
         u.id as user_id,
         u.name,
         u.avatar_url,
         COUNT(DISTINCT ea.id) as total_exams,
         COALESCE(AVG(ea.score), 0)::INTEGER as avg_score,
         COALESCE(SUM(ea.correct_count), 0)::INTEGER as total_correct,
         COALESCE(MAX(ea.score), 0) as best_score,
         ROW_NUMBER() OVER (ORDER BY AVG(ea.score) DESC, SUM(ea.correct_count) DESC) as rank
       FROM users u
       INNER JOIN exam_attempts ea ON u.id = ea.user_id
       WHERE 1=1 ${dateFilter}
       GROUP BY u.id, u.name, u.avatar_url
       ORDER BY avg_score DESC, total_correct DESC
       LIMIT $1`,
      [limit],
    );

    return results.map((r) => ({
      userId: r.user_id,
      name: r.name,
      avatarUrl: r.avatar_url,
      totalExams: parseInt(r.total_exams, 10),
      avgScore: parseInt(r.avg_score, 10),
      totalCorrect: parseInt(r.total_correct, 10),
      bestScore: parseInt(r.best_score, 10),
      rank: parseInt(r.rank, 10),
    }));
  }

  async getUserRank(
    userId: string,
    period: 'weekly' | 'monthly' | 'all_time' = 'weekly',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<any> {
    let dateFilter = '';
    if (period === 'weekly') {
      dateFilter = "AND ea.created_at >= NOW() - INTERVAL '7 days'";
    } else if (period === 'monthly') {
      dateFilter = "AND ea.created_at >= NOW() - INTERVAL '30 days'";
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await this.db.queryOne<any>(
      `WITH ranked AS (
         SELECT
           u.id as user_id,
           COALESCE(AVG(ea.score), 0)::INTEGER as avg_score,
           COALESCE(SUM(ea.correct_count), 0)::INTEGER as total_correct,
           ROW_NUMBER() OVER (ORDER BY AVG(ea.score) DESC, SUM(ea.correct_count) DESC) as rank
         FROM users u
         INNER JOIN exam_attempts ea ON u.id = ea.user_id
         WHERE 1=1 ${dateFilter}
         GROUP BY u.id
       )
       SELECT * FROM ranked WHERE user_id = $1`,
      [userId],
    );

    if (!result) {
      return { rank: null, avgScore: 0, totalCorrect: 0 };
    }

    return {
      rank: parseInt(result.rank, 10),
      avgScore: parseInt(result.avg_score, 10),
      totalCorrect: parseInt(result.total_correct, 10),
    };
  }
}
