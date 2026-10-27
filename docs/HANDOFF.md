# 交接说明（新会话从这里接手）

> 本文件是给下一位接手者的**当前状态快照**，不是需求文档。读完它应当能直接改代码，不必回看历史对话。

## 0. 一句话现状

`dsh-imagegen-video` 的 fork（`dsh-imagegen-studio`）已经能跑：普通生图会话页、素材库、无限画布、每模型自由参数引擎、设置里的模型参数块都已落地并部署。
**当前唯一明确要返工的是「设置 → 生图配置」的模型参数区**：它没有按"原版基础上二开"的路子做，而是把一张内置模板表直接铺开，与"通道未配置"互相矛盾。

## 1. 用户的核心原则（每条返工都以它为准）

1. **在原版基础上二开**，不是重写。用户没点名要改的地方，必须尽可能保留原功能。
2. **不要代码里写死模型信息**。模型、参数、字段一律是数据，由用户配。
3. 单模型的参数配置应当是**点开某个模型才出现的面板**，不是整页铺开的一堆卡片。

## 2. 要修的 bug（用户原话复述）

> 生图配置面板里，渠道显示"未配置"，为什么模型参数里却有 2 个模板 21 个模型？？而且我要的单个模型的配置面板，也不是现在这样。应该是这个生图配置面板完全遵循之前的设计，只不过在每个模型上，添加点击打开其参数配置面板的设计。也就是说当前的模型参数出现的莫名其妙，并没有在原版基础上融合好，可能是在代码里写死的一些模型信息。

### 根因（已经定位，不是猜）

- `src/studio/model-presets.ts` 是一张**种子表**（文件头注释写着"only a starting point"），导出 `imageModelPresets` / `videoModelPresets`，预置了若干图片/视频模型的字段形状。
- `src/client/StudioChannels.tsx`（734 行，导出 `StudioModelParams`）在设置页里**无条件渲染**了这两张表。它跟"通道有没有配置"毫无关系——所以出现"渠道未配置，但模型参数里有 2 个模板 21 个模型"。
- 这些模型不属于任何通道，也就无法生成；用户看到的是一堆悬空配置。

### 修法方向

1. **模型必须挂在通道下面**：一个通道 = 一个 endpoint + 一张它自己的模型表。通道没配，模型区就是空的（或只显示"先添加通道"）。
2. 设置页保持原版结构（`src/client/SettingsCard.tsx`，1989 行，不要重排它），只在**每条通道的模型列表**里，给每个模型加一个"点开配置"的入口，点开是**该模型的字段面板**（单模型单面板，抽屉或弹层）。
3. `model-presets.ts` 降级为**可选动作**：新增模型时提供"从模板填充"，填完即可编辑，绝不自动铺满页面。
4. 删掉/改造 `StudioModelParams` 里那段无条件渲染；`SettingsCard.tsx` 目前 import 它（`import { StudioModelParams } from './StudioChannels.tsx'`），改完要同步改调用点。

## 3. 工程约定（照做能省很多时间）

