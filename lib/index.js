import { n as imageGenLanguageOf, r as interpolate } from "./locale-tables-chunk.js";
import { accessSync, constants, createReadStream, existsSync, promises, readFileSync, statSync } from "node:fs";
import fs, { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path, { join } from "node:path";
import * as settingsModule from "@deepseek-ai/dsh-settings";
import { SettingsConflictError } from "@deepseek-ai/dsh-settings";
import z from "@deepseek-ai/schemastery";
import { spawn } from "node:child_process";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import http from "node:http";
import { deflateSync, inflateRawSync, inflateSync } from "node:zlib";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { defineTool } from "@deepseek-ai/dsh-tools";
//#region src/settings-compat.ts
const compatModule = settingsModule;
/** Strip volatile markers for the pre-0.1.7 settings providers. */
function plainSettingsSchema(schema) {
	const clone = schema.toJSON();
	const seen = /* @__PURE__ */ new WeakSet();
	const walk = (node) => {
		if (typeof node !== "object" || node === null || seen.has(node)) return;
		seen.add(node);
		const record = node;
		const meta = record.meta;
		if (typeof meta === "object" && meta !== null) delete meta.volatile;
		if (typeof record.dict === "object" && record.dict !== null) for (const child of Object.values(record.dict)) walk(child);
		walk(record.inner);
		walk(record.sKey);
		if (Array.isArray(record.list)) for (const child of record.list) walk(child);
	};
	walk(clone);
	return clone;
}
/** The loader entry id of the plugin instance owning `ctx`, when available. */
function entryNamespaceOf(ctx) {
	const compat = ctx;
	const entry = compat.fiber?.entry;
	const candidates = [
		entry?.options?.id,
		entry?.id,
		compat.loader?.locate?.(compat.fiber)
	];
	for (const candidate of candidates) if (typeof candidate === "string" && candidate !== "") return candidate;
}
/** Brand namespaces where the installed settings package still exposes it. */
function settingsNamespaceCompat(value) {
	return compatModule.settingsNamespace?.(value) ?? value;
}
/**
* Resolve the namespace the settings bridge must read and write.
*
* Older settings providers register a caller-chosen namespace through the
* module helper or `provider.installSection`. The managed-forms provider used
* by DSH 0.1.7 derives forms from the plugin's profile entry instead, so its
* namespace is the entry id (`imagegen`) rather than the legacy display id
* (`dsh-imagegen-studio`). The bridge keeps the legacy id on its public wire contract
* and translates it to this internal namespace.
*/
function resolveSettingsNamespaceCompat(ctx, provider, fallback) {
	if (compatModule.installSettingsSection !== void 0) return fallback;
	const candidate = provider;
	if (candidate.installSection !== void 0) return fallback;
	if (candidate.configure !== void 0) return entryNamespaceOf(ctx) ?? fallback;
	return fallback;
}
/**
* Register an optional settings section across the rc.7, alpha.2 and managed
* forms APIs. The first two expose an installer; 0.1.7 derives forms directly
* from the plugin's volatile Config and only needs the custom-page policy.
*/
function installSettingsSectionCompat(ctx, ns, schema, entry, hooks) {
	const legacyInstaller = compatModule.installSettingsSection;
	if (legacyInstaller !== void 0) {
		legacyInstaller(ctx, ns, plainSettingsSchema(schema), entry, hooks);
		return;
	}
	ctx.inject(["settings"], (sctx) => {
		const provider = sctx.get("settings");
		if (provider.installSection !== void 0) {
			provider.installSection(ctx, ns, plainSettingsSchema(schema), entry, hooks);
			return;
		}
		if (provider.configure === void 0) throw new TypeError("dsh-settings does not expose installSection or configure");
		sctx.effect(() => {
			const dispose = provider.configure?.({ auto: false }, ctx.fiber);
			return typeof dispose === "function" ? dispose : () => {};
		});
		const namespace = entryNamespaceOf(ctx);
		if (namespace !== void 0) {
			const settingsEvents = sctx;
			sctx.effect(() => settingsEvents.on("settings/document-updated", (updated) => {
				if (String(updated) === namespace) hooks.onChange();
			}));
		}
	});
}
//#endregion
//#region src/protocol.ts
/**
* Wire contract shared by the host and client halves of dsh-imagegen-studio: the
* settings namespace, the route paths, and the generate payload/result shapes.
* Pure types + constants — safe for the client bundle to inline.
*/
/** Settings namespace this plugin owns (host settings seam + bridge). */
const IMAGEGEN_SETTINGS_NAMESPACE = "dsh-imagegen-studio";
/** Published package version shared by the host updater and the client UI. */
const PLUGIN_VERSION = "1.16.12";
/** Same-origin route family (loopback-only, mirroring the dsh-ssh fence). */
const SETTINGS_API = {
	describe: "/api/dsh-imagegen-studio/settings/describe",
	mutate: "/api/dsh-imagegen-studio/settings/mutate"
};
/** Subscription account login and status routes. */
const SUBSCRIPTION_API = {
	status: "/api/dsh-imagegen-studio/subscription/status",
	login: "/api/dsh-imagegen-studio/subscription/login"
};
/** Official/subscription-backed image providers. */
const SUBSCRIPTION_PROVIDERS = [
	"chatgpt-sub",
	"grok-sub",
	"google-sub",
	"openrouter-sub"
];
/** Whether an endpoint URL explicitly names an OpenAI-compatible chat route. */
function isChatCompletionsUrl(value) {
	const trimmed = value.trim();
	if (trimmed === "") return false;
	try {
		return /\/chat\/completions\/?$/.test(new URL(trimmed).pathname);
	} catch {
		return /\/chat\/completions\/?$/.test(trimmed.split(/[?#]/, 1)[0] ?? "");
	}
}
/** Whether a stored value is one of the accepted protocol preferences. */
function isChannelProtocolPreference(value) {
	return value === "auto" || value === "images" || value === "chat-completions";
}
/** Resolve a channel preference without changing legacy behavior by default. */
function resolveChannelProtocol(apiUrl, preference = "auto") {
	if (preference === "images" || preference === "chat-completions") return preference;
	return isChatCompletionsUrl(apiUrl) ? "chat-completions" : "images";
}
/** Subscription channels with a fixed image model. */
const DEFAULT_SUBSCRIPTION_MODELS = {
	"chatgpt-sub": "gpt-image-2.5-flare",
	"grok-sub": "grok-imagine-image-2.0",
	"google-sub": "gemini-3-pro-image",
	"openrouter-sub": "google/gemini-3-pro-image"
};
/** Human-facing provider names used in status and errors. */
const SUBSCRIPTION_PROVIDER_DISPLAY_NAMES = {
	"chatgpt-sub": "ChatGPT 订阅",
	"grok-sub": "Grok 订阅",
	"google-sub": "Google 订阅",
	"openrouter-sub": "OpenRouter 账号"
};
/** Whether a raw string names one of the subscription providers. */
function isSubscriptionProvider(value) {
	return typeof value === "string" && SUBSCRIPTION_PROVIDERS.includes(value);
}
/** The image-generation proxy route. */
const GENERATE_API = "/api/dsh-imagegen-studio/generate";
/** Host-mediated OpenAI-compatible prompt enhancement endpoints. */
const PROMPT_ENHANCE_API = {
	models: "/api/dsh-imagegen-studio/prompt-enhance/models",
	enhance: "/api/dsh-imagegen-studio/prompt-enhance"
};
/** Host-mediated candidate discovery for the configured image API. */
const IMAGE_MODEL_API = { models: "/api/dsh-imagegen-studio/image-models" };
/** Host-served built-in provider catalog (channels the user can instantiate). */
const PRESETS_API = "/api/dsh-imagegen-studio/presets";
/** Loopback-only image reader for Agent tool-result previews. */
const AGENT_IMAGE_API = "/api/dsh-imagegen-studio/agent-image";
/** Store the current composer image for the direct studio_edit_image command. */
const CONVERSATION_IMAGE_API = "/api/dsh-imagegen-studio/conversation-image";
/**
* Host-computed per-channel usage counters (generation-count badges in the
* settings card): entries are tallied from the persisted history and gallery
* by channel + model alias.
*/
const USAGE_API = "/api/dsh-imagegen-studio/usage";
/** Host-resident generation queue endpoints. */
const TASK_API = {
	submit: "/api/dsh-imagegen-studio/tasks/submit",
	list: "/api/dsh-imagegen-studio/tasks/list",
	get: "/api/dsh-imagegen-studio/tasks/get",
	cancel: "/api/dsh-imagegen-studio/tasks/cancel",
	retry: "/api/dsh-imagegen-studio/tasks/retry"
};
/** Reveal the host data directory (saved images) in the OS file manager. */
const DATA_FOLDER_API = "/api/dsh-imagegen-studio/data-folder/open";
/**
* Generation diagnostics (#38): the retained record of upstream attempts, so a
* failure can be explained after the fact instead of only being toasted once.
*/
const DIAGNOSTICS_API = {
	list: "/api/dsh-imagegen-studio/diagnostics/list",
	clear: "/api/dsh-imagegen-studio/diagnostics/clear"
};
/** Probe the configured S3-compatible object storage. */
const STORAGE_API = { test: "/api/dsh-imagegen-studio/storage/test" };
/** Host-mediated GitHub Release update routes. */
const UPDATE_API = {
	check: "/api/dsh-imagegen-studio/update/check",
	apply: "/api/dsh-imagegen-studio/update/apply"
};
/**
* Video generation route family. Video is asynchronous upstream (submit →
* poll → download), so it keeps its own endpoints rather than reusing the
* synchronous image generate route. Finished clips are persisted as files
* under ~/.dsh/dsh-imagegen-studio/videos/ and served through the `file` prefix
* route, so neither list nor submit responses ever carry video bytes.
*/
const VIDEO_API = {
	/** Submit one video generation and wait for the finished file. */
	generate: "/api/dsh-imagegen-studio/video/generate",
	/** Host-resident video task queue (submit / list / get / cancel / retry). */
	submit: "/api/dsh-imagegen-studio/video/tasks/submit",
	list: "/api/dsh-imagegen-studio/video/tasks/list",
	get: "/api/dsh-imagegen-studio/video/tasks/get",
	cancel: "/api/dsh-imagegen-studio/video/tasks/cancel",
	retry: "/api/dsh-imagegen-studio/video/tasks/retry",
	/**
	* Persisted video history. There is deliberately no `append` endpoint: the
	* host owns the clip bytes, so the runtime persists a finished video itself.
	* A client can never submit video content, which keeps the store free of
	* client-supplied binaries.
	*/
	historyList: "/api/dsh-imagegen-studio/video/history/list",
	historyRemove: "/api/dsh-imagegen-studio/video/history/remove",
	historyClear: "/api/dsh-imagegen-studio/video/history/clear",
	/** Prefix route serving one stored clip: `${file}/<file>`. */
	file: "/api/dsh-imagegen-studio/video/file",
	/**
	* Preview the director plan without rendering anything.
	*
	* The submit path plans internally and the finished task carries its plan,
	* so this exists for the one thing a submit cannot do: show the user what
	* the planner decided BEFORE minutes of render time are spent.
	*/
	plan: "/api/dsh-imagegen-studio/video/plan"
};
/**
* Code-render route family: the second production path, beside the model APIs.
*
* A request here names a chat model, not an image/video model: the chat model
* writes drawing code and this host renders it locally. Nothing in this family
* touches an image or video provider.
*/
const CODE_RENDER_API = { 
/**
* Resolve what a render WOULD do (dimensions, frames, dependency status)
* without calling a model or rendering a frame.
*
* There is deliberately no `render` route here. A code render is submitted
* through the ordinary generate / video-submit endpoints with
* `renderer: 'code'`, so it inherits the same queue, cancellation, retry,
* placeholder and history behaviour as a model render instead of growing a
* second pipeline that would drift from the first.
*/
probe: "/api/dsh-imagegen-studio/code/probe" };
/**
* Same-origin route family for the host-persisted generation history. Images
* live as files under ~/.dsh/dsh-imagegen-studio/images/ and are served back through
* the `image` prefix route, so list responses carry metadata only (never
* base64) and the browser loads thumbnails/previews lazily.
*/
const HISTORY_API = {
	list: "/api/dsh-imagegen-studio/history/list",
	append: "/api/dsh-imagegen-studio/history/append",
	remove: "/api/dsh-imagegen-studio/history/remove",
	clear: "/api/dsh-imagegen-studio/history/clear",
	image: "/api/dsh-imagegen-studio/history/image",
	/**
	* Move one entry in or out of the archive (`{ id, archived }`), the same
	* two-state move the shell applies to conversations: archived entries keep
	* their files and stay restorable, they just leave the everyday list.
	*/
	archive: "/api/dsh-imagegen-studio/history/archive",
	/** The archived half of the list, newest first. */
	archived: "/api/dsh-imagegen-studio/history/archived"
};
/**
* Same-origin route family for the user-curated gallery (favorites). Entries
* reuse the history wire shape and persist under ~/.dsh/dsh-imagegen-studio/gallery/;
* unlike history there is no size cap — the user adds images on purpose.
*
* Every response that can change the trash carries it as a second field next
* to `entries`: the same two lists are always what the client renders.
*/
const GALLERY_API = {
	list: "/api/dsh-imagegen-studio/gallery/list",
	append: "/api/dsh-imagegen-studio/gallery/append",
	remove: "/api/dsh-imagegen-studio/gallery/remove",
	/** Bring one soft-deleted entry back out of the trash. */
	restore: "/api/dsh-imagegen-studio/gallery/restore",
	/** Permanently delete every trashed entry and its files. */
	purge: "/api/dsh-imagegen-studio/gallery/purge",
	clear: "/api/dsh-imagegen-studio/gallery/clear",
	tags: "/api/dsh-imagegen-studio/gallery/tags",
	/**
	* Category registry for the gallery (one action per request):
	* `{ action: 'create' | 'rename' | 'delete', name, to? }`. Categories are the
	* tag vocabulary the filter bar lists, kept next to the entries so an empty
	* category can exist before anything is filed into it.
	*/
	category: "/api/dsh-imagegen-studio/gallery/category",
	image: "/api/dsh-imagegen-studio/gallery/image",
	/** Favorite a finished clip (the host copies it out of the video store). */
	video: "/api/dsh-imagegen-studio/gallery/video",
	/** Prefix route serving one favorited clip: `${videoFile}/<file>`. */
	videoFile: "/api/dsh-imagegen-studio/gallery/video-file"
};
/** Host-persisted infinite canvas projects and their content-addressed assets. */
const CANVAS_API = {
	list: "/api/dsh-imagegen-studio/canvas/list",
	create: "/api/dsh-imagegen-studio/canvas/create",
	read: "/api/dsh-imagegen-studio/canvas/read",
	save: "/api/dsh-imagegen-studio/canvas/save",
	remove: "/api/dsh-imagegen-studio/canvas/remove",
	favorite: "/api/dsh-imagegen-studio/canvas/favorite",
	archive: "/api/dsh-imagegen-studio/canvas/archive",
	/** Rename a canvas from the list (page title and index title together). */
	rename: "/api/dsh-imagegen-studio/canvas/rename",
	assetUpload: "/api/dsh-imagegen-studio/canvas/asset/upload",
	assetImport: "/api/dsh-imagegen-studio/canvas/asset/import",
	asset: "/api/dsh-imagegen-studio/canvas/asset",
	/** Vision-model layer decomposition for the canvas layer-split tool. */
	layers: "/api/dsh-imagegen-studio/canvas/layers",
	/** Raw-binary upload for arbitrary canvas file nodes (no base64 inflation). */
	fileUpload: "/api/dsh-imagegen-studio/canvas/file/upload",
	/** Structured content preview (text / table / office / archive) of one asset. */
	filePreview: "/api/dsh-imagegen-studio/canvas/file/preview"
};
/** Same-origin route family for canvas skills (catalog + run control). */
const CANVAS_SKILL_API = {
	pptRun: "/api/dsh-imagegen-studio/ppt/run",
	pptTasks: "/api/dsh-imagegen-studio/ppt/tasks",
	pptRuntime: "/api/dsh-imagegen-studio/ppt/runtime",
	list: "/api/dsh-imagegen-studio/canvas/skills/list",
	run: "/api/dsh-imagegen-studio/canvas/skills/run",
	task: "/api/dsh-imagegen-studio/canvas/skills/task",
	cancel: "/api/dsh-imagegen-studio/canvas/skills/cancel",
	/** Local skill library (`~/.dsh/skills`): inspect, install, remove. */
	library: "/api/dsh-imagegen-studio/canvas/skills/library",
	install: "/api/dsh-imagegen-studio/canvas/skills/install",
	remove: "/api/dsh-imagegen-studio/canvas/skills/remove",
	/** Per-skill configuration values declared by `skill.config.json` (or a recipe). */
	configSave: "/api/dsh-imagegen-studio/canvas/skills/config/save",
	/** Run a declaration's `apply` steps (commands / files) with the saved values. */
	configApply: "/api/dsh-imagegen-studio/canvas/skills/config/apply"
};
/**
* Same-origin route family for the prompt-template libraries. The library is
* multi-source: every request names a source id from {@link TEMPLATE_SOURCES},
* each source keeps an independent snapshot/image cache host-side, and
* reference images are proxied through the source-scoped `image` prefix route
* (`…/image/<sourceId>/<file>`) and cached on disk so repeated views never hit
* the network again.
*/
const TEMPLATES_API = {
	list: "/api/dsh-imagegen-studio/templates/list",
	refresh: "/api/dsh-imagegen-studio/templates/refresh",
	sample: "/api/dsh-imagegen-studio/templates/sample",
	image: "/api/dsh-imagegen-studio/templates/image"
};
/** Same-origin route family for the user's saved (favorited) templates. */
const TEMPLATE_FAVORITES_API = {
	list: "/api/dsh-imagegen-studio/templates/favorites/list",
	add: "/api/dsh-imagegen-studio/templates/favorites/add",
	remove: "/api/dsh-imagegen-studio/templates/favorites/remove"
};
/**
* The template-library source registry. Each entry is fully independent (own
* upstream JSON, own image pool, own refresh state) and renders as its own
* tab; adding a source later means appending an entry here plus a host-side
* fetch definition in templates-store.ts and an optional bundled snapshot.
*/
const TEMPLATE_SOURCES = [
	{
		id: "vibeui",
		label: "精选案例库",
		homepage: "https://vibeui.top/",
		description: "awesome-gpt-image-2 精选提示词案例（vibeui.top 镜像）"
	},
	{
		id: "canghe",
		label: "沧河案例库",
		homepage: "https://gpt-image2.canghe.ai/",
		description: "GPT-Image2 Prompt Gallery（gpt-image2.canghe.ai，定期更新）"
	},
	{
		id: "handraw",
		label: "手绘模板库",
		homepage: "https://github.com/yang0/handraw-style",
		description: "手绘风格、排版图型与主题色图鉴（yang0/handraw-style）",
		refreshable: false
	},
	{
		id: "prompt-signal",
		label: "Prompt/Signal",
		homepage: "https://github.com/andy7076/image_prompt",
		description: "andy7076/image_prompt 的 570+ 精选生图提示词",
		refreshable: false
	},
	{
		id: "evolink",
		label: "GPT Image 2 案例库",
		homepage: "https://github.com/EvoLinkAI/awesome-gpt-image-2-prompts",
		description: "EvoLink 整理的 GPT Image 2 电商、广告、人像、海报、角色与 UI 案例",
		refreshable: false
	},
	{
		id: "itgoyo",
		label: "Prompt 图集",
		homepage: "https://github.com/itgoyo/awesome-gpt-image2-prompt",
		description: "612 组带示例图的 GPT-Image-2 提示词（itgoyo/awesome-gpt-image2-prompt，CC BY 4.0）",
		refreshable: false
	},
	{
		id: "songtianlun",
		label: "多模态提示词",
		homepage: "https://github.com/songtianlun/awesome-prompts",
		description: "按模态收录的生图 / 改图 / 生视频提示词（songtianlun/awesome-prompts，MIT）",
		refreshable: false
	},
	{
		id: "youart",
		label: "YouArt 2.5",
		homepage: "https://github.com/youart-open-source/awesome-gpt-image-2-5-prompts",
		description: "逐条署名到原作者与原始帖子的 GPT Image 2.5 提示词（CC BY 4.0，无示例图）",
		refreshable: false
	}
];
/** Default source id when a request does not name one (legacy clients). */
const DEFAULT_TEMPLATE_SOURCE_ID = TEMPLATE_SOURCES[0].id;
/** True when the id names a registered template source. */
function isTemplateSourceId(id) {
	return TEMPLATE_SOURCES.some((source) => source.id === id);
}
//#endregion
//#region src/model-catalog.ts
const ENTRIES$1 = {
	"gpt-image": {
		label: "gpt-image",
		labelZh: "GPT 图像",
		known: true,
		supportsEdit: true,
		supportsAspectRatio: false,
		qualityTiers: [
			"1K",
			"2K",
			"4K"
		]
	},
	"dall-e": {
		label: "DALL·E",
		labelZh: "DALL·E",
		known: true,
		supportsEdit: true,
		supportsAspectRatio: false,
		qualityTiers: ["auto"]
	},
	grok: {
		label: "grok",
		labelZh: "Grok",
		known: true,
		supportsEdit: true,
		supportsAspectRatio: true,
		qualityTiers: ["1K", "2K"]
	},
	nanobanana: {
		label: "nanobanana",
		labelZh: "Nano Banana",
		known: true,
		supportsEdit: true,
		supportsAspectRatio: true,
		qualityTiers: [
			"1K",
			"2K",
			"4K"
		]
	},
	seedream: {
		label: "seedream",
		labelZh: "Seedream",
		known: true,
		supportsEdit: true,
		supportsAspectRatio: true,
		qualityTiers: ["1K", "2K"]
	},
	zhipu: {
		label: "GLM-Image",
		labelZh: "智谱图像",
		known: true,
		supportsEdit: false,
		supportsAspectRatio: false,
		qualityTiers: ["HD"]
	},
	qwen: {
		label: "qwen-image",
		labelZh: "千问图像",
		known: true,
		supportsEdit: true,
		supportsAspectRatio: true,
		qualityTiers: ["auto"]
	},
	minimax: {
		label: "MiniMax",
		labelZh: "MiniMax 图像",
		known: true,
		supportsEdit: true,
		supportsAspectRatio: true,
		qualityTiers: ["auto"]
	}
};
/** Documented upstream prompt hard limits (UTF-16 code units). The engine
*  fast-fails on these before any network call and the panel counter shows
*  them live; families absent here have no documented limit. */
const PROMPT_CHAR_LIMITS = { minimax: 1500 };
/** The documented prompt character limit for a model id, or null when the
*  family has no known limit. Single source of truth for engine enforcement
*  and the panel's live counter. */
function promptCharLimit(model) {
	const { family } = describeModel(model);
	return (family !== "unknown" ? PROMPT_CHAR_LIMITS[family] : void 0) ?? null;
}
/** Official Gemini image ids served by Nano Banana gateways. */
const NANOBANANA_GEMINI_IDS = /* @__PURE__ */ new Set([
	"gemini-3-pro-image",
	"gemini-3-pro-image-preview",
	"gemini-3.1-flash-image",
	"gemini-3.1-flash-image-preview",
	"gemini-3.1-flash-lite-image",
	"gemini-2.5-flash-image"
]);
/** Classify one upstream model id into its request-shaping family. */
function describeModel(model) {
	const id = model.trim();
	if (/^gpt-image/i.test(id)) return {
		family: "gpt-image",
		...ENTRIES$1["gpt-image"]
	};
	if (/^dall-e/i.test(id)) return {
		family: "dall-e",
		...ENTRIES$1["dall-e"]
	};
	if (/^grok-imagine(?:-|$)/.test(id)) return {
		family: "grok",
		...ENTRIES$1.grok
	};
	if (/^nanobanana/i.test(id) || NANOBANANA_GEMINI_IDS.has(id)) return {
		family: "nanobanana",
		...ENTRIES$1.nanobanana
	};
	if (/^(?:doubao-)?seedream/i.test(id)) return {
		family: "seedream",
		...ENTRIES$1.seedream
	};
	if (/^(?:glm-image|cogview(?:-|$))/i.test(id)) return {
		family: "zhipu",
		...ENTRIES$1.zhipu
	};
	if (/^qwen-image(?:[-_.]|$)/i.test(id)) return {
		family: "qwen",
		...ENTRIES$1.qwen
	};
	if (/^(?:minimax[-_/])?image-\d+/i.test(id)) return {
		family: "minimax",
		...ENTRIES$1.minimax
	};
	return {
		family: "unknown",
		label: "unknown",
		labelZh: "未知协议",
		known: false,
		supportsEdit: true,
		supportsAspectRatio: false,
		qualityTiers: []
	};
}
/** Conservative fallback for providers whose /models response only has ids.
*  Metadata-aware filtering lives in prompt-enhancer.ts; this catches common
*  image model naming conventions without treating every unknown model as an
*  image model.
*
*  The trailing `\d*` lets the keyword boundary accept the numeric suffix that
*  gateways append to a family name without a separator (`nanobanana2`,
*  `wanx2`). Without it this predicate rejects ids that describeModel() already
*  declares known — including the DEFAULT_IMAGE_MODELS entries `nanobanana2`
*  and `nanobanana2-lite` — so "detect models" silently returns a list shorter
*  than the catalog it is meant to expose. */
function isLikelyImageModelId(model) {
	return /(?:^|[-_.])(?:image|img|diffusion|flux|cogview|imagen|seedream|nanobanana|grok-imagine|dall-e|stable-diffusion|sdxl|pixart|kolors|ideogram|midjourney|recraft|hunyuan|jimeng|wanx|hidream|playground)\d*(?:$|[-_.])/i.test(model.trim());
}
/** The family a model id routes its request through. */
function modelFamily(model) {
	return describeModel(model).family;
}
//#endregion
//#region src/prompt-enhancer.ts
/** OpenAI-compatible chat helpers used by the optional prompt-enhancement UI. */
/** Bounded wait for one chat completion. A hung chat endpoint would otherwise
*  leave prompt enhancement (and the canvas light tier) pending forever. */
const CHAT_TIMEOUT_MS = 6e4;
/** Bounded wait per `/models` attempt. Discovery walks a few candidate URLs in
*  turn, so this caps each one instead of the whole walk. */
const MODELS_TIMEOUT_MS = 3e4;
function endpoint(base, suffix) {
	return `${base.replace(/\/+$/, "")}${suffix}`;
}
function headers(apiKey) {
	return {
		"content-type": "application/json",
		...apiKey.trim() === "" ? {} : { authorization: `Bearer ${apiKey.trim()}` }
	};
}
async function responseJson(response) {
	const body = await response.json().catch(() => void 0);
	if (!response.ok || body === void 0 || body === null || typeof body !== "object") {
		const message = body !== null && typeof body === "object" && typeof body.error?.message === "string" ? body.error.message : `HTTP ${response.status}`;
		throw new Error(message);
	}
	return body;
}
/** Candidate /models URLs for a configured base URL, most specific first. */
function modelListUrls(config) {
	const base = config.apiUrl.trim().replace(/\/+$/, "");
	if (base === "") throw new Error("API URL is required");
	const urls = [];
	if (resolveChannelProtocol(base, config.protocol) === "chat-completions" && isChatCompletionsUrl(base)) {
		const url = new URL(base);
		url.pathname = `${url.pathname.replace(/\/chat\/completions\/?$/, "")}/models`;
		url.search = "";
		url.hash = "";
		urls.push(url.toString());
		return urls;
	}
	urls.push(endpoint(base, "/models"));
	try {
		const url = new URL(base);
		const path = url.pathname.replace(/\/+$/, "");
		if (!/\/v\d+(?:[a-z0-9._-]*)?$/i.test(path)) {
			url.pathname = `${path === "" || path === "/" ? "" : path}/v1/models`;
			url.search = "";
			url.hash = "";
			urls.push(url.toString());
		}
	} catch {}
	return [...new Set(urls)];
}
function errorMessageOf(body, fallback) {
	if (body === null || typeof body !== "object") return fallback;
	const record = body;
	const error = record.error;
	if (error !== null && typeof error === "object" && typeof error.message === "string") return error.message;
	return typeof record.message === "string" && record.message.trim() !== "" ? record.message : fallback;
}
function modelRecordsOf(body) {
	const candidate = Array.isArray(body) ? body : body !== null && typeof body === "object" && Array.isArray(body.data) ? body.data : body !== null && typeof body === "object" && Array.isArray(body.models) ? body.models : void 0;
	if (candidate === void 0) return void 0;
	return candidate.flatMap((item) => {
		const id = typeof item === "string" ? item.trim() : item !== null && typeof item === "object" && typeof item.id === "string" ? item.id.trim() : "";
		return id === "" ? [] : [{
			...typeof item === "object" && item !== null ? item : {},
			id
		}];
	});
}
async function fetchModelRecords(url, apiKey) {
	const response = await fetch(url, {
		headers: headers(apiKey),
		signal: AbortSignal.timeout(MODELS_TIMEOUT_MS)
	});
	const text = await response.text().catch(() => "");
	let body;
	try {
		body = text.trim() === "" ? void 0 : JSON.parse(text);
	} catch {
		body = void 0;
	}
	if (!response.ok) {
		const fallback = `HTTP ${response.status}`;
		return {
			error: new Error(errorMessageOf(body, fallback)),
			retryable: response.status === 404 || response.status === 405
		};
	}
	if (body === void 0) {
		const type = response.headers.get("content-type") ?? "unknown content-type";
		const sample = text.replace(/\s+/g, " ").trim().slice(0, 160);
		return {
			error: /* @__PURE__ */ new Error(`模型接口返回了非 JSON 响应（HTTP ${response.status}, ${type}）${sample === "" ? "" : `：${sample}`}`),
			retryable: true
		};
	}
	const records = modelRecordsOf(body);
	if (records === void 0) return {
		error: new Error(errorMessageOf(body, "模型接口响应中没有 data/models 列表")),
		retryable: true
	};
	return {
		records,
		retryable: false
	};
}
async function listModelRecords(config) {
	const urls = modelListUrls(config);
	let lastError;
	for (const url of urls) {
		let attempt;
		try {
			attempt = await fetchModelRecords(url, config.apiKey);
		} catch (error) {
			lastError = error instanceof Error ? error : new Error(String(error));
			continue;
		}
		if (attempt.records !== void 0) return attempt.records;
		lastError = attempt.error;
		if (!attempt.retryable) throw attempt.error;
	}
	throw lastError ?? /* @__PURE__ */ new Error("模型接口不可用");
}
function textOf(value) {
	if (typeof value === "string") return [value];
	if (!Array.isArray(value)) return [];
	return value.filter((item) => typeof item === "string");
}
function hasImageGenerationCapability(record) {
	const capability = record.capabilities;
	if (capability !== null && typeof capability === "object") {
		const values = capability;
		for (const key of [
			"image_generation",
			"imageGeneration",
			"text_to_image",
			"textToImage",
			"image_gen"
		]) if (typeof values[key] === "boolean") return values[key];
		const serialized = JSON.stringify(values).toLowerCase();
		if (/image[ _-]?generation|text[ _-]?to[ _-]?image/.test(serialized)) return true;
	}
	const taskText = [
		...textOf(record.task),
		...textOf(record.task_type),
		...textOf(record.taskType),
		...textOf(record.type),
		...textOf(record.model_type),
		...textOf(record.modelType),
		...textOf(record.tasks),
		...textOf(record.description)
	].join(" ").toLowerCase();
	if (/image[ _-]?generation|text[ _-]?to[ _-]?image|image[ _-]?gen/.test(taskText)) return true;
	if (/^image(?:[ _-]?generation)?$/.test(taskText.trim())) return true;
	if (/embedding|rerank|moderation|transcri|speech|audio|video|chat[ _-]?completion/.test(taskText)) return false;
	for (const key of [
		"output_modalities",
		"outputModalities",
		"supported_output_modalities"
	]) {
		const modalities = textOf(record[key]).map((value) => value.toLowerCase());
		if (modalities.length > 0) return modalities.includes("image");
	}
}
function isImageModelRecord(record) {
	return hasImageGenerationCapability(record) ?? isLikelyImageModelId(record.id);
}
/** List candidates exposed by an OpenAI-compatible endpoint. */
async function listOpenAIModels(config) {
	return [...new Set((await listModelRecords(config)).map((record) => record.id))].sort((a, b) => a.localeCompare(b));
}
/** List only models that advertise or conventionally represent image generation. */
async function listImageModels(config) {
	return [...new Set((await listModelRecords(config)).filter(isImageModelRecord).map((record) => record.id))].sort((a, b) => a.localeCompare(b));
}
/** List chat models exposed by an OpenAI-compatible endpoint. */
async function listPromptModels(config) {
	return listOpenAIModels(config);
}
/** Remove reasoning-model artifacts from a chat model's visible content:
*  complete `<think>…</think>` blocks first, then anything from a dangling
*  unclosed `<think>` to the end of the text. Reasoning models served through
*  OpenAI-compatible endpoints (MiniMax M3, DeepSeek R1, Qwen QVQ, …) inline
*  these blocks in `message.content`; leaking them into the prompt box both
*  pollutes the prompt and can push it past image models' length limits. */
function stripReasoning(text) {
	const withoutClosed = text.replace(/<think>[\s\S]*?<\/think>/gi, "");
	const dangling = /<think>/i.exec(withoutClosed);
	return (dangling === null ? withoutClosed : withoutClosed.slice(0, dangling.index)).trim();
}
/**
* Run one chat completion and return the cleaned visible answer.
*
* Shared by prompt enhancement, the canvas light-tier skill runner and the
* layer analyzer: it owns the endpoint, auth, error shaping (an upstream
* `error.message` is surfaced verbatim) and the reasoning-strip step, so every
* caller sees the same behaviour.
* The wait is bounded, but the caller's own cancellation still wins: the
* timeout signal is combined with `options.signal` rather than replacing it.
* @param config - endpoint, secret and model.
* @param options - prompt parts plus optional sampling controls.
* @returns the model's visible answer, with reasoning artifacts removed.
*/
async function chatComplete(config, options) {
	if (config.apiUrl.trim() === "" || config.model.trim() === "") throw new Error("chat model is not configured (left sidebar > Image settings > Prompt enhancement)");
	const timeoutSignal = AbortSignal.timeout(CHAT_TIMEOUT_MS);
	const signal = options.signal === void 0 ? timeoutSignal : AbortSignal.any([options.signal, timeoutSignal]);
	const body = await responseJson(await fetch(endpoint(config.apiUrl, "/chat/completions"), {
		method: "POST",
		headers: headers(config.apiKey),
		body: JSON.stringify({
			model: config.model.trim(),
			temperature: options.temperature ?? .4,
			...options.maxTokens === void 0 ? {} : { max_tokens: options.maxTokens },
			messages: [{
				role: "system",
				content: options.system
			}, {
				role: "user",
				content: typeof options.content === "string" ? options.content : options.content
			}]
		}),
		signal
	}));
	const choices = Array.isArray(body.choices) ? body.choices : [];
	const content = choices[0] !== null && typeof choices[0] === "object" ? choices[0].message?.content : void 0;
	if (typeof content !== "string" || content.trim() === "") throw new Error("chat model returned an empty answer");
	const answer = stripReasoning(content);
	if (answer === "") throw new Error("chat model returned only reasoning content (empty <think> payload)");
	return answer;
}
/** Expand a concise image request into a production-ready image prompt. */
async function enhancePrompt(config, prompt) {
	return chatComplete(config, {
		temperature: .7,
		system: "You are an expert image-prompt editor. Expand the user request into one vivid, specific image-generation prompt. Preserve intent and language. Add only useful visual detail: subject, composition, lighting, materials, color, camera/style and quality. Return only the finished prompt, with no preface or markdown.",
		content: prompt
	});
}
/** Polish one existing generation prompt without changing its purpose. */
async function polishPrompt(config, prompt) {
	return chatComplete(config, {
		temperature: .35,
		system: "你是电商生图提示词编辑。请在保持图片用途、商品事实、平台、语言和原有结构不变的前提下，润色文字并补充可执行的视觉细节，减少重复和空泛表达。只输出最终提示词，不要解释、标题或 Markdown。",
		content: prompt
	});
}
//#endregion
//#region src/layer-analyzer.ts
/**
* Canvas layer decomposition (the 图层拆分 / magic-layers tool).
*
* The host asks the configured *chat* model — the same OpenAI-compatible
* endpoint the prompt enhancer uses — to read the picture and answer with a
* strict JSON layer plan (background / object / text). The browser half then
* rasterizes that plan into real canvas nodes: text layers become editable text
* nodes, object layers are cropped and locally matted into transparent PNGs,
* and the background layer reuses the source asset.
*
* Nothing here is trusted: the model output is normalized, clamped and
* length-capped before it reaches the client.
*/
/** Cap on the image payload accepted for analysis (base64 data URL). */
const MAX_LAYER_IMAGE_BYTES = 12 * 1024 * 1024;
/** Hard cap on layers, so a chatty model cannot flood the canvas. */
const MAX_LAYERS = 16;
/** Cap on recognized text length per text layer. */
const MAX_LAYER_TEXT = 200;
/** Bounded wait for the vision call. Layer decomposition sends a whole image,
*  so it needs a longer budget than a plain chat completion — but without a
*  ceiling a stalled endpoint leaves the canvas tool spinning forever. */
const LAYER_TIMEOUT_MS = 12e4;
const LAYER_SYSTEM_PROMPT = [
	"你是图像图层拆解引擎。用户会给你一张图片，请把它拆成可独立编辑的图层，并且只输出一个 JSON 对象，不要输出任何解释、markdown 或代码块。",
	"输出格式：",
	"{\"layers\":[{\"kind\":\"background\",\"label\":\"背景\"},{\"kind\":\"object\",\"label\":\"人物\",\"rect\":{\"x\":0.1,\"y\":0.2,\"width\":0.3,\"height\":0.5}},{\"kind\":\"text\",\"label\":\"标题\",\"rect\":{\"x\":0.2,\"y\":0.05,\"width\":0.6,\"height\":0.12},\"text\":\"识别出的文字\",\"color\":\"#ffffff\"}]}",
	"规则：",
	"1. rect 使用相对图片的归一化坐标（0~1，原点在左上角），必须是紧贴该元素的矩形框。",
	"2. kind 只能是 background / object / text。background 层不要 rect，只允许一个，排在最前面。",
	"3. text 层必须尽量识别出准确的文字内容（保持原语言与换行），并给出文字颜色（十六进制，如 #ffffff）。",
	"4. 人物、商品、装饰元素、图标等前景元素各占一个 object 层，最多 10 个，按视觉重要性排序。",
	"5. 不要臆造看不见的元素；识别不到文字就不要输出 text 层。"
].join("\n");
function clamp01(value) {
	if (typeof value !== "number" || !Number.isFinite(value)) return void 0;
	return Math.min(1, Math.max(0, value));
}
/** Normalize one raw rectangle; undefined when it is degenerate. */
function rectOf(value) {
	if (value === null || typeof value !== "object") return void 0;
	const raw = value;
	let x = clamp01(raw.x);
	let y = clamp01(raw.y);
	let width = clamp01(raw.width ?? raw.w);
	let height = clamp01(raw.height ?? raw.h);
	if (x === void 0 || y === void 0 || width === void 0 || height === void 0) {
		const x2 = clamp01(raw.x2 ?? raw.right);
		const y2 = clamp01(raw.y2 ?? raw.bottom);
		if (x === void 0 || y === void 0 || x2 === void 0 || y2 === void 0) return void 0;
		width = Math.max(0, x2 - x);
		height = Math.max(0, y2 - y);
	}
	if (width === 0 || height === 0) return void 0;
	if (x + width > 1) width = 1 - x;
	if (y + height > 1) height = 1 - y;
	if (width < .005 || height < .005) return void 0;
	return {
		x: Number(x.toFixed(4)),
		y: Number(y.toFixed(4)),
		width: Number(width.toFixed(4)),
		height: Number(height.toFixed(4))
	};
}
function colorOf(value) {
	if (typeof value !== "string") return void 0;
	const trimmed = value.trim();
	if (/^#[0-9a-fA-F]{3}$/.test(trimmed) || /^#[0-9a-fA-F]{6}$/.test(trimmed)) return trimmed.toLowerCase();
}
function labelOf(value, fallback) {
	if (typeof value !== "string") return fallback;
	const trimmed = value.trim().replace(/\s+/g, " ");
	return trimmed === "" ? fallback : trimmed.slice(0, 40);
}
const KIND_LABEL = {
	background: "背景",
	object: "元素",
	text: "文字"
};
/** Validate + normalize one raw layer entry. */
function layerOf(value) {
	if (value === null || typeof value !== "object") return void 0;
	const raw = value;
	const kind = raw.kind ?? raw.type;
	if (kind !== "background" && kind !== "object" && kind !== "text") return void 0;
	const label = labelOf(raw.label ?? raw.name, KIND_LABEL[kind]);
	if (kind === "background") return {
		kind,
		label
	};
	const rect = rectOf(raw.rect ?? raw.box ?? raw.bounds);
	if (rect === void 0) return void 0;
	if (kind === "text") {
		const text = typeof raw.text === "string" ? raw.text.trim() : typeof raw.content === "string" ? raw.content.trim() : "";
		if (text === "") return void 0;
		const color = colorOf(raw.color);
		return {
			kind,
			label,
			rect,
			text: text.slice(0, MAX_LAYER_TEXT),
			...color === void 0 ? {} : { color }
		};
	}
	return {
		kind,
		label,
		rect
	};
}
/** Pull the JSON object out of a model answer that may wrap it in prose/fences. */
function jsonPayload(content) {
	const cleaned = stripReasoning(content).replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
	const start = cleaned.indexOf("{");
	const end = cleaned.lastIndexOf("}");
	if (start < 0 || end <= start) return void 0;
	try {
		return JSON.parse(cleaned.slice(start, end + 1));
	} catch {
		return;
	}
}
/** Normalize a raw plan into the wire shape (background first, capped). */
function normalizeLayerPlan(value) {
	if (value === null || typeof value !== "object") return void 0;
	const raw = value;
	const list = Array.isArray(raw.layers) ? raw.layers : Array.isArray(value) ? value : void 0;
	if (list === void 0) return void 0;
	const parsed = list.flatMap((item) => {
		const layer = layerOf(item);
		return layer === void 0 ? [] : [layer];
	});
	if (parsed.length === 0) return void 0;
	const order = {
		background: 0,
		object: 1,
		text: 2
	};
	return { layers: parsed.sort((a, b) => order[a.kind] - order[b.kind]).filter((layer, index, all) => layer.kind !== "background" || all.findIndex((item) => item.kind === "background") === index).slice(0, MAX_LAYERS) };
}
/**
* Decompose one image into a layer plan through the configured chat model.
* The image travels as an OpenAI-style `image_url` data URL, so the model must
* accept vision input; endpoints without it answer with an upstream error that
* is surfaced verbatim.
*/
async function analyzeLayers(config, image) {
	if (config.apiUrl.trim() === "" || config.model.trim() === "") throw new Error("图层拆分需要先在左侧「生图配置」的「提示词增强」中配置一个支持视觉的聊天模型（API 地址 + 模型）");
	const response = await fetch(`${config.apiUrl.replace(/\/+$/, "")}/chat/completions`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			...config.apiKey.trim() === "" ? {} : { authorization: `Bearer ${config.apiKey.trim()}` }
		},
		body: JSON.stringify({
			model: config.model.trim(),
			temperature: .2,
			messages: [{
				role: "system",
				content: LAYER_SYSTEM_PROMPT
			}, {
				role: "user",
				content: [{
					type: "text",
					text: "请拆解这张图片的图层，只输出 JSON。"
				}, {
					type: "image_url",
					image_url: { url: image }
				}]
			}]
		}),
		signal: AbortSignal.timeout(LAYER_TIMEOUT_MS)
	});
	const body = await response.json().catch(() => void 0);
	if (!response.ok) {
		const message = body !== null && typeof body === "object" ? body.error?.message : void 0;
		throw new Error(typeof message === "string" && message !== "" ? message : `HTTP ${response.status}`);
	}
	const choices = body !== null && typeof body === "object" && Array.isArray(body.choices) ? body.choices : [];
	const content = choices[0] !== null && typeof choices[0] === "object" ? choices[0].message?.content : void 0;
	if (typeof content !== "string" || content.trim() === "") throw new Error("聊天模型没有返回图层数据");
	const plan = normalizeLayerPlan(jsonPayload(content));
	if (plan === void 0) throw new Error("聊天模型返回的图层 JSON 无法解析（可能不支持视觉输入）");
	return plan;
}
//#endregion
//#region src/image-models.ts
/**
* Image-model configuration shared by the host, panel, and Agent tools.
* `/models` exposes candidates only: the configured list is the explicit
* allow-list because OpenAI-compatible gateways rarely advertise modalities.
*/
const DEFAULT_IMAGE_MODELS = [
	"gpt-image-2.5",
	"gpt-image-2",
	"grok-imagine-image",
	"nanobanana2",
	"nanobanana2-lite",
	"nanobanana-pro",
	"seedream-5.0-pro",
	"glm-image"
];
/** Normalize user-entered model identifiers and retain a usable legacy default. */
function normalizeImageModels(value) {
	const candidates = Array.isArray(value) ? value : [];
	const unique = /* @__PURE__ */ new Set();
	for (const candidate of candidates) {
		if (typeof candidate !== "string") continue;
		const model = candidate.trim();
		if (model !== "") unique.add(model);
	}
	return unique.size > 0 ? [...unique] : [...DEFAULT_IMAGE_MODELS];
}
//#endregion
//#region src/image-format.ts
function detectImageMime(data) {
	const startsWith = (...bytes) => bytes.every((value, index) => data[index] === value);
	if (startsWith(137, 80, 78, 71, 13, 10, 26, 10)) return "image/png";
	if (startsWith(255, 216, 255)) return "image/jpeg";
	if (startsWith(71, 73, 70, 56, 55, 97) || startsWith(71, 73, 70, 56, 57, 97)) return "image/gif";
	if (startsWith(82, 73, 70, 70) && data[8] === 87 && data[9] === 69 && data[10] === 66 && data[11] === 80) return "image/webp";
}
//#endregion
//#region src/diagnostics-store.ts
/** How many attempts to retain. Bounded so a long session cannot grow. */
const DIAGNOSTIC_MAX = 200;
/** Cap on any recorded excerpt, in characters. */
const DIAGNOSTIC_EXCERPT_MAX = 2e3;
/**
* Mask anything that looks like a credential. The store is meant to be copied
* into a public issue thread, so this runs on every string it keeps: Bearer
* tokens, common key prefixes, query-string secrets and long base64 blobs
* (image payloads would otherwise swamp the buffer).
*/
function redactDiagnosticText(value, limit = DIAGNOSTIC_EXCERPT_MAX) {
	let text = value;
	text = text.replace(/\b(bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 <redacted>");
	text = text.replace(/\b(sk|rk|pk|api|key|token|secret)[-_][A-Za-z0-9._-]{8,}/gi, "<redacted-key>");
	text = text.replace(/([?&](?:api[_-]?key|key|token|access_token|apikey)=)[^&\s"']+/gi, "$1<redacted>");
	text = text.replace(/("(?:api[_-]?key|key|token|secret|authorization)"\s*:\s*")[^"]*(")/gi, "$1<redacted>$2");
	text = text.replace(/data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi, (match) => {
		return `${match.slice(0, match.indexOf(","))},<${match.length} chars of base64 redacted>`;
	});
	text = text.replace(/(?<![A-Za-z0-9+/=])[A-Za-z0-9+/=]{200,}(?![A-Za-z0-9+/=])/g, "<long-base64 redacted>");
	return text.length > limit ? `${text.slice(0, limit)}…[truncated ${text.length - limit} chars]` : text;
}
/** Bounded excerpt of a body value (object → JSON, string → as-is). */
function excerptOf(value, limit = DIAGNOSTIC_EXCERPT_MAX) {
	if (value === void 0 || value === null || value === "") return void 0;
	if (Buffer.isBuffer(value)) return `<${value.byteLength} bytes of binary>`;
	let text;
	if (typeof value === "string") text = value;
	else try {
		text = JSON.stringify(value);
	} catch {
		text = String(value);
	}
	if (text === "") return void 0;
	return redactDiagnosticText(text, limit);
}
/** Byte length of a request body without materialising it twice. */
function bodyByteLength(body) {
	if (body === void 0 || body === null) return void 0;
	if (typeof body === "string") return Buffer.byteLength(body, "utf8");
	if (Buffer.isBuffer(body)) return body.byteLength;
}
/**
* The process-wide diagnostics buffer. One instance per host: generation runs
* in a single queue, so a module-level singleton keeps every entry reachable
* from the routes without threading a dependency through the engine.
*/
var DiagnosticStore = class {
	entries = [];
	sequence = 0;
	/** Record one attempt and return the stored entry. */
	record(input) {
		this.sequence += 1;
		const entry = {
			...input,
			id: `diag-${Date.now().toString(36)}-${this.sequence.toString(36)}`,
			at: Date.now(),
			durationMs: Math.max(0, Math.round(input.durationMs ?? 0)),
			hadAuth: input.hadAuth ?? false,
			...input.bodyExcerpt === void 0 ? {} : { bodyExcerpt: redactDiagnosticText(input.bodyExcerpt) },
			...input.requestExcerpt === void 0 ? {} : { requestExcerpt: redactDiagnosticText(input.requestExcerpt) },
			message: redactDiagnosticText(input.message)
		};
		this.entries.unshift(entry);
		if (this.entries.length > 200) this.entries.length = 200;
		return entry;
	}
	list() {
		return this.entries.map((entry) => ({ ...entry }));
	}
	/** Drop everything; the panel's Clear action. */
	clear() {
		this.entries = [];
	}
};
const store = new DiagnosticStore();
/** Record one upstream attempt. */
function recordDiagnostic(input) {
	return store.record(input);
}
/** Snapshot the retained attempts, newest first. */
function listDiagnostics() {
	return store.list();
}
/** Clear the retained attempts. */
function clearDiagnostics() {
	store.clear();
}
/**
* Pull the most useful diagnostic fields out of a thrown value. Fetch rejects
* with an AggregateError whose `cause`/`errors` carry the real network code,
* so the code has to be dug out rather than read off the top-level error.
*/
function networkErrorFields(error) {
	const codes = [];
	const messages = [];
	const seen = /* @__PURE__ */ new Set();
	const visit = (value, depth) => {
		if (value === null || value === void 0 || depth > 4 || seen.has(value)) return;
		if (typeof value === "object") seen.add(value);
		if (typeof value === "string") {
			if (value !== "") messages.push(value);
			return;
		}
		if (typeof value !== "object") return;
		const record = value;
		for (const key of [
			"code",
			"errno",
			"name"
		]) {
			const field = record[key];
			if (typeof field === "string" && field !== "") codes.push(field);
		}
		if (typeof record.message === "string" && record.message !== "") messages.push(record.message);
		if (Array.isArray(record.errors)) for (const item of record.errors) visit(item, depth + 1);
		visit(record.cause, depth + 1);
	};
	visit(error, 0);
	const preferred = codes.find((code) => /^[A-Z]+_?[A-Z0-9_]*$/.test(code) && code !== "Error");
	const detail = [...new Set(messages)].join(" | ");
	return {
		...preferred === void 0 ? {} : { errorCode: preferred },
		detail: detail === "" ? String(error) : detail
	};
}
/**
* Read a Response body as text without consuming the stream twice.
*
* Returns the RAW text: callers parse it, so it must never be redacted here.
* Redaction is applied only when the text is stored (see `redactDiagnosticText`
* and `DiagnosticStore.record`), which keeps generated image payloads intact.
*/
async function readResponseText(response) {
	try {
		return await response.clone().text();
	} catch {
		return "";
	}
}
/**
* Read a bounded, REDACTED excerpt of a Response body for the diagnostics
* record. Only for recording: never feed the result back into parsing.
*/
async function readResponseExcerpt(response, limit = DIAGNOSTIC_EXCERPT_MAX) {
	const text = await readResponseText(response);
	if (text === "") return void 0;
	return redactDiagnosticText(text, limit);
}
//#endregion
//#region src/engine.ts
/**
* Upstream proxy engine: forwards a generate request to the configured
* OpenAI-compatible image endpoint (/images/generations for text-to-image,
* /images/edits for image-to-image) and normalizes the response to base64
* images so the browser never fetches the upstream itself.
*
* Framework-free (no cordis imports) so the route layer and tests can drive
* it directly.
*/
/** A generation failure with a user-presentable message. */
var ImageGenError = class extends Error {
	/** Stable wire code. */
	code;
	constructor(message, code = "generate-failed") {
		super(message);
		this.name = "ImageGenError";
		this.code = code;
	}
};
/** Total budget for the upstream generation call (image models are slow). */
const UPSTREAM_TIMEOUT_MS = 24e4;
/** Budget for downloading one result image URL. */
const IMAGE_FETCH_TIMEOUT_MS = 6e4;
/** Cap on the reference image payload (edit mode), in bytes. */
const MAX_EDIT_IMAGE_BYTES = 10 * 1024 * 1024;
/** Sizes dall-e-3 accepts; anything else falls back to its square default. */
const DALLE3_SIZES = /* @__PURE__ */ new Set([
	"1024x1024",
	"1792x1024",
	"1024x1792"
]);
/** The wire model id for a request: `upstream` (host-filled alias mapping)
*  wins, then the alias, then the family default. */
function wireModel(request) {
	const upstream = request.upstream?.trim();
	if (upstream !== void 0 && upstream !== "") return upstream;
	const alias = request.model.trim();
	return alias === "" ? "gpt-image-2" : alias;
}
/** Whether the model is an xAI Grok Imagine model (grok-imagine-image,
*  grok-imagine-image-2.0, …). Grok Imagine speaks JSON on both endpoints
*  and exposes its own aspect-ratio / response-format knobs instead of the
*  OpenAI size/quality/detail passthrough. */
function isGrokImagine(model) {
	return modelFamily(model) === "grok";
}
/** Whether the model belongs to the Google Nano Banana family (nanobanana2 /
*  nanobanana2-lite / nanobanana-pro, plus the official Gemini image IDs the
*  gateways expose). OpenAI-compatible gateways serve these with their own
*  aspect_ratio / image_size vocabulary instead of the OpenAI size/quality
*  passthrough. */
function isNanoBanana(model) {
	return modelFamily(model) === "nanobanana";
}
/** Whether the model belongs to the ByteDance Seedream family (seedream-5.0-pro,
*  seedream-5.0, seedream-4.x, doubao-seedream-…). OpenAI-compatible gateways
*  serve Seedream through a unified generate-and-edit architecture:
*  generation AND editing both go to /images/generations and reference images
*  are a JSON URL / data-URL array. */
function isSeedream(model) {
	return modelFamily(model) === "seedream";
}
/** Whether the model uses the official Zhipu image-generation contract. */
function isZhipuImage(model) {
	return modelFamily(model) === "zhipu";
}
/** Whether the model is Alibaba Qwen-Image, which speaks the DashScope native
*  multimodal-generation contract (NOT OpenAI-compatible): a chat-style
*  messages body, `宽*高` pixel sizes, and image URLs in the reply content. */
function isQwenImage(model) {
	return modelFamily(model) === "qwen";
}
/** ModelScope's OpenAI-compatible image inference API always queues tasks. */
function isModelScopeInference(baseUrl) {
	try {
		return new URL(baseUrl).hostname.toLowerCase() === "api-inference.modelscope.cn";
	} catch {
		return false;
	}
}
/** Normalize ModelScope's documented service-origin URL to its OpenAI API root. */
function normalizeModelScopeBaseUrl(baseUrl, apiUrlFull) {
	if (apiUrlFull || !isModelScopeInference(baseUrl)) return baseUrl;
	try {
		const url = new URL(baseUrl);
		if (url.pathname === "" || url.pathname === "/") url.pathname = "/v1";
		return url.toString().replace(/\/$/, "");
	} catch {
		return baseUrl;
	}
}
/** Recover the versioned API base when a channel stores the exact generation URL. */
function modelScopeTaskBaseUrl(baseUrl, apiUrlFull) {
	if (!apiUrlFull) return baseUrl;
	try {
		const url = new URL(baseUrl);
		url.pathname = url.pathname.replace(/\/images\/(?:generations|edits)\/?$/i, "");
		url.search = "";
		url.hash = "";
		return url.toString().replace(/\/$/, "");
	} catch {
		return baseUrl;
	}
}
/** Whether the model is MiniMax image-01, which speaks MiniMax's native
*  `/image_generation` contract (NOT OpenAI-compatible): `aspect_ratio`,
*  `subject_reference` for image-to-image, `data.image_base64[]` results, and
*  errors reported as HTTP 200 + non-zero `base_resp.status_code`. */
function isMiniMaxImage(model) {
	return modelFamily(model) === "minimax";
}
/** Aspect ratios MiniMax image-01 documents (the panel vocabulary is a superset). */
const MINIMAX_RATIOS = /* @__PURE__ */ new Set([
	"1:1",
	"16:9",
	"4:3",
	"3:2",
	"2:3",
	"3:4",
	"9:16",
	"21:9"
]);
/** MiniMax caps one request at 9 images. */
const MINIMAX_MAX_N = 9;
/** MiniMax image-01 rejects prompts of 1500+ characters; the exact number
*  lives in model-catalog.ts so the panel counter and this guard agree. */
function isGlmImage(model) {
	return /^glm-image(?:-|$)/i.test(model.trim());
}
/** Whether this is the official Volcengine Ark model naming convention. */
function isVolcSeedream(model) {
	return /^doubao-seedream(?:-|$)/i.test(model.trim());
}
/** Documented per-model pixel budgets (width × height), keyed by id prefix. */
const ARK_SIZE_BUDGETS = [
	{
		test: /^doubao-seedream-5-(?:0|1)-(?:pro|flash)/i,
		budget: {
			min: 921600,
			max: 4624220
		}
	},
	{
		test: /^doubao-seedream-5-(?:0|1)-lite/i,
		budget: {
			min: 3686400,
			max: 16777216
		}
	},
	{
		test: /^doubao-seedream-4-5/i,
		budget: {
			min: 3686400,
			max: 16777216
		}
	},
	{
		test: /^doubao-seedream-4-0/i,
		budget: {
			min: 921600,
			max: 16777216
		}
	},
	{
		test: /^doubao-seedream-3-0/i,
		budget: {
			min: 262144,
			max: 4194304
		}
	}
];
/** Total pixels the panel's clarity tier aims for before the budget clamps it. */
const ARK_TIER_PIXELS = {
	"1k": 1048576,
	"2k": 4194304,
	"4k": 16777216
};
/** Width/height for a ratio, rounded to even numbers and inside `budget`. */
function arkPixelSize(ratio, quality, budget) {
	const [w, h] = ratio.split(":").map((part) => Number.parseFloat(part));
	const aspect = Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0 ? w / h : 1;
	const target = Math.min(budget.max, Math.max(budget.min, ARK_TIER_PIXELS[quality] ?? ARK_TIER_PIXELS["2k"]));
	const idealHeight = Math.sqrt(target / aspect);
	let best;
	for (let delta = -48; delta <= 48; delta += 2) {
		const height = Math.max(2, Math.round(idealHeight / 2) * 2 + delta);
		const width = Math.max(2, Math.round(height * aspect / 2) * 2);
		const pixels = width * height;
		if (pixels < budget.min || pixels > budget.max) continue;
		const drift = Math.abs(Math.log(width / height / aspect));
		if (best === void 0 || drift < best.drift) best = {
			width,
			height,
			drift
		};
	}
	if (best !== void 0) return `${best.width}x${best.height}`;
	let height = Math.max(2, Math.round(idealHeight / 2) * 2);
	let width = Math.max(2, Math.round(height * aspect / 2) * 2);
	const scale = Math.sqrt(target / (width * height));
	height = Math.max(2, Math.floor(height * scale / 2) * 2);
	width = Math.max(2, Math.floor(width * scale / 2) * 2);
	return `${width}x${height}`;
}
/**
* The `size` an official Ark Seedream model should receive.
*
* `auto` has no ratio to honour, so it falls back to the tier string (the
* documented "let the model choose" form). A known ratio becomes an explicit
* pixel size inside that model's budget; an unrecognised ratio keeps the
* tier mapping so a new id cannot start failing on a bad string.
*
* The tier lists are NOT interchangeable: 5.0 pro/flash ship 1K/1.5K/2K only,
* while lite and 4.5 start at 2K. Sending `1K` to a lite model is a 400, so the
* panel's finest tier is snapped UP to the cheapest tier the model documents.
*/
function arkSeedreamSize(model, quality, ratio) {
	const id = model.trim();
	const budget = ARK_SIZE_BUDGETS.find((row) => row.test.test(id))?.budget;
	const known = ratio !== "" && ratio !== "auto" && /^\d+:\d+$/.test(ratio);
	if (budget !== void 0 && known) return arkPixelSize(ratio, quality, budget);
	if (/^doubao-seedream-5-(?:0|1)-(?:pro|flash)/i.test(id)) return quality === "1k" ? "1K" : "2K";
	if (/^doubao-seedream-(?:5-(?:0|1)-lite|4-5)/i.test(id)) return quality === "4k" ? "4K" : "2K";
	if (/^doubao-seedream-3-0/i.test(id)) return quality === "4k" ? "2048x2048" : "1024x1024";
	return quality === "1k" ? "1K" : quality === "4k" ? "4K" : "2K";
}
/** Kept for the gateway (non-Ark) Seedream path: tier vocabulary only. */
function seedreamSize(quality) {
	if (quality === "1k") return "1K";
	return "2K";
}
/** The panel's aspect ratios mapped to Qwen-Image's `宽*高` pixel sizes.
*  The classic series (qwen-image / -plus / -max) documents this fixed list;
*  2.0 / 3.0-series models accept any size within their pixel budget and
*  recommend the larger set. */
const QWEN_SIZE_CLASSIC = {
	"16:9": "1664*928",
	"21:9": "1664*928",
	"4:3": "1472*1104",
	"3:2": "1472*1104",
	"1:1": "1328*1328",
	"3:4": "1104*1472",
	"2:3": "1104*1472",
	"9:16": "928*1664"
};
const QWEN_SIZE_HD = {
	"16:9": "2688*1536",
	"21:9": "2688*1536",
	"4:3": "2368*1728",
	"3:2": "2368*1728",
	"1:1": "2048*2048",
	"3:4": "1728*2368",
	"2:3": "1728*2368",
	"9:16": "1536*2688"
};
/** Versioned ids (qwen-image-2.0 / -3.0-pro / …) take the large size set. */
function isVersionedQwenImage(model) {
	return /^qwen-image-\d+\.\d/i.test(model.trim());
}
function qwenSize(model, ratio) {
	if (ratio === "" || ratio === "auto") return void 0;
	return (isVersionedQwenImage(model) ? QWEN_SIZE_HD : QWEN_SIZE_CLASSIC)[ratio];
}
/** The panel's aspect ratios mapped to the closest OpenAI pixel size
*  (gpt-image-2 / generic OpenAI-compatible endpoints). */
const OPENAI_SIZE_BY_RATIO = {
	"1:1": "1024x1024",
	"3:4": "1024x1536",
	"4:3": "1536x1024",
	"9:16": "1024x1792",
	"2:3": "1024x1536",
	"3:2": "1536x1024",
	"16:9": "1792x1024",
	"21:9": "1792x1024"
};
/** Panel ratios that need renaming for a model's vocabulary. Grok documents
*  20:9 as its ultra-wide ratio, so the panel's 21:9 label is sent as 20:9. */
const GROK_ASPECT_ALIASES = { "21:9": "20:9" };
/**
* One request-scoped timeout that is cleared as soon as its fetch settles.
* AbortSignal.timeout() cannot be disposed early; using it inside a long-lived
* task queue leaves an otherwise idle Node process holding every timeout.
*/
function requestSignal$1(source, timeoutMs) {
	const controller = new AbortController();
	const abortFromSource = () => {
		controller.abort(source?.reason);
	};
	if (source?.aborted === true) abortFromSource();
	else source?.addEventListener("abort", abortFromSource, { once: true });
	const timeout = setTimeout(() => {
		controller.abort(new DOMException("The operation timed out.", "TimeoutError"));
	}, timeoutMs);
	timeout.unref();
	return {
		signal: controller.signal,
		dispose: () => {
			clearTimeout(timeout);
			source?.removeEventListener("abort", abortFromSource);
		}
	};
}
/** Whether an error was produced by a requestSignal budget timeout. These can
* surface from the fetch call itself or from reading the response body, so the
* budget must stay armed until the body has been consumed. */
function isBudgetTimeout(error) {
	return (error instanceof DOMException || error instanceof Error) && error.name === "TimeoutError";
}
/** Content-type extension hints for URL-fetched images. */ function mimeOfExtension(path) {
	const match = /\.([a-z0-9]+)$/i.exec(path);
	if (match === null) return void 0;
	switch (match[1].toLowerCase()) {
		case "png": return "image/png";
		case "jpg":
		case "jpeg": return "image/jpeg";
		case "webp": return "image/webp";
		case "gif": return "image/gif";
		default: return;
	}
}
/** Parse `data:<mime>;base64,<payload>` into its parts; undefined when malformed. */
function parseDataUrl(dataUrl) {
	const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataUrl.trim());
	if (match === null || match[3] === void 0) return void 0;
	if (match[2] === void 0) return;
	return {
		mime: match[1] ?? "application/octet-stream",
		base64: match[3]
	};
}
/** Strip a data: prefix from an upstream b64 payload if a gateway added one. */
function bareBase64(value) {
	const parsed = parseDataUrl(value);
	return parsed !== void 0 && parsed.base64 !== void 0 ? parsed.base64 : value;
}
/** Whether a result URL carries cloud-storage signing credentials. */
function isPresignedUrl(value) {
	let url;
	try {
		url = new URL(value);
	} catch {
		return false;
	}
	const params = new Set(Array.from(url.searchParams.keys(), (key) => key.toLowerCase()));
	if (params.has("x-goog-signature") || params.has("x-goog-credential")) return true;
	if (params.has("x-amz-signature") || params.has("x-amz-credential")) return true;
	return params.has("signature") && (params.has("expires") || params.has("googleaccessid") || params.has("awsaccesskeyid"));
}
/** Resolve the request URL for a channel: base URL + path, or the exact URL. */
function endpointUrl$1(upstream, baseUrl, path) {
	return upstream.apiUrlFull === true ? baseUrl : `${baseUrl}${path}`;
}
/**
* Whether a result URL lives on the same origin as the configured API base.
* The upstream Bearer key is only ever forwarded to this origin: a provider
* (or a compromised relay) that hands back an image URL on a foreign host
* must not be able to harvest the key through that download.
*/
function isSameOriginAsApi$1(value, apiUrl) {
	try {
		return new URL(value).origin === new URL(apiUrl).origin;
	} catch {
		return false;
	}
}
/** Clamp the requested image count into the API-accepted range. */
function clampCount(n) {
	if (!Number.isFinite(n)) return 1;
	return Math.min(4, Math.max(1, Math.round(n)));
}
/** Pick the effective per-model request parameters. Never includes `n`: the
*  batch parameter is rejected by Responses-API-based gateways (tools[0].n),
*  so the count is satisfied by parallel single-image requests instead. */
function effectiveParams(request) {
	const model = wireModel(request);
	if (model === "dall-e-3") {
		const pixel = OPENAI_SIZE_BY_RATIO[request.size];
		return {
			model,
			size: pixel !== void 0 && DALLE3_SIZES.has(pixel) ? pixel : "1024x1024"
		};
	}
	if (isGrokImagine(model)) return {
		model,
		...request.size !== "" && request.size !== "auto" ? { aspect_ratio: GROK_ASPECT_ALIASES[request.size] ?? request.size } : {},
		...request.quality !== "" && request.quality !== "auto" ? { resolution: request.quality === "4k" ? "2k" : request.quality } : {},
		response_format: "b64_json"
	};
	if (isNanoBanana(model)) return {
		model,
		...request.size !== "" && request.size !== "auto" ? { aspect_ratio: request.size } : {},
		...request.quality !== "" && request.quality !== "auto" ? { image_size: request.quality.toUpperCase() } : {},
		response_format: "b64_json"
	};
	if (isSeedream(model)) {
		const ark = isVolcSeedream(model);
		return {
			model,
			size: ark ? arkSeedreamSize(model, request.quality, request.size) : seedreamSize(request.quality),
			response_format: ark ? "url" : "b64_json",
			...ark ? { watermark: false } : {}
		};
	}
	if (isZhipuImage(model)) return {
		model,
		...request.size !== "" && request.size !== "auto" && OPENAI_SIZE_BY_RATIO[request.size] !== void 0 ? { size: OPENAI_SIZE_BY_RATIO[request.size] } : {},
		quality: isGlmImage(model) ? "hd" : "standard"
	};
	return {
		model,
		...request.size !== "" && request.size !== "auto" && OPENAI_SIZE_BY_RATIO[request.size] !== void 0 ? { size: OPENAI_SIZE_BY_RATIO[request.size] } : {},
		...request.quality === "1k" ? { quality: "low" } : {},
		...request.quality === "2k" ? { quality: "medium" } : {},
		...request.quality === "4k" ? { quality: "high" } : {},
		...request.detail !== "" ? { detail: request.detail } : {}
	};
}
/** How many single-image requests to issue for the requested image count. */
function effectiveCount(request) {
	if (wireModel(request) === "dall-e-3") return 1;
	return clampCount(request.n);
}
/** Normalize one upstream data item into a base64 image. */
async function normalizeItem(item, upstream, signal) {
	const revisedPrompt = typeof item.revised_prompt === "string" ? item.revised_prompt : void 0;
	if (typeof item.b64_json === "string" && item.b64_json.trim() !== "") {
		const b64 = bareBase64(item.b64_json);
		if (b64.trim() !== "") return {
			b64,
			mime: detectImageMime(Buffer.from(b64, "base64")) ?? "image/png",
			revisedPrompt
		};
	}
	if (typeof item.url !== "string" || item.url === "") throw new ImageGenError("upstream image item has neither b64_json nor url");
	const url = item.url;
	if (url.startsWith("data:")) {
		const parsed = parseDataUrl(url);
		if (parsed === void 0) throw new ImageGenError("upstream returned a malformed data: url");
		return {
			b64: parsed.base64,
			mime: detectImageMime(Buffer.from(parsed.base64, "base64")) ?? parsed.mime,
			revisedPrompt
		};
	}
	const budget = requestSignal$1(signal, IMAGE_FETCH_TIMEOUT_MS);
	const resultContext = {
		phase: "fetch-result",
		channel: upstream.channelName?.trim() || "默认渠道",
		model: "",
		mode: "result",
		url: displayUrl$1(url),
		method: "GET",
		hadAuth: upstream.apiKey !== "" && !isPresignedUrl(url) && isSameOriginAsApi$1(url, upstream.apiUrl),
		startedAt: Date.now()
	};
	try {
		let response;
		try {
			const forwardKey = upstream.apiKey !== "" && !isPresignedUrl(url) && isSameOriginAsApi$1(url, upstream.apiUrl);
			response = await fetch(url, {
				...forwardKey ? { headers: { authorization: `Bearer ${upstream.apiKey}` } } : {},
				signal: budget.signal
			});
		} catch (error) {
			const failure = new ImageGenError(`failed to fetch the generated image url: ${error instanceof Error ? error.message : String(error)}`);
			recordFailure(resultContext, failure);
			throw failure;
		}
		if (!response.ok) {
			const failure = new ImageGenError(`failed to fetch the generated image url: HTTP ${response.status}`);
			recordFailure(resultContext, failure, {
				status: response.status,
				bodyExcerpt: await readResponseExcerpt(response)
			});
			throw failure;
		}
		const buffer = Buffer.from(await response.arrayBuffer());
		const contentType = response.headers.get("content-type");
		const mime = detectImageMime(buffer) ?? (contentType !== null && contentType !== "" ? contentType.split(";")[0].trim() : mimeOfExtension(url) ?? "image/png");
		return {
			b64: buffer.toString("base64"),
			mime,
			revisedPrompt
		};
	} finally {
		budget.dispose();
	}
}
/** Expand a provider image item whose URL may be a string or an array. */
function imageItemsOf(value) {
	if (typeof value === "string" && value.trim() !== "") return [{ url: value.trim() }];
	if (value === null || typeof value !== "object") return [];
	const item = value;
	if (Array.isArray(item.url)) return item.url.filter((url) => typeof url === "string" && url !== "").map((url) => ({
		...item,
		url
	}));
	return [item];
}
/** Return the data records from the response shapes shared by sync gateways. */
function dataRecordsOf(payload) {
	const data = Array.isArray(payload.data) ? payload.data : payload.data !== null && typeof payload.data === "object" ? [payload.data] : Array.isArray(payload.images) ? payload.images : Array.isArray(payload.output) ? payload.output : void 0;
	if (data === void 0) return void 0;
	return data.filter((entry) => entry !== null && typeof entry === "object");
}
/** Remove reasoning-model wrappers before treating chat content as a user-visible error. */
function stripChatReasoning(value) {
	const withoutClosed = value.replace(/<think>[\s\S]*?<\/think>/gi, "");
	const dangling = /<think>/i.exec(withoutClosed);
	return (dangling === null ? withoutClosed : withoutClosed.slice(0, dangling.index)).trim();
}
/** Whether a URL returned in chat content is plausibly an image resource. */
function isLikelyImageUrl(value) {
	if (/^data:image\/[a-z0-9.+-]+;base64,/i.test(value)) return true;
	try {
		const url = new URL(value);
		if (mimeOfExtension(url.pathname) !== void 0) return true;
		const signal = `${url.hostname}${url.pathname}${url.search}`.toLowerCase();
		return /(?:image|img|photo|picture|cdn|blob|cloudinary|googleusercontent|oaidalle|replicate|fal\.media|files\.oai)/.test(signal);
	} catch {
		return false;
	}
}
/** Parse a complete or fenced JSON value embedded in chat text. */
function parseEmbeddedJson(value) {
	const cleaned = stripChatReasoning(value).replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
	if (cleaned === "") return void 0;
	const attempts = [cleaned];
	const objectStart = cleaned.indexOf("{");
	const objectEnd = cleaned.lastIndexOf("}");
	const arrayStart = cleaned.indexOf("[");
	const arrayEnd = cleaned.lastIndexOf("]");
	if (objectStart >= 0 && objectEnd > objectStart) attempts.push(cleaned.slice(objectStart, objectEnd + 1));
	if (arrayStart >= 0 && arrayEnd > arrayStart) attempts.push(cleaned.slice(arrayStart, arrayEnd + 1));
	for (const attempt of attempts) try {
		const parsed = JSON.parse(attempt);
		if (parsed !== null && typeof parsed === "object") return parsed;
	} catch {}
}
/** Collect image references from structured Chat Completions content. */
function collectChatImageItems(value, out, seen, depth = 0) {
	if (depth > 6 || value === null || value === void 0) return;
	if (typeof value === "string") {
		const parsed = parseEmbeddedJson(value);
		if (parsed !== void 0 && parsed !== value) collectChatImageItems(parsed, out, seen, depth + 1);
		for (const match of value.matchAll(/!\[[^\]]*\]\((?:<)?(https?:\/\/[^)\s>]+|data:image\/[^)\s>]+)(?:>)?\)/gi)) if (match[1] !== void 0) out.push({ url: match[1] });
		for (const match of value.matchAll(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi)) if (match[1] !== void 0) out.push({ url: match[1] });
		const urls = value.match(/(?:https?:\/\/|data:image\/)[^\s"'<>)\]}]+/gi) ?? [];
		for (const raw of urls) {
			const url = raw.replace(/[.,;:!?]+$/, "");
			if (isLikelyImageUrl(url)) out.push({ url });
		}
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) collectChatImageItems(item, out, seen, depth + 1);
		return;
	}
	if (typeof value !== "object") return;
	const record = value;
	if (seen.has(record)) return;
	seen.add(record);
	if (typeof record.b64_json === "string" && record.b64_json.trim() !== "") out.push({ b64_json: record.b64_json });
	for (const key of [
		"url",
		"image_url",
		"image",
		"output_url"
	]) {
		const item = record[key];
		if (typeof item === "string" && item !== "") {
			if (key !== "url" || isLikelyImageUrl(item)) out.push({ url: item });
		} else if (item !== null && typeof item === "object") {
			const nested = item;
			if (key !== "url" && typeof nested.url === "string" && nested.url !== "") out.push({ url: nested.url });
			else collectChatImageItems(item, out, seen, depth + 1);
		}
	}
	for (const key of [
		"images",
		"content",
		"message",
		"data",
		"output",
		"result"
	]) if (key in record) collectChatImageItems(record[key], out, seen, depth + 1);
}
/** Extract every image candidate from one Chat Completions response. */
function chatImageItemsOf(payload) {
	const out = [];
	const seenValues = /* @__PURE__ */ new Set();
	const data = dataRecordsOf(payload);
	if (data !== void 0) for (const record of data) collectChatImageItems(record, out, seenValues);
	const choices = Array.isArray(payload.choices) ? payload.choices : [];
	for (const choice of choices) {
		if (choice === null || typeof choice !== "object") continue;
		const message = choice.message;
		collectChatImageItems(message, out, seenValues);
		const delta = choice.delta;
		collectChatImageItems(delta, out, seenValues);
	}
	if (out.length === 0) collectChatImageItems(payload.images, out, seenValues);
	const unique = /* @__PURE__ */ new Map();
	for (const item of out) {
		const url = typeof item.url === "string" ? item.url.trim() : "";
		const b64 = typeof item.b64_json === "string" ? item.b64_json.trim() : "";
		const key = url !== "" ? `url:${url}` : b64 !== "" ? `b64:${b64.slice(0, 128)}` : "";
		if (key !== "" && !unique.has(key)) unique.set(key, item);
	}
	return [...unique.values()];
}
/** User-visible text from a Chat response, used only when no image was found. */
function chatErrorTextOf(payload) {
	const first = (Array.isArray(payload.choices) ? payload.choices : [])[0];
	const content = first !== null && typeof first === "object" ? first.message?.content : void 0;
	const pieces = [];
	if (typeof content === "string") pieces.push(stripChatReasoning(content));
	else if (Array.isArray(content)) {
		for (const part of content) if (typeof part === "string") pieces.push(stripChatReasoning(part));
		else if (part !== null && typeof part === "object" && typeof part.text === "string") pieces.push(stripChatReasoning(part.text));
	}
	if (pieces.join("\n").trim() !== "") return pieces.join("\n").trim();
	if (typeof payload.message === "string" && payload.message.trim() !== "") return payload.message.trim();
	const error = payload.error;
	if (error !== null && typeof error === "object" && typeof error.message === "string") return error.message.trim();
}
const ASYNC_PENDING_STATUSES = /* @__PURE__ */ new Set([
	"submitted",
	"pending",
	"processing",
	"running",
	"in_progress",
	"queued"
]);
const ASYNC_COMPLETED_STATUSES = /* @__PURE__ */ new Set([
	"completed",
	"succeeded",
	"succeed",
	"success",
	"done"
]);
const ASYNC_FAILED_STATUSES = /* @__PURE__ */ new Set([
	"failed",
	"failure",
	"cancelled",
	"canceled",
	"error"
]);
const ASYNC_POLL_MAX_MS = 24e4;
const ASYNC_POLL_REQUEST_TIMEOUT_MS = 3e4;
/** Read a provider error message from the common nested locations. */
function asyncErrorMessage(payload, fallback) {
	if (payload !== null && typeof payload === "object") {
		const record = payload;
		const candidates = [record.message, record.error];
		const data = record.data;
		const entries = Array.isArray(data) ? data : [data];
		for (const entry of entries) {
			if (entry === null || typeof entry !== "object") continue;
			const item = entry;
			candidates.push(item.message, item.error);
			const nested = item.error;
			if (nested !== null && typeof nested === "object") candidates.push(nested.message);
		}
		for (const candidate of candidates) {
			if (typeof candidate === "string" && candidate.trim() !== "") return candidate;
			if (candidate !== null && typeof candidate === "object") {
				const message = candidate.message;
				if (typeof message === "string" && message.trim() !== "") return message;
			}
		}
	}
	return fallback;
}
/** Wait between async-provider polls, but wake immediately when cancelled. */
function waitForPoll$1(ms, signal) {
	return new Promise((resolve, reject) => {
		if (signal?.aborted === true) {
			reject(signal.reason ?? new DOMException("The operation was aborted.", "AbortError"));
			return;
		}
		const onAbort = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			reject(signal?.reason ?? new DOMException("The operation was aborted.", "AbortError"));
		};
		const done = () => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		};
		const timer = setTimeout(done, ms);
		timer.unref();
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}
/**
* Poll an asynchronous provider task until it yields image records (including ModelScope response fields).
* The total deadline is shared by every poll and the final image downloads;
* local task cancellation propagates through every request and sleep.
*/
async function pollAsyncTask(baseUrl, upstream, taskId, signal, modelScope = false) {
	const deadline = Date.now() + ASYNC_POLL_MAX_MS;
	let delay = 1e3;
	const pollUrl = `${baseUrl}/tasks/${encodeURIComponent(taskId)}`;
	while (Date.now() < deadline) {
		const remaining = deadline - Date.now();
		const budget = requestSignal$1(signal, Math.min(ASYNC_POLL_REQUEST_TIMEOUT_MS, remaining));
		const context = {
			phase: "poll-task",
			channel: upstream.channelName?.trim() || "默认渠道",
			model: "",
			mode: "poll",
			url: displayUrl$1(pollUrl),
			method: "GET",
			hadAuth: upstream.apiKey.trim() !== "",
			startedAt: Date.now()
		};
		try {
			let response;
			try {
				response = await fetch(pollUrl, {
					method: "GET",
					headers: {
						authorization: `Bearer ${upstream.apiKey.trim()}`,
						...modelScope ? { "X-ModelScope-Task-Type": "image_generation" } : {}
					},
					signal: budget.signal
				});
			} catch (error) {
				const failure = signal?.aborted === true ? new ImageGenError("任务已取消", "cancelled") : isBudgetTimeout(error) ? new ImageGenError("上游异步任务轮询超时", "upstream-timeout") : new ImageGenError(`无法轮询上游异步任务：${error instanceof Error ? error.message : String(error)}`, "upstream-unreachable");
				recordFailure(context, failure);
				throw failure;
			}
			const responseText = await readResponseText(response);
			let payload;
			try {
				payload = JSON.parse(responseText);
			} catch (error) {
				const failure = isBudgetTimeout(error) ? new ImageGenError("上游异步任务轮询超时", "upstream-timeout") : new ImageGenError(`上游任务接口返回了非 JSON 响应（HTTP ${response.status}）`, "upstream-invalid");
				recordFailure(context, failure, {
					status: response.status,
					bodyExcerpt: responseText
				});
				throw failure;
			}
			if (!response.ok || payload === null || typeof payload !== "object") {
				const failure = new ImageGenError(asyncErrorMessage(payload, `上游任务轮询失败（HTTP ${response.status}）`), "upstream-rejected");
				recordFailure(context, failure, {
					status: response.status,
					bodyExcerpt: responseText
				});
				throw failure;
			}
			const record = payload;
			const data = record.data;
			const statusRecord = Array.isArray(data) ? data[0] : data !== null && typeof data === "object" ? data : record;
			const statusValue = statusRecord !== null && typeof statusRecord === "object" ? statusRecord.task_status ?? statusRecord.status : void 0;
			const status = typeof statusValue === "string" ? statusValue.toLowerCase() : "";
			if (ASYNC_FAILED_STATUSES.has(status)) throw new ImageGenError(asyncErrorMessage(payload, `上游异步任务失败（${status || "unknown"}）`), "upstream-rejected");
			const nested = statusRecord !== null && typeof statusRecord === "object" ? statusRecord : record;
			const result = nested.result ?? (nested.output !== null && typeof nested.output === "object" ? nested.output.result : void 0) ?? record.result;
			const resultRecord = result !== null && typeof result === "object" ? result : void 0;
			const images = resultRecord?.images ?? resultRecord?.output_images ?? nested.images ?? nested.output_images ?? record.images ?? record.output_images;
			if (ASYNC_COMPLETED_STATUSES.has(status) || images !== void 0) {
				const items = Array.isArray(images) ? images.flatMap(imageItemsOf) : imageItemsOf(images);
				if (items.length > 0) return items;
				if (ASYNC_COMPLETED_STATUSES.has(status)) throw new ImageGenError("上游异步任务完成但没有图片结果", "upstream-empty");
			}
			if (status !== "" && !ASYNC_PENDING_STATUSES.has(status) && !ASYNC_COMPLETED_STATUSES.has(status)) throw new ImageGenError(`上游返回了未知异步任务状态：${status}`, "upstream-invalid");
		} finally {
			budget.dispose();
		}
		await waitForPoll$1(Math.min(delay, Math.max(1, deadline - Date.now())), signal);
		delay = Math.min(5e3, delay * 2);
	}
	throw new ImageGenError("上游异步任务轮询超时（240 秒）", "upstream-timeout");
}
/**
* Issue one single-image request (never sends `n`). The response is kept as a
* list so a gateway that happens to return several images per call still works.
*/
async function requestOneImage(baseUrl, upstream, request, params, signal) {
	const modelScope = isModelScopeInference(baseUrl);
	const headers = {
		authorization: `Bearer ${upstream.apiKey.trim()}`,
		...modelScope ? { "X-ModelScope-Async-Mode": "true" } : {}
	};
	let body;
	if (request.mode === "edit") {
		if (typeof request.image !== "string" || request.image === "") throw new ImageGenError("图生图需要上传参考图片", "edit-image-missing");
		const decodeReference = (dataUrl) => {
			const parsed = parseDataUrl(dataUrl);
			if (parsed === void 0) throw new ImageGenError("参考图片格式无效", "edit-image-invalid");
			let bytes;
			try {
				bytes = Buffer.from(parsed.base64, "base64");
			} catch {
				throw new ImageGenError("参考图片数据无法解码", "edit-image-invalid");
			}
			if (bytes.byteLength > MAX_EDIT_IMAGE_BYTES) throw new ImageGenError("参考图片超过 10MB 上限", "edit-image-too-large");
			return {
				bytes,
				mime: parsed.mime,
				filename: `reference.${extensionOf$6(parsed.mime)}`
			};
		};
		const primary = decodeReference(request.image);
		const extras = (request.images ?? []).filter((img) => typeof img === "string" && img !== "").slice(0, 4).map(decodeReference);
		if (isGrokImagine(params.model)) {
			headers["content-type"] = "application/json";
			body = JSON.stringify({
				model: params.model,
				prompt: request.prompt,
				image: {
					url: request.image,
					type: "image_url"
				},
				...params.aspect_ratio !== void 0 ? { aspect_ratio: params.aspect_ratio } : {},
				response_format: "b64_json"
			});
		} else if (isNanoBanana(params.model)) {
			const form = new FormData();
			form.append("image", new Blob([primary.bytes], { type: primary.mime }), primary.filename);
			form.append("prompt", request.prompt);
			form.append("model", params.model);
			if (params.aspect_ratio !== void 0) form.append("aspect_ratio", params.aspect_ratio);
			if (params.image_size !== void 0) form.append("image_size", params.image_size);
			body = form;
		} else if (isSeedream(params.model)) {
			headers["content-type"] = "application/json";
			body = JSON.stringify({
				model: params.model,
				prompt: request.prompt,
				image: [request.image, ...(request.images ?? []).filter((img) => typeof img === "string" && img !== "").slice(0, 4)],
				...params.size !== void 0 ? { size: params.size } : {},
				...params.resolution !== void 0 ? { resolution: params.resolution } : {},
				response_format: isVolcSeedream(params.model) ? "url" : "b64_json",
				...isVolcSeedream(params.model) ? { watermark: false } : {}
			});
		} else {
			const form = new FormData();
			if (extras.length > 0) for (const [index, reference] of [primary, ...extras].entries()) form.append("image[]", new Blob([reference.bytes], { type: reference.mime }), `reference-${index}.${extensionOf$6(reference.mime)}`);
			else form.append("image", new Blob([primary.bytes], { type: primary.mime }), primary.filename);
			form.append("prompt", request.prompt);
			form.append("model", params.model);
			if (params.size !== void 0) form.append("size", params.size);
			if (params.quality !== void 0) form.append("quality", params.quality);
			if (params.detail !== void 0) form.append("detail", params.detail);
			body = form;
		}
	} else {
		headers["content-type"] = "application/json";
		body = JSON.stringify({
			prompt: request.prompt,
			...params
		});
	}
	const budget = requestSignal$1(signal, UPSTREAM_TIMEOUT_MS);
	try {
		let response;
		const requestUrl = endpointUrl$1(upstream, baseUrl, request.mode === "edit" && !isSeedream(params.model) ? "/images/edits" : "/images/generations");
		const context = attemptContext(upstream, request, "generate", requestUrl, "POST", body, Date.now());
		try {
			response = await fetch(requestUrl, {
				method: "POST",
				headers,
				body,
				signal: budget.signal
			});
		} catch (error) {
			const network = networkErrorFields(error);
			const failure = isBudgetTimeout(error) ? new ImageGenError("上游接口响应超时（240 秒）", "upstream-timeout") : signal?.aborted === true ? new ImageGenError("任务已取消", "cancelled") : new ImageGenError(`无法连接上游接口：${network.detail}${network.errorCode === void 0 ? "" : ` [${network.errorCode}]`} · 请求地址 ${displayUrl$1(requestUrl)}`, "upstream-unreachable");
			recordFailure(context, failure);
			throw failure;
		}
		let payload;
		const responseText = await readResponseText(response);
		try {
			payload = JSON.parse(responseText);
		} catch (error) {
			const failure = isBudgetTimeout(error) ? new ImageGenError("上游接口响应超时（240 秒）", "upstream-timeout") : signal?.aborted === true ? new ImageGenError("任务已取消", "cancelled") : new ImageGenError(`上游接口返回了非 JSON 响应（HTTP ${response.status}）`, "upstream-invalid");
			recordFailure(context, failure, {
				status: response.status,
				bodyExcerpt: responseText
			});
			throw failure;
		}
		if (!response.ok || payload === null || typeof payload !== "object") {
			const failure = new ImageGenError(`${upstreamMessage(payload, response.status)}（HTTP ${response.status} · ${displayUrl$1(requestUrl)}）`, "upstream-rejected");
			recordFailure(context, failure, {
				status: response.status,
				bodyExcerpt: responseText,
				responseBytes: Buffer.byteLength(responseText, "utf8")
			});
			throw failure;
		}
		const record = payload;
		const modelScopeTaskId = modelScope && typeof record.task_id === "string" ? record.task_id.trim() : "";
		if (modelScopeTaskId !== "") {
			const taskItems = await pollAsyncTask(modelScopeTaskBaseUrl(baseUrl, upstream.apiUrlFull === true), upstream, modelScopeTaskId, signal, true);
			if (taskItems.length === 0) throw new ImageGenError("魔搭异步任务已完成，但没有图片结果", "upstream-empty");
			return Promise.all(taskItems.flatMap(imageItemsOf).map((item) => normalizeItem(item, upstream, signal)));
		}
		const data = dataRecordsOf(record);
		if (data === void 0) throw new ImageGenError("上游响应缺少 data 数组", "upstream-invalid");
		if (data.length === 0) throw new ImageGenError("上游返回了 0 张图片", "upstream-empty");
		const asyncEntries = data.filter((entry) => typeof entry.task_id === "string" && entry.task_id.trim() !== "");
		if (asyncEntries.length > 0) {
			const asyncRecords = (await Promise.all(asyncEntries.map((entry) => pollAsyncTask(baseUrl, upstream, entry.task_id, signal)))).flat();
			if (asyncRecords.length === 0) throw new ImageGenError("上游异步任务完成但没有图片结果", "upstream-empty");
			return Promise.all(asyncRecords.flatMap(imageItemsOf).map((item) => normalizeItem(item, upstream, signal)));
		}
		return Promise.all(data.flatMap(imageItemsOf).map((item) => normalizeItem(item, upstream, signal)));
	} finally {
		budget.dispose();
	}
}
/**
* Qwen-Image (DashScope native multimodal-generation): one chat-style request
* carries the prompt (plus the reference image for edit mode) and answers
* synchronously with image URLs in the reply content. The versioned series
* batches natively (n ≤ 6; the panel caps at 4), the classic series is
* single-image per call.
*/
async function generateQwenImage(baseUrl, upstream, request, options) {
	const model = wireModel(request);
	const content = [];
	if (request.mode === "edit") {
		if (typeof request.image !== "string" || request.image === "") throw new ImageGenError("图生图需要上传参考图片", "edit-image-missing");
		const parsed = parseDataUrl(request.image);
		if (parsed === void 0) throw new ImageGenError("参考图片格式无效", "edit-image-invalid");
		if (Buffer.from(parsed.base64, "base64").byteLength > MAX_EDIT_IMAGE_BYTES) throw new ImageGenError("参考图片超过 10MB 上限", "edit-image-too-large");
		content.push({ image: request.image });
	}
	content.push({ text: request.prompt });
	const count = isVersionedQwenImage(model) ? clampCount(request.n) : 1;
	const size = qwenSize(model, request.size);
	const body = {
		model,
		input: { messages: [{
			role: "user",
			content
		}] },
		parameters: {
			...size !== void 0 ? { size } : {},
			...count > 1 ? { n: count } : {}
		}
	};
	const budget = requestSignal$1(options.signal, UPSTREAM_TIMEOUT_MS);
	try {
		let response;
		const requestUrl = `${baseUrl}/services/aigc/multimodal-generation/generation`;
		const context = attemptContext(upstream, request, "generate", requestUrl, "POST", JSON.stringify(body), Date.now());
		try {
			response = await fetch(requestUrl, {
				method: "POST",
				headers: {
					authorization: `Bearer ${upstream.apiKey.trim()}`,
					"content-type": "application/json"
				},
				body: JSON.stringify(body),
				signal: budget.signal
			});
		} catch (error) {
			const network = networkErrorFields(error);
			const failure = isBudgetTimeout(error) ? new ImageGenError("上游接口响应超时（240 秒）", "upstream-timeout") : options.signal?.aborted === true ? new ImageGenError("任务已取消", "cancelled") : new ImageGenError(`无法连接上游接口：${network.detail}${network.errorCode === void 0 ? "" : ` [${network.errorCode}]`} · 请求地址 ${displayUrl$1(requestUrl)}`, "upstream-unreachable");
			recordFailure(context, failure);
			throw failure;
		}
		let payload;
		const responseText = await readResponseText(response);
		try {
			payload = JSON.parse(responseText);
		} catch (error) {
			const failure = isBudgetTimeout(error) ? new ImageGenError("上游接口响应超时（240 秒）", "upstream-timeout") : options.signal?.aborted === true ? new ImageGenError("任务已取消", "cancelled") : new ImageGenError(`上游接口返回了非 JSON 响应（HTTP ${response.status}）`, "upstream-invalid");
			recordFailure(context, failure, {
				status: response.status,
				bodyExcerpt: responseText
			});
			throw failure;
		}
		if (!response.ok || payload === null || typeof payload !== "object") {
			const failure = new ImageGenError(`${upstreamMessage(payload, response.status)}（HTTP ${response.status} · ${displayUrl$1(requestUrl)}）`, "upstream-rejected");
			recordFailure(context, failure, {
				status: response.status,
				bodyExcerpt: responseText
			});
			throw failure;
		}
		const output = payload.output;
		const choices = output !== void 0 && Array.isArray(output.choices) ? output.choices : [];
		const urls = [];
		for (const choice of choices) {
			const message = choice !== null && typeof choice === "object" ? choice.message : void 0;
			const items = message !== null && typeof message === "object" && Array.isArray(message.content) ? message.content : [];
			for (const item of items) if (item !== null && typeof item === "object") {
				const image = item.image;
				if (typeof image === "string" && image !== "") urls.push(image);
			}
		}
		if (urls.length === 0) throw new ImageGenError("上游响应缺少图片内容", "upstream-empty");
		return { images: await Promise.all(urls.map(async (url) => {
			const normalized = await normalizeItem({ url }, upstream);
			return {
				b64: normalized.b64,
				mime: normalized.mime
			};
		})) };
	} finally {
		budget.dispose();
	}
}
/**
* MiniMax image-01 (native `/image_generation`): one JSON request that batches
* up to 9 images and returns them inline as base64. Image-to-image rides the
* `subject_reference` array (a character reference, data URL accepted). The
* endpoint answers HTTP 200 even on failure, so `base_resp.status_code` is the
* real verdict.
*/
async function generateMiniMaxImage(baseUrl, upstream, request, options) {
	const model = wireModel(request);
	const promptLimit = promptCharLimit(model);
	if (promptLimit !== null && request.prompt.length >= promptLimit) throw new ImageGenError(`MiniMax image-01 要求提示词少于 ${promptLimit} 字符（当前 ${request.prompt.length}），请精简后重试`, "prompt-too-long");
	const body = {
		model,
		prompt: request.prompt,
		response_format: "base64"
	};
	const ratio = request.size.trim();
	if (ratio !== "" && ratio !== "auto") {
		if (!MINIMAX_RATIOS.has(ratio)) throw new ImageGenError(`MiniMax image-01 不支持 ${ratio} 宽高比，可选：${Array.from(MINIMAX_RATIOS).join(" / ")}`, "size-unsupported");
		body.aspect_ratio = ratio;
	}
	const count = Math.min(MINIMAX_MAX_N, clampCount(request.n));
	if (count > 1) body.n = count;
	if (request.mode === "edit") {
		if (typeof request.image !== "string" || request.image === "") throw new ImageGenError("图生图需要上传参考图片", "edit-image-missing");
		const parsed = parseDataUrl(request.image);
		if (parsed === void 0) throw new ImageGenError("参考图片格式无效", "edit-image-invalid");
		if (Buffer.from(parsed.base64, "base64").byteLength > MAX_EDIT_IMAGE_BYTES) throw new ImageGenError("参考图片超过 10MB 上限", "edit-image-too-large");
		body.subject_reference = [{
			type: "character",
			image_file: request.image
		}];
	}
	const budget = requestSignal$1(options.signal, UPSTREAM_TIMEOUT_MS);
	try {
		let response;
		const requestUrl = `${baseUrl}/image_generation`;
		const context = attemptContext(upstream, request, "generate", requestUrl, "POST", JSON.stringify(body), Date.now());
		try {
			response = await fetch(requestUrl, {
				method: "POST",
				headers: {
					authorization: `Bearer ${upstream.apiKey.trim()}`,
					"content-type": "application/json"
				},
				body: JSON.stringify(body),
				signal: budget.signal
			});
		} catch (error) {
			const network = networkErrorFields(error);
			const failure = isBudgetTimeout(error) ? new ImageGenError("上游接口响应超时（240 秒）", "upstream-timeout") : options.signal?.aborted === true ? new ImageGenError("任务已取消", "cancelled") : new ImageGenError(`无法连接上游接口：${network.detail}${network.errorCode === void 0 ? "" : ` [${network.errorCode}]`} · 请求地址 ${displayUrl$1(requestUrl)}`, "upstream-unreachable");
			recordFailure(context, failure);
			throw failure;
		}
		let payload;
		const responseText = await readResponseText(response);
		try {
			payload = JSON.parse(responseText);
		} catch (error) {
			const failure = isBudgetTimeout(error) ? new ImageGenError("上游接口响应超时（240 秒）", "upstream-timeout") : options.signal?.aborted === true ? new ImageGenError("任务已取消", "cancelled") : new ImageGenError(`上游接口返回了非 JSON 响应（HTTP ${response.status}）`, "upstream-invalid");
			recordFailure(context, failure, {
				status: response.status,
				bodyExcerpt: responseText
			});
			throw failure;
		}
		if (payload === null || typeof payload !== "object") {
			const failure = new ImageGenError(`${upstreamMessage(payload, response.status)}（HTTP ${response.status} · ${displayUrl$1(requestUrl)}）`, "upstream-rejected");
			recordFailure(context, failure, {
				status: response.status,
				bodyExcerpt: responseText
			});
			throw failure;
		}
		const record = payload;
		const baseResp = record.base_resp;
		if (baseResp !== null && typeof baseResp === "object") {
			const status = baseResp.status_code;
			if (typeof status === "number" && status !== 0) {
				const msg = baseResp.status_msg;
				throw new ImageGenError(`MiniMax 拒绝请求（${status}）：${typeof msg === "string" && msg !== "" ? msg : "unknown error"}`, status === 1004 || status === 2049 ? "upstream-unauthorized" : "upstream-rejected");
			}
		}
		if (!response.ok) throw new ImageGenError(upstreamMessage(payload, response.status), "upstream-rejected");
		const data = record.data;
		const b64s = data !== null && typeof data === "object" && Array.isArray(data.image_base64) ? data.image_base64.filter((item) => typeof item === "string" && item.trim() !== "") : [];
		const urls = data !== null && typeof data === "object" && Array.isArray(data.image_urls) ? data.image_urls.filter((item) => typeof item === "string" && item !== "") : [];
		if (b64s.length === 0 && urls.length === 0) throw new ImageGenError("上游响应缺少图片内容", "upstream-empty");
		const images = b64s.map((raw) => {
			const b64 = bareBase64(raw);
			return {
				b64,
				mime: detectImageMime(Buffer.from(b64, "base64")) ?? "image/jpeg"
			};
		});
		for (const url of urls) {
			const normalized = await normalizeItem({ url }, upstream, options.signal);
			images.push({
				b64: normalized.b64,
				mime: normalized.mime
			});
		}
		return { images };
	} finally {
		budget.dispose();
	}
}
/** Resolve the exact Chat Completions endpoint for a channel. */
function chatEndpointUrl(upstream, baseUrl) {
	if (isChatCompletionsUrl(baseUrl)) return baseUrl;
	if (upstream.apiUrlFull === true) return baseUrl;
	return `${baseUrl}/chat/completions`;
}
/** One chat-protocol image request; image count is satisfied by parallel calls. */
async function requestOneChatImage(upstream, baseUrl, request, signal) {
	const content = request.mode === "edit" ? [{
		type: "text",
		text: request.prompt
	}, ...[request.image, ...request.images ?? []].filter((value) => typeof value === "string" && value !== "").slice(0, 5).map((url) => ({
		type: "image_url",
		image_url: { url }
	}))] : request.prompt;
	const budget = requestSignal$1(signal, UPSTREAM_TIMEOUT_MS);
	try {
		let response;
		const requestUrl = chatEndpointUrl(upstream, baseUrl);
		const requestBody = JSON.stringify({
			model: wireModel(request),
			messages: [{
				role: "user",
				content
			}],
			stream: false
		});
		const context = attemptContext(upstream, request, "chat", requestUrl, "POST", requestBody, Date.now());
		try {
			response = await fetch(requestUrl, {
				method: "POST",
				headers: {
					authorization: `Bearer ${upstream.apiKey.trim()}`,
					"content-type": "application/json",
					accept: "application/json"
				},
				body: requestBody,
				signal: budget.signal
			});
		} catch (error) {
			const network = networkErrorFields(error);
			const failure = isBudgetTimeout(error) ? new ImageGenError("上游接口响应超时（240 秒）", "upstream-timeout") : signal?.aborted === true ? new ImageGenError("任务已取消", "cancelled") : new ImageGenError(`无法连接上游接口：${network.detail}${network.errorCode === void 0 ? "" : ` [${network.errorCode}]`} · 请求地址 ${displayUrl$1(requestUrl)}`, "upstream-unreachable");
			recordFailure(context, failure);
			throw failure;
		}
		let payload;
		const responseText = await readResponseText(response);
		try {
			payload = JSON.parse(responseText);
		} catch (error) {
			const failure = isBudgetTimeout(error) ? new ImageGenError("上游接口响应超时（240 秒）", "upstream-timeout") : signal?.aborted === true ? new ImageGenError("任务已取消", "cancelled") : new ImageGenError(`上游接口返回了非 JSON 响应（HTTP ${response.status}）`, "upstream-invalid");
			recordFailure(context, failure, {
				status: response.status,
				bodyExcerpt: responseText
			});
			throw failure;
		}
		if (!response.ok || payload === null || typeof payload !== "object") {
			const failure = new ImageGenError(`${upstreamMessage(payload, response.status)}（HTTP ${response.status} · ${displayUrl$1(requestUrl)}）`, "upstream-rejected");
			recordFailure(context, failure, {
				status: response.status,
				bodyExcerpt: responseText
			});
			throw failure;
		}
		const items = chatImageItemsOf(payload);
		if (items.length === 0) {
			const failure = new ImageGenError(chatErrorTextOf(payload)?.slice(0, 1200) || "Chat Completions 响应中没有可用的图片结果", "upstream-empty");
			recordFailure(context, failure, {
				status: response.status,
				bodyExcerpt: responseText
			});
			throw failure;
		}
		return await Promise.all(items.map((item) => normalizeItem(item, upstream, signal)));
	} finally {
		budget.dispose();
	}
}
/** Run N parallel Chat Completions image calls and flatten the result. */
async function generateChatCompletionImages(upstream, baseUrl, request, signal) {
	const count = effectiveCount(request);
	return (await Promise.all(Array.from({ length: count }, () => requestOneChatImage(upstream, baseUrl, request, signal)))).flat();
}
/**
* Forward one generate request to the configured endpoint. The requested image
* count is satisfied with N parallel single-image requests (the `n` batch
* parameter is never sent, because Responses-API-based gateways reject it as
* `tools[0].n`), then the results are flattened in order.
*/
async function generateImage(upstream, request, options = {}) {
	const baseUrl = normalizeModelScopeBaseUrl(upstream.apiUrl.trim().replace(/\/+$/, ""), upstream.apiUrlFull === true);
	if (baseUrl === "") throw new ImageGenError("api_url 未配置：请先在「设置 → 生图配置」中填写", "config-missing");
	if (upstream.apiKey.trim() === "") throw new ImageGenError("api_key 未配置：请先在「设置 → 生图配置」中填写", "config-missing");
	if (resolveChannelProtocol(baseUrl, upstream.protocol) === "chat-completions") return { images: await generateChatCompletionImages(upstream, baseUrl, request, options.signal) };
	if (upstream.apiUrlFull !== true) {
		if (!isModelScopeInference(baseUrl) && isQwenImage(wireModel(request))) return generateQwenImage(baseUrl, upstream, request, options);
		if (isMiniMaxImage(wireModel(request))) return generateMiniMaxImage(baseUrl, upstream, request, options);
		if (request.mode === "edit" && isZhipuImage(wireModel(request))) throw new ImageGenError("智谱 GLM-Image 当前仅支持文生图，请切换到文生图模式或选择支持图生图的模型", "edit-unsupported");
	}
	const params = effectiveParams(request);
	const count = effectiveCount(request);
	return { images: (await Promise.all(Array.from({ length: count }, () => requestOneImage(baseUrl, upstream, request, params, options.signal)))).flat() };
}
/**
* The URL actually handed to fetch, with any query string dropped: the
* diagnostics panel exists to answer "which address did it call", and a signed
* query would leak credentials into a bug report.
*/
function displayUrl$1(url) {
	try {
		const parsed = new URL(url);
		return `${parsed.origin}${parsed.pathname}`;
	} catch {
		return url.split("?")[0] ?? url;
	}
}
/** Record a failed attempt against the diagnostics buffer. */
function recordFailure(context, error, options = {}) {
	const network = networkErrorFields(error);
	recordDiagnostic({
		phase: context.phase,
		channel: context.channel,
		model: context.model,
		mode: context.mode,
		url: context.url,
		method: context.method,
		status: options.status,
		errorCode: network.errorCode,
		failureCode: error.code,
		message: error.message,
		bodyExcerpt: options.bodyExcerpt,
		requestExcerpt: context.requestExcerpt,
		requestBytes: context.requestBytes,
		responseBytes: options.responseBytes,
		durationMs: Date.now() - context.startedAt,
		hadAuth: context.hadAuth,
		apiUrlFull: context.apiUrlFull
	});
}
/** Build the attempt context for one upstream call. */
function attemptContext(upstream, request, phase, url, method, body, startedAt) {
	return {
		phase,
		channel: upstream.channelName?.trim() || "默认渠道",
		model: wireModel(request),
		mode: request.mode,
		url: displayUrl$1(url),
		method,
		hadAuth: upstream.apiKey.trim() !== "",
		...upstream.apiUrlFull === true ? { apiUrlFull: true } : {},
		requestExcerpt: requestExcerptFor(request, body),
		requestBytes: bodyByteLength(body),
		startedAt
	};
}
/**
* The request excerpt worth keeping. Reference images are stripped (they are
* megabytes of base64 already summarised by requestBytes), keeping the shape
* and the prompt so the panel shows what was actually asked for.
*/
function requestExcerptFor(request, body) {
	if (typeof body === "string") return excerptOf(body);
	const shape = {
		mode: request.mode,
		model: wireModel(request),
		prompt: request.prompt,
		size: request.size,
		quality: request.quality,
		n: request.n
	};
	if (request.image !== void 0) shape.referenceImages = 1 + (request.images?.length ?? 0);
	return excerptOf(shape);
}
/** Human-readable failure message from an upstream error payload. */
function upstreamMessage(payload, status) {
	if (payload !== null && typeof payload === "object") {
		const record = payload;
		const error = record.error;
		if (error !== null && typeof error === "object") {
			const message = error.message;
			if (typeof message === "string" && message !== "") return message;
		}
		if (typeof record.message === "string" && record.message !== "") return record.message;
		if (typeof record.error === "string" && record.error !== "") return record.error;
	}
	return `上游接口拒绝请求（HTTP ${status}）`;
}
/** File extension for a MIME type (multipart reference image). */
function extensionOf$6(mime) {
	switch (mime.split(";")[0].trim()) {
		case "image/jpeg": return "jpg";
		case "image/webp": return "webp";
		case "image/gif": return "gif";
		default: return "png";
	}
}
//#endregion
//#region src/video-model-catalog.ts
/** Families whose request shape we know, keyed by family id. */
const ENTRIES = {
	agnes: {
		label: "agnes",
		labelZh: "Agnes 视频",
		known: true,
		modes: [
			"text",
			"image",
			"keyframe",
			"reference"
		],
		resolutions: [
			"480P",
			"720P",
			"1080P"
		],
		aspectRatios: [
			"16:9",
			"9:16",
			"1:1",
			"4:3",
			"3:4"
		],
		supportsSeed: true,
		requiresReference: false
	},
	comemoe: {
		label: "comemoe",
		labelZh: "算力萌",
		known: true,
		modes: ["text", "image"],
		resolutions: ["720P", "1080P"],
		aspectRatios: [
			"16:9",
			"9:16",
			"1:1"
		],
		supportsSeed: false,
		requiresReference: false
	},
	"openai-video": {
		label: "openai-video",
		labelZh: "通用视频",
		known: true,
		modes: ["text", "image"],
		resolutions: [
			"480P",
			"720P",
			"1080P"
		],
		aspectRatios: [],
		supportsSeed: false,
		requiresReference: false
	},
	seedance: {
		label: "seedance",
		labelZh: "火山 Seedance",
		known: true,
		modes: [
			"text",
			"image",
			"keyframe"
		],
		resolutions: [
			"480P",
			"720P",
			"1080P"
		],
		aspectRatios: [
			"16:9",
			"9:16",
			"1:1",
			"4:3",
			"3:4"
		],
		supportsSeed: true,
		requiresReference: false
	},
	xai: {
		label: "xAI Grok",
		labelZh: "xAI Grok",
		known: true,
		modes: ["text", "image"],
		resolutions: [
			"480P",
			"720P",
			"1080P"
		],
		aspectRatios: [
			"16:9",
			"9:16",
			"1:1",
			"4:3",
			"3:4"
		],
		supportsSeed: false,
		requiresReference: false
	}
};
/** comemoe model ids (they do not start with a vendor prefix). */
const COMEMOE_VIDEO_MODELS = /* @__PURE__ */ new Set(["wan2.2-t2v", "zhimeng-h3-local"]);
/** Whether a model id belongs to the comemoe (算力萌) video family. */
function isComemoeVideoModel(model) {
	const id = model.trim();
	return COMEMOE_VIDEO_MODELS.has(id) || /^comemoe[-_/]/i.test(id);
}
/**
* Whether a model id is Volcengine Ark's Seedance video contract.
*
* Both the official ids (`doubao-seedance-2-0-260128`) and the shorter gateway
* aliases (`seedance-2-0`) are accepted: the family is decided by the request
* SHAPE, and both spellings mean the same `/contents/generations/tasks` body.
*/
function isArkSeedanceVideoModel(model) {
	return /^(?:doubao-)?seedance(?:[-_.]|$)/i.test(model.trim());
}
/** Classify one upstream video model id into its request-shaping family. */
function describeVideoModel(model) {
	const id = model.trim();
	if (id === "") return unknownEntry();
	if (/^agnes-video/i.test(id)) return {
		family: "agnes",
		...ENTRIES.agnes
	};
	if (/^grok-imagine-video/i.test(id)) return {
		family: "xai",
		...ENTRIES.xai
	};
	if (isArkSeedanceVideoModel(id)) {
		const base = ENTRIES.seedance;
		const seedance2 = /seedance[-_.]?2/i.test(id);
		const resolutions = /seedance[-_.]?2(?:[-_.]\d+)*[-_.](?:fast|mini)/i.test(id) ? ["480P", "720P"] : [...base.resolutions];
		const modes = /seedance[-_.]?1[-_.]?\d+[-_.]?pro[-_.]?fast/i.test(id) ? ["text", "image"] : [...base.modes];
		return seedance2 ? {
			family: "seedance",
			...base,
			resolutions,
			modes: [...modes, "reference"]
		} : {
			family: "seedance",
			...base,
			resolutions,
			modes
		};
	}
	if (isComemoeVideoModel(id)) {
		const base = ENTRIES.comemoe;
		return id === "wan2.2-t2v" || /t2v/i.test(id) ? {
			family: "comemoe",
			...base,
			modes: ["text"]
		} : {
			family: "comemoe",
			...base
		};
	}
	if (isLikelyVideoModelId(id)) return {
		family: "openai-video",
		...ENTRIES["openai-video"]
	};
	return unknownEntry();
}
/** Most permissive classification for a model the user explicitly configured. */
function unknownEntry() {
	return {
		family: "unknown",
		label: "unknown",
		labelZh: "未知协议",
		known: false,
		modes: ["text"],
		resolutions: ["720P"],
		aspectRatios: [],
		supportsSeed: false,
		requiresReference: false
	};
}
/** Conservative fallback for providers whose /models response only has ids. */
function isLikelyVideoModelId(model) {
	return /(?:^|[-_.])(?:video|t2v|i2v|motion|animate|sora|veo|kling|runway|pika|luma|haiper|wan2|minimax-h3|seedance)(?:$|[-_.])/i.test(model.trim());
}
/** Default video model ids offered when a channel has no video catalog yet. */
const DEFAULT_VIDEO_MODELS = ["agnes-video-2.5-flash", "agnes-video-2.5"];
/**
* The upstream id a channel alias actually resolves to.
*
* Capability checks (modes, resolutions, family) must describe the id the
* provider RECEIVES, not the alias the user typed: a channel can map
* `seedance-hd` → `doubao-seedance-2-0-fast-260128`, and only the latter is
* capped at 720p. Describing the alias would offer a tier the id rejects.
*
* Falls back to the alias itself when no channel maps it (a request built
* outside the panel, or a catalog edited after selection).
*/
function resolveVideoModelId(alias, channels) {
	const wanted = alias.trim();
	if (wanted === "") return "";
	for (const channel of channels ?? []) for (const row of channel.videoModels ?? []) {
		if (row.alias !== wanted) continue;
		const upstream = (row.id ?? "").trim();
		return upstream === "" ? wanted : upstream;
	}
	return wanted;
}
/** Clamp a requested duration into what the family accepts. */
function clampVideoSeconds(seconds) {
	const rounded = Math.round(seconds);
	if (!Number.isFinite(rounded) || rounded <= 0) return 5;
	return Math.min(30, Math.max(1, rounded));
}
/** Ordered clarity tiers, lowest first. */
const RESOLUTION_RANK = [
	"480P",
	"720P",
	"1080P"
];
/**
* Clamp one resolution to what the family understands.
*
* A model whose tier list was narrowed (Seedance fast/mini cap at 720p) must
* degrade a too-high request to the best tier it does support — falling back
* to the FIRST entry would turn a 1080P ask into 480P and quietly throw away
* most of the picture. Requests below the supported floor still snap up to it.
*/
function normalizeVideoResolution(model, resolution) {
	const entry = describeVideoModel(model);
	const wanted = resolution.trim().toUpperCase();
	const hit = entry.resolutions.find((row) => row === wanted);
	if (hit !== void 0) return hit;
	const ceiling = RESOLUTION_RANK.indexOf(wanted);
	if (ceiling >= 0) {
		const below = entry.resolutions.filter((row) => RESOLUTION_RANK.indexOf(row) <= ceiling);
		if (below.length > 0) return below.reduce((best, row) => RESOLUTION_RANK.indexOf(row) > RESOLUTION_RANK.indexOf(best) ? row : best);
		const above = entry.resolutions.filter((row) => RESOLUTION_RANK.indexOf(row) > ceiling);
		if (above.length > 0) return above.reduce((best, row) => RESOLUTION_RANK.indexOf(row) < RESOLUTION_RANK.indexOf(best) ? row : best);
	}
	return entry.resolutions[0] ?? "720P";
}
//#endregion
//#region src/video-engine.ts
/** A video generation failure with a user-presentable message. */
var VideoGenError = class extends Error {
	/** Stable wire code. */
	code;
	/**
	* Whether retrying the exact same request could plausibly succeed. Only the
	* poll loop reads this: a transient status (5xx / rate limit) is retried
	* against the same deadline, everything else is surfaced as-is.
	*/
	retryable;
	/**
	* The HTTP status, when the failure came with one.
	*
	* Carried on the error because the poll loop only ever sees the error, never
	* the response: a retryable status that does NOT recover still has to be
	* recorded with its wire code, and "503 five times running" and "429 five
	* times running" are different conversations (#38, video parity).
	*/
	status;
	constructor(message, code = "video-failed", retryable = false, status) {
		super(message);
		this.name = "VideoGenError";
		this.code = code;
		this.retryable = retryable;
		this.status = status;
	}
};
/** Total budget for one submit call (submitting is fast; rendering is not). */
const SUBMIT_TIMEOUT_MS$1 = 12e4;
/** Budget for downloading one finished clip. */
const DOWNLOAD_TIMEOUT_MS$1 = 3e5;
/** Cap on one downloaded clip, in bytes (safety valve against a bad URL). */
const MAX_VIDEO_BYTES = 512 * 1024 * 1024;
/**
* Status codes worth one more poll. Rendering takes minutes, and the status
* endpoint is a third party: a 5xx or a rate limit there says "ask again",
* not "this render failed". Everything else — notably 401/403/404 — is a
* permanent answer and must reach the user unchanged.
*/
const RETRYABLE_STATUS$1 = /* @__PURE__ */ new Set([
	408,
	425,
	429,
	500,
	502,
	503,
	504
]);
/**
* Poll budgets per family. Rendering a short clip is slow: Agnes took several
* minutes in testing and comemoe took ~9 minutes for a 5s clip, so the poll
* deadline is generous and the interval is family-tuned rather than shared
* with the image path.
*/
const POLL_POLICY = {
	agnes: {
		intervalMs: 8e3,
		deadlineMs: 20 * 6e4
	},
	comemoe: {
		intervalMs: 6e3,
		deadlineMs: 40 * 6e4
	},
	"openai-video": {
		intervalMs: 5e3,
		deadlineMs: 20 * 6e4
	},
	seedance: {
		intervalMs: 5e3,
		deadlineMs: 30 * 6e4
	},
	xai: {
		intervalMs: 5e3,
		deadlineMs: 20 * 6e4
	},
	unknown: {
		intervalMs: 5e3,
		deadlineMs: 20 * 6e4
	}
};
/** Whether a model id is a wired-up video family (the route/tool gate). */
function isVideoModel(model) {
	return describeVideoModel(model).family !== "unknown";
}
/** Reject a data URL we cannot send upstream. */
function requireDataUrl(value, what) {
	const match = /^data:([^;,]+)?;base64,(.*)$/s.exec(value.trim());
	if (match === null || match[2] === void 0 || match[2] === "") throw new VideoGenError(`${what}不是有效的 base64 图片数据`, "video-bad-reference");
	return {
		mime: match[1] ?? "image/png",
		base64: match[2]
	};
}
/** Decode the reference frames this request's mode actually uses. */
function referencesOf(request) {
	const all = [];
	const push = (value, what) => {
		if (value === void 0 || value.trim() === "") return;
		all.push(requireDataUrl(value, what));
	};
	switch (request.mode) {
		case "image":
			push(request.image, "参考图片");
			break;
		case "keyframe":
			push(request.firstFrame, "首帧图片");
			push(request.lastFrame, "尾帧图片");
			break;
		case "reference":
			push(request.image, "参考图片");
			for (const extra of request.images ?? []) push(extra, "参考图片");
			break;
		default: break;
	}
	return {
		...all.length > 0 ? { primary: all[0] } : {},
		all
	};
}
/** A data URL for one decoded reference (the wire form providers expect). */
function dataUrlOf(reference) {
	return `data:${reference.mime};base64,${reference.base64}`;
}
/**
* Seedance's accepted durations.
*
* The panel offers 5 and 10 seconds; 2.x accepts 4-15 and 1.0 accepts 2-12.
* A value outside the window is CLAMPED rather than rejected: the panel's own
* options are valid on every id, but a caller (Agent tool, graph runner) can
* pass anything, and a 400 from the provider explains nothing.
*/
function seedanceSeconds(model, seconds) {
	const seedance2 = /seedance[-_.]?2/i.test(model);
	return Math.min(seedance2 ? 15 : 12, Math.max(seedance2 ? 4 : 2, Math.round(seconds)));
}
/**
* Seedance resolutions, lowercase, narrowed for the fast/mini ids.
*
* `doubao-seedance-2-0-fast-*` and `-mini-*` reject 1080p and 4k upstream, so
* asking for 1080P on those would be a guaranteed 400 — downgrade to 720p.
*/
function seedanceResolution(model, resolution) {
	if (/seedance[-_.]?2(?:[-_.]\d+)*[-_.](?:fast|mini)/i.test(model)) return resolution === "480P" ? "480p" : "720p";
	return resolution.toLowerCase();
}
/** Map the panel's video mode onto a family's own mode vocabulary. */
function familyMode(family, mode) {
	if (family === "agnes") {
		if (mode === "text") return "text";
		if (mode === "keyframe") return "keyframe";
		return "reference";
	}
	return mode === "text" ? "text" : "image";
}
/** Resolve the request URL: base URL + path, or the exact configured URL. */
function endpointUrl(upstream, baseUrl, path) {
	return upstream.apiUrlFull === true ? baseUrl : `${baseUrl}${path}`;
}
/**
* Submit and status paths for one family.
*
* xAI is the odd one out: it serves `POST /videos/generations` and returns a
* `request_id`, while polling is the same `GET /videos/{id}` every other family
* uses. Posting to `/videos` — what the generic family did — answers 404 (#5).
*/
const VIDEO_PATHS = {
	xai: {
		submit: "/videos/generations",
		status: "/videos/{id}"
	},
	seedance: {
		submit: "/contents/generations/tasks",
		status: "/contents/generations/tasks/{id}"
	}
};
/**
* The status URL for a task id.
*
* `apiUrlFull` names the exact SUBMIT url, so the status url is derived from it
* rather than from the base: without this, a user who configured
* `https://api.x.ai/v1/videos/generations` got polled at
* `…/videos/generations/videos/{id}`, which is a 404 every time (#5).
*/
function statusUrlFor(upstream, baseUrl, family, taskId) {
	const path = (VIDEO_PATHS[family]?.status ?? "/videos/{id}").replace("{id}", encodeURIComponent(taskId));
	if (upstream.apiUrlFull !== true) return `${baseUrl}${path}`;
	const configured = baseUrl.replace(/\/+$/, "");
	const submitPath = VIDEO_PATHS[family]?.submit ?? "/videos";
	return `${configured.endsWith(submitPath) ? configured.slice(0, configured.length - submitPath.length) : configured}${path}`;
}
/** Whether a URL lives on the same origin as the configured API base. */
function isSameOriginAsApi(value, apiUrl) {
	try {
		return new URL(value).origin === new URL(apiUrl).origin;
	} catch {
		return false;
	}
}
/** One abort signal with a budget, disposed by the caller. */
function requestSignal(source, timeoutMs) {
	const controller = new AbortController();
	const abortFromSource = () => {
		controller.abort(source?.reason);
	};
	if (source?.aborted === true) abortFromSource();
	else source?.addEventListener("abort", abortFromSource, { once: true });
	const timeout = setTimeout(() => {
		controller.abort(new DOMException("The operation timed out.", "TimeoutError"));
	}, timeoutMs);
	timeout.unref();
	return {
		signal: controller.signal,
		dispose: () => {
			clearTimeout(timeout);
			source?.removeEventListener("abort", abortFromSource);
		}
	};
}
/** Sleep that rejects immediately when the caller aborts. */
function waitForPoll(ms, signal) {
	return new Promise((resolve, reject) => {
		if (signal?.aborted === true) {
			reject(new VideoGenError("视频生成已取消", "video-cancelled"));
			return;
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(new VideoGenError("视频生成已取消", "video-cancelled"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}
/** Pull a human error string out of any provider error shape. */
function errorTextOf(payload, fallback) {
	const error = payload.error;
	if (typeof error === "string" && error !== "") return error;
	if (error !== null && typeof error === "object") {
		const message = error.message;
		if (typeof message === "string" && message !== "") return message;
	}
	for (const key of [
		"message",
		"msg",
		"detail"
	]) {
		const value = payload[key];
		if (typeof value === "string" && value !== "") return value;
	}
	return fallback;
}
/**
* Read a JSON body AND keep its raw text for the diagnostics record.
*
* The body can only be consumed once, so the two consumers share one read:
* parsing needs the RAW text, and the record needs a redacted excerpt of the
* same text. Reading it twice would silently return an empty excerpt for every
* non-2xx response, which is exactly the case the record exists for.
*/
async function readJsonWithText(response) {
	const text = await readResponseText(response);
	if (text.trim() === "") return {
		payload: {},
		text
	};
	try {
		const parsed = JSON.parse(text);
		return {
			payload: parsed !== null && typeof parsed === "object" ? parsed : {},
			text
		};
	} catch {
		return {
			payload: { message: text.slice(0, 300) },
			text
		};
	}
}
/** The URL actually handed to fetch, with any query string dropped (#38). */
function displayUrl(url) {
	try {
		const parsed = new URL(url);
		return `${parsed.origin}${parsed.pathname}`;
	} catch {
		return url.split("?")[0] ?? url;
	}
}
/** Build the attempt context for one video request. */
function videoAttempt(upstream, request, model, phase, url, method, body) {
	return {
		phase,
		channel: upstream.channelName?.trim() || "默认渠道",
		model,
		mode: request.mode,
		url: displayUrl(url),
		method,
		hadAuth: upstream.apiKey.trim() !== "",
		...upstream.apiUrlFull === true ? { apiUrlFull: true } : {},
		...body === void 0 ? {} : { requestBytes: bodyByteLength(body) },
		startedAt: Date.now()
	};
}
/**
* Record one failed video attempt against the shared diagnostics buffer.
*
* The same buffer the image chain writes to: the panel is one surface, and a
* user whose image call works and whose video call does not must be able to see
* both in one place.
*/
function recordVideoFailure(attempt, error, options = {}) {
	const network = networkErrorFields(error);
	recordDiagnostic({
		phase: attempt.phase,
		channel: attempt.channel,
		model: attempt.model,
		mode: attempt.mode,
		url: attempt.url,
		method: attempt.method,
		status: options.status ?? error.status,
		errorCode: network.errorCode,
		failureCode: error.code,
		message: error.message,
		bodyExcerpt: options.bodyExcerpt,
		requestExcerpt: options.requestExcerpt,
		requestBytes: attempt.requestBytes,
		responseBytes: options.responseBytes,
		durationMs: Date.now() - attempt.startedAt,
		hadAuth: attempt.hadAuth,
		apiUrlFull: attempt.apiUrlFull
	});
}
/**
* Record the poll loop giving up on a status endpoint that kept failing.
*
* Only the exhausted budget is recorded: one blip is not worth a row (writing
* every one would bury the failure that matters), but an endpoint that failed
* the whole budget is exactly the "it just sat there" report this buffer
* exists to answer. It is recorded as `video-status-failed` -- the transient
* reading is over by then -- while still naming the task and the retries.
*/
function recordPollExhausted(statusAttempt, error, taskId, family, retries) {
	const network = networkErrorFields(error);
	recordVideoFailure(statusAttempt, new VideoGenError(error instanceof VideoGenError ? error.message : `视频状态查询连续失败：${network.detail}${network.errorCode === void 0 ? "" : ` [${network.errorCode}]`} · 请求地址 ${statusAttempt.url}`, "video-status-failed", false, error instanceof VideoGenError ? error.status : void 0), { requestExcerpt: excerptOf({
		taskId,
		family,
		retries
	}) });
}
/**
* The submit body worth keeping. Reference frames are data URLs measured in
* megabytes, so they are replaced by their count: the panel shows what was
* asked for without shipping the payload into the buffer.
*/
function videoRequestExcerpt(request, body) {
	const shapes = [
		"image_url",
		"image",
		"images",
		"first_frame",
		"last_frame"
	];
	const shape = {};
	for (const [key, value] of Object.entries(body)) if (shapes.includes(key)) shape[`${key}<omitted>`] = Array.isArray(value) ? value.length : 1;
	else shape[key] = value;
	return excerptOf(shape) ?? "";
}
/** POST one submit request and return the parsed JSON body. */
async function postJson(attempt, request, url, apiKey, body, signal) {
	const excerpt = videoRequestExcerpt(request, body);
	let response;
	try {
		response = await fetch(url, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${apiKey}`
			},
			body: JSON.stringify(body),
			signal
		});
	} catch (error) {
		if (signal.aborted) throw error;
		const network = networkErrorFields(error);
		const failure = new VideoGenError(`无法连接视频接口：${network.detail}${network.errorCode === void 0 ? "" : ` [${network.errorCode}]`} · 请求地址 ${attempt.url}`, "video-unreachable");
		recordVideoFailure(attempt, failure, { requestExcerpt: excerpt });
		throw failure;
	}
	const { payload, text } = await readJsonWithText(response);
	if (!response.ok) {
		const failure = new VideoGenError(`${errorTextOf(payload, `视频提交失败（HTTP ${response.status}）`)}（HTTP ${response.status} · ${attempt.url}）`, "video-submit-failed");
		recordVideoFailure(attempt, failure, {
			status: response.status,
			requestExcerpt: excerpt,
			bodyExcerpt: excerptOf(text),
			responseBytes: Buffer.byteLength(text, "utf8")
		});
		throw failure;
	}
	return payload;
}
/**
* GET one status request and return the parsed JSON body.
*
* A status code that is worth retrying is flagged on the error (see
* `RETRYABLE_STATUS`) so the poll loop can swallow one blip instead of failing
* a render the provider is still working on. Every other status keeps the wire
* code the route layer already reported.
*/
async function getJson(attempt, url, apiKey, signal) {
	const response = await fetch(url, {
		method: "GET",
		headers: { authorization: `Bearer ${apiKey}` },
		signal
	});
	const { payload, text } = await readJsonWithText(response);
	if (!response.ok) {
		const retryable = RETRYABLE_STATUS$1.has(response.status);
		const failure = new VideoGenError(errorTextOf(payload, `视频状态查询失败（HTTP ${response.status}）`), retryable ? "video-status-transient" : "video-status-failed", retryable, response.status);
		if (!retryable) recordVideoFailure(attempt, failure, {
			status: response.status,
			bodyExcerpt: excerptOf(text),
			responseBytes: Buffer.byteLength(text, "utf8")
		});
		throw failure;
	}
	return payload;
}
/** Extract the task id from any of the submit response shapes we have seen. */
function taskIdOf(payload) {
	const nested = payload.task;
	const candidates = [
		payload.video_id,
		payload.id,
		payload.request_id,
		nested !== null && typeof nested === "object" ? nested.id : void 0,
		payload.task_id,
		nested !== null && typeof nested === "object" ? nested.task_id : void 0
	];
	for (const candidate of candidates) {
		if (typeof candidate === "string" && candidate.trim() !== "") return candidate.trim();
		if (typeof candidate === "number") return String(candidate);
	}
	return "";
}
/**
* Interpret one poll response.
*
* Status vocabularies differ and are incomplete in the docs: Agnes reports
* `completed`/`failed`, while comemoe adds a `processing` state its docs omit
* (they claim `queued → running → succeeded`). Treat the union as canonical
* and resolve the URL from either the nested metadata or the flat top level.
*/
function readPoll(payload) {
	const status = String(payload.status ?? "").toLowerCase().trim();
	if ([
		"failed",
		"error",
		"cancelled",
		"canceled",
		"expired"
	].includes(status)) return {
		kind: "failed",
		message: errorTextOf(payload, status === "expired" ? "视频任务已过期" : "视频生成失败")
	};
	const metadata = payload.metadata !== null && typeof payload.metadata === "object" ? payload.metadata : void 0;
	const video = payload.video !== null && typeof payload.video === "object" ? payload.video : void 0;
	const content = payload.content !== null && typeof payload.content === "object" ? payload.content : void 0;
	const url = [
		payload.url,
		payload.result_url,
		payload.video_url,
		content?.video_url,
		metadata?.url,
		video?.url
	].find((candidate) => typeof candidate === "string" && candidate.trim() !== "");
	if ([
		"completed",
		"succeeded",
		"success",
		"done",
		"finished"
	].includes(status)) {
		const duration = typeof payload.duration === "number" ? payload.duration : typeof metadata?.duration === "number" ? metadata.duration : typeof video?.duration === "number" ? video.duration : void 0;
		const poster = typeof payload.poster === "string" ? payload.poster : typeof metadata?.poster === "string" ? metadata.poster : typeof content?.last_frame_url === "string" ? content.last_frame_url : void 0;
		if (typeof url !== "string") return {
			kind: "done-content",
			...duration === void 0 ? {} : { duration },
			...poster === void 0 ? {} : { poster }
		};
		return {
			kind: "done",
			url,
			...duration === void 0 ? {} : { duration },
			...poster === void 0 ? {} : { poster }
		};
	}
	if (typeof url === "string" && status === "") return {
		kind: "done",
		url
	};
	return { kind: "pending" };
}
/**
* Delay before poll number `attempt` (0-based).
*
* Polling is quick-start then steady: the first few checks come fast so a fast
* render (or an immediate rejection) surfaces in seconds, and the cadence then
* settles into the family interval. A flat interval would make every user wait
* the full 6-8s before even the first status, which is the worst case for the
* common "provider rejected it instantly" path.
*/
function pollDelayMs(policy, attempt) {
	if (attempt === 0) return 1500;
	if (attempt === 1) return 3e3;
	return policy.intervalMs;
}
/**
* How many poll requests in a row may fail transiently before the loop gives
* up. The retries share the family deadline, so a dead endpoint still ends in
* `video-timeout` instead of retrying forever.
*/
const MAX_POLL_TRANSIENT_RETRIES = 4;
/** Short backoff before re-asking a status endpoint that just failed. */
function pollRetryDelayMs(retry) {
	const steps = [
		300,
		700,
		1500,
		3e3
	];
	return steps[Math.min(retry, steps.length) - 1] ?? 3e3;
}
/**
* The `/content` address for a finished task.
*
* OpenAI's video API serves the finished clip as a binary stream from
* `GET /videos/{id}/content` and never puts a URL in the poll body. Appending
* to the status URL keeps the `apiUrlFull`-derived base and the family's own
* status path in one place, so a relay with a prefix polls and fetches through
* the same prefix.
*/
function contentUrlFor(statusUrl) {
	return `${statusUrl.replace(/\/+$/, "")}/content`;
}
/** Poll one task until terminal or the family deadline passes. */
async function pollUntilDone(attempt, upstream, baseUrl, taskId, family, signal) {
	const policy = POLL_POLICY[family] ?? POLL_POLICY.unknown;
	const deadline = Date.now() + policy.deadlineMs;
	const statusUrl = statusUrlFor(upstream, baseUrl, family, taskId);
	const statusAttempt = {
		...attempt,
		phase: "video-poll",
		url: displayUrl(statusUrl),
		method: "GET"
	};
	let attemptCount = 0;
	let transientRetries = 0;
	while (Date.now() < deadline) {
		await waitForPoll(pollDelayMs(policy, attemptCount), signal);
		attemptCount += 1;
		const budget = requestSignal(signal, SUBMIT_TIMEOUT_MS$1);
		try {
			const payload = await getJson(statusAttempt, statusUrl, upstream.apiKey, budget.signal);
			transientRetries = 0;
			const outcome = readPoll(payload);
			if (outcome.kind === "done") return {
				source: {
					kind: "url",
					url: outcome.url
				},
				...outcome.duration === void 0 ? {} : { duration: outcome.duration },
				...outcome.poster === void 0 ? {} : { poster: outcome.poster }
			};
			if (outcome.kind === "done-content") return {
				source: {
					kind: "content",
					url: contentUrlFor(statusUrl)
				},
				...outcome.duration === void 0 ? {} : { duration: outcome.duration },
				...outcome.poster === void 0 ? {} : { poster: outcome.poster }
			};
			if (outcome.kind === "failed") {
				const failure = new VideoGenError(outcome.message, "video-failed");
				recordVideoFailure(statusAttempt, failure, { requestExcerpt: excerptOf({
					taskId,
					family,
					...payload
				}) });
				throw failure;
			}
		} catch (error) {
			if (signal?.aborted === true) throw error;
			if (!(error instanceof VideoGenError ? error.retryable : error instanceof TypeError || error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError"))) throw error;
			transientRetries += 1;
			if (transientRetries > MAX_POLL_TRANSIENT_RETRIES) {
				recordPollExhausted(statusAttempt, error, taskId, family, transientRetries);
				throw error;
			}
			if (Date.now() + pollRetryDelayMs(transientRetries) >= deadline) break;
			await waitForPoll(pollRetryDelayMs(transientRetries), signal);
		} finally {
			budget.dispose();
		}
	}
	const timeout = new VideoGenError(`视频生成超时（已等待 ${Math.round(policy.deadlineMs / 6e4)} 分钟）`, "video-timeout");
	recordVideoFailure(statusAttempt, timeout, { requestExcerpt: excerptOf({
		taskId,
		family,
		polls: attemptCount,
		waitedMs: policy.deadlineMs
	}) });
	throw timeout;
}
/** Download the finished clip, forwarding the key only to the API's origin. */
async function downloadVideo(attempt, upstream, url, signal) {
	const budget = requestSignal(signal, DOWNLOAD_TIMEOUT_MS$1);
	try {
		const headers = isSameOriginAsApi(url, upstream.apiUrl) ? { authorization: `Bearer ${upstream.apiKey}` } : {};
		let response;
		try {
			response = await fetch(url, {
				headers,
				signal: budget.signal
			});
		} catch (error) {
			if (signal?.aborted === true) throw error;
			const network = networkErrorFields(error);
			const failure = new VideoGenError(`无法下载生成的视频：${network.detail}${network.errorCode === void 0 ? "" : ` [${network.errorCode}]`} · 视频地址 ${attempt.url}`, "video-download-failed");
			recordVideoFailure(attempt, failure);
			throw failure;
		}
		if (!response.ok) {
			const failure = new VideoGenError(`无法下载生成的视频（HTTP ${response.status} · ${attempt.url}）`, "video-download-failed");
			recordVideoFailure(attempt, failure, { status: response.status });
			throw failure;
		}
		const buffer = Buffer.from(await response.arrayBuffer());
		if (buffer.byteLength === 0) {
			const failure = new VideoGenError("生成的视频内容为空", "video-download-failed");
			recordVideoFailure(attempt, failure, {
				status: response.status,
				responseBytes: 0
			});
			throw failure;
		}
		if (buffer.byteLength > MAX_VIDEO_BYTES) {
			const failure = new VideoGenError("生成的视频超出了单文件体积上限", "video-too-large");
			recordVideoFailure(attempt, failure, {
				status: response.status,
				responseBytes: buffer.byteLength
			});
			throw failure;
		}
		const contentType = response.headers.get("content-type")?.split(";")[0]?.trim();
		return {
			bytes: buffer,
			mime: videoMimeOf(contentType, url),
			sourceUrl: url
		};
	} finally {
		budget.dispose();
	}
}
/** Pick a video MIME type from the response header, falling back to the URL. */
function videoMimeOf(contentType, url) {
	if (contentType !== void 0 && /^video\/[a-z0-9.+-]+$/i.test(contentType)) return contentType;
	switch (/\.([a-z0-9]+)(?:$|[?#])/i.exec(url)?.[1]?.toLowerCase()) {
		case "webm": return "video/webm";
		case "mov": return "video/quicktime";
		case "mkv": return "video/x-matroska";
		default: return "video/mp4";
	}
}
/** Build the family-specific submit body. */
function submitBody(entry, family, request, references) {
	const seconds = clampVideoSeconds(request.seconds);
	const resolution = normalizeVideoResolution((request.upstream ?? request.model).trim(), request.resolution);
	const familyName = entry.family;
	if (familyName === "comemoe") {
		const body = {
			model: request.upstream ?? request.model,
			prompt: request.prompt,
			duration: seconds,
			aspect_ratio: [
				"16:9",
				"9:16",
				"1:1"
			].includes(request.aspectRatio) ? request.aspectRatio : "16:9",
			resolution: entry.modes.includes("text") && entry.modes.length === 1 ? "standard" : resolution === "1080P" ? "1080P" : "720P"
		};
		if (references.primary !== void 0 && entry.modes.includes("image")) body.image_url = dataUrlOf(references.primary);
		return body;
	}
	if (familyName === "agnes") {
		const body = {
			model: request.upstream ?? request.model,
			prompt: request.prompt,
			mode: familyMode("agnes", request.mode),
			seconds: String(seconds),
			size: resolution
		};
		if (entry.aspectRatios.includes(request.aspectRatio)) body.aspect_ratio = request.aspectRatio;
		if (request.mode === "keyframe") {
			if (references.all[0] !== void 0) body.first_frame = dataUrlOf(references.all[0]);
			if (references.all[1] !== void 0) body.last_frame = dataUrlOf(references.all[1]);
		} else if (request.mode === "image" || request.mode === "reference") {
			if (references.all.length > 0) body.images = references.all.map(dataUrlOf);
		}
		if (entry.supportsSeed && request.seed !== void 0 && Number.isFinite(request.seed)) body.seed = request.seed;
		return body;
	}
	if (familyName === "seedance") {
		const wireModelId = (request.upstream ?? request.model).trim();
		const content = [{
			type: "text",
			text: request.prompt
		}];
		const image = (reference, role) => ({
			type: "image_url",
			image_url: { url: dataUrlOf(reference) },
			role
		});
		if (request.mode === "keyframe") {
			if (references.all[0] !== void 0) content.push(image(references.all[0], "first_frame"));
			if (references.all[1] !== void 0) content.push(image(references.all[1], "last_frame"));
		} else if (request.mode === "reference") for (const reference of references.all) content.push(image(reference, "reference_image"));
		else if (request.mode === "image" && references.primary !== void 0) content.push(image(references.primary, "first_frame"));
		const body = {
			model: wireModelId,
			content,
			resolution: seedanceResolution(wireModelId, resolution),
			duration: seedanceSeconds(wireModelId, seconds),
			watermark: false
		};
		if (!/seedance[-_.]?1/i.test(wireModelId)) body.generate_audio = false;
		if (entry.aspectRatios.includes(request.aspectRatio)) body.ratio = request.aspectRatio;
		if (entry.supportsSeed && request.seed !== void 0 && Number.isFinite(request.seed)) body.seed = Math.max(-1, Math.min(2147483647, Math.round(request.seed)));
		return body;
	}
	if (familyName === "xai") {
		const body = {
			model: request.upstream ?? request.model,
			prompt: request.prompt,
			duration: seconds,
			resolution: resolution.toLowerCase()
		};
		if (entry.aspectRatios.includes(request.aspectRatio)) body.aspect_ratio = request.aspectRatio;
		if (references.primary !== void 0) body.image = { url: dataUrlOf(references.primary) };
		return body;
	}
	const body = {
		model: request.upstream ?? request.model,
		prompt: request.prompt,
		seconds: String(seconds),
		size: resolution
	};
	if (request.aspectRatio.trim() !== "") body.aspect_ratio = request.aspectRatio;
	if (references.primary !== void 0) body.image = dataUrlOf(references.primary);
	return body;
}
/**
* Generate one video: submit, poll to a terminal state, download the clip.
*
* `family` may be forced by the caller (the runtime passes the resolved
* upstream family), otherwise it is derived from the model alias.
*/
async function generateVideo(upstream, request, options = {}) {
	const model = (request.upstream ?? request.model).trim();
	if (model === "") throw new VideoGenError("未指定视频模型", "video-no-model");
	const entry = describeVideoModel(model);
	const family = options.family ?? entry.family;
	if (entry.family === "unknown" && options.family === void 0) throw new VideoGenError(`无法识别视频模型「${model}」的协议族，请在渠道中改用已知的视频模型`, "video-unknown-model");
	if (family === "unknown") throw new VideoGenError(`视频模型「${model}」的协议族未知，无法生成`, "video-unknown-model");
	const references = referencesOf(request);
	if (request.mode === "keyframe" && references.all.length === 0) throw new VideoGenError("首尾帧模式至少需要一张首帧图片", "video-bad-reference");
	if ((request.mode === "image" || request.mode === "reference") && references.primary === void 0) throw new VideoGenError(request.mode === "reference" ? "参考图模式至少需要一张参考图片" : "图生视频需要一张参考图片", "video-bad-reference");
	const baseUrl = upstream.apiUrl.replace(/\/+$/, "");
	const url = endpointUrl(upstream, baseUrl, VIDEO_PATHS[family]?.submit ?? "/videos");
	const body = submitBody(entry, family, request, references);
	const submitAttempt = videoAttempt(upstream, request, model, "video-submit", url, "POST", JSON.stringify(body));
	const submitBudget = requestSignal(options.signal, SUBMIT_TIMEOUT_MS$1);
	let taskId = "";
	try {
		const payload = await postJson(submitAttempt, request, url, upstream.apiKey, body, submitBudget.signal);
		taskId = taskIdOf(payload);
		if (taskId === "") {
			const failure = new VideoGenError(errorTextOf(payload, "视频接口未返回任务 ID"), "video-submit-failed");
			recordVideoFailure(submitAttempt, failure, { requestExcerpt: excerptOf(payload) });
			throw failure;
		}
	} finally {
		submitBudget.dispose();
	}
	const finished = await pollUntilDone(submitAttempt, upstream, baseUrl, taskId, family, options.signal);
	return { videos: [{
		...await downloadVideo({
			...submitAttempt,
			phase: "video-download",
			url: displayUrl(finished.source.url),
			method: "GET"
		}, upstream, finished.source.url, options.signal),
		...finished.duration === void 0 ? {} : { duration: finished.duration },
		...finished.poster === void 0 ? {} : { poster: finished.poster }
	}] };
}
//#endregion
//#region src/video-director.ts
/**
* Video director: turn one sentence into a plan before anything is rendered.
*
* The video pipeline used to take the prompt exactly as typed and submit it.
* A one-line request ("两个图片的人物在一起交朋友") then reached the provider as
* that same line: no shot description, no camera movement, no temporal
* structure — and a 5s/16:9/720P default the user never chose. This module is
* the missing reasoning step. It runs *before* the engine and its output is
* what the engine actually sends:
*
*   prompt  → the shot-by-shot description the provider receives
*   seconds → the clip length (may only narrow to what the family accepts)
*   aspect / resolution → the same, never widened beyond the panel's choice
*   shots   → what the panel shows back, so the decision is inspectable
*
* Two backends, one contract:
*  - `chat`: an OpenAI-compatible chat completion through the same endpoint the
*    image studio's prompt enhancement already uses (`resolvePromptModelConfig`),
*    so there is no new credential to configure.
*  - `heuristic`: a fully offline planner used when no chat model is
*    configured, and the fallback when the chat answer is unusable. It is
*    deterministic, so an offline host can still be tested end to end.
*
* The plan is a *proposal checked for validity*, not free text: every field is
* clamped to what the resolved video family accepts, so a model cannot make the
* request unsendable (a 20s clip on a 10s family, a 4:3 frame on comemoe).
*
* The prompt skeleton follows Wan 2.2's own `--use_prompt_extend` guide
* (Wan-Video/Wan2.2, Apache-2.0, `wan/utils/system_prompt.py`): subject and
* action first, then shot size, camera angle/movement, lighting, colour tone
* and style, and — for image-to-video — emphasis on motion over static scene
* description. That model is the reference implementation of the licence-clean
* open video family this plugin actually routes (`wan2.2-*` through comemoe),
* so its vocabulary is the one the provider was trained against.
*/
/** Stable wire code for a planning failure. */
var VideoPlanError = class extends Error {
	code;
	constructor(message, code = "video-plan-failed") {
		super(message);
		this.name = "VideoPlanError";
		this.code = code;
	}
};
/** Hard cap on the user's sentence, in characters. */
const MAX_PROMPT_CHARS = 4e3;
/**
* Cap on the planned prompt. Providers truncate silently past their own limit,
* and a plan longer than this is a sign the planner copied the input instead
* of distilling it. 900 chars is comfortably inside every family's budget and
* long enough for a 5-shot description.
*/
const MAX_PLANNED_PROMPT_CHARS = 900;
/** Chat budget. Planning is one small completion, not a render. */
const PLAN_TIMEOUT_MS = 45e3;
/** Reject blank input with copy that says what to do. */
function requirePrompt(prompt) {
	const value = prompt.trim();
	if (value === "") throw new VideoPlanError("视频描述为空：请先写一句你想要的画面，例如「雨夜霓虹街头，女孩回头看向镜头」", "video-prompt-empty");
	if (value.length > 4e3) throw new VideoPlanError(`视频描述过长（${value.length} 字符，上限 ${MAX_PROMPT_CHARS}）：请压缩到核心动作与场景，其余交给镜头规划`, "video-prompt-too-long");
	return value;
}
/** Whether a string carries a motion verb the planner can anchor on. */
const MOTION_HINTS = [
	"走",
	"跑",
	"跳",
	"转",
	"回头",
	"挥",
	"推",
	"拉",
	"抬",
	"坐",
	"站",
	"飞",
	"漂",
	"摇",
	"笑",
	"哭",
	"说",
	"唱",
	"舞",
	"伸",
	"闭",
	"睁",
	"落",
	"升",
	"冲",
	"拥抱",
	"打",
	"吻",
	"walk",
	"run",
	"jump",
	"turn",
	"wave",
	"push",
	"pull",
	"sit",
	"stand",
	"fly",
	"drift",
	"shake",
	"smile",
	"cry",
	"talk",
	"sing",
	"dance",
	"stretch",
	"close",
	"open",
	"fall",
	"rise",
	"hug",
	"fight",
	"kiss"
];
/** Whether the sentence already names a shot size. */
const SHOT_HINTS = [
	"特写",
	"近景",
	"中景",
	"全景",
	"远景",
	"俯拍",
	"航拍",
	"仰拍",
	"close-up",
	"medium shot",
	"wide shot",
	"aerial"
];
/** Whether the sentence already names a camera movement. */
const CAMERA_HINTS = [
	"推近",
	"拉远",
	"横移",
	"摇镜",
	"跟拍",
	"环绕",
	"手持",
	"固定机位",
	"push-in",
	"pull-back",
	"pan",
	"tracking",
	"orbit",
	"handheld"
];
/** Whether the sentence already names a look/style. */
const LOOK_HINTS = [
	"写实",
	"电影感",
	"二次元",
	"插画",
	"水彩",
	"油画",
	"赛博朋克",
	"定格动画",
	"胶片",
	"photoreal",
	"cinematic",
	"anime",
	"illustration",
	"watercolour",
	"oil painting",
	"cyberpunk",
	"stop-motion",
	"film grain"
];
function hasAny(text, hints) {
	const lower = text.toLowerCase();
	return hints.some((hint) => lower.includes(hint.toLowerCase()));
}
/** Whether the sentence contains any motion at all. */
function hasMotion(text) {
	return hasAny(text, MOTION_HINTS);
}
/**
* Split a long sentence into clauses a shot can be built from.
*
* Chinese and English both end a clause at a full stop or a comma-like pause;
* keeping the separators out means every clause is a clean phrase.
*/
function clausesOf(prompt) {
	return prompt.split(/[。；;，,、\n]+|\.\s+/).map((clause) => clause.trim()).filter((clause) => clause !== "");
}
/** The dominant language of the prompt, so the plan answers in the same one. */
function looksChinese(text) {
	const cjk = (text.match(/[\u4e00-\u9fff]/g) ?? []).length;
	return cjk > 0 && cjk >= text.replace(/\s/g, "").length / 4;
}
/** A shot plan built entirely offline from the prompt's own structure. */
function heuristicRaw(input, prompt) {
	const chinese = looksChinese(prompt);
	const clauses = clausesOf(prompt);
	const beats = clauses.length <= 1 ? [prompt] : clauses.slice(0, 6);
	const total = clampVideoSeconds(input.seconds);
	const perShot = Math.max(1, Math.round(total / beats.length));
	const moving = hasMotion(prompt);
	const camera = hasAny(prompt, CAMERA_HINTS) ? chinese ? "沿用描述中的运镜" : "keep the movement described" : chinese ? moving ? "镜头随主体缓慢跟随" : "固定机位，轻微呼吸感" : moving ? "slow tracking follow" : "locked-off camera with a slight drift";
	const look = hasAny(prompt, LOOK_HINTS) ? void 0 : chinese ? "写实电影感" : "photoreal cinematic";
	const shotLanguage = hasAny(prompt, SHOT_HINTS) ? chinese ? "沿用描述中的景别与光线" : "keep the shot size and lighting described" : chinese ? "中景为主，按动作切近景" : "medium shot, cutting to a close-up on the action";
	return {
		...look === void 0 ? {} : { look },
		shotLanguage,
		pacing: moving ? .6 : .35,
		shots: beats.map((beat, index) => ({
			shot: chinese ? `第 ${index + 1} 个画面：${beat}` : `Shot ${index + 1}: ${beat}`,
			action: moving ? beat : chinese ? `${beat}（主体轻微动作，背景有自然流动）` : `${beat} (subtle subject movement, living background)`,
			camera,
			seconds: perShot
		})),
		seconds: total
	};
}
/** Render a raw plan into one prompt string the provider can be given. */
function renderPrompt(raw, input) {
	const chinese = looksChinese(input.prompt);
	const parts = [];
	if (raw.look !== void 0 && raw.look !== "") parts.push(raw.look);
	if (raw.shotLanguage !== void 0 && raw.shotLanguage !== "") parts.push(raw.shotLanguage);
	const shots = raw.shots.map((shot, index) => {
		const subject = (shot.shot ?? "").trim();
		const pieces = [
			subject,
			(shot.action ?? "").trim(),
			(shot.camera ?? "").trim()
		].filter((piece) => piece !== "");
		if (pieces.length === 0) return "";
		return /^(?:shot\s*\d+|第\s*\d+\s*个画面)/i.test(subject) || subject === "" ? pieces.join(chinese ? "；" : "; ") : `${chinese ? `第 ${index + 1} 个画面` : `Shot ${index + 1}`}${chinese ? "：" : ": "}${pieces.join(chinese ? "；" : "; ")}`;
	}).filter((line) => line !== "");
	parts.push(...shots);
	if (input.mode !== "text") parts.push(chinese ? "以参考图中的主体与构图为基准，强调动作过程，不复述静态场景" : "Anchor on the reference frame's subject and composition; emphasise the action, do not restate the static scene");
	const text = parts.join(chinese ? "。" : ". ").replace(/\s+/g, " ").trim();
	return text === "" ? input.prompt : text;
}
/** Clamp one duration onto the step the family actually accepts. */
function clampToFamilySeconds(seconds, entry) {
	const clamped = clampVideoSeconds(seconds);
	const offered = [5, 10];
	if (offered.includes(clamped)) return clamped;
	const nearest = offered.reduce((best, candidate) => Math.abs(candidate - clamped) < Math.abs(best - clamped) ? candidate : best, offered[0]);
	return Math.min(nearest, clamped) >= 1 ? Math.min(nearest, clamped) : clamped;
}
/**
* Apply a raw plan to a request and produce the validated plan.
*
* Every widening is refused here, which is what makes the result safe to feed
* straight into the engine: the request the user typed is the ceiling.
*/
function finalize(raw, input, source, degradedReason) {
	const entry = describeVideoModel(input.model);
	const notes = [];
	let degraded = degradedReason !== void 0;
	let prompt = (raw.prompt ?? "").trim();
	if (prompt === "") prompt = renderPrompt(raw, input);
	if (prompt.length > 900) {
		const cut = prompt.slice(0, 900);
		const boundary = Math.max(cut.lastIndexOf("。"), cut.lastIndexOf(". "), cut.lastIndexOf("；"), cut.lastIndexOf("; "));
		prompt = boundary > 900 * .6 ? cut.slice(0, boundary) : cut;
		notes.push(`规划提示词超长，已截断到 900 字符`);
		degraded = true;
	}
	const requested = clampVideoSeconds(input.seconds);
	const planned = raw.seconds === void 0 ? requested : clampToFamilySeconds(raw.seconds, entry);
	const seconds = Math.max(1, Math.min(planned, requested));
	if (seconds !== requested) notes.push(`时长按镜头节奏收紧为 ${seconds}s（原 ${requested}s）`);
	let aspectRatio = input.aspectRatio.trim() === "" ? "16:9" : input.aspectRatio.trim();
	const wantedAspect = (raw.aspectRatio ?? "").trim();
	if (wantedAspect !== "" && wantedAspect !== aspectRatio && (entry.aspectRatios.length === 0 || entry.aspectRatios.includes(wantedAspect))) {
		aspectRatio = wantedAspect;
		notes.push(`画幅调整为 ${wantedAspect}`);
	}
	let resolution = input.resolution;
	const wantedResolution = (raw.resolution ?? "").trim().toUpperCase();
	if (wantedResolution !== "" && wantedResolution !== resolution && entry.resolutions.includes(wantedResolution)) {
		const order = [
			"480P",
			"720P",
			"1080P"
		];
		if (order.indexOf(wantedResolution) < order.indexOf(resolution)) {
			resolution = wantedResolution;
			notes.push(`分辨率降为 ${resolution} 以缩短出片时间`);
		}
	}
	const shots = raw.shots.slice(0, 6).map((shot, index) => ({
		index: index + 1,
		shot: (shot.shot ?? "").trim() || (looksChinese(input.prompt) ? `第 ${index + 1} 个画面` : `Shot ${index + 1}`),
		action: (shot.action ?? "").trim(),
		camera: (shot.camera ?? "").trim(),
		seconds: Math.max(1, Math.round(shot.seconds ?? seconds / Math.max(1, raw.shots.length)))
	}));
	return {
		source,
		style: {
			shotLanguage: (raw.shotLanguage ?? "").trim(),
			look: (raw.look ?? "").trim(),
			pacing: typeof raw.pacing === "number" && Number.isFinite(raw.pacing) ? Math.min(1, Math.max(0, raw.pacing)) : .5
		},
		shots: shots.length > 0 ? shots : [{
			index: 1,
			shot: input.prompt,
			action: input.prompt,
			camera: "",
			seconds
		}],
		prompt,
		params: {
			seconds,
			aspectRatio,
			resolution
		},
		notes,
		degraded,
		...degradedReason === void 0 ? {} : { degradedReason }
	};
}
/** The offline plan. Always succeeds for non-empty input. */
function planVideoLocally(input) {
	const prompt = requirePrompt(input.prompt);
	return finalize(heuristicRaw(input, prompt), {
		...input,
		prompt
	}, "heuristic");
}
/** The system prompt the chat backend is given. */
function directorSystemPrompt(chinese) {
	const shape = `{"look":"…","shotLanguage":"…","pacing":0.0,"shots":[{"shot":"…","action":"…","camera":"…","seconds":5}],"prompt":"…","seconds":5,"aspectRatio":"16:9","resolution":"720P"}`;
	if (chinese) return [
		"你是视频导演。把用户的一句话需求拆成镜头、动作、运镜、时长、风格，并落成可直接送给视频模型的一条提示词。",
		"规则：",
		"1. 不改变用户的原意（主体、动作、数量、语言）；不添加用户没有提到的新主体。",
		"2. 提示词结构：先风格，再景别/光线，然后按镜头顺序写「第 N 个画面：主体 + 动作过程 + 运镜」。动作要写出过程，而不是只给静态描述。",
		"3. 若用户没写运镜，补一个克制的运镜（固定机位微呼吸、缓慢推近、横向跟拍等）；若用户写了，则沿用。",
		"4. 若用户没写风格，不要强加；确有需要时给一个中性的写实电影感。",
		"5. 不要写\"氛围\"\"张力\"\"美感\"这类空泛形容；不要写台词、字幕、水印。",
		"6. 总时长不得超过用户给定的秒数上限；每镜 seconds 之和应接近总时长。",
		"7. 只输出一个 JSON 对象，不要 Markdown、不要解释：",
		shape,
		"字段含义：look=视觉风格；shotLanguage=景别与光线；pacing=节奏 0..1；shots=镜头列表；prompt=最终提示词（不超过 900 字）；seconds/aspectRatio/resolution=建议参数（时长不得超过用户值）。"
	].join("\n");
	return [
		"You are a video director. Turn one sentence into shots, motion, camera work, duration and style, and produce the single prompt a video model can be given.",
		"Rules:",
		"1. Preserve the request's subject, action, count and language; never add a subject the user did not mention.",
		"2. Prompt structure: style first, then shot size / lighting, then each shot in order as \"Shot N: subject + action process + camera\". Describe the motion as a process, not a still.",
		"3. If the user named no camera movement, add a restrained one (locked-off with a slight drift, slow push-in, lateral tracking); if they did, keep it.",
		"4. If the user named no style, do not invent one beyond a neutral photoreal cinematic look when needed.",
		"5. No mood words (\"cinematic tension\", \"beautiful atmosphere\"), no dialogue, subtitles or watermarks.",
		"6. Total duration must not exceed the user's chosen seconds; per-shot seconds should add up to roughly the total.",
		"7. Output exactly one JSON object — no markdown, no explanation:",
		shape,
		"Fields: look = visual style; shotLanguage = shot size and lighting; pacing = 0..1; shots = the shot list; prompt = the final prompt (under 900 characters); seconds/aspectRatio/resolution = proposed params (duration must not exceed the user value)."
	].join("\n");
}
/** Parse one chat answer into a RawPlan, tolerating fences and stray prose. */
function parsePlanAnswer(answer) {
	const cleaned = answer.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
	const start = cleaned.indexOf("{");
	const end = cleaned.lastIndexOf("}");
	if (start < 0 || end <= start) return {
		ok: false,
		reason: "no-json"
	};
	let parsed;
	try {
		parsed = JSON.parse(cleaned.slice(start, end + 1));
	} catch {
		return {
			ok: false,
			reason: "invalid-json"
		};
	}
	if (parsed === null || typeof parsed !== "object") return {
		ok: false,
		reason: "not-an-object"
	};
	const record = parsed;
	const shots = (Array.isArray(record.shots) ? record.shots : []).flatMap((item) => {
		if (item === null || typeof item !== "object") return [];
		const shot = item;
		const read = (key) => typeof shot[key] === "string" && shot[key].trim() !== "" ? shot[key].trim() : void 0;
		const seconds = typeof shot.seconds === "number" && Number.isFinite(shot.seconds) ? shot.seconds : void 0;
		return [{
			...read("shot") === void 0 ? {} : { shot: read("shot") },
			...read("action") === void 0 ? {} : { action: read("action") },
			...read("camera") === void 0 ? {} : { camera: read("camera") },
			...seconds === void 0 ? {} : { seconds }
		}];
	});
	const text = (key) => typeof record[key] === "string" && record[key].trim() !== "" ? record[key].trim() : void 0;
	const number = (key) => typeof record[key] === "number" && Number.isFinite(record[key]) ? record[key] : void 0;
	const plan = {
		shots,
		...text("prompt") === void 0 ? {} : { prompt: text("prompt") },
		...text("look") === void 0 ? {} : { look: text("look") },
		...text("shotLanguage") === void 0 ? {} : { shotLanguage: text("shotLanguage") },
		...text("aspectRatio") === void 0 ? {} : { aspectRatio: text("aspectRatio") },
		...text("resolution") === void 0 ? {} : { resolution: text("resolution") },
		...number("pacing") === void 0 ? {} : { pacing: number("pacing") },
		...number("seconds") === void 0 ? {} : { seconds: number("seconds") }
	};
	if (plan.prompt === void 0 && plan.shots.length === 0) return {
		ok: false,
		reason: "no-content"
	};
	return {
		ok: true,
		plan
	};
}
/**
* Plan one video through the configured chat model.
*
* Failure policy: a *configuration* problem (no model, unreachable endpoint)
* raises {@link VideoPlanError} so the user is told why nothing was planned —
* silently rendering the raw sentence is exactly the behaviour this feature
* exists to remove. A *content* problem (the model answered prose, or JSON
* outside the schema) keeps the plan but marks it `degraded`, because the
* offline planner still produces a usable shot list from the same sentence.
*
* @param input - the request as collected, before the engine sees it.
* @param config - resolved chat endpoint (same one prompt enhancement uses).
* @param complete - chat call, or undefined when no chat model is configured.
* @param signal - caller cancellation; a cancelled plan is reported as cancelled.
* @returns a validated plan whose params never exceed the request's own.
*/
async function planVideo(input, config, complete, signal) {
	const prompt = requirePrompt(input.prompt);
	const chinese = looksChinese(prompt);
	if (!(config !== void 0 && config.model.trim() !== "" && config.apiUrl.trim() !== "") || complete === void 0) return finalize(heuristicRaw(input, prompt), {
		...input,
		prompt
	}, "heuristic", "未配置对话模型，使用离线镜头规划");
	const bounded = AbortSignal.timeout(PLAN_TIMEOUT_MS);
	const combined = signal === void 0 ? bounded : AbortSignal.any([signal, bounded]);
	const reference = input.mode === "text" ? "" : chinese ? `\n\n本视频带参考图（模式 ${input.mode}）：描述应以图中的主体与构图为基准，强调动作，不要复述静态画面。` : `\n\nThis run carries a reference frame (mode ${input.mode}): anchor on its subject and composition, emphasise motion, and do not restate the static scene.`;
	const request = `${chinese ? "用户需求" : "Request"}: ${prompt}\n${chinese ? "参数上限" : "Param ceiling"}: seconds<=${clampVideoSeconds(input.seconds)}, aspectRatio=${input.aspectRatio}, resolution=${input.resolution}${reference}`;
	let answer;
	try {
		answer = await complete({
			system: directorSystemPrompt(chinese),
			content: request,
			temperature: .4,
			maxTokens: 1200,
			signal: combined
		});
	} catch (error) {
		if (signal?.aborted === true) throw new VideoPlanError("视频规划已取消", "video-plan-cancelled");
		const reason = error instanceof Error ? error.message : String(error);
		return finalize(heuristicRaw(input, prompt), {
			...input,
			prompt
		}, "heuristic", `对话模型调用失败（${reason}），已改用离线规划`);
	}
	const outcome = parsePlanAnswer(answer);
	if (!outcome.ok) {
		const reasonZh = {
			"no-json": "回复里没有 JSON",
			"invalid-json": "JSON 语法无效",
			"not-an-object": "JSON 不是对象",
			"no-content": "JSON 里没有可用的提示词或镜头"
		};
		return finalize(heuristicRaw(input, prompt), {
			...input,
			prompt
		}, "heuristic", `对话模型返回的规划不可用（${reasonZh[outcome.reason]}），已改用离线规划`);
	}
	const raw = outcome.plan;
	const planned = (raw.prompt ?? "").trim();
	if (planned !== "" && planned.length <= prompt.length + 8) {
		const repaired = heuristicRaw(input, prompt);
		return finalize({
			...repaired,
			...raw.shots.length > 0 ? {} : { shots: repaired.shots }
		}, {
			...input,
			prompt
		}, "chat", "对话模型只复述了原描述，已补充镜头与运镜");
	}
	return finalize(raw, {
		...input,
		prompt
	}, "chat");
}
/**
* Apply a plan to a request. Returns the request the engine must receive.
*
* Only the fields a plan controls are replaced; reference frames, channel and
* canvas lineage pass through untouched, so this cannot break the modes that
* carry images.
*/
function applyPlan(request, plan) {
	return {
		...request,
		prompt: plan.prompt,
		seconds: plan.params.seconds,
		aspectRatio: plan.params.aspectRatio,
		resolution: plan.params.resolution
	};
}
/** Cap on a plan prompt that arrived over the wire. */
const MAX_ADOPTED_PROMPT_CHARS = 900;
/**
* Adopt a plan the client already previewed, re-validated against this request.
*
* A previewed plan travels over the wire, so it is untrusted input: the prompt
* length, the family's accepted duration/aspect/resolution and the user's own
* ceiling are all re-checked here. Without this, a caller could hand the engine
* a 30s render where the user asked for 5s — the exact class of bug the
* director is supposed to prevent.
*
* @param request - the submitted request, including `planPreview`.
* @param model - the resolved upstream model id (the family is read from it).
*/
function adoptPlan(request, model) {
	const preview = request.planPreview;
	if (preview === void 0) throw new VideoPlanError("预览规划缺失", "video-plan-invalid");
	const entry = describeVideoModel(model);
	const notes = [...preview.notes ?? []];
	let prompt = (preview.prompt ?? "").trim();
	if (prompt === "") throw new VideoPlanError("预览规划里没有提示词", "video-plan-invalid");
	if (prompt.length > MAX_ADOPTED_PROMPT_CHARS) {
		prompt = prompt.slice(0, MAX_ADOPTED_PROMPT_CHARS);
		notes.push(`规划提示词超长，已截断到 ${MAX_ADOPTED_PROMPT_CHARS} 字符`);
	}
	const requestedSeconds = clampVideoSeconds(request.seconds);
	const plannedSeconds = typeof preview.params?.seconds === "number" && Number.isFinite(preview.params.seconds) ? clampVideoSeconds(preview.params.seconds) : requestedSeconds;
	const seconds = Math.max(1, Math.min(plannedSeconds, requestedSeconds));
	if (seconds !== requestedSeconds) notes.push(`时长按镜头节奏收紧为 ${seconds}s（原 ${requestedSeconds}s）`);
	const wantedAspect = (preview.params?.aspectRatio ?? "").trim();
	const aspectRatio = wantedAspect !== "" && (entry.aspectRatios.length === 0 || entry.aspectRatios.includes(wantedAspect)) ? wantedAspect : request.aspectRatio;
	const wantedResolution = (preview.params?.resolution ?? "").trim().toUpperCase();
	const order = [
		"480P",
		"720P",
		"1080P"
	];
	const resolution = entry.resolutions.includes(wantedResolution) && order.indexOf(wantedResolution) < order.indexOf(request.resolution) ? wantedResolution : request.resolution;
	const shots = Array.isArray(preview.shots) ? preview.shots.slice(0, 6).map((shot, index) => ({
		index: index + 1,
		shot: String(shot?.shot ?? "").trim(),
		action: String(shot?.action ?? "").trim(),
		camera: String(shot?.camera ?? "").trim(),
		seconds: Math.max(1, Math.round(Number(shot?.seconds) || seconds))
	})) : [];
	return {
		source: preview.source === "chat" ? "chat" : "heuristic",
		style: {
			shotLanguage: String(preview.style?.shotLanguage ?? "").trim(),
			look: String(preview.style?.look ?? "").trim(),
			pacing: Number.isFinite(preview.style?.pacing) ? Math.min(1, Math.max(0, preview.style.pacing)) : .5
		},
		shots,
		prompt,
		params: {
			seconds,
			aspectRatio,
			resolution
		},
		notes,
		degraded: preview.degraded === true,
		...preview.degradedReason === void 0 ? {} : { degradedReason: preview.degradedReason }
	};
}
//#endregion
//#region src/image-storage-path.ts
const DEFAULT_ROOT = path.join(process.env.DSH_HOME?.trim() || path.join(homedir(), ".dsh"), "dsh-imagegen-studio");
let root = DEFAULT_ROOT;
function imageDataRoot() {
	return root;
}
function setImageDataRoot(value) {
	const trimmed = value?.trim();
	root = trimmed === void 0 || trimmed === "" ? DEFAULT_ROOT : path.resolve(expandHome(trimmed));
}
/**
* Expand a leading `~` before the path is resolved.
*
* The setting is typed by hand into the settings form, where `~/my-images` is
* the natural thing to write. `path.resolve` does NOT expand it, so without
* this the host would create a directory literally named `~` under the
* process's working directory and store everything there — while the user
* looked in their home folder and found nothing.
*/
function expandHome(value) {
	if (value === "~") return homedir();
	if (value.startsWith("~/") || value.startsWith("~\\")) return path.join(homedir(), value.slice(2));
	return value;
}
//#endregion
//#region src/video-store.ts
/**
* Host-persisted video history: finished clips are stored as individual files
* under ~/.dsh/dsh-imagegen-studio/videos/ and an index.json keeps the metadata +
* file names. This mirrors `history-store.ts`, which does the same for images.
*
* The split exists for one hard reason: a rendered clip is orders of magnitude
* larger than a generated image, so video can never travel inline in a JSON
* response the way image base64 does. The list route returns metadata only and
* the browser pulls bytes lazily through the video file route, which also
* supports Range so the <video> element can seek.
*
* Framework-free (node:fs only) so the route layer can drive it directly.
*/
/** Cap on retained video entries (clips are large: keep the list short). */
const VIDEO_HISTORY_MAX = 30;
function videoRoot() {
	return path.join(imageDataRoot(), "videos");
}
function indexPath$2() {
	return path.join(videoRoot(), "index.json");
}
function filesDir() {
	return path.join(videoRoot(), "files");
}
let pendingMutation$2 = Promise.resolve();
function mutateVideos(operation) {
	const next = pendingMutation$2.then(operation, operation);
	pendingMutation$2 = next.then(() => void 0, () => void 0);
	return next;
}
/** File extension for a video MIME type. */
function extensionOf$5(mime) {
	switch (mime.split(";")[0].trim().toLowerCase()) {
		case "video/webm": return "webm";
		case "video/quicktime": return "mov";
		case "video/x-matroska": return "mkv";
		default: return "mp4";
	}
}
/** MIME type for a stored clip file name. */
function mimeOfFile$3(file) {
	switch (path.extname(file).toLowerCase()) {
		case ".webm": return "video/webm";
		case ".mov": return "video/quicktime";
		case ".mkv": return "video/x-matroska";
		default: return "video/mp4";
	}
}
/** Sanitize an entry id for use as a file-name prefix. */
function safeId$3(id) {
	const cleaned = id.replace(/[^a-zA-Z0-9-]/g, "-");
	return cleaned === "" ? "video" : cleaned;
}
/** Ensure the storage directories exist. */
async function ensureDirs$2() {
	await promises.mkdir(filesDir(), { recursive: true });
}
/** Read the index, tolerating a missing/corrupt file. */
async function readIndex$2() {
	try {
		const raw = await promises.readFile(indexPath$2(), "utf8");
		const parsed = JSON.parse(raw);
		if (parsed === null || typeof parsed !== "object") return [];
		const entries = parsed.entries;
		if (!Array.isArray(entries)) return [];
		return entries.filter(isStoredEntry$2);
	} catch {
		return [];
	}
}
/** Persist the index. */
async function writeIndex$2(entries) {
	await ensureDirs$2();
	const payload = { entries };
	const tmp = `${indexPath$2()}.tmp-${process.pid}`;
	await promises.writeFile(tmp, JSON.stringify(payload), "utf8");
	await promises.rename(tmp, indexPath$2());
}
/** Structural guard for a stored entry. */
function isStoredEntry$2(value) {
	if (value === null || typeof value !== "object") return false;
	const entry = value;
	return typeof entry.id === "string" && typeof entry.createdAt === "number" && typeof entry.prompt === "string" && Array.isArray(entry.videos) && entry.videos.every((video) => {
		if (video === null || typeof video !== "object") return false;
		const record = video;
		return typeof record.file === "string" && typeof record.mime === "string";
	});
}
/** Remove one entry's clip files (best effort). */
async function removeEntryFiles$2(entry) {
	for (const video of entry.videos) try {
		await promises.rm(path.join(filesDir(), video.file), { force: true });
	} catch {}
}
/** The same-origin URL for one stored clip. */
function fileUrl(file) {
	return `${VIDEO_API.file}/${file}`;
}
/** Project a stored entry onto the wire shape (served URLs, no bytes). */
function toWire$2(entry) {
	return {
		id: entry.id,
		createdAt: entry.createdAt,
		mode: entry.mode,
		model: entry.model,
		prompt: entry.prompt,
		aspectRatio: entry.aspectRatio,
		resolution: entry.resolution,
		seconds: entry.seconds,
		videos: entry.videos.map((video) => ({
			url: fileUrl(video.file),
			mime: video.mime,
			...video.duration === void 0 ? {} : { duration: video.duration },
			...video.poster === void 0 ? {} : { poster: video.poster },
			...video.revisedPrompt === void 0 ? {} : { revisedPrompt: video.revisedPrompt }
		})),
		...entry.refName === void 0 ? {} : { refName: entry.refName },
		...entry.channelId === void 0 ? {} : { channelId: entry.channelId },
		...entry.channel === void 0 ? {} : { channel: entry.channel },
		...entry.plan === void 0 ? {} : { plan: entry.plan },
		...entry.renderer === void 0 ? {} : { renderer: entry.renderer }
	};
}
/** List the persisted video history, newest first. */
async function listVideoHistory() {
	return (await readIndex$2()).map(toWire$2);
}
/**
* Persist one generated clip.
*
* The engine has already downloaded the bytes, so the caller passes them here
* rather than a URL: this keeps the store free of network access and means a
* clip that never downloaded can never appear in the history.
*/
async function appendVideoHistory(input) {
	return mutateVideos(async () => {
		await ensureDirs$2();
		const prefix = safeId$3(input.id);
		const stored = [];
		try {
			for (let index = 0; index < input.files.length; index++) {
				const file = input.files[index];
				const name = `${prefix}-${index}.${extensionOf$5(file.mime)}`;
				await promises.writeFile(path.join(filesDir(), name), file.bytes);
				stored.push({
					file: name,
					mime: file.mime,
					...file.duration === void 0 ? {} : { duration: file.duration },
					...file.poster === void 0 ? {} : { poster: file.poster },
					...file.revisedPrompt === void 0 ? {} : { revisedPrompt: file.revisedPrompt }
				});
			}
		} catch (error) {
			await removeEntryFiles$2({ videos: stored });
			throw error;
		}
		if (stored.length === 0) throw new Error("没有可保存的视频内容");
		const merged = [{
			id: input.id,
			createdAt: input.createdAt,
			mode: input.mode,
			model: input.model,
			prompt: input.prompt,
			aspectRatio: input.aspectRatio,
			resolution: input.resolution,
			seconds: input.seconds,
			videos: stored,
			...input.refName === void 0 ? {} : { refName: input.refName },
			...input.channelId === void 0 ? {} : { channelId: input.channelId },
			...input.channel === void 0 ? {} : { channel: input.channel },
			...input.plan === void 0 ? {} : { plan: input.plan },
			...input.renderer === void 0 ? {} : { renderer: input.renderer }
		}, ...await readIndex$2()];
		const kept = merged.slice(0, 30);
		for (const dropped of merged.slice(30)) await removeEntryFiles$2(dropped);
		await writeIndex$2(kept);
		return kept.map(toWire$2);
	});
}
/** Remove one entry (and its clip files). */
async function removeVideoHistory(id) {
	return mutateVideos(async () => {
		const previous = await readIndex$2();
		const target = previous.find((entry) => entry.id === id);
		if (target !== void 0) await removeEntryFiles$2(target);
		const kept = previous.filter((entry) => entry.id !== id);
		await writeIndex$2(kept);
		return kept.map(toWire$2);
	});
}
/** Remove every entry (and all clip files). */
async function clearVideoHistory() {
	return mutateVideos(async () => {
		const previous = await readIndex$2();
		for (const entry of previous) await removeEntryFiles$2(entry);
		await writeIndex$2([]);
		return [];
	});
}
/**
* Read one stored clip by its (validated) file name.
*
* The pattern is exactly what this store writes — `<id>-<index>.<ext>` — so
* the route can never escape the files directory through `..` or an absolute
* path, and `size` is returned so the route can answer Range requests.
*/
async function readVideoFile(file) {
	if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*-[0-9]+\.(mp4|webm|mov|mkv)$/.test(file)) return void 0;
	const absolute = path.join(filesDir(), file);
	try {
		const stat = await promises.stat(absolute);
		if (!stat.isFile()) return void 0;
		return {
			path: absolute,
			size: stat.size,
			mime: mimeOfFile$3(file)
		};
	} catch {
		return;
	}
}
//#endregion
//#region src/subscription/oauth.ts
/**
* OAuth primitives shared by the subscription vendors.
*
* Adapted from @goodandready/dsh-subscriptions (MIT, (c) 2026 GooDAnDReaDY)
* lib/oauth.js, lib/pkce.js, lib/jwt.js — PKCE generation, authorize-URL
* building and the JWT payload reads the vendors need for identity headers.
*/
async function createPkce() {
	const verifier = Buffer.from(randomBytes(32)).toString("base64url");
	return {
		verifier,
		challenge: Buffer.from(createHash("sha256").update(verifier).digest()).toString("base64url"),
		state: Buffer.from(randomBytes(16)).toString("base64url")
	};
}
/** Build an authorization-code URL with PKCE and optional extra params. */
function buildAuthorizeUrl(input) {
	const url = new URL(input.authUrl);
	url.searchParams.set("response_type", "code");
	url.searchParams.set("client_id", input.clientId);
	url.searchParams.set("redirect_uri", input.redirectUri);
	url.searchParams.set("code_challenge", input.challenge);
	url.searchParams.set("code_challenge_method", "S256");
	url.searchParams.set("state", input.state);
	if (input.scope !== void 0 && input.scope.length > 0) url.searchParams.set("scope", input.scope);
	if (input.extra !== void 0) for (const [key, value] of Object.entries(input.extra)) {
		if (value === null || value === void 0 || value === "") continue;
		url.searchParams.set(key, String(value));
	}
	return url.toString();
}
/** Decode a JWT payload without signature verification (identity read only). */
function decodeJwtPayload(token) {
	const parts = String(token ?? "").split(".");
	if (parts.length < 2) return void 0;
	try {
		const json = Buffer.from(parts[1], "base64url").toString("utf8");
		const parsed = JSON.parse(json);
		return typeof parsed === "object" && parsed !== null ? parsed : void 0;
	} catch {
		return;
	}
}
/** The chatgpt-account-id a Codex API call must carry. */
function chatgptAccountId(token) {
	const payload = decodeJwtPayload(token);
	if (payload === void 0) return "";
	if (typeof payload.chatgpt_account_id === "string") return payload.chatgpt_account_id;
	const nested = payload["https://api.openai.com/auth"];
	if (typeof nested === "object" && nested !== null && typeof nested.chatgpt_account_id === "string") return nested.chatgpt_account_id;
	const orgs = payload.organizations;
	if (Array.isArray(orgs) && orgs[0] !== null && typeof orgs[0] === "object" && typeof orgs[0].id === "string") return orgs[0].id;
	return "";
}
/** The account email for badges and login confirmation. */
function emailFromToken(token) {
	const payload = decodeJwtPayload(token);
	if (payload === void 0) return "";
	const email = payload.email;
	const preferred = payload.preferred_username;
	if (typeof email === "string" && email.length > 0) return email;
	if (typeof preferred === "string") return preferred;
	return "";
}
/** POST an OAuth token endpoint with form encoding; 25s cap like the source. */
async function formTokenRequest(url, params, fetchImpl) {
	const response = await fetchImpl(url, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			Accept: "application/json"
		},
		body: new URLSearchParams(params).toString(),
		signal: AbortSignal.timeout(25e3)
	});
	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(`token endpoint HTTP ${String(response.status)}${text.length > 0 ? `: ${text.slice(0, 200)}` : ""}`);
	}
	try {
		const parsed = await response.json();
		return typeof parsed === "object" && parsed !== null ? parsed : {};
	} catch {
		return {};
	}
}
//#endregion
//#region src/subscription/loopback.ts
/**
* Temporary loopback server that catches the OAuth redirect on a vendor-fixed
* local port and hands the code to a handler.
*
* Adapted from @goodandready/dsh-subscriptions (MIT, (c) 2026 GooDAnDReaDY)
* lib/loopback.js — same protocol (first matching request wins, server shuts
* down, 10-minute cap), restated in TypeScript with this bundle's style.
*/
const OK_HTML = "<!doctype html><meta charset=\"utf-8\"><title>dsh-image-gen</title><p>登录成功，可以关闭此页返回设置。</p>";
const ERR_HTML = "<!doctype html><meta charset=\"utf-8\"><title>dsh-image-gen</title><p>登录失败，请返回设置重试。</p>";
/**
* Loopback addresses accepted by the request handler. On dual-stack systems
* Node reports IPv4-mapped IPv6 addresses as `::ffff:127.0.0.1`, so we must
* accept that form in addition to the canonical IPv4 and IPv6 loopback.
*/
const LOOPBACK_ADDRESSES = /* @__PURE__ */ new Set([
	"127.0.0.1",
	"::1",
	"::ffff:127.0.0.1"
]);
/**
* Listen on the redirect_uri's port and resolve when the provider calls back.
* Rejects on port conflicts, network errors, or when nothing arrives in time.
*/
function startLoopback(options) {
	const parsed = new URL(options.redirectUri);
	if (parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") return Promise.reject(/* @__PURE__ */ new Error(`loopback redirect requires localhost, got ${parsed.hostname}`));
	const port = Number(parsed.port) || 80;
	const path = parsed.pathname;
	const timeoutMs = options.timeoutMs ?? 600 * 1e3;
	const state = { done: false };
	return new Promise((resolve, reject) => {
		const server = http.createServer((req, res) => {
			const remote = req.socket.remoteAddress ?? "";
			if (!LOOPBACK_ADDRESSES.has(remote)) {
				res.writeHead(403);
				res.end();
				return;
			}
			const url = new URL(req.url ?? "/", `http://127.0.0.1:${String(port)}`);
			if (!url.pathname.startsWith(path)) {
				res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
				res.end(ERR_HTML);
				return;
			}
			if (state.done) return;
			state.done = true;
			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
			Promise.resolve(options.onCode(url.searchParams)).then((html) => {
				res.end(html.length > 0 ? html : OK_HTML);
			}).catch(() => {
				res.end(ERR_HTML);
			}).finally(() => {
				clearTimeout(timer);
				server.close();
				resolve({ ok: true });
			});
		});
		server.on("error", (error) => {
			const failure = error instanceof Error ? error : new Error(String(error));
			options.onError?.(failure);
			if (state.done) return;
			state.done = true;
			clearTimeout(timer);
			reject(failure);
		});
		const timer = setTimeout(() => {
			if (state.done) return;
			state.done = true;
			server.close();
			reject(/* @__PURE__ */ new Error("loopback timeout: no callback received"));
		}, timeoutMs);
		server.listen(port, () => {
			options.onReady?.();
		});
	});
}
//#endregion
//#region src/subscription/blob.ts
/**
* OAuth token blob persistence for subscription accounts.
*
* Adapted from @goodandready/dsh-subscriptions (MIT, (c) 2026 GooDAnDReaDY)
* lib/blob.js — trimmed to the two image vendors this plugin ships. The blob
* is stored through the DSH Credentials service under a provider-scoped ref
* (see refs.ts); it never reaches the browser side.
*/
function asString(value) {
	return value === null || value === void 0 ? "" : String(value);
}
/** Serialize a blob for storage; at least one token must be present. */
function serializeBlob(obj) {
	const accessToken = asString(obj.accessToken);
	const refreshToken = asString(obj.refreshToken);
	if (accessToken.length === 0 && refreshToken.length === 0) throw new Error("oauth blob needs accessToken or refreshToken");
	return JSON.stringify({
		accessToken,
		refreshToken,
		expiresAt: Number(obj.expiresAt) || 0,
		label: asString(obj.label),
		email: asString(obj.email),
		accountId: asString(obj.accountId)
	});
}
/** Parse a stored blob back; invalid input throws. */
function parseBlob(text) {
	const obj = typeof text === "string" ? JSON.parse(text) : text;
	if (typeof obj !== "object" || obj === null) throw new Error("invalid oauth blob");
	const row = obj;
	return {
		accessToken: asString(row.accessToken),
		refreshToken: asString(row.refreshToken),
		expiresAt: Number(row.expiresAt) || 0,
		label: asString(row.label),
		email: asString(row.email),
		accountId: asString(row.accountId)
	};
}
//#endregion
//#region src/subscription/vendors/codex.ts
/**
* ChatGPT (Codex) subscription image vendor.
*
* Adapted from @goodandready/dsh-subscriptions (MIT, (c) 2026 GooDAnDReaDY)
* lib/vendors/codex.js and lib/images.js — only the pieces the image channel
* needs: authorize URL, code exchange, refresh, and the generations call.
* The device-code flow and chat streaming stay out of this bundle.
*/
const CODEX_AUTH = "https://auth.openai.com/oauth/authorize";
const CODEX_TOKEN = "https://auth.openai.com/oauth/token";
const CODEX_SCOPE = "openid profile email offline_access api.connectors.read api.connectors.invoke";
/** Where the ChatGPT subscription image request goes. */
const CODEX_IMAGE_URL = "https://chatgpt.com/backend-api/codex/images/generations";
/** Where the ChatGPT subscription image edit request goes. */
const CODEX_IMAGE_EDIT_URL = "https://chatgpt.com/backend-api/codex/images/edits";
/** The model served by this endpoint (probed live: gpt-image-2.5-flare works
* on the ChatGPT internal generations route as of 2026-09-14). */
const CODEX_IMAGE_MODEL = "gpt-image-2.5-flare";
/** Public client id of the Codex CLI; vendor-fixed redirect on port 1455. */
const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_REDIRECT_URI = "http://localhost:1455/auth/callback";
function codexConfig() {
	return {
		clientId: CODEX_CLIENT_ID,
		redirectUri: CODEX_REDIRECT_URI
	};
}
function codexAuthorizeUrl(cfg, pkce) {
	return buildAuthorizeUrl({
		authUrl: CODEX_AUTH,
		clientId: cfg.clientId,
		redirectUri: cfg.redirectUri,
		challenge: pkce.challenge,
		state: pkce.state,
		scope: CODEX_SCOPE,
		extra: {
			id_token_add_organizations: "true",
			codex_cli_simplified_flow: "true",
			originator: "codex_cli_rs"
		}
	});
}
/** Identity fields every Codex API call must carry. */
function codexIdentityHeaders(blob) {
	return {
		authorization: `Bearer ${blob.accessToken}`,
		"chatgpt-account-id": blob.accountId,
		originator: "codex_cli_rs",
		"content-type": "application/json",
		accept: "application/json"
	};
}
function decorate(blob, json) {
	const idToken = typeof json.id_token === "string" ? json.id_token : "";
	return {
		...blob,
		accountId: blob.accountId.length > 0 ? blob.accountId : chatgptAccountId(idToken) || chatgptAccountId(blob.accessToken),
		email: blob.email.length > 0 ? blob.email : emailFromToken(idToken) || emailFromToken(blob.accessToken),
		label: blob.label.length > 0 ? blob.label : emailFromToken(idToken) || emailFromToken(blob.accessToken) || "ChatGPT"
	};
}
function tokenBlobFromOAuth$2(json) {
	const access = json.access_token;
	const refresh = json.refresh_token;
	return {
		accessToken: typeof access === "string" ? access : "",
		refreshToken: typeof refresh === "string" ? refresh : "",
		expiresAt: Date.now() + (Number(json.expires_in) || 3600) * 1e3,
		label: "",
		email: "",
		accountId: ""
	};
}
async function codexExchangeCode(cfg, pkce, code) {
	const json = await formTokenRequest(CODEX_TOKEN, {
		grant_type: "authorization_code",
		client_id: cfg.clientId,
		code,
		redirect_uri: cfg.redirectUri,
		code_verifier: pkce.verifier
	}, fetch);
	return decorate(tokenBlobFromOAuth$2(json), json);
}
async function codexRefresh(blob) {
	const next = tokenBlobFromOAuth$2(await formTokenRequest(CODEX_TOKEN, {
		grant_type: "refresh_token",
		client_id: CODEX_CLIENT_ID,
		refresh_token: blob.refreshToken
	}, fetch));
	return {
		...next,
		refreshToken: next.refreshToken.length > 0 ? next.refreshToken : blob.refreshToken,
		label: blob.label,
		email: blob.email,
		accountId: blob.accountId.length > 0 ? blob.accountId : next.accountId
	};
}
//#endregion
//#region src/subscription/vendors/grok.ts
/**
* Grok subscription image vendor.
*
* Adapted from @goodandready/dsh-subscriptions (MIT, (c) 2026 GooDAnDReaDY)
* lib/vendors/grok.js and lib/images.js — only the pieces the image channel
* needs: authorize URL, code exchange, refresh, and the generations call
* (grok-cli token, not an xAI API key).
*/
const GROK_AUTH = "https://auth.x.ai/oauth2/authorize";
const GROK_TOKEN = "https://auth.x.ai/oauth2/token";
const GROK_SCOPE = "openid profile email offline_access grok-cli:access api:access conversations:read conversations:write";
/** Where the Grok subscription image request goes. */
const GROK_IMAGE_URL = "https://api.x.ai/v1/images/generations";
/** Where the Grok subscription image edit request goes. */
const GROK_IMAGE_EDIT_URL = "https://api.x.ai/v1/images/edits";
/** The model served by this endpoint. */
const GROK_IMAGE_MODEL = "grok-imagine-image-2.0";
/** Public client id of the grok-cli; vendor-fixed redirect on 127.0.0.1:56121. */
const GROK_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const GROK_REDIRECT_URI = "http://127.0.0.1:56121/callback";
function grokConfig() {
	return {
		clientId: GROK_CLIENT_ID,
		redirectUri: GROK_REDIRECT_URI
	};
}
function grokAuthorizeUrl(cfg, pkce) {
	return buildAuthorizeUrl({
		authUrl: GROK_AUTH,
		clientId: cfg.clientId,
		redirectUri: cfg.redirectUri,
		challenge: pkce.challenge,
		state: pkce.state,
		scope: GROK_SCOPE
	});
}
/** Identity fields every grok.com call must carry (the API host ignores them). */
function grokIdentityHeaders(blob) {
	return {
		authorization: `Bearer ${blob.accessToken}`,
		"X-XAI-Token-Auth": "xai-grok-cli",
		"x-grok-client-identifier": "grok-shell",
		"x-grok-client-version": "0.2.103",
		"User-Agent": "xai-grok-cli",
		"content-type": "application/json",
		accept: "application/json"
	};
}
const GROK_DEVICE_CODE_URL = "https://auth.x.ai/oauth2/device/code";
const GROK_DEVICE_SCOPE = "openid profile email offline_access grok-cli:access api:access";
async function grokForm(url, fields, signal, allowDevicePollingStatus = false) {
	const response = await fetch(url, {
		method: "POST",
		headers: {
			accept: "application/json",
			"content-type": "application/x-www-form-urlencoded"
		},
		body: new URLSearchParams(fields).toString(),
		...signal === void 0 ? {} : { signal }
	});
	const body = await response.json().catch(() => ({}));
	if (!response.ok) {
		const error = typeof body.error === "string" ? body.error : "";
		const description = typeof body.error_description === "string" ? body.error_description : "";
		if (allowDevicePollingStatus && (error === "authorization_pending" || error === "slow_down")) return body;
		throw new Error(`xAI OAuth HTTP ${response.status}${error || description ? `: ${[error, description].filter(Boolean).join(": ")}` : ""}`);
	}
	return body;
}
async function grokBeginDeviceLogin(signal) {
	const body = await grokForm(GROK_DEVICE_CODE_URL, {
		client_id: GROK_CLIENT_ID,
		scope: GROK_DEVICE_SCOPE,
		referrer: "pi"
	}, signal);
	const deviceCode = typeof body.device_code === "string" ? body.device_code : "";
	const userCode = typeof body.user_code === "string" ? body.user_code : "";
	const verificationUri = typeof body.verification_uri_complete === "string" ? body.verification_uri_complete : typeof body.verification_uri === "string" ? body.verification_uri : "";
	if (deviceCode === "" || userCode === "" || verificationUri === "") throw new Error("xAI device authorization response is incomplete");
	return {
		deviceCode,
		userCode,
		verificationUri,
		intervalSeconds: typeof body.interval === "number" && body.interval > 0 ? body.interval : 5,
		expiresInSeconds: typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : 900
	};
}
async function grokPollDeviceLogin(device, signal) {
	const deadline = Date.now() + device.expiresInSeconds * 1e3;
	let interval = Math.max(1, device.intervalSeconds) * 1e3;
	while (Date.now() < deadline) {
		await new Promise((resolve, reject) => {
			const timer = setTimeout(resolve, interval);
			signal?.addEventListener("abort", () => {
				clearTimeout(timer);
				reject(/* @__PURE__ */ new Error("Login cancelled"));
			}, { once: true });
		});
		const body = await grokForm(GROK_TOKEN, {
			grant_type: "urn:ietf:params:oauth:grant-type:device_code",
			client_id: GROK_CLIENT_ID,
			device_code: device.deviceCode
		}, signal, true);
		if (typeof body.access_token === "string" && body.access_token !== "") return {
			...tokenBlobFromOAuth$1(body),
			label: "Grok"
		};
		if (body.error === "slow_down" && typeof body.interval === "number") interval = Math.max(1, body.interval) * 1e3;
		else if (body.error !== "authorization_pending") throw new Error(typeof body.error_description === "string" ? body.error_description : `xAI device login failed: ${String(body.error ?? "unknown error")}`);
	}
	throw new Error("xAI device code expired");
}
function tokenBlobFromOAuth$1(json) {
	const access = json.access_token;
	const refresh = json.refresh_token;
	return {
		accessToken: typeof access === "string" ? access : "",
		refreshToken: typeof refresh === "string" ? refresh : "",
		expiresAt: Date.now() + (Number(json.expires_in) || 3600) * 1e3,
		label: "",
		email: "",
		accountId: ""
	};
}
async function grokExchangeCode(cfg, pkce, code) {
	const blob = tokenBlobFromOAuth$1(await formTokenRequest(GROK_TOKEN, {
		grant_type: "authorization_code",
		client_id: cfg.clientId,
		code,
		redirect_uri: cfg.redirectUri,
		code_verifier: pkce.verifier
	}, fetch));
	return {
		...blob,
		email: blob.email.length > 0 ? blob.email : emailFromToken(blob.accessToken),
		label: "Grok"
	};
}
async function grokRefresh(blob) {
	const next = tokenBlobFromOAuth$1(await formTokenRequest(GROK_TOKEN, {
		grant_type: "refresh_token",
		client_id: GROK_CLIENT_ID,
		refresh_token: blob.refreshToken
	}, fetch));
	return {
		...next,
		refreshToken: next.refreshToken.length > 0 ? next.refreshToken : blob.refreshToken,
		label: blob.label.length > 0 ? blob.label : "Grok",
		email: blob.email.length > 0 ? blob.email : next.email
	};
}
//#endregion
//#region src/subscription/vendors/openrouter.ts
const OPENROUTER_AUTH = "https://openrouter.ai/auth";
const OPENROUTER_TOKEN = "https://openrouter.ai/api/v1/auth/keys";
const OPENROUTER_REDIRECT_URI = "http://127.0.0.1:56231/oauth/callback";
const OPENROUTER_IMAGE_URL = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_IMAGE_MODEL = "google/gemini-3-pro-image";
function openRouterAuthorizeUrl(pkce) {
	const url = new URL(OPENROUTER_AUTH);
	url.searchParams.set("callback_url", OPENROUTER_REDIRECT_URI);
	url.searchParams.set("code_challenge", pkce.challenge);
	url.searchParams.set("code_challenge_method", "S256");
	url.searchParams.set("state", pkce.state);
	return url.toString();
}
function openRouterIdentityHeaders(blob) {
	return {
		authorization: `Bearer ${blob.accessToken}`,
		"content-type": "application/json",
		accept: "application/json"
	};
}
async function openRouterExchangeCode(pkce, code) {
	const response = await fetch(OPENROUTER_TOKEN, {
		method: "POST",
		headers: {
			accept: "application/json",
			"content-type": "application/json"
		},
		body: JSON.stringify({
			code,
			code_verifier: pkce.verifier,
			code_challenge_method: "S256"
		}),
		signal: AbortSignal.timeout(3e4)
	});
	const json = await response.json().catch(() => ({}));
	if (!response.ok) throw new Error(`OpenRouter OAuth key exchange failed (HTTP ${response.status})`);
	const key = json.key;
	if (typeof key !== "string" || key.length === 0) throw new Error("OpenRouter OAuth response carries no key");
	return {
		accessToken: key,
		refreshToken: "",
		expiresAt: Number.MAX_SAFE_INTEGER,
		label: "OpenRouter",
		email: "",
		accountId: ""
	};
}
async function openRouterRefresh(blob) {
	return blob;
}
//#endregion
//#region src/subscription/vendors/antigravity.ts
/**
* Google Antigravity (Nano Banana Pro) subscription image vendor.
*
* Protocol adapted from opencode-antigravity-auth-remix (MIT,
* (c) 2026 Darkstarrd-dev, based on NoeFabris/opencode-antigravity-auth):
* Google OAuth with the Antigravity CLI's public client credentials, managed
* project discovery via loadCodeAssist, and image generation through the
* v1internal:streamGenerateContent endpoint with the gemini-3-pro-image
* model. Reference: dist/src/constants.js, dist/src/plugin/image.js,
* dist/src/plugin/project.js.
*
* The dsh-subscriptions antigravity vendor left the OAuth client empty
* (Google's is confidential); the remix package ships the Antigravity CLI's
* own embedded client id/secret, which the community treats as public the
* same way Codex CLI's and grok-cli's are.
*/
const AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN = "https://oauth2.googleapis.com/token";
const SCOPE = [
	"https://www.googleapis.com/auth/cloud-platform",
	"https://www.googleapis.com/auth/userinfo.email",
	"https://www.googleapis.com/auth/userinfo.profile",
	"https://www.googleapis.com/auth/cclog",
	"https://www.googleapis.com/auth/experimentsandconfigs"
].join(" ");
/** Antigravity OAuth is experimental and requires user-supplied client credentials. */
const ANTIGRAVITY_REDIRECT_URI = "http://localhost:51121/oauth-callback";
/**
* Endpoint fallback order for generation, mirroring the reference (daily
* sandbox first, then autopush, then prod).
*/
const ANTIGRAVITY_ENDPOINTS = [
	"https://daily-cloudcode-pa.sandbox.googleapis.com",
	"https://autopush-cloudcode-pa.sandbox.googleapis.com",
	"https://cloudcode-pa.googleapis.com"
];
/** loadCodeAssist is best supported on prod; discovery tries prod first. */
const LOAD_ENDPOINTS = [
	"https://cloudcode-pa.googleapis.com",
	"https://daily-cloudcode-pa.sandbox.googleapis.com",
	"https://autopush-cloudcode-pa.sandbox.googleapis.com"
];
/** The image model served through this channel: Nano Banana Pro. */
const ANTIGRAVITY_IMAGE_MODEL = "gemini-3-pro-image";
/**
* Antigravity client version carried in the browser User-Agent. Google's
* backend routes by this: a non-Antigravity or outdated UA lands in the
* enterprise-license check and fails with the misleading 403 #3501
* "You do not have a valid license of this product". The official
* auto-updater publishes the current version; changelog scrape and the
* hardcoded fallback keep the header sane when the updater is unreachable
* (same strategy as the reference implementation's version.js).
*/
const ANTIGRAVITY_VERSION_FALLBACK = "2.0.6";
const VERSION_URL = "https://antigravity-auto-updater-974169037036.us-central1.run.app";
const CHANGELOG_URL = "https://antigravity.google/changelog";
const VERSION_FETCH_TIMEOUT_MS = 5e3;
const CHANGELOG_SCAN_CHARS = 5e3;
const VERSION_REGEX = /\d+\.\d+\.\d+/;
let antigravityVersion;
/** Current client version: the fetched one, or the fallback until fetched. */
function getAntigravityVersion() {
	return antigravityVersion ?? ANTIGRAVITY_VERSION_FALLBACK;
}
/** Fetch and cache the current version once; failures keep the fallback. */
async function initAntigravityVersion() {
	if (antigravityVersion !== void 0) return;
	const parsed = await fetchVersionText(VERSION_URL) ?? await fetchVersionText(CHANGELOG_URL, CHANGELOG_SCAN_CHARS);
	if (parsed !== void 0) antigravityVersion = parsed;
}
async function fetchVersionText(url, maxChars) {
	try {
		const response = await fetch(url, { signal: AbortSignal.timeout(VERSION_FETCH_TIMEOUT_MS) });
		if (!response.ok) return void 0;
		let text = await response.text();
		if (maxChars !== void 0) text = text.slice(0, maxChars);
		const match = text.match(VERSION_REGEX);
		return match === null ? void 0 : match[0];
	} catch {
		return;
	}
}
/** Hardcoded fallback project when Antigravity returns none (workspace accounts). */
const DEFAULT_PROJECT_ID = "rising-fact-p41fc";
/** Generation timeout mirroring the reference implementation. */
const IMAGE_TIMEOUT_MS = 12e4;
/** Aspect ratios the generationConfig.imageConfig accepts. */
const ASPECT_RATIOS = [
	"1:1",
	"16:9",
	"9:16",
	"4:3",
	"3:4",
	"21:9"
];
/** Safety settings the image endpoint requires to not block benign prompts. */
const SAFETY_SETTINGS_OFF = [
	{
		category: "HARM_CATEGORY_HARASSMENT",
		threshold: "OFF"
	},
	{
		category: "HARM_CATEGORY_HATE_SPEECH",
		threshold: "OFF"
	},
	{
		category: "HARM_CATEGORY_SEXUALLY_EXPLICIT",
		threshold: "OFF"
	},
	{
		category: "HARM_CATEGORY_DANGEROUS_CONTENT",
		threshold: "OFF"
	},
	{
		category: "HARM_CATEGORY_CIVIC_INTEGRITY",
		threshold: "OFF"
	}
];
function antigravityConfig() {
	const clientId = process.env.ANTIGRAVITY_CLIENT_ID?.trim() ?? "";
	const clientSecret = process.env.ANTIGRAVITY_CLIENT_SECRET?.trim() ?? "";
	if (clientId === "" || clientSecret === "") throw new Error("Google 实验订阅需要设置 ANTIGRAVITY_CLIENT_ID 和 ANTIGRAVITY_CLIENT_SECRET 环境变量");
	return {
		clientId,
		clientSecret,
		redirectUri: ANTIGRAVITY_REDIRECT_URI
	};
}
function antigravityAuthorizeUrl(cfg, pkce) {
	return buildAuthorizeUrl({
		authUrl: AUTH,
		clientId: cfg.clientId,
		redirectUri: cfg.redirectUri,
		challenge: pkce.challenge,
		state: pkce.state,
		scope: SCOPE,
		extra: {
			access_type: "offline",
			prompt: "consent"
		}
	});
}
/**
* Headers for project discovery (loadCodeAssist): the reference keeps the
* plain SDK identity here, mirroring its project.js loadHeaders.
*/
function loadHeaders(projectId) {
	const platform = process.platform === "win32" ? "WINDOWS" : process.platform === "darwin" ? "MACOS" : "LINUX";
	return {
		"User-Agent": "google-api-nodejs-client/9.15.1",
		"X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
		"Client-Metadata": JSON.stringify({
			ideType: "ANTIGRAVITY",
			platform,
			pluginType: "GEMINI",
			...projectId.length > 0 ? { duetProject: projectId } : {}
		})
	};
}
/**
* Headers for content requests (image generation): the full Electron
* browser User-Agent with the Antigravity client version, matching the
* official IDE. This is the identity the license check keys on — the plain
* SDK UA here is what produced 403 #3501 on personal accounts.
*/
function contentHeaders(projectId) {
	const uaPlatform = process.platform === "darwin" ? "Macintosh; Intel Mac OS X 10_15_7" : "Windows NT 10.0; Win64; x64";
	const platform = process.platform === "win32" ? "WINDOWS" : process.platform === "darwin" ? "MACOS" : "LINUX";
	return {
		"User-Agent": `Mozilla/5.0 (${uaPlatform}) AppleWebKit/537.36 (KHTML, like Gecko) Antigravity/${getAntigravityVersion()} Chrome/138.0.7204.235 Electron/37.3.1 Safari/537.36`,
		"X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
		"Client-Metadata": JSON.stringify({
			ideType: "ANTIGRAVITY",
			platform,
			pluginType: "GEMINI",
			...projectId.length > 0 ? { duetProject: projectId } : {}
		})
	};
}
function tokenBlobFromOAuth(json) {
	const access = json.access_token;
	const refresh = json.refresh_token;
	const idToken = typeof json.id_token === "string" ? json.id_token : "";
	return {
		accessToken: typeof access === "string" ? access : "",
		refreshToken: typeof refresh === "string" ? refresh : "",
		expiresAt: Date.now() + (Number(json.expires_in) || 3600) * 1e3,
		label: "",
		email: emailFromIdToken(idToken),
		accountId: ""
	};
}
/** Decode the id_token's JWT payload for the account email (identity only). */
function emailFromIdToken(idToken) {
	const parts = idToken.split(".");
	if (parts.length < 2) return "";
	try {
		const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
		return typeof payload.email === "string" ? payload.email : "";
	} catch {
		return "";
	}
}
async function antigravityExchangeCode(cfg, pkce, code) {
	const blob = tokenBlobFromOAuth(await formTokenRequest(TOKEN, {
		client_id: cfg.clientId,
		client_secret: cfg.clientSecret,
		grant_type: "authorization_code",
		code,
		redirect_uri: cfg.redirectUri,
		code_verifier: pkce.verifier
	}, fetch));
	if (blob.accessToken.length === 0) throw new Error("Antigravity token endpoint returned no access token");
	return blob;
}
async function antigravityRefresh(blob) {
	const cfg = antigravityConfig();
	const next = tokenBlobFromOAuth(await formTokenRequest(TOKEN, {
		client_id: cfg.clientId,
		client_secret: cfg.clientSecret,
		grant_type: "refresh_token",
		refresh_token: blob.refreshToken
	}, fetch));
	return {
		...next,
		refreshToken: next.refreshToken.length > 0 ? next.refreshToken : blob.refreshToken,
		label: blob.label,
		email: blob.email.length > 0 ? blob.email : next.email,
		accountId: ""
	};
}
/**
* Resolve the managed project id for the logged-in account. Most accounts
* have one; when loadCodeAssist reports none, the hardcoded fallback keeps
* generation working (mirrors the reference's ensureProjectContext).
* Returns '' only when every endpoint fails, letting generate() throw then.
*/
async function antigravityResolveProject(blob) {
	const metadata = {
		ideType: "ANTIGRAVITY",
		platform: platformOf(),
		pluginType: "GEMINI"
	};
	for (const base of LOAD_ENDPOINTS) try {
		const response = await fetch(`${base}/v1internal:loadCodeAssist`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${blob.accessToken}`,
				...loadHeaders("")
			},
			body: JSON.stringify({ metadata }),
			signal: AbortSignal.timeout(25e3)
		});
		if (!response.ok) continue;
		const payload = await response.json().catch(() => null);
		if (payload === null) continue;
		const project = payload.cloudaicompanionProject;
		const id = typeof project === "string" ? project : typeof project === "object" && project !== null && typeof project.id === "string" ? project.id : "";
		if (id.length > 0) return id;
	} catch {}
	return DEFAULT_PROJECT_ID;
}
function platformOf() {
	if (process.platform === "win32") return "WINDOWS";
	if (process.platform === "darwin") return "MACOS";
	return "LINUX";
}
/**
* Build the streamGenerateContent request body for one image generation.
* Ported from the reference buildImageRequest + the wrapping envelope: no
* tools, no systemInstruction, no thinkingConfig; responseModalities asks
* for TEXT+IMAGE. Reference images (edits) ride along as inlineData parts
* before the text part, mirroring the reference implementation.
*/
function antigravityImageBody(options) {
	const imageConfig = { aspectRatio: options.aspectRatio !== void 0 && ASPECT_RATIOS.includes(options.aspectRatio) ? options.aspectRatio : "1:1" };
	if (options.hd === true) imageConfig.imageSize = "4K";
	const parts = [];
	for (const image of options.referenceImages ?? []) parts.push({ inlineData: {
		mimeType: image.mediaType,
		data: Buffer.from(image.data).toString("base64")
	} });
	parts.push({ text: options.prompt });
	return {
		contents: [{
			role: "user",
			parts
		}],
		generationConfig: {
			candidateCount: 1,
			imageConfig,
			responseModalities: ["TEXT", "IMAGE"]
		},
		safetySettings: SAFETY_SETTINGS_OFF
	};
}
/** Wrap the inner request in the Antigravity agent envelope. */
function antigravityEnvelope(projectId, request) {
	return {
		project: projectId,
		model: ANTIGRAVITY_IMAGE_MODEL,
		userAgent: "antigravity",
		requestId: `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
		requestType: "agent",
		request: {
			...request,
			session_id: `sess-${randomUUID()}`
		}
	};
}
/**
* Generate one image on the logged-in Antigravity account: resolve the
* project, POST the wrapped body to each endpoint in fallback order, and
* parse the SSE stream for the inlineData image part.
*/
async function antigravityGenerateImage(options) {
	await initAntigravityVersion();
	const inner = antigravityImageBody({
		prompt: options.prompt,
		...options.aspectRatio !== void 0 ? { aspectRatio: options.aspectRatio } : {},
		...options.hd !== void 0 ? { hd: options.hd } : {},
		...options.referenceImages !== void 0 ? { referenceImages: options.referenceImages } : {}
	});
	const body = antigravityEnvelope(options.projectId, inner);
	let lastError = "no endpoint succeeded";
	for (const base of ANTIGRAVITY_ENDPOINTS) {
		const url = `${base}/v1internal:streamGenerateContent?alt=sse`;
		const timeoutSignal = AbortSignal.timeout(IMAGE_TIMEOUT_MS);
		const signal = options.signal !== void 0 ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
		try {
			const response = await fetch(url, {
				method: "POST",
				headers: {
					...contentHeaders(options.projectId),
					Authorization: `Bearer ${options.blob.accessToken}`,
					"Content-Type": "application/json",
					Accept: "text/event-stream"
				},
				body: JSON.stringify(body),
				signal
			});
			if (!response.ok) {
				const text = await response.text().catch(() => "");
				lastError = `HTTP ${String(response.status)}: ${text.slice(0, 200)}`;
				if (response.status === 403 || response.status === 404 || response.status === 429 || response.status >= 500) continue;
				throw new Error(`antigravity ${lastError}`);
			}
			const text = await response.text();
			const parsed = parseSseImage(text);
			if (parsed !== void 0) return parsed;
			const reason = parseSseError(text);
			lastError = reason !== void 0 ? reason : "response contained no image";
			continue;
		} catch (error) {
			if (options.signal?.aborted === true) throw error;
			lastError = error instanceof Error ? error.message : String(error);
			continue;
		}
	}
	throw new Error(`antigravity image generation failed: ${lastError}`);
}
/** Scan an SSE body for the first image part in any data: line. */
function parseSseImage(text) {
	for (const line of text.split("\n")) {
		if (!line.startsWith("data: ")) continue;
		const raw = line.slice(6).trim();
		if (raw.length === 0 || raw === "[DONE]") continue;
		try {
			const data = JSON.parse(raw);
			for (const candidate of data.response?.candidates ?? []) for (const part of candidate.content?.parts ?? []) {
				const inline = part.inlineData;
				if (typeof inline?.data === "string" && inline.data.length > 0 && typeof inline.mimeType === "string" && inline.mimeType.startsWith("image/")) return {
					b64: inline.data,
					mimeType: inline.mimeType
				};
			}
		} catch {}
	}
}
/** Pull the first error block an SSE body reports, for better messages. */
function parseSseError(text) {
	for (const line of text.split("\n")) {
		if (!line.startsWith("data: ")) continue;
		const raw = line.slice(6).trim();
		if (raw.length === 0 || raw === "[DONE]") continue;
		try {
			const data = JSON.parse(raw);
			if (data.error !== void 0) {
				const code = typeof data.error.code === "string" || typeof data.error.code === "number" ? String(data.error.code) : "";
				const message = typeof data.error.message === "string" ? data.error.message : "";
				const joined = `${code.length > 0 ? `${code}: ` : ""}${message}`.trim();
				if (joined.length > 0) return joined;
			}
		} catch {}
	}
}
//#endregion
//#region src/subscription/manager.ts
/**
* Subscription account manager: login flows, blob storage through the DSH
* Credentials service, token refresh with per-account locking, and image
* generation on the logged-in account.
*
* The account store pattern follows @goodandready/dsh-subscriptions (MIT,
* (c) 2026 GooDAnDReaDY) lib/accounts.js, trimmed to one account per vendor
* (no rotation, no cooldowns) because this bundle has exactly two vendors
* and no chat adapter to protect.
*
* Isolation invariants (project rules):
* - OAuth blobs live under SUBSCRIPTION_OAUTH_* refs, never the API-key refs.
* - Login/logout never touches any other setting or credential.
* - The browser side never sees a token; it sees the authorize URL and
*   status words only. Generation happens host-side, mirroring every other
*   adapter in this bundle.
*/
/** The vendor each dsh-image-gen subscription provider maps onto. */
function vendorOf(provider) {
	if (provider === "chatgpt-sub") return "codex";
	if (provider === "google-sub") return "antigravity";
	if (provider === "openrouter-sub") return "openrouter";
	return "grok";
}
/** Credential ref one vendor's OAuth blob is stored under (index fixed at 1). */
function subscriptionOauthRef(vendor) {
	return credentialRef(`DSH_IMAGEGEN_${vendor.toUpperCase()}_OAUTH_1`);
}
/**
* Per-application manager instance. Constructed once in the plugin entry,
* owns the pending-login map (PKCE state to login session) and the refresh
* locks; nothing here is persisted except the blobs themselves.
*/
/** Provider names by vendor for login-result pages and errors. */
function providerNameOf(vendor) {
	return SUBSCRIPTION_PROVIDER_DISPLAY_NAMES[vendor === "codex" ? "chatgpt-sub" : vendor === "antigravity" ? "google-sub" : vendor === "openrouter" ? "openrouter-sub" : "grok-sub"];
}
var SubscriptionManager = class {
	ctx;
	pending = /* @__PURE__ */ new Map();
	refreshLocks = /* @__PURE__ */ new Map();
	/** Cheap in-memory expiry cache so badges do not hit credentials on read. */
	blobCache = /* @__PURE__ */ new Map();
	/** Antigravity needs a per-account project id on every generation call. */
	projectCache = /* @__PURE__ */ new Map();
	/** Last failed browser/device login, exposed to the settings card without secrets. */
	loginErrors = /* @__PURE__ */ new Map();
	constructor(ctx) {
		this.ctx = ctx;
	}
	/** Resolve Credentials dynamically so this service stays optional. */
	credentials() {
		const credentials = this.ctx.get("credentials");
		if (credentials === void 0) throw new Error("当前部署未挂载 DSH Credentials，订阅账号不可用");
		return credentials;
	}
	/** Read a vendor's stored blob, or undefined when signed out. */
	async readBlob(vendor) {
		try {
			const raw = (await this.credentials().resolve(subscriptionOauthRef(vendor)))?.value ?? "";
			if (raw.trim().length === 0) return void 0;
			return parseBlob(raw);
		} catch {
			return;
		}
	}
	/** Last login failure for the settings card; never throws. */
	lastLoginError(vendor) {
		return this.loginErrors.get(vendor);
	}
	/** Login status for the settings card; never throws. */
	async loginStatus(vendor) {
		const blob = await this.readBlob(vendor);
		if (blob === void 0) return { state: "logged-out" };
		return {
			state: "logged-in",
			email: blob.email
		};
	}
	/**
	* Begin a login: registers PKCE state, starts the loopback catch server on
	* the vendor-fixed redirect port, and returns the authorize URL for the
	* browser to open. Completion lands in the loopback callback.
	*/
	async beginLogin(vendor) {
		if (vendor === "grok") {
			const device = await grokBeginDeviceLogin();
			this.loginErrors.delete("grok");
			grokPollDeviceLogin(device).then(async (blob) => {
				await this.saveBlob("grok", blob);
				this.loginErrors.delete("grok");
			}).catch((error) => {
				this.loginErrors.set("grok", error instanceof Error ? error.message : String(error));
			});
			return {
				url: device.verificationUri,
				code: device.userCode,
				expiresInSeconds: device.expiresInSeconds
			};
		}
		const redirectUri = vendor === "codex" ? CODEX_REDIRECT_URI : vendor === "antigravity" ? ANTIGRAVITY_REDIRECT_URI : vendor === "openrouter" ? OPENROUTER_REDIRECT_URI : GROK_REDIRECT_URI;
		const pkce = await createPkce();
		this.pending.set(pkce.state, {
			vendor,
			pkce
		});
		const url = vendor === "codex" ? codexAuthorizeUrl(codexConfig(), pkce) : vendor === "antigravity" ? antigravityAuthorizeUrl(antigravityConfig(), pkce) : vendor === "openrouter" ? openRouterAuthorizeUrl(pkce) : grokAuthorizeUrl(grokConfig(), pkce);
		await new Promise((resolve, reject) => {
			let settled = false;
			const ready = () => {
				if (!settled) {
					settled = true;
					resolve();
				}
			};
			const failed = (error) => {
				if (!settled) {
					settled = true;
					reject(error);
				}
			};
			startLoopback({
				redirectUri,
				onReady: ready,
				onError: failed,
				onCode: async (params) => {
					try {
						const html = await this.completeLoginFromCallback(vendor, params.get("code") ?? "", params.get("state") ?? "");
						this.loginErrors.delete(vendor);
						return html;
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						this.loginErrors.set(vendor, message);
						throw error;
					}
				}
			}).catch((error) => {
				failed(error instanceof Error ? error : new Error(String(error)));
			});
		});
		this.loginErrors.delete(vendor);
		return { url };
	}
	/** Complete a browser login from a pasted redirect URL/code when loopback cannot be reached. */
	async completeLogin(vendor, input) {
		const raw = input.trim();
		if (raw === "") throw new Error("authorization redirect URL/code is required");
		let code = "";
		let state = "";
		try {
			const url = new URL(raw);
			code = url.searchParams.get("code") ?? "";
			state = url.searchParams.get("state") ?? "";
		} catch {
			code = raw;
		}
		if (state === "") {
			const found = [...this.pending.entries()].reverse().find(([, row]) => row.vendor === vendor);
			if (found === void 0) throw new Error("login session expired; start again");
			state = found[0];
		}
		try {
			await this.completeLoginFromCallback(vendor, code, state);
			this.loginErrors.delete(vendor);
		} catch (error) {
			this.loginErrors.set(vendor, error instanceof Error ? error.message : String(error));
			throw error;
		}
	}
	/** Loopback callback: validate state, exchange the code, store the blob. */
	async completeLoginFromCallback(vendor, code, state) {
		if (code.length === 0) throw new Error("callback carried no authorization code");
		const row = this.pending.get(state);
		if (row === void 0 || row.vendor !== vendor) throw new Error("login session expired; start again");
		const blob = vendor === "codex" ? await codexExchangeCode(codexConfig(), row.pkce, code) : vendor === "antigravity" ? await antigravityExchangeCode(antigravityConfig(), row.pkce, code) : vendor === "openrouter" ? await openRouterExchangeCode(row.pkce, code) : await grokExchangeCode(grokConfig(), row.pkce, code);
		await this.saveBlob(vendor, blob);
		this.pending.delete(state);
		return `<!doctype html><meta charset="utf-8"><title>dsh-image-gen</title><p>${providerNameOf(vendor)} 登录成功（${escapeHtml(blob.email)}），可以关闭此页返回设置。</p>`;
	}
	/** Sign out: clear the blob and the caches. No other setting changes. */
	async logout(vendor) {
		await this.credentials().unset(subscriptionOauthRef(vendor));
		this.loginErrors.delete(vendor);
		this.blobCache.delete(vendor);
		this.projectCache.clear();
	}
	async saveBlob(vendor, blob) {
		await this.credentials().set(subscriptionOauthRef(vendor), serializeBlob(blob));
		this.blobCache.set(vendor, blob);
	}
	/**
	* Return a blob whose access token is usable; refreshes first when the
	* stored one is expired (or expiring within the skew window). Single-flight
	* per vendor so concurrent generate calls share one refresh.
	*/
	async ensureFresh(vendor) {
		const blob = await this.readBlob(vendor);
		if (blob === void 0) throw notLoggedInError(vendor);
		if (blob.refreshToken.length === 0) return blob;
		if (blob.expiresAt !== 0 && blob.expiresAt - 6e4 > Date.now()) return blob;
		const inflight = this.refreshLocks.get(vendor);
		if (inflight !== void 0) return inflight;
		const refresh = (async () => {
			const next = vendor === "codex" ? await codexRefresh(blob) : vendor === "antigravity" ? await antigravityRefresh(blob) : vendor === "openrouter" ? await openRouterRefresh(blob) : await grokRefresh(blob);
			const merged = {
				...next,
				refreshToken: next.refreshToken.length > 0 ? next.refreshToken : blob.refreshToken,
				accountId: next.accountId.length > 0 ? next.accountId : blob.accountId
			};
			await this.saveBlob(vendor, merged);
			return merged;
		})().finally(() => {
			this.refreshLocks.delete(vendor);
		});
		this.refreshLocks.set(vendor, refresh);
		return refresh;
	}
	/** Generate one image through the logged-in account. b64 reply decoded host-side. */
	async generate(options) {
		const { vendor, prompt } = options;
		const session = await this.ensureFresh(vendor);
		const text = prompt.trim();
		if (text.length === 0) throw new Error("prompt must be a non-empty string");
		const references = options.referenceImages ?? [];
		if (references.length > 5) throw new Error(`订阅生图最多支持 ${String(5)} 张参考图，当前 ${String(references.length)} 张`);
		if (vendor === "openrouter") {
			const response = await fetch(OPENROUTER_IMAGE_URL, {
				method: "POST",
				headers: openRouterIdentityHeaders(session),
				body: JSON.stringify({
					model: OPENROUTER_IMAGE_MODEL,
					messages: [{
						role: "user",
						content: [{
							type: "text",
							text
						}, ...references.map((image) => ({
							type: "image_url",
							image_url: { url: toDataUrl(image) }
						}))]
					}],
					modalities: ["image"],
					stream: false
				}),
				...options.signal === void 0 ? {} : { signal: options.signal }
			});
			const payload = await response.json().catch(() => ({}));
			if (!response.ok) {
				const detail = extractErrorMessage(payload);
				throw new Error(`openrouter HTTP ${String(response.status)}${detail === void 0 ? "" : `: ${detail.slice(0, 200)}`}`);
			}
			return parseOpenRouterImages(payload);
		}
		if (vendor === "antigravity") {
			const projectId = await this.ensureAntigravityProject(session);
			const aspectRatio = antigravityAspectRatioOf(options.size);
			return [{ b64_json: (await antigravityGenerateImage({
				blob: session,
				projectId,
				prompt: text,
				...aspectRatio !== void 0 ? { aspectRatio } : {},
				hd: options.quality === "hd" || options.quality === "high",
				...references.length > 0 ? { referenceImages: references } : {},
				...options.signal !== void 0 ? { signal: options.signal } : {}
			})).b64 }];
		}
		let url;
		let headers;
		let body;
		if (vendor === "codex") {
			url = references.length > 0 ? CODEX_IMAGE_EDIT_URL : CODEX_IMAGE_URL;
			headers = codexIdentityHeaders(session);
			body = {
				prompt: text,
				model: CODEX_IMAGE_MODEL,
				...references.length > 0 ? { images: references.map((image) => ({ image_url: toDataUrl(image) })) } : {},
				...options.size !== void 0 && options.size.length > 0 ? { size: options.size } : {},
				...options.quality !== void 0 && options.quality.length > 0 ? { quality: options.quality } : {}
			};
		} else {
			url = references.length > 0 ? GROK_IMAGE_EDIT_URL : GROK_IMAGE_URL;
			headers = grokIdentityHeaders(session);
			const aspect = {
				"1024x1024": "1:1",
				"1024x1536": "2:3",
				"1536x1024": "3:2",
				auto: "auto"
			};
			const level = options.quality === "low" ? "low" : options.quality === "medium" || options.quality === "high" ? "medium" : void 0;
			body = {
				prompt: text,
				model: GROK_IMAGE_MODEL,
				response_format: "b64_json",
				...references.length > 0 ? { images: references.map((image) => ({
					type: "image_url",
					image_url: toDataUrl(image)
				})) } : {},
				...options.size !== void 0 && aspect[options.size] !== void 0 ? { aspect_ratio: aspect[options.size] } : {},
				...level !== void 0 ? { quality: level } : {}
			};
		}
		const response = await fetch(url, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
			...options.signal !== void 0 ? { signal: options.signal } : {}
		});
		const payload = await response.json().catch(() => ({}));
		if (!response.ok) {
			const detail = extractErrorMessage(payload);
			throw new Error(`${vendor} HTTP ${String(response.status)}${detail !== void 0 ? `: ${detail.slice(0, 200)}` : ""}`);
		}
		return parseImages(payload);
	}
	/**
	* Resolve (and cache per refresh token) the managed project id the
	* Antigravity generation envelope needs. Re-resolved when the account
	* signs out or a different account logs in.
	*/
	async ensureAntigravityProject(blob) {
		const cacheKey = blob.refreshToken.length > 0 ? blob.refreshToken : blob.accessToken.slice(0, 32);
		const cached = this.projectCache.get(cacheKey);
		if (cached !== void 0) return cached;
		const projectId = await antigravityResolveProject(blob);
		this.projectCache.set(cacheKey, projectId);
		return projectId;
	}
};
/** Map an OpenAI-style size onto the aspect ratio Antigravity accepts. */
function antigravityAspectRatioOf(size) {
	const table = {
		"1024x1024": "1:1",
		"1024x1536": "2:3",
		"1536x1024": "3:2",
		"768x1398": "9:16",
		"1398x768": "16:9",
		auto: "1:1"
	};
	if (size === void 0) return void 0;
	const mapped = table[size];
	if (mapped !== void 0) return mapped;
	return /^\d+:\d+$/.test(size) ? size : "1:1";
}
/** Encode one reference image as the data URL the edit endpoints accept. */
function toDataUrl(image) {
	return `data:${image.mediaType};base64,${Buffer.from(image.data).toString("base64")}`;
}
/** Parse OpenRouter's image-capable chat completion response. */
function parseOpenRouterImages(payload) {
	if (typeof payload !== "object" || payload === null) throw new Error("response contains no images");
	const choices = Array.isArray(payload.choices) ? payload.choices : [];
	const images = [];
	for (const choice of choices) {
		if (typeof choice !== "object" || choice === null) continue;
		const message = choice.message;
		if (typeof message !== "object" || message === null) continue;
		const rows = message.images;
		if (!Array.isArray(rows)) continue;
		for (const row of rows) {
			if (typeof row !== "object" || row === null) continue;
			const raw = row.image_url;
			const url = typeof raw === "string" ? raw : typeof raw === "object" && raw !== null && typeof raw.url === "string" ? raw.url : "";
			const match = /^data:([^;]+);base64,(.+)$/s.exec(url);
			if (match?.[2] !== void 0) images.push({ b64_json: match[2] });
		}
	}
	if (images.length === 0) throw new Error("response contains no images");
	return images;
}
/** Response parsing: both vendors reply in the same `{data:[{b64_json}]}` shape. */
function parseImages(payload) {
	const body = typeof payload === "object" && payload !== null ? payload : {};
	const rows = Array.isArray(body.data) ? body.data : [];
	const images = [];
	for (const row of rows) {
		if (typeof row !== "object" || row === null) continue;
		const b64 = row.b64_json;
		if (typeof b64 !== "string" || b64.length === 0) continue;
		const revised = row.revised_prompt;
		images.push({
			b64_json: b64,
			...typeof revised === "string" && revised.length > 0 ? { revisedPrompt: revised } : {}
		});
	}
	if (images.length === 0) throw new Error("response contains no images");
	return images;
}
function extractErrorMessage(payload) {
	if (typeof payload !== "object" || payload === null) return void 0;
	const error = payload.error;
	if (typeof error !== "object" || error === null) return void 0;
	const row = error;
	if (typeof row.message === "string") return row.message;
	if (typeof row.code === "string") return row.code;
}
function notLoggedInError(vendor) {
	const display = providerNameOf(vendor);
	return /* @__PURE__ */ new Error(`${display} 未登录：请到「设置 → 生图配置 → 官方订阅」完成登录`);
}
function escapeHtml(value) {
	return value.replace(/[&<>"']/g, (ch) => ({
		"&": "&amp;",
		"<": "&lt;",
		">": "&gt;",
		"\"": "&quot;",
		"'": "&#39;"
	})[ch] ?? ch);
}
//#endregion
//#region src/storage-sync.ts
/**
* Object-storage sync for saved images: one S3-compatible uploader (SigV4,
* zero dependencies) that covers Tencent COS / Alibaba OSS / Qiniu S3 /
* MinIO / R2 style endpoints, plus a fire-and-forget hook the image stores
* call after a file lands on disk. The handler is registered by the plugin
* root (it owns the live settings), so framework-free stores stay decoupled
* from the settings seam.
*
* Object keys: `${prefix}/gallery/<file>` and `${prefix}/images/<file>` —
* content-addressed file names dedupe re-uploads naturally.
*/
let uploadHandler;
/** Register the live uploader (index.ts apply). Pass undefined to clear. */
function setStorageSyncHandler(handler) {
	uploadHandler = handler;
}
/** Fire-and-forget notification from the image stores after a file write. */
function notifyImageSaved(kind, filePath) {
	try {
		uploadHandler?.(kind, filePath);
	} catch {}
}
/** URL-encode per RFC 3986 (AWS SigV4 canonical forms). */
function uriEncode(value, encodeSlash = true) {
	return value.replace(/[^A-Za-z0-9-_.~]/g, (char) => {
		return `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`;
	}).replace(/%2F/g, encodeSlash ? "%2F" : "/");
}
/** HMAC-SHA256 helper. */
function hmac(key, data) {
	return createHmac("sha256", key).update(data, "utf8").digest();
}
/**
* PUT one object to an S3-compatible endpoint (SigV4, virtual-hosted or
* path-style — the endpoint URL already includes the bucket). Returns the
* elapsed milliseconds so the settings card can show a latency reading.
*/
async function putObject(config, key, data, contentType = "application/octet-stream") {
	const endpoint = config.endpoint.trim().replace(/\/+$/, "");
	if (endpoint === "" || config.accessKey.trim() === "" || config.secretKey.trim() === "") throw new Error("对象存储配置不完整：请填写接口地址与密钥");
	const url = new URL(`${endpoint}/${key.split("/").map((part) => uriEncode(part)).join("/")}`);
	const payloadHash = createHash("sha256").update(data).digest("hex");
	const amzDate = `${(/* @__PURE__ */ new Date()).toISOString().replace(/[:-]|\.\d{3}/g, "")}`;
	const dateStamp = amzDate.slice(0, 8);
	const host = url.host;
	const canonicalUri = url.pathname;
	const canonicalHeaders = `content-type:${contentType}\nhost:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
	const signedHeaders = "content-type;host;x-amz-content-sha256;x-amz-date";
	const canonicalRequest = `PUT\n${canonicalUri}\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
	const scope = `${dateStamp}/${config.region.trim() || "us-east-1"}/s3/aws4_request`;
	const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${createHash("sha256").update(canonicalRequest, "utf8").digest("hex")}`;
	const signature = createHmac("sha256", hmac(hmac(hmac(hmac(`AWS4${config.secretKey.trim()}`, dateStamp), config.region.trim() || "us-east-1"), "s3"), "aws4_request")).update(stringToSign, "utf8").digest("hex");
	const authorization = `AWS4-HMAC-SHA256 Credential=${config.accessKey.trim()}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
	const started = Date.now();
	const response = await fetch(url, {
		method: "PUT",
		headers: {
			"content-type": contentType,
			"x-amz-content-sha256": payloadHash,
			"x-amz-date": amzDate,
			authorization
		},
		body: new Uint8Array(data)
	});
	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(`对象存储拒绝上传（HTTP ${response.status}）${text !== "" ? `：${text.slice(0, 200)}` : ""}`);
	}
	return { ms: Date.now() - started };
}
/** Upload a small probe object; used by the settings card's test button. */
async function testStorage(config) {
	const key = `${config.prefix.trim() || "dsh-imagegen-studio"}/ping.txt`;
	const { ms } = await putObject(config, key, Buffer.from("dsh-imagegen-studio storage ok", "utf8"), "text/plain");
	return {
		ms,
		key
	};
}
//#endregion
//#region src/history-store.ts
/**
* Host-persisted generation history: images are stored as individual files
* under ~/.dsh/dsh-imagegen-studio/images/ and an index.json keeps the metadata +
* file names. This makes the history survive across browsers/devices that
* connect to the same DSH host, and keeps list responses small (the browser
* loads image bytes lazily through the history image route).
*
* Framework-free (node:fs only) so the route layer can drive it directly.
*/
function historyDir() {
	return imageDataRoot();
}
function indexPath$1() {
	return path.join(historyDir(), "index.json");
}
function imagesDir$1() {
	return path.join(historyDir(), "images");
}
let pendingMutation$1 = Promise.resolve();
function mutateHistory(operation) {
	const next = pendingMutation$1.then(operation, operation);
	pendingMutation$1 = next.then(() => void 0, () => void 0);
	return next;
}
/** File extension for a MIME type (image file names). */
function extensionOf$4(mime) {
	switch (mime.split(";")[0].trim()) {
		case "image/jpeg": return "jpg";
		case "image/webp": return "webp";
		case "image/gif": return "gif";
		default: return "png";
	}
}
/** MIME type for a stored image file name (image route responses). */
function mimeOfFile$2(file) {
	switch (path.extname(file).toLowerCase()) {
		case ".jpg":
		case ".jpeg": return "image/jpeg";
		case ".webp": return "image/webp";
		case ".gif": return "image/gif";
		default: return "image/png";
	}
}
/** Sanitize an entry id for use as a file-name prefix. */
function safeId$2(id) {
	const cleaned = id.replace(/[^a-zA-Z0-9-]/g, "-");
	return cleaned === "" ? "entry" : cleaned;
}
/** Ensure the storage directories exist. */
async function ensureDirs$1() {
	await promises.mkdir(imagesDir$1(), { recursive: true });
}
/** Read the index, tolerating a missing/corrupt file. */
async function readIndex$1() {
	try {
		const raw = await promises.readFile(indexPath$1(), "utf8");
		const parsed = JSON.parse(raw);
		if (parsed === null || typeof parsed !== "object") return [];
		const entries = parsed.entries;
		if (!Array.isArray(entries)) return [];
		return entries.filter(isStoredEntry$1);
	} catch {
		return [];
	}
}
/** Persist the index. */
async function writeIndex$1(entries) {
	await ensureDirs$1();
	const payload = { entries };
	const tmp = `${indexPath$1()}.tmp-${process.pid}`;
	await promises.writeFile(tmp, JSON.stringify(payload), "utf8");
	await promises.rename(tmp, indexPath$1());
}
/** Structural guard for a stored entry. */
function isStoredEntry$1(value) {
	if (value === null || typeof value !== "object") return false;
	const entry = value;
	return typeof entry.id === "string" && typeof entry.createdAt === "number" && (entry.mode === "text" || entry.mode === "edit") && (entry.workflow === void 0 || entry.workflow === "ecommerce") && (entry.projectId === void 0 || typeof entry.projectId === "string") && (entry.projectName === void 0 || typeof entry.projectName === "string") && (entry.slotKey === void 0 || typeof entry.slotKey === "string") && (entry.slotLabel === void 0 || typeof entry.slotLabel === "string") && typeof entry.prompt === "string" && (entry.archived === void 0 || typeof entry.archived === "boolean") && Array.isArray(entry.images) && entry.images.every((image) => {
		if (image === null || typeof image !== "object") return false;
		const record = image;
		return typeof record.file === "string" && typeof record.mime === "string";
	});
}
/** Remove one entry's image files (best effort). */
async function removeEntryFiles$1(entry) {
	for (const image of entry.images) try {
		await promises.rm(path.join(imagesDir$1(), image.file), { force: true });
	} catch {}
}
/** Project a stored entry onto the wire shape (image URLs). */
function toWire$1(entry) {
	return {
		id: entry.id,
		createdAt: entry.createdAt,
		mode: entry.mode,
		model: entry.model,
		prompt: entry.prompt,
		size: entry.size,
		quality: entry.quality,
		detail: entry.detail,
		n: entry.n,
		images: entry.images.map((image) => ({
			url: `/api/dsh-imagegen-studio/history/image/${image.file}`,
			mime: image.mime,
			...image.revisedPrompt === void 0 ? {} : { revisedPrompt: image.revisedPrompt }
		})),
		...entry.refName === void 0 ? {} : { refName: entry.refName },
		...entry.channel === void 0 ? {} : { channel: entry.channel },
		...entry.channelId === void 0 ? {} : { channelId: entry.channelId },
		...entry.comparisonId === void 0 ? {} : { comparisonId: entry.comparisonId },
		...entry.comparisonModels === void 0 ? {} : { comparisonModels: entry.comparisonModels },
		...entry.workflow === void 0 ? {} : { workflow: entry.workflow },
		...entry.projectId === void 0 ? {} : { projectId: entry.projectId },
		...entry.projectName === void 0 ? {} : { projectName: entry.projectName },
		...entry.slotKey === void 0 ? {} : { slotKey: entry.slotKey },
		...entry.slotLabel === void 0 ? {} : { slotLabel: entry.slotLabel },
		...entry.canvas === void 0 ? {} : { canvas: entry.canvas },
		...entry.renderer === void 0 ? {} : { renderer: entry.renderer },
		...entry.archived === true ? { archived: true } : {}
	};
}
/** List the live history (the everyday list), newest first, as wire entries. */
async function listHistory() {
	return (await readIndex$1()).filter((entry) => entry.archived !== true).map(toWire$1);
}
/** List the archived half, newest first, as wire entries. */
async function listArchivedHistory() {
	return (await readIndex$1()).filter((entry) => entry.archived === true).map(toWire$1);
}
/**
* Move one entry in or out of the archive.
*
* Archiving is a flag, not a delete: the images stay on disk and the entry can
* come straight back. Returns the two halves the client renders, same shape as
* the gallery routes so the panel has one list update path per store.
* @param id - entry id (unknown ids are a no-op).
* @param archived - true to archive, false to restore to the live list.
* @returns the live and archived halves after the move.
*/
async function setHistoryArchived(id, archived) {
	return mutateHistory(async () => {
		const next = (await readIndex$1()).map((entry) => {
			if (entry.id !== id) return entry;
			return archived ? {
				...entry,
				archived: true
			} : {
				...entry,
				archived: void 0
			};
		});
		await writeIndex$1(next);
		return {
			entries: next.filter((entry) => entry.archived !== true).map(toWire$1),
			archived: next.filter((entry) => entry.archived === true).map(toWire$1)
		};
	});
}
/** Append one generation, evicting the oldest beyond HISTORY_MAX. */
async function appendHistory(input) {
	return mutateHistory(async () => {
		await ensureDirs$1();
		const prefix = safeId$2(input.id);
		const storedImages = [];
		try {
			for (let index = 0; index < input.images.length; index++) {
				const image = input.images[index];
				const file = `${prefix}-${index}.${extensionOf$4(image.mime)}`;
				await promises.writeFile(path.join(imagesDir$1(), file), Buffer.from(image.b64, "base64"));
				notifyImageSaved("history", path.join(imagesDir$1(), file));
				storedImages.push({
					file,
					mime: image.mime,
					...image.revisedPrompt === void 0 ? {} : { revisedPrompt: image.revisedPrompt }
				});
			}
		} catch (error) {
			await removeEntryFiles$1({ images: storedImages });
			throw error;
		}
		const merged = [{
			id: input.id,
			createdAt: input.createdAt,
			mode: input.mode,
			model: input.model,
			prompt: input.prompt,
			size: input.size,
			quality: input.quality,
			detail: input.detail,
			n: input.n,
			images: storedImages,
			...input.refName === void 0 ? {} : { refName: input.refName },
			...input.channelId === void 0 ? {} : { channelId: input.channelId },
			...input.channel === void 0 ? {} : { channel: input.channel },
			...input.comparisonId === void 0 ? {} : { comparisonId: input.comparisonId },
			...input.comparisonModels === void 0 ? {} : { comparisonModels: input.comparisonModels },
			...input.workflow === void 0 ? {} : { workflow: input.workflow },
			...input.projectId === void 0 ? {} : { projectId: input.projectId },
			...input.projectName === void 0 ? {} : { projectName: input.projectName },
			...input.slotKey === void 0 ? {} : { slotKey: input.slotKey },
			...input.slotLabel === void 0 ? {} : { slotLabel: input.slotLabel },
			...input.canvas === void 0 ? {} : { canvas: input.canvas },
			...input.renderer === void 0 ? {} : { renderer: input.renderer }
		}, ...await readIndex$1()];
		const kept = merged.slice(0, 50);
		for (const dropped of merged.slice(50)) await removeEntryFiles$1(dropped);
		await writeIndex$1(kept);
		return kept.map(toWire$1);
	});
}
/** Remove one entry (and its image files). */
async function removeHistory(id) {
	return mutateHistory(async () => {
		const previous = await readIndex$1();
		const target = previous.find((entry) => entry.id === id);
		if (target !== void 0) await removeEntryFiles$1(target);
		const kept = previous.filter((entry) => entry.id !== id);
		await writeIndex$1(kept);
		return kept.map(toWire$1);
	});
}
/** Remove every entry (and all image files). */
async function clearHistory() {
	return mutateHistory(async () => {
		const previous = await readIndex$1();
		for (const entry of previous) await removeEntryFiles$1(entry);
		await writeIndex$1([]);
		return [];
	});
}
/** Read one stored image file by its (validated) file name. */
async function readHistoryImage(file) {
	if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*-[0-9]+\.(png|jpg|jpeg|webp|gif)$/.test(file)) return void 0;
	try {
		return {
			data: await promises.readFile(path.join(imagesDir$1(), file)),
			mime: mimeOfFile$2(file)
		};
	} catch {
		return;
	}
}
//#endregion
//#region src/task-queue.ts
/** In-memory, host-resident image generation queue. */
/**
* Cap on retained *terminal* tasks.
*
* The queue is host-resident and lives as long as the process, and a finished
* image task keeps its full `result` — the base64 image payload — so an
* unbounded `tasks` array pins every image generated in the session, forever.
* Only terminal entries are ever evicted: `queued`/`running` tasks ARE the live
* queue and are never touched. The newest entries are the ones kept, because
* the panel's task list, `get(id)` and `retry(id)` all look up recent work.
*/
const MAX_TERMINAL_TASKS$1 = 200;
var GenerationTaskQueue = class {
	run;
	concurrency;
	tasks = [];
	controllers = /* @__PURE__ */ new Map();
	listeners = /* @__PURE__ */ new Set();
	running = 0;
	constructor(run, concurrency = 1) {
		this.run = run;
		this.concurrency = concurrency;
	}
	list() {
		return this.tasks.map((task) => this.snapshot(task));
	}
	/**
	* Bounded poll payload: active tasks plus the newest terminal summaries.
	* Image data and completed results are intentionally omitted.
	*/
	summaries(terminalLimit = 100) {
		const limit = Math.max(0, Math.floor(terminalLimit));
		const active = this.tasks.filter((task) => task.status === "queued" || task.status === "running");
		const terminal = this.tasks.filter((task) => task.status !== "queued" && task.status !== "running").slice(0, limit);
		const selected = new Set([...active, ...terminal].map((task) => task.id));
		return this.tasks.filter((task) => selected.has(task.id)).map((task) => this.summary(task));
	}
	get(id) {
		const task = this.tasks.find((item) => item.id === id);
		return task === void 0 ? void 0 : this.snapshot(task);
	}
	/** Observe queue state changes. Listener failures never disrupt generation. */
	subscribe(listener) {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}
	submit(request) {
		const task = {
			id: randomUUID(),
			request: { ...request },
			status: "queued",
			createdAt: Date.now()
		};
		this.tasks.unshift(task);
		this.publish(task);
		this.drain();
		return this.snapshot(task);
	}
	cancel(id) {
		const task = this.tasks.find((item) => item.id === id);
		if (task === void 0 || task.status === "completed" || task.status === "failed" || task.status === "cancelled") return task;
		task.status = "cancelled";
		task.finishedAt = Date.now();
		this.controllers.get(id)?.abort();
		this.publish(task);
		this.trimTerminal();
		this.drain();
		return this.snapshot(task);
	}
	retry(id) {
		const previous = this.tasks.find((item) => item.id === id);
		return previous === void 0 ? void 0 : this.submit(previous.request);
	}
	/** Start queued tasks while capacity remains. Plain submissions and
	* comparison batches alike run in parallel up to the host-wide limit, so one
	* slow upstream can no longer hold back unrelated generations. */
	drain() {
		while (this.running < Math.max(1, this.concurrency)) {
			const task = this.tasks.find((item) => item.status === "queued");
			if (task === void 0) return;
			this.running += 1;
			this.runTask(task).finally(() => {
				this.running -= 1;
				this.drain();
			});
		}
	}
	/**
	* Drop the oldest terminal tasks past the retention cap.
	*
	* Only terminal entries are eligible: a `queued`/`running` task is live
	* queue state, and `summaries()`/`get()`/`retry()` all expect to find it.
	* `tasks` is newest-first (every insert is an `unshift`), so the newest
	* terminal entries sit ahead of the older ones and are the ones kept.
	*/
	trimTerminal() {
		let seen = 0;
		for (let index = 0; index < this.tasks.length;) {
			const task = this.tasks[index];
			if (task.status === "queued" || task.status === "running") {
				index += 1;
				continue;
			}
			seen += 1;
			if (seen <= MAX_TERMINAL_TASKS$1) {
				index += 1;
				continue;
			}
			this.tasks.splice(index, 1);
		}
	}
	async runTask(task) {
		task.status = "running";
		task.startedAt = Date.now();
		this.publish(task);
		const controller = new AbortController();
		this.controllers.set(task.id, controller);
		try {
			const result = await this.run(task.request, controller.signal);
			if (this.tasks.find((item) => item.id === task.id)?.status !== "cancelled") {
				task.status = "completed";
				task.result = result;
				task.finishedAt = Date.now();
				this.publish(task);
				this.trimTerminal();
			}
		} catch (error) {
			if (this.tasks.find((item) => item.id === task.id)?.status !== "cancelled") {
				task.status = "failed";
				task.error = error instanceof Error ? error.message : String(error);
				task.finishedAt = Date.now();
				this.publish(task);
				this.trimTerminal();
			}
		} finally {
			this.controllers.delete(task.id);
		}
	}
	publish(task) {
		const snapshot = this.snapshot(task);
		for (const listener of this.listeners) try {
			listener(snapshot);
		} catch {}
	}
	summary(task) {
		const request = { ...task.request };
		delete request.image;
		delete request.images;
		return {
			id: task.id,
			request,
			status: task.status,
			createdAt: task.createdAt,
			...task.startedAt === void 0 ? {} : { startedAt: task.startedAt },
			...task.finishedAt === void 0 ? {} : { finishedAt: task.finishedAt },
			...task.error === void 0 ? {} : { error: task.error },
			resultAvailable: task.result !== void 0
		};
	}
	snapshot(task) {
		return {
			...task,
			request: { ...task.request },
			...task.result === void 0 ? {} : { result: task.result }
		};
	}
};
//#endregion
//#region src/video-task-queue.ts
/**
* In-memory, host-resident video generation queue.
*
* Deliberately a sibling of `task-queue.ts` rather than a generic rewrite of
* it: the image queue is on the hot path for every existing feature, and video
* differs in more than its payload types — a video task is long-running
* (minutes, not seconds), so it needs its own concurrency (one render at a
* time; a provider that renders serially gains nothing from parallel submits)
* and its own summary shape, which strips reference frames but keeps the
* finished clip's served URL.
*/
/**
* Cap on retained *terminal* video tasks.
*
* Same reasoning as `task-queue.ts`, but the number is deliberately smaller:
* a finished image task pins one base64 image, while a finished video task
* pins its full `result` — the served clip URL plus the whole history entry
* (which carries the reference frames' provenance and the clip metadata). A
* video render also costs minutes of wall clock and hundreds of MiB upstream,
* so a session accumulates far fewer of them than images; keeping 200 of these
* would hold megabytes of result objects for work nobody will retry. Only
* terminal entries are ever evicted: `queued`/`running` tasks ARE the live
* queue and are never touched. The newest entries are kept because the panel's
* task list, `get(id)` and `retry(id)` all look up recent work.
*/
const MAX_TERMINAL_TASKS = 100;
var VideoTaskQueue = class {
	run;
	concurrency;
	tasks = [];
	controllers = /* @__PURE__ */ new Map();
	listeners = /* @__PURE__ */ new Set();
	running = 0;
	constructor(run, concurrency = 1) {
		this.run = run;
		this.concurrency = concurrency;
	}
	list() {
		return this.tasks.map((task) => this.snapshot(task));
	}
	/** Bounded poll payload: active tasks plus the newest terminal summaries. */
	summaries(terminalLimit = 50) {
		const limit = Math.max(0, Math.floor(terminalLimit));
		const active = this.tasks.filter((task) => task.status === "queued" || task.status === "running");
		const terminal = this.tasks.filter((task) => task.status !== "queued" && task.status !== "running").slice(0, limit);
		const selected = new Set([...active, ...terminal].map((task) => task.id));
		return this.tasks.filter((task) => selected.has(task.id)).map((task) => this.summary(task));
	}
	get(id) {
		const task = this.tasks.find((item) => item.id === id);
		return task === void 0 ? void 0 : this.snapshot(task);
	}
	/** Observe queue state changes. Listener failures never disrupt generation. */
	subscribe(listener) {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}
	submit(request) {
		const task = {
			id: randomUUID(),
			request: { ...request },
			status: "queued",
			createdAt: Date.now()
		};
		this.tasks.unshift(task);
		this.publish(task);
		this.drain();
		return this.snapshot(task);
	}
	cancel(id) {
		const task = this.tasks.find((item) => item.id === id);
		if (task === void 0 || task.status === "completed" || task.status === "failed" || task.status === "cancelled") return task;
		task.status = "cancelled";
		task.finishedAt = Date.now();
		this.controllers.get(id)?.abort();
		this.publish(task);
		this.trimTerminal();
		this.drain();
		return this.snapshot(task);
	}
	retry(id) {
		const previous = this.tasks.find((item) => item.id === id);
		return previous === void 0 ? void 0 : this.submit(previous.request);
	}
	/** Start queued tasks while capacity remains. */
	drain() {
		while (this.running < Math.max(1, this.concurrency)) {
			const task = this.tasks.find((item) => item.status === "queued");
			if (task === void 0) return;
			this.running += 1;
			this.runTask(task).finally(() => {
				this.running -= 1;
				this.drain();
			});
		}
	}
	/**
	* Drop the oldest terminal tasks past the retention cap.
	*
	* Only terminal entries are eligible: a `queued`/`running` task is live
	* queue state, and `summaries()`/`get()`/`retry()` all expect to find it.
	* `tasks` is newest-first (every insert is an `unshift`), so the newest
	* terminal entries sit ahead of the older ones and are the ones kept.
	*/
	trimTerminal() {
		let seen = 0;
		for (let index = 0; index < this.tasks.length;) {
			const task = this.tasks[index];
			if (task.status === "queued" || task.status === "running") {
				index += 1;
				continue;
			}
			seen += 1;
			if (seen <= MAX_TERMINAL_TASKS) {
				index += 1;
				continue;
			}
			this.tasks.splice(index, 1);
		}
	}
	async runTask(task) {
		task.status = "running";
		task.startedAt = Date.now();
		this.publish(task);
		const controller = new AbortController();
		this.controllers.set(task.id, controller);
		try {
			const result = await this.run(task.request, controller.signal);
			if (this.tasks.find((item) => item.id === task.id)?.status !== "cancelled") {
				task.status = "completed";
				task.result = result;
				task.finishedAt = Date.now();
				this.publish(task);
				this.trimTerminal();
			}
		} catch (error) {
			if (this.tasks.find((item) => item.id === task.id)?.status !== "cancelled") {
				task.status = "failed";
				task.error = error instanceof Error ? error.message : String(error);
				task.finishedAt = Date.now();
				this.publish(task);
				this.trimTerminal();
			}
		} finally {
			this.controllers.delete(task.id);
		}
	}
	publish(task) {
		const snapshot = this.snapshot(task);
		for (const listener of this.listeners) try {
			listener(snapshot);
		} catch {}
	}
	/**
	* Strip the reference frames before the summary crosses the wire: a base64
	* frame is large, and the panel already holds the frame the user picked.
	*/
	summary(task) {
		const request = { ...task.request };
		delete request.image;
		delete request.images;
		delete request.firstFrame;
		delete request.lastFrame;
		const plan = task.result?.plan;
		const renderSource = task.result?.renderSource;
		const clip = task.result?.videos?.[0];
		const entryId = task.result?.history?.[0]?.id;
		return {
			id: task.id,
			request,
			status: task.status,
			createdAt: task.createdAt,
			...task.startedAt === void 0 ? {} : { startedAt: task.startedAt },
			...task.finishedAt === void 0 ? {} : { finishedAt: task.finishedAt },
			...task.error === void 0 ? {} : { error: task.error },
			resultAvailable: task.result !== void 0,
			...clip === void 0 || clip.url === "" ? {} : { resultUrl: clip.url },
			...clip === void 0 ? {} : { resultVideo: clip },
			...entryId === void 0 ? {} : { resultEntryId: entryId },
			...plan === void 0 ? {} : { plan },
			...renderSource === void 0 ? {} : { renderSource }
		};
	}
	snapshot(task) {
		return {
			...task,
			request: { ...task.request },
			...task.result === void 0 ? {} : { result: task.result }
		};
	}
};
//#endregion
//#region src/code-render.ts
/**
* Code-rendered video and images: a second production path beside the model
* APIs, for the graphics a generative model is bad at and a program is exact
* at — text cards, data labels, logo lockups, kinetic typography, charts.
*
* The shape of the path, and why it is this shape:
*
*   prompt → chat model writes one `render(ctx)` function → this module runs
*   that function once per frame inside a `node:vm` sandbox → each frame is a
*   raw RGBA buffer → piped into ffmpeg → a normal MP4 in the same video store
*   the model path writes to.
*
* Three decisions worth stating, because each replaces a dependency that would
* have been easier but worse:
*
*  1. **No rendering framework.** No React, no browser, no headless Chrome.
*     The frame is a plain RGBA buffer the model's own code fills through a
*     tiny drawing API. That removes every licence question (the frameworks
*     that do this well are either dual-licensed or unmaintained), removes
*     Chrome as a runtime requirement, and keeps the dependency surface at
*     `node:vm` + the ffmpeg the plugin already ships against.
*  2. **Raw RGBA piped to ffmpeg**, not one PNG per frame: one process, one
*     encode. Measured on this machine, a 3s 720p clip renders in ~250ms this
*     way versus seconds-to-minutes through per-frame file I/O.
*  3. **The sandbox is a real boundary, not a promise.** The generated code is
*     untrusted text from a language model. It runs in a fresh `vm` context
*     with no `require`, no `process`, no `fetch`, no `fs`, a wall-clock
*     deadline, and a per-frame budget. Everything it can do is the drawing
*     API documented below.
*
* The drawing API is deliberately small enough to document in one prompt and
* large enough to build real motion graphics. Coordinates are in pixels of the
* requested output, so the same code renders at any resolution.
*/
/** Stable wire code for a code-render failure. */
var CodeRenderError = class extends Error {
	code;
	/** Whether re-running the same code could plausibly work (a timeout could). */
	retryable;
	constructor(message, code = "code-render-failed", retryable = false) {
		super(message);
		this.name = "CodeRenderError";
		this.code = code;
		this.retryable = retryable;
	}
};
/** Output dimensions for a resolution tier at a given aspect ratio. */
function dimensionsFor(resolution, aspectRatio) {
	const shortEdge = resolution === "480P" ? 480 : resolution === "1080P" ? 1080 : 720;
	switch (aspectRatio) {
		case "9:16": return {
			width: shortEdge,
			height: Math.round(shortEdge * 16 / 9 / 2) * 2
		};
		case "1:1": return {
			width: shortEdge,
			height: shortEdge
		};
		case "4:3": return {
			width: Math.round(shortEdge * 4 / 3 / 2) * 2,
			height: shortEdge
		};
		case "3:4": return {
			width: shortEdge,
			height: Math.round(shortEdge * 4 / 3 / 2) * 2
		};
		default: return {
			width: Math.round(shortEdge * 16 / 9 / 2) * 2,
			height: shortEdge
		};
	}
}
/** Cap on generated source. A prompt asking for a drawing, not a codebase. */
const MAX_CODE_CHARS = 6e4;
/** Cap on a single frame's pixel buffer (8K would already be too much). */
const MAX_PIXELS = 4096 * 4096;
/** Wall-clock cap on one whole render. */
const DEFAULT_RENDER_TIMEOUT_MS = 12e4;
/**
* Locate ffmpeg without relying on PATH.
*
* The running host's PATH is `/usr/bin:/bin:/usr/sbin:/sbin` — the same reason
* `clip-compose.ts` resolves absolute candidates — so `ffmpeg` alone is a
* guaranteed ENOENT on a machine where it lives in `~/.local/bin` or under
* Homebrew. Returns undefined when nothing executable is found, which the
* caller turns into a "install ffmpeg" message rather than a crash.
*/
function locateFfmpeg() {
	const candidates = [
		process.env.FFMPEG_PATH,
		"/opt/homebrew/bin/ffmpeg",
		"/usr/local/bin/ffmpeg",
		path.join(homedir(), ".local", "bin", "ffmpeg"),
		"/usr/bin/ffmpeg",
		"/snap/bin/ffmpeg"
	].filter((candidate) => typeof candidate === "string" && candidate !== "");
	for (const candidate of candidates) try {
		accessSync(candidate, constants.X_OK);
		return candidate;
	} catch {}
}
/** Parse `#rgb` / `#rrggbb` / `#rrggbbaa` / `rgb()` / `rgba()` into RGBA. */
function parseColor(input) {
	const value = String(input ?? "").trim().toLowerCase();
	const rgbaCall = /^rgba?\(([^)]+)\)$/.exec(value);
	if (rgbaCall !== null) {
		const [r = 0, g = 0, b = 0, a = 1] = rgbaCall[1].split(",").map((part) => Number(part.trim()));
		return [
			Math.max(0, Math.min(255, Math.round(r))),
			Math.max(0, Math.min(255, Math.round(g))),
			Math.max(0, Math.min(255, Math.round(b))),
			Math.max(0, Math.min(255, Math.round(a * 255)))
		];
	}
	const hex = value.startsWith("#") ? value.slice(1) : value;
	if (/^[0-9a-f]{3}$/.test(hex)) return [
		parseInt(hex[0] + hex[0], 16),
		parseInt(hex[1] + hex[1], 16),
		parseInt(hex[2] + hex[2], 16),
		255
	];
	if (/^[0-9a-f]{6}$/.test(hex)) return [
		parseInt(hex.slice(0, 2), 16),
		parseInt(hex.slice(2, 4), 16),
		parseInt(hex.slice(4, 6), 16),
		255
	];
	if (/^[0-9a-f]{8}$/.test(hex)) return [
		parseInt(hex.slice(0, 2), 16),
		parseInt(hex.slice(2, 4), 16),
		parseInt(hex.slice(4, 6), 16),
		parseInt(hex.slice(6, 8), 16)
	];
	return [
		0,
		0,
		0,
		255
	];
}
/**
* Blend one pixel. Additive source-over with the given alpha multiplier.
*
* Kept as a function so every primitive composites identically; a primitive
* that wrote bytes directly would silently ignore opacity.
*/
function blendPixel(buffer, offset, color, alphaScale) {
	const a = color[3] / 255 * alphaScale;
	if (a <= 0) return;
	const inv = 1 - a;
	buffer[offset] = Math.round(color[0] * a + buffer[offset] * inv);
	buffer[offset + 1] = Math.round(color[1] * a + buffer[offset + 1] * inv);
	buffer[offset + 2] = Math.round(color[2] * a + buffer[offset + 2] * inv);
	buffer[offset + 3] = 255;
}
/**
* A 5×7 bitmap font for the printable ASCII range.
*
* Built in rather than borrowed: a font file is a licensing question and a
* dependency, and generated text is short (titles, numbers, labels). Each row
* is five bits, most significant first.
*/
const GLYPHS = {
	" ": [
		"00000",
		"00000",
		"00000",
		"00000",
		"00000",
		"00000",
		"00000"
	],
	"A": [
		"01110",
		"10001",
		"10001",
		"11111",
		"10001",
		"10001",
		"10001"
	],
	"B": [
		"11110",
		"10001",
		"10001",
		"11110",
		"10001",
		"10001",
		"11110"
	],
	"C": [
		"01110",
		"10001",
		"10000",
		"10000",
		"10000",
		"10001",
		"01110"
	],
	"D": [
		"11110",
		"10001",
		"10001",
		"10001",
		"10001",
		"10001",
		"11110"
	],
	"E": [
		"11111",
		"10000",
		"10000",
		"11110",
		"10000",
		"10000",
		"11111"
	],
	"F": [
		"11111",
		"10000",
		"10000",
		"11110",
		"10000",
		"10000",
		"10000"
	],
	"G": [
		"01110",
		"10001",
		"10000",
		"10111",
		"10001",
		"10001",
		"01111"
	],
	"H": [
		"10001",
		"10001",
		"10001",
		"11111",
		"10001",
		"10001",
		"10001"
	],
	"I": [
		"11111",
		"00100",
		"00100",
		"00100",
		"00100",
		"00100",
		"11111"
	],
	"J": [
		"00111",
		"00010",
		"00010",
		"00010",
		"00010",
		"10010",
		"01100"
	],
	"K": [
		"10001",
		"10010",
		"10100",
		"11000",
		"10100",
		"10010",
		"10001"
	],
	"L": [
		"10000",
		"10000",
		"10000",
		"10000",
		"10000",
		"10000",
		"11111"
	],
	"M": [
		"10001",
		"11011",
		"10101",
		"10101",
		"10001",
		"10001",
		"10001"
	],
	"N": [
		"10001",
		"11001",
		"10101",
		"10011",
		"10001",
		"10001",
		"10001"
	],
	"O": [
		"01110",
		"10001",
		"10001",
		"10001",
		"10001",
		"10001",
		"01110"
	],
	"P": [
		"11110",
		"10001",
		"10001",
		"11110",
		"10000",
		"10000",
		"10000"
	],
	"Q": [
		"01110",
		"10001",
		"10001",
		"10001",
		"10101",
		"10010",
		"01101"
	],
	"R": [
		"11110",
		"10001",
		"10001",
		"11110",
		"10100",
		"10010",
		"10001"
	],
	"S": [
		"01111",
		"10000",
		"10000",
		"01110",
		"00001",
		"00001",
		"11110"
	],
	"T": [
		"11111",
		"00100",
		"00100",
		"00100",
		"00100",
		"00100",
		"00100"
	],
	"U": [
		"10001",
		"10001",
		"10001",
		"10001",
		"10001",
		"10001",
		"01110"
	],
	"V": [
		"10001",
		"10001",
		"10001",
		"10001",
		"10001",
		"01010",
		"00100"
	],
	"W": [
		"10001",
		"10001",
		"10001",
		"10101",
		"10101",
		"11011",
		"10001"
	],
	"X": [
		"10001",
		"10001",
		"01010",
		"00100",
		"01010",
		"10001",
		"10001"
	],
	"Y": [
		"10001",
		"10001",
		"01010",
		"00100",
		"00100",
		"00100",
		"00100"
	],
	"Z": [
		"11111",
		"00001",
		"00010",
		"00100",
		"01000",
		"10000",
		"11111"
	],
	"0": [
		"01110",
		"10001",
		"10011",
		"10101",
		"11001",
		"10001",
		"01110"
	],
	"1": [
		"00100",
		"01100",
		"00100",
		"00100",
		"00100",
		"00100",
		"01110"
	],
	"2": [
		"01110",
		"10001",
		"00001",
		"00110",
		"01000",
		"10000",
		"11111"
	],
	"3": [
		"11111",
		"00010",
		"00100",
		"00010",
		"00001",
		"10001",
		"01110"
	],
	"4": [
		"00010",
		"00110",
		"01010",
		"10010",
		"11111",
		"00010",
		"00010"
	],
	"5": [
		"11111",
		"10000",
		"11110",
		"00001",
		"00001",
		"10001",
		"01110"
	],
	"6": [
		"00110",
		"01000",
		"10000",
		"11110",
		"10001",
		"10001",
		"01110"
	],
	"7": [
		"11111",
		"00001",
		"00010",
		"00100",
		"01000",
		"01000",
		"01000"
	],
	"8": [
		"01110",
		"10001",
		"10001",
		"01110",
		"10001",
		"10001",
		"01110"
	],
	"9": [
		"01110",
		"10001",
		"10001",
		"01111",
		"00001",
		"00010",
		"01100"
	],
	".": [
		"00000",
		"00000",
		"00000",
		"00000",
		"00000",
		"01100",
		"01100"
	],
	",": [
		"00000",
		"00000",
		"00000",
		"00000",
		"01100",
		"00100",
		"01000"
	],
	":": [
		"00000",
		"01100",
		"01100",
		"00000",
		"01100",
		"01100",
		"00000"
	],
	"-": [
		"00000",
		"00000",
		"00000",
		"11111",
		"00000",
		"00000",
		"00000"
	],
	"+": [
		"00000",
		"00100",
		"00100",
		"11111",
		"00100",
		"00100",
		"00000"
	],
	"/": [
		"00001",
		"00010",
		"00010",
		"00100",
		"01000",
		"01000",
		"10000"
	],
	"%": [
		"11001",
		"11010",
		"00010",
		"00100",
		"01000",
		"01011",
		"10011"
	],
	"!": [
		"00100",
		"00100",
		"00100",
		"00100",
		"00100",
		"00000",
		"00100"
	],
	"?": [
		"01110",
		"10001",
		"00001",
		"00110",
		"00100",
		"00000",
		"00100"
	],
	"&": [
		"01100",
		"10010",
		"10100",
		"01000",
		"10101",
		"10010",
		"01101"
	],
	"(": [
		"00010",
		"00100",
		"01000",
		"01000",
		"01000",
		"00100",
		"00010"
	],
	")": [
		"01000",
		"00100",
		"00010",
		"00010",
		"00010",
		"00100",
		"01000"
	],
	"°": [
		"01100",
		"10010",
		"10010",
		"01100",
		"00000",
		"00000",
		"00000"
	]
};
/** Fallback glyph for anything outside the table (CJK, emoji, …). */
const TOFU = [
	"01111",
	"01001",
	"01001",
	"01001",
	"01001",
	"01001",
	"01111"
];
/** Draw one character into the frame at an integer position. */
function drawGlyph(buffer, width, height, char, x, y, scale, color, alpha) {
	const rows = GLYPHS[char.toUpperCase()] ?? TOFU;
	for (let row = 0; row < 7; row++) {
		const bits = rows[row];
		for (let col = 0; col < 5; col++) {
			if (bits[col] !== "1") continue;
			for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
				const px = x + col * scale + dx;
				const py = y + row * scale + dy;
				if (px < 0 || py < 0 || px >= width || py >= height) continue;
				blendPixel(buffer, (py * width + px) * 4, color, alpha);
			}
		}
	}
}
/** Build the per-frame API over one RGBA buffer. */
function createFrameApi(buffer, width, height, fps, duration, frame) {
	const fill = (x, y, w, h, color, alpha) => {
		const x0 = Math.max(0, Math.floor(x));
		const y0 = Math.max(0, Math.floor(y));
		const x1 = Math.min(width, Math.ceil(x + w));
		const y1 = Math.min(height, Math.ceil(y + h));
		for (let py = y0; py < y1; py++) {
			const row = py * width * 4;
			for (let px = x0; px < x1; px++) blendPixel(buffer, row + px * 4, color, alpha);
		}
	};
	const api = {
		width,
		height,
		fps,
		duration,
		frame,
		t: duration > 0 ? Math.min(1, frame / (fps * duration)) : 0,
		background(color) {
			fill(0, 0, width, height, parseColor(color), 1);
		},
		rect(x, y, w, h, color, opacity = 1) {
			fill(x, y, w, h, parseColor(color), Math.max(0, Math.min(1, opacity)));
		},
		roundRect(x, y, w, h, radius, color, opacity = 1) {
			const parsed = parseColor(color);
			const alpha = Math.max(0, Math.min(1, opacity));
			const r = Math.max(0, Math.min(radius, Math.min(w, h) / 2));
			fill(x + r, y, w - 2 * r, h, parsed, alpha);
			fill(x, y + r, w, h - 2 * r, parsed, alpha);
			for (const [cx, cy, sx, sy] of [
				[
					x + r,
					y + r,
					-1,
					-1
				],
				[
					x + w - r,
					y + r,
					1,
					-1
				],
				[
					x + r,
					y + h - r,
					-1,
					1
				],
				[
					x + w - r,
					y + h - r,
					1,
					1
				]
			]) for (let dy = 0; dy < r; dy++) for (let dx = 0; dx < r; dx++) {
				const ox = Math.round(cx + sx * dx);
				const oy = Math.round(cy + sy * dy);
				if (ox < 0 || oy < 0 || ox >= width || oy >= height) continue;
				if (dx * dx + dy * dy <= r * r) blendPixel(buffer, (oy * width + ox) * 4, parsed, alpha);
			}
		},
		circle(cx, cy, r, color, opacity = 1) {
			const parsed = parseColor(color);
			const alpha = Math.max(0, Math.min(1, opacity));
			const x0 = Math.max(0, Math.floor(cx - r));
			const y0 = Math.max(0, Math.floor(cy - r));
			const x1 = Math.min(width, Math.ceil(cx + r));
			const y1 = Math.min(height, Math.ceil(cy + r));
			const rr = r * r;
			for (let py = y0; py < y1; py++) {
				const dy = py - cy;
				for (let px = x0; px < x1; px++) {
					const dx = px - cx;
					if (dx * dx + dy * dy <= rr) blendPixel(buffer, (py * width + px) * 4, parsed, alpha);
				}
			}
		},
		line(x1, y1, x2, y2, thickness, color, opacity = 1) {
			parseColor(color);
			const alpha = Math.max(0, Math.min(1, opacity));
			const half = Math.max(1, thickness) / 2;
			const steps = Math.max(1, Math.ceil(Math.hypot(x2 - x1, y2 - y1)));
			for (let step = 0; step <= steps; step++) {
				const k = step / steps;
				api.circle(x1 + (x2 - x1) * k, y1 + (y2 - y1) * k, half, color, alpha);
			}
		},
		text(value, x, y, options = {}) {
			const text = String(value ?? "");
			const size = Math.max(4, options.size ?? 48);
			const scale = Math.max(1, Math.round(size / 7));
			const spacing = options.spacing ?? scale;
			const color = parseColor(options.color ?? "#ffffff");
			const alpha = Math.max(0, Math.min(1, options.opacity ?? 1));
			const advance = 5 * scale + spacing;
			const totalWidth = text.length * advance - spacing;
			const startX = options.align === "left" ? x : options.align === "right" ? x - totalWidth : x - totalWidth / 2;
			const top = y - 7 * scale / 2;
			for (let index = 0; index < text.length; index++) drawGlyph(buffer, width, height, text[index], Math.round(startX + index * advance), Math.round(top), scale, color, alpha);
		},
		gradient(x, y, w, h, stops, angle = 0) {
			const parsedStops = (stops.length > 0 ? stops : [[0, "#000000"], [1, "#ffffff"]]).map(([offset, color]) => [Math.max(0, Math.min(1, offset)), parseColor(color)]);
			const x0 = Math.max(0, Math.floor(x));
			const y0 = Math.max(0, Math.floor(y));
			const x1 = Math.min(width, Math.ceil(x + w));
			const y1 = Math.min(height, Math.ceil(y + h));
			const rad = angle * Math.PI / 180;
			const cos = Math.cos(rad);
			const sin = Math.sin(rad);
			const span = Math.abs(cos) * w + Math.abs(sin) * h;
			for (let py = y0; py < y1; py++) for (let px = x0; px < x1; px++) {
				const projected = (px - x) * cos + (py - y) * sin;
				const k = span === 0 ? 0 : Math.max(0, Math.min(1, projected / span));
				let [first, second] = [parsedStops[0], parsedStops[parsedStops.length - 1]];
				for (let index = 0; index < parsedStops.length - 1; index++) {
					const a = parsedStops[index];
					const b = parsedStops[index + 1];
					if (k >= a[0] && k <= b[0]) {
						first = a;
						second = b;
						break;
					}
				}
				const local = second[0] === first[0] ? 0 : (k - first[0]) / (second[0] - first[0]);
				const color = [
					Math.round(first[1][0] + (second[1][0] - first[1][0]) * local),
					Math.round(first[1][1] + (second[1][1] - first[1][1]) * local),
					Math.round(first[1][2] + (second[1][2] - first[1][2]) * local),
					255
				];
				blendPixel(buffer, (py * width + px) * 4, color, 1);
			}
		},
		ease(t) {
			return t < .5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
		},
		lerp(a, b, t) {
			return a + (b - a) * t;
		},
		clamp(value, min, max) {
			return Math.max(min, Math.min(max, value));
		}
	};
	return api;
}
/**
* Extract the body of the model's `render` function from its answer.
*
* The model is asked for `function render(ctx) { … }`, but answers arrive with
* fences, a leading `const`, an arrow function, or prose around it. All of
* those are accepted; what is NOT accepted is "here is the code" with no
* function at all, which would otherwise compile and silently draw nothing.
*/
function extractRenderSource(answer) {
	const cleaned = String(answer ?? "").trim().replace(/^```(?:javascript|js|typescript|ts)?/i, "").replace(/```$/, "").trim();
	for (const [pattern, group] of [[/function\s+render\s*\(([^)]*)\)\s*\{/i, 1], [/(?:const|let|var)\s+render\s*=\s*(?:async\s*)?\(?([^)=]*)\)?\s*=>\s*\{/i, 1]]) {
		const match = pattern.exec(cleaned);
		if (match === null) continue;
		const openIndex = cleaned.indexOf("{", match.index + match[0].length - 1);
		if (openIndex < 0) continue;
		let depth = 0;
		let end = -1;
		for (let index = openIndex; index < cleaned.length; index++) {
			const char = cleaned[index];
			if (char === "{") depth += 1;
			else if (char === "}") {
				depth -= 1;
				if (depth === 0) {
					end = index;
					break;
				}
			}
		}
		if (end < 0) continue;
		const body = cleaned.slice(openIndex + 1, end);
		if (body.trim() === "") continue;
		return body;
	}
	return cleaned;
}
/** Whether a source string looks like it contains code at all. */
function looksLikeCode(source) {
	return /[{};]|=>|function\s|ctx\./.test(source);
}
/** Compile the model's source into a callable, once, before any rendering. */
function compileRenderer(source) {
	const code = extractRenderSource(source);
	if (!looksLikeCode(code)) throw new CodeRenderError("对话模型没有给出可执行的绘图代码（返回的是说明文字）。请重试，或切回模型生成。", "code-not-code", true);
	const sandbox = vm.createContext(Object.create(null));
	let factory;
	try {
		factory = vm.runInContext(`(function(ctx, frame, Math, JSON, Array, Object, String, Number, Boolean, isFinite, isNaN) {${code}\n})`, sandbox, {
			timeout: 2e3,
			filename: "generated-render.js",
			displayErrors: true
		});
	} catch (error) {
		throw new CodeRenderError(`生成的代码无法编译：${error instanceof Error ? error.message : String(error)}`, "code-syntax", true);
	}
	if (typeof factory !== "function") throw new CodeRenderError("生成的代码不是可调用的渲染函数", "code-syntax", true);
	return (api, frameIndex) => {
		factory(api, frameIndex, Math, JSON, Array, Object, String, Number, Boolean, isFinite, isNaN);
	};
}
/**
* Spawn ffmpeg and return a handle that writes raw RGBA frames to its stdin.
*
* The output goes to a temp FILE, not to `pipe:1`. Measured on this machine's
* ffmpeg 6.0 build: writing mp4 to stdout aborts the process (`EPIPE` on its
* stdin) while writing the identical frames to a file exits 0 — the encoder
* needs a seekable output for its header rewrite. The file is read back and
* removed by {@link finish}; the leftover is also cleaned by the caller's
* `finally` when a render fails midway.
*/
function startEncoder(ffmpeg, width, height, fps) {
	const tempFile = path.join(process.env.TMPDIR?.trim() || "/tmp", `dsh-code-render-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.mp4`);
	const child = spawn(ffmpeg, [
		"-hide_banner",
		"-loglevel",
		"error",
		"-f",
		"rawvideo",
		"-pix_fmt",
		"rgba",
		"-s",
		`${width}x${height}`,
		"-r",
		String(fps),
		"-i",
		"pipe:0",
		"-pix_fmt",
		"yuv420p",
		"-c:v",
		"libx264",
		"-preset",
		"veryfast",
		"-crf",
		"20",
		"-f",
		"mp4",
		tempFile,
		"-y"
	], { stdio: [
		"pipe",
		"ignore",
		"pipe"
	] });
	let stderrText = "";
	child.stderr?.on("data", (chunk) => {
		stderrText += String(chunk);
	});
	let spawnError;
	const closed = new Promise((resolve) => {
		child.on("error", (error) => {
			spawnError = error;
			resolve(-1);
		});
		child.on("close", (code) => {
			resolve(code ?? -1);
		});
	});
	const spawnFailure = () => {
		if (spawnError === void 0) return void 0;
		return new CodeRenderError(`${spawnError.code === "ENOENT" ? "本机找不到 ffmpeg" : spawnError.code === "EACCES" ? "ffmpeg 没有执行权限" : `无法启动 ffmpeg（${spawnError.code ?? spawnError.message}）`}：无法编码代码生成的视频。请安装 ffmpeg（macOS：brew install ffmpeg），或在设置里填写 FFMPEG_PATH 后重试；也可以切回模型生成。`, "render-no-ffmpeg");
	};
	return {
		process: child,
		write: async (frame) => {
			const failed = spawnFailure();
			if (failed !== void 0) throw failed;
			if (child.stdin === null || child.stdin.destroyed) throw new CodeRenderError("ffmpeg 编码进程已退出，渲染中止", "render-encoder-died");
			if (child.stdin.errored !== null) throw new CodeRenderError("ffmpeg 编码进程已退出，渲染中止", "render-encoder-died");
			try {
				if (!child.stdin.write(frame)) {
					if (await Promise.race([new Promise((resolve) => {
						const onDrain = () => {
							child.stdin?.off("error", onError);
							resolve("drained");
						};
						const onError = () => {
							child.stdin?.off("drain", onDrain);
							resolve("error");
						};
						child.stdin.once("drain", onDrain);
						child.stdin.once("error", onError);
					}), closed.then(() => "closed")]) !== "drained") throw spawnFailure() ?? new CodeRenderError("ffmpeg 编码进程已退出，渲染中止", "render-encoder-died");
				}
			} catch (error) {
				if (error instanceof CodeRenderError) throw error;
				const code = error?.code;
				throw new CodeRenderError(`ffmpeg 写入失败（${code ?? "unknown"}）`, "render-encoder-died");
			}
		},
		finish: async () => {
			try {
				child.stdin?.end();
			} catch {}
			const code = await closed;
			if (code !== 0) {
				const failure = spawnFailure();
				const detail = stderrText.trim().split("\n").slice(-3).join(" ").trim();
				await promises.rm(tempFile, { force: true }).catch(() => {});
				if (failure !== void 0) throw failure;
				throw new CodeRenderError(`ffmpeg 编码失败（退出码 ${code}）${detail === "" ? "" : `：${detail}`}`, "render-encoder-failed");
			}
			try {
				const bytes = await promises.readFile(tempFile);
				if (bytes.length === 0) throw new CodeRenderError("ffmpeg 没有输出任何视频数据", "render-empty");
				return bytes;
			} finally {
				await promises.rm(tempFile, { force: true }).catch(() => {});
			}
		},
		stderr: () => stderrText
	};
}
/** Encode one RGBA frame as a PNG, in-process, without a native dependency. */
function encodePng(rgba, width, height) {
	const zlib = { deflateSync };
	const raw = Buffer.alloc((width * 4 + 1) * height);
	for (let y = 0; y < height; y++) {
		raw[y * (width * 4 + 1)] = 0;
		rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
	}
	const idat = zlib.deflateSync(raw, { level: 6 });
	const crcTable = (() => {
		const table = /* @__PURE__ */ new Int32Array(256);
		for (let n = 0; n < 256; n++) {
			let c = n;
			for (let k = 0; k < 8; k++) c = c & 1 ? 3988292384 ^ c >>> 1 : c >>> 1;
			table[n] = c;
		}
		return table;
	})();
	const crc32 = (buffer) => {
		let c = 4294967295;
		for (let i = 0; i < buffer.length; i++) c = crcTable[(c ^ buffer[i]) & 255] ^ c >>> 8;
		return (c ^ 4294967295) >>> 0;
	};
	const chunk = (type, data) => {
		const length = Buffer.alloc(4);
		length.writeUInt32BE(data.length, 0);
		const typeBuffer = Buffer.from(type, "ascii");
		const crc = Buffer.alloc(4);
		crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
		return Buffer.concat([
			length,
			typeBuffer,
			data,
			crc
		]);
	};
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8;
	ihdr[9] = 6;
	ihdr[10] = 0;
	ihdr[11] = 0;
	ihdr[12] = 0;
	return Buffer.concat([
		Buffer.from([
			137,
			80,
			78,
			71,
			13,
			10,
			26,
			10
		]),
		chunk("IHDR", ihdr),
		chunk("IDAT", idat),
		chunk("IEND", Buffer.alloc(0))
	]);
}
/**
* Render the model's code into a video or a still.
*
* One function for both outputs because the difference is only how many frames
* are asked for and how they are encoded — a still is frame 0 drawn once.
*
* @param request - output settings and the generated source.
* @param options - ffmpeg path override (tests inject a fake) and cancellation.
* @returns the encoded bytes plus the source that produced them.
*/
async function renderCode(request, options = {}) {
	const width = Math.round(request.width);
	const height = Math.round(request.height);
	if (!Number.isFinite(width) || !Number.isFinite(height) || width < 16 || height < 16) throw new CodeRenderError(`渲染尺寸不合法（${request.width}×${request.height}）`, "render-bad-size");
	if (width * height > MAX_PIXELS) throw new CodeRenderError(`渲染尺寸过大（${width}×${height}）`, "render-bad-size");
	const source = String(request.source ?? "");
	if (source.trim() === "") throw new CodeRenderError("没有可渲染的代码：对话模型没有返回内容", "code-empty", true);
	if (source.length > 6e4) throw new CodeRenderError(`生成的代码过长（${source.length} 字符，上限 ${MAX_CODE_CHARS}）`, "code-too-long", true);
	const fps = request.kind === "video" ? Math.max(1, Math.min(60, Math.round(request.fps))) : 1;
	const seconds = request.kind === "video" ? Math.max(.2, Math.min(120, request.seconds)) : 1 / fps;
	const frames = request.kind === "video" ? Math.max(1, Math.round(fps * seconds)) : 1;
	const renderer = compileRenderer(source);
	const budgetMs = request.timeoutMs ?? 12e4;
	const deadline = Date.now() + budgetMs;
	const renderFrame = (frameIndex) => {
		if (options.signal?.aborted === true) throw new CodeRenderError("代码渲染已取消", "render-cancelled");
		if (Date.now() > deadline) throw new CodeRenderError(`代码渲染超时（已用 ${Math.round(budgetMs / 1e3)} 秒）`, "render-timeout", true);
		const buffer = Buffer.alloc(width * height * 4);
		const api = createFrameApi(buffer, width, height, fps, seconds, frameIndex);
		try {
			renderer(api, frameIndex);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new CodeRenderError(`生成的代码运行出错（第 ${frameIndex + 1} 帧）：${message}`, "code-runtime", true);
		}
		return buffer;
	};
	if (request.kind === "image") {
		const png = encodePng(renderFrame(0), width, height);
		if (png.length === 0) throw new CodeRenderError("渲染出的图片为空", "render-empty");
		return {
			bytes: png,
			mime: "image/png",
			source,
			width,
			height
		};
	}
	const ffmpeg = options.ffmpeg ?? locateFfmpeg();
	if (ffmpeg === void 0) throw new CodeRenderError("本机找不到 ffmpeg，无法编码代码生成的视频。请安装 ffmpeg（macOS：brew install ffmpeg），或在设置里填写 FFMPEG_PATH 后重试；也可以切回模型生成。", "render-no-ffmpeg");
	const encoder = startEncoder(ffmpeg, width, height, fps);
	let aborted = false;
	const onAbort = () => {
		aborted = true;
		encoder.process.kill("SIGKILL");
	};
	options.signal?.addEventListener("abort", onAbort, { once: true });
	let bytes;
	try {
		for (let frameIndex = 0; frameIndex < frames; frameIndex++) {
			if (aborted || options.signal?.aborted === true) throw new CodeRenderError("代码渲染已取消", "render-cancelled");
			await encoder.write(renderFrame(frameIndex));
		}
		bytes = await encoder.finish();
	} catch (error) {
		encoder.process.kill("SIGKILL");
		if (aborted || options.signal?.aborted === true) throw new CodeRenderError("代码渲染已取消", "render-cancelled");
		throw error;
	} finally {
		options.signal?.removeEventListener("abort", onAbort);
	}
	return {
		bytes,
		mime: "video/mp4",
		source,
		width,
		height,
		fps,
		seconds
	};
}
//#endregion
//#region src/code-prompt.ts
/**
* The drawing API, documented for the model.
*
* Every method here is exercised by `code-render.ts`; a method the model invents
* fails at run time with a legible TypeError, which is why the list is stated
* as complete and final.
*/
const API_DOC = `ctx.width, ctx.height   // output size in pixels (use these, never hard-code)
ctx.fps                 // frames per second (video only)
ctx.duration            // seconds (video only)
ctx.frame               // 0-based frame index
ctx.t                   // 0..1 progress through the clip

ctx.background(color)
ctx.rect(x, y, w, h, color, opacity?)
ctx.roundRect(x, y, w, h, radius, color, opacity?)
ctx.circle(cx, cy, r, color, opacity?)
ctx.line(x1, y1, x2, y2, thickness, color, opacity?)
ctx.text(value, x, y, { size?, color?, align?: 'left'|'center'|'right', weight?, opacity?, spacing? })
ctx.gradient(x, y, w, h, [[offset0to1, color], ...], angleDegrees?)
ctx.ease(t)             // ease-in-out, 0..1 -> 0..1
ctx.lerp(a, b, t)
ctx.clamp(value, min, max)

Colors: '#rgb', '#rrggbb', '#rrggbbaa', 'rgb(r,g,b)', 'rgba(r,g,b,a)'.

The font is a built-in 5x7 bitmap font: ASCII letters, digits, and . , : - + / % ! ? & ( ) °.
CJK and emoji render as an empty box — do NOT put Chinese/Japanese/Korean characters in
ctx.text(); draw shapes instead, or use the request's language for a title only if it is Latin.`;
/**
* Build the chat prompt for one render.
*
* Written as a specification rather than a conversation: the model is being
* asked for a single function, and every sentence that is not a constraint
* costs output tokens without improving the drawing.
*/
function codeRenderSystemPrompt(brief) {
	const chinese = /[\u4e00-\u9fff]/.test(brief.prompt);
	const output = brief.target === "video" ? `a ${brief.seconds}s video at ${brief.fps}fps (${Math.round((brief.fps ?? 30) * (brief.seconds ?? 5))} frames) at ${brief.width}x${brief.height}` : `a still image at ${brief.width}x${brief.height} (the function runs once, ctx.t = 0)`;
	const header = chinese ? `你是动效图形工程师。请为用户的需求写一段 JavaScript 绘图代码，输出 ${output}。` : `You are a motion-graphics engineer. Write JavaScript drawing code for the request, producing ${output}.`;
	const rules = chinese ? [
		"规则：",
		"1. 只输出一个函数：function render(ctx) { ... }，不要 Markdown 围栏、不要解释、不要 import/require。",
		"2. 每帧调用一次；必须根据 ctx.frame / ctx.t 计算动画，禁止使用 Math.random()、Date.now() 或任何时间/网络 API（结果必须可复现）。",
		"3. 只用下面这些 ctx 方法，不要假设有别的 API；不要访问 document/window/process。",
		"4. 先 ctx.background(...) 铺底，再画内容；颜色和排版要克制、有层次。",
		"5. 尺寸一律用 ctx.width / ctx.height 推导，保证任意分辨率都成立。",
		"6. 文字只用 Latin（内置点阵字体）；中文/emoji 会变成方框。",
		`7. 总时长 ${brief.seconds ?? 1} 秒，${brief.fps ?? 30} fps；动画要首尾自然（入场与收尾）。`,
		"",
		"绘图 API（完整列表）：",
		API_DOC
	] : [
		"Rules:",
		"1. Output exactly one function: function render(ctx) { ... } — no markdown fence, no explanation, no imports.",
		"2. It is called once per frame; drive all motion from ctx.frame / ctx.t. Never use Math.random(), Date.now() or any clock/network API (output must be reproducible).",
		"3. Use only the ctx methods below. Do not assume any other API, and do not touch document/window/process.",
		"4. Paint a background first, then content; keep colour and layout deliberate.",
		"5. Derive every dimension from ctx.width / ctx.height so the code works at any resolution.",
		"6. Text is the built-in Latin bitmap font; CJK and emoji draw as empty boxes.",
		`7. The clip is ${brief.seconds ?? 1}s at ${brief.fps ?? 30}fps; give it a clean entrance and exit.`,
		"",
		"Drawing API (complete list):",
		API_DOC
	];
	return [
		...chinese ? [] : [],
		header,
		"",
		...rules
	].join("\n");
}
/** Build the user turn: the request plus the hard output settings. */
function codeRenderUserPrompt(brief) {
	const chinese = /[\u4e00-\u9fff]/.test(brief.prompt);
	const params = brief.target === "video" ? `width=${brief.width}, height=${brief.height}, fps=${brief.fps}, seconds=${brief.seconds}` : `width=${brief.width}, height=${brief.height}`;
	return `${chinese ? "需求" : "Request"}: ${brief.prompt}\n${chinese ? "输出参数" : "Output"}: ${params}`;
}
/**
* Read the model's answer into the source handed to the executor.
*
* The executor accepts `function render(ctx){}`, an arrow form, or a bare body,
* so this only has to reject the one answer that cannot work: prose with no
* code in it. Rejecting here gives a wire code the panel can act on
* (`code-not-code`) instead of a downstream syntax error that reads like a bug.
*/
function readGeneratedCode(answer) {
	const text = String(answer ?? "").trim();
	if (text === "") return {
		ok: false,
		reason: "对话模型返回了空内容"
	};
	const cleaned = text.replace(/^```(?:javascript|js|typescript|ts)?/i, "").replace(/```\s*$/, "").trim();
	const hasFunction = /function\s+render\s*\(|(?:const|let|var)\s+render\s*=/.test(cleaned);
	const hasCalls = /ctx\.\w+\s*\(/.test(cleaned);
	if (!hasFunction && !hasCalls) return {
		ok: false,
		reason: `对话模型返回的不是绘图代码（没有 render 函数，也没有任何 ctx 调用）：${cleaned.replace(/\s+/g, " ").slice(0, 160)}`
	};
	if (cleaned.length > 6e4) return {
		ok: false,
		reason: "对话模型返回的代码过长"
	};
	return {
		ok: true,
		source: cleaned
	};
}
/**
* A last-resort renderer for when the chat model produces unusable code.
*
* Deliberately NOT presented as a successful generation: the caller marks the
* task as degraded and says so. It exists so the path always produces a
* playable artefact instead of dead-ending, and it draws the request itself as
* a title card — the one thing a code renderer is reliably good at.
*/
function fallbackRendererSource(brief) {
	const safe = brief.prompt.replace(/\s+/g, " ").trim().slice(0, 28).toUpperCase().replace(/[\\'"`]/g, "");
	return `
ctx.background('#0b1220')
ctx.gradient(0, 0, ctx.width, ctx.height, [[0, '#0b1220'], [1, '#16233d']], 90)
const p = ctx.ease(ctx.t)
ctx.rect(ctx.width * 0.1, ctx.height / 2 + 60, ctx.width * 0.8 * p, 4, '#7dd3fc')
ctx.text(${JSON.stringify(safe)}, ctx.width / 2, ctx.height / 2 - 10, { size: Math.round(ctx.height / 12), color: '#ffffff' })
ctx.rect(ctx.width * 0.1, ctx.height * 0.8, ctx.width * 0.8, 1, '#22304d')
`.trim();
}
//#endregion
//#region src/code-render-runtime.ts
/**
* Host-side orchestration of the code-render path.
*
* Sits beside `ImageGenerationRuntime` rather than inside it: the model paths
* call an image/video API and persist its bytes, while this path calls a chat
* model once, renders locally, and persists the result into the SAME two stores
* the model paths write to — the image history and the video history. That is
* what makes a code-rendered clip stitchable and a code-rendered still usable
* as a reference: downstream code sees an ordinary entry either way.
*
* No image or video model is ever contacted here. The only network call is the
* chat completion that writes the drawing code.
*/
/**
* Resolve the concrete pixel size a request will render at.
*
* Exposed so the panel can show the same numbers before spending a render, and
* so the probe route and the render route cannot drift apart.
*/
function codeRenderPlan(input) {
	const { width, height } = dimensionsFor(input.resolution, input.aspectRatio);
	if (input.kind === "image") return {
		width,
		height,
		fps: 1,
		seconds: 0,
		frames: 1
	};
	const fps = Math.max(1, Math.min(60, Math.round(input.fps ?? 30)));
	const seconds = Math.max(.2, Math.min(120, input.seconds ?? 5));
	return {
		width,
		height,
		fps,
		seconds,
		frames: Math.max(1, Math.round(fps * seconds))
	};
}
/** Reject an input that cannot produce anything, with copy the panel can show. */
function validateCodeInput(input) {
	const prompt = String(input.prompt ?? "").trim();
	if (prompt === "") throw new CodeRenderError("描述为空：请先写一句你想要的画面，代码生成会用这句描述来绘制", "code-prompt-empty");
	if (prompt.length > 4e3) throw new CodeRenderError(`描述过长（${prompt.length} 字符，上限 4000）：请压缩到核心画面与文案`, "code-prompt-too-long");
	if (input.kind !== "video" && input.kind !== "image") throw new CodeRenderError("未知的输出类型：只能是 video 或 image", "code-bad-kind");
}
/**
* Render one request through the code path end to end.
*
* Order matters: validate → plan → generate code → render → persist. Each step
* can fail with its own wire code, and nothing is written to a store until the
* bytes exist, so a failed run leaves no half-entry behind.
*/
async function runCodeRender(input, config, complete, options = {}) {
	validateCodeInput(input);
	const plan = codeRenderPlan(input);
	const brief = {
		target: input.kind,
		prompt: input.prompt.trim(),
		width: plan.width,
		height: plan.height,
		...input.kind === "video" ? {
			fps: plan.fps,
			seconds: plan.seconds
		} : {}
	};
	let source = "";
	let degraded = false;
	let degradedReason;
	if (typeof input.source === "string" && input.source.trim() !== "") source = input.source;
	else {
		if (config.apiUrl.trim() === "" || config.model.trim() === "") throw new CodeRenderError("尚未配置对话模型：代码生成需要「设置 → 提示词增强模型」里的对话模型来写绘图代码。请配置后重试，或切回模型生成。", "code-no-chat-model");
		let answer;
		try {
			answer = await complete({
				system: codeRenderSystemPrompt(brief),
				content: codeRenderUserPrompt(brief),
				temperature: .3,
				maxTokens: 3e3,
				...options.signal === void 0 ? {} : { signal: options.signal }
			});
		} catch (error) {
			if (options.signal?.aborted === true) throw new CodeRenderError("代码生成已取消", "code-cancelled");
			throw new CodeRenderError(`对话模型调用失败：${error instanceof Error ? error.message : String(error)}`, "code-chat-failed", true);
		}
		const read = readGeneratedCode(answer);
		if (!read.ok) {
			source = fallbackRendererSource(brief);
			degraded = true;
			degradedReason = `${read.reason}，已用内置标题卡渲染；可重试或切回模型生成。`;
		} else source = read.source;
	}
	const rendered = await renderCode({
		kind: input.kind,
		source,
		width: plan.width,
		height: plan.height,
		fps: plan.fps,
		seconds: plan.seconds
	}, {
		...options.ffmpeg === void 0 ? {} : { ffmpeg: options.ffmpeg },
		...options.signal === void 0 ? {} : { signal: options.signal }
	});
	const persist = options.persist !== false;
	const base = {
		kind: input.kind,
		width: rendered.width,
		height: rendered.height,
		...input.kind === "video" ? {
			fps: rendered.fps,
			seconds: rendered.seconds
		} : {},
		bytes: rendered.bytes,
		source,
		degraded,
		...degradedReason === void 0 ? {} : { degradedReason }
	};
	if (!persist) return base;
	const entryId = randomUUID();
	if (input.kind === "video") {
		const history = await appendVideoHistory({
			id: entryId,
			createdAt: Date.now(),
			mode: "text",
			model: config.model,
			prompt: input.prompt.trim(),
			aspectRatio: input.aspectRatio,
			resolution: input.resolution,
			seconds: rendered.seconds ?? plan.seconds,
			files: [{
				bytes: rendered.bytes,
				mime: rendered.mime,
				duration: rendered.seconds ?? plan.seconds
			}],
			renderer: "code",
			...input.canvasId === void 0 ? {} : { channel: void 0 }
		});
		const clip = history.find((item) => item.id === entryId)?.videos[0];
		return {
			...base,
			video: {
				entryId,
				url: clip?.url ?? "",
				mime: clip?.mime ?? "video/mp4",
				...clip?.duration === void 0 ? {} : { duration: clip.duration }
			},
			history
		};
	}
	const b64 = rendered.bytes.toString("base64");
	const history = await appendHistory({
		id: entryId,
		createdAt: Date.now(),
		mode: "text",
		model: config.model,
		prompt: input.prompt.trim(),
		size: `${rendered.width}x${rendered.height}`,
		quality: "code",
		detail: "",
		n: 1,
		images: [{
			b64,
			mime: rendered.mime
		}],
		renderer: "code"
	});
	const stored = history.find((item) => item.id === entryId);
	return {
		...base,
		image: {
			entryId,
			url: stored?.images[0]?.url ?? "",
			mime: rendered.mime
		},
		history
	};
}
/**
* Report what a request WOULD do, without a model call or a rendered frame.
*
* The panel uses this to show the exact pixel size and frame count and to warn
* early when ffmpeg is missing — the one failure a user can fix before paying
* for a model call.
*/
function probeCodeRender(input, ffmpeg) {
	const plan = codeRenderPlan(input);
	const resolved = ffmpeg ?? locateFfmpeg();
	return {
		width: plan.width,
		height: plan.height,
		fps: plan.fps,
		seconds: plan.seconds,
		frames: plan.frames,
		ffmpegAvailable: resolved !== void 0,
		ffmpegPath: resolved
	};
}
//#endregion
//#region src/generation-runtime.ts
/**
* Shared host-side generation runtime. Both the browser routes and Agent tools
* submit to this one queue so persisted history and cancellation semantics stay
* identical regardless of where a request originated.
*
* Requests carry a channel id (host-filled by the route/tool resolution); the
* runtime picks that channel's upstream credentials, otherwise the default
* channel, and records a channel snapshot on the history entry so usage
* counters and filters survive channel deletion.
*/
var ImageGenerationRuntime = class {
	resolve;
	history;
	subscriptions;
	director;
	hostChat;
	queue;
	/** Video runs through its own queue: a render takes minutes, not seconds. */
	videoQueue;
	constructor(resolve, history = { append: appendHistory }, subscriptions, director, hostChat) {
		this.resolve = resolve;
		this.history = history;
		this.subscriptions = subscriptions;
		this.director = director;
		this.hostChat = hostChat;
		this.queue = new GenerationTaskQueue((request, signal) => this.run(request, signal), 4);
		this.videoQueue = new VideoTaskQueue((request, signal) => this.runVideo(request, signal), 1);
	}
	/**
	* Resolve the channel that owns one video model alias.
	*
	* A video request names a model alias, not a channel, and video aliases live
	* in a channel's `videoModels` catalog rather than its image `models` one. So
	* resolution is: the alias's own channel, then the explicitly requested
	* channel, then the default channel.
	*/
	videoChannel(model, channelId, view) {
		return view.channels.find((candidate) => (candidate.videoModels ?? []).some((row) => row.alias === model)) ?? view.channels.find((candidate) => candidate.id === channelId) ?? view.channels.find((candidate) => candidate.id === view.defaultChannelId) ?? view.channels[0];
	}
	/**
	* Resolve the chat endpoint used by the director step.
	*
	* Absent on hosts that did not mount prompt enhancement: planning then runs
	* on the offline backend rather than failing, so video still works.
	*/
	directorSeam() {
		return this.director;
	}
	/**
	* Run the planning step for one video request.
	*
	* Deliberately public and side-effect free (it never renders, never writes
	* history) so the preview route can show the same plan the submit path will
	* use, without spending a render.
	*/
	async planVideoRequest(request, signal) {
		const view = this.resolve();
		const channel = this.videoChannel(request.model, request.channelId, view);
		const upstream = channel === void 0 ? request.model : (channel.videoModels ?? []).find((row) => row.alias === request.model)?.id ?? request.model;
		const seam = this.directorSeam();
		return planVideo({
			mode: request.mode,
			prompt: request.prompt,
			aspectRatio: request.aspectRatio,
			resolution: request.resolution,
			seconds: request.seconds,
			model: upstream,
			hasReference: request.image !== void 0 || request.firstFrame !== void 0 || request.lastFrame !== void 0 || (request.images?.length ?? 0) > 0
		}, seam?.resolveConfig(), seam?.complete, signal);
	}
	/** Generate one video: submit, poll, download, then persist the clip. */
	async runVideo(request, signal) {
		if (request.renderer === "code") return await this.runVideoCode(request, signal);
		const view = this.resolve();
		const channel = this.videoChannel(request.model, request.channelId, view);
		if (channel === void 0) throw new VideoGenError("尚未配置任何渠道：请先打开「设置 → 生图配置」添加渠道并填写 API 地址与密钥", "no-channels");
		const upstream = (channel.videoModels ?? []).find((row) => row.alias === request.model)?.id ?? request.model;
		const family = describeVideoModel(upstream).family;
		if (family === "unknown") throw new VideoGenError(`渠道「${channel.name}」未为模型「${request.model}」配置视频协议族；请在渠道的视频模型中改用受支持的视频模型`, "video-unknown-model");
		let plan;
		let effective = {
			...request,
			upstream
		};
		if (request.plan === true) {
			try {
				requirePrompt(request.prompt);
			} catch (error) {
				if (error instanceof VideoPlanError) throw error;
				throw new VideoPlanError(error instanceof Error ? error.message : String(error));
			}
			const startedAt = Date.now();
			plan = request.planPreview !== void 0 ? adoptPlan(request, upstream) : await this.planVideoRequest(request, signal);
			if (plan.degraded) recordDiagnostic({
				phase: "video-plan",
				channel: channel.name,
				model: request.model,
				mode: request.mode,
				url: "chat/completions",
				method: "POST",
				failureCode: "video-plan-degraded",
				message: plan.degradedReason ?? "规划降级为离线模式",
				requestExcerpt: plan.notes.length > 0 ? plan.notes.join(" · ") : void 0,
				durationMs: Date.now() - startedAt,
				hadAuth: (this.directorSeam()?.resolveConfig().apiKey.trim() ?? "") !== ""
			});
			effective = applyPlan(effective, plan);
		}
		const result = await generateVideo({
			apiUrl: channel.apiUrl,
			apiKey: channel.apiKey,
			apiUrlFull: channel.apiUrlFull,
			protocol: channel.protocol,
			channelName: channel.name
		}, effective, {
			...signal === void 0 ? {} : { signal },
			family
		});
		const entryId = randomUUID();
		try {
			const history = await appendVideoHistory({
				id: entryId,
				createdAt: Date.now(),
				mode: effective.mode,
				model: effective.model,
				prompt: effective.prompt,
				aspectRatio: effective.aspectRatio,
				resolution: effective.resolution,
				seconds: effective.seconds,
				files: result.videos.map((video) => ({
					bytes: video.bytes,
					mime: video.mime,
					...video.duration === void 0 ? {} : { duration: video.duration },
					...video.poster === void 0 ? {} : { poster: video.poster },
					...video.revisedPrompt === void 0 ? {} : { revisedPrompt: video.revisedPrompt }
				})),
				...request.refName === void 0 ? {} : { refName: request.refName },
				...channel.id === void 0 ? {} : { channelId: channel.id },
				channel: channel.name,
				...plan === void 0 ? {} : { plan }
			});
			return {
				videos: history.find((entry) => entry.id === entryId)?.videos ?? [],
				history,
				...plan === void 0 ? {} : { plan }
			};
		} catch (error) {
			return {
				videos: result.videos.map((video) => ({
					url: video.sourceUrl,
					mime: video.mime,
					...video.duration === void 0 ? {} : { duration: video.duration },
					...video.poster === void 0 ? {} : { poster: video.poster }
				})),
				historyError: error instanceof Error ? error.message : String(error),
				...plan === void 0 ? {} : { plan }
			};
		}
	}
	/**
	* The chat model the code path draws with.
	*
	* Preference order matters and is the whole point of this seam: the DSH
	* host's own conversation model first (the one the user already talks to),
	* and only then the plugin's prompt-enhancement endpoint. Neither adds a new
	* setting — there is nothing to configure beyond picking this path.
	*/
	codeProvider() {
		const host = this.hostChat;
		if (host !== void 0 && host.available()) return {
			config: {
				apiUrl: HOST_CHAT_ENDPOINT,
				apiKey: "",
				model: host.label()
			},
			complete: async (options) => await host.complete({
				system: options.system,
				content: options.content,
				...options.signal === void 0 ? {} : { signal: options.signal }
			})
		};
		const seam = this.director;
		if (seam === void 0) throw new CodeRenderError("没有可用的对话模型：代码生成需要 DSH 里已接入的模型（或「设置 → 提示词增强模型」）。请配置后重试，或切回模型生成。", "code-no-chat-model");
		return {
			config: seam.resolveConfig(),
			complete: seam.complete
		};
	}
	/**
	* Render one clip through the code path and persist it like any other clip.
	*
	* The persistence step deliberately mirrors the model path field for field
	* (mode / prompt / aspectRatio / resolution / seconds / files) and only adds
	* `renderer: 'code'`. Downstream — the canvas placeholder, the clip history,
	* favoriting, stitching, the timeline — cannot tell the two apart, which is
	* the whole requirement.
	*/
	async runVideoCode(request, signal) {
		const provider = this.codeProvider();
		const config = provider.config;
		const outcome = await runCodeRender({
			kind: "video",
			prompt: request.prompt,
			resolution: request.resolution,
			aspectRatio: request.aspectRatio,
			seconds: request.seconds,
			fps: CODE_RENDER_FPS,
			model: config.model,
			...request.renderSource === void 0 ? {} : { source: request.renderSource }
		}, config, provider.complete, {
			...signal === void 0 ? {} : { signal },
			persist: false
		});
		const entryId = randomUUID();
		const duration = outcome.seconds ?? request.seconds;
		try {
			const history = await appendVideoHistory({
				id: entryId,
				createdAt: Date.now(),
				mode: request.mode,
				model: config.model,
				prompt: request.prompt.trim(),
				aspectRatio: request.aspectRatio,
				resolution: request.resolution,
				seconds: duration,
				files: [{
					bytes: outcome.bytes,
					mime: outcome.kind === "video" ? "video/mp4" : "image/png",
					duration
				}],
				renderer: "code",
				...request.channel === void 0 ? {} : { channel: request.channel }
			});
			return {
				videos: history.find((entry) => entry.id === entryId)?.videos ?? [],
				history,
				renderer: "code",
				renderSource: outcome.source,
				degraded: outcome.degraded,
				...outcome.degradedReason === void 0 ? {} : { degradedReason: outcome.degradedReason }
			};
		} catch (error) {
			return {
				videos: [],
				historyError: error instanceof Error ? error.message : String(error),
				renderer: "code",
				renderSource: outcome.source,
				degraded: outcome.degraded,
				...outcome.degradedReason === void 0 ? {} : { degradedReason: outcome.degradedReason }
			};
		}
	}
	/**
	* Render one still through the code path and persist it into the image
	* history — the same store the model path writes, so the canvas uploads it,
	* the gallery can favorite it, and an edit can reference it.
	*/
	async runImageCode(request, signal) {
		const provider = this.codeProvider();
		const config = provider.config;
		const { resolution, aspectRatio } = stillShape(request.size, request.quality);
		const outcome = await runCodeRender({
			kind: "image",
			prompt: request.prompt,
			resolution,
			aspectRatio,
			model: config.model,
			...request.renderSource === void 0 ? {} : { source: request.renderSource }
		}, config, provider.complete, {
			...signal === void 0 ? {} : { signal },
			persist: false
		});
		const images = [{
			b64: outcome.bytes.toString("base64"),
			mime: "image/png"
		}];
		try {
			return {
				images,
				history: await this.history.append({
					id: randomUUID(),
					createdAt: Date.now(),
					mode: request.mode,
					model: config.model,
					prompt: request.prompt.trim(),
					size: `${outcome.width}x${outcome.height}`,
					quality: "code",
					detail: request.detail,
					n: 1,
					images,
					renderer: "code",
					...request.refName === void 0 ? {} : { refName: request.refName },
					...request.canvas === void 0 ? {} : { canvas: request.canvas }
				}),
				renderer: "code",
				renderSource: outcome.source,
				degraded: outcome.degraded,
				...outcome.degradedReason === void 0 ? {} : { degradedReason: outcome.degradedReason }
			};
		} catch (error) {
			return {
				images,
				historyError: error instanceof Error ? error.message : String(error),
				renderer: "code",
				renderSource: outcome.source,
				degraded: outcome.degraded,
				...outcome.degradedReason === void 0 ? {} : { degradedReason: outcome.degradedReason }
			};
		}
	}
	async run(request, signal) {
		if (request.renderer === "code") return await this.runImageCode(request, signal);
		const view = this.resolve();
		const channel = view.channels.find((candidate) => candidate.id === request.channelId) ?? view.channels.find((candidate) => candidate.id === view.defaultChannelId) ?? view.channels[0];
		if (channel === void 0) throw new ImageGenError("尚未配置任何渠道：请先打开「设置 → 生图配置」添加渠道并填写 API 地址与密钥", "no-channels");
		const result = channel.auth === "subscription" && channel.subscription !== void 0 ? { images: await this.generateSubscription(channel.subscription, request, signal) } : await generateImage({
			apiUrl: channel.apiUrl,
			apiKey: channel.apiKey,
			apiUrlFull: channel.apiUrlFull,
			protocol: channel.protocol,
			channelName: channel.name
		}, request, { signal });
		try {
			const history = await this.history.append({
				id: randomUUID(),
				createdAt: Date.now(),
				mode: request.mode,
				model: request.model,
				prompt: request.prompt,
				size: request.size,
				quality: request.quality,
				detail: request.detail,
				n: request.n,
				images: result.images,
				...request.refName === void 0 ? {} : { refName: request.refName },
				...request.channelId === void 0 ? {} : { channelId: request.channelId },
				...request.channel === void 0 ? {} : { channel: request.channel },
				...request.comparisonId === void 0 ? {} : { comparisonId: request.comparisonId },
				...request.comparisonModels === void 0 ? {} : { comparisonModels: request.comparisonModels },
				...request.workflow === void 0 ? {} : { workflow: request.workflow },
				...request.projectId === void 0 ? {} : { projectId: request.projectId },
				...request.projectName === void 0 ? {} : { projectName: request.projectName },
				...request.slotKey === void 0 ? {} : { slotKey: request.slotKey },
				...request.slotLabel === void 0 ? {} : { slotLabel: request.slotLabel },
				...request.canvas === void 0 ? {} : { canvas: request.canvas }
			});
			return {
				...result,
				history
			};
		} catch (error) {
			return {
				...result,
				historyError: error instanceof Error ? error.message : String(error)
			};
		}
	}
	/** Generate images through one logged-in subscription account. */
	async generateSubscription(provider, request, signal) {
		if (this.subscriptions === void 0) throw new ImageGenError("当前部署未挂载 DSH Credentials，订阅账号不可用", "subscription-unavailable");
		const references = subscriptionReferences(request);
		const count = Math.max(1, Math.min(4, Math.trunc(request.n) || 1));
		return (await Promise.all(Array.from({ length: count }, async () => await this.subscriptions.generate({
			vendor: vendorOf(provider),
			prompt: request.prompt,
			size: request.size,
			quality: request.quality,
			...references.length > 0 ? { referenceImages: references } : {},
			...signal === void 0 ? {} : { signal }
		})))).flatMap((batch) => batch.flatMap((row) => {
			const mime = detectImageMime(Buffer.from(row.b64_json, "base64"));
			if (mime === void 0) throw new ImageGenError("订阅图像返回了无法识别的图片格式", "subscription-invalid-image");
			return [{
				b64: row.b64_json,
				mime,
				...row.revisedPrompt === void 0 ? {} : { revisedPrompt: row.revisedPrompt }
			}];
		}));
	}
};
/**
* Stand-in endpoint for the host-model seam.
*
* The host conversation model is reached through an agent, not HTTP, so there
* is no URL to dial. `runCodeRender` refuses to call a model when the endpoint
* looks unconfigured, so this sentinel exists purely to say "provider present".
*/
const HOST_CHAT_ENDPOINT = "dsh://host-model";
/**
* Frame rate the code path renders at.
*
* Fixed rather than user-facing: the model path's clip length is provider-
* defined, so exposing fps here would add a knob no model path has. Everything
* the user DOES choose — aspect ratio, resolution tier, seconds — is honoured.
*/
const CODE_RENDER_FPS = 30;
/**
* Map the panel's image size/quality vocabulary onto a code render.
*
* The panel speaks `size: 'auto' | '1:1' | '3:4' | ...` and
* `quality: 'auto' | '1k' | '2k' | '4k'`; the renderer speaks pixels. 'auto'
* falls back to a square, which is what an unset image model would produce.
*/
function stillShape(size, quality) {
	const aspectRatio = size === "auto" || size.trim() === "" ? "1:1" : size.trim();
	return {
		resolution: quality === "1k" ? "720P" : "1080P",
		aspectRatio
	};
}
/** Decode the request's data-URL references into subscription wire images. */
function subscriptionReferences(request) {
	return [request.image, ...request.images ?? []].filter((value) => typeof value === "string" && value !== "").slice(0, 5).map((value) => {
		const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,(.*)$/su.exec(value);
		if (match === null || match[1] === void 0 || match[2] === void 0) throw new ImageGenError("订阅图生图收到无法解码的参考图片", "subscription-invalid-reference");
		return {
			data: Buffer.from(match[2], "base64"),
			mediaType: match[1]
		};
	});
}
//#endregion
//#region src/gallery-store.ts
/**
* Host-persisted gallery (user-curated favorites): mirrors the history store
* (image files + an index.json under ~/.dsh/dsh-imagegen-studio/gallery/) but with no
* size cap — every entry is an explicit user choice. Appends are deduplicated
* by image content so adding the same generated image twice is a no-op.
*
* Removal is a SOFT delete: the entry is flagged with `deletedAt` and moved to
* the trash for `GALLERY_TRASH_RETENTION_MS`, while its files stay exactly
* where they are. History rows, canvas nodes and open lightboxes hold URLs that
* point straight at those files — unlinking them on delete would turn every
* existing reference into a broken image, and restoring would hand back an
* empty card. `restoreGallery` clears the flag; `purgeGallery` (and the
* retention sweep) is the only thing that actually unlinks.
*
* Framework-free (node:fs + node:crypto only) so the route layer can drive it
* directly.
*/
/** Prefix route serving one favorited clip. */
const GALLERY_VIDEO_FILE_ROUTE = GALLERY_API.videoFile;
function galleryDir() {
	return path.join(imageDataRoot(), "gallery");
}
function indexPath() {
	return path.join(galleryDir(), "index.json");
}
function imagesDir() {
	return path.join(galleryDir(), "images");
}
function videosDir() {
	return path.join(galleryDir(), "videos");
}
/** How long a soft-deleted entry stays recoverable. */
const GALLERY_TRASH_RETENTION_MS = 720 * 60 * 60 * 1e3;
let pendingMutation = Promise.resolve();
function mutateGallery(operation) {
	const next = pendingMutation.then(operation, operation);
	pendingMutation = next.then(() => void 0, () => void 0);
	return next;
}
/** File extension for a MIME type (image file names). */
function extensionOf$3(mime) {
	switch (mime.split(";")[0].trim()) {
		case "image/jpeg": return "jpg";
		case "image/webp": return "webp";
		case "image/gif": return "gif";
		default: return "png";
	}
}
/** File extension for a video MIME type. */
function videoExtensionOf(mime) {
	switch (mime.split(";")[0].trim().toLowerCase()) {
		case "video/webm": return "webm";
		case "video/quicktime": return "mov";
		case "video/x-matroska": return "mkv";
		default: return "mp4";
	}
}
/** MIME type for a stored clip file name. */
function videoMimeOfFile(file) {
	switch (path.extname(file).toLowerCase()) {
		case ".webm": return "video/webm";
		case ".mov": return "video/quicktime";
		case ".mkv": return "video/x-matroska";
		default: return "video/mp4";
	}
}
/** MIME type for a stored image file name (image route responses). */
function mimeOfFile$1(file) {
	switch (path.extname(file).toLowerCase()) {
		case ".jpg":
		case ".jpeg": return "image/jpeg";
		case ".webp": return "image/webp";
		case ".gif": return "image/gif";
		default: return "image/png";
	}
}
/** Sanitize an entry id for use as a file-name prefix. */
function safeId$1(id) {
	const cleaned = id.replace(/[^a-zA-Z0-9-]/g, "-");
	return cleaned === "" ? "entry" : cleaned;
}
/** Short content fingerprint of the entry's first image. */
function fingerprint(input) {
	const first = input.images[0];
	if (first === void 0) return void 0;
	return createHash("sha1").update(first.b64).digest("hex");
}
/** Ensure the storage directories exist. */
async function ensureDirs() {
	await promises.mkdir(imagesDir(), { recursive: true });
	await promises.mkdir(videosDir(), { recursive: true });
}
/** Read the index, tolerating a missing/corrupt file. */
async function readIndex() {
	try {
		const raw = await promises.readFile(indexPath(), "utf8");
		const parsed = JSON.parse(raw);
		if (parsed === null || typeof parsed !== "object") return [];
		const entries = parsed.entries;
		if (!Array.isArray(entries)) return [];
		return entries.filter(isStoredEntry);
	} catch {
		return [];
	}
}
/** Persist the index. */
async function writeIndex(entries) {
	await ensureDirs();
	const payload = { entries };
	const tmp = `${indexPath()}.tmp-${process.pid}`;
	await promises.writeFile(tmp, JSON.stringify(payload), "utf8");
	await promises.rename(tmp, indexPath());
}
function categoriesPath() {
	return path.join(galleryDir(), "categories.json");
}
/** Longest category name the store accepts. */
const CATEGORY_MAX_LENGTH = 24;
/** Trim, collapse and bound one category name; empty means "not a name". */
function normalizeCategory(raw) {
	if (typeof raw !== "string") return "";
	return raw.trim().replace(/\s+/g, " ").slice(0, CATEGORY_MAX_LENGTH);
}
/** Read the registry, tolerating a missing/corrupt file. */
async function readCategories() {
	try {
		const raw = await promises.readFile(categoriesPath(), "utf8");
		const parsed = JSON.parse(raw);
		if (parsed === null || typeof parsed !== "object") return [];
		const list = parsed.categories;
		if (!Array.isArray(list)) return [];
		return [...new Set(list.map(normalizeCategory).filter((name) => name !== ""))];
	} catch {
		return [];
	}
}
/** Persist the registry. */
async function writeCategories(categories) {
	await ensureDirs();
	const payload = { categories };
	const tmp = `${categoriesPath()}.tmp-${process.pid}`;
	await promises.writeFile(tmp, JSON.stringify(payload), "utf8");
	await promises.rename(tmp, categoriesPath());
}
/**
* The names the filter bar lists: the registry first, then any tag in use that
* was typed straight onto an entry (an older store, or the per-entry editor).
* @param registry - persisted category names, in creation order.
* @param entries - every entry, live and trashed.
* @returns names without duplicates, registry order preserved.
*/
function mergedCategories(registry, entries) {
	const known = new Set(registry);
	const derived = [];
	for (const entry of entries) for (const tag of entry.tags ?? []) {
		const name = normalizeCategory(tag);
		if (name === "" || known.has(name)) continue;
		known.add(name);
		derived.push(name);
	}
	return [...registry, ...derived];
}
/** Build the snapshot the category routes answer with (call inside a mutation). */
async function snapshotLocked() {
	await purgeExpiredLocked();
	const entries = await readIndex();
	return {
		entries: entries.filter(isLiveEntry).map(toWire),
		trash: entries.filter((entry) => !isLiveEntry(entry)).map(toWire),
		categories: mergedCategories(await readCategories(), entries)
	};
}
/** Replace one tag everywhere it appears (both halves), keeping entry order. */
function replaceTag(entries, from, to) {
	return entries.map((entry) => {
		if (entry.tags === void 0 || !entry.tags.includes(from)) return entry;
		const next = [...new Set(entry.tags.map((tag) => tag === from ? to : tag).filter((tag) => tag !== null && tag !== ""))];
		if (next.length === 0) {
			const { tags: _dropped, ...rest } = entry;
			return rest;
		}
		return {
			...entry,
			tags: next.slice(0, 20)
		};
	});
}
/** Structural guard for a stored entry. */
function isStoredEntry(value) {
	if (value === null || typeof value !== "object") return false;
	const entry = value;
	return typeof entry.id === "string" && typeof entry.createdAt === "number" && (entry.mode === "text" || entry.mode === "edit" || entry.mode === "video") && (entry.deletedAt === void 0 || typeof entry.deletedAt === "number") && (entry.workflow === void 0 || entry.workflow === "ecommerce") && (entry.projectId === void 0 || typeof entry.projectId === "string") && (entry.projectName === void 0 || typeof entry.projectName === "string") && (entry.slotKey === void 0 || typeof entry.slotKey === "string") && (entry.slotLabel === void 0 || typeof entry.slotLabel === "string") && typeof entry.prompt === "string" && Array.isArray(entry.images) && entry.images.every((image) => {
		if (image === null || typeof image !== "object") return false;
		const record = image;
		return typeof record.file === "string" && typeof record.mime === "string";
	});
}
/** Remove one entry's image files (best effort). */
async function removeEntryFiles(entry) {
	for (const image of entry.images) try {
		await promises.rm(path.join(imagesDir(), image.file), { force: true });
	} catch {}
	if (entry.video !== void 0) try {
		await promises.rm(path.join(videosDir(), entry.video.file), { force: true });
	} catch {}
}
/** Project a stored entry onto the wire shape (image URLs). */
function toWire(entry) {
	return {
		id: entry.id,
		createdAt: entry.createdAt,
		mode: entry.mode,
		model: entry.model,
		prompt: entry.prompt,
		size: entry.size,
		quality: entry.quality,
		detail: entry.detail,
		n: entry.n,
		images: entry.images.map((image) => ({
			url: `/api/dsh-imagegen-studio/gallery/image/${image.file}`,
			mime: image.mime,
			...image.revisedPrompt === void 0 ? {} : { revisedPrompt: image.revisedPrompt }
		})),
		...entry.refName === void 0 ? {} : { refName: entry.refName },
		...entry.tags === void 0 ? {} : { tags: entry.tags },
		...entry.channel === void 0 ? {} : { channel: entry.channel },
		...entry.channelId === void 0 ? {} : { channelId: entry.channelId },
		...entry.workflow === void 0 ? {} : { workflow: entry.workflow },
		...entry.projectId === void 0 ? {} : { projectId: entry.projectId },
		...entry.projectName === void 0 ? {} : { projectName: entry.projectName },
		...entry.slotKey === void 0 ? {} : { slotKey: entry.slotKey },
		...entry.slotLabel === void 0 ? {} : { slotLabel: entry.slotLabel },
		...entry.canvas === void 0 ? {} : { canvas: entry.canvas },
		...entry.deletedAt === void 0 ? {} : { deletedAt: entry.deletedAt },
		...entry.video === void 0 ? {} : { video: {
			url: `${GALLERY_VIDEO_FILE_ROUTE}/${entry.video.file}`,
			mime: entry.video.mime,
			...entry.video.duration === void 0 ? {} : { duration: entry.video.duration }
		} }
	};
}
/** Whether an entry is still part of the visible gallery (not in the trash). */
function isLiveEntry(entry) {
	return entry.deletedAt === void 0;
}
/**
* Unlink every trashed entry that is past the retention window.
*
* Called from inside `mutateGallery` only: it reads and rewrites the shared
* index, so it must already hold the mutation queue. A fresh process gets its
* cleanup for free on the first store call (list counts), which is the lazy
* "next start" behaviour — no timer, nothing to shut down.
*/
async function purgeExpiredLocked() {
	const entries = await readIndex();
	const now = Date.now();
	const expired = entries.filter((entry) => entry.deletedAt !== void 0 && now - entry.deletedAt >= 2592e6);
	if (expired.length === 0) return;
	for (const entry of expired) await removeEntryFiles(entry);
	const expiredIds = new Set(expired.map((entry) => entry.id));
	await writeIndex(entries.filter((entry) => !expiredIds.has(entry.id)));
}
/** List the persisted gallery (live entries only), newest first, as wire entries. */
async function listGallery() {
	return mutateGallery(async () => {
		await purgeExpiredLocked();
		return (await readIndex()).filter(isLiveEntry).map(toWire);
	});
}
/** List the trash (soft-deleted entries), newest deletion first. */
async function listGalleryTrash() {
	return mutateGallery(async () => {
		await purgeExpiredLocked();
		return (await readIndex()).filter((entry) => !isLiveEntry(entry)).sort((left, right) => (right.deletedAt ?? 0) - (left.deletedAt ?? 0)).map(toWire);
	});
}
/** Append one image to the gallery. Deduplicates by first-image content —
*  appending an image already in the gallery returns `added: false` with the
*  list unchanged. No size cap: every entry is an explicit user choice. */
async function appendGallery(input) {
	return mutateGallery(async () => {
		await purgeExpiredLocked();
		await ensureDirs();
		const hash = fingerprint(input);
		if (hash !== void 0) {
			const existing = await readIndex();
			if (existing.some((entry) => entry.hash === hash && isLiveEntry(entry))) return {
				entries: existing.map(toWire),
				added: false
			};
		}
		const prefix = safeId$1(input.id);
		const storedImages = [];
		try {
			for (let index = 0; index < input.images.length; index++) {
				const image = input.images[index];
				const file = `${prefix}-${index}.${extensionOf$3(image.mime)}`;
				await promises.writeFile(path.join(imagesDir(), file), Buffer.from(image.b64, "base64"));
				notifyImageSaved("gallery", path.join(imagesDir(), file));
				storedImages.push({
					file,
					mime: image.mime,
					...image.revisedPrompt === void 0 ? {} : { revisedPrompt: image.revisedPrompt }
				});
			}
		} catch (error) {
			await removeEntryFiles({ images: storedImages });
			throw error;
		}
		const merged = [{
			id: input.id,
			createdAt: input.createdAt,
			mode: input.mode,
			model: input.model,
			prompt: input.prompt,
			size: input.size,
			quality: input.quality,
			detail: input.detail,
			n: input.n,
			images: storedImages,
			...hash === void 0 ? {} : { hash },
			...input.refName === void 0 ? {} : { refName: input.refName },
			...input.channelId === void 0 ? {} : { channelId: input.channelId },
			...input.channel === void 0 ? {} : { channel: input.channel },
			...input.workflow === void 0 ? {} : { workflow: input.workflow },
			...input.projectId === void 0 ? {} : { projectId: input.projectId },
			...input.projectName === void 0 ? {} : { projectName: input.projectName },
			...input.slotKey === void 0 ? {} : { slotKey: input.slotKey },
			...input.slotLabel === void 0 ? {} : { slotLabel: input.slotLabel },
			...input.canvas === void 0 ? {} : { canvas: input.canvas }
		}, ...await readIndex()];
		await writeIndex(merged);
		return {
			entries: merged.map(toWire),
			added: true
		};
	});
}
/**
* Move one entry to the trash (soft delete).
*
* The files are deliberately NOT unlinked: they stay readable through the
* existing image/clip routes for the whole retention window, so `restore`
* returns the real picture and every URL already held elsewhere keeps working.
* Returns the full list (live + trash) — the route layer splits it.
*/
async function removeGallery(id) {
	return mutateGallery(async () => {
		await purgeExpiredLocked();
		const entries = await readIndex();
		const target = entries.find((entry) => entry.id === id);
		if (target !== void 0 && isLiveEntry(target)) target.deletedAt = Date.now();
		await writeIndex(entries);
		return entries.map(toWire);
	});
}
/**
* Bring one trashed entry back into the gallery.
*
* Only the flag changes: tags, channel snapshot, canvas lineage and the
* original `createdAt` were never touched, so the entry returns to its old
* position in every sort.
*/
async function restoreGallery(id) {
	return mutateGallery(async () => {
		await purgeExpiredLocked();
		const entries = await readIndex();
		const target = entries.find((entry) => entry.id === id);
		if (target !== void 0) delete target.deletedAt;
		await writeIndex(entries);
		return entries.map(toWire);
	});
}
/**
* Empty the trash: permanently delete every trashed entry and its files.
*
* This is the only unconditional unlink in the store — it backs the explicit
* "empty trash" action, which the client guards with a confirmation.
*/
async function purgeGallery() {
	return mutateGallery(async () => {
		await purgeExpiredLocked();
		const entries = await readIndex();
		const trashed = entries.filter((entry) => !isLiveEntry(entry));
		for (const entry of trashed) await removeEntryFiles(entry);
		const kept = entries.filter(isLiveEntry);
		await writeIndex(kept);
		return kept.map(toWire);
	});
}
/** Replace the user-managed labels for one gallery entry. */
async function updateGalleryTags(id, tags) {
	return mutateGallery(async () => {
		await purgeExpiredLocked();
		const normalized = [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))].slice(0, 20);
		const entries = await readIndex();
		const target = entries.find((entry) => entry.id === id);
		if (target !== void 0) target.tags = normalized;
		await writeIndex(entries);
		return entries.map(toWire);
	});
}
/**
* Create one category.
*
* A category may exist with nothing filed under it — that is the point of a
* registry: the user can set up the shelf before moving things onto it. Names
* are trimmed/collapsed, so " 参考 " and "参考" are the same category.
* @param name - the category to add (blank names are rejected by the route).
* @returns both halves and the new category list.
*/
async function createGalleryCategory(name) {
	return mutateGallery(async () => {
		const category = normalizeCategory(name);
		if (category === "") throw new Error("分类名不能为空");
		const registry = await readCategories();
		if (!mergedCategories(registry, await readIndex()).includes(category)) await writeCategories([...registry, category]);
		return await snapshotLocked();
	});
}
/**
* Rename one category everywhere: the registry entry and every entry's tag.
* @param from - the current name.
* @param to - the new name (blank is rejected).
* @returns both halves and the updated category list.
*/
async function renameGalleryCategory(from, to) {
	return mutateGallery(async () => {
		const source = normalizeCategory(from);
		const target = normalizeCategory(to);
		if (source === "") throw new Error("原分类名不能为空");
		if (target === "") throw new Error("分类名不能为空");
		const registry = await readCategories();
		const entries = await readIndex();
		if (source === target) return await snapshotLocked();
		await writeCategories([...new Set(registry.map((name) => name === source ? target : name))]);
		await writeIndex(replaceTag(entries, source, target));
		return await snapshotLocked();
	});
}
/**
* Delete one category: it leaves the registry and every entry loses that tag.
* The images themselves are untouched — deleting a shelf is not deleting what
* stood on it.
* @param name - the category to remove.
* @returns both halves and the remaining category list.
*/
async function deleteGalleryCategory(name) {
	return mutateGallery(async () => {
		const category = normalizeCategory(name);
		if (category === "") throw new Error("分类名不能为空");
		const registry = await readCategories();
		const entries = await readIndex();
		await writeCategories(registry.filter((entry) => entry !== category));
		await writeIndex(replaceTag(entries, category, null));
		return await snapshotLocked();
	});
}
/** The category list plus both entry halves, for the filter bar. */
async function listGalleryCategories() {
	return mutateGallery(async () => await snapshotLocked());
}
/**
* Move every live entry to the trash.
*
* "Clear the gallery" used to unlink everything on the spot; under soft delete
* it is the bulk form of `removeGallery`, so the whole cleared gallery is
* recoverable for the retention window and only `purgeGallery` really deletes.
*/
async function clearGallery() {
	return mutateGallery(async () => {
		await purgeExpiredLocked();
		const entries = await readIndex();
		const now = Date.now();
		for (const entry of entries) if (isLiveEntry(entry)) entry.deletedAt = now;
		await writeIndex(entries);
		return entries.map(toWire);
	});
}
/** Read one stored image file by its (validated) file name. */
/**
* Favorite one finished clip.
*
* The bytes are COPIED out of the video store rather than referenced: the video
* history is capped (oldest clips are evicted), so a reference would silently
* rot. Copying is the same tradeoff the image path already makes, and it keeps
* a favorite durable without the client ever sending video bytes.
*/
async function appendGalleryVideo(input) {
	return mutateGallery(async () => {
		await purgeExpiredLocked();
		await ensureDirs();
		const file = `${safeId$1(input.id)}-0.${videoExtensionOf(input.mime)}`;
		const target = path.join(videosDir(), file);
		await promises.copyFile(input.sourcePath, target);
		const merged = [{
			id: input.id,
			createdAt: input.createdAt,
			mode: "video",
			model: input.model,
			prompt: input.prompt,
			size: input.aspectRatio,
			quality: "",
			detail: "",
			n: 1,
			images: [],
			video: {
				file,
				mime: input.mime,
				...input.duration === void 0 ? {} : { duration: input.duration }
			},
			...input.tags === void 0 ? {} : { tags: input.tags },
			...input.channelId === void 0 ? {} : { channelId: input.channelId },
			...input.channel === void 0 ? {} : { channel: input.channel }
		}, ...await readIndex()];
		await writeIndex(merged);
		return {
			entries: merged.map(toWire),
			added: true
		};
	});
}
/**
* Read one favorited clip by name.
*
* The name pattern is exactly what this store writes, so the route can never
* escape the videos directory; `size` supports Range responses (seeking).
*/
async function readGalleryVideo(file) {
	if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*-[0-9]+\.(mp4|webm|mov|mkv)$/.test(file)) return void 0;
	const absolute = path.join(videosDir(), file);
	try {
		const stat = await promises.stat(absolute);
		if (!stat.isFile()) return void 0;
		return {
			path: absolute,
			size: stat.size,
			mime: videoMimeOfFile(file)
		};
	} catch {
		return;
	}
}
async function readGalleryImage(file) {
	if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*-[0-9]+\.(png|jpg|jpeg|webp|gif)$/.test(file)) return void 0;
	try {
		return {
			data: await promises.readFile(path.join(imagesDir(), file)),
			mime: mimeOfFile$1(file)
		};
	} catch {
		return;
	}
}
const finite = (value) => typeof value === "number" && Number.isFinite(value);
const positive = (value) => finite(value) && value > 0 && value <= 4096;
const assetRef = (value) => {
	if (value === null || typeof value !== "object") return false;
	const asset = value;
	return typeof asset.assetId === "string" && /^[a-f0-9]{64}\.(png|jpg|jpeg|webp|gif)$/.test(asset.assetId) && asset.url === `/api/dsh-imagegen-studio/canvas/asset/${asset.assetId}` && /^image\/(png|jpeg|webp|gif)$/.test(asset.mime) && finite(asset.bytes) && asset.bytes >= 0 && finite(asset.width) && asset.width > 0 && finite(asset.height) && asset.height > 0;
};
function isPosterDocument(value) {
	if (value === null || typeof value !== "object") return false;
	const poster = value;
	if (poster.version !== 1 || !positive(poster.width) || !positive(poster.height) || !Number.isInteger(poster.width) || !Number.isInteger(poster.height) || !assetRef(poster.background) || !Array.isArray(poster.layers) || poster.layers.length > 40) return false;
	const ids = /* @__PURE__ */ new Set();
	return poster.layers.every((layer) => {
		if (layer === null || typeof layer !== "object" || typeof layer.id !== "string" || layer.id.length === 0 || layer.id.length > 100 || ids.has(layer.id)) return false;
		ids.add(layer.id);
		if (!finite(layer.x) || !finite(layer.y) || layer.x < 0 || layer.y < 0 || layer.x >= poster.width || layer.y >= poster.height || !positive(layer.width) || layer.width > poster.width) return false;
		if (layer.type === "image") return positive(layer.height) && layer.height <= poster.height && assetRef(layer.asset);
		return layer.type === "text" && typeof layer.text === "string" && layer.text.length <= 4e3 && finite(layer.fontSize) && layer.fontSize >= 8 && layer.fontSize <= 512 && [
			"sans-serif",
			"serif",
			"monospace"
		].includes(layer.fontFamily) && /^#[a-f0-9]{6}$/i.test(layer.color) && typeof layer.bold === "boolean" && [
			"left",
			"center",
			"right"
		].includes(layer.align);
	});
}
//#endregion
//#region src/canvas-store.ts
/** Host-persisted infinite canvas documents and content-addressed assets. */
/** Cap on one canvas file asset (arbitrary types travel as raw bytes). */
const MAX_CANVAS_FILE_BYTES = 50 * 1024 * 1024;
/** Text previews kept inline on the asset ref so the node can render without a fetch. */
const MAX_FILE_TEXT_PREVIEW = 8 * 1024;
/** Extensions that must never round-trip through the canvas asset store: they
*  are the classic self-executing downloads. The client blocks them too; this
*  is the host-side half of the same rule. */
const BLOCKED_FILE_EXTENSIONS = /* @__PURE__ */ new Set([
	"exe",
	"com",
	"scr",
	"pif",
	"cpl",
	"msi",
	"msp",
	"dll",
	"sys",
	"bat",
	"cmd",
	"ps1",
	"psm1",
	"vbs",
	"vbe",
	"js",
	"mjs",
	"cjs",
	"jse",
	"wsf",
	"wsh",
	"hta",
	"jar",
	"apk",
	"app",
	"sh",
	"bash",
	"command",
	"reg",
	"lnk",
	"url",
	"html",
	"htm",
	"xhtml",
	"svg"
]);
/** MIME types accepted for arbitrary files (images keep their own strict path). */
const FILE_MIME_ALLOW = /^(application\/(pdf|json|zip|x-zip-compressed|vnd\.openxmlformats-officedocument\.[a-z0-9.+-]+|vnd\.ms-(excel|powerpoint|word)\.[a-z0-9.+-]+|vnd\.oasis\.opendocument\.[a-z0-9.+-]+|rtf|xml|javascript|typescript|x-yaml|yaml|x-sh|x-httpd-php|epub\+zip|gzip|x-7z-compressed|x-rar-compressed|x-tar|octet-stream)|text\/[a-z0-9.+-]+|image\/(png|jpeg|webp|gif|bmp|tiff)|audio\/[a-z0-9.+-]+|video\/[a-z0-9.+-]+)$/i;
/** Extension used for each accepted MIME type; unknown types become `.bin`. */
const EXTENSION_BY_MIME = {
	"application/pdf": "pdf",
	"application/json": "json",
	"application/zip": "zip",
	"application/x-zip-compressed": "zip",
	"application/rtf": "rtf",
	"application/xml": "xml",
	"application/x-yaml": "yaml",
	"application/yaml": "yaml",
	"application/javascript": "js",
	"application/typescript": "ts",
	"application/epub+zip": "epub",
	"application/gzip": "gz",
	"application/x-7z-compressed": "7z",
	"application/x-rar-compressed": "rar",
	"application/x-tar": "tar",
	"application/vnd.ms-excel": "xls",
	"application/vnd.ms-powerpoint": "ppt",
	"application/vnd.ms-word": "doc",
	"application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
	"application/vnd.openxmlformats-officedocument.presentationml.slideshow": "ppsx",
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
	"application/vnd.oasis.opendocument.text": "odt",
	"application/vnd.oasis.opendocument.presentation": "odp",
	"application/vnd.oasis.opendocument.spreadsheet": "ods",
	"text/plain": "txt",
	"text/markdown": "md",
	"text/csv": "csv",
	"text/html": "html",
	"text/xml": "xml",
	"text/yaml": "yaml",
	"text/x-python": "py",
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/webp": "webp",
	"image/gif": "gif",
	"image/bmp": "bmp",
	"image/tiff": "tiff",
	"audio/mpeg": "mp3",
	"audio/wav": "wav",
	"audio/ogg": "ogg",
	"audio/mp4": "m4a",
	"video/mp4": "mp4",
	"video/webm": "webm",
	"video/quicktime": "mov"
};
const MIME_BY_EXTENSION = {
	pdf: "application/pdf",
	json: "application/json",
	zip: "application/zip",
	rtf: "application/rtf",
	xml: "application/xml",
	yaml: "application/x-yaml",
	yml: "application/x-yaml",
	txt: "text/plain",
	log: "text/plain",
	md: "text/markdown",
	markdown: "text/markdown",
	csv: "text/csv",
	tsv: "text/tab-separated-values",
	pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
	docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	ppt: "application/vnd.ms-powerpoint",
	doc: "application/vnd.ms-word",
	xls: "application/vnd.ms-excel",
	odt: "application/vnd.oasis.opendocument.text",
	odp: "application/vnd.oasis.opendocument.presentation",
	ods: "application/vnd.oasis.opendocument.spreadsheet",
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	webp: "image/webp",
	gif: "image/gif",
	bmp: "image/bmp",
	tiff: "image/tiff",
	tif: "image/tiff",
	mp3: "audio/mpeg",
	wav: "audio/wav",
	mp4: "video/mp4",
	webm: "video/webm"
};
/** Content-addressed names may carry any short, safe extension (see putFile). */
const ASSET_FILE_NAME = /^[a-f0-9]{64}\.[a-z0-9]{1,8}$/;
function extensionOf$2(mime) {
	switch (mime.split(";")[0].trim().toLowerCase()) {
		case "image/jpeg": return "jpg";
		case "image/webp": return "webp";
		case "image/gif": return "gif";
		default: return "png";
	}
}
/** MIME type without its parameters, lower-cased (`text/plain; charset=utf-8`). */
function baseMime$1(mime) {
	return mime.split(";")[0].trim().toLowerCase();
}
/** Whether a MIME type carries readable text (used for inline previews). */
function isTextMime(mime) {
	const value = baseMime$1(mime);
	return value.startsWith("text/") || value === "application/json" || value === "application/xml" || value === "application/x-yaml" || value === "application/yaml" || value === "application/javascript" || value === "application/typescript";
}
/** MIME type inferred from a file name, used when the browser reports none. */
function mimeFromFileName(name) {
	const extension = path.extname(name).replace(/^\./, "").toLowerCase();
	return MIME_BY_EXTENSION[extension] ?? "";
}
/** Whether one file name may enter the canvas store at all. */
function isBlockedFileName(name) {
	const extension = path.extname(name).replace(/^\./, "").toLowerCase();
	return extension !== "" && BLOCKED_FILE_EXTENSIONS.has(extension);
}
/** Strip directories, control characters and pathological lengths. */
function safeFileName(value) {
	const cleaned = (value.split(/[\\/]/).pop() ?? "").replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim();
	if (cleaned === "" || cleaned === "." || cleaned === "..") return "file";
	return cleaned.length > 120 ? cleaned.slice(0, 120) : cleaned;
}
/** Coarse bucket driving the file node's icon and preview branch. */
function fileKindOf(mime, name = "") {
	const value = baseMime$1(mime);
	const extension = path.extname(name).replace(/^\./, "").toLowerCase();
	if (value === "application/pdf" || extension === "pdf") return "pdf";
	if (value.startsWith("image/")) return "image";
	if (value.startsWith("audio/")) return "audio";
	if (value.startsWith("video/")) return "video";
	if (value === "application/zip" || value === "application/x-zip-compressed" || value.startsWith("application/x-7z") || value.startsWith("application/x-rar") || value === "application/gzip" || value === "application/x-tar" || [
		"zip",
		"7z",
		"rar",
		"gz",
		"tar"
	].includes(extension)) return "archive";
	if (value.includes("openxmlformats") || value.startsWith("application/vnd.ms-") || value.startsWith("application/vnd.oasis") || [
		"pptx",
		"docx",
		"xlsx",
		"ppt",
		"doc",
		"xls",
		"odt",
		"odp",
		"ods"
	].includes(extension)) return "office";
	if (isTextMime(value) || [
		"md",
		"markdown",
		"csv",
		"tsv",
		"log",
		"json",
		"yaml",
		"yml",
		"xml",
		"txt"
	].includes(extension)) return "text";
	return "other";
}
/** Decoded head of a text file, bounded and safe against a split multi-byte
*  character at the cut point (TextDecoder drops a trailing partial sequence). */
function textHead(data) {
	const slice = data.byteLength > 8192 ? data.subarray(0, MAX_FILE_TEXT_PREVIEW) : data;
	try {
		const text = new TextDecoder("utf-8", { fatal: false }).decode(slice);
		return text.includes("\0") ? void 0 : text;
	} catch {
		return;
	}
}
var CanvasConflictError = class extends Error {
	code = "canvas-conflict";
	constructor(message = "画布已在其他窗口更新，请重新加载后再保存。") {
		super(message);
		this.name = "CanvasConflictError";
	}
};
/** MIME type of one stored asset, derived from its content-addressed name. */
function mimeOf(file) {
	const extension = path.extname(file).replace(/^\./, "").toLowerCase();
	if (MIME_BY_EXTENSION[extension] !== void 0) return MIME_BY_EXTENSION[extension];
	switch (extension) {
		case "jpg":
		case "jpeg": return "image/jpeg";
		case "webp": return "image/webp";
		case "gif": return "image/gif";
		case "js": return "application/javascript";
		case "ts": return "application/typescript";
		case "bin": return "application/octet-stream";
		default: return "application/octet-stream";
	}
}
function safeId(value) {
	const id = value.replace(/[^a-zA-Z0-9_-]/g, "-");
	return id === "" ? randomUUID() : id;
}
async function writeJsonAtomic(file, value) {
	await promises.mkdir(path.dirname(file), { recursive: true });
	const temp = `${file}.tmp-${process.pid}-${randomUUID()}`;
	await promises.writeFile(temp, `${JSON.stringify(value)}\n`, "utf8");
	await promises.rename(temp, file);
}
async function readJson(file) {
	try {
		return JSON.parse(await promises.readFile(file, "utf8"));
	} catch {
		return;
	}
}
function defaultDocument(id, title) {
	const now = Date.now();
	return {
		version: 2,
		id,
		title,
		revision: 1,
		viewport: {
			x: 0,
			y: 0,
			k: 1
		},
		background: "lines",
		nodes: [],
		connections: [],
		createdAt: now,
		updatedAt: now
	};
}
function isAssetRef(value) {
	if (value === null || typeof value !== "object") return false;
	const asset = value;
	if (typeof asset.assetId !== "string" || typeof asset.url !== "string" || typeof asset.mime !== "string") return false;
	const file = asset.kind === "file";
	if (typeof asset.width !== "number" || typeof asset.height !== "number") return false;
	if (!file && (asset.width < 1 || asset.height < 1)) return false;
	if (asset.kind !== void 0 && asset.kind !== "image" && asset.kind !== "file") return false;
	if (asset.name !== void 0 && typeof asset.name !== "string") return false;
	if (asset.textPreview !== void 0 && typeof asset.textPreview !== "string") return false;
	return true;
}
/** A video node's reference to a served clip (`CanvasVideoRef` in protocol.ts).
*  Only `url` and `mime` are required; the rest is metadata the provider may not
*  have reported, so its absence is not a malformed document. */
function isVideoRef(value) {
	if (value === null || typeof value !== "object") return false;
	const video = value;
	if (typeof video.url !== "string" || typeof video.mime !== "string") return false;
	if (video.duration !== void 0 && typeof video.duration !== "number") return false;
	if (video.bytes !== void 0 && typeof video.bytes !== "number") return false;
	if (video.entryId !== void 0 && typeof video.entryId !== "string") return false;
	if (video.sourceUrl !== void 0 && typeof video.sourceUrl !== "string") return false;
	return true;
}
/** One shot of a storyboard node (`CanvasShot` in protocol.ts). A shot with no
*  prompt is a legitimate draft — the node renders it as an empty row and the
*  run refuses it with a visible message — so only its shape is validated. */
function isShot(value) {
	if (value === null || typeof value !== "object") return false;
	const shot = value;
	if (typeof shot.id !== "string" || shot.id === "") return false;
	if (typeof shot.prompt !== "string") return false;
	if (typeof shot.seconds !== "number" || !Number.isFinite(shot.seconds) || shot.seconds <= 0) return false;
	if (shot.nodeId !== void 0 && typeof shot.nodeId !== "string") return false;
	return true;
}
/**
* A storyboard's stored state.
*
* Validated rather than dropped on the floor: `isNode` returning false makes
* `coerceDocument` undefined, and `save()` then throws 'malformed canvas
* document' — so an over-strict rule here does not reject the incoming request,
* it bricks every save of a canvas that holds one storyboard. Each field is
* therefore allowed to be missing and filled in at render time, and only a
* present-but-wrong-typed value is refused.
*/
function isStoryboard(value) {
	if (value === null || typeof value !== "object") return false;
	const board = value;
	if (!Array.isArray(board.shots) || !board.shots.every(isShot)) return false;
	if (board.shots.length > 40) return false;
	if (board.aspectRatio !== void 0 && typeof board.aspectRatio !== "string") return false;
	if (board.resolution !== void 0 && typeof board.resolution !== "string") return false;
	if (board.continuity !== void 0 && board.continuity !== "cut" && board.continuity !== "carry") return false;
	if (board.model !== void 0 && typeof board.model !== "string") return false;
	if (board.channelId !== void 0 && typeof board.channelId !== "string") return false;
	return true;
}
/**
* Provenance of a storyboard-produced clip. Deliberately NOT part of the save
* gate's required set: it is display and lookup metadata, and refusing a whole
* canvas document because one of its clips lost this field would be a data-loss
* bug, not a consistency check.
*/
function isShotOrigin(value) {
	if (value === null || typeof value !== "object") return false;
	const origin = value;
	return typeof origin.storyboardId === "string" && typeof origin.shotId === "string" && typeof origin.index === "number" && Number.isFinite(origin.index);
}
function isNode(value) {
	if (value === null || typeof value !== "object") return false;
	const node = value;
	if (typeof node.id !== "string" || typeof node.title !== "string" || typeof node.x !== "number" || typeof node.y !== "number" || typeof node.width !== "number" || typeof node.height !== "number") return false;
	if (node.type !== "image" && node.type !== "text" && node.type !== "file" && node.type !== "config" && node.type !== "video" && node.type !== "storyboard") return false;
	const metadata = node.metadata;
	if (metadata !== void 0 && (metadata === null || typeof metadata !== "object")) return false;
	const state = metadata ?? {};
	if (node.type === "image") {
		if (state.poster !== void 0 && !isPosterDocument(state.poster)) return false;
		if (state.asset !== void 0 && !isAssetRef(state.asset)) return false;
		if (state.cast !== void 0) {
			if (state.cast === null || typeof state.cast !== "object") return false;
			const cast = state.cast;
			if (cast.role !== "character" && cast.role !== "item" && cast.role !== "style") return false;
			if (cast.name !== void 0 && typeof cast.name !== "string") return false;
		}
		return state.status === void 0 || state.status === "idle" || state.status === "generating" || state.status === "success" || state.status === "error";
	}
	if (node.type === "video") {
		if (state.video !== void 0 && !isVideoRef(state.video)) return false;
		if (state.shot !== void 0 && !isShotOrigin(state.shot)) return false;
		return state.status === void 0 || state.status === "idle" || state.status === "generating" || state.status === "success" || state.status === "error";
	}
	if (node.type === "file") return state.asset === void 0 || isAssetRef(state.asset);
	if (node.type === "storyboard") {
		if (state.storyboard !== void 0 && !isStoryboard(state.storyboard)) return false;
		return true;
	}
	if (node.type === "config") return state.prompt === void 0 || typeof state.prompt === "string";
	return state.text === void 0 || typeof state.text === "string";
}
function isDocument(value) {
	if (value === null || typeof value !== "object") return false;
	const document = value;
	return document.version === 2 && typeof document.id === "string" && typeof document.title === "string" && typeof document.revision === "number" && document.viewport !== null && typeof document.viewport === "object" && typeof document.viewport.x === "number" && typeof document.viewport.y === "number" && typeof document.viewport.k === "number" && (document.background === "dots" || document.background === "lines" || document.background === "blank" || document.background === "image" || document.background === "flow" || document.background === "liquid" || document.background === "floatingLines" || document.background === "galaxy" || document.background === "silk" || document.background === "waves" || document.background === "faultyTerminal" || document.background === "dotField" || document.background === "dotGrid" || document.background === "shapeGrid") && (document.backgroundImage === void 0 || typeof document.backgroundImage === "string") && Array.isArray(document.nodes) && document.nodes.every(isNode) && Array.isArray(document.connections);
}
/** Upgrade a v1 (image/text/annotation + edges) document to the v2 node-graph model.
* Images and text notes keep their geometry; annotation prompt cards become plain
* text notes carrying the prompt, and old edges survive only between surviving nodes. */
function migrateLegacyDocument(input) {
	const now = Date.now();
	const legacyNodes = Array.isArray(input.nodes) ? input.nodes : [];
	const nodes = [];
	const annotationIds = /* @__PURE__ */ new Set();
	for (const raw of legacyNodes) {
		if (raw === null || typeof raw !== "object") continue;
		const node = raw;
		if (typeof node.id !== "string" || typeof node.x !== "number" || typeof node.y !== "number") continue;
		const base = {
			id: node.id,
			title: typeof node.title === "string" ? node.title : "未命名节点",
			x: node.x,
			y: node.y,
			width: typeof node.width === "number" ? node.width : 300,
			height: typeof node.height === "number" ? node.height : 220
		};
		if (node.type === "image" && isAssetRef(node.asset)) {
			const generation = node.generation ?? {};
			nodes.push({
				...base,
				type: "image",
				metadata: {
					asset: node.asset,
					status: typeof node.status === "string" && [
						"idle",
						"generating",
						"success",
						"error"
					].includes(node.status) ? node.status : "success",
					...typeof node.error === "string" ? { error: node.error } : {},
					...typeof generation.prompt === "string" ? { prompt: generation.prompt } : {},
					...typeof generation.model === "string" ? { model: generation.model } : {},
					...typeof generation.taskId === "string" ? { taskId: generation.taskId } : {},
					...typeof generation.sourceNodeId === "string" ? { sourceNodeId: generation.sourceNodeId } : {}
				}
			});
		} else if (node.type === "text") nodes.push({
			...base,
			type: "text",
			metadata: {
				text: typeof node.text === "string" ? node.text : "",
				...typeof node.fontSize === "number" ? { fontSize: node.fontSize } : {}
			}
		});
		else if (node.type === "annotation") {
			annotationIds.add(node.id);
			const prompt = typeof node.prompt === "string" && node.prompt.trim() !== "" ? node.prompt : "（旧版标注，提示词见此）";
			nodes.push({
				...base,
				type: "text",
				title: "旧版标注",
				metadata: { text: prompt }
			});
		}
	}
	nodes.sort((a, b) => {
		const za = legacyNodes.find((item) => item?.id === a.id)?.zIndex;
		const zb = legacyNodes.find((item) => item?.id === b.id)?.zIndex;
		return (typeof za === "number" ? za : 0) - (typeof zb === "number" ? zb : 0);
	});
	const validIds = new Set(nodes.map((node) => node.id));
	const seen = /* @__PURE__ */ new Set();
	const connections = (Array.isArray(input.edges) ? input.edges : []).flatMap((raw) => {
		if (raw === null || typeof raw !== "object") return [];
		const edge = raw;
		if (typeof edge.fromNodeId !== "string" || typeof edge.toNodeId !== "string") return [];
		if (annotationIds.has(edge.fromNodeId) || annotationIds.has(edge.toNodeId)) return [];
		if (!validIds.has(edge.fromNodeId) || !validIds.has(edge.toNodeId) || edge.fromNodeId === edge.toNodeId) return [];
		const key = `${edge.fromNodeId}->${edge.toNodeId}`;
		if (seen.has(key)) return [];
		seen.add(key);
		return [{
			id: typeof edge.id === "string" ? edge.id : `edge-${randomUUID()}`,
			fromNodeId: edge.fromNodeId,
			toNodeId: edge.toNodeId
		}];
	});
	const legacyViewport = input.viewport ?? {};
	const background = input.background === "grid" ? "lines" : input.background === "blank" ? "blank" : "dots";
	return {
		version: 2,
		id: typeof input.id === "string" ? input.id : randomUUID(),
		title: typeof input.title === "string" ? input.title : "未命名画布",
		revision: typeof input.revision === "number" ? input.revision : 1,
		viewport: {
			x: typeof legacyViewport.x === "number" ? legacyViewport.x : 0,
			y: typeof legacyViewport.y === "number" ? legacyViewport.y : 0,
			k: typeof legacyViewport.scale === "number" && legacyViewport.scale > 0 ? legacyViewport.scale : 1
		},
		background,
		nodes,
		connections,
		createdAt: typeof input.createdAt === "number" ? input.createdAt : now,
		updatedAt: typeof input.updatedAt === "number" ? input.updatedAt : now
	};
}
/** Background modes removed from the picker still show up in older saved
*  documents; map them to their nearest surviving replacement. */
const REMOVED_BACKGROUND_FALLBACK = {
	diagonal: "lines",
	checker: "dots",
	aurora: "liquid"
};
/** Accept either the v2 document or a legacy v1 payload and return v2. */
function coerceDocument(value) {
	if (value === null || typeof value !== "object") return void 0;
	const document = value;
	if (document.version === 1) {
		const migrated = migrateLegacyDocument(document);
		return isDocument(migrated) ? migrated : void 0;
	}
	const fallback = REMOVED_BACKGROUND_FALLBACK[String(document.background)];
	if (fallback !== void 0) return isDocument({
		...document,
		background: fallback
	}) ? {
		...document,
		background: fallback
	} : void 0;
	return isDocument(value) ? value : void 0;
}
let mutation = Promise.resolve();
function serialize(operation) {
	const next = mutation.then(operation, operation);
	mutation = next.then(() => void 0, () => void 0);
	return next;
}
var CanvasStore = class {
	root;
	constructor(root) {
		this.root = root;
	}
	pagesDir() {
		return path.join(this.root ?? path.join(imageDataRoot(), "canvas"), "pages");
	}
	assetsDir() {
		return path.join(this.root ?? path.join(imageDataRoot(), "canvas"), "assets");
	}
	indexPath() {
		return path.join(this.root ?? path.join(imageDataRoot(), "canvas"), "index.json");
	}
	async ensure() {
		await promises.mkdir(this.pagesDir(), { recursive: true });
		await promises.mkdir(this.assetsDir(), { recursive: true });
	}
	pagePath(id) {
		return path.join(this.pagesDir(), `${safeId(id)}.json`);
	}
	assetPath(id) {
		if (!ASSET_FILE_NAME.test(id)) return void 0;
		const target = path.join(this.assetsDir(), id);
		const relative = path.relative(this.assetsDir(), target);
		return relative.startsWith("..") || path.isAbsolute(relative) ? void 0 : target;
	}
	async readIndex() {
		const value = await readJson(this.indexPath());
		if (value === void 0 || typeof value !== "object" || !Array.isArray(value.projects)) return [];
		return value.projects.flatMap((item) => {
			if (item === null || typeof item !== "object") return [];
			const project = item;
			if (!(typeof project.id === "string" && typeof project.title === "string" && typeof project.revision === "number" && typeof project.nodeCount === "number" && typeof project.createdAt === "number" && typeof project.updatedAt === "number")) return [];
			return [{
				id: project.id,
				title: project.title,
				revision: project.revision,
				nodeCount: project.nodeCount,
				createdAt: project.createdAt,
				updatedAt: project.updatedAt,
				...project.favorite === true ? { favorite: true } : {},
				...project.archived === true ? { archived: true } : {}
			}];
		});
	}
	async writeIndex(projects) {
		await this.ensure();
		await writeJsonAtomic(this.indexPath(), { projects });
	}
	async list() {
		return this.readIndex();
	}
	async create(title = "未命名画布") {
		return serialize(async () => {
			await this.ensure();
			const id = randomUUID();
			const document = defaultDocument(id, title.trim() || "未命名画布");
			await writeJsonAtomic(this.pagePath(id), document);
			const projects = await this.readIndex();
			await this.writeIndex([this.summaryOf(document), ...projects]);
			return document;
		});
	}
	async read(id) {
		return coerceDocument(await readJson(this.pagePath(id)));
	}
	async save(document, expectedRevision) {
		return serialize(async () => {
			const incoming = coerceDocument(document);
			if (incoming === void 0) throw new Error("malformed canvas document");
			const current = await this.read(incoming.id);
			if (current !== void 0 && expectedRevision !== void 0 && current.revision !== expectedRevision) throw new CanvasConflictError();
			const next = {
				...incoming,
				revision: Math.max(current?.revision ?? 0, incoming.revision) + 1,
				updatedAt: Date.now()
			};
			await this.ensure();
			await writeJsonAtomic(this.pagePath(next.id), next);
			const projects = await this.readIndex();
			const existing = projects.find((item) => item.id === next.id);
			await this.writeIndex([this.summaryOf(next, existing?.favorite === true, existing?.archived === true), ...projects.filter((item) => item.id !== next.id)]);
			return next;
		});
	}
	async setFavorite(id, favorite) {
		return serialize(async () => {
			const projects = await this.readIndex();
			if (!projects.some((item) => item.id === id)) throw new Error("画布不存在");
			const next = projects.map((item) => item.id === id ? {
				...item,
				...favorite ? { favorite: true } : { favorite: void 0 }
			} : item);
			await this.writeIndex(next);
			return next;
		});
	}
	/**
	* Move a canvas into (or out of) the archive.
	*
	* Nothing but the flag changes: the page, its assets and its nodes stay put,
	* which is what makes restoring a one-click affair.
	*/
	async setArchived(id, archived) {
		return serialize(async () => {
			const projects = await this.readIndex();
			if (!projects.some((item) => item.id === id)) throw new Error("画布不存在");
			const next = projects.map((item) => item.id === id ? {
				...item,
				...archived ? { archived: true } : { archived: void 0 }
			} : item);
			await this.writeIndex(next);
			return next;
		});
	}
	/**
	* Rename a canvas.
	*
	* The title lives in two places — the page document (what the canvas header
	* shows) and the index (what the list shows) — so both are rewritten under the
	* store's mutation lock. Renaming from the list must never leave a canvas whose
	* two titles disagree, and it must not bump the revision a client could be
	* holding for a conflict check any higher than the single edit it is.
	*/
	async rename(id, title) {
		const next = title.trim();
		if (next === "") throw new Error("画布名称不能为空");
		return serialize(async () => {
			const document = await this.read(id);
			if (document === void 0) throw new Error("画布不存在");
			const saved = {
				...document,
				title: next,
				revision: document.revision + 1,
				updatedAt: Date.now()
			};
			await this.ensure();
			await writeJsonAtomic(this.pagePath(id), saved);
			const projects = await this.readIndex();
			const existing = projects.find((item) => item.id === id);
			await this.writeIndex([this.summaryOf(saved, existing?.favorite === true, existing?.archived === true), ...projects.filter((item) => item.id !== id)]);
			return this.readIndex();
		});
	}
	async remove(id) {
		return serialize(async () => {
			try {
				await promises.rm(this.pagePath(id), { force: true });
			} catch {}
			const projects = (await this.readIndex()).filter((item) => item.id !== id);
			await this.writeIndex(projects);
			await this.sweepAssets();
			return projects;
		});
	}
	/**
	* Delete asset files no surviving canvas page references.
	*
	* Assets are content-addressed and written once per upload/generation, and
	* nothing used to remove them, so deleting a canvas left every byte of its
	* images and files on disk forever.
	*
	* The sweep is deliberately conservative: anything it cannot read or parse
	* aborts the whole pass instead of being treated as unreferenced. A parse
	* failure here means an unreadable or half-written page, and guessing that
	* its assets are free would silently destroy a canvas the user still has.
	* Leaving garbage behind is recoverable; deleting a live asset is not.
	*/
	async sweepAssets() {
		let pageFiles;
		try {
			pageFiles = (await promises.readdir(this.pagesDir(), { withFileTypes: true })).filter((entry) => entry.isFile() && entry.name.endsWith(".json")).map((entry) => entry.name);
		} catch {
			return;
		}
		const referenced = /* @__PURE__ */ new Set();
		for (const name of pageFiles) {
			const raw = await readJson(path.join(this.pagesDir(), name));
			if (raw === void 0) return;
			const document = coerceDocument(raw);
			if (document === void 0) return;
			for (const node of document.nodes) {
				const metadata = node.metadata;
				const asset = metadata?.asset;
				if (isAssetRef(asset) && asset.assetId !== "") referenced.add(asset.assetId);
				const poster = metadata?.poster;
				if (isPosterDocument(poster)) {
					referenced.add(poster.background.assetId);
					for (const layer of poster.layers) if (layer.type === "image") referenced.add(layer.asset.assetId);
				}
			}
			const background = document.backgroundImage;
			if (typeof background === "string" && background !== "") {
				const last = background.split("/").pop() ?? "";
				const file = decodeURIComponent(last.split("?")[0] ?? "");
				if (ASSET_FILE_NAME.test(file)) referenced.add(file);
			}
		}
		let entries;
		try {
			entries = (await promises.readdir(this.assetsDir(), { withFileTypes: true })).filter((entry) => entry.isFile()).map((entry) => entry.name);
		} catch {
			return;
		}
		for (const file of entries) {
			if (!ASSET_FILE_NAME.test(file) || referenced.has(file)) continue;
			try {
				await promises.rm(path.join(this.assetsDir(), file), { force: true });
			} catch {}
		}
	}
	/** Store raw bytes under their content hash and return the node-facing ref. */
	async putAsset(input) {
		await this.ensure();
		const file = `${createHash("sha256").update(input.data).digest("hex")}.${input.extension}`;
		const target = path.join(this.assetsDir(), file);
		try {
			await promises.access(target);
		} catch {
			await promises.writeFile(target, input.data);
		}
		return {
			assetId: file,
			url: `/api/dsh-imagegen-studio/canvas/asset/${file}`,
			mime: input.mime,
			bytes: input.data.byteLength,
			...input.ref
		};
	}
	async putImage(input) {
		if (!input.data.byteLength) throw new Error("image data is empty");
		if (!/^image\/(png|jpeg|webp|gif)$/.test(input.mime)) throw new Error("unsupported image type");
		if (!Number.isSafeInteger(input.width) || input.width < 1 || !Number.isSafeInteger(input.height) || input.height < 1) throw new Error("image dimensions are invalid");
		return this.putAsset({
			data: input.data,
			mime: input.mime,
			extension: extensionOf$2(input.mime),
			ref: {
				width: input.width,
				height: input.height,
				kind: "image",
				origin: input.origin,
				...input.name === void 0 ? {} : { name: safeFileName(input.name) },
				...input.originId === void 0 ? {} : { originId: input.originId },
				...input.entryId === void 0 ? {} : { entryId: input.entryId },
				...input.imageIndex === void 0 ? {} : { imageIndex: input.imageIndex }
			}
		});
	}
	/**
	* Store one arbitrary file (the canvas file node's upload path). Executable
	* and script-shaped extensions are refused here as well as in the browser:
	* the asset route serves non-image types as attachments, and this keeps a
	* hand-crafted request from parking one on disk in the first place.
	*/
	async putFile(input) {
		if (!input.data.byteLength) throw new Error("file data is empty");
		if (input.data.byteLength > 52428800) throw new Error(`文件超过 ${Math.round(MAX_CANVAS_FILE_BYTES / (1024 * 1024))}MB 上限`);
		const name = safeFileName(input.name);
		if (isBlockedFileName(name)) throw new Error(`出于安全考虑，不支持上传 ${path.extname(name)} 文件`);
		const declared = baseMime$1(input.mime);
		const inferred = mimeFromFileName(name);
		const mime = declared !== "" && declared !== "application/octet-stream" ? declared : inferred !== "" ? inferred : "application/octet-stream";
		if (!FILE_MIME_ALLOW.test(mime)) throw new Error(`不支持的文件类型：${mime}`);
		const extension = EXTENSION_BY_MIME[mime] ?? (path.extname(name).replace(/^\./, "").toLowerCase() || "bin");
		const textPreview = isTextMime(mime) ? textHead(input.data) : void 0;
		return this.putAsset({
			data: input.data,
			mime,
			extension,
			ref: {
				width: 0,
				height: 0,
				kind: "file",
				name,
				origin: input.origin,
				...input.originId === void 0 ? {} : { originId: input.originId },
				...textPreview === void 0 ? {} : { textPreview }
			}
		});
	}
	async readAsset(file) {
		const target = this.assetPath(file);
		if (target === void 0) return void 0;
		try {
			return {
				data: await promises.readFile(target),
				mime: mimeOf(file)
			};
		} catch {
			return;
		}
	}
	/** Read several assets at once, keyed by asset id (missing entries omitted). */
	async readAssets(refs) {
		const out = /* @__PURE__ */ new Map();
		for (const ref of refs) {
			if (ref.assetId === "" || out.has(ref.assetId)) continue;
			const found = await this.readAsset(ref.assetId);
			if (found !== void 0) out.set(ref.assetId, found);
		}
		return out;
	}
	/** Copy one asset out of the content-addressed store into a real file path,
	*  so a skill run (or a headless agent) can read it as an ordinary file. */
	async materialize(ref, targetPath) {
		const found = await this.readAsset(ref.assetId);
		if (found === void 0) throw new Error(`画布资产不存在：${ref.assetId}`);
		await promises.mkdir(path.dirname(targetPath), { recursive: true });
		await promises.writeFile(targetPath, found.data);
	}
	summaryOf(document, favorite = false, archived = false) {
		return {
			id: document.id,
			title: document.title,
			revision: document.revision,
			nodeCount: document.nodes.length,
			createdAt: document.createdAt,
			updatedAt: document.updatedAt,
			...favorite ? { favorite: true } : {},
			...archived ? { archived: true } : {}
		};
	}
};
const canvasStore = new CanvasStore();
//#endregion
//#region src/zip.ts
/**
* Dependency-free ZIP reading.
*
* Skills arrive as archives (GitHub source zips, hand-made bundles) and OOXML
* documents are ZIP containers, so both the skill library and the text
* extractor need to walk a central directory and inflate entries. Doing it with
* `node:zlib` keeps the plugin free of native dependencies.
*
* Only the *reading* path is implemented, and every read is bounded: an entry
* is skipped when its header lies outside the buffer or when its declared size
* exceeds the caller's cap, so a hostile archive cannot make the host allocate
* unbounded memory.
*/
/** Maximum number of entries inspected in one archive. */
const MAX_ZIP_ENTRIES = 2e3;
/** Read a ZIP central directory. Returns an empty list for a non-ZIP buffer. */
function readZipDirectory(data) {
	const maxScan = Math.min(data.length, 66e3);
	let eocd = -1;
	for (let offset = data.length - 22; offset >= data.length - maxScan && offset >= 0; offset -= 1) if (data.readUInt32LE(offset) === 101010256) {
		eocd = offset;
		break;
	}
	if (eocd < 0) return [];
	const count = Math.min(data.readUInt16LE(eocd + 10), MAX_ZIP_ENTRIES);
	let cursor = data.readUInt32LE(eocd + 16);
	const entries = [];
	for (let index = 0; index < count && cursor + 46 <= data.length; index += 1) {
		if (data.readUInt32LE(cursor) !== 33639248) break;
		const method = data.readUInt16LE(cursor + 10);
		const compressedSize = data.readUInt32LE(cursor + 20);
		const uncompressedSize = data.readUInt32LE(cursor + 24);
		const nameLength = data.readUInt16LE(cursor + 28);
		const extraLength = data.readUInt16LE(cursor + 30);
		const commentLength = data.readUInt16LE(cursor + 32);
		const mode = data.readUInt32LE(cursor + 38) >>> 16;
		const localHeaderOffset = data.readUInt32LE(cursor + 42);
		const name = data.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
		entries.push({
			name,
			method,
			uncompressedSize,
			compressedSize,
			localHeaderOffset,
			mode
		});
		cursor += 46 + nameLength + extraLength + commentLength;
	}
	return entries;
}
/**
* Inflate one entry.
* @param data - the whole archive.
* @param entry - an entry from {@link readZipDirectory}.
* @param maxBytes - refuse entries larger than this (uncompressed).
* @returns the entry bytes, or undefined when it cannot be read safely.
*/
function readZipEntry(data, entry, maxBytes = 8 * 1024 * 1024) {
	if (entry.uncompressedSize > maxBytes) return void 0;
	const header = entry.localHeaderOffset;
	if (header + 30 > data.length || data.readUInt32LE(header) !== 67324752) return void 0;
	const nameLength = data.readUInt16LE(header + 26);
	const extraLength = data.readUInt16LE(header + 28);
	const start = header + 30 + nameLength + extraLength;
	const end = entry.compressedSize === 0 ? data.length : Math.min(data.length, start + entry.compressedSize);
	if (start > data.length || end < start) return void 0;
	const raw = data.subarray(start, end);
	try {
		if (entry.method === 0) {
			if (raw.length > maxBytes) return void 0;
			return Buffer.from(raw);
		}
		if (entry.method === 8) return inflateRawSync(raw, { maxOutputLength: maxBytes });
	} catch {
		return;
	}
}
/** Whether a directory entry name looks like a folder marker. */
function isZipDirectory(entry) {
	return entry.name.endsWith("/") || (entry.mode & 61440) === 16384;
}
//#endregion
//#region src/file-text.ts
/**
* Best-effort plain-text extraction for canvas file nodes.
*
* The light skill tier sends text to a chat model, so a file node needs *some*
* readable text before it can be processed at all. This module covers the
* formats that are genuinely extractable without native dependencies:
*
*  - text-like files (txt / md / csv / json / code) decode directly;
*  - OOXML and ODF documents (docx / pptx / xlsx / odt / odp / ods) are ZIP
*    archives of XML, so the XML parts are inflated with `node:zlib` and their
*    text nodes are pulled out in document order;
*  - PDFs are scanned for FlateDecode content streams and the text-showing
*    operators are decoded.
*
* Anything else (images, media, archives, opaque binaries) reports
* `supported: false` with a reason instead of silently returning noise, so the
* UI can suggest the heavy agent tier instead.
*/
/** Cap on extracted text handed to a model (about 200k characters). */
const MAX_EXTRACTED_CHARS = 2e5;
const TEXT_EXTENSIONS = /* @__PURE__ */ new Set([
	"txt",
	"text",
	"log",
	"md",
	"markdown",
	"mdx",
	"csv",
	"tsv",
	"json",
	"jsonl",
	"ndjson",
	"yaml",
	"yml",
	"toml",
	"ini",
	"cfg",
	"conf",
	"env",
	"properties",
	"xml",
	"html",
	"htm",
	"css",
	"scss",
	"less",
	"js",
	"mjs",
	"cjs",
	"ts",
	"tsx",
	"jsx",
	"py",
	"rb",
	"go",
	"rs",
	"java",
	"kt",
	"c",
	"h",
	"cc",
	"cpp",
	"hpp",
	"cs",
	"php",
	"swift",
	"sql",
	"sh",
	"bat",
	"ps1",
	"lua",
	"r",
	"pl",
	"vue",
	"svelte"
]);
const OOXML_PART_PATTERN = /^(word\/document\.xml|ppt\/slides\/slide\d+\.xml|ppt\/notesSlides\/notesSlide\d+\.xml|xl\/sharedStrings\.xml|xl\/worksheets\/sheet\d+\.xml|content\.xml)$/i;
const ODF_PART_PATTERN = /^content\.xml$/i;
/** Decode bytes as UTF-8, falling back to a Latin-1 read for odd encodings. */
function decodeText$1(data) {
	const utf8 = new TextDecoder("utf-8", { fatal: false }).decode(data);
	if ((utf8.match(/\uFFFD/g)?.length ?? 0) / Math.max(1, utf8.length) < .02) return utf8;
	return new TextDecoder("latin1").decode(data);
}
function extensionOf$1(name) {
	const match = /\.([a-z0-9]+)$/i.exec(name.trim());
	return match === null ? "" : match[1].toLowerCase();
}
/** Strip XML markup and decode the entities OOXML/ODF bodies actually use. */
function xmlToText(xml) {
	return xml.replace(/<\/w:p>|<\/a:p>|<\/text:p>|<\/text:h>|<\/w:tr>/gi, "\n").replace(/<w:tab\b[^>]*\/>|<a:br\b[^>]*\/>/gi, "	").replace(/<[^>]*>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code))).replace(/&amp;/g, "&").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
/** Pull readable text out of a PDF's FlateDecode content streams. */
function extractPdfText(data) {
	const chunks = [];
	const marker = Buffer.from("stream");
	let cursor = 0;
	while (cursor < data.length && chunks.length < 400) {
		const at = data.indexOf(marker, cursor);
		if (at < 0) break;
		let start = at + marker.length;
		if (data[start] === 13) start += 1;
		if (data[start] === 10) start += 1;
		const end = data.indexOf(Buffer.from("endstream"), start);
		if (end < 0) break;
		cursor = end + 9;
		const raw = data.subarray(start, end);
		let inflated;
		try {
			inflated = inflateSync(raw);
		} catch {
			inflated = void 0;
		}
		if (inflated === void 0) continue;
		const content = inflated.toString("latin1");
		if (!/BT[\s\S]{0,4000}?ET/.test(content)) continue;
		const texts = [];
		const pattern = /\((?:\\.|[^\\()])*\)/g;
		let match;
		while ((match = pattern.exec(content)) !== null) {
			const decoded = match[0].slice(1, -1).replace(/\\([nrtbf])/g, (_, code) => code === "n" ? "\n" : code === "r" ? "\n" : code === "t" ? "	" : "").replace(/\\([()\\])/g, "$1").replace(/\\(\d{1,3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)));
			if (decoded.trim() !== "") texts.push(decoded);
		}
		if (texts.length > 0) chunks.push(texts.join(" "));
	}
	return chunks.join("\n").replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}
function truncate(text) {
	if (text.length <= 2e5) return {
		text,
		truncated: false
	};
	return {
		text: text.slice(0, MAX_EXTRACTED_CHARS),
		truncated: true
	};
}
/**
* Extract readable text from one stored file asset.
* @param data - raw file bytes.
* @param name - original file name (drives the format decision).
* @param mime - stored MIME type, used when the name has no extension.
* @returns extraction result; never throws for malformed input.
*/
function extractFileText(data, name, mime = "") {
	const extension = extensionOf$1(name);
	const buffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
	const looksZip = buffer.length > 4 && buffer[0] === 80 && buffer[1] === 75;
	if (buffer.length > 5 && buffer.subarray(0, 5).toString("latin1") === "%PDF-" || extension === "pdf") {
		const text = extractPdfText(buffer);
		const cut = truncate(text);
		if (text.trim() === "") return {
			supported: false,
			format: "pdf",
			text: "",
			truncated: false,
			warning: "PDF 未能提取到可读文字（可能是扫描件或使用了非标准编码），建议改用「重任务」技能或先转成图片节点走视觉模型。"
		};
		return {
			supported: true,
			format: "pdf",
			text: cut.text,
			truncated: cut.truncated,
			warning: "PDF 文字为启发式提取，复杂排版可能丢失顺序。"
		};
	}
	if (looksZip) {
		const entries = readZipDirectory(buffer);
		const isOdf = entries.some((entry) => ODF_PART_PATTERN.test(entry.name));
		const wanted = entries.filter((entry) => isOdf ? ODF_PART_PATTERN.test(entry.name) : OOXML_PART_PATTERN.test(entry.name));
		if (wanted.length > 0) {
			const parts = [];
			for (const entry of wanted.sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true }))) {
				const raw = readZipEntry(buffer, entry);
				if (raw === void 0) continue;
				const text = xmlToText(decodeText$1(raw));
				if (text !== "") parts.push(text);
			}
			const joined = parts.join("\n\n");
			const cut = truncate(joined);
			const format = extension === "" ? isOdf ? "odf" : "ooxml" : extension;
			if (joined.trim() === "") return {
				supported: false,
				format,
				text: "",
				truncated: false,
				warning: "文档里没有提取到文字（可能是纯图片幻灯片或表格）。可以先转成图片节点，再交给视觉模型处理。"
			};
			return {
				supported: true,
				format,
				text: cut.text,
				truncated: cut.truncated
			};
		}
		return {
			supported: false,
			format: extension === "" ? "zip" : extension,
			text: "",
			truncated: false,
			warning: "压缩包不能直接抽取内容，请先解压后上传其中的文档。"
		};
	}
	if (TEXT_EXTENSIONS.has(extension) || mime.startsWith("text/") || mime === "application/json" || mime === "application/xml" || mime === "application/x-yaml" || mime === "application/yaml") {
		const cut = truncate(decodeText$1(buffer));
		return {
			supported: true,
			format: extension === "" ? "text" : extension,
			text: cut.text,
			truncated: cut.truncated
		};
	}
	return {
		supported: false,
		format: extension === "" ? "binary" : extension,
		text: "",
		truncated: false,
		warning: `无法把 .${extension === "" ? "bin" : extension} 文件当作文本读取，请换用支持该格式的技能，或先转成文本/图片节点。`
	};
}
//#endregion
//#region src/file-preview.ts
/**
* Content previews for canvas file nodes.
*
* A file node stores arbitrary bytes, so the browser cannot be handed a URL and
* told to render them: HTML/SVG-shaped payloads must never execute in the app's
* origin, and office documents are ZIP containers rather than viewable pages.
* This module turns one stored asset into a bounded, structured preview:
*
*  - images / PDFs / audio / video return an inline URL (the only types the
*    asset route will serve inline — see the route's MIME allow-list);
*  - HTML / SVG / Markdown decode whole so the client can render them as the
*    original document (sandboxed iframe / `<img>` / rich-text renderer);
*  - CSV / TSV / XLSX become a grid;
*  - DOCX parses into headings, lists, tables and styled runs; PPTX into one
*    card per slide with its text and embedded pictures;
*  - remaining text-like / office files reuse the extractor the
*    `extract.content` skill already relies on;
*  - ZIP archives list their central directory.
*
* Every branch is bounded: a hostile or merely huge file can waste CPU here,
* but it cannot make the host allocate unbounded memory or hang the request.
*/
/** Characters of text handed to the viewer (about 120k, ~350KB of JSON). */
const MAX_PREVIEW_CHARS = 12e4;
const MAX_PREVIEW_MEDIA_BYTES = 6 * 1024 * 1024;
/** Image MIME types every current browser renders inside an `<img>`. */
const INLINE_IMAGE_MIME = /^image\/(png|jpeg|webp|gif|bmp)$/;
/** Delimited text formats turned into a grid instead of a wall of commas. */
const TABLE_EXTENSIONS = /* @__PURE__ */ new Set(["csv", "tsv"]);
/** Raster formats an `<img>` tag can show; EMF/WMF metafiles are skipped. */
const IMAGE_MIME_BY_EXTENSION = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	bmp: "image/bmp",
	webp: "image/webp"
};
function extensionOf(name) {
	if (name === void 0) return "";
	return path.extname(name).replace(/^\./, "").toLowerCase();
}
function decodeText(data) {
	const utf8 = new TextDecoder("utf-8", { fatal: false }).decode(data);
	if ((utf8.match(/\uFFFD/g)?.length ?? 0) / Math.max(1, utf8.length) < .02) return utf8;
	return new TextDecoder("latin1").decode(data);
}
function decodeXmlEntities(value) {
	return value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'").replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16))).replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code))).replace(/&amp;/g, "&");
}
function clampText(text) {
	const cap = Math.min(MAX_PREVIEW_CHARS, MAX_EXTRACTED_CHARS);
	if (text.length <= cap) return {
		text,
		truncated: false
	};
	return {
		text: text.slice(0, cap),
		truncated: true
	};
}
/** Split one delimited document into rows, honouring quotes and embedded newlines. */
function parseDelimited(text, delimiter) {
	const rows = [];
	let row = [];
	let field = "";
	let quoted = false;
	let totalRows = 0;
	for (let index = 0; index < text.length; index += 1) {
		const char = text[index];
		if (quoted) {
			if (char === "\"") if (text[index + 1] === "\"") {
				field += "\"";
				index += 1;
			} else quoted = false;
			else field += char;
			continue;
		}
		if (char === "\"" && field === "") {
			quoted = true;
			continue;
		}
		if (char === delimiter) {
			row.push(field);
			field = "";
			continue;
		}
		if (char === "\n" || char === "\r") {
			if (char === "\r" && text[index + 1] === "\n") index += 1;
			row.push(field);
			field = "";
			totalRows += 1;
			if (rows.length < 300) rows.push(row.slice(0, 40));
			row = [];
			continue;
		}
		field += char;
	}
	if (field !== "" || row.length > 0) {
		row.push(field);
		totalRows += 1;
		if (rows.length < 300) rows.push(row.slice(0, 40));
	}
	return {
		rows,
		totalRows
	};
}
/** Column index of an A1-style cell reference (`B7` -> 1). */
function columnIndex(reference) {
	const letters = /^([A-Z]+)/i.exec(reference)?.[1];
	if (letters === void 0) return 0;
	let value = 0;
	for (const char of letters.toUpperCase()) value = value * 26 + (char.charCodeAt(0) - 64);
	return Math.max(0, value - 1);
}
/** Shared-string table of one XLSX workbook (`xl/sharedStrings.xml`). */
function readSharedStrings(buffer, entries) {
	const entry = entries.find((item) => item.name.toLowerCase() === "xl/sharedstrings.xml");
	if (entry === void 0) return [];
	const raw = readZipEntry(buffer, entry);
	if (raw === void 0) return [];
	const xml = decodeText(raw);
	const out = [];
	const itemPattern = /<si\b[^>]*>([\s\S]*?)<\/si>|<si\s*\/>/g;
	let match;
	while ((match = itemPattern.exec(xml)) !== null) {
		const body = match[1] ?? "";
		let text = "";
		const textPattern = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
		let part;
		while ((part = textPattern.exec(body)) !== null) text += decodeXmlEntities(part[1] ?? "");
		out.push(text);
	}
	return out;
}
/** Read the first worksheet of an XLSX workbook into a bounded grid. */
function readXlsxGrid(buffer) {
	const entries = readZipDirectory(buffer);
	if (entries.length === 0) return void 0;
	const sheets = entries.filter((entry) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(entry.name)).sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true }));
	if (sheets.length === 0) return void 0;
	const raw = readZipEntry(buffer, sheets[0]);
	if (raw === void 0) return void 0;
	const shared = readSharedStrings(buffer, entries);
	const xml = decodeText(raw);
	const rows = [];
	let totalRows = 0;
	let more = false;
	const rowPattern = /<row\b[^>]*>([\s\S]*?)<\/row>|<row\b[^>]*\/>/g;
	let rowMatch;
	while ((rowMatch = rowPattern.exec(xml)) !== null) {
		if (rows.length >= 300) {
			more = true;
			break;
		}
		totalRows += 1;
		const body = rowMatch[1] ?? "";
		const cells = [];
		const cellPattern = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
		let cellMatch;
		while ((cellMatch = cellPattern.exec(body)) !== null) {
			const attributes = cellMatch[1] ?? "";
			const inner = cellMatch[2] ?? "";
			const reference = /r="([A-Z]+\d+)"/i.exec(attributes)?.[1] ?? "";
			const type = /t="([a-z]+)"/i.exec(attributes)?.[1]?.toLowerCase() ?? "";
			let value = "";
			if (type === "s") value = shared[Number(/<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? "")] ?? "";
			else if (type === "inlinestr") {
				const textPattern = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
				let part;
				while ((part = textPattern.exec(inner)) !== null) value += decodeXmlEntities(part[1] ?? "");
			} else {
				const raw = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? "";
				value = type === "b" ? raw.trim() === "1" ? "TRUE" : "FALSE" : decodeXmlEntities(raw);
			}
			const column = reference === "" ? cells.length : columnIndex(reference);
			if (column >= 40) continue;
			while (cells.length < column) cells.push("");
			cells[column] = value;
		}
		rows.push(cells.map((cell) => cell ?? ""));
	}
	if (totalRows === 0) return void 0;
	return {
		rows,
		totalRows,
		truncated: more
	};
}
/** Whether an on/off run property (`<w:b>` / `<w:i>`) is switched on. */
function docxRunFlag(body, tag) {
	const pattern = new RegExp(`<w:${tag}(?=[\\s/>])[^>]*>`, "g");
	let on = false;
	let match;
	while ((match = pattern.exec(body)) !== null) on = !/w:val="(?:0|false|off)"/i.test(match[0]);
	return on || void 0;
}
/** Styled runs of one DOCX paragraph fragment; adjacent same-style runs merge. */
function docxRuns(fragment) {
	const runs = [];
	const runPattern = /<w:r\b[^>]*(?:\/>|>([\s\S]*?)<\/w:r>)/g;
	let match;
	while ((match = runPattern.exec(fragment)) !== null) {
		const body = match[1] ?? "";
		let text = "";
		const partPattern = /<w:t\b[^>]*\/>|<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<w:br\b[^>]*\/>|<w:tab\b[^>]*\/>/g;
		let part;
		while ((part = partPattern.exec(body)) !== null) if (part[0].startsWith("<w:br")) text += "\n";
		else if (part[0].startsWith("<w:tab")) text += "	";
		else text += decodeXmlEntities(part[1] ?? "");
		if (text === "") continue;
		const bold = docxRunFlag(body, "b");
		const italic = docxRunFlag(body, "i");
		const previous = runs.at(-1);
		if (previous !== void 0 && !!previous.bold === !!bold && !!previous.italic === !!italic) {
			previous.text += text;
			continue;
		}
		runs.push({
			text,
			...bold === void 0 ? {} : { bold },
			...italic === void 0 ? {} : { italic }
		});
	}
	return runs;
}
/** numId -> list kind (`bullet` vs everything counted) from `word/numbering.xml`. */
function readDocxNumbering(buffer, entries) {
	const orderedByNumId = /* @__PURE__ */ new Map();
	const entry = entries.find((item) => item.name.toLowerCase() === "word/numbering.xml");
	if (entry === void 0) return orderedByNumId;
	const raw = readZipEntry(buffer, entry);
	if (raw === void 0) return orderedByNumId;
	const xml = decodeText(raw);
	const orderedByAbstract = /* @__PURE__ */ new Map();
	const abstractPattern = /<w:abstractNum\b[^>]*w:abstractNumId="(\d+)"[^>]*>([\s\S]*?)<\/w:abstractNum>/g;
	let abstract;
	while ((abstract = abstractPattern.exec(xml)) !== null) {
		const format = /<w:numFmt w:val="([^"]+)"/.exec(abstract[2] ?? "")?.[1]?.toLowerCase();
		orderedByAbstract.set(abstract[1], format !== "bullet");
	}
	const numPattern = /<w:num\b[^>]*w:numId="(\d+)"[^>]*>[\s\S]*?<w:abstractNumId w:val="(\d+)"[^>]*\/>[\s\S]*?<\/w:num>/g;
	let num;
	while ((num = numPattern.exec(xml)) !== null) {
		const ordered = orderedByAbstract.get(num[2]);
		if (ordered !== void 0) orderedByNumId.set(num[1], ordered);
	}
	return orderedByNumId;
}
/** Cell texts of one DOCX table (`<w:tbl>` fragment), one paragraph per line. */
function docxTableRows(fragment) {
	const rows = [];
	const rowPattern = /<w:tr\b[\s\S]*?<\/w:tr>/g;
	let row;
	while ((row = rowPattern.exec(fragment)) !== null && rows.length < 300) {
		const cells = [];
		const cellPattern = /<w:tc\b[\s\S]*?<\/w:tc>/g;
		let cell;
		while ((cell = cellPattern.exec(row[0])) !== null && cells.length < 40) {
			const paragraphs = [];
			const paraPattern = /<w:p\b[^>]*(?:\/>|>[\s\S]*?<\/w:p>)/g;
			let para;
			while ((para = paraPattern.exec(cell[0])) !== null) {
				const text = docxRuns(para[0]).map((run) => run.text).join("").replace(/\s+/g, " ").trim();
				if (text !== "") paragraphs.push(text);
			}
			cells.push(paragraphs.join("\n"));
		}
		rows.push(cells);
	}
	return rows;
}
/** Structured preview of a DOCX body: headings, lists, tables, styled runs.
*  Undefined when the document has no body blocks (flat extraction takes over). */
function readDocxBlocks(buffer) {
	const entries = readZipDirectory(buffer);
	const documentEntry = entries.find((item) => item.name.toLowerCase() === "word/document.xml");
	if (documentEntry === void 0) return void 0;
	const raw = readZipEntry(buffer, documentEntry);
	if (raw === void 0) return void 0;
	const xml = decodeText(raw);
	const body = /<w:body\b[^>]*>([\s\S]*)<\/w:body>/.exec(xml)?.[1] ?? xml;
	const numbering = readDocxNumbering(buffer, entries);
	const blocks = [];
	let truncated = false;
	let chars = 0;
	let list;
	const flushList = () => {
		if (list !== void 0 && list.items.length > 0) blocks.push({
			type: "list",
			ordered: list.ordered,
			items: list.items
		});
		list = void 0;
	};
	const scanner = /<w:tbl[ >]|<w:p[ >/]/g;
	scanner.lastIndex = 0;
	let match;
	while ((match = scanner.exec(body)) !== null) {
		if (blocks.length >= 900) {
			truncated = true;
			break;
		}
		if (match[0].startsWith("<w:p")) {
			const tagEnd = body.indexOf(">", match.index);
			if (tagEnd < 0) {
				truncated = true;
				break;
			}
			if (body[tagEnd - 1] === "/") {
				scanner.lastIndex = tagEnd + 1;
				continue;
			}
		}
		if (match[0].startsWith("<w:tbl")) {
			let depth = 0;
			let end = -1;
			const tagPattern = /<\/?w:tbl[ >]/g;
			tagPattern.lastIndex = match.index;
			let tag;
			while ((tag = tagPattern.exec(body)) !== null) {
				depth += tag[0].startsWith("</") ? -1 : 1;
				if (depth === 0) {
					end = tag.index + tag[0].length;
					break;
				}
			}
			if (end < 0) {
				truncated = true;
				break;
			}
			flushList();
			const rows = docxTableRows(body.slice(match.index, end));
			if (rows.length > 0) blocks.push({
				type: "table",
				rows
			});
			scanner.lastIndex = end;
			continue;
		}
		const close = body.indexOf("</w:p>", match.index);
		if (close < 0) {
			truncated = true;
			break;
		}
		const fragment = body.slice(match.index, close + 6);
		scanner.lastIndex = close + 6;
		const style = /<w:pStyle w:val="([^"]+)"/i.exec(fragment)?.[1] ?? "";
		let headingLevel = 0;
		const headingStyle = /^heading([1-9])$/i.exec(style);
		if (headingStyle !== null) headingLevel = Math.min(3, Number(headingStyle[1]));
		else if (/^title$/i.test(style)) headingLevel = 1;
		else if (/^subtitle$/i.test(style)) headingLevel = 2;
		else {
			const outline = /<w:outlineLvl w:val="([0-8])"/i.exec(fragment)?.[1];
			if (outline !== void 0) headingLevel = Math.min(3, Number(outline) + 1);
		}
		const runs = docxRuns(fragment);
		const text = runs.map((run) => run.text).join("");
		if (text.trim() === "") {
			flushList();
			continue;
		}
		chars += text.length;
		if (chars > 12e4) {
			truncated = true;
			break;
		}
		const numId = /<w:numId w:val="(\d+)"\s*\/>/i.exec(fragment)?.[1];
		if (headingLevel > 0 || numId === void 0 || numId === "0") {
			flushList();
			if (headingLevel > 0) blocks.push({
				type: "heading",
				level: headingLevel,
				runs
			});
			else blocks.push({
				type: "paragraph",
				runs
			});
			continue;
		}
		const ordered = numbering.get(numId) ?? false;
		if (list !== void 0 && list.ordered !== ordered) flushList();
		if (list === void 0) list = {
			ordered,
			items: []
		};
		list.items.push(runs);
	}
	flushList();
	if (blocks.length === 0) return void 0;
	return {
		blocks,
		truncated
	};
}
/** Paragraph texts of one PPTX shape / table fragment (one entry per `<a:p>`). */
function slideParagraphs(fragment) {
	const out = [];
	const paragraphPattern = /<a:p\b[\s\S]*?<\/a:p>/g;
	let paragraph;
	while ((paragraph = paragraphPattern.exec(fragment)) !== null) {
		let text = paragraph[0].replace(/<a:fld\b[\s\S]*?<\/a:fld>/g, "");
		let value = "";
		const textPattern = /<a:t\b[^>]*\/>|<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g;
		let part;
		while ((part = textPattern.exec(text)) !== null) value += decodeXmlEntities(part[1] ?? "");
		value = value.replace(/\s+/g, " ").trim();
		if (value !== "") out.push(value);
	}
	return out;
}
/** Slide-deck preview: one entry per slide with title, body lines and pictures.
*  Pictures ride along as data URLs within a shared byte budget so an
*  image-heavy deck still comes back bounded. */
function readPptxSlides(buffer) {
	const entries = readZipDirectory(buffer);
	const slideEntries = entries.filter((entry) => /^ppt\/slides\/slide\d+\.xml$/i.test(entry.name)).sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true }));
	if (slideEntries.length === 0) return void 0;
	/** rId -> zip path of one slide's relationship target. */
	const relsOf = (slideName) => {
		const map = /* @__PURE__ */ new Map();
		const relEntry = entries.find((item) => item.name.toLowerCase() === `ppt/slides/_rels/${slideName.toLowerCase()}.rels`);
		if (relEntry === void 0) return map;
		const raw = readZipEntry(buffer, relEntry);
		if (raw === void 0) return map;
		const relPattern = /<Relationship\b[^>]*>/g;
		let rel;
		while ((rel = relPattern.exec(decodeText(raw))) !== null) {
			const id = /\bId="([^"]+)"/.exec(rel[0])?.[1];
			const target = /\bTarget="([^"]+)"/.exec(rel[0])?.[1];
			if (id === void 0 || target === void 0) continue;
			const stack = [];
			for (const part of `ppt/slides/${target}`.split("/")) {
				if (part === "" || part === ".") continue;
				if (part === "..") stack.pop();
				else stack.push(part);
			}
			map.set(id, stack.join("/"));
		}
		return map;
	};
	const slides = [];
	let mediaBudget = MAX_PREVIEW_MEDIA_BYTES;
	let truncated = false;
	for (const slideEntry of slideEntries) {
		if (slides.length >= 80) {
			truncated = true;
			break;
		}
		const raw = readZipEntry(buffer, slideEntry);
		if (raw === void 0) continue;
		const xml = decodeText(raw);
		const slide = {
			lines: [],
			images: []
		};
		const rels = relsOf(slideEntry.name.replace(/^ppt\/slides\//i, ""));
		const blipPattern = /<a:blip\b[^>]*r:embed="([^"]+)"/g;
		let blip;
		while ((blip = blipPattern.exec(xml)) !== null && slide.images.length < 6) {
			const target = rels.get(blip[1]);
			if (target === void 0) continue;
			const mime = IMAGE_MIME_BY_EXTENSION[target.split(".").pop()?.toLowerCase() ?? ""];
			if (mime === void 0) continue;
			const mediaEntry = entries.find((item) => item.name.toLowerCase() === target.toLowerCase());
			if (mediaEntry === void 0 || mediaEntry.uncompressedSize > mediaBudget) {
				truncated = true;
				continue;
			}
			const media = readZipEntry(buffer, mediaEntry);
			if (media === void 0) continue;
			mediaBudget -= media.byteLength;
			slide.images.push({
				mime,
				data: `data:${mime};base64,${media.toString("base64")}`
			});
		}
		const shapePattern = /<p:sp\b[\s\S]*?<\/p:sp>/g;
		let shape;
		while ((shape = shapePattern.exec(xml)) !== null) {
			const paragraphs = slideParagraphs(shape[0]);
			if (paragraphs.length === 0) continue;
			if (/<p:ph\b[^>]*type="(?:ctrTitle|title)"/.test(shape[0]) && slide.title === void 0) slide.title = paragraphs.join(" ");
			else slide.lines.push(...paragraphs);
		}
		const tablePattern = /<a:tbl\b[\s\S]*?<\/a:tbl>/g;
		let table;
		while ((table = tablePattern.exec(xml)) !== null) slide.lines.push(...slideParagraphs(table[0]));
		slides.push(slide);
	}
	return {
		slides,
		truncated
	};
}
/** Content preview of one stored canvas file asset. Never throws. */
function buildFilePreview(input) {
	const name = input.name ?? "";
	const extension = extensionOf(name);
	const mime = baseMime$1(input.mime);
	const data = Buffer.from(input.data.buffer, input.data.byteOffset, input.data.byteLength);
	const kind = fileKindOf(mime, name);
	if (INLINE_IMAGE_MIME.test(mime) || kind === "image" && [
		"png",
		"jpg",
		"jpeg",
		"webp",
		"gif",
		"bmp"
	].includes(extension)) return {
		kind: "media",
		media: "image",
		url: input.url,
		width: 0,
		height: 0
	};
	if (mime === "application/pdf" || extension === "pdf") return {
		kind: "media",
		media: "pdf",
		url: input.url,
		width: 0,
		height: 0
	};
	if (mime.startsWith("audio/")) return {
		kind: "media",
		media: "audio",
		url: input.url,
		width: 0,
		height: 0
	};
	if (mime.startsWith("video/")) return {
		kind: "media",
		media: "video",
		url: input.url,
		width: 0,
		height: 0
	};
	const decoded = () => {
		const text = decodeText(data);
		return text.includes("\0") ? void 0 : text;
	};
	if ([
		"md",
		"markdown",
		"mdx"
	].includes(extension) || mime === "text/markdown" || mime === "text/x-markdown") {
		const text = decoded();
		if (text !== void 0) {
			const cut = clampText(text);
			return {
				kind: "markdown",
				format: "markdown",
				markdown: cut.text,
				truncated: cut.truncated
			};
		}
	}
	if (extension === "html" || extension === "htm" || mime === "text/html") {
		const text = decoded();
		if (text !== void 0) {
			const cut = clampText(text);
			return {
				kind: "html",
				format: "html",
				html: cut.text,
				truncated: cut.truncated
			};
		}
	}
	if (extension === "svg" || mime === "image/svg+xml") {
		const text = decoded();
		if (text !== void 0) {
			const cut = clampText(text);
			return {
				kind: "svg",
				format: "svg",
				svg: cut.text,
				truncated: cut.truncated
			};
		}
	}
	const looksZip = data.length > 4 && data[0] === 80 && data[1] === 75;
	if (extension === "xlsx" || mime.includes("spreadsheetml.sheet")) {
		if (looksZip) {
			const grid = readXlsxGrid(data);
			if (grid !== void 0) return {
				kind: "table",
				format: "xlsx",
				rows: grid.rows,
				totalRows: grid.totalRows,
				truncated: grid.truncated
			};
		}
	}
	if (TABLE_EXTENSIONS.has(extension) || mime === "text/csv" || mime === "text/tab-separated-values") {
		const decoded = decodeText(data);
		if (!decoded.includes("\0")) {
			const parsed = parseDelimited(decoded, extension === "tsv" || mime === "text/tab-separated-values" ? "	" : ",");
			return {
				kind: "table",
				format: extension === "" ? "csv" : extension,
				rows: parsed.rows,
				totalRows: parsed.totalRows,
				truncated: parsed.totalRows > parsed.rows.length
			};
		}
	}
	if (isTextMime(mime) || kind === "text" || kind === "office") {
		if (looksZip && (extension === "docx" || mime.includes("wordprocessingml.document"))) {
			const document = readDocxBlocks(data);
			if (document !== void 0) return {
				kind: "document",
				format: "docx",
				blocks: document.blocks,
				truncated: document.truncated
			};
		}
		if (looksZip && (extension === "pptx" || mime.includes("presentationml.presentation"))) {
			const deck = readPptxSlides(data);
			if (deck !== void 0) return {
				kind: "slides",
				format: "pptx",
				slides: deck.slides,
				truncated: deck.truncated
			};
		}
		const extracted = extractFileText(data, name, mime);
		if (extracted.supported) {
			const cut = clampText(extracted.text);
			return {
				kind: "text",
				format: extracted.format,
				text: cut.text,
				truncated: cut.truncated || extracted.truncated,
				lines: cut.text === "" ? 0 : cut.text.split("\n").length,
				...extracted.warning === void 0 ? {} : { warning: extracted.warning }
			};
		}
		return {
			kind: "none",
			format: extracted.format,
			reason: "unreadable",
			message: extracted.warning ?? "无法读取此文件的文字内容。"
		};
	}
	if (looksZip || kind === "archive") {
		const entries = looksZip ? readZipDirectory(data) : [];
		if (entries.length > 0) return {
			kind: "archive",
			entries: entries.slice(0, 400).map((entry) => ({
				name: entry.name,
				size: entry.uncompressedSize,
				dir: isZipDirectory(entry)
			})),
			totalEntries: entries.length,
			truncated: entries.length > 400
		};
		return {
			kind: "none",
			format: extension === "" ? "archive" : extension,
			reason: "unsupported",
			message: "这个压缩格式无法在画布内展开，请下载后用系统程序查看。"
		};
	}
	return {
		kind: "none",
		format: extension === "" ? mime === "" ? "bin" : mime : extension,
		reason: "unsupported",
		message: "这种格式没有可读内容，请下载后查看，或先转成图片 / 文本节点再交给技能处理。"
	};
}
//#endregion
//#region src/templates-store.ts
/**
* Prompt-template library store (multi-source).
*
* The library is a registry of independent sources (see TEMPLATE_SOURCES in
* protocol.ts): each source has its own upstream JSON list, its own bundled
* snapshot, its own refreshed runtime copy, and its own on-disk image pool.
* Sources never mix — the overlay shows one tab per source and every request
* names the source explicitly.
*
* Each case list ships as a bundled snapshot (src/templates/<file>, inside the
* npm package) so every library works offline out of the box; a successful
* refresh (manual, or the periodic background sync) writes a runtime copy
* under <data root>/templates/<sourceId>/ which then takes precedence.
* Reference images are not bundled (hundreds of files, ≈100 MB per source) —
* they are fetched from the source's mirror on demand, cached on disk under
* <data root>/template-images/<sourceId>/, and served from there on every
* later view.
*
* `<data root>` is `imageDataRoot()`, i.e. `$DSH_HOME/dsh-imagegen-studio` (defaulting
* to `~/.dsh/dsh-imagegen-studio`) unless the plugin's `localStoragePath` setting
* overrides it. Every path below is resolved per call rather than captured at
* import time: the host applies that setting while resolving the plugin, which
* happens after this module is loaded.
*
* Framework-free (node:fs only) so the route layer and tests can drive it
* directly.
*/
/** Source registry (host half): where each TEMPLATE_SOURCES entry loads from. */
const SOURCE_DEFS = {
	vibeui: {
		listUrl: "https://vibeui.top/extra/awesome-gpt-image-2/data/cases.json",
		imageBaseUrl: "https://vibeui.top/extra/awesome-gpt-image-2/data/images/",
		bundledPath: fileURLToPath(new URL("../src/templates/cases.json", import.meta.url)),
		legacySnapshotPath: "legacy",
		legacyImageDir: "legacy"
	},
	canghe: {
		listUrl: "https://gpt-image2.canghe.ai/cases.json",
		imageBaseUrl: "https://gpt-image2.canghe.ai/images/",
		bundledPath: fileURLToPath(new URL("../src/templates/canghe-cases.json", import.meta.url))
	},
	handraw: {
		bundledPath: fileURLToPath(new URL("../src/templates/handraw-cases.json", import.meta.url)),
		refreshable: false,
		allowedImageHosts: ["cdn.jsdelivr.net", "raw.githubusercontent.com"],
		imageUrls: (ref) => {
			const match = /^https:\/\/cdn\.jsdelivr\.net\/gh\/yang0\/handraw-style@([^/]+)(\/.*)$/i.exec(ref);
			return match?.[1] !== void 0 && match[2] !== void 0 ? [ref, `https://raw.githubusercontent.com/yang0/handraw-style/${match[1]}${match[2]}`] : [ref];
		}
	},
	"prompt-signal": {
		bundledPath: fileURLToPath(new URL("../src/templates/prompt-signal-cases.json", import.meta.url)),
		refreshable: false,
		allowedImageHosts: [
			"raw.githubusercontent.com",
			"pbs.twimg.com",
			"mosaic.fxtwitter.com"
		]
	},
	evolink: {
		bundledPath: fileURLToPath(new URL("../src/templates/evolink-cases.json", import.meta.url)),
		refreshable: false,
		allowedImageHosts: ["raw.githubusercontent.com"]
	},
	itgoyo: {
		bundledPath: fileURLToPath(new URL("../src/templates/itgoyo-cases.json", import.meta.url)),
		refreshable: false,
		allowedImageHosts: ["raw.githubusercontent.com"]
	},
	songtianlun: {
		bundledPath: fileURLToPath(new URL("../src/templates/songtianlun-cases.json", import.meta.url)),
		refreshable: false,
		allowedImageHosts: ["raw.githubusercontent.com", "cdn.openai.com"]
	},
	youart: {
		bundledPath: fileURLToPath(new URL("../src/templates/youart-cases.json", import.meta.url)),
		refreshable: false
	}
};
/** Category label map mirrored from the upstream sites' site.js (zh names). */
const CATEGORY_ZH = {
	"Architecture & Spaces": "建筑与空间",
	"Brand & Logos": "品牌与标志",
	"Characters & People": "人物与角色",
	"Charts & Infographics": "图表与信息可视化",
	"Documents & Publishing": "文档与出版物",
	"History & Classical Themes": "历史与古风题材",
	"Illustration & Art": "插画与艺术",
	"Other Use Cases": "其他应用场景",
	"Photography & Realism": "摄影与写实",
	"Posters & Typography": "海报与排版",
	"Products & E-commerce": "商品与电商",
	"Scenes & Storytelling": "场景与叙事",
	"UI & Interfaces": "UI 与界面",
	"Portraits & Fashion": "人像与时尚",
	"Celebrities & Sports": "名人与运动",
	"Characters & IP": "角色与 IP",
	"Food & Beverage": "美食与饮品",
	"Brand & Icons": "品牌与图标",
	"Social Media & Stickers": "社媒与表情包",
	"Infographics & Diagrams": "信息图与图解",
	"UI & App Screens": "UI 与应用界面",
	"Architecture & Interiors": "建筑与室内",
	"Cinematic & Storytelling": "影视与叙事",
	"Illustration & Comics": "插画与漫画",
	"Historical & Fantasy": "历史与幻想",
	"Animals & Nature": "动物与自然",
	"Other Creative Uses": "其他创意用途"
};
/**
* Data-root paths are resolved lazily, on every use.
*
* The host calls `setImageDataRoot()` while it resolves the plugin (honouring
* `DSH_HOME` and the profile's `localStoragePath`), which happens *after* this
* module is evaluated. A module-level constant would therefore capture the
* default `~/.dsh/dsh-imagegen-studio` and then disagree with history, gallery, video
* and canvas — which read `imageDataRoot()` per call — about where the user's
* data lives.
*/
function refreshedDir() {
	return path.join(imageDataRoot(), "templates");
}
function imageCacheRoot() {
	return path.join(imageDataRoot(), "template-images");
}
/** Pre-1.6 single-source locations (vibeui fallbacks). */
function legacySnapshotPath() {
	return path.join(refreshedDir(), "cases.json");
}
function legacyImageDir() {
	return imageCacheRoot();
}
/** Budget for one upstream fetch (list refresh or one image). */
const FETCH_TIMEOUT_MS = 6e4;
/** Refuse to cache implausibly large "images". */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
/** Strict legacy reference-image file names this store writes and serves. */
const IMAGE_FILE_PATTERN = /^case\d+\.(jpg|jpeg|png|webp|gif)$/i;
/** Absolute image URL length accepted from bundled/refreshed snapshots. */
const MAX_IMAGE_URL_LENGTH = 4e3;
/**
* Per-source in-memory memo of the active list (avoid re-parsing per request).
*
* Keyed by `${dataRoot}\0${sourceId}` rather than by source id alone: the
* refreshed runtime copy lives under the data root, and that root can be
* repointed after this module loads. A memo keyed only by source id would keep
* serving the OLD root's list while the image cache had already moved to the
* new one, so the two would disagree about where this source's data lives.
*/
const memos = /* @__PURE__ */ new Map();
function memoKey(sourceId) {
	return `${imageDataRoot()}\0${sourceId}`;
}
/** Per-file in-flight downloads, so a gallery scroll never double-fetches. */
const inflightImages = /* @__PURE__ */ new Map();
/** Resolve a registered source id to its fetch definition. */
function sourceDefOf(sourceId) {
	return SOURCE_DEFS[sourceId];
}
/** Validate + normalize one raw upstream case; undefined when unusable. */
function normalizeCase(raw) {
	if (raw === null || typeof raw !== "object") return void 0;
	const record = raw;
	const id = typeof record.id === "number" && Number.isFinite(record.id) ? String(record.id) : typeof record.id === "string" ? record.id.trim() : "";
	const title = typeof record.title === "string" ? record.title.trim() : "";
	const prompt = typeof record.prompt === "string" ? record.prompt.trim() : "";
	if (id === "" || title === "" || prompt === "") return void 0;
	const category = typeof record.category === "string" ? record.category : "";
	const image = imageRefOf(typeof record.image === "string" ? record.image : "");
	return {
		id,
		title,
		prompt,
		category,
		categoryZh: typeof record.categoryZh === "string" && record.categoryZh.trim() !== "" ? record.categoryZh.trim() : CATEGORY_ZH[category] ?? category,
		styles: Array.isArray(record.styles) ? record.styles.map(String) : [],
		scenes: Array.isArray(record.scenes) ? record.scenes.map(String) : [],
		sourceLabel: typeof record.sourceLabel === "string" ? record.sourceLabel : "",
		sourceUrl: typeof record.sourceUrl === "string" ? record.sourceUrl : "",
		githubUrl: typeof record.githubUrl === "string" ? record.githubUrl : "",
		image,
		featured: record.featured === true
	};
}
/** Accept either a legacy bare file name or a safe absolute image URL. */
function imageRefOf(value) {
	const raw = value.trim();
	if (/^https?:\/\//i.test(raw)) {
		if (raw.length > MAX_IMAGE_URL_LENGTH) return "";
		try {
			const url = new URL(raw);
			return (url.protocol === "http:" || url.protocol === "https:") && url.username === "" && url.password === "" ? url.toString() : "";
		} catch {
			return "";
		}
	}
	const name = raw.replace(/^\/+/, "").split("/").pop() ?? "";
	return IMAGE_FILE_PATTERN.test(name) ? name : "";
}
/** Parse a snapshot payload (bundled, refreshed cache, or fresh download). */
function parseSnapshot(payload) {
	if (payload === null || typeof payload !== "object") return void 0;
	const snapshot = payload;
	if (!Array.isArray(snapshot.cases)) return void 0;
	const cases = [];
	for (const raw of snapshot.cases) {
		const normalized = normalizeCase(raw);
		if (normalized !== void 0) cases.push(normalized);
	}
	if (cases.length === 0) return void 0;
	return {
		cases,
		repository: typeof snapshot.repository === "string" && snapshot.repository !== "" ? snapshot.repository : "freestylefly/awesome-gpt-image-2",
		fetchedAt: typeof snapshot.fetchedAt === "string" && snapshot.fetchedAt !== "" ? snapshot.fetchedAt : ""
	};
}
/** Read + parse a snapshot file; undefined when missing/corrupt. */
async function readSnapshotFile(file) {
	try {
		return parseSnapshot(JSON.parse(await promises.readFile(file, "utf8")));
	} catch {
		return;
	}
}
/**
* The active template list of one source: the refreshed runtime copy wins, the
* bundled snapshot is the always-available fallback. Memoized per source; a
* successful refresh replaces that source's memo.
*/
async function listTemplates(sourceId = DEFAULT_TEMPLATE_SOURCE_ID) {
	const def = sourceDefOf(sourceId);
	if (def === void 0) throw new Error(`未知的模板库来源：${sourceId}`);
	const memo = memos.get(memoKey(sourceId));
	if (memo !== void 0) return memo;
	const refreshed = await readSnapshotFile(path.join(refreshedDir(), sourceId, "cases.json")) ?? (def.legacySnapshotPath !== void 0 ? await readSnapshotFile(legacySnapshotPath()) : void 0);
	if (refreshed !== void 0) {
		const result = {
			sourceId,
			...refreshed,
			total: refreshed.cases.length,
			origin: "refreshed"
		};
		memos.set(memoKey(sourceId), result);
		return result;
	}
	const bundled = await readSnapshotFile(def.bundledPath);
	if (bundled !== void 0) {
		const result = {
			sourceId,
			...bundled,
			total: bundled.cases.length,
			origin: "bundled"
		};
		memos.set(memoKey(sourceId), result);
		return result;
	}
	const result = {
		sourceId,
		cases: [],
		total: 0,
		origin: "bundled",
		repository: "freestylefly/awesome-gpt-image-2",
		fetchedAt: ""
	};
	memos.set(memoKey(sourceId), result);
	return result;
}
/**
* Re-download one source's case list from its upstream mirror and persist it
* as the runtime copy. Throws with a user-presentable message on failure; the
* previous list (refreshed or bundled) stays active.
*/
async function refreshTemplates(sourceId = DEFAULT_TEMPLATE_SOURCE_ID) {
	const def = sourceDefOf(sourceId);
	if (def === void 0) throw new Error(`未知的模板库来源：${sourceId}`);
	if (def.refreshable === false || def.listUrl === void 0) throw new Error("该模板库为随插件版本更新的内置快照，暂不支持在线刷新");
	let response;
	try {
		response = await fetch(def.listUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
	} catch (error) {
		throw new Error(`无法连接模板库源站（${sourceId}）：${error instanceof Error ? error.message : String(error)}`);
	}
	if (!response.ok) throw new Error(`模板库源站拒绝请求（HTTP ${response.status}）`);
	let payload;
	try {
		payload = await response.json();
	} catch {
		throw new Error("模板库源站返回了非 JSON 响应");
	}
	const parsed = parseSnapshot(payload);
	if (parsed === void 0) throw new Error("模板库源站数据格式无效");
	const fetchedAt = (/* @__PURE__ */ new Date()).toISOString();
	const snapshot = {
		repository: parsed.repository,
		sourceUrl: def.listUrl,
		fetchedAt,
		totalCases: parsed.cases.length,
		cases: parsed.cases
	};
	const target = path.join(refreshedDir(), sourceId, "cases.json");
	await promises.mkdir(path.dirname(target), { recursive: true });
	const tmp = `${target}.tmp-${process.pid}`;
	await promises.writeFile(tmp, JSON.stringify(snapshot), "utf8");
	await promises.rename(tmp, target);
	const result = {
		sourceId,
		cases: parsed.cases,
		total: parsed.cases.length,
		origin: "refreshed",
		repository: parsed.repository,
		fetchedAt
	};
	memos.set(memoKey(sourceId), result);
	return {
		sourceId,
		total: parsed.cases.length,
		fetchedAt
	};
}
/** Fisher–Yates shuffle (returns a copy; never mutates the pool). */
function shuffled(items) {
	const out = [...items];
	for (let i = out.length - 1; i > 0; i -= 1) {
		const j = Math.floor(Math.random() * (i + 1));
		const a = out[i];
		out[i] = out[j];
		out[j] = a;
	}
	return out;
}
/**
* Draw up to `count` random cases across every source that has data,
* round-robin between sources so one huge library cannot crowd out the
* others, then shuffle the final pick. Reads memoized lists, so this never
* touches the network — cheap enough for every shuffle click.
*/
async function sampleTemplates(count = 9) {
	const size = Math.min(12, Math.max(1, Math.floor(count) || 9));
	const pools = [];
	for (const source of TEMPLATE_SOURCES) try {
		const list = await listTemplates(source.id);
		if (list.cases.length > 0) pools.push({
			sourceId: source.id,
			cases: shuffled(list.cases)
		});
	} catch {}
	const picks = [];
	for (let round = 0; picks.length < size && pools.some((pool) => pool.cases.length > 0); round += 1) {
		const pool = pools[round % pools.length];
		const picked = pool.cases.pop();
		if (picked !== void 0) picks.push({
			sourceId: pool.sourceId,
			case: picked
		});
	}
	return shuffled(picks);
}
/** Serially refresh every registered source; one failure never stops the rest. */
async function syncAllTemplates() {
	const reports = [];
	for (const source of TEMPLATE_SOURCES) try {
		const def = sourceDefOf(source.id);
		if (def?.refreshable === false || def?.listUrl === void 0) {
			const bundled = await listTemplates(source.id);
			reports.push({
				sourceId: source.id,
				ok: true,
				total: bundled.total
			});
			continue;
		}
		const result = await refreshTemplates(source.id);
		reports.push({
			sourceId: source.id,
			ok: true,
			total: result.total
		});
	} catch (error) {
		reports.push({
			sourceId: source.id,
			ok: false,
			total: 0,
			error: error instanceof Error ? error.message : String(error)
		});
	}
	return reports;
}
/** MIME type for a known image extension; undefined when the name has none. */
function mimeOfFile(file) {
	switch (path.extname(file).toLowerCase()) {
		case ".jpg":
		case ".jpeg": return "image/jpeg";
		case ".png": return "image/png";
		case ".webp": return "image/webp";
		case ".gif": return "image/gif";
		default: return;
	}
}
/** Sniff the five image formats the template proxy serves. */
function sniffImageMime(data) {
	if (data.length >= 3 && data[0] === 255 && data[1] === 216 && data[2] === 255) return "image/jpeg";
	if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([
		137,
		80,
		78,
		71,
		13,
		10,
		26,
		10
	]))) return "image/png";
	if (data.length >= 12 && data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
	if (data.length >= 6 && (data.subarray(0, 6).toString("ascii") === "GIF87a" || data.subarray(0, 6).toString("ascii") === "GIF89a")) return "image/gif";
}
/** True when an image reference is safe for a specific source. */
function isAllowedImageRef(def, ref) {
	if (!/^https?:\/\//i.test(ref)) return IMAGE_FILE_PATTERN.test(ref) && !ref.includes("..");
	if (ref.length > MAX_IMAGE_URL_LENGTH || ref.includes("..")) return false;
	try {
		const url = new URL(ref);
		return (url.protocol === "http:" || url.protocol === "https:") && url.username === "" && url.password === "" && (def.allowedImageHosts ?? []).includes(url.hostname.toLowerCase());
	} catch {
		return false;
	}
}
/** All upstream URLs to try for one image reference. */
function imageUrlsOf(def, ref) {
	if (/^https?:\/\//i.test(ref)) return (def.imageUrls ?? ((value) => [value]))(ref);
	if (def.imageBaseUrl === void 0) return [];
	return [`${def.imageBaseUrl}${encodeURIComponent(ref)}`];
}
/** Cache file name: legacy bare names stay readable; remote URLs are hashed. */
function cacheFileOf(ref) {
	if (IMAGE_FILE_PATTERN.test(ref) && !ref.includes("..")) return ref;
	let ext = "";
	try {
		const url = new URL(ref);
		ext = path.extname(url.pathname).toLowerCase();
		if (!/^\.[a-z0-9]{2,5}$/.test(ext)) {
			const format = (url.searchParams.get("format") ?? "").toLowerCase();
			ext = [
				"jpg",
				"jpeg",
				"png",
				"webp",
				"gif"
			].includes(format) ? `.${format}` : "";
		}
	} catch {}
	return `${createHash("sha256").update(ref).digest("hex").slice(0, 32)}${ext}`;
}
/** Download one reference image into the source's disk cache; undefined on failure. */
async function fetchTemplateImage(def, ref, cacheFile, cacheDir) {
	for (const url of imageUrlsOf(def, ref)) {
		let response;
		try {
			response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
		} catch {
			continue;
		}
		if (!response.ok) continue;
		if (Number(response.headers.get("content-length") ?? 0) > MAX_IMAGE_BYTES) continue;
		const data = Buffer.from(await response.arrayBuffer());
		if (data.byteLength === 0 || data.byteLength > MAX_IMAGE_BYTES) continue;
		const headerMime = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
		const mime = headerMime !== void 0 && /^image\/(png|jpeg|webp|gif)$/.test(headerMime) ? headerMime : sniffImageMime(data) ?? mimeOfFile(ref);
		if (mime === void 0) continue;
		try {
			await promises.mkdir(cacheDir, { recursive: true });
			const target = path.join(cacheDir, cacheFile);
			const tmp = `${target}.tmp-${process.pid}`;
			await promises.writeFile(tmp, data);
			await promises.rename(tmp, target);
		} catch {}
		return {
			data,
			mime
		};
	}
}
/**
* Read one reference image for a source's library. Cache hit → disk; miss →
* fetch from that source's mirror, cache, and serve. Only file names present
* in the active case list are served, so the route can never act as an open
* proxy. Undefined when the name is unknown or the fetch failed.
*/
async function readTemplateImage(sourceId, file) {
	const def = sourceDefOf(sourceId);
	if (def === void 0) return void 0;
	if (!isAllowedImageRef(def, file)) return void 0;
	if (!(await listTemplates(sourceId)).cases.some((entry) => entry.image === file)) return void 0;
	const cacheDir = path.join(imageCacheRoot(), sourceId);
	const cacheFile = cacheFileOf(file);
	try {
		const data = await promises.readFile(path.join(cacheDir, cacheFile));
		const mime = mimeOfFile(cacheFile) ?? sniffImageMime(data);
		if (mime !== void 0) return {
			data,
			mime
		};
	} catch {}
	if (def.legacyImageDir !== void 0 && IMAGE_FILE_PATTERN.test(file)) try {
		const data = await promises.readFile(path.join(legacyImageDir(), file));
		const mime = mimeOfFile(file) ?? sniffImageMime(data);
		if (mime !== void 0) return {
			data,
			mime
		};
	} catch {}
	const cacheKey = `${sourceId}/${file}`;
	const inflight = inflightImages.get(cacheKey);
	if (inflight !== void 0) return inflight;
	const pending = fetchTemplateImage(def, file, cacheFile, cacheDir);
	inflightImages.set(cacheKey, pending);
	try {
		return await pending;
	} finally {
		inflightImages.delete(cacheKey);
	}
}
/** Drop the in-memory list memos (tests). */
function clearTemplateMemo() {
	memos.clear();
}
//#endregion
//#region src/template-favorites.ts
/**
* Favorites store for the prompt-template library.
*
* The user's starred templates persist host-side as full case snapshots under
* ~/.dsh/dsh-imagegen-studio/templates/favorites.json, keyed by
* `${sourceId}:${caseId}` — the snapshot means a favorite stays usable even
* after the upstream list drops or renumbers the case. Framework-free
* (node:fs only) so the route layer and tests can drive it directly.
*/
/**
* Resolved lazily on every use: the host calls `setImageDataRoot()` while
* resolving the plugin, after this module is evaluated, so a module-level
* constant would keep pointing at the default `~/.dsh/dsh-imagegen-studio` even when
* the profile stores its data elsewhere.
*/
function favoritesPath() {
	return path.join(imageDataRoot(), "templates", "favorites.json");
}
/** Refuse to grow the file without bound; the user curates this list. */
const MAX_FAVORITES = 1e3;
/** In-memory memo of the persisted list, together with the file it was read
*  from. The data root can be repointed after this module loads (a
*  `localStoragePath` change), and a memo that outlived its root would serve
*  the OLD root's favorites while writing them back to the NEW one. Keying the
*  memo on the path makes a repointed root miss the memo and re-read. */
let memo;
/** Build the stable key of one case within a source. */
function templateFavoriteKey(sourceId, caseId) {
	return `${sourceId}:${caseId}`;
}
/** Validate + normalize one raw stored favorite; undefined when unusable. */
function normalizeFavorite(raw) {
	if (raw === null || typeof raw !== "object") return void 0;
	const record = raw;
	if (typeof record.key !== "string" || typeof record.savedAt !== "string") return void 0;
	const sourceId = typeof record.sourceId === "string" ? record.sourceId : "";
	if (!isTemplateSourceId(sourceId)) return void 0;
	const rawId = record.case && record.case.id;
	const id = typeof rawId === "number" && Number.isFinite(rawId) ? String(rawId) : typeof rawId === "string" ? rawId.trim() : "";
	if (record.key !== templateFavoriteKey(sourceId, id)) return void 0;
	const rawCase = record.case;
	if (rawCase === null || typeof rawCase !== "object") return void 0;
	const item = rawCase;
	const title = typeof item.title === "string" ? item.title : "";
	const prompt = typeof item.prompt === "string" ? item.prompt : "";
	if (id === "" || title === "" || prompt === "") return void 0;
	const snapshot = {
		id,
		title,
		prompt,
		category: typeof item.category === "string" ? item.category : "",
		categoryZh: typeof item.categoryZh === "string" ? item.categoryZh : "",
		styles: Array.isArray(item.styles) ? item.styles.map(String) : [],
		scenes: Array.isArray(item.scenes) ? item.scenes.map(String) : [],
		sourceLabel: typeof item.sourceLabel === "string" ? item.sourceLabel : "",
		sourceUrl: typeof item.sourceUrl === "string" ? item.sourceUrl : "",
		githubUrl: typeof item.githubUrl === "string" ? item.githubUrl : "",
		image: typeof item.image === "string" ? item.image : "",
		featured: item.featured === true
	};
	return {
		key: record.key,
		sourceId,
		savedAt: record.savedAt,
		case: snapshot
	};
}
/** Read + parse the favorites file (memoized per data root). */
async function listTemplateFavorites() {
	const file = favoritesPath();
	if (memo !== void 0 && memo.path === file) return memo.entries;
	let entries;
	try {
		const parsed = JSON.parse(await promises.readFile(file, "utf8"));
		entries = Array.isArray(parsed) ? parsed.map(normalizeFavorite).filter((entry) => entry !== void 0) : [];
	} catch {
		entries = [];
	}
	memo = {
		path: file,
		entries
	};
	return entries;
}
/** Persist the list atomically and update the memo. */
async function writeFavorites(entries) {
	const file = favoritesPath();
	memo = {
		path: file,
		entries
	};
	await promises.mkdir(path.dirname(file), { recursive: true });
	const tmp = `${file}.tmp-${process.pid}`;
	await promises.writeFile(tmp, JSON.stringify(entries, null, 2), "utf8");
	await promises.rename(tmp, file);
}
/** Star one template. Re-starring refreshes the snapshot and is idempotent. */
async function addTemplateFavorite(sourceId, item) {
	if (!isTemplateSourceId(sourceId)) throw new Error(`未知的模板库来源：${sourceId}`);
	const key = templateFavoriteKey(sourceId, item.id);
	const rest = (await listTemplateFavorites()).filter((entry) => entry.key !== key);
	const next = [{
		key,
		sourceId,
		savedAt: (/* @__PURE__ */ new Date()).toISOString(),
		case: item
	}, ...rest].slice(0, MAX_FAVORITES);
	await writeFavorites(next);
	return next;
}
/** Unstar one template by key; unknown keys are a no-op. */
async function removeTemplateFavorite(key) {
	const next = (await listTemplateFavorites()).filter((entry) => entry.key !== key);
	if (next.length === memo?.entries.length) return next;
	await writeFavorites(next);
	return next;
}
/** Drop the in-memory memo (tests). */
function clearTemplateFavoritesMemo() {
	memo = void 0;
}
//#endregion
//#region src/updater.ts
/** GitHub Release discovery and explicit, user-triggered plugin updates. */
/** Keep this in sync with package.json for each published release. */
const CURRENT_VERSION = PLUGIN_VERSION;
/** The one bundle this updater is allowed to report as installed. */
const PACKAGE_NAME = "dsh-imagegen-studio";
/** The answer `checkForUpdate` gives while self-update is switched off. */
function localNoUpdate() {
	return {
		currentVersion: CURRENT_VERSION,
		latestVersion: CURRENT_VERSION,
		updateAvailable: false,
		releaseUrl: "https://github.com/wcq5012531-crypto/dsh-imagegen-erkai",
		releaseNotes: "dsh-imagegen-studio 是本地维护分支：在本地 checkout 中修改、重建后生效，不跟随上游发布通道自动更新。"
	};
}
/**
* Only the download host GitHub serves release assets from may be installed
* from. The URL comes from a release the host already fetched, but a redirect
* to an arbitrary host would still turn "install the update" into "run
* whatever the network returns", so the host is checked before spawning.
*/
function isInstallableTarballUrl(url) {
	let parsed;
	try {
		parsed = new URL(url);
	} catch {
		return false;
	}
	return parsed.protocol === "https:" && (parsed.hostname === "github.com" || parsed.hostname.endsWith(".githubusercontent.com"));
}
/** Compare stable semver triples; returns positive when `left` is newer. */
function compareVersions(left, right) {
	const parse = (value) => {
		const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(value.trim());
		if (match === null) return [
			0,
			0,
			0
		];
		return [
			Number(match[1]),
			Number(match[2]),
			Number(match[3])
		];
	};
	const a = parse(left);
	const b = parse(right);
	return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}
/** Read the latest stable GitHub Release, with a short host-side cache. */
async function checkForUpdate(fetchFn = fetch, now = Date.now()) {
	return localNoUpdate();
}
/**
* Profile name DSH Desktop runs under. The CLI refuses it outright
* (`bin.js`: `profile "desktop" is managed exclusively by the Electron
* application`), so anything that would spawn `dsh plugin --profile desktop`
* has to take the manual route instead of pretending to update.
*/
const DESKTOP_PROFILE = "desktop";
/**
* Resolve the profile that launched the current DSH process.
*
* The Electron host passes the profile as a bare *path* among its argv entries
* (`…/dsh /Users/<user>/.dsh/profiles/desktop …`) and sets no `DSH_PROFILE` and
* no `--profile` flag, so the flag-only reading below fell through to `'web'`
* for every Desktop user. The update then ran against the wrong profile: even
* when it succeeded, the running host kept the old plugin.
*/
function profileFromProcess(argv = process.argv, env = process.env, host = {}) {
	const hostProfile = host.profile?.trim();
	if (hostProfile !== void 0 && /^[a-zA-Z0-9_-]+$/.test(hostProfile)) return hostProfile;
	const envProfile = env.DSH_PROFILE?.trim();
	if (envProfile !== void 0 && /^[a-zA-Z0-9_-]+$/.test(envProfile)) return envProfile;
	const profileIndex = argv.indexOf("--profile");
	const inline = argv.find((entry) => entry.startsWith("--profile="));
	const explicit = profileIndex >= 0 ? argv[profileIndex + 1]?.trim() : inline?.slice(10).trim();
	if (explicit !== void 0 && /^[a-zA-Z0-9_-]+$/.test(explicit)) return explicit;
	const fromPath = argv.map((entry) => /(?:^|[/\\])profiles[/\\]([A-Za-z0-9_-]+)[/\\]?$/.exec(entry)).find((match) => match !== null);
	if (fromPath !== null && fromPath !== void 0 && fromPath[1] !== void 0) return fromPath[1];
	if (env.DSH_DESKTOP === "1" || argv.some((entry) => /[/\\]dsh-desktop-host[/\\]/.test(entry))) return DESKTOP_PROFILE;
	return "web";
}
/**
* Thrown instead of attempting an update the CLI is guaranteed to reject. It
* carries the archive URL so the UI can hand the user a command that works.
*/
var ManualUpdateRequiredError = class extends Error {
	code = "update-manual-required";
	tarballUrl;
	profile;
	constructor(profile, tarballUrl) {
		super(`profile "${profile}" is managed by the Electron app, so the CLI cannot update it. Open Settings → Plugins in DSH Desktop and install the archive from there.`);
		this.name = "ManualUpdateRequiredError";
		this.profile = profile;
		this.tarballUrl = tarballUrl;
	}
};
/**
* Decide how this profile can be updated.
*
* Host capability comes first: when the launcher exposes `installBundle` it owns
* the package manager and the update runs through it, even on Desktop. Only a
* Desktop profile *without* that hook falls back to `host-managed` — the CLI
* refuses the profile outright, so the user has to install the archive by hand.
* Everything else keeps the historical `dsh plugin add` path.
*/
function updateInstallTarget(argv = process.argv, env = process.env, host = {}) {
	const profile = profileFromProcess(argv, env, host);
	if (typeof host.installBundle === "function") return {
		profile,
		installMode: "host"
	};
	return {
		profile,
		installMode: profile.toLowerCase() === "desktop" || env.DSH_DESKTOP === "1" ? "host-managed" : "cli"
	};
}
/**
* Run the same official command documented for plugin installation, but point
* it at this plugin's release archive.
*
* There is deliberately no `PACKAGE_NAME@version` spec here: this plugin ships as
* a GitHub Release asset and is not on npm, so a registry spec would resolve to
* nothing. The route has just fetched the latest release, so resolving the URL
* through `checkForUpdate` is a cache hit, not a second request.
*
* `host` is the launcher's install hook when it has one; without it the update
* either spawns the CLI or refuses a Desktop profile with
* `ManualUpdateRequiredError`.
*/
async function installUpdate(version, spawnFn = spawn, argv = process.argv, env = process.env, fetchFn = fetch, host = {}) {
	throw new Error("dsh-imagegen-studio 关闭了自更新：请在本机 checkout 中修改并重新构建（见 docs/studio-maintenance.md）");
}
/** Test helper: clear the host-side Release cache. */
function clearUpdateCache() {}
//#endregion
//#region src/presets.ts
/**
* Built-in provider catalog (presets). A preset is an official or well-known
* OpenAI-compatible endpoint with its known model list, so the user only fills
* in the API key. The list ships with the package and is served to the
* settings card through a host route, so it can later be refreshed online like
* the template library.
*
* Framework-free (pure data), safe for the host routes to serve directly.
*/
const IMAGE_PRESETS = [
	{
		id: "volc-ark-seedream",
		name: "字节 · 火山方舟（Seedream / Seedance）",
		apiUrl: "https://ark.cn-beijing.volces.com/api/v3",
		hint: "字节跳动官方接口：Seedream 文生图/图生图 与 Seedance 文生视频/首尾帧；模型 ID 请用方舟控制台的 doubao-seedream-* / doubao-seedance-*（协议族按该 ID 判断）",
		models: [
			{
				alias: "doubao-seedream-5-0-pro-260628",
				id: "doubao-seedream-5-0-pro-260628"
			},
			{
				alias: "doubao-seedream-5-0-260128",
				id: "doubao-seedream-5-0-260128"
			},
			{
				alias: "doubao-seedream-4-5-251128",
				id: "doubao-seedream-4-5-251128"
			},
			{
				alias: "doubao-seedream-4-0-250828",
				id: "doubao-seedream-4-0-250828"
			},
			{
				alias: "seedream-5.0-pro",
				id: "seedream-5.0-pro"
			},
			{
				alias: "seedream-4.0",
				id: "seedream-4.0"
			}
		],
		videoModels: [
			{
				alias: "doubao-seedance-2-0-260128",
				id: "doubao-seedance-2-0-260128"
			},
			{
				alias: "doubao-seedance-2-0-fast-260128",
				id: "doubao-seedance-2-0-fast-260128"
			},
			{
				alias: "doubao-seedance-1-0-pro-250528",
				id: "doubao-seedance-1-0-pro-250528"
			}
		]
	},
	{
		id: "openai-official",
		name: "OpenAI 官方",
		apiUrl: "https://api.openai.com/v1",
		hint: "OpenAI 官方图像生成接口（gpt-image-2.5 支持手绘草图生图）",
		models: [{
			alias: "gpt-image-2.5",
			id: "gpt-image-2.5"
		}, {
			alias: "gpt-image-2",
			id: "gpt-image-2"
		}]
	},
	{
		id: "zhipu-official",
		name: "智谱 AI 官方",
		apiUrl: "https://open.bigmodel.cn/api/paas/v4",
		hint: "智谱官方 GLM-Image 图像生成接口",
		models: [{
			alias: "glm-image",
			id: "glm-image"
		}]
	},
	{
		id: "aliyun-dashscope-qwen",
		name: "阿里云百炼（Qwen-Image）",
		apiUrl: "https://dashscope.aliyuncs.com/api/v1",
		hint: "阿里云百炼 DashScope 原生接口：通义千问 Qwen-Image 系列（该渠道不可复用于提示词增强）",
		models: [
			{
				alias: "qwen-image-3.0-pro",
				id: "qwen-image-3.0-pro"
			},
			{
				alias: "qwen-image-3.0",
				id: "qwen-image-3.0"
			},
			{
				alias: "qwen-image-2.0-pro",
				id: "qwen-image-2.0-pro"
			},
			{
				alias: "qwen-image-2.0",
				id: "qwen-image-2.0"
			},
			{
				alias: "qwen-image-max",
				id: "qwen-image-max"
			},
			{
				alias: "qwen-image-plus",
				id: "qwen-image-plus"
			},
			{
				alias: "qwen-image",
				id: "qwen-image"
			}
		]
	},
	{
		id: "minimax-official",
		name: "MiniMax 官方（国际站）",
		apiUrl: "https://api.minimax.io/v1",
		hint: "MiniMax 原生 /image_generation 接口：image-01（国内站请把地址改为 https://api.minimaxi.com/v1；/models 不列出图片模型，请直接使用预填目录）",
		models: [{
			alias: "image-01",
			id: "image-01"
		}]
	},
	{
		id: "xai-grok",
		name: "xAI（Grok）",
		apiUrl: "https://api.x.ai/v1",
		hint: "xAI 官方接口：Grok Imagine 系列",
		models: [{
			alias: "grok-imagine-image",
			id: "grok-imagine-image"
		}],
		videoModels: [{
			alias: "grok-imagine-video-1.5",
			id: "grok-imagine-video-1.5"
		}, {
			alias: "grok-imagine-video-1.5-lite",
			id: "grok-imagine-video-1.5-lite"
		}]
	},
	{
		id: "chatgpt-subscription",
		name: "ChatGPT 订阅（实验）",
		apiUrl: "",
		hint: "浏览器授权登录后使用 gpt-image-2.5-flare；非官方 Codex 图像接口",
		models: [{
			alias: DEFAULT_SUBSCRIPTION_MODELS["chatgpt-sub"],
			id: DEFAULT_SUBSCRIPTION_MODELS["chatgpt-sub"]
		}],
		subscription: "chatgpt-sub",
		experimental: true
	},
	{
		id: "grok-subscription",
		name: "Grok 订阅",
		apiUrl: "",
		hint: "SuperGrok / X Premium 登录后使用 grok-imagine-image-2.0",
		models: [{
			alias: DEFAULT_SUBSCRIPTION_MODELS["grok-sub"],
			id: DEFAULT_SUBSCRIPTION_MODELS["grok-sub"]
		}],
		subscription: "grok-sub"
	},
	{
		id: "google-subscription",
		name: "Google 订阅（实验）",
		apiUrl: "",
		hint: "Google 授权登录后使用 gemini-3-pro-image；非官方 Antigravity 接口",
		models: [{
			alias: DEFAULT_SUBSCRIPTION_MODELS["google-sub"],
			id: DEFAULT_SUBSCRIPTION_MODELS["google-sub"]
		}],
		subscription: "google-sub",
		experimental: true
	},
	{
		id: "openrouter-subscription",
		name: "OpenRouter 账号",
		apiUrl: "",
		hint: "OpenRouter 官方 OAuth 登录，使用 google/gemini-3-pro-image",
		models: [{
			alias: DEFAULT_SUBSCRIPTION_MODELS["openrouter-sub"],
			id: DEFAULT_SUBSCRIPTION_MODELS["openrouter-sub"]
		}],
		subscription: "openrouter-sub"
	}
];
/** Look up one built-in provider by id. */
function presetById(id) {
	return IMAGE_PRESETS.find((preset) => preset.id === id);
}
//#endregion
//#region src/routes.ts
/** Cap on JSON request bodies (settings ops and generate payloads are small). */
const MAX_JSON_BODY_BYTES = 24 * 1024 * 1024;
/** Cap on history append bodies (base64 result images can be much larger). */
const MAX_HISTORY_BODY_BYTES = 64 * 1024 * 1024;
/** Image types the asset route always serves inline (they cannot execute). */
const CANVAS_INLINE_IMAGE_MIME = /^image\/(png|jpeg|webp|gif|bmp)$/;
/**
* The only non-image types `?inline=1` will serve with their real content type:
* the browser's own renderers for documents and media. Anything not listed here
* (HTML, SVG, XML, unknown binaries) keeps coming back as an attachment.
*/
const CANVAS_INLINE_MIME = /^(application\/pdf|audio\/[a-z0-9.+-]+|video\/[a-z0-9.+-]+)$/;
function parseByteRange(header, size) {
	const value = Array.isArray(header) ? header[0] : header;
	if (typeof value !== "string") return { kind: "none" };
	const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
	if (match === null) return { kind: "none" };
	const [, rawStart = "", rawEnd = ""] = match;
	if (rawStart === "" && rawEnd === "") return { kind: "none" };
	if (size <= 0) return { kind: "unsatisfiable" };
	let start;
	let end;
	if (rawStart === "") {
		const length = Number(rawEnd);
		if (!Number.isSafeInteger(length) || length <= 0) return { kind: "unsatisfiable" };
		start = Math.max(0, size - length);
		end = size - 1;
	} else {
		start = Number(rawStart);
		end = rawEnd === "" ? size - 1 : Number(rawEnd);
		if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return { kind: "unsatisfiable" };
		if (start >= size) return { kind: "unsatisfiable" };
		end = Math.min(end, size - 1);
	}
	if (end < start) return { kind: "unsatisfiable" };
	return {
		kind: "range",
		start,
		end
	};
}
/** Answer 416 for a range that cannot be satisfied, naming the real size. */
function writeUnsatisfiable(res, size) {
	res.writeHead(416, { "content-range": `bytes */${size}` });
	res.end();
}
/**
* Pipe a clip's read stream into the response, absorbing a read error.
*
* WHY the listener is not optional: `readVideoFile` / `readGalleryVideo` return
* the path after `await fs.stat`, and the stream is opened later, so a clip
* deleted in that window (removing a history entry, or the 30-entry cap evicting
* the oldest while the browser still has the clip preloading) makes the stream
* emit `error` with ENOENT. `pipe()` forwards errors to the *destination*, never
* the source, and the host installs no `uncaughtException` handler, so an
* unhandled `error` event takes the whole dsh web process down. Destroying the
* response ends that one request instead.
*/
function pipeClip(stream, res) {
	stream.on("error", () => {
		res.destroy();
	});
	stream.pipe(res);
}
/** Loopback literal check plus browser same-origin markers (mirrors dsh-ssh). */
function isLoopbackRequest$1(request) {
	const address = request.socket.remoteAddress;
	if (address !== "127.0.0.1" && address !== "::1" && address !== "::ffff:127.0.0.1") return false;
	const host = request.headers.host;
	if (typeof host !== "string") return false;
	let hostUrl;
	try {
		hostUrl = new URL(`http://${host}`);
	} catch {
		return false;
	}
	if (hostUrl.hostname !== "127.0.0.1" && hostUrl.hostname !== "localhost" && hostUrl.hostname !== "[::1]") return false;
	if (request.headers["sec-fetch-site"] === "cross-site") return false;
	const origin = request.headers.origin;
	if (origin === void 0) return true;
	try {
		return new URL(origin).host === hostUrl.host;
	} catch {
		return false;
	}
}
/** One JSON response. */
function writeJson$1(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"referrer-policy": "no-referrer"
	});
	res.end(payload);
}
/** Read a JSON request body (undefined when too large or unparseable). */
async function readJsonBody$1(req, maxBytes = MAX_JSON_BODY_BYTES) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		const buffer = chunk;
		size += buffer.length;
		if (size > maxBytes) return void 0;
		chunks.push(buffer);
	}
	try {
		const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		return typeof parsed === "object" && parsed !== null ? parsed : void 0;
	} catch {
		return;
	}
}
/** Read a raw request body (the canvas file upload path; no base64 inflation). */
async function readRawBody(req, maxBytes) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		const buffer = chunk;
		size += buffer.length;
		if (size > maxBytes) return void 0;
		chunks.push(buffer);
	}
	return Buffer.concat(chunks);
}
/** Human-readable text from an unknown thrown value. */
function messageOf$3(error) {
	return error instanceof Error ? error.message : String(error);
}
/** Validate the { source } body of a template-library request. */
function templateSourceOf(body) {
	const raw = body?.source;
	if (raw === void 0 || raw === "") return DEFAULT_TEMPLATE_SOURCE_ID;
	return typeof raw === "string" && isTemplateSourceId(raw) ? raw : void 0;
}
/** Validate the body of a canvas skill run (projected from the browser). */
function parseSkillRunRequest(body) {
	const canvasId = typeof body?.canvasId === "string" ? body.canvasId.trim() : "";
	const skillId = typeof body?.skillId === "string" ? body.skillId.trim() : "";
	if (canvasId === "" || skillId === "") return void 0;
	const nodeIds = Array.isArray(body?.nodeIds) ? [...new Set(body.nodeIds.filter((item) => typeof item === "string").map((item) => item.trim()).filter((item) => item !== ""))] : [];
	const instruction = typeof body?.instruction === "string" ? body.instruction : void 0;
	const params = {};
	if (body?.params !== null && typeof body?.params === "object" && !Array.isArray(body.params)) {
		for (const [key, value] of Object.entries(body.params)) if (typeof value === "string") params[key] = value;
	}
	return {
		canvasId,
		skillId,
		nodeIds,
		...instruction === void 0 ? {} : { instruction },
		...Object.keys(params).length === 0 ? {} : { params },
		placement: body?.placement === "below" ? "below" : "right",
		...parseSkillLanguage(body)
	};
}
/** The UI language hint every skill route accepts (copy stays translated). */
function parseSkillLanguage(body) {
	const raw = typeof body?.language === "string" ? body.language.trim().toLowerCase() : "";
	return raw === "zh" || raw === "en" || raw === "ru" ? { language: raw } : {};
}
/**
* Normalize one skill-library install request: sources are trimmed, de-duped
* URLs, and the uploaded archive is taken from an asset reference the canvas
* upload route already stored (the host never sees raw browser bytes twice).
*/
function parseSkillInstallRequest(body) {
	const raw = Array.isArray(body?.sources) ? body.sources : [];
	const sources = [...new Set(raw.filter((item) => typeof item === "string").map((item) => item.trim()).filter((item) => item !== ""))].slice(0, 10);
	const asset = body?.asset !== null && typeof body?.asset === "object" && !Array.isArray(body.asset) ? body.asset : void 0;
	if (sources.length === 0 && asset === void 0) return void 0;
	const name = typeof body?.name === "string" ? body.name.trim() : "";
	return {
		...sources.length === 0 ? {} : { sources },
		...asset === void 0 ? {} : { asset },
		...name === "" ? {} : { name },
		force: body?.force === true,
		...parseSkillLanguage(body)
	};
}
function parseGenerateRequest(body) {
	const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
	if (prompt === "") return void 0;
	const comparisonModels = Array.isArray(body.comparisonModels) ? [...new Set(body.comparisonModels.filter((model) => typeof model === "string").map((model) => model.trim()).filter(Boolean))] : [];
	const canvas = parseCanvasMeta(body.canvas);
	return {
		mode: body.mode === "edit" ? "edit" : "text",
		model: typeof body.model === "string" ? body.model : "",
		prompt,
		size: typeof body.size === "string" ? body.size : "auto",
		quality: typeof body.quality === "string" ? body.quality : "auto",
		n: typeof body.n === "number" ? body.n : 1,
		detail: typeof body.detail === "string" ? body.detail : "",
		...typeof body.image === "string" && body.image !== "" ? { image: body.image } : {},
		...Array.isArray(body.images) ? { images: body.images.filter((item) => typeof item === "string" && item !== "").slice(0, 4) } : {},
		...typeof body.refName === "string" && body.refName !== "" ? { refName: body.refName } : {},
		...typeof body.channelId === "string" && body.channelId !== "" ? { channelId: body.channelId } : {},
		...typeof body.comparisonId === "string" && body.comparisonId !== "" ? { comparisonId: body.comparisonId } : {},
		...comparisonModels.length > 1 ? { comparisonModels } : {},
		...canvas === void 0 ? {} : { canvas },
		...body.workflow === "ecommerce" ? { workflow: "ecommerce" } : {},
		...typeof body.projectId === "string" && body.projectId !== "" ? { projectId: body.projectId } : {},
		...typeof body.projectName === "string" && body.projectName !== "" ? { projectName: body.projectName } : {},
		...typeof body.slotKey === "string" && body.slotKey !== "" ? { slotKey: body.slotKey } : {},
		...typeof body.slotLabel === "string" && body.slotLabel !== "" ? { slotLabel: body.slotLabel } : {},
		...body.renderer === "code" ? { renderer: "code" } : {},
		...typeof body.renderSource === "string" && body.renderSource.trim() !== "" ? { renderSource: body.renderSource } : {}
	};
}
function parseCanvasMeta(value) {
	if (value === null || typeof value !== "object") return void 0;
	const raw = value;
	if (typeof raw.canvasId !== "string" || raw.canvasId.trim() === "") return void 0;
	return {
		canvasId: raw.canvasId.trim(),
		...typeof raw.sourceNodeId === "string" && raw.sourceNodeId.trim() !== "" ? { sourceNodeId: raw.sourceNodeId.trim() } : {},
		...typeof raw.annotationNodeId === "string" && raw.annotationNodeId.trim() !== "" ? { annotationNodeId: raw.annotationNodeId.trim() } : {},
		...typeof raw.parentNodeId === "string" && raw.parentNodeId.trim() !== "" ? { parentNodeId: raw.parentNodeId.trim() } : {},
		...raw.placement === "right" || raw.placement === "below" ? { placement: raw.placement } : {}
	};
}
/** Stable wire code for a thrown video error. */
function videoCodeOf(error) {
	if (error !== null && typeof error === "object" && "code" in error) {
		const code = error.code;
		if (typeof code === "string" && code !== "") return code;
	}
	return "video-failed";
}
/**
* Validate a submitted video request.
*
* The model alias is resolved against the configured video catalogs here, at
* the wire boundary, so the engine only ever sees a model it can classify.
* The channel id is filled in for the history snapshot the same way the image
* path does it.
*/
function parseVideoRequest(body, view, deps) {
	const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
	if (prompt === "") return void 0;
	const mode = body.mode === "image" || body.mode === "keyframe" || body.mode === "reference" ? body.mode : "text";
	const model = typeof body.model === "string" ? body.model.trim() : "";
	const seconds = typeof body.seconds === "number" ? body.seconds : Number(body.seconds ?? 5);
	const resolution = typeof body.resolution === "string" && body.resolution.trim() !== "" ? body.resolution.trim() : "720P";
	const images = Array.isArray(body.images) ? body.images.filter((item) => typeof item === "string" && item !== "").slice(0, 4) : [];
	const channel = deps.resolveChannels === void 0 ? void 0 : view.channels.find((candidate) => (candidate.videoModels ?? []).some((row) => row.alias === model));
	const canvas = parseCanvasVideoMeta(body.canvas);
	return {
		mode,
		model,
		prompt,
		aspectRatio: typeof body.aspectRatio === "string" && body.aspectRatio.trim() !== "" ? body.aspectRatio.trim() : "16:9",
		resolution: resolution === "480P" || resolution === "720P" || resolution === "1080P" ? resolution : "720P",
		seconds: Number.isFinite(seconds) ? seconds : 5,
		...canvas === void 0 ? {} : { canvas },
		...typeof body.image === "string" && body.image !== "" ? { image: body.image } : {},
		...images.length > 0 ? { images } : {},
		...typeof body.firstFrame === "string" && body.firstFrame !== "" ? { firstFrame: body.firstFrame } : {},
		...typeof body.lastFrame === "string" && body.lastFrame !== "" ? { lastFrame: body.lastFrame } : {},
		...typeof body.refName === "string" && body.refName !== "" ? { refName: body.refName } : {},
		...typeof body.channelId === "string" && body.channelId !== "" ? { channelId: body.channelId } : {},
		...channel === void 0 ? {} : { channel: channel.name },
		...typeof body.seed === "number" && Number.isFinite(body.seed) ? { seed: body.seed } : {},
		...body.plan === true ? { plan: true } : {},
		...parsePlanPreview(body.planPreview) === void 0 ? {} : { planPreview: parsePlanPreview(body.planPreview) },
		...body.renderer === "code" ? { renderer: "code" } : {},
		...typeof body.renderSource === "string" && body.renderSource.trim() !== "" ? { renderSource: body.renderSource } : {}
	};
}
/**
* Validate a client-supplied plan the user previewed.
*
* Structural check only: the semantic clamps (duration ceiling, family aspect
* and resolution) run in the director when the plan is adopted, because that
* is where the resolved model is known.
*/
function parsePlanPreview(value) {
	if (value === null || typeof value !== "object") return void 0;
	const raw = value;
	if (typeof raw.prompt !== "string" || raw.prompt.trim() === "") return void 0;
	const params = raw.params !== null && typeof raw.params === "object" ? raw.params : {};
	const style = raw.style !== null && typeof raw.style === "object" ? raw.style : {};
	const shots = Array.isArray(raw.shots) ? raw.shots.flatMap((item, index) => {
		if (item === null || typeof item !== "object") return [];
		const shot = item;
		const text = (key) => typeof shot[key] === "string" ? shot[key] : "";
		return [{
			index,
			shot: text("shot"),
			action: text("action"),
			camera: text("camera"),
			seconds: typeof shot.seconds === "number" && Number.isFinite(shot.seconds) ? shot.seconds : 0
		}];
	}).slice(0, 8) : [];
	return {
		source: raw.source === "chat" ? "chat" : "heuristic",
		style: {
			shotLanguage: typeof style.shotLanguage === "string" ? style.shotLanguage : "",
			look: typeof style.look === "string" ? style.look : "",
			pacing: typeof style.pacing === "number" && Number.isFinite(style.pacing) ? style.pacing : .5
		},
		shots,
		prompt: raw.prompt,
		params: {
			seconds: typeof params.seconds === "number" && Number.isFinite(params.seconds) ? params.seconds : 5,
			aspectRatio: typeof params.aspectRatio === "string" ? params.aspectRatio : "16:9",
			resolution: typeof params.resolution === "string" ? params.resolution : "720P"
		},
		notes: Array.isArray(raw.notes) ? raw.notes.filter((note) => typeof note === "string") : [],
		degraded: raw.degraded === true,
		...typeof raw.degradedReason === "string" ? { degradedReason: raw.degradedReason } : {}
	};
}
/** Validate the canvas lineage a video request may carry. */
function parseCanvasVideoMeta(value) {
	if (value === null || typeof value !== "object") return void 0;
	const raw = value;
	if (typeof raw.canvasId !== "string" || raw.canvasId.trim() === "") return void 0;
	const references = Array.isArray(raw.referenceNodeIds) ? raw.referenceNodeIds.filter((item) => typeof item === "string" && item !== "").slice(0, 4) : [];
	return {
		canvasId: raw.canvasId.trim(),
		...typeof raw.sourceNodeId === "string" && raw.sourceNodeId.trim() !== "" ? { sourceNodeId: raw.sourceNodeId.trim() } : {},
		...typeof raw.nodeId === "string" && raw.nodeId.trim() !== "" ? { nodeId: raw.nodeId.trim() } : {},
		...references.length === 0 ? {} : { referenceNodeIds: references }
	};
}
/** Validate a submitted history entry (images carry base64). */
function parseHistoryEntryInput(body) {
	const raw = body.entry;
	if (raw === null || typeof raw !== "object") return void 0;
	const entry = raw;
	if (typeof entry.id !== "string" || typeof entry.createdAt !== "number") return void 0;
	if (entry.mode !== "text" && entry.mode !== "edit") return void 0;
	if (typeof entry.model !== "string" || typeof entry.prompt !== "string") return void 0;
	if (typeof entry.size !== "string" || typeof entry.quality !== "string" || typeof entry.detail !== "string") return void 0;
	if (typeof entry.n !== "number") return void 0;
	if (!Array.isArray(entry.images)) return void 0;
	const images = [];
	for (const item of entry.images) {
		if (item === null || typeof item !== "object") return void 0;
		const image = item;
		if (typeof image.b64 !== "string" || typeof image.mime !== "string") return void 0;
		images.push({
			b64: image.b64,
			mime: image.mime,
			...typeof image.revisedPrompt === "string" ? { revisedPrompt: image.revisedPrompt } : {}
		});
	}
	const comparisonModels = Array.isArray(entry.comparisonModels) ? [...new Set(entry.comparisonModels.filter((model) => typeof model === "string").map((model) => model.trim()).filter(Boolean))] : [];
	const canvas = parseCanvasMeta(entry.canvas);
	return {
		id: entry.id,
		createdAt: entry.createdAt,
		mode: entry.mode,
		model: entry.model,
		prompt: entry.prompt,
		size: entry.size,
		quality: entry.quality,
		detail: entry.detail,
		n: entry.n,
		images,
		...typeof entry.refName === "string" ? { refName: entry.refName } : {},
		...typeof entry.channelId === "string" ? { channelId: entry.channelId } : {},
		...typeof entry.channel === "string" ? { channel: entry.channel } : {},
		...typeof entry.comparisonId === "string" ? { comparisonId: entry.comparisonId } : {},
		...comparisonModels.length > 1 ? { comparisonModels } : {},
		...canvas === void 0 ? {} : { canvas },
		...entry.workflow === "ecommerce" ? { workflow: "ecommerce" } : {},
		...typeof entry.projectId === "string" ? { projectId: entry.projectId } : {},
		...typeof entry.projectName === "string" ? { projectName: entry.projectName } : {},
		...typeof entry.slotKey === "string" ? { slotKey: entry.slotKey } : {},
		...typeof entry.slotLabel === "string" ? { slotLabel: entry.slotLabel } : {}
	};
}
/** Extract the image file name from a history-image request URL. */
function imageFileFrom(rawUrl, basePath) {
	if (rawUrl === void 0) return void 0;
	let pathname;
	try {
		pathname = new URL(rawUrl, "http://localhost").pathname;
	} catch {
		return;
	}
	if (!pathname.startsWith(`${basePath}/`)) return void 0;
	return decodeURIComponent(pathname.slice(basePath.length + 1));
}
/** Parse the durable image reference carried by an Agent tool-result view. */
function agentImageRefFrom(rawUrl) {
	if (rawUrl === void 0) return void 0;
	let url;
	try {
		url = new URL(rawUrl, "http://localhost");
	} catch {
		return;
	}
	if (url.pathname !== "/api/dsh-imagegen-studio/agent-image") return void 0;
	const attachmentId = url.searchParams.get("attachment_id") ?? "";
	const mediaType = url.searchParams.get("media_type") ?? "";
	const bytes = Number(url.searchParams.get("bytes"));
	const width = Number(url.searchParams.get("width"));
	const height = Number(url.searchParams.get("height"));
	if (attachmentId === "" || !isImageMediaType(mediaType) || !Number.isSafeInteger(bytes) || bytes < 1 || !Number.isSafeInteger(width) || width < 1 || !Number.isSafeInteger(height) || height < 1) return void 0;
	return {
		attachmentId,
		mediaType,
		bytes,
		width,
		height
	};
}
function isImageMediaType(value) {
	return value === "image/png" || value === "image/jpeg" || value === "image/webp" || value === "image/gif";
}
function imageDataUrl$2(value) {
	const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,(.*)$/su.exec(value.trim());
	if (match === null || match[1] === void 0 || match[2] === void 0) return void 0;
	const data = Buffer.from(match[2], "base64");
	return data.byteLength === 0 ? void 0 : {
		mediaType: match[1],
		data
	};
}
/** Project one settings descriptor onto the bridge wire view. */
function toView(descriptor, namespace = String(descriptor.ns)) {
	return {
		ns: namespace,
		schema: descriptor.schema,
		value: descriptor.value,
		...descriptor.base === void 0 ? {} : { base: descriptor.base },
		...descriptor.user === void 0 ? {} : { user: descriptor.user },
		...descriptor.secrets === void 0 ? {} : { secrets: descriptor.secrets.map((secret) => ({
			path: [...secret.path],
			set: secret.set
		})) },
		revision: descriptor.revision
	};
}
/** Map a subscription provider to its manager vendor id. */
function vendorOfSubscription(provider) {
	if (provider === "chatgpt-sub") return "codex";
	if (provider === "google-sub") return "antigravity";
	if (provider === "openrouter-sub") return "openrouter";
	return "grok";
}
/** Map a seam failure onto the bridge refusal envelope. */
function failureOf(error) {
	if (error instanceof SettingsConflictError) return {
		ok: false,
		code: "settings-conflict",
		message: error.message
	};
	return {
		ok: false,
		code: "settings-rejected",
		message: error instanceof Error ? error.message : String(error)
	};
}
/**
* Build every /api/dsh-imagegen-studio route.
* @param deps - settings seam + config resolver.
* @returns the route registrations.
*/
function makeRoutes(deps) {
	const history = deps.history ?? {
		list: listHistory,
		append: appendHistory,
		remove: removeHistory,
		clear: clearHistory,
		readImage: readHistoryImage,
		listArchived: listArchivedHistory,
		archive: setHistoryArchived
	};
	const gallery = deps.gallery ?? {
		list: listGallery,
		listTrash: listGalleryTrash,
		append: appendGallery,
		remove: removeGallery,
		restore: restoreGallery,
		purge: purgeGallery,
		clear: clearGallery,
		updateTags: updateGalleryTags,
		readImage: readGalleryImage,
		appendVideo: appendGalleryVideo,
		readVideo: readGalleryVideo,
		listCategories: listGalleryCategories,
		createCategory: createGalleryCategory,
		renameCategory: renameGalleryCategory,
		deleteCategory: deleteGalleryCategory
	};
	const canvas = deps.canvas ?? canvasStore;
	const templates = deps.templates ?? {
		list: listTemplates,
		refresh: refreshTemplates,
		sample: sampleTemplates,
		readImage: readTemplateImage
	};
	const favorites = deps.favorites ?? {
		list: listTemplateFavorites,
		add: addTemplateFavorite,
		remove: removeTemplateFavorite
	};
	const video = deps.video ?? {
		list: listVideoHistory,
		remove: removeVideoHistory,
		clear: clearVideoHistory,
		readFile: readVideoFile
	};
	const resolvePrompt = deps.resolvePrompt ?? (() => ({
		apiUrl: "",
		apiKey: "",
		model: ""
	}));
	const splitGallery = (entries) => ({
		entries: entries.filter((entry) => entry.deletedAt === void 0),
		trash: entries.filter((entry) => entry.deletedAt !== void 0)
	});
	const serveClip = async (req, res, basePath, read) => {
		if (!isLoopbackRequest$1(req)) {
			writeJson$1(res, 403, { error: "forbidden: loopback-only" });
			return;
		}
		if (req.method !== "GET" && req.method !== "HEAD") {
			writeJson$1(res, 405, { error: `method not allowed: ${req.method}` });
			return;
		}
		const file = imageFileFrom(req.url, basePath);
		const found = file === void 0 ? void 0 : await read(file);
		if (found === void 0) {
			writeJson$1(res, 404, { error: "not found" });
			return;
		}
		const headers = {
			"content-type": found.mime,
			"cache-control": "private, max-age=3600",
			"x-content-type-options": "nosniff",
			"accept-ranges": "bytes"
		};
		const range = parseByteRange(req.headers.range, found.size);
		if (range.kind === "unsatisfiable") {
			writeUnsatisfiable(res, found.size);
			return;
		}
		if (range.kind === "range") {
			res.writeHead(206, {
				...headers,
				"content-range": `bytes ${range.start}-${range.end}/${found.size}`,
				"content-length": range.end - range.start + 1
			});
			if (req.method === "HEAD") {
				res.end();
				return;
			}
			pipeClip(createReadStream(found.path, {
				start: range.start,
				end: range.end
			}), res);
			return;
		}
		res.writeHead(200, {
			...headers,
			"content-length": found.size
		});
		if (req.method === "HEAD") {
			res.end();
			return;
		}
		pipeClip(createReadStream(found.path), res);
	};
	const resolveImageModels = deps.resolveImageModels ?? (() => normalizeImageModels(void 0));
	const settingsNamespace = deps.settingsNamespace ?? "dsh-imagegen-studio";
	/** The current channel view: the channel-aware resolver, or a synthesized
	*  single default channel from the legacy flat upstream config (tests and
	*  older hosts). */
	const channelViewOf = () => {
		if (deps.resolveChannels !== void 0) return deps.resolveChannels();
		const upstream = deps.resolve();
		const models = normalizeImageModels(resolveImageModels()).map((id) => ({
			alias: id,
			id
		}));
		if (upstream.apiUrl.trim() === "" && models.length === 0) return {
			channels: [],
			defaultChannelId: ""
		};
		return {
			channels: [{
				id: "default",
				preset: "",
				name: "默认渠道",
				apiUrl: upstream.apiUrl,
				apiUrlFull: false,
				apiKey: upstream.apiKey,
				models
			}],
			defaultChannelId: "default"
		};
	};
	const runtime = deps.runtime ?? new ImageGenerationRuntime(channelViewOf, history);
	/** Resolve an alias (or the channel fallback) into a concrete generation
	*  request: picks the channel (explicit then default), maps alias → upstream
	*  id, and fills the channel snapshot kept on history entries. */
	const resolveChannelRequest = (request) => {
		const view = channelViewOf();
		if (view.channels.length === 0) return {
			ok: false,
			code: "no-channels",
			message: "尚未配置任何渠道：请先打开「设置 → 生图配置」添加渠道并填写 API 地址与密钥"
		};
		const explicit = view.channels.find((candidate) => candidate.id === request.channelId);
		const defaults = view.channels.find((candidate) => candidate.id === view.defaultChannelId) ?? view.channels[0];
		const target = explicit ?? defaults;
		const asked = request.model.trim();
		if (asked === "") {
			const alias = target?.models[0]?.alias ?? "";
			if (alias === "") return {
				ok: false,
				code: "no-models",
				message: `渠道「${target?.name ?? ""}」尚未配置模型，请先在设置中添加`
			};
			const mapping = target.models.find((model) => model.alias === alias);
			return {
				ok: true,
				request: {
					...request,
					model: alias,
					upstream: mapping.id,
					channelId: target.id,
					channel: target.name
				}
			};
		}
		const hosting = view.channels.filter((channel) => channel.models.some((model) => model.alias === asked));
		if (hosting.length === 0) return {
			ok: false,
			code: "image-model-not-configured",
			message: `模型「${asked}」未在任一渠道配置；可用模型：${[...new Set(view.channels.flatMap((channel) => channel.models.map((model) => model.alias)))].join("、") || "（无）"}`
		};
		const picked = target !== void 0 && target.models.some((model) => model.alias === asked) ? target : hosting[0];
		const mapping = picked.models.find((model) => model.alias === asked);
		return {
			ok: true,
			request: {
				...request,
				model: asked,
				upstream: mapping.id,
				channelId: picked.id,
				channel: picked.name
			}
		};
	};
	const guard = (req, res, method) => {
		if (!isLoopbackRequest$1(req)) {
			writeJson$1(res, 403, { error: "forbidden: loopback-only" });
			return false;
		}
		if (req.method !== method) {
			writeJson$1(res, 405, { error: `method not allowed: ${req.method}` });
			return false;
		}
		return true;
	};
	return [
		...deps.attachments?.saveImage === void 0 || deps.pendingConversationImages === void 0 ? [] : [{
			kind: "exact",
			path: CONVERSATION_IMAGE_API,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody$1(req, MAX_JSON_BODY_BYTES);
				const sessionId = typeof body?.sessionId === "string" ? body.sessionId.trim() : "";
				const dataUrl = typeof body?.dataUrl === "string" ? imageDataUrl$2(body.dataUrl) : void 0;
				if (sessionId === "" || dataUrl === void 0) {
					writeJson$1(res, 200, {
						ok: false,
						code: "bad-request",
						message: "sessionId and image data are required"
					});
					return;
				}
				try {
					const ref = await deps.attachments.saveImage({
						data: dataUrl.data,
						mediaType: dataUrl.mediaType,
						...typeof body?.name === "string" && body.name.trim() !== "" ? { name: body.name.trim() } : {}
					});
					deps.pendingConversationImages.set(sessionId, ref);
					writeJson$1(res, 200, { ok: true });
				} catch (error) {
					writeJson$1(res, 200, {
						ok: false,
						code: "image-save-failed",
						message: messageOf$3(error)
					});
				}
			}
		}],
		...deps.attachments === void 0 ? [] : [{
			kind: "prefix",
			path: AGENT_IMAGE_API,
			handler: async (req, res) => {
				if (!isLoopbackRequest$1(req)) {
					writeJson$1(res, 403, { error: "forbidden: loopback-only" });
					return;
				}
				if (req.method !== "GET") {
					writeJson$1(res, 405, { error: `method not allowed: ${req.method}` });
					return;
				}
				const ref = agentImageRefFrom(req.url);
				if (ref === void 0) {
					writeJson$1(res, 400, { error: "invalid image reference" });
					return;
				}
				try {
					const stored = await deps.attachments.readImage(ref);
					res.writeHead(200, {
						"content-type": stored.ref.mediaType,
						"content-length": stored.data.byteLength,
						"cache-control": "private, max-age=3600"
					});
					res.end(Buffer.from(stored.data));
				} catch {
					writeJson$1(res, 404, { error: "image attachment not found" });
				}
			}
		}],
		{
			kind: "exact",
			path: IMAGE_MODEL_API.models,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody$1(req);
				const view = channelViewOf();
				const stored = view.channels.find((candidate) => candidate.id === (typeof body?.channelId === "string" ? body.channelId : void 0)) ?? view.channels.find((candidate) => candidate.id === view.defaultChannelId) ?? view.channels[0];
				const protocol = isChannelProtocolPreference(body?.protocol) ? body.protocol : stored?.protocol;
				const upstream = {
					apiUrl: typeof body?.apiUrl === "string" && body.apiUrl.trim() !== "" ? body.apiUrl.trim() : stored?.apiUrl ?? "",
					apiKey: typeof body?.apiKey === "string" && body.apiKey.trim() !== "" ? body.apiKey.trim() : stored?.apiKey ?? "",
					apiUrlFull: typeof body?.apiUrlFull === "boolean" ? body.apiUrlFull : stored?.apiUrlFull === true,
					...protocol === void 0 ? {} : { protocol }
				};
				try {
					writeJson$1(res, 200, {
						ok: true,
						models: await listImageModels(upstream)
					});
				} catch (error) {
					writeJson$1(res, 200, {
						ok: false,
						code: "image-models-failed",
						message: messageOf$3(error)
					});
				}
			}
		},
		{
			kind: "exact",
			path: PRESETS_API,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				writeJson$1(res, 200, {
					ok: true,
					presets: IMAGE_PRESETS.map((preset) => ({
						id: preset.id,
						name: preset.name,
						apiUrl: preset.apiUrl,
						hint: preset.hint,
						models: preset.models,
						...preset.videoModels === void 0 ? {} : { videoModels: preset.videoModels },
						...preset.subscription === void 0 ? {} : { subscription: preset.subscription },
						...preset.experimental === void 0 ? {} : { experimental: preset.experimental }
					}))
				});
			}
		},
		{
			kind: "exact",
			path: USAGE_API,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				try {
					const entries = [...await history.list(), ...await gallery.list()];
					const byChannel = {};
					const totals = {};
					for (const entry of entries) {
						const channelKey = entry.channelId !== void 0 ? entry.channelId : entry.channel !== void 0 ? `name:${entry.channel}` : "";
						const alias = entry.model;
						const bucket = byChannel[channelKey] ?? (byChannel[channelKey] = {});
						bucket[alias] = (bucket[alias] ?? 0) + 1;
						totals[alias] = (totals[alias] ?? 0) + 1;
					}
					writeJson$1(res, 200, {
						ok: true,
						usage: {
							byChannel,
							totals
						}
					});
				} catch (error) {
					writeJson$1(res, 200, {
						ok: false,
						code: "usage-failed",
						message: messageOf$3(error)
					});
				}
			}
		},
		{
			kind: "exact",
			path: PROMPT_ENHANCE_API.models,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				try {
					writeJson$1(res, 200, {
						ok: true,
						models: await listPromptModels(resolvePrompt())
					});
				} catch (error) {
					writeJson$1(res, 200, {
						ok: false,
						code: "prompt-models-failed",
						message: messageOf$3(error)
					});
				}
			}
		},
		{
			kind: "exact",
			path: PROMPT_ENHANCE_API.enhance,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody$1(req);
				const prompt = typeof body?.prompt === "string" ? body.prompt.trim() : "";
				if (prompt === "") {
					writeJson$1(res, 200, {
						ok: false,
						code: "bad-request",
						message: "prompt is required"
					});
					return;
				}
				try {
					writeJson$1(res, 200, {
						ok: true,
						prompt: body?.mode === "polish" ? await polishPrompt(resolvePrompt(), prompt) : await enhancePrompt(resolvePrompt(), prompt)
					});
				} catch (error) {
					writeJson$1(res, 200, {
						ok: false,
						code: "prompt-enhance-failed",
						message: messageOf$3(error)
					});
				}
			}
		},
		{
			kind: "exact",
			path: SETTINGS_API.describe,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const descriptor = deps.settings.describe({ redactSecrets: true }).find((candidate) => String(candidate.ns) === settingsNamespace);
				writeJson$1(res, 200, {
					ok: true,
					value: {
						namespaces: descriptor === void 0 ? [] : [toView(descriptor, IMAGEGEN_SETTINGS_NAMESPACE)],
						writable: deps.settings.writable !== false
					}
				});
			}
		},
		{
			kind: "exact",
			path: SETTINGS_API.mutate,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody$1(req);
				if (body === void 0) {
					writeJson$1(res, 200, {
						ok: false,
						code: "settings-rejected",
						message: "unreadable JSON body"
					});
					return;
				}
				if ((typeof body.ns === "string" ? body.ns : "") !== "dsh-imagegen-studio" || !Array.isArray(body.ops)) {
					writeJson$1(res, 200, {
						ok: false,
						code: "settings-rejected",
						message: "malformed bridge settings request"
					});
					return;
				}
				const expectedRevision = typeof body.expectedRevision === "number" ? body.expectedRevision : void 0;
				try {
					await deps.settings.mutate(settingsNamespace, body.ops, expectedRevision);
				} catch (error) {
					writeJson$1(res, 200, failureOf(error));
					return;
				}
				const descriptor = deps.settings.describe({ redactSecrets: true }).find((candidate) => String(candidate.ns) === settingsNamespace);
				if (descriptor === void 0) {
					writeJson$1(res, 200, {
						ok: false,
						code: "internal",
						message: `settings namespace "${settingsNamespace}" was disposed after the mutate`
					});
					return;
				}
				writeJson$1(res, 200, {
					ok: true,
					value: toView(descriptor, IMAGEGEN_SETTINGS_NAMESPACE)
				});
			}
		},
		{
			kind: "exact",
			path: GENERATE_API,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody$1(req);
				const parsed = body === void 0 ? void 0 : parseGenerateRequest(body);
				if (parsed === void 0) {
					writeJson$1(res, 200, {
						ok: false,
						code: "bad-request",
						message: "prompt is required"
					});
					return;
				}
				const resolved = parsed.renderer === "code" ? {
					ok: true,
					request: parsed
				} : resolveChannelRequest(parsed);
				if (!resolved.ok) {
					writeJson$1(res, 200, {
						ok: false,
						code: resolved.code,
						message: resolved.message
					});
					return;
				}
				try {
					writeJson$1(res, 200, {
						ok: true,
						...await runtime.run(resolved.request)
					});
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					writeJson$1(res, 200, {
						ok: false,
						code: error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "generate-failed",
						message
					});
				}
			}
		},
		{
			kind: "exact",
			path: TASK_API.submit,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody$1(req);
				const parsed = body === void 0 ? void 0 : parseGenerateRequest(body);
				if (parsed === void 0) {
					writeJson$1(res, 200, {
						ok: false,
						code: "bad-request",
						message: "prompt is required"
					});
					return;
				}
				const resolved = parsed.renderer === "code" ? {
					ok: true,
					request: parsed
				} : resolveChannelRequest(parsed);
				if (!resolved.ok) {
					writeJson$1(res, 200, {
						ok: false,
						code: resolved.code,
						message: resolved.message
					});
					return;
				}
				writeJson$1(res, 200, {
					ok: true,
					task: runtime.queue.submit(resolved.request)
				});
			}
		},
		{
			kind: "exact",
			path: TASK_API.list,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				writeJson$1(res, 200, {
					ok: true,
					tasks: runtime.queue.summaries()
				});
			}
		},
		{
			kind: "exact",
			path: DIAGNOSTICS_API.list,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				writeJson$1(res, 200, {
					ok: true,
					entries: listDiagnostics()
				});
			}
		},
		{
			kind: "exact",
			path: DIAGNOSTICS_API.clear,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				clearDiagnostics();
				writeJson$1(res, 200, { ok: true });
			}
		},
		{
			kind: "exact",
			path: TASK_API.get,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody$1(req);
				const task = typeof body?.id === "string" ? runtime.queue.get(body.id) : void 0;
				if (task === void 0) {
					writeJson$1(res, 200, {
						ok: false,
						code: "not-found",
						message: "task not found"
					});
					return;
				}
				writeJson$1(res, 200, {
					ok: true,
					task
				});
			}
		},
		{
			kind: "exact",
			path: TASK_API.cancel,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody$1(req);
				const task = typeof body?.id === "string" ? runtime.queue.cancel(body.id) : void 0;
				if (task === void 0) {
					writeJson$1(res, 200, {
						ok: false,
						code: "not-found",
						message: "task not found"
					});
					return;
				}
				writeJson$1(res, 200, {
					ok: true,
					task
				});
			}
		},
		{
			kind: "exact",
			path: TASK_API.retry,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody$1(req);
				const task = typeof body?.id === "string" ? runtime.queue.retry(body.id) : void 0;
				if (task === void 0) {
					writeJson$1(res, 200, {
						ok: false,
						code: "not-found",
						message: "task not found"
					});
					return;
				}
				writeJson$1(res, 200, {
					ok: true,
					task
				});
			}
		},
		{
			kind: "exact",
			path: UPDATE_API.check,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				try {
					writeJson$1(res, 200, {
						ok: true,
						update: {
							...await checkForUpdate(),
							...updateInstallTarget(void 0, void 0, deps.resolveUpdateContext?.())
						}
					});
				} catch (error) {
					writeJson$1(res, 200, {
						ok: false,
						code: "update-check-failed",
						message: messageOf$3(error)
					});
				}
			}
		},
		{
			kind: "exact",
			path: UPDATE_API.apply,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody$1(req);
				const version = body !== void 0 && typeof body.version === "string" ? body.version.trim() : "";
				if (version === "") {
					writeJson$1(res, 200, {
						ok: false,
						code: "bad-request",
						message: "update version is required"
					});
					return;
				}
				try {
					const latest = await checkForUpdate();
					if (!latest.updateAvailable || latest.latestVersion !== version) {
						writeJson$1(res, 200, {
							ok: false,
							code: "update-not-available",
							message: `version ${version} is not the latest available release`
						});
						return;
					}
					await installUpdate(version, void 0, void 0, void 0, void 0, deps.resolveUpdateContext?.());
					writeJson$1(res, 200, {
						ok: true,
						currentVersion: CURRENT_VERSION,
						updatedVersion: version,
						restartRequired: true
					});
				} catch (error) {
					if (error instanceof ManualUpdateRequiredError) {
						writeJson$1(res, 200, {
							ok: false,
							code: error.code,
							message: error.message,
							profile: error.profile,
							tarballUrl: error.tarballUrl,
							updatedVersion: version
						});
						return;
					}
					writeJson$1(res, 200, {
						ok: false,
						code: "update-failed",
						message: messageOf$3(error)
					});
				}
			}
		},
		...deps.subscriptions === void 0 ? [] : [{
			kind: "exact",
			path: SUBSCRIPTION_API.status,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const statuses = {};
				for (const provider of SUBSCRIPTION_PROVIDERS) {
					const vendor = vendorOfSubscription(provider);
					const status = await deps.subscriptions.loginStatus(vendor);
					const error = deps.subscriptions.lastLoginError(vendor);
					statuses[provider] = status.state === "logged-in" ? {
						state: status.state,
						email: status.email
					} : {
						state: status.state,
						...error === void 0 ? {} : { error }
					};
				}
				writeJson$1(res, 200, {
					ok: true,
					statuses
				});
			}
		}, {
			kind: "exact",
			path: SUBSCRIPTION_API.login,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody$1(req);
				const provider = typeof body?.provider === "string" ? body.provider : "";
				if (!SUBSCRIPTION_PROVIDERS.includes(provider)) {
					writeJson$1(res, 200, {
						ok: false,
						code: "invalid-provider",
						message: "unknown subscription provider"
					});
					return;
				}
				const vendor = vendorOfSubscription(provider);
				try {
					if (body?.action === "logout") {
						await deps.subscriptions.logout(vendor);
						writeJson$1(res, 200, { ok: true });
						return;
					}
					if (body?.action === "complete") {
						const input = typeof body.input === "string" ? body.input : "";
						await deps.subscriptions.completeLogin(vendor, input);
						writeJson$1(res, 200, { ok: true });
						return;
					}
					writeJson$1(res, 200, {
						ok: true,
						...await deps.subscriptions.beginLogin(vendor)
					});
				} catch (error) {
					writeJson$1(res, 200, {
						ok: false,
						code: "subscription-login-failed",
						message: messageOf$3(error)
					});
				}
			}
		}],
		{
			kind: "exact",
			path: HISTORY_API.list,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				try {
					writeJson$1(res, 200, {
						ok: true,
						entries: await history.list()
					});
				} catch (error) {
					writeJson$1(res, 200, {
						ok: false,
						code: "history-failed",
						message: messageOf$3(error)
					});
				}
			}
		},
		{
			kind: "exact",
			path: HISTORY_API.append,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody$1(req, MAX_HISTORY_BODY_BYTES);
				if (body === void 0) {
					writeJson$1(res, 200, {
						ok: false,
						code: "bad-request",
						message: "unreadable JSON body"
					});
					return;
				}
				const entry = parseHistoryEntryInput(body);
				if (entry === void 0) {
					writeJson$1(res, 200, {
						ok: false,
						code: "bad-request",
						message: "malformed history entry"
					});
					return;
				}
				try {
					writeJson$1(res, 200, {
						ok: true,
						entries: await history.append(entry)
					});
				} catch (error) {
					writeJson$1(res, 200, {
						ok: false,
						code: "history-failed",
						message: messageOf$3(error)
					});
				}
			}
		},
		{
			kind: "exact",
			path: HISTORY_API.remove,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody$1(req);
				const id = body !== void 0 && typeof body.id === "string" ? body.id : "";
				if (id === "") {
					writeJson$1(res, 200, {
						ok: false,
						code: "bad-request",
						message: "history id is required"
					});
					return;
				}
				try {
					writeJson$1(res, 200, {
						ok: true,
						entries: await history.remove(id)
					});
				} catch (error) {
					writeJson$1(res, 200, {
						ok: false,
						code: "history-failed",
						message: messageOf$3(error)
					});
				}
			}
		},
		{
			kind: "exact",
			path: HISTORY_API.clear,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				try {
					writeJson$1(res, 200, {
						ok: true,
						entries: await history.clear()
					});
				} catch (error) {
					writeJson$1(res, 200, {
						ok: false,
						code: "history-failed",
						message: messageOf$3(error)
					});
				}
			}
		},
		{
			kind: "exact",
			path: HISTORY_API.archive,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody$1(req);
				const id = body !== void 0 && typeof body.id === "string" ? body.id : "";
				if (id === "") {
					writeJson$1(res, 200, {
						ok: false,
						code: "bad-request",
						message: "history id is required"
					});
					return;
				}
				if (history.archive === void 0) {
					writeJson$1(res, 200, {
						ok: false,
						code: "history-archive-unavailable",
						message: "本宿主不支持归档历史记录。"
					});
					return;
				}
				try {
					const archived = body?.archived !== false;
					writeJson$1(res, 200, {
						ok: true,
						...await history.archive(id, archived)
					});
				} catch (error) {
					writeJson$1(res, 200, {
						ok: false,
						code: "history-failed",
						message: messageOf$3(error)
					});
				}
			}
		},
		{
			kind: "exact",
			path: HISTORY_API.archived,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				try {
					writeJson$1(res, 200, {
						ok: true,
						archived: history.listArchived === void 0 ? [] : await history.listArchived()
					});
				} catch (error) {
					writeJson$1(res, 200, {
						ok: false,
						code: "history-failed",
						message: messageOf$3(error)
					});
				}
			}
		},
		{
			kind: "prefix",
			path: HISTORY_API.image,
			handler: async (req, res) => {
				if (!isLoopbackRequest$1(req)) {
					writeJson$1(res, 403, { error: "forbidden: loopback-only" });
					return;
				}
				if (req.method !== "GET") {
					writeJson$1(res, 405, { error: `method not allowed: ${req.method}` });
					return;
				}
				const file = imageFileFrom(req.url, HISTORY_API.image);
				if (file === void 0) {
					writeJson$1(res, 404, { error: "not found" });
					return;
				}
				const found = await history.readImage(file);
				if (found === void 0) {
					writeJson$1(res, 404, { error: "not found" });
					return;
				}
				res.writeHead(200, {
					"content-type": found.mime,
					"content-length": found.data.length,
					"cache-control": "private, max-age=3600"
				});
				res.end(found.data);
			}
		},
		{
			kind: "exact",
			path: GALLERY_API.list,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				try {
					const [entries, trash, snapshot] = await Promise.all([
						gallery.list(),
						gallery.listTrash === void 0 ? Promise.resolve([]) : gallery.listTrash(),
						gallery.listCategories === void 0 ? Promise.resolve({
							categories: [],
							entries: [],
							trash: []
						}) : gallery.listCategories()
					]);
					writeJson$1(res, 200, {
						ok: true,
						entries,
						trash,
						categories: snapshot.categories
					});
				} catch (error) {
					writeJson$1(res, 200, {
						ok: false,
						code: "gallery-failed",
						message: messageOf$3(error)
					});
				}
			}
		},
		{
			kind: "exact",
			path: GALLERY_API.category,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody$1(req);
				const action = body !== void 0 && typeof body.action === "string" ? body.action : "";
				const name = body !== void 0 && typeof body.name === "string" ? body.name : "";
				const to = body !== void 0 && typeof body.to === "string" ? body.to : "";
				if (action !== "create" && action !== "rename" && action !== "delete" && action !== "list") {
					writeJson$1(res, 200, {
						ok: false,
						code: "bad-request",
						message: "unknown gallery category action"
					});
					return;
				}
				try {
					if (action === "list") {
						writeJson$1(res, 200, {
							ok: true,
							...await (gallery.listCategories === void 0 ? Promise.resolve({
								entries: [],
								trash: [],
								categories: []
							}) : gallery.listCategories())
						});
						return;
					}
					if (action === "create") {
						if (gallery.createCategory === void 0) {
							writeJson$1(res, 200, {
								ok: false,
								code: "gallery-category-unavailable",
								message: "本宿主不支持素材库分类。"
							});
							return;
						}
						writeJson$1(res, 200, {
							ok: true,
							...await gallery.createCategory(name)
						});
						return;
					}
					if (action === "rename") {
						if (gallery.renameCategory === void 0) {
							writeJson$1(res, 200, {
								ok: false,
								code: "gallery-category-unavailable",
								message: "本宿主不支持素材库分类。"
							});
							return;
						}
						writeJson$1(res, 200, {
							ok: true,
							...await gallery.renameCategory(name, to)
						});
						return;
					}
					if (gallery.deleteCategory === void 0) {
						writeJson$1(res, 200, {
							ok: false,
							code: "gallery-category-unavailable",
							message: "本宿主不支持素材库分类。"
						});
						return;
					}
					writeJson$1(res, 200, {
						ok: true,
						...await gallery.deleteCategory(name)
					});
				} catch (error) {
					writeJson$1(res, 200, {
						ok: false,
						code: "gallery-failed",
						message: messageOf$3(error)
					});
				}
			}
		},
		{
			kind: "exact",
			path: GALLERY_API.append,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody$1(req, MAX_HISTORY_BODY_BYTES);
				if (body === void 0) {
					writeJson$1(res, 200, {
						ok: false,
						code: "bad-request",
						message: "unreadable JSON body"
					});
					return;
				}
				const entry = parseHistoryEntryInput(body);
				if (entry === void 0) {
					writeJson$1(res, 200, {
						ok: false,
						code: "bad-request",
						message: "malformed gallery entry"
					});
					return;
				}
				try {
					const result = await gallery.append({
						...entry,
						id: randomUUID()
					});
					writeJson$1(res, 200, {
						ok: true,
						entries: result.entries,
						added: result.added
					});
				} catch (error) {
					writeJson$1(res, 200, {
						ok: false,
						code: "gallery-failed",
						message: messageOf$3(error)
					});
				}
			}
		},
		{
			kind: "exact",
			path: GALLERY_API.remove,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody$1(req);
				const id = body !== void 0 && typeof body.id === "string" ? body.id : "";
				if (id === "") {
					writeJson$1(res, 200, {
						ok: false,
						code: "bad-request",
						message: "gallery id is required"
					});
					return;
				}
				try {
					writeJson$1(res, 200, {
						ok: true,
						...splitGallery(await gallery.remove(id))
					});
				} catch (error) {
					writeJson$1(res, 200, {
						ok: false,
						code: "gallery-failed",
						message: messageOf$3(error)
					});
				}
			}
		},
		{
			kind: "exact",
			path: GALLERY_API.restore,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody$1(req);
				const id = body !== void 0 && typeof body.id === "string" ? body.id : "";
				if (id === "" || gallery.restore === void 0) {
					writeJson$1(res, 200, {
						ok: false,
						code: "bad-request",
						message: "gallery id is required"
					});
					return;
				}
				try {
					writeJson$1(res, 200, {
						ok: true,
						...splitGallery(await gallery.restore(id))
					});
				} catch (error) {
					writeJson$1(res, 200, {
						ok: false,
						code: "gallery-failed",
						message: messageOf$3(error)
					});
				}
			}
		},
		{
			kind: "exact",
			path: GALLERY_API.purge,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				if (gallery.purge === void 0) {
					writeJson$1(res, 200, {
						ok: false,
						code: "gallery-failed",
						message: "宿主不支持清空回收站"
					});
					return;
				}
				try {
					writeJson$1(res, 200, {
						ok: true,
						...splitGallery(await gallery.purge())
					});
				} catch (error) {
					writeJson$1(res, 200, {
						ok: false,
						code: "gallery-failed",
						message: messageOf$3(error)
					});
				}
			}
		},
		{
			kind: "exact",
			path: GALLERY_API.tags,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody$1(req);
				const id = typeof body?.id === "string" ? body.id : "";
				const tags = Array.isArray(body?.tags) ? body.tags.filter((tag) => typeof tag === "string") : void 0;
				if (id === "" || tags === void 0 || gallery.updateTags === void 0) {
					writeJson$1(res, 200, {
						ok: false,
						code: "bad-request",
						message: "gallery id and tags are required"
					});
					return;
				}
				try {
					writeJson$1(res, 200, {
						ok: true,
						...splitGallery(await gallery.updateTags(id, tags))
					});
				} catch (error) {
					writeJson$1(res, 200, {
						ok: false,
						code: "gallery-failed",
						message: messageOf$3(error)
					});
				}
			}
		},
		{
			kind: "exact",
			path: GALLERY_API.clear,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				try {
					writeJson$1(res, 200, {
						ok: true,
						...splitGallery(await gallery.clear())
					});
				} catch (error) {
					writeJson$1(res, 200, {
						ok: false,
						code: "gallery-failed",
						message: messageOf$3(error)
					});
				}
			}
		},
		{
			kind: "prefix",
			path: GALLERY_API.image,
			handler: async (req, res) => {
				if (!isLoopbackRequest$1(req)) {
					writeJson$1(res, 403, { error: "forbidden: loopback-only" });
					return;
				}
				if (req.method !== "GET") {
					writeJson$1(res, 405, { error: `method not allowed: ${req.method}` });
					return;
				}
				const file = imageFileFrom(req.url, GALLERY_API.image);
				if (file === void 0) {
					writeJson$1(res, 404, { error: "not found" });
					return;
				}
				const found = await gallery.readImage(file);
				if (found === void 0) {
					writeJson$1(res, 404, { error: "not found" });
					return;
				}
				res.writeHead(200, {
					"content-type": found.mime,
					"content-length": found.data.length,
					"cache-control": "private, max-age=3600"
				});
				res.end(found.data);
			}
		},
		{
			kind: "exact",
			path: GALLERY_API.video,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				if (gallery.appendVideo === void 0) {
					writeJson$1(res, 200, {
						ok: false,
						code: "gallery-video-unsupported",
						message: "当前宿主不支持收藏视频"
					});
					return;
				}
				const body = await readJsonBody$1(req);
				const entryId = typeof body?.entryId === "string" ? body.entryId.trim() : "";
				if (entryId === "") {
					writeJson$1(res, 200, {
						ok: false,
						code: "bad-request",
						message: "entryId is required"
					});
					return;
				}
				try {
					const entry = (await video.list()).find((candidate) => candidate.id === entryId);
					const clip = entry?.videos[0];
					if (entry === void 0 || clip === void 0) {
						writeJson$1(res, 200, {
							ok: false,
							code: "not-found",
							message: "视频不存在或已被清理"
						});
						return;
					}
					const file = imageFileFrom(clip.url, VIDEO_API.file);
					const found = file === void 0 ? void 0 : await video.readFile(file);
					if (found === void 0) {
						writeJson$1(res, 200, {
							ok: false,
							code: "not-found",
							message: "视频文件已不存在"
						});
						return;
					}
					const result = await gallery.appendVideo({
						id: randomUUID(),
						createdAt: Date.now(),
						model: entry.model,
						prompt: entry.prompt,
						aspectRatio: entry.aspectRatio,
						seconds: entry.seconds,
						sourcePath: found.path,
						mime: found.mime,
						...clip.duration === void 0 ? {} : { duration: clip.duration },
						...entry.channelId === void 0 ? {} : { channelId: entry.channelId },
						...entry.channel === void 0 ? {} : { channel: entry.channel },
						...Array.isArray(body?.tags) ? { tags: body.tags.filter((tag) => typeof tag === "string" && tag !== "").slice(0, 20) } : {}
					});
					writeJson$1(res, 200, {
						ok: true,
						entries: result.entries,
						added: result.added
					});
				} catch (error) {
					writeJson$1(res, 200, {
						ok: false,
						code: "gallery-failed",
						message: messageOf$3(error)
					});
				}
			}
		},
		{
			kind: "prefix",
			path: GALLERY_API.videoFile,
			handler: (req, res) => gallery.readVideo === void 0 ? Promise.resolve(writeJson$1(res, 404, { error: "not found" })) : serveClip(req, res, GALLERY_API.videoFile, gallery.readVideo)
		},
		{
			kind: "exact",
			path: CANVAS_API.list,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				try {
					writeJson$1(res, 200, {
						ok: true,
						projects: await canvas.list()
					});
				} catch (error) {
					writeJson$1(res, 200, {
						ok: false,
						code: "canvas-failed",
						message: messageOf$3(error)
					});
				}
			}
		},
		{
			kind: "exact",
			path: CANVAS_API.create,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody$1(req);
				const title = typeof body?.title === "string" ? body.title : "未命名画布";
				try {
					writeJson$1(res, 200, {
						ok: true,
						document: await canvas.create(title)
					});
				} catch (error) {
					writeJson$1(res, 200, {
						ok: false,
						code: "canvas-failed",
						message: messageOf$3(error)
					});
				}
			}
		},
		{
			kind: "exact",
			path: CANVAS_API.read,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody$1(req);
				const id = typeof body?.id === "string" ? body.id : "";
				const document = id === "" ? void 0 : await canvas.read(id);
				if (document === void 0) writeJson$1(res, 200, {
					ok: false,
					code: "not-found",
					message: "画布不存在"
				});
				else writeJson$1(res, 200, {
					ok: true,
					document
				});
			}
		},
		{
			kind: "exact",
			path: CANVAS_API.save,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody$1(req);
				const document = body?.document;
				const expectedRevision = typeof body?.expectedRevision === "number" ? body.expectedRevision : void 0;
				if (document === void 0 || typeof document !== "object") {
					writeJson$1(res, 200, {
						ok: false,
						code: "bad-request",
						message: "canvas document is required"
					});
					return;
				}
				try {
					writeJson$1(res, 200, {
						ok: true,
						document: await canvas.save(document, expectedRevision)
					});
				} catch (error) {
					writeJson$1(res, 200, {
						ok: false,
						code: error instanceof CanvasConflictError ? error.code : "canvas-failed",
						message: messageOf$3(error)
					});
				}
			}
		},
		{
			kind: "exact",
			path: CANVAS_API.remove,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody$1(req);
				const id = typeof body?.id === "string" ? body.id : "";
				if (id === "") {
					writeJson$1(res, 200, {
						ok: false,
						code: "bad-request",
						message: "canvas id is required"
					});
					return;
				}
				try {
					writeJson$1(res, 200, {
						ok: true,
						projects: await canvas.remove(id)
					});
				} catch (error) {
					writeJson$1(res, 200, {
						ok: false,
						code: "canvas-failed",
						message: messageOf$3(error)
					});
				}
			}
		},
		{
			kind: "exact",
			path: CANVAS_API.favorite,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody$1(req);
				const id = typeof body?.id === "string" ? body.id.trim() : "";
				const favorite = body?.favorite === true;
				if (id === "") {
					writeJson$1(res, 200, {
						ok: false,
						code: "bad-request",
						message: "canvas id is required"
					});
					return;
				}
				if (canvas.setFavorite === void 0) {
					writeJson$1(res, 200, {
						ok: false,
						code: "canvas-favorite-unsupported",
						message: "当前画布后端不支持收藏"
					});
					return;
				}
				try {
					writeJson$1(res, 200, {
						ok: true,
						projects: await canvas.setFavorite(id, favorite)
					});
				} catch (error) {
					writeJson$1(res, 200, {
						ok: false,
						code: "canvas-favorite-failed",
						message: messageOf$3(error)
					});
				}
			}
		},
		{
			kind: "exact",
			path: CANVAS_API.archive,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody$1(req);
				const id = typeof body?.id === "string" ? body.id.trim() : "";
				const archived = body?.archived !== false;
				if (id === "") {
					writeJson$1(res, 200, {
						ok: false,
						code: "bad-request",
						message: "canvas id is required"
					});
					return;
				}
				if (canvas.setArchived === void 0) {
					writeJson$1(res, 200, {
						ok: false,
						code: "canvas-archive-unsupported",
						message: "当前画布后端不支持归档"
					});
					return;
				}
				try {
					writeJson$1(res, 200, {
						ok: true,
						projects: await canvas.setArchived(id, archived)
					});
				} catch (error) {
					writeJson$1(res, 200, {
						ok: false,
						code: "canvas-archive-failed",
						message: messageOf$3(error)
					});
				}
			}
		},
		{
			kind: "exact",
			path: CANVAS_API.rename,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody$1(req);
				const id = typeof body?.id === "string" ? body.id.trim() : "";
				const title = typeof body?.title === "string" ? body.title : "";
				if (id === "") {
					writeJson$1(res, 200, {
						ok: false,
						code: "bad-request",
						message: "canvas id is required"
					});
					return;
				}
				if (canvas.rename === void 0) {
					writeJson$1(res, 200, {
						ok: false,
						code: "canvas-rename-unsupported",
						message: "当前画布后端不支持重命名"
					});
					return;
				}
				try {
					writeJson$1(res, 200, {
						ok: true,
						projects: await canvas.rename(id, title)
					});
				} catch (error) {
					writeJson$1(res, 200, {
						ok: false,
						code: "canvas-rename-failed",
						message: messageOf$3(error)
					});
				}
			}
		},
		{
			kind: "exact",
			path: CANVAS_API.assetUpload,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody$1(req, MAX_HISTORY_BODY_BYTES);
				const parsed = typeof body?.dataUrl === "string" ? imageDataUrl$2(body.dataUrl) : void 0;
				const width = Number(body?.width);
				const height = Number(body?.height);
				if (parsed === void 0 || !Number.isSafeInteger(width) || width < 1 || !Number.isSafeInteger(height) || height < 1) {
					writeJson$1(res, 200, {
						ok: false,
						code: "bad-request",
						message: "image data and dimensions are required"
					});
					return;
				}
				try {
					writeJson$1(res, 200, {
						ok: true,
						asset: await canvas.putImage({
							data: parsed.data,
							mime: parsed.mediaType,
							width,
							height,
							origin: body?.origin === "history" || body?.origin === "gallery" || body?.origin === "generated" ? body.origin : "upload",
							...typeof body?.originId === "string" ? { originId: body.originId } : {},
							...typeof body?.entryId === "string" ? { entryId: body.entryId } : {},
							...Number.isSafeInteger(Number(body?.imageIndex)) ? { imageIndex: Number(body?.imageIndex) } : {}
						})
					});
				} catch (error) {
					writeJson$1(res, 200, {
						ok: false,
						code: "canvas-asset-failed",
						message: messageOf$3(error)
					});
				}
			}
		},
		{
			kind: "exact",
			path: CANVAS_API.assetImport,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody$1(req);
				const source = body?.source === "history" || body?.source === "gallery" ? body.source : void 0;
				const entryId = typeof body?.entryId === "string" ? body.entryId : "";
				const imageIndex = Number(body?.imageIndex);
				const width = Number(body?.width);
				const height = Number(body?.height);
				if (source === void 0 || entryId === "" || !Number.isSafeInteger(imageIndex) || imageIndex < 0 || !Number.isSafeInteger(width) || width < 1 || !Number.isSafeInteger(height) || height < 1) {
					writeJson$1(res, 200, {
						ok: false,
						code: "bad-request",
						message: "source, entryId, imageIndex and dimensions are required"
					});
					return;
				}
				try {
					const backend = source === "history" ? history : gallery;
					const image = (await backend.list()).find((item) => item.id === entryId)?.images[imageIndex];
					if (image === void 0) {
						writeJson$1(res, 200, {
							ok: false,
							code: "not-found",
							message: "image not found"
						});
						return;
					}
					const base = source === "history" ? HISTORY_API.image : GALLERY_API.image;
					const file = imageFileFrom(image.url, base);
					const found = file === void 0 ? void 0 : await backend.readImage(file);
					if (found === void 0) {
						writeJson$1(res, 200, {
							ok: false,
							code: "not-found",
							message: "image not found"
						});
						return;
					}
					writeJson$1(res, 200, {
						ok: true,
						asset: await canvas.putImage({
							data: found.data,
							mime: found.mime,
							width,
							height,
							origin: source,
							originId: entryId,
							entryId,
							imageIndex
						})
					});
				} catch (error) {
					writeJson$1(res, 200, {
						ok: false,
						code: "canvas-asset-failed",
						message: messageOf$3(error)
					});
				}
			}
		},
		{
			kind: "exact",
			path: CANVAS_API.layers,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody$1(req);
				const raw = typeof body?.image === "string" ? body.image.trim() : "";
				const image = raw === "" ? void 0 : imageDataUrl$2(raw);
				if (image === void 0) {
					writeJson$1(res, 200, {
						ok: false,
						code: "bad-request",
						message: "image data URL is required"
					});
					return;
				}
				if (image.data.byteLength > 12582912) {
					writeJson$1(res, 200, {
						ok: false,
						code: "image-too-large",
						message: "图片超过 12MB 上限，请先压缩后再拆分图层"
					});
					return;
				}
				try {
					writeJson$1(res, 200, {
						ok: true,
						plan: await analyzeLayers(resolvePrompt(), raw)
					});
				} catch (error) {
					writeJson$1(res, 200, {
						ok: false,
						code: "layer-analysis-failed",
						message: messageOf$3(error)
					});
				}
			}
		},
		{
			kind: "prefix",
			path: CANVAS_API.asset,
			handler: async (req, res) => {
				if (!isLoopbackRequest$1(req)) {
					writeJson$1(res, 403, { error: "forbidden: loopback-only" });
					return;
				}
				if (req.method !== "GET") {
					writeJson$1(res, 405, { error: `method not allowed: ${req.method}` });
					return;
				}
				const file = imageFileFrom(req.url, CANVAS_API.asset);
				const found = file === void 0 ? void 0 : await canvas.readAsset(file);
				if (found === void 0) {
					writeJson$1(res, 404, { error: "not found" });
					return;
				}
				const url = new URL(req.url ?? "/", "http://127.0.0.1");
				const image = CANVAS_INLINE_IMAGE_MIME.test(found.mime);
				const wantsInline = url.searchParams.get("inline") === "1";
				const downloadRequested = url.searchParams.get("download") === "0";
				if (!(image && !downloadRequested || wantsInline && CANVAS_INLINE_MIME.test(found.mime))) {
					res.writeHead(200, {
						"content-type": "application/octet-stream",
						"content-length": found.data.length,
						"cache-control": "private, no-store",
						"x-content-type-options": "nosniff",
						"content-disposition": `attachment; filename="${file ?? "asset"}"`
					});
					res.end(found.data);
					return;
				}
				const headers = {
					"content-type": found.mime,
					"cache-control": "private, max-age=3600",
					"x-content-type-options": "nosniff",
					"content-disposition": `inline; filename="${file ?? "asset"}"`,
					"accept-ranges": "bytes"
				};
				const range = parseByteRange(req.headers.range, found.data.length);
				if (range.kind === "unsatisfiable") {
					writeUnsatisfiable(res, found.data.length);
					return;
				}
				if (range.kind === "range") {
					const slice = found.data.subarray(range.start, range.end + 1);
					res.writeHead(206, {
						...headers,
						"content-range": `bytes ${range.start}-${range.end}/${found.data.length}`,
						"content-length": slice.length
					});
					res.end(slice);
					return;
				}
				res.writeHead(200, {
					...headers,
					"content-length": found.data.length
				});
				res.end(found.data);
			}
		},
		{
			kind: "exact",
			path: CANVAS_API.fileUpload,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				if (canvas.putFile === void 0) {
					writeJson$1(res, 200, {
						ok: false,
						code: "canvas-files-unsupported",
						message: "当前画布后端不支持文件资产"
					});
					return;
				}
				const name = safeFileName(new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get("name") ?? "file");
				const header = req.headers["content-type"];
				const declared = typeof header === "string" ? header : "";
				const mime = declared.trim() === "" ? mimeFromFileName(name) : declared;
				const data = await readRawBody(req, MAX_CANVAS_FILE_BYTES);
				if (data === void 0 || data.byteLength === 0) {
					writeJson$1(res, 200, {
						ok: false,
						code: "file-too-large",
						message: `文件为空或超过 ${Math.round(MAX_CANVAS_FILE_BYTES / (1024 * 1024))}MB 上限`
					});
					return;
				}
				try {
					writeJson$1(res, 200, {
						ok: true,
						asset: await canvas.putFile({
							data,
							mime,
							name,
							origin: "upload"
						})
					});
				} catch (error) {
					writeJson$1(res, 200, {
						ok: false,
						code: "canvas-file-failed",
						message: messageOf$3(error)
					});
				}
			}
		},
		{
			kind: "exact",
			path: CANVAS_API.filePreview,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody$1(req);
				const assetId = typeof body?.assetId === "string" ? body.assetId : "";
				if (assetId === "") {
					writeJson$1(res, 200, {
						ok: false,
						code: "bad-request",
						message: "assetId 是必填项"
					});
					return;
				}
				const found = await canvas.readAsset(assetId);
				if (found === void 0) {
					writeJson$1(res, 200, {
						ok: false,
						code: "not-found",
						message: "画布资产不存在，可能已被清理。"
					});
					return;
				}
				try {
					const hintName = typeof body?.name === "string" ? safeFileName(body.name) : "";
					const rawMime = typeof body?.mime === "string" && body.mime.length <= 160 ? baseMime$1(body.mime) : "";
					const mime = rawMime === "" || rawMime === "application/octet-stream" ? found.mime : rawMime;
					writeJson$1(res, 200, {
						ok: true,
						preview: buildFilePreview({
							data: found.data,
							mime,
							name: hintName === "" ? assetId : hintName,
							url: `${CANVAS_API.asset}/${encodeURIComponent(assetId)}?inline=1`
						})
					});
				} catch (error) {
					writeJson$1(res, 200, {
						ok: false,
						code: "preview-failed",
						message: messageOf$3(error)
					});
				}
			}
		},
		{
			kind: "exact",
			path: CANVAS_SKILL_API.pptRuntime,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody$1(req);
				if (deps.pptRuntime === void 0) {
					writeJson$1(res, 200, {
						ok: false,
						message: "PPT runtime unavailable"
					});
					return;
				}
				try {
					writeJson$1(res, 200, {
						ok: true,
						runtime: body?.install === true ? await deps.pptRuntime.install() : await deps.pptRuntime.check()
					});
				} catch (error) {
					writeJson$1(res, 200, {
						ok: false,
						message: messageOf$3(error)
					});
				}
			}
		},
		{
			kind: "exact",
			path: CANVAS_SKILL_API.pptTasks,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				if (deps.skills?.pptTasks === void 0) {
					writeJson$1(res, 200, {
						ok: false,
						message: "PPT runtime unavailable"
					});
					return;
				}
				try {
					writeJson$1(res, 200, {
						ok: true,
						tasks: await deps.skills.pptTasks()
					});
				} catch (error) {
					writeJson$1(res, 200, {
						ok: false,
						message: messageOf$3(error)
					});
				}
			}
		},
		{
			kind: "exact",
			path: CANVAS_SKILL_API.pptRun,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody$1(req);
				if (!Array.isArray(body?.images) || body.images.length < 1 || body.images.length > 12 || typeof body.offlineOcr !== "boolean") {
					writeJson$1(res, 200, {
						ok: false,
						code: "bad-request",
						message: "请选择1–12张图片和OCR方式"
					});
					return;
				}
				const images = [];
				for (const raw of body.images) {
					if (raw === null || typeof raw !== "object" || typeof raw.assetId !== "string" || !/^[\w.-]+$/.test(raw.assetId)) {
						writeJson$1(res, 200, {
							ok: false,
							code: "bad-request",
							message: "图片资产无效"
						});
						return;
					}
					images.push({
						assetId: raw.assetId,
						url: `${CANVAS_API.asset}/${encodeURIComponent(raw.assetId)}`,
						mime: "",
						width: 0,
						height: 0,
						bytes: 0,
						origin: "upload"
					});
				}
				if (deps.skills?.runPpt === void 0) {
					writeJson$1(res, 200, {
						ok: false,
						message: "PPT runtime unavailable"
					});
					return;
				}
				try {
					const runtime = await deps.pptRuntime?.check();
					if (runtime !== void 0 && !runtime.available) throw new Error(`editppt 尚未就绪，请在生图配置中检查或安装运行环境。${runtime.message}`);
					writeJson$1(res, 200, {
						ok: true,
						task: await deps.skills.runPpt({
							images,
							offlineOcr: body.offlineOcr,
							...parseSkillLanguage(body)
						})
					});
				} catch (error) {
					writeJson$1(res, 200, {
						ok: false,
						code: "ppt-run-failed",
						message: messageOf$3(error)
					});
				}
			}
		},
		{
			kind: "exact",
			path: CANVAS_SKILL_API.list,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody$1(req);
				if (deps.skills === void 0) {
					writeJson$1(res, 200, {
						ok: true,
						skills: [],
						agentAvailable: false,
						registryAvailable: false,
						reason: "本宿主未挂载技能注册表（ctx.skills），画布技能不可用。"
					});
					return;
				}
				try {
					writeJson$1(res, 200, {
						ok: true,
						...await deps.skills.list(parseSkillLanguage(body).language)
					});
				} catch (error) {
					writeJson$1(res, 200, {
						ok: false,
						code: "skills-failed",
						message: messageOf$3(error)
					});
				}
			}
		},
		{
			kind: "exact",
			path: CANVAS_SKILL_API.run,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const request = parseSkillRunRequest(await readJsonBody$1(req));
				if (request === void 0) {
					writeJson$1(res, 200, {
						ok: false,
						code: "bad-request",
						message: "canvasId、skillId 与 nodeIds 是必填项"
					});
					return;
				}
				if (deps.skills === void 0) {
					writeJson$1(res, 200, {
						ok: false,
						code: "skills-unavailable",
						message: "本宿主未挂载技能运行时，画布技能不可用。"
					});
					return;
				}
				try {
					writeJson$1(res, 200, {
						ok: true,
						task: await deps.skills.run(request)
					});
				} catch (error) {
					writeJson$1(res, 200, {
						ok: false,
						code: "skill-run-failed",
						message: messageOf$3(error)
					});
				}
			}
		},
		{
			kind: "exact",
			path: CANVAS_SKILL_API.task,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody$1(req);
				if (deps.skills === void 0) {
					writeJson$1(res, 200, {
						ok: false,
						code: "not-found",
						message: "任务不存在"
					});
					return;
				}
				const canvasId = typeof body?.canvasId === "string" ? body.canvasId.trim() : "";
				if (canvasId !== "") {
					writeJson$1(res, 200, {
						ok: true,
						tasks: deps.skills.tasksOfCanvas(canvasId)
					});
					return;
				}
				const id = typeof body?.taskId === "string" ? body.taskId.trim() : "";
				if (id === "") {
					writeJson$1(res, 200, {
						ok: false,
						code: "not-found",
						message: "任务不存在"
					});
					return;
				}
				const task = deps.skills.task(id);
				if (task === void 0) {
					writeJson$1(res, 200, {
						ok: false,
						code: "not-found",
						message: "任务不存在"
					});
					return;
				}
				writeJson$1(res, 200, {
					ok: true,
					task
				});
			}
		},
		{
			kind: "exact",
			path: CANVAS_SKILL_API.cancel,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody$1(req);
				const id = typeof body?.taskId === "string" ? body.taskId.trim() : "";
				if (id === "" || deps.skills === void 0) {
					writeJson$1(res, 200, {
						ok: false,
						code: "not-found",
						message: "任务不存在"
					});
					return;
				}
				try {
					writeJson$1(res, 200, {
						ok: true,
						cancelled: await deps.skills.cancel(id)
					});
				} catch (error) {
					writeJson$1(res, 200, {
						ok: false,
						code: "skill-cancel-failed",
						message: messageOf$3(error)
					});
				}
			}
		},
		{
			kind: "exact",
			path: CANVAS_SKILL_API.library,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody$1(req);
				if (deps.skillLibrary === void 0) {
					writeJson$1(res, 200, {
						ok: false,
						code: "library-unavailable",
						message: "本宿主不支持管理本机技能库。"
					});
					return;
				}
				try {
					writeJson$1(res, 200, {
						ok: true,
						library: await deps.skillLibrary.list(parseSkillLanguage(body))
					});
				} catch (error) {
					writeJson$1(res, 200, {
						ok: false,
						code: "library-failed",
						message: messageOf$3(error)
					});
				}
			}
		},
		{
			kind: "exact",
			path: CANVAS_SKILL_API.install,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody$1(req);
				if (deps.skillLibrary === void 0) {
					writeJson$1(res, 200, {
						ok: false,
						code: "library-unavailable",
						message: "本宿主不支持安装技能。"
					});
					return;
				}
				const request = parseSkillInstallRequest(body);
				if (request === void 0) {
					writeJson$1(res, 200, {
						ok: false,
						code: "bad-request",
						message: "请提供技能来源链接或上传压缩包。"
					});
					return;
				}
				try {
					writeJson$1(res, 200, await deps.skillLibrary.install(request));
				} catch (error) {
					writeJson$1(res, 200, {
						ok: false,
						code: "install-failed",
						message: messageOf$3(error)
					});
				}
			}
		},
		{
			kind: "exact",
			path: CANVAS_SKILL_API.remove,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody$1(req);
				if (deps.skillLibrary === void 0) {
					writeJson$1(res, 200, {
						ok: false,
						code: "library-unavailable",
						message: "本宿主不支持卸载技能。"
					});
					return;
				}
				const name = typeof body?.name === "string" ? body.name.trim() : "";
				if (name === "") {
					writeJson$1(res, 200, {
						ok: false,
						code: "bad-request",
						message: "缺少技能名。"
					});
					return;
				}
				try {
					writeJson$1(res, 200, await deps.skillLibrary.remove(name, parseSkillLanguage(body)));
				} catch (error) {
					writeJson$1(res, 200, {
						ok: false,
						code: "remove-failed",
						message: messageOf$3(error)
					});
				}
			}
		},
		{
			kind: "exact",
			path: CANVAS_SKILL_API.configSave,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody$1(req);
				if (deps.skillLibrary?.configSave === void 0) {
					writeJson$1(res, 200, {
						ok: false,
						code: "library-unavailable",
						message: "本宿主不支持保存技能配置。"
					});
					return;
				}
				const name = typeof body?.name === "string" ? body.name.trim() : "";
				if (name === "") {
					writeJson$1(res, 200, {
						ok: false,
						code: "bad-request",
						message: "缺少技能名。"
					});
					return;
				}
				const values = (Array.isArray(body?.values) ? body.values : []).map((item) => {
					if (item === null || typeof item !== "object") return void 0;
					const record = item;
					const id = typeof record.id === "string" ? record.id.trim() : "";
					if (id === "" || typeof record.value !== "string") return void 0;
					return {
						id,
						value: record.value
					};
				}).filter((item) => item !== void 0).slice(0, 64);
				try {
					writeJson$1(res, 200, await deps.skillLibrary.configSave({
						name,
						values,
						...parseSkillLanguage(body)
					}));
				} catch (error) {
					writeJson$1(res, 200, {
						ok: false,
						code: "config-save-failed",
						message: messageOf$3(error)
					});
				}
			}
		},
		{
			kind: "exact",
			path: CANVAS_SKILL_API.configApply,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody$1(req);
				if (deps.skillLibrary?.configApply === void 0) {
					writeJson$1(res, 200, {
						ok: false,
						code: "library-unavailable",
						message: "本宿主不支持应用技能配置。"
					});
					return;
				}
				const name = typeof body?.name === "string" ? body.name.trim() : "";
				if (name === "") {
					writeJson$1(res, 200, {
						ok: false,
						code: "bad-request",
						message: "缺少技能名。"
					});
					return;
				}
				try {
					writeJson$1(res, 200, await deps.skillLibrary.configApply({
						name,
						...parseSkillLanguage(body)
					}));
				} catch (error) {
					writeJson$1(res, 200, {
						ok: false,
						code: "config-apply-failed",
						message: messageOf$3(error)
					});
				}
			}
		},
		{
			kind: "exact",
			path: TEMPLATES_API.list,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody$1(req);
				const sourceId = templateSourceOf(body);
				if (sourceId === void 0) {
					writeJson$1(res, 200, {
						ok: false,
						code: "templates-source-unknown",
						message: `未知的模板库来源：${String(body?.source ?? "")}`
					});
					return;
				}
				try {
					writeJson$1(res, 200, {
						ok: true,
						...await templates.list(sourceId)
					});
				} catch (error) {
					writeJson$1(res, 200, {
						ok: false,
						code: "templates-failed",
						message: messageOf$3(error)
					});
				}
			}
		},
		{
			kind: "exact",
			path: TEMPLATES_API.refresh,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody$1(req);
				const sourceId = templateSourceOf(body);
				if (sourceId === void 0) {
					writeJson$1(res, 200, {
						ok: false,
						code: "templates-source-unknown",
						message: `未知的模板库来源：${String(body?.source ?? "")}`
					});
					return;
				}
				try {
					writeJson$1(res, 200, {
						ok: true,
						...await templates.refresh(sourceId)
					});
				} catch (error) {
					writeJson$1(res, 200, {
						ok: false,
						code: "templates-refresh-failed",
						message: messageOf$3(error)
					});
				}
			}
		},
		{
			kind: "exact",
			path: TEMPLATES_API.sample,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody$1(req);
				const requested = Number(body?.count);
				const count = Number.isFinite(requested) ? requested : 9;
				try {
					writeJson$1(res, 200, {
						ok: true,
						samples: await templates.sample(count)
					});
				} catch (error) {
					writeJson$1(res, 200, {
						ok: false,
						code: "templates-sample-failed",
						message: messageOf$3(error)
					});
				}
			}
		},
		{
			kind: "prefix",
			path: TEMPLATES_API.image,
			handler: async (req, res) => {
				if (!isLoopbackRequest$1(req)) {
					writeJson$1(res, 403, { error: "forbidden: loopback-only" });
					return;
				}
				if (req.method !== "GET") {
					writeJson$1(res, 405, { error: `method not allowed: ${req.method}` });
					return;
				}
				const raw = imageFileFrom(req.url, TEMPLATES_API.image);
				const slash = raw?.indexOf("/") ?? -1;
				const sourceId = slash > 0 ? raw.slice(0, slash) : "";
				const file = slash > 0 ? raw.slice(slash + 1) : "";
				if (sourceId === "" || !isTemplateSourceId(sourceId) || file === "") {
					writeJson$1(res, 404, { error: "not found" });
					return;
				}
				const found = await templates.readImage(sourceId, file);
				if (found === void 0) {
					writeJson$1(res, 404, { error: "not found" });
					return;
				}
				res.writeHead(200, {
					"content-type": found.mime,
					"content-length": found.data.length,
					"cache-control": "private, max-age=86400"
				});
				res.end(found.data);
			}
		},
		{
			kind: "exact",
			path: TEMPLATE_FAVORITES_API.list,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				try {
					writeJson$1(res, 200, {
						ok: true,
						favorites: await favorites.list()
					});
				} catch (error) {
					writeJson$1(res, 200, {
						ok: false,
						code: "template-favorites-failed",
						message: messageOf$3(error)
					});
				}
			}
		},
		{
			kind: "exact",
			path: TEMPLATE_FAVORITES_API.add,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody$1(req);
				const sourceId = templateSourceOf(body);
				const rawCase = body?.case;
				if (sourceId === void 0 || rawCase === null || typeof rawCase !== "object") {
					writeJson$1(res, 200, {
						ok: false,
						code: "template-favorite-invalid",
						message: "收藏请求缺少有效的来源或模板数据"
					});
					return;
				}
				const record = rawCase;
				const id = typeof record.id === "number" && Number.isFinite(record.id) ? String(record.id) : typeof record.id === "string" ? record.id.trim() : "";
				const title = typeof record.title === "string" ? record.title.trim() : "";
				const prompt = typeof record.prompt === "string" ? record.prompt.trim() : "";
				if (id === "" || title === "" || prompt === "") {
					writeJson$1(res, 200, {
						ok: false,
						code: "template-favorite-invalid",
						message: "收藏请求缺少有效的模板数据"
					});
					return;
				}
				try {
					writeJson$1(res, 200, {
						ok: true,
						favorites: await favorites.add(sourceId, rawCase)
					});
				} catch (error) {
					writeJson$1(res, 200, {
						ok: false,
						code: "template-favorites-failed",
						message: messageOf$3(error)
					});
				}
			}
		},
		{
			kind: "exact",
			path: TEMPLATE_FAVORITES_API.remove,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody$1(req);
				const key = typeof body?.key === "string" ? body.key : "";
				if (key === "") {
					writeJson$1(res, 200, {
						ok: false,
						code: "template-favorite-invalid",
						message: "取消收藏请求缺少模板标识"
					});
					return;
				}
				try {
					writeJson$1(res, 200, {
						ok: true,
						favorites: await favorites.remove(key)
					});
				} catch (error) {
					writeJson$1(res, 200, {
						ok: false,
						code: "template-favorites-failed",
						message: messageOf$3(error)
					});
				}
			}
		},
		{
			kind: "exact",
			path: DATA_FOLDER_API,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody$1(req);
				const dir = imageDataRoot();
				try {
					await mkdir(dir, { recursive: true });
				} catch {}
				if (body?.open === false) {
					writeJson$1(res, 200, {
						ok: true,
						path: dir
					});
					return;
				}
				try {
					spawn(process.platform === "win32" ? "explorer.exe" : process.platform === "darwin" ? "open" : "xdg-open", [dir], {
						detached: true,
						stdio: "ignore"
					}).unref();
					writeJson$1(res, 200, {
						ok: true,
						path: dir
					});
				} catch (error) {
					writeJson$1(res, 200, {
						ok: false,
						code: "data-folder-failed",
						message: messageOf$3(error)
					});
				}
			}
		},
		{
			kind: "exact",
			path: VIDEO_API.generate,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody$1(req);
				const parsed = body === void 0 ? void 0 : parseVideoRequest(body, channelViewOf(), deps);
				if (parsed === void 0) {
					writeJson$1(res, 200, {
						ok: false,
						code: "bad-request",
						message: "prompt is required"
					});
					return;
				}
				const runtime = deps.runtime;
				if (runtime === void 0) {
					writeJson$1(res, 200, {
						ok: false,
						code: "video-unavailable",
						message: "当前宿主未挂载生成运行时"
					});
					return;
				}
				try {
					writeJson$1(res, 200, {
						ok: true,
						...await runtime.runVideo(parsed)
					});
				} catch (error) {
					writeJson$1(res, 200, {
						ok: false,
						code: videoCodeOf(error),
						message: messageOf$3(error)
					});
				}
			}
		},
		{
			kind: "exact",
			path: VIDEO_API.submit,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody$1(req);
				const parsed = body === void 0 ? void 0 : parseVideoRequest(body, channelViewOf(), deps);
				if (parsed === void 0) {
					writeJson$1(res, 200, {
						ok: false,
						code: "bad-request",
						message: "prompt is required"
					});
					return;
				}
				const runtime = deps.runtime;
				if (runtime === void 0) {
					writeJson$1(res, 200, {
						ok: false,
						code: "video-unavailable",
						message: "当前宿主未挂载生成运行时"
					});
					return;
				}
				writeJson$1(res, 200, {
					ok: true,
					task: runtime.videoQueue.submit(parsed)
				});
			}
		},
		{
			/**
			* Preview the director plan without rendering.
			*
			* Submit already plans when `plan: true`, but a render costs minutes: the
			* user must be able to inspect the shot list and the parameters the
			* planner chose before spending them. This route runs exactly the same
			* planning code and returns its output, and nothing else.
			*/
			kind: "exact",
			path: VIDEO_API.plan,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody$1(req);
				const parsed = body === void 0 ? void 0 : parseVideoRequest(body, channelViewOf(), deps);
				if (parsed === void 0) {
					writeJson$1(res, 200, {
						ok: false,
						code: "video-prompt-empty",
						message: "prompt is required"
					});
					return;
				}
				const runtime = deps.runtime;
				if (runtime === void 0) {
					writeJson$1(res, 200, {
						ok: false,
						code: "video-unavailable",
						message: "当前宿主未挂载生成运行时"
					});
					return;
				}
				try {
					writeJson$1(res, 200, {
						ok: true,
						plan: await runtime.planVideoRequest(parsed)
					});
				} catch (error) {
					writeJson$1(res, 200, {
						ok: false,
						code: videoCodeOf(error),
						message: messageOf$3(error)
					});
				}
			}
		},
		{
			/**
			* Preview a code render: pixel size, frame count, and whether this
			* machine can encode a video.
			*
			* Read-only by design — no model call, no frame rendered. It exists so
			* the composer can tell the user "1080x1920, 150 frames" and can warn
			* about a missing ffmpeg BEFORE a chat model is paid to write code.
			*/
			kind: "exact",
			path: CODE_RENDER_API.probe,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody$1(req);
				const kind = body?.kind === "image" ? "image" : "video";
				const resolution = body?.resolution === "480P" || body?.resolution === "1080P" ? body.resolution : "720P";
				const aspectRatio = typeof body?.aspectRatio === "string" && body.aspectRatio.trim() !== "" ? body.aspectRatio.trim() : "16:9";
				const seconds = typeof body?.seconds === "number" && Number.isFinite(body.seconds) ? body.seconds : 5;
				const fps = typeof body?.fps === "number" && Number.isFinite(body.fps) ? body.fps : void 0;
				try {
					writeJson$1(res, 200, {
						ok: true,
						probe: probeCodeRender({
							kind,
							resolution,
							aspectRatio,
							...kind === "video" ? {
								seconds,
								...fps === void 0 ? {} : { fps }
							} : {}
						})
					});
				} catch (error) {
					writeJson$1(res, 200, {
						ok: false,
						code: videoCodeOf(error),
						message: messageOf$3(error)
					});
				}
			}
		},
		{
			kind: "exact",
			path: VIDEO_API.list,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const runtime = deps.runtime;
				if (runtime === void 0) {
					writeJson$1(res, 200, {
						ok: true,
						tasks: []
					});
					return;
				}
				writeJson$1(res, 200, {
					ok: true,
					tasks: runtime.videoQueue.summaries()
				});
			}
		},
		{
			kind: "exact",
			path: VIDEO_API.get,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody$1(req);
				const task = typeof body?.id === "string" ? deps.runtime?.videoQueue.get(body.id) : void 0;
				if (task === void 0) {
					writeJson$1(res, 200, {
						ok: false,
						code: "not-found",
						message: "task not found"
					});
					return;
				}
				writeJson$1(res, 200, {
					ok: true,
					task
				});
			}
		},
		{
			kind: "exact",
			path: VIDEO_API.cancel,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody$1(req);
				const task = typeof body?.id === "string" ? deps.runtime?.videoQueue.cancel(body.id) : void 0;
				if (task === void 0) {
					writeJson$1(res, 200, {
						ok: false,
						code: "not-found",
						message: "task not found"
					});
					return;
				}
				writeJson$1(res, 200, {
					ok: true,
					task
				});
			}
		},
		{
			kind: "exact",
			path: VIDEO_API.retry,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody$1(req);
				const task = typeof body?.id === "string" ? deps.runtime?.videoQueue.retry(body.id) : void 0;
				if (task === void 0) {
					writeJson$1(res, 200, {
						ok: false,
						code: "not-found",
						message: "task not found"
					});
					return;
				}
				writeJson$1(res, 200, {
					ok: true,
					task
				});
			}
		},
		{
			kind: "exact",
			path: VIDEO_API.historyList,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				try {
					writeJson$1(res, 200, {
						ok: true,
						entries: await video.list()
					});
				} catch (error) {
					writeJson$1(res, 200, {
						ok: false,
						code: "video-history-failed",
						message: messageOf$3(error)
					});
				}
			}
		},
		{
			kind: "exact",
			path: VIDEO_API.historyRemove,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody$1(req);
				if (typeof body?.id !== "string" || body.id === "") {
					writeJson$1(res, 200, {
						ok: false,
						code: "bad-request",
						message: "id is required"
					});
					return;
				}
				try {
					writeJson$1(res, 200, {
						ok: true,
						entries: await video.remove(body.id)
					});
				} catch (error) {
					writeJson$1(res, 200, {
						ok: false,
						code: "video-history-failed",
						message: messageOf$3(error)
					});
				}
			}
		},
		{
			kind: "exact",
			path: VIDEO_API.historyClear,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				try {
					writeJson$1(res, 200, {
						ok: true,
						entries: await video.clear()
					});
				} catch (error) {
					writeJson$1(res, 200, {
						ok: false,
						code: "video-history-failed",
						message: messageOf$3(error)
					});
				}
			}
		},
		{
			kind: "prefix",
			path: VIDEO_API.file,
			handler: (req, res) => serveClip(req, res, VIDEO_API.file, video.readFile)
		},
		{
			kind: "exact",
			path: STORAGE_API.test,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const storage = deps.resolveStorage?.();
				if (storage === void 0) {
					writeJson$1(res, 200, {
						ok: false,
						code: "storage-unavailable",
						message: "存储配置不可用"
					});
					return;
				}
				try {
					const result = await testStorage(storage);
					writeJson$1(res, 200, {
						ok: true,
						ms: result.ms,
						key: result.key
					});
				} catch (error) {
					writeJson$1(res, 200, {
						ok: false,
						code: "storage-test-failed",
						message: messageOf$3(error)
					});
				}
			}
		}
	];
}
//#endregion
//#region src/studio/adapter-spec.ts
/** Statuses treated as terminal when an adapter does not say otherwise. */
const DEFAULT_DONE_VALUES = [
	"succeeded",
	"success",
	"completed",
	"complete",
	"done",
	"finished",
	"ready",
	"ready_to_download",
	"SUCCEEDED",
	"SUCCESS"
];
/** Statuses treated as failure when an adapter does not say otherwise. */
const DEFAULT_FAILED_VALUES = [
	"failed",
	"failure",
	"error",
	"cancelled",
	"canceled",
	"expired",
	"rejected",
	"FAILED",
	"ERROR"
];
/** Field map defaults: the OpenAI-compatible vocabulary. */
const DEFAULT_FIELDS = {
	model: "model",
	prompt: "prompt",
	size: "size",
	aspect: "aspect_ratio",
	resolution: "resolution",
	duration: "seconds",
	n: "n",
	image: "image",
	imageMode: "data-uri-array",
	firstFrame: "first_frame",
	lastFrame: "last_frame"
};
/** Merge the field maps in increasing priority order. */
function resolveFields(...layers) {
	const merged = {};
	for (const layer of layers) {
		if (layer === void 0) continue;
		for (const [key, value] of Object.entries(layer)) {
			if (value === void 0 || value === "") continue;
			merged[key] = value;
		}
	}
	return merged;
}
/**
* Read one dotted path out of a JSON value.
*
* Supported grammar, which covers every gateway shape seen so far:
* - `a.b.c` — object walk
* - `a.0.b` — numeric index
* - `a[0].b` — bracket index
* - `a[].b` — map over every element of `a`, returning several values
* - `a[*].b` — same as `a[].b`
*
* Returns every match (empty when the path does not resolve), so callers do not
* have to care whether the response is an object or a list of assets.
*/
function readJsonPath(value, path) {
	const tokens = [];
	{
		let index = 0;
		const text = path.trim();
		while (index < text.length) {
			const char = text[index];
			if (char === ".") {
				index += 1;
				continue;
			}
			if (char === "[") {
				const close = text.indexOf("]", index);
				if (close === -1) return [];
				const inner = text.slice(index + 1, close).trim();
				if (inner === "" || inner === "*") tokens.push("[]");
				else if (/^\d+$/.test(inner)) tokens.push(Number(inner));
				else if (/^'.*'$/.test(inner) || /^".*"$/.test(inner)) tokens.push(inner.slice(1, -1));
				else tokens.push(inner);
				index = close + 1;
				continue;
			}
			let end = index;
			while (end < text.length && text[end] !== "." && text[end] !== "[") end += 1;
			const token = text.slice(index, end);
			if (token !== "") tokens.push(token);
			index = end;
		}
	}
	let frontier = [value];
	for (const token of tokens) {
		const next = [];
		for (const node of frontier) {
			if (token === "[]") {
				if (Array.isArray(node)) next.push(...node);
				else if (node !== null && typeof node === "object") next.push(...Object.values(node));
				continue;
			}
			if (node === null || node === void 0) continue;
			if (typeof token === "number") {
				if (Array.isArray(node) && token < node.length) next.push(node[token]);
				continue;
			}
			if (typeof node === "object") {
				const record = node;
				if (Object.hasOwn(record, token)) next.push(record[token]);
			}
		}
		frontier = next;
		if (frontier.length === 0) return [];
	}
	return frontier;
}
/** First non-empty string found at any of the given paths. */
function readFirstString(value, paths) {
	for (const path of paths) for (const hit of readJsonPath(value, path)) {
		if (typeof hit === "string" && hit.trim() !== "") return hit;
		if (typeof hit === "number") return String(hit);
	}
}
/** Every string found at the given path (used for arrays of URLs). */
function readStringList(value, path) {
	const out = [];
	for (const hit of readJsonPath(value, path)) if (typeof hit === "string" && hit.trim() !== "") out.push(hit);
	return out;
}
/**
* Render `{{name}}` placeholders.
*
* A placeholder with no value renders as an empty string, and an object or array
* value is JSON-encoded so a template can embed structures (`"refs": {{images}}`).
* Numeric placeholders are never quoted by the renderer: the template author
* writes the quotes when the gateway wants a string.
*/
function renderTemplate(template, values) {
	return template.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_match, name) => {
		const value = values[name];
		if (value === void 0 || value === null) return "";
		if (typeof value === "number") return String(value);
		return value;
	});
}
/** Render then parse a JSON body template; throws a readable error on bad JSON. */
function renderJsonTemplate(template, values) {
	const rendered = renderTemplate(template, values);
	try {
		const parsed = JSON.parse(rendered);
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("模板必须是一个 JSON 对象");
		return parsed;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`请求体模板解析失败：${message}；渲染结果：${rendered.slice(0, 400)}`);
	}
}
//#endregion
//#region src/studio/adapter-engine.ts
/** Raised for every adapter-level failure, with the phase that failed. */
var AdapterError = class extends Error {
	code;
	constructor(message, code) {
		super(message);
		this.code = code;
		this.name = "AdapterError";
	}
};
const SUBMIT_TIMEOUT_MS = 12e4;
const DOWNLOAD_TIMEOUT_MS = 3e5;
const MAX_ASSET_BYTES = 512 * 1024 * 1024;
const RETRYABLE_STATUS = /* @__PURE__ */ new Set([
	408,
	425,
	429,
	500,
	502,
	503,
	504
]);
/** Find the model spec for an alias, falling back to the raw id. */
function adapterModel(adapter, alias) {
	return adapter.models.find((model) => model.alias === alias) ?? adapter.models.find((model) => model.id === alias) ?? (adapter.models.length === 1 ? adapter.models[0] : void 0);
}
/** Join the adapter's origin with a submit/poll path template. */
function resolveUrl(adapter, path) {
	const trimmed = path.trim();
	if (/^https?:\/\//i.test(trimmed)) return trimmed;
	return `${adapter.baseUrl.trim().replace(/\/+$/, "")}/${trimmed.replace(/^\/+/, "")}`;
}
/** Headers with the credential applied, credential itself included. */
function credentialedHeaders(adapter, extra) {
	const headers = {
		...adapter.submit.headers ?? {},
		...extra ?? {}
	};
	const token = adapter.auth.token.trim();
	if (token !== "" && adapter.auth.style !== "none" && adapter.auth.style !== "query") {
		const prefix = adapter.auth.prefix ?? (adapter.auth.style === "bearer" ? "Bearer " : "");
		const name = adapter.auth.style === "bearer" ? "Authorization" : adapter.auth.headerName ?? "Authorization";
		headers[name] = `${prefix}${token}`;
	}
	return headers;
}
/** Redact every credential-bearing header for display. */
function redactHeaders(adapter, headers) {
	const out = {};
	for (const [name, value] of Object.entries(headers)) out[name] = /authorization|api[-_]?key|token|secret|cookie/i.test(name) ? `${value.slice(0, Math.min(value.length, 12))}…(已隐藏)` : value;
	return out;
}
/** Apply the query-style credential to a URL. */
function withQueryToken(adapter, url) {
	if (adapter.auth.style !== "query") return url;
	const name = adapter.auth.queryName?.trim();
	const token = adapter.auth.token.trim();
	if (name === void 0 || name === "" || token === "") return url;
	const parsed = new URL(url);
	parsed.searchParams.set(name, token);
	return parsed.toString();
}
/** Split a `data:` URI into mime + base64 payload. */
function splitDataUri(value) {
	const match = /^data:([^;,]+)(?:;charset=[^;,]+)?;base64,(.*)$/s.exec(value.trim());
	if (match === null) return void 0;
	return {
		mime: match[1],
		b64: match[2]
	};
}
/** Decode any string that is either a data URI or bare base64. */
function toBytes(value) {
	const dataUri = splitDataUri(value);
	if (dataUri !== void 0) return {
		bytes: Buffer.from(dataUri.b64, "base64"),
		mime: dataUri.mime
	};
	return {
		bytes: Buffer.from(value, "base64"),
		mime: "application/octet-stream"
	};
}
/** Guess a MIME type from the first bytes of an asset. */
function sniffMime(bytes, fallback) {
	if (bytes.length >= 12) {
		if (bytes.subarray(0, 8).equals(Buffer.from([
			137,
			80,
			78,
			71,
			13,
			10,
			26,
			10
		]))) return "image/png";
		if (bytes[0] === 255 && bytes[1] === 216) return "image/jpeg";
		if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
		if (bytes.subarray(0, 3).toString("ascii") === "GIF") return "image/gif";
		if (bytes.subarray(4, 8).toString("ascii") === "ftyp") return "video/mp4";
		if (bytes.subarray(0, 4).equals(Buffer.from([
			26,
			69,
			223,
			163
		]))) return "video/webm";
	}
	return fallback;
}
/** Canonical roles and the field-map slot each one drives. */
const ROLE_FIELDS = {
	model: "model",
	prompt: "prompt",
	size: "size",
	aspect: "aspect",
	resolution: "resolution",
	duration: "duration",
	n: "n",
	seed: "seed",
	negativePrompt: "negativePrompt"
};
/**
* Point the canonical field map at the wire names a model declared.
*
* A parameter that claims a role (`resolution`, `duration`, …) is already
* written by the parameter layer under its own `name`. Without this step the
* engine writes the same knob a second time under the default name, and a
* gateway that validates its body rejects the pair (`quality` beside
* `resolution`, `seconds` beside `duration`). So a declared role wins over the
* field map, and a role aimed at a query parameter or a header switches the
* body write off instead of guessing where it belongs.
*/
function applyRoleNames(fields, model) {
	const names = fields;
	for (const param of model?.params ?? []) {
		const role = param.role ?? "custom";
		if (role === "custom") continue;
		const name = typeof param.name === "string" && param.name.trim() !== "" ? param.name.trim() : param.key;
		const target = param.target ?? "body";
		names[ROLE_FIELDS[role]] = target === "body" ? name : null;
	}
}
/**
* Build the request an adapter describes.
*
* Exported because the editor renders it as the dry-run preview: seeing the
* exact URL, headers and body before spending money is the whole point of a
* user-defined protocol layer.
*/
function planAdapterRequest(adapter, model, params) {
	const fields = resolveFields(DEFAULT_FIELDS, adapter.fields, model?.fieldOverrides);
	applyRoleNames(fields, model);
	const omitted = [];
	const images = (params.images ?? []).filter((value) => value.trim() !== "");
	const imageMode = typeof fields.imageMode === "string" ? fields.imageMode : "data-uri-array";
	const multipart = imageMode === "multipart-file";
	const values = {
		prompt: params.prompt,
		model: params.model,
		n: params.n,
		seed: params.seed,
		negative_prompt: params.negativePrompt,
		duration: params.duration,
		resolution: params.resolution,
		aspect: params.aspect,
		size: void 0,
		image: void 0,
		images: void 0,
		first_frame: void 0,
		last_frame: void 0
	};
	const ratio = params.aspect?.trim() ?? "";
	const pixel = params.size?.trim() ?? "";
	if (fields.sizeByRatio !== void 0 && ratio !== "" && fields.sizeByRatio[ratio] !== void 0) values.size = fields.sizeByRatio[ratio];
	else if (pixel !== "" && pixel !== "auto") values.size = pixel;
	else if (ratio !== "" && typeof fields.size === "string" && typeof fields.aspect !== "string") values.size = ratio;
	if (imageMode === "first-last-object") {
		values.first_frame = params.firstFrame ?? images[0];
		values.last_frame = params.lastFrame;
	} else {
		values.image = images[0];
		values.images = images.length === 0 ? void 0 : JSON.stringify(images);
	}
	let body;
	if (adapter.submit.bodyTemplate !== void 0 && adapter.submit.bodyTemplate.trim() !== "") {
		body = renderJsonTemplate(adapter.submit.bodyTemplate, values);
		if (multipart && images.length > 0) omitted.push("multipart 与 JSON 模板同时存在：已按 JSON 模板发送，参考图未上传");
	} else {
		body = {};
		const set = (field, value, label) => {
			if (typeof field !== "string" || field === "") {
				if (value !== void 0) omitted.push(label);
				return;
			}
			if (value === void 0 || value === "") return;
			body[field] = value;
		};
		set(fields.model, params.model, "model");
		set(fields.prompt, params.prompt, "prompt");
		if (values.size !== void 0) set(fields.size, values.size, "size");
		else if (pixel !== "" && typeof fields.size !== "string" && typeof fields.aspect === "string") omitted.push("size");
		set(fields.aspect, params.aspect === "auto" ? void 0 : params.aspect, "aspect_ratio");
		set(fields.resolution, params.resolution, "resolution");
		set(fields.duration, params.duration, "duration");
		set(fields.n, params.n, "n");
		set(fields.seed, params.seed, "seed");
		set(fields.negativePrompt, params.negativePrompt, "negative_prompt");
		if (images.length > 0) {
			const field = typeof fields.image === "string" ? fields.image : void 0;
			if (imageMode === "first-last-object") {
				const firstKey = typeof fields.firstFrame === "string" ? fields.firstFrame : void 0;
				const lastKey = typeof fields.lastFrame === "string" ? fields.lastFrame : void 0;
				if (firstKey === void 0) omitted.push("first_frame");
				else body[firstKey] = params.firstFrame ?? images[0];
				if (lastKey === void 0) {
					if (params.lastFrame !== void 0) omitted.push("last_frame");
				} else if (params.lastFrame !== void 0) body[lastKey] = params.lastFrame;
			} else if (field === void 0) omitted.push("image");
			else if (imageMode === "single-data-uri") body[field] = images[0];
			else if (imageMode === "base64-array") body[field] = images.map((value) => splitDataUri(value)?.b64 ?? value);
			else if (imageMode === "url-array" || imageMode === "multipart-file") body[field] = images;
			else body[field] = images;
		}
		if (params.videos !== void 0 && params.videos.length > 0) if (typeof fields.refVideos === "string") body[fields.refVideos] = params.videos;
		else omitted.push("reference_videos");
		if (params.audios !== void 0 && params.audios.length > 0) if (typeof fields.refAudios === "string") body[fields.refAudios] = params.audios;
		else omitted.push("reference_audios");
	}
	if (model?.extra !== void 0) Object.assign(body, model.extra);
	if (params.custom?.body !== void 0) Object.assign(body, params.custom.body);
	const headers = credentialedHeaders(adapter, params.seed !== void 0 ? {} : {});
	if (params.custom?.headers !== void 0) Object.assign(headers, params.custom.headers);
	let contentType = "application/json";
	let payload = body;
	if (adapter.submit.contentType === "query" && adapter.submit.method !== "GET") contentType = "application/x-www-form-urlencoded";
	else if (multipart) contentType = "multipart/form-data";
	else headers["content-type"] = headers["content-type"] ?? "application/json";
	const url = withQueryToken(adapter, resolveUrl(adapter, adapter.submit.path));
	let finalUrl = url;
	if (adapter.submit.contentType === "query" && adapter.submit.method === "GET") {
		const parsed = new URL(url);
		for (const [key, value] of Object.entries(body)) {
			if (value === void 0 || value === null || typeof value === "object") continue;
			parsed.searchParams.set(key, String(value));
		}
		finalUrl = parsed.toString();
		payload = void 0;
	}
	const queryExtras = params.custom?.query;
	if (queryExtras !== void 0 && Object.keys(queryExtras).length > 0) {
		const parsed = new URL(finalUrl);
		for (const [key, value] of Object.entries(queryExtras)) parsed.searchParams.set(key, value);
		finalUrl = parsed.toString();
	}
	const preview = {
		url: finalUrl,
		method: adapter.submit.method,
		headers: redactHeaders(adapter, headers),
		body: payload,
		contentType,
		omitted: [...new Set(omitted)]
	};
	return {
		url: finalUrl,
		method: adapter.submit.method,
		headers,
		body: payload,
		contentType,
		preview
	};
}
/** Wait for `ms`, aborting early when the signal fires. */
async function sleep(ms, signal) {
	if (signal?.aborted === true) throw new AdapterError("已取消", "aborted");
	await new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(new AdapterError("已取消", "aborted"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}
/** One HTTP call with a timeout and a JSON-shaped failure. */
async function callJson(fetchFn, url, init, phase, timeoutMs, signal) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	const forward = () => controller.abort();
	signal?.addEventListener("abort", forward, { once: true });
	try {
		const response = await fetchFn(url, {
			...init,
			signal: controller.signal
		});
		const text = await response.text();
		if (!response.ok) {
			if (RETRYABLE_STATUS.has(response.status) && phase === "poll") throw new AdapterError(`网关返回 HTTP ${response.status}（稍后重试）：${text.slice(0, 300)}`, "retryable");
			throw new AdapterError(`网关返回 HTTP ${response.status}：${text.slice(0, 500)}`, `${phase}-failed`);
		}
		if (text.trim() === "") return {};
		try {
			return JSON.parse(text);
		} catch {
			throw new AdapterError(`网关返回的不是 JSON：${text.slice(0, 300)}`, "bad-json");
		}
	} catch (error) {
		if (error instanceof AdapterError) throw error;
		const message = error instanceof Error ? error.message : String(error);
		throw new AdapterError(`${phase === "submit" ? "提交" : "轮询"}请求失败：${message}`, `${phase}-failed`);
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", forward);
	}
}
/** Turn the plan into a fetch init, handling the multipart variant. */
function toInit(plan, params) {
	if (plan.contentType === "multipart/form-data") {
		const form = new FormData();
		const body = plan.body ?? {};
		for (const [key, value] of Object.entries(body)) {
			if (Array.isArray(value)) {
				for (const item of value) {
					if (typeof item === "string" && item.startsWith("data:")) {
						const decoded = splitDataUri(item);
						if (decoded !== void 0) {
							form.append(key, new Blob([Buffer.from(decoded.b64, "base64")], { type: decoded.mime }), `${key}.${decoded.mime.split("/")[1] ?? "bin"}`);
							continue;
						}
					}
					form.append(key, typeof item === "string" ? item : JSON.stringify(item));
				}
				continue;
			}
			if (typeof value === "string" && value.startsWith("data:")) {
				const decoded = splitDataUri(value);
				if (decoded !== void 0) {
					form.append(key, new Blob([Buffer.from(decoded.b64, "base64")], { type: decoded.mime }), `${key}.${decoded.mime.split("/")[1] ?? "bin"}`);
					continue;
				}
			}
			form.append(key, typeof value === "string" ? value : JSON.stringify(value));
		}
		const headers = { ...plan.headers };
		for (const name of Object.keys(headers)) if (name.toLowerCase() === "content-type") delete headers[name];
		return {
			method: plan.method,
			headers,
			body: form
		};
	}
	if (plan.contentType === "application/x-www-form-urlencoded" && plan.body !== void 0) {
		const form = new URLSearchParams();
		for (const [key, value] of Object.entries(plan.body)) {
			if (value === void 0 || value === null || typeof value === "object") continue;
			form.set(key, String(value));
		}
		return {
			method: plan.method,
			headers: plan.headers,
			body: form.toString()
		};
	}
	return {
		method: plan.method,
		headers: plan.headers,
		...plan.body === void 0 ? {} : { body: JSON.stringify(plan.body) }
	};
}
/** Download one finished asset, following the adapter's auth setting. */
async function downloadAsset(adapter, url, fetchFn, signal) {
	const headers = adapter.result.downloadAuth === true ? credentialedHeaders(adapter) : {};
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
	const forward = () => controller.abort();
	signal?.addEventListener("abort", forward, { once: true });
	try {
		const response = await fetchFn(url, {
			headers,
			signal: controller.signal
		});
		if (!response.ok) throw new AdapterError(`下载结果失败：HTTP ${response.status}`, "download-failed");
		const length = Number(response.headers.get("content-length") ?? "0");
		if (Number.isFinite(length) && length > MAX_ASSET_BYTES) throw new AdapterError(`结果文件过大（${Math.round(length / 1048576)}MB）`, "download-too-large");
		const buffer = Buffer.from(await response.arrayBuffer());
		if (buffer.byteLength > MAX_ASSET_BYTES) throw new AdapterError("结果文件过大", "download-too-large");
		return {
			bytes: buffer,
			mime: sniffMime(buffer, (response.headers.get("content-type") ?? "application/octet-stream").split(";")[0].trim())
		};
	} catch (error) {
		if (error instanceof AdapterError) throw error;
		throw new AdapterError(`下载结果失败：${error instanceof Error ? error.message : String(error)}`, "download-failed");
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", forward);
	}
}
/** Submit, and poll when the adapter declares a poll step. */
async function execute(adapter, model, params, options) {
	const fetchFn = options.fetchFn ?? fetch;
	const plan = planAdapterRequest(adapter, model, params);
	options.onProgress?.({
		phase: "submit",
		message: `提交到 ${adapter.label}`
	});
	const submitPayload = await callJson(fetchFn, plan.url, toInit(plan, params), "submit", SUBMIT_TIMEOUT_MS, options.signal);
	const poll = adapter.poll;
	if (poll === void 0) return { payload: submitPayload };
	const taskId = readFirstString(submitPayload, [
		poll.taskIdPath,
		"task_id",
		"id",
		"data.task_id",
		"data.id"
	]);
	if (taskId === void 0) {
		if ((adapter.result.urlPaths ?? []).some((path) => readJsonPath(submitPayload, path).length > 0)) return { payload: submitPayload };
		throw new AdapterError(`提交响应里找不到任务 ID（配置的路径：${poll.taskIdPath}）`, "no-task-id");
	}
	options.onProgress?.({
		phase: "poll",
		message: `任务 ${taskId} 已提交，等待渲染`,
		taskId
	});
	const interval = Math.max(1e3, poll.intervalMs ?? 3e3);
	const deadline = Date.now() + Math.max(3e4, poll.timeoutMs ?? 15 * 6e4);
	const done = new Set(poll.doneValues ?? DEFAULT_DONE_VALUES);
	const failed = new Set(poll.failedValues ?? DEFAULT_FAILED_VALUES);
	for (;;) {
		if (Date.now() > deadline) throw new AdapterError(`任务 ${taskId} 轮询超时（${Math.round((poll.timeoutMs ?? 9e5) / 1e3)}s）`, "poll-timeout");
		await sleep(interval, options.signal);
		const pollUrl = withQueryToken(adapter, resolveUrl(adapter, poll.path.replace(/\{\{\s*taskId\s*\}\}/g, taskId)));
		const headers = credentialedHeaders(adapter);
		const method = poll.method ?? "GET";
		let payload;
		try {
			payload = await callJson(fetchFn, pollUrl, {
				method,
				headers
			}, "poll", 6e4, options.signal);
		} catch (error) {
			if (error instanceof AdapterError && error.code === "retryable") continue;
			throw error;
		}
		const status = poll.statusPath === void 0 ? void 0 : readFirstString(payload, [poll.statusPath]);
		const errorText = poll.errorPath === void 0 ? void 0 : readFirstString(payload, [poll.errorPath]);
		const progressRaw = poll.progressPath === void 0 ? void 0 : readFirstString(payload, [poll.progressPath]);
		const progress = progressRaw === void 0 ? void 0 : Number(progressRaw);
		options.onProgress?.({
			phase: "poll",
			message: `任务 ${taskId}：${status ?? "进行中"}`,
			...Number.isFinite(progress) ? { progress } : {},
			taskId
		});
		if (status !== void 0 && failed.has(status)) throw new AdapterError(`任务失败：${status}${errorText === void 0 ? "" : `：${errorText}`}`, "task-failed");
		if (status !== void 0 && done.has(status)) return {
			taskId,
			payload
		};
		if (status === void 0) {
			if ((adapter.result.urlPaths ?? []).some((path) => readJsonPath(payload, path).length > 0) || (adapter.result.b64Paths ?? []).some((path) => readJsonPath(payload, path).length > 0)) return {
				taskId,
				payload
			};
		}
	}
}
/** Collect every asset reference the adapter's result spec points at. */
function readAssetRefs(adapter, payload) {
	const urls = [];
	for (const path of adapter.result.urlPaths ?? []) urls.push(...readStringList(payload, path));
	const b64 = [];
	for (const path of adapter.result.b64Paths ?? []) b64.push(...readStringList(payload, path));
	return {
		urls: [...new Set(urls)],
		b64: [...new Set(b64)],
		...adapter.result.mimePath === void 0 ? {} : (() => {
			const mime = readFirstString(payload, [adapter.result.mimePath]);
			return mime === void 0 ? {} : { mime };
		})(),
		...adapter.result.revisedPromptPath === void 0 ? {} : (() => {
			const revised = readFirstString(payload, [adapter.result.revisedPromptPath]);
			return revised === void 0 ? {} : { revisedPrompt: revised };
		})()
	};
}
/** Run one adapter render and normalize it into `GenerateResult`. */
async function runAdapterImage(adapter, model, params, options = {}) {
	const { payload } = await execute(adapter, model, params, options);
	const refs = readAssetRefs(adapter, payload);
	const images = [];
	for (const url of refs.urls) {
		options.onProgress?.({
			phase: "download",
			message: "下载生成结果"
		});
		const asset = await downloadAsset(adapter, url, options.fetchFn ?? fetch, options.signal);
		images.push({
			b64: asset.bytes.toString("base64"),
			mime: asset.mime,
			...refs.revisedPrompt === void 0 ? {} : { revisedPrompt: refs.revisedPrompt }
		});
	}
	for (const value of refs.b64) {
		const decoded = toBytes(value);
		images.push({
			b64: decoded.bytes.toString("base64"),
			mime: sniffMime(decoded.bytes, refs.mime ?? decoded.mime),
			...refs.revisedPrompt === void 0 ? {} : { revisedPrompt: refs.revisedPrompt }
		});
	}
	if (images.length === 0) throw new AdapterError("适配器没有从响应中取到任何图片；请检查“结果路径”（urlPaths / b64Paths）", "no-asset");
	return { images };
}
/** Run one adapter render and normalize it into `VideoEngineResult`. */
async function runAdapterVideo(adapter, model, params, options = {}) {
	const { payload } = await execute(adapter, model, params, options);
	const refs = readAssetRefs(adapter, payload);
	const videos = [];
	for (const url of refs.urls) {
		options.onProgress?.({
			phase: "download",
			message: "下载视频结果"
		});
		const asset = await downloadAsset(adapter, url, options.fetchFn ?? fetch, options.signal);
		videos.push({
			bytes: asset.bytes,
			mime: asset.mime,
			sourceUrl: url,
			...params.duration === void 0 ? {} : { duration: params.duration },
			...refs.revisedPrompt === void 0 ? {} : { revisedPrompt: refs.revisedPrompt }
		});
	}
	for (const value of refs.b64) {
		const decoded = toBytes(value);
		videos.push({
			bytes: decoded.bytes,
			mime: sniffMime(decoded.bytes, refs.mime ?? decoded.mime),
			sourceUrl: "",
			...params.duration === void 0 ? {} : { duration: params.duration }
		});
	}
	if (videos.length === 0) throw new AdapterError("适配器没有从响应中取到任何视频；请检查“结果路径”（urlPaths）", "no-asset");
	return { videos };
}
//#endregion
//#region src/studio/param-schema.ts
const KINDS = /* @__PURE__ */ new Set([
	"enum",
	"multi",
	"number",
	"boolean",
	"string",
	"longtext",
	"json"
]);
const ROLES = /* @__PURE__ */ new Set([
	"custom",
	"model",
	"prompt",
	"size",
	"aspect",
	"resolution",
	"duration",
	"n",
	"seed",
	"negativePrompt"
]);
const TARGETS = /* @__PURE__ */ new Set([
	"body",
	"query",
	"header"
]);
const SURFACES = /* @__PURE__ */ new Set([
	"image",
	"edit",
	"video"
]);
const ENCODES = /* @__PURE__ */ new Set([
	"raw",
	"string",
	"number",
	"boolean",
	"csv",
	"json",
	"bool01"
]);
/** Guard one unknown option. */
function normalizeOption(raw) {
	if (raw === null || typeof raw !== "object") return void 0;
	const record = raw;
	const value = record.value;
	if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return void 0;
	const patch = record.patch !== null && typeof record.patch === "object" && !Array.isArray(record.patch) ? record.patch : void 0;
	return {
		value,
		...typeof record.label === "string" && record.label.trim() !== "" ? { label: record.label } : {},
		...record.wire === void 0 ? {} : { wire: record.wire },
		...patch === void 0 ? {} : { patch },
		...typeof record.hint === "string" && record.hint.trim() !== "" ? { hint: record.hint } : {}
	};
}
/** Guard one unknown field, tolerating any extra keys. */
function normalizeField(raw, index) {
	if (raw === null || typeof raw !== "object") return void 0;
	const record = raw;
	const key = typeof record.key === "string" ? record.key.trim() : "";
	if (key === "") return void 0;
	const kind = typeof record.kind === "string" && KINDS.has(record.kind) ? record.kind : "string";
	const options = Array.isArray(record.options) ? record.options.flatMap((option) => {
		const parsed = normalizeOption(option);
		return parsed === void 0 ? [] : [parsed];
	}) : void 0;
	const surfaces = Array.isArray(record.surfaces) ? record.surfaces.filter((item) => typeof item === "string" && SURFACES.has(item)) : void 0;
	const role = typeof record.role === "string" && ROLES.has(record.role) ? record.role : "custom";
	const target = typeof record.target === "string" && TARGETS.has(record.target) ? record.target : "body";
	const encode = typeof record.encode === "string" && ENCODES.has(record.encode) ? record.encode : void 0;
	const numeric = (value) => typeof value === "number" && Number.isFinite(value) ? value : void 0;
	return {
		key,
		kind,
		role,
		target,
		...typeof record.label === "string" && record.label.trim() !== "" ? { label: record.label } : {},
		...typeof record.name === "string" && record.name.trim() !== "" ? { name: record.name } : {},
		...options === void 0 || options.length === 0 ? {} : { options },
		...record.default === void 0 ? {} : { default: record.default },
		...numeric(record.min) === void 0 ? {} : { min: numeric(record.min) },
		...numeric(record.max) === void 0 ? {} : { max: numeric(record.max) },
		...numeric(record.step) === void 0 ? {} : { step: numeric(record.step) },
		...typeof record.unit === "string" && record.unit.trim() !== "" ? { unit: record.unit } : {},
		...typeof record.placeholder === "string" && record.placeholder.trim() !== "" ? { placeholder: record.placeholder } : {},
		...typeof record.help === "string" && record.help.trim() !== "" ? { help: record.help } : {},
		...surfaces === void 0 || surfaces.length === 0 ? {} : { surfaces },
		...record.requires === "image" || record.requires === "video" || record.requires === "audio" ? { requires: record.requires } : {},
		...record.omitWhenDefault === true ? { omitWhenDefault: true } : {},
		...record.omitWhenEmpty === true ? { omitWhenEmpty: true } : {},
		...encode === void 0 ? {} : { encode },
		...record.always === true ? { always: true } : {},
		...index < 0 ? {} : {}
	};
}
/**
* Normalize a declared parameter list.
*
* Duplicate keys are collapsed on the first occurrence: two controls writing
* the same body key would silently fight, and the editor cannot show which one
* won.
* @param raw - untrusted value (settings document, HTTP body, preset).
* @returns the usable fields, in declaration order.
*/
function normalizeParamFields(raw) {
	if (!Array.isArray(raw)) return [];
	const seen = /* @__PURE__ */ new Set();
	const out = [];
	for (const [index, item] of raw.entries()) {
		const field = normalizeField(item, index);
		if (field === void 0 || seen.has(field.key)) continue;
		seen.add(field.key);
		out.push(field);
	}
	return out;
}
/**
* Fields a given surface should render.
* @param fields - declared fields.
* @param surface - image / edit / video.
* @param media - attached reference counts.
* @returns the fields to show, in declaration order.
*/
function fieldsForSurface(fields, surface, media = {}) {
	return fields.filter((field) => {
		if (field.surfaces !== void 0 && !field.surfaces.includes(surface)) return false;
		if (field.requires === "image" && (media.images ?? 0) === 0) return false;
		if (field.requires === "video" && (media.videos ?? 0) === 0) return false;
		if (field.requires === "audio" && (media.audios ?? 0) === 0) return false;
		return true;
	});
}
/** Human label for one field. */
function paramLabel(field) {
	return field.label ?? field.key;
}
/** Whether a value counts as "not set". */
function isEmpty(value) {
	if (value === void 0 || value === null) return true;
	if (typeof value === "string") return value.trim() === "";
	if (Array.isArray(value)) return value.length === 0;
	if (typeof value === "number") return !Number.isFinite(value);
	return false;
}
/**
* Coerce one raw value against its declared field.
* @param field - declared field.
* @param raw - user value.
* @returns `{ value }` on success, `{ warning }` when the value is unusable.
*/
function coerceParamValue(field, raw) {
	const label = paramLabel(field);
	switch (field.kind) {
		case "enum": {
			const options = field.options ?? [];
			if (options.length === 0) return { value: raw };
			const match = options.find((option) => option.value === raw) ?? options.find((option) => String(option.value) === String(raw));
			if (match === void 0) return { warning: `${label}：${String(raw)} 不在可选值内` };
			return { value: match.value };
		}
		case "multi": {
			const list = Array.isArray(raw) ? raw : isEmpty(raw) ? [] : [raw];
			const options = field.options ?? [];
			const values = [];
			for (const item of list) {
				const match = options.length === 0 ? item : options.find((option) => option.value === item || String(option.value) === String(item))?.value;
				if (match === void 0) return { warning: `${label}：${String(item)} 不在可选值内` };
				values.push(match);
			}
			return { value: values };
		}
		case "number": {
			const numeric = typeof raw === "number" ? raw : Number(String(raw).trim());
			if (!Number.isFinite(numeric)) return { warning: `${label} 需要数字` };
			const min = field.min ?? Number.NEGATIVE_INFINITY;
			const max = field.max ?? Number.POSITIVE_INFINITY;
			return { value: Math.min(max, Math.max(min, numeric)) };
		}
		case "boolean": {
			if (typeof raw === "boolean") return { value: raw };
			const text = String(raw).trim().toLowerCase();
			if (text === "true" || text === "1" || text === "yes" || text === "on") return { value: true };
			if (text === "false" || text === "0" || text === "no" || text === "off") return { value: false };
			return { warning: `${label} 需要布尔值` };
		}
		case "json":
			if (typeof raw !== "string") return { value: raw };
			if (raw.trim() === "") return { value: void 0 };
			try {
				return { value: JSON.parse(raw) };
			} catch {
				return { warning: `${label} 不是合法 JSON` };
			}
		default: return { value: typeof raw === "string" ? raw : String(raw) };
	}
}
/** Encode one resolved value for the wire. */
function encodeValue(field, value) {
	if (field.kind === "enum") {
		const option = (field.options ?? []).find((item) => item.value === value);
		if (option?.wire !== void 0) return option.wire;
	}
	if (field.kind === "multi" && Array.isArray(value)) {
		const tokens = value.map((item) => (field.options ?? []).find((option) => option.value === item)?.wire ?? item);
		return field.encode === "csv" ? tokens.map((token) => String(token)).join(",") : tokens;
	}
	switch (field.encode) {
		case "string": return String(value);
		case "number": return Number(value);
		case "boolean": return Boolean(value);
		case "bool01": return value === true || value === "true" ? 1 : 0;
		case "csv": return Array.isArray(value) ? value.map((item) => String(item)).join(",") : String(value);
		case "json": return JSON.stringify(value);
		default: return value;
	}
}
/** Body patch for every active enum / multi choice. */
function optionPatches(fields, values) {
	const patch = {};
	for (const field of fields) {
		if (field.kind !== "enum" && field.kind !== "multi") continue;
		const value = values[field.key];
		const active = field.kind === "multi" ? Array.isArray(value) ? value : [] : [value];
		for (const item of active) {
			const option = (field.options ?? []).find((candidate) => candidate.value === item);
			if (option?.patch !== void 0) Object.assign(patch, option.patch);
		}
	}
	return patch;
}
/**
* Resolve one parameter state into panel values, canonical roles and wire extras.
*
* Defaults are applied only for fields the user has not set, so a cleared field
* (empty string) stays cleared instead of snapping back.
* @param fields - fields visible on this surface.
* @param state - user values keyed by field key.
* @returns the resolution result; `warnings` explains every rejected value.
*/
function resolveStudioParams(fields, state) {
	const values = {};
	const roles = {};
	const body = {};
	const query = {};
	const headers = {};
	const warnings = [];
	for (const field of fields) {
		const coerced = coerceParamValue(field, state[field.key] !== void 0 ? state[field.key] : field.default);
		if (coerced.warning !== void 0) {
			warnings.push(coerced.warning);
			continue;
		}
		const value = coerced.value;
		values[field.key] = value;
		if (roleOf(field) !== "custom" && value !== void 0) assignRole(roles, field, value);
		if (!field.always && (isEmpty(value) || field.omitWhenDefault && field.default !== void 0 && String(value) === String(field.default))) continue;
		const encoded = encodeValue(field, value);
		if (encoded === void 0) continue;
		const name = field.name ?? field.key;
		if (field.target === "header") headers[name] = String(encoded);
		else if (field.target === "query") query[name] = String(encoded);
		else body[name] = encoded;
	}
	const patch = optionPatches(fields, values);
	return {
		values,
		roles,
		extras: {
			...Object.keys(body).length === 0 && Object.keys(patch).length === 0 ? {} : { body: {
				...body,
				...patch
			} },
			...Object.keys(query).length === 0 ? {} : { query },
			...Object.keys(headers).length === 0 ? {} : { headers }
		},
		warnings
	};
}
/** Role of a field, defaulting to `custom`. */
function roleOf(field) {
	return field.role ?? "custom";
}
/** Write one value into its canonical slot. */
function assignRole(roles, field, value) {
	switch (roleOf(field)) {
		case "model":
			roles.model = String(value);
			return;
		case "prompt":
			roles.prompt = String(value);
			return;
		case "size":
			roles.size = String(value);
			return;
		case "aspect":
			roles.aspect = String(value);
			return;
		case "resolution":
			roles.resolution = String(value);
			return;
		case "duration":
			roles.duration = Number(value);
			return;
		case "n":
			roles.n = Number(value);
			return;
		case "seed":
			roles.seed = Number(value);
			return;
		case "negativePrompt":
			roles.negativePrompt = String(value);
			return;
		default: return;
	}
}
//#endregion
//#region src/studio/channel-adapters.ts
/**
* dsh-imagegen-studio — a settings channel seen as a studio adapter.
*
* The settings page owns the catalogue: one endpoint, one key, one list of
* models per media kind. The studio surfaces (普通生图 / 无限画布) speak
* `AdapterProfile` instead, because they need per-model knobs the channel row
* does not describe. This module is the bridge.
*
* The channel decides WHICH models exist; the stored override record only adds
* what the channel cannot express — declared parameters, aspect ratios,
* resolutions, reference-image limits and the wire contract. So removing a
* model from the channel removes it from the studio too, and the endpoint and
* key can never drift away from the channel they were configured in.
*
* Pure and browser-safe on purpose: the host routes and the settings drawer run
* the same functions, so a channel that has never been saved shows exactly the
* defaults the host would derive for it.
*/
/** Field map for an OpenAI-compatible gateway: the stock vocabulary. */
const OPENAI_FIELDS = {
	model: DEFAULT_FIELDS.model,
	prompt: DEFAULT_FIELDS.prompt,
	size: DEFAULT_FIELDS.size,
	aspect: DEFAULT_FIELDS.aspect,
	resolution: DEFAULT_FIELDS.resolution,
	duration: DEFAULT_FIELDS.duration,
	n: DEFAULT_FIELDS.n,
	image: DEFAULT_FIELDS.image,
	imageMode: DEFAULT_FIELDS.imageMode,
	firstFrame: DEFAULT_FIELDS.firstFrame,
	lastFrame: DEFAULT_FIELDS.lastFrame
};
/** Suffix that separates one channel's video adapter from its image adapter. */
const VIDEO_ID_SUFFIX = "#video";
/** The id of the adapter derived from one channel and one media kind. */
function channelAdapterId(channelId, kind) {
	return kind === "video" ? `${channelId}${VIDEO_ID_SUFFIX}` : channelId;
}
/** Split a derived adapter id back into its channel and media kind. */
function splitChannelAdapterId(id) {
	return id.endsWith(VIDEO_ID_SUFFIX) ? {
		channelId: id.slice(0, -6),
		kind: "video"
	} : {
		channelId: id,
		kind: "image"
	};
}
/** The models a channel declares for one media kind. */
function channelModels(channel, kind) {
	return ((kind === "video" ? channel.videoModels : channel.models) ?? []).map((model) => ({
		alias: model.alias,
		id: model.id
	}));
}
/** The adapter label shown in the studio pickers. */
function channelAdapterLabel(channel, kind) {
	const name = (channel.name ?? "").trim() === "" ? "未命名渠道" : (channel.name ?? "").trim();
	return kind === "video" ? `${name} · 视频` : name;
}
/** The path the stock engine appends to a channel's base URL. */
function submitSuffix(kind) {
	return kind === "video" ? "videos" : "images/generations";
}
/**
* The submit paths the stock engine knows, longest first.
*
* `apiUrlFull` names the exact SUBMIT url, so the base has to be recovered from
* it before anything else can be resolved against it: the stock video engine
* does the same when it derives a status URL (#5).
*/
const EXACT_TAILS = {
	video: ["/videos/generations", "/videos"],
	image: ["/images/generations", "/images/edits"]
};
/** The base URL implied by an exact submit URL, so polling keeps its prefix. */
function baseOfExact(url, kind) {
	const trimmed = url.replace(/\/+$/, "");
	for (const tail of EXACT_TAILS[kind]) if (trimmed.endsWith(tail)) return trimmed.slice(0, trimmed.length - tail.length);
	return trimmed;
}
/**
* The adapter a channel implies before anyone edited a single parameter.
*
* Endpoint resolution mirrors the stock engine: `apiUrl` is the base and
* `/images/generations` (or `/videos`) is appended — unless the channel says
* the URL is already exact, in which case the URL itself is the submit path.
* @param channel - the settings channel.
* @param kind - image or video pipeline.
* @param apiKey - the host-side key, when one is known.
*/
function defaultChannelAdapter(channel, kind, apiKey = "") {
	const url = channel.apiUrl.trim();
	const suffix = submitSuffix(kind);
	const exact = channel.apiUrlFull === true;
	const path = url === "" ? suffix : exact || url.endsWith(`/${suffix}`) ? url : suffix;
	const now = Date.now();
	const models = channelModels(channel, kind).map((model) => ({
		alias: model.alias,
		id: model.id
	}));
	const common = {
		id: channelAdapterId(channel.id, kind),
		label: channelAdapterLabel(channel, kind),
		kind,
		baseUrl: url === "" ? "" : exact ? baseOfExact(url, kind) : url,
		auth: {
			style: "bearer",
			token: apiKey.trim()
		},
		submit: {
			method: "POST",
			path,
			contentType: "json"
		},
		result: kind === "video" ? {
			urlPaths: [
				"video_url",
				"url",
				"metadata.url",
				"data[].url"
			],
			mimePath: "mime"
		} : {
			urlPaths: [
				"data[].url",
				"data[].b64_json",
				"url"
			],
			b64Paths: ["data[].b64_json"],
			revisedPromptPath: "data[].revised_prompt"
		},
		fields: OPENAI_FIELDS,
		models,
		createdAt: now,
		updatedAt: now
	};
	return kind === "video" ? {
		...common,
		poll: {
			path: "videos/{{taskId}}",
			taskIdPath: "id",
			statusPath: "status",
			progressPath: "progress",
			errorPath: "error"
		}
	} : common;
}
/** The editable half of a model: everything except who it is. */
function modelOverride(override) {
	if (override === void 0) return {};
	const { alias: _alias, id: _id, ...rest } = override;
	return rest;
}
/** Merge the stored override of one model onto the channel's catalogue entry. */
function mergeModel(base, override) {
	return {
		...base,
		...modelOverride(override)
	};
}
/**
* Derive one adapter from a channel, layering the stored override on top.
*
* Returns `undefined` when the channel declares no model of that kind: a
* channel without video models has no video adapter to pick.
* @param channel - the settings channel.
* @param kind - image or video pipeline.
* @param stored - the stored override record for this adapter id, if any.
* @param apiKey - the host-side key, when one is known.
*/
function deriveChannelAdapter(channel, kind, stored, apiKey = "") {
	const base = defaultChannelAdapter(channel, kind, apiKey);
	if (base.models.length === 0) return void 0;
	if (stored === void 0) return base;
	const byAlias = /* @__PURE__ */ new Map();
	for (const model of stored.models) {
		byAlias.set(model.alias, model);
		if (!byAlias.has(model.id)) byAlias.set(model.id, model);
	}
	const token = apiKey.trim() !== "" ? apiKey.trim() : stored.auth.token ?? "";
	return {
		...base,
		auth: {
			...base.auth,
			...stored.auth,
			token
		},
		submit: {
			...base.submit,
			...stored.submit
		},
		...stored.poll === void 0 ? {} : { poll: stored.poll },
		result: {
			...base.result,
			...stored.result
		},
		fields: stored.fields ?? base.fields,
		...stored.note === void 0 ? {} : { note: stored.note },
		createdAt: stored.createdAt,
		updatedAt: base.updatedAt,
		models: base.models.map((model) => mergeModel(model, byAlias.get(model.alias) ?? byAlias.get(model.id)))
	};
}
/**
* Every adapter the current channels imply, in channel order.
* @param channels - the live settings channels.
* @param stored - the override records read from `adapters.json`.
* @param keyOf - host-side key lookup; omit in the browser.
*/
function deriveChannelAdapters(channels, stored, keyOf) {
	const byId = new Map(stored.map((adapter) => [adapter.id, adapter]));
	const out = [];
	for (const channel of channels) for (const kind of ["image", "video"]) {
		const id = channelAdapterId(channel.id, kind);
		const derived = deriveChannelAdapter(channel, kind, byId.get(id), keyOf?.(channel.id) ?? "");
		if (derived !== void 0) out.push(derived);
	}
	return out;
}
//#endregion
//#region src/studio/store.ts
/**
* Studio adapter override persistence.
*
* The channels in the settings document own the endpoint, the key and the model
* catalogue. What this file stores is the part a channel row cannot describe:
* per-model parameter lists, ratios, reference limits, and the wire contract of
* that channel's gateway (submit path, poll spec, result paths, field names).
* `channel-adapters.ts` joins the two at read time, so this store never carries
* a credential and never decides which models exist — deleting a model in the
* settings page removes it from the studio as well.
*
* Writes are atomic (tmp + rename) because the drawer saves in batches and a
* torn file would look like "all my parameters vanished".
*/
/** Store schema version; bumped only on an incompatible reshape. */
const STORE_VERSION = 1;
/** Largest accepted profile file, which also bounds a hostile local write. */
const MAX_STORE_BYTES = 8 * 1024 * 1024;
/** Where this module keeps its state. */
function studioRoot() {
	return path.join(imageDataRoot(), "studio");
}
/** Where generated studio assets are written before being served. */
function studioOutDir() {
	return path.join(studioRoot(), "out");
}
/** The adapter store file. */
function storePath() {
	return path.join(studioRoot(), "adapters.json");
}
/**
* Reduce a credential to something a screenshot can survive.
* @param token - the real credential.
* @returns a mask that reveals only whether one is set and its last 4 chars.
*/
function maskToken(token) {
	const trimmed = token.trim();
	if (trimmed === "") return "";
	return `••••${trimmed.slice(-4)}`;
}
/**
* Strip the credential before the profile crosses into the browser.
* @param profile - stored profile.
* @returns the same profile with the token masked.
*/
function maskProfile(profile) {
	const { auth, ...rest } = profile;
	const { token, ...authRest } = auth;
	return {
		...rest,
		auth: {
			...authRest,
			masked: maskToken(token),
			hasToken: token.trim() !== ""
		}
	};
}
/** Cap on a single string field, to keep a pasted blob from bloating the file. */
function clampString(value, max = 4096) {
	if (typeof value !== "string") return "";
	return value.length > max ? value.slice(0, max) : value;
}
/** Read one optional string field, defaulting to ''. */
function optionalString(value, max = 4096) {
	const text = clampString(value, max).trim();
	return text === "" ? void 0 : text;
}
/** Keep only string entries of a list, trimmed, bounded. */
function stringList(value, max = 64) {
	if (!Array.isArray(value)) return void 0;
	const out = [];
	for (const entry of value) {
		const text = typeof entry === "string" ? entry.trim() : typeof entry === "number" ? String(entry) : "";
		if (text !== "" && !out.includes(text)) out.push(text.slice(0, 128));
		if (out.length >= max) break;
	}
	return out.length === 0 ? void 0 : out;
}
/** Keep only finite positive integers from a list (durations). */
function numberList(value, max = 64) {
	if (!Array.isArray(value)) return void 0;
	const out = [];
	for (const entry of value) {
		const num = typeof entry === "number" ? entry : Number(entry);
		if (Number.isFinite(num) && num > 0 && !out.includes(num)) out.push(num);
		if (out.length >= max) break;
	}
	return out.length === 0 ? void 0 : out;
}
/** Sanitize a field map: unknown keys dropped, empty strings dropped. */
function normalizeFields(raw) {
	if (raw === null || typeof raw !== "object") return void 0;
	const input = raw;
	const out = {};
	for (const key of [
		"model",
		"prompt",
		"size",
		"aspect",
		"resolution",
		"duration",
		"n",
		"seed",
		"negativePrompt",
		"image",
		"firstFrame",
		"lastFrame",
		"refVideos",
		"refAudios"
	]) {
		if (input[key] === null) {
			out[key] = null;
			continue;
		}
		const text = optionalString(input[key], 128);
		if (text !== void 0) out[key] = text;
	}
	const mode = input.imageMode;
	if (mode === "data-uri-array" || mode === "base64-array" || mode === "url-array" || mode === "single-data-uri" || mode === "first-last-object" || mode === "multipart-file") out.imageMode = mode;
	if (input.sizeByRatio !== null && typeof input.sizeByRatio === "object") {
		const table = {};
		for (const [ratio, size] of Object.entries(input.sizeByRatio)) {
			const text = optionalString(size, 64);
			if (text !== void 0) table[clampString(ratio, 32)] = text;
		}
		if (Object.keys(table).length > 0) out.sizeByRatio = table;
	}
	return Object.keys(out).length === 0 ? void 0 : out;
}
/**
* Sanitize one model spec.
* @param raw - untrusted input.
* @param index - position, used to synthesise a missing alias/id.
* @returns a model spec, or undefined when nothing usable is present.
*/
function normalizeModel(raw, index) {
	if (raw === null || typeof raw !== "object") return void 0;
	const input = raw;
	const id = clampString(input.id, 256).trim();
	const alias = clampString(input.alias, 256).trim();
	if (id === "" && alias === "") return void 0;
	const out = {
		alias: alias === "" ? id : alias,
		id: id === "" ? alias : id
	};
	const ratios = stringList(input.aspectRatios);
	if (ratios !== void 0) out.aspectRatios = ratios;
	const resolutions = stringList(input.resolutions);
	if (resolutions !== void 0) out.resolutions = resolutions;
	const durations = numberList(input.durations);
	if (durations !== void 0) out.durations = durations;
	if (typeof input.maxRefImages === "number" && Number.isFinite(input.maxRefImages) && input.maxRefImages >= 0) out.maxRefImages = Math.min(16, Math.floor(input.maxRefImages));
	if (input.extra !== null && typeof input.extra === "object" && !Array.isArray(input.extra)) out.extra = input.extra;
	const fields = normalizeFields(input.fieldOverrides);
	if (fields !== void 0) out.fieldOverrides = fields;
	const params = normalizeParamFields(input.params);
	if (params.length > 0) out.params = params;
	const priceNote = optionalString(input.priceNote, 128);
	if (priceNote !== void 0) out.priceNote = priceNote;
	return {
		...out,
		...index < 0 ? {} : {}
	};
}
/**
* Sanitize one whole profile.
* @param raw - untrusted input (store file, or a request body).
* @param existing - the profile being replaced, used to keep an unsent token.
* @returns the profile plus warnings about anything that had to be dropped.
*/
function normalizeProfile(raw, existing) {
	const warnings = [];
	if (raw === null || typeof raw !== "object") return { warnings: ["配置不是一个对象"] };
	const input = raw;
	const kind = input.kind === "video" ? "video" : "image";
	const label = clampString(input.label, 120).trim() || (kind === "video" ? "未命名视频通道" : "未命名图片通道");
	const baseUrl = clampString(input.baseUrl, 512).trim();
	if (baseUrl === "") return { warnings: ["缺少 API 地址"] };
	if (!/^https?:\/\//i.test(baseUrl)) return { warnings: ["API 地址必须以 http:// 或 https:// 开头"] };
	const authInput = input.auth !== null && typeof input.auth === "object" ? input.auth : {};
	const style = authInput.style === "header" || authInput.style === "query" || authInput.style === "none" ? authInput.style : "bearer";
	const sentToken = clampString(authInput.token, 8192).trim();
	const token = sentToken !== "" ? sentToken : existing?.auth.token ?? "";
	if (style !== "none" && token === "") warnings.push("未填写密钥：该通道在填好密钥前无法调用");
	const submitInput = input.submit !== null && typeof input.submit === "object" ? input.submit : {};
	const submitMethod = submitInput.method === "GET" ? "GET" : "POST";
	const submitPath = clampString(submitInput.path, 1024).trim() || (kind === "video" ? "/v1/videos" : "/v1/images/generations");
	const contentType = submitInput.contentType === "multipart" || submitInput.contentType === "query" ? submitInput.contentType : "json";
	const headers = {};
	if (submitInput.headers !== null && typeof submitInput.headers === "object") for (const [name, value] of Object.entries(submitInput.headers)) {
		const text = optionalString(value, 1024);
		if (text !== void 0) headers[clampString(name, 128)] = text;
	}
	const bodyTemplate = optionalString(submitInput.bodyTemplate, 16384);
	const pollInput = input.poll !== null && typeof input.poll === "object" ? input.poll : void 0;
	const pollPath = pollInput === void 0 ? "" : clampString(pollInput.path, 1024).trim();
	let poll;
	if (pollInput !== void 0 && pollPath !== "") poll = {
		path: pollPath,
		...pollInput.method === "POST" ? { method: "POST" } : {},
		taskIdPath: clampString(pollInput.taskIdPath, 256).trim() || "id",
		...optionalString(pollInput.statusPath, 256) === void 0 ? {} : { statusPath: clampString(pollInput.statusPath, 256) },
		...stringList(pollInput.doneValues) === void 0 ? {} : { doneValues: stringList(pollInput.doneValues) },
		...stringList(pollInput.failedValues) === void 0 ? {} : { failedValues: stringList(pollInput.failedValues) },
		...optionalString(pollInput.progressPath, 256) === void 0 ? {} : { progressPath: clampString(pollInput.progressPath, 256) },
		...optionalString(pollInput.errorPath, 256) === void 0 ? {} : { errorPath: clampString(pollInput.errorPath, 256) },
		...typeof pollInput.intervalMs === "number" && pollInput.intervalMs >= 500 ? { intervalMs: Math.min(6e4, pollInput.intervalMs) } : {},
		...typeof pollInput.timeoutMs === "number" && pollInput.timeoutMs >= 1e3 ? { timeoutMs: Math.min(36e5, pollInput.timeoutMs) } : {}
	};
	const resultInput = input.result !== null && typeof input.result === "object" ? input.result : {};
	const urlPaths = stringList(resultInput.urlPaths, 16);
	const b64Paths = stringList(resultInput.b64Paths, 16);
	if (urlPaths === void 0 && b64Paths === void 0) warnings.push("未配置结果字段路径：默认按常见字段（data[].url / url / video_url …）自动探测");
	const modelsRaw = Array.isArray(input.models) ? input.models : [];
	const models = [];
	for (const [index, entry] of modelsRaw.entries()) {
		const model = normalizeModel(entry, index);
		if (model === void 0) {
			warnings.push(`第 ${index + 1} 个模型缺少 id，已跳过`);
			continue;
		}
		models.push(model);
	}
	if (models.length === 0) warnings.push("该通道还没有模型：先「发现模型」或手填一个");
	const now = Date.now();
	return {
		profile: {
			id: clampString(input.id, 64).trim() || `adapter-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
			label,
			kind,
			baseUrl: baseUrl.replace(/\/+$/, ""),
			auth: {
				style,
				...optionalString(authInput.headerName, 128) === void 0 ? {} : { headerName: clampString(authInput.headerName, 128) },
				...optionalString(authInput.queryName, 128) === void 0 ? {} : { queryName: clampString(authInput.queryName, 128) },
				token,
				...optionalString(authInput.prefix, 64) === void 0 ? {} : { prefix: clampString(authInput.prefix, 64) }
			},
			submit: {
				method: submitMethod,
				path: submitPath,
				contentType,
				...Object.keys(headers).length === 0 ? {} : { headers },
				...bodyTemplate === void 0 ? {} : { bodyTemplate }
			},
			...poll === void 0 ? {} : { poll },
			result: {
				...urlPaths === void 0 ? {} : { urlPaths },
				...b64Paths === void 0 ? {} : { b64Paths },
				...optionalString(resultInput.mimePath, 256) === void 0 ? {} : { mimePath: clampString(resultInput.mimePath, 256) },
				...optionalString(resultInput.revisedPromptPath, 256) === void 0 ? {} : { revisedPromptPath: clampString(resultInput.revisedPromptPath, 256) },
				...resultInput.downloadAuth === true ? { downloadAuth: true } : {}
			},
			...normalizeFields(input.fields) === void 0 ? {} : { fields: normalizeFields(input.fields) },
			models,
			...optionalString(input.note, 2048) === void 0 ? {} : { note: clampString(input.note, 2048) },
			createdAt: typeof input.createdAt === "number" ? input.createdAt : existing?.createdAt ?? now,
			updatedAt: now
		},
		warnings
	};
}
/** Read the store file, tolerating a missing or corrupt file. */
async function readAdapters() {
	try {
		if ((await fs.stat(storePath())).size > MAX_STORE_BYTES) return [];
		const raw = await fs.readFile(storePath(), "utf8");
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed.adapters)) return [];
		const out = [];
		for (const entry of parsed.adapters) {
			const { profile } = normalizeProfile(entry);
			if (profile !== void 0) out.push(profile);
		}
		return out;
	} catch {
		return [];
	}
}
/** Replace the whole list, atomically. */
async function writeAdapters(adapters) {
	await fs.mkdir(studioRoot(), { recursive: true });
	const target = storePath();
	const temp = `${target}.${process.pid.toString(36)}.tmp`;
	const payload = {
		version: STORE_VERSION,
		adapters: [...adapters]
	};
	await fs.writeFile(temp, JSON.stringify(payload, null, 2), "utf8");
	await fs.rename(temp, target);
}
/**
* Insert or replace one profile.
*
* The credential belongs to the channel row, never to this record, so a caller
* writing on the channel's behalf passes `forgetToken`: a key stored by an
* older build is then dropped instead of silently inherited.
* @param raw - untrusted input from the panel.
* @param options - `forgetToken` clears the stored key for this id.
* @returns the saved profile, masked for the browser, plus warnings.
*/
async function saveAdapter(raw, options = {}) {
	const list = await readAdapters();
	const id = raw !== null && typeof raw === "object" && typeof raw.id === "string" ? raw.id : "";
	const found = list.find((entry) => entry.id === id);
	const { profile, warnings } = normalizeProfile(raw, found === void 0 || options.forgetToken !== true ? found : {
		...found,
		auth: {
			...found.auth,
			token: ""
		}
	});
	if (profile === void 0) return { warnings };
	await writeAdapters(found === void 0 ? [...list, profile] : list.map((entry) => entry.id === profile.id ? profile : entry));
	return {
		profile: maskProfile(profile),
		warnings
	};
}
/**
* Delete one profile by id.
* @param id - profile id.
* @returns true when something was removed.
*/
async function removeAdapter(id) {
	const list = await readAdapters();
	const next = list.filter((entry) => entry.id !== id);
	if (next.length === list.length) return false;
	await writeAdapters(next);
	return true;
}
//#endregion
//#region src/studio/tasks.ts
/**
* In-memory task registry for the studio panel.
*
* A video render takes minutes and a continuation chain takes tens of minutes,
* so the panel cannot hold an HTTP request open for it. Every generation starts
* here, returns an id, and is polled; the same id is what the Cancel button
* aborts.
*
* Deliberately in-memory: a task is worthless after the host process restarts
* (its render connection is gone with it) and a persisted task would only
* resurrect a spinner that can never finish. The *results* are persisted, by the
* generation code, as files — that is what survives.
*/
/** Task caps: a panel left open for a week must not grow without bound. */
const MAX_TASKS = 96;
/** Finished tasks are dropped after this long. */
const TASK_TTL_MS = 1800 * 1e3;
/** The registry. */
const tasks = /* @__PURE__ */ new Map();
/** Drop finished tasks past their TTL, then the oldest overflow. */
function prune() {
	const now = Date.now();
	for (const [id, task] of tasks) if ((task.state === "done" || task.state === "error" || task.state === "cancelled") && now - task.updatedAt > TASK_TTL_MS) tasks.delete(id);
	while (tasks.size > MAX_TASKS) {
		const oldest = [...tasks.values()].filter((task) => task.state !== "running" && task.state !== "queued").sort((left, right) => left.updatedAt - right.updatedAt)[0];
		if (oldest === void 0) break;
		tasks.delete(oldest.id);
	}
}
/**
* Register a task and hand the caller its id plus the controller to pass down.
* @param kind - which pipeline this is.
* @returns the new task id and its abort controller.
*/
function createStudioTask(kind) {
	prune();
	const id = randomUUID();
	const now = Date.now();
	const controller = new AbortController();
	tasks.set(id, {
		id,
		kind,
		state: "queued",
		phase: "排队",
		message: "已受理",
		createdAt: now,
		updatedAt: now,
		controller
	});
	return {
		id,
		controller
	};
}
/**
* Advance a task.
* @param id - task id.
* @param patch - fields to overwrite.
*/
function updateStudioTask(id, patch) {
	const task = tasks.get(id);
	if (task === void 0) return;
	if (patch.state !== void 0) task.state = patch.state;
	if (patch.phase !== void 0) task.phase = patch.phase;
	if (patch.message !== void 0) task.message = patch.message;
	if (patch.progress !== void 0) task.progress = Math.max(0, Math.min(100, patch.progress));
	if (patch.result !== void 0) task.result = patch.result;
	if (patch.error !== void 0) task.error = patch.error;
	task.updatedAt = Date.now();
}
/**
* Read one task for the browser (the abort controller never leaves the host).
* @param id - task id.
* @returns the view, or undefined when it never existed / already expired.
*/
function readStudioTask(id) {
	const task = tasks.get(id);
	if (task === void 0) return void 0;
	const { controller: _controller, ...view } = task;
	return view;
}
/**
* Ask a running task to stop.
* @param id - task id.
* @returns true when the task was known and still running.
*/
function cancelStudioTask(id) {
	const task = tasks.get(id);
	if (task === void 0) return false;
	if (task.state === "done" || task.state === "error" || task.state === "cancelled") return false;
	task.controller.abort();
	task.state = "cancelled";
	task.phase = "已取消";
	task.message = "已取消";
	task.updatedAt = Date.now();
	return true;
}
//#endregion
//#region src/clip-compose.ts
/**
* Local clip stitching (ffmpeg) — the host half of the canvas 「拼接视频」 action.
*
* One {@link ClipComposer} covers every step the runner must not know about:
* locate ffmpeg/ffprobe, turn a served clip URL back into a local file, run the
* pipeline, and persist the result into the video history. Keeping it as one
* injected seam is what lets the smoke suites drive the whole compose path with
* a fake — offline, with no ffmpeg installed and no network.
*
* Three measured facts shape this file (see `docs/compose-contract.md` §1/§5):
*
*  - the running host's PATH is `/usr/bin:/bin:/usr/sbin:/sbin`, which does NOT
*    contain `~/.local/bin`, so a bare `ffmpeg` is a guaranteed ENOENT. Every
*    executable is resolved through absolute-path candidates only.
*  - `-c copy` + the concat demuxer exits 0 on a silently corrupt file when the
*    inputs differ in size or frame rate, so the pipeline always re-encodes
*    through an explicit filtergraph.
*  - referencing an audio stream an input does not have fails the whole
*    filtergraph, while `anullsrc` without `d=` is an infinite source whose
*    concat never advances (OOM, exit 137). So every input is probed for audio
*    and for its real duration before the graph is built.
*
* Process handling copies `src/skill-store.ts` `run()`: no shell, args as an
* array, `stdio: ['ignore','pipe','pipe']`, bounded output, a timer that kills
* the child, and `error`/`close` settling behind a `settled` flag.
*/
/** Target canvas geometry: the format every input is normalized onto. */
const TARGET_WIDTH = 1280;
const TARGET_HEIGHT = 720;
const TARGET_FPS = 30;
const TARGET_SAMPLE_RATE = 48e3;
/** Cap on captured process output, per stream (bad inputs can be very loud). */
const MAX_PROCESS_OUTPUT$1 = 8e3;
/** Cap on the diagnostic tail kept for one failure message. */
const MAX_ERROR_TAIL = 600;
/** Wall-clock cap for one transcode. Cancellation is the AbortSignal's job. */
const STITCH_TIMEOUT_MS = 30 * 6e4;
/** Wall-clock cap for one probe (audio presence, duration). */
const PROBE_TIMEOUT_MS = 6e4;
/**
* Absolute directories searched for `ffmpeg`/`ffprobe`, in order.
*
* `~/.local/bin` first because that is where this machine actually keeps them;
* a bare command name is never tried, since the host's PATH cannot see it.
*/
function localVideoToolDirs() {
	const dirs = [
		path.join(homedir(), ".local", "bin"),
		"/opt/homebrew/bin",
		"/usr/local/bin",
		"/usr/bin"
	];
	return [...new Set(dirs)];
}
/** Last printable characters of process output, for an error message. */
function tail(text) {
	const trimmed = text.trim();
	if (trimmed === "") return "(no output)";
	return trimmed.length <= MAX_ERROR_TAIL ? trimmed : `…${trimmed.slice(-600)}`;
}
/**
* Run one child process without a shell and collect its bounded output.
*
* Rejects on spawn failure, on the timeout, and on abort; a non-zero exit is
* reported through `code` so callers can distinguish "ran and refused" from
* "never ran". Modeled on `src/skill-store.ts` `run()`.
* @param command - absolute executable path.
* @param args - argument vector, never a shell string.
* @param options - timeout and cancellation.
*/
function runProcess(command, args, options) {
	const label = path.basename(command);
	return new Promise((resolve, reject) => {
		let settled = false;
		let timer;
		let stdout = "";
		let stderr = "";
		const child = spawn(command, [...args], {
			windowsHide: true,
			stdio: [
				"ignore",
				"pipe",
				"pipe"
			]
		});
		child.stdout.on("data", (chunk) => {
			if (stdout.length < MAX_PROCESS_OUTPUT$1) stdout += chunk.toString("utf8");
		});
		child.stderr.on("data", (chunk) => {
			if (stderr.length < MAX_PROCESS_OUTPUT$1) stderr += chunk.toString("utf8");
		});
		const finish = (settle) => {
			if (settled) return;
			settled = true;
			if (timer !== void 0) clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
			settle();
		};
		function onAbort() {
			child.kill();
			finish(() => reject(/* @__PURE__ */ new Error(`${label} was cancelled`)));
		}
		timer = setTimeout(() => {
			child.kill();
			finish(() => reject(/* @__PURE__ */ new Error(`${label} timed out after ${options.timeoutMs}ms`)));
		}, options.timeoutMs);
		timer.unref?.();
		if (options.signal !== void 0) {
			if (options.signal.aborted) {
				onAbort();
				return;
			}
			options.signal.addEventListener("abort", onAbort, { once: true });
		}
		child.on("error", (error) => finish(() => reject(/* @__PURE__ */ new Error(`${label} could not start: ${error.message}`))));
		child.on("close", (code) => finish(() => resolve({
			code: code ?? -1,
			stdout,
			stderr
		})));
	});
}
/** First executable candidate for one tool name, or undefined. */
function findTool(name) {
	for (const dir of localVideoToolDirs()) {
		const candidate = path.join(dir, name);
		try {
			if (!statSync(candidate).isFile()) continue;
			accessSync(candidate, constants.X_OK);
			return candidate;
		} catch {}
	}
}
function describeTools(found) {
	return `ffmpeg: ${found.ffmpeg ?? "not found"}; ffprobe: ${found.ffprobe ?? "not found"} (searched ${localVideoToolDirs().join(", ")})`;
}
async function probeAudio(ffprobe, file, signal) {
	const result = await runProcess(ffprobe, [
		"-v",
		"error",
		"-select_streams",
		"a",
		"-show_entries",
		"stream=codec_name",
		"-of",
		"csv=p=0",
		file
	], {
		timeoutMs: PROBE_TIMEOUT_MS,
		signal
	});
	if (result.code !== 0) throw new Error(`ffprobe could not read ${file}: ${tail(result.stderr)}`);
	return result.stdout.trim() !== "";
}
async function probeDuration(ffprobe, file, signal) {
	const result = await runProcess(ffprobe, [
		"-v",
		"error",
		"-show_entries",
		"format=duration",
		"-of",
		"csv=p=0",
		file
	], {
		timeoutMs: PROBE_TIMEOUT_MS,
		signal
	});
	if (result.code !== 0) throw new Error(`ffprobe could not measure ${file}: ${tail(result.stderr)}`);
	const seconds = Number.parseFloat(result.stdout.trim());
	return Number.isFinite(seconds) && seconds > 0 ? seconds : void 0;
}
async function probeClip(ffprobe, file, trim, signal) {
	const hasAudio = await probeAudio(ffprobe, file, signal);
	const duration = await probeDuration(ffprobe, file, signal);
	return {
		file,
		hasAudio,
		...duration === void 0 ? {} : { duration },
		trimStart: Math.max(0, trim.start),
		...trim.seconds === void 0 ? {} : { trimSeconds: Math.max(0, trim.seconds) }
	};
}
/**
* Build the ffmpeg argument vector (contract §5, extended for timelines).
*
* Each input is trimmed to its segment, normalized to 1280x720/30fps/yuv420p,
* and its audio either reformatted or synthesized at the TRIMMED length, so no
* branch of the graph can ever stall the concat.
*
* Two paths, deliberately:
*  - every seam is a hard cut: one `concat` node (cheapest, what the original
*    stitch always did), and
*  - any seam has a transition: chained `xfade`/`acrossfade`, each taking the
*    measured overlap. xfade needs absolute offsets into the growing result, so
*    the offset for seam i is the running total minus the overlaps so far — the
*    arithmetic lives in `placeTimeline` on the client and is passed in already
*    resolved, because the composer must not re-derive (and disagree with) what
*    the editor showed the user.
*
* @param sources - local file paths in final play order.
* @param probes - one probe per source, same order.
* @param target - output file path.
* @param options - transitions (length = sources-1) and whether to keep audio.
*/
function buildStitchArgs(sources, probes, target, options = {}) {
	const keepAudio = options.keepAudio !== false;
	const transitions = options.transitions ?? [];
	const trimmedSeconds = probes.map((probe) => {
		const available = probe.duration === void 0 ? probe.trimSeconds : Math.max(0, probe.duration - probe.trimStart);
		return probe.trimSeconds === void 0 ? available : Math.min(probe.trimSeconds, available ?? probe.trimSeconds);
	});
	const filters = [];
	let concatInputs = "";
	const overlapOf = (index) => {
		const transition = transitions[index];
		if (transition === void 0 || transition.kind === "cut") return 0;
		const left = trimmedSeconds[index];
		const right = trimmedSeconds[index + 1];
		if (left === void 0 || right === void 0) return 0;
		return Math.max(0, Math.min(transition.seconds, left / 2 - .05, right / 2 - .05));
	};
	const hasTransition = probes.some((_, index) => overlapOf(index) > 0);
	probes.forEach((probe, index) => {
		const hasTrim = probe.trimStart > 0 || probe.trimSeconds !== void 0;
		const trimRange = `start=${probe.trimStart.toFixed(3)}${probe.trimSeconds === void 0 ? "" : `:duration=${probe.trimSeconds.toFixed(3)}`}`;
		const videoTrim = hasTrim ? `trim=${trimRange},setpts=PTS-STARTPTS,` : "";
		const audioTrim = hasTrim ? `atrim=${trimRange},asetpts=PTS-STARTPTS,` : "";
		filters.push(`[${index}:v]${videoTrim}scale=${TARGET_WIDTH}:${TARGET_HEIGHT}:force_original_aspect_ratio=decrease,pad=${TARGET_WIDTH}:${TARGET_HEIGHT}:(ow-iw)/2:(oh-ih)/2,fps=${TARGET_FPS},setsar=1,format=yuv420p[v${index}]`);
		if (!keepAudio) return;
		if (probe.hasAudio) {
			filters.push(`[${index}:a]${audioTrim}aformat=sample_rates=${TARGET_SAMPLE_RATE}:channel_layouts=stereo[a${index}]`);
			return;
		}
		const length = trimmedSeconds[index];
		if (length === void 0) throw new Error(`cannot determine the length of ${probe.file}, so its silent audio track cannot be bounded`);
		filters.push(`anullsrc=r=${TARGET_SAMPLE_RATE}:cl=stereo:d=${length.toFixed(3)}[a${index}]`);
	});
	if (!hasTransition) {
		for (let index = 0; index < probes.length; index += 1) concatInputs += keepAudio ? `[v${index}][a${index}]` : `[v${index}]`;
		filters.push(`${concatInputs}concat=n=${probes.length}:v=1:a=${keepAudio ? 1 : 0}[v]${keepAudio ? "[a]" : ""}`);
	} else {
		let videoLabel = "v0";
		let audioLabel = keepAudio ? "a0" : "";
		let running = trimmedSeconds[0] ?? 0;
		for (let index = 1; index < probes.length; index += 1) {
			const overlap = overlapOf(index - 1);
			const videoOut = `vx${index}`;
			if (overlap <= 0) {
				const videoIn = `vc${index}`;
				const audioIn = `ac${index}`;
				if (keepAudio) {
					filters.push(`[${videoLabel}][v${index}]concat=n=2:v=1:a=0,settb=AVTB[${videoIn}]`);
					filters.push(`[${audioLabel}][a${index}]concat=n=2:v=0:a=1[${audioIn}]`);
					audioLabel = audioIn;
				} else filters.push(`[${videoLabel}][v${index}]concat=n=2:v=1:a=0,settb=AVTB[${videoIn}]`);
				videoLabel = videoIn;
				running += trimmedSeconds[index] ?? 0;
			} else {
				const offset = Math.max(0, running - overlap);
				filters.push(`[${videoLabel}]settb=AVTB[vtb${index}]`);
				filters.push(`[v${index}]settb=AVTB[vtb${index}b]`);
				filters.push(`[vtb${index}][vtb${index}b]xfade=transition=${transitionFilter(transitions[index - 1].kind)}:duration=${overlap.toFixed(3)}:offset=${offset.toFixed(3)}[${videoOut}]`);
				videoLabel = videoOut;
				if (keepAudio) {
					const audioOut = `ax${index}`;
					filters.push(`[${audioLabel}][a${index}]acrossfade=d=${overlap.toFixed(3)}[${audioOut}]`);
					audioLabel = audioOut;
				}
				running += (trimmedSeconds[index] ?? 0) - overlap;
			}
		}
		filters.push(`[${videoLabel}]null[v]`);
		if (keepAudio) filters.push(`[${audioLabel}]anull[a]`);
	}
	return [
		"-y",
		"-hide_banner",
		"-loglevel",
		"error",
		...sources.flatMap((source) => ["-i", source]),
		"-filter_complex",
		filters.join(";"),
		"-map",
		"[v]",
		...keepAudio ? ["-map", "[a]"] : [],
		"-c:v",
		"libx264",
		"-preset",
		"veryfast",
		"-crf",
		"20",
		...keepAudio ? ["-c:a", "aac"] : ["-an"],
		"-movflags",
		"+faststart",
		target
	];
}
/** ffmpeg's xfade name for one of our three seam kinds. */
function transitionFilter(kind) {
	return kind === "fade" ? "fade" : "dissolve";
}
/**
* Every store a canvas clip node can point at.
*
* TWO, because the user can act on a clip before or after favoriting it:
*  - the video history (`videos/files/`), what a finished generation writes, and
*  - the gallery (`gallery/videos/`), where 「收藏」 COPIES the bytes.
* Favoriting used to make a clip un-stitchable: the composer only knew the first
* prefix, so `resolve()` answered undefined and the whole run failed. The order
* matters only for readability of this list — the prefixes are disjoint.
*
* Each `read` re-validates the name against that store's own pattern, so a URL
* can never reach outside its directory (see below).
*/
const CLIP_SOURCES = [{
	prefix: VIDEO_API.file,
	read: readVideoFile
}, {
	prefix: GALLERY_API.videoFile,
	read: readGalleryVideo
}];
/**
* Decode a served clip URL into the file name and the store that owns it.
*
* The prefix is matched EXACTLY, as `prefix + '/'`, so a lookalike route such as
* `/api/dsh-imagegen-studio/gallery/video-file-x/…` cannot be mistaken for a clip. The
* `URL` parse normalizes `..` segments away and the store's own name pattern
* rejects whatever survives, so `../../etc/passwd` is still refused.
*
* A malformed escape (`%ZZ`, or a truncated `%E0%A4%A`) makes
* `decodeURIComponent` throw a `URIError`. That is an unreadable clip like any
* other, so it resolves to `undefined` here and the run reports it by name
* instead of surfacing a raw engine error.
*/
function videoFileFrom(rawUrl) {
	if (rawUrl.trim() === "") return void 0;
	let pathname;
	try {
		pathname = new URL(rawUrl, "http://localhost").pathname;
	} catch {
		return;
	}
	for (const source of CLIP_SOURCES) {
		if (!pathname.startsWith(`${source.prefix}/`)) continue;
		let file;
		try {
			file = decodeURIComponent(pathname.slice(source.prefix.length + 1));
		} catch {
			return;
		}
		return file === "" ? void 0 : {
			file,
			read: source.read
		};
	}
}
/** Defensive entry id, only used when a caller passes none. */
function localEntryId() {
	return `compose-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
/**
* The host's local clip stitcher.
*
* Every dependency is derived here from the module's own imports
* (`imageDataRoot()` through the video store, `VIDEO_API.file` through the
* protocol), so the plugin can construct it with no arguments and the runner
* never has to import the video store itself.
*/
function createClipComposer() {
	let cached;
	const locate = () => {
		if (cached === void 0) cached = {
			ffmpeg: findTool("ffmpeg"),
			ffprobe: findTool("ffprobe")
		};
		return cached;
	};
	const requireTools = () => {
		const found = locate();
		if (found.ffmpeg === void 0 || found.ffprobe === void 0) throw new Error(`ffmpeg and ffprobe are both required; ${describeTools(found)}`);
		return {
			ffmpeg: found.ffmpeg,
			ffprobe: found.ffprobe
		};
	};
	return {
		available: () => {
			const found = locate();
			return found.ffmpeg !== void 0 && found.ffprobe !== void 0;
		},
		describe: () => describeTools(locate()),
		/**
		* Turn a served clip URL back into its local file. A clip that is no longer
		* on disk (evicted history entry, foreign URL) resolves to undefined, and
		* the caller must fail the run rather than drop the segment.
		*/
		resolve: async (url) => {
			const found = videoFileFrom(url);
			if (found === void 0) return void 0;
			return (await found.read(found.file))?.path;
		},
		stitch: async (input) => {
			const { ffmpeg, ffprobe } = requireTools();
			const sources = [...input.sources];
			if (sources.length < 2) throw new Error(`stitching needs at least two clips, got ${sources.length}`);
			const trims = input.trims ?? [];
			input.onStage?.("probe");
			const probes = [];
			for (let index = 0; index < sources.length; index += 1) {
				if (input.signal?.aborted === true) throw new Error("stitch was cancelled");
				const trim = trims[index] ?? { start: 0 };
				probes.push(await probeClip(ffprobe, sources[index], trim, input.signal));
			}
			input.onStage?.("encode");
			const dir = await promises.mkdtemp(path.join(tmpdir(), "dsh-compose-"));
			const target = path.join(dir, "stitched.mp4");
			try {
				const result = await runProcess(ffmpeg, buildStitchArgs(sources, probes, target, {
					...input.transitions === void 0 ? {} : { transitions: input.transitions },
					...input.keepAudio === void 0 ? {} : { keepAudio: input.keepAudio }
				}), {
					timeoutMs: STITCH_TIMEOUT_MS,
					...input.signal === void 0 ? {} : { signal: input.signal }
				});
				if (result.code !== 0) throw new Error(`ffmpeg exited ${result.code}: ${tail(result.stderr)}`);
				const bytes = await promises.readFile(target);
				if (bytes.length === 0) throw new Error("ffmpeg produced an empty file");
				const duration = await probeDuration(ffprobe, target, input.signal).catch(() => void 0);
				return {
					bytes,
					mime: "video/mp4",
					...duration === void 0 ? {} : { duration },
					width: TARGET_WIDTH,
					height: TARGET_HEIGHT
				};
			} finally {
				await promises.rm(dir, {
					recursive: true,
					force: true
				}).catch(() => {});
			}
		},
		/**
		* Persist the stitched bytes as one video-history entry and hand back the
		* SERVED ref. The URL is read back off the stored entry rather than
		* assembled here, so exactly one place knows the served URL shape.
		*/
		publish: async (input) => {
			const id = input.id.trim() === "" ? localEntryId() : input.id;
			const file = (await appendVideoHistory({
				id,
				createdAt: Date.now(),
				mode: "compose",
				model: "ffmpeg",
				prompt: input.prompt,
				aspectRatio: "16:9",
				resolution: `${TARGET_WIDTH}x${TARGET_HEIGHT}`,
				seconds: input.duration ?? 0,
				files: [{
					bytes: Buffer.from(input.bytes),
					mime: input.mime,
					...input.duration === void 0 ? {} : { duration: input.duration }
				}]
			})).find((item) => item.id === id)?.videos[0];
			if (file === void 0) throw new Error("the stitched clip did not come back from the video history");
			return {
				url: file.url,
				mime: file.mime,
				...file.duration === void 0 ? {} : { duration: file.duration }
			};
		}
	};
}
/** Where continuation temporaries live. */
function continuumDir() {
	return path.join(imageDataRoot(), "studio", "continuum");
}
/** Cap on captured ffmpeg output, so a chatty encode cannot grow memory. */
const MAX_PROCESS_OUTPUT = 256 * 1024;
/** Frames grabbed from the tail of a clip, tried in order. */
const TAIL_SEEKS = [
	"-0.5",
	"-1.5",
	"-0.1"
];
/**
* Run one ffmpeg invocation and collect its stderr.
* @param command - ffmpeg path.
* @param args - arguments.
* @param options - timeout and cancellation.
* @returns captured stderr, for the failure message.
*/
function runFfmpeg(command, args, options) {
	return new Promise((resolve, reject) => {
		let settled = false;
		let stderr = "";
		const child = spawn(command, [...args], {
			windowsHide: true,
			stdio: [
				"ignore",
				"ignore",
				"pipe"
			]
		});
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			finish(/* @__PURE__ */ new Error("取帧超时"));
		}, options.timeoutMs);
		const onAbort = () => {
			child.kill("SIGKILL");
			finish(/* @__PURE__ */ new Error("已取消"));
		};
		options.signal?.addEventListener("abort", onAbort, { once: true });
		const finish = (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
			if (error !== void 0) reject(error);
			else resolve(stderr);
		};
		child.stderr?.on("data", (chunk) => {
			if (stderr.length < MAX_PROCESS_OUTPUT) stderr += chunk.toString("utf8");
		});
		child.on("error", (error) => {
			finish(error);
		});
		child.on("close", (code) => {
			if (code === 0) finish();
			else finish(/* @__PURE__ */ new Error(`ffmpeg 退出码 ${String(code)}：${stderr.slice(-800)}`));
		});
	});
}
/**
* Grab the last frame of a clip as a PNG data URI.
*
* Three seeks are tried because `-sseof` lands on a keyframe boundary: on a clip
* whose last keyframe sits more than half a second from the end, the first seek
* yields no frame at all ("Output file is empty"). The progressively larger
* seeks always find one, and the frame closest to the end is preferred.
* @param bytes - the clip.
* @param mime - its container MIME, used to pick a file extension.
* @param dir - scratch directory.
* @param options - cancellation.
* @returns the frame as `data:image/png;base64,…`.
*/
async function grabTailFrame(bytes, mime, dir, options = {}) {
	const ffmpeg = locateFfmpeg();
	if (ffmpeg === void 0) throw new Error("续时长需要本机 ffmpeg：取尾帧与拼接收尾都依赖它；安装 ffmpeg 后重试");
	await fs.mkdir(dir, { recursive: true });
	const stem = `tail-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	const input = path.join(dir, `${stem}.${mime.includes("webm") ? "webm" : "mp4"}`);
	const output = path.join(dir, `${stem}.png`);
	await fs.writeFile(input, bytes);
	let lastError;
	try {
		for (const seek of TAIL_SEEKS) {
			if (options.signal?.aborted === true) throw new Error("已取消");
			try {
				await runFfmpeg(ffmpeg, [
					"-y",
					"-loglevel",
					"error",
					"-sseof",
					seek,
					"-i",
					input,
					"-frames:v",
					"1",
					"-update",
					"1",
					output
				], {
					timeoutMs: 6e4,
					...options.signal === void 0 ? {} : { signal: options.signal }
				});
				const frame = await fs.readFile(output);
				if (frame.byteLength > 0) return `data:image/png;base64,${frame.toString("base64")}`;
				lastError = /* @__PURE__ */ new Error("取到的尾帧是空文件");
			} catch (error) {
				lastError = error instanceof Error ? error : new Error(String(error));
			}
		}
		throw lastError ?? /* @__PURE__ */ new Error("取尾帧失败");
	} finally {
		await fs.rm(input, { force: true }).catch(() => {});
		await fs.rm(output, { force: true }).catch(() => {});
	}
}
/**
* Render a chain of segments joined by their tail frames.
* @param request - the chain description.
* @param options - progress, cancellation, and an injectable composer.
* @returns the segments plus the stitched clip when two or more exist.
*/
async function runContinuum(request, options = {}) {
	const total = Math.max(1, Math.min(24, Math.floor(request.segments)));
	const warnings = [];
	const segments = [];
	const dir = continuumDir();
	await fs.mkdir(dir, { recursive: true });
	let frame = request.seedFrame;
	for (let index = 0; index < total; index++) {
		if (options.signal?.aborted === true) throw new Error("已取消");
		const prompt = index === 0 || request.promptStep === void 0 || request.promptStep.trim() === "" ? request.prompt : `${request.prompt}，${request.promptStep.trim()}`;
		options.onProgress?.({
			phase: "render",
			index: index + 1,
			total,
			message: `渲染第 ${index + 1}/${total} 段`,
			progress: index / total
		});
		const clip = (await runAdapterVideo(request.adapter, request.model, {
			prompt,
			model: request.model.id,
			...request.aspect === void 0 ? {} : { aspect: request.aspect },
			...request.resolution === void 0 ? {} : { resolution: request.resolution },
			...request.seed === void 0 ? {} : { seed: request.seed },
			duration: request.seconds,
			n: 1,
			...frame === void 0 ? {} : {
				firstFrame: frame,
				images: [frame]
			},
			...request.custom === void 0 ? {} : { custom: request.custom }
		}, {
			...options.signal === void 0 ? {} : { signal: options.signal },
			onProgress: (event) => {
				options.onProgress?.({
					phase: "render",
					index: index + 1,
					total,
					message: `第 ${index + 1}/${total} 段：${event.message}`,
					...event.progress === void 0 ? {} : { progress: (index + event.progress / 100) / total }
				});
			}
		})).videos[0];
		if (clip === void 0) throw new Error(`第 ${index + 1} 段没有返回视频`);
		segments.push({
			index,
			bytes: clip.bytes,
			mime: clip.mime,
			seconds: clip.duration ?? request.seconds,
			prompt
		});
		options.onProgress?.({
			phase: "frame",
			index: index + 1,
			total,
			message: "取尾帧作为下一段首帧",
			progress: (index + .9) / total
		});
		frame = await grabTailFrame(clip.bytes, clip.mime, dir, options.signal === void 0 ? {} : { signal: options.signal });
	}
	if (segments.length < 2) return {
		segments,
		warnings
	};
	options.onProgress?.({
		phase: "stitch",
		index: total,
		total,
		message: "拼接并统一编码",
		progress: .96
	});
	const composer = options.composer ?? createClipComposer();
	if (!composer.available()) {
		warnings.push(`未找到可用的 ffmpeg/ffprobe（${composer.describe()}）：已逐段返回，未拼接`);
		return {
			segments,
			warnings
		};
	}
	const files = [];
	try {
		for (const segment of segments) {
			const file = path.join(dir, `seg-${Date.now()}-${segment.index}.${segment.mime.includes("webm") ? "webm" : "mp4"}`);
			await fs.writeFile(file, segment.bytes);
			files.push(file);
		}
		const crossfadeSeconds = Math.max(0, (request.crossfadeMs ?? 0) / 1e3);
		const stitched = await composer.stitch({
			sources: files,
			...crossfadeSeconds <= 0 ? {} : { transitions: files.slice(1).map(() => ({
				kind: "dissolve",
				seconds: crossfadeSeconds
			})) },
			...options.signal === void 0 ? {} : { signal: options.signal }
		});
		return {
			segments,
			stitched: {
				bytes: Buffer.from(stitched.bytes),
				mime: stitched.mime,
				...stitched.duration === void 0 ? {} : { duration: stitched.duration }
			},
			warnings
		};
	} finally {
		for (const file of files) await fs.rm(file, { force: true }).catch(() => {});
	}
}
/**
* Write one JSON response.
* @param res - the response.
* @param status - HTTP status.
* @param body - payload.
*/
function writeJson(res, status, body) {
	const text = JSON.stringify(body);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": Buffer.byteLength(text),
		"cache-control": "no-store"
	});
	res.end(text);
}
/**
* True when the request came from this machine.
*
* The panel holds the user's credentials, so a route that answers a LAN peer
* would be a credential oracle even if it never prints the key.
* @param req - the request.
*/
function isLoopbackRequest(req) {
	const address = req.socket.remoteAddress ?? "";
	return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}
/**
* Read a JSON body, refusing anything oversized or unparseable.
* @param req - the request.
* @returns the parsed body, or undefined.
*/
async function readJsonBody(req) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		const buffer = chunk;
		size += buffer.byteLength;
		if (size > 50331648) return void 0;
		chunks.push(buffer);
	}
	if (size === 0) return void 0;
	try {
		const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : void 0;
	} catch {
		return;
	}
}
/**
* Message of an unknown thrown value.
* @param error - thrown value.
*/
function messageOf$2(error) {
	return error instanceof Error ? error.message : String(error);
}
/**
* Serve one file with Range support.
*
* Range matters here rather than being a nicety: without it a browser cannot seek
* a generated clip, and the panel's scrubber would jump back to zero on every
* drag.
* @param res - the response.
* @param filePath - absolute file path.
* @param mime - content type.
* @param range - the request's Range header, when present.
*/
async function sendFile(res, filePath, mime, range) {
	let size;
	try {
		size = (await fs.stat(filePath)).size;
	} catch {
		writeJson(res, 404, {
			ok: false,
			code: "not-found",
			message: "文件不存在"
		});
		return;
	}
	const match = range === void 0 ? null : /^bytes=(\d*)-(\d*)$/.exec(range.trim());
	if (match !== null) {
		const startRaw = match[1] ?? "";
		const endRaw = match[2] ?? "";
		let start = startRaw === "" ? NaN : Number(startRaw);
		let end = endRaw === "" ? size - 1 : Number(endRaw);
		if (Number.isNaN(start)) {
			const suffix = Number(endRaw);
			start = Number.isFinite(suffix) ? Math.max(0, size - suffix) : 0;
			end = size - 1;
		}
		start = Math.max(0, Math.min(start, size - 1));
		end = Math.max(start, Math.min(end, size - 1));
		const length = end - start + 1;
		res.writeHead(206, {
			"content-type": mime,
			"content-length": length,
			"content-range": `bytes ${start}-${end}/${size}`,
			"accept-ranges": "bytes",
			"cache-control": "private, max-age=3600"
		});
		createReadStream(filePath, {
			start,
			end
		}).pipe(res);
		return;
	}
	res.writeHead(200, {
		"content-type": mime,
		"content-length": size,
		"accept-ranges": "bytes",
		"cache-control": "private, max-age=3600"
	});
	createReadStream(filePath).pipe(res);
}
/**
* Reject anything that is not a plain file name, so a served asset can never be
* a path traversal.
* @param name - candidate name.
*/
function safeAssetName(name) {
	const trimmed = name.trim();
	if (trimmed === "" || trimmed.length > 200) return void 0;
	if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) return void 0;
	if (trimmed.startsWith(".")) return void 0;
	return trimmed;
}
/**
* Join a directory and a file name, refusing escapes.
* @param dir - base directory.
* @param name - file name.
*/
function resolveInside(dir, name) {
	const safe = safeAssetName(name);
	if (safe === void 0) return void 0;
	const full = path.resolve(dir, safe);
	return full.startsWith(path.resolve(dir) + path.sep) ? full : void 0;
}
//#endregion
//#region src/studio/types.ts
/** Every route this module registers. */
const STUDIO_API = {
	/** GET: masked adapter list. */
	adapters: "/api/dsh-imagegen-studio/studio/adapters",
	/** POST: create or update one adapter. */
	adapter: "/api/dsh-imagegen-studio/studio/adapter",
	/** POST: delete one adapter. */
	adapterDelete: "/api/dsh-imagegen-studio/studio/adapter/delete",
	/** POST: probe a gateway's /v1/models and suggest models. */
	discover: "/api/dsh-imagegen-studio/studio/discover",
	/** POST: append discovered models to the catalogue of the channel behind an adapter. */
	adopt: "/api/dsh-imagegen-studio/studio/adopt",
	/** POST: render the exact wire request without sending it. */
	preview: "/api/dsh-imagegen-studio/studio/preview",
	/** POST: start one chat generation (image or video). */
	generate: "/api/dsh-imagegen-studio/studio/generate",
	/** POST: start a tail-frame continuation chain. */
	continuum: "/api/dsh-imagegen-studio/studio/continuum",
	/** GET prefix: poll one task. */
	task: "/api/dsh-imagegen-studio/studio/task",
	/** POST: cancel one task. */
	cancel: "/api/dsh-imagegen-studio/studio/cancel",
	/** POST: record one renderer stall report (diagnostics only). */
	diag: "/api/dsh-imagegen-studio/studio/diag",
	/** GET prefix: serve a produced asset (supports Range). */
	file: "/api/dsh-imagegen-studio/studio/file"
};
//#endregion
//#region src/studio/routes.ts
/**
* Studio routes: adapters, discovery, wire preview, chat generation, and
* tail-frame continuation.
*
* Everything a "friendly integration" needs lives behind these endpoints:
*
*  - the adapter store (`GET/POST adapters`) so a gateway is described once, not
*    hard-coded into the panel;
*  - `discover` so the model list is read off the gateway instead of typed by
*    hand;
*  - `preview` which renders the exact URL, headers and body *without sending
*    it* — the cheapest way to debug a gateway that keeps answering 400;
*  - `generate` / `continuum`, both asynchronous with a poll and a cancel, since
*    a video render outlives any sane HTTP request.
*
* No credential ever leaves this process: profiles go out masked, and the token
* is read from the store at request time.
*/
/** Model-id patterns used to classify what a gateway returns. */
const VIDEO_MODEL_PAT = /(video|veo|sora|kling|seedance|hailuo|vidu|pika|movie|t2v|i2v|r2v|s2v|wan[-_.]?\d|minimax[-_]?h3|grok-imagine-video|runway|pixverse|luma|ltx)/i;
/** Image-model patterns. */
const IMAGE_MODEL_PAT = /(image|dall|flux|sdxl|sd[-_.]?\d|midjourney|banana|seedream|kolors|hidream|imagen|gpt-image|glm-image|qwen-image|recraft|ideogram|stable-diffusion|janus)/i;
/**
* Patterns for everything that is definitely not a media model. Checked first:
* a gateway lists its chat models in the same endpoint, and offering `gpt-4o` as
* an image model is worse than offering nothing.
*/
const NON_MEDIA_PAT = /(embed|rerank|whisper|tts|transcri|moderation|chat|instruct|vision-ocr|gpt-3|gpt-4(?!o-image)|gpt-5|o1|o3|claude|gemini-(?!.*image)|deepseek|llama|mistral|qwen-(max|plus|turbo|long)|text-|bge-|jina-)/i;
/** Extensions per produced MIME. */
function extensionFor(mime) {
	if (mime.includes("webm")) return "webm";
	if (mime.includes("quicktime")) return "mov";
	if (mime.includes("jpeg")) return "jpg";
	if (mime.includes("webp")) return "webp";
	if (mime.includes("gif")) return "gif";
	if (mime.startsWith("video/")) return "mp4";
	if (mime.startsWith("audio/")) return "mp3";
	return "png";
}
/**
* Write one produced asset into the served directory.
* @param bytes - the bytes.
* @param mime - content type.
* @param prefix - file-name prefix, for legibility in the folder.
* @returns the served URL and its size.
*/
async function persistAsset(bytes, mime, prefix) {
	const dir = studioOutDir();
	await fs.mkdir(dir, { recursive: true });
	const name = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${extensionFor(mime)}`;
	await fs.writeFile(path.join(dir, name), bytes);
	return {
		url: `${STUDIO_API.file}/${name}`,
		mime,
		bytes: bytes.byteLength
	};
}
/**
* The model spec for a request, synthesising a bare one when the profile has no
* entry for that alias (so an unlisted model is still tryable).
* @param adapter - the profile.
* @param alias - alias or raw id.
*/
function resolveModel(adapter, alias) {
	return adapterModel(adapter, alias) ?? {
		alias,
		id: alias
	};
}
/**
* Turn a chat request into engine parameters.
*
* Precedence is deliberate: explicit request values win, then the model's
* declared parameter roles, then the model's own defaults. That order is what
* lets one panel serve a gateway where `nano-banana` spells size `image_size`
* and `gpt-image-2` spells it `size` — both declare the same *role*.
* @param raw - request body.
* @param adapters - the adapters derived from the live channels.
* @returns the prepared render, or a failure message.
*/
async function prepareGenerate(raw, adapters) {
	const adapterId = typeof raw.adapterId === "string" ? raw.adapterId.trim() : "";
	const alias = typeof raw.modelAlias === "string" ? raw.modelAlias.trim() : "";
	const prompt = typeof raw.prompt === "string" ? raw.prompt : "";
	if (adapterId === "") return { failure: "缺少 adapterId" };
	if (alias === "") return { failure: "缺少 modelAlias" };
	if (prompt.trim() === "") return { failure: "提示词为空" };
	const adapter = adapters.find((entry) => entry.id === adapterId);
	if (adapter === void 0) return { failure: `找不到通道 ${adapterId}：它对应的渠道可能已从设置里删除` };
	if (adapter.auth.style !== "none" && adapter.auth.token.trim() === "") return { failure: `通道「${adapter.label}」还没有 API Key：在「设置 → 生图配置」里打开该渠道填一个` };
	const model = resolveModel(adapter, alias);
	const surface = raw.surface === "edit" ? "edit" : raw.surface === "video" ? "video" : "image";
	const mediaImages = Array.isArray(raw.images) ? raw.images.length : 0;
	const mediaVideos = Array.isArray(raw.videos) ? raw.videos.length : 0;
	const mediaAudios = Array.isArray(raw.audios) ? raw.audios.length : 0;
	const resolved = resolveStudioParams(fieldsForSurface(model.params ?? [], surface, {
		images: mediaImages,
		videos: mediaVideos,
		audios: mediaAudios
	}), raw.params !== null && typeof raw.params === "object" ? raw.params : {});
	const warnings = [...resolved.warnings];
	const listOf = (value) => {
		if (!Array.isArray(value)) return void 0;
		const out = value.filter((entry) => typeof entry === "string" && entry.trim() !== "");
		return out.length === 0 ? void 0 : out;
	};
	const numberOf = (value) => {
		const num = typeof value === "number" ? value : Number(value);
		return Number.isFinite(num) ? num : void 0;
	};
	const images = listOf(raw.images);
	const videos = listOf(raw.videos);
	const audios = listOf(raw.audios);
	const firstFrame = typeof raw.firstFrame === "string" && raw.firstFrame.trim() !== "" ? raw.firstFrame : void 0;
	const lastFrame = typeof raw.lastFrame === "string" && raw.lastFrame.trim() !== "" ? raw.lastFrame : void 0;
	if (images !== void 0 && images.length > (model.maxRefImages ?? 0)) warnings.push(`该模型最多 ${String(model.maxRefImages ?? 0)} 张参考图，多余的已忽略`);
	const capped = images === void 0 ? void 0 : images.slice(0, model.maxRefImages ?? 0);
	return {
		adapter,
		model,
		params: {
			prompt,
			model: model.id,
			...typeof raw.aspect === "string" && raw.aspect !== "" ? { aspect: raw.aspect } : resolved.roles.aspect === void 0 ? {} : { aspect: resolved.roles.aspect },
			...typeof raw.resolution === "string" && raw.resolution !== "" ? { resolution: raw.resolution } : resolved.roles.resolution === void 0 ? {} : { resolution: resolved.roles.resolution },
			...typeof raw.size === "string" && raw.size !== "" ? { size: raw.size } : resolved.roles.size === void 0 ? {} : { size: resolved.roles.size },
			...(() => {
				const duration = numberOf(raw.duration) ?? resolved.roles.duration;
				return duration === void 0 ? {} : { duration };
			})(),
			...(() => {
				const n = numberOf(raw.n) ?? resolved.roles.n;
				return n === void 0 ? {} : { n };
			})(),
			...(() => {
				const seed = numberOf(raw.seed) ?? resolved.roles.seed;
				return seed === void 0 ? {} : { seed };
			})(),
			...typeof raw.negativePrompt === "string" && raw.negativePrompt !== "" ? { negativePrompt: raw.negativePrompt } : resolved.roles.negativePrompt === void 0 ? {} : { negativePrompt: resolved.roles.negativePrompt },
			...capped === void 0 ? {} : { images: capped },
			...firstFrame === void 0 ? {} : { firstFrame },
			...lastFrame === void 0 ? {} : { lastFrame },
			...videos === void 0 ? {} : { videos },
			...audios === void 0 ? {} : { audios },
			...Object.keys(resolved.extras.body ?? {}).length === 0 ? {} : { custom: resolved.extras }
		},
		warnings
	};
}
/**
* Classify a model id.
* @param id - upstream model id.
* @returns the kind, or undefined for something that is not a media model.
*/
function classifyModel(id) {
	if (NON_MEDIA_PAT.test(id)) return void 0;
	if (VIDEO_MODEL_PAT.test(id)) return "video";
	if (IMAGE_MODEL_PAT.test(id)) return "image";
}
/**
* Fetch JSON with a timeout and the adapter's credential.
* @param url - absolute URL.
* @param adapter - credential source.
* @param signal - cancellation.
* @returns parsed JSON, or a thrown error.
*/
async function fetchJson(url, adapter, signal) {
	const headers = { accept: "application/json" };
	const { auth } = adapter;
	if (auth.style === "bearer" && auth.token !== "") headers[auth.headerName ?? "Authorization"] = `${auth.prefix ?? "Bearer "}${auth.token}`;
	else if (auth.style === "header" && auth.token !== "") headers[auth.headerName ?? "x-api-key"] = `${auth.prefix ?? ""}${auth.token}`;
	let target = url;
	if (auth.style === "query" && auth.token !== "") {
		const join = target.includes("?") ? "&" : "?";
		target = `${target}${join}${encodeURIComponent(auth.queryName ?? "key")}=${encodeURIComponent(auth.token)}`;
	}
	const controller = new AbortController();
	const timer = setTimeout(() => {
		controller.abort();
	}, 2e4);
	const onAbort = () => {
		controller.abort();
	};
	signal?.addEventListener("abort", onAbort, { once: true });
	try {
		const response = await fetch(target, {
			headers,
			signal: controller.signal
		});
		const text = await response.text();
		if (!response.ok) throw new Error(`HTTP ${String(response.status)}：${text.slice(0, 300)}`);
		return text.trim() === "" ? {} : JSON.parse(text);
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", onAbort);
	}
}
/**
* Read the model list out of a gateway response.
* @param payload - parsed JSON.
* @returns ids found.
*/
function modelIds(payload) {
	const record = payload !== null && typeof payload === "object" ? payload : {};
	const list = Array.isArray(record.data) ? record.data : Array.isArray(record.models) ? record.models : Array.isArray(payload) ? payload : [];
	const ids = [];
	for (const entry of list) {
		if (typeof entry === "string") {
			ids.push(entry);
			continue;
		}
		if (entry === null || typeof entry !== "object") continue;
		const item = entry;
		const id = typeof item.id === "string" ? item.id : typeof item.name === "string" ? item.name : typeof item.model === "string" ? item.model : "";
		if (id.trim() !== "") ids.push(id.trim());
	}
	return [...new Set(ids)];
}
/**
* Read `/api/pricing` into an id → {description, price} table, when present.
* @param payload - parsed JSON.
*/
function pricingTable(payload) {
	const table = /* @__PURE__ */ new Map();
	const record = payload !== null && typeof payload === "object" ? payload : {};
	const list = Array.isArray(record.data) ? record.data : Array.isArray(payload) ? payload : [];
	for (const entry of list) {
		if (entry === null || typeof entry !== "object") continue;
		const item = entry;
		const id = typeof item.id === "string" ? item.id : typeof item.model === "string" ? item.model : "";
		if (id === "") continue;
		const description = typeof item.description === "string" ? item.description : void 0;
		const price = typeof item.model_price === "number" ? String(item.model_price) : typeof item.model_price === "string" ? item.model_price : typeof item.price === "string" ? item.price : void 0;
		table.set(id, {
			...description === void 0 ? {} : { description },
			...price === void 0 ? {} : { price }
		});
	}
	return table;
}
/**
* Route table for the studio surface.
*
* Adapters are derived from the live channels on every request: the settings
* page owns endpoints, keys and model catalogues, while the stored override
* file only adds what a channel row cannot express (per-model parameters, the
* wire contract). A channel deleted in settings therefore stops existing here
* without a reconciliation step in between.
* @param deps - host services (live channels, catalogue writes).
*/
function makeStudioRoutes(deps = {}) {
	/** The adapters the current channels imply, stored overrides applied. */
	const resolveAdapters = async () => {
		const channels = deps.channels?.() ?? [];
		return deriveChannelAdapters(channels, await readAdapters(), (channelId) => channels.find((entry) => entry.id === channelId)?.apiKey ?? "");
	};
	const guard = (req, res, method) => {
		if (!isLoopbackRequest(req)) {
			writeJson(res, 403, {
				ok: false,
				code: "forbidden",
				message: "loopback-only"
			});
			return false;
		}
		if (req.method !== method) {
			writeJson(res, 405, {
				ok: false,
				code: "method",
				message: `method not allowed: ${req.method ?? ""}`
			});
			return false;
		}
		return true;
	};
	return [
		{
			kind: "exact",
			path: STUDIO_API.adapters,
			handler: async (req, res) => {
				if (!guard(req, res, "GET")) return;
				try {
					writeJson(res, 200, {
						ok: true,
						adapters: (await resolveAdapters()).map(maskProfile)
					});
				} catch (error) {
					writeJson(res, 200, {
						ok: false,
						code: "store-failed",
						message: messageOf$2(error)
					});
				}
			}
		},
		{
			kind: "exact",
			path: STUDIO_API.adapter,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody(req);
				if (body === void 0) {
					writeJson(res, 200, {
						ok: false,
						code: "bad-request",
						message: "请求体不是合法 JSON"
					});
					return;
				}
				try {
					const raw = body.adapter ?? body;
					const posted = raw !== null && typeof raw === "object" ? raw : {};
					const auth = posted.auth !== null && typeof posted.auth === "object" ? posted.auth : void 0;
					const saved = await saveAdapter(auth === void 0 ? raw : {
						...posted,
						auth: {
							...auth,
							token: ""
						}
					}, { forgetToken: true });
					if (saved.profile === void 0) {
						writeJson(res, 200, {
							ok: false,
							code: "invalid-adapter",
							message: "通道配置无效",
							warnings: saved.warnings
						});
						return;
					}
					const warnings = saved.warnings.filter((warning) => !warning.startsWith("未填写密钥"));
					writeJson(res, 200, {
						ok: true,
						adapter: saved.profile,
						warnings
					});
				} catch (error) {
					writeJson(res, 200, {
						ok: false,
						code: "save-failed",
						message: messageOf$2(error)
					});
				}
			}
		},
		{
			kind: "exact",
			path: STUDIO_API.adapterDelete,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody(req);
				const id = typeof body?.id === "string" ? body.id : "";
				if (id === "") {
					writeJson(res, 200, {
						ok: false,
						code: "bad-request",
						message: "缺少 id"
					});
					return;
				}
				try {
					writeJson(res, 200, {
						ok: true,
						removed: await removeAdapter(id)
					});
				} catch (error) {
					writeJson(res, 200, {
						ok: false,
						code: "delete-failed",
						message: messageOf$2(error)
					});
				}
			}
		},
		{
			kind: "exact",
			path: STUDIO_API.adopt,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody(req);
				if (body === void 0) {
					writeJson(res, 200, {
						ok: false,
						code: "bad-request",
						message: "请求体不是合法 JSON"
					});
					return;
				}
				const adapterId = typeof body.adapterId === "string" ? body.adapterId.trim() : "";
				const requested = Array.isArray(body.models) ? body.models : [];
				const models = [];
				for (const entry of requested) {
					if (entry === null || typeof entry !== "object") continue;
					const item = entry;
					const id = typeof item.id === "string" ? item.id.trim() : "";
					if (id === "") continue;
					models.push({
						alias: typeof item.alias === "string" && item.alias.trim() !== "" ? item.alias.trim() : id,
						id
					});
				}
				if (adapterId === "" || models.length === 0) {
					writeJson(res, 200, {
						ok: false,
						code: "bad-request",
						message: "缺少 adapterId 或 models"
					});
					return;
				}
				if (deps.adoptModels === void 0) {
					writeJson(res, 200, {
						ok: false,
						code: "unsupported",
						message: "宿主没有注入渠道写入能力"
					});
					return;
				}
				try {
					const { channelId, kind } = splitChannelAdapterId(adapterId);
					const failure = await deps.adoptModels(channelId, kind, models);
					if (failure !== void 0) {
						writeJson(res, 200, {
							ok: false,
							code: "adopt-failed",
							message: failure
						});
						return;
					}
					writeJson(res, 200, {
						ok: true,
						added: models.length
					});
				} catch (error) {
					writeJson(res, 200, {
						ok: false,
						code: "adopt-failed",
						message: messageOf$2(error)
					});
				}
			}
		},
		{
			kind: "exact",
			path: STUDIO_API.diag,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody(req);
				if (body === void 0) {
					writeJson(res, 200, {
						ok: false,
						code: "bad-request",
						message: "请求体不是合法 JSON"
					});
					return;
				}
				try {
					const logDir = studioOutDir();
					await fs.mkdir(logDir, { recursive: true });
					await fs.appendFile(path.join(logDir, "stall.log"), `${JSON.stringify(body)}\n`, "utf8");
					writeJson(res, 200, { ok: true });
				} catch (error) {
					writeJson(res, 200, {
						ok: false,
						code: "diag-failed",
						message: messageOf$2(error)
					});
				}
			}
		},
		{
			kind: "exact",
			path: STUDIO_API.discover,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody(req);
				if (body === void 0) {
					writeJson(res, 200, {
						ok: false,
						code: "bad-request",
						message: "请求体不是合法 JSON"
					});
					return;
				}
				try {
					let adapter;
					const draft = body.adapter;
					if (draft !== null && typeof draft === "object") adapter = normalizeProfile(draft, (await readAdapters()).find((entry) => entry.id === draft.id)).profile;
					else {
						const id = typeof body.adapterId === "string" ? body.adapterId : "";
						adapter = (await resolveAdapters()).find((entry) => entry.id === id);
					}
					if (adapter === void 0) {
						writeJson(res, 200, {
							ok: false,
							code: "no-adapter",
							message: "找不到通道"
						});
						return;
					}
					const modelsPath = typeof body.modelsPath === "string" && body.modelsPath.trim() !== "" ? body.modelsPath.trim() : "/v1/models";
					const endpoint = /^https?:\/\//i.test(modelsPath) ? modelsPath : `${adapter.baseUrl}${modelsPath.startsWith("/") ? "" : "/"}${modelsPath}`;
					const payload = await fetchJson(endpoint, adapter);
					let pricing = /* @__PURE__ */ new Map();
					try {
						const pricingPath = typeof body.pricingPath === "string" && body.pricingPath.trim() !== "" ? body.pricingPath.trim() : "/api/pricing";
						pricing = pricingTable(await fetchJson(/^https?:\/\//i.test(pricingPath) ? pricingPath : `${adapter.baseUrl}${pricingPath.startsWith("/") ? "" : "/"}${pricingPath}`, adapter));
					} catch {}
					const known = new Set(adapter.models.map((model) => model.id));
					const models = [];
					for (const id of modelIds(payload)) {
						const kind = classifyModel(id);
						if (kind === void 0) continue;
						const meta = pricing.get(id);
						models.push({
							id,
							alias: id,
							kind,
							known: known.has(id),
							...meta?.price === void 0 ? {} : { priceNote: `≈${meta.price}` },
							...meta?.description === void 0 ? {} : { description: meta.description }
						});
					}
					writeJson(res, 200, {
						ok: true,
						endpoint,
						models: models.sort((left, right) => left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id)),
						hint: models.length === 0 ? "端点有响应，但没有识别出图片/视频模型：可以在“模型”里手工填一个 id" : void 0
					});
				} catch (error) {
					writeJson(res, 200, {
						ok: false,
						code: "discover-failed",
						message: messageOf$2(error)
					});
				}
			}
		},
		{
			kind: "exact",
			path: STUDIO_API.preview,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody(req);
				if (body === void 0) {
					writeJson(res, 200, {
						ok: false,
						code: "bad-request",
						message: "请求体不是合法 JSON"
					});
					return;
				}
				try {
					let adapters = [];
					const draft = body.adapter;
					if (draft !== null && typeof draft === "object") {
						const normalized = normalizeProfile(draft, (await readAdapters()).find((entry) => entry.id === draft.id)).profile;
						if (normalized === void 0) {
							writeJson(res, 200, {
								ok: false,
								code: "invalid",
								message: "通道草稿不完整，无法预览"
							});
							return;
						}
						adapters = [normalized.auth.style !== "none" && normalized.auth.token.trim() === "" ? {
							...normalized,
							auth: {
								...normalized.auth,
								token: "preview-token"
							}
						} : normalized];
					} else adapters = await resolveAdapters();
					const prepared = await prepareGenerate({
						...body,
						prompt: typeof body.prompt === "string" && body.prompt.trim() !== "" ? body.prompt : "preview"
					}, adapters);
					if ("failure" in prepared) {
						writeJson(res, 200, {
							ok: false,
							code: "invalid",
							message: prepared.failure
						});
						return;
					}
					const plan = planAdapterRequest(prepared.adapter, prepared.model, prepared.params);
					const wire = plan.preview;
					const declared = fieldsForSurface(prepared.model.params ?? [], body.surface === "video" ? "video" : body.surface === "edit" ? "edit" : "image");
					const sentBody = plan.body !== null && typeof plan.body === "object" ? plan.body : {};
					writeJson(res, 200, {
						ok: true,
						url: plan.url,
						method: plan.method,
						headers: plan.headers,
						body: plan.body,
						contentType: plan.contentType,
						omitted: wire.omitted,
						unused: declared.map((field) => field.key).filter((key) => !(key in sentBody))
					});
				} catch (error) {
					writeJson(res, 200, {
						ok: false,
						code: "preview-failed",
						message: messageOf$2(error)
					});
				}
			}
		},
		{
			kind: "exact",
			path: STUDIO_API.generate,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody(req);
				if (body === void 0) {
					writeJson(res, 200, {
						ok: false,
						code: "bad-request",
						message: "请求体不是合法 JSON"
					});
					return;
				}
				const prepared = await prepareGenerate(body, await resolveAdapters());
				if ("failure" in prepared) {
					writeJson(res, 200, {
						ok: false,
						code: "invalid",
						message: prepared.failure
					});
					return;
				}
				const isVideo = body.surface === "video" || prepared.adapter.kind === "video";
				const { id, controller } = createStudioTask(isVideo ? "video" : "image");
				updateStudioTask(id, {
					state: "running",
					phase: "提交",
					message: prepared.warnings.length === 0 ? "已提交到网关" : `已提交到网关（${prepared.warnings.join("；")}）`
				});
				(async () => {
					try {
						if (isVideo) {
							const clip = (await runAdapterVideo(prepared.adapter, prepared.model, prepared.params, {
								signal: controller.signal,
								onProgress: (event) => {
									updateStudioTask(id, {
										phase: event.phase === "poll" ? "生成中" : event.phase === "download" ? "下载" : "提交",
										message: event.message,
										...event.progress === void 0 ? {} : { progress: event.progress }
									});
								}
							})).videos[0];
							if (clip === void 0) throw new Error("网关没有返回视频");
							const asset = await persistAsset(clip.bytes, clip.mime, "video");
							updateStudioTask(id, {
								state: "done",
								phase: "完成",
								message: "已完成",
								progress: 100,
								result: {
									kind: "video",
									video: {
										...asset,
										...clip.duration === void 0 ? {} : { duration: clip.duration },
										...clip.revisedPrompt === void 0 ? {} : { revisedPrompt: clip.revisedPrompt }
									},
									...prepared.warnings.length === 0 ? {} : { warnings: prepared.warnings }
								}
							});
							return;
						}
						const result = await runAdapterImage(prepared.adapter, prepared.model, prepared.params, {
							signal: controller.signal,
							onProgress: (event) => {
								updateStudioTask(id, {
									phase: event.phase === "poll" ? "生成中" : event.phase === "download" ? "下载" : "提交",
									message: event.message,
									...event.progress === void 0 ? {} : { progress: event.progress }
								});
							}
						});
						const images = [];
						for (const image of result.images) {
							const asset = await persistAsset(Buffer.from(image.b64, "base64"), image.mime, "image");
							images.push({
								...asset,
								...image.revisedPrompt === void 0 ? {} : { revisedPrompt: image.revisedPrompt }
							});
						}
						updateStudioTask(id, {
							state: "done",
							phase: "完成",
							message: `已完成 ${String(images.length)} 张`,
							progress: 100,
							result: {
								kind: "image",
								images
							}
						});
					} catch (error) {
						const cancelled = controller.signal.aborted;
						updateStudioTask(id, {
							state: cancelled ? "cancelled" : "error",
							phase: cancelled ? "已取消" : "失败",
							message: messageOf$2(error),
							...cancelled ? {} : { error: {
								code: "generate-failed",
								message: messageOf$2(error)
							} }
						});
					}
				})();
				writeJson(res, 200, {
					ok: true,
					taskId: id
				});
			}
		},
		{
			kind: "exact",
			path: STUDIO_API.continuum,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody(req);
				if (body === void 0) {
					writeJson(res, 200, {
						ok: false,
						code: "bad-request",
						message: "请求体不是合法 JSON"
					});
					return;
				}
				const prepared = await prepareGenerate({
					...body,
					surface: "video"
				}, await resolveAdapters());
				if ("failure" in prepared) {
					writeJson(res, 200, {
						ok: false,
						code: "invalid",
						message: prepared.failure
					});
					return;
				}
				const request = body;
				const segments = Number(request.segments);
				if (!Number.isFinite(segments) || segments < 1) {
					writeJson(res, 200, {
						ok: false,
						code: "invalid",
						message: "segments 必须是正整数"
					});
					return;
				}
				const { id, controller } = createStudioTask("continuum");
				updateStudioTask(id, {
					state: "running",
					phase: "准备",
					message: `准备渲染 ${String(segments)} 段`
				});
				(async () => {
					try {
						let seedFrame = request.seedFrame;
						if (seedFrame === void 0 && typeof request.seedFromUrl === "string" && request.seedFromUrl !== "") {
							const name = request.seedFromUrl.startsWith(STUDIO_API.file) ? request.seedFromUrl.slice(STUDIO_API.file.length + 1) : request.seedFromUrl.split("/").pop() ?? "";
							const filePath = resolveInside(studioOutDir(), decodeURIComponent(name));
							if (filePath === void 0) throw new Error("续时长：找不到要延续的视频文件");
							seedFrame = await grabTailFrame(await fs.readFile(filePath), filePath.toLowerCase().endsWith(".webm") ? "video/webm" : "video/mp4", path.join(studioOutDir(), "..", "continuum"), { signal: controller.signal });
						}
						const result = await runContinuum({
							adapter: prepared.adapter,
							model: prepared.model,
							prompt: request.prompt,
							segments,
							seconds: prepared.params.duration ?? 5,
							...request.promptStep === void 0 ? {} : { promptStep: request.promptStep },
							...seedFrame === void 0 ? {} : { seedFrame },
							...prepared.params.aspect === void 0 ? {} : { aspect: prepared.params.aspect },
							...prepared.params.resolution === void 0 ? {} : { resolution: prepared.params.resolution },
							...prepared.params.seed === void 0 ? {} : { seed: prepared.params.seed },
							...prepared.params.custom === void 0 ? {} : { custom: prepared.params.custom },
							...request.crossfadeMs === void 0 ? {} : { crossfadeMs: request.crossfadeMs }
						}, {
							signal: controller.signal,
							onProgress: (event) => {
								updateStudioTask(id, {
									phase: event.phase === "stitch" ? "拼接" : "渲染",
									message: event.message,
									...event.progress === void 0 ? {} : { progress: Math.round(event.progress * 100) }
								});
							}
						});
						const final = result.stitched ?? result.segments[result.segments.length - 1];
						const asset = await persistAsset(final.bytes, final.mime, "continuum");
						const kept = [];
						for (const segment of result.segments) {
							const stored = await persistAsset(segment.bytes, segment.mime, `seg${String(segment.index + 1)}`);
							kept.push({
								...stored,
								duration: segment.seconds
							});
						}
						const totalSeconds = result.segments.reduce((sum, segment) => sum + segment.seconds, 0);
						updateStudioTask(id, {
							state: "done",
							phase: "完成",
							message: `已完成 ${String(result.segments.length)} 段`,
							progress: 100,
							result: {
								kind: "video",
								video: {
									...asset,
									duration: result.stitched?.duration ?? totalSeconds
								},
								segments: kept,
								...result.warnings.length === 0 ? {} : { warnings: result.warnings }
							}
						});
					} catch (error) {
						const cancelled = controller.signal.aborted;
						updateStudioTask(id, {
							state: cancelled ? "cancelled" : "error",
							phase: cancelled ? "已取消" : "失败",
							message: messageOf$2(error),
							...cancelled ? {} : { error: {
								code: "continuum-failed",
								message: messageOf$2(error)
							} }
						});
					}
				})();
				writeJson(res, 200, {
					ok: true,
					taskId: id
				});
			}
		},
		{
			kind: "prefix",
			path: STUDIO_API.task,
			handler: async (req, res) => {
				if (!guard(req, res, "GET")) return;
				const url = new URL(req.url ?? "/", "http://127.0.0.1");
				const task = readStudioTask(decodeURIComponent(url.pathname.slice(STUDIO_API.task.length + 1)));
				if (task === void 0) {
					writeJson(res, 200, {
						ok: false,
						code: "not-found",
						message: "任务不存在或已过期"
					});
					return;
				}
				writeJson(res, 200, {
					ok: true,
					task
				});
			}
		},
		{
			kind: "exact",
			path: STUDIO_API.cancel,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody(req);
				const id = typeof body?.taskId === "string" ? body.taskId : "";
				writeJson(res, 200, {
					ok: true,
					cancelled: id !== "" && cancelStudioTask(id)
				});
			}
		},
		{
			kind: "prefix",
			path: STUDIO_API.file,
			handler: async (req, res) => {
				if (!isLoopbackRequest(req)) {
					writeJson(res, 403, {
						ok: false,
						code: "forbidden",
						message: "loopback-only"
					});
					return;
				}
				if (req.method !== "GET") {
					writeJson(res, 405, {
						ok: false,
						code: "method",
						message: "GET only"
					});
					return;
				}
				const url = new URL(req.url ?? "/", "http://127.0.0.1");
				const name = decodeURIComponent(url.pathname.slice(STUDIO_API.file.length + 1));
				const filePath = resolveInside(studioOutDir(), name);
				if (filePath === void 0) {
					writeJson(res, 400, {
						ok: false,
						code: "bad-name",
						message: "非法文件名"
					});
					return;
				}
				const lower = filePath.toLowerCase();
				await sendFile(res, filePath, lower.endsWith(".webm") ? "video/webm" : lower.endsWith(".mov") ? "video/quicktime" : lower.endsWith(".mp4") ? "video/mp4" : lower.endsWith(".jpg") ? "image/jpeg" : lower.endsWith(".webp") ? "image/webp" : lower.endsWith(".gif") ? "image/gif" : lower.endsWith(".mp3") ? "audio/mpeg" : "image/png", typeof req.headers.range === "string" ? req.headers.range : void 0);
			}
		}
	];
}
//#endregion
//#region src/skills-catalog.ts
/** The external-skill name of the deck-rebuilding pipeline this plugin knows
*  how to drive end to end (image → editable .pptx). */
const EDITABLE_PPT_SKILL = "image-to-editable-ppt";
/** Origin label used for built-in catalog entries. */
const BUILTIN_ORIGIN = "builtin";
/** Style presets offered by the text polish action. */
const POLISH_STYLES = [
	"formal",
	"casual",
	"shorter",
	"expand",
	"custom"
];
/** Copy keys of the polish style labels (kept literal so the copy table can
*  typecheck them; a computed template literal would widen to `string`). The
*  catalog reuses the canvas button labels so one style reads the same in the
*  picker and on the text node toolbar. */
const POLISH_STYLE_KEYS = {
	formal: "canvas.polish.formal",
	casual: "canvas.polish.casual",
	shorter: "canvas.polish.shorter",
	expand: "canvas.polish.expand",
	custom: "canvas.polish.custom"
};
/** Built-in ids (stable: they are persisted on produced nodes as provenance). */
const BUILTIN_POLISH = "polish.text";
const BUILTIN_DESCRIBE = "describe.image";
const BUILTIN_EXTRACT = "extract.content";
const BUILTIN_COMPOSE = "compose.videos";
const BUILTIN_PPT = "ppt.fromImages";
/**
* The built-in catalog. Order is the menu order: the high-frequency text
* actions first, the long-running deck conversion last.
* @param t - copy resolver for the current UI language.
* @param options - whether the host agent runtime answered; a heavy entry
*   without one stays visible but marked unavailable. `pptInstallUrl` is the
*   upstream home of the deck pipeline, offered as a one-click install.
*/
function builtinCanvasSkills(t, options) {
	const polishStyles = POLISH_STYLES.map((style) => ({
		id: style,
		label: t(POLISH_STYLE_KEYS[style])
	}));
	return [
		{
			id: BUILTIN_POLISH,
			name: t("canvas.skills.polish"),
			description: t("canvas.skills.polishDesc"),
			origin: BUILTIN_ORIGIN,
			tier: "light",
			accepts: ["text"],
			output: "text",
			params: polishStyles
		},
		{
			id: BUILTIN_DESCRIBE,
			name: t("canvas.skills.describe"),
			description: t("canvas.skills.describeDesc"),
			origin: BUILTIN_ORIGIN,
			tier: "light",
			accepts: ["image"],
			output: "text"
		},
		{
			id: BUILTIN_EXTRACT,
			name: t("canvas.skills.extract"),
			description: t("canvas.skills.extractDesc"),
			origin: BUILTIN_ORIGIN,
			tier: "light",
			accepts: ["file", "image"],
			output: "text"
		},
		{
			id: BUILTIN_COMPOSE,
			name: t("canvas.skills.compose"),
			description: t("canvas.skills.composeDesc"),
			origin: BUILTIN_ORIGIN,
			tier: "local",
			accepts: ["video"],
			output: "video",
			costHint: t("canvas.skills.composeCost")
		},
		{
			id: BUILTIN_PPT,
			name: t("canvas.skills.ppt"),
			description: t("canvas.skills.pptDesc"),
			origin: BUILTIN_ORIGIN,
			tier: "heavy",
			accepts: ["image"],
			output: "file",
			costHint: t("canvas.skills.pptCost"),
			requires: options.agentAvailable ? [t("canvas.skills.pptRequires")] : [t("canvas.skills.needAgent")],
			skillName: EDITABLE_PPT_SKILL,
			...options.pptInstallUrl === void 0 ? {} : { installUrl: options.pptInstallUrl }
		}
	];
}
/** Long-running pipeline markers: a skill matching one of these runs an agent. */
const HEAVY_SKILL_HINTS = [
	"ppt",
	"pptx",
	"slide",
	"deck",
	"keynote",
	"presentation",
	"pdf",
	"word",
	"docx",
	"excel",
	"xlsx",
	"video",
	"render",
	"export",
	"batch",
	"pipeline",
	"ocr"
];
/** Declared tier in skill frontmatter, when a skill author set one. */
function declaredTier(metadata) {
	if (metadata === void 0) return void 0;
	for (const key of [
		"tier",
		"canvasTier",
		"executionTier",
		"runtime"
	]) {
		const value = metadata[key];
		if (value === "heavy" || value === "light") return value;
	}
}
/**
* Decide whether an external skill needs the headless-agent tier. Explicit
* frontmatter wins; otherwise the name/description is matched against the
* long-running pipeline vocabulary. Unknown skills default to `light`, which is
* the cheaper and more predictable failure mode (a light run that is too small
* reports an actionable error instead of silently burning an agent run).
*/
function tierOfExternalSkill(skill) {
	const declared = declaredTier(skill.metadata);
	if (declared !== void 0) return declared;
	const haystack = `${skill.name} ${skill.description} ${skill.whenToUse ?? ""}`.toLowerCase();
	return HEAVY_SKILL_HINTS.some((hint) => haystack.includes(hint)) ? "heavy" : "light";
}
/** Whether one external skill is the deck pipeline this plugin drives itself. */
function isEditablePptSkill(name) {
	return name === "image-to-editable-ppt" || name.includes("image-to-editable") || name.includes("editable-ppt");
}
/**
* Merge the host registry's summaries into the canvas catalog. Only
* model-invocable skills are offered: the canvas runs skills through a model,
* so a user-only (slash-command) skill would fail halfway.
* @param skills - host registry summaries.
* @param t - copy resolver for the current UI language.
* @param options - run-layer availability, used for the heavy entries' hints;
*   `configMissing` reports a skill's unset required configuration by name.
*/
function mergeExternalSkills(skills, t, options) {
	return skills.map((skill) => {
		const tier = tierOfExternalSkill(skill);
		const name = t("canvas.skills.externalName", { name: skill.name });
		const configMissing = options.configMissing?.(skill.name);
		return {
			id: `skill:${skill.name}`,
			name,
			description: skill.description.trim() === "" ? t("canvas.skills.noDescription") : skill.description,
			...skill.whenToUse === void 0 || skill.whenToUse.trim() === "" ? {} : { whenToUse: skill.whenToUse },
			origin: "external",
			tier,
			accepts: [
				"image",
				"text",
				"file"
			],
			output: "text",
			...tier === "heavy" ? {
				costHint: t("canvas.skills.externalHeavyCost", { name: skill.name }),
				requires: options.agentAvailable ? [] : [t("canvas.skills.needAgent")]
			} : {},
			...configMissing === void 0 || configMissing.length === 0 ? {} : { configMissing }
		};
	});
}
/** The whole catalog for one canvas: built-ins first, then host skills. */
function canvasSkillCatalog(external, t, options) {
	const builtins = builtinCanvasSkills(t, options);
	const taken = new Set(builtins.map((skill) => skill.id));
	const merged = mergeExternalSkills(external, t, options).filter((skill) => !taken.has(skill.id));
	return [...builtins, ...merged];
}
/** Resolve one catalog entry by id (built-ins are stable, externals prefixed). */
function findCanvasSkill(catalog, id) {
	return catalog.find((skill) => skill.id === id);
}
//#endregion
//#region src/clip-order.ts
/**
* How close two top edges must be, as a fraction of the shorter node's height,
* for the two nodes to be plausibly in the same row. A knob, not a law — but it
* only has to absorb hand-placed imprecision, so it is deliberately generous.
*/
const ROW_PROXIMITY = .5;
/**
* The most a top-edge difference may ever count for, in pixels.
*
* Without this ceiling the proximity window scales with the clip's own height,
* so a tall clip reaches across a gap a short one could not: given a 700px clip
* with a 240x160 clip to its right, a 700px clip below it, and no overlap
* anywhere, the window is 350px and swallows the lower clip into the upper row
* — leaving it to be ordered by x, so a clip sitting entirely above another
* plays after it. The ceiling is one clip's own footprint (the default video
* node is 240x160): more than that is a row gap, not raggedness.
*/
const ROW_PROXIMITY_LIMIT = 240;
/**
* The least the proximity window may shrink to, in pixels.
*
* The window is a fraction of the *shorter* node, so a clip resized down to the
* minimum node height (64px) leaves a 32px window — tighter than ordinary
* hand-placed imprecision, so a 64px clip sitting beside a taller one in the
* same visual row is thrown onto a row of its own and the taller neighbour is
* then read first. Flooring at one minimum node height keeps small clips
* grouped. See {@link sharesRow} for the pairing that exposed it.
*/
const ROW_PROXIMITY_FLOOR = 64;
/**
* How much horizontal overlap, as a fraction of the narrower node's width,
* means the two nodes may be stacked one under the other rather than side by
* side. Combined with {@link STACK_OFFSET} it is the guard that keeps a column
* from collapsing into a single row.
*/
const STACK_OVERLAP = .5;
/**
* How far apart the top edges must be, as a fraction of the shorter node's
* height, before a horizontally-overlapping pair counts as a column.
*
* The offset matters as much as the overlap. Overlap alone vetoes clips that sit
* level with each other and merely share some width — a hand-placed row — and
* splits it into separate rows, so a clip one pixel lower jumps the queue.
* Requiring a real vertical offset keeps the row intact while still refusing the
* column.
*/
const STACK_OFFSET = .25;
/** Top edge, then left edge, then id — the total order items are walked in. */
function byTopLeft(source, other) {
	if (source.y !== other.y) return source.y - other.y;
	if (source.x !== other.x) return source.x - other.x;
	return source.id < other.id ? -1 : source.id > other.id ? 1 : 0;
}
/** Left edge, then top edge, then id — the total order inside one row. */
function byLeftTop(source, other) {
	if (source.x !== other.x) return source.x - other.x;
	if (source.y !== other.y) return source.y - other.y;
	return source.id < other.id ? -1 : source.id > other.id ? 1 : 0;
}
/** Horizontal overlap of two nodes in pixels; negative when they are apart. */
function horizontalOverlap(source, other) {
	const left = Math.max(source.x, other.x);
	return Math.min(source.x + source.width, other.x + other.width) - left;
}
/** Is one node vertically inside the other? */
function nestedWithin(source, other) {
	return source.y >= other.y && source.y + source.height <= other.y + other.height;
}
/**
* Do the two nodes sit in the same row?
*
* Three conditions, and each is needed.
*
* A node nested inside the *vertical* span of another while overlapping it
* horizontally is part of the same visual group **when its top edge is level
* with its host's**: a small clip dropped on the top of a tall one reads as one
* cluster, and pushing it out leaves the small clip to start a row no one drew.
* This is checked first, because the stacked-pair guard below would otherwise
* fire on exactly this shape — the small clip overlaps its host's width and its
* top edges differ.
*
* The level-top half of that condition is not decoration. Without it, any clip
* merely *inside* a tall neighbour is welded to it, so a clip resting at the
* bottom of a tall host is pulled up to the host's row and jumps ahead of a clip
* that sits entirely above it to the right — a strict inversion, and a common
* one: a 240x1000 host produced it in 24% of layouts. With it, the nesting
* clause only fires on the top-aligned cluster it was written for.
*
* A pair that overlaps horizontally by at least {@link STACK_OVERLAP} of the
* narrower node *and* whose top edges differ by at least {@link STACK_OFFSET} of
* the shorter node is a column, not a ragged row. Dropping the offset half tears
* apart clips that sit level and simply share width; dropping the overlap half
* merges a vertical stack whose neighbours are closer than the window.
*
* Otherwise the pair shares a row when their top edges are within
* {@link ROW_PROXIMITY} of the shorter node's height, floored at
* {@link ROW_PROXIMITY_FLOOR} and capped at {@link ROW_PROXIMITY_LIMIT} pixels.
* Comparing centers instead (an earlier attempt) pushes a clip twice the height
* of its neighbours onto a row of its own, because a tall node's center sinks
* below the short nodes beside it.
*/
function sharesRow(source, other) {
	const offset = Math.abs(source.y - other.y);
	const shorter = Math.min(source.height, other.height);
	const narrower = Math.min(source.width, other.width);
	const overlap = horizontalOverlap(source, other);
	const window = Math.min(Math.max(ROW_PROXIMITY * shorter, ROW_PROXIMITY_FLOOR), ROW_PROXIMITY_LIMIT);
	if (overlap > 0) {
		const inner = nestedWithin(source, other) ? source : nestedWithin(other, source) ? other : void 0;
		if (inner !== void 0) {
			const host = inner === source ? other : source;
			if (Math.abs(inner.y - host.y) < window) return true;
		}
	}
	if (overlap >= STACK_OVERLAP * narrower && offset >= STACK_OFFSET * shorter) return false;
	return offset < window;
}
/**
* Group items into reading-order rows: top-to-bottom, left-to-right within a row.
*
* Items are walked in ascending top edge, and each joins the first existing row
* it shares a row with every member of; if there is no such row it starts a new
* one. Requiring every member rather than any one of them is what stops a chain
* of pairwise-overlapping nodes from dragging distant items into the same row.
* That also makes rows come out in top-edge order without a second sort.
*/
function rowMajorOrder(items) {
	const rows = [];
	for (const item of [...items].sort(byTopLeft)) {
		const row = rows.find((candidate) => candidate.every((member) => sharesRow(item, member)));
		if (row === void 0) rows.push([item]);
		else row.push(item);
	}
	return rows.flatMap((row) => [...row].sort(byLeftTop));
}
/** Is `source` wholly above `other` — not one pixel of shared height? */
function entirelyAbove(source, other) {
	return source.y + source.height <= other.y;
}
/**
* Reorder so that a clip never plays after one that sits wholly above it.
*
* Row grouping is a heuristic that can be fooled: rows are compared pairwise, so
* a tall clip can end up grouped with a neighbour that happens to sit beside it
* while a clip entirely above it was grouped elsewhere, and the flat row order
* then plays the lower clip first. No threshold prevents that — every pairing of
* "close enough" against "far enough" eventually finds a shape on both sides of
* the line.
*
* "Wholly above" is not a heuristic, though: it is a strict partial order. So
* rather than tune the grouping further, this pass keeps the row order as a
* preference and repairs only the cases that are provably wrong, by stably
* topologically sorting the graph of that relation — always taking the node the
* row order preferred, among those whose above-neighbours are already placed.
*
* The repair is provably a no-op whenever the row order was already sound. If no
* clip sits wholly above one that precedes it, then every edge points forward in
* the row order, that order is itself a topological order, and at each step the
* earliest unplaced node is available — so the pass returns exactly what it was
* given. Measured: it moved nothing at all in 200,000 random layouts whose node
* sizes were limited to the three the canvas can produce on its own
* (240x160 / 200x240 / 240x240); it moved a clip in 3,605 of 200,000 layouts
* once the size pool also allowed ordinary drags (adding 96x64, 240x64, 240x600,
* 240x1000, 400x900), and in every one of those the row order contained a
* provable inversion.
*
* The graph is quadratic, which is free here: a stitch is a handful of clips.
* Note that the host does NOT cap the count — `runCompose` never consults
* `MAX_SKILL_INPUT_NODES`, and the client's compose branch returns before its
* own batch cap — so this comment must not be read as a guarantee.
*/
function liftAbove(base) {
	const count = base.length;
	const edges = base.map(() => []);
	const waited = new Array(count).fill(0);
	for (let before = 0; before < count; before += 1) for (let after = 0; after < count; after += 1) {
		if (before === after) continue;
		if (entirelyAbove(base[before], base[after])) {
			edges[before].push(after);
			waited[after] += 1;
		}
	}
	const placed = new Array(count).fill(false);
	const ordered = [];
	for (let step = 0; step < count; step += 1) {
		let pick = -1;
		for (let index = 0; index < count; index += 1) if (!placed[index] && waited[index] === 0) {
			pick = index;
			break;
		}
		if (pick === -1) {
			for (let index = 0; index < count; index += 1) if (!placed[index]) {
				pick = index;
				break;
			}
		}
		placed[pick] = true;
		ordered.push(base[pick]);
		for (const next of edges[pick]) waited[next] -= 1;
	}
	return ordered;
}
/**
* Sort items into stitch order: top-to-bottom rows, left-to-right within a row,
* with a clip never after one that sits wholly above it.
*
* Returned array is a new array; input is untouched.
*/
function orderByPosition(items) {
	return liftAbove(rowMajorOrder(items));
}
/** Cap on the text handed to the light tier from text nodes. */
const MAX_INLINE_TEXT = 4e4;
/** Cap on the images handed to one vision call. */
const MAX_VISION_IMAGES = 6;
/** Completed tasks are kept for the poll window, then evicted. */
const MAX_TRACKED_TASKS = 200;
/** Output node footprints (world units), matching the client's node sizes. */
const TEXT_NODE_SIZE = {
	width: 320,
	height: 260
};
const FILE_NODE_SIZE = {
	width: 300,
	height: 170
};
/** Video-node footprint, matching the client's 16:9 video nodes. */
const VIDEO_NODE_SIZE = {
	width: 240,
	height: 160
};
const NODE_GAP = 96;
/** Minimum clips one compose run needs: stitching one clip is a no-op. */
const MIN_COMPOSE_SOURCES = 2;
/**
* Parse the timeline parameter, refusing anything that would silently change
* the film.
*
* A malformed timeline is NOT ignored: falling back to a plain stitch would
* hand the user a video that ignores the trims they set and look like the
* editor did nothing. Returning undefined is reserved for "no timeline sent",
* which is the ordinary stitch path.
*/
function parseTimelineParam(raw) {
	if (raw === void 0 || raw.trim() === "") return void 0;
	let value;
	try {
		value = JSON.parse(raw);
	} catch {
		throw new Error("the timeline parameter is not valid JSON");
	}
	if (value === null || typeof value !== "object") throw new Error("the timeline parameter is not an object");
	const record = value;
	const segments = Array.isArray(record.segments) ? record.segments.flatMap((item) => {
		if (item === null || typeof item !== "object") return [];
		const segment = item;
		if (typeof segment.nodeId !== "string" || segment.nodeId === "") return [];
		const inPoint = typeof segment.inPoint === "number" && Number.isFinite(segment.inPoint) ? Math.max(0, segment.inPoint) : 0;
		const outPoint = typeof segment.outPoint === "number" && Number.isFinite(segment.outPoint) ? segment.outPoint : void 0;
		return [{
			nodeId: segment.nodeId,
			inPoint,
			...outPoint === void 0 || outPoint <= inPoint ? {} : { outPoint }
		}];
	}) : [];
	if (segments.length === 0) throw new Error("the timeline parameter carries no usable segment");
	return {
		segments,
		transitions: Array.isArray(record.transitions) ? record.transitions.flatMap((item) => {
			if (item === null || typeof item !== "object") return [];
			const transition = item;
			const kind = transition.kind === "fade" || transition.kind === "dissolve" ? transition.kind : "cut";
			const seconds = typeof transition.seconds === "number" && Number.isFinite(transition.seconds) ? transition.seconds : .5;
			return [{
				kind,
				seconds: Math.max(0, seconds)
			}];
		}) : [],
		keepAudio: record.keepAudio !== false
	};
}
/** Chat-model instructions per built-in light action. */
const POLISH_DIRECTIVES = {
	formal: {
		zh: "改写得更正式、专业、书面化，保留原意与信息量，不要添加新事实。",
		en: "Rewrite it in a more formal, professional register. Preserve meaning and facts; add nothing."
	},
	casual: {
		zh: "改写得更口语、轻松、自然，保留原意与信息量。",
		en: "Rewrite it in a casual, conversational, natural voice. Preserve meaning and facts."
	},
	shorter: {
		zh: "压缩到原文 60% 以内的篇幅，只保留关键信息，语句通顺。",
		en: "Compress it to at most 60% of the original length, keeping only the key information."
	},
	expand: {
		zh: "在保留原意的前提下扩写，补充必要的细节、例子或过渡，让内容更充实。",
		en: "Expand it with necessary detail, examples or transitions while preserving the original intent."
	}
};
const DESCRIBE_SYSTEM = "你是图像理解引擎。请用简洁、具体的语言描述这张图片：主体、场景、构图、光线、色彩风格、文字与关键元素。只输出描述正文，不要客套话，不要 markdown 标题。";
function describeSystem(language) {
	return language.startsWith("zh") || language === "" ? DESCRIBE_SYSTEM : "You are an image-understanding engine. Describe this image concretely: subject, scene, composition, lighting, color and style, text and key elements. Output the description only — no preface, no markdown headings.";
}
/** Deterministic id generator, injectable for tests. */
let idFactory = (prefix) => `${prefix}-${randomUUID()}`;
function newId(prefix) {
	return idFactory(prefix);
}
function messageOf$1(error) {
	return error instanceof Error ? error.message : String(error);
}
function baseMime(mime) {
	return mime.split(";")[0].trim().toLowerCase();
}
function isImageAsset(asset) {
	return asset.kind !== "file" && baseMime(asset.mime).startsWith("image/");
}
function nodeText(node) {
	return typeof node.metadata?.text === "string" ? node.metadata.text.trim() : "";
}
function nodeTitle(node) {
	return node.title.trim() === "" ? node.type : node.title.trim();
}
/** Union of explicit ids and every node connected into them. */
function resolveInputIds(document, request) {
	const explicit = request.nodeIds.filter((id) => id.trim() !== "");
	const targets = explicit.length > 0 ? explicit : [];
	const ids = new Set(targets);
	for (const connection of document.connections) if (targets.includes(connection.toNodeId)) ids.add(connection.fromNodeId);
	return [...ids];
}
function textOutputNode(source, title, text, skillId, label, sourceIds) {
	const metadata = source.metadata ?? {};
	return {
		id: newId("node"),
		type: "text",
		title,
		x: source.x + source.width + NODE_GAP,
		y: source.y,
		width: TEXT_NODE_SIZE.width,
		height: TEXT_NODE_SIZE.height,
		metadata: {
			text,
			fontSize: typeof metadata.fontSize === "number" ? metadata.fontSize : 14,
			status: "success",
			skill: {
				id: skillId,
				label,
				sourceNodeIds: sourceIds,
				createdAt: Date.now()
			}
		}
	};
}
function fileOutputNode(source, asset, title, skillId, label, sourceIds) {
	return {
		id: newId("node"),
		type: "file",
		title,
		x: source.x + source.width + NODE_GAP,
		y: source.y,
		width: FILE_NODE_SIZE.width,
		height: FILE_NODE_SIZE.height,
		metadata: {
			asset,
			fileKind: fileKindOf(asset.mime, asset.name ?? ""),
			status: "success",
			skill: {
				id: skillId,
				label,
				sourceNodeIds: sourceIds,
				createdAt: Date.now()
			}
		}
	};
}
/** Wrap produced nodes into the wire output (drafts only — no ids rewritten). */
function outputOf(nodes, connections, warnings = []) {
	return {
		nodes,
		connections,
		warnings
	};
}
/**
* A produced clip node: a 16:9 video node REFERENCING the stitched clip in the
* video store — never a canvas asset, so no bytes are copied and the node
* behaves exactly like a clip added from the history.
*/
function videoOutputNode(source, clip, title, skillId, label, sourceIds) {
	return {
		id: newId("node"),
		type: "video",
		title,
		x: source.x + source.width + NODE_GAP,
		y: source.y,
		width: VIDEO_NODE_SIZE.width,
		height: VIDEO_NODE_SIZE.height,
		metadata: {
			video: {
				url: clip.url,
				mime: clip.mime,
				...clip.entryId === void 0 ? {} : { entryId: clip.entryId },
				...clip.duration === void 0 ? {} : { duration: clip.duration }
			},
			status: "success",
			skill: {
				id: skillId,
				label,
				sourceNodeIds: sourceIds,
				createdAt: Date.now()
			}
		}
	};
}
/** whenIdle contains driver errors; inspect its durable turn ending instead. */
function agentSessionFailure(session) {
	if (session.eventAt === void 0 || !Number.isSafeInteger(session.seq)) return void 0;
	for (let index = session.seq - 1; index >= Math.max(0, session.seq - 1e3); index -= 1) {
		const raw = session.eventAt(index);
		if (raw?.type !== "turn/end") continue;
		const reason = raw.data?.reason;
		if (reason?.kind === "error") return redactDiagnosticText([reason.error?.code, reason.error?.message].filter(Boolean).join(": ") || "Agent execution failed");
		if (reason?.kind === "aborted") return `Agent stopped (${reason.reason?.kind ?? "aborted"})`;
		return;
	}
}
/** Find the last assistant text in a session message list (structural). */
function lastAssistantText(messages) {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message === null || typeof message !== "object") continue;
		const record = message;
		if (record.role !== "assistant" || !Array.isArray(record.content)) continue;
		const text = record.content.flatMap((block) => {
			if (block === null || typeof block !== "object") return [];
			const entry = block;
			return entry.type === "text" && typeof entry.text === "string" ? [entry.text] : [];
		}).join("\n").trim();
		if (text !== "") return text;
	}
}
var SkillRunner = class {
	options;
	tasks = /* @__PURE__ */ new Map();
	cancellers = /* @__PURE__ */ new Map();
	tail = Promise.resolve();
	backend;
	constructor(options) {
		this.options = options;
		this.backend = { ...options.backend };
	}
	/**
	* Attach or replace the optional host seams (skill registry, agent runtime).
	* Called from the plugin's soft injection once those services exist, and with
	* an empty object when they unload. The chat and canvas seams are never
	* replaced here.
	* @param parts - the seams to adopt; omitted keys are cleared.
	*/
	attach(parts) {
		this.backend.registry = parts.registry;
		this.backend.agents = parts.agents;
		this.backend.skillConfig = parts.skillConfig;
	}
	/**
	* The catalog offered to the canvas (built-ins + allowlisted host skills).
	* @param language - UI language for the catalog copy (falls back to the
	*   installed resolver, then to the runner default).
	*/
	async list(language) {
		const t = this.translate(language);
		const registry = this.backend.registry;
		const agentAvailable = this.backend.agents?.available() === true && this.options.heavyEnabled();
		if (!this.options.enabled()) return {
			skills: [],
			agentAvailable,
			registryAvailable: registry !== void 0,
			installed: [],
			reason: t("canvas.skills.disabled")
		};
		let external = [];
		let registryAvailable = false;
		let reason;
		if (registry === void 0) reason = t("canvas.skills.noRegistry");
		else try {
			const listed = await registry.list();
			const allow = this.options.allowlist().map((item) => item.trim()).filter((item) => item !== "");
			external = allow.length === 0 ? listed : listed.filter((skill) => allow.includes(skill.name));
			registryAvailable = true;
		} catch (error) {
			reason = t("canvas.skills.registryFailed", { message: messageOf$1(error) });
		}
		const missing = this.backend.skillConfig === void 0 ? void 0 : await this.backend.skillConfig.missing(external.map((skill) => skill.name)).catch(() => void 0);
		return {
			skills: canvasSkillCatalog(external, t, {
				agentAvailable,
				...this.options.pptInstallUrl === void 0 ? {} : { pptInstallUrl: this.options.pptInstallUrl },
				...missing === void 0 ? {} : { configMissing: (name) => missing.get(name) }
			}),
			agentAvailable,
			registryAvailable,
			installed: external.map((skill) => skill.name),
			...reason === void 0 ? {} : { reason },
			...agentAvailable ? {} : { reason: reason ?? t("canvas.skills.needAgent") }
		};
	}
	/** Queue one run and return its task immediately (the client polls it). */
	async run(request) {
		const t = this.translate(request.language);
		const catalog = await this.list(request.language);
		const skill = catalog.skills.find((item) => item.id === request.skillId);
		if (skill === void 0) throw new Error(t("canvas.skills.unknown"));
		if (skill.id === "compose.videos") return this.runCompose(skill, request);
		const document = await this.backend.canvas.read(request.canvasId);
		if (document === void 0) throw new Error(t("canvas.skills.canvasMissing"));
		const ids = resolveInputIds(document, request).slice(0, 12);
		const byId = new Map(document.nodes.map((node) => [node.id, node]));
		const inputs = ids.flatMap((id) => {
			const node = byId.get(id);
			if (node === void 0 || node.type === "config") return [];
			const asset = node.metadata?.asset;
			return [{
				node,
				...asset === void 0 ? {} : { asset }
			}];
		});
		if (inputs.length === 0) throw new Error(t("canvas.skills.noInput"));
		const target = inputs.find((input) => request.nodeIds.includes(input.node.id)) ?? inputs[0];
		if (!skill.accepts.includes(target.node.type)) throw new Error(t("canvas.skills.incompatible"));
		if (skill.tier === "heavy" && !catalog.agentAvailable) throw new Error(t("canvas.skills.needAgent"));
		request.language;
		return this.startTask(request, skill, inputs);
	}
	/**
	* Create, track and queue one task.
	*
	* Split out of {@link run} because a standalone conversion builds its inputs
	* itself: it has no canvas to resolve them from, and its task has to carry
	* the slide list so a reloaded panel can still show what was submitted.
	* @param ppt - true for a standalone conversion, which persists its task.
	*/
	async startTask(request, skill, inputs, ppt = false) {
		const language = request.language;
		const task = {
			id: newId("skillrun"),
			canvasId: request.canvasId,
			skillId: skill.id,
			label: skill.name,
			tier: skill.tier,
			status: "queued",
			stage: this.translate(language)("canvas.skills.stageQueued"),
			phase: "queued",
			nodeIds: [...request.nodeIds],
			startedAt: Date.now(),
			...language === void 0 || language === "" ? {} : { language },
			...ppt ? { pptImages: inputs.flatMap((input) => input.asset === void 0 ? [] : [input.asset]) } : {}
		};
		this.tasks.set(task.id, task);
		try {
			await this.persistPpt(task);
		} catch (error) {
			this.tasks.delete(task.id);
			throw error;
		}
		this.pruneTasks();
		this.enqueue(task, skill, inputs, request).catch((error) => {
			task.status = "failed";
			task.error = messageOf$1(error);
			task.finishedAt = Date.now();
		});
		return task;
	}
	/** One task snapshot, or undefined once evicted. */
	task(id) {
		return this.tasks.get(id);
	}
	/** Unfinished runs of one canvas, so a reopened canvas can rebuild its live
	*  run cards after a reload (the browser holds no run state itself). */
	tasksOfCanvas(canvasId) {
		return [...this.tasks.values()].filter((task) => task.canvasId === canvasId && (task.status === "queued" || task.status === "running"));
	}
	/** Cancel a queued or running task. */
	async cancel(id) {
		const task = this.tasks.get(id);
		if (task === void 0) return false;
		if (task.status === "completed" || task.status === "failed" || task.status === "cancelled") return false;
		task.status = "cancelled";
		task.stage = this.translate(task.language)("canvas.skills.stageCancelled");
		task.finishedAt = Date.now();
		const canceller = this.cancellers.get(id);
		this.cancellers.delete(id);
		if (canceller !== void 0) await canceller.dispose().catch(() => {});
		await this.persistPpt(task);
		return true;
	}
	/**
	* Standalone image-to-PPT conversion: the same installed skill the canvas
	* uses, run without creating a canvas.
	*
	* The run is keyed by `canvasId: 'ppt'`, which is what marks it as a
	* conversion everywhere else (prompt, deck validation, persistence) rather
	* than threading a flag through every method.
	*/
	async runPpt(request) {
		const t = this.translate(request.language);
		const catalog = await this.list(request.language);
		const skill = catalog.skills.find((item) => item.id === BUILTIN_PPT);
		if (skill === void 0 || !catalog.agentAvailable) throw new Error(t("canvas.skills.needAgent"));
		if (!catalog.installed.includes("image-to-editable-ppt")) throw new Error(t("canvas.skills.skillMissing", { name: EDITABLE_PPT_SKILL }));
		if (request.images.length === 0 || request.images.length > 12) throw new Error(t("ppt.inputLimit"));
		const inputs = [];
		for (const [index, asset] of request.images.entries()) {
			const found = await this.backend.canvas.readAsset(asset.assetId);
			if (found === void 0 || !/^image\/(png|jpeg|webp)$/.test(found.mime)) throw new Error(t("ppt.invalidImage"));
			const safeAsset = {
				...asset,
				mime: found.mime,
				name: `slide-${index + 1}.${found.mime === "image/jpeg" ? "jpg" : found.mime.split("/")[1]}`
			};
			inputs.push({
				asset: safeAsset,
				node: {
					id: newId("ppt-input"),
					type: "image",
					title: safeAsset.name,
					x: 0,
					y: 0,
					width: 320,
					height: 240,
					metadata: { asset: safeAsset }
				}
			});
		}
		return this.startTask({
			canvasId: "ppt",
			skillId: BUILTIN_PPT,
			nodeIds: inputs.map((input) => input.node.id),
			language: request.language,
			instruction: request.offlineOcr ? "The user explicitly chose offline text detection for this run. Use upstream editppt prepare --no-text-hints, then editppt page hints for each page to generate offline hints before reconstruction. Do not call PaddleOCR for this run or ask about a token again. All other upstream steps remain required." : "Use the configured PaddleOCR token. Follow the upstream skill if OCR fails; do not silently downgrade quality."
		}, skill, inputs, true);
	}
	/** Conversion history, so a panel reload or a host restart does not lose it. */
	async pptTasks() {
		const dir = path.join(this.options.dataRoot(), "ppt-tasks");
		const files = await promises.readdir(dir).catch(() => []);
		const persisted = [];
		for (const name of files.filter((entry) => /^skillrun-[\w-]+\.json$/.test(entry))) {
			const task = await promises.readFile(path.join(dir, name), "utf8").then((raw) => JSON.parse(raw)).catch(() => void 0);
			if (task === void 0 || task.canvasId !== "ppt" || task.id !== name.slice(0, -5)) continue;
			const live = this.tasks.get(task.id);
			if (live !== void 0) {
				persisted.push(live);
				continue;
			}
			if (task.status === "queued" || task.status === "running") {
				task.status = "failed";
				task.error = this.translate(task.language)("ppt.interrupted");
				task.finishedAt = Date.now();
				await this.persistPpt(task);
			}
			persisted.push(task);
		}
		for (const task of this.tasks.values()) if (task.canvasId === "ppt" && !persisted.some((item) => item.id === task.id)) persisted.push(task);
		return persisted.sort((a, b) => b.startedAt - a.startedAt);
	}
	/** Write one conversion task to disk; a no-op for canvas runs. */
	async persistPpt(task) {
		if (task.canvasId !== "ppt") return;
		const dir = path.join(this.options.dataRoot(), "ppt-tasks");
		await promises.mkdir(dir, { recursive: true });
		const file = path.join(dir, `${task.id}.json`);
		const temporary = `${file}.${randomUUID()}.tmp`;
		await promises.writeFile(temporary, JSON.stringify(task), "utf8");
		await promises.rename(temporary, file);
	}
	/**
	* Queue one clip-stitch run and return its task immediately.
	*
	* Separate from {@link run} for one reason: the shared input construction only
	* understands `metadata.asset`, while a clip node carries a *reference*
	* (`metadata.video.url`) whose bytes live in the video store. Building the
	* inputs here keeps the four existing skills on their untouched path.
	* @param skill - the compose catalog entry.
	* @param request - the run request (its `nodeIds` are the user's selection).
	*/
	async runCompose(skill, request) {
		const t = this.translate(request.language);
		const composer = this.options.composer;
		if (composer === void 0) throw new Error(t("canvas.skills.composeNoFfmpeg", { detail: "no local composer is wired into this host" }));
		const document = await this.backend.canvas.read(request.canvasId);
		if (document === void 0) throw new Error(t("canvas.skills.canvasMissing"));
		const byId = new Map(document.nodes.map((node) => [node.id, node]));
		const clips = [];
		const seen = /* @__PURE__ */ new Set();
		for (const id of request.nodeIds) {
			if (seen.has(id)) continue;
			const node = byId.get(id);
			if (node === void 0 || node.type !== "video") continue;
			if ((node.metadata?.video?.url ?? "") === "") continue;
			seen.add(id);
			clips.push(node);
		}
		const ordered = orderByPosition(clips);
		if (ordered.length < MIN_COMPOSE_SOURCES) throw new Error(t("canvas.skills.composeTooFew"));
		const language = request.language;
		const task = {
			id: newId("skillrun"),
			canvasId: request.canvasId,
			skillId: skill.id,
			label: skill.name,
			tier: skill.tier,
			status: "queued",
			stage: this.translate(language)("canvas.skills.stageQueued"),
			phase: "queued",
			nodeIds: ordered.map((node) => node.id),
			startedAt: Date.now(),
			...language === void 0 || language === "" ? {} : { language }
		};
		this.tasks.set(task.id, task);
		this.pruneTasks();
		const timeline = parseTimelineParam(request.params?.timeline);
		this.enqueue(task, skill, [], request, () => this.stitchClips(task, skill, ordered, composer, timeline)).catch((error) => {
			task.status = "failed";
			task.error = messageOf$1(error);
			task.finishedAt = Date.now();
		});
		return task;
	}
	/**
	* The `local` tier: one ffmpeg invocation on this machine through the
	* injected {@link ClipComposer}. No model, no agent, no network.
	*/
	async stitchClips(task, skill, clips, composer, timeline) {
		const t = this.translate(task.language);
		if (!composer.available()) throw new Error(t("canvas.skills.composeNoFfmpeg", { detail: composer.describe() }));
		const sources = [];
		for (let index = 0; index < clips.length; index += 1) {
			const node = clips[index];
			const url = node.metadata?.video?.url ?? "";
			const local = await composer.resolve(url);
			if (local === void 0) throw new Error(t("canvas.skills.composeFailed", { message: `${t("canvas.composeBadge", { index: index + 1 })}：${nodeTitle(node)}` }));
			sources.push(local);
		}
		const controller = new AbortController();
		this.cancellers.set(task.id, { dispose: async () => {
			controller.abort();
		} });
		task.stage = t("canvas.skills.composeStageProbe");
		task.phase = "running";
		const trims = timeline === void 0 ? void 0 : timeline.segments.map((segment) => {
			clips.findIndex((node) => node.id === segment.nodeId);
			return {
				start: Math.max(0, segment.inPoint),
				...segment.outPoint === void 0 ? {} : { seconds: Math.max(0, segment.outPoint - segment.inPoint) }
			};
		});
		const playOrder = timeline === void 0 || trims === void 0 ? sources : (() => {
			const ordered = [];
			for (const segment of timeline.segments) {
				const index = clips.findIndex((node) => node.id === segment.nodeId);
				const source = index < 0 ? void 0 : sources[index];
				if (source !== void 0) ordered.push(source);
			}
			return ordered.length === sources.length ? ordered : sources;
		})();
		const orderedTrims = timeline === void 0 || trims === void 0 ? trims : playOrder.map((source) => {
			const index = sources.indexOf(source);
			return trims[index] ?? { start: 0 };
		});
		let stitched;
		try {
			stitched = await composer.stitch({
				sources: playOrder,
				...orderedTrims === void 0 ? {} : { trims: orderedTrims },
				...timeline === void 0 ? {} : { transitions: timeline.transitions },
				...timeline === void 0 ? {} : { keepAudio: timeline.keepAudio },
				signal: controller.signal,
				onStage: (stage) => {
					task.stage = stage === "probe" ? t("canvas.skills.composeStageProbe") : t("canvas.skills.composeStageEncode");
				}
			});
		} catch (error) {
			throw new Error(t("canvas.skills.composeFailed", { message: messageOf$1(error) }));
		}
		task.stage = t("canvas.skills.composeStageEncode");
		const entryId = newId("compose");
		const clip = await composer.publish({
			id: entryId,
			bytes: stitched.bytes,
			mime: stitched.mime,
			...stitched.duration === void 0 ? {} : { duration: stitched.duration },
			prompt: this.composePrompt(clips)
		});
		task.stage = t("canvas.skills.composeDone", { count: clips.length });
		const anchor = clips[clips.length - 1];
		const node = videoOutputNode(anchor, {
			...clip,
			entryId
		}, t("canvas.skills.composeNode"), skill.id, skill.name, clips.map((item) => item.id));
		const connections = clips.map((source) => ({
			id: newId("edge"),
			fromNodeId: source.id,
			toNodeId: node.id
		}));
		return outputOf([node], connections);
	}
	/**
	* Provenance for the history entry ("stitched from N clips: …").
	*
	* Deliberately NOT localized: this string is persisted into the video index and
	* re-read later, possibly after the user switches language, so a translated
	* prefix would leave a Chinese entry labelled in Chinese inside an English UI.
	* The per-clip parts are the user's own prompts/titles, which are their content.
	*/
	composePrompt(clips) {
		const list = clips.map((node, index) => {
			const prompt = typeof node.metadata?.prompt === "string" ? node.metadata.prompt.trim() : "";
			return `${index + 1}. ${prompt === "" ? nodeTitle(node) : prompt}`;
		}).join(" · ");
		return `stitched from ${clips.length} clips: ${list}`;
	}
	/**
	* The `local` tier: work that runs on this machine and never calls a model.
	* The caller owns the shape of the inputs, so it hands in the job itself.
	*/
	async runLocal(task, local) {
		if (local === void 0) throw new Error(`${this.translate(task.language)("canvas.skills.unknown")} (${task.skillId})`);
		return local();
	}
	/**
	* Serialize one job on the shared tail.
	* @param local - the work of a `local`-tier skill, supplied by the caller that
	*   knows the shape of its inputs (see {@link runCompose}).
	*/
	enqueue(task, skill, inputs, request, local) {
		const cancelled = () => this.tasks.get(task.id)?.status === "cancelled";
		const run = async () => {
			if (cancelled()) return;
			task.status = "running";
			task.phase = "running";
			try {
				task.output = skill.tier === "heavy" ? await this.runHeavy(task, skill, inputs, request) : skill.tier === "local" ? await this.runLocal(task, local) : await this.runLight(task, skill, inputs, request);
				if (!cancelled()) {
					task.status = "completed";
					task.stage = this.translate(task.language)("canvas.skills.stageDone");
					task.phase = void 0;
				}
			} catch (error) {
				if (!cancelled()) {
					task.status = "failed";
					task.error = messageOf$1(error);
					task.phase = void 0;
				}
			} finally {
				task.finishedAt = Date.now();
				this.cancellers.delete(task.id);
				await this.persistPpt(task).catch(() => {});
			}
		};
		const next = this.tail.then(run, run);
		this.tail = next.then(() => void 0, () => void 0);
		return next;
	}
	pruneTasks() {
		if (this.tasks.size <= MAX_TRACKED_TASKS) return;
		const finished = [...this.tasks.values()].filter((task) => task.finishedAt !== void 0).sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0));
		for (const task of finished.slice(0, this.tasks.size - MAX_TRACKED_TASKS)) this.tasks.delete(task.id);
	}
	async runLight(task, skill, inputs, request) {
		const t = this.translate(task.language);
		const chat = this.backend.chat;
		if (chat === void 0) throw new Error(t("canvas.skills.noChat"));
		task.stage = t("canvas.skills.stageReading");
		task.phase = "running";
		await this.loadAssets(inputs);
		const target = inputs.find((input) => request.nodeIds.includes(input.node.id)) ?? inputs[0];
		if (skill.id === "extract.content" && target.node.type === "file") return this.runBuiltinExtract(target, skill, t);
		if (skill.id === "extract.content") return this.runCollectedLight(target, inputs, skill, t);
		if (skill.id === "describe.image") return this.runBuiltinDescribe(target, inputs, skill, chat, t);
		if (skill.id === "polish.text") return this.runBuiltinPolish(target, skill, request, chat, t);
		return this.runExternalLight(target, inputs, skill, request, chat, t);
	}
	/** Read the asset bytes for every image/file input once. */
	async loadAssets(inputs) {
		const canvas = this.backend.canvas;
		const pending = inputs.filter((input) => input.asset !== void 0 && input.data === void 0);
		if (pending.length === 0) return;
		const refs = pending.map((input) => input.asset).filter((ref) => ref.assetId !== "");
		const found = await canvas.readAssets(refs);
		for (const input of pending) {
			const asset = input.asset;
			const hit = found.get(asset.assetId);
			if (hit !== void 0) input.data = hit.data;
		}
	}
	runBuiltinExtract(target, skill, t) {
		const asset = target.asset;
		if (asset === void 0 || target.data === void 0) throw new Error(t("canvas.skills.fileMissing"));
		const name = asset.name ?? asset.assetId;
		const extracted = extractFileText(target.data, name, asset.mime);
		const warnings = [...extracted.warning === void 0 ? [] : [extracted.warning], ...extracted.truncated ? [t("canvas.skills.truncated", { count: MAX_EXTRACTED_CHARS })] : []];
		if (!extracted.supported) throw new Error(extracted.warning ?? t("canvas.skills.extractFailed"));
		const sourceIds = [target.node.id];
		const node = textOutputNode(target.node, t("canvas.skills.extractNodeTitle", { name }), extracted.text, skill.id, skill.name, sourceIds);
		const connection = {
			id: newId("edge"),
			fromNodeId: target.node.id,
			toNodeId: node.id
		};
		return outputOf([node], [connection], warnings);
	}
	/** Collect text from every input and hand it to the model in one shot. Used
	*  when a built-in cannot decode the input itself (image extraction). */
	runCollectedLight(target, inputs, skill, t) {
		const subject = inputs.find((input) => input.node.id === target.node.id) ?? inputs[0];
		const pieces = [];
		const warnings = [];
		for (const input of inputs) {
			const text = nodeText(input.node);
			if (text !== "") {
				pieces.push(text);
				continue;
			}
			const asset = input.asset;
			if (asset === void 0 || input.data === void 0) continue;
			const extracted = extractFileText(input.data, asset.name ?? asset.assetId, asset.mime);
			if (extracted.supported && extracted.text !== "") pieces.push(extracted.text);
			else if (extracted.warning !== void 0) warnings.push(extracted.warning);
		}
		if (pieces.length === 0) throw new Error(t("canvas.skills.nothingToRead"));
		const joined = pieces.join("\n\n---\n\n");
		const text = `${t("canvas.skills.summaryHead", { count: pieces.length })}\n\n${joined.slice(0, MAX_EXTRACTED_CHARS)}`;
		const node = textOutputNode(subject.node, skill.name, text, skill.id, skill.name, [subject.node.id]);
		return outputOf([node], [{
			id: newId("edge"),
			fromNodeId: subject.node.id,
			toNodeId: node.id
		}], warnings);
	}
	async runBuiltinDescribe(target, inputs, skill, chat, t) {
		const images = inputs.filter((input) => input.node.type === "image" && input.asset !== void 0 && isImageAsset(input.asset));
		if (images.length === 0) throw new Error(t("canvas.skills.needImage"));
		const parts = [{
			type: "text",
			text: t("canvas.skills.describeAsk", { count: images.length })
		}];
		for (const input of images.slice(0, MAX_VISION_IMAGES)) {
			if (input.data === void 0) continue;
			parts.push({
				type: "image_url",
				image_url: { url: `data:${baseMime(input.asset.mime)};base64,${input.data.toString("base64")}` }
			});
		}
		const answer = await chat.complete({
			system: describeSystem(currentSkillLanguage()),
			content: parts,
			temperature: .3
		});
		const warnings = images.length > MAX_VISION_IMAGES ? [t("canvas.skills.tooManyImages", { count: MAX_VISION_IMAGES })] : [];
		const node = textOutputNode(target.node, skill.name, answer, skill.id, skill.name, [target.node.id]);
		return outputOf([node], [{
			id: newId("edge"),
			fromNodeId: target.node.id,
			toNodeId: node.id
		}], warnings);
	}
	async runBuiltinPolish(target, skill, request, chat, t) {
		const original = nodeText(target.node);
		if (original === "") throw new Error(t("canvas.skills.needText"));
		const style = (request.params?.style ?? "formal").trim();
		const language = currentSkillLanguage();
		const english = !(language.startsWith("zh") || language === "");
		const directive = style === "custom" ? (request.instruction ?? "").trim() : (POLISH_DIRECTIVES[style] ?? POLISH_DIRECTIVES.formal)[english ? "en" : "zh"];
		if (directive === "") throw new Error(t("canvas.skills.needInstruction"));
		const system = english ? "You are a text editor. Rewrite the user text following the instruction exactly. Preserve the original language and every fact. Return only the rewritten text — no preface, no quotes, no markdown fences." : "你是文字编辑。请严格按指令改写用户提供的文本，保持原语言与全部事实不变。只输出改写后的正文，不要任何说明、引号或 markdown 代码块。";
		const answer = await chat.complete({
			system,
			content: `${directive}\n\n---\n${original}`,
			temperature: .4
		});
		const node = textOutputNode(target.node, t("canvas.skills.polishNodeTitle", { style: t(`canvas.polish.${style}`) }), answer, skill.id, skill.name, [target.node.id]);
		return outputOf([node], [{
			id: newId("edge"),
			fromNodeId: target.node.id,
			toNodeId: node.id
		}]);
	}
	/** External skill through the light tier: skill body in, answer out. */
	async runExternalLight(target, inputs, skill, request, chat, t) {
		const registry = this.backend.registry;
		const name = skill.id.startsWith("skill:") ? skill.id.slice(6) : skill.id;
		const definition = registry === void 0 ? void 0 : await registry.get(name);
		const warnings = [];
		const sections = [];
		if (definition !== void 0 && definition.content.trim() !== "") sections.push(definition.content.trim());
		const configNote = await this.backend.skillConfig?.note(name).catch(() => void 0);
		if (configNote !== void 0 && configNote !== "") sections.push(`${t("canvas.skills.configHeader")}\n${configNote}`);
		for (const input of inputs) {
			const text = nodeText(input.node);
			if (text !== "") {
				sections.push(`### ${nodeTitle(input.node)}\n${text.slice(0, MAX_INLINE_TEXT)}`);
				continue;
			}
			const asset = input.asset;
			if (asset === void 0 || input.data === void 0) continue;
			const extracted = extractFileText(input.data, asset.name ?? asset.assetId, asset.mime);
			if (extracted.supported && extracted.text !== "") sections.push(`### ${asset.name ?? nodeTitle(input.node)}\n${extracted.text.slice(0, MAX_INLINE_TEXT)}`);
			else if (extracted.warning !== void 0) warnings.push(extracted.warning);
		}
		const parts = [{
			type: "text",
			text: this.externalUserPrompt(skill, sections, request, t)
		}];
		for (const input of inputs) {
			const asset = input.asset;
			if (asset === void 0 || input.data === void 0 || !isImageAsset(asset)) continue;
			if (parts.length > MAX_VISION_IMAGES) {
				warnings.push(t("canvas.skills.tooManyImages", { count: MAX_VISION_IMAGES }));
				break;
			}
			parts.push({
				type: "image_url",
				image_url: { url: `data:${baseMime(asset.mime)};base64,${input.data.toString("base64")}` }
			});
		}
		const answer = await chat.complete({
			system: t("canvas.skills.externalSystem", { name: skill.name }),
			content: parts,
			temperature: .35
		});
		const node = textOutputNode(target.node, skill.name, answer, skill.id, skill.name, [target.node.id]);
		return outputOf([node], [{
			id: newId("edge"),
			fromNodeId: target.node.id,
			toNodeId: node.id
		}], warnings);
	}
	externalUserPrompt(skill, sections, request, t) {
		const header = t("canvas.skills.externalHeader", { name: skill.name });
		const instruction = (request.instruction ?? "").trim();
		return [
			header,
			...instruction === "" ? [] : [
				"",
				t("canvas.skills.extraInstruction"),
				instruction
			],
			"",
			t("canvas.skills.inputsHeader"),
			...sections.length === 0 ? [t("canvas.skills.inputsEmpty")] : sections
		].join("\n");
	}
	async runHeavy(task, skill, inputs, request) {
		const runRoot = this.options.runRoot().trim() === "" ? path.join(this.options.dataRoot(), "canvas", "runs") : this.options.runRoot().trim();
		const runDir = path.join(runRoot, request.canvasId, task.id);
		if (task.canvasId === "ppt") task.runDirectory = runDir;
		try {
			return await this.runHeavyIn(runDir, task, skill, inputs, request);
		} finally {
			await this.discardRunDir(runDir);
		}
	}
	/**
	* Delete a finished run's scratch directory.
	*
	* Cleanup is strictly best effort: a failure here (a locked file, a
	* permission problem, a directory the agent removed itself) must never change
	* the outcome of the run that just finished, so every error is swallowed and
	* the worst case is a leftover directory the next sweep can ignore.
	*/
	async discardRunDir(runDir) {
		try {
			await promises.rm(runDir, {
				recursive: true,
				force: true
			});
		} catch {}
	}
	/** The heavy tier's work, with the run directory handed in by its caller so
	*  one place owns the directory's whole lifetime (create and delete). */
	async runHeavyIn(runDir, task, skill, inputs, request) {
		const t = this.translate(task.language);
		const agents = this.backend.agents;
		if (agents === void 0 || !agents.available()) throw new Error(t("canvas.skills.needAgent"));
		const canvas = this.backend.canvas;
		await canvas.read(request.canvasId);
		const target = inputs.find((input) => request.nodeIds.includes(input.node.id)) ?? inputs[0];
		const inputDir = path.join(runDir, "input");
		const outputDir = path.join(runDir, "output");
		await promises.mkdir(inputDir, { recursive: true });
		await promises.mkdir(outputDir, { recursive: true });
		task.stage = t("canvas.skills.stagePreparing");
		task.phase = "preparing";
		const fileLines = [];
		const warnings = [];
		let index = 0;
		for (const input of inputs) {
			index += 1;
			const asset = input.asset;
			if (asset === void 0 || asset.assetId === "") {
				const text = nodeText(input.node);
				if (text !== "") {
					const name = `${String(index).padStart(2, "0")}_${input.node.type}-${input.node.id}.md`;
					await promises.writeFile(path.join(inputDir, name), text, "utf8");
					fileLines.push(`- ${path.join(inputDir, name)}（文本节点内容）`);
				}
				continue;
			}
			const safe = (asset.name ?? `${asset.assetId}`).replace(/[\\/:*?"<>|]/g, "_").slice(0, 80) || "input";
			const name = `${String(index).padStart(2, "0")}_${safe}`;
			const target2 = path.join(inputDir, name);
			await canvas.materialize(asset, target2);
			fileLines.push(`- ${target2}`);
		}
		if (fileLines.length === 0) throw new Error(t("canvas.skills.noInput"));
		task.stage = t("canvas.skills.stagePrepared", { count: fileLines.length });
		const skillName = this.heavySkillName(skill);
		const body = await this.loadSkillBody(skillName);
		if (body === void 0) throw new Error(t("canvas.skills.skillMissing", { name: skillName }));
		const configNote = await this.backend.skillConfig?.note(skillName).catch(() => void 0);
		const definition = await this.backend.registry?.list().then((items) => items.find((item) => item.name === skillName)).catch(() => void 0);
		const command = task.canvasId === "ppt" ? await this.options.pptCommand?.() : void 0;
		const systemPrompt = [
			this.heavySystemPrompt(skill, body, fileLines, outputDir, t, configNote),
			...definition?.path === void 0 ? [] : [`Skill entry path: ${JSON.stringify(definition.path)}. Resolve every skill-local reference, prompt builder and CLI source relative to its directory.`],
			...task.canvasId !== "ppt" ? [] : [
				"This is an image-to-editable-PPT conversion explicitly requested by the user. Follow the installed upstream skill unchanged; do not design a replacement pipeline.",
				"The input order is the slide order. Use the original images as source slides. Copy ONLY the validated final deck, final previews and validation report to the output directory. Do not copy intermediate page decks as final decks. If finalize cannot pass, report failure; never substitute a full-slide raster.",
				`Runtime CLI: ${JSON.stringify(command ?? "editppt")}. Use this executable for editppt commands; add its parent directory to your shell PATH for upstream helpers.`,
				request.instruction ?? ""
			]
		].join("\n\n");
		task.stage = t("canvas.skills.stageRunning");
		task.phase = "running";
		const controller = new AbortController();
		const timeout = this.options.heavyTimeoutMs();
		const timer = timeout > 0 ? setTimeout(() => controller.abort(), timeout) : void 0;
		timer?.unref?.();
		let handle;
		const cancelled = () => task.status === "cancelled";
		try {
			if (cancelled()) throw new Error(t("canvas.skills.stageCancelled"));
			const sessionId = newId("skillagent");
			if (task.canvasId === "ppt") {
				task.agentSessionId = sessionId;
				await this.persistPpt(task);
			}
			handle = await agents.create({
				sessionId,
				cwd: runDir,
				systemPrompt,
				signal: controller.signal,
				fail: (key) => t(key)
			});
			if (handle === void 0) throw new Error(t("canvas.skills.agentFailed"));
			if (cancelled()) {
				handle.cancel();
				throw new Error(t("canvas.skills.stageCancelled"));
			}
			this.cancellers.set(task.id, { dispose: async () => {
				controller.abort();
				handle?.cancel();
				await handle?.dispose().catch(() => {});
			} });
			handle.followup(this.heavyUserPrompt(skill, skillName, inputDir, outputDir, body !== void 0, t));
			const watch = this.watchOutputDir(task, outputDir, t);
			try {
				await handle.whenIdle();
			} finally {
				watch.stop();
			}
			controller.signal.throwIfAborted();
			if (cancelled()) throw new Error(t("canvas.skills.stageCancelled"));
			task.stage = t("canvas.skills.stageCollecting");
			task.phase = "collecting";
			const failure = agentSessionFailure(handle.session);
			if (failure !== void 0) throw new Error(t("ppt.agentFailed", { error: failure }));
			const answer = lastAssistantText(handle.session.deriveMessages());
			if (task.canvasId === "ppt") await this.recoverFinalizedPpt(runDir, outputDir, task.pptImages?.length ?? 0);
			return await this.collectHeavyOutput(task, skill, target, outputDir, answer, warnings, t);
		} finally {
			if (timer !== void 0) clearTimeout(timer);
			await handle?.dispose().catch(() => {});
		}
	}
	/** Report newly produced output files on the task while the agent works, so
	*  the canvas run card shows "已产出 N 个文件" instead of a silent spinner. */
	watchOutputDir(task, outputDir, t) {
		let seen = -1;
		const timer = setInterval(() => {
			promises.readdir(outputDir, {
				recursive: true,
				withFileTypes: true
			}).then((entries) => {
				const count = entries.filter((entry) => entry.isFile()).length;
				if (count === 0 || count === seen) return;
				seen = count;
				task.stage = t("canvas.skills.stageArtifacts", { count });
			}).catch(() => {});
		}, 2e3);
		timer.unref?.();
		return { stop: () => clearInterval(timer) };
	}
	/** The host skill name a heavy built-in maps to (the deck pipeline). */
	heavySkillName(skill) {
		if (skill.id.startsWith("skill:")) return skill.id.slice(6);
		if (skill.id === "ppt.fromImages") return EDITABLE_PPT_SKILL;
		return skill.name;
	}
	/** Where an installed skill lives on disk, for callers that run its CLI. */
	async skillDefinition(name) {
		return this.backend.registry?.list().then((items) => items.find((item) => item.name === name)).catch(() => void 0);
	}
	async loadSkillBody(name) {
		const registry = this.backend.registry;
		if (registry === void 0) return void 0;
		const definition = await registry.get(name).catch(() => void 0);
		if (definition === void 0 || definition.content.trim() === "") return void 0;
		return definition.content;
	}
	heavySystemPrompt(skill, body, fileLines, outputDir, t, configNote) {
		return [
			t("canvas.skills.heavyIntro", { name: skill.name }),
			...body === void 0 ? [] : [
				"",
				t("canvas.skills.heavyBodyHeader"),
				body
			],
			...configNote === void 0 || configNote === "" ? [] : [
				"",
				t("canvas.skills.configHeader"),
				configNote
			],
			"",
			t("canvas.skills.heavyInputsHeader"),
			...fileLines,
			"",
			t("canvas.skills.heavyOutputHeader", { dir: outputDir }),
			t("canvas.skills.heavyRules")
		].join("\n");
	}
	heavyUserPrompt(skill, skillName, inputDir, outputDir, hasBody, t) {
		return [
			t("canvas.skills.heavyAsk", { name: skill.name }),
			"",
			t("canvas.skills.heavyAskInputs", { dir: inputDir }),
			t("canvas.skills.heavyAskOutput", { dir: outputDir }),
			...hasBody ? [] : ["", t("canvas.skills.heavyAskLoadSkill", { name: skillName })]
		].join("\n");
	}
	/**
	* The editppt skill finalizes into its own `final/` directory, outside the
	* output folder this runner hands it. Collect only a completed, validated
	* final deck — never an intermediate page — and only when this run produced
	* no deck of its own.
	*/
	async recoverFinalizedPpt(runDir, outputDir, pageCount) {
		const root = await promises.realpath(runDir);
		const inside = (file) => file.startsWith(root + path.sep);
		const resolveFile = async (raw, base) => {
			const file = await promises.realpath(path.resolve(base, raw)).catch(() => void 0);
			return file !== void 0 && inside(file) ? file : void 0;
		};
		const boundedJson = async (file) => {
			const stat = await promises.stat(file).catch(() => void 0);
			if (!stat?.isFile() || stat.size > 2 * 1024 * 1024) return void 0;
			const value = await promises.readFile(file, "utf8").then((raw) => JSON.parse(raw)).catch(() => void 0);
			return value !== null && typeof value === "object" && !Array.isArray(value) ? value : void 0;
		};
		let inspected = 0;
		const walk = async (dir, depth) => {
			if (depth > 7 || inspected > 2e3) return;
			const entries = await promises.readdir(dir, { withFileTypes: true }).catch(() => []);
			for (const entry of entries) {
				if (++inspected > 2e3) return;
				const full = path.join(dir, entry.name);
				if (entry.isDirectory() && ![
					"input",
					"pages",
					"node_modules",
					".venv"
				].includes(entry.name)) {
					await walk(full, depth + 1);
					continue;
				}
				if (!entry.isFile() || entry.name !== "run_summary.json") continue;
				const summary = await boundedJson(full);
				if (summary?.status !== "complete" || summary.page_count !== pageCount || typeof summary.output !== "string" || typeof summary.validation !== "string") continue;
				const deck = await resolveFile(summary.output, dir);
				const report = await resolveFile(summary.validation, dir);
				if (deck === void 0 || report === void 0 || !deck.toLowerCase().endsWith(".pptx")) continue;
				if ((await boundedJson(report))?.passed !== true) continue;
				const size = await promises.stat(deck);
				if (!size.isFile() || size.size === 0 || size.size > 64 * 1024 * 1024) continue;
				const target = path.join(outputDir, path.basename(deck));
				if (!await promises.stat(target).then(() => true, () => false)) await promises.copyFile(deck, target);
				await promises.copyFile(report, path.join(outputDir, "validation.json"));
				await promises.copyFile(full, path.join(outputDir, "run_summary.json"));
			}
		};
		if (!await promises.readdir(outputDir).then((names) => names.some((name) => name.toLowerCase().endsWith(".pptx")))) await walk(runDir, 0);
	}
	async collectHeavyOutput(task, skill, target, outputDir, answer, warnings, t) {
		const canvas = this.backend.canvas;
		const files = [];
		const walk = async (dir, depth) => {
			if (depth > 3) return;
			let entries;
			try {
				entries = await promises.readdir(dir, { withFileTypes: true });
			} catch {
				return;
			}
			for (const entry of entries) {
				const full = path.join(dir, entry.name);
				if (entry.isDirectory()) {
					if (task.canvasId !== "ppt") await walk(full, depth + 1);
					continue;
				}
				if (!entry.isFile()) continue;
				const stat = await promises.stat(full).catch(() => void 0);
				if (stat === void 0 || stat.size === 0) continue;
				files.push({
					file: full,
					size: stat.size
				});
			}
		};
		await walk(outputDir, 0);
		const nodes = [];
		const connections = [];
		for (const found of files.sort((a, b) => a.file.localeCompare(b.file))) {
			const data = await promises.readFile(found.file).catch(() => void 0);
			if (data === void 0) continue;
			const name = path.basename(found.file);
			if (task.canvasId === "ppt" && name.toLowerCase().endsWith(".pptx")) {
				const entries = readZipDirectory(data);
				const presentation = entries.find((entry) => entry.name === "ppt/presentation.xml");
				const slides = entries.filter((entry) => /^ppt\/slides\/slide\d+\.xml$/.test(entry.name));
				if (presentation === void 0 || readZipEntry(data, presentation) === void 0 || slides.length !== task.pptImages?.length || slides.some((entry) => readZipEntry(data, entry) === void 0)) throw new Error(t("ppt.invalidDeck"));
			}
			let asset;
			try {
				asset = await canvas.putFile({
					data,
					mime: mimeFromName(name),
					name,
					origin: "generated",
					originId: task.id
				});
			} catch (caught) {
				warnings.push(t("canvas.skills.skippedOutput", {
					name,
					message: messageOf$1(caught)
				}));
				continue;
			}
			const node = fileOutputNode(target.node, asset, name, skill.id, skill.name, [target.node.id]);
			nodes.push(node);
			connections.push({
				id: newId("edge"),
				fromNodeId: target.node.id,
				toNodeId: node.id
			});
		}
		if (task.canvasId === "ppt" && !nodes.some((node) => node.metadata?.asset?.name?.toLowerCase().endsWith(".pptx"))) throw new Error([t("ppt.noDeck"), answer?.trim() || t("ppt.noAgentReply")].filter(Boolean).join("\n"));
		if (nodes.length === 0) {
			const text = answer ?? "";
			if (text !== "") {
				const node = textOutputNode(target.node, skill.name, text, skill.id, skill.name, [target.node.id]);
				nodes.push(node);
				connections.push({
					id: newId("edge"),
					fromNodeId: target.node.id,
					toNodeId: node.id
				});
			}
			warnings.push(t("canvas.skills.noOutputFile"));
		}
		return outputOf(nodes, connections, warnings);
	}
	/**
	* Resolve copy for one run's language, falling back to the host-installed
	* resolver when the caller sent none.
	* @param language - the caller's UI language, when it sent one.
	*/
	translate(language) {
		return canvasSkillCopy(language);
	}
};
/** Minimal extension→MIME map for produced files (the store validates again). */
function mimeFromName(name) {
	switch (path.extname(name).replace(/^\./, "").toLowerCase()) {
		case "pptx": return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
		case "docx": return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
		case "xlsx": return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
		case "pdf": return "application/pdf";
		case "json": return "application/json";
		case "csv": return "text/csv";
		case "md": return "text/markdown";
		case "txt": return "text/plain";
		case "zip": return "application/zip";
		case "png": return "image/png";
		case "jpg":
		case "jpeg": return "image/jpeg";
		case "webp": return "image/webp";
		default: return "application/octet-stream";
	}
}
/** Copy resolver shared with the browser bundle (see locale-tables.ts). */
let translateHook = (key) => key;
/** Install the real copy resolver (host half wires the locale dictionaries). */
function setSkillTranslate(hook) {
	translateHook = hook;
}
function translateCanvasSkill(key, params, language) {
	return translateHook(key, params, language);
}
/**
* Active UI language for host-rendered copy. A run request carries no locale, so
* the host half installs a resolver here; without one the host answers in
* English (the browser half always renders its own copy through `tt`).
*/
let languageHook = () => "en";
/** Install the active-language resolver. */
function setSkillLanguage(hook) {
	languageHook = hook;
}
function currentSkillLanguage() {
	try {
		return languageHook();
	} catch {
		return "zh";
	}
}
/**
* Copy resolver for host-rendered canvas copy outside a run (the skill library
* panel): the caller's language wins, the installed language resolver backs it
* up, exactly as {@link SkillRunner.translate} does for runs.
* @param language - the caller's UI language, when it sent one.
*/
function canvasSkillCopy(language) {
	const preferred = language !== void 0 && language !== "" ? language : void 0;
	return (key, params) => translateCanvasSkill(key, params, preferred ?? currentSkillLanguage());
}
//#endregion
//#region src/host-chat.ts
/** Map a user-facing model name onto a filesystem-safe run id. */
function runId() {
	return `dsh-imagegen-studio-code-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
/**
* Build the seam.
*
* `available()` is checked per call, not cached at mount time: the host can
* mount `agents` after this plugin, and the user can switch models without a
* restart. Everything else is resolved at call time for the same reason.
*/
function createHostChatSeam(options) {
	const selection = () => {
		const current = options.defaultModel?.currentSelection();
		const provider = current?.provider?.trim() ?? "";
		const model = current?.model?.trim() ?? "";
		return provider === "" || model === "" ? void 0 : {
			provider,
			model
		};
	};
	return {
		available: () => options.agents !== void 0 && selection() !== void 0,
		label: () => selection()?.model ?? "",
		complete: async ({ system, content, signal }) => {
			const agents = options.agents;
			const chosen = selection();
			if (agents === void 0 || chosen === void 0) throw new Error("DSH 当前没有可用的对话模型：请先在对话面板里选择一个模型，或切回模型生成。");
			const requested = options.preset().trim();
			const presetId = options.presets === void 0 ? void 0 : (await options.presets.resolve(requested === "" ? void 0 : requested)).id;
			const sessionId = runId();
			const handle = await agents.create({
				sessionId,
				meta: {
					cwd: options.cwd(),
					origin: "subagent",
					...presetId === void 0 ? {} : { agentPreset: presetId }
				},
				agentOptions: chosen,
				...signal === void 0 ? {} : { signal },
				setup: async (agentCtx) => {
					if (options.presets !== void 0 && presetId !== void 0) await options.presets.mount(agentCtx, presetId);
					agentCtx.systemPrompt.section({
						name: "plugin:dsh-imagegen-studio:code-render",
						order: 10,
						text: system
					});
				}
			});
			const agent = handle.agent;
			try {
				agent.followup({
					id: `${sessionId}-turn`,
					role: "user",
					content: [{
						type: "text",
						text: content
					}],
					source: { kind: "plugin:dsh-imagegen-studio" }
				});
				await agent.whenIdle();
				if (signal?.aborted === true) throw new Error("代码生成已取消");
				const failure = agentSessionFailure(agent.session);
				if (failure !== void 0) throw new Error(`DSH 的对话模型调用失败：${failure}`);
				const answer = lastAssistantText(agent.session.deriveMessages());
				if (answer === void 0) throw new Error("DSH 的对话模型没有返回任何内容");
				return answer;
			} finally {
				await handle.dispose().catch(() => {});
			}
		}
	};
}
//#endregion
//#region src/agent-image-tools.ts
const imageRefSchema$1 = {
	type: "object",
	additionalProperties: false,
	properties: {
		attachment_id: {
			type: "string",
			required: true
		},
		media_type: {
			type: "string",
			required: true
		},
		bytes: {
			type: "integer",
			required: true
		},
		width: {
			type: "integer",
			required: true
		},
		height: {
			type: "integer",
			required: true
		},
		name: { type: "string" }
	}
};
const taskResultSchema = {
	type: "object",
	additionalProperties: false,
	properties: {
		task_id: {
			type: "string",
			required: true
		},
		status: {
			type: "string",
			required: true
		},
		message: {
			type: "string",
			required: true
		},
		error: { type: "string" },
		images: {
			type: "array",
			required: true,
			items: imageRefSchema$1
		}
	}
};
/** Agent calls stay pending until the provider and history write settle. */
const AGENT_GENERATION_TIMEOUT_MS = 3e5;
function ensureAgentImageConfigured(config) {
	if (!config.enabled) throw new ImageGenError("AI image generation is disabled. Open Settings → Image settings and enable it.", "plugin-disabled");
	if (!config.allowAgentImageGeneration) throw new ImageGenError("Agent image generation is disabled in Settings → Image settings.", "agent-generation-disabled");
	if (!config.channels.some((channel) => channel.apiUrl.trim() !== "" && channel.apiKey.trim() !== "")) throw new ImageGenError("Image API credentials are not configured. Open Settings → Image settings, add a channel and fill in its API URL and API key.", "image-api-not-configured");
}
/** Resolve a configured image alias and its owning channel. */
function resolveAgentImageModel(config, requested) {
	const entries = config.channels.flatMap((channel) => channel.models.map((model) => ({
		channel,
		alias: model.alias,
		upstream: model.id
	})));
	if (entries.length === 0) throw new ImageGenError("No image models are configured. Open Settings → Image settings and add a channel with at least one model.", "no-models-configured");
	const wanted = typeof requested === "string" && requested.trim() !== "" ? requested.trim() : typeof config.defaultModel === "string" ? config.defaultModel.trim() : "";
	if (wanted === "") {
		if (entries.length === 1) return entries[0];
		throw new ImageGenError(`Multiple image models are available — ask the user which channel and model to use, then call this tool again with that exact model name. Options: ${config.channels.flatMap((channel) => channel.models.map((model) => `"${channel.name} · ${model.alias}"`)).join(", ")}.`, "model-choice-required");
	}
	const hosting = entries.filter((entry) => entry.alias === wanted);
	if (hosting.length === 0) throw new ImageGenError(`Image model "${wanted}" is not configured in any channel. Choose one of: ${[...new Set(entries.map((entry) => entry.alias))].join(", ")}.`, "image-model-not-configured");
	return hosting.find((entry) => entry.channel.id === config.defaultChannelId) ?? hosting[0];
}
function findAgentImageTask(runtime, id) {
	const task = runtime.queue.list().find((candidate) => candidate.id === id);
	if (task === void 0) throw new ImageGenError(`Image generation task ${id} was not found.`, "task-not-found");
	return task;
}
/** Wait for a queue task without sending anything through the chat model. */
function waitForAgentImageTask(runtime, id, signal) {
	return new Promise((resolveTask, rejectTask) => {
		let settled = false;
		let dispose = () => {};
		let timer;
		let abort = () => {};
		const cleanup = () => {
			dispose();
			if (timer !== void 0) clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
		};
		const resolve = (task) => {
			if (settled) return;
			settled = true;
			cleanup();
			resolveTask(task);
		};
		const reject = (error) => {
			if (settled) return;
			settled = true;
			cleanup();
			rejectTask(error);
		};
		abort = () => {
			if (settled) return;
			const reason = signal?.reason instanceof Error ? signal.reason : /* @__PURE__ */ new Error("Image generation was cancelled.");
			settled = true;
			cleanup();
			runtime.queue.cancel(id);
			rejectTask(reason);
		};
		const onChange = (updated) => {
			if (updated.id === id && isFinalTask(updated)) resolve(updated);
		};
		if (signal?.aborted === true) {
			abort();
			return;
		}
		dispose = runtime.queue.subscribe(onChange);
		signal?.addEventListener("abort", abort, { once: true });
		timer = setTimeout(() => {
			if (settled) return;
			const timeout = new ImageGenError(`Image generation task ${id} timed out after ${AGENT_GENERATION_TIMEOUT_MS / 1e3} seconds.`, "generation-timeout");
			settled = true;
			cleanup();
			runtime.queue.cancel(id);
			rejectTask(timeout);
		}, AGENT_GENERATION_TIMEOUT_MS);
		let current;
		try {
			current = findAgentImageTask(runtime, id);
		} catch (error) {
			reject(error);
			return;
		}
		if (isFinalTask(current)) resolve(current);
	});
}
/** Submit the same image-edit request used by the Agent tool. */
async function submitAgentImageEdit(attachments, runtime, resolve, input) {
	const config = resolve();
	ensureAgentImageConfigured(config);
	const reference = await attachments.readImage(input.sourceImage, input.signal);
	const fallbackModel = (config.channels.find((channel) => channel.id === config.defaultChannelId) ?? config.channels[0])?.models[0]?.alias ?? config.channels.flatMap((channel) => channel.models)[0]?.alias ?? "";
	const picked = resolveAgentImageModel(config, config.defaultModel?.trim() || fallbackModel);
	return waitForAgentImageTask(runtime, runtime.queue.submit({
		mode: "edit",
		model: picked.alias,
		upstream: picked.upstream,
		channelId: picked.channel.id,
		channel: picked.channel.name,
		prompt: input.prompt.trim(),
		size: "auto",
		quality: "auto",
		n: 1,
		detail: "",
		image: imageDataUrl$1(reference),
		...reference.ref.name === void 0 ? {} : { refName: reference.ref.name }
	}).id, input.signal);
}
function acceptedMediaType$1(value) {
	return value === "image/png" || value === "image/jpeg" || value === "image/webp" || value === "image/gif";
}
function projectRef(ref) {
	return {
		attachment_id: String(ref.attachmentId),
		media_type: ref.mediaType,
		bytes: ref.bytes,
		width: ref.width,
		height: ref.height,
		...ref.name === void 0 ? {} : { name: ref.name }
	};
}
function restoreRef$1(value) {
	if (!acceptedMediaType$1(value.media_type)) throw new ImageGenError("source_image.media_type is not a supported image type", "bad-reference-image");
	if (!Number.isInteger(value.bytes) || value.bytes < 1 || !Number.isInteger(value.width) || value.width < 1 || !Number.isInteger(value.height) || value.height < 1) throw new ImageGenError("source_image metadata is invalid", "bad-reference-image");
	return {
		attachmentId: value.attachment_id,
		mediaType: value.media_type,
		bytes: value.bytes,
		width: value.width,
		height: value.height,
		...value.name === void 0 ? {} : { name: value.name }
	};
}
function imageDataUrl$1(image) {
	return `data:${image.ref.mediaType};base64,${Buffer.from(image.data).toString("base64")}`;
}
function renderTaskResult(value) {
	return [{
		type: "text",
		text: JSON.stringify(value)
	}];
}
/** The UI-only projection that keeps generated images beside the tool call. */
function imagePresentationMeta(value) {
	return { images: value.images.map((image) => {
		const ref = {
			attachment_id: image.attachment_id,
			media_type: image.media_type,
			bytes: image.bytes,
			width: image.width,
			height: image.height
		};
		if (image.name !== void 0) ref.name = image.name;
		return ref;
	}) };
}
function imageBlocksFromMeta(meta) {
	if (typeof meta !== "object" || meta === null || Array.isArray(meta)) return [];
	const images = meta.images;
	if (!Array.isArray(images)) return [];
	return images.flatMap((value) => {
		if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
		const raw = value;
		if (typeof raw.attachment_id !== "string" || typeof raw.media_type !== "string" || typeof raw.bytes !== "number" || typeof raw.width !== "number" || typeof raw.height !== "number") return [];
		try {
			return [{
				type: "image",
				attachment: restoreRef$1({
					attachment_id: raw.attachment_id,
					media_type: raw.media_type,
					bytes: raw.bytes,
					width: raw.width,
					height: raw.height,
					...typeof raw.name === "string" ? { name: raw.name } : {}
				})
			}];
		} catch {
			return [];
		}
	});
}
/** Rehydrate image attachments for the host-computed tool result view only. */
function presentImageResult(_args, result) {
	const content = result.isError ? [] : imageBlocksFromMeta(result.meta);
	return content.length === 0 ? void 0 : {
		card: "generic",
		content
	};
}
/** Register the global Agent tools and unregister them with the plugin lifecycle. */
function registerAgentImageTools(ctx, runtime, resolve) {
	const attachmentRefs = /* @__PURE__ */ new Map();
	const ensureConfigured = () => {
		ensureAgentImageConfigured(resolve());
	};
	const resolveModel = (requested) => resolveAgentImageModel(resolve(), requested);
	const materializeTaskImages = (task) => {
		if (task.status !== "completed") return Promise.resolve([]);
		const existing = attachmentRefs.get(task.id);
		if (existing !== void 0) return existing;
		const pending = ctx.attachments.saveImages((task.result?.images ?? []).map((image, index) => toSaveImage(image, task.id, index))).then((refs) => refs.map(projectRef));
		attachmentRefs.set(task.id, pending);
		pending.catch(() => {
			if (attachmentRefs.get(task.id) === pending) attachmentRefs.delete(task.id);
		});
		return pending;
	};
	const taskResult = async (task) => {
		const images = await materializeTaskImages(task);
		return {
			task_id: task.id,
			status: task.status,
			message: task.status === "completed" ? "Generation completed. The images are shown beside this tool call and can be reused as source_image in studio_edit_image." : task.status === "failed" ? "Generation failed." : task.status === "cancelled" ? "Generation was cancelled." : "Generation is still running. Query the task again when you need its current status.",
			...task.error === void 0 ? {} : { error: task.error },
			images
		};
	};
	const findTask = (id) => findAgentImageTask(runtime, id);
	const waitForTask = (id, signal) => waitForAgentImageTask(runtime, id, signal);
	const disposers = [
		ctx.tools.register(defineTool({
			name: "studio_generate_image",
			description: "Generate an image. By default this tool call stays pending until the task reaches a final state; completed images are shown beside this tool call, while the model receives their attachment references, without creating a user message. Set wait_for_completion to false for background mode, then use studio_get_image_generation_task explicitly. Only use models configured for this plugin; omit model to use the configured default image model (or the first model when none is configured).",
			parameters: {
				prompt: {
					type: "string",
					required: true,
					description: "Detailed image-generation prompt."
				},
				model: {
					type: "string",
					description: "One of the configured image models. Defaults to the configured default image model, or the first model when none is configured."
				},
				size: {
					type: "string",
					description: "Aspect ratio such as 1:1, 16:9, 9:16, or auto."
				},
				quality: {
					type: "string",
					description: "auto, 1k, 2k, or 4k."
				},
				count: {
					type: "integer",
					description: "Number of images, 1 to 4. Defaults to 1."
				},
				detail: {
					type: "string",
					description: "Optional provider detail value, for example standard or high."
				},
				wait_for_completion: {
					type: "boolean",
					description: "Wait for images and return them in this tool result. Defaults to true; set false for background mode."
				}
			},
			output: {
				schema: taskResultSchema,
				render: (_args, value) => renderTaskResult(value),
				presentationMeta: (_args, value) => imagePresentationMeta(value)
			},
			presentResult: presentImageResult,
			async execute(args, exec) {
				ensureConfigured();
				const picked = resolveModel(args.model);
				const task = runtime.queue.submit({
					mode: "text",
					model: picked.alias,
					upstream: picked.upstream,
					channelId: picked.channel.id,
					channel: picked.channel.name,
					prompt: args.prompt.trim(),
					size: args.size ?? "auto",
					quality: args.quality ?? "auto",
					n: Math.min(4, Math.max(1, args.count ?? 1)),
					detail: args.detail ?? ""
				});
				return taskResult(args.wait_for_completion === false ? task : await waitForTask(task.id, exec.signal));
			}
		})),
		ctx.tools.register(defineTool({
			name: "studio_edit_image",
			description: "Edit an image. By default this tool call stays pending until the task reaches a final state; completed images are shown beside this tool call, while the model receives their attachment references, without creating a user message. Set wait_for_completion to false for background mode, then use studio_get_image_generation_task explicitly. source_image must be an image reference returned by a completed generation or studio_get_image_generation_task; pass that entire object unchanged. Only configured image models are allowed; omit model to use the configured default image model (or the first model when none is configured).",
			parameters: {
				prompt: {
					type: "string",
					required: true,
					description: "How to transform the source image."
				},
				source_image: {
					...imageRefSchema$1,
					required: true,
					description: "Image reference returned by studio_get_image_generation_task."
				},
				model: {
					type: "string",
					description: "One of the configured image models. Defaults to the configured default image model, or the first model when none is configured."
				},
				size: {
					type: "string",
					description: "Aspect ratio such as 1:1, 16:9, 9:16, or auto."
				},
				quality: {
					type: "string",
					description: "auto, 1k, 2k, or 4k."
				},
				count: {
					type: "integer",
					description: "Number of images, 1 to 4. Defaults to 1."
				},
				detail: {
					type: "string",
					description: "Optional provider detail value."
				},
				wait_for_completion: {
					type: "boolean",
					description: "Wait for images and return them in this tool result. Defaults to true; set false for background mode."
				}
			},
			output: {
				schema: taskResultSchema,
				render: (_args, value) => renderTaskResult(value),
				presentationMeta: (_args, value) => imagePresentationMeta(value)
			},
			presentResult: presentImageResult,
			async execute(args, exec) {
				ensureConfigured();
				const reference = await ctx.attachments.readImage(restoreRef$1(args.source_image), exec.signal);
				const picked = resolveModel(args.model);
				const task = runtime.queue.submit({
					mode: "edit",
					model: picked.alias,
					upstream: picked.upstream,
					channelId: picked.channel.id,
					channel: picked.channel.name,
					prompt: args.prompt.trim(),
					size: args.size ?? "auto",
					quality: args.quality ?? "auto",
					n: Math.min(4, Math.max(1, args.count ?? 1)),
					detail: args.detail ?? "",
					image: imageDataUrl$1(reference),
					...reference.ref.name === void 0 ? {} : { refName: reference.ref.name }
				});
				return taskResult(args.wait_for_completion === false ? task : await waitForTask(task.id, exec.signal));
			}
		})),
		ctx.tools.register(defineTool({
			name: "studio_get_image_generation_task",
			description: "Check an image-generation task status. Completed tasks return image references; their images are shown beside this tool call and the references can be passed to studio_edit_image. Generation tools normally wait for completion, so use this for explicit recovery or status checks.",
			parameters: { task_id: {
				type: "string",
				required: true,
				description: "Task id returned by studio_generate_image or studio_edit_image."
			} },
			output: {
				schema: taskResultSchema,
				render: (_args, value) => renderTaskResult(value),
				presentationMeta: (_args, value) => imagePresentationMeta(value)
			},
			presentResult: presentImageResult,
			async execute(args) {
				ensureConfigured();
				return taskResult(findTask(args.task_id));
			}
		})),
		ctx.tools.register(defineTool({
			name: "studio_cancel_image_generation_task",
			description: "Cancel a queued or running image generation task.",
			parameters: { task_id: {
				type: "string",
				required: true,
				description: "Task id returned by studio_generate_image or studio_edit_image."
			} },
			output: {
				schema: taskResultSchema,
				render: (_args, value) => renderTaskResult(value),
				presentationMeta: (_args, value) => imagePresentationMeta(value)
			},
			presentResult: presentImageResult,
			async execute(args) {
				ensureConfigured();
				const task = runtime.queue.cancel(args.task_id);
				if (task === void 0) throw new ImageGenError(`Image generation task ${args.task_id} was not found.`, "task-not-found");
				return taskResult(task);
			}
		}))
	];
	return () => {
		for (const dispose of disposers) dispose();
	};
}
function isFinalTask(task) {
	return task.status === "completed" || task.status === "failed" || task.status === "cancelled";
}
function toSaveImage(image, taskId, index) {
	const data = Buffer.from(image.b64, "base64");
	const declaredMediaType = acceptedMediaType$1(image.mime) ? image.mime : "image/png";
	const mediaType = detectImageMime(data) ?? declaredMediaType;
	return {
		data,
		mediaType,
		name: `imagegen-${taskId}-${index + 1}.${mediaType === "image/jpeg" ? "jpg" : mediaType.slice(6)}`
	};
}
//#endregion
//#region src/agent-video-tools.ts
/** One reference image the model passes back from a completed generation. */
const imageRefSchema = {
	type: "object",
	additionalProperties: false,
	properties: {
		attachment_id: {
			type: "string",
			required: true
		},
		media_type: {
			type: "string",
			required: true
		},
		bytes: {
			type: "integer",
			required: true
		},
		width: {
			type: "integer",
			required: true
		},
		height: {
			type: "integer",
			required: true
		},
		name: { type: "string" }
	}
};
const videoTaskResultSchema = {
	type: "object",
	additionalProperties: false,
	properties: {
		task_id: {
			type: "string",
			required: true
		},
		status: {
			type: "string",
			required: true
		},
		message: {
			type: "string",
			required: true
		},
		error: { type: "string" },
		videos: {
			type: "array",
			required: true,
			items: {
				type: "object",
				additionalProperties: false,
				properties: {
					url: {
						type: "string",
						required: true
					},
					mime: {
						type: "string",
						required: true
					},
					duration: { type: "number" }
				}
			}
		}
	}
};
/** Agent submits stay pending until the queue task settles. */
const AGENT_VIDEO_TIMEOUT_MS = 40 * 6e4;
function ensureAgentVideoConfigured(config) {
	if (!config.enabled) throw new VideoGenError("AI image generation is disabled. Open Settings → Image settings and enable it.", "plugin-disabled");
	if (!config.allowAgentVideoGeneration) throw new VideoGenError("Agent video generation is disabled in Settings → Image settings.", "agent-video-disabled");
	if (!config.channels.some((channel) => channel.apiUrl.trim() !== "" && channel.apiKey.trim() !== "" && (channel.videoModels ?? []).length > 0)) throw new VideoGenError("No video models are configured. Open Settings → Image settings, pick a channel and add video models to it.", "video-model-not-configured");
}
/** Resolve a configured video alias and its owning channel. */
function resolveAgentVideoModel(config, requested) {
	const entries = config.channels.flatMap((channel) => (channel.videoModels ?? []).map((model) => ({
		channel,
		alias: model.alias,
		upstream: model.id
	})));
	if (entries.length === 0) throw new VideoGenError("No video models are configured. Open Settings → Image settings and add video models to a channel.", "video-model-not-configured");
	const wanted = typeof requested === "string" && requested.trim() !== "" ? requested.trim() : typeof config.defaultVideoModel === "string" ? config.defaultVideoModel.trim() : "";
	if (wanted === "") {
		if (entries.length === 1) return entries[0];
		throw new VideoGenError(`Multiple video models are available — ask the user which channel and model to use, then call this tool again with that exact model name. Options: ${entries.map((entry) => `"${entry.channel.name} · ${entry.alias}"`).join(", ")}.`, "video-model-choice-required");
	}
	const hosting = entries.filter((entry) => entry.alias === wanted);
	if (hosting.length === 0) throw new VideoGenError(`Video model "${wanted}" is not configured in any channel. Choose one of: ${[...new Set(entries.map((entry) => entry.alias))].join(", ")}.`, "video-model-not-configured");
	return hosting.find((entry) => entry.channel.id === config.defaultChannelId) ?? hosting[0];
}
/** Reject a model whose protocol family the engine cannot shape. */
function requireKnownFamily(upstream) {
	if (describeVideoModel(upstream).family === "unknown") throw new VideoGenError(`Video model "${upstream}" has an unknown protocol family, so it cannot be generated. Use a known video model such as agnes-video-2.5-flash.`, "video-unknown-model");
}
function isFinalVideoTask(task) {
	return task.status === "completed" || task.status === "failed" || task.status === "cancelled";
}
/** Wait for a video queue task without sending anything through the chat model. */
function waitForAgentVideoTask(runtime, id, signal) {
	return new Promise((resolveTask, rejectTask) => {
		let settled = false;
		let unsubscribe = () => {};
		let timer;
		let abort = () => {};
		const cleanup = () => {
			unsubscribe();
			if (timer !== void 0) clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
		};
		const settle = (task) => {
			if (settled) return;
			settled = true;
			cleanup();
			resolveTask(task);
		};
		const reject = (error) => {
			if (settled) return;
			settled = true;
			cleanup();
			rejectTask(error);
		};
		abort = () => {
			if (settled) return;
			const reason = signal?.reason instanceof Error ? signal.reason : /* @__PURE__ */ new Error("Video generation was cancelled.");
			reject(reason);
		};
		if (signal?.aborted === true) {
			abort();
			return;
		}
		signal?.addEventListener("abort", abort, { once: true });
		const inspect = () => {
			const task = runtime.videoQueue.get(id);
			if (task === void 0) {
				reject(new VideoGenError(`Video generation task ${id} was not found.`, "task-not-found"));
				return;
			}
			if (isFinalVideoTask(task)) {
				settle(task);
				return;
			}
		};
		inspect();
		if (settled) return;
		unsubscribe = runtime.videoQueue.subscribe((task) => {
			if (task.id === id) inspect();
		});
		timer = setTimeout(() => {
			reject(new VideoGenError(`Video generation did not finish within ${Math.round(AGENT_VIDEO_TIMEOUT_MS / 6e4)} minutes. The task is still running on the host; query it again with studio_get_video_generation_task.`, "video-timeout"));
		}, AGENT_VIDEO_TIMEOUT_MS);
	});
}
/**
* Render one video result for the model.
*
* Textual, like the image tools: a clip cannot be attached to the
* conversation, and keeping the model-facing result textual lets video
* generation work with text-only conversation models.
*/
function renderVideoTaskResult(value) {
	return [{
		type: "text",
		text: JSON.stringify(value)
	}];
}
/**
* Register the video tools on the host context.
*
* `enabled` is read per call so a settings change applies without a restart,
* exactly like the image tools.
*/
function registerAgentVideoTools(ctx, runtime, config) {
	const ensureConfigured = () => {
		const value = config();
		ensureAgentVideoConfigured(value);
		return value;
	};
	const taskResult = (task) => {
		const clips = task.result?.videos ?? [];
		return {
			task_id: task.id,
			status: task.status,
			message: task.status === "completed" ? clips.length > 0 ? "Video generation completed. The clip is served at the URL below; tell the user where it is and that it is also listed in the studio's video history." : "Video generation completed, but the clip could not be persisted locally." : task.status === "failed" ? "Video generation failed." : task.status === "cancelled" ? "Video generation was cancelled." : "Video generation is still running. Video renders usually take several minutes; query the task again later rather than in a tight loop.",
			...task.error === void 0 ? {} : { error: task.error },
			...task.result?.historyError === void 0 ? {} : { error: task.result.historyError },
			videos: clips.map((video) => ({
				url: video.url,
				mime: video.mime,
				...video.duration === void 0 ? {} : { duration: video.duration }
			}))
		};
	};
	const findTask = (id) => {
		const task = runtime.videoQueue.get(id);
		if (task === void 0) throw new VideoGenError(`Video generation task ${id} was not found.`, "task-not-found");
		return task;
	};
	const buildRequest = (picked, args, mode, frame) => {
		const seconds = typeof args.seconds === "number" ? args.seconds : 5;
		const resolution = typeof args.resolution === "string" ? args.resolution : "720P";
		return {
			mode,
			model: picked.alias,
			upstream: picked.upstream,
			channelId: picked.channel.id,
			channel: picked.channel.name,
			prompt: typeof args.prompt === "string" ? args.prompt.trim() : "",
			aspectRatio: typeof args.aspect_ratio === "string" && args.aspect_ratio.trim() !== "" ? args.aspect_ratio.trim() : "16:9",
			resolution: resolution === "480P" || resolution === "720P" || resolution === "1080P" ? resolution : "720P",
			seconds,
			...frame === void 0 ? {} : frame
		};
	};
	const disposers = [
		ctx.tools.register(defineTool({
			name: "studio_generate_video",
			description: "Generate a video (text-to-video). Video rendering is asynchronous and usually takes several minutes, so by default this tool call stays pending until the task settles; set wait_for_completion to false for background mode and then use studio_get_video_generation_task. The finished clip is saved as a file on the host and returned as a same-origin URL (it is never attached to the conversation). Only models configured in the channel's video catalog are allowed; omit model to use the configured default video model.",
			parameters: {
				prompt: {
					type: "string",
					required: true,
					description: "Detailed video prompt: subject, action, camera movement, lighting and mood."
				},
				model: {
					type: "string",
					description: "One of the configured video models. Defaults to the configured default video model."
				},
				aspect_ratio: {
					type: "string",
					description: "Aspect ratio such as 16:9, 9:16 or 1:1. Defaults to 16:9."
				},
				resolution: {
					type: "string",
					description: "480P, 720P (default) or 1080P, when the model supports it."
				},
				seconds: {
					type: "integer",
					description: "Clip length in seconds. Defaults to 5."
				},
				wait_for_completion: {
					type: "boolean",
					description: "Wait for the finished clip and return its URL. Defaults to true; set false for background mode."
				}
			},
			output: {
				schema: videoTaskResultSchema,
				render: (_args, value) => renderVideoTaskResult(value)
			},
			async execute(args, exec) {
				const picked = resolveAgentVideoModel(ensureConfigured(), args.model);
				requireKnownFamily(picked.upstream);
				const task = runtime.videoQueue.submit(buildRequest(picked, args, "text"));
				return taskResult(args.wait_for_completion === false ? task : await waitForAgentVideoTask(runtime, task.id, exec.signal));
			}
		})),
		ctx.tools.register(defineTool({
			name: "studio_generate_video_from_image",
			description: "Generate a video from reference image(s). Use mode \"image\" for one reference frame, \"keyframe\" for first/last-frame interpolation (providers that accept both), or \"reference\" for one or more style/subject references. Reference images must be image references returned by a completed generation or studio_get_video_generation_task; pass that entire object unchanged. Rendering is asynchronous and usually takes minutes; by default this tool call stays pending until the task settles.",
			parameters: {
				prompt: {
					type: "string",
					required: true,
					description: "Detailed video prompt describing the motion and mood."
				},
				mode: {
					type: "string",
					required: true,
					description: "image (one reference), keyframe (first/last frame) or reference (multiple references)."
				},
				image: {
					...imageRefSchema,
					description: "Reference image for mode=image or mode=reference."
				},
				first_frame: {
					...imageRefSchema,
					description: "First-frame image for mode=keyframe."
				},
				last_frame: {
					...imageRefSchema,
					description: "Optional last-frame image for mode=keyframe."
				},
				model: {
					type: "string",
					description: "One of the configured video models. Defaults to the configured default video model."
				},
				aspect_ratio: {
					type: "string",
					description: "Aspect ratio such as 16:9, 9:16 or 1:1."
				},
				resolution: {
					type: "string",
					description: "480P, 720P (default) or 1080P, when the model supports it."
				},
				seconds: {
					type: "integer",
					description: "Clip length in seconds. Defaults to 5."
				},
				wait_for_completion: {
					type: "boolean",
					description: "Wait for the finished clip and return its URL. Defaults to true."
				}
			},
			output: {
				schema: videoTaskResultSchema,
				render: (_args, value) => renderVideoTaskResult(value)
			},
			async execute(args, exec) {
				const picked = resolveAgentVideoModel(ensureConfigured(), args.model);
				requireKnownFamily(picked.upstream);
				const mode = args.mode === "keyframe" ? "keyframe" : args.mode === "reference" ? "reference" : "image";
				const readFrame = async (value, what) => {
					if (value === null || typeof value !== "object") return void 0;
					const reference = await ctx.attachments.readImage(restoreRef(value), exec.signal);
					if (reference.data.byteLength === 0) throw new VideoGenError(`${what} had no readable bytes.`, "video-bad-reference");
					return imageDataUrl(reference);
				};
				const image = await readFrame(args.image, "image");
				const first = await readFrame(args.first_frame, "first_frame");
				const last = await readFrame(args.last_frame, "last_frame");
				if (mode === "keyframe" && first === void 0) throw new VideoGenError("mode=keyframe needs first_frame (and optionally last_frame).", "video-bad-reference");
				if (mode !== "keyframe" && image === void 0) throw new VideoGenError(`mode=${mode} needs image.`, "video-bad-reference");
				const frame = mode === "keyframe" ? {
					...first === void 0 ? {} : { firstFrame: first },
					...last === void 0 ? {} : { lastFrame: last }
				} : {
					image,
					refName: "reference"
				};
				const task = runtime.videoQueue.submit(buildRequest(picked, args, mode, frame));
				return taskResult(args.wait_for_completion === false ? task : await waitForAgentVideoTask(runtime, task.id, exec.signal));
			}
		})),
		ctx.tools.register(defineTool({
			name: "studio_get_video_generation_task",
			description: "Check a video-generation task status. Completed tasks return the served clip URL. Video renders usually take several minutes, so use this for polling or recovery instead of re-submitting; do not poll in a tight loop.",
			parameters: { task_id: {
				type: "string",
				required: true,
				description: "Task id returned by studio_generate_video or studio_generate_video_from_image."
			} },
			output: {
				schema: videoTaskResultSchema,
				render: (_args, value) => renderVideoTaskResult(value)
			},
			async execute(args) {
				ensureConfigured();
				return taskResult(findTask(args.task_id));
			}
		})),
		ctx.tools.register(defineTool({
			name: "studio_cancel_video_generation_task",
			description: "Cancel a queued or running video generation task.",
			parameters: { task_id: {
				type: "string",
				required: true,
				description: "Task id returned by studio_generate_video or studio_generate_video_from_image."
			} },
			output: {
				schema: videoTaskResultSchema,
				render: (_args, value) => renderVideoTaskResult(value)
			},
			async execute(args) {
				ensureConfigured();
				const task = runtime.videoQueue.cancel(args.task_id);
				if (task === void 0) throw new VideoGenError(`Video generation task ${args.task_id} was not found.`, "task-not-found");
				return taskResult(task);
			}
		}))
	];
	return () => {
		for (const dispose of disposers) dispose();
	};
}
/** Tool names this module registers (used by the host to gate announcements). */
const AGENT_VIDEO_TOOL_NAMES = [
	"studio_generate_video",
	"studio_generate_video_from_image",
	"studio_get_video_generation_task",
	"studio_cancel_video_generation_task"
];
/** Whether a media type is one the host accepts as a reference frame. */
function acceptedMediaType(value) {
	return value === "image/png" || value === "image/jpeg" || value === "image/webp" || value === "image/gif";
}
/** Rebuild an attachment reference from the model-passed object. */
function restoreRef(value) {
	const mediaType = typeof value.media_type === "string" ? value.media_type : "";
	if (!acceptedMediaType(mediaType)) throw new VideoGenError("reference image media_type is not a supported image type", "video-bad-reference");
	if (typeof value.attachment_id !== "string" || value.attachment_id === "") throw new VideoGenError("reference image attachment_id is missing", "video-bad-reference");
	const dim = (key) => typeof value[key] === "number" && Number.isInteger(value[key]) && value[key] > 0 ? value[key] : 0;
	const bytes = dim("bytes");
	const width = dim("width");
	const height = dim("height");
	if (bytes === 0 || width === 0 || height === 0) throw new VideoGenError("reference image metadata is invalid", "video-bad-reference");
	return {
		attachmentId: value.attachment_id,
		mediaType,
		bytes,
		width,
		height,
		...typeof value.name === "string" && value.name !== "" ? { name: value.name } : {}
	};
}
/** Encode one attachment as a data URL the engine can send upstream. */
function imageDataUrl(image) {
	return `data:${image.ref.mediaType};base64,${Buffer.from(image.data).toString("base64")}`;
}
//#endregion
//#region src/edit-image-command.ts
function isImageReference(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const ref = value;
	return typeof ref.attachmentId === "string" && (ref.mediaType === "image/png" || ref.mediaType === "image/jpeg" || ref.mediaType === "image/webp" || ref.mediaType === "image/gif") && Number.isInteger(ref.bytes) && ref.bytes > 0 && Number.isInteger(ref.width) && ref.width > 0 && Number.isInteger(ref.height) && ref.height > 0;
}
function imageInContent(value) {
	if (!Array.isArray(value)) return void 0;
	for (let index = value.length - 1; index >= 0; index -= 1) {
		const block = value[index];
		if (typeof block !== "object" || block === null || Array.isArray(block)) continue;
		const raw = block;
		if (raw.type === "image" && isImageReference(raw.attachment)) return raw.attachment;
		if (raw.type === "tool-result") {
			const nested = imageInContent(raw.content);
			if (nested !== void 0) return nested;
		}
	}
}
/** Pick the newest image explicitly attached to this command invocation. */
function imageInInvocation(value) {
	if (!Array.isArray(value)) return void 0;
	for (let index = value.length - 1; index >= 0; index -= 1) {
		const block = value[index];
		if (typeof block !== "object" || block === null || Array.isArray(block)) continue;
		const raw = block;
		if (raw.type === "image" && isImageReference(raw.attachment)) return raw.attachment;
	}
}
/** Find the newest durable image reference, including nested tool results. */
function latestSessionImage(messages) {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (typeof message !== "object" || message === null || Array.isArray(message)) continue;
		const image = imageInContent(message.content);
		if (image !== void 0) return image;
	}
}
function commandError(error) {
	const text = error instanceof Error ? error.message : String(error);
	return {
		kind: "error",
		text: text.trim() === "" ? "图片编辑失败。" : text
	};
}
/** Register the host-side command; it never sends the command line to a chat model. */
function registerEditImageCommand(ctx, runtime, resolve, pendingImages) {
	return ctx.commands.register({
		name: "studio_edit_image",
		description: "Edit the latest image in this conversation with the plugin image model",
		input: {
			hint: "Describe how to modify the latest image",
			images: true
		},
		async handler(invocation) {
			const prompt = invocation.rawInput.trim();
			if (prompt === "") return {
				kind: "error",
				text: "请提供图片修改描述，例如：/studio_edit_image 把背景改成夜景"
			};
			const invocationImage = imageInInvocation(invocation.attachments);
			const pendingImage = pendingImages?.get(String(invocation.agent.id));
			const durableImage = latestSessionImage(invocation.agent.session.deriveMessages());
			const sourceImage = invocationImage ?? pendingImage ?? durableImage;
			if (sourceImage === void 0) return {
				kind: "error",
				text: "当前对话没有可用图片，请先上传图片或把画廊图片加入对话。"
			};
			try {
				const task = await submitAgentImageEdit(ctx.attachments, runtime, resolve, {
					prompt,
					sourceImage,
					signal: invocation.signal
				});
				if (task.status === "completed") {
					if (pendingImage !== void 0) pendingImages?.consume(String(invocation.agent.id), pendingImage);
					return {
						kind: "success",
						text: "图片编辑已完成，可在 AI 生图面板查看结果。"
					};
				}
				return {
					kind: "error",
					text: task.error ?? `图片编辑${task.status === "cancelled" ? "已取消" : "失败"}。`
				};
			} catch (error) {
				return commandError(error);
			}
		}
	});
}
//#endregion
//#region src/skill-store.ts
/**
* Local skill library (`~/.dsh/skills`).
*
* The canvas offers every model-invocable host skill, but the interesting
* long-running ones (deck/document pipelines) are user-installed. This module
* is the host side of that story: it inspects the library, installs skills from
* a git URL / archive URL / raw `SKILL.md` URL, installs an archive the user
* uploaded through the canvas, and removes an installed skill.
*
* Install safety rules:
*
*  - everything lands under the resolved skills root; every destination path is
*    re-checked with `path.relative` before it is written or deleted;
*  - an archive is extracted into a staging directory first and only promoted
*    when it actually contains a `SKILL.md` with a frontmatter `name`;
*  - archives are read through the same bounded ZIP reader as OOXML extraction,
*    and the expanded size is capped;
*  - `git` runs with a timeout in a non-interactive mode on a fixed executable
*    name (no shell), and its failure is reported as actionable copy.
*
* The filesystem skill provider watches `~/.dsh/skills`, so an install becomes
* visible to `ctx.skills` without restarting the host.
*/
/** Hard cap on one downloaded archive / unpacked skill folder. */
const MAX_SKILL_ARCHIVE_BYTES = 64 * 1024 * 1024;
/** Cap on a single `SKILL.md` fetched from a raw URL. */
const MAX_SKILL_MARKDOWN_BYTES = 2 * 1024 * 1024;
/** Wall-clock cap for one install source. */
const INSTALL_TIMEOUT_MS = 18e4;
/** Canonical install sources this plugin knows by name (one-click affordances). */
const KNOWN_SKILL_SOURCES = [{
	name: "image-to-editable-ppt",
	url: "https://github.com/ningzimu/image-to-editable-ppt-skill"
}];
/** The upstream home of a known skill, when we know it. */
function knownSkillUrl(name) {
	return KNOWN_SKILL_SOURCES.find((entry) => entry.name === name)?.url;
}
/** Resolve the skills root: `DSH_HOME/skills` when known, else `~/.dsh/skills`. */
function skillsRoot(dshHome) {
	const home = (dshHome ?? process.env.DSH_HOME ?? "").trim();
	const base = home === "" ? path.join(homedir(), ".dsh") : home;
	return path.join(base, "skills");
}
/** A user-facing failure carrying actionable copy. */
var SkillStoreError = class extends Error {
	constructor(message) {
		super(message);
		this.name = "SkillStoreError";
	}
};
/** Whether a name is a safe folder name for one skill. */
function isValidSkillName(name) {
	return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name) && name !== "." && name !== "..";
}
/**
* The public DSH skill-name grammar: lowercase kebab-case.
*
* This is stricter than {@link isValidSkillName} on purpose. The folder-name
* check only keeps a destination path safe, while the host skill registry
* publishes a bundle under its frontmatter `name` and *drops the whole skill*
* when that name is not kebab-case — silently, with nothing but a host log line.
* Every install and every locally discovered skill is checked against this
* grammar so the canvas can never offer something the host would ignore.
*/
const DSH_SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** Whether a name is the kebab-case name the host skill registry loads. */
function isDshSkillName(name) {
	return DSH_SKILL_NAME.test(name);
}
/** Directory size in bytes (bounded walk), or 0 when it cannot be read. */
async function directorySize(root, depth = 0) {
	if (depth > 6) return 0;
	let total = 0;
	let entries;
	try {
		entries = await readdir(root, { withFileTypes: true });
	} catch {
		return 0;
	}
	for (const entry of entries) {
		const full = path.join(root, entry.name);
		if (entry.isDirectory()) {
			total += await directorySize(full, depth + 1);
			continue;
		}
		if (!entry.isFile()) continue;
		const info = await stat(full).catch(() => void 0);
		if (info !== void 0) total += info.size;
	}
	return total;
}
/** The opening fence of a `SKILL.md` head, body excluded. */
const FRONTMATTER_HEAD = /^---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;
/** The same fence as a whole match, for stripping a body out of a file. */
const FRONTMATTER_WHOLE = /^---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;
/** The boolean spellings the host's frontmatter reader accepts. */
function booleanOf(raw) {
	switch (raw.trim().toLowerCase()) {
		case "true":
		case "yes":
		case "on":
		case "1": return true;
		case "false":
		case "no":
		case "off":
		case "0": return false;
		default: return;
	}
}
/** Strip one matching pair of surrounding quotes from a scalar value. */
function unquote(value) {
	const text = value.trim();
	const quote = text[0];
	if ((quote === "\"" || quote === "'") && text.length > 1 && text.endsWith(quote)) return text.slice(1, -1).trim();
	return text;
}
/**
* Read a skill bundle's frontmatter. The DSH skill format uses a YAML head
* between `---` fences and wants `name` plus `description`; this reader covers
* the scalar and block-scalar spellings real bundles use (a folded
* `description: >-` must not surface as the literal text `>-`).
* @param markdown - the `SKILL.md` contents.
*/
function parseSkillFrontmatter(markdown) {
	const match = FRONTMATTER_HEAD.exec(markdown);
	if (match === null) return {
		present: false,
		invalidInvocation: false
	};
	const lines = match[1].split(/\r?\n/);
	const fields = /* @__PURE__ */ new Map();
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		if (line.trim() === "" || line.trim().startsWith("#") || /^\s/.test(line)) continue;
		const entry = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line);
		if (entry === null) continue;
		const key = entry[1];
		let value = entry[2].trim();
		const block = /^([|>])[+-]?\d*\s*$/.exec(value);
		if (block !== null) {
			const collected = [];
			while (index + 1 < lines.length && (lines[index + 1].trim() === "" || /^\s/.test(lines[index + 1]))) {
				index += 1;
				collected.push(lines[index].trim());
			}
			value = block[1] === ">" ? collected.join(" ").replace(/\s+/g, " ").trim() : collected.join("\n").trim();
		} else value = unquote(value);
		if (!fields.has(key)) fields.set(key, value);
	}
	const read = (key) => {
		const value = fields.get(key);
		return value === void 0 || value === "" ? void 0 : value;
	};
	const disable = read("disable-model-invocation");
	const user = read("user-invocable");
	const disableValue = disable === void 0 ? void 0 : booleanOf(disable);
	const userValue = user === void 0 ? void 0 : booleanOf(user);
	return {
		present: true,
		...read("name") === void 0 ? {} : { name: read("name") },
		...read("description") === void 0 ? {} : { description: read("description") },
		...read("whenToUse") === void 0 ? {} : { whenToUse: read("whenToUse") },
		...disableValue === void 0 ? {} : { disableModelInvocation: disableValue },
		...userValue === void 0 ? {} : { userInvocable: userValue },
		invalidInvocation: disable !== void 0 && disableValue === void 0 || user !== void 0 && userValue === void 0
	};
}
/** First meaningful line of a skill body, used when frontmatter has no blurb. */
function firstHeading(markdown) {
	const withoutHead = markdown.replace(FRONTMATTER_WHOLE, "");
	for (const raw of withoutHead.split(/\r?\n/)) {
		const line = raw.trim();
		if (line === "") continue;
		return line.replace(/^#+\s*/, "").slice(0, 240);
	}
	return "";
}
/**
* Judge one bundle against the host registry's rules: a kebab-case frontmatter
* `name`, a frontmatter `description`, a parseable invocation spelling, and
* model invocation left permitted. Anything else is invisible to every agent,
* which is exactly what the canvas must not pretend to offer.
* @param markdown - the `SKILL.md` contents.
*/
function inspectSkillMarkdown(markdown) {
	const front = parseSkillFrontmatter(markdown);
	const name = front.name?.trim() ?? "";
	const base = {
		name,
		description: (front.description ?? firstHeading(markdown)).trim(),
		...front.whenToUse === void 0 ? {} : { whenToUse: front.whenToUse }
	};
	if (!front.present) return {
		...base,
		loadable: false,
		issue: "no-frontmatter"
	};
	if (!isDshSkillName(name)) return {
		...base,
		loadable: false,
		issue: "bad-name"
	};
	if ((front.description ?? "").trim() === "") return {
		...base,
		loadable: false,
		issue: "no-description"
	};
	if (front.invalidInvocation) return {
		...base,
		loadable: false,
		issue: "bad-invocation"
	};
	if (front.disableModelInvocation === true) return {
		...base,
		loadable: false,
		issue: "user-only"
	};
	return {
		...base,
		loadable: true
	};
}
/** Candidate skill files directly under `root` (the host scans one level). */
async function scanSkillFiles(root) {
	let children;
	try {
		children = await readdir(root, { withFileTypes: true });
	} catch {
		return [];
	}
	const files = [];
	for (const child of children) {
		if (child.isDirectory()) {
			if (child.name.startsWith(".")) continue;
			const markdown = path.join(root, child.name, "SKILL.md");
			if (existsSync(markdown)) files.push({
				folder: child.name,
				path: markdown
			});
			continue;
		}
		if (child.isFile() && child.name.toLowerCase().endsWith(".md")) files.push({
			folder: child.name.slice(0, -3),
			path: path.join(root, child.name)
		});
	}
	return files;
}
/** Read one candidate `SKILL.md`, bounded like a downloaded one. */
async function readSkillText(candidatePath) {
	const info = await stat(candidatePath).catch(() => void 0);
	if (info === void 0 || !info.isFile() || info.size > 2097152) return void 0;
	return await readFile(candidatePath, "utf8").catch(() => void 0);
}
/** The instruction body of one `SKILL.md` (frontmatter removed). */
function skillBody(markdown) {
	return markdown.replace(FRONTMATTER_WHOLE, "").trim();
}
/**
* Every skill under `root` the host registry would load, with its body.
*
* The canvas is a host surface with no session scope, so it cannot read the
* per-preset layer of `ctx.skills` (see `createSkillRegistryBackend`). Scanning
* the library directly is what lets the node skill menu agree with the skill
* library panel the user installed from.
* @param root - resolved skills root.
*/
async function listLocalSkills(root) {
	const skills = [];
	for (const candidate of await scanSkillFiles(root)) {
		const markdown = await readSkillText(candidate.path);
		if (markdown === void 0) continue;
		const inspection = inspectSkillMarkdown(markdown);
		if (!inspection.loadable) continue;
		skills.push({
			name: inspection.name,
			description: inspection.description,
			...inspection.whenToUse === void 0 ? {} : { whenToUse: inspection.whenToUse },
			path: candidate.path,
			content: skillBody(markdown)
		});
	}
	return skills.sort((a, b) => a.name.localeCompare(b.name));
}
/**
* Resolve one loadable local skill by the name the host registry publishes.
* @param root - resolved skills root.
* @param name - published skill name.
*/
async function readLocalSkill(root, name) {
	const wanted = name.trim();
	if (wanted === "") return void 0;
	return (await listLocalSkills(root)).find((skill) => skill.name === wanted);
}
/** One installed skill folder as the library reports it. */
async function entryOf(root, candidate, options) {
	const inspection = inspectSkillMarkdown(await readSkillText(candidate.path) ?? "");
	const name = inspection.name !== "" ? inspection.name : candidate.folder;
	const known = knownSkillUrl(name);
	const registryPath = options.known?.find((item) => item.name === name || item.name === candidate.folder)?.path;
	const info = await stat(candidate.path).catch(() => void 0);
	const issue = inspection.issue !== void 0 && options.issueText !== void 0 ? options.issueText(inspection.issue, name) : void 0;
	return {
		name,
		description: inspection.description,
		path: registryPath ?? candidate.path,
		sizeBytes: path.basename(candidate.path).toLowerCase() === "skill.md" ? await directorySize(path.dirname(candidate.path)) : info?.size ?? 0,
		updatedAt: info?.mtimeMs ?? Date.now(),
		...known === void 0 ? {} : { installUrl: known },
		...issue === void 0 ? {} : { issue }
	};
}
/**
* Inspect the library.
* @param options - skills root plus an optional authoritative name/path list
*   from the host registry (`ctx.skills`), which is preferred for `path`.
* @param options.root - resolved skills root.
* @param options.known - registry summaries, when the registry answered.
* @param options.networkAvailable - whether installs can be attempted at all.
* @param options.issueText - localizes "why the node menu cannot offer this"
*   for entries the host registry would ignore; omitted leaves it unsaid.
*/
async function listLibrary(options) {
	const entries = [];
	for (const candidate of await scanSkillFiles(options.root)) entries.push(await entryOf(options.root, candidate, options));
	entries.sort((a, b) => a.name.localeCompare(b.name));
	return {
		root: options.root,
		entries,
		catalog: KNOWN_SKILL_SOURCES.map((source) => ({ ...source })),
		networkAvailable: options.networkAvailable
	};
}
/** Strip a source URL down to something printable in an error message. */
function shortSource(source) {
	try {
		const url = new URL(source);
		return `${url.host}${url.pathname}`.slice(0, 120);
	} catch {
		return source.slice(0, 120);
	}
}
/**
* Classify one install source.
* @param source - user-supplied URL (git URL, archive URL, or SKILL.md URL).
*/
function classifySource(source) {
	const trimmed = source.trim();
	const github = /^https?:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s#?]+?)(?:\.git)?(?:\/(?:tree|blob)\/([^/\s]+)((?:\/[^\s#?]*)?))?\/?$/i.exec(trimmed);
	if (github !== null) {
		const subpath = (github[4] ?? "").replace(/^\/+/, "").replace(/\/+$/, "");
		return {
			kind: "github",
			owner: github[1],
			repo: github[2],
			ref: github[3] ?? "",
			subpath
		};
	}
	const raw = /^https?:\/\/raw\.githubusercontent\.com\/([^/\s]+)\/([^/\s]+)\/([^/\s]+)\/(.+)$/i.exec(trimmed);
	if (raw !== null) return {
		kind: "raw",
		url: trimmed,
		name: (raw[4].split("/").filter((part) => part !== "").pop() ?? "SKILL.md").replace(/\.md$/i, "")
	};
	if (/\.zip(?:[?#].*)?$/i.test(trimmed)) return {
		kind: "archive",
		url: trimmed
	};
	return {
		kind: "git",
		url: trimmed,
		name: (trimmed.split(/[?#]/)[0].replace(/\/+$/, "").split("/").pop() ?? "").replace(/\.git$/i, "")
	};
}
/** Download one URL into memory with a byte cap. */
async function download(url, maxBytes, signal) {
	let response;
	try {
		response = await fetch(url, {
			redirect: "follow",
			signal,
			headers: {
				"user-agent": "dsh-imagegen-studio-skill-installer",
				accept: "*/*"
			}
		});
	} catch (error) {
		throw new SkillStoreError(`下载失败：${error instanceof Error ? error.message : String(error)}`);
	}
	if (!response.ok) throw new SkillStoreError(`下载失败：HTTP ${response.status}`);
	const length = Number(response.headers.get("content-length") ?? "0");
	if (Number.isFinite(length) && length > maxBytes) throw new SkillStoreError("文件超过大小上限");
	const data = Buffer.from(await response.arrayBuffer());
	if (data.length > maxBytes) throw new SkillStoreError("文件超过大小上限");
	return data;
}
/** Run a command without a shell and collect its output (bounded by a timer). */
function run(command, args, options) {
	return new Promise((resolve) => {
		let settled = false;
		const child = spawn(command, args, {
			cwd: options.cwd,
			windowsHide: true,
			stdio: [
				"ignore",
				"pipe",
				"pipe"
			],
			env: {
				...process.env,
				GIT_TERMINAL_PROMPT: "0",
				GIT_ASKPASS: "echo"
			}
		});
		let output = "";
		const collect = (chunk) => {
			if (output.length < 8e3) output += chunk.toString("utf8");
		};
		child.stdout?.on("data", collect);
		child.stderr?.on("data", collect);
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			child.kill();
			resolve({
				code: -1,
				output: `${output}\n安装超时`
			});
		}, options.timeoutMs);
		child.on("error", (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({
				code: -1,
				output: String(error.message)
			});
		});
		child.on("close", (code) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({
				code: code ?? -1,
				output
			});
		});
	});
}
/** Expand a ZIP archive into `target`, refusing paths that escape it. */
async function extractArchive(data, target) {
	const entries = readZipDirectory(data);
	if (entries.length === 0) throw new SkillStoreError("压缩包无法解析（不是有效的 ZIP）");
	let written = 0;
	let expanded = 0;
	for (const entry of entries) {
		const relative = entry.name.replace(/\\/g, "/").replace(/^\/+/, "");
		if (relative === "" || relative.includes("..")) continue;
		const destination = path.resolve(target, relative);
		if (path.relative(target, destination).startsWith("..")) continue;
		if (isZipDirectory(entry)) {
			await mkdir(destination, { recursive: true });
			continue;
		}
		const bytes = readZipEntry(data, entry, MAX_SKILL_ARCHIVE_BYTES);
		if (bytes === void 0) continue;
		expanded += bytes.length;
		if (expanded > 67108864) throw new SkillStoreError("压缩包解压后超过大小上限");
		await mkdir(path.dirname(destination), { recursive: true });
		await writeFile(destination, bytes);
		written += 1;
	}
	if (written === 0) throw new SkillStoreError("压缩包内没有可安装的文件");
	return written;
}
/** Find the folder that actually holds `SKILL.md` inside an extracted tree. */
async function findSkillRoot(root) {
	if (existsSync(path.join(root, "SKILL.md"))) return root;
	let children;
	try {
		children = await readdir(root, { withFileTypes: true });
	} catch {
		return;
	}
	const dirs = children.filter((child) => child.isDirectory());
	for (const dir of dirs) {
		const candidate = path.join(root, dir.name);
		if (existsSync(path.join(candidate, "SKILL.md"))) return candidate;
	}
	if (dirs.length === 1) return await findSkillRoot(path.join(root, dirs[0].name));
}
/** `fs.rename` can fail across volumes; fall back to a recursive copy. */
async function moveInto(from, to) {
	try {
		await rename(from, to);
	} catch {
		await cp(from, to, { recursive: true });
		await rm(from, {
			recursive: true,
			force: true
		});
	}
}
/**
* The name one staged bundle installs under, or an actionable refusal.
*
* A bundle the host registry cannot load is never worth installing: its
* frontmatter name must be kebab-case, its description present, and its
* invocation spellings parseable. The folder fallback is only a *label* — the
* host publishes the frontmatter name, so a fallback cannot rescue a bundle
* whose own frontmatter is unusable.
* @param markdown - the staged `SKILL.md` contents.
*/
function installableSkillName(markdown) {
	const inspection = inspectSkillMarkdown(markdown);
	switch (inspection.issue) {
		case "no-frontmatter": throw new SkillStoreError("SKILL.md 缺少 YAML frontmatter（--- 开头的 name / description），本机技能注册表不会加载它");
		case "bad-name": throw new SkillStoreError(`SKILL.md 的 frontmatter name「${inspection.name}」不是 kebab-case（只能小写字母、数字和连字符），本机技能注册表会忽略它`);
		case "no-description": throw new SkillStoreError("SKILL.md 的 frontmatter 缺少 description（必填），本机技能注册表不会加载它");
		case "bad-invocation": throw new SkillStoreError("SKILL.md 的 disable-model-invocation / user-invocable 写法无法解析，本机技能注册表会忽略它");
		default: return inspection.name;
	}
}
/** Move a staged skill bundle into the library under its published name. */
async function promote(staged, root, force) {
	const skillRoot = await findSkillRoot(staged);
	if (skillRoot === void 0) throw new SkillStoreError("该来源里没有找到 SKILL.md");
	const markdown = await readFile(path.join(skillRoot, "SKILL.md"), "utf8").catch(() => "");
	if (markdown.trim() === "") throw new SkillStoreError("SKILL.md 是空文件");
	const name = installableSkillName(markdown);
	if (!isValidSkillName(name)) throw new SkillStoreError(`技能名「${name}」不能用作目录名，请改名后重新安装`);
	const destination = path.resolve(root, name);
	if (path.relative(root, destination).startsWith("..")) throw new SkillStoreError("技能名不合法");
	if (existsSync(destination) && !force) throw new SkillStoreError(`技能「${name}」已经安装（可勾选覆盖安装）`);
	await rm(destination, {
		recursive: true,
		force: true
	});
	await mkdir(root, { recursive: true });
	await moveInto(skillRoot, destination);
	return name;
}
/**
* Install one skill from an uploaded archive, or from a folder of files.
* @param data - archive bytes.
* @param root - skills root.
* @param _fallbackName - accepted for signature compatibility only: the
*   frontmatter `name` is authoritative, because that is the name the host
*   registry publishes (a bundle without one is refused, not renamed).
* @param force - replace an existing skill of the same name.
*/
async function installFromArchive(data, root, _fallbackName, force) {
	const staging = await mkdtemp(path.join(tmpdir(), "dsh-imagegen-studio-skill-"));
	try {
		await extractArchive(data, staging);
		return await promote(staging, root, force);
	} finally {
		await rm(staging, {
			recursive: true,
			force: true
		}).catch(() => {});
	}
}
/**
* Install one skill from a URL: a GitHub folder, a raw `SKILL.md`, an archive,
* or any other git remote.
* @param source - the URL the user supplied.
* @param root - skills root.
* @param options - `force` replaces an existing install; `signal` aborts.
*   `fallbackName` only names a *diagnostic* for a source with no bundle; the
*   frontmatter name is what the host registry publishes.
*/
async function installFromUrl(source, root, options) {
	const kind = classifySource(source);
	if (kind.kind === "raw") {
		const data = await download(kind.url, MAX_SKILL_MARKDOWN_BYTES, options.signal);
		const name = installableSkillName(data.toString("utf8"));
		if (!isValidSkillName(name)) throw new SkillStoreError(`技能名「${name}」不能用作目录名，请改用仓库地址安装`);
		const destination = path.resolve(root, name);
		if (path.relative(root, destination).startsWith("..")) throw new SkillStoreError("技能名不合法");
		if (existsSync(destination) && !options.force) throw new SkillStoreError(`技能「${name}」已经安装（可勾选覆盖安装）`);
		await rm(destination, {
			recursive: true,
			force: true
		});
		await mkdir(destination, { recursive: true });
		await writeFile(path.join(destination, "SKILL.md"), data);
		return name;
	}
	if (kind.kind === "github") {
		const ref = kind.ref === "" ? "HEAD" : kind.ref;
		const data = await download(`https://codeload.github.com/${kind.owner}/${kind.repo}/zip/${encodeURIComponent(ref)}`, MAX_SKILL_ARCHIVE_BYTES, options.signal);
		const staging = await mkdtemp(path.join(tmpdir(), "dsh-imagegen-studio-skill-"));
		try {
			await extractArchive(data, staging);
			const wanted = kind.subpath === "" ? staging : path.resolve(staging, kind.subpath);
			return await promote(existsSync(wanted) ? wanted : staging, root, options.force);
		} finally {
			await rm(staging, {
				recursive: true,
				force: true
			}).catch(() => {});
		}
	}
	if (kind.kind === "archive") {
		const data = await download(kind.url, MAX_SKILL_ARCHIVE_BYTES, options.signal);
		const tail = shortSource(kind.url).split("/").pop() ?? "skill";
		return await installFromArchive(data, root, options.fallbackName ?? tail.replace(/\.zip$/i, ""), options.force);
	}
	const staging = await mkdtemp(path.join(tmpdir(), "dsh-imagegen-studio-skill-"));
	try {
		const result = await run("git", [
			"clone",
			"--depth",
			"1",
			"--quiet",
			kind.url,
			path.join(staging, "repo")
		], {
			cwd: staging,
			timeoutMs: INSTALL_TIMEOUT_MS
		});
		if (result.code !== 0) throw new SkillStoreError(`git clone 失败：${result.output.trim().split("\n").slice(-3).join(" ").slice(0, 300)}`);
		await rm(path.join(staging, "repo", ".git"), {
			recursive: true,
			force: true
		});
		return await promote(path.join(staging, "repo"), root, options.force);
	} finally {
		await rm(staging, {
			recursive: true,
			force: true
		}).catch(() => {});
	}
}
/** One local candidate whose published name matches, for a remove by name. */
async function publishedSkillFile(root, name) {
	for (const candidate of await scanSkillFiles(root)) {
		const markdown = await readSkillText(candidate.path);
		if (markdown === void 0) continue;
		if (inspectSkillMarkdown(markdown).name === name) return candidate.path;
	}
}
/**
* Remove one installed skill. The name may be the folder name or the
* frontmatter name the panel listed (they differ whenever an author renamed
* their skill after the first release).
* @param name - the skill's published or folder name inside the library.
* @param root - skills root.
*/
async function removeSkill(name, root) {
	const trimmed = name.trim();
	if (trimmed === "" || trimmed === "." || trimmed === ".." || /[\\/]/.test(trimmed)) throw new SkillStoreError("技能名不合法");
	const dir = path.resolve(root, trimmed);
	if (path.relative(root, dir).startsWith("..")) throw new SkillStoreError("技能名不合法");
	const flat = path.resolve(root, `${trimmed}.md`);
	if (existsSync(dir)) {
		await rm(dir, {
			recursive: true,
			force: true
		});
		return trimmed;
	}
	if (existsSync(flat)) {
		await rm(flat, { force: true });
		return trimmed;
	}
	const published = await publishedSkillFile(root, trimmed);
	if (published === void 0) throw new SkillStoreError(`没有找到技能「${trimmed}」`);
	if (path.basename(published).toLowerCase() === "skill.md") await rm(path.dirname(published), {
		recursive: true,
		force: true
	});
	else await rm(published, { force: true });
	return trimmed;
}
//#endregion
//#region src/skill-config.ts
/**
* Per-skill configuration (`docs/skill-config.md`).
*
* Skills are data, so DSH itself has no notion of a skill setting; the canvas
* supplies one. A skill declares what it needs in a `skill.config.json` beside
* its `SKILL.md`, the panel renders a form from that declaration, the values
* live in this plugin's settings namespace, and "save and apply" runs the
* declared steps — the skill's own CLI (`editppt config …`) or a config file it
* reads. A built-in recipe covers well-known skills that ship no declaration.
*
* Everything here treats the declaration as untrusted data:
*
*  - parsing never executes anything and never writes a file;
*  - the manifest is bounded (fields, steps, content size) and versioned;
*  - `apply` runs only when the user clicks, with the exact argv shown first;
*  - commands run without a shell, from a fixed cwd, under a timeout;
*  - `file` targets expand `~`, refuse `..` escapes, and refuse the DSH home's
*    control files;
*  - secrets never reach the run prompt, the run directory, or a step's
*    reported detail/output.
*/
/** Cap on one declaration's fields / steps / file body. */
const MAX_CONFIG_FIELDS = 32;
const MAX_CONFIG_STEPS = 16;
const MAX_CONFIG_CONTENT_BYTES = 8 * 1024;
const MAX_CONFIG_LABEL_CHARS = 240;
/** Wall-clock cap for one `command` step. */
const COMMAND_TIMEOUT_MS = 18e4;
/** Cap on the command output kept for the panel. */
const MAX_COMMAND_OUTPUT_CHARS = 8e3;
/** Key one value inside the settings dictionaries. */
function skillConfigKey(skill, field) {
	return `${skill}/${field}`;
}
/** Coerce one dictionary-shaped settings value into a detached record. */
function asConfigDict(value) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
	const out = {};
	for (const [key, entry] of Object.entries(value)) if (typeof entry === "string") out[key] = entry;
	return out;
}
/** One field id the manifest may reference from `apply`. */
const FIELD_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const FIELD_TYPES = /* @__PURE__ */ new Set([
	"string",
	"secret",
	"boolean",
	"number",
	"select"
]);
/** Trim one declaration string to its cap, or undefined when it is not text. */
function text(value, max) {
	if (typeof value !== "string") return void 0;
	const trimmed = value.trim();
	return trimmed === "" ? void 0 : trimmed.slice(0, max);
}
/** Parse one `fields[]` entry. */
function parseField(raw) {
	if (raw === null || typeof raw !== "object") return void 0;
	const entry = raw;
	const id = typeof entry.id === "string" ? entry.id.trim() : "";
	if (!FIELD_ID.test(id)) return void 0;
	const type = typeof entry.type === "string" && FIELD_TYPES.has(entry.type) ? entry.type : "string";
	const label = text(entry.label, MAX_CONFIG_LABEL_CHARS) ?? id;
	const description = text(entry.description, MAX_CONFIG_LABEL_CHARS);
	const fallback = text(entry.default, MAX_CONFIG_CONTENT_BYTES);
	const options = type !== "select" || !Array.isArray(entry.options) ? void 0 : entry.options.map((option) => {
		if (option === null || typeof option !== "object") return void 0;
		const record = option;
		const value = text(record.value, MAX_CONFIG_LABEL_CHARS);
		if (value === void 0) return void 0;
		return {
			value,
			label: text(record.label, MAX_CONFIG_LABEL_CHARS) ?? value
		};
	}).filter((option) => option !== void 0).slice(0, 64);
	return {
		id,
		label,
		type,
		...description === void 0 ? {} : { description },
		...entry.required === true ? { required: true } : {},
		...fallback === void 0 ? {} : { default: fallback },
		...options === void 0 || options.length === 0 ? {} : { options },
		...type === "secret" ? {} : entry.expose === true ? { expose: true } : {}
	};
}
/** Parse one `apply[]` entry. */
function parseStep(raw) {
	if (raw === null || typeof raw !== "object") return void 0;
	const entry = raw;
	const when = entry.when !== null && typeof entry.when === "object" ? entry.when : void 0;
	const guard = when === void 0 || typeof when.field !== "string" || !FIELD_ID.test(when.field.trim()) ? void 0 : {
		field: when.field.trim(),
		set: when.set !== false
	};
	const kind = typeof entry.kind === "string" ? entry.kind : "";
	if (kind === "command") {
		if (!Array.isArray(entry.argv)) return void 0;
		const argv = entry.argv.map((part) => typeof part === "string" ? part.trim() : "").filter((part) => part !== "").slice(0, 32);
		if (argv.length === 0) return void 0;
		return {
			kind: "command",
			argv,
			cwd: entry.cwd === "skill" ? "skill" : "run",
			...guard === void 0 ? {} : { when: guard }
		};
	}
	if (kind === "file") {
		const target = text(entry.path, 1024);
		const content = typeof entry.content === "string" ? entry.content : void 0;
		if (target === void 0 || content === void 0) return void 0;
		if (content.length > MAX_CONFIG_CONTENT_BYTES) return void 0;
		return {
			kind: "file",
			path: target,
			content,
			...guard === void 0 ? {} : { when: guard }
		};
	}
}
/**
* Validate one declaration object.
* @param raw - parsed JSON (or any value).
* @returns the bounded manifest, or the issue that made it unusable.
*/
function parseSkillConfigManifest(raw) {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { issue: "unreadable" };
	const entry = raw;
	if (entry.version !== 1) return { issue: "unsupported-version" };
	const fields = (Array.isArray(entry.fields) ? entry.fields : []).map(parseField).filter((field) => field !== void 0).slice(0, MAX_CONFIG_FIELDS);
	const steps = (Array.isArray(entry.apply) ? entry.apply : []).map(parseStep).filter((step) => step !== void 0).slice(0, MAX_CONFIG_STEPS);
	if (fields.length === 0 && steps.length === 0) return { issue: "empty" };
	const note = text(entry.note, MAX_CONFIG_LABEL_CHARS);
	return { manifest: {
		fields,
		steps,
		...note === void 0 ? {} : { note }
	} };
}
/** Read `<bundleDir>/skill.config.json` when the bundle has one. */
async function readSkillConfigFile(bundleDir) {
	const file = path.join(bundleDir, "skill.config.json");
	if (!existsSync(file)) return void 0;
	let raw;
	try {
		raw = JSON.parse(await readFile(file, "utf8"));
	} catch {
		return { issue: "unreadable" };
	}
	return parseSkillConfigManifest(raw);
}
/** Current values for one skill, secrets included (host side only). */
function valuesFor(declaration, store, skill) {
	const values = /* @__PURE__ */ new Map();
	for (const field of declaration.manifest.fields) {
		const key = skillConfigKey(skill, field.id);
		const stored = field.type === "secret" ? store.secrets[key] : store.values[key];
		values.set(field.id, typeof stored === "string" ? stored : field.default ?? "");
	}
	return values;
}
/** Labels of required fields with no value yet, in declaration order. */
function missingFields(declaration, values) {
	return declaration.manifest.fields.filter((field) => field.required === true && (values.get(field.id) ?? "").trim() === "").map((field) => field.label);
}
/**
* The panel-facing view of one skill's configuration. An ignored declaration
* still reports why, so the author sees the typo instead of an empty panel.
* @param declaration - validated declaration, when there is one.
* @param values - resolved values (secrets included).
* @param issue - host-rendered copy for an ignored declaration, when any.
*/
function configView(declaration, values, issue) {
	if (declaration === void 0) return issue === void 0 ? void 0 : {
		fields: [],
		values: [],
		source: "skill",
		applicable: false,
		missing: [],
		issue
	};
	return {
		fields: declaration.manifest.fields,
		values: declaration.manifest.fields.map((field) => {
			const value = values.get(field.id) ?? "";
			return field.type === "secret" ? {
				id: field.id,
				set: value !== ""
			} : {
				id: field.id,
				set: value !== "",
				value
			};
		}),
		source: declaration.source,
		applicable: declaration.manifest.steps.length > 0,
		missing: missingFields(declaration, values),
		...declaration.manifest.note === void 0 ? {} : { note: declaration.manifest.note },
		...issue === void 0 ? {} : { issue }
	};
}
/**
* The non-secret "configured values" block a run may carry, or undefined when
* the declaration exposes nothing. Secrets never appear here.
* @param declaration - validated declaration.
* @param values - resolved values (secrets included; they are filtered out).
*/
function configNote(declaration, values) {
	const lines = declaration.manifest.fields.filter((field) => field.expose === true && field.type !== "secret").map((field) => {
		const value = (values.get(field.id) ?? "").trim();
		return value === "" ? void 0 : `- ${field.label}: ${value}`;
	}).filter((line) => line !== void 0);
	return lines.length === 0 ? void 0 : lines.join("\n");
}
/** Substitute `{field}` references; undefined when a referenced value is empty. */
function substitute(template, values) {
	const missing = [];
	return {
		text: template.replace(/\{([a-z0-9][a-z0-9-]{0,63})\}/g, (_match, id) => {
			const value = (values.get(id) ?? "").trim();
			if (value === "") {
				missing.push(id);
				return "";
			}
			return value;
		}),
		missing
	};
}
/** Whether one guarded step should run. */
function guardAllows(step, values) {
	const when = step.when;
	if (when === void 0) return true;
	const value = (values.get(when.field) ?? "").trim();
	return when.set ? value !== "" : value === "";
}
/**
* Resolve one `file` target: expand `~`, refuse `..` escapes, and refuse the
* DSH home's own control files (a declaration is untrusted, so the blast radius
* of one careless click stays small).
* @param raw - the declared path.
* @returns the absolute target, or a refusal code.
*/
function resolveConfigTarget(raw) {
	const trimmed = raw.trim();
	const expanded = trimmed === "~" || trimmed.startsWith("~/") || trimmed.startsWith("~\\") ? path.join(homedir(), trimmed.slice(1)) : trimmed;
	if (!path.isAbsolute(expanded)) return { issue: "refused-path" };
	if (expanded.split(/[\\/]+/).includes("..")) return { issue: "refused-path" };
	const normalized = path.resolve(expanded);
	const home = (process.env.DSH_HOME ?? "").trim() === "" ? path.join(homedir(), ".dsh") : process.env.DSH_HOME.trim();
	const control = [
		"settings.yaml",
		"cordis.patch.yml",
		"cordis.yml"
	].map((name) => path.join(home, name));
	const profiles = path.join(home, "profiles");
	if (control.includes(normalized)) return { issue: "refused-path" };
	if (normalized === profiles || normalized.startsWith(`${profiles}${path.sep}`)) return { issue: "refused-path" };
	return { path: normalized };
}
/** Mask every secret value inside one report string. */
function mask(text, secrets) {
	let out = text;
	for (const secret of secrets) if (secret.trim().length >= 4) out = out.split(secret).join("•••");
	return out;
}
/** Run one command without a shell, bounded by a timer and an output cap. */
function runCommand(argv, options) {
	return new Promise((resolve) => {
		let settled = false;
		const child = spawn(argv[0], argv.slice(1), {
			cwd: options.cwd,
			windowsHide: true,
			stdio: [
				"ignore",
				"pipe",
				"pipe"
			],
			env: { ...process.env }
		});
		let output = "";
		const collect = (chunk) => {
			if (output.length < MAX_COMMAND_OUTPUT_CHARS) output += chunk.toString("utf8");
		};
		child.stdout?.on("data", collect);
		child.stderr?.on("data", collect);
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			child.kill();
			resolve({
				code: -1,
				output: `${output}\n超时（${Math.round(options.timeoutMs / 1e3)}s）`
			});
		}, options.timeoutMs);
		child.on("error", (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({
				code: -1,
				output: String(error.message)
			});
		});
		child.on("close", (code) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({
				code: code ?? -1,
				output
			});
		});
	});
}
/** Write one file atomically, creating its parents. */
async function writeConfigFile(target, content) {
	await mkdir(path.dirname(target), { recursive: true });
	const temporary = `${target}.tmp-${process.pid.toString(36)}`;
	try {
		await writeFile(temporary, content, "utf8");
		await rename(temporary, target);
	} catch (error) {
		await rm(temporary, { force: true }).catch(() => {});
		throw error;
	}
}
/**
* Execute a declaration's `apply` steps in order.
* @param declaration - validated declaration.
* @param values - resolved values (secrets included).
* @param options - `runRoot` is the default cwd; `skillDir` backs `cwd: 'skill'`;
*   `timeoutMs` overrides the per-command cap.
* @returns one result per declared step, in order (secrets masked).
*/
async function applySkillConfigSteps(declaration, values, options) {
	const secrets = declaration.manifest.fields.filter((field) => field.type === "secret").map((field) => values.get(field.id) ?? "");
	const results = [];
	const stepDir = (step) => {
		if (step.kind === "command" && step.cwd === "skill" && options.skillDir !== void 0) return options.skillDir;
		return options.runRoot;
	};
	for (const step of declaration.manifest.steps) {
		if (!guardAllows(step, values)) {
			results.push({
				step,
				ok: true,
				detail: "skipped"
			});
			continue;
		}
		if (step.kind === "command") {
			const substituted = step.argv.map((part) => substitute(part, values));
			const missing = [...new Set(substituted.flatMap((part) => part.missing))];
			const argv = substituted.map((part) => part.text);
			if (missing.length > 0) {
				results.push({
					step,
					ok: false,
					detail: mask(argv.join(" "), secrets),
					output: `缺少配置：${missing.join("、")}`
				});
				continue;
			}
			const outcome = await runCommand(argv, {
				cwd: stepDir(step),
				timeoutMs: options.timeoutMs ?? COMMAND_TIMEOUT_MS
			});
			const output = mask(outcome.output.trim().slice(-8e3), secrets);
			results.push({
				step,
				ok: outcome.code === 0,
				detail: mask(argv.join(" "), secrets),
				...output === "" ? {} : { output }
			});
			continue;
		}
		const target = resolveConfigTarget(step.path);
		if ("issue" in target) {
			results.push({
				step,
				ok: false,
				detail: step.path,
				output: "该路径不允许写入（只允许绝对路径 / ~ 展开，且不能写 DSH 主目录的控制文件）"
			});
			continue;
		}
		const rendered = substitute(step.content, values);
		if (rendered.missing.length > 0) {
			results.push({
				step,
				ok: false,
				detail: `→ ${target.path}`,
				output: `缺少配置：${[...new Set(rendered.missing)].join("、")}`
			});
			continue;
		}
		try {
			await writeConfigFile(target.path, rendered.text);
			results.push({
				step,
				ok: true,
				detail: `→ ${target.path}`
			});
		} catch (error) {
			results.push({
				step,
				ok: false,
				detail: `→ ${target.path}`,
				output: error instanceof Error ? error.message : String(error)
			});
		}
	}
	return results;
}
//#endregion
//#region src/skill-config-recipes.ts
/**
* Built-in configuration recipes for well-known skills.
*
* A skill should declare its own configuration in `skill.config.json` (see
* `docs/skill-config.md`); a recipe exists only so a known skill works out of
* the box for users who installed it from upstream before it shipped a
* declaration. A skill's own file always wins, so upstream can take over
* without a plugin release — the same relationship `KNOWN_SKILL_SOURCES` has
* with install links.
*
* Recipes are plugin-owned data, so they are trusted here: they still go
* through the same validation as an installed declaration, which keeps one
* grammar and one set of caps for both.
*/
/**
* The `image-to-editable-ppt` pipeline: it drives `editppt`, which reads
* `~/.editppt/config.yaml` and needs an OpenAI-compatible image endpoint for
* page background repair and asset separation. PaddleOCR is optional (the
* built-in offline detector still works), so its step is guarded.
*/
const RECIPES = [{
	name: EDITABLE_PPT_SKILL,
	declaration: {
		version: 1,
		note: "使用已有 Codex OAuth 时可不填图像 API 密钥；需要 API 兜底时填写。密钥只写入本机 ~/.editppt/config.yaml；不会进入运行目录、清单或提示词。页面素材需要任何 OpenAI 兼容的图像 API。",
		fields: [
			{
				id: "image-api-key",
				label: "图像 API 密钥",
				description: "用于页面背景修复与素材分离的 OpenAI 兼容图像 API 密钥",
				type: "secret",
				required: false
			},
			{
				id: "image-base-url",
				label: "API 地址",
				description: "OpenAI 兼容的 base URL，例如 https://api.openai.com/v1",
				type: "string",
				default: "https://api.openai.com/v1",
				expose: true
			},
			{
				id: "image-model",
				label: "图像模型",
				type: "string",
				default: "gpt-image-2",
				expose: true
			},
			{
				id: "paddle-ocr-token",
				label: "PaddleOCR token（可选）",
				description: "不填则使用内置离线文字检测；填了文字还原更准（免费额度）",
				type: "secret"
			}
		],
		apply: [{
			kind: "command",
			when: {
				field: "image-api-key",
				set: true
			},
			argv: [
				"editppt",
				"config",
				"--api-key",
				"{image-api-key}",
				"--base-url",
				"{image-base-url}",
				"--model",
				"{image-model}"
			]
		}, {
			kind: "command",
			argv: [
				"editppt",
				"config",
				"--paddle-ocr-token",
				"{paddle-ocr-token}"
			],
			when: {
				field: "paddle-ocr-token",
				set: true
			}
		}]
	}
}];
/** The built-in declaration for one skill, already validated. */
function recipeFor(skillName) {
	const recipe = RECIPES.find((entry) => entry.name === skillName);
	if (recipe === void 0) return void 0;
	const parsed = parseSkillConfigManifest(recipe.declaration);
	return parsed.manifest === void 0 ? void 0 : {
		manifest: parsed.manifest,
		source: "plugin"
	};
}
/** Skill names this plugin ships a configuration recipe for. */
function recipeNames() {
	return RECIPES.map((recipe) => recipe.name);
}
//#endregion
//#region src/ppt-runtime.ts
/** Installs the upstream CLI unchanged in an isolated Python environment. */
var PptRuntime = class {
	root;
	skillDir;
	installing;
	constructor(root, skillDir) {
		this.root = root;
		this.skillDir = skillDir;
	}
	executable() {
		return path.join(this.root(), "ppt-runtime", process.platform === "win32" ? "Scripts/editppt.exe" : "bin/editppt");
	}
	async command() {
		const local = this.executable();
		return await promises.stat(local).then((s) => s.isFile(), () => false) ? local : "editppt";
	}
	async check() {
		const result = await runCommand([await this.command(), "doctor"], {
			cwd: process.cwd(),
			timeoutMs: 3e4
		});
		return {
			available: result.code === 0,
			message: result.output.slice(0, 12e3)
		};
	}
	async install() {
		if (this.installing !== void 0) return this.installing;
		this.installing = this.installUpstream().finally(() => {
			this.installing = void 0;
		});
		return this.installing;
	}
	async installUpstream() {
		const dir = await this.skillDir();
		if (dir === void 0) throw new Error("请先安装 image-to-editable-ppt skill");
		const cli = path.join(dir, "cli");
		await promises.access(path.join(cli, "pyproject.toml"));
		const candidates = process.platform === "win32" ? [
			["py", "-3"],
			["python"],
			["python3"]
		] : [["python3"], ["python"]];
		let python;
		for (const candidate of candidates) if ((await runCommand([
			...candidate,
			"-c",
			"import sys; sys.exit(0 if sys.version_info >= (3,10) else 1)"
		], {
			cwd: dir,
			timeoutMs: 1e4
		})).code === 0) {
			python = candidate;
			break;
		}
		if (python === void 0) throw new Error("需要 Python 3.10 或以上版本。安装 Python 后重启 DSH，再点击安装运行环境。");
		const environment = path.join(this.root(), "ppt-runtime");
		await promises.mkdir(this.root(), { recursive: true });
		const created = await runCommand([
			...python,
			"-m",
			"venv",
			environment
		], {
			cwd: dir,
			timeoutMs: 6e4
		});
		if (created.code !== 0) throw new Error(`无法创建 Python 环境：${created.output.slice(-3e3)}`);
		const installed = await runCommand([
			path.join(environment, process.platform === "win32" ? "Scripts/python.exe" : "bin/python"),
			"-m",
			"pip",
			"install",
			"--editable",
			cli
		], {
			cwd: dir,
			timeoutMs: 18e4
		});
		if (installed.code !== 0) throw new Error(`上游 editppt 安装失败：${installed.output.slice(-3e3)}`);
		const setup = await runCommand([this.executable(), "setup"], {
			cwd: dir,
			timeoutMs: 3e4
		});
		if (setup.code !== 0) throw new Error(`editppt setup 失败：${setup.output.slice(-3e3)}`);
		return this.check();
	}
};
//#endregion
//#region src/conflicts.ts
/**
* 与同名路由/工具/settings 命名空间撞车的插件检测。
*
* WHY：本插件注册的是 `/api/dsh-imagegen-studio/*` 这一整组路由、`generate_image`
* 这批工具、以及 `plugin:dsh-imagegen-studio` 这个提示词段。上游的同源插件
* （`@q253595422/dsh-imagegen-video`）注册的是同一套东西——两个都启用时，先到的
* 那个占住名字，后到的在 `apply()` 里抛 "already registered"，表现是路由重复、
* 工具重复，严重时整个 Web 端卡在 "正在读取本地工作台"。这类冲突不该等到用户
* 撞上才解释，也不该让宿主静默吞掉：启动时认出来，直接报清楚该怎么办。
*
* 判定刻意保守：只有"装了" **且** "真的会被加载"才算冲突。插件市场里禁用一
* 个 bundle 的做法是把它从 `dsh.profile.bundles` 里摘掉，所以不在 bundles 里的
* 一律视为已禁用；profile 的补丁层里把它整行标成 `disabled: true` 同样算禁用。
*/
/** 和本插件注册同一套路由 / 工具 / 设置命名空间的包。 */
const CONFLICTING_PACKAGES = ["@q253595422/dsh-imagegen-video", "@dickpy/dsh-imagegen-studio"];
/** `$DSH_HOME`，缺省落到 `~/.dsh`（与宿主其它部分一致）。 */
function dshHome() {
	const configured = (process.env.DSH_HOME ?? "").trim();
	return configured === "" ? join(homedir(), ".dsh") : configured;
}
function readManifest(path) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return;
	}
}
function bundlesOf(manifest) {
	const list = manifest?.dsh?.profile?.bundles;
	return Array.isArray(list) ? list.filter((entry) => typeof entry === "string") : [];
}
/**
* profile 的补丁层是否把某个包整行关掉了。
*
* 只看 `disabled: true` 里"这一行属于谁"——行里 `name:` 指向的包名在 `name:`
* 之后、下一个 `- id:` 之前出现，就认为这一行是它的。够用且不依赖 YAML 解析器
* （宿主可能没装，插件也不该为这点事多背一个依赖）。
*/
function disabledInPatchLayer(patchPath, name) {
	if (!existsSync(patchPath)) return false;
	let text;
	try {
		text = readFileSync(patchPath, "utf8");
	} catch {
		return false;
	}
	for (const block of text.split(/\n(?=\s*-\s+id:)/)) {
		if (!block.includes(`name: "${name}"`) && !block.includes(`name: '${name}'`) && !block.includes(`name: ${name}`)) continue;
		if (/^\s*disabled:\s*true\s*$/m.test(block)) return true;
	}
	return false;
}
/**
* 找出"装了、并且会被加载"的冲突插件。
*
* @param profile - profile 名；缺省从启动参数推断（宿主会把 `--profile` 传下来）。
* @param home - `$DSH_HOME`，测试用。
*/
function findPluginConflicts(profile = profileFromProcess(), home = dshHome()) {
	const dir = join(home, "profiles", profile);
	const manifest = readManifest(join(dir, "package.json"));
	if (manifest === void 0) return [];
	const installed = /* @__PURE__ */ new Set([
		...Object.keys(manifest.dependencies ?? {}),
		...Object.keys(manifest.optionalDependencies ?? {}),
		...Object.keys(manifest.devDependencies ?? {})
	]);
	const bundles = bundlesOf(manifest);
	const patchPath = join(dir, "cordis.patch.yml");
	const hits = [];
	for (const name of CONFLICTING_PACKAGES) {
		if (!installed.has(name) && !bundles.includes(name)) continue;
		if (!bundles.includes(name)) continue;
		if (disabledInPatchLayer(patchPath, name)) continue;
		hits.push({
			name,
			profile
		});
	}
	return hits;
}
/** 给用户看的处理建议（抛错和日志共用一份措辞）。 */
function conflictMessage(hits) {
	const names = [...new Set(hits.map((hit) => hit.name))].join("、");
	return `检测到已启用的冲突插件 ${names}：它和 dsh-imagegen-studio 注册同一套 /api/dsh-imagegen-studio/* 路由、同一批工具和同一个设置命名空间，同时加载会重复注册（严重时整个页面会卡在“正在读取本地工作台”）。请先在「设置 → 插件」或插件市场里禁用或卸载 ${names}，再重启 DSH。`;
}
//#endregion
//#region src/index.ts
/**
* Resolve one skill's configuration declaration and the view the panel renders.
*
* Sidecar first, built-in recipe second, nothing third — the plugin never
* invents a configuration surface for a skill that declared none. Exported so
* the smoke suite exercises the real lookup (sidecar parsing, recipe fallback,
* value resolution) rather than a test double of it.
* @param options - skill name, its library entry path, the skills root, and the
*   live value store; `issueText` localizes an ignored declaration.
*/
async function readCanvasSkillConfig(options) {
	const candidates = [.../* @__PURE__ */ new Set([bundleDirOf(options.entryPath), path.join(options.root, options.name)])].filter((dir) => dir !== void 0);
	let declaration;
	let issue;
	for (const dir of candidates) {
		const found = await readSkillConfigFile(dir).catch(() => void 0);
		if (found === void 0) continue;
		if (found.manifest === void 0) issue = found.issue ?? "unreadable";
		else declaration = {
			manifest: found.manifest,
			source: "skill"
		};
		break;
	}
	if (declaration === void 0 && issue === void 0) declaration = recipeFor(options.name);
	const values = declaration === void 0 ? /* @__PURE__ */ new Map() : valuesFor(declaration, options.store, options.name);
	const view = configView(declaration, values, issue === void 0 ? void 0 : options.issueText === void 0 ? issue : options.issueText(issue));
	return {
		...declaration === void 0 ? {} : { declaration },
		...issue === void 0 ? {} : { issue },
		...view === void 0 ? {} : { view }
	};
}
/** The bundle directory a library entry points at, when it is a bundle. */
function bundleDirOf(entryPath) {
	if (entryPath === void 0) return void 0;
	return path.basename(entryPath).toLowerCase() === "skill.md" ? path.dirname(entryPath) : void 0;
}
/** Error text for user-facing copy (never a bare `[object Object]`). */
function messageOf(error) {
	return error instanceof Error ? error.message : String(error);
}
/**
* Compose the headless agent one heavy skill run drives.
*
* Creating an agent is not enough to make it *useful*: on the Web surface every
* model-facing row (tools, prompt sections) lives behind an agent preset, and a
* model route is not implied by the request. DSH's own entry points therefore
* always pass both — `dsh-api-session-controller` stamps `agentOptions` from the
* deployment default and mounts the resolved preset in `setup`, and
* `dsh-subagent` joins the parent's preset for the same reason ("a child that
* joins no preset sees an empty tool registry and none of its parent's prompt
* sections"). A skill pipeline that must run a CLI is exactly that case: without
* the join the agent dies on its first step, and without the model route it has
* nothing to think with, so the canvas fails the run up front with copy instead
* of producing an empty result.
* @param options - host seams plus the run's identity, workspace and skill body.
* @returns the live agent handle narrowed to what a skill run drives.
*/
async function createCanvasSkillAgent(options) {
	const requested = options.agentPreset.trim();
	const presetId = options.presets === void 0 ? void 0 : (await options.presets.resolve(requested === "" ? void 0 : requested)).id;
	const selection = options.defaultModel?.currentSelection();
	const provider = selection?.provider?.trim() ?? "";
	const model = selection?.model?.trim() ?? "";
	const fail = options.fail ?? ((key) => key);
	if (provider === "" || model === "") throw new Error(fail("canvas.skills.needModel"));
	let runtimeFailure;
	const handle = await options.agents.create({
		sessionId: options.sessionId,
		meta: {
			cwd: options.cwd,
			origin: "subagent",
			...presetId === void 0 ? {} : { agentPreset: presetId }
		},
		agentOptions: {
			provider,
			model
		},
		...options.signal === void 0 ? {} : { signal: options.signal },
		setup: async (agentCtx) => {
			agentCtx.on?.("agent/error", (payload) => {
				if (payload.agent?.id !== options.sessionId) return;
				const error = payload.error;
				runtimeFailure = redactDiagnosticText(error instanceof Error ? error.message : String(error));
			});
			if (options.presets !== void 0 && presetId !== void 0) await options.presets.mount(agentCtx, presetId);
			agentCtx.systemPrompt.section({
				name: "plugin:dsh-imagegen-studio:canvas-skill",
				order: SECTION_ORDER,
				text: options.systemPrompt
			});
		}
	});
	const agent = handle.agent;
	return {
		session: agent.session,
		followup: (body) => {
			agent.followup({
				id: `canvas-skill-${Date.now().toString(36)}`,
				role: "user",
				content: [{
					type: "text",
					text: body
				}],
				source: { kind: "plugin:dsh-imagegen-studio" }
			});
		},
		whenIdle: async () => {
			await agent.whenIdle();
			if (runtimeFailure !== void 0) throw new Error(runtimeFailure);
		},
		cancel: () => agent.cancel({ kind: "user" }),
		dispose: () => handle.dispose()
	};
}
/**
* Wrap the host skill registry for the canvas runner: only model-invocable
* skills are offered (the canvas runs every skill through a model, so a
* user-only slash-command skill would fail halfway), and the summary is
* narrowed to the fields the tier heuristic reads.
*
* The registry alone is not enough on the Web surface. There, a preset owns
* local discovery: `skill-filesystem` mounts into the *preset's* layer while
* this plugin is a host-plane bundle, and an unscoped `ctx.skills.list()` reads
* the global layer alone (the base host row is disabled — see
* `dsh-web-app/cordis.patch.yml`). Every skill the user installs into
* `~/.dsh/skills` would therefore be invisible to the canvas, even though the
* skill library panel lists it. So the local library is read straight from disk
* as a second source, and both `list` and `get` consult it — the disk source is
* also what makes a heavy run's body load without the agent's own scope.
*
* The canvas is one host surface shared by every session, so it deliberately
* offers the union: registry entries win a name collision (a deployment-level
* provider outranks a user install), and the local scan fills the rest.
* @param skills - the injected `ctx.skills` service.
* @param options - `root` resolves the local skill library root; omitted (as in
*   narrow harnesses) leaves only the registry source.
* @returns the runner's registry seam.
*/
function createSkillRegistryBackend(skills, options = {}) {
	const localRoot = () => options.root?.();
	const localSkills = async () => {
		const root = localRoot();
		if (root === void 0) return [];
		return await listLocalSkills(root).catch(() => []);
	};
	return {
		list: async () => {
			const listed = await skills.list();
			const merged = /* @__PURE__ */ new Map();
			for (const skill of await localSkills()) merged.set(skill.name, {
				name: skill.name,
				description: skill.description,
				...skill.whenToUse === void 0 ? {} : { whenToUse: skill.whenToUse },
				path: skill.path,
				source: "filesystem"
			});
			for (const summary of listed) {
				if (summary.invocation?.modelInvocable === false) continue;
				merged.set(summary.name, {
					name: summary.name,
					description: summary.description,
					...summary.whenToUse === void 0 ? {} : { whenToUse: summary.whenToUse },
					...summary.path === void 0 ? {} : { path: summary.path },
					...summary.metadata === void 0 ? {} : { metadata: summary.metadata }
				});
			}
			return [...merged.values()];
		},
		get: async (name) => {
			const definition = await skills.get(name);
			if (definition !== void 0) return {
				name: definition.name,
				content: definition.content,
				...definition.metadata === void 0 ? {} : { metadata: definition.metadata }
			};
			const root = localRoot();
			const local = root === void 0 ? void 0 : await readLocalSkill(root, name).catch(() => void 0);
			return local === void 0 ? void 0 : {
				name: local.name,
				content: local.content
			};
		}
	};
}
/** Content type for a saved image file name (object uploads). */
function mimeOfPath(filePath) {
	switch (path.extname(filePath).toLowerCase()) {
		case ".jpg":
		case ".jpeg": return "image/jpeg";
		case ".webp": return "image/webp";
		case ".gif": return "image/gif";
		default: return "image/png";
	}
}
/** Stable cordis plugin name. */
const name = "imagegen-studio";
/** Services required before the surfaces can mount. */
const inject = [
	"webServer",
	"systemPrompt",
	"commands"
];
/** The branded settings namespace of this plugin (the card edits it). */
const ImageGenSettingsNamespace = settingsNamespaceCompat(IMAGEGEN_SETTINGS_NAMESPACE);
const Config = z.object({
	enabled: z.boolean().default(true).volatile(),
	announceToAgent: z.boolean().default(true).volatile(),
	allowAgentImageGeneration: z.boolean().default(true).volatile(),
	channels: z.array(z.object({
		id: z.string(),
		preset: z.string().default(""),
		name: z.string().default(""),
		apiUrl: z.string().default(""),
		apiUrlFull: z.boolean().default(false),
		protocol: z.union([
			z.const("auto"),
			z.const("images"),
			z.const("chat-completions")
		]).default("auto"),
		auth: z.union([z.const("api-key"), z.const("subscription")]).default("api-key"),
		subscription: z.string().default(""),
		models: z.array(z.object({
			alias: z.string(),
			id: z.string()
		})).default([]),
		/** Video model catalog (alias → upstream id). Appended after `models` so
		*  existing channels keep parsing unchanged: an absent list is empty. */
		videoModels: z.array(z.object({
			alias: z.string(),
			id: z.string()
		})).default([])
	})).default([]).volatile(),
	channelSecrets: z.dict(z.string().role("secret")).default({}).volatile(),
	defaultChannelId: z.string().default("").volatile(),
	defaultModel: z.string().default("").volatile(),
	defaultVideoModel: z.string().default("").volatile(),
	allowAgentVideoGeneration: z.boolean().default(true).volatile(),
	promptApiUrl: z.string().default("").volatile(),
	promptApiKey: z.string().role("secret").default("").volatile(),
	promptModel: z.string().default("").volatile(),
	localStoragePath: z.string().default("").volatile(),
	storageEnabled: z.boolean().default(false).volatile(),
	storageEndpoint: z.string().default("").volatile(),
	storageRegion: z.string().default("").volatile(),
	storagePrefix: z.string().default("dsh-imagegen-studio").volatile(),
	storageAccessKey: z.string().default("").volatile(),
	storageSecretKey: z.string().role("secret").default("").volatile(),
	storageSyncGallery: z.boolean().default(true).volatile(),
	storageSyncHistory: z.boolean().default(false).volatile(),
	skillsEnabled: z.boolean().default(true).volatile(),
	allowHeavySkills: z.boolean().default(true).volatile(),
	skillAllowlist: z.string().default("").volatile(),
	skillOutputDir: z.string().default("").volatile(),
	skillHeavyTimeoutMinutes: z.number().default(20).volatile(),
	skillAgentPreset: z.string().default("").volatile(),
	skillConfig: z.dict(z.string()).default({}).volatile(),
	skillConfigSecrets: z.dict(z.string().role("secret")).default({}).volatile(),
	apiUrl: z.string().default("").volatile(),
	apiKey: z.string().role("secret").default("").volatile(),
	imageModels: z.array(z.string()).default([]).volatile()
});
/** Read a value that may be a volatile config reference. */
function unwrapVolatileValue(value) {
	if (typeof value === "object" && value !== null && typeof value.get === "function") return value.get();
	return value;
}
/** Detach the plain Config view from the loader's top-level volatile fields. */
function unwrapConfig(value) {
	if (typeof value !== "object" || value === null) return {};
	const out = {};
	for (const [key, field] of Object.entries(value)) out[key] = unwrapVolatileValue(field);
	return out;
}
/** Schema defaults, re-read for hand-built contexts (the loader applies them normally). */
const DEFAULT_ENABLED = true;
const DEFAULT_ANNOUNCE = true;
const DEFAULT_ALLOW_AGENT_IMAGE_GENERATION = true;
/** Order of the announcement section within the tool-guidance band. */
const SECTION_ORDER = 150;
/** Model-facing announcement: plugin presence, capabilities, and limits. */
const IMAGEGEN_GUIDANCE = "本机已安装 dsh-imagegen-studio 插件（DSH AI 生图）：「设置 → 生图配置」，以及侧边栏「新会话 / 生图」工作台。能力：通过「渠道」对接 OpenAI 兼容图像生成 API（每个渠道 = 一个 API 端点 + 各自的模型目录），支持文生图（/images/generations）与图生图（/images/edits，上传参考图，grok-imagine 模型按官方 JSON image_url 协议发送，nanobanana 系列按 aspect_ratio / image_size 参数协议发送；seedream 系列统一走 /images/generations，参考图以 JSON image 数组发送；智谱 `glm-image` 使用官方 `/api/paas/v4/images/generations`，当前仅支持文生图；qwen-image 系列使用阿里云 DashScope 原生接口（api_url 填 https://dashscope.aliyuncs.com/api/v1，不支持 OpenAI 兼容模式，该渠道不可复用于提示词增强，尺寸自动映射为宽*高）。MiniMax `image-01` 使用 MiniMax 原生 `/image_generation` 接口（api_url 填 https://api.minimax.io/v1 或国内站 https://api.minimaxi.com/v1，支持 1:1/16:9/4:3/3:2/2:3/3:4/9:16/21:9 宽高比，一次最多 9 张；图生图为单张 subject_reference 主体参考（保持人物/主体一致，非像素级局部编辑）；其 /models 只列聊天模型，图片模型需用预设目录）。API 地址与密钥在 GUI 设置中按渠道配置，密钥仅存于本机设置文档；生成请求由本地宿主代理转发，结果以 base64 返回面板，可预览与下载。模型只能使用用户在各渠道配置目录中的模型；检测模型时会过滤聊天、Embedding 等非图片模型，但模型出现在 /models 中仍不等于其网关原生支持生图协议，遇到 Qwen、MiniMax、Gemini 等非 OpenAI 生图协议时应如实说明上游兼容性。可一键把满意的图片加入「画廊」。内置「提示词模板库」（面板提示词框左下角「模板库」按钮）：多来源标签页（精选案例库 / 沧河案例库 / 手绘模板库 / Prompt-Signal / GPT Image 2 案例库），内置多个社区库的数千条提示词案例，可搜索、筛选、收藏（星标，宿主持久化）与复用；在线来源可独立刷新并每 12 小时后台同步，手绘、Prompt-Signal 与 GPT Image 2 案例库使用随插件版本更新的固定快照。Agent 可直接调用 `studio_generate_image` 提交文生图，也可用 `studio_edit_image` 图生图；默认保持工具调用等待直到任务完成，完成图片显示在工具调用对应的左侧结果区域，模型收到状态和附件引用，不会额外伪造用户消息。用户也可以使用 `/studio_edit_image <修改描述>`，命令会直接读取当前对话最近图片并调用插件图片模型，不经过对话模型的图片能力检查。若明确需要后台执行，可传 `wait_for_completion: false`，之后再用 `studio_get_image_generation_task` 查询；不要反复轮询。限制：生成消耗上游 API 额度；图片内容由上游模型生成，可能不符合预期或包含不适宜内容；api_key 以明文存储在设置文档中；参考图会发送至所配置的 API 服务；模板库参考图首次加载需要访问对应来源站点（vibeui.top / gpt-image2.canghe.ai / cdn.jsdelivr.net / raw.githubusercontent.com / pbs.twimg.com / mosaic.fxtwitter.com）。用户提到「生图 / 绘画 / 生成图片 / 文生图 / 图生图 / 画廊 / 提示词模板」时即指本插件，请据此协作。插件同时支持 AI 生视频：在「设置 → 生图配置」的渠道里为渠道单独配置「视频模型」目录（与图片模型分开，因为视频走异步提交+轮询协议），面板「生视频」标签页可文生视频、图生视频、首尾帧与多参考图生成。视频按协议族适配：Agnes 视频模型（`agnes-video-*`，提交 POST /v1/videos，轮询 GET /v1/videos/{id}，取 metadata.url，支持 mode=text/keyframe/reference、seconds、size、seed）；算力萌 comemoe 模型（`wan2.2-t2v` 仅文生视频、`zhimeng-h3-local` 支持图生视频；提交响应为扁平结构、状态含官方文档未写的 `processing`、结果在顶层 `url`，aspect_ratio 仅接受 16:9/9:16/1:1，5 秒片子实测约 9 分钟）；其余视频模型按通用 OpenAI 兼容视频端点尽力适配。Agent 可直接调用 `studio_generate_video` 提交视频生成（默认等待完成，完成视频以文件落盘并通过同源 URL 播放），也可传 `wait_for_completion: false` 后用 `studio_get_video_generation_task` 查询；视频渲染通常需要数分钟，不要反复轮询。视频文件保存在本机数据目录的 videos/ 下，不占用对话上下文。无限画布的图片节点还有四个纯界面能力（标注局部改图：画框后挂一张跟随图片移动的提示词卡片、本地抠图去背景、按视觉模型拆分图层、为节点指定模型），它们由用户在画布上操作，Agent 无需也无法触发。无限画布现在还支持「技能」：任意图片/文本/文件节点（生成配置节点除外）的悬浮工具条或右键菜单都有「技能」入口，内置动作包括文本润色（polish.text，可指定 formal/casual/shorter/expand 或自定义指令）、图片描述（describe.image）、内容抽取（extract.content：文本/代码/OOXML/PDF 抽取为文本节点），以及重任务「图片转可编辑 PPT」（ppt.fromImages）；同时会列出本机 ~/.dsh/skills 下所有可被模型调用的技能（id 形如 skill:<名称>）。轻量技能直接调用「提示词增强」所配置的聊天模型；重任务技能会启动一个无头 DSH Agent 在本机执行真实流水线（读写文件、跑 CLI），可能持续数分钟到数十分钟并消耗较多额度，因此界面会先弹确认框。`image-to-editable-ppt` 需要用户自行安装该技能，并按它的文档配置 OCR Token 与图片后端，未安装时运行会返回可操作的 skill-missing 提示；底部 Dock 的「技能库」面板可以在线安装（粘贴仓库/压缩包/SKILL.md 链接，支持 GitHub、裸 git、raw 与 zip）或上传本地技能压缩包，也可以卸载，装好后宿主会热加载、无需重启。技能可以在 SKILL.md 旁边放 skill.config.json 声明自己需要的配置（字段 + apply 步骤：command 调技能自带 CLI、或写一份配置文件），技能库面板据此渲染「配置」表单并支持保存 / 保存并应用，密钥走设置脱敏存储、不会进入运行目录或提示词；已知技能（image-to-editable-ppt 的 editppt config）插件内置了配方，所以用户不需要手敲配置命令。文件节点支持拖拽或菜单上传任意文件（单文件 ≤50MB，脚本/可执行文件被拒绝），并在节点内直接预览内容：文本/代码/CSV/TSV/JSON 原文、XLSX 表格、DOCX/PPTX/ODT/ODS 抽取文本、ZIP 目录清单都由宿主解码成有限的预览数据返回，图片、PDF、音频、视频由宿主以 inline 响应（支持 HTTP Range，可拖动播放进度）交给浏览器渲染；双击节点或点悬浮工具条的「放大预览」会在全屏阅读器里显示全文并支持复制与下载，无法内联的二进制类型仍以下载方式提供（宿主以 application/octet-stream + attachment 返回，HTML/SVG 一类的标记永远不会内联渲染）。技能运行只产出节点与连线草稿，由浏览器端写入画布文档。相关设置在「设置 → 生图配置」的「无限画布技能」（总开关、是否允许重任务、技能白名单、重任务工作目录、超时分钟数、Agent 预设，并可一键检测技能环境）。";
/** Append the live channel × model table so an Agent can honor user choices. */
function guidanceFor(channels, defaultChannelId, defaultModel, defaultVideoModel = "") {
	if (channels.length === 0) return `${IMAGEGEN_GUIDANCE} 尚未配置任何渠道：请先打开「设置 → 生图配置」添加渠道并填写 API 地址与密钥。`;
	const table = channels.map((channel) => {
		const aliases = channel.models.map((model) => model.alias).join("、");
		const mark = channel.id === defaultChannelId ? "（默认渠道）" : "";
		const key = channel.apiKey === "" ? "（未填密钥）" : "";
		const models = channel.models.length === 0 ? "未配置模型" : `可用模型：${aliases}`;
		const videoAliases = (channel.videoModels ?? []).map((model) => model.alias).join("、");
		const videos = (channel.videoModels ?? []).length === 0 ? "" : `；视频模型：${videoAliases}`;
		return `渠道「${channel.name}」${mark}[${channel.apiUrl}] ${models}${videos}${key}`;
	}).join("；");
	const fallback = defaultModel === "" ? "未指定模型时若仅一个可用模型可直接生成，若有多个应先询问用户选择「渠道 + 模型」。" : `未指定模型时默认使用「${defaultModel}」。`;
	const videoFallback = defaultVideoModel === "" ? "视频模型未设默认，未指定时应先与用户确认。" : `视频未指定模型时默认使用「${defaultVideoModel}」。`;
	return `${IMAGEGEN_GUIDANCE} 当前渠道与模型：${table}。用户指定模型名时取该模型所属渠道（多渠道同名用默认渠道）；${fallback}${videoFallback}`;
}
/** Normalize raw channel entries into the wire shape (schema-adjacent guard). */
function normalizeChannels(value) {
	if (!Array.isArray(value)) return [];
	const out = [];
	for (const item of value) {
		if (item === null || typeof item !== "object") continue;
		const raw = item;
		const id = typeof raw.id === "string" ? raw.id.trim() : "";
		if (id === "") continue;
		const models = [];
		if (Array.isArray(raw.models)) for (const entry of raw.models) {
			if (entry === null || typeof entry !== "object") continue;
			const record = entry;
			const alias = typeof record.alias === "string" ? record.alias.trim() : "";
			const upstream = typeof record.id === "string" ? record.id.trim() : "";
			if (alias === "") continue;
			models.push({
				alias,
				id: upstream === "" ? alias : upstream
			});
		}
		const videoModels = [];
		if (Array.isArray(raw.videoModels)) for (const entry of raw.videoModels) {
			if (entry === null || typeof entry !== "object") continue;
			const record = entry;
			const alias = typeof record.alias === "string" ? record.alias.trim() : "";
			const upstream = typeof record.id === "string" ? record.id.trim() : "";
			if (alias === "") continue;
			videoModels.push({
				alias,
				id: upstream === "" ? alias : upstream
			});
		}
		out.push({
			id,
			preset: typeof raw.preset === "string" ? raw.preset : "",
			name: typeof raw.name === "string" ? raw.name.trim() : "",
			apiUrl: typeof raw.apiUrl === "string" ? raw.apiUrl.trim() : "",
			apiUrlFull: raw.apiUrlFull === true,
			...isChannelProtocolPreference(raw.protocol) ? { protocol: raw.protocol } : {},
			...raw.auth === "subscription" ? { auth: "subscription" } : {},
			...isSubscriptionProvider(raw.subscription) ? { subscription: raw.subscription } : {},
			models,
			videoModels
		});
	}
	return out;
}
/** Whether a channel can back the optional chat model without subscription routing. */
function isReusablePromptChannel(channel) {
	return channel.auth !== "subscription" && channel.apiUrlFull !== true && channel.apiUrl.trim() !== "";
}
/**
* Resolve the optional chat endpoint. Keeping this separate from image
* generation matters when subscription channels appear first: blank prompt
* fields must reuse a real API-key channel, not the first configured row.
*/
function resolvePromptModelConfig(value) {
	const reusable = [
		value.defaultModel === "" ? void 0 : value.channels.find((channel) => isReusablePromptChannel(channel) && channel.models.some((model) => model.alias === value.defaultModel)),
		value.channels.find((channel) => channel.id === value.defaultChannelId),
		...value.channels
	].find((channel) => channel !== void 0 && isReusablePromptChannel(channel));
	return {
		apiUrl: value.promptApiUrl !== "" ? value.promptApiUrl : reusable?.apiUrl ?? "",
		apiKey: value.promptApiKey !== "" ? value.promptApiKey : reusable?.apiKey ?? "",
		model: value.promptModel
	};
}
/**
* Mount the settings section, routes, and announcement.
* @param ctx - host plugin context carrying webServer/systemPrompt.
* @param config - resolved plugin config (schema defaults applied by the loader).
*/
function apply(ctx, config) {
	const conflicts = findPluginConflicts();
	if (conflicts.length > 0) throw new Error(conflictMessage(conflicts));
	let current = () => config ?? {};
	const resolve = () => {
		const value = unwrapConfig(current());
		setImageDataRoot(value.localStoragePath);
		let channels = normalizeChannels(value.channels);
		const secrets = { ...value.channelSecrets ?? {} };
		if (channels.length === 0) {
			const legacyUrl = typeof value.apiUrl === "string" ? value.apiUrl.trim() : "";
			const legacyModels = Array.isArray(value.imageModels) ? value.imageModels.filter((model) => typeof model === "string" && model.trim() !== "").map((model) => ({
				alias: model.trim(),
				id: model.trim()
			})) : [];
			if (legacyUrl !== "" || legacyModels.length > 0) {
				channels = [{
					id: "default",
					preset: "",
					name: "默认渠道",
					apiUrl: legacyUrl,
					apiUrlFull: false,
					models: legacyModels
				}];
				const legacyKey = typeof value.apiKey === "string" ? value.apiKey.trim() : "";
				if (legacyKey !== "") secrets["default"] = legacyKey;
			}
		}
		const named = channels.map((channel) => ({
			...channel,
			name: channel.name === "" ? presetById(channel.preset)?.name ?? "未命名渠道" : channel.name
		}));
		const defaultChannelId = typeof value.defaultChannelId === "string" && named.some((channel) => channel.id === value.defaultChannelId) ? value.defaultChannelId : named[0]?.id ?? "";
		const aliases = [...new Set(named.flatMap((channel) => channel.models.map((model) => model.alias)))];
		const defaultModel = typeof value.defaultModel === "string" && aliases.includes(value.defaultModel.trim()) ? value.defaultModel.trim() : "";
		const videoAliases = [...new Set(named.flatMap((channel) => (channel.videoModels ?? []).map((model) => model.alias)))];
		const defaultVideoModel = typeof value.defaultVideoModel === "string" && videoAliases.includes(value.defaultVideoModel.trim()) ? value.defaultVideoModel.trim() : "";
		return {
			enabled: value.enabled ?? DEFAULT_ENABLED,
			announceToAgent: value.announceToAgent ?? DEFAULT_ANNOUNCE,
			allowAgentImageGeneration: value.allowAgentImageGeneration ?? DEFAULT_ALLOW_AGENT_IMAGE_GENERATION,
			allowAgentVideoGeneration: value.allowAgentVideoGeneration ?? true,
			channels: named.map((channel) => ({
				...channel,
				apiKey: typeof secrets[channel.id] === "string" ? secrets[channel.id] : ""
			})),
			defaultChannelId,
			defaultModel,
			defaultVideoModel,
			promptApiUrl: typeof value.promptApiUrl === "string" ? value.promptApiUrl.trim() : "",
			promptApiKey: typeof value.promptApiKey === "string" ? value.promptApiKey.trim() : "",
			promptModel: typeof value.promptModel === "string" ? value.promptModel.trim() : "",
			storage: {
				enabled: value.storageEnabled ?? false,
				endpoint: typeof value.storageEndpoint === "string" ? value.storageEndpoint.trim() : "",
				region: typeof value.storageRegion === "string" ? value.storageRegion.trim() : "",
				accessKey: typeof value.storageAccessKey === "string" ? value.storageAccessKey.trim() : "",
				secretKey: typeof value.storageSecretKey === "string" ? value.storageSecretKey.trim() : "",
				prefix: typeof value.storagePrefix === "string" && value.storagePrefix.trim() !== "" ? value.storagePrefix.trim() : "dsh-imagegen-studio",
				syncGallery: value.storageSyncGallery ?? true,
				syncHistory: value.storageSyncHistory ?? false
			},
			skills: {
				enabled: value.skillsEnabled ?? true,
				allowHeavy: value.allowHeavySkills ?? true,
				allowlist: (value.skillAllowlist ?? "").split(/[\n,]/).map((item) => item.trim()).filter((item) => item !== ""),
				outputDir: typeof value.skillOutputDir === "string" ? value.skillOutputDir.trim() : "",
				heavyTimeoutMs: Math.max(0, Math.round((value.skillHeavyTimeoutMinutes ?? 20) * 6e4)),
				agentPreset: typeof value.skillAgentPreset === "string" ? value.skillAgentPreset.trim() : ""
			},
			skillConfig: {
				values: asConfigDict(value.skillConfig),
				secrets: asConfigDict(value.skillConfigSecrets)
			}
		};
	};
	const channelsView = () => {
		const value = resolve();
		return {
			channels: value.channels,
			defaultChannelId: value.defaultChannelId
		};
	};
	setStorageSyncHandler((kind, filePath) => {
		const storage = resolve().storage;
		if (!storage.enabled || !storage.endpoint.trim() || storage.secretKey.trim() === "") return;
		if (kind === "gallery" && !storage.syncGallery) return;
		if (kind === "history" && !storage.syncHistory) return;
		putObject(storage, `${storage.prefix}/${kind === "gallery" ? "gallery" : "images"}/${path.basename(filePath)}`, readFileSync(filePath), mimeOfPath(filePath)).catch(() => {});
	});
	const subscriptions = new SubscriptionManager(ctx);
	let hostServices;
	const hostChatService = () => createHostChatSeam({
		...hostServices === void 0 ? {} : hostServices,
		cwd: () => process.cwd(),
		preset: () => resolveSkills().agentPreset
	});
	const runtime = new ImageGenerationRuntime(channelsView, void 0, subscriptions, {
		resolveConfig: () => resolvePromptModelConfig(resolve()),
		complete: async (options) => chatComplete(resolvePromptModelConfig(resolve()), options)
	}, {
		available: () => hostChatService().available(),
		label: () => hostChatService().label(),
		complete: async (options) => await hostChatService().complete(options)
	});
	const pendingConversationImages = /* @__PURE__ */ new Map();
	setSkillTranslate((key, params, language) => interpolate(key, params, imageGenLanguageOf(language)));
	let skillRunner;
	const pptRuntime = new PptRuntime(() => imageDataRoot(), async () => {
		return (await skillRunner?.skillDefinition(EDITABLE_PPT_SKILL))?.path;
	});
	const resolveSkills = () => resolve().skills;
	skillRunner = new SkillRunner({
		backend: {
			canvas: canvasStore,
			chat: { complete: async (options) => chatComplete(resolvePromptModelConfig(resolve()), options) }
		},
		enabled: () => resolve().enabled && resolveSkills().enabled,
		heavyEnabled: () => resolveSkills().allowHeavy,
		allowlist: () => resolveSkills().allowlist,
		runRoot: () => resolveSkills().outputDir,
		heavyTimeoutMs: () => resolveSkills().heavyTimeoutMs,
		dataRoot: () => imageDataRoot(),
		pptInstallUrl: knownSkillUrl(EDITABLE_PPT_SKILL),
		pptCommand: () => pptRuntime.command(),
		composer: createClipComposer()
	});
	/** Settings write path, installed by the settings injection further down. */
	let mutateSettings;
	let settingsNamespace = IMAGEGEN_SETTINGS_NAMESPACE;
	/** Entry paths the last library listing resolved, so lookups agree with it. */
	const entryPathByName = /* @__PURE__ */ new Map();
	/** Localize one ignored-declaration reason for the panel. */
	const configIssueText = (language) => (issue) => {
		const t = canvasSkillCopy(language);
		switch (issue) {
			case "unsupported-version": return t("canvas.skills.configIssueVersion");
			case "empty": return t("canvas.skills.configIssueEmpty");
			default: return t("canvas.skills.configIssueUnreadable");
		}
	};
	/** Resolve one skill's values from the live settings dictionaries. */
	const skillValues = (name, declaration) => valuesFor(declaration, resolve().skillConfig, name);
	/**
	* The library entry path for one skill: the last listing's answer when it has
	* one, else a direct disk read — so a config lookup and the panel agree.
	*/
	const entryPathFor = async (name) => {
		const known = entryPathByName.get(name);
		if (known !== void 0) return known;
		return (await readLocalSkill(skillsRoot(), name).catch(() => void 0))?.path;
	};
	/** Look up a declaration by skill name, reading its path from disk. */
	const declarationByName = async (name) => {
		const entryPath = await entryPathFor(name);
		return await readCanvasSkillConfig({
			name,
			...entryPath === void 0 ? {} : { entryPath },
			root: skillsRoot(),
			store: resolve().skillConfig
		});
	};
	/** The directory a `command` step runs in by default (created on demand). */
	const configRunRoot = (name) => {
		const configured = resolveSkills().outputDir.trim();
		const root = configured === "" ? path.join(imageDataRoot(), "canvas", "runs") : configured;
		return path.join(root, "skill-config", name);
	};
	let skillRegistryNames;
	/** One entry's "why the node menu cannot offer this" line, in caller copy. */
	const issueText = (language) => (issue, name) => {
		const t = canvasSkillCopy(language);
		switch (issue) {
			case "no-frontmatter": return t("canvas.skills.libraryIssueFrontmatter");
			case "bad-name": return t("canvas.skills.libraryIssueName", { name });
			case "no-description": return t("canvas.skills.libraryIssueDescription");
			case "bad-invocation": return t("canvas.skills.libraryIssueInvocation");
			default: return t("canvas.skills.libraryIssueUserOnly");
		}
	};
	const snapshotLibrary = async (language) => {
		const library = await listLibrary({
			root: skillsRoot(),
			...skillRegistryNames === void 0 ? {} : { known: skillRegistryNames },
			networkAvailable: true,
			issueText: issueText(language)
		});
		const store = resolve().skillConfig;
		const entries = await Promise.all(library.entries.map(async (entry) => {
			if (entry.path !== void 0) entryPathByName.set(entry.name, entry.path);
			const found = await readCanvasSkillConfig({
				name: entry.name,
				...entry.path === void 0 ? {} : { entryPath: entry.path },
				root: skillsRoot(),
				store,
				issueText: configIssueText(language)
			});
			return found.view === void 0 ? entry : {
				...entry,
				config: found.view
			};
		}));
		return {
			...library,
			entries
		};
	};
	/** Merge one save request into both dictionaries and write them back. */
	const saveSkillValues = async (name, declaration, edits) => {
		if (mutateSettings === void 0) throw new SkillStoreError(canvasSkillCopy()("canvas.skills.configUnwritable"));
		const store = resolve().skillConfig;
		const next = {
			values: { ...store.values },
			secrets: { ...store.secrets }
		};
		const byId = new Map(declaration.manifest.fields.map((field) => [field.id, field]));
		for (const edit of edits) {
			const field = byId.get(edit.id);
			if (field === void 0) continue;
			const key = skillConfigKey(name, field.id);
			const dict = field.type === "secret" ? next.secrets : next.values;
			if (edit.value.trim() === "") delete dict[key];
			else dict[key] = edit.value;
		}
		await mutateSettings([{
			op: "set",
			path: ["skillConfig"],
			value: next.values
		}, {
			op: "set",
			path: ["skillConfigSecrets"],
			value: next.secrets
		}]);
	};
	const skillLibrary = {
		list: async (options) => await snapshotLibrary(options?.language),
		install: async (request) => {
			const root = skillsRoot();
			const installed = [];
			const failed = [];
			let message;
			if (request.asset !== void 0) try {
				const blob = (await canvasStore.readAssets([request.asset])).get(request.asset.assetId);
				if (blob === void 0) throw new SkillStoreError("上传的压缩包已失效，请重新上传");
				installed.push(await installFromArchive(blob.data, root, request.name ?? "skill", request.force === true));
			} catch (error) {
				message = messageOf(error);
			}
			for (const source of request.sources ?? []) try {
				installed.push(await installFromUrl(source, root, {
					force: request.force === true,
					fallbackName: request.name
				}));
			} catch (error) {
				failed.push({
					source,
					message: messageOf(error)
				});
			}
			return {
				ok: installed.length > 0,
				installed,
				failed,
				library: await snapshotLibrary(request.language),
				...message === void 0 ? {} : { message }
			};
		},
		remove: async (name, options) => {
			try {
				const removed = await removeSkill(name, skillsRoot());
				return {
					ok: true,
					library: await snapshotLibrary(options?.language),
					message: removed
				};
			} catch (error) {
				return {
					ok: false,
					library: await snapshotLibrary(options?.language),
					message: messageOf(error)
				};
			}
		},
		configSave: async (request) => {
			try {
				const found = await declarationByName(request.name);
				if (found.declaration === void 0) throw new SkillStoreError(configIssueText(request.language)(found.issue ?? "empty"));
				await saveSkillValues(request.name, found.declaration, request.values ?? []);
				return {
					ok: true,
					library: await snapshotLibrary(request.language)
				};
			} catch (error) {
				return {
					ok: false,
					library: await snapshotLibrary(request.language),
					message: messageOf(error)
				};
			}
		},
		configApply: async (request) => {
			const library = async () => await snapshotLibrary(request.language);
			try {
				const found = await declarationByName(request.name);
				if (found.declaration === void 0) throw new SkillStoreError(configIssueText(request.language)(found.issue ?? "empty"));
				const values = skillValues(request.name, found.declaration);
				const runRoot = configRunRoot(request.name);
				await mkdir(runRoot, { recursive: true });
				const skillDir = bundleDirOf((await readLocalSkill(skillsRoot(), request.name).catch(() => void 0))?.path);
				const results = await applySkillConfigSteps(found.declaration, values, {
					runRoot,
					...skillDir === void 0 ? {} : { skillDir }
				});
				return {
					ok: results.every((result) => result.ok),
					library: await library(),
					steps: results.map((result) => ({
						kind: result.step.kind,
						detail: result.detail,
						ok: result.ok,
						...result.output === void 0 ? {} : { output: result.output }
					}))
				};
			} catch (error) {
				return {
					ok: false,
					library: await library(),
					steps: [],
					message: messageOf(error)
				};
			}
		}
	};
	ctx.inject(["skills", "agents"], (sctx) => {
		const services = sctx;
		hostServices = {
			agents: services.agents,
			presets: sctx.get("agentPresets"),
			defaultModel: sctx.get("agentDefaultModel")
		};
		sctx.effect(() => {
			const registry = createSkillRegistryBackend(services.skills, { root: skillsRoot });
			registry.list().then((listed) => {
				skillRegistryNames = listed.map((item) => ({
					name: item.name,
					...item.path === void 0 ? {} : { path: item.path }
				}));
			}, () => {
				skillRegistryNames = [];
			});
			const presets = sctx.get("agentPresets");
			const defaultModel = sctx.get("agentDefaultModel");
			skillRunner?.attach({
				registry,
				agents: {
					available: () => services.agents !== void 0,
					create: async (options) => await createCanvasSkillAgent({
						agents: services.agents,
						...presets === void 0 ? {} : { presets },
						...defaultModel === void 0 ? {} : { defaultModel },
						agentPreset: resolveSkills().agentPreset,
						sessionId: options.sessionId,
						cwd: options.cwd,
						systemPrompt: options.systemPrompt,
						...options.signal === void 0 ? {} : { signal: options.signal },
						fail: options.fail
					})
				},
				skillConfig: {
					missing: async (names) => {
						const out = /* @__PURE__ */ new Map();
						for (const name of names) {
							const found = await declarationByName(name);
							if (found.declaration === void 0) continue;
							const missing = missingFields(found.declaration, skillValues(name, found.declaration));
							if (missing.length > 0) out.set(name, missing);
						}
						return out;
					},
					note: async (name) => {
						const found = await declarationByName(name);
						if (found.declaration === void 0) return void 0;
						return configNote(found.declaration, skillValues(name, found.declaration));
					}
				}
			});
			return () => {
				skillRunner?.attach({});
				hostServices = void 0;
			};
		}, "dsh-imagegen-studio: canvas skills");
	});
	ctx.inject(["settings", "attachments"], (sctx) => {
		const seam = sctx.get("settings");
		settingsNamespace = resolveSettingsNamespaceCompat(ctx, seam, ImageGenSettingsNamespace);
		mutateSettings = async (ops) => {
			await seam.mutate(settingsNamespace, ops);
		};
		/**
		* Append models the studio discovered to a channel's catalogue. The settings
		* document is the only home a channel has, so "adopt this model" cannot mean
		* anything else — and the write goes back through `normalizeChannels`, which
		* keeps channel objects key-free (keys live in `channelSecrets`, and a
		* whole-array write must never carry them).
		* @param channelId - channel to extend.
		* @param kind - which catalogue (image or video).
		* @param models - discovered models to add; duplicates are ignored.
		* @returns an error message, or undefined when the write was accepted.
		*/
		const adoptChannelModels = async (channelId, kind, models) => {
			const value = resolve();
			const channel = value.channels.find((entry) => entry.id === channelId);
			if (channel === void 0) return "找不到该渠道：先在「设置 → 生图配置」里保存一次";
			const current = kind === "video" ? channel.videoModels ?? [] : channel.models;
			const known = new Set(current.map((entry) => entry.id));
			const added = models.filter((entry) => !known.has(entry.id)).map((entry) => ({
				alias: entry.alias,
				id: entry.id
			}));
			if (added.length === 0) return void 0;
			const next = normalizeChannels(value.channels.map((entry) => entry.id === channelId ? {
				...entry,
				...kind === "video" ? { videoModels: [...current, ...added] } : { models: [...current, ...added] }
			} : entry));
			await mutateSettings?.([{
				op: "set",
				path: ["channels"],
				value: next
			}]);
		};
		sctx.effect(() => {
			const disposers = [...makeRoutes({
				settings: seam,
				settingsNamespace,
				resolve: () => {
					const value = resolve();
					const channel = value.channels.find((candidate) => candidate.id === value.defaultChannelId) ?? value.channels[0];
					return {
						apiUrl: channel?.apiUrl ?? "",
						apiKey: channel?.apiKey ?? ""
					};
				},
				resolveChannels: channelsView,
				resolvePrompt: () => resolvePromptModelConfig(resolve()),
				resolveImageModels: () => {
					const value = resolve();
					return [...new Set(value.channels.flatMap((channel) => channel.models.map((model) => model.alias)))];
				},
				attachments: sctx.attachments,
				pendingConversationImages,
				runtime,
				subscriptions,
				resolveStorage: () => resolve().storage,
				skills: skillRunner,
				pptRuntime,
				skillLibrary
			}), ...makeStudioRoutes({
				channels: () => resolve().channels,
				adoptModels: adoptChannelModels
			})].map((route) => ctx.webServer.register(route));
			const TEMPLATE_SYNC_INITIAL_DELAY_MS = 3e4;
			const TEMPLATE_SYNC_INTERVAL_MS = 720 * 60 * 1e3;
			let syncTimer;
			const runSync = () => {
				if (!resolve().enabled) return;
				syncAllTemplates().catch(() => {});
			};
			const startTimer = setTimeout(runSync, TEMPLATE_SYNC_INITIAL_DELAY_MS);
			syncTimer = setInterval(runSync, TEMPLATE_SYNC_INTERVAL_MS);
			syncTimer.unref?.();
			return () => {
				clearTimeout(startTimer);
				clearInterval(syncTimer);
				for (const dispose of disposers) dispose();
			};
		}, "dsh-imagegen-studio: routes");
	});
	ctx.inject([
		"tools",
		"attachments",
		"commands"
	], (tctx) => {
		tctx.effect(() => {
			const resolveAgentConfig = () => {
				const value = resolve();
				return {
					enabled: value.enabled,
					allowAgentImageGeneration: value.allowAgentImageGeneration,
					channels: value.channels,
					defaultChannelId: value.defaultChannelId,
					defaultModel: value.defaultModel
				};
			};
			const resolveVideoToolConfig = () => {
				const value = resolve();
				return {
					enabled: value.enabled,
					allowAgentVideoGeneration: value.allowAgentVideoGeneration,
					channels: value.channels,
					defaultChannelId: value.defaultChannelId,
					defaultVideoModel: value.defaultVideoModel
				};
			};
			const disposeTools = registerAgentImageTools(tctx, runtime, resolveAgentConfig);
			const disposeVideoTools = registerAgentVideoTools(tctx, runtime, resolveVideoToolConfig);
			const disposeCommand = registerEditImageCommand(tctx, runtime, resolveAgentConfig, {
				get: (sessionId) => pendingConversationImages.get(sessionId),
				consume: (sessionId, ref) => {
					if (pendingConversationImages.get(sessionId)?.attachmentId === ref.attachmentId) pendingConversationImages.delete(sessionId);
				}
			});
			return () => {
				disposeCommand();
				disposeVideoTools();
				disposeTools();
			};
		}, "dsh-imagegen-studio: agent image tools and commands");
	});
	let disposeSection;
	const sync = () => {
		if (disposeSection !== void 0) {
			disposeSection();
			disposeSection = void 0;
		}
		const value = resolve();
		if (!value.enabled || !value.announceToAgent) return;
		disposeSection = ctx.systemPrompt.section({
			name: "plugin:dsh-imagegen-studio",
			order: SECTION_ORDER,
			text: guidanceFor(value.channels, value.defaultChannelId, value.defaultModel, value.defaultVideoModel)
		});
	};
	installSettingsSectionCompat(ctx, ImageGenSettingsNamespace, Config, unwrapConfig(config), {
		setSource: (source) => {
			current = source;
			sync();
		},
		onChange: sync
	});
	sync();
	return () => {
		setStorageSyncHandler(void 0);
	};
}
//#endregion
export { AGENT_VIDEO_TOOL_NAMES, CURRENT_VERSION, CodeRenderError, Config, DEFAULT_RENDER_TIMEOUT_MS, DEFAULT_VIDEO_MODELS, DESKTOP_PROFILE, DIAGNOSTIC_MAX, EDITABLE_PPT_SKILL, GALLERY_TRASH_RETENTION_MS, IMAGEGEN_GUIDANCE, ImageGenError, ImageGenSettingsNamespace, ImageGenerationRuntime, KNOWN_SKILL_SOURCES, MAX_CANVAS_FILE_BYTES, MAX_CODE_CHARS, MAX_EXTRACTED_CHARS, MAX_LAYER_IMAGE_BYTES, MAX_PLANNED_PROMPT_CHARS, MAX_PREVIEW_CHARS, MAX_PROMPT_CHARS, MAX_SKILL_ARCHIVE_BYTES, ManualUpdateRequiredError, PACKAGE_NAME, SkillRunner, SkillStoreError, SubscriptionManager, VIDEO_HISTORY_MAX, VideoGenError, VideoPlanError, VideoTaskQueue, addTemplateFavorite, agentSessionFailure, analyzeLayers, appendGallery, appendGalleryVideo, appendVideoHistory, apply, applyPlan, applySkillConfigSteps, buildFilePreview, builtinCanvasSkills, canvasSkillCatalog, canvasSkillCopy, canvasStore, checkForUpdate, classifySource, clearDiagnostics, clearGallery, clearTemplateFavoritesMemo, clearTemplateMemo, clearUpdateCache, clearVideoHistory, codeRenderPlan, codeRenderSystemPrompt, codeRenderUserPrompt, compareVersions, configNote, configView, createCanvasSkillAgent, createClipComposer, createHostChatSeam, createSkillRegistryBackend, describeVideoModel, dimensionsFor, extractFileText, extractRenderSource, fallbackRendererSource, fileKindOf, findCanvasSkill, generateImage, generateVideo, hasMotion, inject, inspectSkillMarkdown, installFromArchive, installFromUrl, installUpdate, installableSkillName, isBlockedFileName, isDshSkillName, isEditablePptSkill, isInstallableTarballUrl, isValidSkillName, isVideoModel, isZipDirectory, knownSkillUrl, latestSessionImage, listDiagnostics, listGallery, listGalleryTrash, listLibrary, listLocalSkills, listTemplateFavorites, listTemplates, listVideoHistory, localVideoToolDirs, locateFfmpeg, looksChinese, looksLikeCode, makeRoutes, mergeExternalSkills, mimeFromFileName, missingFields, name, networkErrorFields, normalizeLayerPlan, normalizeVideoResolution, parsePlanAnswer, parseSkillConfigManifest, parseSkillFrontmatter, planVideo, planVideoLocally, probeCodeRender, profileFromProcess, promptCharLimit, purgeGallery, putObject, readCanvasSkillConfig, readGalleryImage, readGalleryVideo, readGeneratedCode, readLocalSkill, readSkillConfigFile, readTemplateImage, readVideoFile, readZipDirectory, readZipEntry, recipeFor, recipeNames, recordDiagnostic, redactDiagnosticText, refreshTemplates, registerAgentImageTools, registerAgentVideoTools, registerEditImageCommand, removeGallery, removeSkill, removeTemplateFavorite, removeVideoHistory, renderCode, requirePrompt, resolveAgentImageModel, resolveAgentVideoModel, resolveConfigTarget, resolvePromptModelConfig, resolveVideoModelId, restoreGallery, runCodeRender, safeFileName, sampleTemplates, setSkillLanguage, setSkillTranslate, setStorageSyncHandler, skillConfigKey, skillsRoot, subscriptionOauthRef, syncAllTemplates, testStorage, tierOfExternalSkill, updateGalleryTags, updateInstallTarget, validateCodeInput, valuesFor, vendorOf };
