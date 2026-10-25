import { describe, expect, it } from 'vitest';

import { analysisKeywords, buildAnalysisQuery, FileProcessingError, FileVault, MAX_EXTRACTED_CHARS, MAX_UPLOAD_BYTES } from './files';

describe('conversation-scoped upload vault', () => {
  it('extracts bounded plain text and only returns upload metadata', async () => {
    const vault = new FileVault();
    const file = await vault.upload({
      name: '../notes.txt',
      mediaType: 'text/plain',
      bytes: new TextEncoder().encode('first line\nsecond line'),
      conversationId: 'conv-a',
    });
    expect(file.name).toBe('notes.txt');
    expect(file.extractedCharacters).toBeGreaterThan(0);
    expect(file).not.toHaveProperty('text');
    expect(file).not.toHaveProperty('conversationId');
    expect(vault.list('conv-a')).toEqual([file]);
    expect(vault.read('conv-a', file.id, { startLine: 2 }).content).toBe('second line');
  });

  it('does not allow a file ID from another conversation', async () => {
    const vault = new FileVault();
    const file = await vault.upload({
      name: 'private.md', mediaType: 'text/markdown', bytes: new TextEncoder().encode('untrusted file text'), conversationId: 'owner',
    });
    expect(() => vault.read('attacker', file.id)).toThrow(FileProcessingError);
    expect(vault.list('attacker')).toEqual([]);
  });

  it('extracts bounded DOCX and text-based PDF content without returning the bytes', async () => {
    const vault = new FileVault();
    const docx = Buffer.from('UEsDBBQAAAAIAAkoVF1MBC9KmgAAAMcAAAARAAAAd29yZC9kb2N1bWVudC54bWxFjr0OwjAMhF8lyk5TGBCq2jKAEBsLSKwlcX+kOI6cQOHtScrA8p18Z59c799oxQs4TOQauS5KKcBpMpMbGnm7nlY7uW/ruTKknwguirTvQjU3cozRV0oFPQJ2oSAPLmU9MXYxjTyomdh4Jg0hpDq0alOWW4Xd5GSufJD5ZPUZnBHbM1hLomdCcbwc7rXKZiYv9At/h+r/VPsFUEsBAhQDFAAAAAgACShUXUwEL0qaAAAAxwAAABEAAAAAAAAAAAAAAIABAAAAAHdvcmQvZG9jdW1lbnQueG1sUEsFBgAAAAABAAEAPwAAAMkAAAAAAA==', 'base64');
    const docxFile = await vault.upload({
      name: 'notes.docx', mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', bytes: docx, conversationId: 'conv-docx',
    });
    expect(vault.read('conv-docx', docxFile.id).content).toContain('Hello from DOCX');
    expect(docxFile).not.toHaveProperty('content');

    const pdf = Buffer.from('JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCAyMDAgMjAwXSAvUmVzb3VyY2VzIDw8IC9Gb250IDw8IC9GMSA0IDAgUiA+PiA+PiAvQ29udGVudHMgNSAwIFIgPj4KZW5kb2JqCjQgMCBvYmoKPDwgL1R5cGUgL0ZvbnQgL1N1YnR5cGUgL1R5cGUxIC9CYXNlRm9udCAvSGVsdmV0aWNhID4+CmVuZG9iago1IDAgb2JqCjw8IC9MZW5ndGggNDUgPj4Kc3RyZWFtCkJUIC9GMSAxMiBUZiA3MiAxMDAgVGQgKEhlbGxvIFBERikgVGogRVQKZW5kc3RyZWFtCmVuZG9iagp4cmVmCjAgNgowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMDkgMDAwMDAgbiAKMDAwMDAwMDA1OCAwMDAwMCBuIAowMDAwMDAwMTE1IDAwMDAwIG4gCjAwMDAwMDAyNDEgMDAwMDAgbiAKMDAwMDAwMDMxMSAwMDAwMCBuIAp0cmFpbGVyCjw8IC9TaXplIDYgL1Jvb3QgMSAwIFIgPj4Kc3RhcnR4cmVmCjQwMQolJUVPRgo=', 'base64');
    const pdfFile = await vault.upload({ name: 'report.pdf', mediaType: 'application/pdf', bytes: pdf, conversationId: 'conv-pdf' });
    expect(vault.read('conv-pdf', pdfFile.id).content).toContain('Hello PDF');
  });

  it('refuses unsupported, empty, oversized and invalid UTF-8 uploads', async () => {
    const vault = new FileVault();
    await expect(vault.upload({ name: 'empty.txt', mediaType: 'text/plain', bytes: new Uint8Array(), conversationId: 'conv' })).rejects.toThrow(/empty/i);
    await expect(vault.upload({ name: 'payload.bin', mediaType: 'application/octet-stream', bytes: new Uint8Array([1]), conversationId: 'conv' })).rejects.toThrow(/unsupported/i);
    await expect(vault.upload({ name: 'large.txt', mediaType: 'text/plain', bytes: new Uint8Array(MAX_UPLOAD_BYTES + 1), conversationId: 'conv' })).rejects.toThrow(/4 MiB/i);
    await expect(vault.upload({ name: 'broken.txt', mediaType: 'text/plain', bytes: new Uint8Array([0xff]), conversationId: 'conv' })).rejects.toThrow(/UTF-8/i);
  });

  it('removes all in-memory files for a cleared conversation', async () => {
    const vault = new FileVault();
    const file = await vault.upload({ name: 'notes.csv', mediaType: 'text/csv', bytes: new TextEncoder().encode('a,b\n1,2'), conversationId: 'conv' });
    vault.removeConversation('conv');
    expect(vault.list('conv')).toEqual([]);
    expect(() => vault.read('conv', file.id)).toThrow(/unavailable/i);
  });
});

