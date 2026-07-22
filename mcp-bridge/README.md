# Job Tracker MCP Bridge

通过 MCP 协议(Model Context Protocol)让 AI 助手(Trae/WorkBuddy/...)访问岗位猎手 Chrome 扩展的岗位数据。

## 架构(单端口 8765)

stdio 传输是一对一的,每个 AI 助手会各自启动一个 `server.js` 进程(通过 stdio 与 AI 助手通信);`server.js` 再通过 WebSocket 连回扩展。**所有桥接进程统一连接扩展的同一 WS 端口 8765**:

```
AI 助手 <--MCP(stdio)--> server.js[WS :8765] <--WS(8765)--> Chrome 扩展
```

> **端口约定**:标准端口为 **8765**。**8766 / 8767 已废弃,不再使用。**
> 多个 AI 助手复用同一个 8765 端口即可,**但同时只运行一个桥接进程**(不要同时启动多个 `server.js` 去抢同一个 8765 端口)。

- **server.js**:每个 AI 助手通过 stdio 启动一个实例,默认连接 WS 端口 8765(`--ws-port=` 仅供高级自定义,标准端口为 8765)
- **ext-bridge.js**:server 实例在 8765 启动 WS 服务,等待扩展连接
- **扩展侧 mcp-connector.js**:连接统一端口 `[8765]`,处理请求/响应
- **数据一致性**:存储在扩展的 `chrome.storage.local`,所有 server 进程都通过 WS 问同一个扩展,数据天然一致

## 安装步骤

### 1. 安装 Node.js(>=18)

从 https://nodejs.org 下载安装。

### 2. 安装 MCP 桥接依赖

```powershell
cd mcp-bridge
npm install
```

### 3. 重新加载 Chrome 扩展

在 `edge://extensions` 点「岗位猎手」的刷新按钮。

### 4. 在 AI 助手中注册 MCP server

> **端口约定**:标准端口为 **8765**(8766/8767 已废弃)。下面以 8765 注册即可,多个 AI 助手都用同一个配置(同时只运行一个桥接进程)。

**AI 助手(以 Trae 为例)— 端口 8765:**

```json
{
  "mcpServers": {
    "job-tracker": {
      "command": "d:\\woekbuddygongzkongjian\\2026-07-06-12-20-43\\job-tracker-extension\\mcp-bridge\\run-host.bat",
      "args": ["--ws-port=8765"],
      "type": "stdio"
    }
  }
}
```

> 若 WorkBuddy 等其他 AI 助手也要用,照抄上面同一份配置(同一 8765 端口)即可,**不要改成 8766**——8766 已废弃,且两个桥接进程不能同时抢 8765。

### 5. 验证

1. 打开扩展的 dashboard 或 popup(保持 SW 活跃约 2 秒让 WS 握手完成)
2. 在任意 AI 助手中说:"帮我看看岗位猎手里有哪些岗位"
3. 即可查询岗位数据(单端口 8765,标准配置)

## 企业分析(天眼查)Key 配置

「岗位猎手」的 AI 深度分析可结合天眼查企业工商/风险信息(存续状态、注册资本、参保人数、行业资质、司法风险)一起分析岗位。**Key 由使用者自行申请,不内置、不分发。**

### 方式一(推荐):在扩展设置页填写

1. 到天眼查 AI 开放平台(tianyancha.com/ai)申请 API Key
2. 打开扩展「设置页 → 企业分析(天眼查)」卡片,填入 Key,点「保存 Key」
3. Key 仅存于你本地浏览器的 `chrome.storage.local`,**不进扩展包、不进 git**
4. 扩展与 mcp-bridge 握手时,会自动把 Key 推送给本地 Node 桥接进程(优先级高于 `.env`),无需手动改任何配置文件
5. 别人拿到你的插件包也用不了你的 Key——他们各自在设置页填自己的

### 方式二(开发者/调试):填 mcp-bridge/.env

```powershell
cd mcp-bridge
cp .env.example .env
# 编辑 .env,填入 TYC_API_KEY=你的key
```

> `.env` 已被 `.gitignore` 排除,真实 Key 绝不进版本库/扩展包。开源时只提交 `.env.example` 模板。

### Key 优先级

扩展注入的 Key(设置页填写) > `mcp-bridge/.env`(本地调试)。两者皆空 → 企业分析自动降级为「只分析岗位」,不影响主流程。

## 暴露给 AI 的能力

### Resources(只读)

| URI | 说明 |
|---|---|
| `jobs://list` | 全部岗位列表(含 AI 分析结果、状态、匹配分) |
| `jobs://stats` | 岗位统计(总数、匹配数、各状态数量) |
| `config://filters` | 当前筛选条件 |
| `config://autoscan` | 自动扫描配置 |
| `profile://resume` | 用户简历档案(求职意向、技能、经验) |

### Tools(可执行,共 17 个)

> 以下为 `server.js` 实际注册的完整清单(此前文档漏列了 `get_job_detail` / `update_autoscan` / `get_chat_context` / `get_chat_debug` / `smart_reply`,此处已补齐)。