| 事项 | 做法 |
|---|---|
| 仓库 | `C:\Users\Administrator\Documents\dsh-imagegen-studio` |
| 改源码 | **必须用 Node 脚本** `fs.readFileSync/writeFileSync(..., 'utf8')`。用 PowerShell here-string 直接写 `.tsx` 会打翻中文编码（曾发生过一次，靠 `lib\client.js.map` 的 `sourcesContent` 才恢复） |
| 类型检查 | `pnpm typecheck`（= `tsc --noEmit`），必须干净 |
| 构建 | `pnpm build`（产物 `lib\client.js`） |
| 部署 | `node scripts/studio/deploy-live.mjs`，同步到 `...\harness\profiles\.generations\live\dsh-imagegen-studio+1.16.0+<hash>\` |
| 生效 | **必须整窗重启 DSH**。HMR 会让新旧模块混跑，热更新后的现象不可信 |
| 数据目录 | `C:\Users\Administrator\AppData\Roaming\dsh-desktop\harness\dsh-imagegen-studio\studio\`（`adapters.json` 通道与模型、`out\` 产出与 `stall.log`、会话/画布/素材库都在这一层下面） |

## 4. 关键模块地图

**宿主（`src/studio/`）**

- `param-schema.ts` — 参数字段模型：`kind: enum | int | text | bool`、`omitWhenDefault`、`options`。所有"字段自由"能力都从这里长出来。
- `adapter-spec.ts` — `AdapterProfile` / `AdapterModelSpec`（通道与模型的数据形状）。
- `store.ts` — 读写 `adapters.json`（`studioRoot()` = `<数据目录>\studio`）。
- `routes.ts` — 宿主路由 `/api/dsh-imagegen-studio/studio/*`（adapters / model / preview / generate / tasks / diag …）。
- `model-presets.ts` — **种子表**，见上文，需要降级为"可选模板"。
- `engine` — 按 `AdapterModelSpec` 拼请求体、发请求、轮询；不同网关字段差异全部由数据描述，不写死。

**前端（`src/client/`）**

- `StudioWorkspace.tsx` — 普通生图会话页（会话、＋素材五源、参数胶囊 `PillSelect`、生成确认）。
- `CanvasWorkspace.tsx` — 无限画布（节点、连线、右键菜单、任务轮询）。
- `GalleryWorkspace` / 素材库、`TemplateLibrary.tsx` — 模板库（弹层已 `anchor` 到工作区，避免遮住宿主标题栏）。
- `ImageGenPanel.tsx` — 面板壳：三个标签、左侧会话列表、右侧栏已删。
- `SettingsCard.tsx` — **原版生图配置页**（改动要克制）。
- `StudioChannels.tsx` — 当前的模型参数块（要返工的就是它）。
- `studio-bridge.ts` — 画布 → 普通生图的传递通道。
- `stall-watch.ts` — 卡顿探针（见第 6 节）。

## 5. 已完成、勿回退

- 三个标签：普通生图 / 素材库 / 无限画布；右侧历史栏与右上"对话 / 未连接"控件已移除。
- 参数全部为"标签 + 自绘下拉胶囊"，一行排布，不再用"更多 N"折叠、不再用 portal。
- ＋素材五个来源：本地图片 / 素材库 / 历史记录 / AI 生成 / 添加视频；请求按 `images` `videos` `audios` 分流。
- 画布 → 普通生图：节点右键"送到普通生图"。
- 模板库遮罩只覆盖工作区（`anchor`），不盖住宿主窗口按钮。
- 侧边栏历史面板只挂一个（多处 anchor 时 prune 掉旧的）。

## 6. 已知环境问题：整个软件会卡死

- 现象：界面冻住，但宿主与工具执行继续跑，重启后对话内容都在 → 卡的是**渲染进程**。
- 实测当前会话文件解压后 **13.5 MB / 3109 帧**（约三千条消息）。结论倾向"会话太大 + 对话页全量重渲染"，与插件无关（面板激活时对话树是 `display:none`，插件不订阅 token）。
- 待验证：新会话里跑同样重的活是否还卡。
- 诊断通道已就绪：`src/client/stall-watch.ts` 每 400ms 写 `localStorage` 面包屑（含 `action` / `workspace`），上次启动若判定为"卡死后被强杀"，会 POST 到 `/api/dsh-imagegen-studio/studio/diag`；`PerformanceObserver('longtask')` 记录 >3s 的长任务。落盘位置 `...\studio\out\stall.log`（此前缺 mkdir 一直写不出来，已修）。

## 7. 待办（按优先级）

1. **返工设置页模型参数**（本文第 2 节）：模型挂到通道下；单模型点开配置；预置表降级为"从模板填充"；保持 `SettingsCard.tsx` 原结构。
2. 验收：画布与普通生图 / 素材库的双向打通（画布的 AI 生成结果回填普通生图素材区尚未实现）。
3. 新会话里验证卡死是否消失。

## 8. 用户当下要的一句话

> 我要的是在原版基础上二开：我没提出要改的地方，肯定是尽可能继承原功能的。

改动前先问自己：这一处用户点名要改吗？没点名，就保持原样。

## 9. 返工记录：设置页模型参数（已完成，待整窗重启验证）

### 9.1 根因（比第 2 节最初的判断更准确）

- 「2 个模板 21 个模型」**不是** `StudioChannels.tsx` 直接渲染 `model-presets.ts`：是 `src/studio/store.ts` 的 `ensureAdapters()` 在 `adapters.json` 不存在（或为空）时，把 `defaultAdapters()`（`mmg-image` 11 个模型 + `mmg-video` 10 个模型）写了进去。设置页里那段块只是把 `adapters.json` 的内容原样铺开，于是看起来像"已经配好的模型"。
- 现在 `ensureAdapters()` / `defaultAdapters()` / `OPENAI_FIELDS` 已从 `store.ts` 删除；`adapters.json` 只剩"覆盖层"职责。

### 9.2 新的数据流（后续都按这个来）

- **渠道**（设置文档的 `channels` + `channelSecrets`）决定：地址、密钥、有哪些模型（图片 `models`、视频 `videoModels`）。
- **`adapters.json` 覆盖层**只存渠道表达不了的东西：`submit` / `poll` / `result` / `fields` / `auth` 样式，以及每个模型的参数表、画幅、清晰度、时长、参考图上限、价格备注。
- **派生**全部在 `src/studio/channel-adapters.ts`（纯模块，宿主与浏览器共用同一套函数）：
  - 派生 id：图片 = `channel.id`，视频 = `channel.id + '#video'`（`channelAdapterId` / `splitChannelAdapterId`）。
  - 渠道没配 → 一个 adapter 都没有 → 设置页不再出现模型参数区，工作台显示既有的"还没有通道…"空状态。
  - 密钥永远来自 `channelSecrets`，只在宿主侧注入（`deriveChannelAdapters(channels, stored, keyOf)`），浏览器只拿到 `maskProfile` 的 masked 值。
  - 地址沿用原版语义：`apiUrl` 是 base，追加 `images/generations` / `videos`；`apiUrlFull` 时该 URL 就是提交地址，base 由它反推（与 `video-engine.ts` 的 `statusUrlFor` 同一套规则）。
  - 渠道目录说了算：渠道里删掉一个模型，工作台里跟着消失；覆盖层里对不上的模型记录会被忽略。

### 9.3 改动清单

- 新增 `src/studio/channel-adapters.ts`。
- `src/studio/store.ts`：删掉种子与 `ensureAdapters`；`saveAdapter(raw, { forgetToken })`。
- `src/studio/routes.ts`：`makeStudioRoutes(deps)`（注入 `channels` / `adoptModels`）；所有 `ensureAdapters()` 换成 `resolveAdapters()`（渠道 + 覆盖层）；POST adapter 保存前清空 `auth.token` 并 `forgetToken`；新增 `STUDIO_API.adopt` 路由。
- `src/index.ts`：注入 `channels: () => resolve().channels` 与 `adoptModels`（用 `normalizeChannels` 白名单写回设置文档的 `channels`，密钥不进数组）。
- `src/client/StudioChannels.tsx`：整体重写为 `ModelParamsDrawer`（单模型抽屉）；`StudioChannels` / `StudioModelParams` 已删。
- `src/client/SettingsCard.tsx`：删掉 `{/* 模型参数… */} <StudioModelParams />`；图片/视频模型行各加一个「参数」按钮（在 `.modelRowActions` 内、编辑按钮之前），点开只传这一个模型；其余原版结构未动。
- `src/client/StudioWorkspace.tsx`：发现模型后的"采用"改走 `adoptModels`（写进渠道目录），不再往 adapter 里塞模型。
- `src/client/studio-channels.module.css`：新增 `.drawer` 系列（内容区自己滚动，修掉旧对话框长表单被裁的问题）。
- `src/client/locales.ts`：新增 `channels.params`（中/英/俄）。

### 9.4 验收点（整窗重启后照这个过一遍）

1. 没有任何渠道时：设置 → 生图配置 里不再有"X 个模板 · Y 个模型"，模型参数区完全不存在。
2. 新建一个渠道（例如照抄 `cordis.patch.yml` 里那条「自用」：`https://api.yeshanli.com/v1` + 4 个图片模型 + 1 个视频模型），保存后普通生图 / 无限画布的通道列表出现 `自用` 与 `自用 · 视频`。
3. 该渠道每个模型行尾部都有「参数」按钮；点开只显示这一个模型的字段；保存后重开仍在（落在 `adapters.json` 覆盖层）。
4. 渠道里删掉一个模型 → 工作台里跟着消失。
5. 抽屉里的「从模板填充」能把内置模板（如 `nano-banana-pro · 1K`）的字段填进当前模型且可编辑。

