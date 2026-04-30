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

const ACTIVITY_QUERY_LIMIT = 250;
const SEARCH_DEBOUNCE_MS = 180;
const DAY_IN_MS = 24 * 60 * 60 * 1000;

const currencyFormatter = new Intl.NumberFormat('pt-BR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
});
const dateTimeFormatter = new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
});
const timeFormatter = new Intl.DateTimeFormat('pt-BR', {
    hour: '2-digit',
    minute: '2-digit'
});
const dayFormatter = new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit',
    month: 'long',
    year: 'numeric'
});

const activityList = document.getElementById('activityList');
const activitySummary = document.getElementById('activitySummary');
const historyMeta = document.getElementById('historyMeta');
const activityLimit = document.getElementById('activityLimit');
const activityType = document.getElementById('activityType');
const historySearch = document.getElementById('historySearch');
const clearHistoryFilters = document.getElementById('clearHistoryFilters');
const historySalesTotal = document.getElementById('historySalesTotal');
const historyPaymentsTotal = document.getElementById('historyPaymentsTotal');
const historyNotesCount = document.getElementById('historyNotesCount');
const themeToggle = document.getElementById('themeToggle');
const historyMenu = document.getElementById('historyMenu');
const historyMenuOverlay = document.getElementById('historyMenuOverlay');
const historyMenuToggle = document.getElementById('historyMenuToggle');
const historyMenuClose = document.getElementById('historyMenuClose');
const historyMenuThemeShortcut = document.getElementById('historyMenuThemeShortcut');

let allActivities = [];
let activitiesUnsubscribe = null;
let legacyUnsubscribe = null;
let hydrationAttempted = false;
let usingLegacyFallback = false;

function createElement(tagName, className = '', text = '') {
    const element = document.createElement(tagName);
    if (className) element.className = className;
    if (text !== '') element.textContent = text;
    return element;
}

function debounce(callback, delay) {
    let timeoutId = null;

    return (...args) => {
        window.clearTimeout(timeoutId);
        timeoutId = window.setTimeout(() => callback(...args), delay);
    };
}

function normalizeSearchText(value) {
    return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .trim();
}

function getValidDate(value) {
    const date = new Date(value || 0);
    return Number.isNaN(date.getTime()) ? null : date;
}

function formatDate(isoString) {
    const date = getValidDate(isoString);
    return date ? dateTimeFormatter.format(date) : 'Data indisponível';
}

function formatTime(isoString) {
    const date = getValidDate(isoString);
    return date ? timeFormatter.format(date) : '--:--';
}

function getDayLabel(isoString) {
    const date = getValidDate(isoString);
    if (!date) return 'Sem data';

    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const dateStart = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
    const dayDiff = Math.round((todayStart - dateStart) / DAY_IN_MS);

    if (dayDiff === 0) return 'Hoje';
    if (dayDiff === 1) return 'Ontem';

    return dayFormatter.format(date);
}

function formatCurrency(value) {
    const numericValue = Number(value);
    if (!Number.isFinite(numericValue)) return '0,00';
    const roundedValue = Math.round((numericValue + Number.EPSILON) * 100) / 100;
    const safeValue = Object.is(roundedValue, -0) ? 0 : roundedValue;

    return currencyFormatter.format(safeValue);
}

function getSelectedLimit() {
    const selectedLimit = Number(activityLimit?.value || 15);
    return Number.isFinite(selectedLimit) && selectedLimit > 0 ? selectedLimit : 15;
}

function matchesActivityType(item, typeFilter) {
    if (typeFilter === 'sale') return item.type === 'sale' && !item.isNote;
    if (typeFilter === 'payment') return item.type === 'payment';
    if (typeFilter === 'note') return item.isNote;
    return true;
}

function getActivityLabel(item) {
    if (item.type === 'payment') return 'Recebimento';
    if (item.isNote) return 'Anotação';
    return 'Venda';
}

