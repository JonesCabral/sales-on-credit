import {
    endBefore,
    get,
    getDatabase,
    limitToLast,
    onValue,
    orderByChild,
    query,
    ref,
    update
} from 'firebase/database';
import { getAuth, onAuthStateChanged } from 'firebase/auth';
import { firebaseApp } from './firebase.js';
import {
    activityHasUnpricedProducts,
    amountToCents,
    calculateActivityTotals,
    compareFirebaseActivityOrder,
    resolveUnpricedItemsFlag
} from './history-domain.js';

const database = getDatabase(firebaseApp);
const auth = getAuth(firebaseApp);

const ACTIVITY_PAGE_SIZE = 250;
const SEARCH_DEBOUNCE_MS = 180;
const DAY_IN_MS = 24 * 60 * 60 * 1000;
const DESCRIPTION_COLLAPSE_LENGTH = 150;
const MOBILE_FILTERS_QUERY = '(max-width: 700px)';
const VALID_PERIODS = new Set(['all', 'today', '7d', '30d', 'month', 'custom']);
const VALID_TYPES = new Set(['all', 'sale', 'interest', 'payment', 'note']);
const VALID_SORTS = new Set(['newest', 'oldest', 'amount', 'client']);
const VALID_LIMITS = new Set(['15', '30', '50', '100']);

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
const shortDateFormatter = new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric'
});

const elements = {
    activityList: document.getElementById('activityList'),
    activitySummary: document.getElementById('activitySummary'),
    activityLimit: document.getElementById('activityLimit'),
    activityType: document.getElementById('activityType'),
    activityClient: document.getElementById('activityClient'),
    activitySort: document.getElementById('activitySort'),
    historySearch: document.getElementById('historySearch'),
    historyDateFrom: document.getElementById('historyDateFrom'),
    historyDateTo: document.getElementById('historyDateTo'),
    historyCustomPeriod: document.getElementById('historyCustomPeriod'),
    historyIncludeArchived: document.getElementById('historyIncludeArchived'),
    historyFiltersPanel: document.getElementById('historyFiltersPanel'),
    historyFiltersToggle: document.getElementById('historyFiltersToggle'),
    clearHistoryFilters: document.getElementById('clearHistoryFilters'),
    historySalesTotal: document.getElementById('historySalesTotal'),
    historyPaymentsTotal: document.getElementById('historyPaymentsTotal'),
    historyInterestTotal: document.getElementById('historyInterestTotal'),
    historyNotesCount: document.getElementById('historyNotesCount'),
    historyBalanceTotal: document.getElementById('historyBalanceTotal'),
    historyTotalsScope: document.getElementById('historyTotalsScope'),
    historyMeta: document.getElementById('historyMeta'),
    retryHistoryLoad: document.getElementById('retryHistoryLoad'),
    historyPagination: document.getElementById('historyPagination'),
    loadMoreHistory: document.getElementById('loadMoreHistory'),
    loadAllHistory: document.getElementById('loadAllHistory'),
    exportHistoryCsv: document.getElementById('exportHistoryCsv'),
    printHistory: document.getElementById('printHistory'),
    themeToggle: document.getElementById('themeToggle'),
    historyMenu: document.getElementById('historyMenu'),
    historyMenuOverlay: document.getElementById('historyMenuOverlay'),
    historyMenuToggle: document.getElementById('historyMenuToggle'),
    historyMenuClose: document.getElementById('historyMenuClose')
};

const activityMap = new Map();
let recentActivityKeys = new Set();
let olderActivityKeys = new Set();
let allActivities = [];
let clientSummaries = {};
let activitiesUnsubscribe = null;
let legacyUnsubscribe = null;
let clientSummariesUnsubscribe = null;
let currentUserId = '';
let selectedPeriod = 'all';
let pendingClientFilter = 'all';
let hasMoreActivities = false;
let activitiesReady = false;
let isLoadingOlder = false;
let isLoadingAll = false;
let isEnsuringPeriod = false;
let isPrinting = false;
let usingLegacyFallback = false;
let reconciliationAttempted = false;
let filtersInitialized = false;
let mobileFiltersOpen = false;
const mobileFiltersMedia = window.matchMedia(MOBILE_FILTERS_QUERY);

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

function formatDate(value) {
    const date = getValidDate(value);
    return date ? dateTimeFormatter.format(date) : 'Data indisponível';
}

function formatTime(value) {
    const date = getValidDate(value);
    return date ? timeFormatter.format(date) : '--:--';
}

function getDayLabel(value) {
    const date = getValidDate(value);
    if (!date) return 'Sem data';

    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const dateStart = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
    const dayDiff = Math.round((todayStart - dateStart) / DAY_IN_MS);

    if (dayDiff === 0) return 'Hoje';
    if (dayDiff === 1) return 'Ontem';
    return dayFormatter.format(date);
}

function formatCurrencyFromCents(value) {
    const cents = Number.isFinite(Number(value)) ? Math.round(Number(value)) : 0;
    return currencyFormatter.format(cents / 100);
}

function parseLocalDate(value, endOfDay = false) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
    if (!match) return null;
    const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    if (endOfDay) date.setHours(23, 59, 59, 999);
    return date;
}

