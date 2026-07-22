// ============================================================
// ext-bridge.js — 扩展通信桥接(WebSocket 版)
// 在本地启动一个 WebSocket 服务,等待 Chrome 扩展主动连接
// 职责:把 MCP server 的请求通过 WS 转发给扩展,等待扩展返回结果
//
// 设计理由:
//   1. server.js 的 stdin/stdout 已被 StdioServerTransport(MCP 协议)占用
//      不能再用 Native Messaging 协议抢同一个 stdio
//   2. WebSocket 是双向长连接,MV3 Service Worker 原生支持
//      断线重连比 connectNative 更稳,不受 SW 休眠端口断开困扰
//   3. 单进程双通道:stdin/stdout 给 Trae(MCP),WS(127.0.0.1:8765)给扩展
//      彻底避免"两个进程互不相干"的根因问题
// ============================================================

'use strict';

const { WebSocketServer } = require('ws');
const { CompanyEnricher } = require('./company-enricher');

// 天眼AI 企业 enrichment 单例(Node 端,密钥读 .env,不进扩展包)
const enricher = new CompanyEnricher();

class ExtBridge {
  /**
   * @param {number} port WebSocket 监听端口,默认 8765
   */
  constructor(port = 8765) {
    this._pending = new Map(); // id → {resolve, reject, timer}
    this._nextId = 1;
    this._connected = false;
    this._waiters = []; // 连接等待队列
    this._ws = null; // 当前扩展连接(只接受一个)

    this.wss = new WebSocketServer({ port, host: '127.0.0.1' });
    this.wss.on('connection', (ws) => this._onConnection(ws));
    this.wss.on('error', (e) => {
      console.error('[ext-bridge] wss error:', e.message);
    });

    console.error('[ext-bridge] WebSocket 服务已启动,端口 ' + port + ',等待扩展连接...');
  }

  _onConnection(ws) {
    // 只保留一个扩展连接,新连接到来时关闭旧的
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      try { this._ws.close(); } catch (_) {}
    }
    this._ws = ws;

    ws.on('message', (data) => this._onMessage(data));
    ws.on('close', () => {
      if (this._ws === ws) {
        this._ws = null;
        this._connected = false;
        // 拒绝所有 pending 请求
        for (const [id, p] of this._pending) {
          clearTimeout(p.timer);
          p.reject(new Error('扩展已断开'));
        }
        this._pending.clear();
        console.error('[ext-bridge] 扩展断开连接');
      }
    });
    ws.on('error', (e) => {
      console.error('[ext-bridge] ws error:', e.message);
    });

    console.error('[ext-bridge] 扩展已接入,等待 JT_MCP_CONNECTED 握手...');
  }

  _onMessage(data) {
    let msg;
    try {
      msg = JSON.parse(data.toString('utf8'));
    } catch (e) {
      console.error('[ext-bridge] 解析消息失败:', e.message);
      return;
    }

    // 扩展连接握手通知(可携带 tycApiKey:使用者自填的天眼查 Key,优先于 .env)
    if (msg.type === 'JT_MCP_CONNECTED') {
      if (msg.tycApiKey && msg.tycApiKey.trim()) {
        enricher.setApiKey(msg.tycApiKey);
        console.error('[ext-bridge] 已接收扩展注入的天眼查 Key(优先于 .env)');
      }
      this._connected = true;
      const waiters = this._waiters;
      this._waiters = [];
      waiters.forEach(fn => fn());
      console.error('[ext-bridge] 扩展握手成功,已就绪');
      return;
    }

    // 响应消息(带 _reqId 配对)
    if (msg._reqId && this._pending.has(msg._reqId)) {
      const p = this._pending.get(msg._reqId);
      this._pending.delete(msg._reqId);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error));
      else p.resolve(msg.result);
      return;
    }

    // 扩展主动发起的请求(带 action 且非本端 pending 响应)
    if (msg.action && msg._reqId != null) {
      this._handleExtensionRequest(msg).catch((e) => {
        if (this._ws && this._ws.readyState === WebSocket.OPEN) {
          this._ws.send(JSON.stringify({ _reqId: msg._reqId, error: e.message }));
        }
      });
    }
  }

  // 处理扩展主动发来的请求(enrichCompany / setTycKey / testTyc)
  async _handleExtensionRequest(msg) {
    const { action, params = {}, _reqId } = msg;
    let result;
    if (action === 'enrichCompany') {
      result = await this.enrichCompany(params);
    } else if (action === 'setTycKey') {
      // 使用者自填的 Key:注入 enricher(优先级高于 .env)
      enricher.setApiKey(params.apiKey || '');
      result = { ok: true, injected: !!(params.apiKey && params.apiKey.trim()) };
    } else if (action === 'testTyc') {
      // 用提供的 Key 临时验证天眼AI 连通性(不污染已注入的 key 状态)
      const testKey = (params.apiKey || '').trim();
      if (!testKey) throw new Error('未提供 Key');
      const prev = enricher._injectedKey;
      try {
        enricher.setApiKey(testKey);
        await enricher.init();
        // 验证通过:取一个示例企业确认能正常查询
        const sample = await enricher.searchCompany('腾讯');
        result = {
          ok: true,
          sample: (sample && sample[0] && sample[0].name) || '连通(无示例返回)',
        };
      } finally {
        // 还原为原先注入的 key(若本次仅是临时测试)
        enricher.setApiKey(prev || '');
      }
    } else {
      throw new Error('未知扩展请求: ' + action);
    }
    if (_reqId != null && this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify({ _reqId, result }));
    }
  }

  // 企业 enrichment(直连天眼AI,密钥在 .env)
  async enrichCompany(params = {}) {
    return enricher.enrich(params.companyName, {
      city: params.city || '',
      jobIndustry: params.jobIndustry || '',
    });
  }

  // 等待扩展连接(含握手)
  _waitForConnection(timeout = 5000) {
    if (this._connected) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('等待扩展连接超时(请确保扩展已加载,且 SW 在运行)')),
        timeout
      );
      this._waiters.push(() => { clearTimeout(timer); resolve(); });
    });
  }

  // 向扩展发送请求,等待响应
  // action: 'getJobs' / 'getStats' / 'getFilters' / 'searchJobs' / 'updateStatus' / 'exportJobs'
  async request(action, params = {}, timeout = 10000) {
    await this._waitForConnection();
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) {
      throw new Error('扩展连接已断开');
    }
    const id = this._nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error('扩展响应超时(' + action + ')'));
      }, timeout);

      this._pending.set(id, { resolve, reject, timer });
      this._ws.send(JSON.stringify({ _reqId: id, action, params }));
    });
  }

  // 便捷方法
  getJobs() { return this.request('getJobs'); }
  getStats() { return this.request('getStats'); }
  getFilters() { return this.request('getFilters'); }
  getAutoScan() { return this.request('getAutoScan'); }
  searchJobs(params) { return this.request('searchJobs', params); }
  updateStatus(params) { return this.request('updateStatus', params); }
  exportJobs(params) { return this.request('exportJobs', params); }
}

module.exports = { ExtBridge };
