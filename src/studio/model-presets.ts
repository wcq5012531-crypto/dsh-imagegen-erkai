/**
 * Seed parameter schemas for the models on `api.mmg.lat`.
 *
 * Every gateway spells the same knobs differently — `size` vs `image_size`,
 * `seconds` vs `duration`, `1080P` vs `1080p`, a clip length encoded in the
 * model id instead of the body. Hard-coding one shape per family is what made
 * the old panel need a code change per model; here the shape is data, so the
 * panel renders whatever a model declares and the engine writes it verbatim.
 *
 * These presets are only a starting point: the 模型 editor in the panel loads
 * them, then the user edits any field, adds their own, or discovers the live
 * list from `/v1/models`. Nothing downstream assumes these exact values.
 *
 * @module
 */

import type { AdapterModelSpec } from './adapter-spec.js'
import type { StudioParamField } from './param-schema.js'

/** Choices for the aspect ratio knob most video models share. */
function ratioOptions(values: string[]): StudioParamField['options'] {
  return values.map((value) => ({ value }))
}

/** `size` expressed as `WIDTHxHEIGHT` pairs. */
function sizeOptions(values: string[]): StudioParamField['options'] {
  return values.map((value) => ({ value }))
}

/** The OpenAI-compatible quality ladder. */
const QUALITY: StudioParamField = {
  key: 'quality',
  kind: 'enum',
  label: '质量',
  options: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }, { value: 'auto' }],
  omitWhenDefault: true,
  help: 'OpenAI 兼容图片接口的质量档位；不选则不发送。',
}

/** `n` — how many images one call returns. */
const COUNT: StudioParamField = {
  key: 'n',
  kind: 'number',
  label: '张数',
  role: 'n',
  min: 1,
  max: 10,
  step: 1,
  default: 1,
  omitWhenDefault: true,
}

/** Grain seed; 0 is a real seed, so it is always sent once touched. */
const SEED: StudioParamField = {
  key: 'seed',
  kind: 'number',
  label: '种子',
  role: 'seed',
  min: 0,
  max: 2147483647,
  step: 1,
  placeholder: '留空则随机',
  help: '相同种子 + 相同提示词可复现同一张图/同一段视频。',
}

/** Vendor-native `image_size` tokens (nano-banana family). */
const IMAGE_SIZE_TOKENS: StudioParamField = {
  key: 'image_size',
  kind: 'enum',
  label: '尺寸',
  role: 'size',
  name: 'image_size',
  options: [{ value: '1K' }, { value: '2K' }, { value: '4K' }],
  default: '1K',
  help: '这是厂商自己的档位 token，不是像素值；像素由档位 + 画幅共同决定。',
}

/** Pixel `size` (gpt-image family). */
const PIXEL_SIZE: StudioParamField = {
  key: 'size',
  kind: 'enum',
  label: '尺寸',
  role: 'size',
  options: sizeOptions(['1024x1024', '1536x1024', '1024x1536', 'auto']),
  default: '1024x1024',
}

/** Free-form `WIDTHxHEIGHT` for Stable Diffusion endpoints. */
const FREE_SIZE: StudioParamField = {
  key: 'size',
  kind: 'string',
  label: '尺寸',
  role: 'size',
  placeholder: '1024x1024',
  help: '宽x高，像素值。',
}

/** Classic SD knobs. */
const SD_EXTRA: StudioParamField[] = [
  {
    key: 'negative_prompt',
    kind: 'longtext',
    label: '反向提示词',
    role: 'negativePrompt',
    placeholder: '不想要的内容',
    surfaces: ['image', 'edit'],
  },
  {
    key: 'steps',
    kind: 'number',
    label: '采样步数',
    min: 1,
    max: 100,
    step: 1,
    default: 28,
    omitWhenDefault: true,
  },
  {
    key: 'cfg_scale',
    kind: 'number',
    label: '引导强度',
    min: 0,
    max: 30,
    step: 0.5,
    default: 7,
    omitWhenDefault: true,
  },
  {
    key: 'sampler',
    kind: 'enum',
    label: '采样器',
    options: [
      { value: 'DPM++ 2M Karras' },
      { value: 'Euler a' },
      { value: 'Euler' },
      { value: 'DDIM' },
    ],
    omitWhenDefault: true,
  },
  {
    key: 'watermark',
    kind: 'boolean',
    label: '水印',
    default: false,
    omitWhenDefault: true,
    encode: 'bool01',
    help: '部分网关只接受 1/0，这里按 bool01 编码。',
  },
]

/** Aspect knob used by nearly every video model. */
function videoAspect(options: string[]): StudioParamField {
  return {
    key: 'aspect_ratio',
    kind: 'enum',
    label: '画幅',
    role: 'aspect',
    name: 'aspect_ratio',
    options: ratioOptions(options),
    default: options[0],
  }
}

/** Integer clip length in seconds. */
function videoSeconds(options: number[], def: number): StudioParamField {
  return {
    key: 'seconds',
    kind: 'enum',
    label: '时长',
    role: 'duration',
    name: 'seconds',
    options: options.map((value) => ({ value, label: `${value}s` })),
    default: def,
    help: '这个模型只接受这几档时长；需要更长请用「续时长」链式拼接。',
  }
}

