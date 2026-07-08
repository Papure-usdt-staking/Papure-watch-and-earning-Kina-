(function() {
    'use strict';

    // ============================================
    // STATE (extended)
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
        // new features
        transactionPin: '1234', // default
        dailyLimit: 100.00,
        todayWithdrawn: 0.00, // reset each day
        lastWithdrawDate: null, // date string for today check
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
    const dailyLimitDisplay = $('#dailyLimitDisplay');
    const todayWithdrawnDisplay = $('#todayWithdrawn');
    const feeDisplay = $('#feeDisplay');

    const bankSelectGrid = $('#bankSelectGrid');
    const bankSelectHint = $('#bankSelectHint');
    const accName = $('#accName');
    const accNumber = $('#accNumber');
    const accCode = $('#accCode');
    const withdrawAmount = $('#withdrawAmount');
    const withdrawForm = $('#withdrawForm');
    const withdrawBtn = $('#withdrawSubmitBtn');
    const transactionPinInput = $('#transactionPin');
    const pinHint = $('#pinHint');

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
    const successMessage = $('#successMessage');

    const toastContainer = $('#toastContainer');

    // Settings
    const currentPinInput = $('#currentPin');
    const newPinInput = $('#newPin');
    const confirmPinInput = $('#confirmPin');
    const changePinBtn = $('#changePinBtn');
    const dailyLimitInput = $('#dailyLimitInput');
    const updateLimitBtn = $('#updateLimitBtn');

    // Proof feed
    const proofFeedList = $('#proofFeedList');
    const proofCount = $('#proofCount');

    // ============================================
    // UTILITY
    // ============================================
    function formatK(amount) {
        amount = Number(amount);
        if (!isFinite(amount)) amount = 0;
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

    function getToday() {
        return new Date().toISOString().split('T')[0];
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
            if (!saved) return;
            const parsed = JSON.parse(saved);

            // coerce numeric fields and provide defaults
            state.balance = Number(parsed.balance ?? state.balance ?? 0) || 0;
            state.totalEarned = Number(parsed.totalEarned ?? state.totalEarned ?? 0) || 0;
            state.todayEarned = Number(parsed.todayEarned ?? state.todayEarned ?? 0) || 0;
            state.banks = Array.isArray(parsed.banks) ? parsed.banks : (state.banks || []);
            state.withdrawals = Array.isArray(parsed.withdrawals) ? parsed.withdrawals : (state.withdrawals || []);
            state.transactionPin = parsed.transactionPin ? String(parsed.transactionPin) : (state.transactionPin || '1234');
            state.dailyLimit = Number(parsed.dailyLimit ?? state.dailyLimit ?? 100.00) || 100.00;
            state.todayWithdrawn = Number(parsed.todayWithdrawn ?? 0) || 0;
            state.lastWithdrawDate = parsed.lastWithdrawDate || getToday();

            // Reset today's withdrawn if new day
            if (state.lastWithdrawDate !== getToday()) {
                state.todayWithdrawn = 0.00;
                state.lastWithdrawDate = getToday();
            }
        } catch (err) {
            // don't let a bad localStorage value stop the app
            console.error('Failed to load papure_wallet from localStorage:', err);
        }
    }

    function saveState() {
        try {
            const data = {
                balance: Number(state.balance) || 0,
                totalEarned: Number(state.totalEarned) || 0,
                todayEarned: Number(state.todayEarned) || 0,
                banks: state.banks,
                withdrawals: state.withdrawals,
                transactionPin: String(state.transactionPin || '1234'),
                dailyLimit: Number(state.dailyLimit) || 100,
                todayWithdrawn: Number(state.todayWithdrawn) || 0,
                lastWithdrawDate: state.lastWithdrawDate || getToday(),
            };
            localStorage.setItem('papure_wallet', JSON.stringify(data));
        } catch (_) {}
    }

    // ============================================
    // RENDER
    // ============================================
    function renderBalance() {
        const bal = Number(state.balance) || 0;
        const today = Number(state.todayEarned) || 0;
        const total = Number(state.totalEarned) || 0;
        const dailyLimit = Number(state.dailyLimit) || 0;
        const todayWd = Number(state.todayWithdrawn) || 0;

        if (balanceDisplay) balanceDisplay.textContent = bal.toFixed(2);
        if (headerBadge) headerBadge.textContent = formatK(bal);
        if (todayEarnings) todayEarnings.textContent = formatK(today);
        if (totalEarnings) totalEarnings.textContent = formatK(total);
        if (maxWithdrawLabel) maxWithdrawLabel.textContent = formatK(bal);
        if (dailyLimitDisplay) dailyLimitDisplay.textContent = formatK(dailyLimit);
        if (todayWithdrawnDisplay) todayWithdrawnDisplay.textContent = formatK(todayWd);

        // Fee display
        const amount = parseFloat(withdrawAmount && withdrawAmount.value ? withdrawAmount.value : 0) || 0;
        const fee = calculateFee(amount);
        if (feeDisplay) feeDisplay.innerHTML = `Fee: <strong>${formatK(fee)}</strong>`;

        if (withdrawAmount) {
            withdrawAmount.min = 1;
            withdrawAmount.max = bal;
            withdrawAmount.placeholder = `0.00 (max ${bal.toFixed(2)})`;
        }
    }

    function calculateFee(amount) {
        amount = Number(amount) || 0;
        if (amount <= 0) return 0;
        // Example: 2% fee, min 0.50 K
        let fee = amount * 0.02;
        if (fee < 0.50) fee = 0.50;
        return Math.min(fee, amount); // fee cannot exceed amount
    }

    function renderBankSelect() {
        if (!bankSelectGrid) return;
        bankSelectGrid.innerHTML = '';
        if (state.banks.length === 0) {
            bankSelectGrid.innerHTML =
                `<div class="text-muted" style="grid-column:1/-1;padding:0.6rem;text-align:center;font-size:0.8rem;">No banks saved. Add one in the Banks tab.</div>`;
            if (bankSelectHint) bankSelectHint.textContent = 'Please add a bank first.';
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
        if (bankSelectHint) bankSelectHint.textContent = state.banks.length > 0 ? 'Click a bank to select it.' : 'No banks saved.';
    }

    function selectBank(bankId) {
        state.selectedBankId = bankId;
        const bank = state.banks.find(b => b.id === bankId);
        if (bank) {
            if (accName) accName.value = bank.accName || '';
            if (accNumber) accNumber.value = bank.accNumber || '';
            if (accCode) accCode.value = bank.accCode || '';
        }
        renderBankSelect();
        saveState();
    }

    function renderSavedBanks() {
        if (!savedBanksList) return;
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
        if (!historyList) return;
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
            const feeText = w.fee ? ` (fee ${formatK(w.fee)})` : '';
            item.innerHTML = `
                    <div class="h-left">
                        <div class="h-amount">K${(Number(w.amount)||0).toFixed(2)}${feeText}</div>
                        <div class="h-meta">${w.bankName} · ${w.accNumber} · ${dateStr}</div>
                    </div>
                    <span class="h-status ${w.status}">${statusLabel}</span>
                `;
            historyList.appendChild(item);
        });
    }

    // Proof feed – show recent successful withdrawals
    function renderProofFeed() {
        if (!proofFeedList) return;
        const successes = state.withdrawals.filter(w => w.status === 'success').slice(-5).reverse();
        if (successes.length === 0) {
            proofFeedList.innerHTML = `<div class="text-white/30 text-sm py-4">No recent payouts yet</div>`;
            if (proofCount) proofCount.textContent = '0';
            return;
        }
        if (proofCount) proofCount.textContent = String(successes.length);
        let html = '';
        successes.forEach(w => {
            const dateStr = new Date(w.date).toLocaleDateString('en-US', {
                month: 'short',
                day: 'numeric',
            });
            html += `
                    <div class="flex items-center justify-between bg-white/5 rounded-lg p-2 text-left">
                        <div>
                            <span class="font-bold text-[#FCD116]">${formatK(w.amount)}</span>
                            <span class="text-xs text-white/40 ml-2">${w.bankName}</span>
                        </div>
                        <span class="text-xs text-white/30">${dateStr}</span>
                    </div>
                `;
        });
        proofFeedList.innerHTML = html;
    }

    function renderAll() {
        renderBalance();
        renderBankSelect();
        renderSavedBanks();
        renderHistory();
        renderProofFeed();
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
        if (bankFormContainer) bankFormContainer.style.display = 'block';

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
        if (bankFormContainer) bankFormContainer.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    function closeBankForm() {
        if (bankFormContainer) bankFormContainer.style.display = 'none';
        state.editingBankId = null;
        bankFormSaveBtn.classList.remove('loading');
    }

    // ============================================
    // WITHDRAWAL (with fee, PIN, daily limit)
    // ============================================
    function processWithdrawal(amount, bankId, pin) {
        if (state.isProcessing) return;
        const bank = state.banks.find(b => b.id === bankId);
        if (!bank) {
            showToast('Please select a bank.', 'error');
            return;
        }

        const nameVal = accName && accName.value ? accName.value.trim() : '';
        const numVal = accNumber && accNumber.value ? accNumber.value.trim() : '';
        if (!nameVal || !numVal) {
            showToast('Please fill in account name and number.', 'error');
            return;
        }

        // Validate PIN
        if (pin !== state.transactionPin) {
            showToast('Invalid PIN. Please try again.', 'error');
            return;
        }

        amount = Number(amount) || 0;

        // Check daily limit
        if (state.todayWithdrawn + amount > state.dailyLimit) {
            showToast(`Daily limit of ${formatK(state.dailyLimit)} exceeded. Today's remaining: ${formatK(state.dailyLimit - state.todayWithdrawn)}`, 'error');
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

        // Calculate fee
        const fee = calculateFee(amount);
        const totalDeduct = amount + fee;
        if (totalDeduct > state.balance) {
            showToast(`Insufficient balance to cover amount + fee (${formatK(totalDeduct)}).`, 'error');
            return;
        }

        state.isProcessing = true;
        if (withdrawBtn) {
            withdrawBtn.classList.add('loading');
            withdrawBtn.disabled = true;
        }

        setTimeout(() => {
            // Deduct amount + fee
            state.balance = Number(state.balance) - totalDeduct;
            // Update today's withdrawn
            state.todayWithdrawn = Number(state.todayWithdrawn) + amount;
            state.lastWithdrawDate = getToday();

            // Record withdrawal with fee
            state.withdrawals.push({
                id: generateId(),
                amount: amount,
                fee: fee,
                bankName: bank.name,
                accNumber: bank.accNumber,
                status: 'success',
                date: Date.now(),
            });

            state.isProcessing = false;
            if (withdrawBtn) {
                withdrawBtn.classList.remove('loading');
                withdrawBtn.disabled = false;
            }

            renderAll();
            saveState();

            if (successMessage) successMessage.textContent = `K${amount.toFixed(2)} + fee ${formatK(fee)} withdrawn successfully.`;
            if (successOverlay) successOverlay.classList.add('active');
            if (withdrawAmount) withdrawAmount.value = '';
            if (transactionPinInput) transactionPinInput.value = '';
            showToast(`Withdrawal of K${amount.toFixed(2)} to ${bank.name} successful! (fee ${formatK(fee)})`, 'success');
        }, 1800);
    }

    // ============================================
    // SETTINGS: Change PIN, Update Limit
    // ============================================
    function changePin() {
        const current = currentPinInput && currentPinInput.value ? currentPinInput.value.trim() : '';
        const newPin = newPinInput && newPinInput.value ? newPinInput.value.trim() : '';
        const confirm = confirmPinInput && confirmPinInput.value ? confirmPinInput.value.trim() : '';

        if (!current || !newPin || !confirm) {
            showToast('Please fill in all fields.', 'error');
            return;
        }
        if (current !== state.transactionPin) {
            showToast('Current PIN is incorrect.', 'error');
            return;
        }
        if (newPin.length !== 4 || isNaN(newPin)) {
            showToast('New PIN must be 4 digits.', 'error');
            return;
        }
        if (newPin !== confirm) {
            showToast('New PIN and confirmation do not match.', 'error');
            return;
        }
        state.transactionPin = newPin;
        if (pinHint) pinHint.textContent = 'PIN updated successfully.';
        saveState();
        if (currentPinInput) currentPinInput.value = '';
        if (newPinInput) newPinInput.value = '';
        if (confirmPinInput) confirmPinInput.value = '';
        showToast('Transaction PIN changed successfully!', 'success');
    }

    function updateDailyLimit() {
        const val = parseFloat(dailyLimitInput && dailyLimitInput.value ? dailyLimitInput.value : NaN);
        if (isNaN(val) || val < 10) {
            showToast('Please enter a limit of at least K10.00.', 'error');
            return;
        }
        state.dailyLimit = val;
        saveState();
        renderBalance();
        showToast(`Daily limit updated to ${formatK(val)}.`, 'success');
    }

    // ============================================
    // EVENT BINDING
    // ============================================

    function openWallet() {
        renderAll();
        if (overlay) overlay.classList.add('active');
        document.body.style.overflow = 'hidden';
        if (successOverlay) successOverlay.classList.remove('active');
        if (withdrawBtn) {
            withdrawBtn.classList.remove('loading');
            withdrawBtn.disabled = false;
        }
        state.isProcessing = false;
        // show current PIN hint
        if (pinHint) pinHint.textContent = `Default: 1234 (current: ${state.transactionPin})`;
        if (dailyLimitInput) dailyLimitInput.value = state.dailyLimit;
    }

    function closeWallet() {
        if (overlay) overlay.classList.remove('active');
        document.body.style.overflow = '';
        closeBankForm();
        if (successOverlay) successOverlay.classList.remove('active');
    }

    if (toggleBtn) toggleBtn.addEventListener('click', openWallet);
    if (closeBtn) closeBtn.addEventListener('click', closeWallet);
    if (overlay) overlay.addEventListener('click', (e) => {
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
            if (btn.dataset.tab === 'settings') {
                if (dailyLimitInput) dailyLimitInput.value = state.dailyLimit;
                if (pinHint) pinHint.textContent = `Current PIN: ${state.transactionPin}`;
            }
        });
    });

    // Withdraw form
    if (withdrawForm) {
        withdrawForm.addEventListener('submit', (e) => {
            e.preventDefault();
            const amount = parseFloat(withdrawAmount && withdrawAmount.value ? withdrawAmount.value : NaN);
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
            const pin = transactionPinInput && transactionPinInput.value ? transactionPinInput.value.trim() : '';
            if (!pin || pin.length !== 4) {
                showToast('Please enter your 4-digit PIN.', 'error');
                return;
            }
            processWithdrawal(amount, state.selectedBankId, pin);
        });
    }

    // Amount input change to update fee
    if (withdrawAmount) withdrawAmount.addEventListener('input', renderBalance);

    if (successOkBtn) successOkBtn.addEventListener('click', () => {
        if (successOverlay) successOverlay.classList.remove('active');
    });

    if (addBankBtn) addBankBtn.addEventListener('click', () => openBankForm(null));

    if (bankFormSaveBtn) bankFormSaveBtn.addEventListener('click', () => {
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

    if (bankFormCancelBtn) bankFormCancelBtn.addEventListener('click', closeBankForm);

    // Settings buttons
    if (changePinBtn) changePinBtn.addEventListener('click', changePin);
    if (updateLimitBtn) updateLimitBtn.addEventListener('click', updateDailyLimit);

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
            fee: 0.50,
            bankName: 'BSP Bank',
            accNumber: '1234567890',
            status: 'success',
            date: Date.now() - 86400000 * 2,
        });
        state.withdrawals.push({
            id: generateId(),
            amount: 8.25,
            fee: 0.50,
            bankName: 'BSP Bank',
            accNumber: '1234567890',
            status: 'pending',
            date: Date.now() - 86400000,
        });
        // Today's withdrawals
        state.todayWithdrawn = 0;
        state.lastWithdrawDate = getToday();
        saveState();
    }

    renderAll();

    if (window.location.search.includes('wallet')) {
        setTimeout(openWallet, 400);
    }

    window.__wallet = { state, openWallet, closeWallet, renderAll };

    console.log('🇵🇬 Papure Watch Enhanced Wallet System loaded.');
    console.log('📊 State:', state);

})();
