/**
 * ============================================================
 * قاعدة استهلاك إلزامية (انظر PERFORMANCE_RULES.md):
 * - لا قراءات/listeners على شيء المستخدم لم يفتحه أو يتفاعل معه.
 * - كاش محلي + limit + إيقاف المستمع عند الإغلاق.
 * - أي ميزة جديدة تُبنى بنفس الأسلوب وإلا تُرفض.
 * ============================================================
 */
import { 
  auth, db, onAuthStateChanged, signOut,
  collection, doc, getDoc, getDocs, addDoc, updateDoc, deleteDoc, setDoc, query, where, orderBy, limit, startAfter, serverTimestamp, onSnapshot
} from './firebase.js';
import { cacheGet, cacheSet, cacheRemovePrefix, cacheRemove, networkInvalidate } from './localCache.js';


// ===== صلاحيات الأدمن + المالك =====
const OWNER_ADMIN_EMAIL = 'lamadh41@gmail.com';
let currentAdminUser = null;
let currentAdminData = null;
let currentAdminRoles = null; // { general, users, products, finance, tools, _owner }

function isOwnerEmail(email) {
  return (email || '').toLowerCase().trim() === OWNER_ADMIN_EMAIL;
}
function resolveAdminRoles(userData, email) {
  if (isOwnerEmail(email)) {
    return { general: true, users: true, products: true, finance: true, tools: true, _owner: true };
  }
  const r = userData?.adminRoles;
  if (!r || typeof r !== 'object') return null;
  if (!(r.general || r.users || r.products || r.finance || r.tools)) return null;
  return {
    general: !!r.general,
    users: !!r.users,
    products: !!r.products,
    finance: !!r.finance,
    tools: !!r.tools,
    _owner: false
  };
}

function applyAdminNavVisibility(roles) {
  if (!roles) return;
  document.querySelectorAll('.admin-sidebar [data-section]').forEach(link => {
    const need = link.getAttribute('data-role');
    if (!need) { link.classList.remove('d-none'); return; }
    if (need === 'owner') {
      link.classList.toggle('d-none', !roles._owner);
      return;
    }
    const ok = roles._owner || !!roles[need];
    link.classList.toggle('d-none', !ok);
  });
  document.querySelectorAll('[data-role-group="owner"]').forEach(el => {
    el.classList.toggle('d-none', !roles._owner);
  });
}

function gateAdminAccess() {
  return new Promise((resolve) => {
    onAuthStateChanged(auth, async (user) => {
      if (!user) {
        document.body.innerHTML = '<div class="container py-5 text-center"><div class="alert alert-warning">يجب تسجيل الدخول أولاً. <a href="index.html">العودة للموقع</a></div></div>';
        resolve(false);
        return;
      }
      currentAdminUser = user;
      try {
        const snap = await getDoc(doc(db, 'users', user.uid));
        currentAdminData = snap.exists() ? snap.data() : { email: user.email, name: user.displayName || '' };
      } catch (e) {
        currentAdminData = { email: user.email };
      }
      currentAdminRoles = resolveAdminRoles(currentAdminData, user.email);
      if (!currentAdminRoles) {
        document.body.innerHTML = '<div class="container py-5 text-center"><div class="alert alert-danger">غير مصرح لك بالدخول إلى لوحة الأدمن. <a href="index.html">العودة للموقع</a></div></div>';
        resolve(false);
        return;
      }
      const lbl = document.getElementById('adminUserLabel');
      if (lbl) lbl.textContent = (currentAdminData.name || user.email) + (currentAdminRoles._owner ? ' (المالك)' : ' (إداري)');
      applyAdminNavVisibility(currentAdminRoles);
      // اتصال فوري عند دخول لوحة الأدمن (بدون انتظار ضغط قسم)
      try {
        const connEl = document.getElementById('fbConnStatus');
        if (connEl) {
          connEl.innerHTML = '<span class="text-success"><i class="fas fa-check-circle me-1"></i>متصل بـ Firebase بنجاح</span>';
        }
        // لوحة التحكم ظاهرة افتراضياً — حمّل الإحصائيات فوراً
        const dash = document.getElementById('section-dashboard');
        if (dash && !dash.classList.contains('d-none')) {
          setTimeout(() => { try { loadStats(); } catch (_) {} }, 50);
        }
      } catch (_) {}
      resolve(true);
    });
  });
}

// تشغيل البوابة فوراً
const _adminReady = gateAdminAccess();


const ADMIN_PROJECT_CATEGORIES = ['برمجة وسكربتات', 'شخصيات وأفاتار', 'أسلحة وقتال', 'مركبات', 'بيئة وديكور', 'واجهات UI', 'تأثيرات VFX', 'أصوات وموسيقى', 'حركات Animation', 'قوالب مشاريع', 'تعريب وأدوات عربية', 'ألعاب كاملة', 'شبكات ومتعدد لاعبين', 'ذكاء اصطناعي', 'إضاءة ورندر', 'خامات ومواد Materials', 'أدوات محرر Editor', 'تعليم وشروحات', 'إضافات ومنصات', 'أخرى'];

function invalidateProjectCaches(projectId) {
  // الشبكة أصل — الكاش تابع: امسحه ليُعاد ملؤه من الشبكة فقط
  try {
    const keys = ['projects:', 'sellerProds:', 'myProjects:', 'admin:stats'];
    if (projectId) keys.unshift('product:' + projectId);
    networkInvalidate(...keys);
    // لا تلمس purchases — المشتريات مستقلة عن تعديل المنتج
  } catch (_) {}
}

/** نسبة العمولة المسجّلة على العملية وقت الشراء (لا تُعاد حسابها لاحقاً) */
function getPurchaseCommissionRate(p) {
  const r = parseFloat(p?.commissionPercent);
  if (isFinite(r) && r >= 0 && r <= 100) return r;
  return 5; // افتراضي للسجلات القديمة
}
function calcCommissionParts(gross, ratePercent) {
  const g = parseFloat(gross) || 0;
  const r = (isFinite(ratePercent) ? ratePercent : 5) / 100;
  return { commission: g * r, net: g * (1 - r), rate: (isFinite(ratePercent) ? ratePercent : 5) };
}

/** رابط عام لصفحة المنتج في المتجر */

/** رابط المتجر الافتراضي عندكم (GitHub Pages) — يُستبدل إن وُجد في إعدادات Drive */
const DEFAULT_STORE_BASE = 'https://lamadh41-lgtm.github.io/sds';

(async function preloadStoreBaseUrl() {
  try {
    const snap = await getDoc(doc(db, 'settings', 'drive'));
    const u = snap.exists() ? (snap.data().storePublicUrl || '') : '';
    if (u) {
      window.STORE_BASE_URL = String(u).replace(/\/$/, '');
    } else {
      window.STORE_BASE_URL = DEFAULT_STORE_BASE;
    }
  } catch (_) {
    window.STORE_BASE_URL = window.STORE_BASE_URL || DEFAULT_STORE_BASE;
  }
})();

function getStoreProductUrl(prodId) {
  // المتجر الفعلي عندكم دائماً تحت /sds — الأدمن تحت /qw فلا يُستخدم كأساس أبداً
  const HARD_DEFAULT = 'https://lamadh41-lgtm.github.io/sds';
  let base = (window.STORE_BASE_URL || DEFAULT_STORE_BASE || HARD_DEFAULT || '').toString().trim().replace(/\/$/, '');
  // ارفض أي قاعدة فيها مسار الأدمن أو لا تحتوي sds على github pages
  const bad = !base
    || /\/(qw|admin)(\/|$)/i.test(base + '/')
    || (/github\.io/i.test(base) && !/\/sds(\/|$)/i.test(base + '/'));
  if (bad) base = HARD_DEFAULT;
  return base + '/product.html?id=' + String(prodId || '');
}

function copyStoreProductLink(prodId) {
  const url = getStoreProductUrl(prodId);
  const done = () => { try { showToast('تم نسخ رابط المشاركة'); } catch(_){} };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(url).then(done).catch(() => {
      // fallback
      const ta = document.createElement('textarea');
      ta.value = url; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); } catch(_){}
      ta.remove(); done();
    });
  }
  const ta = document.createElement('textarea');
  ta.value = url; document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); } catch(_){}
  ta.remove(); done();
  return Promise.resolve();
}


function showToast(msg, type='success') {
  const c = document.querySelector('.toast-container');
  if (!c) { console.log(msg); return; }
  const id = 't'+Date.now();
  const bg = type==='error'?'bg-danger':'bg-success';
  c.insertAdjacentHTML('beforeend', `<div id="${id}" class="toast align-items-center text-white ${bg} border-0"><div class="d-flex"><div class="toast-body">${msg}</div><button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast"></button></div></div>`);
  try { new bootstrap.Toast(document.getElementById(id)).show(); } catch(e){}
}
function showLoading(s=true, message='جاري التحميل...', percent=null){ 
  let el = document.getElementById('loadingOverlay');
  const loaderHTML = `<div class="upload-loader-card">
      <div class="spinner-border text-primary mb-3" style="width:3rem;height:3rem;"></div>
      <div class="upload-loader-msg" id="loadingOverlayMsg"></div>
      <div class="upload-loader-bar mt-3 d-none" id="loadingOverlayBarWrap">
        <div class="progress" style="height:10px;width:240px;background:rgba(255,255,255,0.15);">
          <div class="progress-bar progress-bar-striped progress-bar-animated bg-warning" id="loadingOverlayBar" style="width:0%"></div>
        </div>
        <div class="upload-loader-pct mt-2" id="loadingOverlayPct">0%</div>
      </div>
    </div>`;
  if (!el && s) {
    el = document.createElement('div');
    el.id = 'loadingOverlay';
    el.className = 'spinner-overlay';
    el.innerHTML = loaderHTML;
    document.body.appendChild(el);
  } else if (el && s && !el.querySelector('.upload-loader-card')) {
    el.className = 'spinner-overlay';
    el.innerHTML = loaderHTML;
  }
  if (!el) return;
  if (s) {
    el.classList.remove('d-none');
    const msgEl = document.getElementById('loadingOverlayMsg');
    if (msgEl) msgEl.textContent = message || 'جاري التحميل...';
    const barWrap = document.getElementById('loadingOverlayBarWrap');
    const bar = document.getElementById('loadingOverlayBar');
    const pctEl = document.getElementById('loadingOverlayPct');
    if (percent !== null && percent !== undefined && barWrap && bar && pctEl) {
      barWrap.classList.remove('d-none');
      const pct = Math.max(0, Math.min(100, Math.round(percent)));
      bar.style.width = pct + '%';
      pctEl.textContent = pct + '%';
    } else if (barWrap) barWrap.classList.add('d-none');
  } else {
    el.classList.add('d-none');
  }
}

function siteConfirm(message, title = 'تأكيد') {
  return new Promise((resolve) => {
    let modal = document.getElementById('siteConfirmModal');
    if (!modal) {
      document.body.insertAdjacentHTML('beforeend', `
        <div class="modal fade" id="siteConfirmModal" tabindex="-1">
          <div class="modal-dialog modal-dialog-centered">
            <div class="modal-content">
              <div class="modal-header">
                <h5 class="modal-title" id="siteConfirmTitle">تأكيد</h5>
                <button type="button" class="btn-close btn-close-white" data-bs-dismiss="modal"></button>
              </div>
              <div class="modal-body"><p id="siteConfirmMsg" class="mb-0" style="white-space:pre-wrap;"></p></div>
              <div class="modal-footer">
                <button type="button" class="btn btn-outline-secondary" data-bs-dismiss="modal">إلغاء</button>
                <button type="button" class="btn btn-primary" id="siteConfirmYes">تأكيد</button>
              </div>
            </div>
          </div>
        </div>`);
      modal = document.getElementById('siteConfirmModal');
    }
    document.getElementById('siteConfirmTitle').textContent = title;
    document.getElementById('siteConfirmMsg').textContent = message;
    const modalInst = new bootstrap.Modal(modal);
    const yesBtn = document.getElementById('siteConfirmYes');
    const cleanup = () => { yesBtn.onclick = null; modal.removeEventListener('hidden.bs.modal', onHide); };
    const onHide = () => { cleanup(); resolve(false); };
    yesBtn.onclick = () => { cleanup(); modalInst.hide(); resolve(true); };
    modal.addEventListener('hidden.bs.modal', onHide);
    modalInst.show();
  });
}

function sitePrompt(message, title = 'إدخال', defaultValue = '') {
  return new Promise((resolve) => {
    let modal = document.getElementById('sitePromptModal');
    if (!modal) {
      document.body.insertAdjacentHTML('beforeend', `
        <div class="modal fade" id="sitePromptModal" tabindex="-1">
          <div class="modal-dialog modal-dialog-centered">
            <div class="modal-content">
              <div class="modal-header">
                <h5 class="modal-title" id="sitePromptTitle">إدخال</h5>
                <button type="button" class="btn-close btn-close-white" data-bs-dismiss="modal"></button>
              </div>
              <div class="modal-body">
                <p id="sitePromptMsg" class="mb-2"></p>
                <input type="text" class="form-control" id="sitePromptInput">
              </div>
              <div class="modal-footer">
                <button type="button" class="btn btn-outline-secondary" data-bs-dismiss="modal">إلغاء</button>
                <button type="button" class="btn btn-primary" id="sitePromptYes">تأكيد</button>
              </div>
            </div>
          </div>
        </div>`);
      modal = document.getElementById('sitePromptModal');
    }
    document.getElementById('sitePromptTitle').textContent = title;
    document.getElementById('sitePromptMsg').textContent = message;
    const input = document.getElementById('sitePromptInput');
    input.value = defaultValue || '';
    const modalInst = new bootstrap.Modal(modal);
    const yesBtn = document.getElementById('sitePromptYes');
    const cleanup = () => { yesBtn.onclick = null; modal.removeEventListener('hidden.bs.modal', onHide); };
    const onHide = () => { cleanup(); resolve(null); };
    yesBtn.onclick = () => { const val = input.value; cleanup(); modalInst.hide(); resolve(val); };
    modal.addEventListener('hidden.bs.modal', onHide);
    modalInst.show();
    setTimeout(() => input.focus(), 300);
  });
}
window.siteConfirm = siteConfirm;
window.sitePrompt = sitePrompt;


// Navigation (event delegation — أكثر ثباتاً)
function switchAdminSection(sectionName, linkEl) {
  document.querySelectorAll('.admin-section').forEach(s => s.classList.add('d-none'));
  document.querySelectorAll('.admin-sidebar .nav-link').forEach(l => l.classList.remove('active'));
  if (linkEl) linkEl.classList.add('active');
  const sec = document.getElementById('section-' + sectionName);
  if (sec) sec.classList.remove('d-none');
  else console.warn('Section not found:', sectionName);

  try {
    // أوقف مستمع دردشة الدعم عند مغادرة القسم
    if (sectionName !== 'support' && adminChatUnsub) {
      try { adminChatUnsub(); } catch (_) {}
      adminChatUnsub = null;
    }
    if (sectionName === 'adminProfile') loadOfficialProfile();
    else if (sectionName === 'users') loadUsers();
    else if (sectionName === 'products') loadAdminProducts();
    else if (sectionName === 'reviews') { clearBadge('reviews'); loadReviews(); }
    else if (sectionName === 'orders') { clearBadge('orders'); loadOrders(); }
    else if (sectionName === 'addBalance') initAddBalanceSection();
    else if (sectionName === 'banned') loadBanned();
    else if (sectionName === 'support') { clearBadge('support'); loadSupportUsers(); }
    else if (sectionName === 'dashboard') loadStats();
    else if (sectionName === 'news') loadNewsAdmin();
    else if (sectionName === 'promoContent') { loadPromoAdmin(1); loadPlaylistsAdmin(); }
    else if (sectionName === 'myCreations') loadAdminMyCreations();
    else if (sectionName === 'myEarningsHub') initEarningsHub();
    else if (sectionName === 'myEarnings') loadAdminMyEarnings();
    else if (sectionName === 'commissionEarnings') loadCommissionEarnings();
    else if (sectionName === 'usersEarnings') loadUsersEarningsList();
    else if (sectionName === 'resetEarnings') loadResetEarningsUsers();
    else if (sectionName === 'sponsoredAds') loadSponsoredAdsAdmin();
    else if (sectionName === 'admins') loadAdminsSection();
    else if (sectionName === 'firebase') loadFirebaseUsage();
    else if (sectionName === 'drive') loadDriveSettings();
    else if (sectionName === 'sellerPayouts') { const b=document.getElementById('badge-payouts'); if(b) b.classList.add('d-none'); loadSellerPayouts(); }
  } catch (err) {
    console.error('Section load error:', err);
    showToast('خطأ في فتح القسم: ' + (err.message || err), 'error');
  }
}

document.querySelector('.admin-sidebar')?.addEventListener('click', (e) => {
  const link = e.target.closest('[data-section]');
  if (!link) return;
  e.preventDefault();
  switchAdminSection(link.dataset.section, link);
});

// ===== Dashboard Stats =====
async function loadStats() {
  const connEl = document.getElementById('fbConnStatus');
  try {
    if (connEl) connEl.innerHTML = '<span class="text-warning">جاري الاتصال بـ Firebase...</span>';
    const cached = cacheGet('admin:stats');
    let users, products, purchases;
    if (cached && cached.usersSize != null) {
      if (connEl) connEl.innerHTML = '<span class="text-success"><i class="fas fa-check-circle me-1"></i>من التخزين المحلي (بدون قراءة)</span>';
      const elUsers = document.getElementById('statUsers');
      const elProd = document.getElementById('statProducts');
      const elPend = document.getElementById('statPending');
      if (elUsers) elUsers.textContent = cached.usersSize;
      if (elProd) elProd.textContent = cached.activeCount;
      if (elPend) elPend.textContent = cached.pendingCount;
      const chatsEl = document.getElementById('statChats');
      if (chatsEl) chatsEl.textContent = cached.deletedCount;
      return;
    }
    users = await getDocs(query(collection(db, 'users'), limit(200)));
    products = await getDocs(query(collection(db, 'projects'), limit(200)));
    purchases = await getDocs(query(collection(db, 'purchases'), limit(200)));
    
    let pendingCount = 0;
    purchases.forEach(d => { if (d.data().status === 'pending') pendingCount++; });

    let activeCount = 0, deletedCount = 0;
    products.forEach(d => {
      const s = d.data().status;
      if (s === 'deleted') deletedCount++;
      else activeCount++;
    });

    const elUsers = document.getElementById('statUsers');
    const elProd = document.getElementById('statProducts');
    const elPend = document.getElementById('statPending');
    if (elUsers) elUsers.textContent = users.size;
    if (elProd) elProd.textContent = activeCount;
    if (elPend) elPend.textContent = pendingCount;
    const chatsEl = document.getElementById('statChats');
    if (chatsEl) chatsEl.textContent = deletedCount;
    const deletedLabel = document.querySelector('#section-dashboard .stat-card:nth-child(4) div:last-child');
    if (deletedLabel) deletedLabel.textContent = 'منتجات محذوفة';
    try { cacheSet('admin:stats', { usersSize: users.size, activeCount, pendingCount, deletedCount }); } catch(_){}
    if (connEl) connEl.innerHTML = '<span class="text-success"><i class="fas fa-check-circle me-1"></i>متصل بـ Firebase بنجاح</span>';
  } catch (err) {
    console.error(err);
    if (connEl) connEl.innerHTML = '<span class="text-danger"><i class="fas fa-times-circle me-1"></i>فشل الاتصال: ' + (err.message || err) + '</span>';
    showToast('خطأ في تحميل الإحصائيات: ' + err.message, 'error');
  }
}
// loadStats() — فقط عند فتح قسم لوحة التحكم (لا عند تحميل الصفحة)

// ===== Orders (Pending Purchases) =====
async function loadOrders() {
  // شحن الرصيد المطلوب (topups)
  const list = document.getElementById('ordersList');
  if (!list) return;
  list.innerHTML = '<div class="text-center py-4"><div class="spinner-border text-primary"></div></div>';
  
  try {
    const snap = await getDocs(query(collection(db, 'topups'), limit(80)));
    const pending = snap.docs.filter(d => d.data().status === 'pending');
    
    pending.sort((a, b) => {
      const t1 = a.data().createdAt?.toMillis?.() || 0;
      const t2 = b.data().createdAt?.toMillis?.() || 0;
      return t2 - t1;
    });

    if (pending.length === 0) {
      list.innerHTML = '<div class="alert alert-info">لا توجد طلبات شحن رصيد معلقة</div>';
      return;
    }

    list.innerHTML = pending.map(d => {
      const p = d.data();
      return `
        <div class="card mb-3 shadow-sm">
          <div class="card-body">
            <div class="row align-items-center">
              <div class="col-md-5">
                <h5 class="mb-1">شحن رصيد: ${p.amount || 0} ج.م</h5>
                <p class="mb-1"><strong>المستخدم:</strong> ${p.userName || p.userEmail || '-'}</p>
                <p class="mb-1 small">ID: ${p.userId || '-'}</p>
                <p class="mb-0 small text-muted">${p.createdAt?.toDate?.().toLocaleString('ar-EG') || ''}</p>
              </div>
              <div class="col-md-3 text-center">
                ${p.transferImage 
                  ? `<a href="${p.transferImage}" target="_blank" class="btn btn-sm btn-outline-primary">عرض التحويل</a>` 
                  : '<span class="text-muted">لا توجد صورة</span>'}
              </div>
              <div class="col-md-4 text-end">
                <button class="btn btn-success btn-sm me-1 approve-topup" data-id="${d.id}" data-uid="${p.userId||''}" data-amount="${p.amount||0}">قبول الشحن</button>
                <button class="btn btn-danger btn-sm reject-topup" data-id="${d.id}" data-uid="${p.userId||''}">رفض</button>
              </div>
            </div>
          </div>
        </div>
      `;
    }).join('');

    list.querySelectorAll('.approve-topup').forEach(btn => {
      btn.onclick = async () => {
        if (!(await siteConfirm('قبول شحن الرصيد وإضافته لحساب المستخدم؟', 'قبول الشحن'))) return;
        showLoading(true);
        try {
          const uid = btn.dataset.uid;
          const amount = parseFloat(btn.dataset.amount) || 0;
          const uRef = doc(db, 'users', uid);
          const uSnap = await getDoc(uRef);
          const bal = (uSnap.exists() ? (parseFloat(uSnap.data().balance) || 0) : 0) + amount;
          await updateDoc(uRef, { balance: bal });
          await updateDoc(doc(db, 'topups', btn.dataset.id), { status: 'approved', approvedAt: serverTimestamp() });
          await addDoc(collection(db, 'notifications'), {
            userId: uid, title: 'تم شحن رصيدك', body: `تم قبول شحن ${amount} ج.م. رصيدك الآن ${bal} ج.م`,
            type: 'topup_approved', read: false, createdAt: serverTimestamp()
          });
          showToast('تم قبول الشحن');
          loadOrders();
        } catch(e){ showToast('خطأ: ' + e.message, 'error'); }
        finally { showLoading(false); }
      };
    });

    list.querySelectorAll('.reject-topup').forEach(btn => {
      btn.onclick = async () => {
        const reason = await sitePrompt('سبب الرفض:', 'رفض الشحن');
        if (reason === null) return;
        showLoading(true);
        try {
          await updateDoc(doc(db, 'topups', btn.dataset.id), {
            status: 'rejected', rejectionReason: reason || 'بدون سبب', rejectedAt: serverTimestamp()
          });
          if (btn.dataset.uid) {
            await addDoc(collection(db, 'notifications'), {
              userId: btn.dataset.uid, title: 'رفض شحن الرصيد',
              body: `تم رفض طلب الشحن. السبب: ${reason || 'بدون سبب'}`,
              type: 'topup_rejected', read: false, createdAt: serverTimestamp()
            });
          }
          showToast('تم الرفض');
          loadOrders();
        } catch(e){ showToast('خطأ: ' + e.message, 'error'); }
        finally { showLoading(false); }
      };
    });

  } catch (err) {
    console.error(err);
    list.innerHTML = `<div class="alert alert-danger">خطأ في تحميل الطلبات: ${err.message}</div>`;
  }
}

// ===== Users =====
const ADMIN_PAGE_SIZE = 10;
let usersPageCursor = null;
let usersPageStack = [null];
let usersPageIndex = 0;