function getActivityIcon(item) {
    if (item.type === 'payment') return '✓';
    if (item.isNote) return '✎';
    return 'R$';
}

function getActivityClass(item) {
    if (item.type === 'payment') return 'is-payment';
    if (item.isNote) return 'is-note';
    return 'is-sale';
}

function setStats(saleTotal, paymentTotal, notesCount) {
    if (historySalesTotal) historySalesTotal.textContent = `R$ ${formatCurrency(saleTotal)}`;
    if (historyPaymentsTotal) historyPaymentsTotal.textContent = `R$ ${formatCurrency(paymentTotal)}`;
    if (historyNotesCount) historyNotesCount.textContent = String(notesCount);
}

function setEmptyState(message) {
    if (!activityList) return;
    const emptyMessage = createElement('p', 'empty-message activity-empty-state', message);
    activityList.replaceChildren(emptyMessage);
}

function createActivityItem(item) {
    const isPayment = item.type === 'payment';
    const article = createElement('article', `activity-item ${getActivityClass(item)}`);
    const main = createElement('div', 'activity-main');
    const titleRow = createElement('div', 'activity-title-row');
    const type = createElement('span', 'activity-type');
    const icon = createElement('span', 'activity-icon', getActivityIcon(item));
    const amountClass = item.isNote ? 'activity-amount note' : `activity-amount ${isPayment ? 'in' : 'out'}`;
    const amountText = item.isNote ? 'Sem valor' : `R$ ${formatCurrency(item.amount)}`;
    const amount = createElement('span', amountClass, amountText);
    const client = createElement('div', 'activity-client', item.clientName);
    const time = createElement('time', 'activity-date', formatTime(item.date));

    icon.setAttribute('aria-hidden', 'true');
    type.append(icon, document.createTextNode(` ${getActivityLabel(item)}`));
    titleRow.append(type, amount);
    main.append(titleRow, client);

    if (item.description) {
        main.append(createElement('div', 'activity-description', item.description));
    }

    time.dateTime = item.date || '';
    time.title = formatDate(item.date);
    article.append(main, time);

    return article;
}

function renderActivityList(activities) {
    if (!activityList) return;

    const fragment = document.createDocumentFragment();
    let currentDay = '';
    let currentGroup = null;

    activities.forEach((item) => {
        const day = getDayLabel(item.date);

        if (day !== currentDay) {
            currentDay = day;
            currentGroup = createElement('div', 'date-group');
            currentGroup.append(createElement('h3', 'date-group-title', day));
            fragment.append(currentGroup);
        }

        currentGroup.append(createActivityItem(item));
    });

    activityList.replaceChildren(fragment);
}

function renderActivities() {
    if (!activityList || !activitySummary || !historyMeta) return;

    const limit = getSelectedLimit();
    const typeFilter = activityType?.value || 'all';
    const searchQuery = normalizeSearchText(historySearch?.value || '');
    const hasFilters = Boolean(searchQuery) || typeFilter !== 'all';
    const filteredActivities = [];

    for (const item of allActivities) {
        if (!matchesActivityType(item, typeFilter)) continue;
        if (searchQuery && !item.searchText.includes(searchQuery)) continue;
        filteredActivities.push(item);
    }

    const totalAvailable = filteredActivities.length;
    const visibleActivities = filteredActivities.slice(0, limit);
    let saleTotal = 0;
    let paymentTotal = 0;
    let notesCount = 0;

    visibleActivities.forEach((item) => {
        if (item.type === 'payment') {
            paymentTotal += item.amount;
        } else if (item.isNote) {
            notesCount += 1;
        } else {
            saleTotal += item.amount;
        }
    });

    setStats(saleTotal, paymentTotal, notesCount);
    if (clearHistoryFilters) clearHistoryFilters.hidden = !hasFilters;

    if (visibleActivities.length === 0) {
        activitySummary.textContent = 'Nenhum resultado';
        historyMeta.textContent = hasFilters
            ? 'Nenhuma movimentação encontrada com esses filtros.'
            : 'Nenhuma movimentação disponível.';
        setEmptyState('Nenhuma movimentação encontrada.');
        return;
    }

    const visibleLabel = visibleActivities.length === 1 ? '1 item' : `${visibleActivities.length} itens`;
    const loadedLabel = !usingLegacyFallback && allActivities.length >= ACTIVITY_QUERY_LIMIT
        ? 'movimentações recentes carregadas'
        : 'movimentações carregadas';

    activitySummary.textContent = visibleLabel;
    historyMeta.textContent = `Exibindo ${visibleActivities.length} de ${totalAvailable} encontradas (${allActivities.length} ${loadedLabel}).`;
    renderActivityList(visibleActivities);
}