另注：`adapters.json` 里那两个 mmg 种子记录在新代码下不会被派生（id 对不上任何渠道），可以删；建议**整窗重启之后**再删，因为旧构建还活着时会再次播种。

## 10. 启动冻结（2026-10-24 修复）

现象：启用插件后 DSH 打开卡在「正在读取本地工作台」，渲染进程完全无响应（CDP `Runtime.evaluate` 超时）。

定位：把 `lib/client.js` 的 `apply` 分段短路，配合隔离 profile 逐段启动，锁定在 `mountSidebarEntry` 的 DOM 自愈逻辑：
- `tabs.dataset.dshImagegenSessionTabs` 生成的是 `data-dsh-imagegen-session-tabs`，而 `ENTRY_SELECTOR` 查的是 `data-dsh-imagegen-studio-session-tabs`；`historyHost`、`sessionTab` 同样少了 `studio-` 段。
  → 自愈永远找不到自己插入的节点，每趟都新建一份；整篇 `document.body` 的 MutationObserver 又在写入时被同步触发，形成「插入 → 观察 → 再插入」的同步死循环。
- 历史记录 host 被塞进 React 托管的 `regionArea`，React 每次重排都会把它删掉，微任务调度的补插会饿死主线程（任务队列排不进来，页面看似死机）。

修复（`src/client/sidebar-entry.ts`）：
1. 所有标记位改成 `setAttribute('data-dsh-imagegen-studio-…')`，与选择器严格一致（`tabs` / `tab` / `history-host` / `sidebar-root`）；`mount.tsx` 的 `view`、`chat-resizer` 与 `ImageGenPanel` 的 `chat-collapsed` 同样修正（CSS 一直按 `studio-` 写）。
2. `placeTabs` 命中已有节点就复用/搬移，不再重建。
3. MutationObserver 回调只排程不写 DOM；补插改为 `setTimeout(0)` 宏任务，并用 `takeRecords()` 丢掉自己写入产生的记录。
4. 自愈限速：1 秒内超过 40 趟就断开观察者并告警；历史记录 host 对同一 `regionArea` 最多补插 2 次，超过就放弃并告警（React 托管的列表不再硬抢）。

验证：`_livehome`（真 config + 真渠道）与 `_livecheck`（原样拷贝的 live profile）都一次启动成功，`[data-dsh-imagegen-studio-session-tabs]` = 1、`[data-dsh-imagegen-studio-history-host]` = 1、`[data-dsh-imagegen-studio-view]` = 1，点「生图」标签后历史、普通生图/素材库/无限画布、渠道 `自用` 与 4 个模型全部就位。

启用配置（已写入 live profile）：`package.json` 加 `"dsh-imagegen-studio": "link:./vendor/dsh-imagegen-studio"` 与 `dsh.profile.bundles` 追加同名包；`cordis.patch.yml` 里旧行 `- id: imagegen / name: "@q253595422/dsh-imagegen-video"` 改名为 `imagegen-studio` / `dsh-imagegen-studio`（渠道、密钥结构不动，只去掉这一行的 `disabled: true`）。

## 11. 能力上限 ↔ 上游字段名打通（1.16.1）

问题：抽屉上半部「时长 / 清晰度 / 画幅 / 参考图上限」只是**能力声明**，真正发出去的字段名写在
参数表的 `role + name` 里，两者之间没有任何约束，于是：
- 同一个旋钮被写两次 —— 参数行把"清晰度"映射成 `quality`，引擎又按默认映射写一个
  `resolution`，严格校验 body 的网关直接拒；
- 「清晰度顶到 4k，上游只认 1k/2k」只能靠 option 列表兜，档位差一位就白跑一次；
- `fields` 表达不了「这个参数根本不发」：删键会被上层默认值补回来，写空串被当成"未提供"。

改动：
1. `src/studio/adapter-engine.ts` `applyRoleNames()`：参数行声明角色后，标准字段映射改指向它自己的
   `name`；`target` 不是 `body` 时那一路写成 `null`（不发），不再猜它该去哪个位置。
2. `src/studio/adapter-spec.ts`：`FieldName = string | null`；`resolveFields` 让 `null` 穿过
   所有下层（空串仍是"未提供"）。
