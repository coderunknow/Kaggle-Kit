/**
 * The model catalog.
 *
 * The catalog is *metadata the application knows*, nothing more. It never
 * claims that a model is installed, downloaded, running, or reachable: only
 * an actual `/v1/models` answer from the selected endpoint (dynamic
 * discovery) plus a real inference test can prove that. Catalog entries
 * therefore stay strictly separated from endpoint state:
 *
 *  - browsing/selecting a catalog entry fills in *profile fields* (a model ID
 *    the deployment is known to serve, recommended sampling values). It does
 *    not install, download, start, or switch anything on a remote server.
 *  - a model that the endpoint does not advertise is reported as such; the
 *    user is told to launch/configure the matching deployment instead of the
 *    app pretending the server changed models.
 *  - every deployment combination carries an explicit verification status
 *    with the evidence behind it. "Implemented — not live-verified" and
 *    "Blocked" are first-class states, not euphemisms for "supported".
 *
 * Sources (checked 2026-10-22): the KRAFTON model card and GGUF repository
 * metadata (`huggingface.co/KRAFTON/Raon-1-mini-preview[-gguf]`), the
 * `krafton-ai/llama.cpp` branch `raon-1-mini-preview`, Google Cloud TPU
 * inference documentation, and this repository's own deployment records.
 */

import type { InferenceParams } from '../api/requests';

/** How much evidence exists for one model × accelerator combination. */
export type DeploymentStatus =
  | 'verified'
  | 'preexisting_not_reverified'
  | 'implemented_not_live_verified'
  | 'blocked'
  | 'unsupported'
  | 'not_applicable';

export const DEPLOYMENT_STATUS_LABELS: Record<DeploymentStatus, string> = {
  verified: 'Verified',
  preexisting_not_reverified: 'Pre-existing — not re-verified live',
  implemented_not_live_verified: 'Implemented — not live-verified',
  blocked: 'Blocked',
  unsupported: 'Unsupported',
  not_applicable: 'Not applicable',
};

export type DeploymentAccelerator =
  | 'kaggle_t4x2'
  | 'kaggle_tpu_v5e8'
  | 'hosted_api'
  | 'custom_endpoint';

export const ACCELERATOR_LABELS: Record<DeploymentAccelerator, string> = {
  kaggle_t4x2: 'Kaggle GPU T4 x2',
  kaggle_tpu_v5e8: 'Kaggle TPU v5e-8',
  hosted_api: 'Hosted API',
  custom_endpoint: 'Custom endpoint',
};

export interface DeploymentCombination {
  accelerator: DeploymentAccelerator;
  status: DeploymentStatus;
  /** Runtime/checkpoint combination this status refers to. */
  runtime: string;
  /** What actually proves (or blocks) this combination. Never invented. */
  evidence: string;
}

export type ModelAccess = 'open' | 'gated_weights' | 'provider_account' | 'user_configured';

export type InferenceUseCase = 'general' | 'coding_math';

export interface ModelCatalogEntry {
  /** Stable catalog slug, unrelated to any endpoint's model ID. */
  id: string;
  displayName: string;
  description: string;
  architecture: string;
  totalParameters?: string;
  activeParameters?: string;
  contextTokens?: number;
  license?: string;
  access: ModelAccess;
  accessNote: string;
  /**
   * Model IDs this project's own deployments (or the provider's documented
   * examples) are known to serve under. Empty means the served ID is decided
   * by the server and must be discovered — the app never invents one.
   */
  servedModelIds: string[];
  /**
   * Normalized substrings (lowercase, separators removed) used to recognize a
   * discovered model ID as this catalog entry, e.g. a GGUF file name that a
   * llama.cpp server reports as its model ID.
   */
  matchKeys: string[];
  /**
   * Recommended request-time sampling values for the general use case. Only
   * the keys present here are applied; a key explicitly set to `undefined`
   * clears a previously configured value (the parameter is then omitted).
   */
  recommendedParams?: Partial<InferenceParams>;
  /** Overrides of `recommendedParams` for coding/math work. */
  codingMathParams?: Partial<InferenceParams>;
  /** Where the recommendations come from; shown next to the apply action. */
  recommendedParamsSource?: string;
  deployments: DeploymentCombination[];
}

