const APP_VERSION = '2.3.4';
const PAGE_SIZE = 30;
const DAY_IN_MS = 24 * 60 * 60 * 1000;
const DEFAULT_OVERDUE_ALERT_DAYS = 60;
const MAX_OVERDUE_ALERT_DAYS = 3650;
const DEFAULT_OVERDUE_RESET_PAYMENT_PERCENT = 20;
const MAX_OVERDUE_INTEREST_PERCENT = 100;
const CLIENT_INTEREST_MODE_GLOBAL = 'global';
const CLIENT_INTEREST_MODE_CUSTOM = 'custom';
const CLIENT_INTEREST_MODE_DISABLED = 'disabled';
const TRANSACTION_TYPE_SALE = 'sale';
const TRANSACTION_TYPE_PAYMENT = 'payment';
const TRANSACTION_TYPE_INTEREST = 'interest';
const QR_CODE_URL = 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js';
const PIX_KEY = '00020126580014BR.GOV.BCB.PIX013617f7af49-8c45-42b3-af8d-08ced311b87f5204000053039865802BR5919Jones Vieira Cabral6009SAO PAULO621405108GFi9k39TN63044602';

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
const dateFormatter = new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric'
});
const timeFormatter = new Intl.DateTimeFormat('pt-BR', {
    hour: '2-digit',
    minute: '2-digit'
});

const elements = {
    loadingScreen: document.getElementById('loadingScreen'),
    errorScreen: document.getElementById('errorScreen'),
    errorDetail: document.getElementById('errorDetail'),
    contentScreen: document.getElementById('contentScreen'),
    statusCard: document.querySelector('.status-card'),
    statusIcon: document.getElementById('statusIcon'),
    statusValue: document.getElementById('statusValue'),
    statusText: document.getElementById('statusText'),
    interestDeadline: document.getElementById('interestDeadline'),
    interestDeadlineText: document.getElementById('interestDeadlineText'),
    interestRulesButton: document.getElementById('interestRulesButton'),
    interestRulesBackdrop: document.getElementById('interestRulesBackdrop'),
    interestRulesTooltip: document.getElementById('interestRulesTooltip'),
    interestRulesClose: document.getElementById('interestRulesClose'),
    interestRulesContent: document.getElementById('interestRulesContent'),
    transactionsList: document.getElementById('transactionsList'),
    historyControls: document.getElementById('historyControls'),
    historySummary: document.getElementById('historySummary'),
    loadMoreButton: document.getElementById('loadMoreButton'),
    pixPaymentDiv: document.getElementById('pixPaymentDiv')
};

const state = {
    database: null,
    databaseApi: null,
    userId: '',
    clientId: '',
    settings: getDefaultSettings(),
    settingsReadyFields: new Set(),
    settingsReady: false,
    summary: null,
    summarySource: '',
    summaryReady: false,
    legacyClientData: null,
    legacyClientPromise: null,
    transactions: new Map(),
    recentKeys: new Set(),
    olderKeys: new Set(),
    transactionsReady: false,
    hasMoreHint: false,
    renderFrame: 0,
    lastStatusSignature: '',
    qrLibraryPromise: null,
    qrGenerated: false,
    pixInitialized: false
};

function getDefaultSettings() {
    return {
        overdueAlertDays: DEFAULT_OVERDUE_ALERT_DAYS,
        overdueInterest: { enabled: false, percent: 0 },
        overdueResetPaymentPercent: DEFAULT_OVERDUE_RESET_PAYMENT_PERCENT
    };
}