| Tool | 必需参数 | 可选参数 | 说明 |
|---|---|---|---|
| `search_jobs` | — | keyword, city, status, minScore, sortBy(score/capturedAt/salaryMax/title), limit | 搜索/筛选岗位(关键词匹配标题或公司) |
| `get_job_detail` | jobId | — | 获取单个岗位完整详情(含 AI 分析全文、匹配理由、避坑提示、笔记) |
| `update_status` | jobId, status | — | 更新单个岗位状态(unseen/interested/applied/interview/rejected/offer) |
| `export_jobs` | — | format(csv/json), filter{keyword,status,minScore} | 导出岗位数据为 CSV 或 JSON 文本 |
| `delete_job` | jobId | — | 删除单个岗位 |
| `delete_jobs` | jobIds | — | 批量删除岗位(传 ID 列表) |
| `update_notes` | jobId, notes | — | 更新岗位笔记内容 |
| `batch_update_status` | jobIds, status | — | 批量更新状态(如把 80 分以上的全标记为感兴趣) |
| `analyze_job` | jobId | force(默认 false) | 触发 AI 适配度分析(force=true 跳过缓存) |
| `batch_analyze` | — | limit(默认 5,上限 10), force(默认 false) | 批量分析未分析岗位(force=true 全刷) |
| `run_autoscan` | — | — | 立即触发一轮自动扫描(唤醒前端执行) |
| `get_autoscan_status` | — | — | 查询自动扫描状态(是否在运行、今日已扫描数、剩余配额) |
| `update_autoscan` | — | keywords, city, maxJobsPerRun, autoAnalyze, analyzePerDay, enrichDetails | 修改自动扫描配置(只改传入字段) |
| `generate_reply` | hrMessage | intent(interested/polite_decline/negotiate/ask_more_info), style(professional/enthusiastic/concise), context{jobTitle} | 根据 HR 消息生成回复(返回多个版本) |
| `get_chat_context` | — | maxMessages(默认 20) | 获取当前 BOSS 聊天页上下文(HR 消息历史、岗位标题),需停留在聊天页 |
| `get_chat_debug` | — | — | 获取 BOSS 聊天页 DOM 调试信息(输入框/消息列表检测结果),用于故障排查 |
| `smart_reply` | — | maxMessages(默认 20) | 半自动智能回复:综合岗位+简历+意图+聊天历史生成,需停留在 BOSS 聊天页 |

## 使用示例(在任意 AI 助手中对 AI 说)

- "帮我看看南宁康复治疗师岗位,哪些 AI 评分最高"
- "把得分 80 以上的岗位标记为感兴趣"(AI 调 batch_update_status)
- "删除所有匹配分低于 30 的岗位"(AI 调 delete_jobs)
- "给运动康复师学徒这个岗位加个笔记:优先联系"(AI 调 update_notes)
- "重新分析一下这个岗位,跳过缓存"(AI 调 analyze_job force=true)
- "把还没分析过的岗位都分析一下"(AI 调 batch_analyze)
- "立即扫一轮岗位"(AI 调 run_autoscan)
- "自动扫描今天扫了多少个了?还有多少配额?"(AI 调 get_autoscan_status)
- "HR 问我什么时候能面试,帮我回复,风格热情一点"(AI 调 generate_reply)
- "导出所有已投递的岗位为 CSV"(AI 调 export_jobs)
- "我的简历档案里写了什么求职意向?"(AI 读 profile://resume)
- "看看岗位 j1 的完整 AI 分析和避坑提示"(AI 调 get_job_detail)
- "把自动扫描城市改成广州,关键词加上推拿"(AI 调 update_autoscan)
- "根据当前 BOSS 聊天记录帮我生成一句回复"(AI 调 smart_reply,需停留在聊天页)
- "为什么聊天页抓不到消息?给我诊断信息"(AI 调 get_chat_debug)

## 卸载

只需两步:

1. 从所有 AI 助手的 MCP 配置中移除 `job-tracker` 条目
2. 删除 `mcp-bridge/node_modules`(可选)

扩展侧回滚:在 `edge://extensions` 重新加载 v1.5.45 版本即可(或从 background.js 的 importScripts 移除 `lib/mcp-connector.js` + 删除 `lib/mcp-connector.js`)。

## 故障排查

### 端口被占用 / 端口冲突

标准端口为 8765。**同时只运行一个桥接进程**即可,不要启动多个 `server.js` 抢同一 8765。如果端口被占用,检查是否有残留的 node 进程:
```powershell
Get-Process node | Stop-Process -Force
```

### 扩展未连接

AI 报错"等待扩展连接超时":
- 确保 Edge/Chrome 已打开,且「岗位猎手」扩展已启用
- 打开扩展的 dashboard 或 popup,保持 SW 活跃约 2 秒让 WS 握手完成
- 在 `edge://extensions` 点扩展的「Service Worker」链接,查看控制台是否打印 `[JT MCP] 已连接到 MCP 毥接进程`

### 端口被占用

- WS 端口 8765 被占:检查残留 node 进程并清理(见上),**不要改用 8766**——8766 已废弃;如确需自定义端口,仅用 `--ws-port=` 并同步改 `mcp-connector.js` 的 `WS_PORTS`

### Service Worker 生命周期说明(MV3)

Chrome MV3 的 Service Worker 会被浏览器在空闲时终止,这会导致 WebSocket 断开。`mcp-connector.js` 在 SW 重启时会自动重新连接(初始延迟 2 秒)。这意味着:

- 长时间无操作后,首次查询可能需要等 5 秒(SW 唤醒 + WS 重连)
- 若希望连接始终活跃,保持 dashboard 或 popup 打开即可

## 技术约束

- 扩展的 `background.js` 不加载 `storage.js`(架构约束),`mcp-connector.js` 直接用 `chrome.storage.local` + `JT_CONFIG.storageKeys` 读写
- 每个 AI 助手启动一个独立的 server.js 进程(stdio 传输),默认连接统一端口 **8765**(`--ws-port` 仅供高级自定义,8766/8767 已废弃)
- 扩展连接统一端口 `WS_PORTS = [8765]`,处理请求/响应
- 数据一致性由 `chrome.storage.local` 保证(存储在扩展侧,所有 server 进程通过 WS 访问同一个扩展)
- 仅监听 `127.0.0.1`,不对外网开放