/** Normalize a model ID for catalog matching: case and separators ignored. */
export function normalizeModelKey(modelId: string): string {
  return modelId.toLowerCase().replace(/[-_.\s/]/g, '');
}

export const QWEN_CATALOG_ID = 'Qwen3.8-27b';
export const RAON_CATALOG_ID = 'raon-1-mini-preview';
export const CUSTOM_CATALOG_ID = 'custom-openai-compatible';

export const MODEL_CATALOG: readonly ModelCatalogEntry[] = [
  {
    id: QWEN_CATALOG_ID,
    displayName: 'Qwen3.8-27B',
    description:
      'The model this repository deploys by default: a 27B hybrid gated-DeltaNet/attention model served as a GGUF (GSQ-RCO IQ3_S with an MTP head) by the CUDA build of llama.cpp on two Tesla T4 GPUs.',
    architecture: 'Hybrid gated DeltaNet + full attention (dense 27B)',
    totalParameters: '27B',
    contextTokens: 262_144,
    license: 'See the checkpoint repository',
    access: 'open',
    accessNote:
      'The GGUF checkpoint used by the notebook (ISTA-DASLab/Qwen3.8-27B-GSQ-RCO-GGUF) is downloaded from Hugging Face by the deployment cell. An operator-pinned revision/digest can be configured there.',
    servedModelIds: [],
    matchKeys: ['qwen3827b', 'qwen38'],
    recommendedParams: {
      temperature: 0.7,
      topP: 0.95,
      frequencyPenalty: undefined,
      presencePenalty: undefined,
      topK: undefined,
      minP: undefined,
      repetitionPenalty: undefined,
    },
    recommendedParamsSource:
      'Kaggle-Kit profile defaults for the verified deployment. The sampling extensions (top_k/min_p/repetition_penalty) stay unset, so they are omitted from requests.',
    deployments: [
      {
        accelerator: 'kaggle_t4x2',
        // Not 'verified': the repository's logs record that this script was
        // derived from an operator-verified cell but never itself executed on
        // real Kaggle T4 hardware in any development environment.
        status: 'preexisting_not_reverified',
        runtime: 'llama.cpp CUDA (pinned builds b11717–b11719), GGUF IQ3_S, ctx 8192, MTP when the build supports it',
        evidence:
          'The existing deployment cell (notebooks/qwen3_8_27b_api.py) with its real-inference smoke test and unit suite. Preserved unchanged in dev7; a rerun reuses a healthy server and never touches foreign processes.',
      },
      {
        accelerator: 'kaggle_tpu_v5e8',
        status: 'implemented_not_live_verified',
        runtime: 'vLLM TPU backend (tpu-inference), bf16 safetensors checkpoint, tensor parallel 8, MTP off',
        evidence:
          'notebooks/tpu_deployment.py builds the pinned vllm-tpu command, requires 8 real TPU devices and refuses CPU fallback. Upstream vllm-tpu gained gated-DeltaNet Pallas kernels and community Kaggle v5e-8 runs exist, including the finding that stock MTP corrupts outputs on TPU — so MTP is forced off. No TPU was available in the dev7 environment, so this path has not executed here.',
      },
    ],
  },
  {
    id: RAON_CATALOG_ID,
    displayName: 'Raon-1 mini preview',
    description:
      'KRAFTON AI 30B-A4B Mixture-of-Experts model: 28.8B total parameters, 4.3B active per token (6 of 128 routed experts + 1 shared), 18 Raon Delta Attention layers + 7 gated-MLA layers, thinking enabled by default. The active-parameter count describes the MoE routing; it is not a speed measurement.',
    architecture: 'MoE — hybrid Raon Delta Attention (18) + Gated MLA (7), 25 layers, NoPE',
    totalParameters: '28.8B',
    activeParameters: '4.3B',
    contextTokens: 262_144,
    license: 'Apache-2.0 (weights; hosted API/playground terms are separate)',
    access: 'gated_weights',
    accessNote:
      'The Hugging Face repositories are access-gated: request access with your own account, then provide your token to the deployment through the HF_TOKEN environment/secret mechanism. Kaggle-Kit ships no token and never puts one in a URL, argv, log, or file in this repository. Without access the download fails explicitly.',
    servedModelIds: ['Raon-1-mini-preview'],
    matchKeys: ['raon1minipreview', 'raon1mini', 'raon1'],
    recommendedParams: {
      temperature: 1.0,
      topP: 0.95,
      topK: 20,
      minP: 0.0,
      repetitionPenalty: 1.0,
      frequencyPenalty: 0,
      presencePenalty: 1.5,
    },
    codingMathParams: {
      presencePenalty: 0,
    },
    recommendedParamsSource:
      'KRAFTON model card baseline (thinking on): temperature 1.0, top_p 0.95, top_k 20, min_p 0.0, repetition_penalty 1.0, frequency_penalty 0; presence_penalty 1.5 for general chat/summarization/agentic use and 0 for coding/math. truncate_history_thinking=false is a chat-template/startup setting of the deployment, not a per-request field here.',
    deployments: [
      {
        accelerator: 'kaggle_t4x2',
        status: 'implemented_not_live_verified',
        runtime:
          'KRAFTON llama.cpp branch raon-1-mini-preview (pinned commit, built with CUDA in the notebook), GGUF Q4_K_M (IQ4_XS fallback), layer split over both T4s',
        evidence:
          'Quantization sizes from the official GGUF repository metadata (Q4_K_M 19,686,434,304 B; IQ4_XS 16,071,801,344 B) fit a layer split across 2×16 GB with headroom for the small MLA-only KV cache; digests are pinned from the same metadata. The code path, gated-download failure, and command construction are unit-tested. No Kaggle GPU or gated access was available in the dev7 environment, so no live inference has run here.',
      },
      {
        accelerator: 'kaggle_tpu_v5e8',
        status: 'blocked',
        runtime: 'No TPU runtime with Raon kernels (RDA / Gated MLA / SiTU-GLU / Raon-mHC)',
        evidence:
          'KRAFTON ships CUDA paths only (llama.cpp branch and a vLLM fork); the GGUF file is not consumable by a TPU runtime, CUDA kernels cannot run on TPU, and the documented vllm-tpu/tpu-inference model support does not include the raon1 architecture. notebooks/tpu_deployment.py therefore refuses this combination explicitly instead of falling back to CPU or another accelerator. Revisit when a TPU backend publishes raon1 support.',
      },
      {
        accelerator: 'hosted_api',
        status: 'implemented_not_live_verified',
        runtime: 'Configurable OpenAI-compatible profile (existing connection architecture)',
        evidence:
          'KRAFTON documents a hosted API with its own access flow and separate terms from the Apache-2.0 weights. Kaggle-Kit does not hardcode a provider base URL or token: create a separate profile with the endpoint and credential your provider issued, then use Discover models + Test connection (real inference) to verify it. The generic path is covered by the existing tests; the official service was not live-tested here (no provider credential).',
      },
    ],
  },
  {
    id: CUSTOM_CATALOG_ID,
    displayName: 'Custom OpenAI-compatible endpoint',
    description:
      'Any other server that speaks the OpenAI-compatible API (llama.cpp, vLLM, SGLang, a hosted provider, …). Kaggle-Kit knows nothing about it beyond what the endpoint itself reports.',
    architecture: 'Determined by your server',
    access: 'user_configured',
    accessNote:
      'You supply the base URL and, when the server requires one, its API key through the existing credential modes. Nothing is prefilled and no model is assumed.',
    servedModelIds: [],
    matchKeys: [],
    deployments: [
      {
        accelerator: 'custom_endpoint',
        status: 'not_applicable',
        runtime: 'Your OpenAI-compatible server',
        evidence:
          'Model availability comes only from dynamic discovery (/v1/models) and the staged connection test with real inference.',
      },
    ],
  },
];