function escapeHTML(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function formatCurrency(value) {
    return currencyFormatter.format(Number(value) || 0);
}

function currencyToCents(value) {
    const numericValue = Number(value);
    return Number.isFinite(numericValue) ? Math.round((numericValue + Number.EPSILON) * 100) : 0;
}

function centsToAmount(cents) {
    const numericCents = Number(cents);
    return Number.isFinite(numericCents) ? Math.round(numericCents) / 100 : 0;
}

function getTransactionAmountCents(item) {
    const directCents = Number(item?.amountCents);
    return Number.isFinite(directCents) ? Math.round(directCents) : currencyToCents(item?.amount);
}

function getTransactionTime(item) {
    const time = new Date(item?.date || 0).getTime();
    return Number.isFinite(time) ? time : 0;
}

function getDebtDeltaCents(item) {
    const amountCents = getTransactionAmountCents(item);
    if (item?.type === TRANSACTION_TYPE_SALE || item?.type === TRANSACTION_TYPE_INTEREST) return amountCents;
    if (item?.type === TRANSACTION_TYPE_PAYMENT) return -amountCents;
    return 0;
}

function isAutomaticInterestTransaction(item) {
    return item?.type === TRANSACTION_TYPE_INTEREST
        && (item.automaticInterest === true
            || Boolean(item.relatedPaymentId)
            || /^Juros por atraso/i.test(String(item.description || '')));
}

function parsePercentage(value, fallback = 0, minimum = 0, maximum = 100) {
    const parsedValue = typeof value === 'string'
        ? Number.parseFloat(value.replace(',', '.'))
        : Number.parseFloat(value);
    if (!Number.isFinite(parsedValue)) return fallback;
    return Math.round(Math.min(maximum, Math.max(minimum, parsedValue)) * 100) / 100;
}

function normalizeOverdueAlertDays(value) {
    const parsedValue = Number.parseInt(value, 10);
    if (!Number.isFinite(parsedValue)) return DEFAULT_OVERDUE_ALERT_DAYS;
    return Math.min(MAX_OVERDUE_ALERT_DAYS, Math.max(1, parsedValue));
}

function normalizeOverdueInterestPercent(value) {
    return parsePercentage(value, 0, 0, MAX_OVERDUE_INTEREST_PERCENT);
}

function normalizeOverdueResetPaymentPercent(value) {
    return parsePercentage(value, DEFAULT_OVERDUE_RESET_PAYMENT_PERCENT);
}

function normalizeOverdueInterest(value) {
    const interest = value && typeof value === 'object' ? value : {};
    return {
        enabled: interest.enabled === true,
        percent: normalizeOverdueInterestPercent(interest.percent)
    };
}

function normalizeClientOverdueInterestOverride(value) {
    if (!value || typeof value !== 'object') return null;
    if (value.mode === CLIENT_INTEREST_MODE_DISABLED) {
        return { mode: CLIENT_INTEREST_MODE_DISABLED, enabled: false, percent: 0 };
    }
    if (value.mode !== CLIENT_INTEREST_MODE_CUSTOM) return null;
    const percent = normalizeOverdueInterestPercent(value.percent);
    return { mode: CLIENT_INTEREST_MODE_CUSTOM, enabled: percent > 0, percent };
}

function formatOverdueInterestPercent(value) {
    const percent = normalizeOverdueInterestPercent(value);
    return `${percent.toLocaleString('pt-BR', {
        minimumFractionDigits: Number.isInteger(percent) ? 0 : 2,
        maximumFractionDigits: 2
    })}%`;
}

function formatOverdueResetPaymentPercent(value) {
    const percent = normalizeOverdueResetPaymentPercent(value);
    return `${percent.toLocaleString('pt-BR', {
        minimumFractionDigits: Number.isInteger(percent) ? 0 : 2,
        maximumFractionDigits: 2
    })}%`;
}

function formatDate(dateValue) {
    const date = new Date(dateValue);
    return Number.isNaN(date.getTime()) ? 'Data indisponível' : dateTimeFormatter.format(date);
}

function formatDeadlineDate(dateValue) {
    if (!dateValue) return '';
    const date = new Date(dateValue);
    if (Number.isNaN(date.getTime())) return '';
    return `${dateFormatter.format(date)} às ${timeFormatter.format(date)}`;
}

function normalizePublicSummary(value) {
    if (!value || typeof value !== 'object') return null;
    return {
        version: Number(value.version) || 1,
        baseDebtCents: Math.round(Number(value.baseDebtCents) || 0),
        principalDebtCents: Math.round(Number(value.principalDebtCents) || 0),
        outstandingInterestCents: Math.max(0, Math.round(Number(value.outstandingInterestCents) || 0)),
        transactionCount: Math.max(0, Math.round(Number(value.transactionCount) || 0)),
        referenceDate: value.referenceDate || null,
        lastAutomaticInterestDate: value.lastAutomaticInterestDate || null,
        overdueResetPaymentPercent: normalizeOverdueResetPaymentPercent(value.overdueResetPaymentPercent),
        overdueInterestOverride: normalizeClientOverdueInterestOverride(value.overdueInterestOverride)
    };
}

function normalizeTransactions(sales) {
    const entries = Array.isArray(sales)
        ? sales.map((item, index) => [String(index), item])
        : Object.entries(sales || {});

    return entries
        .filter(([, item]) => item && typeof item === 'object')
        .map(([key, item], index) => ({
            key,
            item,
            index,
            time: getTransactionTime(item),
            dateValue: String(item.date || '')
        }))
        .sort(compareTransactionsAscending);
}

function compareTransactionsAscending(firstEntry, secondEntry) {
    const timeDifference = firstEntry.time - secondEntry.time;
    if (timeDifference !== 0) return timeDifference;
    const keyDifference = String(firstEntry.key).localeCompare(String(secondEntry.key), 'pt-BR', { numeric: true });
    return keyDifference !== 0 ? keyDifference : (firstEntry.index || 0) - (secondEntry.index || 0);
}

function compareFirebaseKeys(firstEntry, secondEntry) {
    const firstKey = String(firstEntry.key);
    const secondKey = String(secondEntry.key);
    const firstNumber = /^\d+$/.test(firstKey) ? Number(firstKey) : Number.NaN;
    const secondNumber = /^\d+$/.test(secondKey) ? Number(secondKey) : Number.NaN;
    if (Number.isFinite(firstNumber) && Number.isFinite(secondNumber)) return firstNumber - secondNumber;
    if (Number.isFinite(firstNumber)) return -1;
    if (Number.isFinite(secondNumber)) return 1;
    return firstKey.localeCompare(secondKey);
}

function paymentMeetsResetThreshold(item, debtBeforePaymentCents, resetPercent) {
    const paymentCents = getTransactionAmountCents(item);
    if (paymentCents <= 0 || debtBeforePaymentCents <= 0) return false;
    const safePercent = normalizeOverdueResetPaymentPercent(resetPercent);
    if (safePercent <= 0) return true;
    return paymentCents >= Math.ceil(debtBeforePaymentCents * (safePercent / 100));
}

function buildLegacySummary(clientData) {
    const transactions = normalizeTransactions(clientData?.sales);
    const resetPercent = normalizeOverdueResetPaymentPercent(state.settings.overdueResetPaymentPercent);
    let baseDebtCents = 0;
    let principalDebtCents = 0;
    let outstandingInterestCents = 0;
    let firstSaleDate = null;
    let lastPaymentDate = null;
    let lastAutomaticInterestDate = null;

    transactions.forEach(({ item, time }) => {
        const itemDate = time > 0 ? new Date(time) : null;
        const debtBeforeTransactionCents = baseDebtCents;
        const amountCents = getTransactionAmountCents(item);

        if (
            item.type === TRANSACTION_TYPE_PAYMENT
            && itemDate
            && paymentMeetsResetThreshold(item, debtBeforeTransactionCents, resetPercent)
        ) {
            lastPaymentDate = itemDate;
        }

        if (item.type === TRANSACTION_TYPE_SALE) {
            baseDebtCents += amountCents;
            principalDebtCents += amountCents;
        } else if (item.type === TRANSACTION_TYPE_INTEREST) {
            baseDebtCents += amountCents;
            outstandingInterestCents += amountCents;
            if (isAutomaticInterestTransaction(item) && itemDate) lastAutomaticInterestDate = itemDate;
        } else if (item.type === TRANSACTION_TYPE_PAYMENT) {
            baseDebtCents -= amountCents;
            const paymentCents = Math.max(0, amountCents);
            const interestPaidCents = Math.min(paymentCents, Math.max(0, outstandingInterestCents));
            outstandingInterestCents -= interestPaidCents;
            principalDebtCents -= paymentCents - interestPaidCents;
        }

        if (debtBeforeTransactionCents <= 0 && baseDebtCents > 0 && itemDate) {
            firstSaleDate = itemDate;
            lastPaymentDate = null;
        }
        if (baseDebtCents <= 0) {
            firstSaleDate = null;
            lastPaymentDate = null;
        }
    });

    const referenceDate = lastPaymentDate || firstSaleDate;
    return normalizePublicSummary({
        version: 1,
        baseDebtCents,
        principalDebtCents,
        outstandingInterestCents,
        transactionCount: transactions.length,
        referenceDate: referenceDate?.toISOString() || null,
        lastAutomaticInterestDate: lastAutomaticInterestDate?.toISOString() || null,
        overdueResetPaymentPercent: resetPercent,
        overdueInterestOverride: clientData?.overdueInterestOverride || null
    });
}

function getEffectiveInterestSettings(summary) {
    const clientOverride = normalizeClientOverdueInterestOverride(summary?.overdueInterestOverride);
    if (clientOverride) return clientOverride;
    return {
        mode: CLIENT_INTEREST_MODE_GLOBAL,
        enabled: state.settings.overdueInterest.enabled === true,
        percent: normalizeOverdueInterestPercent(state.settings.overdueInterest.percent)
    };
}

function calculateDebtDetails(summary) {
    const baseDebtCents = Math.round(Number(summary?.baseDebtCents) || 0);
    const principalDebtCents = Math.round(Number(summary?.principalDebtCents) || 0);
    const referenceDate = summary?.referenceDate ? new Date(summary.referenceDate) : null;
    const referenceTime = referenceDate && !Number.isNaN(referenceDate.getTime()) ? referenceDate.getTime() : 0;
    const daysSinceRef = baseDebtCents > 0 && referenceTime > 0
        ? Math.max(0, Math.floor((Date.now() - referenceTime) / DAY_IN_MS))
        : 0;
    const overdueDays = normalizeOverdueAlertDays(state.settings.overdueAlertDays);
    const isOverdue = baseDebtCents > 0 && daysSinceRef >= overdueDays;
    const interestSettings = getEffectiveInterestSettings(summary);
    const interestPercent = normalizeOverdueInterestPercent(interestSettings.percent);
    const interestEnabled = interestSettings.enabled === true && interestPercent > 0;
    const lastAutomaticInterestTime = summary?.lastAutomaticInterestDate
        ? new Date(summary.lastAutomaticInterestDate).getTime()
        : 0;
    const interestAlreadyApplied = isOverdue
        && referenceTime > 0
        && Number.isFinite(lastAutomaticInterestTime)
        && lastAutomaticInterestTime > referenceTime;
    const interestBaseCents = Math.min(Math.max(0, principalDebtCents), baseDebtCents);
    const projectedInterestCents = interestEnabled && interestBaseCents > 0 && !interestAlreadyApplied
        ? Math.round(interestBaseCents * (interestPercent / 100))
        : 0;
    const interestCents = isOverdue ? projectedInterestCents : 0;
    const totalDebtCents = baseDebtCents + interestCents;
    const projectedTotalDebtCents = baseDebtCents + projectedInterestCents;
    const resetPaymentPercent = normalizeOverdueResetPaymentPercent(state.settings.overdueResetPaymentPercent);
    const minimumPaymentBaseCents = isOverdue ? totalDebtCents : baseDebtCents;
    const minimumPaymentCents = resetPaymentPercent <= 0
        ? 0
        : Math.ceil(minimumPaymentBaseCents * (resetPaymentPercent / 100));
    const interestDeadlineDate = referenceTime > 0
        ? new Date(referenceTime + overdueDays * DAY_IN_MS)
        : null;

    return {
        baseDebt: centsToAmount(baseDebtCents),
        totalDebt: centsToAmount(totalDebtCents),
        projectedTotalDebt: centsToAmount(projectedTotalDebtCents),
        interestAmount: centsToAmount(interestCents),
        projectedInterestAmount: centsToAmount(projectedInterestCents),
        minimumPaymentAmount: centsToAmount(minimumPaymentCents),
        interestMode: interestSettings.mode,
        interestPercent,
        interestEnabled,
        resetPaymentPercent,
        daysSinceRef,
        daysUntilInterest: interestEnabled && baseDebtCents > 0 ? Math.max(0, overdueDays - daysSinceRef) : null,
        interestDeadlineDate,
        overdueDays,
        isOverdue
    };
}

function shouldShowInterestInformation(debtDetails) {
    if (debtDetails?.interestMode === CLIENT_INTEREST_MODE_DISABLED) return false;
    return debtDetails?.interestEnabled === true && Number(debtDetails?.baseDebt) > 0;
}

function buildInterestDeadlineHTML(debtDetails) {
    if (!shouldShowInterestInformation(debtDetails)) return '';
    const formattedPercent = formatOverdueInterestPercent(debtDetails.interestPercent);
    const resetPaymentPercent = normalizeOverdueResetPaymentPercent(debtDetails.resetPaymentPercent);
    const minimumPaymentText = formatOverdueResetPaymentPercent(resetPaymentPercent);
    const minimumPaymentAmountText = `R$ ${formatCurrency(debtDetails.minimumPaymentAmount)}`;
    const displayedInterestAmount = debtDetails.isOverdue ? debtDetails.interestAmount : debtDetails.projectedInterestAmount;
    const interestAmountText = `R$ ${formatCurrency(displayedInterestAmount)}`;
    const deadlineDateText = formatDeadlineDate(debtDetails.interestDeadlineDate);
    const overdueLimit = Number(debtDetails.overdueDays);
    const paymentTitle = resetPaymentPercent <= 0
        ? 'Faça um pagamento de qualquer valor'
        : `Pague <span class="interest-summary-payment-amount">${minimumPaymentAmountText}</span> ou mais`;
    const paymentNote = resetPaymentPercent <= 0
        ? 'Qualquer valor reduz a dívida e renova o prazo.'
        : `Mínimo de ${minimumPaymentText} do saldo ${debtDetails.isOverdue ? 'com juros' : 'atual'}. Valor menor reduz a dívida, mas não ${debtDetails.isOverdue ? 'inicia um novo prazo' : 'renova o prazo'}.`;

    if (debtDetails.isOverdue) {
        const daysOverdue = Math.max(0, Number(debtDetails.daysSinceRef) - overdueLimit);
        const overdueTitle = daysOverdue <= 0
            ? 'Prazo encerrado hoje'
            : daysOverdue === 1 ? 'Encerrado há 1 dia' : `Encerrado há <span class="interest-summary-days">${daysOverdue} dias</span>`;
        const deadlineSupport = deadlineDateText ? `Desde <strong>${deadlineDateText}</strong>.` : '';
        return `
            <section class="interest-summary-section interest-summary-status">
                <span class="interest-summary-kicker">Prazo sem juros</span>
                <h2 class="interest-summary-title">${overdueTitle}</h2>
                ${deadlineSupport ? `<p class="interest-summary-support">${deadlineSupport}</p>` : ''}
            </section>
            <section class="interest-summary-section interest-summary-consequence">
                <h2 class="interest-summary-kicker">Juros incluídos no saldo atual</h2>
                <p class="interest-summary-row"><span>Juros de ${formattedPercent}</span><strong class="interest-summary-interest-amount">${interestAmountText}</strong></p>
            </section>
            <section class="interest-summary-section interest-summary-action">
                <span class="interest-summary-kicker">Pagamento mínimo para novo prazo</span>
                <h2 class="interest-summary-title">${paymentTitle}</h2>
                <p class="interest-summary-note">${paymentNote}</p>
            </section>`;
    }

    const daysUntilInterest = Number(debtDetails.daysUntilInterest);
    if (!Number.isFinite(daysUntilInterest)) return '';
    const deadlineTitle = daysUntilInterest <= 0
        ? 'Termina hoje'
        : daysUntilInterest === 1 ? '<span class="interest-summary-days">1 dia</span> restante' : `<span class="interest-summary-days">${daysUntilInterest} dias</span> restantes`;
    const deadlineSupport = deadlineDateText ? `Até <strong>${deadlineDateText}</strong>.` : '';
    const missedPaymentLabel = resetPaymentPercent <= 0 ? 'Se não houver pagamento' : 'Se não pagar o mínimo';
    return `
        <section class="interest-summary-section interest-summary-status">
            <span class="interest-summary-kicker">Prazo sem juros</span>
            <h2 class="interest-summary-title">${deadlineTitle}</h2>
            ${deadlineSupport ? `<p class="interest-summary-support">${deadlineSupport}</p>` : ''}
        </section>
        <section class="interest-summary-section interest-summary-action">
            <span class="interest-summary-kicker">Pagamento mínimo para renovar</span>
            <h2 class="interest-summary-title">${paymentTitle}</h2>
            <p class="interest-summary-note">${paymentNote}</p>
        </section>
        <section class="interest-summary-section interest-summary-consequence">
            <h2 class="interest-summary-kicker">${missedPaymentLabel}</h2>
            <p class="interest-summary-row"><span>Juros de ${formattedPercent}</span><strong class="interest-summary-interest-amount">+ ${interestAmountText}</strong></p>
            <p class="interest-summary-row"><span>Novo saldo</span><strong class="interest-summary-total">R$ ${formatCurrency(debtDetails.projectedTotalDebt)}</strong></p>
        </section>`;
}

function buildInterestRulesHTML(debtDetails) {
    if (!shouldShowInterestInformation(debtDetails)) return '';
    const formattedInterest = formatOverdueInterestPercent(debtDetails.interestPercent);
    const displayedInterestAmount = debtDetails.isOverdue ? debtDetails.interestAmount : debtDetails.projectedInterestAmount;
    const formattedInterestAmount = `R$ ${formatCurrency(displayedInterestAmount)}`;
    const resetPaymentPercent = normalizeOverdueResetPaymentPercent(debtDetails.resetPaymentPercent);
    const formattedResetPayment = formatOverdueResetPaymentPercent(resetPaymentPercent);
    const formattedMinimumPayment = `R$ ${formatCurrency(debtDetails.minimumPaymentAmount)}`;
    const overdueLimit = Number(debtDetails.overdueDays);
    const overdueLimitText = overdueLimit === 1 ? '1 dia' : `${overdueLimit} dias`;
    const deadlineDateText = formatDeadlineDate(debtDetails.interestDeadlineDate);
    const paymentRule = resetPaymentPercent <= 0
        ? 'faça um pagamento de qualquer valor.'
        : `pague ${formattedMinimumPayment} ou mais (${formattedResetPayment} do saldo ${debtDetails.isOverdue ? 'com juros' : 'atual'}).`;
    const smallerPaymentRule = resetPaymentPercent <= 0
        ? 'O pagamento reduz a dívida e reinicia a contagem.'
        : `Pagamentos menores reduzem a dívida, mas não ${debtDetails.isOverdue ? 'iniciam um novo prazo' : 'renovam o prazo'}.`;

    if (debtDetails.isOverdue) {
        return `<ol class="interest-rules-steps">
            <li><strong>Prazo encerrado${deadlineDateText ? ` em ${deadlineDateText}` : ''}.</strong><span>Juros: ${formattedInterestAmount} (${formattedInterest}). Saldo atual: R$ ${formatCurrency(debtDetails.totalDebt)}.</span></li>
            <li><strong>Para iniciar um novo prazo de ${overdueLimitText}, ${paymentRule}</strong><span>${smallerPaymentRule}</span></li>
        </ol>`;
    }
    return `<ol class="interest-rules-steps">
        <li><strong>Para renovar por mais ${overdueLimitText}, ${paymentRule}</strong><span>${deadlineDateText ? `Até ${deadlineDateText}. ` : ''}${smallerPaymentRule}</span></li>
        <li><strong>Se não pagar o mínimo, os juros serão de ${formattedInterestAmount} (${formattedInterest}).</strong><span>Novo saldo estimado: R$ ${formatCurrency(debtDetails.projectedTotalDebt)}.</span></li>
    </ol>`;
}

let interestRulesPreviousFocus = null;

function setInterestRulesOpen(isOpen) {
    const { interestRulesTooltip, interestRulesButton, interestRulesBackdrop } = elements;
    if (!interestRulesTooltip || !interestRulesButton || !interestRulesBackdrop) return;
    const wasOpen = !interestRulesTooltip.hidden;
    if (isOpen && !wasOpen) interestRulesPreviousFocus = document.activeElement;
    interestRulesTooltip.hidden = !isOpen;
    interestRulesBackdrop.hidden = !isOpen;
    interestRulesButton.setAttribute('aria-expanded', String(isOpen));
    document.body.classList.toggle('interest-rules-open', isOpen);
    if (isOpen) {
        requestAnimationFrame(() => elements.interestRulesClose?.focus());
    } else if (wasOpen) {
        const focusTarget = interestRulesPreviousFocus?.isConnected ? interestRulesPreviousFocus : interestRulesButton;
        interestRulesPreviousFocus = null;
        focusTarget?.focus();
    }
}

function bindInterestDialog() {
    elements.interestRulesButton?.addEventListener('click', () => setInterestRulesOpen(elements.interestRulesTooltip?.hidden));
    elements.interestRulesClose?.addEventListener('click', () => setInterestRulesOpen(false));
    elements.interestRulesBackdrop?.addEventListener('click', () => setInterestRulesOpen(false));
    document.addEventListener('click', (event) => {
        if (elements.interestRulesTooltip?.hidden) return;
        if (elements.interestRulesTooltip.contains(event.target) || elements.interestRulesButton?.contains(event.target)) return;
        setInterestRulesOpen(false);
    });
    document.addEventListener('keydown', (event) => {
        if (elements.interestRulesTooltip?.hidden) return;
        if (event.key === 'Escape') {
            setInterestRulesOpen(false);
            return;
        }
        if (event.key !== 'Tab') return;
        const focusableElements = [...elements.interestRulesTooltip.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
            .filter((element) => !element.hidden && !element.disabled);
        const firstFocusable = focusableElements[0];
        const lastFocusable = focusableElements[focusableElements.length - 1];
        if (!firstFocusable) {
            event.preventDefault();
            elements.interestRulesTooltip.focus();
        } else if (event.shiftKey && document.activeElement === firstFocusable) {
            event.preventDefault();
            lastFocusable.focus();
        } else if (!event.shiftKey && document.activeElement === lastFocusable) {
            event.preventDefault();
            firstFocusable.focus();
        }
    });
}

function showError(message = 'Verifique se o link está correto.') {
    elements.loadingScreen.hidden = true;
    elements.contentScreen.hidden = true;
    elements.errorScreen.hidden = false;
    elements.errorDetail.textContent = message;
}

function showContent() {
    elements.loadingScreen.hidden = true;
    elements.errorScreen.hidden = true;
    elements.contentScreen.hidden = false;
}

function renderStatus(debtDetails) {
    const signature = JSON.stringify({ summary: state.summary, settings: state.settings, debtDetails });
    if (signature === state.lastStatusSignature) return;
    state.lastStatusSignature = signature;
    const debt = debtDetails.totalDebt;
    const isCredit = debt < 0;
    const isPaid = debt === 0;
    elements.statusCard.classList.remove('debt-status', 'credit-status', 'paid-status');

    if (isPaid) {
        elements.statusIcon.textContent = '✅';
        elements.statusValue.textContent = 'R$ 0,00';
        elements.statusValue.className = 'status-value paid';
        elements.statusText.textContent = 'Sua conta está quitada!';
        elements.statusCard.classList.add('paid-status');
    } else if (isCredit) {
        elements.statusIcon.textContent = '💚';
        elements.statusValue.textContent = `R$ ${formatCurrency(Math.abs(debt))}`;
        elements.statusValue.className = 'status-value credit';
        elements.statusText.textContent = 'Você tem crédito a favor!';
        elements.statusCard.classList.add('credit-status');
    } else {
        elements.statusIcon.textContent = '💰';
        elements.statusValue.textContent = `R$ ${formatCurrency(debt)}`;
        elements.statusValue.className = 'status-value debt';
        elements.statusText.textContent = 'Total em aberto hoje.';
        elements.statusCard.classList.add('debt-status');
    }

    const deadlineHTML = !isPaid && !isCredit ? buildInterestDeadlineHTML(debtDetails) : '';
    elements.interestDeadlineText.innerHTML = deadlineHTML;
    elements.interestRulesContent.innerHTML = deadlineHTML ? buildInterestRulesHTML(debtDetails) : '';
    elements.interestDeadline.hidden = !deadlineHTML;
    elements.interestRulesButton.hidden = !deadlineHTML;
    elements.interestDeadline.classList.toggle('overdue', debtDetails.isOverdue && Boolean(deadlineHTML));
    if (!deadlineHTML) setInterestRulesOpen(false);
}

function buildTransactionElement(entry, existingElement) {
    const item = entry.item;
    const isPayment = item.type === TRANSACTION_TYPE_PAYMENT;
    const isInterest = item.type === TRANSACTION_TYPE_INTEREST;
    const icon = isPayment ? '✅' : isInterest ? 'R$' : '🛒';
    const typeText = isPayment ? 'Pagamento recebido' : isInterest ? 'Juros adicionados' : 'Compra';
    const typeClass = isPayment ? 'payment' : isInterest ? 'interest' : 'sale';
    const amount = centsToAmount(getTransactionAmountCents(item));
    const safeDescription = item.description ? escapeHTML(item.description) : '';
    const signature = JSON.stringify([item.type, amount, item.date, item.description]);
    const element = existingElement || document.createElement('article');

    if (element.dataset.signature !== signature) {
        element.className = `transaction-item ${typeClass}`;
        element.innerHTML = `
            <div class="transaction-header">
                <span class="transaction-type ${typeClass}">${icon} ${typeText}</span>
                <span class="transaction-amount ${typeClass}">R$ ${formatCurrency(amount)}</span>
            </div>
            <div class="transaction-date">📅 ${formatDate(item.date)}</div>
            ${safeDescription ? `<div class="transaction-description">📝 ${safeDescription}</div>` : ''}`;
        element.dataset.signature = signature;
    }
    element.dataset.transactionKey = entry.key;
    return element;
}

function renderTransactions() {
    if (!state.transactionsReady) return;
    const sortedTransactions = [...state.transactions.values()].sort((first, second) => compareTransactionsAscending(second, first));
    elements.transactionsList.setAttribute('aria-busy', 'false');

    if (sortedTransactions.length === 0) {
        elements.transactionsList.innerHTML = '<div class="empty-state"><div class="empty-state-icon">📭</div><p>Nenhuma transação registrada</p></div>';
    } else {
        const existingElements = new Map(
            [...elements.transactionsList.querySelectorAll('[data-transaction-key]')]
                .map((element) => [element.dataset.transactionKey, element])
        );
        const fragment = document.createDocumentFragment();
        sortedTransactions.forEach((entry) => {
            fragment.appendChild(buildTransactionElement(entry, existingElements.get(entry.key)));
        });
        elements.transactionsList.replaceChildren(fragment);
    }

    const totalTransactions = Math.max(sortedTransactions.length, Number(state.summary?.transactionCount) || 0);
    const hasMore = state.hasMoreHint || sortedTransactions.length < totalTransactions;
    elements.historyControls.hidden = sortedTransactions.length === 0;
    elements.historySummary.textContent = totalTransactions > sortedTransactions.length
        ? `Exibindo ${sortedTransactions.length} de ${totalTransactions} transações.`
        : `${sortedTransactions.length} ${sortedTransactions.length === 1 ? 'transação exibida' : 'transações exibidas'}.`;
    elements.loadMoreButton.hidden = !hasMore;
}

function initializePixCard() {
    if (state.pixInitialized) return;
    state.pixInitialized = true;
    elements.pixPaymentDiv.innerHTML = `
        <h2 class="section-title">💳 Pagamento via PIX</h2>
        <div class="pix-card">
            <div class="pix-info">
                <button id="copyPixButton" class="pix-btn" type="button">Copiar chave PIX</button>
                <div class="pix-desc">Clique no botão para copiar a chave ou use o QR Code no app do seu banco.</div>
            </div>
            <div id="pixQrCode" class="pix-qrcode" role="img" aria-label="QR Code PIX"><span>Preparando QR Code...</span></div>
        </div>
        <div class="pix-receiver-info">
            <div class="pix-receiver-title">Recebedor</div>
            <div class="pix-receiver-row"><b>Nome:</b> Jones Vieira Cabral</div>
            <div class="pix-receiver-row"><b>CPF:</b> •••.253.763-••</div>
        </div>`;
    document.getElementById('copyPixButton')?.addEventListener('click', async (event) => {
        const button = event.currentTarget;
        try {
            await navigator.clipboard.writeText(PIX_KEY);
            button.textContent = 'Chave copiada!';
        } catch {
            button.textContent = 'Não foi possível copiar';
        }
        window.setTimeout(() => { button.textContent = 'Copiar chave PIX'; }, 1500);
    });
}

function loadQRCodeLibrary() {
    if (window.QRCode) return Promise.resolve(window.QRCode);
    if (state.qrLibraryPromise) return state.qrLibraryPromise;
    state.qrLibraryPromise = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = QR_CODE_URL;
        script.async = true;
        script.crossOrigin = 'anonymous';
        script.addEventListener('load', () => resolve(window.QRCode), { once: true });
        script.addEventListener('error', () => reject(new Error('Falha ao carregar QR Code')), { once: true });
        document.head.appendChild(script);
    });
    return state.qrLibraryPromise;
}

