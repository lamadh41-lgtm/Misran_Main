/**
 * ============================================================
 * قاعدة استهلاك إلزامية (انظر PERFORMANCE_RULES.md):
 * - لا قراءات/listeners على شيء المستخدم لم يفتحه أو يتفاعل معه.
 * - كاش محلي + limit + إيقاف المستمع عند الإغلاق.
 * - أي ميزة جديدة تُبنى بنفس الأسلوب وإلا تُرفض.
 * ============================================================
 */
import { 
  auth, db, storage,
  createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut, onAuthStateChanged,
  updateProfile, collection, doc, setDoc, getDoc, getDocs, addDoc, updateDoc, deleteDoc, query, where, orderBy, limit, serverTimestamp, onSnapshot,
  ref, uploadBytes, getDownloadURL
} from './firebase.js';
import { cacheGet, cacheSet, cachedFetch, softFetch, cacheUserKey, cacheNotifsKey, cacheChatsKey, cacheNewsKey, cacheRemovePrefix, cacheRemove, networkInvalidate, toPlain } from './localCache.js';

// ===== 20 فلتر / قسم للأصول =====
const PROJECT_CATEGORIES = [
  'شخصيات Characters',
  'أسلحة Weapons',
  'مركبات Vehicles',
  'مباني وبيوت Buildings',
  'أثاث وديكور Props',
  'خرائط Maps',
  'بيئة وتضاريس Environment',
  'وحوش وأعداء Creatures',
  'حركات Animation',
  'تأثيرات VFX',
  'أصوات وموسيقى Audio',
  'واجهات UI / HUD',
  'قوائم Main Menu',
  'سكربتات وأدوات Scripts',
  'أنظمة لعب Systems',
  'خامات Materials',
  'إضاءة ورندر Lighting',
  'شبكات ومتعدد لاعبين',
  'حزم كاملة Packs',
  'أخرى'
];
if (typeof window !== 'undefined') window.PROJECT_CATEGORIES = PROJECT_CATEGORIES;

function getEffectivePrice(p) {
  if (!p) return 0;
  const cur = parseFloat(p.price) || 0;
  const orig = parseFloat(p.originalPrice);
  const ends = p.saleEndsAt?.toMillis?.() || p.saleEndsAt?.__ts || (p.saleEndsAt ? new Date(p.saleEndsAt).getTime() : 0);
  // بعد انتهاء العرض: يرجع السعر الأصلي
  if (isFinite(orig) && orig > 0 && ends && Date.now() > ends) return orig;
  return cur;
}
function isProductOnSale(p) {
  if (!p) return false;
  if (p.salePending) return false; // لم يبدأ بعد قبول الأدمن
  const now = Date.now();
  const ends = p.saleEndsAt?.toMillis?.() || p.saleEndsAt?.__ts || (p.saleEndsAt ? new Date(p.saleEndsAt).getTime() : 0);
  const orig = parseFloat(p.originalPrice);
  const cur = parseFloat(p.price);
  return isFinite(orig) && isFinite(cur) && orig > cur && ends && ends > now;
}
function formatSaleRemaining(p) {
  if (!isProductOnSale(p)) return '';
  const ends = p.saleEndsAt?.toMillis?.() || p.saleEndsAt?.__ts || new Date(p.saleEndsAt).getTime();
  let ms = ends - Date.now();
  if (ms <= 0) return 'انتهى العرض';
  const totalMin = Math.floor(ms / 60000);
  const d = Math.floor(totalMin / (60 * 24));
  const h = Math.floor((totalMin % (60 * 24)) / 60);
  const m = totalMin % 60;
  if (d > 0) return d + ' يوم' + (h ? ' و ' + h + ' ساعة' : '');
  if (h > 0) return h + ' ساعة' + (m ? ' و ' + m + ' دقيقة' : '');
  return Math.max(1, m) + ' دقيقة';
}
/** مضاعف مدة العرض بالميلي ثانية */
function saleDurationToMs(val, unit) {
  const n = parseFloat(val) || 0;
  if (unit === 'minutes') return n * 60000;
  if (unit === 'hours') return n * 3600000;
  if (unit === 'months') return n * 30 * 86400000;
  return n * 86400000; // days
}
window.saleDurationToMs = saleDurationToMs;

function priceHtmlForProduct(p) {
  const cur = parseFloat(p.price) || 0;
  if (cur <= 0) return '<span class="badge bg-success">مجاني</span>';
  if (isProductOnSale(p)) {
    const orig = parseFloat(p.originalPrice) || 0;
    const left = formatSaleRemaining(p);
    return `<span class="sale-price-wrap d-inline-flex flex-wrap align-items-center gap-2">
      <span class="sale-old-price text-decoration-line-through text-muted" style="text-decoration-thickness:2px;font-size:0.95em;">${orig} ج.م</span>
      <span class="sale-new-price text-danger fw-bold" style="font-size:1.15em;">${cur} ج.م</span>
      <span class="badge bg-danger">عرض</span>
      <span class="sale-remain small text-muted"><i class="fas fa-clock me-1"></i>تبقى ${left}</span>
    </span>`;
  }
  return `<span class="fw-bold text-primary">${cur} ج.م</span>`;
}
if (typeof window !== 'undefined') {
  window.PROJECT_CATEGORIES = PROJECT_CATEGORIES;
  window.getEffectivePrice = getEffectivePrice;
  window.isProductOnSale = isProductOnSale;
  window.formatSaleRemaining = formatSaleRemaining;
  window.priceHtmlForProduct = priceHtmlForProduct;
}


// ===== Helpers =====
function showToast(message, type = 'success') {
  let container = document.querySelector('.toast-container');
  if (!container) {
    container = document.createElement('div');
    container.className = 'toast-container position-fixed bottom-0 end-0 p-3';
    container.style.zIndex = '9999';
    document.body.appendChild(container);
  }
  const id = 'toast-' + Date.now();
  const bg = type === 'success' ? 'bg-success' : type === 'error' ? 'bg-danger' : 'bg-primary';
  container.insertAdjacentHTML('beforeend', `
    <div id="${id}" class="toast align-items-center text-white ${bg} border-0" role="alert">
      <div class="d-flex">
        <div class="toast-body">${message}</div>
        <button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast"></button>
      </div>
    </div>
  `);
  const toastEl = document.getElementById(id);
  const toast = new bootstrap.Toast(toastEl, { delay: 4000 });
  toast.show();
  toastEl.addEventListener('hidden.bs.toast', () => toastEl.remove());
}

function showLoading(show = true, message = 'جاري التحميل...', percent = null) {
  let el = document.getElementById('loadingOverlay');
  const loaderHTML = `
      <div class="upload-loader-card">
        <div class="spinner-border text-primary mb-3" style="width:3rem;height:3rem;" role="status"></div>
        <div class="upload-loader-msg" id="loadingOverlayMsg"></div>
        <div class="upload-loader-bar mt-3 d-none" id="loadingOverlayBarWrap">
          <div class="progress" style="height:10px;width:240px;background:rgba(255,255,255,0.15);">
            <div class="progress-bar progress-bar-striped progress-bar-animated bg-warning" id="loadingOverlayBar" style="width:0%"></div>
          </div>
          <div class="upload-loader-pct mt-2" id="loadingOverlayPct">0%</div>
        </div>
      </div>`;
  if (!el && show) {
    el = document.createElement('div');
    el.id = 'loadingOverlay';
    el.className = 'spinner-overlay';
    el.innerHTML = loaderHTML;
    document.body.appendChild(el);
  } else if (el && show && !el.querySelector('.upload-loader-card')) {
    el.className = 'spinner-overlay';
    el.innerHTML = loaderHTML;
  }
  if (!el) return;
  if (show) {
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
    } else if (barWrap) {
      barWrap.classList.add('d-none');
    }
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
                <button type="button" class="btn btn-primary-custom text-white" id="siteConfirmYes">تأكيد</button>
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
    const cleanup = () => {
      yesBtn.onclick = null;
      modal.removeEventListener('hidden.bs.modal', onHide);
    };
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
                <button type="button" class="btn btn-primary-custom text-white" id="sitePromptYes">تأكيد</button>
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
    const cleanup = () => {
      yesBtn.onclick = null;
      modal.removeEventListener('hidden.bs.modal', onHide);
    };
    const onHide = () => { cleanup(); resolve(null); };
    yesBtn.onclick = () => {
      const val = input.value;
      cleanup();
      modalInst.hide();
      resolve(val);
    };
    modal.addEventListener('hidden.bs.modal', onHide);
    modalInst.show();
    setTimeout(() => input.focus(), 300);
  });
}
window.siteConfirm = siteConfirm;
window.sitePrompt = sitePrompt;


function linkifyText(text) {
  if (!text) return '';
  const escaped = String(text)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  return escaped.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
}
window.linkifyText = linkifyText;

function getInitials(name) {
  if (!name) return '?';
  return name.split(' ').map(n => n[0]).join('').substring(0, 2).toUpperCase();
}

