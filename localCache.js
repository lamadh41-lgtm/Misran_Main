/**
 * تخزين محلي للمتجر — يقلل قراءات Firebase لأقصى حد
 *
 * قاعدة ملزمة:
 * - الشبكة (Firestore) هي المصدر الرسمي الوحيد للحقيقة.
 * - المحلي تابع: يعرض ويخزّن نسخة، ولا يتخذ قرار حذف/إبقاء لوحده.
 * - أي حذف/تعديل حقيقي يتم على الشبكة أولاً، ثم يُحدَّث أو يُمسَح الكاش التابع.
 * - مثال: حذف منتج ≠ حذف المشتريات (لا شبكياً ولا محلياً).
 *
 * أول مرة: قراءة من الشبكة → حفظ محلي
 * نفس الجلسة بعد softFetch: من المحلي
 * جلسة جديدة / force: إعادة تحقق من الشبكة ثم تحديث المحلي

 *
 * ===== قاعدة الاستهلاك (إلزامية لأي كود جديد) =====
 * 1) لا تقرأ من الشبكة بيانات المستخدم لم يتفاعل معها (تبويب/لوحة مغلقة).
 * 2) onSnapshot فقط أثناء فتح الواجهة، ثم إلغاء الاشتراك فوراً.
 * 3) كل استعلام عليه limit مناسب؛ لا سحب غير محدود.
 * 4) استخدم softFetch/cachedFetch قبل getDocs المتكرر.
 * 5) لا بولنج خفي ولا timers تستهلك قراءات في الخلفية.
 * التفاصيل: PERFORMANCE_RULES.md
 */
const PREFIX = 'misran_cache_v1:';
const MAX_KEY_BYTES = 4.2 * 1024 * 1024; // حد تقريبي لكل مفتاح

function safeParse(raw) {
  try { return JSON.parse(raw); } catch { return null; }
}

/** تحويل Timestamps وكائنات Firestore لقيم قابلة للـ JSON */
export function toPlain(value) {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;
  // Firestore Timestamp
  if (typeof value.toDate === 'function' && typeof value.toMillis === 'function') {
    return { __ts: value.toMillis() };
  }
  if (value instanceof Date) return { __ts: value.getTime() };
  if (Array.isArray(value)) return value.map(toPlain);
  const out = {};
  for (const k of Object.keys(value)) {
    if (k === 'firestore' || typeof value[k] === 'function') continue;
    out[k] = toPlain(value[k]);
  }
  return out;
}

/** إعادة Timestamp تقريبي للعرض */
export function revive(value) {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;
  if (value.__ts != null && Object.keys(value).length === 1) {
    const d = new Date(value.__ts);
    return {
      __ts: value.__ts,
      toDate: () => d,
      toMillis: () => value.__ts
    };
  }
  if (Array.isArray(value)) return value.map(revive);
  const out = {};
  for (const k of Object.keys(value)) out[k] = revive(value[k]);
  return out;
}

export function cacheGet(key) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (!raw) return null;
    const parsed = safeParse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return revive(parsed.data);
  } catch {
    return null;
  }
}

export function cacheSet(key, data) {
  try {
    const payload = JSON.stringify({ t: Date.now(), data: toPlain(data) });
    if (payload.length > MAX_KEY_BYTES) {
      // كبير جداً — حاول بدون حقول ثقيلة
      console.warn('[cache] skip large key', key, payload.length);
      return false;
    }
    localStorage.setItem(PREFIX + key, payload);
    return true;
  } catch (e) {
    // مساحة ممتلئة — امسح أقدم مفاتيح
    try { cacheEvictOldest(5); localStorage.setItem(PREFIX + key, JSON.stringify({ t: Date.now(), data: toPlain(data) })); return true; }
    catch { return false; }
  }
}


/** عمر الكاش بالميلي ثانية من وقت الحفظ */
export function cacheAge(key) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (!raw) return null;
    const parsed = safeParse(raw);
    if (!parsed || !parsed.t) return null;
    return Date.now() - parsed.t;
  } catch { return null; }
}

/**
 * جلب مرن — الشبكة أصل، الكاش تابع فقط:
 * - يعرض/يرجع كاش بسرعة إن وُجد
 * - يعيد التحقق من الشبكة مرة كل جلسة (أو عند force / انتهاء maxAge)
 * - بعد أي كتابة: استدعِ networkInvalidate حتى لا يبقى كاش قديم يحجب الحقيقة
 */
export async function softFetch(key, fetcher, { sessionFlag, maxAgeMs = null, force = false } = {}) {
  const flag = sessionFlag || ('soft:' + key);
  let sessDone = false;
  try { sessDone = sessionStorage.getItem(flag) === '1'; } catch {}

  const cached = cacheGet(key);
  const age = cacheAge(key);
  const expired = maxAgeMs != null && age != null && age > maxAgeMs;

  // كاش فقط إذا تحققت الشبكة في هذه الجلسة ولم يُطلب force ولم ينتهِ العمر
  if (!force && cached != null && sessDone && !expired) {
    return { data: cached, fromCache: true, revalidated: false };
  }

  try {
    const data = await fetcher();
    if (data !== undefined && data !== null) cacheSet(key, data);
    else cacheRemove(key); // الشبكة قالت فاضي → امسح التابع
    try { sessionStorage.setItem(flag, '1'); } catch {}
    return { data, fromCache: false, revalidated: true };
  } catch (e) {
    // عند فشل الشبكة فقط: اسمح بالكاش كاحتياطي عرض
    if (cached != null) return { data: cached, fromCache: true, revalidated: false, error: e };
    throw e;
  }
}