async function ensurePixQRCode() {
    if (state.qrGenerated || elements.pixPaymentDiv.hidden) return;
    const qrContainer = document.getElementById('pixQrCode');
    if (!qrContainer) return;
    try {
        const QRCode = await loadQRCodeLibrary();
        if (!QRCode || elements.pixPaymentDiv.hidden || state.qrGenerated) return;
        qrContainer.replaceChildren();
        new QRCode(qrContainer, {
            text: PIX_KEY,
            width: 180,
            height: 180,
            colorDark: '#000000',
            colorLight: '#ffffff',
            correctLevel: QRCode.CorrectLevel.M
        });
        state.qrGenerated = true;
    } catch {
        qrContainer.textContent = 'Use o botão para copiar a chave PIX.';
    }
}

function updatePixCard(debtDetails) {
    const shouldShow = debtDetails.totalDebt > 0;
    if (!shouldShow) {
        elements.pixPaymentDiv.hidden = true;
        return;
    }
    initializePixCard();
    elements.pixPaymentDiv.hidden = false;
    if (!state.qrGenerated) {
        requestAnimationFrame(() => window.setTimeout(ensurePixQRCode, 0));
    }
}

function renderPage() {
    state.renderFrame = 0;
    if (!state.summaryReady || !state.settingsReady) return;
    showContent();
    const debtDetails = calculateDebtDetails(state.summary);
    renderStatus(debtDetails);
    updatePixCard(debtDetails);
    renderTransactions();
}