3. `src/studio/store.ts` `normalizeFields`：`null` 原样落盘；`model.fieldOverrides` 同样走它。
4. `src/client/StudioChannels.tsx`：高级区新增 14 行**字段名表**（留空 = 默认名 / 填写 = 自定义名 /
   勾「不发」= 显式关闭）+「图片编码方式」下拉 + 底部「预览请求」；每行标出哪个参数行正在接管它。
5. `src/studio/routes.ts` 的预览接口接受**未保存**的 `adapter` 草稿（与 discover 一致），
   `omitted` 一并回给抽屉。

验证（都已在本机跑过）：
- `npm run typecheck` 通过。
- 引擎隔离用例（用 `rolldown` 单独打包 `adapter-engine.ts` 后直接调用）：role 名优先且不双写、
  `size: null` 不发并进 `omitted`、query 目标不进 body、无 role 时仍发 OpenAI 词表 —— 4 条全过。
- `node scripts/verify-ui-contracts.mjs`（需 `CHROME_HEADLESS_SHELL`）全绿 24 项，含堆叠刻度 35 级无冲突。
- `npm run build` 连跑两次，`lib/index.js` 与 `lib/client.js` 哈希一致。

回归注意：`fields` 里出现 `null` 是**新能力**，旧 `adapters.json` 不受影响；以前靠"留空"表示不发
的写法行为不变（空串仍被忽略）。

## 12. 历史归档 / 素材库分类 / 对话删除（1.16.2）

用户原话（2026-10-24）：「生图面板左侧历史记录这几个字右侧的俩图标…点击也没反应，是否可以去掉。
素材库…能不能实现自定义分类？就是实现分类的添删改。历史记录也没有删除记录的按钮？最起码不应该和
会话一样，有归档功能吗，就是同样的地方，不应该使用同样逻辑吗，毕竟是一个软件里」。

1. **历史归档**（`src/history-store.ts`）：`StoredEntry.archived?: boolean`，`listHistory()` 只回
   未归档的，新增 `listArchivedHistory()` 与 `setHistoryArchived(id, archived)`（未知 id 是 no-op；
   取消归档时写 `archived: undefined`，JSON.stringify 会丢掉这个键，索引对旧版本仍是原样）。
   宿主路由 `HISTORY_API.archive` / `HISTORY_API.archived`，客户端 `api.archiveHistory` /
   `api.listArchivedHistory`。入口在历史小标题右侧的「已归档」开关与每行的归档按钮。
2. **删掉小标题右侧两个图标**：「新建对话」（`data-history-new`）和「打开数据目录」
   （`data-history-open-folder`）。前者已经被顶部导航的「新建」覆盖，后者和列表无关；两个都留在
   那里只会让人点了没反应。腾出的位置给「已归档」。
3. **素材库自定义分类**（`src/gallery-store.ts`）：分类本来就是条目上的 `tags`，`categories.json`
   只是"置顶的空架子"。新增 `createGalleryCategory` / `renameGalleryCategory`（同时改写所有条目上
   的旧标签）/ `deleteGalleryCategory`（只摘标签，图片不动）/ `listGalleryCategories`；重命名落到
   已存在的名字就合并。宿主路由 `GALLERY_API.category`（GET 列、POST create/rename/delete），
   客户端 `api.galleryCategory()`，UI 是筛选栏右侧的「管理分类」。
4. **画布对话可删**：`StudioWorkspace` 监听 `dsh-imagegen-studio:studio-delete` 事件，
   历史列表里的画布对话每行多一个删除按钮；删的是那一页对话记录，不是画布节点。
5. **store 端到端用例**（`node scripts/verify-stores.mjs`，已挂进 `npm test` 链）：归档往返、
   归档后仍可删、索引不留 `archived:false`、分类新建去重 / 重命名改标签 / 合并同名 /
   删除只摘标签。20 条断言全过；Node < 22 会打印 SKIP 块退出 0（是缺运行时，不是回归）。

验证：`npm run typecheck`、`npx tsdown`（`lib/index.js` 862.88 kB / `lib/client.js` 2.73 MB）、
`node scripts/verify-ui-contracts.mjs`（`CHROME_HEADLESS_SHELL` 指向本机 Chrome）24 项全绿。

环境坑（本机）：`node scripts/smoke.mjs` 跑不起来——它 import 的 `@deepseek-ai/dsh-tools`
缺 `@deepseek-ai/dsh-scope`，是**本机没装宿主依赖**，不是回归；store 用例绕开了这一层，
直接用 Node 24 的类型剥离跑源码。

## 13. 筛选栏重做 / 挂载健壮性 / 冒烟套件转绿（1.16.3–1.16.5）

1. **素材库筛选栏三段化（1.16.3）**：截图里的自相矛盾是同一列里同时塞了「来源（全部素材/
   文生图/图生图）」和模型名，标题却叫「分类」，下面又问「还没有分类」。现在分三段——
   来源（只放真实来源）、模型（库里真有图的模型才出现）、分类（用户的标签 + 管理入口）；
   比例只在库里出现 ≥2 种时渲染，且值取自条目本身（`normalizeSize`），不再列固定 8 种。
2. **挂载健壮性（1.16.4）**：`stall-watch` 原来直接读裸 `performance`，在 jsdom/内嵌
   WebView 里抛 `ReferenceError`，被 `mountUi` 的兜底 catch 吞掉，表现就是「侧栏标签在、
   工作室空白」。改成 `clock()`（有 `performance.now` 用之，否则 `Date.now()`），堆内存
   快照也改成可选读取——诊断设施不该拖垮面板。
3. **更新通道指回自己的仓库（1.16.4）**：`RELEASES_URL`、面板 GitHub 图标、profile 清单
   全部指向 `wcq5012531-crypto/dsh-imagegen-erkai`；自更新仍关闭（`SELF_UPDATE_DISABLED`）。
