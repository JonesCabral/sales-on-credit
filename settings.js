import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js';
import { getDatabase, ref, onValue, update, get } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js';
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

const DEFAULT_OVERDUE_ALERT_DAYS = 60;
const MIN_OVERDUE_ALERT_DAYS = 1;
const MAX_OVERDUE_ALERT_DAYS = 3650;
const DEFAULT_OVERDUE_INTEREST_ENABLED = false;
const DEFAULT_OVERDUE_INTEREST_PERCENT = 0;
const MIN_OVERDUE_INTEREST_PERCENT = 0;
const MAX_OVERDUE_INTEREST_PERCENT = 100;

const app = initializeApp(firebaseConfig);
const database = getDatabase(app);
const auth = getAuth(app);

const overdueSettingsForm = document.getElementById('overdueSettingsForm');
const overdueDaysInput = document.getElementById('overdueDaysInput');
const overdueCurrentValue = document.getElementById('overdueCurrentValue');
const saveOverdueSettings = document.getElementById('saveOverdueSettings');
const interestSettingsForm = document.getElementById('interestSettingsForm');
const interestEnabledInput = document.getElementById('interestEnabledInput');
const interestPercentInput = document.getElementById('interestPercentInput');
const interestCurrentValue = document.getElementById('interestCurrentValue');
const saveInterestSettings = document.getElementById('saveInterestSettings');
const settingsStatus = document.getElementById('settingsStatus');
const themeToggle = document.getElementById('themeToggle');
const settingsMenu = document.getElementById('settingsMenu');
const settingsMenuOverlay = document.getElementById('settingsMenuOverlay');
const settingsMenuToggle = document.getElementById('settingsMenuToggle');
const settingsMenuClose = document.getElementById('settingsMenuClose');
const settingsMenuThemeShortcut = document.getElementById('settingsMenuThemeShortcut');

let currentUserId = null;
let settingsUnsubscribe = null;
let currentOverdueDays = DEFAULT_OVERDUE_ALERT_DAYS;
let currentInterestEnabled = DEFAULT_OVERDUE_INTEREST_ENABLED;
let currentInterestPercent = DEFAULT_OVERDUE_INTEREST_PERCENT;
let formsDisabled = false;

function normalizeOverdueAlertDays(value) {
    const parsedValue = Number.parseInt(value, 10);
    if (!Number.isFinite(parsedValue)) return DEFAULT_OVERDUE_ALERT_DAYS;
    return Math.min(MAX_OVERDUE_ALERT_DAYS, Math.max(MIN_OVERDUE_ALERT_DAYS, parsedValue));
}

function formatOverdueAlertDays(days) {
    const safeDays = normalizeOverdueAlertDays(days);
    return safeDays === 1 ? '1 dia' : `${safeDays} dias`;
}

function parseInterestPercent(value) {
    if (typeof value === 'string') {
        return Number.parseFloat(value.replace(',', '.'));
    }
    return Number.parseFloat(value);
}

function normalizeOverdueInterestPercent(value) {
    const parsedValue = parseInterestPercent(value);
    if (!Number.isFinite(parsedValue)) return DEFAULT_OVERDUE_INTEREST_PERCENT;
    const clampedValue = Math.min(MAX_OVERDUE_INTEREST_PERCENT, Math.max(MIN_OVERDUE_INTEREST_PERCENT, parsedValue));
    return Math.round(clampedValue * 100) / 100;
}

function formatOverdueInterestPercent(percent) {
    const safePercent = normalizeOverdueInterestPercent(percent);
    return `${safePercent.toLocaleString('pt-BR', {
        minimumFractionDigits: Number.isInteger(safePercent) ? 0 : 2,
        maximumFractionDigits: 2
    })}%`;
}

function getDefaultSettings() {
    return {
        overdueAlertDays: DEFAULT_OVERDUE_ALERT_DAYS,
        overdueInterest: {
            enabled: DEFAULT_OVERDUE_INTEREST_ENABLED,
            percent: DEFAULT_OVERDUE_INTEREST_PERCENT
        }
    };
}

