/**
 * Document generation utility.
 * Converts markdown-style content into .docx Word documents.
 */

import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  AlignmentType,
  TableRow,
  TableCell,
  Table,
  WidthType,
} from "docx";

interface DocSection {
  type: "heading1" | "heading2" | "heading3" | "paragraph" | "bullet" | "numbered" | "table";
  content: string;
  rows?: string[][];
}

/**
 * Parse markdown-ish content into structured sections.
 */
function parseContent(content: string): DocSection[] {
  const lines = content.split("\n");
  const sections: DocSection[] = [];
  let numberedCounter = 0;
  let tableRows: string[][] = [];
  let inTable = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Table row (pipe-delimited)
    if (line.trim().startsWith("|") && line.trim().endsWith("|")) {
      // Skip separator rows like |---|---|
      if (/^\|[\s\-:]+\|/.test(line.trim()) && !line.includes("  ")) {
        continue;
      }
      const cells = line.trim().slice(1, -1).split("|").map(c => c.trim());
      // Skip if it's a separator row
      if (cells.every(c => /^[-:]+$/.test(c))) continue;
      tableRows.push(cells);
      inTable = true;
      continue;
    }

    // End of table
    if (inTable && tableRows.length > 0) {
      sections.push({ type: "table", content: "", rows: tableRows });
      tableRows = [];
      inTable = false;
    }

    // Empty line
    if (!line.trim()) {
      numberedCounter = 0;
      continue;
    }

    // Headings
    if (line.startsWith("### ")) {
      sections.push({ type: "heading3", content: line.slice(4).trim() });
      numberedCounter = 0;
    } else if (line.startsWith("## ")) {
      sections.push({ type: "heading2", content: line.slice(3).trim() });
      numberedCounter = 0;
    } else if (line.startsWith("# ")) {
      sections.push({ type: "heading1", content: line.slice(2).trim() });
      numberedCounter = 0;
    }
    // Bullet points
    else if (/^\s*[-*]\s+/.test(line)) {
      sections.push({ type: "bullet", content: line.replace(/^\s*[-*]\s+/, "").trim() });
      numberedCounter = 0;
    }
    // Numbered lists
    else if (/^\s*\d+[.)]\s+/.test(line)) {
      numberedCounter++;
      sections.push({ type: "numbered", content: line.replace(/^\s*\d+[.)]\s+/, "").trim() });
    }
    // Regular paragraph
    else {
      sections.push({ type: "paragraph", content: line.trim() });
      numberedCounter = 0;
    }
  }

  // Flush remaining table
  if (tableRows.length > 0) {
    sections.push({ type: "table", content: "", rows: tableRows });
  }

  return sections;
}

/**
 * Parse inline formatting: **bold**, *italic*, `code`
 */
function parseInlineFormatting(text: string): TextRun[] {
  const runs: TextRun[] = [];
  const regex = /(\*\*(.+?)\*\*|\*(.+?)\*|`(.+?)`)/g;
  let lastIndex = 0;
  let match;

  while ((match = regex.exec(text)) !== null) {
    // Text before the match
    if (match.index > lastIndex) {
      runs.push(new TextRun({ text: text.slice(lastIndex, match.index) }));
    }

    if (match[2]) {
      // **bold**
      runs.push(new TextRun({ text: match[2], bold: true }));
    } else if (match[3]) {
      // *italic*
      runs.push(new TextRun({ text: match[3], italics: true }));
    } else if (match[4]) {
      // `code`
      runs.push(new TextRun({ text: match[4], font: "Consolas", shading: { fill: "f0f0f0" } }));
    }

    lastIndex = match.index + match[0].length;
  }

  // Remaining text
  if (lastIndex < text.length) {
    runs.push(new TextRun({ text: text.slice(lastIndex) }));
  }

  if (runs.length === 0) {
    runs.push(new TextRun({ text }));
  }

  return runs;
}

function buildTable(rows: string[][]): Table {
  const tableRows = rows.map((cells, rowIdx) =>
    new TableRow({
      children: cells.map(cell =>
        new TableCell({
          children: [
            new Paragraph({
              children: parseInlineFormatting(cell),
              spacing: { before: 40, after: 40 },
            }),
          ],
          ...(rowIdx === 0
            ? { shading: { fill: "d9e2f3" } }
            : {}),
        })
      ),
    })
  );

  return new Table({
    rows: tableRows,
    width: { size: 100, type: WidthType.PERCENTAGE },
  });
}

/**
 * Generate a .docx Word document from markdown-style content.
 * Returns a Buffer of the .docx file.
 */
export async function generateDocx(
  content: string,
  title?: string
): Promise<Buffer> {
  const sections = parseContent(content);
  const children: (Paragraph | Table)[] = [];

  // Optional title
  if (title) {
    children.push(
      new Paragraph({
        children: [new TextRun({ text: title, bold: true, size: 32 })],
        heading: HeadingLevel.TITLE,
        alignment: AlignmentType.CENTER,
        spacing: { after: 300 },
      })
    );
  }

  let numberedIdx = 0;

  for (const section of sections) {
    switch (section.type) {
      case "heading1":
        numberedIdx = 0;
        children.push(
          new Paragraph({
            children: [new TextRun({ text: section.content, bold: true, size: 28 })],
            heading: HeadingLevel.HEADING_1,
            spacing: { before: 300, after: 120 },
          })
        );
        break;

      case "heading2":
        numberedIdx = 0;
        children.push(
          new Paragraph({
            children: [new TextRun({ text: section.content, bold: true, size: 24 })],
            heading: HeadingLevel.HEADING_2,
            spacing: { before: 240, after: 100 },
          })
        );
        break;

      case "heading3":
        numberedIdx = 0;
        children.push(
          new Paragraph({
            children: [new TextRun({ text: section.content, bold: true, size: 22 })],
            heading: HeadingLevel.HEADING_3,
            spacing: { before: 200, after: 80 },
          })
        );
        break;

      case "bullet":
        numberedIdx = 0;
        children.push(
          new Paragraph({
            children: parseInlineFormatting(`• ${section.content}`),
            spacing: { before: 40, after: 40 },
            indent: { left: 720 },
          })
        );
        break;

      case "numbered":
        numberedIdx++;
        children.push(
          new Paragraph({
            children: parseInlineFormatting(`${numberedIdx}. ${section.content}`),
            spacing: { before: 40, after: 40 },
            indent: { left: 720 },
          })
        );
        break;

      case "table":
        if (section.rows && section.rows.length > 0) {
          children.push(buildTable(section.rows));
          children.push(new Paragraph({ children: [] })); // spacer
        }
        break;

      case "paragraph":
      default:
        numberedIdx = 0;
        children.push(
          new Paragraph({
            children: parseInlineFormatting(section.content),
            spacing: { before: 80, after: 80 },
          })
        );
        break;
    }
  }

  const doc = new Document({
    sections: [{ children }],
  });

  const buffer = await Packer.toBuffer(doc);
  return Buffer.from(buffer);
}
