import { getDatabase, ref, onValue, update, get, push } from 'firebase/database';
import { getAuth, onAuthStateChanged } from 'firebase/auth';
import { firebaseApp } from './firebase.js';

const database = getDatabase(firebaseApp);
const auth = getAuth(firebaseApp);

const DEFAULT_OVERDUE_RESET_PAYMENT_PERCENT = 20;
const MAX_CLIENT_NAME_LENGTH = 100;
const SEARCH_DEBOUNCE_MS = 160;
const currencyFormatter = new Intl.NumberFormat('pt-BR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
});

const clientForm = document.getElementById('clientForm');
const clientNameInput = document.getElementById('clientName');
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
const clientsMenuThemeShortcut = document.getElementById('clientsMenuThemeShortcut');

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
    if (clientNameInput) clientNameInput.disabled = disabled;
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
                <div class="client-directory-balance ${balanceClass}">
                    <span>Saldo</span>
                    <strong>R$ ${formatCurrencyFromCents(balanceCents)}</strong>
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

function buildEmptyClientSummary(clientId, name, createdAt, resetPaymentPercent) {
    return {
        version: 1,
        id: clientId,
        name,
        archived: false,
        archivedAt: null,
        createdAt,
        salesCount: 0,
        hasUnpricedNotes: false,
        referenceType: null,
        baseDebtCents: 0,
        principalDebtCents: 0,
        outstandingInterestCents: 0,
        transactionCount: 0,
        referenceDate: null,
        lastAutomaticInterestDate: null,
        overdueResetPaymentPercent: resetPaymentPercent,
        overdueInterestOverride: null
    };
}

async function addClient() {
    if (!currentUserId || isSaving) return;

    const name = normalizeClientName(clientNameInput?.value);
    if (!name) throw new Error('Informe o nome do cliente.');
    if (name.length < 2) throw new Error('O nome deve ter pelo menos 2 caracteres.');
    if (name.length > MAX_CLIENT_NAME_LENGTH) throw new Error(`O nome não pode ter mais de ${MAX_CLIENT_NAME_LENGTH} caracteres.`);

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
        const publicSummary = {
            version: 1,
            baseDebtCents: 0,
            principalDebtCents: 0,
            outstandingInterestCents: 0,
            transactionCount: 0,
            referenceDate: null,
            lastAutomaticInterestDate: null,
            overdueResetPaymentPercent: resetPaymentPercent,
            overdueInterestOverride: null
        };
        const client = {
            id: clientId,
            name,
            archived: false,
            createdAt,
            sales: [],
            publicSummary
        };
        const listSummary = buildEmptyClientSummary(clientId, name, createdAt, resetPaymentPercent);

        await update(ref(database), {
            [`${userPath}/clients/${clientId}`]: client,
            [`${userPath}/clientSummaries/${clientId}`]: listSummary
        });

        const verification = await get(ref(database, `${userPath}/clients/${clientId}`));
        if (!verification.exists()) throw new Error('O cadastro não foi confirmado no Firebase.');

        clientForm.reset();
        setStatus(`Cliente ${name} adicionado com saldo zerado.`, 'success');
        showToast(`Cliente ${name} adicionado com sucesso!`);
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
    clientsMenuThemeShortcut?.addEventListener('click', toggleTheme);
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
        clientNameInput?.focus();
    }
});
clientsSearch?.addEventListener('input', debounce(renderClients, SEARCH_DEBOUNCE_MS));

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