// ===== Ensure Login/Register Modals exist on every page =====
function ensureAuthModals() {
  if (!document.getElementById('loginModal')) {
    document.body.insertAdjacentHTML('beforeend', `
      <div class="modal fade" id="loginModal" tabindex="-1">
        <div class="modal-dialog modal-dialog-centered">
          <div class="modal-content">
            <div class="modal-header">
              <h5 class="modal-title"><i class="fas fa-sign-in-alt me-2"></i>تسجيل الدخول</h5>
              <button type="button" class="btn-close btn-close-white" data-bs-dismiss="modal"></button>
            </div>
            <div class="modal-body">
              <form id="loginForm">
                <div class="mb-3">
                  <label class="form-label">البريد الإلكتروني</label>
                  <input type="email" class="form-control" id="loginEmail" required>
                </div>
                <div class="mb-3">
                  <label class="form-label">كلمة المرور</label>
                  <input type="password" class="form-control" id="loginPassword" required>
                </div>
                <button type="submit" class="btn btn-primary-custom text-white w-100">دخول</button>
              </form>
              <p class="text-center mt-3 mb-0">ليس لديك حساب؟ <a href="#" id="switchToRegister">إنشاء حساب</a></p>
            </div>
          </div>
        </div>
      </div>`);
  }
  if (!document.getElementById('registerModal')) {
    document.body.insertAdjacentHTML('beforeend', `
      <div class="modal fade" id="registerModal" tabindex="-1">
        <div class="modal-dialog modal-dialog-centered modal-lg">
          <div class="modal-content">
            <div class="modal-header">
              <h5 class="modal-title"><i class="fas fa-user-plus me-2"></i>إنشاء حساب جديد</h5>
              <button type="button" class="btn-close btn-close-white" data-bs-dismiss="modal"></button>
            </div>
            <div class="modal-body">
              <form id="registerForm">
                <div class="row">
                  <div class="col-md-6 mb-3">
                    <label class="form-label">الاسم الكامل *</label>
                    <input type="text" class="form-control" id="regName" required>
                  </div>
                  <div class="col-md-6 mb-3">
                    <label class="form-label">البريد الإلكتروني *</label>
                    <input type="email" class="form-control" id="regEmail" required>
                  </div>
                </div>
                <div class="row">
                  <div class="col-md-6 mb-3">
                    <label class="form-label">رقم الهاتف *</label>
                    <input type="tel" class="form-control" id="regPhone" placeholder="01xxxxxxxxx" required>
                  </div>
                  <div class="col-md-6 mb-3">
                    <label class="form-label">كلمة المرور *</label>
                    <div class="input-group">
                      <input type="password" class="form-control" id="regPassword" required minlength="6">
                      <button class="btn btn-outline-secondary" type="button" id="toggleRegPass" title="إظهار/إخفاء"><i class="fas fa-eye"></i></button>
                    </div>
                  </div>
                </div>
                <div class="mb-3">
                  <label class="form-label">تأكيد كلمة المرور *</label>
                  <div class="input-group">
                    <input type="password" class="form-control" id="regPassword2" required>
                    <button class="btn btn-outline-secondary" type="button" id="toggleRegPass2" title="إظهار/إخفاء"><i class="fas fa-eye"></i></button>
                  </div>
                </div>
                <div class="form-check mb-2">
                  <input class="form-check-input" type="checkbox" id="agreePrivacy" required>
                  <label class="form-check-label" for="agreePrivacy">أوافق على <a href="privacy.html" target="_blank">سياسة الخصوصية</a></label>
                </div>
                <div class="form-check mb-3">
                  <input class="form-check-input" type="checkbox" id="agreeTerms" required>
                  <label class="form-check-label" for="agreeTerms">أوافق على <a href="terms.html" target="_blank">الشروط والأحكام</a></label>
                </div>
                <button type="submit" class="btn btn-primary-custom text-white w-100">إنشاء الحساب</button>
              </form>
            </div>
          </div>
        </div>
      </div>`);
  }
  // Re-bind forms if newly injected
  bindAuthForms();
  document.getElementById('switchToRegister')?.addEventListener('click', (e) => {
    e.preventDefault();
    bootstrap.Modal.getInstance(document.getElementById('loginModal'))?.hide();
    new bootstrap.Modal(document.getElementById('registerModal')).show();
  });
}

let authFormsBound = false;
function bindAuthForms() {
  if (authFormsBound) return;
  const loginForm = document.getElementById('loginForm');
  const regForm = document.getElementById('registerForm');
  if (!loginForm || !regForm) return;
  authFormsBound = true;

  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('loginEmail').value.trim();
    const pass = document.getElementById('loginPassword').value;
    showLoading(true);
    try {
      await signInWithEmailAndPassword(auth, email, pass);
      showToast('تم تسجيل الدخول بنجاح');
      bootstrap.Modal.getInstance(document.getElementById('loginModal'))?.hide();
    } catch (err) {
      showToast(err.message.includes('wrong-password') || err.message.includes('user-not-found') || err.message.includes('invalid-credential')
        ? 'بيانات الدخول غير صحيحة' : 'حدث خطأ', 'error');
    } finally {
      showLoading(false);
    }
  });

  regForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('regName').value.trim();
    const email = document.getElementById('regEmail').value.trim();
    const phone = document.getElementById('regPhone')?.value.trim() || '';
    const pass = document.getElementById('regPassword').value;
    const pass2 = document.getElementById('regPassword2').value;
    if (!phone) { showToast('يجب إدخال رقم الهاتف', 'error'); return; }
    if (pass !== pass2) { showToast('كلمتا المرور غير متطابقتين', 'error'); return; }
    if (!document.getElementById('agreePrivacy')?.checked || !document.getElementById('agreeTerms')?.checked) {
      showToast('يجب الموافقة على سياسة الخصوصية والشروط', 'error'); return;
    }
    showLoading(true);
    try {
      const cred = await createUserWithEmailAndPassword(auth, email, pass);
      await updateProfile(cred.user, { displayName: name });
      const emailKey = String(email).toLowerCase().trim();
      let restored = false;
      let baseUser = {
        name, email, emailLower: emailKey, phone,
        createdAt: serverTimestamp(),
        banned: false, deleted: false, role: 'user', bio: '',
        balance: 0, commissionPercent: 5,
        earnings: 0, totalSales: 0
      };
      let oldUserId = null;
      try {
        let legDocs = [];
        try {
          const legacySnap = await getDocs(query(collection(db, 'users'), where('email', '==', email), limit(8)));
          legDocs = legacySnap.docs.filter(d => d.id !== cred.user.uid && !d.data().blockEmailRestore && !d.data().permanentlyDeleted && !d.data().deleted);
        } catch (_) {}
        if (!legDocs.length) {
          try {
            const s2 = await getDocs(query(collection(db, 'users'), where('emailLower', '==', emailKey), limit(8)));
            legDocs = s2.docs.filter(d => d.id !== cred.user.uid && !d.data().blockEmailRestore && !d.data().permanentlyDeleted && !d.data().deleted);
          } catch (_) {}
        }
        if (legDocs.length) {
          let best = legDocs[0].data();
          oldUserId = legDocs[0].id;
          for (const d of legDocs) {
            const u = d.data();
            const bal = parseFloat(u.balance) || 0;
            const bestBal = parseFloat(best.balance) || 0;
            if (bal >= bestBal) { best = u; oldUserId = d.id; }
          }
          baseUser = {
            ...baseUser,
            name: name || best.name || name,
            phone: phone || best.phone || '',
            bio: best.bio || '',
            balance: parseFloat(best.balance) || 0,
            commissionPercent: (best.commissionPercent != null ? best.commissionPercent : 5),
            earnings: parseFloat(best.earnings) || 0,
            totalSales: parseFloat(best.totalSales) || 0,
            role: best.role === 'admin' ? 'user' : (best.role || 'user'),
            restoredFromUserId: oldUserId,
            restoredAt: serverTimestamp(),
            banned: !!best.banned,
            deleted: false
          };
          restored = true;
        }
      } catch (mergeErr) {
        console.warn('email restore', mergeErr);
      }
      await setDoc(doc(db, 'users', cred.user.uid), baseUser, { merge: true });
      if (oldUserId) {
        try {
          const buys = await getDocs(query(collection(db, 'purchases'), where('buyerId', '==', oldUserId), limit(150)));
          for (const d of buys.docs) {
            try { await updateDoc(d.ref, { buyerId: cred.user.uid, buyerEmail: email, legacyBuyerId: oldUserId }); } catch (_) {}
          }
        } catch (_) {}
        try {
          const sells = await getDocs(query(collection(db, 'projects'), where('sellerId', '==', oldUserId), limit(100)));
          for (const d of sells.docs) {
            try { await updateDoc(d.ref, { sellerId: cred.user.uid, sellerEmail: email, legacySellerId: oldUserId }); } catch (_) {}
          }
        } catch (_) {}
        try {
          await updateDoc(doc(db, 'users', oldUserId), {
            migratedTo: cred.user.uid,
            deleted: true,
            migratedAt: serverTimestamp()
          });
        } catch (_) {}
      }
      showToast(restored
        ? 'تم إنشاء الحساب واستعادة رصيدك ومشترياتك المرتبطة بهذا الإيميل'
        : 'تم إنشاء الحساب بنجاح! مرحباً بك');
      bootstrap.Modal.getInstance(document.getElementById('registerModal'))?.hide();
    } catch (err) {
      showToast(err.message.includes('email-already-in-use') ? 'البريد مستخدم مسبقاً' : 'حدث خطأ أثناء التسجيل', 'error');
    } finally {
      showLoading(false);
    }
  });

  const bindPassToggle = (btnId, inputId) => {
    document.getElementById(btnId)?.addEventListener('click', () => {
      const inp = document.getElementById(inputId);
      if (!inp) return;
      const show = inp.type === 'password';
      inp.type = show ? 'text' : 'password';
      const icon = document.querySelector(`#${btnId} i`);
      if (icon) icon.className = show ? 'fas fa-eye-slash' : 'fas fa-eye';
    });
  };
  bindPassToggle('toggleRegPass', 'regPassword');
  bindPassToggle('toggleRegPass2', 'regPassword2');
}

// Call early
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', ensureAuthModals);
} else {
  ensureAuthModals();
}

// ===== Auth State =====
let currentUser = null;
let currentUserData = null;

/** المالك الرئيسي + صلاحيات الإداريين */
const OWNER_ADMIN_EMAIL = 'lamadh41@gmail.com';
function isOwnerEmail(email) {
  return (email || '').toLowerCase().trim() === OWNER_ADMIN_EMAIL;
}
function getAdminRoles(userData, email) {
  if (isOwnerEmail(email)) {
    return { general: true, users: true, products: true, finance: true, tools: true, _owner: true };
  }
  const r = userData?.adminRoles;
  if (!r || typeof r !== 'object') return null;
  const any = r.general || r.users || r.products || r.finance || r.tools;
  if (!any) return null;
  return { general: !!r.general, users: !!r.users, products: !!r.products, finance: !!r.finance, tools: !!r.tools, _owner: false };
}
function hasAnyAdminRole(userData, email) {
  return !!getAdminRoles(userData, email);
}
window.OWNER_ADMIN_EMAIL = OWNER_ADMIN_EMAIL;
window.isOwnerEmail = isOwnerEmail;
window.getAdminRoles = getAdminRoles;
window.hasAnyAdminRole = hasAnyAdminRole;



