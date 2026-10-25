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
      csv?: { columns: number; dataRows: number; quoteClosed: boolean };
      json?: { topLevel: 'object' | 'array' | 'scalar'; entries: number };
    };
    excerpt: string;
    matches: Array<{ line: number; text: string }>;
    /** True when a 21st matching line existed and was not returned. */
    matchesTruncated: boolean;
    /** Exact total when known, `null` when the scan stopped at the cap. */
    matchesFound: number | null;
    /** What the question was reduced to, and how far that can be trusted. */
    query: AnalysisQuery;
  } {
    const trimmedQuestion = question.trim();
    if (!trimmedQuestion) throw new FileProcessingError('An analysis question is required.');
    if (trimmedQuestion.length > 500) throw new FileProcessingError('The analysis question is limited to 500 characters.');
    const read = this.read(conversationId, id, options);
    const file = this.files.get(id)!;
    // One trailing newline ends the last line; it does not start a new one.
    const lines = file.text.replace(/\r?\n$/, '').split(/\r?\n/);
    const query = buildAnalysisQuery(trimmedQuestion);
    const matches: Array<{ line: number; text: string }> = [];
    let matchesTruncated = false;
    // `query.matchesEvaluated` is false when no usable term existed. In that
    // case an empty `matches` array means "not searched", not "nothing found".
    if (query.matchesEvaluated) {
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index]!;
        if (!line.trim()) continue;
        // The same NFC form the keywords use: decomposed text in the file must
        // match a precomposed question (and the reverse).
        const lowered = line.normalize('NFC').toLowerCase();
        if (!query.keywords.some((keyword) => lowered.includes(keyword))) continue;
        // Stop at the first omitted match: one extra comparison detects the
        // cap without counting or storing an unbounded number of matches.
        if (matches.length >= MAX_ANALYSIS_MATCHES) {
          matchesTruncated = true;
          break;
        }
        matches.push({ line: index + 1, text: line.trim().slice(0, 200) });
      }
    }
    const structure: ReturnType<FileVault['analyze']>['structure'] = {
      mediaType: file.mediaType,
      lines: lines.length,
      extractedCharacters: file.text.length,
      truncated: file.truncated,
    };
    const kind = file.name.split('.').pop()?.toLowerCase() ?? '';
    if (kind === 'csv') {
      structure.csv = describeCsv(file.text);
    } else if (kind === 'json') {
      try {
        const parsed: unknown = JSON.parse(file.text);
        structure.json = Array.isArray(parsed)
          ? { topLevel: 'array', entries: parsed.length }
          : parsed !== null && typeof parsed === 'object'
            ? { topLevel: 'object', entries: Object.keys(parsed as Record<string, unknown>).length }
            : { topLevel: 'scalar', entries: 1 };
      } catch {
        // Upload-time extraction rejected malformed JSON, but it stores at most
        // MAX_EXTRACTED_CHARS characters. A larger document is cut there and the
        // cut text no longer parses; `structure.truncated` already tells the
        // model that the stored text is partial. Report no JSON shape rather
        // than a shape derived from a partial parse.
      }
    }
    return {
      file: publicReference(file),
      question: trimmedQuestion,
      structure,
      excerpt: read.content,
      matches,
      matchesTruncated,
      matchesFound: matchesTruncated || !query.matchesEvaluated ? null : matches.length,
      query,
    };
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
  // Vietnamese question function words: a literal search would otherwise match
  // nearly every line of a Vietnamese file through "của" or "và".
  'của', 'và', 'là', 'có', 'cho', 'với', 'những', 'các', 'một', 'không', 'được',
  'trong', 'khi', 'thì', 'này', 'đó', 'nhiêu', 'bao',
]);

