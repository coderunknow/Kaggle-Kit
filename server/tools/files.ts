import { randomUUID } from 'node:crypto';
import CSSMatrix from '@thednp/dommatrix';
import 'pdfjs-dist/legacy/build/pdf.worker.mjs';
import yauzl from 'yauzl';
import { XMLParser } from 'fast-xml-parser';
import type { UploadedFileReference } from '../../shared/tools/types';

export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
export const MAX_EXTRACTED_CHARS = 100_000;
export const FILE_PARSER_TIMEOUT_MS = 15_000;
const MAX_DOCX_XML_BYTES = 8 * 1024 * 1024;
const MAX_PDF_PAGES = 250;

export class FileProcessingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FileProcessingError';
  }
}

interface VaultFile extends UploadedFileReference {
  conversationId: string;
  text: string;
  truncated: boolean;
  uploadedAt: string;
}

export interface FileReadOptions {
  startLine?: number;
  maxLines?: number;
}

export class FileVault {
  private readonly files = new Map<string, VaultFile>();
  private static readonly MAX_FILES = 100;
  private static readonly TTL_MS = 60 * 60 * 1000;

  async upload(input: {
    name: string;
    mediaType: string;
    bytes: Uint8Array;
    conversationId: string;
  }): Promise<UploadedFileReference> {
    if (input.bytes.byteLength === 0) throw new FileProcessingError('The uploaded file is empty.');
    if (input.bytes.byteLength > MAX_UPLOAD_BYTES) throw new FileProcessingError('The file exceeds the 4 MiB upload limit.');
    if (!input.conversationId || input.conversationId.length > 128) throw new FileProcessingError('A valid conversation is required for a file upload.');
    const filename = normalizeFilename(input.name);
    const extension = filename.split('.').pop()?.toLowerCase() ?? '';
    const text = await extractText(extension, input.mediaType, input.bytes);
    const truncated = text.length > MAX_EXTRACTED_CHARS;
    const bounded = text.slice(0, MAX_EXTRACTED_CHARS);
    const id = randomUUID();
    this.prune();
    if (this.files.size >= FileVault.MAX_FILES) throw new FileProcessingError('The in-memory upload limit is reached; remove an old conversation or restart the proxy.');
    const record: VaultFile = {
      id,
      name: filename,
      mediaType: normalizedMediaType(extension),
      size: input.bytes.byteLength,
      extractedCharacters: bounded.length,
      conversationId: input.conversationId,
      text: bounded,
      truncated,
      uploadedAt: new Date().toISOString(),
    };
    this.files.set(id, record);
    return publicReference(record);
  }

  list(conversationId: string): UploadedFileReference[] {
    this.prune();
    return [...this.files.values()]
      .filter((file) => file.conversationId === conversationId)
      .map(publicReference);
  }

  read(conversationId: string, id: string, options: FileReadOptions = {}): { file: UploadedFileReference; content: string; truncated: boolean } {
    this.prune();
    const file = this.files.get(id);
    if (!file || file.conversationId !== conversationId) {
      throw new FileProcessingError('That uploaded file is unavailable in this conversation.');
    }
    const lines = file.text.split(/\r?\n/);
    const start = Math.max(1, Math.floor(options.startLine ?? 1));
    const maximum = Math.max(1, Math.min(400, Math.floor(options.maxLines ?? 120)));
    const content = lines.slice(start - 1, start - 1 + maximum).join('\n');
    return { file: publicReference(file), content, truncated: file.truncated || start + maximum <= lines.length };
  }