describe('bounded file analysis', () => {
  const csv = 'department,amount,owner\nengineering,1200,ana\nmarketing,800,bo\nsupport,400,cy\n';

  it('reports deterministic CSV structure and literal keyword matches', async () => {
    const vault = new FileVault();
    const file = await vault.upload({
      name: 'budget.csv',
      mediaType: 'text/csv',
      bytes: new TextEncoder().encode(csv),
      conversationId: 'conv-analyze',
    });

    const analysis = vault.analyze('conv-analyze', file.id, 'How much budget does marketing have?');

    expect(analysis.file).toEqual(file);
    expect(analysis.question).toBe('How much budget does marketing have?');
    expect(analysis.structure).toMatchObject({
      mediaType: 'text/csv',
      lines: 4,
      csv: { columns: 3, dataRows: 3 },
    });
    expect(analysis.matches).toEqual([{ line: 3, text: 'marketing,800,bo' }]);
    expect(analysis.excerpt.split('\n')[0]).toBe('department,amount,owner');
  });

  it('reports the JSON top-level shape and quotes a numeric header safely', async () => {
    const vault = new FileVault();
    const quoted = await vault.upload({
      name: 'quoted.csv', mediaType: 'text/csv',
      bytes: new TextEncoder().encode('"a,b",c\n1,2\n'), conversationId: 'conv-json',
    });
    expect(vault.analyze('conv-json', quoted.id, 'columns').structure.csv).toEqual({ columns: 2, dataRows: 1, quoteClosed: true });

    const json = await vault.upload({
      name: 'data.json', mediaType: 'application/json',
      bytes: new TextEncoder().encode('{"alpha":1,"beta":[2,3]}'), conversationId: 'conv-json',
    });
    expect(vault.analyze('conv-json', json.id, 'beta').structure.json).toEqual({ topLevel: 'object', entries: 2 });
  });

  it('keeps non-ASCII terms intact, including decomposed Vietnamese input', () => {
    // The old ASCII split turned "lương" into "l" + "ng" and "café" into "caf",
    // so a Vietnamese or accented question silently matched nothing.
    expect(analysisKeywords('Lương tháng của nhân viên')).toContain('lương');
    expect(analysisKeywords('café au lait')).toContain('café');
    expect(analysisKeywords('Tổng doanh thu của marketing là bao nhiêu?')).toEqual(
      expect.arrayContaining(['tổng', 'doanh', 'thu', 'marketing']),
    );
    // NFC and NFD spellings of the same question must produce the same terms.
    const composed = 'Lương tháng của nhân viên';
    expect(analysisKeywords(composed.normalize('NFD'))).toEqual(analysisKeywords(composed));
    // Space-separated non-Latin scripts keep whole words.
    expect(analysisKeywords('Какой бюджет у маркетинга?')).toEqual(
      expect.arrayContaining(['бюджет', 'маркетинга']),
    );
    // Bounded: a long question still yields at most six terms, measured in code points.
    expect(analysisKeywords('doanh thu lợi nhuận chi phí nhân viên khách hàng thị trường').length).toBeLessThanOrEqual(6);
    expect(analysisKeywords('预算和销售额是多少？'.repeat(20)).length).toBeLessThanOrEqual(6);
  });

  it('matches accented Vietnamese and a script without spaces through literal terms', async () => {
    const vault = new FileVault();
    const vietnamese = await vault.upload({
      name: 'doanh-thu.csv',
      mediaType: 'text/csv',
      bytes: new TextEncoder().encode('phòng ban,số tiền\nkỹ thuật,1200\ntiếp thị,800\n'),
      conversationId: 'conv-vi',
    });
    const vietnameseAnalysis = vault.analyze('conv-vi', vietnamese.id, 'Số tiền của tiếp thị là bao nhiêu?');
    expect(vietnameseAnalysis.matches).toContainEqual({ line: 3, text: 'tiếp thị,800' });
    // The unrelated engineering row matches no term and stays out.
    expect(vietnameseAnalysis.matches).not.toContainEqual({ line: 2, text: 'kỹ thuật,1200' });

    // Decomposed text in the file must match the precomposed question.
    const decomposed = await vault.upload({
      name: 'nfd.txt',
      mediaType: 'text/plain',
      bytes: new TextEncoder().encode('lương tháng 12\nlương tháng 13\n'.normalize('NFD')),
      conversationId: 'conv-vi',
    });
    // The stored text keeps its own spelling; only the comparison is
    // normalized, so the match reports the decomposed bytes from the file.
    expect(vault.analyze('conv-vi', decomposed.id, 'lương tháng 13').matches).toContainEqual({
      line: 2,
      text: 'lương tháng 13'.normalize('NFD'),
    });

    // Han runs have no spaces, so the tool searches literal two-character
    // windows instead of the whole question.
    const chinese = await vault.upload({
      name: 'yusuan.csv',
      mediaType: 'text/csv',
      bytes: new TextEncoder().encode('预算,1000\n销售,800\n其他,500\n'),
      conversationId: 'conv-zh',
    });
    const chineseAnalysis = vault.analyze('conv-zh', chinese.id, '预算和销售额是多少？');
    expect(chineseAnalysis.matches).toContainEqual({ line: 1, text: '预算,1000' });
    // Two-character windows are broad by design (no word segmentation): they
    // can match several lines, which is why the result is capped and literal.
    expect(chineseAnalysis.matches).toContainEqual({ line: 2, text: '销售,800' });
    expect(chineseAnalysis.matches).not.toContainEqual({ line: 3, text: '其他,500' });
  });

  it('reports no JSON shape when the stored text was cut at the extraction limit', async () => {
    const vault = new FileVault();
    const entries = Array.from({ length: 3_000 }, (_, index) => ({ id: index, label: `item-${index}` }));
    const file = await vault.upload({
      name: 'large.json',
      mediaType: 'application/json',
      bytes: new TextEncoder().encode(JSON.stringify(entries)),
      conversationId: 'conv-large-json',
    });

    // Pretty-printing expands the document past MAX_EXTRACTED_CHARS; the cut
    // text no longer parses, which is the real (documented) trigger of the
    // catch in analyze().
    expect(file.extractedCharacters).toBe(MAX_EXTRACTED_CHARS);
    const analysis = vault.analyze('conv-large-json', file.id, 'label');
    expect(analysis.structure.truncated).toBe(true);
    expect(analysis.structure.json).toBeUndefined();
  });

  it('bounds the excerpt and refuses an empty question, a foreign file and an oversized question', async () => {
    const vault = new FileVault();
    const file = await vault.upload({
      name: 'lines.txt', mediaType: 'text/plain',
      bytes: new TextEncoder().encode(Array.from({ length: 300 }, (_, index) => `line ${index + 1}`).join('\n')),
      conversationId: 'conv-bounds',
    });

    expect(() => vault.analyze('conv-bounds', file.id, '   ')).toThrow(/question/i);
    expect(() => vault.analyze('conv-bounds', file.id, 'x'.repeat(501))).toThrow(/500/);
    expect(() => vault.analyze('other', file.id, 'line')).toThrow(/unavailable/i);

    const window = vault.analyze('conv-bounds', file.id, '250', { startLine: 200, maxLines: 10 });
    expect(window.excerpt.split('\n')).toHaveLength(10);
    expect(window.excerpt.split('\n')[0]).toBe('line 200');
    expect(window.matches).toEqual([{ line: 250, text: 'line 250' }]);
  });
});


