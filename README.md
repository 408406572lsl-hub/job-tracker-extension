<h1 align="center">🎯 岗位猎手 —— 求职记录筛选助手</h1>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="license"></a>
</p>

## 🌐 English Summary

**Job Hunter** is a Chrome/Edge MV3 browser extension that turns "scrolling job boards" into "systematic job hunting".

- **Local-first, zero privacy leak** — all your job data stays in your browser's local storage. Nothing is uploaded or collected.
- **Tianyancha direct risk check** — query business anomalies, legal risks, and social insurance headcount *inside the extension*, before you apply.
- **Cross-industry AI fit analysis** — evaluates both your fit feasibility and the role's risk index, not tied to any single industry.
- **Resume parser & auto form-fill** — upload PDF/Word/TXT, get a structured profile, and auto-fill application forms in one click.
- **Background auto-scan & MCP Bridge** — schedule auto-scanning on BOSS Zhipin, and let AI assistants (Trae / WorkBuddy) filter and tag for you via MCP.

> Keywords: chrome extension job tracker, resume parser browser extension, local-first job search tool, tianyancha risk check, auto fill job application form, cross-industry AI fit analysis, privacy-safe recruitment assistant.

---

<h2 align="center">黑暗无论多么长，光明迟早总是会来的</h2>

<p align="center">
  <strong>
    我知道你心中有煎熬，有焦虑，像一柄长剑悬在头顶，随时可能落下。<br>
    黎明破晓之时，苦难都将化作勋章。
  </strong>
</p>

<p align="center">
  🦾 <strong>v1.5.56 重磅登场</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/%F0%9F%8F%86-GitHub%20Trending%20%7C%20本地优先%20%C2%B7%20AI%20避坑%20%C2%B7%20跨行业通用-blueviolet" alt="Repository Of The Day">
</p>

---

## 📌 目前该项目存在的问题

- 【重要】v1.5.56 已迁移为 **天眼查直连方案**，旧版 `8765` 桥接用户需在设置页重新填写 API Key。
- 【已知】MV3 Service Worker 休眠会导致 MCP Bridge 首次查询延迟约 5 秒；保持 Dashboard / Popup 打开可保活。
- 【计划】`host_permissions` 当前仍为 `<all_urls>`，后续版本会收窄到具体招聘站点（需验证自动填充跨站能力）。
- 【提醒】自动扫描依赖 BOSS 直聘登录态，平台风控可能导致列表刷新或详情回退，请合理使用随机延迟。
- 【协议】本项目采用 MIT 协议开源，可自由学习、修改、分发，但请保留版权声明，勿用于非法用途。

---

## 🚀 它能做什么

> 把「刷招聘站」变成「系统化求职」。

- **岗位采集与去重**：浏览 BOSS 直聘等站点时一键记录，重复岗位自动合并。
- **智能筛选**：城市 / 行业 / 薪资 / 状态多维过滤，快速定位目标。
- **AI 关系分析**：通用化适配评分，既看「你与岗位的匹配可行性」，也独立提示「岗位风险指数」，不绑定任何行业。
- **企业避坑**：扩展内直连天眼查，经营异常、司法风险、参保人数投前可查。
- **简历解析建档**：PDF / Word / TXT 上传即结构化，沉淀你的能力画像。
- **申请表单自动填充**：简历字段自动映射网页表单，秒填不手抖。
- **HR 回复 & 聊天辅助**：多版话术生成，半自动回复不冷场。
- **后台自动扫描**：设定条件后自动轮巡，新机会主动弹窗提醒。
- **AI 助手联动**：通过 MCP Bridge，Trae / WorkBuddy 等 AI 助手可直接帮你筛选、标记、扫描。

**所有数据只存浏览器本地，不上传、不收集，隐私零泄露。**

---

## 📦 快速开始

1. 下载 `job-tracker-v1.5.56.zip`（或克隆本仓库后加载已解压的扩展目录）。
2. 打开 Chrome / Edge → 扩展管理 → 开启「开发者模式」→ 加载已解压的扩展程序。
3. 在 BOSS 直聘浏览岗位，点击扩展图标开始记录。
4. 进入 Dashboard 查看、筛选、分析，按需填写天眼查 API Key 启用避坑功能。

---

## 🧪 本地开发

```bash
# 依赖安装（仅测试需要）
npm install
# 运行测试
npm test
```

> 测试 fixtures 中的公司名、地址均为虚构示例，不含任何真实个人数据。

---

## 🌴 源码地址

> 如果你也觉得求职这件事值得被更好地对待，欢迎 Star 与反馈。

- 主仓库：https://github.com/408406572lsl-hub/job-tracker-extension
- issue 反馈：https://github.com/408406572lsl-hub/job-tracker-extension/issues
- 作者：408406572lsl-hub（个人开发作品）

---

## 🔑 关键词 / Keywords

本地存储零隐私招聘插件 · 天眼查直连避坑浏览器扩展 · 简历解析自动填表工具 · 跨行业 AI 匹配度与风险分析 · BOSS直聘自动扫描 · MCP 联动 AI 助手筛选 · chrome extension job tracker · resume parser browser extension · local-first job search · tianyancha risk check · auto fill job application · privacy-safe recruitment assistant

---

<p align="center">
  <strong>愿每一个深夜投简历的人，都能在黎明前拿到属于自己的 offer。</strong>
</p>
