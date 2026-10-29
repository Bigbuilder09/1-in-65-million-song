/* Saved games are deterministic event logs: the seed and all completed inputs.
   Replaying rebuilds async continuations and scheduled callbacks without serializing them.
   Keep the engine identifier fixed only while story/control flow remains compatible. */
window.SaveGame = (() => {
  const ENGINE = 'o65m-replay-1';
  let bucket = 'guest', records = [], active = null, cursor = 0, timer;
  let syncing = null, conflict = null, tabBlocked = false, menuRefresh, undoId = null;
  let pendingCancel = null, restartInFlight = false;
  let lastCheckpoint = null, queuedCloud = null, stopWatching = null, lastSyncSucceeded = false;
  const conflictWaiters = [];
  let reachedLivePrompt = false;
  const status = document.createElement('span');
  const bar = document.createElement('div');
  bar.id = 'saveBar';
  bar.hidden = true;
  bar.innerHTML = '<button type="button" id="charactersBtn" disabled>ตัวละครของฉัน</button><button type="button" id="syncBtn" hidden>บันทึกก่อนย้ายเครื่อง</button>';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  bar.append(status);
  document.body.append(bar);
  const message = text => { status.textContent = text; };
  const key = () => `o65m_characters_v1:${bucket}`;
  const id = () => crypto.randomUUID ? crypto.randomUUID() : `c${Date.now()}${Math.random().toString(36).slice(2)}`;
  const clone = x => JSON.parse(JSON.stringify(x));
  const validGame = g => g && Number.isInteger(g.seed) && g.seed >= 0 && g.seed <= 4294967295
    && Array.isArray(g.events)
    && g.events.every(e => e && typeof e.gate === 'string' && e.gate.length < 40
      && (e.value === null || Number.isInteger(e.value)
        || (e.gate === 'kid-name' && typeof e.value === 'string' && e.value.trim().length > 0 && [...e.value].length <= 40)
        || (Array.isArray(e.value) && e.value.length <= 100 && e.value.every(Number.isInteger))
        || (e.value && ['child', 'new', 'reborn'].includes(e.value.t)
          && (e.value.i === undefined || Number.isInteger(e.value.i)))));
  function persist() {
    if (tabBlocked) return false;
    try { localStorage.setItem(key(), JSON.stringify(records)); return true; }
    catch (e) { message('บันทึกในเครื่องไม่ได้ กรุณาตรวจพื้นที่จัดเก็บเว็บไซต์'); return false; }
  }
  function fromCloud(remote) {
    if (remote.engine !== ENGINE) throw new Error('เซฟนี้ใช้เกมคนละเวอร์ชัน');
    const game = JSON.parse(remote.payload);
    if (!validGame(game)) throw new Error('รูปแบบเซฟไม่ถูกต้อง');
    return {
      id: remote.id, engine: ENGINE, game, name: remote.name,
      age: remote.age, generation: remote.generation,
      updatedAt: remote.updatedAt?.toMillis?.() || Date.now(),
      cloudRevision: remote.revision, dirty: false,
    };
  }
  function checkpoint() {
    if (!active || active.game.deleted) return;
    const p = typeof CUR !== 'undefined' ? CUR.p : null;
    const metadataChanged = p && (active.name !== p.name || active.age !== p.age || active.generation !== p.gen);
    if (p) { active.name = p.name; active.age = p.age; active.generation = p.gen; }
    const version = JSON.stringify(active.game);
    // Ignore metadata reconstructed by replay, but save age/name changes after new decisions.
    const wasLive = reachedLivePrompt; reachedLivePrompt = true;
    if (version === lastCheckpoint && (!wasLive || !metadataChanged)) {
      if (!wasLive) message(active.dirty ? 'บันทึกในเครื่องแล้ว · รอซิงก์' : 'โหลดเซฟแล้ว · พร้อมเล่นต่อ');
      return;
    }
    lastCheckpoint = version;
    active.updatedAt = Date.now(); active.dirty = true;
    if (persist()) message(bucket === 'guest' ? 'บันทึกในเครื่องแล้ว' : 'บันทึกในเครื่องแล้ว · รอซิงก์');
    schedule();
  }
  function receiveCloud(cloud) {
    if (tabBlocked || CloudSave.user?.uid !== bucket) return;
    if (syncing) { queuedCloud = cloud; return; }
    mergeCloud(cloud);
  }
  function mergeCloud(cloud) {
    for (const remote of cloud) {
      try {
        const record = fromCloud(remote), local = records.find(r => r.id === record.id);
        if (!local) { records.push(record); continue; }
        if (record.cloudRevision <= (local.cloudRevision || 0)) continue;
        if (conflict?.local === local) { conflict.remote = remote; continue; }
        if (JSON.stringify(record.game) === JSON.stringify(local.game)) {
          local.cloudRevision = record.cloudRevision; local.dirty = false;
          continue;
        }
        if (local.dirty || active === local) {
          // Never replace an event log underneath the running game.
          if (!conflict) conflict = { local, remote };
        } else records[records.indexOf(local)] = record;
      } catch (e) { console.warn('Skipped incompatible cloud save', e.message); }
    }
    persist(); menuRefresh?.();
    if (conflict) { message('มีเซฟจากอีกเครื่อง กรุณาเลือกเวอร์ชัน'); showConflict(); }
  }
  function schedule() {
    if (bucket === 'guest' || conflict || timer) return;
    timer = setTimeout(() => { timer = null; sync({ pull: false }); }, 15000);
  }
  async function sync({ pull = true } = {}) {
    if (tabBlocked) return;
    if (bucket === 'guest') { message('เซฟอยู่ในเครื่อง · เข้าสู่ระบบเพื่อบันทึกออนไลน์'); return; }
    if (syncing) return syncing;
    if (conflict) { showConflict(); return; }
    if (CloudSave.user?.uid !== bucket) { message('บัญชีเปลี่ยน กรุณาโหลดหน้าใหม่'); return; }
    clearTimeout(timer); timer = null;
    syncing = (async () => {
      // Yield before finally can clear the shared promise, including no-op syncs.
      await Promise.resolve();
      lastSyncSucceeded = false;
      try {
        if (pull) mergeCloud(await CloudSave.list());
        if (tabBlocked || conflict || CloudSave.user?.uid !== bucket) return;
        for (const record of records.filter(r => r.dirty)) {
          if (tabBlocked || CloudSave.user?.uid !== bucket) return;
          const sent = clone(record), sentVersion = JSON.stringify(sent.game);
          if (new TextEncoder().encode(JSON.stringify(sent.game)).length >= 790000) {
            throw new Error('ประวัติชีวิตนี้ยาวเกินขนาดเซฟออนไลน์ กรุณาเริ่มตัวละครใหม่');
          }
          message('กำลังบันทึกออนไลน์…');
          const result = await CloudSave.write(sent);
          if (result.conflict) {
            conflict = { local: record, remote: result.conflict };
            message('มีเซฟจากอีกเครื่อง กรุณาเลือกเวอร์ชัน'); showConflict(); return;
          }
          record.cloudRevision = result.revision;
          record.dirty = JSON.stringify(record.game) !== sentVersion;
          persist();
        }
        lastSyncSucceeded = true;
        message(records.some(r => r.dirty) ? 'มีความคืบหน้าใหม่ · รอซิงก์' : 'บันทึกออนไลน์แล้ว ✓');
      } catch (e) {
        console.warn('Cloud save failed', e.code || e.message);
        message('เซฟออนไลน์ยังไม่สำเร็จ · เก็บในเครื่องไว้แล้ว');
      } finally {
        syncing = null;
        if (queuedCloud) { const cloud = queuedCloud; queuedCloud = null; receiveCloud(cloud); }
        if (!tabBlocked && !conflict && records.some(r => r.dirty)) schedule();
      }
    })();
    return syncing;
  }
  function node(tag, text, parent) {
    const el = document.createElement(tag); el.textContent = text; if (parent) parent.append(el); return el;
  }
  function button(text, parent, fn) {
    const b = node('button', text, parent); b.type = 'button'; b.className = 'go ghost';
    b.addEventListener('click', fn); return b;
  }
  function dialog(title) {
    const d = document.createElement('dialog'); d.className = 'saveDialog';
    const h = node('h2', title, d); h.id = `save-title-${id()}`; d.setAttribute('aria-labelledby', h.id);
    d.addEventListener('keydown', e => e.stopPropagation()); document.body.append(d);
    d.addEventListener('close', () => d.remove(), { once: true }); return d;
  }
  function showConflict() {
    if (!conflict) return;
    const existing = document.querySelector('#saveConflict');
    if (existing) { existing.refreshSaveDetails?.(); return; }
    const d = dialog('พบเซฟจากอีกเครื่อง'); d.id = 'saveConflict';
    node('p', 'อีกเครื่องมีเซฟใหม่ เลือกโหลดออนไลน์เพื่อเล่นต่อ หรือเก็บทั้งสองชุดหากต้องการรักษาความคืบหน้าเครื่องนี้', d);
    const details = node('div', '', d);
    const describe = (label, record) => {
      const when = record.updatedAt ? new Date(record.updatedAt).toLocaleString('th-TH') : 'ไม่ทราบเวลา';
      return `${label}: ${record.name} · อายุ ${record.age} ปี · รุ่นที่ ${record.generation} · ${when}`;
    };
    const renderDetails = () => {
      details.replaceChildren();
      node('p', describe('เครื่องนี้', conflict.local), details);
      try { node('p', describe('ออนไลน์', fromCloud(conflict.remote)), details); }
      catch (_) { node('p', 'เซฟออนไลน์ใช้เกมคนละเวอร์ชัน กรุณาติดต่อผู้ดูแล', details); }
    };
    renderDetails();
    d.refreshSaveDetails = renderDetails;
    button('โหลดเซฟออนไลน์', d, () => {
      try {
        const remote = fromCloud(conflict.remote), at = records.indexOf(conflict.local);
        records[at] = remote;
        if (!persist()) { records[at] = conflict.local; return; }
        stopWatching?.(); tabBlocked = true; clearTimeout(timer);
        sessionStorage.setItem('o65m_open', remote.id); location.reload();
      } catch (e) { alert(e.message); }
    });
    button('เก็บทั้งสองชุด', d, () => {
      try {
        const old = conflict.local, remote = fromCloud(conflict.remote);
        const previous = { id: old.id, cloudRevision: old.cloudRevision, dirty: old.dirty };
        old.id = id(); old.cloudRevision = 0; old.dirty = true;
        records.push(remote);
        if (!persist()) { records.pop(); Object.assign(old, previous); return; }
        conflict = null; d.close();
        for (const resolve of conflictWaiters.splice(0)) resolve();
        sync(); menuRefresh?.();
      } catch (e) { alert(e.message); }
    });
    button('เล่นต่อในเครื่องนี้ก่อน', d, () => d.close()); d.showModal();
  }
  function openRecord(record) {
    if (record.game.deleted) throw new Error('ตัวละครนี้ถูกลบแล้ว');
    if (active?.id === record.id) return false;
    if (!validGame(record.game) || record.engine !== ENGINE) throw new Error('เซฟไม่รองรับเกมเวอร์ชันนี้');
    sessionStorage.setItem('o65m_open', record.id); location.reload(); return true;
  }
  function createRecord(game) {
    const record = { id: id(), engine: ENGINE,
      game: game || { seed: crypto.getRandomValues(new Uint32Array(1))[0], events: [], policeRoutes: 1, economyVersion: 1, policeProgression: 1, childhoodVersion: 1, balanceFixFrom: 0, billionaireFrom: 0, clubMoralFrom: 0, clubRandomFrom: 0, storyV2From: 0, storyV3From: 0, storyV4From: 0, storyV5From: 0, storyV6From: 0, bossStoryFrom: 0, memorialStoryFrom: 0, bossCombatFrom: 0, caseResolutionFrom: 0 },
      name: 'ชีวิตใหม่', age: 0, generation: 1, updatedAt: Date.now(), cloudRevision: 0, dirty: true };
    records.push(record);
    if (!persist()) { records.pop(); throw new Error('บันทึกไม่ได้ กรุณาอนุญาตพื้นที่จัดเก็บเว็บไซต์ก่อนเล่น'); }
    return record;
  }
  async function loginWithGoogle(control, errorBox) {
    control.disabled = true;
    const reloadAfterLogin = () => {
      try { sessionStorage.setItem('o65m_skip_update', '1'); } catch (_) {}
      location.reload();
    };
    try { await CloudSave.login(); reloadAfterLogin(); }
    catch (e) {
      // Auth can finish in another tab while this popup is closing.
      if (CloudSave.user) { reloadAfterLogin(); return; }
      console.warn('Google sign-in failed', e.code || e.message);
      const reasons = {
        'auth/popup-closed-by-user': 'หน้าต่าง Google ถูกปิดก่อนเข้าสู่ระบบเสร็จ กรุณากดเข้าสู่ระบบอีกครั้ง',
        'auth/popup-blocked': 'เบราว์เซอร์บล็อกหน้าต่าง Google กรุณาอนุญาตป๊อปอัปสำหรับเว็บนี้แล้วลองอีกครั้ง',
        'auth/cancelled-popup-request': 'มีหน้าต่างเข้าสู่ระบบเปิดอยู่แล้ว กรุณาทำรายการในหน้าต่างนั้นให้เสร็จ',
        'auth/unauthorized-domain': `ยังไม่ได้อนุญาตโดเมน ${location.hostname} กรุณาเพิ่ม ${location.hostname} ใน Firebase Console → Authentication → Settings → Authorized domains (ไม่ต้องใส่ http:// หรือพอร์ต)`,
        'auth/operation-not-allowed': 'ยังไม่ได้เปิด Google ใน Firebase Authentication → Sign-in method',
        'auth/invalid-api-key': 'ค่าตั้งค่า Firebase ไม่ถูกต้อง กรุณาตรวจ API key ของเว็บแอป',
        'auth/configuration-not-found': 'ยังตั้งค่า Firebase Authentication ไม่ครบ กรุณาเปิด Google provider',
        'auth/network-request-failed': 'ติดต่อ Google ไม่ได้ กรุณาตรวจการเชื่อมต่อหรือส่วนขยายที่บล็อกคำขอ',
        'auth/web-storage-unsupported': 'เบราว์เซอร์ไม่อนุญาตให้เก็บสถานะเข้าสู่ระบบ กรุณาอนุญาตพื้นที่เว็บไซต์',
        'auth/operation-not-supported-in-this-environment': 'เปิดไฟล์ START-LOCAL.cmd ในโฟลเดอร์เกม แล้วเล่นผ่าน http://localhost:8765/index.html เพื่อใช้ Google Login หรือเลือกเล่นแบบ Guest จากไฟล์นี้',
        'firebase/loading': 'ระบบเข้าสู่ระบบยังโหลดไม่เสร็จ กรุณารอสักครู่แล้วกดอีกครั้ง',
      };
      const reason = reasons[e.code] || 'เข้าสู่ระบบไม่สำเร็จ';
      const detail = e.code || e.message || 'unknown-error';
      const text = `${reason} (${detail})`;
      if (errorBox) errorBox.textContent = text; else message(text);
      control.disabled = false;
      if (CloudSave.error) CloudSave.retry();
    }
  }
  function guestRecord() {
    // Keep existing guest progress, but never expose a character-management flow.
    return records.filter(r => !r.game.deleted).sort((a,b) => b.updatedAt - a.updatedAt)[0] || createRecord();
  }
  function removeRecord(record) {
    if (!confirm(`ลบตัวละคร “${record.name}” และความคืบหน้าของตระกูลนี้หรือไม่?`)) return;
    record.game.deleted = true; record.dirty = true; record.updatedAt = Date.now();
    if (!persist()) { delete record.game.deleted; return; }
    undoId = record.id;
    sessionStorage.setItem(`o65m_undo_delete:${bucket}`, undoId);
    if (active?.id === record.id) {
      // The next page uploads the tombstone. Do not race an upload against reload.
      active = null; tabBlocked = true; clearTimeout(timer); location.reload(); return;
    }
    menuRefresh?.(); sync();
  }
  async function library(initial = false) {
    if (bucket === 'guest') {
      if (initial) return Promise.resolve(guestRecord());
      const control = document.querySelector('#charactersBtn');
      return loginWithGoogle(control);
    }
    await sync();
    if (conflict) {
      await new Promise(resolve => conflictWaiters.push(resolve));
      return library(initial);
    }
    if (tabBlocked) return new Promise(() => {});
    return new Promise(resolve => {
      const d = dialog(records.some(r => !r.game.deleted) ? 'เล่นต่อจากชีวิตเดิม' : 'เริ่มชีวิตแรกของคุณ');
      node('p', `บัญชี ${CloudSave.user?.displayName || CloudSave.user?.email || ''}`, d);
      const list = node('div', '', d);
      const pick = record => {
        try {
          if (conflict || tabBlocked) { showConflict(); return; }
          if (initial) { resolve(record); d.close(); }
          else if (!openRecord(record)) d.close();
        } catch (e) { alert(e.message); }
      };
      function render() {
        list.replaceChildren();
        const visible = records.filter(r => !r.game.deleted);
        const heading = d.querySelector('h2');
        if (heading) heading.textContent = visible.length ? 'เล่นต่อจากชีวิตเดิม' : 'เริ่มชีวิตแรกของคุณ';
        if (!visible.length) node('p', 'ยังไม่มีตัวละคร เริ่มชีวิตใหม่แล้วเราจะบันทึกให้โดยอัตโนมัติ', list);
        for (const record of visible.sort((a,b) => b.updatedAt - a.updatedAt)) {
          const card = node('div', '', list); card.className = 'saveCard';
          node('strong', record.name, card);
          node('p', `อายุ ${record.age} ปี · รุ่นที่ ${record.generation}`, card);
          button(active?.id === record.id ? 'กลับไปเล่น' : 'เล่นต่อ', card, () => pick(record));
          const remove = button('ลบตัวละคร', card, () => removeRecord(record));
          remove.className += ' danger';
        }
        const deleted = records.find(r => r.id === undoId && r.game.deleted);
        if (deleted) button('ยกเลิกการลบล่าสุด', list, () => {
          delete deleted.game.deleted; deleted.dirty = true; deleted.updatedAt = Date.now();
          if (!persist()) { deleted.game.deleted = true; return; }
          undoId = null; sessionStorage.removeItem(`o65m_undo_delete:${bucket}`); render(); sync();
        });
      }
      menuRefresh = render; render();
      button('เริ่มตัวละครใหม่', d, () => {
        try { pick(createRecord()); } catch (e) { alert(e.message); }
      });
      button('ออกจากระบบ', d, async event => {
        const control = event.currentTarget; control.disabled = true;
        try { await CloudSave.logout(); location.reload(); }
        catch (_) { control.disabled = false; node('p', 'ออกจากระบบไม่สำเร็จ กรุณาลองอีกครั้ง', d); }
      });
      d.addEventListener('cancel', e => { if (initial) e.preventDefault(); });
      d.addEventListener('close', () => { menuRefresh = null; if (initial) resolve(null); });
      d.showModal();
    });
  }
  function restartGame() {
    if (!active || tabBlocked || restartInFlight || api.replaying || !pendingCancel || document.querySelector('#restartDialog')) return;
    const d = dialog('เริ่มต้นใหม่หรือไม่?'); d.id = 'restartDialog';
    node('p', 'จะสุ่มตัวละครใหม่และกลับไปหน้าเกิด จากนั้นเลือกโรงเรียนใหม่ ตัวละครเดิมและตัวเลือกที่บันทึกไว้จะยังเก็บอยู่ในเครื่อง', d);
    const error = node('p', '', d); error.id = 'restartError'; error.setAttribute('role', 'alert');
    const cancel = button('เล่นชีวิตนี้ต่อ', d, () => d.close());
    const begin = button('ยืนยัน เริ่มชีวิตใหม่', d, () => {
      if (tabBlocked || !active || restartInFlight || !pendingCancel) { error.textContent = 'ยังเริ่มใหม่ไม่ได้ กรุณากลับไปหน้าตัวเลือกปัจจุบันก่อน'; return; }
      begin.disabled = true;
      try {
        checkpoint();
        if (!persist()) throw new Error('ยังเก็บชีวิตเดิมไม่ได้ กรุณาตรวจพื้นที่เว็บไซต์แล้วลองอีกครั้ง');
        const fresh = createRecord();
        // End the old async game before boot starts the new one. No reload or
        // session-storage handoff is needed, including when opened via file:.
        restartInFlight = true;
        document.querySelector('#restartBtn').disabled = true;
        const stop = pendingCancel;
        const signal = Object.assign(new Error('Start a fresh life'), { code:'O65M_RESTART', record:fresh });
        d.close(); stop(signal);
      } catch (e) {
        begin.disabled = false; error.textContent = e.message || 'เริ่มใหม่ไม่สำเร็จ กรุณาลองอีกครั้ง';
      }
    });
    d.showModal(); cancel.focus();
  }

  const api = {
    get replaying() { return !!active && cursor < active.game.events.length; },
    get active() { return active; },
    get signedIn() { return bucket !== 'guest'; },
    bindEntry(el, resolve) {
      const google = el.querySelector('#googleLoginBtn');
      const errorBox = el.querySelector('#loginError');
      google.disabled = !CloudSave.configured;
      google.addEventListener('click', () => loginWithGoogle(google, errorBox));
      el.querySelector('#guestPlayBtn').addEventListener('click', () => {
        try { resolve(guestRecord()); } catch (e) { errorBox.textContent = e.message; }
      });
    },
    get cursor() { return cursor; },
    nameKid(o, renderer) {
      // Older event logs never contained name prompts: retain their original
      // generated names while replaying and keep all later inputs aligned.
      if (api.replaying && active.game.events[cursor].gate !== 'kid-name') return Promise.resolve(o.kid.name);
      return api.gate('kid-name', renderer);
    },
    seeded(seed) {
      let state = seed >>> 0;
      return () => { state += 0x6D2B79F5; let t = state; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
    },
    gate(label, renderer) {
      if (!active) return new Promise(renderer);
      if (api.replaying) {
        const event = active.game.events[cursor++];
        if (event.gate !== label) throw new Error('เซฟนี้ไม่รองรับเกมเวอร์ชันปัจจุบัน กรุณาติดต่อผู้ดูแลเกม');
        return Promise.resolve(clone(event.value));
      }
      checkpoint();
      document.querySelector('#restartBtn').disabled = tabBlocked;
      return new Promise((resolve, reject) => {
        let done = false;
        const cancel = error => {
          if (done) return; done = true;
          if (pendingCancel === cancel) pendingCancel = null;
          reject(error);
        };
        pendingCancel = cancel;
        const finish = value => {
          if (done || tabBlocked) return; done = true;
          if (pendingCancel === cancel) pendingCancel = null;
          active.game.events.push({ gate: label, value: value === undefined ? null : clone(value) });
          cursor++; checkpoint(); resolve(value);
        };
        try { renderer(finish, cancel); } catch (e) { cancel(e); }
      });
    },
    async init() {
      await Promise.race([CloudSave.ready, new Promise(r => setTimeout(r, 8000))]);
      bucket = CloudSave.user?.uid || 'guest';
      undoId = sessionStorage.getItem(`o65m_undo_delete:${bucket}`);
      try {
        records = JSON.parse(localStorage.getItem(key()) || '[]');
        if (!Array.isArray(records)) throw new Error('Invalid local saves');
        records = records.filter(r => r && typeof r.id === 'string' && r.engine === ENGINE && validGame(r.game));
      } catch (e) { records = []; message('อ่านเซฟในเครื่องไม่ได้ กรุณาลองโหลดหน้าใหม่'); }
      if (bucket !== 'guest') {
        try {
          const cloud = await Promise.race([CloudSave.list(), new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 8000))]);
          mergeCloud(cloud);
          persist(); message('โหลดตัวละครแล้ว');
        } catch (e) { message('โหลดออนไลน์ไม่ได้ · ใช้เซฟในเครื่องได้'); }
      } else message(CloudSave.error ? 'เชื่อมต่อ Firebase ไม่ได้ · เล่นแบบผู้เยี่ยมชมได้' : 'เซฟในเครื่องพร้อมใช้งาน');
      let migrated = false;
      for(const record of records){
        if(!record.game.deleted && !Number.isInteger(record.game.balanceFixFrom)){
          record.game.balanceFixFrom = record.game.events.length; record.dirty = true; migrated = true;
        }
        if(!record.game.deleted && !Number.isInteger(record.game.billionaireFrom)){
          record.game.billionaireFrom=record.game.events.length; record.dirty=true; migrated=true;
        }
        if(!record.game.deleted && !Number.isInteger(record.game.clubMoralFrom)){
          record.game.clubMoralFrom=record.game.events.length; record.dirty=true; migrated=true;
        }
        if(!record.game.deleted && !Number.isInteger(record.game.clubRandomFrom)){
          record.game.clubRandomFrom=record.game.events.length; record.dirty=true; migrated=true;
        }
        // Story review v2: rebalanced police/childhood/club rules apply from the next unplayed input.
        if(!record.game.deleted && !Number.isInteger(record.game.storyV2From)){
          record.game.storyV2From=record.game.events.length; record.dirty=true; migrated=true;
        }
        // Story v3: police investigation cases and the high-stakes club rival.
        if(!record.game.deleted && !Number.isInteger(record.game.storyV3From)){
          record.game.storyV3From=record.game.events.length; record.dirty=true; migrated=true;
        }
        // Story v4: magic school cast, romance, shadow-agent mystery and Rahu.
        if(!record.game.deleted && !Number.isInteger(record.game.storyV4From)){
          record.game.storyV4From=record.game.events.length; record.dirty=true; migrated=true;
        }
        // Story v5: dates in the magic romance route.
        if(!record.game.deleted && !Number.isInteger(record.game.storyV5From)){
          record.game.storyV5From=record.game.events.length; record.dirty=true; migrated=true;
        }
        // Battles already present in old logs retain their original input sequence.
        if(!record.game.deleted && !Number.isInteger(record.game.caseResolutionFrom)){
          record.game.caseResolutionFrom=record.game.events.length; record.dirty=true; migrated=true;
        }
        if(!record.game.deleted && !Number.isInteger(record.game.bossCombatFrom)){
          record.game.bossCombatFrom=record.game.events.length; record.dirty=true; migrated=true;
        }
        // Farewell scenes apply after the inputs already recorded in an older save.
        if(!record.game.deleted && !Number.isInteger(record.game.memorialStoryFrom)){
          record.game.memorialStoryFrom=record.game.events.length; record.dirty=true; migrated=true;
        }
        // Extra boss scenes must not be injected into previously recorded screen inputs.
        if(!record.game.deleted && !Number.isInteger(record.game.bossStoryFrom)){
          record.game.bossStoryFrom=record.game.events.length; record.dirty=true; migrated=true;
        }
        // Story v6: the blond rival's arc (school, adult life, dragon in the final battle).
        if(!record.game.deleted && !Number.isInteger(record.game.storyV6From)){
          record.game.storyV6From=record.game.events.length; record.dirty=true; migrated=true;
        }
      }
      if(migrated)persist();
      document.querySelector('#syncBtn').hidden = bucket === 'guest';
      document.querySelector('#syncBtn').onclick = async event => {
        const control = event.currentTarget; control.disabled = true;
        message('กำลังตรวจสอบและบันทึกออนไลน์…');
        try {
          // Drain decisions made during an in-flight upload before confirming a handoff.
          do { await sync(); } while (!tabBlocked && !conflict && CloudSave.user?.uid === bucket && records.some(r => r.dirty) && lastSyncSucceeded);
          if (!tabBlocked && !conflict && CloudSave.user?.uid === bucket && lastSyncSucceeded && !records.some(r => r.dirty)) message('บันทึกออนไลน์แล้ว ✓ เปิดอีกเครื่องด้วยบัญชีเดิมได้');
        } finally { control.disabled = false; }
      };
      document.querySelector('#charactersBtn').disabled = false;
      document.querySelector('#charactersBtn').textContent = bucket === 'guest' ? 'เข้าสู่ระบบด้วย Google' : 'ตัวละครของฉัน';
      document.querySelector('#charactersBtn').onclick = () => library();
      bar.hidden = true;
      if (bucket !== 'guest') {
        if (records.some(r => r.dirty)) schedule();
        stopWatching?.();
        stopWatching = CloudSave.watch(receiveCloud, e => {
          console.warn('Cloud updates unavailable', e.code || e.message);
          message('รับเซฟจากอีกเครื่องไม่ได้ · กดบันทึกก่อนย้ายเครื่องเพื่อลองใหม่');
        });
      }
      const requested = sessionStorage.getItem('o65m_open'); sessionStorage.removeItem('o65m_open');
      return records.find(r => r.id === requested && !r.game.deleted) || null;
    },
    library,
    start(record) {
      if (!validGame(record.game)) throw new Error('เซฟไม่ถูกต้อง');
      active = record; lastCheckpoint = JSON.stringify(record.game); reachedLivePrompt = false; cursor = 0; bar.hidden = false; restartInFlight = false;
      if (record.dirty) schedule();
      const restart = document.querySelector('#restartBtn'); restart.hidden = false; restart.disabled = true;
      message(record.game.events.length ? 'กำลังกลับไปจุดที่เล่นค้างไว้…' : 'เริ่มชีวิตใหม่');
      return record.game.seed;
    },
    sync,
  };
  document.querySelector('#restartBtn').addEventListener('click', restartGame);
  addEventListener('online', () => { if (bucket !== 'guest') sync(); });
  document.addEventListener('visibilitychange', () => { if (bucket !== 'guest') sync({ pull: !document.hidden }); });
  addEventListener('storage', e => {
    if (e.key !== key()) return;
    if (!active) {
      try {
        const incoming = JSON.parse(e.newValue || '[]');
        if (Array.isArray(incoming)) {
          records = incoming.filter(r => r && r.engine === ENGINE && validGame(r.game));
          menuRefresh?.();
        }
      } catch (_) {}
      return;
    }
    if (tabBlocked) return;
    tabBlocked = true; clearTimeout(timer); timer = null;
    document.querySelector('#restartBtn').disabled = true;
    // Stop the older tab before it can write over progress from a newer tab.
    const d = dialog('เกมถูกเปิดอีกแท็บ');
    node('p', 'เพื่อไม่ให้เซฟทับกัน กรุณาใช้แท็บเดียว แล้วโหลดหน้านี้ใหม่ก่อนเล่นต่อ', d);
    d.addEventListener('cancel', e => e.preventDefault());
    button('โหลดหน้าใหม่', d, () => location.reload()); d.showModal();
  });
  return api;
})();
function saveGate(label, renderer) { return SaveGame.gate(label, renderer); }