function scheduleRender() {
    if (!state.summaryReady || !state.settingsReady) return;
    if (state.renderFrame) return;
    state.renderFrame = requestAnimationFrame(renderPage);
}

function readSnapshotEntries(snapshot) {
    const entries = [];
    snapshot.forEach((childSnapshot) => {
        const item = childSnapshot.val();
        if (!item || typeof item !== 'object') return;
        entries.push({
            key: String(childSnapshot.key),
            item,
            time: getTransactionTime(item),
            dateValue: String(item.date || ''),
            index: entries.length
        });
    });
    return entries;
}

function applyRecentTransactions(entries) {
    state.recentKeys.forEach((key) => {
        if (!state.olderKeys.has(key)) state.transactions.delete(key);
    });
    const hasExtra = entries.length > PAGE_SIZE;
    const visibleEntries = hasExtra ? entries.slice(1) : entries;
    state.recentKeys = new Set(visibleEntries.map((entry) => entry.key));
    visibleEntries.forEach((entry) => state.transactions.set(entry.key, entry));
    state.hasMoreHint = hasExtra || state.olderKeys.size > 0 && state.hasMoreHint;
    state.transactionsReady = true;
    renderTransactions();
}

function getOldestLoadedTransaction() {
    return [...state.transactions.values()].sort(compareFirebaseKeys)[0] || null;
}

