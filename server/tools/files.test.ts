import { describe, expect, it } from 'vitest';

import { FileProcessingError, FileVault, MAX_UPLOAD_BYTES } from './files';

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