onAuthStateChanged(auth, async (user) => {
  currentUser = user;
  const authArea = document.getElementById('authArea');
  if (!authArea) return;

  if (user) {
    // Load user data from Firestore
    const userRef = doc(db, 'users', user.uid);
    // كاش مرن: محلي + إعادة تحقق مرة كل جلسة (رصيد/صورة/عمولة…)
    const { data: uData } = await softFetch(cacheUserKey(user.uid), async () => {
      const snap = await getDoc(userRef);
      return snap.exists() ? snap.data() : { name: user.displayName || 'مستخدم', email: user.email };
    }, { sessionFlag: 'soft:user:' + user.uid });
    currentUserData = uData || { name: user.displayName || 'مستخدم', email: user.email };

    // Check if banned
    if (currentUserData.banned) {
      await signOut(auth);
      showToast('تم حظر حسابك من المتجر. تواصل مع الدعم.', 'error');
      return;
    }

    const initials = getInitials(currentUserData.name || user.displayName);
    const myPhoto = currentUserData.photoURL || currentUserData.avatarUrl || user.photoURL || '';
    const avatarHtml = myPhoto
      ? `<div class="user-avatar" style="padding:0;overflow:hidden;background:transparent;"><img src="${myPhoto}" alt="" style="width:100%;height:100%;object-fit:cover;"></div>`
      : `<div class="user-avatar">${initials}</div>`;
    const adminRoles = getAdminRoles(currentUserData, user.email);
    const adminBtnHtml = adminRoles
      ? `<a href="index-admin.html" class="btn btn-dark btn-sm" title="وضع الأدمن"><i class="fas fa-shield-alt me-1"></i><span class="d-none d-md-inline">وضع الأدمن</span></a>`
      : '';
    authArea.innerHTML = `
      ${adminBtnHtml}
      <div class="dropdown" id="notifDropdown">
        <button class="btn btn-outline-secondary btn-sm position-relative" data-bs-toggle="dropdown" data-bs-auto-close="outside" id="notifBtn" title="الإشعارات">
          <i class="fas fa-bell"></i>
          <span class="position-absolute top-0 start-100 translate-middle badge rounded-pill bg-danger d-none" id="notifBadge">0</span>
        </button>
        <div class="dropdown-menu dropdown-menu-end notif-menu p-0" style="min-width:320px;max-height:400px;overflow-y:auto;">
          <div class="p-2 border-bottom bg-light">
            <div class="d-flex justify-content-between align-items-center mb-1">
              <strong><i class="fas fa-bell me-1"></i> الإشعارات</strong>
              <button class="btn btn-sm btn-link text-decoration-none p-0" id="markAllRead">علم الكل كمقروء</button>
            </div>
            <button type="button" class="btn btn-sm btn-outline-danger w-100" id="deleteAllNotifsBtn">
              <i class="fas fa-trash-alt me-1"></i>حذف كل الإشعارات
            </button>
          </div>
          <div id="notifList" class="p-2"><div class="text-center text-muted small py-3">جاري التحميل...</div></div>
        </div>
      </div>
      <div class="dropdown">
        <div class="d-flex align-items-center gap-2" data-bs-toggle="dropdown" style="cursor:pointer;">
          ${avatarHtml}
          <span class="d-none d-md-inline fw-semibold">${currentUserData.name || 'حسابي'}</span>
        </div>
        <ul class="dropdown-menu dropdown-menu-end">
          <li><a class="dropdown-item" href="account.html"><i class="fas fa-user me-2"></i>حسابي</a></li>
          <li><a class="dropdown-item" href="purchases.html"><i class="fas fa-shopping-bag me-2"></i>مشترياتي</a></li>
          <li><a class="dropdown-item" href="my-creations.html"><i class="fas fa-lightbulb me-2"></i>إبداعاتي</a></li>
          <li><a class="dropdown-item" href="earnings.html"><i class="fas fa-coins me-2"></i>أرباحك</a></li>
          <li><a class="dropdown-item" href="balance.html"><i class="fas fa-wallet me-2"></i>رصيدي <strong id="navBalanceBadge" class="text-success">...</strong></a></li>
          <li><hr class="dropdown-divider"></li>
          <li><a class="dropdown-item text-danger" href="#" id="logoutBtn"><i class="fas fa-sign-out-alt me-2"></i>تسجيل الخروج</a></li>
        </ul>
      </div>
    `;

    document.getElementById('logoutBtn')?.addEventListener('click', async (e) => {
      e.preventDefault();
      await signOut(auth);
      showToast('تم تسجيل الخروج بنجاح');
      setTimeout(() => location.href = 'index.html', 800);
    });

    document.getElementById('openUploadBtn')?.addEventListener('click', (e) => {
      e.preventDefault();
      const modal = new bootstrap.Modal(document.getElementById('uploadModal'));
      modal.show();
    });

    // الإشعارات: تحميل خفيف مرة واحدة للشارة فقط — القائمة تتحدث عند فتح القائمة
    loadUserNotifications(user.uid);
    const notifBtn = document.getElementById('notifBtn');
    if (notifBtn && !notifBtn.dataset.bound) {
      notifBtn.dataset.bound = '1';
      notifBtn.addEventListener('show.bs.dropdown', () => {
        // مرة كل جلسة: حدّث الإشعارات من الشبكة ثم كاش
        loadUserNotifications(user.uid, { soft: true });
        markNotificationsRead(user.uid);
      });
    }
    document.getElementById('deleteAllNotifsBtn')?.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!(await siteConfirm('حذف كل الإشعارات نهائيًا؟', 'حذف الإشعارات'))) return;
      await deleteAllNotifications(user.uid);
    });
    document.getElementById('markAllRead')?.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      await markNotificationsRead(user.uid);
    });
    initSupportWidget(user);
    // إظهار قيمة الرصيد جنب القائمة
    const bal = parseFloat(currentUserData?.balance) || 0;
    const balEl = document.getElementById('navBalanceBadge');
    if (balEl) balEl.textContent = `(${bal.toFixed(2)} ج.م)`;
  } else {
    currentUserData = null;
    ensureAuthModals();
    authArea.innerHTML = `
      <button class="btn btn-outline-primary btn-sm" id="openLoginBtn">تسجيل الدخول</button>
      <button class="btn btn-primary-custom btn-sm text-white" id="openRegisterBtn">إنشاء حساب</button>
    `;
    document.getElementById('openLoginBtn')?.addEventListener('click', () => {
      ensureAuthModals();
      new bootstrap.Modal(document.getElementById('loginModal')).show();
    });
    document.getElementById('openRegisterBtn')?.addEventListener('click', () => {
      ensureAuthModals();
      new bootstrap.Modal(document.getElementById('registerModal')).show();
    });
    initSupportWidget(null);
  }
});

// Auth forms handled by bindAuthForms()

function getDriveFileId(link) {
  if (!link) return '';
  const m1 = String(link).match(/\/d\/([a-zA-Z0-9_-]+)/);
  const m2 = String(link).match(/[?&]id=([a-zA-Z0-9_-]+)/);
  return (m1 && m1[1]) || (m2 && m2[1]) || '';
}
/** رابط تنزيل مباشر من درايف (ملف واحد) */
function getDriveDownloadUrl(link) {
  const id = getDriveFileId(link);
  if (!id) return link || '';
  return `https://drive.google.com/uc?export=download&id=${id}`;
}
window.getDriveDownloadUrl = getDriveDownloadUrl;
window.getDriveFileId = getDriveFileId;


// ===== علامة الموقع + نافذة تحميل المحرك (settings/engine — شبكة أصل) =====
async function fetchEngineSettings() {
  try {
    const { data } = await softFetch('settings:engine', async () => {
      const snap = await getDoc(doc(db, 'settings', 'engine'));
      return snap.exists() ? snap.data() : {};
    }, { sessionFlag: 'soft:settings:engine', maxAgeMs: 5 * 60 * 1000 });
    return data || {};
  } catch {
    return cacheGet('settings:engine') || {};
  }
}

function applySiteBranding(data) {
  window.applySiteBranding = applySiteBranding;
  const siteName = (data && (data.siteName || data.engineName || data.name)) || 'محرك مصران';
  const logoUrl = data && data.logoUrl;
  // اسم المتجر للزر: "متجر " + الجزء المتغير من اسم الموقع
  const storeLinkName = 'متجر ' + (siteName.replace(/^محرك\s*/i, '').trim() || siteName);
  document.querySelectorAll('.navbar-brand, .js-site-brand').forEach(el => {
    if (logoUrl) {
      el.innerHTML = `<img src="${logoUrl}" alt="" class="site-logo-img" style="height:32px;width:auto;margin-left:0.4rem;border-radius:6px;vertical-align:middle;">${siteName}`;
    } else {
      el.innerHTML = `<i class="fas fa-ankh me-2"></i>${siteName}`;
    }
  });
  document.querySelectorAll('.js-site-name').forEach(el => { el.textContent = siteName; });
  // تحديث زر المشاريع → متجر [اسم الموقع المتغير]
  document.querySelectorAll('a.nav-link[href="projects.html"], a.js-projects-link').forEach(el => {
    el.textContent = storeLinkName;
    el.classList.add('js-projects-link');
  });
  try {
    const baseTitle = document.title.replace(/\s*\|\s*.*$/, '');
    // حدّث عنوان التبويب
    if (/متجر مصران|محرك مصران/.test(document.title)) {
      document.title = document.title.replace(/متجر مصران|محرك مصران/g, siteName);
    } else if (!document.title.includes(siteName)) {
      document.title = siteName + (document.title ? ' | ' + document.title : '');
    }
  } catch (_) {}
  // فافيكون / أيقونة التبويب من لوجو الموقع
  try {
    if (logoUrl) {
      let link = document.querySelector("link[rel='icon']") || document.querySelector("link[rel='shortcut icon']");
      if (!link) {
        link = document.createElement('link');
        link.rel = 'icon';
        document.head.appendChild(link);
      }
      link.type = 'image/png';
      link.href = logoUrl + (logoUrl.includes('?') ? '&' : '?') + 'v=' + Date.now();
      // apple touch
      let apple = document.querySelector("link[rel='apple-touch-icon']");
      if (!apple) {
        apple = document.createElement('link');
        apple.rel = 'apple-touch-icon';
        document.head.appendChild(apple);
      }
      apple.href = link.href;
    }
  } catch (_) {}
}

function ensureEngineDownloadModal() {
  if (document.getElementById('engineDownloadModal')) return;
  document.body.insertAdjacentHTML('beforeend', `
    <div class="modal fade" id="engineDownloadModal" tabindex="-1">
      <div class="modal-dialog modal-lg modal-dialog-scrollable">
        <div class="modal-content">
          <div class="modal-header">
            <h5 class="modal-title"><i class="fas fa-download me-2"></i>تحميل المحرك</h5>
            <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
          </div>
          <div class="modal-body" id="engineDownloadBody">
            <div class="text-center text-muted py-4">جاري التحميل...</div>
          </div>
        </div>
      </div>
    </div>`);
}

async function openEngineDownloadModal() {
  ensureEngineDownloadModal();
  const body = document.getElementById('engineDownloadBody');
  body.innerHTML = '<div class="text-center text-muted py-4">جاري التحميل...</div>';
  new bootstrap.Modal(document.getElementById('engineDownloadModal')).show();
  const data = await fetchEngineSettings();
  const name = data.engineName || data.name || 'محرك مصران';
  const ver = data.version || '—';
  const desc = data.description || 'لا يوجد وصف بعد.';
  const imgs = data.images || [];
  let dl = data.downloadUrl || '';
  if (dl && typeof getDriveDownloadUrl === 'function') dl = getDriveDownloadUrl(dl);
  else if (data.fileId) dl = `https://drive.google.com/uc?export=download&id=${data.fileId}`;

  const imgsHtml = imgs.length
    ? `<div class="d-flex flex-wrap gap-2 mb-3">${imgs.map(im => {
        const u = typeof im === 'string' ? im : (im.url || '');
        return u ? `<img src="${u}" alt="" style="max-width:160px;max-height:110px;object-fit:cover;border-radius:10px;border:1px solid rgba(201,162,39,0.3);">` : '';
      }).join('')}</div>`
    : '';

  body.innerHTML = `
    ${imgsHtml}
    <div class="d-flex flex-wrap align-items-center justify-content-between gap-2 mb-3">
      <div>
        <h4 class="mb-1 fw-bold">${name}</h4>
        <span class="badge bg-warning text-dark">أحدث إصدار: ${ver}</span>
      </div>
      ${dl
        ? `<a class="btn btn-primary-custom text-dark fw-bold" href="${dl}" download target="_blank" rel="noopener">
             <i class="fas fa-download me-1"></i>تحميل <span class="small">(أحدث إصدار)</span>
           </a>`
        : `<button type="button" class="btn btn-secondary" disabled>التحميل غير متاح بعد</button>`}
    </div>
    <p class="mb-3" style="white-space:pre-wrap;">${desc}</p>
    <div class="alert alert-info mb-0 small">
      <i class="fas fa-shield-alt me-1"></i>
      متخافش: لما تحمّل المحرك وتفتح نافذة المشاريع هتلاقي مشاريعك زي ما هي موجودة.
    </div>`;
}