function normalizeActivityEntry(activity) {
    const amount = Number(activity.amount) || 0;
    const timestamp = Number(activity.timestamp) || new Date(activity.date || 0).getTime() || 0;
    const date = activity.date || (timestamp ? new Date(timestamp).toISOString() : '');
    const type = activity.type === 'payment' ? 'payment' : 'sale';
    const isNote = Boolean(activity.isNote) || (type === 'sale' && amount === 0);
    const clientName = activity.clientName || 'Cliente';
    const description = activity.description || '';

    return {
        id: activity.id,
        clientId: activity.clientId || '',
        clientName,
        type,
        amount,
        description,
        isNote,
        date,
        timestamp,
        searchText: normalizeSearchText(`${clientName} ${description}`)
    };
}

function mapActivitiesFromClients(clientsMap) {
    const activities = [];

    Object.entries(clientsMap || {}).forEach(([clientId, client]) => {
        const sales = Array.isArray(client.sales) ? client.sales : [];
        const resolvedClientId = client.id || clientId;

        sales.forEach((item) => {
            const amount = Number(item.amount) || 0;
            const type = item.type === 'payment' ? 'payment' : item.type === 'sale' ? 'sale' : '';
            if (!type) return;

            activities.push(normalizeActivityEntry({
                id: item.id,
                clientId: resolvedClientId,
                clientName: client.name || 'Cliente',
                type,
                amount,
                description: item.description || '',
                isNote: Boolean(item.isNote) || (type === 'sale' && amount === 0),
                date: item.date,
                timestamp: new Date(item.date || 0).getTime() || 0
            }));
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
            historyMeta.textContent += ' Modo compatibilidade.';
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

    Object.entries(clients).forEach(([clientId, client]) => {
        const sales = Array.isArray(client.sales) ? client.sales : [];
        const resolvedClientId = client.id || clientId;

        sales.forEach((saleItem) => {
            if (!saleItem?.id) return;
            if (saleItem.type !== 'sale' && saleItem.type !== 'payment') return;

            const key = getActivityKey(resolvedClientId, saleItem.id);
            const timestamp = new Date(saleItem.date || new Date().toISOString()).getTime();
            indexedActivities[key] = {
                id: saleItem.id,
                clientId: resolvedClientId,
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

    const activitiesQuery = query(
        ref(database, `users/${userId}/activities`),
        orderByChild('timestamp'),
        limitToLast(ACTIVITY_QUERY_LIMIT)
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
    setStats(0, 0, 0);
    setEmptyState(message);
}

const debouncedRenderActivities = debounce(renderActivities, SEARCH_DEBOUNCE_MS);

if (activityLimit) {
    activityLimit.addEventListener('change', renderActivities);
}

if (activityType) {
    activityType.addEventListener('change', renderActivities);
}

if (historySearch) {
    historySearch.addEventListener('input', debouncedRenderActivities);
}

if (clearHistoryFilters) {
    clearHistoryFilters.addEventListener('click', () => {
        if (historySearch) historySearch.value = '';
        if (activityType) activityType.value = 'all';
        renderActivities();
        historySearch?.focus();
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

    unsubscribeAll();
    hydrationAttempted = false;
    subscribeRecentActivities(user.uid);
});
