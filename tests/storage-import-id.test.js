// ============================================================
// storage-import-id.test.js — M9 回归
// 核心回归:导入岗位若缺 id,storage 层(saveJob/saveJobs)必须自动补一个
//   稳定唯一 id,否则该岗位无法被 updateStatus/deleteJob/MCP 按 id 操作,
//   且无 URL/标题时去重会失效、可能重复入库。
// ============================================================

function loadStorage() {
  const code = global.readSrc('lib/storage.js');
  // eslint-disable-next-line no-eval
  (0, eval)(code + '\nglobalThis.JTStorage = (typeof JTStorage !== "undefined") ? JTStorage : undefined;');
}

describe('JTStorage 导入岗位缺 id 时自动补 id(M9 修复)', () => {
  let store;
  let origChrome;

  beforeEach(() => {
    store = {};
    origChrome = global.chrome;
    global.chrome = {
      storage: {
        local: {
          get(keys, cb) {
            const ks = Array.isArray(keys) ? keys : [keys];
            const res = {};
            ks.forEach(k => { if (Object.prototype.hasOwnProperty.call(store, k)) res[k] = store[k]; });
            cb(res);
          },
          set(obj, cb) {
            Object.keys(obj).forEach(k => { store[k] = obj[k]; });
            if (cb) cb();
          }
        }
      }
    };
    loadStorage();
  });

  afterEach(() => {
    global.chrome = origChrome;
  });

  test('批量导入无 id 岗位:每条都获得唯一非空 id,且可 getJobs 取回', async () => {
    const jobs = [
      { url: 'https://www.zhipin.com/job/101', title: '康复治疗师' },
      { url: 'https://www.zhipin.com/job/102', title: '推拿师' }
    ];
    const r = await JTStorage.saveJobs(jobs);
    expect(r.added).toBe(2);

    const stored = await JTStorage.getJobs();
    expect(stored.length).toBe(2);
    stored.forEach(j => {
      expect(typeof j.id).toBe('string');
      expect(j.id.length).toBeGreaterThan(0);
    });
    // 两条 id 互不相同
    expect(stored[0].id).not.toBe(stored[1].id);
  });

  test('无 id 岗位保存后,可经 updateStatus / deleteJob 按 id 操作', async () => {
    const r = await JTStorage.saveJobs([{ url: 'https://www.zhipin.com/job/201', title: '运动康复' }]);
    expect(r.added).toBe(1);
    const job = (await JTStorage.getJobs())[0];
    expect(typeof job.id).toBe('string');

    // 按 id 更新状态(updateStatus 返回更新后的 job 对象,失败返回 undefined)
    const u = await JTStorage.updateStatus(job.id, 'applied');
    expect(u).toBeTruthy();
    expect(u.status).toBe('applied');
    expect((await JTStorage.getJobs())[0].status).toBe('applied');

    // 按 id 删除(deleteJob 返回删除后剩余数量)
    const d = await JTStorage.deleteJob(job.id);
    expect(typeof d).toBe('number');
    expect((await JTStorage.getJobs()).length).toBe(0);
  });

  test('单条 saveJob 无 id:也能补 id', async () => {
    const r = await JTStorage.saveJob({ url: 'https://www.zhipin.com/job/301', title: '理疗师' });
    expect(r.action).toBe('added');
    expect(typeof r.job.id).toBe('string');
    expect(r.job.id.length).toBeGreaterThan(0);
  });

  test('重复导入同 URL 的无 id 岗位:不产生重复(去重按 URL 命中已有记录)', async () => {
    const j1 = { url: 'https://www.zhipin.com/job/401', title: '康复' };
    const j2 = { url: 'https://www.zhipin.com/job/401', title: '康复' }; // 同 URL,无 id

    const r1 = await JTStorage.saveJobs([j1]);
    expect(r1.added).toBe(1);

    const r2 = await JTStorage.saveJobs([j2]);
    expect(r2.added).toBe(0);
    expect(r2.updated).toBe(1); // 去重命中,更新而非新增

    const stored = await JTStorage.getJobs();
    expect(stored.length).toBe(1); // 仅一条,未重复
    expect(typeof stored[0].id).toBe('string');
  });

  test('CSV 导出防公式注入并正确处理回车', () => {
    const csv = JTStorage.exportCSV([{
      title: '=HYPERLINK("https://evil.example")', company: '+cmd', location: '-1+2',
      salaryRaw: '@SUM(1,2)', site: '测试', status: 'unseen', url: 'https://example.com/job/1',
      capturedAt: Date.now(), notes: '第一行\r第二行'
    }]);
    expect(csv).toContain("'=HYPERLINK");
    expect(csv).toContain("'+cmd");
    expect(csv).toContain("'-1+2");
    expect(csv).toContain("'@SUM");
    expect(csv).toContain('"第一行\r第二行"');
  });

  test('已有 id 的岗位不被覆盖(保留原 id)', async () => {
    const r1 = await JTStorage.saveJobs([{ id: 'fixed-1', url: 'https://www.zhipin.com/job/501', title: '康复A' }]);
    expect(r1.added).toBe(1);
    expect((await JTStorage.getJobs())[0].id).toBe('fixed-1');

    // 再次导入同 id + 同 URL,应更新且保留原 id
    const r2 = await JTStorage.saveJobs([{ id: 'fixed-1', url: 'https://www.zhipin.com/job/501', title: '康复A' }]);
    expect(r2.updated).toBe(1);
    const stored = await JTStorage.getJobs();
    expect(stored.length).toBe(1);
    expect(stored[0].id).toBe('fixed-1');
  });
});