function normalizeOverdueInterest(settings = {}) {
    const savedInterest = settings.overdueInterest || {};
    return {
        enabled: savedInterest.enabled === true,
        percent: normalizeOverdueInterestPercent(savedInterest.percent)
    };
}

function normalizeSettings(settings = {}) {
    return {
        overdueAlertDays: normalizeOverdueAlertDays(settings.overdueAlertDays),
        overdueInterest: normalizeOverdueInterest(settings)
    };
}

function createSettingsPayload(overrides = {}) {
    const interestOverrides = overrides.overdueInterest || {};
    return {
        overdueAlertDays: normalizeOverdueAlertDays(overrides.overdueAlertDays ?? currentOverdueDays),
        overdueInterest: {
            enabled: Boolean(interestOverrides.enabled ?? currentInterestEnabled),
            percent: normalizeOverdueInterestPercent(interestOverrides.percent ?? currentInterestPercent)
        },
        updatedAt: new Date().toISOString()
    };
}

function hasOwn(object, key) {
    return Object.prototype.hasOwnProperty.call(object || {}, key);
}

function settingsMatch(expectedSettings, savedSettings) {
    const expected = normalizeSettings(expectedSettings);
    const saved = normalizeSettings(savedSettings);
    const savedInterest = savedSettings?.overdueInterest || {};

    return hasOwn(savedSettings, 'overdueAlertDays')
        && hasOwn(savedSettings, 'overdueInterest')
        && hasOwn(savedInterest, 'enabled')
        && hasOwn(savedInterest, 'percent')
        && expected.overdueAlertDays === saved.overdueAlertDays
        && expected.overdueInterest.enabled === saved.overdueInterest.enabled
        && expected.overdueInterest.percent === saved.overdueInterest.percent;
}

async function saveAndVerifySettings(settingsPayload) {
    if (!currentUserId) {
        throw new Error('Usuario nao autenticado');
    }

    const settingsRef = ref(database, `users/${currentUserId}/settings`);
    await update(settingsRef, settingsPayload);

    const savedSnapshot = await get(settingsRef);
    const savedSettings = savedSnapshot.val() || {};

    if (!settingsMatch(settingsPayload, savedSettings)) {
        throw new Error('As configuracoes nao foram confirmadas no Firebase.');
    }

    return normalizeSettings(savedSettings);
}

function setStatus(message, type = 'neutral') {
    if (!settingsStatus) return;
    settingsStatus.textContent = message;
    settingsStatus.dataset.status = type;
}

function setFormDisabled(isDisabled) {
    formsDisabled = isDisabled;
    if (overdueDaysInput) overdueDaysInput.disabled = isDisabled;
    if (saveOverdueSettings) saveOverdueSettings.disabled = isDisabled;
    if (interestEnabledInput) interestEnabledInput.disabled = isDisabled;
    if (saveInterestSettings) saveInterestSettings.disabled = isDisabled;
    syncInterestPercentInputState();
}

function syncInterestPercentInputState() {
    if (!interestPercentInput) return;
    interestPercentInput.disabled = formsDisabled || !interestEnabledInput?.checked;
}

function syncSettingsForm(settings = getDefaultSettings()) {
    currentOverdueDays = normalizeOverdueAlertDays(settings.overdueAlertDays);
    const interestSettings = normalizeOverdueInterest(settings);
    currentInterestEnabled = interestSettings.enabled;
    currentInterestPercent = interestSettings.percent;
    const formattedDays = formatOverdueAlertDays(currentOverdueDays);

    if (overdueDaysInput && document.activeElement !== overdueDaysInput) {
        overdueDaysInput.value = String(currentOverdueDays);
    }

    if (overdueCurrentValue) {
        overdueCurrentValue.textContent = `Atual: ${formattedDays}`;
    }

    if (interestEnabledInput && document.activeElement !== interestEnabledInput) {
        interestEnabledInput.checked = currentInterestEnabled;
    }

    if (interestPercentInput && document.activeElement !== interestPercentInput) {
        interestPercentInput.value = String(currentInterestPercent);
    }

    if (interestCurrentValue) {
        interestCurrentValue.textContent = currentInterestEnabled && currentInterestPercent > 0
            ? `Atual: ${formatOverdueInterestPercent(currentInterestPercent)} ativo`
            : 'Atual: desativado';
    }

    syncInterestPercentInputState();
}