async function loadOlderTransactions() {
    const cursor = getOldestLoadedTransaction();
    if (!cursor || !state.databaseApi) return;
    const { ref, query, orderByKey, endBefore, limitToLast, get } = state.databaseApi;
    elements.loadMoreButton.disabled = true;
    elements.loadMoreButton.textContent = 'Carregando...';
    try {
        const salesRef = ref(state.database, `users/${state.userId}/clients/${state.clientId}/sales`);
        const olderQuery = query(
            salesRef,
            orderByKey(),
            endBefore(cursor.key),
            limitToLast(PAGE_SIZE + 1)
        );
        const snapshot = await get(olderQuery);
        const entries = readSnapshotEntries(snapshot);
        const hasExtra = entries.length > PAGE_SIZE;
        const visibleEntries = hasExtra ? entries.slice(1) : entries;
        visibleEntries.forEach((entry) => {
            state.olderKeys.add(entry.key);
            state.transactions.set(entry.key, entry);
        });
        state.hasMoreHint = hasExtra;
        renderTransactions();
    } catch {
        elements.historySummary.textContent = 'Não foi possível carregar transações anteriores. Tente novamente.';
    } finally {
        elements.loadMoreButton.disabled = false;
        elements.loadMoreButton.textContent = 'Carregar transações anteriores';
    }
}

