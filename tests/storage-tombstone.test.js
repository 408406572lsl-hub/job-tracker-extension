// ============================================================
// storage-tombstone.test.js — 测试"删除墓碑"
// 核心回归:用户删除的岗位,自动扫描重新采集时不应复活
// ============================================================

function loadStorage() {
  const code = global.readSrc('lib/storage.js');
  // eslint-disable-next-line no-eval
  (0, eval)(code + '\nglobalThis.JTStorage = (typeof JTStorage !== "undefined") ? JTStorage : undefined;');
}

describe('JTStorage 删除墓碑(已删岗位扫描不再复活)', () => {
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

  const jobA = { id: 'a1', url: 'https://www.zhipin.com/job/123', title: '康复治疗师' };

  test('删除后,扫描路径(saveJob respectTombstone)应跳过、不再复活', async () => {
    let r = await JTStorage.saveJob(jobA);
    expect(r.action).toBe('added');

    await JTStorage.deleteJob('a1');
    let jobs = await JTStorage.getJobs();
    expect(jobs.length).toBe(0);

    // 模拟重新扫描同岗
    r = await JTStorage.saveJob(jobA, { respectTombstone: true });
    expect(r.action).toBe('skipped');

    jobs = await JTStorage.getJobs();
    expect(jobs.length).toBe(0);
  });

  test('删除后,批量扫描(saveJobs respectTombstone)同样跳过', async () => {
    await JTStorage.saveJob(jobA);
    await JTStorage.deleteJob('a1');

    const r = await JTStorage.saveJobs([jobA], { respectTombstone: true });
    expect(r.added).toBe(0);
    expect(r.skipped).toBe(1);
    const jobs = await JTStorage.getJobs();
    expect(jobs.length).toBe(0);
  });

  test('手动保存(saveJob 默认不尊重墓碑)可绕过,重新加入', async () => {
    await JTStorage.saveJob(jobA);
    await JTStorage.deleteJob('a1');

    const r = await JTStorage.saveJob(jobA); // 默认 respectTombstone=false
    expect(r.action).toBe('added');
    const jobs = await JTStorage.getJobs();
    expect(jobs.length).toBe(1);
  });

  test('clearAll() 默认【保留】墓碑(已删岗位扫描不再复活)', async () => {
    await JTStorage.saveJob(jobA);
    await JTStorage.deleteJob('a1');

    await JTStorage.clearAll(); // 清空 jobs,但保留墓碑
    const del = await JTStorage.getDeletedKeys();
    expect(del.length).toBe(1); // 墓碑保留

    // 清空后重新扫描同岗仍被跳过
    const r = await JTStorage.saveJob(jobA, { respectTombstone: true });
    expect(r.action).toBe('skipped');
    const jobs = await JTStorage.getJobs();
    expect(jobs.length).toBe(0);
  });

  test('clearAll({tombstone:true}) 把被清空的岗位记入墓碑(管理面板"清空所有")', async () => {
    await JTStorage.saveJob(jobA); // jobs 含 jobA

    await JTStorage.clearAll({ tombstone: true }); // 清空 jobs + 把 jobA key 写入墓碑
    const del = await JTStorage.getDeletedKeys();
    expect(del.length).toBe(1);
    const jobs = await JTStorage.getJobs();
    expect(jobs.length).toBe(0);

    // 重新扫描 jobA 被跳过(符合"清空即永久删除"的语义)
    const r = await JTStorage.saveJob(jobA, { respectTombstone: true });
    expect(r.action).toBe('skipped');
  });

  test('clearDeletedJobs() 清空墓碑后,已删岗位可重新被扫描加回(重置入口)', async () => {
    await JTStorage.saveJob(jobA);
    await JTStorage.deleteJob('a1');
    expect((await JTStorage.getDeletedKeys()).length).toBe(1);

    await JTStorage.clearDeletedJobs();
    expect((await JTStorage.getDeletedKeys()).length).toBe(0);

    const r = await JTStorage.saveJob(jobA, { respectTombstone: true });
    expect(r.action).toBe('added');
  });

  test('批量删除多个岗位均记入墓碑', async () => {
    const jobB = { id: 'b1', url: 'https://www.zhipin.com/job/456', title: '推拿师' };
    await JTStorage.saveJob(jobA);
    await JTStorage.saveJob(jobB);

    await JTStorage.deleteJobs(['a1', 'b1']);
    const del = await JTStorage.getDeletedKeys();
    expect(del.length).toBe(2);
  });
});