4. **版本号单点（1.16.4 起）**：`package.json` 与 `src/protocol.ts` 的 `PLUGIN_VERSION`
   必须一致，冒烟 A1 钉住这一对值（之前漂过三个版本）。
5. **历史视频行回到结果看板（1.16.5）**：`openVideoFromHistory` 原来走 `openTab('text')`，
   而面板收敛成三个标签后这个 helper 对非素材库标签一律切去 studio，studio 没有播放器——
   行会高亮、画面不动。现在显式要求经典工作区的结果看板。
6. **冒烟 E1 按真实界面收敛（1.16.5）**：底栏 Dock、导航里的电商模式/图片转 PPT、模板库
   抽屉、电商整套图提交流这些入口在二开里已不存在，用例改成走仍然存在的路径，或在原位留
   一行说明。`node scripts/smoke.mjs` 89/89。

### 套件里踩到的坑（都已修，别再踩）

- `scripts/verify-tracked.mjs`：`git ls-files` 输出用 `/`，与 `readdir` 的 `\` 直接比较会
  在 Windows 上永远不等——比较前统一 `replace(/\\/g, '/')`。
- `scripts/verify-reproducible.mjs`：用 `spawnSync(process.execPath, ['build'])` 调不到
  tsdown 入口，改成跑 `tsdown` 实际 bin。
- `scripts/smoke-storyboard.mjs`：`new URL(...).pathname` 在 Windows 上得到 `/C:/...`，
  必须 `fileURLToPath`。
- `smoke-video-picker` / `smoke-canvas-video`：底栏 Dock 已拆，入口改成画布空白处右键菜单
  的「添加视频」；选中态 / 清空选中走 `clearSelection()`（Esc 等价）。
- `smoke-code-render` 的 C4c（超时截断）：视频渲染在帧循环之前先找 ffmpeg，本机没有 ffmpeg
  就永远到不了 deadline（会先报 `render-no-ffmpeg`，由 C4d 覆盖），所以 C4c 在无 ffmpeg 时
  打印 SKIP 并返回，而不是断言一个本机到不了的状态。
- 跑冒烟前必须先 `npm run build`：E1 加载的是 `lib/client.js`，改 `src/` 不重建等于白跑。

### 本机验证环境

- `node_modules\@deepseek-ai\dsh-scope` 是 junction，指向宿主自带副本
  `C:\Users\Administrator\AppData\Local\Programs\DSH Desktop\resources\app\node_modules\@deepseek-ai\dsh-scope`。
- `verify-ui-contracts.mjs` 需要 `CHROME_HEADLESS_SHELL='C:\Program Files\Google\Chrome\Application\chrome.exe'`。
- 本机无 ffmpeg：代码渲染只覆盖静帧路径。

### 当前状态

`node scripts/verify-tracked.mjs`、`verify-reproducible.mjs`、`smoke.mjs`（89）、
`smoke-storyboard.mjs`、`smoke-code-render.mjs`、`smoke-canvas-video.mjs`、
`smoke-video-picker.mjs`、`verify-ui-contracts.mjs`（24）、`verify-stores.mjs`（20）
九个套件全绿；`lib/index.js` 862.89 kB、`lib/client.js` 2,732,016 B；已同步到
`profiles\web\vendor\dsh-imagegen-studio`，**彻底退出 DSH Desktop 再重开**才生效。

## 14. 单条货架 + 画布 → 素材库（1.16.6）

用户原话（2026-10-25）：「这个分类还是不好，'来源'就应该和分类是一个意思，你去掉'来源'整个逻辑，
把分类里每个分类像'来源'似的独占一行，且有一个'全部素材'。另外，素材也应和其他页面打通，比如，
生成的内容，右键可以添加为素材，这只是个简单例子，打通和统一，是一个插件各个功能这能能完美融合
的根基」。

1. **删掉「来源」轴**（`src/client/ImageGenPanel.tsx`）：`GalleryFilter` 类型、`galleryFilter`
   状态、以及 全部素材/文生图/图生图/视频 四个来源桶全部移除，连 `gallery.sources` 这个标题也
   不再渲染。筛选列现在只有一条货架：第一行 `data-gallery-all`（全部素材，行尾是总数），之后
   每个分类各占一行（行尾是该分类下的素材数），点击在「选中/取消」之间切换。模型、画面比例两段
   保留，但只在库里真的存在多个模型 / 多种比例时出现。
   - 原来按来源过滤的分支随之删除：来源桶不存在，`galleryFilter` 也就没有取值了。
   - `gallery.sources` 这个本地化键留在三语表里但已无引用，下次清理时可以删。

2. **画布 → 素材库**（`src/client/CanvasWorkspace.tsx`）：图片节点的右键菜单在「下载图片」旁边
   新增「加入素材库」。实现是 `saveNodeToLibrary(node)`：`fetch(asset.url) → blob → base64`，
   调 `api.galleryAppend`，`mode: 'text'`、`model` 记为「画布」、`prompt` 用节点标题。
   宿主按内容哈希去重，因此重复点不会多出条目，提示词会从「已加入素材库」变成「已在素材库中」。

3. **跨面刷新**：新增 DOM 事件 `dsh-imagegen-studio:gallery-changed`。画布入库成功、工作室
   自动入库成功都会广播；`ImageGenPanel` 挂了一个监听，收到就重新 `galleryList()` 覆盖
   entries/trash/categories。素材库只有一份，哪个面写入都该让正开着的列表立刻跟上，而不是等
   用户关掉面板再打开。

4. **冒烟 E1 适配新货架**（`scripts/smoke.mjs`）：原来那段「点视频来源桶 → 只剩剪贴」的断言
   改成了断言新形状——第一行是「全部素材」且默认选中、图片卡片与剪贴卡片并列出现。来源桶已退休，
   再去点它就是测一个不存在的东西。

验证：`npm run build`（`lib/client.js` 2,734,015 B）后九个套件全绿；`node scripts/smoke.mjs`
仍 89/89（只换了那段断言的内容，条目数不变）。

## 15. 观察者收窄与卡顿判据（1.16.7）

用户报告（2026-10-25 20:03）：「刚才又出现界面卡的情况了」。查 `studio/out/stall.log`：

| 时间(UTC) | 现场 | 节点数 | 空档 |
| --- | --- | --- | --- |
| 10:56:26 | normal, 1 panel | 30318 | 42s |
| 10:57:26 | normal, 1 panel | 30463 | 60s |
| 10:58:26 | normal, 1 panel | 30639 | 60s |
| 12:00–12:03 | studio | 18602（不变） | 60s ×3 |

两点结论：

1. **60 秒整的空档多半是节流，不是冻结。** 窗口隐藏/被遮挡时 Chromium 会把定时器节流到
   每分钟一次，与主线程卡死的心跳空档长得一样。记录新增 `visibility` / `hidden` /
   `focused`，以后直接看 `hidden`。
2. **插件侧的放大效应确实存在。** `normal` 现场有 3 万节点，而插件历史/素材库目录基本是空的
   （`harness\dsh-imagegen-studio\gallery\images` 空、没有 history 索引），说明这些节点是
   对话本身。这种页面上，插件原来有两处「整页 DOM 观察者」，每次 DOM 变动都要做一遍全页查询：

   - `src/client/sidebar-entry.ts`：`observe(document.body, {childList, subtree})` → 每次变动排
     一个修复 pass（pass 内要重新走 `placeTabs` / `placeHistoryHost` / `pruneDuplicates`）。
     现在只观察侧栏根节点；「宿主把侧栏整块换掉」是窄观察者看不到的情况，交给 300 ms 守卫
     （只读 `tabs.isConnected` / `root.isConnected`）。pass 里发现根变了会重新挂观察者。
   - `src/client/ImageGenPanel.tsx` 的 `useSidebarHistoryHost`：整页观察者里做
     `document.querySelector`。现在 1 秒一次的单次查询，引用相等就跳过 setState。

   效果：稳定界面上，原来「每次 DOM 变动 = 一次全页查询」，现在「每次 DOM 变动 = 零次查询」。
   `mount.tsx` 的那个整页观察者保留——它的回调只是 `container.isConnected`，本来就便宜。

真正的卡顿源仍是**超大会话**：本机当前会话压缩后 5.34 MB（`session.v4.jsonl.zstd`），
解压后三千万级节点 / 数千帧，对话页全量重渲染与插件无关（HANDOFF §6 已记录，仍待在新会话里
复验）。二开能做的只有把自己的边际成本压到零，这一版做的就是这个。

验证：`npm run build`（`lib/client.js` 2,734,732 B）、`node scripts/smoke.mjs` 89/89，
九个套件全绿，已同步到 `profiles\web\vendor\dsh-imagegen-studio`。

## 16. 右键菜单 + 批量入库（1.16.8）

用户 m03295「继续」指向三件打通：素材库卡片右键、历史行右键、画布多选批量入库。

1. **`src/client/RowMenu.tsx`（新）**：`useRowMenu()` → `[state, open, close]`；`open` 既接受 React 事件，
   也接受 `{ x, y }`（原生监听和「⋯」类入口都用得上）。`RowMenu` 用 `createPortal` 渲染到
   `document.body`，位置在视口内收边（`MENU_WIDTH = 168`、`ITEM_HEIGHT = 30`），Esc / 外部
   `mousedown`（capture）/ 滚动（capture）/ `resize` / `blur` 关闭。按钮带 `data-menu-key`，
   危险项带 `data-danger`。
2. **历史行**（`src/client/ImageGenPanel.tsx`）：图片行 打开 / 加入对话 / 加入素材库 / 加到画布 / 归档 / 删除；
   视频行 打开 / 加入对话 / 加到画布 / 加入素材库 / 删除；已归档行 打开 / 取消归档 / 删除。
3. **为什么是原生监听**：历史行 portal 进宿主侧栏，React 的委托 `onContextMenu` 到不了那个子树
   （点击可用是因为每行自带按钮）。`contextMenuFor(items)` 返回 ref 回调，在节点上挂 `node.oncontextmenu`。
   冒烟因此改成 `await waitUntil(() => document.querySelector('[data-row-menu]') !== null)`。
4. **素材库卡片**（`:4099`）：图片卡片 打开 / 加入对话 / 加到画布 / 编辑分类 / 删除；视频卡片 打开 / 加入对话 /
   加到画布 / 删除。
5. **批量入库**（`src/client/CanvasWorkspace.tsx`）：`importRequest` 的
   `{ entryId, imageIndex }` 变成 `items: Array<{ entryId, imageIndex }>`；先全部解析再并发
   `canvasImport`，`addAssets` 按选择顺序落节点；`processedImport` 的 key 用全部条目拼。

验证：`npx tsc --noEmit` 干净；`npm run build`（`lib/client.js` 见构建输出）；`node scripts/smoke.mjs`
89/89；全量 19 个套件通过。

## 17. 安装对齐市场 + 同源撞车检测（1.16.9）

用户 m03841 的两条要求：装法要对齐市场（包名 / GitHub 地址 / 本地目录），并在我这个插件装上来时
主动识别同源插件（`@q253595422/dsh-imagegen-video`、`@dickpy/dsh-imagegen-studio`）而不是让两边抢路由。

1. **为什么之前 GitHub 地址装不上**：仓库不带构建产物，pnpm 拉 git 包时会跑 `prepare`（`tsdown`），
   而 pnpm 对 git 包的构建脚本是 fail-closed 的（`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`），
   允许清单还要按 commit sha 写进 `pnpm-workspace.yaml`，每次 push 都会失效。
   解法：把 `lib/` 提交进仓库、删掉 `prepare`。`scripts/verify-lib-sync.mjs` 钉住「提交的 lib/ 与
   源码构建结果一致」，`npm test` 里排在 build 之后。
2. **实测**（全新 `DSH_HOME`，不碰用户 profile）：
   - `dsh plugin --profile web add https://github.com/wcq5012531-crypto/dsh-imagegen-erkai`
     → 33.6s，`dependencies` 记成 `github:wcq5012531-crypto/dsh-imagegen-erkai`，bundles 自动加一行，
     `lib/index.js` 就在包里，无需编译。
   - `dsh plugin --profile web add C:\...\dsh-imagegen-studio` → 1.9s，`link:` 依赖，同一套校验通过。
   - 包名（`dsh-imagegen-studio`）还需要发 npm registry，仓库里没做，需要 token。