async function initEngineUi() {
  try {
    const data = await fetchEngineSettings();
    applySiteBranding(data);
  } catch (_) {
    applySiteBranding({ siteName: 'محرك مصران' });
  }
  // زر الشريط
  document.querySelectorAll('.nav-engine-download').forEach(btn => {
    btn.addEventListener('click', (e) => {
      // صفحة عادية
      if (btn.getAttribute('href') && btn.getAttribute('href') !== '#') return;
      e.preventDefault();
      window.location.href = 'engine.html';
    });
    if (!btn.getAttribute('href') || btn.getAttribute('href') === '#') {
      btn.setAttribute('href', 'engine.html');
    }
  });
}

// استدعِ بعد تحميل الصفحة
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { try { initEngineUi(); } catch(_){} });
  } else {
    try { initEngineUi(); } catch(_){}
  }
}



function getDriveImageUrl(link) {
  if (!link) return '';
  let id = '';
  const match1 = link.match(/\/d\/([a-zA-Z0-9_-]+)/);
  const match2 = link.match(/id=([a-zA-Z0-9_-]+)/);
  if (match1) id = match1[1];
  else if (match2) id = match2[1];
  // thumbnail API أكثر استقراراً للعرض
  if (id) return `https://drive.google.com/thumbnail?id=${id}&sz=w1000`;
  return link;
}

function collectProjectFormData() {
  if (!currentUser) {
    showToast('يجب تسجيل الدخول أولاً', 'error');
    return null;
  }
  const title = document.getElementById('projTitle')?.value.trim() || '';
  const desc = document.getElementById('projDesc')?.value.trim() || '';
  const pricing = document.querySelector('input[name="projPricing"]:checked')?.value || 'free';
  let price = normalizePriceInput(document.getElementById('projPrice'));
  if (pricing === 'free') price = 0;
  let payMethod = document.getElementById('projPayMethod')?.value || '';
  let payNumber = document.getElementById('projPayNumber')?.value.trim() || '';
  let payName = document.getElementById('projPayName')?.value.trim() || '';
  const thumbLink = document.getElementById('projThumbLink')?.value.trim() || '';
  const filesLink = document.getElementById('projFilesLink')?.value.trim() || '';

  if (!title || !desc) {
    showToast('أدخل اسم المشروع والوصف', 'error');
    return null;
  }
  if (!moderateText(title, 'عنوان المشروع') || !moderateText(desc, 'الوصف')) return null;
  const thumbFile = window._croppedThumbFile || document.getElementById('projThumbFile')?.files?.[0];
  const filesFile = document.getElementById('projFilesFile')?.files?.[0];
  if (!thumbFile || !filesFile) {
    showToast('ارفع الصورة المصغرة وملف المشروع', 'error');
    return null;
  }
  if (pricing === 'paid' && price <= 0) {
    showToast('أدخل سعر أكبر من صفر للمنتج المدفوع', 'error');
    return null;
  }
  if (price > 0 && (!payMethod || !payNumber || !payName)) {
    showToast('أدخل بيانات المحفظة للمنتج المدفوع', 'error');
    return null;
  }
  if (price <= 0) {
    payMethod = ''; payNumber = ''; payName = '';
  }
  // فلاتر: مطلوب واحد على الأقل، حتى 20
  const cats = Array.from(document.querySelectorAll('input[name="projCategory"]:checked')).map(el => el.value).filter(Boolean);
  if (!cats.length) {
    showToast('اختر فلترًا واحدًا على الأقل للمشروع', 'error');
    return null;
  }
  if (cats.length > 20) {
    showToast('الحد الأقصى 20 فلتر', 'error');
    return null;
  }
  // نظام العرض — المدة تُخزَّن؛ الساعة تبدأ عند قبول الأدمن
  let originalPrice = null;
  let saleDurationValue = null;
  let saleDurationUnit = null;
  let salePending = false;
  const saleEnabled = document.getElementById('projSaleEnabled')?.checked;
  if (saleEnabled && (price > 0 || document.getElementById('projSaleOfferPrice'))) {
    // سعر العرض من الحقل المخصص إن وُجد، وإلا من سعر المنتج
    const offerEl = document.getElementById('projSaleOfferPrice');
    if (offerEl && offerEl.value !== '') {
      price = parseFloat(offerEl.value) || 0;
      const mainPrice = document.getElementById('projPrice');
      if (mainPrice) mainPrice.value = price;
    }
    const orig = parseFloat(document.getElementById('projOriginalPrice')?.value) || 0;
    const durVal = parseFloat(document.getElementById('projSaleDuration')?.value) || 0;
    const durUnit = document.getElementById('projSaleUnit')?.value || 'days';
    if (!(price > 0)) {
      showToast('أدخل سعر العرض', 'error');
      return null;
    }
    if (!(orig > price)) {
      showToast('السعر بعد انتهاء العرض يجب أن يكون أكبر من سعر العرض', 'error');
      return null;
    }
    if (!(durVal > 0)) {
      showToast('حدد مدة العرض', 'error');
      return null;
    }
    originalPrice = orig;
    saleDurationValue = durVal;
    saleDurationUnit = durUnit;
    salePending = true;
  }
  return {
    title, description: desc, price, isFree: price === 0,
    categories: cats,
    originalPrice: originalPrice,
    saleEndsAt: null,
    saleDurationValue,
    saleDurationUnit,
    salePending,
    thumbnail: thumbLink,
    thumbnailDirect: getDriveImageUrl(thumbLink),
    filesLink, files: [],
    sellerId: currentUser.uid,
    sellerName: currentUserData?.name || currentUser.displayName || '',
    sellerPhoto: currentUserData?.photoURL || currentUserData?.avatarUrl || currentUser?.photoURL || '',
    paymentMethod: payMethod, paymentNumber: payNumber, paymentName: payName,
    commission: 5, isOfficial: false, downloads: 0, sales: 0
  };
}