/**
 * بعد أي كتابة على الشبكة: امسح الكاش التابع + علم الجلسة لإجبار إعادة التحقق
 * هذا يمنع سعر/عرض/شات/شارات قديمة من الظهور بعد التعديل
 */
export function networkInvalidate(...keysOrPrefixes) {
  for (const k of keysOrPrefixes) {
    if (!k) continue;
    if (String(k).endsWith(':') || String(k).endsWith('*')) {
      const pref = String(k).replace(/\*$/, '');
      cacheRemovePrefix(pref);
      // امسح soft flags المتعلقة
      try {
        const toDel = [];
        for (let i = 0; i < sessionStorage.length; i++) {
          const sk = sessionStorage.key(i);
          if (sk && sk.startsWith('soft:') && sk.includes(pref.replace(/:$/, ''))) toDel.push(sk);
        }
        toDel.forEach(sk => sessionStorage.removeItem(sk));
      } catch {}
    } else {
      cacheRemove(k);
      try {
        sessionStorage.removeItem('soft:' + k);
        sessionStorage.removeItem('softFetch:' + k);
      } catch {}
    }
  }
  // مشاريع عامة
  try {
    sessionStorage.removeItem('soft:projects');
    sessionStorage.removeItem('soft:news');
  } catch {}
}

export function cacheRemove(key) {
  try { localStorage.removeItem(PREFIX + key); } catch {}
}

export function cacheRemovePrefix(prefix) {
  try {
    const full = PREFIX + prefix;
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(full)) keys.push(k);
    }
    keys.forEach(k => localStorage.removeItem(k));
  } catch {}
}

function cacheEvictOldest(n = 3) {
  const items = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k || !k.startsWith(PREFIX)) continue;
    try {
      const p = safeParse(localStorage.getItem(k));
      items.push({ k, t: p?.t || 0 });
    } catch {}
  }
  items.sort((a, b) => a.t - b.t);
  items.slice(0, n).forEach(x => localStorage.removeItem(x.k));
}

/**
 * جلب مع كاش — افتراضياً يعيد التحقق من الشبكة (الكاش للعرض الاحتياطي فقط).
 * skipNetwork=true فقط لعرض لحظي غير حرج (ثم يُفضّل softFetch).
 * بعد الكتابة: networkInvalidate(key)
 */
export async function cachedFetch(key, fetcher, { force = true, skipNetwork = false } = {}) {
  const hit = cacheGet(key);
  if (skipNetwork && !force && hit !== null && hit !== undefined) {
    return { data: hit, fromCache: true };
  }
  try {
    const data = await fetcher();
    if (data !== undefined && data !== null) cacheSet(key, data);
    else cacheRemove(key);
    return { data, fromCache: false };
  } catch (e) {
    if (hit !== null && hit !== undefined) return { data: hit, fromCache: true, error: e };
    throw e;
  }
}

/** دمج عنصر في قائمة مخزنة محلياً (مثلاً بعد إضافة مشروع) */
export function cacheUpsertInList(listKey, item, idField = 'id') {
  const list = cacheGet(listKey);
  if (!Array.isArray(list)) {
    cacheSet(listKey, [item]);
    return;
  }
  const id = item[idField];
  const idx = list.findIndex(x => x && x[idField] === id);
  if (idx >= 0) list[idx] = { ...list[idx], ...item };
  else list.unshift(item);
  cacheSet(listKey, list);
}

export function cacheUserKey(uid) { return `user:${uid}`; }
export function cacheProductKey(id) { return `product:${id}`; }
export function cacheProjectsPageKey(page) { return `projects:page:${page}`; }
export function cacheNotifsKey(uid) { return `notifs:${uid}`; }
export function cacheChatsKey(uid) { return `chats:${uid}`; }
export function cachePurchasesKey(uid) { return `purchases:${uid}`; }
export function cacheSellerKey(id) { return `seller:${id}`; }
export function cacheSellerProdsKey(id) { return `sellerProds:${id}`; }
export function cacheMyProjectsKey(uid) { return `myProjects:${uid}`; }
export function cacheBalanceKey(uid) { return `balance:${uid}`; }
export function cacheTopupsKey(uid) { return `topups:${uid}`; }
export function cacheEarningsKey(uid) { return `earnings:${uid}`; }
export function cacheNewsKey() { return 'news:bar'; }
export function cacheOfficialKey() { return 'official:profile'; }

// كشف عام على window للاستخدام من صفحات بدون import معقد
if (typeof window !== 'undefined') {
  window.localCache = {
    get: cacheGet,
    set: cacheSet,
    remove: cacheRemove,
    removePrefix: cacheRemovePrefix,
    invalidate: networkInvalidate,
    networkInvalidate,
    fetch: cachedFetch,
    softFetch: softFetch,
    age: cacheAge,
    upsertInList: cacheUpsertInList,
    toPlain,
    revive,
    keys: {
      user: cacheUserKey,
      product: cacheProductKey,
      projectsPage: cacheProjectsPageKey,
      notifs: cacheNotifsKey,
      chats: cacheChatsKey,
      purchases: cachePurchasesKey,
      seller: cacheSellerKey,
      sellerProds: cacheSellerProdsKey,
      myProjects: cacheMyProjectsKey,
      balance: cacheBalanceKey,
      topups: cacheTopupsKey,
      earnings: cacheEarningsKey,
      news: cacheNewsKey,
      official: cacheOfficialKey
    }
  };
}

export default {
  cacheGet, cacheSet, cacheRemove, cacheRemovePrefix, cachedFetch, softFetch, networkInvalidate, cacheUpsertInList,
  toPlain, revive
};
