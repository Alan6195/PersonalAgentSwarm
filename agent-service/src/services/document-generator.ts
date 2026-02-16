/**
 * Document Generator Service
 *
 * Generates PDF documents using PDFKit. Used by comms-drafter and
 * ascend-builder agents when they output [DOCUMENT:type] action blocks.
 *
 * Supported document types: proposal, report, memo, invoice, letter
 */

import PDFDocument from 'pdfkit';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface DocumentSection {
  heading?: string;
  body: string;
}

export interface DocumentOptions {
  type: 'proposal' | 'report' | 'memo' | 'invoice' | 'letter';
  title: string;
  subtitle?: string;
  author?: string;
  date?: string;
  recipient?: string;
  sections: DocumentSection[];
  footer?: string;
}

export interface GeneratedDocument {
  filePath: string;
  fileName: string;
  sizeBytes: number;
}

// Brand colors
const BRAND = {
  primary: '#1a1a2e',     // Dark navy
  accent: '#00ff9d',      // Neon green (Ascend brand)
  text: '#333333',
  lightText: '#666666',
  divider: '#e0e0e0',
};

/**
 * Generate a PDF document and save to a temp file.
 * Returns the file path for Telegram upload.
 */
export async function generateDocument(options: DocumentOptions): Promise<GeneratedDocument> {
  const fileName = `${options.type}_${Date.now()}.pdf`;
  const filePath = path.join(os.tmpdir(), fileName);

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'LETTER',
      margins: { top: 60, bottom: 60, left: 60, right: 60 },
      info: {
        Title: options.title,
        Author: options.author || 'Alan Jacobson / Ascend Intuition',
        Creator: 'Agent Swarm Document Generator',
      },
    });

    const stream = fs.createWriteStream(filePath);
    doc.pipe(stream);

    // ---- Header ----
    renderHeader(doc, options);

    // ---- Sections ----
    for (let i = 0; i < options.sections.length; i++) {
      const section = options.sections[i];

      if (section.heading) {
        doc.moveDown(0.8);
        doc
          .font('Helvetica-Bold')
          .fontSize(14)
          .fillColor(BRAND.primary)
          .text(section.heading, { underline: false });

        // Accent underline
        const y = doc.y + 2;
        doc
          .moveTo(60, y)
          .lineTo(180, y)
          .lineWidth(2)
          .strokeColor(BRAND.accent)
          .stroke();

        doc.moveDown(0.4);
      }

      // Body text: handle markdown-like bold and bullet points
      renderBodyText(doc, section.body);
    }

    // ---- Footer ----
    if (options.footer) {
      doc.moveDown(2);
      doc
        .font('Helvetica-Oblique')
        .fontSize(9)
        .fillColor(BRAND.lightText)
        .text(options.footer, { align: 'center' });
    }

    // Page number footer on every page
    const pageCount = doc.bufferedPageRange();
    for (let i = 0; i < pageCount.count; i++) {
      doc.switchToPage(i);
      doc
        .font('Helvetica')
        .fontSize(8)
        .fillColor(BRAND.lightText)
        .text(
          `Page ${i + 1} of ${pageCount.count}`,
          60,
          doc.page.height - 40,
          { align: 'center', width: doc.page.width - 120 }
        );
    }

    doc.end();

    stream.on('finish', () => {
      const stats = fs.statSync(filePath);
      console.log(`[DocGen] Generated ${options.type}: ${fileName} (${stats.size} bytes)`);
      resolve({ filePath, fileName, sizeBytes: stats.size });
    });

    stream.on('error', (err) => {
      console.error(`[DocGen] Failed to generate document: ${err.message}`);
      reject(err);
    });
  });
}

function renderHeader(doc: PDFKit.PDFDocument, options: DocumentOptions): void {
  const typeLabel = options.type.charAt(0).toUpperCase() + options.type.slice(1);

  // Type badge (top-right)
  doc
    .font('Helvetica-Bold')
    .fontSize(10)
    .fillColor(BRAND.accent)
    .text(typeLabel.toUpperCase(), 400, 30, { align: 'right', width: 152 });

  // Title
  doc
    .font('Helvetica-Bold')
    .fontSize(22)
    .fillColor(BRAND.primary)
    .text(options.title, 60, 50, { width: 400 });

  // Subtitle
  if (options.subtitle) {
    doc.moveDown(0.2);
    doc
      .font('Helvetica')
      .fontSize(12)
      .fillColor(BRAND.lightText)
      .text(options.subtitle);
  }

  // Meta line (date, author, recipient)
  doc.moveDown(0.4);
  const metaParts: string[] = [];
  if (options.date) metaParts.push(options.date);
  if (options.author) metaParts.push(`Prepared by: ${options.author}`);
  if (options.recipient) metaParts.push(`For: ${options.recipient}`);

  if (metaParts.length > 0) {
    doc
      .font('Helvetica')
      .fontSize(9)
      .fillColor(BRAND.lightText)
      .text(metaParts.join('  |  '));
  }

  // Divider
  doc.moveDown(0.6);
  const divY = doc.y;
  doc
    .moveTo(60, divY)
    .lineTo(doc.page.width - 60, divY)
    .lineWidth(1)
    .strokeColor(BRAND.divider)
    .stroke();

  doc.moveDown(0.4);
}

function renderBodyText(doc: PDFKit.PDFDocument, text: string): void {
  const lines = text.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed) {
      doc.moveDown(0.3);
      continue;
    }

    // Bullet point
    if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
      const content = trimmed.substring(2);
      doc
        .font('Helvetica')
        .fontSize(10)
        .fillColor(BRAND.text)
        .text(`  \u2022  ${content}`, { indent: 10 });
      continue;
    }

    // Numbered list
    const numberedMatch = trimmed.match(/^(\d+)\.\s+(.+)/);
    if (numberedMatch) {
      doc
        .font('Helvetica')
        .fontSize(10)
        .fillColor(BRAND.text)
        .text(`  ${numberedMatch[1]}.  ${numberedMatch[2]}`, { indent: 10 });
      continue;
    }

    // Bold text: **text** or *text*
    if (trimmed.includes('**') || trimmed.includes('*')) {
      renderRichText(doc, trimmed);
      continue;
    }

    // Normal paragraph
    doc
      .font('Helvetica')
      .fontSize(10)
      .fillColor(BRAND.text)
      .text(trimmed, { lineGap: 2 });
  }
}

function renderRichText(doc: PDFKit.PDFDocument, text: string): void {
  // Simple bold handling: split on ** markers
  const parts = text.split(/(\*\*[^*]+\*\*)/g);

  for (const part of parts) {
    if (part.startsWith('**') && part.endsWith('**')) {
      const bold = part.slice(2, -2);
      doc
        .font('Helvetica-Bold')
        .fontSize(10)
        .fillColor(BRAND.text)
        .text(bold, { continued: true });
    } else if (part) {
      doc
        .font('Helvetica')
        .fontSize(10)
        .fillColor(BRAND.text)
        .text(part, { continued: true });
    }
  }

  // End the line
  doc.text('', { continued: false });
}

/**
 * Clean up a generated document after it's been sent.
 */
export function cleanupDocument(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      console.log(`[DocGen] Cleaned up: ${filePath}`);
    }
  } catch (err) {
    console.warn(`[DocGen] Cleanup failed: ${(err as Error).message}`);
  }
}