let isPublishing = false;
async function saveProjectWithStatus(status, successMsg) {
  if (isPublishing) return;
  const data = collectProjectFormData();
  if (!data) return;
  if (data.salePending) {
    const okSale = await siteConfirm(
      'تنبيه العرض:\n• مدة العرض تبدأ من لحظة قبول الإدارة للمشروع.\n• بعد أي تعديل على العرض لن يُسمح بتعديل العرض مرة أخرى على نفس المنتج إلا بعد 24 ساعة. تعديل السعر العادي متاح دائماً.\nهل توافق وتكمل؟',
      'تأكيد العرض'
    );
    if (!okSale) return;
  }
  if (status === 'pending_review') {
    const ok = await siteConfirm('هل أنت متأكد من إرسال المشروع للمراجعة؟\nلن تتمكن من التعديل بعد الإرسال، ويمكنك الحذف فقط أو إلغاء طلب المراجعة.', 'إرسال للمراجعة');
    if (!ok) return;
  }
  isPublishing = true;
  showLoading(true, 'جاري رفع ملف المشروع...', 0);
  try {
    const thumbFile0 = window._croppedThumbFile || document.getElementById('projThumbFile')?.files?.[0] || null;
    const filesFile = document.getElementById('projFilesFile')?.files?.[0];
    const extraImgs = (window._extraImageFiles && window._extraImageFiles.length)
      ? window._extraImageFiles.slice(0, 12)
      : Array.from(document.getElementById('projExtraImages')?.files || []).slice(0, 12);
    const setProg = (pct, txt) => showLoading(true, txt || 'جاري رفع ملف المشروع...', pct);
    try {
      if (!thumbFile0 || !filesFile) throw new Error('الصورة المصغرة وملف المشروع مطلوبان');
      const projectName = data.title || 'project';
      setProg(5, 'جاري تجهيز الصورة...');
      const thumbFile = await compressImageFile(thumbFile0, 800, 0.6);
      setProg(15, 'جاري رفع الصورة المصغرة...');
      const upThumb = await uploadToDriveScript(thumbFile, (p) => setProg(15 + p * 0.25, 'رفع المصغرة...'), { projectName, folderKind: 'images', userName: currentUserData?.name || currentUser?.displayName || '', userId: currentUser?.uid || '' });
      data.thumbnail = upThumb.url;
      data.thumbnailDirect = upThumb.thumbUrl || upThumb.url;
      if (upThumb.fileId) data.thumbnailFileId = upThumb.fileId;
      data.images = [upThumb.url];
      data.driveFolderUrl = upThumb.projectFolderUrl || '';

      // صور إضافية بالتوازي قدر الإمكان
      if (extraImgs.length) {
        setProg(45, 'جاري رفع الصور الإضافية...');
        const compressed = await Promise.all(extraImgs.map(f => compressImageFile(f, 900, 0.62)));
        const userMeta = { projectName, folderKind: 'images', userName: currentUserData?.name || currentUser?.displayName || '', userId: currentUser?.uid || '' };
        const ups = await Promise.all(compressed.map(f => uploadToDriveScript(f, null, userMeta)));
        data.images = data.images.concat(ups.map(u => u.url));
      }

      setProg(70, 'جاري رفع ملف المشروع...');
      const upFiles = await uploadToDriveScript(filesFile, (p) => setProg(70 + p * 0.25, 'رفع الملفات...'), { projectName, folderKind: 'files', userName: currentUserData?.name || currentUser?.displayName || '', userId: currentUser?.uid || '' });
      data.filesLink = upFiles.url;
      setProg(95, 'جاري حفظ البيانات...');
    } catch (upErr) {
      showToast('فشل الرفع: ' + (upErr.message || upErr), 'error');
      isPublishing = false;
      showLoading(false);
      return;
    }
    if (!data.thumbnail || !data.filesLink) {
      showToast('الصورة وملفات المشروع مطلوبان', 'error');
      isPublishing = false;
      showLoading(false);
      return;
    }
    await addDoc(collection(db, 'projects'), {
      ...data,
      status,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
    // أبطل كاش قائمة المشاريع عشان الزيارة الجاية تجيب الجديد (قراءة واحدة)
    try { networkInvalidate('projects:', 'product:'); } catch(_){}
    try { window.localCache?.invalidate?.('projects:', 'product:'); } catch(_){}
    showToast(successMsg);
    bootstrap.Modal.getInstance(document.getElementById('uploadModal'))?.hide();
    document.getElementById('uploadForm')?.reset();
    window._extraImageFiles = [];
    window._croppedThumbFile = null;
    if (typeof renderExtraPreview === 'function') renderExtraPreview();
    const tp = document.getElementById('thumbPreview'); if (tp) tp.innerHTML = '';
    const fp = document.getElementById('filesPreview'); if (fp) fp.innerHTML = '';
    const pf = document.getElementById('paymentFields');
    if (pf) pf.style.display = 'none';
  } catch (err) {
    console.error(err);
    showToast('حدث خطأ: ' + err.message, 'error');
  } finally {
    isPublishing = false;
    showLoading(false);
  }
}

// منع الـ submit التقليدي
document.getElementById('uploadForm')?.addEventListener('submit', (e) => e.preventDefault());

document.addEventListener('click', (e) => {
  if (e.target.closest('#saveDraftBtn')) {
    e.preventDefault();
    saveProjectWithStatus('draft', 'تم حفظ المشروع في إبداعاتك (لم يُرسل للمراجعة)');
  }
  if (e.target.closest('#submitReviewBtn')) {
    e.preventDefault();
    saveProjectWithStatus('pending_review', 'تم إرسال المشروع للمراجعة. سيتم قبوله في أقرب وقت إن شاء الله');
  }
});

// ===== Notifications =====
async function loadUserNotifications(uid, opts = {}) {
  const listEl = document.getElementById('notifList');
  const badge = document.getElementById('notifBadge');
  if (!listEl) return;
  try {
    const nKey = cacheNotifsKey(uid);
    const soft = opts.soft !== false; // افتراضي: مرونة جلسة
    const { data: plain } = await softFetch(nKey, async () => {
      const snap = await getDocs(query(collection(db, 'notifications'), where('userId', '==', uid), limit(40)));
      return snap.docs
        .map(d => ({ id: d.id, data: d.data() }))
        .sort((a, b) => (b.data.createdAt?.toMillis?.() || b.data.createdAt?.__ts || 0) - (a.data.createdAt?.toMillis?.() || a.data.createdAt?.__ts || 0))
        .slice(0, 30);
    }, { sessionFlag: 'soft:notifs:' + uid, force: !!opts.force });
    let notifs = (Array.isArray(plain) ? plain : []).map(x => ({ id: x.id, data: () => x.data }));
    notifs = notifs
      .sort((a, b) => (b.data().createdAt?.toMillis?.() || b.data().createdAt?.__ts || 0) - (a.data().createdAt?.toMillis?.() || a.data().createdAt?.__ts || 0))
      .slice(0, 30);

    const unread = notifs.filter(d => !d.data().read).length;
    if (badge) {
      if (unread > 0) {
        badge.textContent = unread > 9 ? '9+' : unread;
        badge.classList.remove('d-none');
      } else {
        badge.classList.add('d-none');
      }
    }

    if (notifs.length === 0) {
      listEl.innerHTML = '<div class="text-center text-muted small py-3">لا توجد إشعارات</div>';
      return;
    }

    listEl.innerHTML = notifs.map(d => {
      const n = d.data();
      const time = n.createdAt?.toDate?.().toLocaleString('ar-EG') || '';
      return `<div class="notif-item border-bottom py-2 px-1 ${n.read ? '' : 'bg-warning bg-opacity-10'}" data-id="${d.id}">
        <div class="d-flex justify-content-between align-items-start gap-2">
          <strong class="small">${n.title || 'إشعار'}</strong>
          <span class="text-muted text-nowrap" style="font-size:0.7rem;">${time}</span>
        </div>
        <div class="small text-muted">${n.body || ''}</div>
        <div class="d-flex align-items-center gap-1 mt-1" style="font-size:0.65rem;">
          <span class="text-muted">ID: ${d.id}</span>
          <button type="button" class="btn btn-link btn-sm p-0 copy-id-btn" data-id="${d.id}" title="نسخ ID" style="font-size:0.7rem;line-height:1;">
            <i class="fas fa-copy"></i>
          </button>
        </div>
      </div>`;
    }).join('');

    // منع إغلاق القائمة عند النقر داخل الإشعارات
    listEl.querySelectorAll('.notif-item, .copy-id-btn').forEach(el => {
      el.addEventListener('click', (e) => e.stopPropagation());
    });
    listEl.querySelectorAll('.copy-id-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        try {
          await navigator.clipboard.writeText(btn.dataset.id);
          showToast('تم نسخ الـ ID');
        } catch {
          showToast('تعذر النسخ', 'error');
        }
      });
    });
  } catch (err) {
    console.error(err);
    listEl.innerHTML = '<div class="text-danger small p-2">تعذر تحميل الإشعارات</div>';
  }
}

async function markNotificationsRead(uid) {
  try {
    const nKey = cacheNotifsKey(uid);
    let plain = cacheGet(nKey);
    if (!Array.isArray(plain)) {
      // أول مرة فقط نقرأ من الشبكة
      const snap = await getDocs(query(collection(db, 'notifications'), where('userId', '==', uid), limit(30)));
      plain = snap.docs.map(d => ({ id: d.id, data: d.data() }));
    }
    const unread = plain.filter(x => x.data && !x.data.read);
    if (unread.length) {
      await Promise.all(unread.map(x => updateDoc(doc(db, 'notifications', x.id), { read: true })));
      plain = plain.map(x => ({ ...x, data: { ...x.data, read: true } }));
      cacheSet(nKey, plain);
    }
    const badge = document.getElementById('notifBadge');
    if (badge) badge.classList.add('d-none');
    document.querySelectorAll('#notifList .notif-item').forEach(el => {
      el.classList.remove('bg-warning', 'bg-opacity-10');
    });
  } catch (e) { console.error(e); }
}

async function deleteAllNotifications(uid) {
  try {
    showLoading(true, 'جاري حذف الإشعارات...');
    const nKey = cacheNotifsKey(uid);
    let plain = cacheGet(nKey);
    if (!Array.isArray(plain) || !plain.length) {
      const snap = await getDocs(query(collection(db, 'notifications'), where('userId', '==', uid), limit(100)));
      plain = snap.docs.map(d => ({ id: d.id, data: d.data() }));
    }
    if (!plain.length) {
      showToast('لا توجد إشعارات');
      return;
    }
    // حذف على دفعات
    const ids = plain.map(x => x.id).filter(Boolean);
    for (let i = 0; i < ids.length; i += 20) {
      const chunk = ids.slice(i, i + 20);
      await Promise.all(chunk.map(id => deleteDoc(doc(db, 'notifications', id))));
    }
    cacheSet(nKey, []);
    try { sessionStorage.removeItem('soft:notifs:' + uid); } catch {}
    const listEl = document.getElementById('notifList');
    if (listEl) listEl.innerHTML = '<div class="text-center text-muted small py-3">لا توجد إشعارات</div>';
    document.getElementById('notifBadge')?.classList.add('d-none');
    showToast('تم حذف كل الإشعارات');
  } catch (e) {
    console.error(e);
    showToast('تعذر الحذف: ' + (e.message || e), 'error');
  } finally {
    showLoading(false);
  }
}


// ===== Floating Support Widget =====
let supportOpen = false;
let supportUnsub = null;