function toDateInputValue(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function getSelectedLimit() {
    const selectedLimit = Number(elements.activityLimit?.value || 15);
    return Number.isFinite(selectedLimit) && selectedLimit > 0 ? selectedLimit : 15;
}

function getSelectedDateRange() {
    const now = new Date();
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
    let start = null;

    if (selectedPeriod === 'today') {
        start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    } else if (selectedPeriod === '7d' || selectedPeriod === '30d') {
        const days = selectedPeriod === '7d' ? 7 : 30;
        start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        start.setDate(start.getDate() - (days - 1));
    } else if (selectedPeriod === 'month') {
        start = new Date(now.getFullYear(), now.getMonth(), 1);
    } else if (selectedPeriod === 'custom') {
        const customStart = parseLocalDate(elements.historyDateFrom?.value);
        const customEnd = parseLocalDate(elements.historyDateTo?.value, true);
        if (customStart && customEnd && customStart.getTime() > customEnd.getTime()) {
            return { invalid: true, start: customStart.getTime(), end: customEnd.getTime() };
        }
        return {
            invalid: false,
            start: customStart?.getTime() ?? null,
            end: customEnd?.getTime() ?? null
        };
    }

    return {
        invalid: false,
        start: start?.getTime() ?? null,
        end: selectedPeriod === 'all' ? null : end.getTime()
    };
}

function getPeriodLabel() {
    const range = getSelectedDateRange();
    if (selectedPeriod === 'all') return 'todo o período carregado';
    if (selectedPeriod === 'today') return 'hoje';
    if (selectedPeriod === '7d') return 'os últimos 7 dias';
    if (selectedPeriod === '30d') return 'os últimos 30 dias';
    if (selectedPeriod === 'month') return 'este mês';
    if (range.invalid) return 'o período personalizado';

    const start = range.start ? shortDateFormatter.format(new Date(range.start)) : 'o início';
    const end = range.end ? shortDateFormatter.format(new Date(range.end)) : 'hoje';
    return `de ${start} a ${end}`;
}

function getActivityLabel(item) {
    if (item.type === 'payment') return 'Recebimento';
    if (item.type === 'interest') return 'Juros';
    if (activityHasUnpricedProducts(item)) return item.amountCents > 0 ? 'Venda com anotação' : 'Anotação';
    return 'Venda';
}

function getActivityIcon(item) {
    if (item.type === 'payment') return '✓';
    if (item.type === 'interest') return '%';
    if (activityHasUnpricedProducts(item)) return '✎';
    return '↗';
}

function getActivityClass(item) {
    if (item.type === 'payment') return 'is-payment';
    if (item.type === 'interest') return 'is-interest';
    if (activityHasUnpricedProducts(item)) return 'is-note';
    return 'is-sale';
}

function matchesActivityType(item, typeFilter) {
    if (typeFilter === 'sale') return item.type === 'sale' && !activityHasUnpricedProducts(item);
    if (typeFilter === 'interest') return item.type === 'interest';
    if (typeFilter === 'payment') return item.type === 'payment';
    if (typeFilter === 'note') return activityHasUnpricedProducts(item);
    return true;
}

function normalizeActivityEntry(activity, key = '') {
    const amountCents = amountToCents(activity);
    const timestamp = Number(activity?.timestamp) || new Date(activity?.date || 0).getTime() || 0;
    const date = activity?.date || (timestamp ? new Date(timestamp).toISOString() : '');
    const type = activity?.type === 'payment'
        ? 'payment'
        : activity?.type === 'interest'
            ? 'interest'
            : 'sale';

    const entry = {
        key: String(key || activity?.key || activity?.id || `${timestamp}`),
        id: activity?.id || '',
        clientId: activity?.clientId || '',
        clientName: activity?.clientName || 'Cliente',
        type,
        amountCents,
        description: activity?.description || '',
        isNote: Boolean(activity?.isNote) || (type === 'sale' && amountCents === 0),
        hasUnpricedItems: activity?.hasUnpricedItems === true,
        // `items` precisa sobreviver a normalizacao: e um dos sinais da regra de
        // produtos sem preco, e sem ele a tela derivaria um valor diferente do
        // que foi gravado no indice de atividades.
        items: Array.isArray(activity?.items) ? activity.items : [],
        date,
        timestamp,
        editedAt: activity?.editedAt || null,
        automaticInterest: activity?.automaticInterest === true,
        relatedInterestId: activity?.relatedInterestId || null,
        relatedPaymentId: activity?.relatedPaymentId || null
    };

    // Resolvido sobre a entrada ja normalizada (o `type` acima e coagido), para
    // que registros legados com flag desatualizado se corrijam na leitura.
    entry.hasUnpricedItems = resolveUnpricedItemsFlag(entry);
    return entry;
}

function snapshotToActivities(snapshot) {
    const activities = [];
    snapshot.forEach((childSnapshot) => {
        const value = childSnapshot.val();
        if (value && typeof value === 'object') {
            activities.push(normalizeActivityEntry(value, childSnapshot.key));
        }
    });
    return activities;
}

function rebuildActivitiesArray() {
    allActivities = [...activityMap.values()].sort((a, b) => {
        const timeDifference = b.timestamp - a.timestamp;
        return timeDifference || b.key.localeCompare(a.key, 'pt-BR', { numeric: true });
    });
}

function getClientDetails(item) {
    const summary = clientSummaries[item.clientId];
    return {
        clientName: summary?.name || item.clientName || 'Cliente',
        archived: summary?.archived === true
    };
}

function enrichActivity(item) {
    return { ...item, ...getClientDetails(item) };
}

function getFilteredActivities() {
    const typeFilter = elements.activityType?.value || 'all';
    const clientFilter = elements.activityClient?.value || 'all';
    const searchQuery = normalizeSearchText(elements.historySearch?.value || '');
    const includeArchived = elements.historyIncludeArchived?.checked !== false;
    const range = getSelectedDateRange();
    if (range.invalid) return { invalidRange: true, activities: [] };

    const activities = [];
    allActivities.forEach((rawItem) => {
        const item = enrichActivity(rawItem);
        if (!matchesActivityType(item, typeFilter)) return;
        if (clientFilter !== 'all' && item.clientId !== clientFilter) return;
        if (!includeArchived && item.archived) return;
        if (range.start !== null && item.timestamp < range.start) return;
        if (range.end !== null && item.timestamp > range.end) return;

        const searchable = normalizeSearchText([
            item.clientName,
            item.description,
            getActivityLabel(item),
            formatCurrencyFromCents(item.amountCents)
        ].join(' '));
        if (searchQuery && !searchable.includes(searchQuery)) return;
        activities.push(item);
    });

    const sort = elements.activitySort?.value || 'newest';
    activities.sort((a, b) => {
        if (sort === 'oldest') return (a.timestamp - b.timestamp) || a.key.localeCompare(b.key, 'pt-BR', { numeric: true });
        if (sort === 'amount') return (b.amountCents - a.amountCents) || (b.timestamp - a.timestamp);
        if (sort === 'client') {
            return a.clientName.localeCompare(b.clientName, 'pt-BR', { sensitivity: 'base' }) || (b.timestamp - a.timestamp);
        }
        return (b.timestamp - a.timestamp) || b.key.localeCompare(a.key, 'pt-BR', { numeric: true });
    });

    return { invalidRange: false, activities };
}

function setStats(activities) {
    const { saleCents, paymentCents, interestCents, notesCount, balanceCents } = calculateActivityTotals(activities);
    elements.historySalesTotal.textContent = `R$ ${formatCurrencyFromCents(saleCents)}`;
    elements.historyPaymentsTotal.textContent = `R$ ${formatCurrencyFromCents(paymentCents)}`;
    elements.historyInterestTotal.textContent = `R$ ${formatCurrencyFromCents(interestCents)}`;
    elements.historyNotesCount.textContent = String(notesCount);
    elements.historyBalanceTotal.textContent = `${balanceCents < 0 ? '− ' : ''}R$ ${formatCurrencyFromCents(Math.abs(balanceCents))}`;
    elements.historyBalanceTotal.classList.toggle('is-positive', balanceCents > 0);
    elements.historyBalanceTotal.classList.toggle('is-negative', balanceCents < 0);
    elements.historyBalanceTotal.classList.toggle('is-zero', balanceCents === 0);
}

function setEmptyState(message, detail = '') {
    const wrapper = createElement('div', 'empty-message activity-empty-state');
    wrapper.append(createElement('strong', '', message));
    if (detail) wrapper.append(createElement('span', '', detail));
    elements.activityList.replaceChildren(wrapper);
}

function createBadge(text, className = '') {
    return createElement('span', `activity-badge ${className}`.trim(), text);
}

function createActivityItem(item) {
    const isPayment = item.type === 'payment';
    const isAmountlessNote = activityHasUnpricedProducts(item) && item.amountCents === 0;
    const article = createElement('article', `activity-item ${getActivityClass(item)}`);
    const main = createElement('div', 'activity-main');
    const titleRow = createElement('div', 'activity-title-row');
    const type = createElement('span', 'activity-type');
    const icon = createElement('span', 'activity-icon', getActivityIcon(item));
    const amountClass = isAmountlessNote ? 'activity-amount note' : `activity-amount ${isPayment ? 'in' : 'out'}`;
    const amountText = isAmountlessNote ? 'Sem valor' : `R$ ${formatCurrencyFromCents(item.amountCents)}`;
    const amount = createElement('span', amountClass, amountText);
    const client = createElement('div', 'activity-client', item.clientName);
    const time = createElement('time', 'activity-date', formatTime(item.date));
    const badges = createElement('div', 'activity-badges');
    const openHint = createElement('a', 'activity-open-hint', 'Abrir cliente →');

    article.dataset.href = `dashboard.html?client=${encodeURIComponent(item.clientId)}&screen=history`;
    article.dataset.clientId = item.clientId;
    openHint.href = article.dataset.href;
    openHint.setAttribute('aria-label', `Abrir histórico de ${item.clientName}`);

    icon.setAttribute('aria-hidden', 'true');
    type.append(icon, document.createTextNode(` ${getActivityLabel(item)}`));
    titleRow.append(type, amount);
    main.append(titleRow, client);

    if (item.editedAt) badges.append(createBadge('Editado', 'is-edited'));
    if (item.automaticInterest) badges.append(createBadge('Automático', 'is-automatic'));
    if (item.archived) badges.append(createBadge('Arquivado', 'is-archived'));
    if (badges.childElementCount > 0) main.append(badges);

    if (item.description) {
        const description = createElement('div', 'activity-description', item.description);
        const shouldCollapse = item.description.length > DESCRIPTION_COLLAPSE_LENGTH || item.description.split('\n').length > 3;
        if (shouldCollapse) {
            const descriptionId = `activity-description-${String(item.key).replace(/[^a-zA-Z0-9_-]/g, '-')}`;
            const toggle = createElement('button', 'activity-description-toggle', 'Ver mais');
            description.id = descriptionId;
            description.classList.add('is-collapsed');
            toggle.type = 'button';
            toggle.setAttribute('aria-expanded', 'false');
            toggle.setAttribute('aria-controls', descriptionId);
            main.append(description, toggle);
        } else {
            main.append(description);
        }
    }

    time.dateTime = item.date || '';
    time.title = formatDate(item.date);
    const side = createElement('div', 'activity-side');
    side.append(time, openHint);
    article.append(main, side);
    return article;
}

function renderActivityList(activities) {
    const fragment = document.createDocumentFragment();
    const chronological = ['newest', 'oldest'].includes(elements.activitySort?.value || 'newest');

    if (!chronological) {
        activities.forEach((item) => fragment.append(createActivityItem(item)));
        elements.activityList.replaceChildren(fragment);
        return;
    }

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
    elements.activityList.replaceChildren(fragment);
}

function hasActiveFilters() {
    return Boolean(elements.historySearch?.value.trim())
        || (elements.activityType?.value || 'all') !== 'all'
        || (elements.activityClient?.value || 'all') !== 'all'
        || selectedPeriod !== 'all'
        || elements.historyIncludeArchived?.checked === false
        || (elements.activitySort?.value || 'newest') !== 'newest';
}

function updateTotalsScope(filteredCount) {
    const completeness = isCurrentFilterCoverageComplete()
        ? 'Totais completos para os filtros selecionados.'
        : hasMoreActivities
        ? 'Totais calculados sobre os registros carregados; ainda existem movimentações anteriores.'
        : 'Totais completos para os filtros selecionados.';
    elements.historyTotalsScope.textContent = `${filteredCount} ${filteredCount === 1 ? 'resultado' : 'resultados'} em ${getPeriodLabel()}. ${completeness} Variação do saldo = vendas + juros − recebimentos.`;
}

function updatePagination() {
    elements.historyPagination.hidden = !hasMoreActivities || usingLegacyFallback || isPrinting;
    elements.loadMoreHistory.disabled = isLoadingOlder || isLoadingAll;
    elements.loadAllHistory.disabled = isLoadingOlder || isLoadingAll;
    elements.exportHistoryCsv.disabled = isLoadingOlder || isLoadingAll;
    elements.printHistory.disabled = isLoadingOlder || isLoadingAll;
    elements.loadMoreHistory.textContent = isLoadingOlder && !isLoadingAll
        ? 'Carregando anteriores...'
        : 'Carregar movimentações anteriores';
    elements.loadAllHistory.textContent = isLoadingAll
        ? 'Carregando histórico...'
        : 'Carregar todo o histórico';
}

function renderActivities() {
    if (!elements.activityList || !elements.activitySummary || !elements.historyMeta) return;
    if (!activitiesReady) return;
    const { invalidRange, activities } = getFilteredActivities();
    const rangeError = invalidRange ? 'A data inicial deve ser anterior ou igual à data final.' : '';
    elements.historyDateFrom?.setCustomValidity(rangeError);
    elements.historyDateTo?.setCustomValidity(rangeError);
    elements.activityList.setAttribute('aria-busy', 'false');
    elements.clearHistoryFilters.hidden = !hasActiveFilters();
    setStats(activities);
    updateTotalsScope(activities.length);
    updatePagination();

    if (invalidRange) {
        elements.activitySummary.textContent = 'Período inválido';
        elements.historyMeta.textContent = 'A data inicial deve ser anterior ou igual à data final.';
        setEmptyState('Revise o período selecionado.', 'A data inicial está depois da data final.');
        return;
    }

    const limit = getSelectedLimit();
    const visibleActivities = isPrinting ? activities : activities.slice(0, limit);
    if (visibleActivities.length === 0) {
        elements.activitySummary.textContent = 'Nenhum resultado';
        const canLoadMore = hasMoreActivities ? ' Carregue movimentações anteriores para ampliar a busca.' : '';
        elements.historyMeta.textContent = `Nenhuma movimentação encontrada com esses filtros.${canLoadMore}`;
        setEmptyState('Nenhuma movimentação encontrada.', hasActiveFilters() ? 'Tente limpar ou ajustar os filtros.' : 'As novas vendas e recebimentos aparecerão aqui.');
        return;
    }

    elements.activitySummary.textContent = visibleActivities.length === activities.length
        ? `${activities.length} ${activities.length === 1 ? 'item' : 'itens'}`
        : `${visibleActivities.length} de ${activities.length} itens`;

    const loadedLabel = `${allActivities.length} ${allActivities.length === 1 ? 'movimentação carregada' : 'movimentações carregadas'}`;
    const olderLabel = hasMoreActivities ? ' Há registros anteriores disponíveis.' : ' Todo o histórico foi carregado.';
    elements.historyMeta.textContent = `Exibindo ${visibleActivities.length} de ${activities.length} resultados (${loadedLabel}).${olderLabel}`;
    renderActivityList(visibleActivities);
}

function populateClientOptions() {
    if (!elements.activityClient) return;
    const selected = pendingClientFilter !== 'all'
        ? pendingClientFilter
        : elements.activityClient.value || 'all';
    const clients = new Map();

    Object.entries(clientSummaries || {}).forEach(([clientId, summary]) => {
        if (clientId !== '_meta') clients.set(clientId, summary?.name || 'Cliente');
    });
    allActivities.forEach((item) => {
        if (!clients.has(item.clientId)) clients.set(item.clientId, item.clientName || 'Cliente');
    });

    const options = [...clients.entries()].sort((a, b) => a[1].localeCompare(b[1], 'pt-BR', { sensitivity: 'base' }));
    const fragment = document.createDocumentFragment();
    const allOption = document.createElement('option');
    allOption.value = 'all';
    allOption.textContent = 'Todos os clientes';
    fragment.append(allOption);
    options.forEach(([clientId, clientName]) => {
        const option = document.createElement('option');
        option.value = clientId;
        option.textContent = clientName;
        fragment.append(option);
    });
    elements.activityClient.replaceChildren(fragment);
    const canSelectRequested = selected === 'all' || clients.has(selected);
    elements.activityClient.value = canSelectRequested ? selected : 'all';
    if (canSelectRequested) pendingClientFilter = 'all';
}

function persistFiltersInUrl() {
    if (!filtersInitialized) return;
    const url = new URL(window.location.href);
    const values = {
        q: elements.historySearch?.value.trim() || '',
        type: elements.activityType?.value || 'all',
        client: elements.activityClient?.value || 'all',
        period: selectedPeriod,
        from: selectedPeriod === 'custom' ? elements.historyDateFrom?.value || '' : '',
        to: selectedPeriod === 'custom' ? elements.historyDateTo?.value || '' : '',
        sort: elements.activitySort?.value || 'newest',
        limit: elements.activityLimit?.value || '15',
        archived: elements.historyIncludeArchived?.checked === false ? '0' : '1'
    };

    Object.entries(values).forEach(([key, value]) => {
        const defaults = { type: 'all', client: 'all', period: 'all', sort: 'newest', limit: '15', archived: '1' };
        if (!value || value === defaults[key]) url.searchParams.delete(key);
        else url.searchParams.set(key, value);
    });
    window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
}

function selectPeriod(period, { persist = true } = {}) {
    selectedPeriod = VALID_PERIODS.has(period) ? period : 'all';
    document.querySelectorAll('[data-history-period]').forEach((button) => {
        button.setAttribute('aria-pressed', String(button.dataset.historyPeriod === selectedPeriod));
    });
    elements.historyCustomPeriod.hidden = selectedPeriod !== 'custom';
    if (persist) persistFiltersInUrl();
}

function initializeFiltersFromUrl() {
    const params = new URLSearchParams(window.location.search);
    elements.historySearch.value = params.get('q') || '';
    elements.activityType.value = VALID_TYPES.has(params.get('type')) ? params.get('type') : 'all';
    elements.activitySort.value = VALID_SORTS.has(params.get('sort')) ? params.get('sort') : 'newest';
    elements.activityLimit.value = VALID_LIMITS.has(params.get('limit')) ? params.get('limit') : '15';
    elements.historyIncludeArchived.checked = params.get('archived') !== '0';
    pendingClientFilter = params.get('client') || 'all';
    elements.historyDateFrom.value = params.get('from') || '';
    elements.historyDateTo.value = params.get('to') || '';
    selectPeriod(params.get('period') || 'all', { persist: false });
    filtersInitialized = true;
}

function resetFilters() {
    elements.historySearch.value = '';
    elements.activityType.value = 'all';
    elements.activityClient.value = 'all';
    elements.activitySort.value = 'newest';
    elements.activityLimit.value = '15';
    elements.historyIncludeArchived.checked = true;
    elements.historyDateFrom.value = '';
    elements.historyDateTo.value = '';
    selectPeriod('all', { persist: false });
    persistFiltersInUrl();
    renderActivities();
    elements.historySearch.focus();
}

function syncFiltersPanel() {
    const isMobile = mobileFiltersMedia.matches;
    if (!isMobile) {
        elements.historyFiltersPanel.hidden = false;
        elements.historyFiltersToggle.setAttribute('aria-expanded', 'true');
        return;
    }
    elements.historyFiltersPanel.hidden = !mobileFiltersOpen;
    elements.historyFiltersToggle.setAttribute('aria-expanded', String(mobileFiltersOpen));
}

function setLoadingState(message = 'Carregando movimentações...') {
    elements.historyMeta.textContent = message;
    elements.activitySummary.textContent = 'Carregando...';
    elements.activityList.setAttribute('aria-busy', 'true');
    elements.retryHistoryLoad.hidden = true;
    const skeleton = createElement('div', 'history-skeleton');
    skeleton.setAttribute('aria-label', 'Carregando movimentações');
    skeleton.append(createElement('span'), createElement('span'), createElement('span'));
    elements.activityList.replaceChildren(skeleton);
    setStats([]);
    elements.historyTotalsScope.textContent = 'Os totais serão calculados sobre os resultados filtrados.';
    updatePagination();
}

function showError(message) {
    activitiesReady = true;
    elements.activitySummary.textContent = 'Erro ao carregar';
    elements.historyMeta.textContent = message;
    elements.retryHistoryLoad.hidden = false;
    setStats([]);
    elements.historyTotalsScope.textContent = 'Os totais não estão disponíveis enquanto o histórico não for carregado.';
    setEmptyState('Não foi possível carregar o histórico.', 'Verifique sua conexão e tente novamente.');
}

function isPermissionDenied(error) {
    const code = String(error?.code || '');
    const message = String(error?.message || '');
    return code.includes('PERMISSION_DENIED') || /permission denied/i.test(message);
}

function transactionEntries(sales) {
    if (Array.isArray(sales)) return sales.map((item, index) => [String(index), item]);
    if (sales && typeof sales === 'object') return Object.entries(sales);
    return [];
}

function buildActivityRecord(clientId, clientName, saleItem) {
    const amountCents = amountToCents(saleItem);
    const date = saleItem.date || new Date().toISOString();
    const timestamp = new Date(date).getTime();
    return {
        id: saleItem.id,
        clientId,
        clientName: clientName || 'Cliente',
        type: saleItem.type,
        amount: amountCents / 100,
        amountCents,
        description: saleItem.description || '',
        isNote: Boolean(saleItem.isNote) || (saleItem.type === 'sale' && amountCents === 0),
        hasUnpricedItems: resolveUnpricedItemsFlag(saleItem),
        items: Array.isArray(saleItem.items) ? saleItem.items : [],
        interestPaidCents: Number.isFinite(Number(saleItem.interestPaidCents)) ? Math.round(Number(saleItem.interestPaidCents)) : 0,
        principalPaidCents: Number.isFinite(Number(saleItem.principalPaidCents)) ? Math.round(Number(saleItem.principalPaidCents)) : 0,
        settlesPreviouslyAppliedInterest: saleItem.settlesPreviouslyAppliedInterest === true,
        relatedInterestId: saleItem.relatedInterestId || null,
        relatedPaymentId: saleItem.relatedPaymentId || null,
        automaticInterest: saleItem.automaticInterest === true,
        date,
        timestamp: Number.isFinite(timestamp) ? timestamp : Date.now(),
        editedAt: saleItem.editedAt || null
    };
}

function buildActivityIndexFromClients(clientsMap) {
    const indexed = {};
    Object.entries(clientsMap || {}).forEach(([clientKey, client]) => {
        if (!client || typeof client !== 'object') return;
        const clientId = client.id || clientKey;
        transactionEntries(client.sales).forEach(([, saleItem]) => {
            if (!saleItem?.id || !['sale', 'payment', 'interest'].includes(saleItem.type)) return;
            indexed[`${clientId}_${saleItem.id}`] = buildActivityRecord(clientId, client.name, saleItem);
        });
    });
    return indexed;
}

function comparableActivityRecord(record) {
    if (!record || typeof record !== 'object') return null;
    return {
        id: record.id || '',
        clientId: record.clientId || '',
        clientName: record.clientName || 'Cliente',
        type: record.type || '',
        amountCents: amountToCents(record),
        description: record.description || '',
        isNote: record.isNote === true,
        hasUnpricedItems: record.hasUnpricedItems === true,
        items: Array.isArray(record.items) ? record.items : [],
        interestPaidCents: Math.round(Number(record.interestPaidCents) || 0),
        principalPaidCents: Math.round(Number(record.principalPaidCents) || 0),
        settlesPreviouslyAppliedInterest: record.settlesPreviouslyAppliedInterest === true,
        relatedInterestId: record.relatedInterestId || null,
        relatedPaymentId: record.relatedPaymentId || null,
        automaticInterest: record.automaticInterest === true,
        date: record.date || '',
        timestamp: Number(record.timestamp) || new Date(record.date || 0).getTime() || 0,
        editedAt: record.editedAt || null
    };
}

async function reconcileActivitiesIndex(userId) {
    if (!userId || reconciliationAttempted) return;
    reconciliationAttempted = true;
    try {
        const [clientsSnapshot, activitiesSnapshot] = await Promise.all([
            get(ref(database, `users/${userId}/clients`)),
            get(ref(database, `users/${userId}/activities`))
        ]);
        const expected = buildActivityIndexFromClients(clientsSnapshot.val() || {});
        const current = activitiesSnapshot.val() || {};
        const updates = {};

        Object.entries(expected).forEach(([key, record]) => {
            const currentComparable = JSON.stringify(comparableActivityRecord(current[key]));
            const expectedComparable = JSON.stringify(comparableActivityRecord(record));
            if (currentComparable !== expectedComparable) {
                updates[`users/${userId}/activities/${key}`] = record;
            }
        });
        Object.keys(current).forEach((key) => {
            if (!Object.prototype.hasOwnProperty.call(expected, key)) {
                updates[`users/${userId}/activities/${key}`] = null;
            }
        });

        if (Object.keys(updates).length > 0) {
            await update(ref(database), updates);
        }
    } catch (error) {
        console.warn('Não foi possível reconciliar o índice de atividades:', error?.code || error?.message || error);
    }
}

function mapActivitiesFromClients(clientsMap) {
    return Object.entries(buildActivityIndexFromClients(clientsMap)).map(([key, value]) => normalizeActivityEntry(value, key));
}

function subscribeLegacyClients(userId) {
    legacyUnsubscribe?.();
    usingLegacyFallback = true;
    hasMoreActivities = false;
    setLoadingState('Modo compatibilidade: carregando histórico...');

    legacyUnsubscribe = onValue(ref(database, `users/${userId}/clients`), (snapshot) => {
        activityMap.clear();
        mapActivitiesFromClients(snapshot.val() || {}).forEach((activity) => activityMap.set(activity.key, activity));
        rebuildActivitiesArray();
        activitiesReady = true;
        populateClientOptions();
        renderActivities();
        elements.historyMeta.textContent += ' Modo de compatibilidade ativo.';
    }, (error) => {
        showError('Não foi possível carregar o histórico. Verifique sua conexão.');
        console.error('Erro no modo de compatibilidade do histórico:', error);
    });
}

function subscribeClientSummaries(userId) {
    clientSummariesUnsubscribe?.();
    clientSummariesUnsubscribe = onValue(ref(database, `users/${userId}/clientSummaries`), (snapshot) => {
        clientSummaries = snapshot.val() || {};
        populateClientOptions();
        renderActivities();
    }, (error) => {
        console.warn('Não foi possível carregar os nomes atualizados dos clientes:', error?.code || error?.message || error);
    });
}

function subscribeRecentActivities(userId) {
    activitiesUnsubscribe?.();
    usingLegacyFallback = false;
    setLoadingState();

    const activitiesQuery = query(
        ref(database, `users/${userId}/activities`),
        orderByChild('timestamp'),
        limitToLast(ACTIVITY_PAGE_SIZE + 1)
    );

    activitiesUnsubscribe = onValue(activitiesQuery, (snapshot) => {
        const received = snapshotToActivities(snapshot);
        const recent = received.length > ACTIVITY_PAGE_SIZE ? received.slice(1) : received;
        hasMoreActivities = received.length > ACTIVITY_PAGE_SIZE;

        const nextRecentKeys = new Set(recent.map((item) => item.key));
        const oldestRecent = recent[0] || null;
        recentActivityKeys.forEach((key) => {
            if (nextRecentKeys.has(key) || olderActivityKeys.has(key)) return;
            const previousItem = activityMap.get(key);
            const movedPastLoadedBoundary = olderActivityKeys.size > 0
                && previousItem
                && oldestRecent
                && compareFirebaseActivityOrder(previousItem, oldestRecent) < 0;
            if (movedPastLoadedBoundary) olderActivityKeys.add(key);
            else activityMap.delete(key);
        });
        recentActivityKeys = nextRecentKeys;
        recent.forEach((item) => activityMap.set(item.key, item));
        rebuildActivitiesArray();
        activitiesReady = true;
        populateClientOptions();
        elements.retryHistoryLoad.hidden = true;
        renderActivities();
        void ensureSelectedPeriodLoaded();
    }, (error) => {
        if (isPermissionDenied(error)) {
            subscribeLegacyClients(userId);
            return;
        }
        showError('Não foi possível carregar o histórico. Verifique sua conexão.');
        console.error('Erro ao carregar histórico:', error);
    });
}

function getOldestLoadedActivity() {
    return allActivities.reduce((oldest, item) => {
        if (!oldest) return item;
        if (compareFirebaseActivityOrder(item, oldest) < 0) return item;
        return oldest;
    }, null);
}

function isCurrentFilterCoverageComplete() {
    if (!hasMoreActivities) return true;
    const range = getSelectedDateRange();
    if (range.invalid || range.start === null) return false;
    const oldest = getOldestLoadedActivity();
    return Boolean(oldest && oldest.timestamp < range.start);
}

async function loadMoreActivities({ quiet = false } = {}) {
    if (!currentUserId || isLoadingOlder || !hasMoreActivities || usingLegacyFallback) return false;
    const oldest = getOldestLoadedActivity();
    if (!oldest) {
        hasMoreActivities = false;
        updatePagination();
        return false;
    }

    isLoadingOlder = true;
    if (!quiet) elements.historyMeta.textContent = 'Carregando movimentações anteriores...';
    updatePagination();
    try {
        const olderQuery = query(
            ref(database, `users/${currentUserId}/activities`),
            orderByChild('timestamp'),
            endBefore(oldest.timestamp, oldest.key),
            limitToLast(ACTIVITY_PAGE_SIZE + 1)
        );
        const snapshot = await get(olderQuery);
        const received = snapshotToActivities(snapshot);
        const page = received.length > ACTIVITY_PAGE_SIZE ? received.slice(1) : received;
        hasMoreActivities = received.length > ACTIVITY_PAGE_SIZE;
        page.forEach((item) => {
            olderActivityKeys.add(item.key);
            activityMap.set(item.key, item);
        });
        if (page.length === 0) hasMoreActivities = false;
        rebuildActivitiesArray();
        populateClientOptions();
        renderActivities();
        return page.length > 0;
    } catch (error) {
        elements.historyMeta.textContent = 'Não foi possível carregar movimentações anteriores. Tente novamente.';
        console.error('Erro ao paginar histórico:', error);
        return false;
    } finally {
        isLoadingOlder = false;
        updatePagination();
    }
}

async function loadAllActivities() {
    if (isLoadingAll || usingLegacyFallback || !hasMoreActivities) return;
    isLoadingAll = true;
    updatePagination();
    try {
        while (hasMoreActivities) {
            const loaded = await loadMoreActivities({ quiet: true });
            elements.historyMeta.textContent = `Preparando histórico completo: ${allActivities.length} movimentações carregadas...`;
            if (!loaded) break;
        }
    } finally {
        isLoadingAll = false;
        renderActivities();
    }
}

async function ensureSelectedPeriodLoaded() {
    if (isEnsuringPeriod || isLoadingAll || usingLegacyFallback || !hasMoreActivities) return;
    const range = getSelectedDateRange();
    if (range.invalid || range.start === null) return;

    isEnsuringPeriod = true;
    try {
        let oldest = getOldestLoadedActivity();
        while (hasMoreActivities && oldest && oldest.timestamp >= range.start) {
            const loaded = await loadMoreActivities({ quiet: true });
            if (!loaded) break;
            oldest = getOldestLoadedActivity();
        }
    } finally {
        isEnsuringPeriod = false;
        renderActivities();
    }
}

function escapeCsvValue(value) {
    const text = String(value ?? '').replace(/\r?\n/g, ' ');
    return `"${text.replace(/"/g, '""')}"`;
}

async function exportFilteredActivitiesCsv() {
    elements.exportHistoryCsv.disabled = true;
    const originalText = elements.exportHistoryCsv.textContent;
    elements.exportHistoryCsv.textContent = 'Preparando CSV...';
    try {
        await loadAllActivities();
        const { invalidRange, activities } = getFilteredActivities();
        if (invalidRange || activities.length === 0) {
            elements.historyMeta.textContent = invalidRange
                ? 'Revise o período antes de exportar.'
                : 'Não há movimentações para exportar com os filtros atuais.';
            return;
        }

        const rows = [
            ['Data', 'Hora', 'Tipo', 'Cliente', 'Descrição', 'Valor', 'Editado', 'Automático', 'Arquivado'],
            ...activities.map((item) => {
                const date = getValidDate(item.date);
                return [
                    date ? shortDateFormatter.format(date) : '',
                    date ? timeFormatter.format(date) : '',
                    getActivityLabel(item),
                    item.clientName,
                    item.description,
                    (item.amountCents / 100).toFixed(2).replace('.', ','),
                    item.editedAt ? 'Sim' : 'Não',
                    item.automaticInterest ? 'Sim' : 'Não',
                    item.archived ? 'Sim' : 'Não'
                ];
            })
        ];
        const csv = `\uFEFF${rows.map((row) => row.map(escapeCsvValue).join(';')).join('\r\n')}`;
        const blobUrl = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
        const link = document.createElement('a');
        link.href = blobUrl;
        link.download = `historico-vivi-${toDateInputValue(new Date())}.csv`;
        document.body.append(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(blobUrl);
        elements.historyMeta.textContent = `${activities.length} movimentações exportadas para CSV.`;
    } finally {
        elements.exportHistoryCsv.disabled = false;
        elements.exportHistoryCsv.textContent = originalText;
    }
}

function finishPrintMode() {
    if (!isPrinting) return;
    isPrinting = false;
    document.body.classList.remove('history-printing');
    renderActivities();
}

async function printFilteredHistory() {
    elements.printHistory.disabled = true;
    const originalText = elements.printHistory.textContent;
    elements.printHistory.textContent = 'Preparando impressão...';
    try {
        await loadAllActivities();
        const { invalidRange, activities } = getFilteredActivities();
        if (invalidRange || activities.length === 0) {
            elements.historyMeta.textContent = invalidRange
                ? 'Revise o período antes de imprimir.'
                : 'Não há movimentações para imprimir com os filtros atuais.';
            return;
        }
        isPrinting = true;
        document.body.classList.add('history-printing');
        renderActivities();
        await new Promise((resolve) => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve)));
        window.print();
        window.setTimeout(finishPrintMode, 1000);
    } finally {
        elements.printHistory.disabled = false;
        elements.printHistory.textContent = originalText;
    }
}

