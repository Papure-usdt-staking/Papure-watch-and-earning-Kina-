/* script.js — Monolithic client with:
   - REST API wiring (withdraw, banks)
   - WebSocket realtime (subprotocol auth + fallback)
   - Automatic token refresh (single-flight)
   - Fetch retry with exponential backoff + jitter
   - URL-driven wallet navigation and accessibility improvements

   Configure before loading:
    - window.__WALLET_API_BASE
    - window.__WALLET_WS_URL
    - window.__WALLET_AUTH_HEADER_NAME
    - window.__WALLET_AUTH_PREFIX
    - window.__WALLET_AUTH_REFRESH_URL
    - window.__WALLET_WS_USE_SUBPROTOCOL (true/false)
    - window.__WALLET_RETRY_OPTIONS = { retries, baseDelay, maxDelay }
*/

(function () {
  'use strict';

  document.addEventListener('DOMContentLoaded', () => {

    // -----------------------
    // CONFIG & defaults
    // -----------------------
    const API_BASE = (typeof window.__WALLET_API_BASE !== 'undefined') ? window.__WALLET_API_BASE : '';
    const DEFAULT_WS_URL = (() => {
      try {
        const loc = window.location;
        return (loc.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + loc.host + '/ws';
      } catch (e) { return null; }
    })();
    const WS_URL_BASE = window.__WALLET_WS_URL || DEFAULT_WS_URL;
    const POLL_URL = API_BASE + '/api/wallet';
    const POLL_INTERVAL = 15000;

    const AUTH_HEADER_NAME = window.__WALLET_AUTH_HEADER_NAME || 'Authorization';
    const AUTH_PREFIX = (typeof window.__WALLET_AUTH_PREFIX !== 'undefined') ? window.__WALLET_AUTH_PREFIX : 'Bearer ';
    const AUTH_REFRESH_URL = window.__WALLET_AUTH_REFRESH_URL || (API_BASE + '/api/auth/refresh');
    let WS_USE_SUBPROTOCOL = (typeof window.__WALLET_WS_USE_SUBPROTOCOL !== 'undefined') ? Boolean(window.__WALLET_WS_USE_SUBPROTOCOL) : true;

    const DEFAULT_RETRY_OPTIONS = { retries: 3, baseDelay: 500, maxDelay: 8000 };
    let RETRY_OPTIONS = Object.assign({}, DEFAULT_RETRY_OPTIONS, window.__WALLET_RETRY_OPTIONS || {});

    // -----------------------
    // AUTH token storage keys
    // -----------------------
    const LS_AUTH_KEY = 'wallet_access_token';
    const LS_REFRESH_KEY = 'wallet_refresh_token';

    // -----------------------
    // AUTH: helpers, single-flight refresh
    // -----------------------
    function readMetaToken() {
      try {
        const m = document.querySelector('meta[name="wallet-auth-token"]');
        return m ? m.getAttribute('content') : null;
      } catch (e) { return null; }
    }

    function readMetaRefresh() {
      try {
        const m = document.querySelector('meta[name="wallet-refresh-token"]');
        return m ? m.getAttribute('content') : null;
      } catch (e) { return null; }
    }

    function getStoredAuth() {
      if (typeof window.__WALLET_AUTH_TOKEN !== 'undefined' && window.__WALLET_AUTH_TOKEN) return String(window.__WALLET_AUTH_TOKEN);
      const meta = readMetaToken();
      if (meta) return String(meta);
      try {
        const ls = localStorage.getItem(LS_AUTH_KEY);
        if (ls) return String(ls);
      } catch (e) {}
      return null;
    }

    function getStoredRefresh() {
      if (typeof window.__WALLET_REFRESH_TOKEN !== 'undefined' && window.__WALLET_REFRESH_TOKEN) return String(window.__WALLET_REFRESH_TOKEN);
      const meta = readMetaRefresh();
      if (meta) return String(meta);
      try {
        const ls = localStorage.getItem(LS_REFRESH_KEY);
        if (ls) return String(ls);
      } catch (e) {}
      return null;
    }

    let authToken = getStoredAuth();
    let refreshToken = getStoredRefresh();

    // Single-flight refresh promise
    let refreshPromise = null;

    function getAuthHeaders() {
      const headers = {};
      if (authToken) headers[AUTH_HEADER_NAME] = AUTH_PREFIX ? (AUTH_PREFIX + authToken) : authToken;
      return headers;
    }

    function setAuthToken(token, opts = { persist: false }) {
      authToken = token ? String(token) : null;
      if (opts && opts.persist) {
        try {
          if (authToken) localStorage.setItem(LS_AUTH_KEY, authToken);
          else localStorage.removeItem(LS_AUTH_KEY);
        } catch (e) {}
      }
      // reconnect WS with new token if active
      if (ws && ws.readyState === WebSocket.OPEN) {
        try { ws.close(1000, 'auth-update'); } catch (e) {}
        ws = null;
        connectWebSocket(WS_URL_BASE);
      }
    }

    function setRefreshToken(token, opts = { persist: false }) {
      refreshToken = token ? String(token) : null;
      if (opts && opts.persist) {
        try {
          if (refreshToken) localStorage.setItem(LS_REFRESH_KEY, refreshToken);
          else localStorage.removeItem(LS_REFRESH_KEY);
        } catch (e) {}
      }
    }

    function clearAuthToken() {
      setAuthToken(null, { persist: true });
      setRefreshToken(null, { persist: true });
    }

    async function refreshAuthToken() {
      // Return existing promise if refresh in progress
      if (refreshPromise) return refreshPromise;
      // If no refresh token available, fail quickly
      if (!refreshToken) {
        clearAuthToken();
        return Promise.reject(new Error('no-refresh-token'));
      }

      refreshPromise = (async () => {
        try {
          const res = await fetch(AUTH_REFRESH_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ refreshToken })
          });
          if (!res.ok) {
            // refresh failed — clear tokens
            clearAuthToken();
            throw new Error('refresh-failed');
          }
          const json = await res.json();
          // Expect shape { accessToken, refreshToken? }
          if (!json || !json.accessToken) {
            clearAuthToken();
            throw new Error('invalid-refresh-response');
          }
          // update tokens
          setAuthToken(json.accessToken, { persist: true });
          if (json.refreshToken) setRefreshToken(json.refreshToken, { persist: true });
          return json.accessToken;
        } catch (err) {
          clearAuthToken();
          throw err;
        } finally {
          refreshPromise = null;
        }
      })();

      return refreshPromise;
    }

    // -----------------------
    // Retry / backoff helpers
    // -----------------------
    function sleep(ms) {
      return new Promise(resolve => setTimeout(resolve, ms));
    }

    function jitter(min, max) {
      return Math.random() * (max - min) + min;
    }

    // fetchWithRetry: retries on network errors and 5xx; on 401 attempts token refresh once
    async function fetchWithRetry(url, opts = {}, retryOptions = RETRY_OPTIONS) {
      const { retries = 3, baseDelay = 500, maxDelay = 8000 } = retryOptions;
      let attempt = 0;
      let lastErr = null;
      // Copy opts to avoid mutation
      const originalOpts = Object.assign({}, opts);

      while (attempt <= retries) {
        try {
          const res = await fetch(url, originalOpts);
          if (res.status === 401) {
            // Try refresh once, then retry request
            try {
              await refreshAuthToken();
              // rebuild headers with new auth header if present
              if (originalOpts.headers) originalOpts.headers = Object.assign({}, originalOpts.headers, getAuthHeaders());
              else originalOpts.headers = getAuthHeaders();
              // retry immediately (not counting as incremental backoff attempt)
              const retryRes = await fetch(url, originalOpts);
              return retryRes;
            } catch (refreshErr) {
              // refresh failed
              throw new Error('auth-refresh-failed');
            }
          }
          // For 5xx, treat as retryable
          if (res.status >= 500 && res.status < 600) {
            lastErr = new Error('server-error-' + res.status);
            // fall through to retry
            throw lastErr;
          }
          // successful or 4xx (other than 401) -> return directly
          return res;
        } catch (err) {
          lastErr = err;
          attempt += 1;
          if (attempt > retries) break;
          // exponential backoff with jitter
          const delay = Math.min(maxDelay, baseDelay * Math.pow(2, attempt - 1));
          const wait = Math.round(jitter(delay * 0.6, delay * 1.4));
          await sleep(wait);
          // continue to next attempt
        }
      }
      // exhausted
      throw lastErr || new Error('fetch-failed');
    }

    function authFetch(url, opts = {}, retryOptions = RETRY_OPTIONS) {
      opts = Object.assign({}, opts);
      opts.headers = Object.assign({}, opts.headers || {}, getAuthHeaders());
      return fetchWithRetry(url, opts, retryOptions);
    }

    // -----------------------
    // DOM helpers & rendering
    // -----------------------
    const $ = (s) => document.querySelector(s);
    const $$ = (s) => Array.from(document.querySelectorAll(s));

    const overlay = $('#walletOverlay');
    const modal = $('#walletModal');
    const closeBtn = $('#closeWalletBtn');
    const toggleBtn = $('#walletToggleBtn');

    const balanceDisplay = $('#walletBalance');
    const headerBadge = $('#headerBalanceBadge');
    const todayEarnings = $('#todayEarnings');
    const totalEarnings = $('#totalEarnings');
    const maxWithdrawLabel = $('#maxWithdrawLabel');

    const bankSelectGrid = $('#bankSelectGrid');
    const bankSelectHint = $('#bankSelectHint');
    const accName = $('#accName');
    const accNumber = $('#accNumber');
    const accCode = $('#accCode');
    const withdrawAmount = $('#withdrawAmount');
    const withdrawForm = $('#withdrawForm');
    const withdrawBtn = $('#withdrawSubmitBtn');

    const historyList = $('#historyList');
    const savedBanksList = $('#savedBanksList');
    const addBankBtn = $('#addBankBtn');
    const bankFormContainer = $('#bankFormContainer');
    const bankFormTitle = $('#bankFormTitle');
    const bankNameSelect = $('#bankNameSelect');
    const bankFormAccName = $('#bankFormAccName');
    const bankFormAccNumber = $('#bankFormAccNumber');
    const bankFormAccCode = $('#bankFormAccCode');
    const bankFormSaveBtn = $('#bankFormSaveBtn');
    const bankFormCancelBtn = $('#bankFormCancelBtn');

    const successOverlay = $('#withdrawSuccessOverlay');
    const successOkBtn = $('#successOkBtn');

    const toastContainer = $('#toastContainer');

    // focus management
    let lastFocusedElement = null;
    const focusableSelector = 'a[href], area[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex="-1"])';

    function el(tag, opts = {}, children = []) {
      const node = document.createElement(tag);
      Object.keys(opts).forEach(k => {
        if (k === 'class') node.className = opts[k];
        else if (k === 'text') node.textContent = opts[k];
        else if (k === 'html') node.innerHTML = opts[k];
        else node.setAttribute(k, opts[k]);
      });
      children.forEach(c => node.appendChild(c));
      return node;
    }

    // Application state and render functions (unchanged structure)
    const appState = {
      balance: 27.45,
      totalEarned: 142.80,
      todayEarned: 4.20,
      banks: [],
      withdrawals: [],
      selectedBankId: null,
      editingBankId: null,
      isProcessing: false,
    };

    // Keep in sync with earlier 'state' naming
    Object.assign(appState, {
      balance: 27.45,
      totalEarned: 142.80,
      todayEarned: 4.20
    });

    // Local persistence debounce
    function saveState() {
      try {
        const data = {
          balance: appState.balance,
          totalEarned: appState.totalEarned,
          todayEarned: appState.todayEarned,
          banks: appState.banks,
          withdrawals: appState.withdrawals,
        };
        localStorage.setItem('papure_wallet', JSON.stringify(data));
      } catch (e) {}
    }

    function loadState() {
      try {
        const s = localStorage.getItem('papure_wallet');
        if (s) {
          const parsed = JSON.parse(s);
          Object.assign(appState, parsed);
          appState.banks = appState.banks || [];
          appState.withdrawals = appState.withdrawals || [];
        }
      } catch (e) {}
    }

    function renderBalance() {
      if (balanceDisplay) balanceDisplay.textContent = Number(appState.balance || 0).toFixed(2);
      if (headerBadge) headerBadge.textContent = formatK(appState.balance);
      if (todayEarnings) todayEarnings.textContent = formatK(appState.todayEarned);
      if (totalEarnings) totalEarnings.textContent = formatK(appState.totalEarned);
      if (maxWithdrawLabel) maxWithdrawLabel.textContent = formatK(appState.balance);
      if (withdrawAmount) {
        withdrawAmount.min = 1;
        withdrawAmount.max = appState.balance || 0;
        withdrawAmount.placeholder = `0.00 (max ${Number(appState.balance || 0).toFixed(2)})`;
      }
    }

    function renderBankSelect() {
      if (!bankSelectGrid) return;
      bankSelectGrid.innerHTML = '';
      if (!appState.banks || appState.banks.length === 0) {
        bankSelectGrid.appendChild(el('div', { class: 'text-muted', text: 'No banks saved. Add one in the Banks tab.' }));
        if (bankSelectHint) bankSelectHint.textContent = 'Please add a bank first.';
        appState.selectedBankId = null;
        return;
      }

      appState.banks.forEach(bank => {
        const card = el('button', { class: 'bank-select-card', 'data-bank-id': bank.id, type: 'button' });
        if (appState.selectedBankId === bank.id) card.classList.add('selected');

        const icon = el('span', { class: 'bank-icon', text: getBankEmoji(bank.name) });
        const name = el('span', { text: bank.name });

        card.appendChild(icon);
        card.appendChild(name);

        card.addEventListener('click', () => {
          appState.selectedBankId = bank.id;
          if (accName) accName.value = bank.accName || '';
          if (accNumber) accNumber.value = bank.accNumber || '';
          if (accCode) accCode.value = bank.accCode || '';
          renderBankSelect();
          saveState();
        });
        bankSelectGrid.appendChild(card);
      });

      if (!appState.selectedBankId && appState.banks.length > 0) {
        appState.selectedBankId = appState.banks[0].id;
      } else if (appState.selectedBankId && !appState.banks.find(b => b.id === appState.selectedBankId)) {
        appState.selectedBankId = appState.banks[0].id;
      }
      if (bankSelectHint) bankSelectHint.textContent = appState.banks.length > 0 ? 'Click a bank to select it.' : 'No banks saved.';
    }

    function renderSavedBanks() {
      if (!savedBanksList) return;
      savedBanksList.innerHTML = '';
      if (!appState.banks || appState.banks.length === 0) {
        const empty = el('div', { class: 'empty-state' }, [
          el('div', { class: 'empty-icon', html: '<i class="fas fa-building-columns"></i>' }),
          el('p', { text: 'No banks saved yet' })
        ]);
        savedBanksList.appendChild(empty);
        return;
      }

      appState.banks.forEach(bank => {
        const item = el('div', { class: 'saved-bank-item' });
        const bankInfo = el('div', { class: 'bank-info' });
        const bankEmoji = el('span', { style: 'font-size:1.4rem;', text: getBankEmoji(bank.name) });
        const bankDetails = el('div');
        const bankName = el('div', { class: 'bank-name', text: bank.name });
        const detailText = `${bank.accName} · ${bank.accNumber}${bank.accCode ? ' · ' + bank.accCode : ''}`;
        const bankDetail = el('div', { class: 'bank-detail', text: detailText });

        bankDetails.appendChild(bankName);
        bankDetails.appendChild(bankDetail);
        bankInfo.appendChild(bankEmoji);
        bankInfo.appendChild(bankDetails);

        const actions = el('div', { class: 'bank-actions' });
        const editBtn = el('button', { class: 'edit-btn', title: 'Edit', 'data-id': bank.id, type: 'button' }, [el('i', { class: 'fas fa-pen' })]);
        const delBtn = el('button', { class: 'delete-btn', title: 'Delete', 'data-id': bank.id, type: 'button' }, [el('i', { class: 'fas fa-trash-can' })]);

        editBtn.addEventListener('click', () => {
          appState.editingBankId = bank.id;
          bankFormTitle.textContent = 'Edit Bank';
          bankNameSelect.value = bank.name;
          bankFormAccName.value = bank.accName;
          bankFormAccNumber.value = bank.accNumber;
          bankFormAccCode.value = bank.accCode || '';
          bankFormSaveBtn.querySelector('.btn-text').textContent = 'Update Bank';
          bankFormContainer.style.display = 'block';
        });

        delBtn.addEventListener('click', () => {
          if (confirm(`Delete "${bank.name}" account?`)) {
            // call API or local remove
            if (API_BASE) {
              apiDeleteBank(bank.id).then(res => {
                if (res && res.ok) {
                  appState.banks = appState.banks.filter(b => b.id !== bank.id);
                  if (appState.selectedBankId === bank.id) appState.selectedBankId = appState.banks.length ? appState.banks[0].id : null;
                  renderSavedBanks();
                  renderBankSelect();
                  saveState();
                  showToast('Bank removed.', 'info');
                } else {
                  showToast(res && res.error === 'network' ? 'Network error while removing bank' : (res && res.error) || 'Failed to remove bank', 'error');
                }
              }).catch(() => showToast('Network error while removing bank', 'error'));
            } else {
              appState.banks = appState.banks.filter(b => b.id !== bank.id);
              if (appState.selectedBankId === bank.id) appState.selectedBankId = appState.banks.length ? appState.banks[0].id : null;
              renderSavedBanks();
              renderBankSelect();
              saveState();
              showToast('Bank removed.', 'info');
            }
          }
        });

        actions.appendChild(editBtn);
        actions.appendChild(delBtn);

        item.appendChild(bankInfo);
        item.appendChild(actions);

        savedBanksList.appendChild(item);
      });
    }

    function renderHistory() {
      if (!historyList) return;
      historyList.innerHTML = '';
      if (!appState.withdrawals || appState.withdrawals.length === 0) {
        const empty = el('div', { class: 'empty-state' }, [
          el('div', { class: 'empty-icon', html: '<i class="fas fa-clock-rotate-left"></i>' }),
          el('p', { text: 'No withdrawal history yet' })
        ]);
        historyList.appendChild(empty);
        return;
      }

      const sorted = [...appState.withdrawals].reverse();
      sorted.forEach(w => {
        const item = el('div', { class: `history-item status-${w.status}` });
        const left = el('div', { class: 'h-left' });
        const amount = el('div', { class: 'h-amount', text: `K${Number(w.amount).toFixed(2)}` });
        const meta = el('div', { class: 'h-meta', text: `${w.bankName} · ${w.accNumber} · ${new Date(w.date).toLocaleString()}` });
        left.appendChild(amount);
        left.appendChild(meta);

        const statusLabel = (w.status || 'unknown').charAt(0).toUpperCase() + (w.status || 'unknown').slice(1);
        const statusEl = el('span', { class: `h-status ${w.status || ''}`, text: statusLabel });

        item.appendChild(left);
        item.appendChild(statusEl);
        historyList.appendChild(item);
      });
    }

    function renderAll() {
      renderBalance();
      renderBankSelect();
      renderSavedBanks();
      renderHistory();
      saveState();
    }

    // -----------------------
    // API functions (withdraw, banks) using authFetch
    // -----------------------
    async function apiWithdraw(amount, bankId, accNameVal, accNumberVal, accCodeVal) {
      try {
        const res = await authFetch(API_BASE + '/api/withdraw', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ amount, bankId, accName: accNameVal, accNumber: accNumberVal, accCode: accCodeVal })
        });
        const json = await res.json();
        if (!res.ok) return { error: json && json.error ? json.error : 'failed' };
        return { ok: true, result: json };
      } catch (err) {
        return { error: 'network' };
      }
    }

    async function apiAddBank(name, accNameVal, accNumberVal, accCodeVal) {
      try {
        const res = await authFetch(API_BASE + '/api/banks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ name, accName: accNameVal, accNumber: accNumberVal, accCode: accCodeVal })
        });
        const json = await res.json();
        if (!res.ok) return { error: json && json.error ? json.error : 'failed' };
        return { ok: true, bank: json.bank || json };
      } catch (err) {
        return { error: 'network' };
      }
    }

    async function apiUpdateBank(id, name, accNameVal, accNumberVal, accCodeVal) {
      try {
        const res = await authFetch(API_BASE + '/api/banks/' + encodeURIComponent(id), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ name, accName: accNameVal, accNumber: accNumberVal, accCode: accCodeVal })
        });
        const json = await res.json();
        if (!res.ok) return { error: json && json.error ? json.error : 'failed' };
        return { ok: true, bank: json.bank || json };
      } catch (err) {
        return { error: 'network' };
      }
    }

    async function apiDeleteBank(id) {
      try {
        const res = await authFetch(API_BASE + '/api/banks/' + encodeURIComponent(id), {
          method: 'DELETE',
          credentials: 'same-origin'
        });
        const json = await res.json();
        if (!res.ok) return { error: json && json.error ? json.error : 'failed' };
        return { ok: true, removed: json.removed || json };
      } catch (err) {
        return { error: 'network' };
      }
    }

    // -----------------------
    // Withdraw processing (uses apiWithdraw when API_BASE present)
    // -----------------------
    async function processWithdrawal(amount, bankId) {
      if (appState.isProcessing) return;
      const bank = appState.banks.find(b => b.id === bankId);
      if (!bank) { showToast('Please select a bank.', 'error'); return; }

      const nameVal = accName.value.trim();
      const numVal = accNumber.value.trim();
      if (!nameVal || !numVal) { showToast('Please fill in account name and number.', 'error'); return; }

      if (amount < 1) { showToast('Minimum withdrawal is K1.00.', 'error'); return; }
      if (amount > appState.balance) { showToast('Insufficient balance.', 'error'); return; }

      appState.isProcessing = true;
      if (withdrawBtn) { withdrawBtn.classList.add('loading'); withdrawBtn.disabled = true; }

      if (!API_BASE) {
        setTimeout(() => {
          appState.balance = Number((appState.balance - amount).toFixed(2));
          appState.withdrawals.push({
            id: generateId('w_'),
            amount,
            bankName: bank.name,
            accNumber: bank.accNumber,
            status: 'success',
            date: Date.now(),
          });
          appState.isProcessing = false;
          if (withdrawBtn) { withdrawBtn.classList.remove('loading'); withdrawBtn.disabled = false; }
          renderAll();
          if (successOverlay) { successOverlay.classList.add('active'); successOverlay.setAttribute('aria-hidden', 'false'); }
          if (withdrawAmount) withdrawAmount.value = '';
          showToast(`Withdrawal of K${amount.toFixed(2)} to ${bank.name} successful!`, 'success');
        }, 1200);
        return;
      }

      const res = await apiWithdraw(amount, bankId, nameVal, numVal, accCode.value.trim());
      if (res.ok) {
        const result = res.result;
        if (result.withdrawal) appState.withdrawals.push(result.withdrawal);
        if (typeof result.balance !== 'undefined') appState.balance = Number(result.balance);
        renderAll();
        if (successOverlay) { successOverlay.classList.add('active'); successOverlay.setAttribute('aria-hidden', 'false'); }
        if (withdrawAmount) withdrawAmount.value = '';
        showToast(`Withdrawal of K${amount.toFixed(2)} submitted!`, 'success');
      } else {
        showToast(res.error === 'network' ? 'Network error. Try again.' : (res.error || 'Withdraw failed'), 'error');
      }

      appState.isProcessing = false;
      if (withdrawBtn) { withdrawBtn.classList.remove('loading'); withdrawBtn.disabled = false; }
      saveState();
    }

    // -----------------------
    // Navigation & events
    // -----------------------
    function trapFocus(container) {
      const focusable = Array.from(container.querySelectorAll(focusableSelector)).filter(el => el.offsetParent !== null);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      container.addEventListener('keydown', (e) => {
        if (e.key !== 'Tab') return;
        if (e.shiftKey) {
          if (document.activeElement === first) { e.preventDefault(); last.focus(); }
        } else {
          if (document.activeElement === last) { e.preventDefault(); first.focus(); }
        }
      });
    }

    function activateTabButton(btn, pushUrl = true) {
      $$('.tab-btn').forEach(b => { b.classList.remove('active'); b.setAttribute('aria-selected', 'false'); });
      btn.classList.add('active');
      btn.setAttribute('aria-selected', 'true');
      const tabName = btn.dataset.tab;
      $$('.tab-content').forEach(c => { c.classList.remove('active'); c.setAttribute('aria-hidden', 'true'); });
      const targetId = 'tab' + tabName.charAt(0).toUpperCase() + tabName.slice(1);
      const target = document.getElementById(targetId);
      if (target) { target.classList.add('active'); target.setAttribute('aria-hidden', 'false'); }

      const url = new URL(window.location.href);
      if (url.searchParams.get('wallet')) {
        url.searchParams.set('tab', tabName);
        history.replaceState({ wallet: true, tab: tabName }, '', url.toString());
      } else if (pushUrl) {
        url.searchParams.set('wallet', '1'); url.searchParams.set('tab', tabName);
        history.pushState({ wallet: true, tab: tabName }, '', url.toString());
      }

      if (tabName === 'banks') renderSavedBanks();
      if (tabName === 'history') renderHistory();
    }

    function openWallet(tab = 'withdraw', push = true) {
      renderAll();
      if (overlay) overlay.classList.add('active');
      if (overlay) overlay.setAttribute('aria-hidden', 'false');
      if (modal) modal.setAttribute('aria-hidden', 'false');
      document.body.style.overflow = 'hidden';
      if (successOverlay) { successOverlay.classList.remove('active'); successOverlay.setAttribute('aria-hidden', 'true'); }
      if (withdrawBtn) { withdrawBtn.classList.remove('loading'); withdrawBtn.disabled = false; }
      appState.isProcessing = false;

      const btn = $(`.tab-btn[data-tab="${tab}"]`);
      if (btn) activateTabButton(btn, false);

      lastFocusedElement = document.activeElement;
      const focusable = modal ? modal.querySelectorAll(focusableSelector) : [];
      if (focusable && focusable.length) focusable[0].focus();
      if (modal) trapFocus(modal);

      if (push) {
        const url = new URL(window.location.href);
        url.searchParams.set('wallet', '1');
        if (tab) url.searchParams.set('tab', tab);
        history.pushState({ wallet: true, tab }, '', url.toString());
      }
      if (toggleBtn) toggleBtn.setAttribute('aria-expanded', 'true');
    }

    function closeWallet(push = true) {
      if (overlay) overlay.classList.remove('active');
      if (overlay) overlay.setAttribute('aria-hidden', 'true');
      if (modal) modal.setAttribute('aria-hidden', 'true');
      document.body.style.overflow = '';
      closeBankForm();
      if (successOverlay) { successOverlay.classList.remove('active'); successOverlay.setAttribute('aria-hidden', 'true'); }

      if (lastFocusedElement && typeof lastFocusedElement.focus === 'function') lastFocusedElement.focus();

      if (push) {
        const url = new URL(window.location.href);
        url.searchParams.delete('wallet'); url.searchParams.delete('tab');
        history.pushState({}, '', url.toString());
      }
      if (toggleBtn) toggleBtn.setAttribute('aria-expanded', 'false');
    }

    window.addEventListener('popstate', (e) => {
      const url = new URL(window.location.href);
      if (url.searchParams.get('wallet')) {
        const tab = url.searchParams.get('tab') || 'withdraw';
        openWallet(tab, false);
      } else closeWallet(false);
    });

    if (toggleBtn) toggleBtn.addEventListener('click', () => { if (!overlay || !overlay.classList.contains('active')) openWallet('withdraw', true); else closeWallet(true); });
    if (closeBtn) closeBtn.addEventListener('click', () => closeWallet(true));
    if (overlay) overlay.addEventListener('click', (e) => { if (e.target === overlay) closeWallet(true); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && overlay && overlay.classList.contains('active')) closeWallet(true); });

    $$('.tab-btn').forEach(btn => btn.addEventListener('click', () => activateTabButton(btn, true)));

    if (withdrawForm) withdrawForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const amount = parseFloat(withdrawAmount.value);
      if (isNaN(amount) || amount <= 0) { showToast('Please enter a valid amount.', 'error'); return; }
      if (!appState.selectedBankId) { showToast('Please select a bank.', 'error'); return; }
      const bank = appState.banks.find(b => b.id === appState.selectedBankId);
      if (!bank) { showToast('Selected bank no longer exists.', 'error'); appState.selectedBankId = appState.banks.length > 0 ? appState.banks[0].id : null; renderAll(); return; }
      processWithdrawal(amount, appState.selectedBankId);
    });

    if (successOkBtn) successOkBtn.addEventListener('click', () => { if (successOverlay) { successOverlay.classList.remove('active'); successOverlay.setAttribute('aria-hidden', 'true'); } });
    if (addBankBtn) addBankBtn.addEventListener('click', () => { appState.editingBankId = null; bankFormTitle.textContent = 'Add Bank'; bankNameSelect.value = 'BSP Bank'; bankFormAccName.value = ''; bankFormAccNumber.value = ''; bankFormAccCode.value = ''; bankFormSaveBtn.querySelector('.btn-text').textContent = 'Save Bank'; bankFormContainer.style.display = 'block'; });

    if (bankFormSaveBtn) bankFormSaveBtn.addEventListener('click', async () => {
      const name = bankNameSelect.value.trim();
      const accNameVal = bankFormAccName.value.trim();
      const accNumberVal = bankFormAccNumber.value.trim();
      const accCodeVal = bankFormAccCode.value.trim();
      if (!name || !accNameVal || !accNumberVal) { showToast('Please fill in all required fields.', 'error'); return; }
      bankFormSaveBtn.classList.add('loading'); bankFormSaveBtn.disabled = true;
      try {
        if (appState.editingBankId) {
          if (!API_BASE) {
            const b = appState.banks.find(x => x.id === appState.editingBankId); if (b) { b.name = name; b.accName = accNameVal; b.accNumber = accNumberVal; b.accCode = accCodeVal; renderAll(); showToast('Bank updated', 'success'); closeBankForm(); }
          } else {
            const res = await apiUpdateBank(appState.editingBankId, name, accNameVal, accNumberVal, accCodeVal);
            if (res && res.ok) {
              const idx = appState.banks.findIndex(b => b.id === res.bank.id); if (idx !== -1) appState.banks[idx] = res.bank;
              renderAll(); showToast('Bank updated', 'success'); closeBankForm();
            } else showToast(res && res.error === 'network' ? 'Network error while updating bank' : (res && res.error) || 'Failed to update bank', 'error');
          }
        } else {
          if (!API_BASE) {
            const bank = { id: generateId('b_'), name, accName: accNameVal, accNumber: accNumberVal, accCode: accCodeVal };
            appState.banks.push(bank); appState.selectedBankId = bank.id; renderAll(); showToast('Bank added', 'success'); closeBankForm();
          } else {
            const res = await apiAddBank(name, accNameVal, accNumberVal, accCodeVal);
            if (res && res.ok) {
              appState.banks.push(res.bank); appState.selectedBankId = res.bank.id; renderAll(); showToast('Bank added', 'success'); closeBankForm();
            } else showToast(res && res.error === 'network' ? 'Network error while adding bank' : (res && res.error) || 'Failed to add bank', 'error');
          }
        }
      } finally { bankFormSaveBtn.classList.remove('loading'); bankFormSaveBtn.disabled = false; }
    });

    if (bankFormCancelBtn) bankFormCancelBtn.addEventListener('click', () => { bankFormContainer.style.display = 'none'; appState.editingBankId = null; });

    // -----------------------
    // Real-time (WS) with subprotocols auth and reconnect/backoff
    // -----------------------
    let ws = null;
    let wsReconnectAttempts = 0;
    let wsReconnectTimer = null;

    function buildWsUrl(base) {
      if (!base) return null;
      try {
        const url = new URL(base, window.location.href);
        // if not using subprotocols, append token as query param
        if (!WS_USE_SUBPROTOCOL && authToken) url.searchParams.set('wallet_token', authToken);
        return url.toString();
      } catch (e) {
        return base + (base.includes('?') ? '&' : '?') + 'wallet_token=' + encodeURIComponent(authToken || '');
      }
    }

    function buildWsProtocols() {
      // If subprotocols enabled and token present, return array with token protocol
      if (WS_USE_SUBPROTOCOL && authToken) {
        // Compose a safe subprotocol string. We'll use prefix 'access-token.' + base64url(token)
        // Base64url to avoid illegal chars: btoa may produce padding, so use encodeURIComponent fallback
        try {
          const b = btoa(unescape(encodeURIComponent(authToken))).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
          return ['wallet.v1', 'access_token.' + b];
        } catch (e) {
          // fallback: plain token (may fail if token contains spaces), but try
          return ['wallet.v1', 'access_token.' + authToken];
        }
      }
      // No subprotocols or no token: return a basic protocol
      return ['wallet.v1'];
    }

    function resetWsBackoff() {
      wsReconnectAttempts = 0;
      if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null; }
    }

    function scheduleWsReconnect() {
      wsReconnectAttempts += 1;
      const delay = Math.min(RETRY_OPTIONS.maxDelay || 8000, (RETRY_OPTIONS.baseDelay || 500) * Math.pow(2, wsReconnectAttempts - 1));
      const wait = Math.round(jitter(delay * 0.6, delay * 1.4));
      if (wsReconnectTimer) clearTimeout(wsReconnectTimer);
      wsReconnectTimer = setTimeout(() => {
        wsReconnectTimer = null;
        connectWebSocket(WS_URL_BASE);
      }, wait);
    }

    function handleRealtimeMessage(packet) {
      if (!packet || !packet.type) return;
      switch (packet.type) {
        case 'balance':
          if (packet.payload && typeof packet.payload.balance !== 'undefined') {
            appState.balance = Number(packet.payload.balance);
            if (typeof packet.payload.totalEarned !== 'undefined') appState.totalEarned = Number(packet.payload.totalEarned);
            if (typeof packet.payload.todayEarned !== 'undefined') appState.todayEarned = Number(packet.payload.todayEarned);
            renderBalance();
            saveState();
          }
          break;
        case 'withdrawal':
          if (packet.payload) {
            appState.withdrawals.push({
              id: packet.payload.id || generateId('w_'),
              amount: Number(packet.payload.amount || 0),
              bankName: packet.payload.bankName || 'Unknown',
              accNumber: packet.payload.accNumber || '—',
              status: packet.payload.status || 'pending',
              date: packet.payload.date || Date.now(),
            });
            renderHistory();
            saveState();
            showToast('New withdrawal recorded', 'info');
          }
          break;
        case 'banks':
          if (Array.isArray(packet.payload)) {
            appState.banks = packet.payload.map(b => ({ id: b.id || generateId('b_'), name: b.name, accName: b.accName, accNumber: b.accNumber, accCode: b.accCode || '' }));
            renderBankSelect(); renderSavedBanks(); saveState();
          }
          break;
        case 'snapshot':
          if (packet.payload) {
            appState.balance = Number(packet.payload.balance || appState.balance);
            appState.totalEarned = Number(packet.payload.totalEarned || appState.totalEarned);
            appState.todayEarned = Number(packet.payload.todayEarned || appState.todayEarned);
            appState.banks = Array.isArray(packet.payload.banks) ? packet.payload.banks : appState.banks;
            appState.withdrawals = Array.isArray(packet.payload.withdrawals) ? packet.payload.withdrawals : appState.withdrawals;
            renderAll(); saveState();
          }
          break;
        default:
          // ignore unknown
      }
    }

    function connectWebSocket(baseUrl) {
      if (!baseUrl) { startPolling(); return; }

      // If WS already open, close first
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        try { ws.close(1000, 'reconnect'); } catch (e) {}
      }

      const url = buildWsUrl(baseUrl);
      if (!url) { startPolling(); return; }

      try {
        const protocols = buildWsProtocols();
        ws = WS_USE_SUBPROTOCOL ? new WebSocket(url, protocols) : new WebSocket(url);
      } catch (err) {
        // Some browsers may reject subprotocol with big token; fallback to query param mode
        if (WS_USE_SUBPROTOCOL) {
          WS_USE_SUBPROTOCOL = false;
          const fallbackUrl = buildWsUrl(baseUrl);
          try { ws = new WebSocket(fallbackUrl); } catch (e) { startPolling(); return; }
        } else {
          startPolling(); return;
        }
      }

      ws.addEventListener('open', () => {
        resetWsBackoff();
        console.log('WS connected');
      });

      ws.addEventListener('message', (evt) => {
        try {
          const msg = JSON.parse(evt.data);
          handleRealtimeMessage(msg);
        } catch (e) {
          // ignore invalid
        }
      });

      ws.addEventListener('close', async (evt) => {
        console.warn('WS closed', evt.code, evt.reason);
        // If closure indicates auth required (custom code 4001/4003 or 1008), try refresh then reconnect
        const authErrorCodes = [4001, 4003, 1008]; // application-specific choices
        if (authErrorCodes.includes(evt.code) || evt.reason.toLowerCase().includes('auth')) {
          try {
            await refreshAuthToken();
            // immediate reconnect
            connectWebSocket(WS_URL_BASE);
            return;
          } catch (err) {
            // refresh failed -> clear auth and fallback to polling
            clearAuthToken();
            startPolling();
            return;
          }
        }
        // otherwise schedule reconnect with backoff
        scheduleWsReconnect();
      });

      ws.addEventListener('error', (err) => {
        console.warn('WS error', err);
      });
    }

    // -----------------------
    // Polling fallback
    // -----------------------
    let pollTimer = null;

    async function pollOnce() {
      if (!POLL_URL) return;
      try {
        const res = await authFetch(POLL_URL, { credentials: 'same-origin' });
        if (!res.ok) {
          // if 401, fetchWithRetry inside authFetch will attempt refresh
          return;
        }
        const json = await res.json();
        if (!json) return;
        if (typeof json.balance !== 'undefined') appState.balance = Number(json.balance);
        if (typeof json.totalEarned !== 'undefined') appState.totalEarned = Number(json.totalEarned);
        if (typeof json.todayEarned !== 'undefined') appState.todayEarned = Number(json.todayEarned);
        if (Array.isArray(json.banks)) appState.banks = json.banks.map(b => ({ id: b.id || generateId('b_'), name: b.name, accName: b.accName, accNumber: b.accNumber, accCode: b.accCode || '' }));
        if (Array.isArray(json.withdrawals)) appState.withdrawals = json.withdrawals.map(w => ({ id: w.id || generateId('w_'), amount: Number(w.amount), bankName: w.bankName, accNumber: w.accNumber, status: w.status || 'pending', date: w.date || Date.now() }));
        renderAll(); saveState();
      } catch (err) {
        // ignore
      }
    }

    function startPolling() {
      if (pollTimer) clearInterval(pollTimer);
      pollOnce();
      pollTimer = setInterval(pollOnce, POLL_INTERVAL);
    }

    // Initialize real-time layer
    if (WS_URL_BASE) connectWebSocket(WS_URL_BASE);
    else startPolling();

    // -----------------------
    // Initialization
    // -----------------------
    loadState();
    appState.banks = appState.banks || [];
    appState.withdrawals = appState.withdrawals || [];

    if (appState.banks.length === 0) {
      appState.banks.push({ id: generateId('b_'), name: 'BSP Bank', accName: 'John Doe', accNumber: '1234567890', accCode: 'BSP001' });
      appState.selectedBankId = appState.banks[0].id;
      appState.withdrawals.push({ id: generateId('w_'), amount: 15.50, bankName: 'BSP Bank', accNumber: '1234567890', status: 'success', date: Date.now() - 86400000 * 2 });
      appState.withdrawals.push({ id: generateId('w_'), amount: 8.25, bankName: 'BSP Bank', accNumber: '1234567890', status: 'pending', date: Date.now() - 86400000 });
      saveState();
    }

    renderAll();

    // deep link open
    const startUrl = new URL(window.location.href);
    if (startUrl.searchParams.get('wallet')) {
      const tab = startUrl.searchParams.get('tab') || 'withdraw';
      setTimeout(() => openWallet(tab, false), 260);
    }

    // -----------------------
    // Expose runtime API
    // -----------------------
    window.__wallet = window.__wallet || {};
    Object.assign(window.__wallet, {
      openWallet: (tab) => openWallet(tab || 'withdraw', true),
      closeWallet: () => closeWallet(true),
      renderAll,
      setAuthToken: (token, opts) => setAuthToken(token, opts || { persist: false }),
      setRefreshToken: (token, opts) => setRefreshToken(token, opts || { persist: false }),
      clearAuthToken,
      refreshAuthToken,
      setRetryOptions: (opts) => { RETRY_OPTIONS = Object.assign({}, RETRY_OPTIONS, opts || {}); },
      setWsSubprotocolMode: (enabled) => { WS_USE_SUBPROTOCOL = !!enabled; if (ws && ws.readyState === WebSocket.OPEN) { try { ws.close(1000, 'protocol-change'); } catch (e) {} ws = null; connectWebSocket(WS_URL_BASE); } },
      connectWebSocket: (u) => { if (u) connectWebSocket(u); },
      api: { addBank: apiAddBank, updateBank: apiUpdateBank, deleteBank: apiDeleteBank, withdraw: apiWithdraw },
      state: appState
    });

    console.log('Papure Watch wallet script loaded — auth & retries enabled.');
    console.log('Auth token present:', !!authToken);
  });
})();