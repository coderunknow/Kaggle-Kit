import { describe, expect, it } from 'vitest';

import { DEFAULT_INFERENCE_PARAMS } from '../api/requests';
import {
  applyRecommendedParams,
  catalogEntryById,
  CUSTOM_CATALOG_ID,
  deploymentMatrix,
  describeModelAvailability,
  findCatalogEntryByModelId,
  MODEL_CATALOG,
  normalizeModelKey,
  QWEN_CATALOG_ID,
  RAON_CATALOG_ID,
  recommendedParamsFor,
} from './catalog';

const qwen = catalogEntryById(QWEN_CATALOG_ID)!;
const raon = catalogEntryById(RAON_CATALOG_ID)!;
const custom = catalogEntryById(CUSTOM_CATALOG_ID)!;

describe('model catalog', () => {
  it('contains Qwen, Raon and the custom endpoint entry', () => {
    expect(MODEL_CATALOG.map((entry) => entry.id)).toEqual([
      QWEN_CATALOG_ID,
      RAON_CATALOG_ID,
      CUSTOM_CATALOG_ID,
    ]);
    expect(raon.access).toBe('gated_weights');
    expect(raon.totalParameters).toBe('28.8B');
    expect(raon.activeParameters).toBe('4.3B');
    // The custom entry must not invent a served model ID.
    expect(custom.servedModelIds).toEqual([]);
    expect(qwen.servedModelIds).toEqual([]);
  });

  it('recognizes discovered model IDs without guessing unknown ones', () => {
    expect(findCatalogEntryByModelId('Raon-1-mini-preview')?.id).toBe(RAON_CATALOG_ID);
    expect(findCatalogEntryByModelId('raon-1-mini-preview-Q4_K_M.gguf')?.id).toBe(RAON_CATALOG_ID);
    expect(findCatalogEntryByModelId('Qwen3.8-27B-GSQ-RCO-IQ3_S-mtp.gguf')?.id).toBe(QWEN_CATALOG_ID);
    expect(findCatalogEntryByModelId('/models/Qwen3.8-27B')?.id).toBe(QWEN_CATALOG_ID);
    expect(findCatalogEntryByModelId('some-other-model')).toBeUndefined();
    expect(findCatalogEntryByModelId('')).toBeUndefined();
    expect(normalizeModelKey('Raon-1_Mini.Preview')).toBe('raon1minipreview');
  });

  it('carries the documented Raon sampling baseline, split by use case', () => {
    expect(recommendedParamsFor(raon, 'general')).toEqual({
      temperature: 1.0,
      topP: 0.95,
      topK: 20,
      minP: 0.0,
      repetitionPenalty: 1.0,
      frequencyPenalty: 0,
      presencePenalty: 1.5,
    });
    expect(recommendedParamsFor(raon, 'coding_math').presencePenalty).toBe(0);
    expect(recommendedParamsFor(raon, 'coding_math').temperature).toBe(1.0);
  });

  it('applying Raon defaults changes only sampling fields', () => {
    const current = { ...DEFAULT_INFERENCE_PARAMS, maxTokens: 4096, stream: true, reasoningEffort: 'high' as const };
    const next = applyRecommendedParams(current, raon);
    expect(next.temperature).toBe(1.0);
    expect(next.topK).toBe(20);
    expect(next.minP).toBe(0);
    expect(next.repetitionPenalty).toBe(1.0);
    expect(next.frequencyPenalty).toBe(0);
    expect(next.presencePenalty).toBe(1.5);
    // Output length, transport and reasoning effort are never silently changed.
    expect(next.maxTokens).toBe(4096);
    expect(next.stream).toBe(true);
    expect(next.reasoningEffort).toBe('high');
  });

  it('applying Qwen defaults clears Raon sampling extensions instead of leaking them', () => {
    const raonParams = applyRecommendedParams(DEFAULT_INFERENCE_PARAMS, raon);
    const back = applyRecommendedParams(raonParams, qwen);
    expect(back.temperature).toBe(0.7);
    expect(back.topK).toBeUndefined();
    expect(back.minP).toBeUndefined();
    expect(back.repetitionPenalty).toBeUndefined();
    expect(back.frequencyPenalty).toBeUndefined();
    expect(back.presencePenalty).toBeUndefined();
  });

  it('distinguishes advertised, missing and undiscovered models honestly', () => {
    expect(describeModelAvailability(raon, []).state).toBe('unknown');
    expect(describeModelAvailability(raon, ['Raon-1-mini-preview']).state).toBe('advertised');

    const missing = describeModelAvailability(raon, ['Qwen3.8-27B-GSQ-RCO-IQ3_S-mtp.gguf']);
    expect(missing.state).toBe('not_advertised');
    expect(missing.message).toContain('does not switch a remote server');
    expect(missing.message).toContain('launch the matching deployment');

    expect(describeModelAvailability(custom, ['anything']).state).toBe('unknown');
  });

  it('reports the deployment matrix with explicit, distinct statuses', () => {
    const matrix = deploymentMatrix();
    const row = (model: string, accelerator: string) =>
      matrix.find((entry) => entry.model === model && entry.accelerator === accelerator);

    expect(row('Qwen3.8-27B', 'Kaggle GPU T4 x2')?.status).toBe('preexisting_not_reverified');
    // No combination may claim live verification without live evidence.
    expect(matrix.some((entry) => entry.status === 'verified')).toBe(false);
    expect(row('Qwen3.8-27B', 'Kaggle TPU v5e-8')?.status).toBe('implemented_not_live_verified');
    expect(row('Qwen3.8-27B', 'Kaggle TPU v5e-8')?.runtime).toContain('MTP off');
    expect(row('Raon-1 mini preview', 'Kaggle GPU T4 x2')?.status).toBe('implemented_not_live_verified');
    expect(row('Raon-1 mini preview', 'Kaggle TPU v5e-8')?.status).toBe('blocked');
    expect(row('Raon-1 mini preview', 'Hosted API')?.status).toBe('implemented_not_live_verified');
    // Every row carries evidence; a status without evidence would be a claim.
    for (const entry of matrix) {
      expect(entry.evidence.length).toBeGreaterThan(40);
      expect(entry.statusLabel.length).toBeGreaterThan(0);
    }
  });
});