function setupThemeToggle() {
    const toggleTheme = () => {
        const html = document.documentElement;
        const currentTheme = html.getAttribute('data-theme');
        const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
        html.setAttribute('data-theme', newTheme);
        localStorage.setItem('theme', newTheme);
    };

    themeToggle?.addEventListener('click', toggleTheme);
    settingsMenuThemeShortcut?.addEventListener('click', toggleTheme);
}

function setSettingsMenuOpen(isOpen) {
    if (!settingsMenu || !settingsMenuOverlay || !settingsMenuToggle) return;

    settingsMenu.classList.toggle('open', isOpen);
    document.body.classList.toggle('menu-open', isOpen);
    settingsMenu.setAttribute('aria-hidden', String(!isOpen));
    settingsMenuOverlay.hidden = !isOpen;
    settingsMenuToggle.setAttribute('aria-expanded', String(isOpen));

    if (isOpen) {
        const firstMenuItem = settingsMenu.querySelector('.app-menu-link, .btn-menu-close');
        firstMenuItem?.focus({ preventScroll: true });
    } else if (document.activeElement && settingsMenu.contains(document.activeElement)) {
        settingsMenuToggle.focus({ preventScroll: true });
    }
}

function setupSettingsMenu() {
    if (!settingsMenu || !settingsMenuOverlay || !settingsMenuToggle || !settingsMenuClose) return;

    settingsMenuToggle.addEventListener('click', () => setSettingsMenuOpen(true));
    settingsMenuClose.addEventListener('click', () => setSettingsMenuOpen(false));
    settingsMenuOverlay.addEventListener('click', () => setSettingsMenuOpen(false));

    document.querySelectorAll('.app-menu-link').forEach((link) => {
        link.addEventListener('click', () => setSettingsMenuOpen(false));
    });

    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
            setSettingsMenuOpen(false);
        }
    });

    window.addEventListener('resize', () => setSettingsMenuOpen(false));
}

function subscribeSettings(userId) {
    if (settingsUnsubscribe) {
        settingsUnsubscribe();
        settingsUnsubscribe = null;
    }

    setFormDisabled(true);
    setStatus('Carregando configuração...');

    settingsUnsubscribe = onValue(ref(database, `users/${userId}/settings`), (snapshot) => {
        const settings = snapshot.val() || {};
        syncSettingsForm(settings);
        setFormDisabled(false);
        const interestMessage = currentInterestEnabled && currentInterestPercent > 0
            ? ` Juros de ${formatOverdueInterestPercent(currentInterestPercent)} ativo para clientes atrasados.`
            : ' Juros desativados.';
        setStatus(`Alerta ativo em ${formatOverdueAlertDays(currentOverdueDays)} sem pagamento.${interestMessage}`, 'success');
    }, (error) => {
        console.error('Erro ao carregar configurações:', error);
        syncSettingsForm(getDefaultSettings());
        setFormDisabled(false);
        setStatus('Não foi possível carregar a configuração. Usando padrão de 60 dias.', 'error');
    });
}