function setupThemeToggle() {
    elements.themeToggle?.addEventListener('click', () => {
        const html = document.documentElement;
        const newTheme = html.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
        html.setAttribute('data-theme', newTheme);
        localStorage.setItem('theme', newTheme);
    });
}

function setHistoryMenuOpen(isOpen) {
    const { historyMenu, historyMenuOverlay, historyMenuToggle } = elements;
    if (!historyMenu || !historyMenuOverlay || !historyMenuToggle) return;

    historyMenu.classList.toggle('open', isOpen);
    document.body.classList.toggle('menu-open', isOpen);
    historyMenu.setAttribute('aria-hidden', String(!isOpen));
    historyMenu.toggleAttribute('inert', !isOpen);
    historyMenuOverlay.hidden = !isOpen;
    historyMenuToggle.setAttribute('aria-expanded', String(isOpen));

    if (isOpen) {
        const firstMenuItem = historyMenu.querySelector('.app-menu-link, .btn-menu-close');
        firstMenuItem?.focus({ preventScroll: true });
    } else if (document.activeElement && historyMenu.contains(document.activeElement)) {
        historyMenuToggle.focus({ preventScroll: true });
    }
}

function trapMenuFocus(event) {
    if (event.key !== 'Tab' || !elements.historyMenu?.classList.contains('open')) return;
    const focusable = [...elements.historyMenu.querySelectorAll('a[href], button:not([disabled])')];
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
    }
}