/** Find a catalog entry by its catalog slug. */
export function catalogEntryById(id: string): ModelCatalogEntry | undefined {
  return MODEL_CATALOG.find((entry) => entry.id === id);
}

/**
 * Recognize which catalog entry a concrete model ID belongs to, based on the
 * IDs our deployments serve and on normalized name fragments (a llama.cpp
 * server commonly reports the GGUF file name). Returns `undefined` for
 * anything unknown — an unrecognized model is custom, never guessed.
 */
export function findCatalogEntryByModelId(modelId: string): ModelCatalogEntry | undefined {
  const trimmed = modelId.trim();
  if (!trimmed) return undefined;
  const exact = MODEL_CATALOG.find((entry) =>
    entry.servedModelIds.some((served) => served.toLowerCase() === trimmed.toLowerCase()),
  );
  if (exact) return exact;
  const key = normalizeModelKey(trimmed);
  return MODEL_CATALOG.find((entry) => entry.matchKeys.some((fragment) => key.includes(fragment)));
}

/** The recommended sampling values of an entry for a use case. */
export function recommendedParamsFor(
  entry: ModelCatalogEntry,
  useCase: InferenceUseCase = 'general',
): Partial<InferenceParams> {
  const base = entry.recommendedParams ?? {};
  return useCase === 'coding_math' ? { ...base, ...(entry.codingMathParams ?? {}) } : { ...base };
}