overdueSettingsForm?.addEventListener('submit', async (event) => {
    event.preventDefault();

    if (!currentUserId) {
        setStatus('Faça login para salvar configurações.', 'error');
        return;
    }

    const rawDays = overdueDaysInput?.value || '';
    const numericDays = Number(rawDays);

    if (!Number.isInteger(numericDays) || numericDays < MIN_OVERDUE_ALERT_DAYS || numericDays > MAX_OVERDUE_ALERT_DAYS) {
        setStatus(`Informe um número de dias entre ${MIN_OVERDUE_ALERT_DAYS} e ${MAX_OVERDUE_ALERT_DAYS}.`, 'error');
        overdueDaysInput?.focus();
        return;
    }

    const normalizedDays = normalizeOverdueAlertDays(numericDays);
    setFormDisabled(true);
    setStatus('Salvando configuração...');

    try {
        const savedSettings = await saveAndVerifySettings(createSettingsPayload({
            overdueAlertDays: normalizedDays,
            overdueInterest: {
                enabled: currentInterestEnabled,
                percent: currentInterestPercent
            }
        }));
        syncSettingsForm(savedSettings);
        setStatus(`Configuração salva: ${formatOverdueAlertDays(normalizedDays)} sem pagamento.`, 'success');
    } catch (error) {
        console.error('Erro ao salvar configuração:', error);
        setStatus('Erro ao salvar configuração. Tente novamente.', 'error');
    } finally {
        setFormDisabled(false);
    }
});

interestEnabledInput?.addEventListener('change', syncInterestPercentInputState);

interestSettingsForm?.addEventListener('submit', async (event) => {
    event.preventDefault();

    if (!currentUserId) {
        setStatus('Faça login para salvar configurações.', 'error');
        return;
    }

    const enabled = interestEnabledInput?.checked || false;
    const rawPercent = interestPercentInput?.value || '';
    const numericPercent = parseInterestPercent(rawPercent);

    if (enabled && (!Number.isFinite(numericPercent) || numericPercent <= 0 || numericPercent > MAX_OVERDUE_INTEREST_PERCENT)) {
        setStatus(`Informe um percentual maior que 0 e até ${MAX_OVERDUE_INTEREST_PERCENT}%.`, 'error');
        interestPercentInput?.focus();
        return;
    }

    if (!enabled && rawPercent && (!Number.isFinite(numericPercent) || numericPercent < MIN_OVERDUE_INTEREST_PERCENT || numericPercent > MAX_OVERDUE_INTEREST_PERCENT)) {
        setStatus(`Informe um percentual entre ${MIN_OVERDUE_INTEREST_PERCENT}% e ${MAX_OVERDUE_INTEREST_PERCENT}%.`, 'error');
        interestPercentInput?.focus();
        return;
    }

    const normalizedPercent = enabled
        ? normalizeOverdueInterestPercent(numericPercent)
        : normalizeOverdueInterestPercent(Number.isFinite(numericPercent) ? numericPercent : DEFAULT_OVERDUE_INTEREST_PERCENT);

    setFormDisabled(true);
    setStatus('Salvando juros...');

    try {
        const savedSettings = await saveAndVerifySettings(createSettingsPayload({
            overdueAlertDays: currentOverdueDays,
            overdueInterest: {
                enabled,
                percent: normalizedPercent
            }
        }));
        syncSettingsForm(savedSettings);
        const savedMessage = enabled
            ? `Juros salvos: ${formatOverdueInterestPercent(normalizedPercent)} para clientes atrasados.`
            : 'Juros por atraso desativados.';
        setStatus(savedMessage, 'success');
    } catch (error) {
        console.error('Erro ao salvar juros:', error);
        setStatus('Erro ao salvar juros. Tente novamente.', 'error');
    } finally {
        setFormDisabled(false);
    }
});

setupThemeToggle();
setupSettingsMenu();
syncSettingsForm(getDefaultSettings());

onAuthStateChanged(auth, (user) => {
    if (!user) {
        if (settingsUnsubscribe) {
            settingsUnsubscribe();
            settingsUnsubscribe = null;
        }
        window.location.href = './index.html';
        return;
    }

    currentUserId = user.uid;
    subscribeSettings(user.uid);
});
