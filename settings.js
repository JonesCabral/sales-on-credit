import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js';
import { getDatabase, ref, onValue, set } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js';
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

const app = initializeApp(firebaseConfig);
const database = getDatabase(app);
const auth = getAuth(app);

const overdueSettingsForm = document.getElementById('overdueSettingsForm');
const overdueDaysInput = document.getElementById('overdueDaysInput');
const overdueCurrentValue = document.getElementById('overdueCurrentValue');
const saveOverdueSettings = document.getElementById('saveOverdueSettings');
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

function normalizeOverdueAlertDays(value) {
    const parsedValue = Number.parseInt(value, 10);
    if (!Number.isFinite(parsedValue)) return DEFAULT_OVERDUE_ALERT_DAYS;
    return Math.min(MAX_OVERDUE_ALERT_DAYS, Math.max(MIN_OVERDUE_ALERT_DAYS, parsedValue));
}

function formatOverdueAlertDays(days) {
    const safeDays = normalizeOverdueAlertDays(days);
    return safeDays === 1 ? '1 dia' : `${safeDays} dias`;
}

function setStatus(message, type = 'neutral') {
    if (!settingsStatus) return;
    settingsStatus.textContent = message;
    settingsStatus.dataset.status = type;
}

function setFormDisabled(isDisabled) {
    if (overdueDaysInput) overdueDaysInput.disabled = isDisabled;
    if (saveOverdueSettings) saveOverdueSettings.disabled = isDisabled;
}

function syncSettingsForm(days) {
    currentOverdueDays = normalizeOverdueAlertDays(days);
    const formattedDays = formatOverdueAlertDays(currentOverdueDays);

    if (overdueDaysInput && document.activeElement !== overdueDaysInput) {
        overdueDaysInput.value = String(currentOverdueDays);
    }

    if (overdueCurrentValue) {
        overdueCurrentValue.textContent = `Atual: ${formattedDays}`;
    }
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
    settingsMenu.setAttribute('aria-hidden', String(!isOpen));
    settingsMenuOverlay.hidden = !isOpen;
    settingsMenuToggle.setAttribute('aria-expanded', String(isOpen));
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
        syncSettingsForm(settings.overdueAlertDays);
        setFormDisabled(false);
        setStatus(`Alerta ativo em ${formatOverdueAlertDays(currentOverdueDays)} sem pagamento.`, 'success');
    }, (error) => {
        console.error('Erro ao carregar configurações:', error);
        syncSettingsForm(DEFAULT_OVERDUE_ALERT_DAYS);
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
        await set(ref(database, `users/${currentUserId}/settings/overdueAlertDays`), normalizedDays);
        syncSettingsForm(normalizedDays);
        setStatus(`Configuração salva: ${formatOverdueAlertDays(normalizedDays)} sem pagamento.`, 'success');
    } catch (error) {
        console.error('Erro ao salvar configuração:', error);
        setStatus('Erro ao salvar configuração. Tente novamente.', 'error');
    } finally {
        setFormDisabled(false);
    }
});

setupThemeToggle();
setupSettingsMenu();
syncSettingsForm(DEFAULT_OVERDUE_ALERT_DAYS);

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