function initSupportWidget(user) {
  stopSupportListener();
  stopSupportBadgeWatcher();
  supportOpen = false;

  // إزالة أي واجهة دعم قديمة كبيرة
  document.querySelectorAll('.support-toggle-btn:not(.support-fab-circle)').forEach(() => {});

  // دائماً: زر دائري فقط + لوحة شات (مش نافذة عريضة قديمة)
  let fab = document.getElementById('supportFab');
  if (fab) {
    const btn = document.getElementById('supportToggleBtn');
    if (!btn || !btn.classList.contains('support-fab-circle') || fab.querySelector('.support-toggle-btn:not(.support-fab-circle)')) {
      fab.remove();
      fab = null;
    }
  }
  if (!fab) {
    document.body.insertAdjacentHTML('beforeend', `
      <div id="supportFab" class="support-fab">
        <div id="supportPanel" class="support-panel">
          <div class="support-panel-header">
            <span><i class="fas fa-headset me-1"></i> الدعم</span>
            <button type="button" id="supportCloseBtn" class="btn btn-sm btn-light py-0 px-2" aria-label="إغلاق">&times;</button>
          </div>
          <div id="supportChatBox" class="support-chat-box">
            <div class="text-center text-muted small py-3">اضغط لفتح المحادثة</div>
          </div>
          <div class="support-input-row" id="supportInputRow" style="display:none">
            <input type="text" id="supportInput" class="form-control form-control-sm" placeholder="اكتب رسالتك...">
            <button class="btn btn-sm btn-primary" id="supportSendBtn"><i class="fas fa-paper-plane"></i></button>
          </div>
        </div>
        <div id="supportCallPanel" class="support-panel support-call-panel">
          <div class="support-panel-header">
            <span><i class="fas fa-phone-alt me-1"></i> الاتصال</span>
            <button type="button" id="supportCallCloseBtn" class="btn btn-sm btn-light py-0 px-2" aria-label="إغلاق">&times;</button>
          </div>
          <div class="p-3 text-center">
            <p class="small text-muted mb-2" id="supportCallHint">لو مستعجل وعايز تواصل أسرع اتصل على هذا الرقم</p>
            <div class="fs-4 fw-bold mb-3" id="supportCallPhone">—</div>
            <a href="#" class="btn btn-success btn-sm" id="supportCallTelBtn"><i class="fas fa-phone me-1"></i>اتصال الآن</a>
          </div>
        </div>
        <div class="d-flex flex-column gap-2 align-items-center">
          <button type="button" id="supportToggleBtn" class="support-fab-circle" title="الدعم">
            <i class="fas fa-headset"></i>
            <span id="supportBadge" class="support-badge-dot d-none"></span>
          </button>
          <span class="support-fab-label small">الدعم</span>
          <button type="button" id="supportCallToggleBtn" class="support-fab-circle support-fab-call" title="الاتصال">
            <i class="fas fa-phone-alt"></i>
          </button>
          <span class="support-fab-label small">الاتصال</span>
        </div>
      </div>
    `);
    fab = document.getElementById('supportFab');
  }

  // شارة الدعم في الشريط العلوي
  document.querySelectorAll('a.nav-link[href="support.html"], a.nav-link[href*="support"]').forEach(a => {
    if (a.dataset.supportNavReady) return;
    a.dataset.supportNavReady = '1';
    if (!a.querySelector('.fa-headset')) {
      a.insertAdjacentHTML('afterbegin', '<i class="fas fa-headset me-1"></i>');
    }
    if (!a.querySelector('#navSupportBadge') && !a.querySelector('.nav-support-badge')) {
      a.insertAdjacentHTML('beforeend', ' <span class="nav-support-badge support-badge-dot d-none" id="navSupportBadge"></span>');
    }
    a.addEventListener('click', (e) => {
      // لو الصفحة الحالية فيها ويدجت — افتح اللوحة بدل التنقل إن أمكن
      if (document.getElementById('supportPanel') && !a.getAttribute('href')?.includes('support.html')) {
        e.preventDefault();
      }
    });
  });

  const panel = document.getElementById('supportPanel');
  const toggleBtn = document.getElementById('supportToggleBtn');
  const closeBtn = document.getElementById('supportCloseBtn');
  const inputRow = document.getElementById('supportInputRow');
  const box = document.getElementById('supportChatBox');

  panel?.classList.remove('open');
  if (inputRow) inputRow.style.display = user ? '' : 'none';
  if (box) {
    box.innerHTML = `<div class="text-center text-muted small py-3">${user ? 'اضغط لفتح المحادثة' : 'سجّل دخول للتواصل مع الدعم'}</div>`;
  }

  const clearSupportBadges = () => {
    document.getElementById('supportBadge')?.classList.add('d-none');
    document.getElementById('navSupportBadge')?.classList.add('d-none');
    document.querySelectorAll('.nav-support-badge').forEach(el => el.classList.add('d-none'));
  };
  const showSupportBadges = () => {
    document.getElementById('supportBadge')?.classList.remove('d-none');
    document.getElementById('navSupportBadge')?.classList.remove('d-none');
    document.querySelectorAll('.nav-support-badge').forEach(el => el.classList.remove('d-none'));
  };
  window._showSupportBadges = showSupportBadges;
  window._clearSupportBadges = clearSupportBadges;

  const openPanel = () => {
    if (!user) {
      showToast('سجّل دخول أولاً للتواصل مع الدعم', 'error');
      return;
    }
    supportOpen = true;
    panel.classList.add('open');
    startSupportListener(user);
    markSupportRead(user.uid);
    clearSupportBadges();
  };
  const closePanel = () => {
    supportOpen = false;
    panel.classList.remove('open');
    stopSupportListener(); // إيقاف onSnapshot فوراً — صفر قراءات بعد الإغلاق
    if (user) checkSupportBadgeOnce(user);
  };

  if (toggleBtn) toggleBtn.onclick = () => {
    document.getElementById('supportCallPanel')?.classList.remove('open');
    if (supportOpen) closePanel(); else openPanel();
  };
  if (closeBtn) closeBtn.onclick = closePanel;

  const callPanel = document.getElementById('supportCallPanel');
  const callToggle = document.getElementById('supportCallToggleBtn');
  const callClose = document.getElementById('supportCallCloseBtn');
  async function openCallPanel() {
    closePanel();
    if (!callPanel) return;
    callPanel.classList.add('open');
    try {
      const { data } = await softFetch('settings:siteMessages', async () => {
        const snap = await getDoc(doc(db, 'settings', 'siteMessages'));
        return snap.exists() ? snap.data() : {};
      }, { sessionFlag: 'soft:siteMessages', maxAgeMs: 5 * 60 * 1000 });
      const phone = (data?.supportPhone || data?.devPhone || '').trim();
      const hint = data?.supportPhoneHint || 'لو مستعجل وعايز تواصل أسرع اتصل على هذا الرقم';
      const hintEl = document.getElementById('supportCallHint');
      const phoneEl = document.getElementById('supportCallPhone');
      const telBtn = document.getElementById('supportCallTelBtn');
      if (hintEl) hintEl.textContent = hint;
      if (phoneEl) phoneEl.textContent = phone || 'غير متوفر حالياً';
      if (telBtn) {
        if (phone) { telBtn.href = 'tel:' + phone.replace(/\s/g, ''); telBtn.classList.remove('disabled'); }
        else { telBtn.href = '#'; telBtn.classList.add('disabled'); }
      }
    } catch (_) {}
  }
  if (callToggle) callToggle.onclick = () => {
    if (callPanel?.classList.contains('open')) callPanel.classList.remove('open');
    else openCallPanel();
  };
  if (callClose) callClose.onclick = () => callPanel?.classList.remove('open');

  document.getElementById('supportSendBtn')?.addEventListener('click', () => sendSupportMsg(user));
  document.getElementById('supportInput')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendSupportMsg(user);
  });

  // استماع خفيف للشارات فقط (بدون فتح اللوحة) — عند تسجيل الدخول
  if (user) {
    startSupportBadgeWatcher(user);
  }
}

let supportBadgeUnsub = null;
let _supportBadgeTimer = null;
let _supportBadgeUser = null;

/** شارة الدعم: قراءة واحدة فقط — بدون onSnapshot دائم (يقلل الاتصالات النشطة) */
async function checkSupportBadgeOnce(user) {
  if (!user || supportOpen) return;
  try {
    const { data } = await softFetch('supportBadge:' + user.uid, async () => {
      const snap = await getDocs(query(
        collection(db, 'supportChats'),
        where('userId', '==', user.uid),
        limit(20)
      ));
      return snap.docs.some(d => d.data().sender === 'admin' && !d.data().read);
    }, { sessionFlag: 'soft:supportBadge:' + user.uid, maxAgeMs: 3 * 60 * 1000 });
    if (data) window._showSupportBadges?.();
    else window._clearSupportBadges?.();
  } catch (_) {}
}

function stopSupportBadgeWatcher() {
  if (supportBadgeUnsub) { try { supportBadgeUnsub(); } catch(_){} supportBadgeUnsub = null; }
  if (_supportBadgeTimer) { clearInterval(_supportBadgeTimer); _supportBadgeTimer = null; }
  _supportBadgeUser = null;
}

function startSupportBadgeWatcher(user) {
  stopSupportBadgeWatcher();
  if (!user) return;
  _supportBadgeUser = user;
  // قراءة واحدة عند الدخول — مش مستمع حي
  checkSupportBadgeOnce(user);
  // فحص نادر جداً فقط والصفحة ظاهرة (كل 8 دقائق) — صفر onSnapshot
  _supportBadgeTimer = setInterval(() => {
    if (document.hidden || supportOpen || !_supportBadgeUser) return;
    // امسح كاش الجلسة عشان يعيد التحقق من الشبكة مرة كل فترة
    try { sessionStorage.removeItem('soft:supportBadge:' + _supportBadgeUser.uid); } catch(_){}
    checkSupportBadgeOnce(_supportBadgeUser);
  }, 8 * 60 * 1000);
}

function renderSupportSnap(snap) {
  const box = document.getElementById('supportChatBox');
  if (!box) return;
  const docs = snap.docs.slice().sort((a, b) => {
    const t1 = a.data().createdAt?.toMillis?.() || 0;
    const t2 = b.data().createdAt?.toMillis?.() || 0;
    return t1 - t2;
  });
  if (!docs.length) {
    box.innerHTML = '<div class="text-center text-muted small py-3">لا رسائل بعد — اكتب رسالتك</div>';
    return;
  }
  box.innerHTML = docs.map(d => {
    const m = d.data();
    const mine = m.sender === 'user';
    const time = m.createdAt?.toDate?.().toLocaleString?.('ar-EG') || '';
    return `<div class="chat-message ${mine ? 'me' : ''}"><div class="chat-bubble">${m.text || ''}</div><small class="text-muted" style="font-size:0.7rem;">${time}</small></div>`;
  }).join('');
  box.scrollTop = box.scrollHeight;
  if (supportOpen) window._clearSupportBadges?.();
}

function startSupportListener(user) {
  stopSupportListener();
  const box = document.getElementById('supportChatBox');
  if (!box || !user) return;
  const cKey = cacheChatsKey(user.uid);
  const cached = cacheGet(cKey);
  if (Array.isArray(cached) && cached.length) {
    renderSupportSnap({ docs: cached.map(x => ({ id: x.id, data: () => x.data })) });
  } else {
    box.innerHTML = '<div class="text-center text-muted small py-2">جاري التحميل...</div>';
  }
  try {
    const q = query(collection(db, 'supportChats'), where('userId', '==', user.uid), limit(50));
    window._supportChatUnsub = onSnapshot(q, (snap) => {
      if (!supportOpen) return;
      cacheSet(cKey, snap.docs.map(d => ({ id: d.id, data: d.data() })));
      renderSupportSnap(snap);
      markSupportRead(user.uid);
    }, (err) => {
      box.innerHTML = `<div class="text-danger small">${err.message}</div>`;
    });
  } catch (e) {
    getDocs(query(collection(db, 'supportChats'), where('userId', '==', user.uid), limit(50))).then(snap => {
      renderSupportSnap(snap);
    }).catch(err => { box.innerHTML = `<div class="text-danger small">${err.message}</div>`; });
  }
}

function stopSupportListener() {
  if (window._supportChatUnsub) {
    try { window._supportChatUnsub(); } catch (_) {}
    window._supportChatUnsub = null;
  }
  if (supportUnsub) {
    try { supportUnsub(); } catch (_) {}
    supportUnsub = null;
  }
}

// إيقاف كل مستمعات الدعم عند إخفاء التبويب أو مغادرة الصفحة
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    if (supportOpen) {
      // الشات مفتوح لكن التبويب مخفي → أوقف المستمع الحي فوراً
      stopSupportListener();
    }
  } else if (supportOpen && currentUser) {
    // رجع التبويب والشات لسه مفتوح → أعد المستمع
    startSupportListener(currentUser);
  }
});
window.addEventListener('pagehide', () => {
  stopSupportListener();
  stopSupportBadgeWatcher();
});


async function sendSupportMsg(user) {
  const input = document.getElementById('supportInput');
  const text = input?.value.trim();
  if (!text || !user) return;
  input.value = '';
  try {
    await addDoc(collection(db, 'supportChats'), {
      userId: user.uid,
      userEmail: user.email,
      sender: 'user',
      text,
      read: false,
      createdAt: serverTimestamp()
    });
  } catch (e) { showToast(e.message, 'error'); }
}

async function markSupportRead(uid) {
  try {
    const snap = await getDocs(query(collection(db, 'supportChats'), where('userId', '==', uid), limit(40)));
    const unread = snap.docs.filter(d => d.data().sender === 'admin' && !d.data().read);
    if (unread.length) {
      await Promise.all(unread.map(d => updateDoc(doc(db, 'supportChats', d.id), { read: true })));
    }
    window._clearSupportBadges?.();
    document.getElementById('supportBadge')?.classList.add('d-none');
    document.getElementById('navSupportBadge')?.classList.add('d-none');
  } catch (e) {}
}

