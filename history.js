import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js';
import { getDatabase, ref, onValue, query, orderByChild, limitToLast, get, set } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js';
import { getAuth, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js';

const firebaseConfig = {
    apiKey: 'AIzaSyAmtxBsBUy67kuk50M25SPNl6AOhYFeDuY',
    authDomain: 'vendas-fiadas.firebaseapp.com',
    databaseURL: 'https://vendas-fiadas-default-rtdb.firebaseio.com',
    projectId: 'vendas-fiadas',
    storageBucket: 'vendas-fiadas.firebasestorage.app',
    messagingSenderId: '893268626644',
    appId: '1:893268626644:web:4f9237500db5de98177f41',
    measurementId: 'G-GVRNJBMTKC'
};

const app = initializeApp(firebaseConfig);
const database = getDatabase(app);
const auth = getAuth(app);

const activityList = document.getElementById('activityList');
const activitySummary = document.getElementById('activitySummary');
const historyMeta = document.getElementById('historyMeta');
const activityLimit = document.getElementById('activityLimit');
const themeToggle = document.getElementById('themeToggle');
const historyMenu = document.getElementById('historyMenu');
const historyMenuOverlay = document.getElementById('historyMenuOverlay');
const historyMenuToggle = document.getElementById('historyMenuToggle');
const historyMenuClose = document.getElementById('historyMenuClose');
const historyMenuThemeShortcut = document.getElementById('historyMenuThemeShortcut');

let allActivities = [];
let activitiesUnsubscribe = null;
let legacyUnsubscribe = null;
let currentUserId = null;
let hydrationAttempted = false;
let usingLegacyFallback = false;

function sanitizeHTML(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function formatDescription(text) {
    const safeText = sanitizeHTML(text || '');
    return safeText.replace(/\n/g, '<br>');
}

function formatDate(isoString) {
    const date = new Date(isoString);
    return date.toLocaleString('pt-BR', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
}

function formatCurrency(value) {
    const numericValue = Number(value);
    if (!Number.isFinite(numericValue)) return '0,00';
    const roundedValue = Math.round((numericValue + Number.EPSILON) * 100) / 100;
    const safeValue = Object.is(roundedValue, -0) ? 0 : roundedValue;

    return safeValue.toLocaleString('pt-BR', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    });
}

function renderActivities() {
    if (!activityList || !activitySummary || !historyMeta) return;

    const limit = Number(activityLimit?.value || 15);
    const visibleActivities = allActivities.slice(0, limit);

    if (visibleActivities.length === 0) {
        activitySummary.textContent = 'Sem movimentações recentes';
        historyMeta.textContent = 'Nenhuma movimentação disponível.';
        activityList.innerHTML = '<p class="empty-message">Nenhuma movimentação registrada ainda.</p>';
        return;
    }

    const saleTotal = visibleActivities
        .filter((item) => item.type === 'sale' && !item.isNote)
        .reduce((sum, item) => sum + item.amount, 0);

    const paymentTotal = visibleActivities
        .filter((item) => item.type === 'payment')
        .reduce((sum, item) => sum + item.amount, 0);

    const notesCount = visibleActivities.filter((item) => item.isNote).length;

    activitySummary.textContent = `Vendas: R$ ${formatCurrency(saleTotal)} | Recebimentos: R$ ${formatCurrency(paymentTotal)}`;
    historyMeta.textContent = `Exibindo ${visibleActivities.length} de ${allActivities.length} movimentações${notesCount ? ` | ${notesCount} anotação(ões)` : ''}`;

    activityList.innerHTML = visibleActivities.map((item) => {
        const isPayment = item.type === 'payment';
        const typeLabel = isPayment ? 'Recebimento' : (item.isNote ? 'Anotação' : 'Venda');
        const icon = isPayment ? '✓' : (item.isNote ? '📝' : '💵');
        const amountText = item.isNote ? 'Sem valor' : `R$ ${formatCurrency(item.amount)}`;
        const amountClass = isPayment ? 'activity-amount in' : 'activity-amount out';
        const safeClientName = sanitizeHTML(item.clientName);
        const safeDescription = item.description ? formatDescription(item.description) : '';

        return `
            <article class="activity-item ${isPayment ? 'is-payment' : 'is-sale'}">
                <div class="activity-main">
                    <div class="activity-title-row">
                        <span class="activity-type">${icon} ${typeLabel}</span>
                        <span class="${amountClass}">${amountText}</span>
                    </div>
                    <div class="activity-client">${safeClientName}</div>
                    ${safeDescription ? `<div class="activity-description">${safeDescription}</div>` : ''}
                </div>
                <time class="activity-date" datetime="${sanitizeHTML(item.date)}">${formatDate(item.date)}</time>
            </article>
        `;
    }).join('');
}

function normalizeActivityEntry(activity) {
    const amount = Number(activity.amount) || 0;
    const isSale = activity.type === 'sale';
    return {
        id: activity.id,
        clientId: activity.clientId || '',
        clientName: activity.clientName || 'Cliente',
        type: activity.type,
        amount,
        description: activity.description || '',
        isNote: Boolean(activity.isNote) || (isSale && amount === 0),
        date: activity.date,
        timestamp: Number(activity.timestamp) || new Date(activity.date || 0).getTime() || 0
    };
}

function mapActivitiesFromClients(clientsMap) {
    const activities = [];

    Object.values(clientsMap || {}).forEach((client) => {
        const sales = Array.isArray(client.sales) ? client.sales : [];

        sales.forEach((item) => {
            const amount = Number(item.amount) || 0;
            const isSale = item.type === 'sale';
            const isPayment = item.type === 'payment';
            if (!isSale && !isPayment) return;

            activities.push({
                id: item.id,
                clientId: client.id,
                clientName: client.name || 'Cliente',
                type: item.type,
                amount,
                description: item.description || '',
                isNote: Boolean(item.isNote) || (isSale && amount === 0),
                date: item.date,
                timestamp: new Date(item.date || 0).getTime() || 0
            });
        });
    });

    return activities
        .filter((activity) => activity.date)
        .sort((a, b) => b.timestamp - a.timestamp);
}

function unsubscribeAll() {
    if (activitiesUnsubscribe) {
        activitiesUnsubscribe();
        activitiesUnsubscribe = null;
    }
    if (legacyUnsubscribe) {
        legacyUnsubscribe();
        legacyUnsubscribe = null;
    }
}

function isPermissionDenied(error) {
    const code = String(error?.code || '');
    const msg = String(error?.message || '');
    return code.includes('PERMISSION_DENIED') || /permission denied/i.test(msg);
}

function subscribeLegacyClients(userId) {
    if (legacyUnsubscribe) {
        legacyUnsubscribe();
        legacyUnsubscribe = null;
    }

    usingLegacyFallback = true;
    historyMeta.textContent = 'Modo compatibilidade: carregando histórico...';

    legacyUnsubscribe = onValue(ref(database, `users/${userId}/clients`), (snapshot) => {
        const clients = snapshot.val() || {};
        allActivities = mapActivitiesFromClients(clients);
        renderActivities();

        if (allActivities.length > 0) {
            historyMeta.textContent += ' (compatibilidade)';
        }
    }, (error) => {
        showError('Não foi possível carregar o histórico. Verifique sua conexão.');
        console.error('Erro no fallback do histórico:', error);
    });
}

function getActivityKey(clientId, saleId) {
    return `${clientId}_${saleId}`;
}

async function hydrateActivitiesIndexFromClients(userId) {
    const clientsSnapshot = await get(ref(database, `users/${userId}/clients`));
    const clients = clientsSnapshot.val() || {};
    const indexedActivities = {};

    Object.values(clients).forEach((client) => {
        const sales = Array.isArray(client.sales) ? client.sales : [];

        sales.forEach((saleItem) => {
            if (!saleItem?.id) return;
            if (saleItem.type !== 'sale' && saleItem.type !== 'payment') return;

            const key = getActivityKey(client.id, saleItem.id);
            const timestamp = new Date(saleItem.date || new Date().toISOString()).getTime();
            indexedActivities[key] = {
                id: saleItem.id,
                clientId: client.id,
                clientName: client.name || 'Cliente',
                type: saleItem.type,
                amount: Number(saleItem.amount) || 0,
                description: saleItem.description || '',
                isNote: Boolean(saleItem.isNote) || (saleItem.type === 'sale' && Number(saleItem.amount) === 0),
                date: saleItem.date || new Date().toISOString(),
                timestamp: Number.isFinite(timestamp) ? timestamp : Date.now(),
                editedAt: saleItem.editedAt || null
            };
        });
    });

    const activityCount = Object.keys(indexedActivities).length;

    if (activityCount > 0) {
        await set(ref(database, `users/${userId}/activities`), indexedActivities);
    }

    return activityCount;
}

function subscribeRecentActivities(userId) {
    if (activitiesUnsubscribe) {
        activitiesUnsubscribe();
        activitiesUnsubscribe = null;
    }

    usingLegacyFallback = false;

    const limit = Number(activityLimit?.value || 15);
    const queryLimit = Math.max(30, limit);
    const activitiesQuery = query(
        ref(database, `users/${userId}/activities`),
        orderByChild('timestamp'),
        limitToLast(queryLimit)
    );

    historyMeta.textContent = 'Carregando movimentações...';

    activitiesUnsubscribe = onValue(activitiesQuery, async (snapshot) => {
        const activitiesObj = snapshot.val() || {};

        allActivities = Object.values(activitiesObj)
            .map(normalizeActivityEntry)
            .filter((activity) => activity.date)
            .sort((a, b) => b.timestamp - a.timestamp);

        if (allActivities.length === 0 && !hydrationAttempted) {
            hydrationAttempted = true;
            try {
                const hydratedCount = await hydrateActivitiesIndexFromClients(userId);
                if (hydratedCount === 0) {
                    renderActivities();
                }
                return;
            } catch (error) {
                console.error('Falha ao hidratar índice de atividades:', error);
                if (isPermissionDenied(error)) {
                    subscribeLegacyClients(userId);
                    return;
                }
            }
        }

        renderActivities();
    }, (error) => {
        if (isPermissionDenied(error)) {
            subscribeLegacyClients(userId);
            return;
        }

        showError('Não foi possível carregar o histórico. Verifique sua conexão.');
        console.error('Erro ao carregar histórico:', error);
    });
}

function setupThemeToggle() {
    const toggleTheme = () => {
        const html = document.documentElement;
        const currentTheme = html.getAttribute('data-theme');
        const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
        html.setAttribute('data-theme', newTheme);
        localStorage.setItem('theme', newTheme);
    };

    if (themeToggle) {
        themeToggle.addEventListener('click', toggleTheme);
    }

    if (historyMenuThemeShortcut) {
        historyMenuThemeShortcut.addEventListener('click', toggleTheme);
    }
}

function setHistoryMenuOpen(isOpen) {
    if (!historyMenu || !historyMenuOverlay || !historyMenuToggle) return;

    historyMenu.classList.toggle('open', isOpen);
    historyMenu.setAttribute('aria-hidden', String(!isOpen));
    historyMenuOverlay.hidden = !isOpen;
    historyMenuToggle.setAttribute('aria-expanded', String(isOpen));
}

function setupHistoryMenu() {
    if (!historyMenu || !historyMenuOverlay || !historyMenuToggle || !historyMenuClose) return;

    historyMenuToggle.addEventListener('click', () => setHistoryMenuOpen(true));
    historyMenuClose.addEventListener('click', () => setHistoryMenuOpen(false));
    historyMenuOverlay.addEventListener('click', () => setHistoryMenuOpen(false));

    document.querySelectorAll('.app-menu-link').forEach((link) => {
        link.addEventListener('click', () => setHistoryMenuOpen(false));
    });

    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
            setHistoryMenuOpen(false);
        }
    });
}

function showError(message) {
    if (!activityList || !activitySummary || !historyMeta) return;
    activitySummary.textContent = 'Erro ao carregar';
    historyMeta.textContent = message;
    activityList.innerHTML = `<p class="empty-message">${sanitizeHTML(message)}</p>`;
}

if (activityLimit) {
    activityLimit.addEventListener('change', () => {
        if (currentUserId) {
            if (usingLegacyFallback) {
                renderActivities();
                return;
            }
            subscribeRecentActivities(currentUserId);
            return;
        }
        renderActivities();
    });
}

setupThemeToggle();
setupHistoryMenu();

onAuthStateChanged(auth, (user) => {
    if (!user) {
        unsubscribeAll();
        window.location.href = './index.html';
        return;
    }

    currentUserId = user.uid;
    unsubscribeAll();
    hydrationAttempted = false;
    subscribeRecentActivities(user.uid);
});