/** Reference-frame limits differ per model, so each declares its own. */
const IMAGE_REFS = 4

/**
 * Image models shipped with the image adapter preset.
 * @returns seed specs; the panel lets the user edit every field.
 */
export function imageModelPresets(): AdapterModelSpec[] {
  const families: Array<[string, string, StudioParamField[], Record<string, unknown>?]> = [
    ['nano-banana-pro · 1K', 'nano-banana-pro-1k', [IMAGE_SIZE_TOKENS, videoAspect(['1:1', '4:3', '3:4', '16:9', '9:16']), SEED, COUNT]],
    ['nano-banana-pro · 2K', 'nano-banana-pro-2k', [IMAGE_SIZE_TOKENS, videoAspect(['1:1', '4:3', '3:4', '16:9', '9:16']), SEED, COUNT]],
    ['nano-banana-pro · 4K', 'nano-banana-pro-4k', [{ ...IMAGE_SIZE_TOKENS, options: [{ value: '4K' }], default: '4K' }, videoAspect(['1:1', '4:3', '3:4', '16:9', '9:16']), SEED, COUNT]],
    ['nano-banana-2.1 · 1K', 'nano-banana-2.1-1k', [IMAGE_SIZE_TOKENS, videoAspect(['1:1', '4:3', '3:4', '16:9', '9:16']), SEED, COUNT]],
    ['nano-banana-2.1 · 2K', 'nano-banana-2.1-2k', [IMAGE_SIZE_TOKENS, videoAspect(['1:1', '4:3', '3:4', '16:9', '9:16']), SEED, COUNT]],
    ['gpt-image-2', 'gpt-image-2', [PIXEL_SIZE, QUALITY, COUNT, SEED],
      { background: 'auto', output_format: 'png' }],
    ['gpt-image-2 · 2K', 'gpt-image-2-2k', [PIXEL_SIZE, QUALITY, COUNT, SEED]],
    ['gpt-image-2 · 4K', 'gpt-image-2-4k', [PIXEL_SIZE, QUALITY, COUNT, SEED]],
    ['SD 2.5', 'sd-2.5', [FREE_SIZE, ...SD_EXTRA, COUNT, SEED]],
    ['SD 2.0 · 933', 'sd-2.0-933', [FREE_SIZE, ...SD_EXTRA, COUNT, SEED]],
    ['SD 2.0 · 900', 'sd-2.0-900', [FREE_SIZE, ...SD_EXTRA, COUNT, SEED]],
  ]
  return families.map(([alias, id, params, extra]) => ({
    alias,
    id,
    params,
    maxRefImages: IMAGE_REFS,
    extra,
  }))
}

/**
 * Video models shipped with the video adapter preset.
 *
 * Note the `wan` and `seedance` entries: their resolution is baked into the
 * model id, so the schema deliberately omits a `resolution` field — declaring
 * one would send a token the gateway does not read.
 * @returns seed specs; the panel lets the user edit every field.
 */
