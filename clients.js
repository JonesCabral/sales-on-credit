import { getDatabase, ref, onValue, update, get, push } from 'firebase/database';
import { getAuth, onAuthStateChanged } from 'firebase/auth';
import { firebaseApp } from './firebase.js';

const database = getDatabase(firebaseApp);
const auth = getAuth(firebaseApp);

const DEFAULT_OVERDUE_RESET_PAYMENT_PERCENT = 20;
const MAX_CLIENT_NAME_LENGTH = 100;
const MAX_SALE_DESCRIPTION_LENGTH = 500;
const MAX_SALE_AMOUNT_CENTS = 100000000;
const SEARCH_DEBOUNCE_MS = 160;
const currencyFormatter = new Intl.NumberFormat('pt-BR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
});

const clientForm = document.getElementById('clientForm');
const clientNameInput = document.getElementById('clientName');
const addInitialSaleInput = document.getElementById('addInitialSale');
const initialSaleFields = document.getElementById('initialSaleFields');
const initialSaleAmountInput = document.getElementById('initialSaleAmount');
const initialSaleDescriptionInput = document.getElementById('initialSaleDescription');
const saveClientBtn = document.getElementById('saveClientBtn');
const clientsStatus = document.getElementById('clientsStatus');
const clientsSearch = document.getElementById('clientsSearch');
const clientsList = document.getElementById('clientsList');
const clientsCount = document.getElementById('clientsCount');
const toast = document.getElementById('toast');
const themeToggle = document.getElementById('themeToggle');
const clientsMenu = document.getElementById('clientsMenu');
const clientsMenuOverlay = document.getElementById('clientsMenuOverlay');
const clientsMenuToggle = document.getElementById('clientsMenuToggle');
const clientsMenuClose = document.getElementById('clientsMenuClose');

let currentUserId = null;
let clientSummaries = {};
let clientsUnsubscribe = null;
let isSaving = false;

function debounce(callback, delay) {
    let timeoutId = null;
    return (...args) => {
        window.clearTimeout(timeoutId);
        timeoutId = window.setTimeout(() => callback(...args), delay);
    };
}

function sanitizeHTML(value) {
    const div = document.createElement('div');
    div.textContent = String(value || '');
    return div.innerHTML;
}