describe('F2 - the 20-match cap is reported, not hidden', () => {
  it('flags omitted matches and leaves the total unknown instead of reporting 20 as the count', async () => {
    const vault = new FileVault();
    const file = await vault.upload({
      name: 'many.txt',
      mediaType: 'text/plain',
      bytes: new TextEncoder().encode(Array.from({ length: 50 }, (_, index) => `revenue row ${index}`).join('\n')),
      conversationId: 'conv-cap',
    });

    const analysis = vault.analyze('conv-cap', file.id, 'revenue');
    expect(analysis.matches).toHaveLength(20);
    expect(analysis.matchesTruncated).toBe(true);
    expect(analysis.matchesFound).toBeNull();
    // The first 20 are still returned in order, so the cap costs no evidence
    // that was already collected.
    expect(analysis.matches[0]).toEqual({ line: 1, text: 'revenue row 0' });
    expect(analysis.matches[19]).toEqual({ line: 20, text: 'revenue row 19' });
    expect(analysis.query.matchesEvaluated).toBe(true);
  });

  it('reports an exact count and no truncation for a control case under the cap', async () => {
    const vault = new FileVault();
    const file = await vault.upload({
      name: 'few.txt',
      mediaType: 'text/plain',
      bytes: new TextEncoder().encode('revenue 1\nother\nrevenue 2\n'),
      conversationId: 'conv-cap',
    });
    const analysis = vault.analyze('conv-cap', file.id, 'revenue');
    expect(analysis.matches).toEqual([
      { line: 1, text: 'revenue 1' },
      { line: 3, text: 'revenue 2' },
    ]);
    expect(analysis.matchesTruncated).toBe(false);
    expect(analysis.matchesFound).toBe(2);
  });
});