function summaryMatchesCurrentSettings(summary) {
    return normalizeOverdueResetPaymentPercent(summary?.overdueResetPaymentPercent)
        === normalizeOverdueResetPaymentPercent(state.settings.overdueResetPaymentPercent);
}

async function loadLegacyClient(forceRefresh = false) {
    if (!state.databaseApi) return;
    if (forceRefresh) state.legacyClientPromise = null;
    if (!state.legacyClientPromise) {
        const { ref, get } = state.databaseApi;
        state.legacyClientPromise = get(ref(state.database, `users/${state.userId}/clients/${state.clientId}`))
            .then((snapshot) => snapshot.val());
    }
    try {
        const clientData = await state.legacyClientPromise;
        if (!clientData) {
            showError('Cliente não encontrado. Verifique se o link está correto.');
            return;
        }
        state.legacyClientData = clientData;
        if (!state.settingsReady) return;
        state.summary = buildLegacySummary(clientData);
        state.summarySource = 'legacy';
        state.summaryReady = true;
        scheduleRender();
    } catch {
        showError('Não foi possível carregar os dados. Verifique sua conexão e tente novamente.');
    }
}

function reconcileSummaryWithSettings() {
    if (!state.settingsReady) return;
    if (state.legacyClientData && (state.summarySource === 'legacy' || !state.summary)) {
        state.summary = buildLegacySummary(state.legacyClientData);
        state.summarySource = 'legacy';
        state.summaryReady = true;
    } else if (state.summarySource === 'public' && state.summary && !summaryMatchesCurrentSettings(state.summary)) {
        state.summaryReady = false;
        loadLegacyClient(true);
        return;
    }
    scheduleRender();
}

