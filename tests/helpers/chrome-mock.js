// ============================================================
// chrome-mock.js — 共享的 chrome API mock
// 供所有测试文件使用,避免各自实现导致行为不一致
//
// 用法:
//   const { makeChrome, makeStorageLocal } = require('./helpers/chrome-mock');
//   beforeEach(() => {
//     const store = {};
//     global.chrome = makeChrome(store);
//   });
// ============================================================

const noop = () => {};

// 仅 mock chrome.storage.local(最小化,供 storage 测试用)
function makeStorageLocal(store) {
  return {
    get(keys, cb) {
      const ks = Array.isArray(keys) ? keys : [keys];
      const res = {};
      ks.forEach(k => {
        if (Object.prototype.hasOwnProperty.call(store, k)) res[k] = store[k];
      });
      cb(res);
    },
    set(obj, cb) {
      Object.keys(obj).forEach(k => { store[k] = obj[k]; });
      if (cb) cb();
    },
    remove(keys, cb) {
      (Array.isArray(keys) ? keys : [keys]).forEach(k => delete store[k]);
      if (cb) cb();
    }
  };
}

// 完整 chrome mock(含 runtime/tabs/alarms/contextMenus/action 等)
// 用 Proxy 兜底未实现的 API,避免测试因缺少 API 报错
function makeChrome(store) {
  const local = makeStorageLocal(store);
  const target = {
    storage: { local },
    runtime: {
      onInstalled: { addListener: noop },
      onMessage: { addListener: noop },
      sendMessage: noop,
      lastError: null
    },
    contextMenus: { create: noop, onClicked: { addListener: noop } },
    alarms: { create: noop, clear: noop, onAlarm: { addListener: noop } },
    tabs: { sendMessage: noop, query: noop },
    action: { setBadgeText: noop, setBadgeBackgroundColor: noop },
    notifications: { create: noop }
  };
  return new Proxy(target, {
    get(t, prop) {
      if (prop in t) return t[prop];
      // 未知 API:返回兜底 Proxy,任何方法调用都返回 noop
      return new Proxy({
        addListener: noop,
        create: noop,
        clear: noop,
        get: noop,
        set: noop,
        remove: noop,
        sendMessage: noop,
        query: noop,
        setBadgeText: noop
      }, {
        get(tt, p) { return (p in tt) ? tt[p] : noop; }
      });
    }
  });
}

module.exports = { makeChrome, makeStorageLocal, noop };