describe('F3 - keyword extraction keeps discriminating terms and reports its limits', () => {
  it('samples windows from the end of a long unspaced question, not only its head', () => {
    const query = buildAnalysisQuery('请分析这个文件中的数据分布情况和主要结论');
    expect(query.keywords).toContain('结论');
    expect(query.keywords.length).toBeLessThanOrEqual(6);
    expect(query.keywordsLimited).toBe(true);
    expect(query.scriptWindows).toBe(true);
    expect(query.matchesEvaluated).toBe(true);
    expect(query.reason).toBe('keyword_limit');
    expect(analysisKeywords('请分析这个文件中的数据分布情况和主要结论')).toEqual(query.keywords);
  });

  it('does find the end-of-question term in a real file', async () => {
    const vault = new FileVault();
    const file = await vault.upload({
      name: 'report.txt',
      mediaType: 'text/plain',
      bytes: new TextEncoder().encode('结论：销售额上升\n预算：1000\n'),
      conversationId: 'conv-cjk',
    });
    const analysis = vault.analyze('conv-cjk', file.id, '请分析这个文件中的数据分布情况和主要结论');
    expect(analysis.matches).toContainEqual({ line: 1, text: '结论：销售额上升' });
    expect(analysis.query.matchesEvaluated).toBe(true);
  });

  it('keeps a single-character CJK query and a short identifier searchable', async () => {
    const single = buildAnalysisQuery('论');
    expect(single.keywords).toEqual(['论']);
    expect(single.matchesEvaluated).toBe(true);
    expect(buildAnalysisQuery('c1').keywords).toEqual(['c1']);
    expect(buildAnalysisQuery('V2').keywords).toEqual(['v2']);

    const vault = new FileVault();
    const file = await vault.upload({
      name: 'ids.txt',
      mediaType: 'text/plain',
      bytes: new TextEncoder().encode('c1,alpha\nc2,beta\n结论,gamma\n'),
      conversationId: 'conv-id',
    });
    expect(vault.analyze('conv-id', file.id, 'c1').matches).toEqual([{ line: 1, text: 'c1,alpha' }]);
    expect(vault.analyze('conv-id', file.id, '论').matches).toEqual([{ line: 3, text: '结论,gamma' }]);
  });

  it('says matching was not evaluated for a stop-word-only question', async () => {
    const query = buildAnalysisQuery('What is the file about?');
    expect(query.keywords).toEqual([]);
    expect(query.matchesEvaluated).toBe(false);
    expect(query.reason).toBe('no_usable_terms');
    expect(query.note).toMatch(/not evidence/i);

    const vault = new FileVault();
    const file = await vault.upload({
      name: 'relevant.txt',
      mediaType: 'text/plain',
      bytes: new TextEncoder().encode('what a relevant line\n'),
      conversationId: 'conv-stop',
    });
    const analysis = vault.analyze('conv-stop', file.id, 'What is the file about?');
    // An empty match list here must NOT be reported as a truncation: the file
    // was never searched.
    expect(analysis.matches).toEqual([]);
    expect(analysis.matchesTruncated).toBe(false);
    expect(analysis.matchesFound).toBeNull();
    expect(analysis.query.matchesEvaluated).toBe(false);
  });

  it('samples a query above the keyword limit across the whole question', () => {
    const query = buildAnalysisQuery('alpha beta gamma delta epsilon zeta eta theta iota kappa lambda');
    expect(query.keywords).toHaveLength(6);
    expect(query.keywordsLimited).toBe(true);
    expect(query.keywords).toContain('alpha');
    expect(query.keywords).toContain('lambda');
  });

  it('preserves NFC/NFD equivalence and mixed-script terms', () => {
    const composed = 'Lương tháng của nhân viên';
    expect(buildAnalysisQuery(composed.normalize('NFD')).keywords).toEqual(buildAnalysisQuery(composed).keywords);
    expect(buildAnalysisQuery('café au lait').keywords).toContain('café');
    expect(buildAnalysisQuery('Какой бюджет у маркетинга?').keywords).toEqual(
      expect.arrayContaining(['бюджет', 'маркетинга']),
    );
    expect(buildAnalysisQuery('Show me 收入 and revenue').keywords).toEqual(
      expect.arrayContaining(['收入', 'revenue']),
    );
    expect(buildAnalysisQuery('预算和销售额是多少？'.repeat(20)).keywords.length).toBeLessThanOrEqual(6);
  });
});