// ===== News Bar (dismiss محلي — يظهر تاني لو الخبر اتغيّر) =====
async function loadNewsBar() {
  try {
    // مرونة: كاش محلي + إعادة تحقق مرة كل جلسة (لو الخبر اتغيّر يتحدّث)
    const { data } = await softFetch(cacheNewsKey(), async () => {
      const snap = await getDoc(doc(db, 'settings', 'news'));
      if (!snap.exists()) return { active: false, text: '', updatedAt: null };
      const d = snap.data();
      return {
        active: !!d.active,
        text: d.text || '',
        updatedAt: d.updatedAt?.toMillis?.() || d.updatedAt || null
      };
    }, { sessionFlag: 'soft:news' });
    if (!data) return;
    if (!data.active || !data.text) {
      document.getElementById('newsBar')?.remove();
      document.getElementById('newsShowBtn')?.remove();
      return;
    }
    const newsKey = String(data.text || '').trim();
    const dismissed = localStorage.getItem('newsDismissedText') === newsKey;

    document.getElementById('newsBar')?.remove();
    document.getElementById('newsShowBtn')?.remove();

    if (dismissed) {
      const btn = document.createElement('button');
      btn.id = 'newsShowBtn';
      btn.type = 'button';
      btn.className = 'news-show-btn';
      btn.innerHTML = '<i class="fas fa-bullhorn me-1"></i>إظهار الخبر';
      btn.onclick = () => {
        localStorage.removeItem('newsDismissedText');
        loadNewsBar();
      };
      document.body.appendChild(btn);
      return;
    }

    const bar = document.createElement('div');
    bar.id = 'newsBar';
    bar.className = 'news-bar';
    bar.innerHTML = `<div class="news-bar-inner d-flex align-items-center justify-content-center gap-2 flex-wrap">
      <span><i class="fas fa-bullhorn me-2"></i>${(typeof linkifyText==='function'?linkifyText(data.text):data.text)}</span>
      <button type="button" class="btn btn-sm btn-dark py-0 px-2" id="newsDismissBtn" title="إخفاء">×</button>
    </div>`;
    document.body.prepend(bar);
    document.getElementById('newsDismissBtn')?.addEventListener('click', () => {
      localStorage.setItem('newsDismissedText', newsKey);
      loadNewsBar();
    });
  } catch (e) { console.error(e); }
}
loadNewsBar();


// ===== رفع ملف على درايف الأدمن عبر Apps Script =====
async function getDriveUploadConfig() {
  try {
    const snap = await getDoc(doc(db, 'settings', 'drive'));
    if (!snap.exists()) return null;
    return snap.data();
  } catch (e) {
    console.error(e);
    return null;
  }
}