function markSettingReady(fieldName) {
    state.settingsReadyFields.add(fieldName);
    state.settingsReady = state.settingsReadyFields.size === 3;
    if (state.settingsReady) reconcileSummaryWithSettings();
}

function startSettingsListeners() {
    const { ref, onValue } = state.databaseApi;
    const settingsPath = `users/${state.userId}/settings`;
    const handleError = (fieldName) => () => markSettingReady(fieldName);

    onValue(ref(state.database, `${settingsPath}/overdueAlertDays`), (snapshot) => {
        state.settings.overdueAlertDays = normalizeOverdueAlertDays(snapshot.val());
        markSettingReady('overdueAlertDays');
        reconcileSummaryWithSettings();
    }, handleError('overdueAlertDays'));

    onValue(ref(state.database, `${settingsPath}/overdueInterest`), (snapshot) => {
        state.settings.overdueInterest = normalizeOverdueInterest(snapshot.val());
        markSettingReady('overdueInterest');
        reconcileSummaryWithSettings();
    }, handleError('overdueInterest'));

    onValue(ref(state.database, `${settingsPath}/overdueResetPaymentPercent`), (snapshot) => {
        state.settings.overdueResetPaymentPercent = normalizeOverdueResetPaymentPercent(snapshot.val());
        markSettingReady('overdueResetPaymentPercent');
        reconcileSummaryWithSettings();
    }, handleError('overdueResetPaymentPercent'));
}