function normalizeText(value) {
    return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

function normalizeClientName(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function formatCurrencyFromCents(value) {
    const cents = Number(value);
    const amount = Number.isFinite(cents) ? Math.round(cents) / 100 : 0;
    return currencyFormatter.format(Object.is(amount, -0) ? 0 : amount);
}

function parseCurrencyToCents(value) {
    const normalized = String(value || '').trim().replace(/\./g, '').replace(',', '.');
    const amount = Number.parseFloat(normalized);
    return Number.isFinite(amount) ? Math.round((amount + Number.EPSILON) * 100) : 0;
}

function setupCurrencyMask(input) {
    if (!input) return;
    input.addEventListener('input', () => {
        let digits = input.value.replace(/\D/g, '').replace(/^0+/, '') || '0';
        digits = digits.padStart(3, '0');
        const cents = digits.slice(-2);
        const reais = digits.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
        input.value = `${reais},${cents}`;
    });
    input.addEventListener('focus', () => window.setTimeout(() => input.select(), 0));
}

function setInitialSaleVisibility(shouldShow = Boolean(addInitialSaleInput?.checked)) {
    if (!initialSaleFields || !initialSaleAmountInput) return;
    initialSaleFields.hidden = !shouldShow;
    initialSaleAmountInput.required = shouldShow;
    if (shouldShow) window.setTimeout(() => initialSaleAmountInput.focus(), 0);
}

function createTransactionId(type = 'sale') {
    return `${Date.now()}_${type}_${Math.random().toString(36).slice(2, 8)}`;
}

function getVisibleSummaries() {
    const search = normalizeText(clientsSearch?.value || '');
    return Object.entries(clientSummaries || {})
        .filter(([clientId]) => clientId !== '_meta')
        .map(([clientId, summary]) => ({ id: summary?.id || clientId, ...summary }))
        .filter((client) => !search || normalizeText(client.name).includes(search))
        .sort((a, b) => {
            if (Boolean(a.archived) !== Boolean(b.archived)) return a.archived ? 1 : -1;
            return String(a.name || '').localeCompare(String(b.name || ''), 'pt-BR');
        });
}

function setStatus(message, type = 'neutral') {
    if (!clientsStatus) return;
    clientsStatus.textContent = message;
    clientsStatus.dataset.status = type;
}

function showToast(message, type = 'success') {
    if (!toast) return;
    const toastMessage = toast.querySelector('.toast-message');
    const toastIcon = toast.querySelector('.toast-icon');
    if (toastMessage) toastMessage.textContent = message;
    if (toastIcon) toastIcon.textContent = type === 'error' ? '!' : '\u2713';

    toast.classList.remove('toast-success', 'toast-error', 'show');
    toast.classList.add(type === 'error' ? 'toast-error' : 'toast-success');
    window.requestAnimationFrame(() => toast.classList.add('show'));
    window.clearTimeout(showToast.hideTimeout);
    showToast.hideTimeout = window.setTimeout(() => toast.classList.remove('show'), 3200);
}

function setFormDisabled(disabled) {
    isSaving = disabled;
    [clientNameInput, addInitialSaleInput, initialSaleAmountInput, initialSaleDescriptionInput].forEach((field) => {
        if (field) field.disabled = disabled;
    });
    if (saveClientBtn) {
        saveClientBtn.disabled = disabled;
        saveClientBtn.textContent = disabled ? 'Adicionando...' : 'Adicionar cliente';
    }
}

function renderClients() {
    if (!clientsList) return;

    const clients = getVisibleSummaries();
    const total = Object.keys(clientSummaries || {}).filter((clientId) => clientId !== '_meta').length;
    if (clientsCount) {
        clientsCount.textContent = `${clients.length} de ${total} cliente${total === 1 ? '' : 's'}`;
    }

    if (clients.length === 0) {
        clientsList.innerHTML = `<p class="empty-message">${total === 0 ? 'Nenhum cliente cadastrado ainda.' : 'Nenhum cliente encontrado.'}</p>`;
        return;
    }

    clientsList.innerHTML = clients.map((client) => {
        const balanceCents = Number(client.baseDebtCents) || 0;
        const balanceClass = balanceCents > 0 ? 'has-debt' : balanceCents < 0 ? 'has-credit' : 'is-paid';
        const salesCount = Number(client.salesCount) || 0;
        const statusText = client.archived
            ? 'Arquivado'
            : salesCount === 0
                ? 'Sem vendas registradas'
                : `${salesCount} venda${salesCount === 1 ? '' : 's'} registrada${salesCount === 1 ? '' : 's'}`;

        return `
            <article class="client-directory-item ${client.archived ? 'is-archived' : ''}">
                <div class="client-directory-main">
                    <div class="client-directory-title-row">
                        <h3>${sanitizeHTML(client.name || 'Cliente')}</h3>
                        ${client.archived ? '<span class="archived-badge">Arquivado</span>' : ''}
                    </div>
                    <p class="client-directory-meta">${sanitizeHTML(statusText)}</p>
                </div>
                <div class="client-directory-side">
                    <div class="client-directory-balance ${balanceClass}">
                        <span>Saldo</span>
                        <strong>R$ ${formatCurrencyFromCents(balanceCents)}</strong>
                    </div>
                    <div class="client-directory-actions">
                        <a class="btn btn-primary client-directory-action" href="index.html?client=${encodeURIComponent(client.id)}&amp;screen=sale">Nova venda</a>
                        <a class="btn btn-secondary client-directory-action" href="index.html?client=${encodeURIComponent(client.id)}&amp;screen=settings" title="Editar, arquivar ou excluir cliente">Configurar</a>
                    </div>
                </div>
            </article>
        `;
    }).join('');
}

function subscribeClients(userId) {
    if (clientsUnsubscribe) clientsUnsubscribe();
    clientsList.innerHTML = '<p class="empty-message">Carregando clientes...</p>';

    clientsUnsubscribe = onValue(ref(database, `users/${userId}/clientSummaries`), (snapshot) => {
        clientSummaries = snapshot.val() || {};
        renderClients();
    }, (error) => {
        console.error('Erro ao carregar clientes:', error);
        clientSummaries = {};
        clientsList.innerHTML = '<p class="empty-message">Não foi possível carregar os clientes.</p>';
        setStatus('Erro ao carregar clientes. Verifique sua conexão.', 'error');
    });
}

function buildPublicClientSummary(initialSale, resetPaymentPercent) {
    const amountCents = Number(initialSale?.amountCents) || 0;
    return {
        version: 1,
        baseDebtCents: amountCents,
        principalDebtCents: amountCents,
        outstandingInterestCents: 0,
        transactionCount: initialSale ? 1 : 0,
        referenceDate: initialSale?.date || null,
        lastAutomaticInterestDate: null,
        overdueResetPaymentPercent: resetPaymentPercent,
        overdueInterestOverride: null
    };
}

function buildClientSummary(clientId, name, createdAt, resetPaymentPercent, initialSale) {
    return {
        ...buildPublicClientSummary(initialSale, resetPaymentPercent),
        id: clientId,
        name,
        archived: false,
        archivedAt: null,
        createdAt,
        salesCount: initialSale ? 1 : 0,
        hasUnpricedNotes: false,
        referenceType: initialSale ? 'first-sale' : null
    };
}

async function addClient() {
    if (!currentUserId || isSaving) return;

    const name = normalizeClientName(clientNameInput?.value);
    if (!name) throw new Error('Informe o nome do cliente.');
    if (name.length < 2) throw new Error('O nome deve ter pelo menos 2 caracteres.');
    if (name.length > MAX_CLIENT_NAME_LENGTH) throw new Error(`O nome não pode ter mais de ${MAX_CLIENT_NAME_LENGTH} caracteres.`);

    const shouldAddInitialSale = Boolean(addInitialSaleInput?.checked);
    const saleAmountCents = shouldAddInitialSale ? parseCurrencyToCents(initialSaleAmountInput?.value) : 0;
    const saleDescription = String(initialSaleDescriptionInput?.value || '').trim();
    if (shouldAddInitialSale && saleAmountCents <= 0) throw new Error('Informe um valor maior que zero para a primeira venda.');
    if (saleAmountCents > MAX_SALE_AMOUNT_CENTS) throw new Error('O valor da venda não pode ser maior que R$ 1.000.000,00.');
    if (saleDescription.length > MAX_SALE_DESCRIPTION_LENGTH) throw new Error(`A descrição não pode ter mais de ${MAX_SALE_DESCRIPTION_LENGTH} caracteres.`);

    setFormDisabled(true);
    setStatus('Verificando e adicionando cliente...');

    try {
        const userPath = `users/${currentUserId}`;
        const [clientsSnapshot, resetPercentSnapshot] = await Promise.all([
            get(ref(database, `${userPath}/clients`)),
            get(ref(database, `${userPath}/settings/overdueResetPaymentPercent`))
        ]);
        const existingClients = clientsSnapshot.val() || {};
        const duplicate = Object.values(existingClients).some((client) => normalizeText(client?.name) === normalizeText(name));
        if (duplicate) throw new Error('Já existe um cliente com este nome.');

        const resetValue = Number(resetPercentSnapshot.val());
        const resetPaymentPercent = Number.isFinite(resetValue)
            ? Math.min(100, Math.max(0, resetValue))
            : DEFAULT_OVERDUE_RESET_PAYMENT_PERCENT;
        const clientId = push(ref(database, `${userPath}/clients`)).key;
        if (!clientId) throw new Error('Não foi possível gerar o cadastro do cliente.');

        const createdAt = new Date().toISOString();
        const initialSale = shouldAddInitialSale ? {
            id: createTransactionId(),
            amount: saleAmountCents / 100,
            amountCents: saleAmountCents,
            description: saleDescription,
            items: [],
            type: 'sale',
            isNote: false,
            hasUnpricedItems: false,
            date: createdAt
        } : null;
        const publicSummary = buildPublicClientSummary(initialSale, resetPaymentPercent);
        const client = {
            id: clientId,
            name,
            archived: false,
            createdAt,
            // Transações são gravadas com o id como chave (nunca por índice),
            // para que remoções não desloquem as posições das demais.
            sales: initialSale ? { [initialSale.id]: initialSale } : null,
            publicSummary
        };
        const listSummary = buildClientSummary(clientId, name, createdAt, resetPaymentPercent, initialSale);
        const updates = {
            [`${userPath}/clients/${clientId}`]: client,
            [`${userPath}/clientSummaries/${clientId}`]: listSummary
        };

        if (initialSale) {
            updates[`${userPath}/activities/${clientId}_${initialSale.id}`] = {
                id: initialSale.id,
                clientId,
                clientName: name,
                type: initialSale.type,
                amount: initialSale.amount,
                amountCents: initialSale.amountCents,
                description: initialSale.description,
                isNote: false,
                hasUnpricedItems: false,
                items: [],
                interestPaidCents: 0,
                principalPaidCents: 0,
                settlesPreviouslyAppliedInterest: false,
                relatedInterestId: null,
                relatedPaymentId: null,
                automaticInterest: false,
                date: initialSale.date,
                timestamp: new Date(initialSale.date).getTime(),
                editedAt: null
            };
        }

        await update(ref(database), updates);

        const verification = await get(ref(database, `${userPath}/clients/${clientId}`));
        if (!verification.exists()) throw new Error('O cadastro não foi confirmado no Firebase.');

        clientForm.reset();
        setInitialSaleVisibility(false);
        setStatus(
            initialSale
                ? `Cliente ${name} adicionado com a primeira venda de R$ ${formatCurrencyFromCents(saleAmountCents)}.`
                : `Cliente ${name} adicionado com saldo zerado.`,
            'success'
        );
        showToast(initialSale ? 'Cliente e primeira venda adicionados com sucesso!' : `Cliente ${name} adicionado com sucesso!`);
        window.setTimeout(() => clientNameInput?.focus(), 0);
    } catch (error) {
        console.error('Erro ao adicionar cliente:', error);
        setStatus(error.message || 'Erro ao adicionar cliente. Tente novamente.', 'error');
        showToast(error.message || 'Erro ao adicionar cliente. Tente novamente.', 'error');
    } finally {
        setFormDisabled(false);
    }
}

function setupThemeToggle() {
    const toggleTheme = () => {
        const html = document.documentElement;
        const nextTheme = html.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
        html.setAttribute('data-theme', nextTheme);
        localStorage.setItem('theme', nextTheme);
    };
    themeToggle?.addEventListener('click', toggleTheme);
}

function setClientsMenuOpen(isOpen) {
    if (!clientsMenu || !clientsMenuOverlay || !clientsMenuToggle) return;
    clientsMenu.classList.toggle('open', isOpen);
    document.body.classList.toggle('menu-open', isOpen);
    clientsMenu.setAttribute('aria-hidden', String(!isOpen));
    clientsMenuOverlay.hidden = !isOpen;
    clientsMenuToggle.setAttribute('aria-expanded', String(isOpen));
}

function setupClientsMenu() {
    if (!clientsMenu || !clientsMenuOverlay || !clientsMenuToggle || !clientsMenuClose) return;
    clientsMenuToggle.addEventListener('click', () => setClientsMenuOpen(true));
    clientsMenuClose.addEventListener('click', () => setClientsMenuOpen(false));
    clientsMenuOverlay.addEventListener('click', () => setClientsMenuOpen(false));
    document.querySelectorAll('.app-menu-link').forEach((link) => link.addEventListener('click', () => setClientsMenuOpen(false)));
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') setClientsMenuOpen(false);
    });
    window.addEventListener('resize', () => setClientsMenuOpen(false));
}

clientForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
        await addClient();
    } catch (error) {
        setStatus(error.message || 'Verifique o nome informado.', 'error');
        showToast(error.message || 'Verifique o nome informado.', 'error');
        if (addInitialSaleInput?.checked && parseCurrencyToCents(initialSaleAmountInput?.value) <= 0) {
            initialSaleAmountInput?.focus();
        } else {
            clientNameInput?.focus();
        }
    }
});
clientsSearch?.addEventListener('input', debounce(renderClients, SEARCH_DEBOUNCE_MS));
addInitialSaleInput?.addEventListener('change', () => setInitialSaleVisibility());

setupCurrencyMask(initialSaleAmountInput);
setInitialSaleVisibility(false);
setupThemeToggle();
setupClientsMenu();

onAuthStateChanged(auth, (user) => {
    if (!user) {
        if (clientsUnsubscribe) clientsUnsubscribe();
        window.location.href = './index.html';
        return;
    }
    currentUserId = user.uid;
    subscribeClients(user.uid);
    clientNameInput?.focus();
});
