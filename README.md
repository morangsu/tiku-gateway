# 题库网关（tiku）

> **开源协议：MIT**（见 [LICENSE](LICENSE)）。零遥测、零 npm 依赖、数据全部留在本机。
>
> **隐私 / 脱敏**：仓库不含任何密钥与题库数据。所有密钥只存 `data/keys.json`，题库存 `data/bank.sqlite`，二者都被 [.gitignore](.gitignore) 排除、从未上传。首次使用请把 `config.example.json` 复制成 `data/config.json`，token / API key 通过网页界面填写。

本地跑的一个「答案编排器」。OCS 只负责**采集题目**和**填写答案**，所有答案来源都在这里：

- ZError（服务端直连，可清洗、可记账）
- 五个网页版 AI（导出 → 粘贴 → 导入，多会话各自成票）
- **自定义 HTTP API**（填 URL/头/body/答案路径，服务端直连，不用来回复制）
- 人工裁决（权重最高）

零 npm 依赖，整个文件夹拷给同学就能用。

## 快速开始

```
双击 start.cmd          （或者：node --experimental-sqlite src/gateway.mjs）
```

浏览器打开 `http://127.0.0.1:8321`。端口被占用会自动 +1，看控制台输出的实际端口。

## 验证（三步，从低成本到真实环境）

### 第 1 步：离线自测（不碰 OCS、不写库）

```
node src/selftest.mjs
```

应该输出 `✅ 通过 71 / 71`。它验证的是整套东西的地基：

| 覆盖点 | 为什么重要 |
|---|---|
| `A. 细胞膜` → `细胞膜`、全角转半角 | OCS 和网关的归一化必须一致 |
| **同一题在乱序选项下定位到同一段文本** | 这是「不存编号」的全部意义 |
| 1:1 分歧留空 / 2:1 采纳 / 人工压过一切 | 投票规则 |
| 多空填空输出 JSON 数组且长答案不被切碎 | 老师「一空不限长度」 |
| 五家脏回复解析（前言、代码块、加粗、表格拒绝、多批堆叠） | 粘贴容错 |

### 第 2 步：一键演示（写库，但只在 `course=demo`）

先启动网关，另开一个窗口：

```
node src/demo.mjs
```

它会造 4 道题 → 导出 → 模拟两家导入 → 打印结果 → 演示 1:1 冲突和人工裁决。重点看三行：

```
单选取文本而非字母               {"code":1,"a":"选择透过性"}
同一题乱序后仍正确               {"code":1,"a":"选择透过性"}
填空（JSON 数组穿过 OCS 契约）    {"code":1,"a":"[\"北京\",\"甲辰\"]"}
```

跑完自动切回 `course=default`，演示数据留在 `demo` 课程里。

### 第 3 步：接 OCS（真实环境）

1. 打开 `http://127.0.0.1:8321` → 底部「接到 OCS」→ 复制那段 JSON
2. OCS 里：通用 → 全局设置 → **题库配置**，清空原有内容，粘贴这段（**只留这一个题库**）
3. **关掉 OCS 的「题库缓存」**（通用 → 全局设置 → 题库缓存 → 关闭）。否则你在复核页改的答案会被旧缓存挡住
4. 总览页选 `auto` 模式，进作业页跑一遍
5. 看控制台/`data/logs/gateway.log`：每道题一行 `HIT <题型> <题干前24字> → <答案>`

> OCS 侧 `type` 必须是 `GM_xmlhttpRequest`（跨域），`method` 是 `post`，`data` 里三个占位符不能改。

## 一天怎么用

| 步 | 操作 | 在哪 |
|---|---|---|
| 1 | `auto` 模式跑一遍作业 | OCS |
| 2 | 「开始新一轮」收集未解的题 | 总览 |
| 3 | 按题型分批，五家各点一次「复制」 | 导出 |
| 4 | 每家在会话里问完，粘进对应票源的会话框，点「解析导入」 | 导入 |
| 5 | 分歧题点「拉取分歧题」（走 ZError，省次数） | 总览 |
| 6 | 过一遍争议题，点选项或手填 | 复核 |
| 7 | `auto` 再跑一遍 → 全绿 → 手动交卷 | OCS |

第 2 次跑同一门课，第 3–6 步全部跳过。

## ZError 的三个事实（都实测过）

1. **响应里没有剩余次数字段。** `/api/query` 只返回 `{data:{code,data,msg,ai,source},success}`。所以剩余次数只能：
   - 总览页手动校准（「当前剩余次数」→ 写入）
   - 网关本地记账：每发一次请求扣一次，`used` 可在总览看到
2. **策略默认 `zlast`**：只查 AI 投票分歧的题。300 题的卷子通常只花 30–60 次。改 `zfirst` 就是每题都查（很费）。
3. **失效会被认出来**：返回「该题库配置已失效」时置 `invalid`，总览页弹红条，提示去官网重新复制 token。你上次那份 token 就是失效状态。

`ai:true` 的答案默认丢弃（设置里可改）。丢弃也扣 1 次，这是服务端行为，改不了。

## 数据

```
data/config.json    运行时设置（模式、课程、票源、题型规则）—— 不含任何密钥
data/keys.json      ★ 所有密钥（ZError token + 各 API 的 key）—— 分享时删掉这个文件
data/bank.sqlite    题库（question / vote / answer / round）
data/logs/          运行日志
```