  /**
   * Bounded, deterministic analysis of an uploaded file.
   *
   * The tool never "answers" the question: it reports structure, keyword
   * matches and an excerpt, and the model reasons over that. Matching is
   * literal and case-insensitive, so the result is reproducible and cannot be
   * steered by instructions inside the file.
   */
  analyze(
    conversationId: string,
    id: string,
    question: string,
    options: FileReadOptions = {},
  ): {
    file: UploadedFileReference;
    question: string;
    structure: {
      mediaType: string;
      lines: number;
      extractedCharacters: number;
      truncated: boolean;
      csv?: { columns: number; dataRows: number };
      json?: { topLevel: 'object' | 'array' | 'scalar'; entries: number };
    };
    excerpt: string;
    matches: Array<{ line: number; text: string }>;
  } {
    const trimmedQuestion = question.trim();
    if (!trimmedQuestion) throw new FileProcessingError('An analysis question is required.');
    if (trimmedQuestion.length > 500) throw new FileProcessingError('The analysis question is limited to 500 characters.');
    const read = this.read(conversationId, id, options);
    const file = this.files.get(id)!;
    // One trailing newline ends the last line; it does not start a new one.
    const lines = file.text.replace(/\r?\n$/, '').split(/\r?\n/);
    const keywords = analysisKeywords(trimmedQuestion);
    const matches: Array<{ line: number; text: string }> = [];
    for (let index = 0; index < lines.length && matches.length < 20; index += 1) {
      const line = lines[index]!;
      if (!line.trim()) continue;
      const lowered = line.toLowerCase();
      if (!keywords.some((keyword) => lowered.includes(keyword))) continue;
      matches.push({ line: index + 1, text: line.trim().slice(0, 200) });
    }
    const structure: ReturnType<FileVault['analyze']>['structure'] = {
      mediaType: file.mediaType,
      lines: lines.length,
      extractedCharacters: file.text.length,
      truncated: file.truncated,
    };
    const kind = file.name.split('.').pop()?.toLowerCase() ?? '';
    if (kind === 'csv' && lines[0]?.trim()) {
      structure.csv = {
        columns: countCsvColumns(lines[0]),
        dataRows: Math.max(0, lines.filter((line) => line.trim() !== '').length - 1),
      };
    } else if (kind === 'json') {
      try {
        const parsed: unknown = JSON.parse(file.text);
        structure.json = Array.isArray(parsed)
          ? { topLevel: 'array', entries: parsed.length }
          : parsed !== null && typeof parsed === 'object'
            ? { topLevel: 'object', entries: Object.keys(parsed as Record<string, unknown>).length }
            : { topLevel: 'scalar', entries: 1 };
      } catch {
        // Upload-time extraction already rejected malformed JSON, so this is
        // unreachable in practice. Report no JSON shape rather than a wrong one.
      }
    }
    return { file: publicReference(file), question: trimmedQuestion, structure, excerpt: read.content, matches };
  }

  removeConversation(conversationId: string): void {
    for (const [id, file] of this.files) if (file.conversationId === conversationId) this.files.delete(id);
  }

  private prune(): void {
    const cutoff = Date.now() - FileVault.TTL_MS;
    for (const [id, file] of this.files) {
      if (Date.parse(file.uploadedAt) < cutoff) this.files.delete(id);
    }
  }
}

const ANALYSIS_STOP_WORDS = new Set([
  'the', 'and', 'for', 'from', 'with', 'what', 'which', 'who', 'whom', 'whose', 'how', 'why',
  'when', 'where', 'does', 'did', 'are', 'was', 'were', 'has', 'had', 'have', 'can', 'could',
  'should', 'would', 'this', 'that', 'these', 'those', 'there', 'their', 'about', 'into', 'than',
  'then', 'them', 'they', 'you', 'your', 'our', 'its', 'all', 'any', 'each', 'many', 'much',
  'list', 'show', 'tell', 'give', 'please', 'summarize', 'summary', 'file', 'files', 'document',
  'contents', 'content', 'explain', 'describe', 'according', 'based', 'using', 'between',
]);