async function loadUsers(search = '', direction = 'first') {
  const list = document.getElementById('usersList');
  list.innerHTML = '<div class="text-center py-4"><div class="spinner-border text-primary"></div></div>';
  
  try {
    // بحث بالاسم/إيميل/ID: لو في بحث نقرأ دفعة محدودة أكبر للفلترة
    let snap;
    if (search && search.trim()) {
      snap = await getDocs(query(collection(db, 'users'), limit(50)));
      usersPageIndex = 0;
      usersPageStack = [null];
      usersPageCursor = null;
    } else {
      try {
        if (direction === 'next' && usersPageCursor) {
          snap = await getDocs(query(collection(db, 'users'), orderBy('createdAt', 'desc'), startAfter(usersPageCursor), limit(ADMIN_PAGE_SIZE)));
        } else if (direction === 'prev' && usersPageIndex > 0) {
          usersPageIndex--;
          const c = usersPageStack[usersPageIndex];
          snap = c
            ? await getDocs(query(collection(db, 'users'), orderBy('createdAt', 'desc'), startAfter(c), limit(ADMIN_PAGE_SIZE)))
            : await getDocs(query(collection(db, 'users'), orderBy('createdAt', 'desc'), limit(ADMIN_PAGE_SIZE)));
        } else {
          usersPageIndex = 0;
          usersPageStack = [null];
          snap = await getDocs(query(collection(db, 'users'), orderBy('createdAt', 'desc'), limit(ADMIN_PAGE_SIZE)));
        }
      } catch (e) {
        snap = await getDocs(query(collection(db, 'users'), limit(ADMIN_PAGE_SIZE)));
      }
    }

    let docs = snap.docs.filter(d => {
      const u = d.data();
      return !u.banned && !u.deleted;
    });

    if (search) {
      const s = search.toLowerCase();
      docs = docs.filter(d => {
        const u = d.data();
        return (u.name || '').toLowerCase().includes(s) || (u.email || '').toLowerCase().includes(s) || d.id.toLowerCase().includes(s);
      });
    }

    if (docs.length === 0) {
      list.innerHTML = '<div class="alert alert-info">لا يوجد مستخدمون في هذه الصفحة</div>';
      return;
    }

    if (!search) {
      if (direction === 'next') {
        usersPageStack.push(usersPageCursor);
        usersPageIndex = usersPageStack.length - 1;
      }
      usersPageCursor = docs[docs.length - 1];
    }

    list.innerHTML = `
      <div class="table-responsive">
        <table class="table table-hover bg-white rounded shadow-sm">
          <thead class="table-light">
            <tr>
              <th style="width:56px"></th>
              <th>الاسم</th>
              <th>الإيميل</th>
              <th>تاريخ التسجيل</th>
              <th>إجراءات</th>
            </tr>
          </thead>
          <tbody>
            ${docs.map(d => {
              const u = d.data();
              const photo = u.photoURL || u.avatarUrl || '';
              const av = photo
                ? `<img src="${photo}" alt="" style="width:40px;height:40px;border-radius:50%;object-fit:cover;">`
                : `<div class="bg-secondary text-white rounded-circle d-inline-flex align-items-center justify-content-center" style="width:40px;height:40px;font-size:0.9rem;">${((u.name||'?')[0]||'?')}</div>`;
              return `<tr class="user-row" data-id="${d.id}" data-name="${(u.name||'').replace(/"/g,'&quot;')}" style="cursor:pointer;">
                <td class="align-middle">${av}</td>
                <td class="align-middle"><span class="text-primary fw-semibold">${u.name || '-'}</span></td>
                <td class="align-middle">${u.email || '-'}</td>
                <td>${(() => { try { const d = u.createdAt?.toDate?.(); if (!d) return '-'; return d.getFullYear() + '/' + String(d.getMonth()+1).padStart(2,'0') + '/' + String(d.getDate()).padStart(2,'0'); } catch { return '-'; } })()}</td>
                <td>
                  <button class="btn btn-sm btn-outline-primary view-user-prods" data-id="${d.id}" data-name="${(u.name||'').replace(/"/g,'&quot;')}">إبداعاته</button>
                  <button class="btn btn-sm btn-outline-success view-user-purchases" data-id="${d.id}" data-name="${(u.name||'').replace(/"/g,'&quot;')}">مشترياته</button>
                  <button class="btn btn-sm btn-outline-dark view-user-details" data-id="${d.id}">تفاصيل</button>
                  <button class="btn btn-sm btn-outline-warning ban-user" data-id="${d.id}">حظر</button>
                  <button class="btn btn-sm btn-outline-danger delete-user" data-id="${d.id}">حذف</button>
                  <button class="btn btn-sm btn-outline-info msg-user" data-id="${d.id}" data-email="${u.email || ''}">رسالة</button>
                </td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
      <div class="d-flex justify-content-center gap-2 mt-3" id="usersPager">
        <button class="btn btn-sm btn-outline-secondary" id="usersPrevBtn" ${usersPageIndex>0&&!search?'':'disabled'}>السابق</button>
        <span class="align-self-center small">صفحة ${usersPageIndex+1}</span>
        <button class="btn btn-sm btn-outline-secondary" id="usersNextBtn" ${docs.length>=ADMIN_PAGE_SIZE&&!search?'':'disabled'}>التالي</button>
      </div>
      <div id="userProductsPanel" class="mt-4 d-none"></div>
    `;
    document.getElementById('usersPrevBtn')?.addEventListener('click', () => loadUsers('', 'prev'));
    document.getElementById('usersNextBtn')?.addEventListener('click', () => loadUsers('', 'next'));

    list.querySelectorAll('.ban-user').forEach(btn => {
      btn.onclick = async (e) => {
        e.stopPropagation();
        if (!(await siteConfirm('هل أنت متأكد من حظر هذا المستخدم؟', 'حظر مستخدم'))) return;
        try {
          await updateDoc(doc(db, 'users', btn.dataset.id), { banned: true, bannedAt: serverTimestamp() });
          showToast('تم حظر المستخدم');
          loadUsers();
        } catch(e) { showToast(e.message, 'error'); }
      };
    });

    list.querySelectorAll('.delete-user').forEach(btn => {
      btn.onclick = async (e) => {
        e.stopPropagation();
        if (!(await siteConfirm('هل أنت متأكد من حذف المستخدم؟', 'حذف مستخدم'))) return;
        try {
          await updateDoc(doc(db, 'users', btn.dataset.id), {
            deleted: true,
            permanentlyDeleted: true,
            blockEmailRestore: true,
            balance: 0,
            earnings: 0,
            deletedAt: serverTimestamp()
          });
          showToast('تم حذف المستخدم');
          loadUsers();
        } catch(e) { showToast(e.message, 'error'); }
      };
    });

    list.querySelectorAll('.msg-user').forEach(btn => {
      btn.onclick = async (e) => {
        e.stopPropagation();
        const text = await sitePrompt('اكتب الرسالة:', 'رسالة للمستخدم');
        if (!text) return;
        try {
          await addDoc(collection(db, 'supportChats'), {
            userId: btn.dataset.id,
            userEmail: btn.dataset.email,
            sender: 'admin',
            text,
            createdAt: serverTimestamp()
          });
          await addDoc(collection(db, 'notifications'), {
            userId: btn.dataset.id,
            title: 'رسالة من الإدارة',
            body: text,
            read: false,
            createdAt: serverTimestamp()
          });
          showToast('تم إرسال الرسالة');
        } catch(e) { showToast(e.message, 'error'); }
      };
    });

    list.querySelectorAll('.view-user-prods').forEach(btn => {
      btn.onclick = (e) => {
        e.stopPropagation();
        showUserProducts(btn.dataset.id, btn.dataset.name);
      };
    });
    list.querySelectorAll('.view-user-purchases').forEach(btn => {
      btn.onclick = (e) => {
        e.stopPropagation();
        showUserPurchases(btn.dataset.id, btn.dataset.name);
      };
    });
    list.querySelectorAll('.view-user-details').forEach(btn => {
      btn.onclick = (e) => {
        e.stopPropagation();
        showUserFullDetails(btn.dataset.id);
      };
    });

    list.querySelectorAll('.user-row').forEach(row => {
      row.onclick = () => showUserFullDetails(row.dataset.id);
    });

  } catch (err) {
    console.error(err);
    list.innerHTML = `<div class="alert alert-danger">خطأ: ${err.message}</div>`;
  }
}

async function showUserProducts(userId, userName) {
  const panel = document.getElementById('userProductsPanel');
  if (!panel) return;
  panel.classList.remove('d-none');
  panel.innerHTML = `<div class="card shadow-sm"><div class="card-header d-flex justify-content-between align-items-center bg-primary text-white">
    <h5 class="mb-0"><i class="fas fa-box me-2"></i>منتجات: ${userName || userId}</h5>
    <button class="btn btn-sm btn-light" onclick="document.getElementById('userProductsPanel').classList.add('d-none')">إغلاق</button>
  </div><div class="card-body"><div class="text-center py-3"><div class="spinner-border text-primary"></div></div></div></div>`;

  try {
    const snap = await getDocs(query(collection(db, 'projects'), where('sellerId', '==', userId), limit(80)));
    const prods = snap.docs.filter(d => d.data().status !== 'deleted');
    const body = panel.querySelector('.card-body');
    if (prods.length === 0) {
      body.innerHTML = '<div class="alert alert-info mb-0">لا توجد منتجات لهذا المستخدم</div>';
      return;
    }
    body.innerHTML = `
      <div class="table-responsive">
        <table class="table table-sm table-hover align-middle">
          <thead><tr><th>العنوان</th><th>السعر</th><th>الحالة</th><th>تاريخ</th><th>إجراء</th></tr></thead>
          <tbody>
            ${prods.map(d => {
              const p = d.data();
              return `<tr>
                <td><a href="#" class="view-prod-detail text-decoration-none" data-id="${d.id}">${p.title || '-'}</a></td>
                <td>${p.price || 0} ج.م</td>
                <td><span class="badge bg-${p.status==='active'?'success':'secondary'}">${p.status||'active'}</span></td>
                <td class="small">${p.createdAt?.toDate?.().toLocaleDateString('ar-EG')||'-'}</td>
                <td><button class="btn btn-sm btn-danger del-user-prod" data-id="${d.id}" data-seller="${userId}">حذف</button></td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>`;

    body.querySelectorAll('.del-user-prod').forEach(btn => {
      btn.onclick = async () => {
        const reason = await sitePrompt('سبب الحذف (سيصل لصاحب المنتج في الإشعارات):', 'حذف منتج');
        if (reason === null) return;
        try {
          await updateDoc(doc(db, 'projects', btn.dataset.id), {
            status: 'deleted',
            deleteReason: reason || 'بدون سبب',
            deletedAt: serverTimestamp()
          });
          await addDoc(collection(db, 'notifications'), {
            userId: btn.dataset.seller,
            title: 'تم حذف منتجك',
            body: `تم حذف أحد منتجاتك بواسطة الإدارة. السبب: ${reason || 'بدون سبب'}`,
            type: 'product_deleted',
            read: false,
            createdAt: serverTimestamp()
          });
          invalidateProjectCaches(btn.dataset.id);
          showToast('تم حذف المنتج وإرسال الإشعار');
          showUserProducts(userId, userName);
          loadStats();
        } catch(e) { showToast(e.message, 'error'); }
      };
    });

    body.querySelectorAll('.view-prod-detail').forEach(a => {
      a.onclick = (e) => { e.preventDefault(); viewAdminProduct(a.dataset.id); };
    });
  } catch (err) {
    panel.querySelector('.card-body').innerHTML = `<div class="alert alert-danger">${err.message}</div>`;
  }
}

document.getElementById('userSearch')?.addEventListener('input', (e) => {
  loadUsers(e.target.value);
});

// ===== Products =====
async function loadAdminProducts(officialQ = '', userQ = '') {
  const offList = document.getElementById('officialProductsList');
  const userList = document.getElementById('userProductsList');
  if (!offList || !userList) return;
  offList.innerHTML = '<div class="col-12 text-center py-3"><div class="spinner-border spinner-border-sm"></div></div>';
  userList.innerHTML = '<div class="col-12 text-center py-3"><div class="spinner-border spinner-border-sm"></div></div>';

  try {
    const snap = await getDocs(query(collection(db, 'projects'), limit(200)));
    const docs = snap.docs.filter(d => d.data().status !== 'deleted' && d.data().status !== 'draft' && d.data().status !== 'pending_review');

    let official = docs.filter(d => d.data().isOfficial);
    let users = docs.filter(d => !d.data().isOfficial);

    if (officialQ) {
      const s = officialQ.toLowerCase();
      official = official.filter(d => {
        const p = d.data();
        return (p.title||'').toLowerCase().includes(s) || (p.description||'').toLowerCase().includes(s) || d.id.toLowerCase().includes(s);
      });
    }
    if (userQ) {
      const s = userQ.toLowerCase();
      users = users.filter(d => {
        const p = d.data();
        return (p.title||'').toLowerCase().includes(s) || (p.sellerName||'').toLowerCase().includes(s) || (p.description||'').toLowerCase().includes(s) || d.id.toLowerCase().includes(s);
      });
    }

    const card = (d) => {
      const p = d.data();
      return `
        <div class="col-md-4 mb-3">
          <div class="card h-100 shadow-sm product-admin-card" style="cursor:pointer;" data-id="${d.id}">
            <div class="card-body">
              <h6 class="card-title">${p.title || 'بدون عنوان'}
                ${p.isOfficial ? '<span class="badge bg-info">رسمي</span>' : ''}
              </h6>
              <p class="small mb-1">
                <a href="#" class="seller-link text-primary text-decoration-none fw-semibold" data-seller="${p.sellerId||''}" data-name="${(p.sellerName||'').replace(/"/g,'&quot;')}">
                  <i class="fas fa-store me-1"></i>${p.sellerName || '-'}
                </a>
                — <strong>${p.price || 0} ج.م</strong>
              </p>
              <p class="small text-truncate text-muted">${p.description || ''}</p>
              <div class="small text-muted mb-2">ID: ${d.id}</div>
              <div class="d-flex gap-2 mt-2">
                <button class="btn btn-sm btn-outline-primary view-prod" data-id="${d.id}"><i class="fas fa-eye"></i> عرض</button>
                <button class="btn btn-sm btn-danger del-prod" data-id="${d.id}">حذف</button>
              </div>
            </div>
          </div>
        </div>`;
    };

    offList.innerHTML = official.length ? official.map(card).join('') : '<div class="col-12"><div class="alert alert-info">لا توجد منتجات رسمية</div></div>';
    userList.innerHTML = users.length ? users.map(card).join('') : '<div class="col-12"><div class="alert alert-info">لا توجد منتجات مستخدمين</div></div>';

    const bind = (root) => {
      root.querySelectorAll('.del-prod').forEach(btn => {
        btn.onclick = async (e) => {
          e.stopPropagation();
          const reason = await sitePrompt('سبب الحذف:', 'حذف');
          if (reason === null) return;
          try {
            const pSnap = await getDoc(doc(db, 'projects', btn.dataset.id));
            await updateDoc(doc(db, 'projects', btn.dataset.id), {
              status: 'deleted', deleteReason: reason || 'بدون سبب', deletedAt: serverTimestamp()
            });
            if (pSnap.exists() && pSnap.data().sellerId) {
              await addDoc(collection(db, 'notifications'), {
                userId: pSnap.data().sellerId,
                title: 'تم حذف مشروعك',
                body: `تم حذف مشروعك "${pSnap.data().title||''}". السبب: ${reason || 'بدون سبب'}`,
                type: 'product_deleted', read: false, createdAt: serverTimestamp()
              });
            }
            invalidateProjectCaches(btn?.dataset?.id); showToast('تم الحذف');
            loadAdminProducts(
              document.getElementById('searchOfficial')?.value || '',
              document.getElementById('searchUsersProd')?.value || ''
            );
            loadStats();
          } catch(e) { showToast(e.message, 'error'); }
        };
      });
      root.querySelectorAll('.view-prod').forEach(btn => {
        btn.onclick = (e) => { e.stopPropagation(); viewAdminProduct(btn.dataset.id); };
      });
      root.querySelectorAll('.product-admin-card').forEach(cardEl => {
        cardEl.onclick = () => viewAdminProduct(cardEl.dataset.id);
      });
      root.querySelectorAll('.seller-link').forEach(a => {
        a.onclick = (e) => {
          e.preventDefault(); e.stopPropagation();
          if (a.dataset.seller) showUserProducts(a.dataset.seller, a.dataset.name);
        };
      });
    };
    bind(offList);
    bind(userList);
  } catch (err) {
    console.error(err);
    offList.innerHTML = `<div class="col-12 alert alert-danger">${err.message}</div>`;
  }
}

document.getElementById('searchOfficial')?.addEventListener('input', (e) => {
  loadAdminProducts(e.target.value, document.getElementById('searchUsersProd')?.value || '');
});
document.getElementById('searchUsersProd')?.addEventListener('input', (e) => {
  loadAdminProducts(document.getElementById('searchOfficial')?.value || '', e.target.value);
});

// ===== Reviews =====
async function loadReviews() {
  const list = document.getElementById('reviewsList');
  if (!list) return;
  list.innerHTML = '<div class="text-center py-4"><div class="spinner-border text-primary"></div></div>';
  try {
    // استعلام مباشر على pending_review فقط — بدون قراءة كل المشاريع
    let pending = [];
    try {
      const snap = await getDocs(query(collection(db, 'projects'), where('status', '==', 'pending_review'), limit(80)));
      pending = snap.docs;
    } catch (qErr) {
      // fallback لو مفيش index
      const snap = await getDocs(query(collection(db, 'projects'), limit(100)));
      pending = snap.docs.filter(d => d.data().status === 'pending_review');
    }
    pending.sort((a, b) => (b.data().createdAt?.toMillis?.() || 0) - (a.data().createdAt?.toMillis?.() || 0));
    if (pending.length === 0) {
      list.innerHTML = '<div class="alert alert-info">لا توجد مشاريع بانتظار المراجعة</div>';
      return;
    }

    // تجميع حسب البائع: الاسم ثم المشاريع تحته كعناصر
    const groups = {};
    pending.forEach(d => {
      const p = d.data();
      const key = p.sellerId || p.sellerName || 'unknown';
      if (!groups[key]) {
        groups[key] = {
          sellerId: p.sellerId || '',
          sellerName: p.sellerName || 'بائع',
          sellerPhoto: p.sellerPhoto || '',
          items: []
        };
      }
      groups[key].items.push(d);
    });
    const groupList = Object.values(groups).sort((a, b) => b.items.length - a.items.length);

    const cardHtml = (d) => {
      const p = d.data();
      const img = p.thumbnailDirect || p.thumbnail || '';
      return `
        <div class="border rounded p-3 mb-2 bg-white">
          <div class="row g-2 align-items-start">
            <div class="col-md-2 col-4">
              ${img ? `<img src="${img}" class="img-fluid rounded" style="max-height:100px;object-fit:cover;width:100%;" onerror="this.style.display='none'">` : ''}
            </div>
            <div class="col-md-6 col-8">
              <h6 class="mb-1">${p.title || '-'}</h6>
              <p class="mb-1 small"><strong>السعر:</strong> ${p.price || 0} ج.م</p>
              <p class="small text-muted text-truncate mb-1">${p.description || ''}</p>
              <div class="small text-muted">ID: ${d.id}</div>
              ${p.filesLink ? `<a href="${p.filesLink}" target="_blank" class="btn btn-sm btn-outline-secondary mt-1">فتح الملفات</a>` : ''}
            </div>
            <div class="col-md-4 text-md-end">
              <button class="btn btn-success btn-sm mb-1 w-100 approve-review" data-id="${d.id}">نشر على المتجر</button>
              <button class="btn btn-danger btn-sm w-100 reject-review" data-id="${d.id}" data-seller="${p.sellerId||''}" data-title="${(p.title||'').replace(/"/g,'&quot;')}">رفض مع سبب</button>
              <button class="btn btn-outline-primary btn-sm mt-1 w-100 view-prod" data-id="${d.id}">عرض كامل</button>
            </div>
          </div>
        </div>`;
    };

    list.innerHTML = groupList.map((g, gi) => {
      const avatar = g.sellerPhoto
        ? `<img src="${g.sellerPhoto}" class="rounded-circle" style="width:36px;height:36px;object-fit:cover;">`
        : `<span class="d-inline-flex align-items-center justify-content-center rounded-circle bg-secondary text-white" style="width:36px;height:36px;font-size:0.85rem;">${(g.sellerName||'?').charAt(0)}</span>`;
      return `
        <div class="card mb-3 shadow-sm border-0">
          <div class="card-header bg-light d-flex align-items-center justify-content-between flex-wrap gap-2">
            <div class="d-flex align-items-center gap-2">
              ${avatar}
              <div>
                <strong>${g.sellerName}</strong>
                <div class="small text-muted">ID: ${g.sellerId || '-'}</div>
              </div>
            </div>
            <span class="badge bg-warning text-dark">${g.items.length} مشروع بانتظار المراجعة</span>
          </div>
          <div class="card-body py-2">
            ${g.items.map(cardHtml).join('')}
          </div>
        </div>`;
    }).join('');

    list.querySelectorAll('.approve-review').forEach(btn => {
      btn.onclick = async () => {
        if (!(await siteConfirm('نشر هذا المشروع على المتجر؟', 'قبول المشروع'))) return;
        try {
          const pSnap = await getDoc(doc(db, 'projects', btn.dataset.id));
          const pd = pSnap.exists() ? pSnap.data() : {};
          const upd = { status: 'active', approvedAt: serverTimestamp() };
          // بدء ساعة العرض عند القبول فقط
          if (pd.salePending && pd.saleDurationValue && pd.originalPrice != null) {
            const u = pd.saleDurationUnit || 'days';
            const v = Number(pd.saleDurationValue) || 0;
            const mult = u === 'minutes' ? 60000 : u === 'hours' ? 3600000 : u === 'months' ? 30*86400000 : 86400000;
            upd.saleEndsAt = new Date(Date.now() + v * mult);
            upd.salePending = false;
          }
          await updateDoc(doc(db, 'projects', btn.dataset.id), upd);
          if (pSnap.exists() && pSnap.data().sellerId) {
            await addDoc(collection(db, 'notifications'), {
              userId: pSnap.data().sellerId,
              title: 'تم قبول مشروعك',
              body: `تم قبول ونشر مشروعك "${pSnap.data().title||''}" على المتجر.`,
              type: 'project_approved', read: false, createdAt: serverTimestamp()
            });
          }
          showToast('تم النشر');
          loadReviews();
        } catch(e) { showToast(e.message, 'error'); }
      };
    });
    list.querySelectorAll('.reject-review').forEach(btn => {
      btn.onclick = async () => {
        const reason = await sitePrompt('سبب الرفض:', 'رفض المشروع');
        if (reason === null) return;
        try {
          await updateDoc(doc(db, 'projects', btn.dataset.id), {
            status: 'rejected', rejectReason: reason || 'بدون سبب', rejectedAt: serverTimestamp()
          });
          if (btn.dataset.seller) {
            await addDoc(collection(db, 'notifications'), {
              userId: btn.dataset.seller,
              title: 'تم رفض مشروعك',
              body: `تم رفض مشروعك "${btn.dataset.title}". السبب: ${reason || 'بدون سبب'}`,
              type: 'project_rejected', read: false, createdAt: serverTimestamp()
            });
          }
          showToast('تم الرفض');
          loadReviews();
        } catch(e) { showToast(e.message, 'error'); }
      };
    });
    list.querySelectorAll('.view-prod').forEach(btn => {
      btn.onclick = () => viewAdminProduct(btn.dataset.id);
    });
  } catch (err) {
    list.innerHTML = `<div class="alert alert-danger">${err.message}</div>`;
  }
}

async function viewAdminProduct(prodId) {
  let modal = document.getElementById('adminProdModal');
  if (!modal) {
    document.body.insertAdjacentHTML('beforeend', `
      <div class="modal fade" id="adminProdModal" tabindex="-1">
        <div class="modal-dialog modal-lg modal-dialog-scrollable">
          <div class="modal-content">
            <div class="modal-header bg-dark text-white">
              <h5 class="modal-title">تفاصيل المنتج</h5>
              <button type="button" class="btn-close btn-close-white" data-bs-dismiss="modal"></button>
            </div>
            <div class="modal-body" id="adminProdModalBody">
              <div class="text-center py-4"><div class="spinner-border"></div></div>
            </div>
          </div>
        </div>
      </div>`);
    modal = document.getElementById('adminProdModal');
  }
  const body = document.getElementById('adminProdModalBody');
  body.innerHTML = '<div class="text-center py-4"><div class="spinner-border"></div></div>';
  new bootstrap.Modal(modal).show();

  try {
    const snap = await getDoc(doc(db, 'projects', prodId));
    if (!snap.exists()) {
      body.innerHTML = '<div class="alert alert-danger">المنتج غير موجود</div>';
      return;
    }
    const p = snap.data();
    const imgs = Array.isArray(p.images) && p.images.length
      ? p.images
      : (p.thumbnailDirect || p.thumbnail ? [p.thumbnailDirect || p.thumbnail] : []);
    const imgsHtml = imgs.length
      ? imgs.map(src => `<a href="${src}" target="_blank"><img src="${src}" class="rounded shadow-sm me-1 mb-1" style="height:90px;width:120px;object-fit:cover;" onerror="this.style.display='none'"></a>`).join('')
      : '<span class="text-muted">لا توجد صور</span>';

    body.innerHTML = `
      <div class="row g-3">
        <div class="col-md-5">
          ${p.thumbnailDirect || p.thumbnail 
            ? `<img src="${p.thumbnailDirect || p.thumbnail}" class="img-fluid rounded shadow-sm" alt="" style="max-height:280px;object-fit:cover;width:100%;" onerror="this.src='https://via.placeholder.com/400x280?text=No+Image'">`
            : '<div class="bg-light rounded d-flex align-items-center justify-content-center" style="height:200px;">لا توجد صورة</div>'}
          <div class="mt-2"><strong class="small">كل الصور:</strong><div class="d-flex flex-wrap mt-1">${imgsHtml}</div></div>
        </div>
        <div class="col-md-7">
          <h4>${p.title || '-'} ${p.isOfficial ? '<span class="badge bg-info">رسمي</span>' : ''}</h4>
          <p class="mb-1"><strong>التاجر:</strong> 
            <a href="#" class="seller-link-modal text-primary" data-seller="${p.sellerId||''}" data-name="${(p.sellerName||'').replace(/"/g,'&quot;')}">${p.sellerName || '-'}</a>
          </p>
          <p class="mb-1"><strong>السعر:</strong> ${p.price || 0} ج.م ${p.isFree ? '(مجاني)' : ''}</p>
          <p class="mb-1"><strong>الحالة:</strong> <span class="badge bg-${p.status==='active'?'success':'secondary'}">${p.status||'active'}</span></p>
          <p class="mb-1"><strong>المبيعات:</strong> ${p.sales||0} | <strong>التحميلات:</strong> ${p.downloads||0}</p>
          <p class="mb-1 small text-muted">تاريخ النشر: ${p.createdAt?.toDate?.().toLocaleString('ar-EG')||'-'}</p>
          ${p.paymentMethod ? `<p class="mb-1 small"><strong>طريقة الدفع:</strong> ${p.paymentMethod} — ${p.paymentNumber||''} (${p.paymentName||''})</p>` : ''}
          ${p.filesLink ? `<p class="mb-1"><a href="${p.filesLink}" target="_blank" class="btn btn-sm btn-outline-primary"><i class="fas fa-file-archive me-1"></i>فتح الملف المرفق</a></p>` : '<p class="text-muted small">لا يوجد ملف مرفق</p>'}
          ${p.driveFolderUrl ? `<p class="mb-1"><a href="${p.driveFolderUrl}" target="_blank" class="btn btn-sm btn-outline-secondary">مجلد المشروع على درايف</a></p>` : ''}
          <p class="small text-muted">ID: ${prodId}</p>
          <div class="mt-2 d-flex flex-wrap gap-2 align-items-center">
            <button type="button" class="btn btn-sm btn-outline-primary" id="adminCopyShareBtn"><i class="fas fa-copy me-1"></i>نسخ رابط المشاركة</button>
          </div>
        </div>
        <div class="col-12">
          <h6>الوصف</h6>
          <div class="border rounded p-3 bg-light" style="white-space:pre-wrap;">${p.description || 'لا يوجد وصف'}</div>
        </div>
        <div class="col-12">
          <h6>التعليقات</h6>
          <div id="adminProdComments"><div class="text-muted small">جاري التحميل...</div></div>
        </div>
        <div class="col-12 text-end">
          <button class="btn btn-danger del-from-view" data-id="${prodId}" data-seller="${p.sellerId||''}" data-title="${(p.title||'').replace(/"/g,'&quot;')}">حذف</button>
        </div>
      </div>`;

    document.getElementById('adminCopyShareBtn')?.addEventListener('click', () => {
      copyStoreProductLink(prodId);
    });

    // تحميل تعليقات المنتج + حذف
    (async () => {
      const box = document.getElementById('adminProdComments');
      if (!box) return;
      try {
        const csnap = await getDocs(query(collection(db, 'comments'), where('projectId', '==', prodId)));
        if (!csnap.docs.length) {
          box.innerHTML = '<div class="text-muted">لا توجد تعليقات</div>';
          return;
        }
        box.innerHTML = csnap.docs.map(d => {
          const c = d.data();
          const stars = '★'.repeat(c.stars||0) + '☆'.repeat(5-(c.stars||0));
          return `<div class="border rounded p-2 mb-2 d-flex justify-content-between gap-2">
            <div>
              <strong>${c.userName||'مستخدم'}</strong> <span class="text-warning">${stars}</span>
              <div class="small">${c.text||''}</div>
              <div class="small text-muted">ID: ${d.id}</div>
            </div>
            <button class="btn btn-sm btn-outline-danger admin-del-comment" data-id="${d.id}" data-uid="${c.userId||''}">حذف</button>
          </div>`;
        }).join('');
        box.querySelectorAll('.admin-del-comment').forEach(btn => {
          btn.onclick = async () => {
            const reason = await sitePrompt('سبب حذف التعليق:', 'حذف تعليق');
            if (reason === null) return;
            try {
              await deleteDoc(doc(db, 'comments', btn.dataset.id));
              if (btn.dataset.uid) {
                await addDoc(collection(db, 'notifications'), {
                  userId: btn.dataset.uid,
                  title: 'تم حذف تعليقك',
                  body: `تم حذف تعليقك. السبب: ${reason || 'بدون سبب'}`,
                  read: false,
                  createdAt: serverTimestamp()
                });
              }
              showToast('تم حذف التعليق');
              btn.closest('.border')?.remove();
            } catch (e) { showToast(e.message, 'error'); }
          };
        });
      } catch (e) {
        box.innerHTML = `<div class="text-danger small">${e.message}</div>`;
      }
    })();

    body.querySelector('.seller-link-modal')?.addEventListener('click', (e) => {
      e.preventDefault();
      const a = e.currentTarget;
      bootstrap.Modal.getInstance(modal)?.hide();
      if (a.dataset.seller) {
        document.querySelector('[data-section="users"]')?.click();
        setTimeout(() => showUserProducts(a.dataset.seller, a.dataset.name), 300);
      }
    });

    body.querySelector('.del-from-view')?.addEventListener('click', async () => {
      const btn = body.querySelector('.del-from-view');
      const reason = await sitePrompt('سبب الحذف:', 'حذف');
      if (reason === null) return;
      try {
        await updateDoc(doc(db, 'projects', btn.dataset.id), {
          status: 'deleted', deleteReason: reason || 'بدون سبب', deletedAt: serverTimestamp()
        });
        if (btn.dataset.seller) {
          await addDoc(collection(db, 'notifications'), {
            userId: btn.dataset.seller,
            title: 'تم حذف مشروعك',
            body: `تم حذف مشروعك "${btn.dataset.title}". السبب: ${reason || 'بدون سبب'}`,
            type: 'product_deleted', read: false, createdAt: serverTimestamp()
          });
        }
        invalidateProjectCaches(btn?.dataset?.id); showToast('تم الحذف');
        bootstrap.Modal.getInstance(modal)?.hide();
        loadAdminProducts();
        loadStats();
      } catch(e) { showToast(e.message, 'error'); }
    });
  } catch (err) {
    body.innerHTML = `<div class="alert alert-danger">${err.message}</div>`;
  }
}

// ===== Support Chat =====

let selectedSupportUser = null;

async function loadSupportUsers() {
  const list = document.getElementById('supportUsersList');
  list.innerHTML = '<div class="text-center p-3"><div class="spinner-border spinner-border-sm"></div></div>';
  
  try {
    const snap = await getDocs(query(collection(db, 'supportChats'), limit(120)));
    const usersMap = {};
    snap.docs.forEach(d => {
      const m = d.data();
      if (!m.userId) return;
      if (!usersMap[m.userId]) {
        usersMap[m.userId] = { email: m.userEmail || m.userId, unread: 0, lastAt: 0, firstAt: 0 };
      }
      if (m.sender === 'user' && !m.readByAdmin) {
        usersMap[m.userId].unread++;
      }
      const ts = m.createdAt?.toMillis?.() || 0;
      if (ts > usersMap[m.userId].lastAt) usersMap[m.userId].lastAt = ts;
      if (ts && (!usersMap[m.userId].firstAt || ts < usersMap[m.userId].firstAt)) {
        usersMap[m.userId].firstAt = ts;
      }
    });

    // الأقدم أعلى القائمة (عدل في الرد)
    Object.keys(usersMap).forEach(uid => {
      if (!usersMap[uid].firstAt) usersMap[uid].firstAt = usersMap[uid].lastAt || 0;
    });
    const entries = Object.entries(usersMap).sort((a,b) => (a[1].firstAt || 0) - (b[1].firstAt || 0));
    if (entries.length === 0) {
      list.innerHTML = '<div class="text-muted p-3">لا توجد محادثات بعد</div>';
      return;
    }

    list.innerHTML = entries.map(([uid, info]) => {
      const badge = info.unread > 0
        ? `<span class="badge bg-danger rounded-pill ms-1 support-unread-badge">${info.unread}</span>`
        : '';
      return `<a href="#" class="list-group-item list-group-item-action support-user d-flex justify-content-between align-items-center" data-uid="${uid}">
        <span class="text-truncate">${info.email}</span>${badge}
      </a>`;
    }).join('');

    list.querySelectorAll('.support-user').forEach(el => {
      el.onclick = (e) => {
        e.preventDefault();
        list.querySelectorAll('.support-user').forEach(x => x.classList.remove('active'));
        el.classList.add('active');
        selectedSupportUser = el.dataset.uid;
        // تصفير العداد عند فتح المحادثة
        const b = el.querySelector('.support-unread-badge');
        if (b) b.remove();
        loadAdminChat(selectedSupportUser);
      };
    });
  } catch (err) {
    list.innerHTML = `<div class="alert alert-danger p-2">${err.message}</div>`;
  }
}

let adminChatUnsub = null;
function loadAdminChat(uid) {
  const box = document.getElementById('adminChatBox');
  box.innerHTML = '<div class="text-center text-muted">جاري التحميل...</div>';
  // أوقف أي مستمع سابق — ممنوع يتراكم listeners على مستخدمين مختلفين
  if (adminChatUnsub) {
    try { adminChatUnsub(); } catch (_) {}
    adminChatUnsub = null;
  }
  const q = query(collection(db, 'supportChats'), where('userId', '==', uid), limit(80));
  adminChatUnsub = onSnapshot(q, (snap) => {
    // لو الأدمن خرج من القسم أو غيّر المستخدم — لا ترسم
    if (selectedSupportUser !== uid) return;
    const docs = snap.docs.slice().sort((a, b) => {
      const t1 = a.data().createdAt?.toMillis?.() || 0;
      const t2 = b.data().createdAt?.toMillis?.() || 0;
      return t1 - t2;
    });
    
    if (docs.length === 0) {
      box.innerHTML = '<div class="text-center text-muted py-3">لا توجد رسائل</div>';
      return;
    }
    
    box.innerHTML = docs.map(d => {
      const m = d.data();
      const isAdmin = m.sender === 'admin';
      const time = m.createdAt?.toDate?.().toLocaleString('ar-EG') || '';
      return `<div class="chat-message ${isAdmin ? 'me' : ''}">
        <div class="chat-bubble">${m.text || ''}</div>
        <small class="text-muted" style="font-size:0.7rem;">${time}</small>
        <div class="text-muted" style="font-size:0.65rem;">ID: ${d.id}</div>
      </div>`;
    }).join('');
    box.scrollTop = box.scrollHeight;
    docs.filter(d => d.data().sender === 'user' && !d.data().readByAdmin).forEach(d => {
      updateDoc(doc(db, 'supportChats', d.id), { readByAdmin: true }).catch(() => {});
    });
  }, (err) => {
    box.innerHTML = `<div class="text-danger p-2">${err.message}</div>`;
  });
}

document.getElementById('adminSendChat')?.addEventListener('click', async () => {
  if (!selectedSupportUser) {
    showToast('اختر مستخدماً أولاً من القائمة', 'error');
    return;
  }
  const input = document.getElementById('adminChatInput');
  const text = input.value.trim();
  if (!text) return;
  
  try {
    await addDoc(collection(db, 'supportChats'), {
      userId: selectedSupportUser,
      sender: 'admin',
      text,
      read: false,
      createdAt: serverTimestamp()
    });
    input.value = '';
  } catch (e) {
    showToast(e.message, 'error');
  }
});

// ===== Official Project Upload =====
function getDriveImageUrl(link) {
  if (!link) return '';
  let id = '';
  const match1 = link.match(/\/d\/([a-zA-Z0-9_-]+)/);
  const match2 = link.match(/id=([a-zA-Z0-9_-]+)/);
  if (match1) id = match1[1];
  else if (match2) id = match2[1];
  if (id) return `https://drive.google.com/thumbnail?id=${id}&sz=w1000`;
  return link;
}

function toggleAdminPaymentFields() {
  const pricing = document.querySelector('input[name="adminPricing"]:checked')?.value;
  const priceEl = document.getElementById('adminProjPrice');
  const wrap = document.getElementById('adminPriceWrap');
  const fields = document.getElementById('adminPaymentFields');
  const isFree = pricing === 'free' || (!pricing && (parseFloat(priceEl?.value)||0) <= 0);
  if (isFree && priceEl) priceEl.value = '0';
  if (wrap) wrap.style.display = isFree ? 'none' : 'block';
  if (fields) fields.style.display = isFree ? 'none' : 'block';
  if (priceEl && !isFree) {
    const n = parseFloat(priceEl.value);
    if (!isNaN(n)) priceEl.value = String(n);
  }
}
document.getElementById('adminProjPrice')?.addEventListener('input', toggleAdminPaymentFields);
document.getElementById('adminProjPrice')?.addEventListener('blur', () => {
  const el = document.getElementById('adminProjPrice');
  if (el) { const n = parseFloat(el.value); if (!isNaN(n)) el.value = String(n); }
});
document.addEventListener('change', (e) => { if (e.target?.name === 'adminPricing') toggleAdminPaymentFields(); });
document.addEventListener('DOMContentLoaded', toggleAdminPaymentFields);

// ===== رفع مشروع رسمي: ملفات → درايف (نفس أسلوب المتجر) =====
window._adminExtraImageFiles = [];

function setAdminUploadProgress(pct, text) {
  const wrap = document.getElementById('adminUploadProgressWrap');
  const bar = document.getElementById('adminUploadProgressBar');
  const t = document.getElementById('adminUploadProgressText');
  if (wrap) wrap.classList.toggle('d-none', !(pct > 0 && pct < 100));
  if (bar) bar.style.width = Math.max(0, Math.min(100, pct)) + '%';
  if (t) t.textContent = text || '';
}

document.getElementById('adminProjThumbFile')?.addEventListener('change', (e) => {
  const f = e.target.files?.[0];
  const prev = document.getElementById('adminThumbPreview');
  const clr = document.getElementById('adminClearThumbBtn');
  if (!f) {
    if (prev) prev.innerHTML = '';
    if (clr) clr.classList.add('d-none');
    return;
  }
  if (clr) clr.classList.remove('d-none');
  if (prev) {
    const url = URL.createObjectURL(f);
    prev.innerHTML = `<img src="${url}" alt="" style="max-width:220px;max-height:140px;border-radius:8px;object-fit:cover;">`;
  }
});
document.getElementById('adminClearThumbBtn')?.addEventListener('click', () => {
  const inp = document.getElementById('adminProjThumbFile');
  if (inp) inp.value = '';
  const prev = document.getElementById('adminThumbPreview');
  if (prev) prev.innerHTML = '';
  document.getElementById('adminClearThumbBtn')?.classList.add('d-none');
});

document.getElementById('adminProjFilesFile')?.addEventListener('change', (e) => {
  const f = e.target.files?.[0];
  const prev = document.getElementById('adminFilesPreview');
  const clr = document.getElementById('adminClearFilesBtn');
  if (!f) {
    if (prev) prev.textContent = '';
    if (clr) clr.classList.add('d-none');
    return;
  }
  if (clr) clr.classList.remove('d-none');
  if (prev) prev.textContent = 'تم اختيار: ' + f.name + ' (' + (f.size / 1024 / 1024).toFixed(2) + ' MB)';
});
document.getElementById('adminClearFilesBtn')?.addEventListener('click', () => {
  const inp = document.getElementById('adminProjFilesFile');
  if (inp) inp.value = '';
  const prev = document.getElementById('adminFilesPreview');
  if (prev) prev.textContent = '';
  document.getElementById('adminClearFilesBtn')?.classList.add('d-none');
});

document.getElementById('adminProjExtraFiles')?.addEventListener('change', (e) => {
  const files = Array.from(e.target.files || []);
  if (!files.length) return;
  const room = 12 - (window._adminExtraImageFiles?.length || 0);
  const add = files.slice(0, Math.max(0, room));
  window._adminExtraImageFiles = (window._adminExtraImageFiles || []).concat(add);
  const box = document.getElementById('adminExtraPreview');
  if (box) {
    box.innerHTML = window._adminExtraImageFiles.map((f, i) =>
      `<span class="badge bg-secondary d-inline-flex align-items-center gap-1">${f.name.slice(0, 18)}<button type="button" class="btn-close btn-close-white btn-sm" data-i="${i}" style="font-size:0.55rem;"></button></span>`
    ).join('');
    box.querySelectorAll('[data-i]').forEach(btn => {
      btn.onclick = () => {
        window._adminExtraImageFiles.splice(parseInt(btn.dataset.i, 10), 1);
        document.getElementById('adminProjExtraFiles').value = '';
        document.getElementById('adminProjExtraFiles').dispatchEvent(new Event('change'));
        // re-render
        const b = document.getElementById('adminExtraPreview');
        if (b) b.innerHTML = window._adminExtraImageFiles.map((f, i) =>
          `<span class="badge bg-secondary d-inline-flex align-items-center gap-1">${f.name.slice(0, 18)}<button type="button" class="btn-close btn-close-white btn-sm" data-i="${i}" style="font-size:0.55rem;"></button></span>`
        ).join('');
        b.querySelectorAll('[data-i]').forEach(btn2 => {
          btn2.onclick = () => {
            window._adminExtraImageFiles.splice(parseInt(btn2.dataset.i, 10), 1);
            btn2.parentElement?.remove();
          };
        });
      };
    });
  }
  e.target.value = '';
});

document.getElementById('adminUploadForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const title = (document.getElementById('adminProjTitle')?.value || '').trim() || 'المحرك';
  const desc = document.getElementById('adminProjDesc').value.trim();
  const pricing = document.querySelector('input[name="adminPricing"]:checked')?.value || 'free';
  let price = parseFloat(document.getElementById('adminProjPrice').value) || 0;
  if (pricing === 'free') price = 0;
  let payMethod = document.getElementById('adminProjPayMethod')?.value || '';
  let payNumber = document.getElementById('adminProjPayNumber')?.value || '';
  let payName = document.getElementById('adminProjPayName')?.value || '';
  if (price <= 0) { payMethod = ''; payNumber = ''; payName = ''; }

  const thumbFile = document.getElementById('adminProjThumbFile')?.files?.[0];
  const filesFile = document.getElementById('adminProjFilesFile')?.files?.[0];
  if (!thumbFile) { showToast('اختر صورة مصغرة', 'error'); return; }
  if (!filesFile) { showToast('اختر ملف المشروع (ZIP)', 'error'); return; }
  if (pricing === 'paid' && price <= 0) { showToast('أدخل سعر للمنتج المدفوع', 'error'); return; }

  showLoading(true, 'جاري رفع المشروع على الدرايف...');
  try {
    const projectName = title;
    const metaBase = { projectName, userName: 'محرك_مصران', userId: 'official' };

    setAdminUploadProgress(10, 'ضغط الصورة...');
    const thumbCompressed = await adminCompressImage(thumbFile, 1200, 0.85);
    setAdminUploadProgress(25, 'رفع المصغرة...');
    const upThumb = await adminUploadToDrive(thumbCompressed, { ...metaBase, folderKind: 'images' });
    const thumbnail = upThumb.url;
    const thumbnailDirect = upThumb.thumbUrl || upThumb.url;

    const extraImages = [];
    const extras = window._adminExtraImageFiles || [];
    for (let i = 0; i < extras.length; i++) {
      setAdminUploadProgress(30 + Math.round((i / Math.max(extras.length, 1)) * 25), `رفع صورة إضافية ${i + 1}...`);
      const c = await adminCompressImage(extras[i], 1200, 0.85);
      const up = await adminUploadToDrive(c, { ...metaBase, folderKind: 'images' });
      extraImages.push({ url: up.url, thumbUrl: up.thumbUrl || up.url });
    }

    setAdminUploadProgress(70, 'رفع ملف المشروع...');
    const upFiles = await adminUploadToDrive(filesFile, { ...metaBase, folderKind: 'files' });
    const filesLink = upFiles.url;

    const cats = Array.from(document.querySelectorAll('input[name="adminCategory"]:checked')).map(el => el.value);
    if (!cats.length) { showToast('اختر فلترًا واحدًا على الأقل', 'error'); showLoading(false); return; }
    let originalPrice = null, saleEndsAt = null;
    if (document.getElementById('adminSaleEnabled')?.checked && price > 0) {
      const orig = parseFloat(document.getElementById('adminOriginalPrice')?.value) || 0;
      const durVal = parseFloat(document.getElementById('adminSaleDuration')?.value) || 0;
      const unit = document.getElementById('adminSaleUnit')?.value || 'days';
      if (!(orig > price)) { showToast('السعر الأصلي أكبر من سعر العرض', 'error'); showLoading(false); return; }
      if (!(durVal > 0)) { showToast('حدد مدة العرض', 'error'); showLoading(false); return; }
      originalPrice = orig;
      const mult = unit === 'minutes' ? 60000 : unit === 'hours' ? 3600000 : unit === 'months' ? 30*86400000 : 86400000;
      saleEndsAt = new Date(Date.now() + durVal * mult);
    }
    setAdminUploadProgress(90, 'حفظ في قاعدة البيانات...');
    await addDoc(collection(db, 'projects'), {
      title,
      description: desc,
      price,
      isFree: price === 0,
      categories: cats,
      originalPrice,
      saleEndsAt,
      thumbnail,
      thumbnailDirect,
      extraImages,
      filesLink,
      files: [],
      sellerId: 'official',
      sellerName: (window._officialDisplayName || document.getElementById('officialDisplayName')?.value || 'محرك مصران'),
      sellerPhoto: (window._officialProfilePhoto || ''),
      paymentMethod: payMethod,
      paymentNumber: payNumber,
      paymentName: payName,
      commission: 0,
      status: 'active',
      isOfficial: true,
      createdAt: serverTimestamp(),
      downloads: 0,
      sales: 0,
      driveFolderUrl: upFiles.projectFolderUrl || upThumb.projectFolderUrl || ''
    });

    try { cacheRemovePrefix('projects:'); cacheRemove('admin:stats'); } catch (_) {}
    setAdminUploadProgress(100, 'تم');
    showToast('تم نشر المشروع الرسمي بنجاح (رُفع على الدرايف)');
    e.target.reset();
    window._adminExtraImageFiles = [];
    const ep = document.getElementById('adminExtraPreview');
    if (ep) ep.innerHTML = '';
    const tp = document.getElementById('adminThumbPreview');
    if (tp) tp.innerHTML = '';
    const fp = document.getElementById('adminFilesPreview');
    if (fp) fp.textContent = '';
    document.getElementById('adminClearThumbBtn')?.classList.add('d-none');
    document.getElementById('adminClearFilesBtn')?.classList.add('d-none');
    setAdminUploadProgress(0, '');
  } catch (err) {
    console.error(err);
    showToast('خطأ: ' + (err.message || err), 'error');
  } finally {
    showLoading(false);
  }
});

