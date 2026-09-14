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