/** Literal, lower-case search terms; bounded so a long question stays cheap. */
export function analysisKeywords(question: string): string[] {
  const words = question
    .toLowerCase()
    .split(/[^a-z0-9.+#-]+/)
    .map((word) => word.replace(/^[.+#-]+|[.+#-]+$/g, ''))
    .filter((word) => word.length >= 3 && !ANALYSIS_STOP_WORDS.has(word));
  return [...new Set(words)].slice(0, 6);
}

/** Comma count outside double quotes, plus one (a minimal but honest CSV header). */
function countCsvColumns(header: string): number {
  let columns = 1;
  let quoted = false;
  for (let index = 0; index < header.length; index += 1) {
    const character = header[index];
    if (character === '"') {
      if (quoted && header[index + 1] === '"') index += 1;
      else quoted = !quoted;
    } else if (character === ',' && !quoted) {
      columns += 1;
    }
  }
  return columns;
}

function publicReference(file: VaultFile): UploadedFileReference {
  return {
    id: file.id,
    name: file.name,
    mediaType: file.mediaType,
    size: file.size,
    extractedCharacters: file.extractedCharacters,
    truncated: file.truncated,
  };
}

function normalizeFilename(raw: string): string {
  const candidate = raw.split(/[\\/]/).pop() ?? '';
  const name = [...candidate].filter((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code > 0x1f && code !== 0x7f;
  }).join('').trim();
  if (!name || name.length > 160 || name === '.' || name === '..') throw new FileProcessingError('The filename is invalid.');
  return name;
}

function normalizedMediaType(extension: string): string {
  switch (extension) {
    case 'txt': return 'text/plain';
    case 'md': case 'markdown': return 'text/markdown';
    case 'csv': return 'text/csv';
    case 'json': return 'application/json';
    case 'pdf': return 'application/pdf';
    case 'docx': return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    default: return 'application/octet-stream';
  }
}

async function extractText(extension: string, mediaType: string, bytes: Uint8Array): Promise<string> {
  return withTimeout(async (signal) => {
    switch (extension) {
      case 'txt': case 'md': case 'markdown': case 'csv': return extractPlainText(bytes);
      case 'json': return extractJson(bytes);
      case 'pdf':
        if (mediaType && mediaType !== 'application/pdf' && mediaType !== 'application/octet-stream') {
          throw new FileProcessingError('The PDF extension does not match the declared file type.');
        }
        return extractPdf(bytes, signal);
      case 'docx':
        if (mediaType && mediaType !== 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' && mediaType !== 'application/octet-stream') {
          throw new FileProcessingError('The DOCX extension does not match the declared file type.');
        }
        return extractDocx(bytes, signal);
      default:
        throw new FileProcessingError('Unsupported file type. Upload TXT, Markdown, CSV, JSON, text-based PDF, or DOCX.');
    }
  }, FILE_PARSER_TIMEOUT_MS);
}

function extractPlainText(bytes: Uint8Array): string {
  if (bytes.some((byte) => byte === 0)) throw new FileProcessingError('Binary content is not accepted as text.');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new FileProcessingError('The file is not valid UTF-8 text.');
  }
}

function extractJson(bytes: Uint8Array): string {
  const text = extractPlainText(bytes);
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    throw new FileProcessingError('The JSON file is malformed.');
  }
}

async function extractPdf(bytes: Uint8Array, signal: AbortSignal): Promise<string> {
  if (signal.aborted) throw new FileProcessingError('PDF parsing was interrupted.');
  // A double assertion, not an intersection: under the DOM lib (the client
  // typecheck also compiles this module) `globalThis.DOMMatrix` is already
  // declared with DOM's static methods, which the CSSMatrix shim does not
  // implement. At runtime pdf.js only needs a constructible matrix class.
  const pdfjsGlobal = globalThis as unknown as { DOMMatrix?: typeof CSSMatrix };
  pdfjsGlobal.DOMMatrix ??= CSSMatrix;
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  if (signal.aborted) throw new FileProcessingError('PDF parsing was interrupted.');
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    useSystemFonts: false,
    disableFontFace: true,
    isEvalSupported: false,
    stopAtErrors: true,
  });
  const abort = () => void loadingTask.destroy();
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  try {
    const document = await loadingTask.promise;
    if (document.numPages > MAX_PDF_PAGES) throw new FileProcessingError(`PDF has ${document.numPages} pages; the limit is ${MAX_PDF_PAGES}.`);
    const pages: string[] = [];
    let extractedLength = 0;
    for (let pageNo = 1; pageNo <= document.numPages; pageNo += 1) {
      if (signal.aborted) throw new FileProcessingError('PDF parsing was interrupted.');
      const page = await document.getPage(pageNo);
      const content = await page.getTextContent();
      const pageText = content.items.map((item) => ('str' in item && typeof item.str === 'string' ? item.str : '')).join(' ');
      pages.push(pageText);
      extractedLength += pageText.length + 2;
      page.cleanup();
      if (extractedLength > MAX_EXTRACTED_CHARS * 2) break;
    }
    const text = pages.join('\n\n').trim();
    if (!text) throw new FileProcessingError('The PDF contains no extractable text. Scanned PDFs are not OCR-processed.');
    return text;
  } catch (error) {
    if (error instanceof FileProcessingError) throw error;
    if (signal.aborted) throw new FileProcessingError('PDF parsing exceeded the parser time limit.');
    throw new FileProcessingError('The PDF could not be parsed or is malformed.');
  } finally {
    signal.removeEventListener('abort', abort);
    await loadingTask.destroy().catch(() => undefined);
  }
}

async function extractDocx(bytes: Uint8Array, signal: AbortSignal): Promise<string> {
  const buffer = Buffer.from(bytes);
  let removeAbortListener: () => void = () => {};
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, result?: string) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(result ?? '');
    };
    yauzl.fromBuffer(buffer, { lazyEntries: true, decodeStrings: true, validateEntrySizes: true, strictFileNames: true }, (openError, zip) => {
      if (openError || !zip) return finish(new FileProcessingError('The DOCX container is malformed.'));
      const stop = () => zip.close();
      removeAbortListener = () => signal.removeEventListener('abort', stop);
      signal.addEventListener('abort', stop, { once: true });
      if (signal.aborted) {
        zip.close();
        return finish(new FileProcessingError('DOCX parsing exceeded the parser time limit.'));
      }
      zip.on('error', () => finish(new FileProcessingError('The DOCX container is malformed.')));
      zip.on('entry', (entry) => {
        if (entry.fileName.includes('..') || entry.fileName.startsWith('/') || entry.fileName.includes('\\')) {
          zip.close();
          return finish(new FileProcessingError('The DOCX archive contains an unsafe path.'));
        }
        if (entry.fileName !== 'word/document.xml') {
          zip.readEntry();
          return;
        }
        if (entry.uncompressedSize > MAX_DOCX_XML_BYTES) {
          zip.close();
          return finish(new FileProcessingError('The DOCX document XML exceeds the 8 MiB parser limit.'));
        }
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) {
            zip.close();
            return finish(new FileProcessingError('The DOCX document could not be read.'));
          }
          const chunks: Buffer[] = [];
          let length = 0;
          stream.on('data', (chunk: Buffer) => {
            length += chunk.length;
            if (length > MAX_DOCX_XML_BYTES) {
              stream.destroy(new FileProcessingError('The DOCX document XML exceeded the parser limit.'));
            } else chunks.push(chunk);
          });
          stream.on('error', () => {
            zip.close();
            finish(new FileProcessingError(signal.aborted ? 'DOCX parsing exceeded the parser time limit.' : 'The DOCX document is malformed.'));
          });
          stream.on('end', () => {
            zip.close();
            try {
              const xml = Buffer.concat(chunks).toString('utf8');
              const parser = new XMLParser({
                preserveOrder: true,
                ignoreAttributes: true,
                processEntities: {
                  enabled: true,
                  maxEntitySize: 10_000,
                  maxExpansionDepth: 64,
                  maxTotalExpansions: 100_000,
                  maxExpandedLength: MAX_EXTRACTED_CHARS,
                  maxEntityCount: 1_000,
                },
                maxNestedTags: 100,
                trimValues: false,
              });
              const tree = parser.parse(xml) as unknown;
              const parts: string[] = [];
              collectWordText(tree, parts);
              const text = parts.join('').replace(/[\t ]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
              if (!text) throw new FileProcessingError('The DOCX contains no extractable text.');
              finish(undefined, text);
            } catch (error) {
              finish(error instanceof FileProcessingError ? error : new FileProcessingError('The DOCX document XML is malformed.'));
            }
          });
        });
      });
      zip.on('end', () => finish(new FileProcessingError('The DOCX archive has no word/document.xml document.')));
      zip.readEntry();
    });
  }).finally(() => removeAbortListener());
}

function collectWordText(node: unknown, output: string[]): void {
  if (Array.isArray(node)) {
    for (const child of node) collectWordText(child, output);
    return;
  }
  if (!node || typeof node !== 'object') return;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === 'w:t') collectTextValue(value, output);
    else if (key === 'w:tab') output.push('\t');
    else if (key === 'w:br' || key === 'w:p') {
      collectWordText(value, output);
      output.push('\n');
    } else collectWordText(value, output);
  }
}

function collectTextValue(value: unknown, output: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectTextValue(item, output);
  } else if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record['#text'] === 'string') output.push(record['#text']);
    for (const [key, child] of Object.entries(record)) if (key !== '#text') collectTextValue(child, output);
  } else if (typeof value === 'string') output.push(value);
}

async function withTimeout<T>(work: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new FileProcessingError(`File parser exceeded ${timeoutMs / 1000} seconds.`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([work(controller.signal), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