function fillAdminCategories() {
  const box = document.getElementById('adminProjCategoriesBox');
  if (!box || box.dataset.ready) return;
  box.innerHTML = ADMIN_PROJECT_CATEGORIES.map((c,i) =>
    `<div class="col-6 col-md-4"><div class="form-check">
      <input class="form-check-input" type="checkbox" name="adminCategory" value="${c}" id="ac_${i}">
      <label class="form-check-label small" for="ac_${i}">${c}</label>
    </div></div>`).join('');
  box.dataset.ready = '1';
}
document.getElementById('adminSaleEnabled')?.addEventListener('change', (e) => {
  document.getElementById('adminSaleFields')?.classList.toggle('d-none', !e.target.checked);
});
document.querySelector('[data-section="addProject"]')?.addEventListener('click', fillAdminCategories);
fillAdminCategories();
console.log('Admin panel loaded successfully');


// ===== News Admin =====
async function loadNewsAdmin() {
  try {
    const snap = await getDoc(doc(db, 'settings', 'news'));
    const data = snap.exists() ? snap.data() : { text: '', active: false };
    const ta = document.getElementById('newsText');
    const disp = document.getElementById('currentNewsDisplay');
    const badge = document.getElementById('newsStatusBadge');
    if (ta) ta.value = data.text || '';
    if (disp) disp.textContent = data.text || 'لا يوجد';
    if (badge) {
      badge.textContent = data.active ? 'مفعّل' : 'معطّل';
      badge.className = 'badge ' + (data.active ? 'bg-success' : 'bg-secondary');
    }
  } catch (e) {
    console.error(e);
    showToast('خطأ في تحميل الأخبار: ' + e.message, 'error');
  }
}

document.getElementById('publishNewsBtn')?.addEventListener('click', async () => {
  const text = document.getElementById('newsText')?.value.trim();
  if (!text) { showToast('اكتب نص الخبر أولاً', 'error'); return; }
  if (!(await siteConfirm('تأكيد نشر الخبر؟', 'نشر الخبر'))) return;
  try {
    await setDoc(doc(db, 'settings', 'news'), {
      text,
      active: true,
      updatedAt: serverTimestamp()
    }, { merge: true });
    showToast('تم نشر الخبر وتفعيله');
    loadNewsAdmin();
  } catch (e) { showToast(e.message, 'error'); }
});

document.getElementById('activateNewsBtn')?.addEventListener('click', async () => {
  try {
    await setDoc(doc(db, 'settings', 'news'), { active: true, updatedAt: serverTimestamp() }, { merge: true });
    showToast('تم تفعيل الأخبار');
    loadNewsAdmin();
  } catch (e) { showToast(e.message, 'error'); }
});

document.getElementById('deactivateNewsBtn')?.addEventListener('click', async () => {
  try {
    await setDoc(doc(db, 'settings', 'news'), { active: false, updatedAt: serverTimestamp() }, { merge: true });
    showToast('تم إلغاء تفعيل الأخبار');
    loadNewsAdmin();
  } catch (e) { showToast(e.message, 'error'); }
});

// ===== ID Lookup =====
document.getElementById('lookupIdInput')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('lookupIdBtn')?.click();
});
document.getElementById('lookupIdBtn')?.addEventListener('click', async () => {
  const id = document.getElementById('lookupIdInput')?.value.trim();
  const result = document.getElementById('lookupResult');
  if (!id || !result) return;
  result.innerHTML = '<div class="text-center"><div class="spinner-border spinner-border-sm"></div></div>';
  try {
    // Try product
    const prod = await getDoc(doc(db, 'projects', id));
    if (prod.exists()) {
      const p = prod.data();
      result.innerHTML = `<div class="alert alert-success"><strong>منتج</strong> — ${p.title || '-'}<br>
        التاجر: ${p.sellerName || '-'} | السعر: ${p.price || 0} | الحالة: ${p.status || 'active'}<br>
        <button type="button" class="btn btn-sm btn-primary mt-2" id="lookupViewProdBtn" data-id="${id}">عرض التفاصيل</button>
        <div class="small text-muted mt-1">ID: ${id}</div></div>`;
      document.getElementById('lookupViewProdBtn')?.addEventListener('click', () => {
        if (typeof viewAdminProduct === 'function') viewAdminProduct(id);
        else if (typeof window.viewAdminProduct === 'function') window.viewAdminProduct(id);
      });
      return;
    }
    // Try notification
    const notif = await getDoc(doc(db, 'notifications', id));
    if (notif.exists()) {
      const n = notif.data();
      result.innerHTML = `<div class="alert alert-info"><strong>إشعار</strong><br>
        العنوان: ${n.title || '-'}<br>المحتوى: ${n.body || '-'}<br>
        userId: ${n.userId || '-'} | مقروء: ${n.read ? 'نعم' : 'لا'}<br>
        <div class="small text-muted mt-1">ID: ${id}</div></div>`;
      return;
    }
    // Try support chat message
    const chat = await getDoc(doc(db, 'supportChats', id));
    if (chat.exists()) {
      const c = chat.data();
      result.innerHTML = `<div class="alert alert-warning"><strong>رسالة دعم</strong><br>
        من: ${c.sender || '-'} | المستخدم: ${c.userEmail || c.userId || '-'}<br>
        النص: ${c.text || '-'}<br>
        <div class="small text-muted mt-1">ID: ${id}</div></div>`;
      return;
    }
    // Try purchase
    const purch = await getDoc(doc(db, 'purchases', id));
    if (purch.exists()) {
      const x = purch.data();
      result.innerHTML = `<div class="alert alert-primary"><strong>طلب شراء</strong><br>
        المنتج: ${x.projectTitle || x.projectId} | المشتري: ${x.buyerEmail || '-'}<br>
        المبلغ: ${x.amount || 0} | الحالة: ${x.status}<br>
        <div class="small text-muted mt-1">ID: ${id}</div></div>`;
      return;
    }
    // Try user
    const user = await getDoc(doc(db, 'users', id));
    if (user.exists()) {
      const u = user.data();
      result.innerHTML = `<div class="alert alert-secondary"><strong>مستخدم</strong><br>
        الاسم: ${u.name || '-'} | الإيميل: ${u.email || '-'}<br>
        <button class="btn btn-sm btn-outline-primary mt-2" onclick="showUserProducts('${id}','${(u.name||'').replace(/'/g,"\\'")}')">عرض إبداعاته</button>
        <div class="small text-muted mt-1">ID: ${id}</div></div>`;
      return;
    }
    result.innerHTML = '<div class="alert alert-danger">لم يتم العثور على أي سجل بهذا الـ ID</div>';
  } catch (e) {
    result.innerHTML = `<div class="alert alert-danger">${e.message}</div>`;
  }
});

// expose for inline onclick from ID lookup
window.viewAdminProduct = viewAdminProduct;
window.showUserProducts = showUserProducts;
window.loadAdminProducts = loadAdminProducts;


// ===== Nav Badges =====
function setBadge(key, count) {
  const el = document.getElementById('badge-' + key);
  if (!el) return;
  if (count > 0) {
    el.textContent = count > 99 ? '99+' : count;
    el.classList.remove('d-none');
  } else {
    el.classList.add('d-none');
  }
}
function clearBadge(key) {
  localStorage.setItem('admin_seen_' + key, String(Date.now()));
  setBadge(key, 0);
}
async function refreshNavBadges() {
  try {
    // قراءات محدودة فقط — بدون fallback يمسح كل الكولكشن (كان يسبب حرق قراءات)
    let pendingTopups = 0, pendingReviews = 0, unreadSupport = 0, pendingPayouts = 0;
    try {
      const top = await getDocs(query(collection(db, 'topups'), where('status', '==', 'pending'), limit(50)));
      pendingTopups = top.size;
    } catch (e) { console.warn('badge topups', e.message); }
    try {
      const rev = await getDocs(query(collection(db, 'projects'), where('status', '==', 'pending_review'), limit(50)));
      pendingReviews = rev.size;
    } catch (e) { console.warn('badge reviews', e.message); }
    try {
      const chats = await getDocs(query(collection(db, 'supportChats'), where('sender', '==', 'user'), limit(30)));
      unreadSupport = chats.docs.filter(d => !d.data().readByAdmin).length;
    } catch (e) { console.warn('badge support', e.message); }
    try {
      // لا نقرأ كل المشتريات — نحدّها
      const pays = await getDocs(query(collection(db, 'purchases'), where('status', '==', 'approved'), limit(40)));
      pendingPayouts = pays.docs.filter(d => {
        const p = d.data();
        return !p.payoutSent && (parseFloat(p.amount||p.price)||0) > 0 && p.sellerId && p.sellerId !== 'official';
      }).length;
    } catch (e) { console.warn('badge payouts', e.message); }

    setBadge('orders', pendingTopups);
    setBadge('reviews', pendingReviews);
    setBadge('support', unreadSupport);
    // شارة على قسم إرسال الأرباح إن وُجد
    let payBadge = document.getElementById('badge-payouts');
    if (!payBadge) {
      const link = document.querySelector('[data-section="sellerPayouts"]');
      if (link) {
        payBadge = document.createElement('span');
        payBadge.id = 'badge-payouts';
        payBadge.className = 'badge bg-danger nav-badge d-none';
        link.appendChild(payBadge);
      }
    }
    if (payBadge) {
      if (pendingPayouts > 0) {
        payBadge.textContent = pendingPayouts > 99 ? '99+' : pendingPayouts;
        payBadge.classList.remove('d-none');
      } else payBadge.classList.add('d-none');
    }
  } catch (e) { console.error(e); }
}
// الشارات: لا قراءة عند فتح الأدمن — فقط عند الحاجة أو كل 10 دقائق بعد أول تفاعل
let _badgesStarted = false;
function ensureBadgeRefresh() {
  if (_badgesStarted) return;
  _badgesStarted = true;
  refreshNavBadges();
  setInterval(refreshNavBadges, 600000);
}
// لوحة التحكم ظاهرة افتراضياً → إحصائيات فقط (loadStats بالأسفل)
// الشارات تتأجل لأول تنقل لقسم فيه شارة
document.querySelector('.admin-sidebar')?.addEventListener('click', (e) => {
  if (e.target.closest('[data-section]')) ensureBadgeRefresh();
}, { once: true });

// Banned search
let _bannedCache = { banned: [], deleted: [] };
const _oldLoadBanned = typeof loadBanned === 'function' ? loadBanned : null;

async function loadBanned() {
  const list = document.getElementById('bannedList');
  list.innerHTML = '<div class="text-center"><div class="spinner-border"></div></div>';
  try {
    // قراءات مفلترة بدل مسح كل المستخدمين
    let bannedDocs = [], deletedDocs = [];
    try {
      const b = await getDocs(query(collection(db, 'users'), where('banned', '==', true), limit(100)));
      bannedDocs = b.docs;
    } catch(e) { console.warn(e.message); }
    try {
      const d = await getDocs(query(collection(db, 'users'), where('deleted', '==', true), limit(100)));
      deletedDocs = d.docs;
    } catch(e) { console.warn(e.message); }
    _bannedCache.banned = bannedDocs;
    _bannedCache.deleted = deletedDocs;
    renderBannedLists();
  } catch (err) {
    list.innerHTML = `<div class="alert alert-danger">${err.message}</div>`;
  }
}

