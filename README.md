# Feishu Bookmark Sync MVP

这个 MVP 是一个 Chrome Manifest V3 扩展：当用户点击 Chrome 地址栏原生星标并创建书签后，扩展会监听 `chrome.bookmarks.onCreated`，把当前网页信息写入飞书多维表格。

项目还包含一个静态个人资源网站：用飞书多维表格作为 CMS，同步脚本把收藏内容导出为 `website/data/resources.json`，网站负责搜索、分类、标签筛选和卡片展示。

## 功能

- 监听新建书签事件
- 同步标题、URL、域名、摘要、标签、分类、封面图、收藏时间
- 同一个 URL 已存在时更新原记录，不重复新增
- 可选：收藏后让 AI 阅读网页正文，生成中文标题、摘要、标签、分类
- 通过配置页填写飞书应用凭据和多维表格字段映射
- 弹窗查看最近同步结果
- 配置页支持“测试同步当前页”

## 安装

1. 打开 Chrome 的 `chrome://extensions/`
2. 开启“开发者模式”
3. 点击“加载已解压的扩展程序”
4. 选择本仓库下的 `extension` 目录
5. 打开扩展详情，进入“扩展程序选项”填写配置

## 个人资源网站

推荐架构：

```text
公司电脑 Chrome 扩展 ┐
                   ├─> 飞书多维表格 -> GitHub Actions 定时同步 -> 在线资源网站
家里电脑 Chrome 扩展 ┘
```

扩展可以安装在多台电脑上，它们都写入同一个飞书多维表格。网站上线后不依赖某一台电脑开机，云端定时任务会从飞书同步数据并发布静态网站。

本地预览：

```bash
npm run serve
```

然后打开 `http://localhost:5173`。

同步飞书数据：

```bash
cp .env.example .env
```

把 `.env` 里的飞书配置改成你的真实值，然后在 shell 中导入环境变量后运行：

```bash
set -a
source .env
set +a
npm run sync
```

同步完成后会生成：

```text
website/data/resources.json
```

静态网站读取这个 JSON 来展示资源。部署时只需要发布 `website` 目录即可。

封面图：

- 默认 `DOWNLOAD_COVERS=1`，同步时会把飞书附件封面下载到网站目录并展示。
- 如果不想下载封面，可以设置 `DOWNLOAD_COVERS=0`，网站会用分类占位封面。
- 下载封面可能需要额外的飞书 Drive/素材读取权限。

## 上线部署

项目内置 GitHub Pages 工作流：

```text
.github/workflows/deploy-resources-site.yml
```

上线步骤：

1. 把项目推到 GitHub 仓库。
2. 在仓库 Settings -> Pages 中选择 GitHub Actions 作为部署来源。
3. 在仓库 Settings -> Secrets and variables -> Actions -> Secrets 中添加：
   - `FEISHU_BASE_URL`
   - `FEISHU_APP_ID`
   - `FEISHU_APP_SECRET`
   - `BITABLE_SOURCE`
   - `TABLE_ID`，如果 `BITABLE_SOURCE` 已包含 `table=tbl...` 可以留空
4. 可选：在 Variables 中添加字段名覆盖：
   - `FIELD_TITLE`
   - `FIELD_URL`
   - `FIELD_DOMAIN`
   - `FIELD_SUMMARY`
   - `FIELD_TAGS`
   - `FIELD_CATEGORY`
   - `FIELD_COVER`
   - `FIELD_CREATED_AT`
   - `DOWNLOAD_COVERS`
5. 手动运行一次 `Deploy resources site` 工作流，确认发布成功。

默认工作流每 15 分钟同步一次，也支持手动触发。公司电脑和家里电脑只需要安装并配置同一个扩展，收藏内容写入同一个飞书表格即可。

如果希望收藏后网站尽快刷新，可以在扩展设置页开启“网站自动刷新”。开启后，扩展会在成功写入飞书后调用 GitHub Actions 的 `workflow_dispatch` 接口，触发一次部署；15 分钟定时任务仍会保留作为兜底。

需要在扩展设置页填写：

- `GitHub 用户名`：例如 `ccfffcc`
- `GitHub 仓库名`：例如 `resource-site`
- `工作流文件名`：`deploy-resources-site.yml`
- `部署分支`：当前是 `master`
- `GitHub Token`：需要有触发 Actions 的权限
- `触发间隔`：默认 120 秒，避免连续收藏多个网页时频繁触发部署

## 飞书准备

1. 在飞书开放平台创建企业自建应用
2. 获取 `App ID` 和 `App Secret`
3. 给应用开通多维表格相关权限，并发布/启用应用
4. 在目标多维表格中准备字段，默认字段名为：
   - `标题`
   - `URL`
   - `域名`
   - `摘要`
   - `标签`
   - `分类`
   - `封面图`
   - `收藏时间`
5. 在扩展设置里填写多维表格来源和 `table_id`

## 多维表格来源

扩展支持 4 种写法：

