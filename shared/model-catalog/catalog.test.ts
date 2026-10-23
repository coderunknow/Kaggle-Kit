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
  SPARK_CATALOG_ID,
  recommendedParamsFor,
  thinkingLevelsForModelId,
} from './catalog';

const qwen = catalogEntryById(QWEN_CATALOG_ID)!;
const raon = catalogEntryById(RAON_CATALOG_ID)!;
const spark = catalogEntryById(SPARK_CATALOG_ID)!;
const custom = catalogEntryById(CUSTOM_CATALOG_ID)!;

describe('model catalog', () => {
  it('contains Qwen, Raon, Spark and the custom endpoint entry', () => {
    expect(MODEL_CATALOG.map((entry) => entry.id)).toEqual([
      QWEN_CATALOG_ID,
      RAON_CATALOG_ID,
      SPARK_CATALOG_ID,
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
    expect(row('Spark-X2.6-4B', 'Kaggle GPU T4 x2')?.status).toBe('implemented_not_live_verified');
    expect(row('Spark-X2.6-4B', 'Kaggle TPU v5e-8')?.status).toBe('blocked');
    // Every row carries evidence; a status without evidence would be a claim.
    for (const entry of matrix) {
      expect(entry.evidence.length).toBeGreaterThan(40);
      expect(entry.statusLabel.length).toBeGreaterThan(0);
    }
  });

  it('describes Spark-X2.6-4B with sourced metadata, not invented values', () => {
    expect(spark.displayName).toBe('Spark-X2.6-4B');
    expect(spark.license).toBe('Apache-2.0');
    expect(spark.access).toBe('open');
    expect(spark.contextTokens).toBe(1_048_576);
    expect(spark.totalParameters).toBe('4B');
    expect(spark.servedModelIds).toEqual(['Spark-X2.6-4B']);
    // The deployment is pinned to one repository revision and one digest per
    // quantization; the catalog itself never claims a file is installed.
    expect(spark.deployments.every((deployment) => deployment.evidence.length > 100)).toBe(true);
  });

  it('recognizes Spark served IDs and GGUF file names but never guesses unknown ones', () => {
    expect(findCatalogEntryByModelId('Spark-X2.6-4B')?.id).toBe(SPARK_CATALOG_ID);
    expect(findCatalogEntryByModelId('Spark-X2.6-4B-Q4_K_M.gguf')?.id).toBe(SPARK_CATALOG_ID);
    expect(findCatalogEntryByModelId('/models/spark2.6')?.id).toBe(SPARK_CATALOG_ID);
    // The vLLM example alias "spark25" is not a documented match key here.
    expect(findCatalogEntryByModelId('spark25')).toBeUndefined();
    expect(findCatalogEntryByModelId('spark-x1-9b')).toBeUndefined();
  });

  it('exposes the template-defined thinking levels only for Spark', () => {
    expect(spark.thinking).toBeDefined();
    expect(spark.thinking?.mechanism).toBe('llama_cpp_reasoning_effort');
    expect(spark.thinking?.levels).toEqual(['none', 'low', 'high']);
    expect(spark.thinking?.defaultLevel).toBe('high');
    expect(thinkingLevelsForModelId('Spark-X2.6-4B')).toEqual(['none', 'low', 'high']);
    expect(thinkingLevelsForModelId('Raon-1-mini-preview')).toBeUndefined();
    expect(thinkingLevelsForModelId('Qwen3.8-27B')).toBeUndefined();
    expect(thinkingLevelsForModelId('not-a-catalog-model')).toBeUndefined();
  });

  it('carries the official Spark sampling values and never changes thinking or output length', () => {
    expect(recommendedParamsFor(spark, 'general')).toEqual({
      temperature: 1.0,
      topP: 0.95,
      topK: 0,
      frequencyPenalty: undefined,
      presencePenalty: undefined,
      minP: undefined,
      repetitionPenalty: undefined,
    });

    const current = {
      ...DEFAULT_INFERENCE_PARAMS,
      maxTokens: 2048,
      stream: true,
      reasoningEffort: 'none' as const,
    };
    const next = applyRecommendedParams(current, spark);
    expect(next.temperature).toBe(1.0);
    expect(next.topP).toBe(0.95);
    expect(next.topK).toBe(0);
    // Thinking level, output length and transport are untouched.
    expect(next.reasoningEffort).toBe('none');
    expect(next.maxTokens).toBe(2048);
    expect(next.stream).toBe(true);
  });

  it('does not advertise a verified Spark deployment without live evidence', () => {
    const sparkRows = deploymentMatrix().filter((entry) => entry.model === 'Spark-X2.6-4B');
    expect(sparkRows.map((entry) => entry.status)).not.toContain('verified');
    expect(sparkRows.find((entry) => entry.accelerator === 'Kaggle TPU v5e-8')?.evidence).toContain(
      'tpu-inference',
    );
  });
});