function renderBannedLists() {
  const list = document.getElementById('bannedList');
  const bq = (document.getElementById('bannedSearch')?.value || '').toLowerCase();
  const dq = (document.getElementById('deletedSearch')?.value || '').toLowerCase();
  let banned = _bannedCache.banned;
  let deleted = _bannedCache.deleted;
  if (bq) banned = banned.filter(d => {
    const u = d.data();
    return (u.name||'').toLowerCase().includes(bq) || (u.email||'').toLowerCase().includes(bq);
  });
  if (dq) deleted = deleted.filter(d => {
    const u = d.data();
    return (u.name||'').toLowerCase().includes(dq) || (u.email||'').toLowerCase().includes(dq);
  });

  let html = '<h5 class="mt-3">المحظورون</h5>';
  if (banned.length === 0) html += '<p class="text-muted">لا يوجد محظورون</p>';
  else {
    html += '<ul class="list-group mb-4">';
    banned.forEach(d => {
      const u = d.data();
      html += `<li class="list-group-item d-flex justify-content-between align-items-center">
        ${u.name || '-'} (${u.email || '-'})
        <button class="btn btn-sm btn-success unban-btn" data-id="${d.id}">فك الحظر</button>
      </li>`;
    });
    html += '</ul>';
  }
  html += '<h5>المحذوفون</h5>';
  if (deleted.length === 0) html += '<p class="text-muted">لا يوجد محذوفون</p>';
  else {
    html += '<ul class="list-group">';
    deleted.forEach(d => {
      const u = d.data();
      html += `<li class="list-group-item">${u.name || '-'} (${u.email || '-'})</li>`;
    });
    html += '</ul>';
  }
  list.innerHTML = html;
  list.querySelectorAll('.unban-btn').forEach(btn => {
    btn.onclick = async () => {
      try {
        await updateDoc(doc(db, 'users', btn.dataset.id), { banned: false, unbannedAt: serverTimestamp() });
        showToast('تم فك الحظر');
        loadBanned();
      } catch(e) { showToast(e.message, 'error'); }
    };
  });
}
document.getElementById('bannedSearch')?.addEventListener('input', renderBannedLists);
document.getElementById('deletedSearch')?.addEventListener('input', renderBannedLists);

// ===== Detailed Report =====

// ===== Admin My Earnings (no 5% cut) =====
function toDateSafe(ts) {
  if (!ts) return null;
  if (ts.toDate) return ts.toDate();
  if (ts.seconds) return new Date(ts.seconds * 1000);
  return new Date(ts);
}
function inDateRangeDate(date, from, to) {
  if (!date) return !from && !to;
  try {
    const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    if (from) { const f = new Date(from); if (d < f) return false; }
    if (to) { const t = new Date(to); if (d > t) return false; }
    return true;
  } catch (e) { return true; }
}

async function loadAdminMyEarnings() {
  const list = document.getElementById('adminEarningsList');
  if (!list) return;
  list.innerHTML = '<div class="text-center py-3"><div class="spinner-border text-primary"></div></div>';
  try {
    const [projSnap, purchSnap] = await Promise.all([
      getDocs(query(collection(db, 'projects'), limit(150))),
      getDocs(query(collection(db, 'purchases'), limit(150)))
    ]);
    const officialProjs = projSnap.docs.filter(d => d.data().isOfficial || d.data().sellerId === 'official');
    const purchases = purchSnap.docs
      .filter(d => {
        const p = d.data();
        return p.status === 'approved' && !p.earningsVoided && (p.sellerId === 'official' || officialProjs.some(op => op.id === p.projectId));
      })
      .map(d => ({ id: d.id, ...d.data(), _date: toDateSafe(d.data().approvedAt || d.data().createdAt) }));

    window._adminEarnPurchases = purchases;
    window._adminOfficialProjs = officialProjs.map(d => ({ id: d.id, ...d.data() }));

    renderAdminEarnings();
  } catch (e) {
    list.innerHTML = '<div class="alert alert-danger">' + e.message + '</div>';
  }
}

function renderAdminEarnings() {
  const from = document.getElementById('adminEarnFrom')?.value || null;
  const to = document.getElementById('adminEarnTo')?.value || null;
  const purchases = (window._adminEarnPurchases || []).filter(p => inDateRangeDate(p._date, from, to));
  let gross = 0, buyers = 0;
  purchases.forEach(p => { const pr = parseFloat(p.amount || p.price) || 0; if (pr > 0) { gross += pr; buyers++; } });
  document.getElementById('adminTotalGross').textContent = gross.toFixed(2) + ' ج.م';
  document.getElementById('adminTotalBuyers').textContent = buyers;

  const list = document.getElementById('adminEarningsList');
  const projs = window._adminOfficialProjs || [];
  if (projs.length === 0) {
    list.innerHTML = '<div class="alert alert-info">لا توجد مشاريع رسمية</div>';
    return;
  }
  list.innerHTML = projs.map(proj => {
    const prods = purchases.filter(p => p.projectId === proj.id);
    let g = 0, b = 0;
    prods.forEach(p => { const pr = parseFloat(p.amount || p.price) || 0; if (pr > 0) { g += pr; b++; } });
    return `<div class="card mb-2"><div class="card-body d-flex justify-content-between align-items-center">
      <div><strong>${proj.title || 'مشروع'}</strong><br><small class="text-muted">${proj.price || 0} ج.م</small></div>
      <div class="text-end">إجمالي: <strong>${g.toFixed(2)}</strong> | مشترين: <strong>${b}</strong></div>
    </div></div>`;
  }).join('');
}

document.getElementById('adminEarnFilter')?.addEventListener('click', renderAdminEarnings);
document.getElementById('adminEarnClear')?.addEventListener('click', () => {
  document.getElementById('adminEarnFrom').value = '';
  document.getElementById('adminEarnTo').value = '';
  renderAdminEarnings();
});

// ===== Users Earnings =====
async function loadUsersEarningsList() {
  const list = document.getElementById('usersEarningsList');
  const detail = document.getElementById('userEarnDetail');
  if (detail) detail.classList.add('d-none');
  list.innerHTML = '<div class="text-center py-3"><div class="spinner-border text-primary"></div></div>';
  try {
    const usersSnap = await getDocs(query(collection(db, 'users'), limit(150)));
    const purchSnap = await getDocs(query(collection(db, 'purchases'), where('status', '==', 'approved'), limit(200)));
    const approved = purchSnap.docs.filter(d => {
      const p = d.data();
      return p.status === 'approved' && !p.earningsVoided && (parseFloat(p.amount || p.price) || 0) > 0;
    });

    const sellerMap = {};
    approved.forEach(d => {
      const p = d.data();
      const sid = p.sellerId;
      if (!sid || sid === 'official') return;
      if (!sellerMap[sid]) sellerMap[sid] = { gross: 0, net: 0, buyers: 0 };
      const amt = parseFloat(p.amount || p.price) || 0;
      const parts = calcCommissionParts(amt, getPurchaseCommissionRate(p));
      sellerMap[sid].gross += amt;
      sellerMap[sid].net += parts.net;
      sellerMap[sid].buyers++;
    });

    const rows = usersSnap.docs
      .filter(d => !d.data().banned && !d.data().deleted && sellerMap[d.id])
      .map(d => {
        const u = d.data();
        const e = sellerMap[d.id];
        return { id: d.id, name: u.name || '', email: u.email || '', gross: e.gross, net: e.net, buyers: e.buyers };
      })
      .sort((a, b) => b.gross - a.gross);

    window._usersEarnRows = rows;
    renderUsersEarnList(rows);
  } catch (e) {
    list.innerHTML = '<div class="alert alert-danger">' + e.message + '</div>';
  }
}

function renderUsersEarnList(rows) {
  const list = document.getElementById('usersEarningsList');
  if (!rows.length) {
    list.innerHTML = '<div class="alert alert-info">لا يوجد مستخدمون لديهم أرباح</div>';
    return;
  }
  list.innerHTML = `<div class="table-responsive"><table class="table table-hover">
    <thead><tr><th>الاسم</th><th>الإيميل</th><th>إجمالي</th><th>صافي (بعد العمولة المحسوبة)</th><th>مشترين</th><th></th></tr></thead>
    <tbody>${rows.map(r => `
      <tr>
        <td>${r.name}</td>
        <td>${r.email}</td>
        <td>${r.gross.toFixed(2)}</td>
        <td class="text-success">${r.net.toFixed(2)}</td>
        <td>${r.buyers}</td>
        <td><button class="btn btn-sm btn-outline-primary view-user-earn" data-id="${r.id}" data-name="${(r.name||'').replace(/"/g,'&quot;')}">عرض التفاصيل</button></td>
      </tr>`).join('')}
    </tbody></table></div>`;

  list.querySelectorAll('.view-user-earn').forEach(btn => {
    btn.onclick = () => showUserEarnDetail(btn.dataset.id, btn.dataset.name);
  });
}

document.getElementById('usersEarnSearch')?.addEventListener('input', (e) => {
  const q = e.target.value.trim().toLowerCase();
  const rows = (window._usersEarnRows || []).filter(r =>
    (r.name || '').toLowerCase().includes(q) ||
    (r.email || '').toLowerCase().includes(q) ||
    (r.id || '').toLowerCase().includes(q)
  );
  renderUsersEarnList(rows);
});

async function showUserEarnDetail(userId, name) {
  const detail = document.getElementById('userEarnDetail');
  detail.classList.remove('d-none');
  detail.innerHTML = '<div class="text-center py-3"><div class="spinner-border text-primary"></div></div>';
  try {
    const [projSnap, purchSnap] = await Promise.all([
      getDocs(query(collection(db, 'projects'), limit(150))),
      getDocs(query(collection(db, 'purchases'), limit(150)))
    ]);
    const myProjs = projSnap.docs.filter(d => d.data().sellerId === userId && (parseFloat(d.data().price)||0) > 0).map(d => ({ id: d.id, ...d.data() }));
    const purchases = purchSnap.docs
      .filter(d => {
        const p = d.data();
        return p.status === 'approved' && !p.earningsVoided && p.sellerId === userId;
      })
      .map(d => ({ id: d.id, ...d.data(), _date: toDateSafe(d.data().approvedAt || d.data().createdAt) }));

    let totalGross = 0, totalBuyers = 0;
    purchases.forEach(p => { const pr = parseFloat(p.amount || p.price)||0; if (pr>0){ totalGross+=pr; totalBuyers++; } });
    let totalNet = 0; purchases.forEach(p => { totalNet += calcCommissionParts(parseFloat(p.amount||p.price)||0, getPurchaseCommissionRate(p)).net; });

    detail.innerHTML = `
      <div class="card"><div class="card-body">
        <h5>أرباح: ${name}</h5>
        <div class="row g-2 mb-3">
          <div class="col-4"><div class="border rounded p-2 text-center"><div class="fw-bold">${totalGross.toFixed(2)}</div><small>إجمالي</small></div></div>
          <div class="col-4"><div class="border rounded p-2 text-center"><div class="fw-bold text-success">${totalNet.toFixed(2)}</div><small>صافي بعد العمولة</small></div></div>
          <div class="col-4"><div class="border rounded p-2 text-center"><div class="fw-bold">${totalBuyers}</div><small>مشترين</small></div></div>
        </div>
        <h6>المشاريع</h6>
        ${myProjs.map(proj => {
          const prods = purchases.filter(p => p.projectId === proj.id);
          let g=0,b=0; prods.forEach(p=>{const pr=parseFloat(p.amount||p.price)||0; if(pr>0){g+=pr;b++;}}); const netP = prods.reduce((s,p)=>s+calcCommissionParts(parseFloat(p.amount||p.price)||0, getPurchaseCommissionRate(p)).net,0);
          return `<div class="border-bottom py-2 d-flex justify-content-between">
            <span>${proj.title || 'مشروع'}</span>
            <span>إجمالي ${g.toFixed(2)} | صافي ${netP.toFixed(2)} | مشترين ${b}</span>
          </div>`;
        }).join('') || '<div class="text-muted">لا توجد مشاريع</div>'}
      </div></div>`;
  } catch (e) {
    detail.innerHTML = '<div class="alert alert-danger">' + e.message + '</div>';
  }
}

// ===== Commission Earnings (5% from user sales) =====
async function loadCommissionEarnings() {
  const list = document.getElementById('commDetailsList');
  if (!list) return;
  list.innerHTML = '<div class="text-center py-3"><div class="spinner-border text-primary"></div></div>';
  try {
    const [projSnap, purchSnap] = await Promise.all([
      getDocs(query(collection(db, 'projects'), limit(150))),
      getDocs(query(collection(db, 'purchases'), limit(150)))
    ]);
    const userProjs = projSnap.docs
      .filter(d => !d.data().isOfficial && d.data().sellerId && d.data().sellerId !== 'official')
      .map(d => ({ id: d.id, ...d.data() }));

    const purchases = purchSnap.docs
      .filter(d => {
        const p = d.data();
        return p.status === 'approved' && !p.earningsVoided && p.sellerId && p.sellerId !== 'official' && (parseFloat(p.amount || p.price) || 0) > 0;
      })
      .map(d => ({ id: d.id, ...d.data(), _date: toDateSafe(d.data().approvedAt || d.data().createdAt) }));

    window._commPurchases = purchases;
    window._commProjs = userProjs;
    renderCommissionEarnings();
  } catch (e) {
    list.innerHTML = '<div class="alert alert-danger">' + e.message + '</div>';
  }
}

function renderCommissionEarnings() {
  const from = document.getElementById('commFrom')?.value || null;
  const to = document.getElementById('commTo')?.value || null;
  const purchases = (window._commPurchases || []).filter(p => inDateRangeDate(p._date, from, to));
  const projs = window._commProjs || [];

  let totalSales = 0;
  const sellerSet = new Set();
  const productSet = new Set();
  purchases.forEach(p => {
    const pr = parseFloat(p.amount || p.price) || 0;
    totalSales += pr;
    if (p.sellerId) sellerSet.add(p.sellerId);
    if (p.projectId) productSet.add(p.projectId);
  });
  let commission = 0; purchases.forEach(p => { commission += calcCommissionParts(parseFloat(p.amount||p.price)||0, getPurchaseCommissionRate(p)).commission; });

  document.getElementById('commTotal').textContent = commission.toFixed(2) + ' ج.م';
  document.getElementById('commSales').textContent = totalSales.toFixed(2) + ' ج.م';
  document.getElementById('commUsers').textContent = sellerSet.size;
  document.getElementById('commProducts').textContent = productSet.size;

  const list = document.getElementById('commDetailsList');
  if (purchases.length === 0) {
    list.innerHTML = '<div class="alert alert-info">لا توجد مبيعات مستخدمين في هذه الفترة</div>';
    return;
  }

  // Group by project + سجل كل عملية بعمولتها وقت الشراء
  const byProj = {};
  purchases.forEach(p => {
    const pid = p.projectId || 'unknown';
    if (!byProj[pid]) byProj[pid] = { sales: 0, buyers: 0, sellerId: p.sellerId, title: p.projectTitle || pid, items: [] };
    const pr = parseFloat(p.amount || p.price) || 0;
    byProj[pid].sales += pr;
    byProj[pid].buyers++;
    byProj[pid].items.push(p);
  });
  projs.forEach(pr => {
    if (byProj[pr.id]) byProj[pr.id].title = pr.title || byProj[pr.id].title;
  });

  list.innerHTML = Object.entries(byProj).map(([pid, v]) => {
    const comm = v.items.reduce((s, p) => s + calcCommissionParts(parseFloat(p.amount||p.price)||0, getPurchaseCommissionRate(p)).commission, 0);
    const rates = [...new Set(v.items.map(p => getPurchaseCommissionRate(p) + '%'))].join(' / ');
    const rows = v.items.map(p => {
      const amt = parseFloat(p.amount || p.price) || 0;
      const parts = calcCommissionParts(amt, getPurchaseCommissionRate(p));
      const dt = p._date ? (p._date.toLocaleString?.('ar-EG') || '') : '';
      return `<div class="small border-bottom py-1 d-flex flex-wrap justify-content-between gap-2">
        <span>${dt || 'عملية'} — ${amt.toFixed(2)} ج.م</span>
        <span>عمولة <strong>${parts.rate}%</strong> = <strong class="text-success">${parts.commission.toFixed(2)}</strong> | صافي البائع ${parts.net.toFixed(2)}</span>
      </div>`;
    }).join('');
    return `<div class="card mb-2"><div class="card-body">
      <div class="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-2">
        <div>
          <strong>${v.title}</strong>
          <div class="small text-muted">ID: ${pid} | بائع: ${v.sellerId || '-'}</div>
        </div>
        <div class="text-end">
          <div>مبيعات: <strong>${v.sales.toFixed(2)} ج.م</strong></div>
          <div class="text-success">إجمالي العمولة (<span class="text-muted">${rates}</span>): <strong>${comm.toFixed(2)} ج.م</strong></div>
          <div>مشترين: ${v.buyers}</div>
        </div>
      </div>
      <div class="mt-2 p-2 rounded" style="background:#f8f9fa">${rows}</div>
    </div></div>`;
  }).join('');
}

document.getElementById('commFilterBtn')?.addEventListener('click', renderCommissionEarnings);
document.getElementById('commClearBtn')?.addEventListener('click', () => {
  document.getElementById('commFrom').value = '';
  document.getElementById('commTo').value = '';
  renderCommissionEarnings();
});

// ===== Firebase Usage (estimate) =====
async function loadFirebaseUsage() {
  const cards = document.getElementById('fbUsageCards');
  const detail = document.getElementById('fbCollectionsDetail');
  if (!cards) return;
  cards.innerHTML = '<div class="col-12 text-center py-4"><div class="spinner-border text-primary"></div></div>';
  if (detail) detail.innerHTML = '';

  const collections = [
    { name: 'users', label: 'المستخدمون' },
    { name: 'projects', label: 'المشاريع' },
    { name: 'purchases', label: 'المشتريات' },
    { name: 'notifications', label: 'الإشعارات' },
    { name: 'comments', label: 'التعليقات' },
    { name: 'supportChats', label: 'محادثات الدعم' },
    { name: 'news', label: 'الأخبار' }
  ];

  try {
    const results = [];
    let totalDocs = 0;
    for (const c of collections) {
      try {
        const snap = await getDocs(query(collection(db, c.name), limit(100))); // عينة لتقليل الحرق
        const count = snap.size;
        totalDocs += count;
        results.push({ ...c, count });
      } catch (e) {
        results.push({ ...c, count: 0, error: true });
      }
    }

    // Spark daily limits (for reference)
    const readLimit = 50000;
    const writeLimit = 20000;
    // We can't know actual reads/writes from client; show doc counts as activity proxy
    cards.innerHTML = `
      <div class="col-md-4">
        <div class="stat-card text-center">
          <div class="stat-number">${totalDocs}</div>
          <div>إجمالي المستندات (تقدير)</div>
        </div>
      </div>
      <div class="col-md-4">
        <div class="stat-card text-center">
          <div class="stat-number">50,000</div>
          <div>حد القراءات اليومي (Reads)</div>
          <small class="text-muted">يتجدد يومياً UTC</small>
        </div>
      </div>
      <div class="col-md-4">
        <div class="stat-card text-center">
          <div class="stat-number">20,000</div>
          <div>حد الكتابات اليومي (Writes)</div>
          <small class="text-muted">يتجدد يومياً UTC</small>
        </div>
      </div>
      <div class="col-12">
        <div class="alert alert-warning mb-0">
          <strong>مهم:</strong> عدد المستندات ≠ عدد القراءات/الكتابات الفعلي. كل فتح صفحة أو تحميل قائمة يستهلك Reads. للأرقام الدقيقة ادخل 
          <a href="https://console.firebase.google.com/project/misran-4b187/usage" target="_blank">Firebase Console → Usage</a>.
        </div>
      </div>
    `;

    detail.innerHTML = `
      <div class="table-responsive">
        <table class="table table-sm table-hover">
          <thead><tr><th>المجموعة</th><th>عدد المستندات</th><th>الحالة</th></tr></thead>
          <tbody>
            ${results.map(r => `
              <tr>
                <td><code>${r.name}</code> — ${r.label}</td>
                <td><strong>${r.count}</strong></td>
                <td>${r.error ? '<span class="text-danger">تعذر القراءة</span>' : '<span class="text-success">OK</span>'}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
      <p class="small text-muted mb-0">
        حدود Storage المجانية: 1 GB تخزين + 10 GB تنزيل شهرياً.<br>
        الفترة المجانية (Spark) لا تنتهي طالما لم تتجاوز الحدود اليومية/الشهرية. لو تجاوزت الحدود يتوقف المشروع مؤقتاً حتى التجديد أو الترقية لـ Blaze.
      </p>
    `;
  } catch (e) {
    cards.innerHTML = `<div class="col-12"><div class="alert alert-danger">${e.message}</div></div>`;
  }
}

document.getElementById('fbRefreshBtn')?.addEventListener('click', loadFirebaseUsage);

// ===== Seller Payouts =====
async function loadSellerPayouts() {
  const list = document.getElementById('sellerPayoutsList');
  if (!list) return;
  list.innerHTML = '<div class="text-center py-3"><div class="spinner-border text-primary"></div></div>';
  try {
    // قراءة واحدة محدودة فقط عند فتح القسم — لا قراءات إضافية عند الطي/الفتح
    const snap = await getDocs(query(collection(db, 'purchases'), where('status', '==', 'approved'), limit(100)));
    const rows = snap.docs.filter(d => {
      const p = d.data();
      return (parseFloat(p.amount || p.price) || 0) > 0 && p.sellerId && p.sellerId !== 'official';
    }).sort((a,b) => (b.data().createdAt?.toMillis?.()||0) - (a.data().createdAt?.toMillis?.()||0));

    const groupByProject = (arr) => {
      const map = new Map();
      arr.forEach(d => {
        const p = d.data();
        const key = p.projectId || p.projectTitle || d.id;
        if (!map.has(key)) {
          map.set(key, {
            projectId: p.projectId || '',
            title: p.projectTitle || 'منتج',
            sellerId: p.sellerId || '',
            sellerName: p.sellerName || p.sellerId || '',
            method: p.sellerPayMethod || p.paymentMethod || '-',
            number: p.sellerPayNumber || p.paymentNumber || '-',
            payName: p.sellerPayName || p.paymentName || '-',
            items: []
          });
        }
        map.get(key).items.push(d);
      });
      return Array.from(map.values());
    };

    const pendingRows = rows.filter(d => !d.data().payoutSent);
    const sentRows = rows.filter(d => !!d.data().payoutSent);
    const pendingGroups = groupByProject(pendingRows);
    const sentGroups = groupByProject(sentRows);

    // بطاقة مطوية: اسم المنتج + سهم فقط — التفاصيل تظهر عند الضغط (بدون قراءة إضافية)
    const groupHtml = (g, showConfirm) => {
      const total = g.items.reduce((s, d) => s + (parseFloat(d.data().amount || d.data().price) || 0), 0);
      const net = g.items.reduce((s, d) => {
        const p = d.data();
        const amt = parseFloat(p.amount||p.price)||0;
        return s + calcCommissionParts(amt, getPurchaseCommissionRate(p)).net;
      }, 0).toFixed(2);
      const count = g.items.length;
      const uid = 'pg_' + (g.projectId || g.title).toString().replace(/[^a-zA-Z0-9\u0600-\u06FF]/g, '_').slice(0, 40) + '_' + Math.random().toString(36).slice(2, 7);

      const itemsHtml = g.items.map(d => {
        const p = d.data();
        const amt = parseFloat(p.amount || p.price) || 0;
        const parts = calcCommissionParts(amt, getPurchaseCommissionRate(p));
        const dt = p.createdAt?.toDate?.().toLocaleString('ar-EG') || p.approvedAt?.toDate?.().toLocaleString('ar-EG') || '-';
        return `<div class="border rounded p-2 mb-2 bg-white">
          <div class="d-flex flex-wrap justify-content-between gap-2 align-items-start">
            <div>
              <div class="small">المشتري: <strong>${p.buyerName || p.buyerEmail || '-'}</strong></div>
              <div class="small text-muted">ID الشراء: ${d.id}</div>
              <div class="small text-muted">${dt}</div>
            </div>
            <div class="text-end">
              <div>الإجمالي: <strong>${amt}</strong> ج</div>
              <div class="small text-success">صافي التاجر: ${parts.net.toFixed(2)} ج</div>
              ${showConfirm ? `<button class="btn btn-sm btn-primary confirm-payout mt-1" data-id="${d.id}" data-seller="${p.sellerId||''}" data-title="${(p.projectTitle||g.title||'').replace(/"/g,'&quot;')}">تأكيد إرسال هذا الطلب</button>` : (p.payoutSentAt ? `<div class="small text-muted">أُرسل: ${p.payoutSentAt?.toDate?.().toLocaleString('ar-EG')||''}</div>` : '')}
            </div>
          </div>
        </div>`;
      }).join('');

      return `<div class="card mb-2 payout-group" data-search="${(g.title + ' ' + g.projectId + ' ' + g.sellerId + ' ' + g.sellerName + ' ' + g.number).toLowerCase()}">
        <div class="card-body py-2 px-3">
          <div class="d-flex align-items-center justify-content-between gap-2 payout-toggle" role="button" data-target="${uid}" style="cursor:pointer;user-select:none;">
            <div class="d-flex align-items-center gap-2 flex-grow-1 min-w-0">
              <i class="fas fa-chevron-left payout-arrow text-primary transition-transform" id="arrow_${uid}" style="transition:transform .2s;"></i>
              <div class="text-truncate">
                <strong class="d-block text-truncate">${g.title}</strong>
                <span class="small text-muted">${count} عملية · صافي ${net} ج · ${g.sellerName || g.sellerId || ''}</span>
              </div>
            </div>
            <span class="badge ${showConfirm ? 'bg-warning text-dark' : 'bg-success'} flex-shrink-0">${showConfirm ? 'بانتظار الإرسال' : 'تم الإرسال'}</span>
          </div>
          <div id="${uid}" class="payout-details d-none mt-3 border-top pt-3">
            <div class="row g-2 mb-2 small">
              <div class="col-md-4"><span class="text-muted">البائع:</span> ${g.sellerName || '-'} <code class="small">${g.sellerId || ''}</code></div>
              <div class="col-md-4"><span class="text-muted">وسيلة الدفع:</span> ${g.method} — ${g.payName}</div>
              <div class="col-md-4">
                <span class="text-muted">رقم الحساب:</span>
                <code>${g.number}</code>
                ${g.number && g.number !== '-' ? `<button type="button" class="btn btn-link btn-sm p-0 copy-pay-num" data-num="${(g.number||'').replace(/"/g,'&quot;')}">نسخ</button>` : ''}
              </div>
              <div class="col-md-4"><span class="text-muted">معرف المنتج:</span> <code>${g.projectId || '-'}</code></div>
              <div class="col-md-4"><span class="text-muted">إجمالي المبيعات:</span> ${total.toFixed(2)} ج</div>
              <div class="col-md-4"><span class="text-muted">صافي للتاجر:</span> <strong class="text-success">${net} ج</strong></div>
            </div>
            <h6 class="mb-2">تفاصيل المشتريات (${count})</h6>
            ${itemsHtml}
          </div>
        </div>
      </div>`;
    };

    list.innerHTML = `
      <input type="search" class="form-control mb-3" id="sellerPayoutsSearchLive" placeholder="بحث باسم المنتج أو ID المنتج أو البائع أو رقم الحساب...">
      <ul class="nav nav-tabs mb-3">
        <li class="nav-item"><button class="nav-link active" data-bs-toggle="tab" data-bs-target="#payoutPendingTab" type="button">لم يتم الإرسال <span class="badge bg-warning text-dark">${pendingRows.length}</span></button></li>
        <li class="nav-item"><button class="nav-link" data-bs-toggle="tab" data-bs-target="#payoutSentTab" type="button">تم الإرسال <span class="badge bg-success">${sentRows.length}</span></button></li>
      </ul>
      <div class="tab-content">
        <div class="tab-pane fade show active" id="payoutPendingTab">
          ${pendingGroups.length ? pendingGroups.map(g => groupHtml(g, true)).join('') : '<div class="alert alert-info">لا توجد أرباح بانتظار الإرسال</div>'}
        </div>
        <div class="tab-pane fade" id="payoutSentTab">
          ${sentGroups.length ? sentGroups.map(g => groupHtml(g, false)).join('') : '<div class="alert alert-secondary">لا توجد عمليات تم إرسالها بعد</div>'}
        </div>
      </div>`;

    // طي/فتح بالسهم — بدون أي قراءة من Firebase
    list.querySelectorAll('.payout-toggle').forEach(el => {
      el.addEventListener('click', () => {
        const id = el.dataset.target;
        const box = document.getElementById(id);
        const arrow = document.getElementById('arrow_' + id);
        if (!box) return;
        const open = box.classList.contains('d-none');
        box.classList.toggle('d-none', !open);
        if (arrow) arrow.style.transform = open ? 'rotate(-90deg)' : '';
      });
    });

    list.querySelectorAll('.copy-pay-num').forEach(btn => {
      btn.onclick = async (e) => {
        e.stopPropagation();
        try { await navigator.clipboard.writeText(btn.dataset.num || ''); showToast('تم نسخ رقم الحساب'); }
        catch { showToast('تعذر النسخ', 'error'); }
      };
    });

    list.querySelectorAll('.confirm-payout').forEach(btn => {
      btn.onclick = async (e) => {
        e.stopPropagation();
        if (!(await siteConfirm('تأكيد أنك أرسلت أرباح هذا الطلب للتاجر؟', 'إرسال الأرباح'))) return;
        try {
          await updateDoc(doc(db, 'purchases', btn.dataset.id), { payoutSent: true, payoutSentAt: serverTimestamp() });
          if (btn.dataset.seller) {
            await addDoc(collection(db, 'notifications'), {
              userId: btn.dataset.seller,
              title: 'تم إرسال أرباحك',
              body: `تم إرسال أرباح مشروع "${btn.dataset.title}" إلى حسابك المالي.`,
              type: 'payout_sent', read: false, createdAt: serverTimestamp()
            });
          }
          showToast('تم التأكيد');
          loadSellerPayouts();
        } catch (err) { showToast(err.message, 'error'); }
      };
    });

    // بحث محلي (اسم / ID / بائع) — بدون قراءة إضافية
    const searchEl = document.getElementById('sellerPayoutsSearchLive') || document.getElementById('sellerPayoutsSearch');
    if (searchEl) {
      searchEl.oninput = () => {
        const q = (searchEl.value || '').trim().toLowerCase();
        list.querySelectorAll('.payout-group').forEach(card => {
          const hay = (card.dataset.search || '').toLowerCase();
          card.style.display = !q || hay.includes(q) ? '' : 'none';
        });
      };
    }
  } catch (e) {
    list.innerHTML = `<div class="alert alert-danger">${e.message}</div>`;
  }
}


async function showUserPurchases(userId, userName) {
  const panel = document.getElementById('userProductsPanel');
  if (!panel) return;
  panel.classList.remove('d-none');
  panel.innerHTML = '<div class="text-center py-3"><div class="spinner-border text-primary"></div></div>';
  try {
    const snap = await getDocs(query(collection(db, 'purchases'), where('buyerId', '==', userId)));
    const rows = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .sort((a,b) => (b.createdAt?.toMillis?.()||0)-(a.createdAt?.toMillis?.()||0));
    panel.innerHTML = `<div class="card shadow-sm"><div class="card-header d-flex justify-content-between bg-success text-white">
      <h5 class="mb-0">مشتريات: ${userName||userId}</h5>
      <button class="btn btn-sm btn-light" onclick="document.getElementById('userProductsPanel').classList.add('d-none')">إغلاق</button>
    </div><div class="card-body">
      ${rows.length ? rows.map(r => `<div class="border-bottom py-2">
        <strong>${r.projectTitle || r.snapshot?.title || r.projectId}</strong>
        <div class="small">الحالة: ${r.status} | المبلغ: ${r.amount||r.price||0} ج.م</div>
        <div class="small text-muted">ID: ${r.id}</div>
      </div>`).join('') : '<div class="text-muted">لا توجد مشتريات</div>'}
    </div></div>`;
  } catch (e) {
    panel.innerHTML = `<div class="alert alert-danger">${e.message}</div>`;
  }
}

async function showUserFullDetails(userId) {
  const panel = document.getElementById('userProductsPanel');
  if (!panel) return;
  panel.classList.remove('d-none');
  panel.innerHTML = '<div class="text-center py-3"><div class="spinner-border text-primary"></div></div>';
  try {
    const snap = await getDoc(doc(db, 'users', userId));
    if (!snap.exists()) {
      panel.innerHTML = '<div class="alert alert-warning">المستخدم غير موجود</div>';
      return;
    }
    const u = snap.data();
    const photo = u.photoURL || u.avatarUrl || '';
    const photoBlock = photo
      ? `<div class="text-center mb-3"><img src="${photo}" alt="" style="width:96px;height:96px;border-radius:50%;object-fit:cover;border:3px solid #eee;"></div>`
      : `<div class="text-center mb-3"><div class="bg-secondary text-white rounded-circle d-inline-flex align-items-center justify-content-center" style="width:96px;height:96px;font-size:2rem;">${(u.name||'?')[0]}</div></div>`;
    panel.innerHTML = `<div class="card shadow-sm"><div class="card-header d-flex justify-content-between bg-dark text-white">
      <h5 class="mb-0">تفاصيل المستخدم</h5>
      <button class="btn btn-sm btn-light" onclick="document.getElementById('userProductsPanel').classList.add('d-none')">إغلاق</button>
    </div><div class="card-body">
      ${photoBlock}
      <p><strong>الاسم:</strong> ${u.name || '-'}</p>
      <p><strong>الإيميل:</strong> ${u.email || '-'}</p>
      <p><strong>الهاتف:</strong> ${u.phone || '-'}</p>
      <p><strong>النبذة:</strong> ${u.bio || '-'}</p>
      <p><strong>الرصيد:</strong> ${parseFloat(u.balance)||0} ج.م</p>
      <p><strong>الحالة:</strong> ${u.banned?'محظور':''} ${u.deleted?'محذوف':''} ${(!u.banned&&!u.deleted)?'نشط':''}</p>
      <p><strong>تاريخ التسجيل:</strong> ${u.createdAt?.toDate?.().toLocaleString('ar-EG')||'-'}</p>
      <p class="mb-0"><strong>ID:</strong> <code>${userId}</code>
        <button class="btn btn-link btn-sm p-0" onclick="navigator.clipboard.writeText('${userId}')">نسخ</button></p>
    </div></div>`;
  } catch (e) {
    panel.innerHTML = `<div class="alert alert-danger">${e.message}</div>`;
  }
}
window.showUserPurchases = showUserPurchases;
window.showUserFullDetails = showUserFullDetails;


// ===== Drive settings (Apps Script URL) =====
async function loadDriveSettings() {
  try {
    const snap = await getDoc(doc(db, 'settings', 'drive'));
    const d = snap.exists() ? snap.data() : {};
    const urlEl = document.getElementById('driveScriptUrl');
    const secEl = document.getElementById('driveSecret');
    const foldEl = document.getElementById('driveFolderUrl');
    const maxEl = document.getElementById('driveMaxMb');
    if (urlEl) urlEl.value = d.scriptUrl || 'https://script.google.com/macros/s/AKfycbx4awlMRifgAxgECzCssVwl44Sx_dHoEeRYAV2EIt9iJVo-aPnOF_RyZ71kxJ-O-L76UQ/exec';
    if (secEl) secEl.value = d.secret || '';
    if (foldEl) foldEl.value = d.folderUrl || 'https://drive.google.com/drive/folders/1r_pMH_KZH-YlrllbqK0CbMvew00BhGqG?usp=sharing';
    if (maxEl) maxEl.value = d.maxMb || 15;
    const storeEl = document.getElementById('storePublicUrl');
    if (storeEl) storeEl.value = d.storePublicUrl || 'https://lamadh41-lgtm.github.io/sds/';
    if (d.storePublicUrl) window.STORE_BASE_URL = d.storePublicUrl.replace(/\/$/, '');
    const at = document.getElementById('driveUpdatedAt');
    if (at) at.textContent = d.updatedAt?.toDate?.().toLocaleString('ar-EG') || (d.updatedAt ? String(d.updatedAt) : '—');
  } catch (e) {
    showToast(e.message, 'error');
  }
}

document.getElementById('saveDriveSettingsBtn')?.addEventListener('click', async () => {
  const scriptUrl = document.getElementById('driveScriptUrl')?.value.trim() || '';
  const secret = '';
  const folderUrl = document.getElementById('driveFolderUrl')?.value.trim() || '';
  const maxMb = parseFloat(document.getElementById('driveMaxMb')?.value) || 15;
  const storePublicUrl = document.getElementById('storePublicUrl')?.value.trim() || '';
  if (!scriptUrl) { showToast('أدخل رابط السكربت', 'error'); return; }
  showLoading(true);
  try {
    await setDoc(doc(db, 'settings', 'drive'), {
      scriptUrl,
      secret,
      folderUrl,
      maxMb,
      storePublicUrl,
      updatedAt: serverTimestamp()
    }, { merge: true });
    if (storePublicUrl) window.STORE_BASE_URL = storePublicUrl.replace(/\/$/, '');
    const msg = document.getElementById('driveSaveMsg');
    if (msg) msg.innerHTML = '<div class="alert alert-success mb-0"><i class="fas fa-check me-1"></i>تم تجديد إعدادات الرفع. الملفات القديمة في الموقع لم تُمس وتظل بروابطها كما هي.</div>';
    showToast('تم حفظ إعدادات Drive');
    loadDriveSettings();
  } catch (e) {
    showToast(e.message, 'error');
  } finally {
    showLoading(false);
  }
});


document.getElementById('testDriveBtn')?.addEventListener('click', async () => {
  const scriptUrl = document.getElementById('driveScriptUrl')?.value.trim();
  const secret = '';
  const msg = document.getElementById('driveSaveMsg');
  if (!scriptUrl) { showToast('أدخل رابط السكربت أولاً', 'error'); return; }
  if (msg) msg.innerHTML = '<div class="alert alert-secondary">جاري الاختبار...</div>';
  try {
    const payload = JSON.stringify({
      secret,
      fileName: 'connection-test.txt',
      mimeType: 'text/plain',
      base64: btoa('misran-drive-test')
    });
    const text = await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', scriptUrl, true);
      xhr.setRequestHeader('Content-Type', 'text/plain;charset=utf-8');
      xhr.timeout = 30000;
      xhr.onload = () => resolve(xhr.responseText || '');
      xhr.onerror = () => reject(new Error('Failed to fetch / network error'));
      xhr.ontimeout = () => reject(new Error('timeout'));
      xhr.send(payload);
    });
    let data;
    try { data = JSON.parse(text); } catch {
      throw new Error('رد غير JSON: ' + text.slice(0, 150));
    }
    if (data.ok) {
      if (msg) msg.innerHTML = '<div class="alert alert-success">الاتصال ناجح ✅ تم رفع ملف اختبار على الدرايف.</div>';
      showToast('اختبار Drive ناجح');
    } else {
      if (msg) msg.innerHTML = `<div class="alert alert-warning">السكربت رد: ${data.error || 'خطأ'} — غالباً SECRET غير متطابق</div>`;
      showToast(data.error || 'فشل', 'error');
    }
  } catch (e) {
    if (msg) msg.innerHTML = `<div class="alert alert-danger">فشل الاتصال: ${e.message}<br>تأكد من Who has access = Anyone بعد New version، ولا تفتح الملف كـ file://</div>`;
    showToast(e.message, 'error');
  }
});