3. **撞车检测**（`src/conflicts.ts`，在 `apply()` 最前面调用）：扫 profile 依赖 + `cordis.patch.yml`
   的启用行（`disabled: true` 的算禁用），命中就抛中文错误，说明卸载/禁用命令，并提示数据目录共用、
   换之前先备份。命中条件是「装了 + 启用」，纯依赖挂着但被 patch 禁用不误报。
4. 冒烟 `A1b` 从「prepare 钩子会构建产物」改成「git 安装不需要构建：lib/ 随仓库发布」。

验证：`node scripts/smoke.mjs` 全绿（`A1b` 新断言通过）；`npx tsc --noEmit` 干净；
vendor 副本已同步 1.16.9（`lib/index.js` 内可搜到「冲突插件」提示）。

## 18. 宿主依赖不再写成 peer（1.16.10）

用户截图报「依赖缺失 @deepseek-ai/schemastery ≥3.18.4 … 未安装」。排查结论：报错来自 profile 里的
`dsh-my-guardian`（0.4.8）`lib/dep-precheck.js`，不是 DSH 本体，也不是插件真的缺包。

1. **它为什么看不见宿主包**：`lib/host-inventory.js` 只认 `<Resources>/app.asar/dsh/desktop-runtime.json`
   （以及 `DSH_APP_RESOURCES` 的同一约定）。本机 DSH Desktop 0.12.1 的 `app.asar` 顶层是 `node_modules/`、
   `out/`，没有 `dsh/desktop-runtime.json`，于是宿主清单解析成空，随后 `classifyPeers` 把
   `peerDependencies` 里所有包都算成 `missing`。
