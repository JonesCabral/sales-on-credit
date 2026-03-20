import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js';
import { getDatabase, ref, onValue } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js';
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

let allActivities = [];

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

function getActivities(clientsMap) {
    const activities = [];

    Object.values(clientsMap || {}).forEach((client) => {
        if (!Array.isArray(client.sales) || client.sales.length === 0) return;

        client.sales.forEach((item) => {
            const amount = Number(item.amount) || 0;
            const isSale = item.type === 'sale';
            const isPayment = item.type === 'payment';

            if (!isSale && !isPayment) return;

            activities.push({
                id: item.id,
                clientName: client.name || 'Cliente',
                type: item.type,
                amount,
                isNote: Boolean(item.isNote) || (isSale && amount === 0),
                description: item.description || '',
                date: item.date
            });
        });
    });

    return activities
        .filter((activity) => activity.date)
        .sort((a, b) => new Date(b.date) - new Date(a.date));
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

function setupThemeToggle() {
    if (!themeToggle) return;

    themeToggle.addEventListener('click', () => {
        const html = document.documentElement;
        const currentTheme = html.getAttribute('data-theme');
        const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
        html.setAttribute('data-theme', newTheme);
        localStorage.setItem('theme', newTheme);
    });
}

function showError(message) {
    if (!activityList || !activitySummary || !historyMeta) return;
    activitySummary.textContent = 'Erro ao carregar';
    historyMeta.textContent = message;
    activityList.innerHTML = `<p class="empty-message">${sanitizeHTML(message)}</p>`;
}

if (activityLimit) {
    activityLimit.addEventListener('change', renderActivities);
}

setupThemeToggle();

onAuthStateChanged(auth, (user) => {
    if (!user) {
        window.location.href = './index.html';
        return;
    }

    const dbRef = ref(database, `users/${user.uid}/clients`);

    onValue(dbRef, (snapshot) => {
        const clients = snapshot.val() || {};
        allActivities = getActivities(clients);
        renderActivities();
    }, (error) => {
        showError('Não foi possível carregar o histórico. Verifique sua conexão.');
        console.error('Erro ao carregar histórico:', error);
    });
});