// ===== إعادة / إلغاء الربح (تجريبي) =====
async function loadResetEarningsUsers() {
  const list = document.getElementById('resetEarnUsersList');
  const detail = document.getElementById('resetEarnDetail');
  if (detail) detail.classList.add('d-none');
  if (!list) return;
  list.innerHTML = '<div class="text-center py-3"><div class="spinner-border text-primary"></div></div>';
  try {
    // قراءة محدودة: purchases المعتمدة فقط + users بأسمائهم
    const purchSnap = await getDocs(query(collection(db, 'purchases'), where('status', '==', 'approved'), limit(300)));
    const bySeller = {};
    purchSnap.docs.forEach(d => {
      const p = d.data();
      if (p.earningsVoided) return;
      let sid = p.sellerId;
      if (!sid) return;
      // مشاريع المحرك الرسمية تُحسب تحت official
      if (p.isOfficial) sid = 'official';
      const amount = parseFloat(p.amount || p.price) || 0;
      if (amount <= 0) return;
      if (!bySeller[sid]) bySeller[sid] = { gross: 0, count: 0, projectIds: new Set() };
      bySeller[sid].gross += amount;
      bySeller[sid].count++;
      if (p.projectId) bySeller[sid].projectIds.add(p.projectId);
    });
    // تأكد من ظهور المحرك حتى لو مفيش مشتريات حالياً (في المقدمة)
    if (!bySeller['official']) bySeller['official'] = { gross: 0, count: 0, projectIds: new Set() };

    const uids = Object.keys(bySeller).filter(id => id !== 'official');
    const rows = [];
    // المحرك دائماً في المقدمة
    rows.push({
      id: 'official',
      name: 'محرك مصران',
      email: 'حساب رسمي موثّق',
      gross: bySeller['official'].gross,
      count: bySeller['official'].count,
      projects: bySeller['official'].projectIds.size,
      isOfficial: true
    });
    for (const uid of uids.slice(0, 80)) {
      try {
        const uSnap = await getDoc(doc(db, 'users', uid));
        const u = uSnap.exists() ? uSnap.data() : {};
        rows.push({
          id: uid,
          name: u.name || uid.slice(0, 8),
          email: u.email || '',
          gross: bySeller[uid].gross,
          count: bySeller[uid].count,
          projects: bySeller[uid].projectIds.size
        });
      } catch {
        rows.push({ id: uid, name: uid.slice(0, 8), email: '', gross: bySeller[uid].gross, count: bySeller[uid].count, projects: bySeller[uid].projectIds.size });
      }
    }
    // باقي المستخدمين حسب الإجمالي (المحرك يبقى أول صف)
    const rest = rows.slice(1).sort((a, b) => b.gross - a.gross);
    window._resetEarnRows = [rows[0], ...rest];
    renderResetEarnUsers(window._resetEarnRows);
  } catch (e) {
    list.innerHTML = '<div class="alert alert-danger">' + (e.message || e) + '</div>';
  }
}

function renderResetEarnUsers(rows) {
  const list = document.getElementById('resetEarnUsersList');
  if (!list) return;
  if (!rows.length) {
    list.innerHTML = '<div class="alert alert-info">لا يوجد مستخدمون لديهم أرباح غير ملغاة</div>';
    return;
  }
  list.innerHTML = `<div class="table-responsive"><table class="table table-hover bg-white shadow-sm">
    <thead class="table-light"><tr><th>الاسم</th><th>الإيميل</th><th>إجمالي</th><th>مشتريات</th><th>منتجات</th><th></th></tr></thead>
    <tbody>${rows.map(r => `<tr class="${r.isOfficial || r.id==='official' ? 'table-warning' : ''}">
      <td>${r.name}${r.isOfficial || r.id==='official' ? ' <span class="badge bg-primary"><i class="fas fa-check-circle"></i> موثّق</span>' : ''}</td>
      <td class="small">${r.email}</td>
      <td class="fw-semibold">${r.gross.toFixed(2)} ج.م</td>
      <td>${r.count}</td><td>${r.projects}</td>
      <td>
        <button class="btn btn-sm btn-outline-primary reset-earn-view" data-id="${r.id}" data-name="${(r.name||'').replace(/"/g,'&quot;')}">عرض المنتجات</button>
        <button class="btn btn-sm btn-outline-danger reset-earn-all" data-id="${r.id}" data-name="${(r.name||'').replace(/"/g,'&quot;')}">إلغاء كل الربح</button>
      </td>
    </tr>`).join('')}</tbody></table></div>`;

  list.querySelectorAll('.reset-earn-view').forEach(btn => {
    btn.onclick = () => showResetEarnDetail(btn.dataset.id, btn.dataset.name);
  });
  list.querySelectorAll('.reset-earn-all').forEach(btn => {
    btn.onclick = async () => {
      if (!(await siteConfirm('تأكيد إلغاء كل أرباح المستخدم «' + btn.dataset.name + '»؟\nسيتم تصفير الأرباح في المعادلات ولن تُحسب العمولة عليها.', 'إلغاء كل الربح'))) return;
      await voidSellerEarnings(btn.dataset.id, null);
      loadResetEarningsUsers();
    };
  });
}

document.getElementById('resetEarnSearch')?.addEventListener('input', (e) => {
  const q = e.target.value.trim().toLowerCase();
  const rows = (window._resetEarnRows || []).filter(r =>
    (r.name || '').toLowerCase().includes(q) ||
    (r.email || '').toLowerCase().includes(q) ||
    (r.id || '').toLowerCase().includes(q)
  );
  renderResetEarnUsers(rows);
});

async function showResetEarnDetail(userId, name) {
  const detail = document.getElementById('resetEarnDetail');
  if (!detail) return;
  detail.classList.remove('d-none');
  detail.innerHTML = '<div class="text-center py-3"><div class="spinner-border text-primary"></div></div>';
  try {
    const [projSnap, purchSnap] = await Promise.all([
      getDocs(query(collection(db, 'projects'), where('sellerId', '==', userId), limit(80))),
      getDocs(query(collection(db, 'purchases'), where('sellerId', '==', userId), limit(200)))
    ]);
    const purchases = purchSnap.docs
      .filter(d => d.data().status === 'approved' && !d.data().earningsVoided && (parseFloat(d.data().amount || d.data().price) || 0) > 0)
      .map(d => ({ id: d.id, ...d.data() }));

    const byProj = {};
    purchases.forEach(p => {
      const pid = p.projectId || '_unknown';
      if (!byProj[pid]) byProj[pid] = { gross: 0, count: 0, title: p.projectTitle || p.title || pid };
      byProj[pid].gross += parseFloat(p.amount || p.price) || 0;
      byProj[pid].count++;
    });
    // أسماء المشاريع من projects إن وُجدت
    projSnap.docs.forEach(d => {
      if (byProj[d.id]) byProj[d.id].title = d.data().title || byProj[d.id].title;
    });

    const items = Object.entries(byProj).map(([pid, v]) => ({ id: pid, ...v }));
    detail.innerHTML = `
      <div class="card border-0 shadow-sm"><div class="card-body">
        <div class="d-flex justify-content-between align-items-center flex-wrap gap-2 mb-3">
          <h5 class="mb-0">منتجات: ${name}</h5>
          <button class="btn btn-sm btn-danger" id="voidAllForUserBtn">إلغاء كل ربح هذا المستخدم</button>
        </div>
        ${items.length ? `<div class="table-responsive"><table class="table table-sm">
          <thead><tr><th>المنتج</th><th>مبيعات</th><th>إجمالي</th><th></th></tr></thead>
          <tbody>${items.map(it => `<tr>
            <td>${it.title}</td>
            <td>${it.count}</td>
            <td>${it.gross.toFixed(2)} ج.م</td>
            <td><button class="btn btn-sm btn-outline-danger void-proj-earn" data-pid="${it.id}" data-title="${(it.title||'').replace(/"/g,'&quot;')}">إلغاء ربح المنتج</button></td>
          </tr>`).join('')}</tbody></table></div>` : '<div class="alert alert-info">لا توجد أرباح نشطة</div>'}
      </div></div>`;

    document.getElementById('voidAllForUserBtn')?.addEventListener('click', async () => {
      if (!(await siteConfirm('تأكيد إلغاء كل أرباح «' + name + '»؟', 'إلغاء كل الربح'))) return;
      await voidSellerEarnings(userId, null);
      showResetEarnDetail(userId, name);
      loadResetEarningsUsers();
    });
    detail.querySelectorAll('.void-proj-earn').forEach(btn => {
      btn.onclick = async () => {
        if (!(await siteConfirm('تأكيد إلغاء ربح المنتج «' + btn.dataset.title + '» فقط؟', 'إلغاء ربح المنتج'))) return;
        await voidSellerEarnings(userId, btn.dataset.pid);
        showResetEarnDetail(userId, name);
        loadResetEarningsUsers();
      };
    });
  } catch (e) {
    detail.innerHTML = '<div class="alert alert-danger">' + (e.message || e) + '</div>';
  }
}

/** إلغاء أرباح بائع (كل المنتجات أو منتج واحد) عبر earningsVoided */
async function voidSellerEarnings(sellerId, projectId) {
  showLoading(true);
  try {
    const snap = await getDocs(query(collection(db, 'purchases'), where('sellerId', '==', sellerId), limit(250)));
    let n = 0;
    const batchOps = [];
    for (const d of snap.docs) {
      const p = d.data();
      if (p.status !== 'approved' || p.earningsVoided) continue;
      if (projectId && p.projectId !== projectId) continue;
      batchOps.push(updateDoc(doc(db, 'purchases', d.id), {
        earningsVoided: true,
        earningsVoidedAt: serverTimestamp(),
        earningsVoidedBy: 'admin'
      }));
      n++;
    }
    // تنفيذ متوازي محدود
    const chunk = 15;
    for (let i = 0; i < batchOps.length; i += chunk) {
      await Promise.all(batchOps.slice(i, i + chunk));
    }
    showToast(n ? `تم إلغاء ربح ${n} عملية شراء` : 'لا توجد عمليات لإلغائها');
  } catch (e) {
    showToast('فشل الإلغاء: ' + (e.message || e), 'error');
  } finally {
    showLoading(false);
  }
}

// ===== الملف الشخصي الرسمي (محرك مصران) =====
async function loadOfficialProfile() {
  const prev = document.getElementById('officialAvatarPreview');
  const msg = document.getElementById('officialProfileMsg');
  if (msg) msg.textContent = 'جاري التحميل...';
  try {
    // كاش محلي أولاً
    let data = cacheGet('settings:officialProfile');
    if (!data) {
      const snap = await getDoc(doc(db, 'settings', 'officialProfile'));
      data = snap.exists() ? snap.data() : {};
      cacheSet('settings:officialProfile', data);
    }
    const photo = data.photoURL || data.avatarUrl || '';
    window._officialProfilePhoto = photo;
    window._officialDisplayName = data.displayName || data.name || 'محرك مصران';
    const nameInp = document.getElementById('officialDisplayName');
    if (nameInp) nameInp.value = window._officialDisplayName;
    window._officialProfileFileId = data.photoFileId || '';
    if (prev) {
      if (photo) {
        prev.innerHTML = `<img src="${photo}" alt="" style="width:100%;height:100%;object-fit:cover;">`;
        prev.style.background = 'transparent';
      } else {
        prev.textContent = 'م';
        prev.style.background = 'linear-gradient(135deg,#d4af37,#b8860b)';
      }
    }
    if (msg) msg.textContent = photo ? 'الصورة محفوظة وستظهر بجانب «محرك مصران».' : 'لم يتم رفع صورة بعد.';

    // رسالة شحن الرصيد
    let siteMsg = cacheGet('settings:siteMessages');
    if (!siteMsg) {
      const mSnap = await getDoc(doc(db, 'settings', 'siteMessages'));
      siteMsg = mSnap.exists() ? mSnap.data() : {};
      cacheSet('settings:siteMessages', siteMsg);
    }
    const ta = document.getElementById('topupMessageInput');
    if (ta) ta.value = siteMsg.topupMessage || 'حوّل المبلغ على الرقم المحدد ثم ارفع صورة التحويل من جهازك.';

    // رقم الدعم / الاتصال
    const phoneInp = document.getElementById('supportPhoneInput');
    const hintInp = document.getElementById('supportPhoneHintInput');
    if (phoneInp) phoneInp.value = siteMsg.supportPhone || siteMsg.devPhone || '';
    if (hintInp) hintInp.value = siteMsg.supportPhoneHint || 'لو مستعجل وعايز تواصل أسرع اتصل على هذا الرقم';

    await loadEnginePackageSettings();
    initRootSettingsTabs();
    // تحميل قائمة مستخدمين لتعديل العمولة (كاش)
    await loadCommUserSelect();
  } catch (e) {
    if (msg) msg.textContent = 'تعذر التحميل: ' + (e.message || e);
  }
}

async function loadCommUserSelect() {
  const sel = document.getElementById('commUserSelect');
  if (!sel) return;
  let rows = cacheGet('admin:usersLite');
  if (!Array.isArray(rows) || !rows.length) {
    const snap = await getDocs(query(collection(db, 'users'), limit(150)));
    rows = snap.docs.map(d => {
      const u = d.data();
      return {
        id: d.id,
        name: u.name || '',
        email: u.email || '',
        commissionPercent: (u.commissionPercent != null ? u.commissionPercent : 5)
      };
    });
    cacheSet('admin:usersLite', rows);
  }
  window._commUserRows = rows;
  const fill = (list) => {
    sel.innerHTML = '<option value="">— اختر —</option>' + list.map(r =>
      `<option value="${r.id}" data-comm="${r.commissionPercent != null ? r.commissionPercent : 5}">${(r.name || r.email || r.id).replace(/</g,'')} (${r.email || r.id.slice(0,8)}) — ${r.commissionPercent != null ? r.commissionPercent : 5}%</option>`
    ).join('');
  };
  fill(rows);
  document.getElementById('commUserSearch')?.addEventListener('input', (e) => {
    const q = e.target.value.trim().toLowerCase();
    const filtered = !q ? rows : rows.filter(r =>
      (r.name || '').toLowerCase().includes(q) ||
      (r.email || '').toLowerCase().includes(q) ||
      (r.id || '').toLowerCase().includes(q)
    );
    fill(filtered);
  });
  sel.onchange = () => {
    const opt = sel.selectedOptions[0];
    const pct = opt ? parseFloat(opt.dataset.comm) : 5;
    const inp = document.getElementById('commUserPercent');
    if (inp) inp.value = isFinite(pct) ? pct : 5;
    const hint = document.getElementById('commUserHint');
    if (hint) hint.textContent = opt && opt.value ? `العمولة الحالية للمستخدم: ${inp.value}% — التعديل يسري على المبيعات الجديدة فقط.` : '';
  };
}

document.getElementById('saveTopupMessageBtn')?.addEventListener('click', async () => {
  const text = document.getElementById('topupMessageInput')?.value?.trim() || '';
  const msg = document.getElementById('topupMessageSaveMsg');
  try {
    await setDoc(doc(db, 'settings', 'siteMessages'), { topupMessage: text, updatedAt: serverTimestamp() }, { merge: true });
    cacheSet('settings:siteMessages', { topupMessage: text });
    if (msg) msg.textContent = 'تم الحفظ';
    showToast('تم حفظ رسالة شحن الرصيد');
  } catch (e) {
    showToast(e.message || e, 'error');
  }
});

document.getElementById('saveUserCommBtn')?.addEventListener('click', async () => {
  const uid = document.getElementById('commUserSelect')?.value;
  const pct = parseFloat(document.getElementById('commUserPercent')?.value);
  if (!uid) { showToast('اختر مستخدماً', 'error'); return; }
  if (!isFinite(pct) || pct < 0 || pct > 100) { showToast('نسبة غير صالحة', 'error'); return; }
  if (!(await siteConfirm(`حفظ عمولة ${pct}% لهذا المستخدم؟\nستُطبَّق على المبيعات الجديدة فقط ولن تُعاد حساب القديمة.`, 'تعديل العمولة'))) return;
  try {
    await updateDoc(doc(db, 'users', uid), {
      commissionPercent: pct,
      commissionUpdatedAt: serverTimestamp()
    });
    // حدّث الكاش المحلي
    let rows = cacheGet('admin:usersLite') || [];
    rows = rows.map(r => r.id === uid ? { ...r, commissionPercent: pct } : r);
    cacheSet('admin:usersLite', rows);
    window._commUserRows = rows;
    await loadCommUserSelect();
    document.getElementById('commUserSelect').value = uid;
    document.getElementById('commUserPercent').value = pct;
    showToast('تم حفظ العمولة — تسري على المبيعات الجديدة فقط');
  } catch (e) {
    showToast(e.message || e, 'error');
  }
});