function setupHistoryMenu() {
    if (!elements.historyMenu || !elements.historyMenuOverlay || !elements.historyMenuToggle || !elements.historyMenuClose) return;
    elements.historyMenuToggle.addEventListener('click', () => setHistoryMenuOpen(true));
    elements.historyMenuClose.addEventListener('click', () => setHistoryMenuOpen(false));
    elements.historyMenuOverlay.addEventListener('click', () => setHistoryMenuOpen(false));
    elements.historyMenu.querySelectorAll('.app-menu-link').forEach((link) => {
        link.addEventListener('click', () => setHistoryMenuOpen(false));
    });
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') setHistoryMenuOpen(false);
        trapMenuFocus(event);
    });
    window.addEventListener('resize', () => setHistoryMenuOpen(false));
}

function unsubscribeAll() {
    activitiesUnsubscribe?.();
    legacyUnsubscribe?.();
    clientSummariesUnsubscribe?.();
    activitiesUnsubscribe = null;
    legacyUnsubscribe = null;
    clientSummariesUnsubscribe = null;
}

function resetActivityState() {
    activityMap.clear();
    recentActivityKeys = new Set();
    olderActivityKeys = new Set();
    allActivities = [];
    clientSummaries = {};
    hasMoreActivities = false;
    activitiesReady = false;
    isLoadingOlder = false;
    isLoadingAll = false;
    isEnsuringPeriod = false;
    usingLegacyFallback = false;
    reconciliationAttempted = false;
}

