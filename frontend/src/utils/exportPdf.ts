import { jsPDF } from 'jspdf';
import 'jspdf-autotable';

interface ExamQuestion {
  id: string;
  type: string;
  question: string;
  options: string[] | null;
  correctAnswer: string;
  explanation: string | null;
  difficulty: string;
  topic: string | null;
}

interface ExportOptions {
  title: string;
  subject?: string;
  includeAnswers: boolean;
  includeExplanations: boolean;
}

declare module 'jspdf' {
  interface jsPDF {
    autoTable: (options: {
      startY?: number;
      head?: string[][];
      body?: string[][];
      theme?: string;
      headStyles?: { fillColor: number[]; textColor?: number[]; fontStyle?: string };
      columnStyles?: Record<number, { cellWidth?: number | string; halign?: string }>;
      styles?: { fontSize?: number; cellPadding?: number; overflow?: string };
      margin?: { left?: number; right?: number };
    }) => jsPDF;
  }
}

export function exportQuestionsToPdf(
  questions: ExamQuestion[],
  options: ExportOptions
): void {
  const doc = new jsPDF({
    orientation: 'portrait',
    unit: 'mm',
    format: 'a4',
  });

  const pageWidth = doc.internal.pageSize.getWidth(); // ~210 mm
  const pageHeight = doc.internal.pageSize.getHeight(); // ~297 mm
  const margin = 15;
  const contentWidth = pageWidth - margin * 2; // ~180 mm
  const maxY = pageHeight - 20;

  let yPos = 15;

  // Helper: Add decorative header bar on Page 1
  const drawHeaderBanner = () => {
    // Header background bar (Purple theme)
    doc.setFillColor(124, 58, 237); // #7c3aed (Purple 600)
    doc.rect(0, 0, pageWidth, 18, 'F');

    // Brand title in header
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(255, 255, 255);
    doc.text('EDUVERSE', margin, 12);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.text('AI-POWERED EXAM & STUDY PLATFORM', pageWidth - margin, 12, { align: 'right' });

    yPos = 28;
  };

  drawHeaderBanner();

  // Document Title
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(18);
  doc.setTextColor(30, 41, 59); // Slate 800
  const titleLines = doc.splitTextToSize(options.title, contentWidth);
  doc.text(titleLines, margin, yPos);
  yPos += titleLines.length * 7 + 2;

  // Subject & Metadata Subtitle
  if (options.subject) {
    doc.setFont('helvetica', 'medium');
    doc.setFontSize(11);
    doc.setTextColor(100, 116, 139); // Slate 500
    doc.text(`Subject: ${options.subject}`, margin, yPos);
    yPos += 6;
  }

  // Date & Overview Metadata Line
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(148, 163, 184); // Slate 400
  const dateStr = new Date().toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
  doc.text(`Generated: ${dateStr}  •  Total Questions: ${questions.length}`, margin, yPos);
  yPos += 8;

  // Summary Stats Box
  doc.setFillColor(248, 250, 252); // Slate 50
  doc.setDrawColor(226, 232, 240); // Slate 200
  doc.roundedRect(margin, yPos, contentWidth, 12, 2, 2, 'FD');

  const diffCounts = questions.reduce(
    (acc, q) => {
      acc[q.difficulty] = (acc[q.difficulty] || 0) + 1;
      return acc;
    },
    {} as Record<string, number>
  );

  doc.setFontSize(9);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(71, 85, 105);
  doc.text('Question Breakdown:', margin + 4, yPos + 7.5);

  doc.setFont('helvetica', 'normal');
  doc.setTextColor(34, 197, 94); // Green
  doc.text(`Easy: ${diffCounts.easy || 0}`, margin + 45, yPos + 7.5);

  doc.setTextColor(234, 88, 12); // Amber/Orange
  doc.text(`Medium: ${diffCounts.medium || 0}`, margin + 75, yPos + 7.5);

  doc.setTextColor(225, 29, 72); // Red
  doc.text(`Hard: ${diffCounts.hard || 0}`, margin + 110, yPos + 7.5);

  yPos += 18;

  // Divider Line
  doc.setDrawColor(203, 213, 225);
  doc.setLineWidth(0.5);
  doc.line(margin, yPos, pageWidth - margin, yPos);
  yPos += 10;

  // Helper for Page Check
  const checkNewPage = (neededSpace = 30) => {
    if (yPos + neededSpace > maxY) {
      doc.addPage();
      yPos = 20;
      return true;
    }
    return false;
  };

  // Questions Loop
  questions.forEach((question, index) => {
    // Check space for starting question header + text
    checkNewPage(35);

    const qNumber = index + 1;

    // Question Number Label
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(124, 58, 237); // Purple 600
    const qNumText = `Question ${qNumber}`;
    doc.text(qNumText, margin, yPos);

    const qNumWidth = doc.getTextWidth(qNumText);
    const badgeX = margin + qNumWidth + 6;

    // Difficulty Pill Badge
    const diff = (question.difficulty || 'medium').toLowerCase();
    let badgeFill = [234, 88, 12]; // Medium default (orange)
    let badgeText = 'MEDIUM';

    if (diff === 'easy') {
      badgeFill = [34, 197, 94];
      badgeText = 'EASY';
    } else if (diff === 'hard') {
      badgeFill = [225, 29, 72];
      badgeText = 'HARD';
    }

    doc.setFillColor(badgeFill[0], badgeFill[1], badgeFill[2]);
    doc.roundedRect(badgeX, yPos - 4, 18, 5, 1, 1, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7);
    doc.setTextColor(255, 255, 255);
    doc.text(badgeText, badgeX + 9, yPos - 0.5, { align: 'center' });

    // Topic Tag
    if (question.topic) {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8.5);
      doc.setTextColor(148, 163, 184);
      doc.text(`[${question.topic}]`, badgeX + 22, yPos);
    }

    yPos += 7;

    // Question Body Text
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.setTextColor(30, 41, 59); // Slate 800
    const qLines = doc.splitTextToSize(question.question, contentWidth);
    
    // Ensure room for question body
    checkNewPage(qLines.length * 5 + 10);
    doc.text(qLines, margin, yPos);
    yPos += qLines.length * 5.5 + 4;

    // Render Options if available (MCQ)
    if (question.options && Array.isArray(question.options) && question.options.length > 0) {
      question.options.forEach((opt, i) => {
        const letter = String.fromCharCode(65 + i);
        const isCorrect = opt === question.correctAnswer;
        const optText = `${letter}) ${opt}`;
        const optLines = doc.splitTextToSize(optText, contentWidth - 8);

        checkNewPage(optLines.length * 5 + 4);

        if (options.includeAnswers && isCorrect) {
          // Highlight correct option row
          const blockHeight = Math.max(optLines.length * 5.5 + 2, 7);
          doc.setFillColor(240, 253, 244); // Green 50
          doc.setDrawColor(187, 247, 208); // Green 200
          doc.roundedRect(margin, yPos - 3.5, contentWidth, blockHeight, 1, 1, 'FD');

          doc.setFont('helvetica', 'bold');
          doc.setTextColor(22, 101, 52); // Green 800
          doc.text(optLines, margin + 4, yPos);
          doc.setFontSize(8);
          doc.text('✓ Correct Answer', pageWidth - margin - 4, yPos, { align: 'right' });
          doc.setFontSize(10);
        } else {
          doc.setFont('helvetica', 'normal');
          doc.setTextColor(51, 65, 85); // Slate 700
          doc.text(optLines, margin + 4, yPos);
        }

        yPos += optLines.length * 5.5 + 3;
      });
      yPos += 2;
    }

    // Render Answer Block (if answers included and non-MCQ, OR for comprehensive review)
    if (options.includeAnswers && (!question.options || question.options.length === 0)) {
      const ansHeader = 'Answer: ';
      const ansLines = doc.splitTextToSize(question.correctAnswer, contentWidth - 22);

      checkNewPage(ansLines.length * 5 + 8);

      const boxHeight = ansLines.length * 5.5 + 5;
      doc.setFillColor(240, 253, 244); // Green 50
      doc.setDrawColor(187, 247, 208); // Green 200
      doc.roundedRect(margin, yPos - 3, contentWidth, boxHeight, 1.5, 1.5, 'FD');

      doc.setFont('helvetica', 'bold');
      doc.setFontSize(9.5);
      doc.setTextColor(22, 101, 52); // Green 800
      doc.text(ansHeader, margin + 4, yPos + 2);

      doc.setFont('helvetica', 'normal');
      doc.text(ansLines, margin + 20, yPos + 2);

      yPos += boxHeight + 4;
    }

    // Render Explanation Block
    if (options.includeExplanations && question.explanation) {
      const expLines = doc.splitTextToSize(question.explanation, contentWidth - 26);
      checkNewPage(expLines.length * 5 + 8);

      const boxHeight = expLines.length * 5 + 5;
      doc.setFillColor(240, 249, 255); // Sky 50
      doc.setDrawColor(186, 230, 253); // Sky 200
      doc.roundedRect(margin, yPos - 3, contentWidth, boxHeight, 1.5, 1.5, 'FD');

      doc.setFont('helvetica', 'bold');
      doc.setFontSize(9);
      doc.setTextColor(3, 105, 161); // Sky 700
      doc.text('Explanation: ', margin + 4, yPos + 2);

      doc.setFont('helvetica', 'normal');
      doc.setTextColor(51, 65, 85);
      doc.text(expLines, margin + 26, yPos + 2);

      yPos += boxHeight + 4;
    }

    yPos += 4;

    // Question Separator
    doc.setDrawColor(241, 245, 249); // Slate 100
    doc.setLineWidth(0.4);
    doc.line(margin, yPos, pageWidth - margin, yPos);
    yPos += 6;
  });

  // Standalone Answer Key Page (if inline answers were disabled)
  if (!options.includeAnswers) {
    doc.addPage();
    yPos = 20;

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(16);
    doc.setTextColor(30, 41, 59);
    doc.text('Answer Key & Model Solutions', pageWidth / 2, yPos, { align: 'center' });
    yPos += 12;

    const tableData = questions.map((q, i) => [
      `${i + 1}`,
      q.topic || 'General',
      q.difficulty.toUpperCase(),
      q.correctAnswer,
    ]);

    doc.autoTable({
      startY: yPos,
      head: [['#', 'Topic', 'Difficulty', 'Correct Answer / Model Solution']],
      body: tableData,
      theme: 'striped',
      headStyles: { fillColor: [124, 58, 237], textColor: [255, 255, 255], fontStyle: 'bold' },
      columnStyles: {
        0: { cellWidth: 12, halign: 'center' },
        1: { cellWidth: 35 },
        2: { cellWidth: 25, halign: 'center' },
        3: { cellWidth: 'auto' },
      },
      styles: { fontSize: 8.5, cellPadding: 3, overflow: 'linebreak' },
      margin: { left: margin, right: margin },
    });
  }

  // Global Page Footer on Every Page
  const totalPages = doc.getNumberOfPages();
  for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
    doc.setPage(pageNum);

    // Footer line
    doc.setDrawColor(226, 232, 240);
    doc.setLineWidth(0.3);
    doc.line(margin, pageHeight - 12, pageWidth - margin, pageHeight - 12);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(148, 163, 184); // Slate 400

    doc.text(`Page ${pageNum} of ${totalPages}`, margin, pageHeight - 6);
    doc.text('Eduverse AI Learning Platform  •  Confidential Study Material', pageWidth / 2, pageHeight - 6, {
      align: 'center',
    });
    doc.text(dateStr, pageWidth - margin, pageHeight - 6, { align: 'right' });
  }

  // Save PDF file
  const safeFilename = `${options.title.replace(/[^a-z0-9]/gi, '_').toLowerCase()}_exam.pdf`;
  doc.save(safeFilename);
}