async function adminUploadToDrive(file, meta = {}) {
  const cfgSnap = await getDoc(doc(db, 'settings', 'drive'));
  if (!cfgSnap.exists() || !cfgSnap.data().scriptUrl) {
    throw new Error('إعدادات Drive غير مكتملة — احفظ رابط السكربت أولاً من قسم Drive');
  }
  const cfg = cfgSnap.data();
  const scriptUrl = String(cfg.scriptUrl).trim();
  const base64 = await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const res = String(r.result || '');
      resolve(res.includes(',') ? res.split(',')[1] : res);
    };
    r.onerror = reject;
    r.readAsDataURL(file);
  });
  const payload = JSON.stringify({
    secret: cfg.secret || '',
    fileName: file.name || 'avatar.jpg',
    mimeType: file.type || 'image/jpeg',
    base64,
    projectName: meta.projectName || 'profile',
    folderKind: meta.folderKind || 'profile',
    userName: meta.userName || 'محرك_مصران',
    userId: meta.userId || 'official',
    deleteOldInFolder: !!meta.deleteOldInFolder
  });
  const text = await new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', scriptUrl, true);
    xhr.setRequestHeader('Content-Type', 'text/plain;charset=utf-8');
    xhr.timeout = 120000;
    xhr.onload = () => resolve(xhr.responseText || '');
    xhr.onerror = () => reject(new Error('تم فشل رفع الملف'));
    xhr.ontimeout = () => reject(new Error('تم فشل رفع الملف'));
    xhr.send(payload);
  });
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('تم فشل رفع الملف — رد غير صالح من السكربت'); }
  if (!data.ok) throw new Error(data.error || 'تم فشل رفع الملف');
  return data;
}

function adminCompressImage(file, maxW = 400, quality = 0.85) {
  return new Promise((resolve) => {
    if (!file.type || !file.type.startsWith('image/')) { resolve(file); return; }
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      let w = img.width, h = img.height;
      if (w > maxW) { h = Math.round(h * maxW / w); w = maxW; }
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      // center crop square-ish if needed - keep aspect for profile via cropper optional
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      canvas.toBlob((blob) => {
        URL.revokeObjectURL(url);
        if (!blob) { resolve(file); return; }
        resolve(new File([blob], file.name.replace(/\.\w+$/, '.jpg'), { type: 'image/jpeg' }));
      }, 'image/jpeg', quality);
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(file); };
    img.src = url;
  });
}

document.getElementById('officialPhotoBtn')?.addEventListener('click', () => {
  document.getElementById('officialPhotoInput')?.click();
});

document.getElementById('officialPhotoInput')?.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  if (!file.type.startsWith('image/')) {
    showToast('اختر صورة فقط', 'error');
    return;
  }
  showLoading(true, 'جاري رفع صورة المحرك...');
  try {
    const compressed = await adminCompressImage(file, 400, 0.85);
    const oldId = (window._officialProfileFileId || '');
    const up = await adminUploadToDrive(compressed, {
      projectName: 'profile',
      folderKind: 'profile',
      userName: 'محرك_مصران',
      userId: 'official',
      deleteOldInFolder: true
    });
    const photoURL = up.thumbUrl || up.url;
    const photoFileId = up.fileId || '';
    if (oldId && oldId !== photoFileId) {
      try {
        const cfgSnap = await getDoc(doc(db, 'settings', 'drive'));
        const cfg = cfgSnap.exists() ? cfgSnap.data() : {};
        if (cfg.scriptUrl) {
          await new Promise((resolve) => {
            const xhr = new XMLHttpRequest();
            xhr.open('POST', String(cfg.scriptUrl).trim(), true);
            xhr.setRequestHeader('Content-Type', 'text/plain;charset=utf-8');
            xhr.onload = () => resolve();
            xhr.onerror = () => resolve();
            xhr.send(JSON.stringify({ secret: cfg.secret || '', action: 'delete', fileId: oldId }));
          });
        }
      } catch (_) {}
    }
    await setDoc(doc(db, 'settings', 'officialProfile'), {
      name: 'محرك مصران',
      verified: true,
      photoURL,
      avatarUrl: photoURL,
      photoFileId: photoFileId || null,
      updatedAt: serverTimestamp()
    }, { merge: true });
    window._officialProfileFileId = photoFileId;
    window._officialProfilePhoto = photoURL;
    const prev = document.getElementById('officialAvatarPreview');
    if (prev) {
      prev.innerHTML = `<img src="${photoURL}" alt="" style="width:100%;height:100%;object-fit:cover;">`;
      prev.style.background = 'transparent';
    }
    const msg = document.getElementById('officialProfileMsg');
    if (msg) msg.textContent = 'تم حفظ صورة المحرك بنجاح.';
    showToast('تم رفع صورة الملف الشخصي للمحرك');
  } catch (err) {
    showToast('فشل الرفع: ' + (err.message || err), 'error');
  } finally {
    showLoading(false);
    e.target.value = '';
  }
});


document.getElementById('saveOfficialNameBtn')?.addEventListener('click', async () => {
  const name = (document.getElementById('officialDisplayName')?.value || '').trim();
  if (!name) { showToast('أدخل الاسم الظاهر', 'error'); return; }
  try {
    await setDoc(doc(db, 'settings', 'officialProfile'), {
      displayName: name,
      name: name,
      updatedAt: serverTimestamp()
    }, { merge: true });
    window._officialDisplayName = name;
    try { cacheSet('settings:officialProfile', { ...(cacheGet('settings:officialProfile')||{}), displayName: name, name }); } catch(_){}
    showToast('تم حفظ الاسم الظاهر');
  } catch (e) { showToast(e.message, 'error'); }
});









// ===== قص الصور (مصغرة محتوى 16:9 · لوجو 1:1) =====
let _cropState = null;

function openImageCropper(file, { aspect = 16/9, outW = 1280, outH = 720, title = 'قص الصورة' } = {}) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.getElementById('imgCropCanvas');
        const modalEl = document.getElementById('imgCropModal');
        if (!canvas || !modalEl) { resolve(file); return; }
        document.getElementById('imgCropTitle').textContent = title;
        document.getElementById('imgCropHint').textContent = `المخرجات: ${outW} × ${outH} بكسل`;

        // عرض الصورة بمقياس مناسب
        const maxDisp = 720;
        const scale = Math.min(1, maxDisp / Math.max(img.width, img.height));
        const dw = Math.round(img.width * scale);
        const dh = Math.round(img.height * scale);
        canvas.width = dw;
        canvas.height = dh;
        const ctx = canvas.getContext('2d');

        // منطقة قص ابتدائية في المنتصف بنسبة aspect
        let cropW = dw * 0.85;
        let cropH = cropW / aspect;
        if (cropH > dh * 0.85) { cropH = dh * 0.85; cropW = cropH * aspect; }
        let cropX = (dw - cropW) / 2;
        let cropY = (dh - cropH) / 2;

        function draw() {
          ctx.clearRect(0, 0, dw, dh);
          ctx.drawImage(img, 0, 0, dw, dh);
          ctx.fillStyle = 'rgba(0,0,0,0.45)';
          ctx.fillRect(0, 0, dw, dh);
          ctx.clearRect(cropX, cropY, cropW, cropH);
          ctx.drawImage(img, cropX/scale, cropY/scale, cropW/scale, cropH/scale, cropX, cropY, cropW, cropH);
          ctx.strokeStyle = '#e8c547';
          ctx.lineWidth = 2;
          ctx.strokeRect(cropX, cropY, cropW, cropH);
        }
        draw();

        let dragging = false, lastX = 0, lastY = 0;
        const onDown = (e) => {
          dragging = true;
          const r = canvas.getBoundingClientRect();
          const cx = (e.touches ? e.touches[0].clientX : e.clientX) - r.left;
          const cy = (e.touches ? e.touches[0].clientY : e.clientY) - r.top;
          lastX = cx * (dw / r.width);
          lastY = cy * (dh / r.height);
          e.preventDefault();
        };
        const onMove = (e) => {
          if (!dragging) return;
          const r = canvas.getBoundingClientRect();
          const cx = (e.touches ? e.touches[0].clientX : e.clientX) - r.left;
          const cy = (e.touches ? e.touches[0].clientY : e.clientY) - r.top;
          const x = cx * (dw / r.width);
          const y = cy * (dh / r.height);
          cropX += x - lastX;
          cropY += y - lastY;
          cropX = Math.max(0, Math.min(dw - cropW, cropX));
          cropY = Math.max(0, Math.min(dh - cropH, cropY));
          lastX = x; lastY = y;
          draw();
          e.preventDefault();
        };
        const onUp = () => { dragging = false; };
        canvas.onmousedown = onDown;
        canvas.onmousemove = onMove;
        window.addEventListener('mouseup', onUp);
        canvas.ontouchstart = onDown;
        canvas.ontouchmove = onMove;
        canvas.ontouchend = onUp;

        const applyBtn = document.getElementById('imgCropApplyBtn');
        const modal = bootstrap.Modal.getOrCreateInstance(modalEl);
        const cleanup = () => {
          canvas.onmousedown = canvas.onmousemove = null;
          window.removeEventListener('mouseup', onUp);
          applyBtn.onclick = null;
        };
        applyBtn.onclick = () => {
          const out = document.createElement('canvas');
          out.width = outW; out.height = outH;
          out.getContext('2d').drawImage(
            img,
            cropX / scale, cropY / scale, cropW / scale, cropH / scale,
            0, 0, outW, outH
          );
          out.toBlob((blob) => {
            cleanup();
            modal.hide();
            if (!blob) { resolve(file); return; }
            const name = (file.name || 'image').replace(/\.\w+$/, '') + '_crop.jpg';
            resolve(new File([blob], name, { type: 'image/jpeg' }));
          }, 'image/jpeg', 0.92);
        };
        modalEl.addEventListener('hidden.bs.modal', () => { cleanup(); }, { once: true });
        modal.show();
      };
      img.onerror = () => resolve(file);
      img.src = reader.result;
    };
    reader.onerror = () => resolve(file);
    reader.readAsDataURL(file);
  });
}

// ربط مصغرة المحتوى بالقص 16:9
document.getElementById('promoThumb')?.addEventListener('change', async (e) => {
  const f = e.target.files?.[0];
  if (!f) return;
  const cropped = await openImageCropper(f, {
    aspect: 16/9, outW: 1280, outH: 720,
    title: 'قص صورة المحتوى (16:9)'
  });
  // استبدال الملف في input عبر DataTransfer
  try {
    const dt = new DataTransfer();
    dt.items.add(cropped);
    e.target.files = dt.files;
  } catch (_) { window._promoThumbCropped = cropped; }
  const prev = document.getElementById('promoThumbCropPreview');
  if (prev) {
    const url = URL.createObjectURL(cropped);
    prev.innerHTML = `<img src="${url}" alt="" style="max-width:240px;border-radius:10px;border:1px solid rgba(201,162,39,0.35);"> <span class="small text-success">تم القص · 1280×720</span>`;
  }
});

document.getElementById('siteLogoInput')?.addEventListener('change', async (e) => {
  const f = e.target.files?.[0];
  if (!f) return;
  const cropped = await openImageCropper(f, {
    aspect: 1, outW: 512, outH: 512,
    title: 'قص لوجو الموقع (مربع 512×512)'
  });
  try {
    const dt = new DataTransfer();
    dt.items.add(cropped);
    e.target.files = dt.files;
  } catch (_) { window._siteLogoCropped = cropped; }
  const prev = document.getElementById('siteLogoPreview');
  if (prev) {
    const url = URL.createObjectURL(cropped);
    prev.innerHTML = `<img src="${url}" alt="" style="width:100%;height:100%;object-fit:contain;">`;
  }
  const p2 = document.getElementById('siteLogoCropPreview');
  if (p2) p2.innerHTML = `<span class="small text-success">تم القص · 512×512 — سيظهر في الشريط وتبويب المتصفح</span>`;
});


// ===== قوائم تشغيل يوتيوب =====
async function loadPlaylistsAdmin() {
  const sel = document.getElementById('playlistSelect');
  const vidSel = document.getElementById('playlistVideoSelect');
  if (!sel) return;
  try {
    const plSnap = await getDocs(query(collection(db, 'promoPlaylists'), limit(80)));
    const current = sel.value;
    sel.innerHTML = '<option value="">— اختر قائمة —</option>' + plSnap.docs.map(d => {
      const p = d.data();
      return `<option value="${d.id}">${p.name || 'قائمة'} (${(p.itemIds || []).length})</option>`;
    }).join('');
    if (current) sel.value = current;

    const ytSnap = await getDocs(query(collection(db, 'promoContent'), where('type', '==', 'youtube'), limit(120)));
    if (vidSel) {
      const sorted = ytSnap.docs.slice().sort((a, b) => (b.data().createdAt?.toMillis?.() || 0) - (a.data().createdAt?.toMillis?.() || 0));
      vidSel.innerHTML = '<option value="">— اختر فيديو —</option>' + sorted.map(d => {
        const t = d.data().title || d.id;
        return `<option value="${d.id}">${t}</option>`;
      }).join('');
    }
    await renderPlaylistItems();
  } catch (e) {
    console.warn('loadPlaylistsAdmin', e);
  }
}

async function renderPlaylistItems() {
  const box = document.getElementById('playlistItemsBox');
  const sel = document.getElementById('playlistSelect');
  if (!box || !sel || !sel.value) {
    if (box) box.innerHTML = '<span class="text-muted">اختر قائمة لعرض فيديوهاتها</span>';
    return;
  }
  try {
    const snap = await getDoc(doc(db, 'promoPlaylists', sel.value));
    if (!snap.exists()) { box.innerHTML = ''; return; }
    const ids = snap.data().itemIds || [];
    if (!ids.length) {
      box.innerHTML = '<span class="text-muted">القائمة فارغة — أضف فيديوهات من الأعلى</span>';
      return;
    }
    const rows = [];
    for (const id of ids) {
      try {
        const s = await getDoc(doc(db, 'promoContent', id));
        const t = s.exists() ? (s.data().title || id) : id + ' (محذوف)';
        rows.push(`<div class="d-flex justify-content-between align-items-center border rounded px-2 py-1 mb-1 bg-light">
          <span>${t}</span>
          <button type="button" class="btn btn-sm btn-outline-danger py-0 playlist-remove-item" data-id="${id}">إزالة</button>
        </div>`);
      } catch (_) {}
    }
    box.innerHTML = rows.join('') || '';
    box.querySelectorAll('.playlist-remove-item').forEach(btn => {
      btn.onclick = async () => {
        try {
          const pl = await getDoc(doc(db, 'promoPlaylists', sel.value));
          const itemIds = (pl.data().itemIds || []).filter(x => x !== btn.dataset.id);
          await updateDoc(doc(db, 'promoPlaylists', sel.value), { itemIds, updatedAt: serverTimestamp() });
          try { networkInvalidate('promo:'); } catch (_) {}
          showToast('تمت الإزالة من القائمة فقط — الفيديو ما زال في المحتوى');
          loadPlaylistsAdmin();
        } catch (e) { showToast(e.message, 'error'); }
      };
    });
  } catch (e) {
    box.innerHTML = `<span class="text-danger">${e.message}</span>`;
  }
}

document.getElementById('playlistCreateBtn')?.addEventListener('click', async () => {
  const name = (document.getElementById('playlistNameInput')?.value || '').trim();
  if (!name) { showToast('اكتب اسم القائمة', 'error'); return; }
  try {
    await addDoc(collection(db, 'promoPlaylists'), {
      name,
      type: 'youtube',
      itemIds: [],
      createdAt: serverTimestamp()
    });
    document.getElementById('playlistNameInput').value = '';
    try { networkInvalidate('promo:'); } catch (_) {}
    showToast('تم إنشاء القائمة');
    loadPlaylistsAdmin();
  } catch (e) { showToast(e.message, 'error'); }
});

document.getElementById('playlistSelect')?.addEventListener('change', () => renderPlaylistItems());

document.getElementById('playlistAddVideoBtn')?.addEventListener('click', async () => {
  const pid = document.getElementById('playlistSelect')?.value;
  const vid = document.getElementById('playlistVideoSelect')?.value;
  if (!pid || !vid) { showToast('اختر قائمة وفيديو', 'error'); return; }
  try {
    const snap = await getDoc(doc(db, 'promoPlaylists', pid));
    if (!snap.exists()) return;
    const itemIds = Array.isArray(snap.data().itemIds) ? snap.data().itemIds.slice() : [];
    if (itemIds.includes(vid)) { showToast('الفيديو موجود بالفعل في القائمة', 'error'); return; }
    itemIds.push(vid);
    await updateDoc(doc(db, 'promoPlaylists', pid), { itemIds, updatedAt: serverTimestamp() });
    try { networkInvalidate('promo:'); } catch (_) {}
    showToast('تمت الإضافة للقائمة');
    loadPlaylistsAdmin();
  } catch (e) { showToast(e.message, 'error'); }
});

document.getElementById('playlistDeleteBtn')?.addEventListener('click', async () => {
  const pid = document.getElementById('playlistSelect')?.value;
  if (!pid) { showToast('اختر قائمة', 'error'); return; }
  if (!(await siteConfirm('حذف قائمة التشغيل؟ الفيديوهات نفسها لن تُحذف من المحتوى.', 'حذف قائمة'))) return;
  try {
    await deleteDoc(doc(db, 'promoPlaylists', pid));
    try { networkInvalidate('promo:'); } catch (_) {}
    showToast('تم حذف القائمة');
    loadPlaylistsAdmin();
  } catch (e) { showToast(e.message, 'error'); }
});


// ===== حزمة المحرك + العلامة التجارية (settings/engine) =====
async function loadEnginePackageSettings() {
  try {
    let data = cacheGet('settings:engine');
    if (!data) {
      const snap = await getDoc(doc(db, 'settings', 'engine'));
      data = snap.exists() ? snap.data() : {};
      cacheSet('settings:engine', data);
    }
    const nameEl = document.getElementById('engineNameInput');
    const verEl = document.getElementById('engineVersionInput');
    const descEl = document.getElementById('engineDescInput');
    if (nameEl) nameEl.value = data.engineName || data.name || 'محرك مصران';
    if (verEl) verEl.value = data.version || '1.0.0';
    if (descEl) descEl.value = data.description || '';
    const hint = document.getElementById('engineFileHint');
    if (hint) {
      hint.textContent = data.fileId || data.downloadUrl
        ? `ملف مرفوع · إصدار ${data.version || '—'} · ${data.fileName || 'engine'}`
        : 'لم يُرفع ملف بعد';
    }
    const prev = document.getElementById('engineImagesPreview');
    if (prev) {
      const imgs = data.images || [];
      prev.innerHTML = imgs.map(im => {
        const u = typeof im === 'string' ? im : (im.url || '');
        return u ? `<img src="${u}" alt="" style="width:72px;height:54px;object-fit:cover;border-radius:8px;border:1px solid rgba(201,162,39,0.3);">` : '';
      }).join('');
    }
    const siteName = document.getElementById('siteNameInput');
    if (siteName) siteName.value = data.siteName || 'محرك مصران';
    const logoPrev = document.getElementById('siteLogoPreview');
    if (logoPrev && data.logoUrl) {
      logoPrev.innerHTML = `<img src="${data.logoUrl}" alt="" style="width:100%;height:100%;object-fit:contain;">`;
    }
  } catch (e) {
    console.warn('loadEnginePackageSettings', e);
  }
}

async function adminDeleteDriveFile(fileId) {
  if (!fileId) return;
  try {
    const cfgSnap = await getDoc(doc(db, 'settings', 'drive'));
    const cfg = cfgSnap.exists() ? cfgSnap.data() : {};
    if (!cfg.scriptUrl) return;
    await new Promise((resolve) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', String(cfg.scriptUrl).trim(), true);
      xhr.setRequestHeader('Content-Type', 'text/plain;charset=utf-8');
      xhr.onload = () => resolve();
      xhr.onerror = () => resolve();
      xhr.send(JSON.stringify({ secret: cfg.secret || '', action: 'delete', fileId }));
    });
  } catch (_) {}
}

document.getElementById('saveEnginePackageBtn')?.addEventListener('click', async () => {
  const msg = document.getElementById('enginePackageMsg');
  const engineName = (document.getElementById('engineNameInput')?.value || '').trim() || 'محرك مصران';
  const version = (document.getElementById('engineVersionInput')?.value || '').trim() || '1.0.0';
  const description = (document.getElementById('engineDescInput')?.value || '').trim();
  const fileInput = document.getElementById('engineFileInput');
  const imgInput = document.getElementById('engineImagesInput');
  try {
    showLoading(true, 'جاري الحفظ...');
    let prev = {};
    try {
      const snap = await getDoc(doc(db, 'settings', 'engine'));
      prev = snap.exists() ? snap.data() : {};
    } catch (_) {}

    const payload = {
      engineName,
      name: engineName,
      version,
      description,
      updatedAt: serverTimestamp()
    };

    // رفع ملف المحرك مع استبدال القديم
    const f = fileInput?.files?.[0];
    if (f) {
      if (prev.fileId) await adminDeleteDriveFile(prev.fileId);
      const up = await adminUploadToDrive(f, {
        projectName: 'MisranEngineRelease',
        folderKind: 'files',
        deleteOldInFolder: true
      });
      payload.downloadUrl = up.url || up.downloadUrl || '';
      payload.fileId = up.fileId || '';
      payload.fileName = f.name;
    } else {
      if (prev.downloadUrl) payload.downloadUrl = prev.downloadUrl;
      if (prev.fileId) payload.fileId = prev.fileId;
      if (prev.fileName) payload.fileName = prev.fileName;
    }

    // صور مرفقة — استبدال كامل
    const imgs = imgInput?.files ? Array.from(imgInput.files).slice(0, 8) : [];
    if (imgs.length) {
      for (const id of (prev.imageFileIds || [])) await adminDeleteDriveFile(id);
      const uploaded = [];
      const ids = [];
      for (const im of imgs) {
        const up = await adminUploadToDrive(im, {
          projectName: 'MisranEngineGallery',
          folderKind: 'images',
          deleteOldInFolder: true
        });
        const url = up.thumbUrl || up.url || '';
        uploaded.push({ url, fileId: up.fileId || '' });
        if (up.fileId) ids.push(up.fileId);
      }
      payload.images = uploaded;
      payload.imageFileIds = ids;
    } else {
      payload.images = prev.images || [];
      payload.imageFileIds = prev.imageFileIds || [];
    }

    // حافظ على branding إن وُجد
    if (prev.siteName) payload.siteName = prev.siteName;
    if (prev.logoUrl) payload.logoUrl = prev.logoUrl;
    if (prev.logoFileId) payload.logoFileId = prev.logoFileId;

    await setDoc(doc(db, 'settings', 'engine'), payload, { merge: true });
    try {
      networkInvalidate('settings:engine');
      cacheSet('settings:engine', { ...prev, ...payload });
    } catch (_) {}
    if (msg) msg.innerHTML = '<span class="text-success">تم حفظ حزمة المحرك — ستظهر للزوار بعد تحديث الصفحة</span>';
    showToast('تم حفظ المحرك');
    document.getElementById('engineFileInput').value = '';
    if (imgInput) imgInput.value = '';
    await loadEnginePackageSettings();
  } catch (e) {
    if (msg) msg.textContent = e.message || String(e);
    showToast(e.message || String(e), 'error');
  } finally {
    showLoading(false);
  }
});

document.getElementById('saveSiteBrandingBtn')?.addEventListener('click', async () => {
  const msg = document.getElementById('siteBrandingMsg');
  const siteName = (document.getElementById('siteNameInput')?.value || '').trim() || 'محرك مصران';
  const logoFile = window._siteLogoCropped || document.getElementById('siteLogoInput')?.files?.[0];
  try {
    showLoading(true, 'حفظ العلامة...');
    let prev = {};
    try {
      const snap = await getDoc(doc(db, 'settings', 'engine'));
      prev = snap.exists() ? snap.data() : {};
    } catch (_) {}
    const payload = { siteName, updatedAt: serverTimestamp() };
    if (logoFile) {
      if (prev.logoFileId) await adminDeleteDriveFile(prev.logoFileId);
      const up = await adminUploadToDrive(logoFile, {
        projectName: 'MisranSiteLogo',
        folderKind: 'images',
        deleteOldInFolder: true
      });
      payload.logoUrl = up.thumbUrl || up.url || '';
      payload.logoFileId = up.fileId || '';
    }
    await setDoc(doc(db, 'settings', 'engine'), payload, { merge: true });
    try {
      networkInvalidate('settings:engine');
      cacheSet('settings:engine', { ...prev, ...payload });
    } catch (_) {}
    if (msg) msg.innerHTML = '<span class="text-success">تم حفظ اسم الموقع واللوجو</span>';
    showToast('تم حفظ العلامة التجارية');
    document.getElementById('siteLogoInput').value = '';
    window._siteLogoCropped = null;
    await loadEnginePackageSettings();
  } catch (e) {
    if (msg) msg.textContent = e.message || String(e);
    showToast(e.message || String(e), 'error');
  } finally {
    showLoading(false);
  }
});




// ===== المحتوى التقديمي (YouTube / Facebook) — صفحة 1 = الأحدث =====
let promoAdminPage = 1;
const PROMO_PAGE_SIZE = 8;
let promoAdminCursors = [null];

async function loadPromoAdmin(page) {
  const list = document.getElementById('promoAdminList');
  const pager = document.getElementById('promoAdminPager');
  if (!list) return;
  promoAdminPage = page || 1;
  list.innerHTML = '<div class="col-12 text-center py-4"><div class="spinner-border spinner-border-sm"></div></div>';
  try {
    // بدون حاجة لفهرس خاص: نجلب ثم نرتّب الأحدث أولاً محلياً
    const allSnap = await getDocs(query(collection(db, 'promoContent'), limit(150)));
    const sorted = allSnap.docs.slice().sort((a, b) => {
      const t1 = a.data().createdAt?.toMillis?.() || 0;
      const t2 = b.data().createdAt?.toMillis?.() || 0;
      return t2 - t1;
    });
    if (promoAdminPage <= 1) promoAdminPage = 1;
    const start = (promoAdminPage - 1) * PROMO_PAGE_SIZE;
    const pageDocs = sorted.slice(start, start + PROMO_PAGE_SIZE);
    if (!pageDocs.length) {
      list.innerHTML = '<div class="col-12 text-muted">لا يوجد محتوى بعد.</div>';
      if (pager) pager.innerHTML = '';
      return;
    }
    list.innerHTML = pageDocs.map(d => {
      const p = d.data();
      const typeIcon = p.type === 'facebook'
        ? '<i class="fab fa-facebook text-primary"></i>'
        : '<i class="fab fa-youtube text-danger"></i>';
      const typeLabel = p.type === 'facebook' ? 'فيسبوك' : 'يوتيوب';
      const thumb = p.thumbnail || '';
      return `<div class="col-md-6 col-lg-4">
        <div class="card h-100 border-0 shadow-sm">
          ${thumb ? `<img src="${thumb}" class="card-img-top" style="height:140px;object-fit:cover;" alt="">` : `<div class="bg-light d-flex align-items-center justify-content-center" style="height:140px;">${typeIcon}</div>`}
          <div class="card-body">
            <div class="small mb-1">${typeIcon} ${typeLabel}</div>
            <h6 class="fw-bold">${p.title || 'بدون عنوان'}</h6>
            <p class="small text-muted mb-2" style="max-height:3em;overflow:hidden;">${(p.description || '').slice(0, 120)}</p>
            <div class="d-flex gap-1 flex-wrap">
              <a href="${p.videoUrl || '#'}" target="_blank" rel="noopener" class="btn btn-sm btn-outline-primary">فتح الرابط</a>
              <button type="button" class="btn btn-sm btn-outline-secondary promo-edit"
                data-id="${d.id}"
                data-type="${p.type || 'youtube'}"
                data-title="${(p.title||'').replace(/"/g,'&quot;')}"
                data-desc="${(p.description||'').replace(/"/g,'&quot;')}"
                data-url="${(p.videoUrl||'').replace(/"/g,'&quot;')}"
                data-thumb="${(p.thumbnail||'').replace(/"/g,'&quot;')}"
                data-file="${p.thumbnailFileId || ''}">تعديل</button>
              <button type="button" class="btn btn-sm btn-outline-danger promo-del" data-id="${d.id}" data-file="${p.thumbnailFileId || ''}">حذف</button>
            </div>
            <div class="small text-muted mt-1">ID: ${d.id}</div>
          </div>
        </div>
      </div>`;
    }).join('');

    list.querySelectorAll('.promo-edit').forEach(btn => {
      btn.onclick = () => {
        document.getElementById('promoEditId').value = btn.dataset.id;
        document.getElementById('promoType').value = btn.dataset.type || 'youtube';
        document.getElementById('promoTitle').value = btn.dataset.title || '';
        document.getElementById('promoDesc').value = btn.dataset.desc || '';
        document.getElementById('promoVideoUrl').value = btn.dataset.url || '';
        window._promoEditOldFileId = btn.dataset.file || '';
        const prev = document.getElementById('promoThumbCropPreview');
        if (prev) {
          prev.innerHTML = btn.dataset.thumb
            ? `<img src="${btn.dataset.thumb}" alt="" style="max-height:80px;border-radius:8px;">`
            : '';
        }
        document.getElementById('promoFormTitle').textContent = 'تعديل محتوى';
        document.getElementById('promoAddBtn')?.classList.add('d-none');
        document.getElementById('promoUpdateBtn')?.classList.remove('d-none');
        document.getElementById('promoCancelEditBtn')?.classList.remove('d-none');
        document.getElementById('section-promoContent')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      };
    });

    list.querySelectorAll('.promo-del').forEach(btn => {
      btn.onclick = async () => {
        if (!(await siteConfirm('حذف هذا المحتوى نهائياً من قسم المحتوى؟', 'حذف محتوى'))) return;
        try {
          showLoading(true);
          const fid = btn.dataset.file;
          if (fid && typeof adminDeleteDriveFile === 'function') await adminDeleteDriveFile(fid);
          await deleteDoc(doc(db, 'promoContent', btn.dataset.id));
          try { networkInvalidate('promo:'); } catch (_) {}
          showToast('تم الحذف');
          loadPromoAdmin(promoAdminPage);
        } catch (e) { showToast(e.message, 'error'); }
        finally { showLoading(false); }
      };
    });

    if (pager) {
      const hasMore = start + PROMO_PAGE_SIZE < sorted.length;
      pager.innerHTML = `
        <button type="button" class="btn btn-sm btn-outline-secondary" id="promoPrev" ${promoAdminPage <= 1 ? 'disabled' : ''}>السابق</button>
        <span class="align-self-center px-2">صفحة ${promoAdminPage}</span>
        <button type="button" class="btn btn-sm btn-outline-secondary" id="promoNext" ${hasMore ? '' : 'disabled'}>التالي</button>`;
      document.getElementById('promoPrev')?.addEventListener('click', () => loadPromoAdmin(promoAdminPage - 1));
      document.getElementById('promoNext')?.addEventListener('click', () => loadPromoAdmin(promoAdminPage + 1));
    }
  } catch (e) {
    list.innerHTML = `<div class="col-12 text-danger">${e.message}</div>`;
  }
}