- SQLite 是主后端（可用 DB Browser for SQLite 直接看）。如果你的 Node 跑不了 `node:sqlite`，会自动降级成 `data/bank.json`，接口完全一样。
- **复制给同学**：拷 `tiku/`，但**删掉 `data/keys.json`**（里面有你的密钥），并把 `data/config.json` 里需要的 token 让他们自己填。题库在 `data/bank.sqlite`。
- **升级**：旧版 `config.json` 里的 ZError token 会在网关启动时**自动迁到 `keys.json`**并从 config 清空，token 不丢。
- **清空**：删 `data/bank.sqlite*`（所有课程）或只删某个 `course`。

## 已知边界

| 边界 | 影响 | 说明 |
|---|---|---|
| 填空的「空数」拿不到 | 网关只按 AI 给的数组长度输出 | OCS 传上来的 `options` 对填空题是空字符串，数不出空数。数组长度和真实空数不一致时 OCS 不会填（安全失败），这题会出现在复核页 |
| 输入框有 `maxlength` | 长答案会被浏览器截断 | 网关无从得知，需要你在复核页手填一次并记住能填多长 |
| 判断题必须能识别 | 选项是「符合/不符合」这类词时判不出 | 识别词表在 `src/normalize.mjs` 的 `CORRECT/INCORRECT`，可自行加 |
| 同一题干不同课程 | 会串答案 | `hash = sha1(course + ':' + 题干)`，切课程请改「当前课程」 |
| 网页版 AI 的输出 | 表格、超长、漏题 | 通义表格会被明确拒绝，其他家自动清洗；漏题会报「缺 n 题」 |

## 自定义 API 票源（服务端直连）

票源页 →「② 自定义 API」→ 选预设模板（DeepSeek / OpenAI 兼容 / 智谱 / 通义）或空白 → 新建。
**只有填了 URL 和 Body、且勾选启用的源才参与投票**，其它源不请求、不计票。

要填的字段（都在票源页，会实时存进 `config.json`）：

| 字段 | 作用 | 例子 |
|---|---|---|
| URL | 请求地址 | `https://api.deepseek.com/chat/completions` |
| 方法 | POST / GET | `POST` |
| 请求头 | JSON 对象 | `{"Content-Type":"application/json"}` |
| 鉴权头名 | 留空则不注入 | `Authorization` |
| 鉴权头值 | 支持 `{{key}}` | `Bearer {{key}}` |
| Body 模板 | JSON；**内容里用 `{{prompt\|json}}`** | `{"model":"deepseek-chat","messages":[{"role":"user","content":"{{prompt\|json}}"}]}` |
| 答案路径 | 从响应 JSON 抠答案的点号路径 | `choices.0.message.content` |
| 批量大小 | 一次问几题 | `20` |

**占位符**：`{{prompt}}`（原样）、`{{prompt|json}}`（JSON 转义后，放 body 引号里必须用这个）、`{{title}}`、`{{options}}`、`{{type}}`、`{{i}}`、`{{key}}`、`{{model}}`。
留空答案路径 = 把整段响应当文本；关键是让 AI 按 prompt 要求回 `[{"i":1,"a":"B"},...]`。

**key 不填在配置里**：每个 API 源在票源页有自己的「保存 key」框，写进 `data/keys.json`，网关返回给前端的只有掩码（如 `sk-1…cdef`）。换电脑或发给同学时删掉这个文件即可，配置可安全分享。

**流程**：
1. 填好字段 →「保存全部」→「保存 key」→「测试连通」（发一道「水的化学式」探针题，确认 key 有效、答案能解析）
2. 总览页 `auto` 跑一遍 OCS 收集题目 →「开始新一轮」
3. 票源页「立即拉取未解题」——网关只拉**本轮还没解出的题**，解析后自动转成票（省 API 费用）
4. 回总览看命中；有分歧的题用人工裁决或网页 AI 补票

效费比：`zlast` 策略下 ZError 只查分歧题，API 只拉未解题，两者都是「按需付费、不重复花钱」。网页 AI 免费但当面粘贴费时；API 便宜但要 key，适合兜底那些网页 AI 也判不准的题。

## 加一个网页版 AI 票源

票源页「① 网页版 AI」→「新增网页票源」→ id 写 `web:xxx`，导出页就多一张卡片、导入页多一个票源（可开多个会话框，各自算一票）。权重 0 = 不参与投票。

## 文件

```
src/normalize.mjs   归一化、dice 相似度、判断题词表
src/store.mjs       SQLite / JSON 双后端，同一套仓储接口
src/decide.mjs      题型判定、文字↔选项匹配、加权投票、序列化给 OCS
src/prompt.mjs      预处理、分批 prompt、五家清洗与解析
src/zerror.mjs      ZError 客户端 + 额度记账 + 批量拉取
src/keys.mjs        独立密钥存储（keys.json）+ 旧 token 自动迁移 + 掩码
src/apiprovider.mjs 自定义 API：模板渲染 / 鉴权 / 请求 / 路径提取 / 批量拉取
src/gateway.mjs     HTTP 路由
src/selftest.mjs    71 项离线自测
src/demo.mjs        一键演示
web/                总览 / 导出 / 导入 / 复核 / 票源
```