/** Punctuation that stays part of a term (decimals, C++, C#, email-like names). */
const TERM_EDGE_PUNCTUATION = /^[.+#-]+|[.+#-]+$/gu;
/** Everything else separates terms: letters, marks and numbers stay together. */
const TERM_SEPARATOR = /[^\p{L}\p{M}\p{N}.+#-]+/u;
/**
 * Scripts written without spaces between words. Their whole question becomes a
 * single run, so a whitespace token is rarely a literal term found in a file.
 */
const UNSPACED_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const MAX_KEYWORDS = 6;
const MAX_ANALYSIS_MATCHES = 20;

export interface AnalysisQuery {
  /** Literal, lower-case search terms, at most `MAX_KEYWORDS`. */
  keywords: string[];
  /** More distinct candidate terms existed than the cap could hold. */
  keywordsLimited: boolean;
  /**
   * False when no usable term existed. `matches: []` then means the file was
   * not searched, never that the file contains no relevant line.
   */
  matchesEvaluated: boolean;
  /** Matching used bounded two-character windows instead of word segmentation. */
  scriptWindows: boolean;
  reason: 'no_usable_terms' | 'keyword_limit' | 'unspaced_script' | null;
  /** Model-readable explanation of the query's limits. */
  note: string;
}

/**
 * Pick at most `count` items spread over the whole list, including the last
 * one. Taking the first `count` items systematically discarded discriminating
 * terms near the end of a long question (especially long Han/Kana/Hangul runs).
 */
function evenSample<T>(items: readonly T[], count: number): T[] {
  if (count <= 0 || items.length === 0) return [];
  if (items.length <= count) return [...items];
  if (count === 1) return [items[items.length - 1]!];
  const picked: T[] = [];
  for (let index = 0; index < count; index += 1) {
    picked.push(items[Math.round(index * (items.length - 1) / (count - 1))]!);
  }
  return [...new Set(picked)];
}

/**
 * Turn a question into bounded literal search terms plus truthful diagnostics.
 *
 * The question is NFC-normalized first: decomposed Vietnamese (or Indic) input
 * must yield the same terms as the precomposed text stored in the file, and
 * combining marks must not act as separators. Unicode letter/number classes
 * keep non-ASCII terms intact, so `café` stays `café` instead of `caf`.
 *
 * Han/Kana/Hangul runs have no whitespace-delimited words, so two-character
 * literal windows are generated over the *whole* run and sampled evenly; a
 * single character is a valid query. Short alphanumeric identifiers such as
 * `c1` are kept. When no usable term survives (stop-word-only questions), the
 * result says matching was not evaluated instead of returning a bare empty
 * keyword list that callers would report as "0 matching lines".
 */
export function buildAnalysisQuery(question: string): AnalysisQuery {
  const normalized = question.normalize('NFC').toLowerCase();
  const primary: string[] = [];
  const windows: string[] = [];
  let scriptWindows = false;

  for (const raw of normalized.split(TERM_SEPARATOR)) {
    const term = raw.replace(TERM_EDGE_PUNCTUATION, '');
    if (!term) continue;
    const characters = [...term];
    if (UNSPACED_SCRIPT.test(term)) {
      scriptWindows = true;
      if (characters.length <= 8) primary.push(term);
      for (let index = 0; index + 1 < characters.length; index += 1) {
        windows.push(`${characters[index]}${characters[index + 1]}`);
      }
      continue;
    }
    if (ANALYSIS_STOP_WORDS.has(term)) continue;
    const shortIdentifier = characters.length >= 2 && /\p{N}/u.test(term);
    if (characters.length >= 3 || shortIdentifier) primary.push(term);
  }

  const uniquePrimary = [...new Set(primary)];
  const uniqueWindows = [...new Set(windows)].filter((window) => !uniquePrimary.includes(window));
  const keywords = [...new Set(
    uniquePrimary.length > MAX_KEYWORDS
      ? evenSample(uniquePrimary, MAX_KEYWORDS)
      : [...uniquePrimary, ...evenSample(uniqueWindows, MAX_KEYWORDS - uniquePrimary.length)],
  )].slice(0, MAX_KEYWORDS);

  const keywordsLimited = uniquePrimary.length + uniqueWindows.length > MAX_KEYWORDS;
  const matchesEvaluated = keywords.length > 0;
  const reason: AnalysisQuery['reason'] = !matchesEvaluated
    ? 'no_usable_terms'
    : keywordsLimited
      ? 'keyword_limit'
      : scriptWindows
        ? 'unspaced_script'
        : null;
  const note = !matchesEvaluated
    ? 'The question contained no usable search term (only stop words or very short words). The file was not searched; an empty match list is not evidence that no relevant line exists.'
    : keywordsLimited
      ? `Only ${MAX_KEYWORDS} of more than ${MAX_KEYWORDS} candidate search terms were used, sampled across the whole question. Matches may be incomplete.`
      : scriptWindows
        ? 'The question uses a script without whitespace-delimited words. Bounded literal two-character windows were used instead of word segmentation; matches are approximate.'
        : 'Literal, case-insensitive keyword matching.';

  return { keywords, keywordsLimited, matchesEvaluated, scriptWindows, reason, note };
}

/** Literal, lower-case search terms; bounded so a long question stays cheap. */
export function analysisKeywords(question: string): string[] {
  return buildAnalysisQuery(question).keywords;
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

/**
 * Bounded, quote-aware CSV description. Records are separated by newlines
 * *outside* double quotes, so a quoted field containing an embedded newline
 * does not inflate `dataRows`. `quoteClosed` is false for an unterminated
 * quoted field, which makes the counts explicitly provisional instead of
 * silently wrong. One linear pass over the already bounded extracted text.
 */
function describeCsv(text: string): { columns: number; dataRows: number; quoteClosed: boolean } {
  let inQuotes = false;
  let records = 0;
  let recordHasContent = false;
  let firstRecord = '';
  let firstRecordDone = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (inQuotes) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          if (!firstRecordDone) firstRecord += '""';
          index += 1;
        } else {
          inQuotes = false;
          if (!firstRecordDone) firstRecord += '"';
        }
      } else if (!firstRecordDone) {
        firstRecord += character;
      }
      recordHasContent = true;
      continue;
    }
    if (character === '"') {
      inQuotes = true;
      recordHasContent = true;
      if (!firstRecordDone) firstRecord += '"';
      continue;
    }
    if (character === '\r' || character === '\n') {
      if (character === '\r' && text[index + 1] === '\n') index += 1;
      if (recordHasContent) {
        records += 1;
        firstRecordDone = true;
      }
      recordHasContent = false;
      continue;
    }
    if (!firstRecordDone) firstRecord += character;
    recordHasContent = true;
  }
  if (recordHasContent) {
    records += 1;
    firstRecordDone = true;
  }
  return {
    columns: firstRecordDone ? countCsvColumns(firstRecord) : 0,
    dataRows: Math.max(0, records - 1),
    quoteClosed: !inQuotes,
  };
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