function startSummaryListener() {
    const { ref, onValue } = state.databaseApi;
    const summaryRef = ref(state.database, `users/${state.userId}/clients/${state.clientId}/publicSummary`);
    onValue(summaryRef, (snapshot) => {
        const summary = normalizePublicSummary(snapshot.val());
        if (!summary) {
            state.summaryReady = false;
            loadLegacyClient();
            return;
        }
        state.summary = summary;
        state.summarySource = 'public';
        state.summaryReady = true;
        if (state.settingsReady && !summaryMatchesCurrentSettings(summary)) {
            state.summaryReady = false;
            loadLegacyClient(true);
            return;
        }
        scheduleRender();
    }, () => loadLegacyClient());
}

function startTransactionsListener() {
    const { ref, query, orderByKey, limitToLast, onValue } = state.databaseApi;
    const salesRef = ref(state.database, `users/${state.userId}/clients/${state.clientId}/sales`);
    const recentQuery = query(salesRef, orderByKey(), limitToLast(PAGE_SIZE + 1));
    onValue(recentQuery, (snapshot) => {
        applyRecentTransactions(readSnapshotEntries(snapshot));
    }, () => {
        state.transactionsReady = true;
        renderTransactions();
    });
}

function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js').catch(() => {});
    }, { once: true });
}

async function start() {
    bindInterestDialog();
    elements.loadMoreButton?.addEventListener('click', loadOlderTransactions);
    registerServiceWorker();

    const urlParams = new URLSearchParams(window.location.search);
    state.userId = urlParams.get('u') || '';
    state.clientId = urlParams.get('c') || '';
    if (!state.userId || !state.clientId) {
        showError('O link está incompleto. Solicite um novo link ao responsável.');
        return;
    }

    try {
        const [appModule, databaseModule] = await Promise.all([
            import('firebase/app'),
            import('firebase/database')
        ]);
        const app = appModule.initializeApp(firebaseConfig);
        state.database = databaseModule.getDatabase(app);
        state.databaseApi = databaseModule;
        startSettingsListeners();
        startSummaryListener();
        startTransactionsListener();
    } catch {
        showError('Não foi possível iniciar a conexão. Verifique sua internet e tente novamente.');
    }
}

start();