2. **我们其实由宿主供**：`<Resources>/host-module-fallback.mjs` 的 `registerHostModuleFallback()` 对任何
   `@deepseek-ai/*` 解析失败都会回落到 Harness 入口（`ERR_MODULE_NOT_FOUND` 才回落），所以 Profile 里
   永远不该装一份 `@deepseek-ai/schemastery`——装了反而会和宿主抢同一个单例。
3. **处理**：从 `package.json` 的 `peerDependencies` 移除该包（运行时 `import` 不变，解析走宿主兜底），
   并在 README「其他安装方式」里写清原因。现在 `checkPeerDependencies()` 对 vendor 副本返回
   `{ ok: true, missing: [], mismatched: [], warnings: [] }`，市场面板的「依赖缺失」随之消失。
4. **备选**（如果以后想保留声明）：`peerDependenciesMeta.<name>.optional = true` 能把 `missing` 变成
   `warnings`（`ok: true`），但面板仍可能显示一行「可选依赖…未安装」。

验证：`npm run build` + `node scripts/verify-lib-sync.mjs` PASS；`node scripts/smoke.mjs` 全绿；
vendor 副本已同步 1.16.10。

## 19. 历史栏两个货架：生成记录 / 画布（1.16.11）

用户看完截图后的原话（paraphrase）：历史记录就这么一个模块吗？左侧这些东西应该统一起来——普通生图的
记录和无限画布的项目，感觉有点像。方案经用户确认（「可以」）后实施。

1. **一个左栏，两个货架。** `src/client/ImageGenPanel.tsx` 的历史侧栏顶部加了分段控件
   （`data-history-scopes` / `data-history-scope="generations|canvases"`）。切到画布货架时，生成记录
   专属的 `data-history-filters`、`data-history-archived-toggle`、清空按钮一起离开视图——它们只管生成
   记录，留在画布货架上就是撒谎。画布货架有自己的 `data-canvas-new`。
2. **画布行。** 标题 / 节点数（`history.canvasMeta`）/ 更新时间，点开跳到那张画布；右键菜单与生成行
   共用 `src/client/RowMenu.tsx`：打开 / 收藏（取消收藏）/ 删除，收藏的画布单独分组
   （`history.canvasFavorites`）。列表来自 `api.canvasList()`，挂在挂载时读一次（来源标签要标题）。
3. **互相认得。** 生成行与素材库卡片下方的 `history.fromCanvas` 标签用 `CanvasTaskMeta.sourceNodeId`
   回到产出该图的节点；右键里是同一条 `history.openInCanvas`。
4. **怎么跨组件打开某张画布。** 新增 `src/client/canvas-open.ts`：`requestCanvasOpen(target)` 既
   `window.dispatchEvent('dsh-imagegen-studio:open-canvas')` 又记一份 pending，
   `takePendingCanvasOpen()` 供后挂载的一方消费。面板先 `setWorkspace('canvas')` 再发事件，事件可能
   早于 `CanvasWorkspace` 注册监听——pending 兜住这个顺序，两条路径都收敛到同一张画布。
   `CanvasWorkspace.selectProject(id, nodeId?)` 打开后选中节点并把视口居中到它。