describe('F7 - CSV structure counts records, not physical lines', () => {
  const csvStructure = async (text: string) => {
    const vault = new FileVault();
    const file = await vault.upload({
      name: 'records.csv', mediaType: 'text/csv',
      bytes: new TextEncoder().encode(text), conversationId: 'conv-csv',
    });
    return vault.analyze('conv-csv', file.id, 'record').structure.csv;
  };

  it('does not count a newline inside a quoted field as a new record', async () => {
    expect(await csvStructure('a,b\n"line1\nline2",3\n"x",4\n')).toEqual({
      columns: 2, dataRows: 2, quoteClosed: true,
    });
  });

  it('handles escaped quotes, empty lines, CRLF and ordinary records', async () => {
    expect(await csvStructure('a,b\n1,2\n3,4\n')).toEqual({ columns: 2, dataRows: 2, quoteClosed: true });
    expect(await csvStructure('a,b\n\n1,2\n\n')).toEqual({ columns: 2, dataRows: 1, quoteClosed: true });
    expect(await csvStructure('a,b\r\n1,2\r\n3,4\r\n')).toEqual({ columns: 2, dataRows: 2, quoteClosed: true });
    expect(await csvStructure('"a,b",c\n"he said ""hi""",3\n')).toEqual({ columns: 2, dataRows: 1, quoteClosed: true });
  });

  it('marks an unterminated quoted field instead of reporting a confident count', async () => {
    expect(await csvStructure('a,b\n"unterminated,3\n4,5\n')).toMatchObject({
      columns: 2, quoteClosed: false,
    });
  });

  it('never scans more than the bounded extracted text', async () => {
    const vault = new FileVault();
    const huge = 'a,b\n' + '1,2\n'.repeat(60_000);
    const file = await vault.upload({
      name: 'huge.csv', mediaType: 'text/csv',
      bytes: new TextEncoder().encode(huge), conversationId: 'conv-csv',
    });
    expect(file.truncated).toBe(true);
    const analysis = vault.analyze('conv-csv', file.id, 'record');
    expect(analysis.structure.truncated).toBe(true);
    expect(analysis.structure.csv?.dataRows).toBeLessThan(MAX_EXTRACTED_CHARS);
  });
});