export function videoModelPresets(): AdapterModelSpec[] {
  return [
    {
      alias: 'Grok Imagine 1.5',
      id: 'grok-imagine-video-1.5-preview',
      aspectRatios: ['16:9', '9:16', '1:1'],
      resolutions: ['480p', '720p'],
      durations: [6, 10],
      maxRefImages: 1,
      params: [
        videoAspect(['16:9', '9:16', '1:1']),
        videoSeconds([6, 10], 6),
        {
          key: 'resolution',
          kind: 'enum',
          label: '清晰度',
          role: 'resolution',
          name: 'resolution',
          options: [{ value: '480p' }, { value: '720p' }],
          default: '720p',
        },
        SEED,
      ],
      extra: { mode: 'text' },
    },
    {
      alias: 'Veo 3.1 Fast',
      id: 'veo-3.1-fast-generate-preview',
      aspectRatios: ['16:9', '9:16'],
      resolutions: ['720p', '1080p'],
      durations: [8],
      maxRefImages: 2,
      params: [
        videoAspect(['16:9', '9:16']),
        {
          key: 'resolution',
          kind: 'enum',
          label: '清晰度',
          role: 'resolution',
          name: 'resolution',
          options: [{ value: '720p' }, { value: '1080p' }],
          default: '1080p',
        },
        {
          key: 'generate_audio',
          kind: 'boolean',
          label: '生成音轨',
          default: true,
          omitWhenDefault: true,
        },
        {
          key: 'negative_prompt',
          kind: 'longtext',
          label: '反向提示词',
          role: 'negativePrompt',
        },
      ],
      // veo refuses a `seconds` field; the clip is always 8s.
      priceNote: '固定 8 秒，不接受时长参数。',
    },
    {
      alias: 'Seedance 2.0 · 480P',
      id: 'seedance-2.0-933-480p',
      aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'],
      resolutions: ['480p'],
      durations: [4, 5, 6, 8, 10, 12],
      maxRefImages: 3,
      params: [
        videoAspect(['16:9', '9:16', '1:1', '4:3', '3:4', '21:9']),
        videoSeconds([4, 5, 6, 8, 10, 12], 5),
        { key: 'watermark', kind: 'boolean', label: '水印', default: false, omitWhenDefault: true },
        { key: 'camera_fixed', kind: 'boolean', label: '固定机位', default: false, omitWhenDefault: true },
        SEED,
      ],
    },
    {
      alias: 'Seedance 2.0 · 720P',
      id: 'seedance-2.0-933-720p',
      aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'],
      resolutions: ['720p'],
      durations: [4, 5, 6, 8, 10, 12],
      maxRefImages: 3,
      params: [
        videoAspect(['16:9', '9:16', '1:1', '4:3', '3:4', '21:9']),
        videoSeconds([4, 5, 6, 8, 10, 12], 5),
        { key: 'watermark', kind: 'boolean', label: '水印', default: false, omitWhenDefault: true },
        { key: 'camera_fixed', kind: 'boolean', label: '固定机位', default: false, omitWhenDefault: true },
        SEED,
      ],
    },
    {
      alias: 'Seedance 2.0 Fast · 特价',
      id: 'seedance-2.0-fast-特价',
      aspectRatios: ['16:9', '9:16'],
      resolutions: ['480p'],
      durations: [4, 5, 6],
      maxRefImages: 1,
      params: [
        videoAspect(['16:9', '9:16']),
        videoSeconds([4, 5, 6], 5),
        SEED,
      ],
      priceNote: '特价档，分辨率固定 480p。',
    },
    {
      alias: 'Wan 3.0 快速 · 720P',
      id: 'wan-3.0-快速-720p',
      aspectRatios: ['16:9', '9:16', '1:1'],
      resolutions: ['720p'],
      durations: [5],
      maxRefImages: 1,
      params: [
        videoAspect(['16:9', '9:16', '1:1']),
        { key: 'audio', kind: 'boolean', label: '带音轨', default: false, omitWhenDefault: true },
        SEED,
      ],
      // `duration` is not read by this family; the id fixes 5s.
      priceNote: '固定 5 秒；分辨率由模型 id 决定。',
    },
    {
      alias: 'Wan 3.0 快速 · 1080P',
      id: 'wan-3.0-快速-1080p',
      aspectRatios: ['16:9', '9:16', '1:1'],
      resolutions: ['1080p'],
      durations: [5],
      maxRefImages: 1,
      params: [
        videoAspect(['16:9', '9:16', '1:1']),
        { key: 'audio', kind: 'boolean', label: '带音轨', default: false, omitWhenDefault: true },
        SEED,
      ],
      priceNote: '固定 5 秒；分辨率由模型 id 决定。',
    },
    {
      alias: 'MiniMax H3',
      id: 'minimax_h3',
      aspectRatios: ['16:9', '9:16', '1:1'],
      resolutions: ['768P', '1080P'],
      durations: [6, 10],
      maxRefImages: 1,
      params: [
        videoAspect(['16:9', '9:16', '1:1']),
        videoSeconds([6, 10], 6),
        {
          key: 'resolution',
          kind: 'enum',
          label: '清晰度',
          role: 'resolution',
          name: 'resolution',
          options: [{ value: '768P' }, { value: '1080P' }],
          default: '768P',
          help: '注意是大写 P：这个网关认 768P/1080P，写 720p 会被忽略。',
        },
        {
          key: 'prompt_optimizer',
          kind: 'boolean',
          label: '自动优化提示词',
          default: true,
          omitWhenDefault: true,
        },
      ],
    },
    {
      alias: 'MiniMax H3 · no_audios',
      id: 'minimax_h3-no_audios',
      aspectRatios: ['16:9', '9:16', '1:1'],
      resolutions: ['768P', '1080P'],
      durations: [6, 10],
      maxRefImages: 1,
      params: [
        videoAspect(['16:9', '9:16', '1:1']),
        videoSeconds([6, 10], 6),
        {
          key: 'resolution',
          kind: 'enum',
          label: '清晰度',
          role: 'resolution',
          name: 'resolution',
          options: [{ value: '768P' }, { value: '1080P' }],
          default: '768P',
        },
      ],
      priceNote: '无音轨变体。',
    },
    {
      alias: 'MiniMax H3 · 内置提示词优化',
      id: 'minimax_h3-内置提示词优化',
      aspectRatios: ['16:9', '9:16', '1:1'],
      resolutions: ['768P', '1080P'],
      durations: [6, 10],
      maxRefImages: 1,
      params: [
        videoAspect(['16:9', '9:16', '1:1']),
        videoSeconds([6, 10], 6),
        {
          key: 'resolution',
          kind: 'enum',
          label: '清晰度',
          role: 'resolution',
          name: 'resolution',
          options: [{ value: '768P' }, { value: '1080P' }],
          default: '768P',
        },
      ],
      priceNote: '自带提示词优化，prompt_optimizer 固定在服务端。',
    },
  ]
}