5. **跟随但不抢。** 左栏货架跟随工作区（`workspace === 'canvas'` → 画布），只在工作区变化时跟随一次，
   所以用户手动点回生成记录不会被 effect 抢回去。
6. **冒烟。** E1 新增：两个货架都渲染、默认落在生成记录、切到画布后筛选/归档控件消失且
   `data-canvas-new` 在场、切回来控件复原。踩到的两个坑都记在用例注释里：左栏跟随工作区导致
   上面的导航步骤把货架停在画布（所以行断言前先显式切回生成记录）；切货架会重渲染，之前抓住的行节点
   变成游离节点（所以要重新 query 再点）。

验证：`npx tsc --noEmit`、`npm run build`（`lib/client.js` 2,765,851 B）、`node scripts/smoke.mjs` 全绿。

## 20. 左栏两个货架完全统一（1.16.12）

用户对着五张截图逐条提的问题，归结起来是一件事：**历史侧栏的两个货架长得不像一家人**。

1. **头部统一。** 生成记录有「＋新建 / 已归档」，画布货架只有「＋新建画布」。现在两边都在位：
   画布也能归档（`CanvasSummary.archived`，宿主 `CANVAS_API.archive`），也能切换查看已归档。
2. **筛选还给素材库。** 左栏原来还有搜索框和「全部 / 全部模型 / 全部比例」三个下拉，
   和素材库的筛选重复。全删——左栏只回答「我刚做的东西在哪」，找东西去素材库。
3. **命名与排序。** `workspace.normal` 从「普通生图」改成「图片生成」，导航顺序改为
   图片生成 / 无限画布 / 素材库（素材库最后）。
4. **画布管理能力对齐。** 画布行右键菜单与生成行共用 `src/client/RowMenu.tsx`：
   打开 / 在画布中打开 / 重命名 / 收藏 / 归档 / 删除。画布顶栏的「删除画布」按钮删掉——
   它调用的是文件菜单里的删除，点下去没反应，是设计的错；「另存为副本」留下并接入 i18n
   （`canvas.duplicateProject` / `canvas.duplicateProjectHint`）。
5. **重命名。** 宿主 `CANVAS_API.rename` 走 `canvas-store.rename()`，空标题回落到「未命名画布」；
   画布行菜单里的「重命名」用 `window.prompt` 拿新名字——与素材库分类重命名同一套交互。

踩到的坑：`ImageGenPanel` 的 `workspace` 跟随 effect 会在切到画布时把货架也切到画布，
所以 E1 里做生成行断言前要先显式点回「生成记录」（`data-history-scope="generations"`），
而且切货架会重渲染，之前抓到的行节点会游离，必须重新 query。

验证：`npx tsc --noEmit`、`npm run build`、`node scripts/smoke.mjs` 全绿、
`node scripts/verify-ui-contracts.mjs` 全绿。

## 21. 会话行与画布行同规格（1.16.13）

用户的原话：为什么普通生图里只有一个删除图标？——这不是个例，是二开时缺一套全局设计规则。

1. **规则。** 左栏的「项目行」只有两种：会话与画布。它们回答同一个问题（我刚做的东西在哪），
   所以结构、图标位、动作集必须一样，差异只允许在「打开去哪」和「本体数据从哪来」。
2. **落法。** `src/client/ImageGenPanel.tsx` 里 `renderShelfRow(spec)` 是唯一渲染入口，
   `renderThreadRow` 与 `renderCanvasRow` 各自只提供数据与回调。行的能力清单写进
   `data-shelf-actions`（未归档为 `open rename favorite archive delete`），冒烟据此断言。
3. **会话的动作从哪来。** 收藏/归档不存在宿主存储里，落在本地 `dsh-imagegen-studio:shelf-flags`
   （id → { favorite, archived }）；改名走 `studio-rename` 事件，由工作室写它自己那份 payload。
4. **命名。** 导航「普通生图」改为「图片生成」；货架叫「生成记录 / 画布」，不借用工作台名字。

验证：`npx tsc --noEmit`、`npm run build`、`node scripts/smoke.mjs`（新增 action-cluster 断言）、
`node scripts/verify-ui-contracts.mjs`。

## 22. 图片编辑面板与冒烟同步（1.16.14）

1. **结构。** 画布节点工具条的「图片编辑」打开 `src/client/ImageEditSurface.tsx`：
   `[data-image-edit-surface]` 的 role=dialog，头部两个 `[role="tab"]`（涂鸦 / 标注），
   中间一块 canvas（所有绘制都在上面），底部 关闭编辑器 / 应用到节点。
   标注工具六种：框选标注、图钉、箭头、椭圆、自由圈、画笔；标记与提示词一起进
   `CanvasImagePlan`，由 `onApply` 交回画布。
2. **下线的东西。** `annotateNodeId` / `toggleAnnotate` 仍是死代码（没有入口再设置它），
   节点不再渲染 `data-annotating`。清理它们时注意 `attachedCards()` 仍在用——标注卡片
   的数据模型没删，只是没有内联创建入口了。
3. **测试。** `scripts/smoke.mjs` 的 E1 段：内联标注块改为面板骨架断言；「配置节点生成」
   改为断言「图下游运行带参考图（mode=edit、refName=canvas-reference.png、
   sourceNodeId=node-image、parentNodeId=node-config）」。卡片跟随的两条断言随创建入口
   一起移除，原因写进了注释。

验证：`npx tsc --noEmit`、`npm run build`、`node scripts/smoke.mjs`（SMOKE TEST OK）、
`node scripts/verify-ui-contracts.mjs`（UI CONTRACTS VERIFIED）。