document.getElementById('promoRefreshBtn')?.addEventListener('click', () => loadPromoAdmin(1));

document.getElementById('promoAddBtn')?.addEventListener('click', async () => {
  const msg = document.getElementById('promoAddMsg');
  const type = document.getElementById('promoType')?.value || 'youtube';
  const title = (document.getElementById('promoTitle')?.value || '').trim();
  const description = (document.getElementById('promoDesc')?.value || '').trim();
  const videoUrl = (document.getElementById('promoVideoUrl')?.value || '').trim();
  const thumbFile = window._promoThumbCropped || document.getElementById('promoThumb')?.files?.[0];
  if (!title || !videoUrl) {
    showToast('الاسم والرابط مطلوبان', 'error');
    return;
  }
  // أي رابط مسموح — بدون قيود نطاق
  try {
    showLoading(true, 'جاري الإضافة...');
    let thumbnail = '';
    let thumbnailFileId = '';
    if (thumbFile) {
      if (typeof adminUploadToDrive !== 'function') throw new Error('دالة الرفع غير متاحة');
      const up = await adminUploadToDrive(thumbFile, {
        projectName: 'PromoContentThumbs',
        folderKind: 'images',
        deleteOldInFolder: false
      });
      thumbnail = up.thumbUrl || up.url || '';
      thumbnailFileId = up.fileId || '';
    }
    await addDoc(collection(db, 'promoContent'), {
      type,
      title,
      description,
      videoUrl,
      thumbnail,
      thumbnailFileId: thumbnailFileId || null,
      status: 'active',
      createdAt: serverTimestamp()
    });
    try { networkInvalidate('promo:'); } catch (_) {}
    if (msg) msg.innerHTML = '<span class="text-success">تمت الإضافة</span>';
    showToast('تم إضافة المحتوى');
    document.getElementById('promoTitle').value = '';
    document.getElementById('promoDesc').value = '';
    document.getElementById('promoVideoUrl').value = '';
    document.getElementById('promoThumb').value = '';
    window._promoThumbCropped = null;
    const ptp = document.getElementById('promoThumbCropPreview'); if (ptp) ptp.innerHTML = '';
    loadPromoAdmin(1);
  } catch (e) {
    if (msg) msg.textContent = e.message || String(e);
    showToast(e.message || String(e), 'error');
  } finally {
    showLoading(false);
  }
});


// ===== إبداعات المحرك (تعديل حر بدون كولداون) =====
async function loadAdminMyCreations() {
  const list = document.getElementById('adminMyCreationsList');
  if (!list) return;
  list.innerHTML = '<div class="col-12 text-center py-4"><div class="spinner-border spinner-border-sm"></div></div>';
  try {
    let docs = [];
    try {
      const snap = await getDocs(query(collection(db, 'projects'), where('isOfficial', '==', true), limit(100)));
      docs = snap.docs.filter(d => d.data().status !== 'deleted');
    } catch (e) {
      const snap = await getDocs(query(collection(db, 'projects'), limit(200)));
      docs = snap.docs.filter(d => d.data().isOfficial && d.data().status !== 'deleted');
    }
    docs.sort((a,b) => (b.data().createdAt?.toMillis?.()||0) - (a.data().createdAt?.toMillis?.()||0));
    if (!docs.length) {
      list.innerHTML = '<div class="col-12 alert alert-info">لا توجد منتجات رسمية بعد. أضف من «إضافة مشروع رسمي».</div>';
      return;
    }
    list.innerHTML = docs.map(d => {
      const p = d.data();
      const img = p.thumbnailDirect || p.thumbnail || 'https://via.placeholder.com/400x180?text=Official';
      const price = p.price || 0;
      const onSale = p.originalPrice && p.saleEndsAt;
      return `<div class="col-md-4">
        <div class="card h-100 shadow-sm">
          <img src="${img}" class="card-img-top" style="height:140px;object-fit:cover;" onerror="this.src='https://via.placeholder.com/400x180?text=Official'">
          <div class="card-body">
            <h6>${p.title || '-'}</h6>
            <p class="small text-muted text-truncate">${p.description || ''}</p>
            <p class="mb-1"><strong>${price} ج.م</strong> ${onSale ? '<span class="badge bg-danger">عرض</span>' : ''}</p>
            <p class="small text-muted">ID: ${d.id}</p>
            <div class="d-flex flex-wrap gap-1">
              <button class="btn btn-sm btn-outline-primary admin-view-off" data-id="${d.id}">عرض</button>
              <button class="btn btn-sm btn-warning admin-edit-off" data-id="${d.id}">تعديل</button>
              <button class="btn btn-sm btn-outline-secondary admin-copy-off" data-id="${d.id}">نسخ الرابط</button>
              <button class="btn btn-sm btn-outline-danger admin-del-off" data-id="${d.id}">حذف</button>
            </div>
          </div>
        </div>
      </div>`;
    }).join('');

    list.querySelectorAll('.admin-view-off').forEach(btn => {
      btn.onclick = () => viewAdminProduct(btn.dataset.id);
    });
    list.querySelectorAll('.admin-copy-off').forEach(btn => {
      btn.onclick = () => copyStoreProductLink(btn.dataset.id);
    });
    list.querySelectorAll('.admin-del-off').forEach(btn => {
      btn.onclick = async () => {
        const ok = await siteConfirm('حذف هذا المنتج الرسمي؟', 'تأكيد الحذف');
        if (!ok) return;
        try {
          await updateDoc(doc(db, 'projects', btn.dataset.id), { status: 'deleted', deletedAt: serverTimestamp() });
          showToast('تم الحذف');
          loadAdminMyCreations();
        } catch (e) { showToast(e.message, 'error'); }
      };
    });
    list.querySelectorAll('.admin-edit-off').forEach(btn => {
      btn.onclick = () => openAdminOfficialEdit(btn.dataset.id, docs.find(x => x.id === btn.dataset.id)?.data());
    });
  } catch (err) {
    list.innerHTML = `<div class="col-12 alert alert-danger">${err.message}</div>`;
  }
}

document.getElementById('adminMyCreationsRefresh')?.addEventListener('click', () => loadAdminMyCreations());

function openAdminOfficialEdit(id, p) {
  if (!p) return;
  let modal = document.getElementById('adminOfficialEditModal');
  if (!modal) {
    document.body.insertAdjacentHTML('beforeend', `
      <div class="modal fade" id="adminOfficialEditModal" tabindex="-1">
        <div class="modal-dialog modal-lg modal-dialog-scrollable">
          <div class="modal-content">
            <div class="modal-header"><h5 class="modal-title">تعديل منتج المحرك</h5>
              <button type="button" class="btn-close" data-bs-dismiss="modal"></button></div>
            <div class="modal-body">
              <input type="hidden" id="aoeId">
              <div class="mb-2"><label class="form-label">العنوان</label>
                <input class="form-control" id="aoeTitle"></div>
              <div class="mb-2"><label class="form-label">الوصف</label>
                <textarea class="form-control" id="aoeDesc" rows="3"></textarea></div>
              <div class="mb-2"><label class="form-label">السعر / سعر العرض (ج.م)</label>
                <input type="number" class="form-control" id="aoePrice" min="0" step="any"></div>
              <div class="form-check mb-2">
                <input class="form-check-input" type="checkbox" id="aoeSale">
                <label class="form-check-label" for="aoeSale">تفعيل / تعديل عرض</label>
              </div>
              <div id="aoeSaleFields" class="border rounded p-2 d-none">
                <div class="row g-2 mb-2">
                  <div class="col-6"><label class="form-label small fw-bold text-danger">سعر العرض</label>
                    <input type="number" class="form-control form-control-sm" id="aoeOffer" min="0" step="any"></div>
                  <div class="col-6"><label class="form-label small fw-bold">بعد انتهاء العرض</label>
                    <input type="number" class="form-control form-control-sm" id="aoeOrig" min="0" step="any"></div>
                </div>
                <div class="row g-2">
                  <div class="col-6"><label class="form-label small">المدة</label>
                    <input type="number" class="form-control form-control-sm" id="aoeDur" min="1" value="7"></div>
                  <div class="col-6"><label class="form-label small">الوحدة</label>
                    <select class="form-select form-select-sm" id="aoeUnit">
                      <option value="minutes">دقائق</option>
                      <option value="hours">ساعات</option>
                      <option value="days" selected>أيام</option>
                      <option value="months">شهور</option>
                    </select></div>
                </div>
                <small class="text-muted">الأدمن: بدون انتظار 24 ساعة — تعديل حر في أي وقت.</small>
              </div>
            </div>
            <div class="modal-footer">
              <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">إلغاء</button>
              <button type="button" class="btn btn-primary" id="aoeSaveBtn">حفظ</button>
            </div>
          </div>
        </div>
      </div>`);
    modal = document.getElementById('adminOfficialEditModal');
    document.getElementById('aoeSale')?.addEventListener('change', (e) => {
      document.getElementById('aoeSaleFields')?.classList.toggle('d-none', !e.target.checked);
    });
    document.getElementById('aoeSaveBtn')?.addEventListener('click', async () => {
      const pid = document.getElementById('aoeId').value;
      const title = document.getElementById('aoeTitle').value.trim();
      const description = document.getElementById('aoeDesc').value.trim();
      let price = parseFloat(document.getElementById('aoePrice').value) || 0;
      if (!title || !description) { showToast('العنوان والوصف مطلوبان', 'error'); return; }
      const saleOn = !!document.getElementById('aoeSale')?.checked;
      const offerEl = document.getElementById('aoeOffer');
      if (saleOn && offerEl && offerEl.value !== '') {
        price = parseFloat(offerEl.value) || 0;
      }
      if (price < 0) { showToast('سعر غير صالح', 'error'); return; }
      const payload = {
        title, description, price, isFree: price === 0,
        updatedAt: serverTimestamp(), isOfficial: true
      };
      if (saleOn && price > 0) {
        const orig = parseFloat(document.getElementById('aoeOrig').value) || 0;
        const durVal = parseFloat(document.getElementById('aoeDur').value) || 0;
        const unit = document.getElementById('aoeUnit').value || 'days';
        if (!(orig > price)) { showToast('السعر بعد الانتهاء يجب أن يكون أكبر من سعر العرض', 'error'); return; }
        if (!(durVal > 0)) { showToast('حدد مدة', 'error'); return; }
        const unitMs = unit === 'minutes' ? 60000 : unit === 'hours' ? 3600000 : unit === 'months' ? 30*86400000 : 86400000;
        payload.originalPrice = orig;
        payload.saleEndsAt = new Date(Date.now() + durVal * unitMs);
        payload.salePending = false;
        payload.saleDurationValue = durVal;
        payload.saleDurationUnit = unit;
      } else {
        payload.originalPrice = null;
        payload.saleEndsAt = null;
        payload.salePending = false;
      }
      try {
        showLoading(true);
        await updateDoc(doc(db, 'projects', pid), payload);
        invalidateProjectCaches(pid);
        try {
          // حدّث كاش المنتج فوراً للزوار على نفس المتصفح
          cacheSet('product:' + pid, { id: pid, ...payload, isOfficial: true });
        } catch(_){}
        showToast('تم الحفظ — التحديث يظهر في المتجر');
        bootstrap.Modal.getInstance(modal)?.hide();
        loadAdminMyCreations();
      } catch (e) { showToast(e.message, 'error'); }
      finally { showLoading(false); }
    });
  }
  document.getElementById('aoeId').value = id;
  document.getElementById('aoeTitle').value = p.title || '';
  document.getElementById('aoeDesc').value = p.description || '';
  document.getElementById('aoePrice').value = p.price || 0;
  const aoeOffer = document.getElementById('aoeOffer');
  if (aoeOffer) aoeOffer.value = p.price || 0;
  const hasSale = !!(p.originalPrice && p.saleEndsAt);
  document.getElementById('aoeSale').checked = hasSale;
  document.getElementById('aoeSaleFields')?.classList.toggle('d-none', !hasSale);
  if (hasSale) {
    document.getElementById('aoeOrig').value = p.originalPrice || '';
    document.getElementById('aoeDur').value = p.saleDurationValue || 7;
    if (p.saleDurationUnit) document.getElementById('aoeUnit').value = p.saleDurationUnit;
  }
  new bootstrap.Modal(modal).show();
}


// ===== نسخة احتياطية شاملة → درايف (سكربت v5) =====
const BACKUP_COLLECTIONS = [
  'users', 'projects', 'purchases', 'promoContent', 'promoPlaylists',
  'supportChats', 'comments', 'topups', 'notifications', 'settings'
];

function plainForBackup(val) {
  if (val === null || val === undefined) return val;
  if (typeof val !== 'object') return val;
  if (typeof val.toDate === 'function' && typeof val.toMillis === 'function') {
    return { __ts: val.toMillis(), __iso: val.toDate().toISOString?.() || null };
  }
  if (val instanceof Date) return { __ts: val.getTime(), __iso: val.toISOString() };
  if (Array.isArray(val)) return val.map(plainForBackup);
  const out = {};
  for (const k of Object.keys(val)) {
    if (typeof val[k] === 'function') continue;
    out[k] = plainForBackup(val[k]);
  }
  return out;
}

async function fetchAllCollectionDocs(colName, pageSize = 200) {
  const rows = [];
  try {
    let cursor = null;
    for (let i = 0; i < 40; i++) {
      const qBase = cursor
        ? query(collection(db, colName), orderBy('__name__'), startAfter(cursor), limit(pageSize))
        : query(collection(db, colName), orderBy('__name__'), limit(pageSize));
      const snap = await getDocs(qBase);
      if (!snap.docs.length) break;
      snap.docs.forEach(d => {
        rows.push({ id: d.id, data: plainForBackup(d.data()) });
      });
      cursor = snap.docs[snap.docs.length - 1];
      if (snap.docs.length < pageSize) break;
    }
  } catch (err) {
    const snap = await getDocs(query(collection(db, colName), limit(Math.min(pageSize, 500))));
    snap.docs.forEach(d => rows.push({ id: d.id, data: plainForBackup(d.data()) }));
  }
  return rows;
}

async function driveBackupRequest(payload) {
  const cfgSnap = await getDoc(doc(db, 'settings', 'drive'));
  const cfg = cfgSnap.exists() ? cfgSnap.data() : {};
  if (!cfg.scriptUrl) throw new Error('إعدادات درايف غير مكتملة — احفظ رابط سكربت v5 أولاً');
  const scriptUrl = String(cfg.scriptUrl).trim();
  const body = JSON.stringify({ secret: cfg.secret || '', ...payload });
  const text = await new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', scriptUrl, true);
    xhr.setRequestHeader('Content-Type', 'text/plain;charset=utf-8');
    xhr.timeout = 180000;
    xhr.onload = () => resolve(xhr.responseText || '');
    xhr.onerror = () => reject(new Error('فشل الاتصال بسكربت الدرايف'));
    xhr.ontimeout = () => reject(new Error('انتهت مهلة الاتصال'));
    xhr.send(body);
  });
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('رد غير متوقع من السكربت — تأكد من نشر الإصدار 5'); }
  if (!data.ok) throw new Error(data.error || 'فشل العملية');
  return data;
}

async function runFullBackup(opts = {}) {
  const silent = !!opts.silent;
  const msg = document.getElementById('fullBackupMsg');
  const prog = document.getElementById('fullBackupProgress');
  const bar = document.getElementById('fullBackupBar');
  try {
    if (!silent) showLoading(true, 'جاري النسخ الاحتياطي...');
    if (prog) prog.classList.remove('d-none');
    if (msg) msg.textContent = 'إنشاء مجلد النسخة على درايف...';
    const init = await driveBackupRequest({ action: 'backupInit' });
    const folderId = init.folderId;
    const stamp = init.stamp;
    const counts = {};
    const byEmail = {};

    const total = BACKUP_COLLECTIONS.length + 1;
    let step = 0;
    const setProg = (t) => {
      step++;
      if (bar) bar.style.width = Math.round((step / total) * 100) + '%';
      if (msg) msg.textContent = t;
      showLoading(true, t);
    };

    for (const col of BACKUP_COLLECTIONS) {
      setProg('قراءة: ' + col + '...');
      let rows = [];
      try {
        rows = await fetchAllCollectionDocs(col);
      } catch (e) {
        rows = [{ _error: String(e.message || e) }];
      }
      counts[col] = Array.isArray(rows) ? rows.length : 0;

      // فهرس بالإيميل للمستخدمين والمشتريات
      if (col === 'users') {
        rows.forEach(r => {
          if (r.data?.blockEmailRestore || r.data?.permanentlyDeleted) return;
          const em = (r.data?.email || '').toLowerCase().trim();
          if (em) {
            byEmail[em] = byEmail[em] || { email: em, userId: r.id, user: r.data, purchases: [], projects: [] };
            byEmail[em].userId = r.id;
            byEmail[em].user = r.data;
          }
        });
      }
      if (col === 'purchases') {
        rows.forEach(r => {
          const em = (r.data?.userEmail || r.data?.email || '').toLowerCase().trim();
          const uid = r.data?.userId || '';
          if (em) {
            byEmail[em] = byEmail[em] || { email: em, userId: uid, purchases: [], projects: [] };
            byEmail[em].purchases.push(r);
          }
        });
      }
      if (col === 'projects') {
        rows.forEach(r => {
          const em = (r.data?.sellerEmail || '').toLowerCase().trim();
          if (em) {
            byEmail[em] = byEmail[em] || { email: em, userId: r.data?.sellerId, purchases: [], projects: [] };
            byEmail[em].projects.push({ id: r.id, title: r.data?.title, price: r.data?.price });
          }
        });
      }

      const jsonText = JSON.stringify({ collection: col, exportedAt: new Date().toISOString(), count: rows.length, docs: rows }, null, 0);
      // تقسيم لو كبير
      if (jsonText.length > 12 * 1024 * 1024) {
        const chunkSize = 500;
        for (let i = 0; i < rows.length; i += chunkSize) {
          const part = rows.slice(i, i + chunkSize);
          const partText = JSON.stringify({ collection: col, part: Math.floor(i / chunkSize) + 1, docs: part });
          await driveBackupRequest({ action: 'backupWrite', folderId, fileName: col + '_part' + (Math.floor(i / chunkSize) + 1) + '.json', jsonText: partText });
        }
      } else {
        await driveBackupRequest({ action: 'backupWrite', folderId, fileName: col + '.json', jsonText });
      }
    }

    setProg('كتابة فهرس الإيميلات و meta...');
    const emailIndex = Object.values(byEmail);
    await driveBackupRequest({
      action: 'backupWrite',
      folderId,
      fileName: 'by_email.json',
      jsonText: JSON.stringify({ description: 'فهرس لكل إيميل: بيانات المستخدم + مشترياته + منتجاته', count: emailIndex.length, emails: emailIndex })
    });

    const meta = {
      exportedAt: new Date().toISOString(),
      stamp,
      scriptVersion: 5,
      projectHint: 'misran-4b187',
      counts,
      emailCount: emailIndex.length,
      note: 'Firestore data only. Firebase Auth passwords are NOT included — see AUTH_MIGRATION in meta.',
      AUTH_MIGRATION: {
        ar: 'نسخ Firestore يعيد الأرصدة والمنتجات والمشتريات بنفس الـ document id. تسجيل الدخول (Auth) لا يُنقل بكلمات المرور من المتصفح. للنقل لمشروع Firebase جديد: 1) استورد وثائق Firestore 2) استخدم Firebase Admin SDK أو Auth Import لنقل المستخدمين، أو أنشئ حسابات بالإيميلات وأرسل رابط إعادة تعيين كلمة المرور.',
        keepSameProject: 'لو نفس مشروع Firebase: النسخة للاحتياط فقط — المستخدمون يسجلون كالمعتاد.',
        newProject: 'مشروع جديد: استعد JSON → users/projects/purchases بنفس الـ id، ثم Auth import أو password reset جماعي.'
      }
    };
    await driveBackupRequest({ action: 'backupWrite', folderId, fileName: 'meta.json', jsonText: JSON.stringify(meta, null, 2) });

    if (bar) bar.style.width = '100%';
    if (msg) msg.innerHTML = `<span class="text-success">تمت النسخة الاحتياطية.</span> المجلد: <a href="${init.folderUrl}" target="_blank" rel="noopener">فتح على درايف</a> · إيميلات مفهرسة: ${emailIndex.length}`;
    try {
      await setDoc(doc(db, 'settings', 'backup'), {
        lastBackupAt: serverTimestamp(),
        lastStamp: stamp,
        lastFolderUrl: init.folderUrl || null,
        counts,
        emailCount: emailIndex.length,
        auto: !!silent
      }, { merge: true });
    } catch (_) {}
    if (!silent) showToast('تمت النسخة الاحتياطية على درايف');
    return { ok: true, folderUrl: init.folderUrl };
  } catch (e) {
    if (msg) msg.innerHTML = `<span class="text-danger">${e.message || e}</span>`;
    if (!silent) showToast(e.message || String(e), 'error');
    console.warn('backup failed', e);
    return { ok: false, error: e };
  } finally {
    if (!silent) showLoading(false);
  }
}

// تشغيل تلقائي: مرة كل 24 ساعة عند فتح الأدمن (بدون زر إلزامي)
async function maybeAutoBackup() {
  try {
    const snap = await getDoc(doc(db, 'settings', 'backup'));
    const last = snap.exists() ? snap.data().lastBackupAt : null;
    const lastMs = last?.toMillis?.() || 0;
    const day = 24 * 60 * 60 * 1000;
    if (Date.now() - lastMs < day) return;
    // لا نمنع واجهة الأدمن — خلفية هادئة
    const msg = document.getElementById('fullBackupMsg');
    if (msg) msg.textContent = 'جاري نسخة احتياطية تلقائية في الخلفية...';
    await runFullBackup({ silent: true });
    if (msg) msg.innerHTML = '<span class="text-success">آخر نسخة تلقائية تمت بنجاح</span>';
  } catch (e) {
    console.warn('auto backup', e);
  }
}

// بعد تحميل الصفحة
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => setTimeout(maybeAutoBackup, 8000));
} else {
  setTimeout(maybeAutoBackup, 8000);
}



// ===== أرباحي (Hub: عمولاتي / إبداعاتي / الإعلانات الممولة) =====
function initEarningsHub() {
  const tabs = document.querySelectorAll('#earningsHubTabs [data-hub]');
  tabs.forEach(btn => {
    btn.onclick = () => {
      tabs.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('.earnings-hub-pane').forEach(p => p.classList.add('d-none'));
      const pane = document.getElementById('hub-' + btn.dataset.hub);
      if (pane) pane.classList.remove('d-none');
      if (btn.dataset.hub === 'commission') loadCommissionEarnings();
      else if (btn.dataset.hub === 'creations') loadAdminMyEarnings();
      else if (btn.dataset.hub === 'sponsored') loadSponsoredEarningsLog();
    };
  });
  // افتراضي: عمولاتي
  const active = document.querySelector('#earningsHubTabs .nav-link.active');
  if (active?.dataset.hub === 'commission') loadCommissionEarnings();
  else if (active?.dataset.hub === 'creations') loadAdminMyEarnings();
}

async function loadSponsoredEarningsLog() {
  const list = document.getElementById('sponsoredEarnList');
  if (!list) return;
  list.innerHTML = '<div class="text-center py-3"><div class="spinner-border spinner-border-sm"></div></div>';
  try {
    const q = query(collection(db, 'sponsored_ads'), orderBy('createdAt', 'desc'), limit(80));
    const snap = await getDocs(q);
    const ads = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    let total = 0;
    ads.forEach(a => { total += parseFloat(a.pricePaid) || 0; });
    const totalEl = document.getElementById('sponsoredEarnTotal');
    const countEl = document.getElementById('sponsoredEarnCount');
    if (totalEl) totalEl.textContent = total.toFixed(2);
    if (countEl) countEl.textContent = ads.length;

    const searchEl = document.getElementById('sponsoredEarnSearch');
    const render = (filter = '') => {
      const f = (filter || '').trim().toLowerCase();
      const filtered = f
        ? ads.filter(a =>
            (a.id || '').toLowerCase().includes(f) ||
            (a.productId || '').toLowerCase().includes(f) ||
            (a.userId || '').toLowerCase().includes(f) ||
            (a.productTitle || '').toLowerCase().includes(f)
          )
        : ads;
      if (!filtered.length) {
        list.innerHTML = '<div class="alert alert-info">لا توجد سجلات</div>';
        return;
      }
      list.innerHTML = filtered.map(a => `
        <div class="card mb-2"><div class="card-body py-2 d-flex justify-content-between flex-wrap gap-2">
          <div>
            <strong>${a.productTitle || a.productId || a.id}</strong>
            <div class="small text-muted">user: ${a.userId || '—'} · ID: ${a.id}</div>
          </div>
          <div class="text-end">
            <span class="badge bg-success">${a.pricePaid != null ? a.pricePaid + ' ج' : '—'}</span>
            <div class="small text-muted">${a.status || ''}</div>
          </div>
        </div></div>
      `).join('');
    };
    render();
    if (searchEl && !searchEl._bound) {
      searchEl._bound = true;
      searchEl.addEventListener('input', () => render(searchEl.value));
    }
  } catch (e) {
    console.error(e);
    list.innerHTML = '<div class="alert alert-danger">خطأ في التحميل (قد تحتاج فهرس createdAt). ' + (e.message || '') + '</div>';
  }
}

// ===== إدارة الإعلانات الممولة (أدمن) =====
let _sponsoredAdsPage = 0;
const SPONSORED_PAGE_SIZE = 20;
let _sponsoredAdsCache = [];