/**
 * Apply an entry's recommended sampling values to a profile's parameters.
 *
 * Only sampling fields are touched: `maxTokens`, `stream`, and
 * `reasoningEffort` always keep the profile's current values, so applying
 * Raon defaults can never silently change output length or transport, and
 * applying Qwen defaults clears the sampling extensions instead of leaking
 * Raon values into a Qwen profile.
 */
export function applyRecommendedParams(
  current: InferenceParams,
  entry: ModelCatalogEntry,
  useCase: InferenceUseCase = 'general',
): InferenceParams {
  const recommended = recommendedParamsFor(entry, useCase);
  const next: InferenceParams = { ...current };
  if ('temperature' in recommended) next.temperature = recommended.temperature ?? current.temperature;
  if ('topP' in recommended) next.topP = recommended.topP ?? current.topP;
  if ('frequencyPenalty' in recommended) next.frequencyPenalty = recommended.frequencyPenalty;
  if ('presencePenalty' in recommended) next.presencePenalty = recommended.presencePenalty;
  if ('topK' in recommended) next.topK = recommended.topK;
  if ('minP' in recommended) next.minP = recommended.minP;
  if ('repetitionPenalty' in recommended) next.repetitionPenalty = recommended.repetitionPenalty;
  return next;
}

export type ModelAvailabilityState = 'advertised' | 'not_advertised' | 'unknown';

export interface ModelAvailability {
  state: ModelAvailabilityState;
  message: string;
}

/**
 * Compare a catalog entry with what the selected endpoint actually reported.
 *
 * `unknown` means discovery has not run (or returned nothing), so no claim is
 * made either way. `not_advertised` is the honest signal to launch/configure
 * the matching deployment — selecting the catalog entry did not (and cannot)
 * switch the remote server's model.
 */
export function describeModelAvailability(
  entry: ModelCatalogEntry,
  discoveredModelIds: readonly string[],
): ModelAvailability {
  if (entry.id === CUSTOM_CATALOG_ID) {
    return {
      state: 'unknown',
      message: 'Custom endpoint: use “Discover models” to read the model IDs this server reports, or type one by hand.',
    };
  }
  if (discoveredModelIds.length === 0) {
    return {
      state: 'unknown',
      message: `No discovery result for this endpoint yet. Run “Discover models” to check whether it serves ${entry.displayName}.`,
    };
  }
  const advertised = discoveredModelIds.some(
    (modelId) => findCatalogEntryByModelId(modelId)?.id === entry.id,
  );
  if (advertised) {
    return {
      state: 'advertised',
      message: `The endpoint advertises ${entry.displayName}. “Test connection” still decides usability with a real inference request.`,
    };
  }
  return {
    state: 'not_advertised',
    message:
      `${entry.displayName} is not in this endpoint's /v1/models list (${discoveredModelIds.join(', ')}). ` +
      'Selecting a catalog entry does not switch a remote server: launch the matching deployment (see docs/kaggle-deployment.md) or point this profile at an endpoint that serves it. A hand-typed model ID is sent only as this profile’s explicit manual ID.',
  };
}

/** The full deployment matrix, flattened for documentation-style rendering. */
export function deploymentMatrix(): Array<{
  model: string;
  accelerator: string;
  status: DeploymentStatus;
  statusLabel: string;
  runtime: string;
  evidence: string;
}> {
  return MODEL_CATALOG.flatMap((entry) =>
    entry.deployments.map((deployment) => ({
      model: entry.displayName,
      accelerator: ACCELERATOR_LABELS[deployment.accelerator],
      status: deployment.status,
      statusLabel: DEPLOYMENT_STATUS_LABELS[deployment.status],
      runtime: deployment.runtime,
      evidence: deployment.evidence,
    })),
  );
}