function retryHistoryLoad() {
    if (!currentUserId) return;
    unsubscribeAll();
    resetActivityState();
    subscribeClientSummaries(currentUserId);
    subscribeRecentActivities(currentUserId);
    void reconcileActivitiesIndex(currentUserId);
}

const debouncedSearchRender = debounce(() => {
    persistFiltersInUrl();
    renderActivities();
}, SEARCH_DEBOUNCE_MS);

function setupFilterEvents() {
    elements.historySearch?.addEventListener('input', debouncedSearchRender);
    [elements.activityLimit, elements.activityType, elements.activityClient, elements.activitySort, elements.historyIncludeArchived]
        .forEach((control) => control?.addEventListener('change', () => {
            if (control === elements.activityClient) pendingClientFilter = 'all';
            persistFiltersInUrl();
            renderActivities();
        }));
    [elements.historyDateFrom, elements.historyDateTo].forEach((control) => control?.addEventListener('change', () => {
        persistFiltersInUrl();
        renderActivities();
        void ensureSelectedPeriodLoaded();
    }));
    document.querySelectorAll('[data-history-period]').forEach((button) => {
        button.addEventListener('click', () => {
            selectPeriod(button.dataset.historyPeriod);
            renderActivities();
            void ensureSelectedPeriodLoaded();
        });
    });
    elements.clearHistoryFilters?.addEventListener('click', resetFilters);
    elements.historyFiltersToggle?.addEventListener('click', () => {
        mobileFiltersOpen = !mobileFiltersOpen;
        syncFiltersPanel();
    });
    mobileFiltersMedia.addEventListener?.('change', syncFiltersPanel);
    elements.loadMoreHistory?.addEventListener('click', () => void loadMoreActivities());
    elements.loadAllHistory?.addEventListener('click', () => void loadAllActivities());
    elements.exportHistoryCsv?.addEventListener('click', () => void exportFilteredActivitiesCsv());
    elements.printHistory?.addEventListener('click', () => void printFilteredHistory());
    elements.retryHistoryLoad?.addEventListener('click', retryHistoryLoad);

    elements.activityList?.addEventListener('click', (event) => {
        const toggle = event.target.closest('.activity-description-toggle');
        if (toggle) {
            event.stopPropagation();
            const description = document.getElementById(toggle.getAttribute('aria-controls'));
            const expanded = toggle.getAttribute('aria-expanded') === 'true';
            toggle.setAttribute('aria-expanded', String(!expanded));
            toggle.textContent = expanded ? 'Ver mais' : 'Ver menos';
            description?.classList.toggle('is-collapsed', expanded);
            return;
        }
        if (event.target.closest('a')) return;
        const item = event.target.closest('.activity-item[data-href]');
        if (item?.dataset.href) window.location.href = item.dataset.href;
    });
}

setupThemeToggle();
setupHistoryMenu();
initializeFiltersFromUrl();
setupFilterEvents();
syncFiltersPanel();
window.addEventListener('afterprint', finishPrintMode);

onAuthStateChanged(auth, (user) => {
    if (!user) {
        unsubscribeAll();
        currentUserId = '';
        window.location.href = './index.html';
        return;
    }

    unsubscribeAll();
    resetActivityState();
    currentUserId = user.uid;
    subscribeClientSummaries(user.uid);
    subscribeRecentActivities(user.uid);
    void reconcileActivitiesIndex(user.uid);
});
