(function() {
    'use strict';

    // ============================================
    // STATE
    // ============================================
    const state = {
        balance: 27.45,
        totalEarned: 142.80,
        todayEarned: 4.20,
        banks: [],
        withdrawals: [],
        selectedBankId: null,
        editingBankId: null,
        isProcessing: false,
    };

    // ============================================
    // DOM REFS
    // ============================================
    const $ = (sel) => document.querySelector(sel);
    const $$ = (sel) => document.querySelectorAll(sel);

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

    // ============================================
    // UTILITY
    // ============================================
    function formatK(amount) {
        return 'K' + amount.toFixed(2);
    }

    function generateId() {
        return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    }

    function getBankEmoji(name) {
        const map = {
            'BSP Bank': '🏦',
            'Kina Bank': '🏛️',
            'MiBank': '📱',
        };
        return map[name] || '🏦';
    }

    // ============================================
    // TOAST
    // ============================================
    function showToast(message, type = 'info', duration = 3600) {
        const icons = {
            success: 'fa-check-circle',
            error: 'fa-circle-exclamation',
            info: 'fa-circle-info',
        };
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        toast.innerHTML = `
                <span class="toast-icon"><i class="fas ${icons[type] || icons.info}"></i></span>
                <span>${message}</span>
            `;
        toastContainer.appendChild(toast);
        setTimeout(() => {
            if (toast.parentNode) toast.remove();
        }, duration);
    }

    // ============================================
    // LOCAL STORAGE
    // ============================================
    function loadState() {
        try {
            const saved = localStorage.getItem('papure_wallet');
            if (saved) {
                const parsed = JSON.parse(saved);
                Object.assign(state, parsed);
                state.banks = state.banks || [];
                state.withdrawals = state.withdrawals || [];
            }
        } catch (_) {}
    }

    function saveState() {
        try {
            const data = {
                balance: state.balance,
                totalEarned: state.totalEarned,
                todayEarned: state.todayEarned,
                banks: state.banks,
                withdrawals: state.withdrawals,
            };
            localStorage.setItem('papure_wallet', JSON.stringify(data));
        } catch (_) {}
    }

    // ============================================
    // RENDER
    // ============================================
    function renderBalance() {
        balanceDisplay.textContent = state.balance.toFixed(2);
        headerBadge.textContent = formatK(state.balance);
        todayEarnings.textContent = formatK(state.todayEarned);
        totalEarnings.textContent = formatK(state.totalEarned);
        maxWithdrawLabel.textContent = formatK(state.balance);
        withdrawAmount.min = 1;
        withdrawAmount.max = state.balance;
        withdrawAmount.placeholder = `0.00 (max ${state.balance.toFixed(2)})`;
    }

    function renderBankSelect() {
        bankSelectGrid.innerHTML = '';
        if (state.banks.length === 0) {
            bankSelectGrid.innerHTML =
                `<div class="text-muted" style="grid-column:1/-1;padding:0.6rem;text-align:center;font-size:0.8rem;">No banks saved. Add one in the Banks tab.</div>`;
            bankSelectHint.textContent = 'Please add a bank first.';
            state.selectedBankId = null;
            return;
        }

        state.banks.forEach(bank => {
            const card = document.createElement('div');
            card.className = `bank-select-card${state.selectedBankId === bank.id ? ' selected' : ''}`;
            card.dataset.bankId = bank.id;
            card.innerHTML = `
                    <span class="bank-icon">${getBankEmoji(bank.name)}</span>
                    <span>${bank.name}</span>
                `;
            card.addEventListener('click', () => selectBank(bank.id));
            bankSelectGrid.appendChild(card);
        });

        if (!state.selectedBankId && state.banks.length > 0) {
            selectBank(state.banks[0].id);
        } else if (state.selectedBankId && !state.banks.find(b => b.id === state.selectedBankId)) {
            selectBank(state.banks[0].id);
        }
        bankSelectHint.textContent = state.banks.length > 0 ? 'Click a bank to select it.' : 'No banks saved.';
    }

    function selectBank(bankId) {
        state.selectedBankId = bankId;
        const bank = state.banks.find(b => b.id === bankId);
        if (bank) {
            accName.value = bank.accName || '';
            accNumber.value = bank.accNumber || '';
            accCode.value = bank.accCode || '';
        }
        renderBankSelect();
        saveState();
    }

    function renderSavedBanks() {
        savedBanksList.innerHTML = '';
        if (state.banks.length === 0) {
            savedBanksList.innerHTML = `
                    <div class="empty-state">
                        <div class="empty-icon"><i class="fas fa-building-columns"></i></div>
                        <p>No banks saved yet</p>
                    </div>
                `;
            return;
        }

        state.banks.forEach(bank => {
            const item = document.createElement('div');
            item.className = 'saved-bank-item';
            item.innerHTML = `
                    <div class="bank-info">
                        <span style="font-size:1.4rem;">${getBankEmoji(bank.name)}</span>
                        <div>
                            <div class="bank-name">${bank.name}</div>
                            <div class="bank-detail">${bank.accName} · ${bank.accNumber}${bank.accCode ? ' · '+bank.accCode : ''}</div>
                        </div>
                    </div>
                    <div class="bank-actions">
                        <button class="edit-btn" data-id="${bank.id}" title="Edit"><i class="fas fa-pen"></i></button>
                        <button class="delete-btn" data-id="${bank.id}" title="Delete"><i class="fas fa-trash-can"></i></button>
                    </div>
                `;
            savedBanksList.appendChild(item);

            item.querySelector('.edit-btn').addEventListener('click', () => openBankForm(bank.id));
            item.querySelector('.delete-btn').addEventListener('click', () => {
                if (confirm(`Delete "${bank.name}" account?`)) deleteBank(bank.id);
            });
        });
    }

    function renderHistory() {
        historyList.innerHTML = '';
        if (state.withdrawals.length === 0) {
            historyList.innerHTML = `
                    <div class="empty-state">
                        <div class="empty-icon"><i class="fas fa-clock-rotate-left"></i></div>
                        <p>No withdrawal history yet</p>
                    </div>
                `;
            return;
        }

        const sorted = [...state.withdrawals].reverse();
        sorted.forEach(w => {
            const item = document.createElement('div');
            item.className = `history-item status-${w.status}`;
            const statusLabel = w.status.charAt(0).toUpperCase() + w.status.slice(1);
            const dateStr = new Date(w.date).toLocaleDateString('en-US', {
                month: 'short',
                day: 'numeric',
                year: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
            });
            item.innerHTML = `
                    <div class="h-left">
                        <div class="h-amount">K${w.amount.toFixed(2)}</div>
                        <div class="h-meta">${w.bankName} · ${w.accNumber} · ${dateStr}</div>
                    </div>
                    <span class="h-status ${w.status}">${statusLabel}</span>
                `;
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

    // ============================================
    // BANK CRUD
    // ============================================
    function addBank(name, accNameVal, accNumberVal, accCodeVal) {
        const bank = {
            id: generateId(),
            name: name.trim(),
            accName: accNameVal.trim(),
            accNumber: accNumberVal.trim(),
            accCode: accCodeVal.trim() || '',
        };
        state.banks.push(bank);
        state.selectedBankId = bank.id;
        renderAll();
        showToast(`Bank "${bank.name}" added successfully!`, 'success');
        closeBankForm();
    }

    function updateBank(id, name, accNameVal, accNumberVal, accCodeVal) {
        const bank = state.banks.find(b => b.id === id);
        if (!bank) return;
        bank.name = name.trim();
        bank.accName = accNameVal.trim();
        bank.accNumber = accNumberVal.trim();
        bank.accCode = accCodeVal.trim() || '';
        renderAll();
        showToast(`Bank "${bank.name}" updated!`, 'success');
        closeBankForm();
    }

    function deleteBank(id) {
        state.banks = state.banks.filter(b => b.id !== id);
        if (state.selectedBankId === id) {
            state.selectedBankId = state.banks.length > 0 ? state.banks[0].id : null;
        }
        renderAll();
        showToast('Bank removed.', 'info');
    }

    function openBankForm(editId = null) {
        state.editingBankId = editId;
        bankFormContainer.style.display = 'block';

        if (editId) {
            const bank = state.banks.find(b => b.id === editId);
            if (bank) {
                bankFormTitle.textContent = 'Edit Bank';
                bankNameSelect.value = bank.name;
                bankFormAccName.value = bank.accName;
                bankFormAccNumber.value = bank.accNumber;
                bankFormAccCode.value = bank.accCode || '';
                bankFormSaveBtn.querySelector('.btn-text').textContent = 'Update Bank';
            }
        } else {
            bankFormTitle.textContent = 'Add Bank';
            bankNameSelect.value = 'BSP Bank';
            bankFormAccName.value = '';
            bankFormAccNumber.value = '';
            bankFormAccCode.value = '';
            bankFormSaveBtn.querySelector('.btn-text').textContent = 'Save Bank';
        }
        bankFormContainer.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    function closeBankForm() {
        bankFormContainer.style.display = 'none';
        state.editingBankId = null;
        bankFormSaveBtn.classList.remove('loading');
    }

    // ============================================
    // WITHDRAWAL
    // ============================================
    function processWithdrawal(amount, bankId) {
        if (state.isProcessing) return;
        const bank = state.banks.find(b => b.id === bankId);
        if (!bank) {
            showToast('Please select a bank.', 'error');
            return;
        }

        const nameVal = accName.value.trim();
        const numVal = accNumber.value.trim();
        if (!nameVal || !numVal) {
            showToast('Please fill in account name and number.', 'error');
            return;
        }

        if (amount < 1) {
            showToast('Minimum withdrawal is K1.00.', 'error');
            return;
        }
        if (amount > state.balance) {
            showToast('Insufficient balance.', 'error');
            return;
        }

        state.isProcessing = true;
        withdrawBtn.classList.add('loading');
        withdrawBtn.disabled = true;

        setTimeout(() => {
            state.balance -= amount;
            state.withdrawals.push({
                id: generateId(),
                amount: amount,
                bankName: bank.name,
                accNumber: bank.accNumber,
                status: 'success',
                date: Date.now(),
            });

            state.isProcessing = false;
            withdrawBtn.classList.remove('loading');
            withdrawBtn.disabled = false;

            renderAll();
            saveState();

            successOverlay.classList.add('active');
            withdrawAmount.value = '';
            showToast(`Withdrawal of K${amount.toFixed(2)} to ${bank.name} successful!`, 'success');
        }, 1800);
    }

    // ============================================
    // EVENT BINDING
    // ============================================

    function openWallet() {
        renderAll();
        overlay.classList.add('active');
        document.body.style.overflow = 'hidden';
        successOverlay.classList.remove('active');
        withdrawBtn.classList.remove('loading');
        withdrawBtn.disabled = false;
        state.isProcessing = false;
    }

    function closeWallet() {
        overlay.classList.remove('active');
        document.body.style.overflow = '';
        closeBankForm();
        successOverlay.classList.remove('active');
    }

    toggleBtn.addEventListener('click', openWallet);
    closeBtn.addEventListener('click', closeWallet);
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closeWallet();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeWallet();
    });

    $$('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            $$('.tab-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            $$('.tab-content').forEach(c => c.classList.remove('active'));
            const target = document.getElementById('tab' + btn.dataset.tab.charAt(0).toUpperCase() + btn.dataset
                .tab.slice(1));
            if (target) target.classList.add('active');
            if (btn.dataset.tab === 'banks') renderSavedBanks();
            if (btn.dataset.tab === 'history') renderHistory();
        });
    });

    withdrawForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const amount = parseFloat(withdrawAmount.value);
        if (isNaN(amount) || amount <= 0) {
            showToast('Please enter a valid amount.', 'error');
            return;
        }
        if (!state.selectedBankId) {
            showToast('Please select a bank.', 'error');
            return;
        }
        const bank = state.banks.find(b => b.id === state.selectedBankId);
        if (!bank) {
            showToast('Selected bank no longer exists.', 'error');
            state.selectedBankId = state.banks.length > 0 ? state.banks[0].id : null;
            renderAll();
            return;
        }
        processWithdrawal(amount, state.selectedBankId);
    });

    successOkBtn.addEventListener('click', () => {
        successOverlay.classList.remove('active');
    });

    addBankBtn.addEventListener('click', () => openBankForm(null));

    bankFormSaveBtn.addEventListener('click', () => {
        const name = bankNameSelect.value.trim();
        const accNameVal = bankFormAccName.value.trim();
        const accNumberVal = bankFormAccNumber.value.trim();
        const accCodeVal = bankFormAccCode.value.trim();

        if (!name || !accNameVal || !accNumberVal) {
            showToast('Please fill in all required fields.', 'error');
            return;
        }

        if (state.editingBankId) {
            updateBank(state.editingBankId, name, accNameVal, accNumberVal, accCodeVal);
        } else {
            const dup = state.banks.find(b =>
                b.name === name &&
                b.accNumber === accNumberVal &&
                b.accName === accNameVal
            );
            if (dup) {
                showToast('This bank account already exists.', 'error');
                return;
            }
            addBank(name, accNameVal, accNumberVal, accCodeVal);
        }
    });

    bankFormCancelBtn.addEventListener('click', closeBankForm);

    // ============================================
    // INIT
    // ============================================
    loadState();
    state.banks = state.banks || [];
    state.withdrawals = state.withdrawals || [];

    if (state.banks.length === 0) {
        state.banks.push({
            id: generateId(),
            name: 'BSP Bank',
            accName: 'John Doe',
            accNumber: '1234567890',
            accCode: 'BSP001',
        });
        state.selectedBankId = state.banks[0].id;
        state.withdrawals.push({
            id: generateId(),
            amount: 15.50,
            bankName: 'BSP Bank',
            accNumber: '1234567890',
            status: 'success',
            date: Date.now() - 86400000 * 2,
        });
        state.withdrawals.push({
            id: generateId(),
            amount: 8.25,
            bankName: 'BSP Bank',
            accNumber: '1234567890',
            status: 'pending',
            date: Date.now() - 86400000,
        });
        saveState();
    }

    renderAll();

    if (window.location.search.includes('wallet')) {
        setTimeout(openWallet, 400);
    }

    window.__wallet = { state, openWallet, closeWallet, renderAll };

    console.log('🇵🇬 Papure Watch Wallet System loaded.');
    console.log('📊 State:', state);

})();