function compressImageFile(file, maxW = 900, quality = 0.62) {
  return new Promise((resolve) => {
    if (!file.type || !file.type.startsWith('image/')) { resolve(file); return; }
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      let w = img.width, h = img.height;
      if (w > maxW) { h = Math.round(h * maxW / w); w = maxW; }
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
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

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const res = String(reader.result || '');
      const b64 = res.includes(',') ? res.split(',')[1] : res;
      resolve(b64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function uploadToDriveScript(file, onProgress, meta = {}) {
  const cfg = await getDriveUploadConfig();
  if (!cfg?.scriptUrl) {
    throw new Error('رفع الملفات غير مفعّل من الإدارة بعد — ادخل Drive في الأدمن واحفظ الرابط والـ SECRET');
  }
  let scriptUrl = String(cfg.scriptUrl).trim();
  if (scriptUrl.includes('/dev')) {
    throw new Error('استخدم رابط النشر /exec مش رابط التجربة /dev');
  }
  const maxMb = parseFloat(cfg.maxMb) || 15;
  if (file.size > maxMb * 1024 * 1024) {
    throw new Error(`الحد الأقصى ${maxMb} ميجا`);
  }
  const progressCb = typeof onProgress === 'function' ? onProgress : null;
  if (progressCb) progressCb(10);
  const base64 = await fileToBase64(file);
  if (progressCb) progressCb(40);

  const payload = JSON.stringify({
    secret: cfg.secret || '',
    fileName: file.name,
    mimeType: file.type || 'application/octet-stream',
    base64,
    projectName: (meta && meta.projectName) || 'project',
    folderKind: (meta && meta.folderKind) || 'files',
    userName: (meta && meta.userName) || '',
    userId: (meta && meta.userId) || '',
    deleteOldInFolder: !!(meta && meta.deleteOldInFolder)
  });

  const text = await new Promise((resolve, reject) => {
    try {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', scriptUrl, true);
      xhr.setRequestHeader('Content-Type', 'text/plain;charset=utf-8');
      xhr.timeout = 120000;
      xhr.onload = () => {
        if (progressCb) progressCb(80);
        resolve(xhr.responseText || '');
      };
      xhr.onerror = () => reject(new Error(
        'فشل الاتصال بسكربت الدرايف. جرّب: Chrome بدون إضافات، ومن localhost، وتأكد أن Who has access = Anyone بعد New version.'
      ));
      xhr.ontimeout = () => reject(new Error('انتهت مهلة الرفع — جرب ملف أصغر'));
      xhr.send(payload);
    } catch (e) {
      reject(e);
    }
  });

  let data;
  try { data = JSON.parse(text); } catch {
    throw new Error('رد غير متوقع من السكربت. تأكد من النشر Anyone. جزء من الرد: ' + String(text).slice(0, 100));
  }
  if (!data.ok) throw new Error(data.error || 'فشل الرفع');
  if (progressCb) progressCb(100);
  return data;
}

window.uploadToDriveScript = uploadToDriveScript;
window.compressImageFile = compressImageFile;
window.getDriveUploadConfig = getDriveUploadConfig;

/** حذف ملف من الدرايف بالـ fileId (لتوفير المساحة عند تغيير صورة البروفايل) */
async function deleteFromDriveScript(fileId) {
  if (!fileId) return false;
  try {
    const cfg = await getDriveUploadConfig();
    if (!cfg?.scriptUrl) return false;
    const scriptUrl = String(cfg.scriptUrl).trim();
    const payload = JSON.stringify({ secret: cfg.secret || '', action: 'delete', fileId: String(fileId) });
    const text = await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', scriptUrl, true);
      xhr.setRequestHeader('Content-Type', 'text/plain;charset=utf-8');
      xhr.timeout = 30000;
      xhr.onload = () => resolve(xhr.responseText || '');
      xhr.onerror = () => reject(new Error('network'));
      xhr.ontimeout = () => reject(new Error('timeout'));
      xhr.send(payload);
    });
    const data = JSON.parse(text);
    return !!(data && data.ok);
  } catch (e) {
    console.warn('deleteFromDrive', e);
    return false;
  }
}
window.deleteFromDriveScript = deleteFromDriveScript;



// Export for other pages
window.appHelpers = { showToast, showLoading, getInitials, currentUser, currentUserData, loadUserNotifications };
// فلتر شتائم بسيط محلي — بدون قراءات Firebase
const BAD_WORDS = ['كس','كسم','عرص','شرموط','متناك','زب','طيز','خرا','منيوك','خول','قحبة','شرموطة','fuck','shit','bitch','asshole'];
function containsBadWords(text) {
  if (!text) return false;
  const t = String(text).toLowerCase().replace(/\s+/g,'');
  return BAD_WORDS.some(w => t.includes(w.toLowerCase()));
}
function moderateText(text, fieldName = 'النص') {
  if (containsBadWords(text)) {
    showToast(fieldName + ' يحتوي ألفاظ غير لائقة. عدّل الصياغة.', 'error');
    return false;
  }
  return true;
}
export { showToast, showLoading, getInitials, containsBadWords, moderateText, linkifyText, getDriveDownloadUrl, uploadToDriveScript, compressImageFile, deleteFromDriveScript, siteConfirm };
window.moderateText = moderateText;


// مجاني / مدفوع + تنظيف السعر (06 → 6)
function normalizePriceInput(el) {
  if (!el) return 0;
  let v = String(el.value || '').trim();
  if (v === '') { el.value = '0'; return 0; }
  const n = parseFloat(v);
  if (isNaN(n) || n < 0) { el.value = '0'; return 0; }
  el.value = String(n);
  return n;
}

function togglePaymentFields() {
  const pricing = document.querySelector('input[name="projPricing"]:checked')?.value;
  const priceEl = document.getElementById('projPrice');
  const priceWrap = document.getElementById('projPriceWrap');
  const fields = document.getElementById('paymentFields');
  const method = document.getElementById('projPayMethod');
  const number = document.getElementById('projPayNumber');
  const name = document.getElementById('projPayName');

  const isFree = pricing === 'free' || (!pricing && (parseFloat(priceEl?.value) || 0) <= 0);
  if (isFree && priceEl) priceEl.value = '0';
  if (priceWrap) priceWrap.style.display = isFree ? 'none' : 'block';
  const hide = isFree;
  if (fields) fields.style.display = hide ? 'none' : 'block';
  if (!hide && priceEl) normalizePriceInput(priceEl);

  // لو مفيش wrapper (صفحة المشاريع) نخفي العناصر نفسها وآباءها
  [method, number, name].forEach(el => {
    if (!el) return;
    if (hide) {
      el.removeAttribute('required');
      el.value = el.tagName === 'SELECT' ? (el.options[0]?.value || '') : '';
    } else {
      el.setAttribute('required', 'required');
    }
    // إخفاء الصف/المجموعة الأب إن وجدت
    const row = el.closest('.mb-3, .col-md-6, .row');
    if (row && !fields) row.style.display = hide ? 'none' : '';
  });

  // labels/groups around payment in projects.html
  if (!fields) {
    document.querySelectorAll('[data-pay-field]').forEach(el => {
      el.style.display = hide ? 'none' : '';
    });
  }
}
document.getElementById('projPrice')?.addEventListener('input', togglePaymentFields);
document.getElementById('projPrice')?.addEventListener('blur', () => normalizePriceInput(document.getElementById('projPrice')));
document.addEventListener('change', (e) => {
  if (e.target?.name === 'projPricing') togglePaymentFields();
});
document.addEventListener('DOMContentLoaded', togglePaymentFields);
document.getElementById('uploadModal')?.addEventListener('shown.bs.modal', togglePaymentFields);

// ===== Image Cropper (drag + resize) =====
// aspect: number (e.g. 1 or 16/9) or 'free'
function openImageCropper(file, options = {}) {
  return new Promise((resolve, reject) => {
    if (!file || !file.type.startsWith('image/')) {
      reject(new Error('ملف غير صالح'));
      return;
    }
    const aspect = options.aspect === 'free' ? null : (parseFloat(options.aspect) || 1);
    const outSize = options.outSize || 400;
    const title = options.title || 'قص الصورة';
    const hint = options.hint || 'اسحب المربع للتحريك · اسحب الزوايا للتكبير/التصغير';

    let modal = document.getElementById('imageCropModal');
    if (modal) modal.remove();
    modal = document.createElement('div');
    modal.id = 'imageCropModal';
    modal.className = 'modal fade';
    modal.tabIndex = -1;
    modal.innerHTML = `
      <div class="modal-dialog modal-dialog-centered modal-lg">
        <div class="modal-content">
          <div class="modal-header">
            <h5 class="modal-title" id="cropModalTitle">${title}</h5>
            <button type="button" class="btn-close btn-close-white" data-bs-dismiss="modal"></button>
          </div>
          <div class="modal-body text-center">
            <p class="small text-muted mb-2" id="cropHintText">${hint}</p>
            <div id="cropCanvasWrap" style="position:relative;display:inline-block;max-width:100%;touch-action:none;user-select:none;">
              <canvas id="cropBgCanvas" style="max-width:100%;display:block;border-radius:8px;"></canvas>
              <div id="cropBox" style="position:absolute;border:2px solid #d4af37;box-shadow:0 0 0 9999px rgba(0,0,0,0.45);cursor:move;box-sizing:border-box;">
                <span class="crop-handle" data-dir="nw" style="left:-7px;top:-7px;cursor:nwse-resize;"></span>
                <span class="crop-handle" data-dir="ne" style="right:-7px;top:-7px;cursor:nesw-resize;"></span>
                <span class="crop-handle" data-dir="sw" style="left:-7px;bottom:-7px;cursor:nesw-resize;"></span>
                <span class="crop-handle" data-dir="se" style="right:-7px;bottom:-7px;cursor:nwse-resize;"></span>
              </div>
            </div>
            <div class="mt-2 d-flex justify-content-center gap-2 flex-wrap">
              <button type="button" class="btn btn-sm btn-outline-secondary" id="cropZoomOut" title="تصغير">− تصغير</button>
              <button type="button" class="btn btn-sm btn-outline-secondary" id="cropZoomIn" title="تكبير">+ تكبير</button>
            </div>
          </div>
          <div class="modal-footer">
            <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">إلغاء</button>
            <button type="button" class="btn btn-primary-custom text-white" id="cropConfirmBtn">تأكيد القص</button>
          </div>
        </div>
      </div>`;
    // inject handle styles once
    if (!document.getElementById('cropHandleStyles')) {
      const st = document.createElement('style');
      st.id = 'cropHandleStyles';
      st.textContent = `.crop-handle{position:absolute;width:14px;height:14px;background:#d4af37;border:2px solid #fff;border-radius:50%;z-index:5;box-shadow:0 1px 4px rgba(0,0,0,.35);}
#cropBox{touch-action:none;}
@media(max-width:576px){.crop-handle{width:18px;height:18px;}}`;
      document.head.appendChild(st);
    }
    document.body.appendChild(modal);

    const bgCanvas = document.getElementById('cropBgCanvas');
    const cropBox = document.getElementById('cropBox');
    const ctx = bgCanvas.getContext('2d');

    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const maxDisp = Math.min(560, window.innerWidth - 40);
      let dw = img.width, dh = img.height;
      if (dw > maxDisp) { dh = Math.round(dh * maxDisp / dw); dw = maxDisp; }
      if (dh > Math.min(420, window.innerHeight * 0.5)) {
        const maxH = Math.min(420, window.innerHeight * 0.5);
        dw = Math.round(dw * maxH / dh); dh = maxH;
      }
      bgCanvas.width = dw;
      bgCanvas.height = dh;
      bgCanvas.style.width = dw + 'px';
      bgCanvas.style.height = dh + 'px';
      ctx.drawImage(img, 0, 0, dw, dh);

      const minSide = 48;
      let boxW, boxH;
      if (aspect) {
        if (dw / dh > aspect) { boxH = Math.min(dh * 0.75, dw * 0.75 / aspect); boxW = boxH * aspect; }
        else { boxW = Math.min(dw * 0.75, dh * 0.75 * aspect); boxH = boxW / aspect; }
      } else {
        boxW = dw * 0.75; boxH = dh * 0.75;
      }
      let boxX = (dw - boxW) / 2, boxY = (dh - boxH) / 2;

      const place = () => {
        cropBox.style.left = boxX + 'px';
        cropBox.style.top = boxY + 'px';
        cropBox.style.width = boxW + 'px';
        cropBox.style.height = boxH + 'px';
      };
      place();

      const clampBox = () => {
        boxW = Math.max(minSide, Math.min(dw, boxW));
        boxH = Math.max(minSide, Math.min(dh, boxH));
        if (aspect) {
          // keep aspect after clamp
          if (boxW / boxH > aspect) boxW = boxH * aspect;
          else boxH = boxW / aspect;
          if (boxW > dw) { boxW = dw; boxH = boxW / aspect; }
          if (boxH > dh) { boxH = dh; boxW = boxH * aspect; }
        }
        boxX = Math.max(0, Math.min(dw - boxW, boxX));
        boxY = Math.max(0, Math.min(dh - boxH, boxY));
      };

      let mode = null; // 'move' | 'nw'|'ne'|'sw'|'se'
      let startX = 0, startY = 0, oX = 0, oY = 0, oW = 0, oH = 0;

      const getPt = (e) => {
        const t = e.touches ? e.touches[0] : e;
        return { x: t.clientX, y: t.clientY };
      };

      const onDown = (e) => {
        const handle = e.target.closest?.('.crop-handle');
        mode = handle ? handle.dataset.dir : 'move';
        const pt = getPt(e);
        startX = pt.x; startY = pt.y;
        oX = boxX; oY = boxY; oW = boxW; oH = boxH;
        e.preventDefault();
        e.stopPropagation();
      };
      const onMove = (e) => {
        if (!mode) return;
        const pt = getPt(e);
        const dx = pt.x - startX;
        const dy = pt.y - startY;
        if (mode === 'move') {
          boxX = oX + dx;
          boxY = oY + dy;
        } else {
          // resize from corners, keep aspect if set
          let nx = oX, ny = oY, nw = oW, nh = oH;
          if (mode.includes('e')) nw = oW + dx;
          if (mode.includes('s')) nh = oH + dy;
          if (mode.includes('w')) { nw = oW - dx; nx = oX + dx; }
          if (mode.includes('n')) { nh = oH - dy; ny = oY + dy; }
          if (aspect) {
            // dominant axis by larger relative change
            if (Math.abs(dx) > Math.abs(dy)) {
              nh = nw / aspect;
              if (mode.includes('n')) ny = oY + oH - nh;
            } else {
              nw = nh * aspect;
              if (mode.includes('w')) nx = oX + oW - nw;
            }
          }
          if (nw < minSide || nh < minSide) return;
          if (nx < 0 || ny < 0 || nx + nw > dw || ny + nh > dh) {
            // soft clamp
            if (nx < 0) { nw += nx; nx = 0; if (aspect) nh = nw / aspect; }
            if (ny < 0) { nh += ny; ny = 0; if (aspect) nw = nh * aspect; }
            if (nx + nw > dw) { nw = dw - nx; if (aspect) nh = nw / aspect; }
            if (ny + nh > dh) { nh = dh - ny; if (aspect) nw = nh * aspect; }
            if (nw < minSide || nh < minSide) return;
          }
          boxX = nx; boxY = ny; boxW = nw; boxH = nh;
        }
        clampBox();
        place();
        e.preventDefault();
      };
      const onUp = () => { mode = null; };

      cropBox.addEventListener('mousedown', onDown);
      cropBox.addEventListener('touchstart', onDown, { passive: false });
      window.addEventListener('mousemove', onMove);
      window.addEventListener('touchmove', onMove, { passive: false });
      window.addEventListener('mouseup', onUp);
      window.addEventListener('touchend', onUp);

      const scaleBox = (factor) => {
        const cx = boxX + boxW / 2, cy = boxY + boxH / 2;
        boxW *= factor; boxH *= factor;
        clampBox();
        boxX = cx - boxW / 2;
        boxY = cy - boxH / 2;
        clampBox();
        place();
      };
      document.getElementById('cropZoomIn').onclick = () => scaleBox(1.08);
      document.getElementById('cropZoomOut').onclick = () => scaleBox(0.92);

      const bsModal = new bootstrap.Modal(modal);
      let settled = false;
      const cleanup = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('touchmove', onMove);
        window.removeEventListener('mouseup', onUp);
        window.removeEventListener('touchend', onUp);
        URL.revokeObjectURL(url);
      };
      modal.addEventListener('hidden.bs.modal', () => {
        cleanup();
        if (!settled) reject(new Error('cancelled'));
      }, { once: true });

      document.getElementById('cropConfirmBtn').onclick = () => {
        settled = true;
        const scaleX = img.width / dw;
        const scaleY = img.height / dh;
        const sx = boxX * scaleX, sy = boxY * scaleY;
        const sw = boxW * scaleX, sh = boxH * scaleY;
        const out = document.createElement('canvas');
        let targetW, targetH;
        if (aspect === 1) {
          targetW = outSize; targetH = outSize;
        } else {
          targetW = Math.min(Math.max(outSize, 640), Math.round(sw));
          targetH = Math.round(targetW * (sh / sw));
        }
        out.width = targetW;
        out.height = targetH;
        out.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, targetW, targetH);
        out.toBlob((blob) => {
          cleanup();
          bsModal.hide();
          if (!blob) { reject(new Error('فشل القص')); return; }
          const name = (file.name || 'image').replace(/\.\w+$/, '') + '_crop.jpg';
          resolve(new File([blob], name, { type: 'image/jpeg' }));
        }, 'image/jpeg', 0.9);
      };
      bsModal.show();
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('تعذر قراءة الصورة')); };
    img.src = url;
  });
}
window.openImageCropper = openImageCropper;

// Extra images accumulator (append instead of replace)
window._extraImageFiles = window._extraImageFiles || [];
function renderExtraPreview() {
  const box = document.getElementById('extraPreview');
  if (!box) return;
  const files = window._extraImageFiles || [];
  box.innerHTML = files.map((f, i) => `
    <div class="position-relative d-inline-block me-1 mb-1">
      <img src="${URL.createObjectURL(f)}" style="height:56px;width:72px;object-fit:cover;border-radius:6px;border:1px solid #ddd;">
      <button type="button" class="btn btn-danger btn-sm position-absolute top-0 end-0 p-0 extra-rm" data-i="${i}"
        style="width:20px;height:20px;line-height:1;font-size:11px;border-radius:50%;transform:translate(30%,-30%);">×</button>
    </div>`).join('') + (files.length ? `<div class="small text-muted w-100">${files.length} / 12 صورة</div>` : '');
  box.querySelectorAll('.extra-rm').forEach(btn => {
    btn.onclick = () => {
      window._extraImageFiles.splice(parseInt(btn.dataset.i, 10), 1);
      renderExtraPreview();
    };
  });
}
window.renderExtraPreview = renderExtraPreview;

function clearFileInput(inputId, previewId) {
  const inp = document.getElementById(inputId);
  if (inp) inp.value = '';
  const prev = previewId ? document.getElementById(previewId) : null;
  if (prev) prev.innerHTML = '';
}
window.clearFileInput = clearFileInput;

function formatArDate(ts) {
  try {
    let d = null;
    if (!ts) return '';
    if (typeof ts.toDate === 'function') d = ts.toDate();
    else if (ts instanceof Date) d = ts;
    else if (typeof ts === 'string' || typeof ts === 'number') d = new Date(ts);
    if (!d || isNaN(d.getTime())) return '';
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}/${m}/${day}`;
  } catch { return ''; }
}
window.formatArDate = formatArDate;

export { openImageCropper, formatArDate };