- 常规多维表格 `/base` 链接，例如 `https://xxx.feishu.cn/base/xxxx`
- 常规多维表格 `app_token`
- 知识库下的多维表格 `/wiki` 链接，例如 `https://xxx.feishu.cn/wiki/xxxx`
- 知识库节点 token，例如 `wik...`

如果填写的是 `/wiki` 链接或 `wik...` 节点 token，扩展会先调用飞书“获取知识空间节点信息”接口；当返回的 `obj_type` 是 `bitable` 时，使用 `obj_token` 作为真正的多维表格 `app_token`。

建议直接复制打开目标数据表时浏览器地址栏的完整 `/base` URL。扩展会优先从 URL 中提取 `table=tbl...`。`vew...` 是视图 ID，不能作为 `tableId` 使用。

使用 `/wiki` 链接时，企业自建应用还需要额外开通以下任一权限：

- `wiki:node:read`
- `wiki:wiki:readonly`
- `wiki:wiki`

开通权限后需要重新发布/启用应用，然后在扩展里重新测试。

写入多维表格记录还需要开通以下任一权限：

- `base:record:create`，推荐，最小写入记录权限
- `bitable:app`

启用同 URL 去重更新后，还需要记录查询和更新权限。若弹窗提示缺少读取/更新记录权限，请按飞书返回的授权链接补开对应权限。

## 字段类型建议

- `标题`：文本
- `URL`：链接
- `域名`：文本
- `摘要`：多行文本
- `标签`：多选
- `分类`：单选
- `封面图`：附件；扩展会截取当前页面第一屏，上传后写入附件字段
- `收藏时间`：日期

MVP 当前把 `URL` 写成链接字段值，把 `收藏时间` 写成毫秒时间戳，适配飞书日期字段。`封面图` 会截取当前页面第一屏，上传到飞书后写入附件字段。

建议先在 `标签` 和 `分类` 字段里准备这些选项：`AI`、`开发`、`设计`、`产品`、`效率`、`文章`、`未分类`。

## 中文化

扩展设置页提供“中文化”配置。开启后，扩展会先从当前页面提取正文文本，再在写入飞书前调用 OpenAI 兼容的 Chat Completions 接口，生成中文标题、摘要、标签和分类。

需要填写：

- `AI 接口地址`：默认 `https://api.openai.com/v1/chat/completions`
- `AI API Key`
- `模型`：默认 `gpt-4o-mini`
- `正文最大长度`：默认 `12000`
- `分类候选`：用逗号或换行分隔，AI 会优先从这里选择分类，也可以返回更准确的新分类

如果没有填写 API Key，或者 AI 接口调用失败，扩展会继续使用网页原始标题和摘要同步，不会阻断收藏。

标签不再限制为固定大类，AI 会生成 2-6 个更细的中文短标签，例如 `动效`、`图标`、`Figma`、`PPT`、`Notion`、`React`、`写作`、`素材`。
如果飞书多选/单选字段不允许写入未预设的选项，请先把常用标签和分类选项维护到表格字段里，或把字段临时改成文本字段。

注意：MVP 当前把 API Key 保存在 Chrome 扩展配置中，只适合个人本地使用。若要分发给多人使用，建议改成后端代理，不要把用户的 AI Key 放在扩展里。

## 注意

- Chrome 扩展无法只监听“地址栏星标按钮”这个 UI 动作本身；MVP 使用官方 `bookmarks` API 监听新建书签事件。用户通过地址栏星标创建书签时会触发该事件。
- 如果某些页面禁止脚本注入，扩展仍会同步标题和 URL，只是可能拿不到页面描述。
- 飞书国际版可把开放平台地址改为 `https://open.larksuite.com`。

## 排障

如果完整字段写入失败，扩展会自动降级，只写入 `标题`、`URL`、`域名`、`摘要`、`收藏时间` 这些核心字段，并在弹窗中保留飞书返回的原始错误。

常见原因：

- `标签` 或 `分类` 字段没有提前创建对应选项
- `封面图` 上传失败时，按弹窗里的飞书错误开通 Drive/素材上传相关权限
- 字段名和扩展设置里的字段映射不完全一致
- 错误 `FieldNameNotFound` 表示当前 table 里没有对应列名，例如扩展写 `标题`，但表里实际叫 `网页标题`
- 错误 `AttachFieldConvFail` 表示附件字段值格式不匹配；请确认 `封面图` 是附件字段，并查看弹窗里的原始错误
- 应用没有多维表格或知识库节点读取权限

如果错误是 `code=91403; msg=Forbidden`，通常表示 API 权限范围已经开通，但应用身份没有访问这个具体多维表格/知识库文档。请检查：

- 目标多维表格所在文档是否把应用/机器人加入协作者
- 应用是否已经发布/启用到当前企业
- `/wiki` 来源对应的知识库节点是否允许该应用读取
- `tableId` 是否是当前多维表格里的表 ID，而不是其他表格或视图 ID