async function loadSponsoredAdsAdmin(direction = 'first') {
  const list = document.getElementById('sponsoredAdsList');
  if (!list) return;
  list.innerHTML = '<div class="text-center py-4"><div class="spinner-border text-primary"></div></div>';

  try {
    const statusFilter = document.getElementById('sponsoredAdsStatus')?.value || 'active';
    // قراءة محدودة — فقط عند فتح القسم
    let qRef = query(collection(db, 'sponsored_ads'), orderBy('createdAt', 'desc'), limit(100));
    const snap = await getDocs(qRef);
    let ads = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    if (statusFilter !== 'all') {
      ads = ads.filter(a => {
        if (statusFilter === 'active') {
          const end = a.endAt?.toDate ? a.endAt.toDate().getTime() : 0;
          return a.status === 'active' && (!end || end > Date.now());
        }
        return a.status === statusFilter;
      });
    }

    const search = (document.getElementById('sponsoredAdsSearch')?.value || '').trim().toLowerCase();
    if (search) {
      ads = ads.filter(a =>
        (a.id || '').toLowerCase().includes(search) ||
        (a.productId || '').toLowerCase().includes(search) ||
        (a.userId || '').toLowerCase().includes(search) ||
        (a.productTitle || '').toLowerCase().includes(search)
      );
    }

    _sponsoredAdsCache = ads;
    if (direction === 'first') _sponsoredAdsPage = 0;
    else if (direction === 'next') _sponsoredAdsPage++;
    else if (direction === 'prev') _sponsoredAdsPage = Math.max(0, _sponsoredAdsPage - 1);

    const start = _sponsoredAdsPage * SPONSORED_PAGE_SIZE;
    const pageItems = ads.slice(start, start + SPONSORED_PAGE_SIZE);
    const totalPages = Math.max(1, Math.ceil(ads.length / SPONSORED_PAGE_SIZE));

    const info = document.getElementById('sponsoredAdsPageInfo');
    if (info) info.textContent = `صفحة ${_sponsoredAdsPage + 1} من ${totalPages} (${ads.length} إعلان)`;
    const prevBtn = document.getElementById('sponsoredAdsPrev');
    const nextBtn = document.getElementById('sponsoredAdsNext');
    if (prevBtn) prevBtn.disabled = _sponsoredAdsPage <= 0;
    if (nextBtn) nextBtn.disabled = start + SPONSORED_PAGE_SIZE >= ads.length;

    if (!pageItems.length) {
      list.innerHTML = '<div class="alert alert-info">لا توجد إعلانات مطابقة</div>';
      return;
    }

    list.innerHTML = pageItems.map(a => {
      const end = a.endAt?.toDate ? a.endAt.toDate() : null;
      const isActive = a.status === 'active' && (!end || end.getTime() > Date.now());
      return `
        <div class="card mb-2">
          <div class="card-body py-2">
            <div class="d-flex flex-wrap justify-content-between gap-2">
              <div>
                <strong>${a.productTitle || a.productId || '—'}</strong>
                <div class="small text-muted">ID: ${a.id} · منتج: ${a.productId || '—'} · مستخدم: ${a.userId || '—'}</div>
                <div class="small">المدة: ${a.durationDays || '—'} يوم · مدفوع: ${a.pricePaid != null ? a.pricePaid + ' ج' : '—'} · ${a.priority || 'عادي'}</div>
              </div>
              <div class="text-end">
                <span class="badge ${isActive ? 'bg-success' : 'bg-secondary'}">${a.status || '—'}</span>
                ${isActive ? `
                  <div class="mt-1">
                    <button type="button" class="btn btn-sm btn-outline-danger admin-cancel-sponsored"
                      data-id="${a.id}" data-userid="${a.userId || ''}" data-price="${a.pricePaid || 0}">
                      إلغاء تفعيل + استرجاع
                    </button>
                  </div>` : ''}
              </div>
            </div>
          </div>
        </div>`;
    }).join('');

    list.querySelectorAll('.admin-cancel-sponsored').forEach(btn => {
      btn.addEventListener('click', () => {
        document.getElementById('adminCancelSponsoredId').value = btn.dataset.id;
        document.getElementById('adminCancelSponsoredUserId').value = btn.dataset.userid;
        document.getElementById('adminCancelSponsoredPrice').value = btn.dataset.price;
        document.getElementById('adminCancelReason').value = '';
        new bootstrap.Modal(document.getElementById('adminCancelSponsoredModal')).show();
      });
    });
  } catch (e) {
    console.error(e);
    list.innerHTML = '<div class="alert alert-danger">خطأ: ' + (e.message || e) + ' — تأكد من وجود collection sponsored_ads وفهرس createdAt</div>';
  }
}

// ربط أزرار قسم الإعلانات
document.getElementById('sponsoredAdsRefresh')?.addEventListener('click', () => loadSponsoredAdsAdmin('first'));
document.getElementById('sponsoredAdsPrev')?.addEventListener('click', () => loadSponsoredAdsAdmin('prev'));
document.getElementById('sponsoredAdsNext')?.addEventListener('click', () => loadSponsoredAdsAdmin('next'));
document.getElementById('sponsoredAdsStatus')?.addEventListener('change', () => loadSponsoredAdsAdmin('first'));
document.getElementById('sponsoredAdsSearch')?.addEventListener('input', () => {
  // فلترة محلية بعد التحميل
  if (_sponsoredAdsCache.length) loadSponsoredAdsAdmin('first');
});

document.getElementById('adminConfirmCancelSponsored')?.addEventListener('click', async () => {
  const id = document.getElementById('adminCancelSponsoredId')?.value;
  const userId = document.getElementById('adminCancelSponsoredUserId')?.value;
  const price = parseFloat(document.getElementById('adminCancelSponsoredPrice')?.value) || 0;
  const reason = (document.getElementById('adminCancelReason')?.value || '').trim();
  if (!id) return;
  if (!reason) { showToast('اكتب سبب الإلغاء', 'error'); return; }
  const btn = document.getElementById('adminConfirmCancelSponsored');
  btn.disabled = true;
  try {
    // 1) تحديث حالة الإعلان
    await updateDoc(doc(db, 'sponsored_ads', id), {
      status: 'cancelled_by_admin',
      cancelledAt: serverTimestamp(),
      cancelledBy: 'admin',
      cancelReason: reason,
      updatedAt: serverTimestamp()
    });
    // 2) استرجاع الرصيد للمستخدم (إن وُجد userId وسعر)
    if (userId && price > 0) {
      const userRef = doc(db, 'users', userId);
      const userSnap = await getDoc(userRef);
      if (userSnap.exists()) {
        const bal = parseFloat(userSnap.data().balance) || 0;
        await updateDoc(userRef, {
          balance: bal + price,
          updatedAt: serverTimestamp()
        });
      }
    }
    try { networkInvalidate && networkInvalidate('sponsored'); } catch (_) {}
    bootstrap.Modal.getInstance(document.getElementById('adminCancelSponsoredModal'))?.hide();
    showToast('تم إلغاء الإعلان واسترجاع الرصيد');
    loadSponsoredAdsAdmin('first');
  } catch (e) {
    console.error(e);
    showToast('فشل الإلغاء: ' + (e.message || e), 'error');
  } finally {
    btn.disabled = false;
  }
});

// ===== قسم الإداريين (المالك فقط) =====
async function loadAdminsSection() {
  if (!currentAdminRoles?._owner) {
    const list = document.getElementById('appointedAdminsList');
    if (list) list.innerHTML = '<div class="alert alert-danger">هذا القسم للمالك فقط</div>';
    return;
  }
  loadAppointedAdmins();
  const searchEl = document.getElementById('adminAppointSearch');
  if (searchEl && !searchEl._bound) {
    searchEl._bound = true;
    let t;
    searchEl.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(() => searchUsersForAdmin(searchEl.value.trim()), 350);
    });
  }
}

async function searchUsersForAdmin(q) {
  const box = document.getElementById('adminAppointResults');
  if (!box) return;
  if (!q || q.length < 2) {
    box.innerHTML = '<div class="text-muted small">اكتب حرفين على الأقل للبحث</div>';
    return;
  }
  box.innerHTML = '<div class="spinner-border spinner-border-sm"></div>';
  try {
    const snap = await getDocs(query(collection(db, 'users'), limit(80)));
    const ql = q.toLowerCase();
    const hits = snap.docs.filter(d => {
      const u = d.data();
      return d.id.toLowerCase().includes(ql) ||
        (u.email || '').toLowerCase().includes(ql) ||
        (u.name || '').toLowerCase().includes(ql);
    }).slice(0, 15);

    if (!hits.length) {
      box.innerHTML = '<div class="alert alert-secondary py-2">لا نتائج</div>';
      return;
    }
    box.innerHTML = hits.map(d => {
      const u = d.data();
      const isOwn = isOwnerEmail(u.email);
      const hasRoles = u.adminRoles && (u.adminRoles.general || u.adminRoles.users || u.adminRoles.products || u.adminRoles.finance || u.adminRoles.tools);
      return `<div class="card mb-2"><div class="card-body py-2 d-flex justify-content-between align-items-center flex-wrap gap-2">
        <div>
          <strong>${u.name || '—'}</strong>
          <div class="small text-muted">${u.email || ''} · ID: ${d.id}</div>
        </div>
        <div>
          ${isOwn ? '<span class="badge bg-dark">المالك</span>' :
            `<button type="button" class="btn btn-sm btn-primary appoint-admin-btn" data-id="${d.id}" data-name="${(u.name||'').replace(/"/g,'&quot;')}" data-email="${(u.email||'').replace(/"/g,'&quot;')}">
              ${hasRoles ? 'تعديل الإدارية' : 'تعيين إداري'}
            </button>`}
        </div>
      </div></div>`;
    }).join('');

    box.querySelectorAll('.appoint-admin-btn').forEach(btn => {
      btn.onclick = async () => {
        const id = btn.dataset.id;
        const snap = await getDoc(doc(db, 'users', id));
        const roles = snap.exists() ? (snap.data().adminRoles || {}) : {};
        openAdminRolesModal(id, btn.dataset.name, btn.dataset.email, roles);
      };
    });
  } catch (e) {
    box.innerHTML = `<div class="alert alert-danger">${e.message}</div>`;
  }
}

async function loadAppointedAdmins() {
  const list = document.getElementById('appointedAdminsList');
  if (!list) return;
  list.innerHTML = '<div class="text-center py-2"><div class="spinner-border spinner-border-sm"></div></div>';
  try {
    const snap = await getDocs(query(collection(db, 'users'), limit(150)));
    const admins = snap.docs.filter(d => {
      const u = d.data();
      if (isOwnerEmail(u.email)) return true;
      const r = u.adminRoles;
      return r && (r.general || r.users || r.products || r.finance || r.tools);
    });
    if (!admins.length) {
      list.innerHTML = '<div class="alert alert-info">لا يوجد إداريون معيّنون بعد</div>';
      return;
    }
    list.innerHTML = admins.map(d => {
      const u = d.data();
      const r = u.adminRoles || {};
      const rolesLabel = isOwnerEmail(u.email) ? 'المالك (كل الصلاحيات)' :
        [r.general && 'عامة', r.users && 'مستخدمين', r.products && 'منتجات', r.finance && 'مالية', r.tools && 'أدوات'].filter(Boolean).join(' · ') || '—';
      const photo = u.photoURL || u.avatarUrl || '';
      const photoHtml = photo
        ? `<img src="${photo}" alt="" style="width:40px;height:40px;border-radius:50%;object-fit:cover;">`
        : `<div class="bg-secondary text-white rounded-circle d-inline-flex align-items-center justify-content-center" style="width:40px;height:40px;">${(u.name||'?')[0]}</div>`;
      return `<div class="card mb-2"><div class="card-body py-2">
        <div class="d-flex flex-wrap justify-content-between align-items-center gap-2">
          <div class="d-flex align-items-center gap-2">
            ${photoHtml}
            <div>
              <strong>${u.name || '—'}</strong>
              <div class="small text-muted">${u.email || ''} · ID: ${d.id}</div>
              <div class="small"><span class="badge bg-secondary">${rolesLabel}</span></div>
            </div>
          </div>
          <div class="d-flex gap-1 flex-wrap">
            <button type="button" class="btn btn-sm btn-outline-primary admin-view-detail" data-id="${d.id}">عرض التفاصيل</button>
            ${isOwnerEmail(u.email) ? '' : `
              <button type="button" class="btn btn-sm btn-outline-secondary admin-edit-roles" data-id="${d.id}">تعديل الإدارية</button>
              <button type="button" class="btn btn-sm btn-outline-danger admin-remove-btn" data-id="${d.id}" data-name="${(u.name||'').replace(/"/g,'&quot;')}">عزل</button>
            `}
          </div>
        </div>
      </div></div>`;
    }).join('');

    list.querySelectorAll('.admin-view-detail').forEach(btn => {
      btn.onclick = () => showAdminUserDetail(btn.dataset.id);
    });
    list.querySelectorAll('.admin-edit-roles').forEach(btn => {
      btn.onclick = async () => {
        const snap = await getDoc(doc(db, 'users', btn.dataset.id));
        const u = snap.data() || {};
        openAdminRolesModal(btn.dataset.id, u.name, u.email, u.adminRoles || {});
      };
    });
    list.querySelectorAll('.admin-remove-btn').forEach(btn => {
      btn.onclick = async () => {
        if (!(await siteConfirm(`عزل الإداري «${btn.dataset.name}»؟ سيختفي زر وضع الأدمن عنده.`, 'عزل إداري'))) return;
        try {
          await updateDoc(doc(db, 'users', btn.dataset.id), {
            adminRoles: { general: false, users: false, products: false, finance: false, tools: false },
            updatedAt: serverTimestamp()
          });
          try { networkInvalidate('users:'); } catch(_){}
          showToast('تم عزل الإداري');
          loadAppointedAdmins();
        } catch (e) { showToast(e.message, 'error'); }
      };
    });
  } catch (e) {
    list.innerHTML = `<div class="alert alert-danger">${e.message}</div>`;
  }
}

function openAdminRolesModal(userId, name, email, roles) {
  document.getElementById('adminRolesUserId').value = userId;
  document.getElementById('adminRolesTargetLabel').textContent = `${name || ''} — ${email || ''} — ${userId}`;
  document.getElementById('adminRolesModalTitle').textContent = 'تحديد الإدارية';
  ['general','users','products','finance','tools'].forEach(k => {
    const el = document.getElementById('role_' + k);
    if (el) el.checked = !!roles[k];
  });
  new bootstrap.Modal(document.getElementById('adminRolesModal')).show();
}

document.getElementById('saveAdminRolesBtn')?.addEventListener('click', async () => {
  const userId = document.getElementById('adminRolesUserId')?.value;
  if (!userId || !currentAdminRoles?._owner) return;
  const roles = {
    general: !!document.getElementById('role_general')?.checked,
    users: !!document.getElementById('role_users')?.checked,
    products: !!document.getElementById('role_products')?.checked,
    finance: !!document.getElementById('role_finance')?.checked,
    tools: !!document.getElementById('role_tools')?.checked
  };
  try {
    await updateDoc(doc(db, 'users', userId), { adminRoles: roles, updatedAt: serverTimestamp() });
    try { networkInvalidate('users:'); } catch(_){}
    bootstrap.Modal.getInstance(document.getElementById('adminRolesModal'))?.hide();
    showToast('تم حفظ الصلاحيات');
    loadAppointedAdmins();
  } catch (e) { showToast(e.message, 'error'); }
});

async function showAdminUserDetail(userId) {
  const body = document.getElementById('adminDetailBody');
  if (!body) return;
  body.innerHTML = '<div class="text-center"><div class="spinner-border"></div></div>';
  new bootstrap.Modal(document.getElementById('adminDetailModal')).show();
  try {
    const snap = await getDoc(doc(db, 'users', userId));
    if (!snap.exists()) {
      body.innerHTML = '<div class="alert alert-warning">المستخدم غير موجود</div>';
      return;
    }
    const u = snap.data();
    const photo = u.photoURL || u.avatarUrl || '';
    const r = u.adminRoles || {};
    body.innerHTML = `
      <div class="text-center mb-3">
        ${photo ? `<img src="${photo}" alt="" style="width:96px;height:96px;border-radius:50%;object-fit:cover;">` :
          `<div class="bg-secondary text-white rounded-circle d-inline-flex align-items-center justify-content-center mx-auto" style="width:96px;height:96px;font-size:2rem;">${(u.name||'?')[0]}</div>`}
      </div>
      <table class="table table-sm">
        <tr><th>الاسم</th><td>${u.name || '—'}</td></tr>
        <tr><th>البريد</th><td>${u.email || '—'}</td></tr>
        <tr><th>ID</th><td><code>${userId}</code></td></tr>
        <tr><th>الهاتف</th><td>${u.phone || '—'}</td></tr>
        <tr><th>نبذة</th><td>${u.bio || '—'}</td></tr>
        <tr><th>الرصيد</th><td>${u.balance != null ? u.balance : '—'}</td></tr>
        <tr><th>الصلاحيات</th><td>${isOwnerEmail(u.email) ? 'المالك' : [r.general&&'عامة',r.users&&'مستخدمين',r.products&&'منتجات',r.finance&&'مالية',r.tools&&'أدوات'].filter(Boolean).join(' · ') || 'لا توجد'}</td></tr>
      </table>`;
  } catch (e) {
    body.innerHTML = `<div class="alert alert-danger">${e.message}</div>`;
  }
}

// ===== إضافة رصيد من الأدمن =====
function initAddBalanceSection() {
  const searchEl = document.getElementById('addBalanceSearch');
  const box = document.getElementById('addBalanceResults');
  if (!searchEl || !box) return;
  if (!searchEl._bound) {
    searchEl._bound = true;
    let t;
    searchEl.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(() => searchUsersForBalance(searchEl.value.trim()), 350);
    });
  }
  box.innerHTML = '<div class="text-muted small">اكتب حرفين على الأقل للبحث بالاسم أو الإيميل أو ID</div>';
}

async function searchUsersForBalance(q) {
  const box = document.getElementById('addBalanceResults');
  if (!box) return;
  if (!q || q.length < 2) {
    box.innerHTML = '<div class="text-muted small">اكتب حرفين على الأقل للبحث</div>';
    return;
  }
  box.innerHTML = '<div class="text-center py-3"><div class="spinner-border spinner-border-sm text-primary"></div></div>';
  try {
    const snap = await getDocs(query(collection(db, 'users'), limit(100)));
    const ql = q.toLowerCase();
    const hits = snap.docs.filter(d => {
      const u = d.data();
      return d.id.toLowerCase().includes(ql) ||
        (u.email || '').toLowerCase().includes(ql) ||
        (u.name || '').toLowerCase().includes(ql);
    }).slice(0, 20);

    if (!hits.length) {
      box.innerHTML = '<div class="alert alert-secondary">لا توجد نتائج</div>';
      return;
    }
    box.innerHTML = hits.map(d => {
      const u = d.data();
      const bal = parseFloat(u.balance) || 0;
      const photo = u.photoURL || u.avatarUrl || '';
      const avatar = photo
        ? `<img src="${photo}" alt="" style="width:40px;height:40px;border-radius:50%;object-fit:cover;">`
        : `<div class="bg-secondary text-white rounded-circle d-inline-flex align-items-center justify-content-center" style="width:40px;height:40px;">${(u.name||'?')[0]}</div>`;
      return `<div class="card mb-2"><div class="card-body py-2 d-flex flex-wrap justify-content-between align-items-center gap-2">
        <div class="d-flex align-items-center gap-2">
          ${avatar}
          <div>
            <strong>${u.name || '—'}</strong>
            <div class="small text-muted">${u.email || ''} · ID: ${d.id}</div>
            <div class="small">الرصيد الحالي: <strong class="text-success">${bal.toFixed(2)} ج.م</strong></div>
          </div>
        </div>
        <button type="button" class="btn btn-sm btn-success send-balance-btn"
          data-id="${d.id}"
          data-name="${(u.name||'').replace(/"/g,'&quot;')}"
          data-email="${(u.email||'').replace(/"/g,'&quot;')}"
          data-bal="${bal}">
          <i class="fas fa-paper-plane me-1"></i>إرسال رصيد
        </button>
      </div></div>`;
    }).join('');

    box.querySelectorAll('.send-balance-btn').forEach(btn => {
      btn.onclick = () => {
        document.getElementById('sendBalanceUserId').value = btn.dataset.id;
        document.getElementById('sendBalanceUserLabel').innerHTML =
          `المستخدم: <strong>${btn.dataset.name}</strong> (${btn.dataset.email})<br><span class="small text-muted">الرصيد الحالي: ${parseFloat(btn.dataset.bal||0).toFixed(2)} ج.م · ID: ${btn.dataset.id}</span>`;
        document.getElementById('sendBalanceAmount').value = '';
        document.getElementById('sendBalanceReason').value = '';
        new bootstrap.Modal(document.getElementById('sendBalanceModal')).show();
      };
    });
  } catch (e) {
    console.error(e);
    box.innerHTML = `<div class="alert alert-danger">${e.message || e}</div>`;
  }
}

document.getElementById('confirmSendBalanceBtn')?.addEventListener('click', async () => {
  const userId = document.getElementById('sendBalanceUserId')?.value;
  const amount = parseFloat(document.getElementById('sendBalanceAmount')?.value);
  const reason = (document.getElementById('sendBalanceReason')?.value || '').trim();
  if (!userId) return;
  if (!isFinite(amount) || amount <= 0) {
    showToast('أدخل كمية صحيحة أكبر من صفر', 'error');
    return;
  }
  if (!reason) {
    showToast('اكتب سبب الإرسال', 'error');
    return;
  }
  if (!(await siteConfirm(`تأكيد إرسال ${amount.toFixed(2)} ج.م لهذا المستخدم؟\nالسبب: ${reason}`, 'تأكيد إضافة رصيد'))) return;

  const btn = document.getElementById('confirmSendBalanceBtn');
  btn.disabled = true;
  try {
    const userRef = doc(db, 'users', userId);
    const userSnap = await getDoc(userRef);
    if (!userSnap.exists()) {
      showToast('المستخدم غير موجود', 'error');
      return;
    }
    const prev = parseFloat(userSnap.data().balance) || 0;
    const next = prev + amount;

    await updateDoc(userRef, {
      balance: next,
      updatedAt: serverTimestamp()
    });

    await addDoc(collection(db, 'balance_logs'), {
      userId,
      type: 'admin_credit',
      amount,
      balanceBefore: prev,
      balanceAfter: next,
      reason,
      adminId: currentAdminUser?.uid || null,
      adminEmail: currentAdminUser?.email || null,
      createdAt: serverTimestamp()
    });

    await addDoc(collection(db, 'notifications'), {
      userId,
      title: 'تم إضافة رصيد لحسابك',
      body: `تم إضافة ${amount.toFixed(2)} ج.م إلى رصيدك. السبب: ${reason}`,
      type: 'balance_credit',
      amount,
      reason,
      read: false,
      createdAt: serverTimestamp()
    });

    try { networkInvalidate('users:', 'user:' + userId); } catch (_) {}
    bootstrap.Modal.getInstance(document.getElementById('sendBalanceModal'))?.hide();
    showToast(`تم إرسال ${amount.toFixed(2)} ج.م بنجاح`);
    const q = document.getElementById('addBalanceSearch')?.value?.trim();
    if (q) searchUsersForBalance(q);
  } catch (e) {
    console.error(e);
    showToast('فشل الإرسال: ' + (e.message || e), 'error');
  } finally {
    btn.disabled = false;
  }
});


// إيقاف شات الأدمن عند إخفاء التبويب
document.addEventListener('visibilitychange', () => {
  if (document.hidden && adminChatUnsub) {
    try { adminChatUnsub(); } catch(_){}
    adminChatUnsub = null;
  }
});
window.addEventListener('pagehide', () => {
  if (adminChatUnsub) { try { adminChatUnsub(); } catch(_){} adminChatUnsub = null; }
});

// ===== تبويبات الجذر الأساسي =====
function initRootSettingsTabs() {
  const tabs = document.querySelectorAll('#rootSettingsTabs [data-root-tab]');
  if (!tabs.length) return;
  tabs.forEach(btn => {
    if (btn._rootBound) return;
    btn._rootBound = true;
    btn.addEventListener('click', () => {
      tabs.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('.root-tab-pane').forEach(p => p.classList.add('d-none'));
      const pane = document.getElementById('root-tab-' + btn.dataset.rootTab);
      if (pane) pane.classList.remove('d-none');
    });
  });
}

document.getElementById('saveSupportPhoneBtn')?.addEventListener('click', async () => {
  const phone = (document.getElementById('supportPhoneInput')?.value || '').trim();
  const hint = (document.getElementById('supportPhoneHintInput')?.value || '').trim() || 'لو مستعجل وعايز تواصل أسرع اتصل على هذا الرقم';
  const msg = document.getElementById('supportPhoneSaveMsg');
  if (!phone) { showToast('أدخل رقم التليفون', 'error'); return; }
  try {
    await setDoc(doc(db, 'settings', 'siteMessages'), {
      supportPhone: phone,
      devPhone: phone,
      supportPhoneHint: hint,
      updatedAt: serverTimestamp()
    }, { merge: true });
    try {
      networkInvalidate('settings:siteMessages');
      const prev = cacheGet('settings:siteMessages') || {};
      cacheSet('settings:siteMessages', { ...prev, supportPhone: phone, devPhone: phone, supportPhoneHint: hint });
    } catch (_) {}
    if (msg) msg.innerHTML = '<span class="text-success">تم حفظ رقم الاتصال</span>';
    showToast('تم حفظ رقم الدعم');
  } catch (e) {
    if (msg) msg.textContent = e.message || String(e);
    showToast(e.message || String(e), 'error');
  }
});


function resetPromoForm() {
  document.getElementById('promoEditId').value = '';
  document.getElementById('promoTitle').value = '';
  document.getElementById('promoDesc').value = '';
  document.getElementById('promoVideoUrl').value = '';
  document.getElementById('promoThumb').value = '';
  window._promoThumbCropped = null;
  window._promoEditOldFileId = '';
  const ptp = document.getElementById('promoThumbCropPreview'); if (ptp) ptp.innerHTML = '';
  document.getElementById('promoFormTitle').textContent = 'إضافة محتوى';
  document.getElementById('promoAddBtn')?.classList.remove('d-none');
  document.getElementById('promoUpdateBtn')?.classList.add('d-none');
  document.getElementById('promoCancelEditBtn')?.classList.add('d-none');
  const msg = document.getElementById('promoAddMsg'); if (msg) msg.textContent = '';
}

document.getElementById('promoCancelEditBtn')?.addEventListener('click', () => resetPromoForm());

document.getElementById('promoUpdateBtn')?.addEventListener('click', async () => {
  const id = document.getElementById('promoEditId')?.value;
  if (!id) return;
  const type = document.getElementById('promoType')?.value || 'youtube';
  const title = (document.getElementById('promoTitle')?.value || '').trim();
  const description = (document.getElementById('promoDesc')?.value || '').trim();
  const videoUrl = (document.getElementById('promoVideoUrl')?.value || '').trim();
  const thumbFile = window._promoThumbCropped || document.getElementById('promoThumb')?.files?.[0];
  if (!title || !videoUrl) {
    showToast('الاسم والرابط مطلوبان', 'error');
    return;
  }
  const msg = document.getElementById('promoAddMsg');
  try {
    showLoading(true, 'جاري حفظ التعديل...');
    const payload = {
      type,
      title,
      description,
      videoUrl,
      updatedAt: serverTimestamp()
    };
    if (thumbFile) {
      const oldId = window._promoEditOldFileId || '';
      if (oldId && typeof adminDeleteDriveFile === 'function') {
        try { await adminDeleteDriveFile(oldId); } catch (_) {}
      }
      const up = await adminUploadToDrive(thumbFile, {
        projectName: 'PromoContentThumbs',
        folderKind: 'images',
        deleteOldInFolder: false
      });
      payload.thumbnail = up.thumbUrl || up.url || '';
      payload.thumbnailFileId = up.fileId || null;
    }
    await updateDoc(doc(db, 'promoContent', id), payload);
    try { networkInvalidate('promo:'); } catch (_) {}
    if (msg) msg.innerHTML = '<span class="text-success">تم حفظ التعديل</span>';
    showToast('تم تحديث المحتوى');
    resetPromoForm();
    loadPromoAdmin(promoAdminPage || 1);
    loadPlaylistsAdmin();
  } catch (e) {
    if (msg) msg.textContent = e.message || String(e);
    showToast(e.message || String(e), 'error');
  } finally {
    showLoading(false);
  }
});

// بحث محلي في قائمة المحتوى
document.getElementById('promoSearch')?.addEventListener('input', () => {
  const q = (document.getElementById('promoSearch')?.value || '').trim().toLowerCase();
  document.querySelectorAll('#promoAdminList [data-promo-id]').forEach(el => {
    const hay = (el.dataset.promoSearch || '').toLowerCase();
    el.style.display = (!q || hay.includes(q)) ? '' : 'none';
  });
});
