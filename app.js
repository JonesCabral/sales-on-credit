// Importar Firebase
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js';
import { getDatabase, ref, set, remove, onValue } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js';
import { getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js';

// Configuração do Firebase
// IMPORTANTE: Para produção, mova as configurações para variáveis de ambiente
// e proteja com Firebase App Check (https://firebase.google.com/docs/app-check)
const firebaseConfig = {
    apiKey: "AIzaSyAmtxBsBUy67kuk50M25SPNl6AOhYFeDuY",
    authDomain: "vendas-fiadas.firebaseapp.com",
    databaseURL: "https://vendas-fiadas-default-rtdb.firebaseio.com",
    projectId: "vendas-fiadas",
    storageBucket: "vendas-fiadas.firebasestorage.app",
    messagingSenderId: "893268626644",
    appId: "1:893268626644:web:4f9237500db5de98177f41",
    measurementId: "G-GVRNJBMTKC"
};

// Inicializar Firebase
const app = initializeApp(firebaseConfig);
const database = getDatabase(app);
const auth = getAuth(app);

// Versão da aplicação
const APP_VERSION = '2.1.17';

// Verificar e sincronizar versão
(function checkVersion() {
    const storedVersion = localStorage.getItem('appVersion');
    if (storedVersion && storedVersion !== APP_VERSION) {
        console.log(`Atualizando de v${storedVersion} para v${APP_VERSION}`);
        localStorage.setItem('appVersion', APP_VERSION);
    } else if (!storedVersion) {
        localStorage.setItem('appVersion', APP_VERSION);
    }
    
    // Exibir versão na interface
    document.addEventListener('DOMContentLoaded', () => {
        const appVersionElement = document.getElementById('appVersion');
        const loginVersionElement = document.getElementById('loginVersion');
        
        if (appVersionElement) {
            appVersionElement.textContent = `v${APP_VERSION}`;
        }
        if (loginVersionElement) {
            loginVersionElement.textContent = `Versão ${APP_VERSION}`;
        }

        // Theme toggle
        const toggleTheme = () => {
            const html = document.documentElement;
            const currentTheme = html.getAttribute('data-theme');
            const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
            html.setAttribute('data-theme', newTheme);
            localStorage.setItem('theme', newTheme);
        };

        const themeToggle = document.getElementById('themeToggle');
        if (themeToggle) {
            themeToggle.addEventListener('click', toggleTheme);
        }

        const menuThemeShortcut = document.getElementById('menuThemeShortcut');
        if (menuThemeShortcut) {
            menuThemeShortcut.addEventListener('click', toggleTheme);
        }
    });
})();

// Variável global para armazenar o usuário atual
let currentUser = null;

// Flag de desenvolvimento (mudar para false em produção)
const IS_DEV = false;

const DEFAULT_OVERDUE_ALERT_DAYS = 60;
const MIN_OVERDUE_ALERT_DAYS = 1;
const MAX_OVERDUE_ALERT_DAYS = 3650;
const DEFAULT_OVERDUE_INTEREST_ENABLED = false;
const DEFAULT_OVERDUE_INTEREST_PERCENT = 0;
const MIN_OVERDUE_INTEREST_PERCENT = 0;
const MAX_OVERDUE_INTEREST_PERCENT = 100;
const DAY_IN_MS = 24 * 60 * 60 * 1000;
const TRANSACTION_TYPE_SALE = 'sale';
const TRANSACTION_TYPE_PAYMENT = 'payment';
const TRANSACTION_TYPE_INTEREST = 'interest';
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

function normalizeOverdueAlertDays(value) {
    const parsedValue = Number.parseInt(value, 10);
    if (!Number.isFinite(parsedValue)) return DEFAULT_OVERDUE_ALERT_DAYS;
    return Math.min(MAX_OVERDUE_ALERT_DAYS, Math.max(MIN_OVERDUE_ALERT_DAYS, parsedValue));
}

function formatOverdueAlertDays(days) {
    const safeDays = normalizeOverdueAlertDays(days);
    return safeDays === 1 ? '1 dia' : `${safeDays} dias`;
}

function parseOverdueInterestPercent(value) {
    if (typeof value === 'string') {
        return Number.parseFloat(value.replace(',', '.'));
    }
    return Number.parseFloat(value);
}

function normalizeOverdueInterestPercent(value) {
    const parsedValue = parseOverdueInterestPercent(value);
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

function normalizeSettings(savedSettings = {}) {
    const savedInterest = savedSettings.overdueInterest || {};
    return {
        overdueAlertDays: normalizeOverdueAlertDays(savedSettings.overdueAlertDays),
        overdueInterest: {
            enabled: savedInterest.enabled === true,
            percent: normalizeOverdueInterestPercent(savedInterest.percent)
        }
    };
}

// Função para sanitizar strings (prevenir XSS)
function sanitizeHTML(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

// Função de log segura (apenas em desenvolvimento)
function safeLog(...args) {
    if (IS_DEV) {
        console.log(...args);
    }
}

// Gerenciador de dados usando Firebase
class SalesManager {
    constructor() {
        this.clients = {};
        this.settings = getDefaultSettings();
        this.currentClientId = null;
        this.userId = null;
        this.unsubscribe = null;
        this.settingsUnsubscribe = null;
        this.dataLoaded = false;
    }

    setUser(userId) {
        this.userId = userId;
        this.settings = getDefaultSettings();
        syncSettingsUI();
        this.loadSettings();
        this.loadData();
    }

    loadSettings() {
        if (!this.userId) return;

        if (this.settingsUnsubscribe) {
            this.settingsUnsubscribe();
            this.settingsUnsubscribe = null;
        }

        const settingsRef = ref(database, `users/${this.userId}/settings`);

        this.settingsUnsubscribe = onValue(settingsRef, (snapshot) => {
            const savedSettings = snapshot.val() || {};
            this.settings = normalizeSettings(savedSettings);
            syncSettingsUI();
            updateClientsList();
        }, (error) => {
            console.error('Erro ao carregar configurações:', error);
            this.settings = getDefaultSettings();
            syncSettingsUI();
        });
    }

    async loadData() {
        if (!this.userId) return;
        
        // Cancelar listener anterior se existir
        if (this.unsubscribe) {
            this.unsubscribe();
            this.unsubscribe = null;
        }
        
        const dbRef = ref(database, `users/${this.userId}/clients`);
        
        // Listener em tempo real para mudanças no banco de dados
        this.unsubscribe = onValue(dbRef, (snapshot) => {
            this.clients = snapshot.val() || {};
            safeLog('Dados carregados do Firebase');
            updateClientsList();
            // Esconder loading screen após primeiro carregamento de dados
            if (!this.dataLoaded) {
                this.dataLoaded = true;
                hideLoadingScreen();
            }
        }, (error) => {
            console.error('Erro ao carregar dados:', error);
            showToast('Erro ao carregar dados. Verifique sua conexão.', 'error');
            // Esconder loading mesmo em caso de erro para não travar a tela
            if (!this.dataLoaded) {
                this.dataLoaded = true;
                hideLoadingScreen();
            }
        });
    }

    // Método para limpar recursos
    cleanup() {
        if (this.unsubscribe) {
            this.unsubscribe();
            this.unsubscribe = null;
        }
        if (this.settingsUnsubscribe) {
            this.settingsUnsubscribe();
            this.settingsUnsubscribe = null;
        }
        this.userId = null;
        this.settings = getDefaultSettings();
        syncSettingsUI();
    }

    async saveData() {
        if (!this.userId) {
            if (IS_DEV) console.error('Erro: userId não definido');
            throw new Error('Usuário não autenticado');
        }
        const dbRef = ref(database, `users/${this.userId}/clients`);
        safeLog('Salvando dados para usuário:', this.userId);
        await set(dbRef, this.clients);
    }

    async saveClientData(clientId) {
        if (!this.userId) {
            if (IS_DEV) console.error('Erro: userId nÃ£o definido');
            throw new Error('UsuÃ¡rio nÃ£o autenticado');
        }
        if (!this.clients[clientId]) {
            throw new Error('Cliente nÃ£o encontrado');
        }

        await set(ref(database, `users/${this.userId}/clients/${clientId}`), this.clients[clientId]);
    }

    async removeClientData(clientId) {
        if (!this.userId) {
            if (IS_DEV) console.error('Erro: userId nÃ£o definido');
            throw new Error('UsuÃ¡rio nÃ£o autenticado');
        }

        await remove(ref(database, `users/${this.userId}/clients/${clientId}`));
    }

    getOverdueAlertDays() {
        return normalizeOverdueAlertDays(this.settings?.overdueAlertDays);
    }

    getOverdueInterestSettings() {
        const interestSettings = this.settings?.overdueInterest || {};
        return {
            enabled: interestSettings.enabled === true,
            percent: normalizeOverdueInterestPercent(interestSettings.percent)
        };
    }

    isOverdueInterestEnabled() {
        const interestSettings = this.getOverdueInterestSettings();
        return interestSettings.enabled && interestSettings.percent > 0;
    }

    getOverdueInterestPercent() {
        return this.getOverdueInterestSettings().percent;
    }

    getActivityKey(clientId, saleId) {
        return `${clientId}_${saleId}`;
    }

    async upsertActivity(clientId, saleItem) {
        if (!this.userId || !saleItem?.id) return;
        const client = this.clients[clientId];
        if (!client) return;

        const key = this.getActivityKey(clientId, saleItem.id);
        const timestamp = new Date(saleItem.date || new Date().toISOString()).getTime();

        try {
            await set(ref(database, `users/${this.userId}/activities/${key}`), {
                id: saleItem.id,
                clientId,
                clientName: client.name || 'Cliente',
                type: saleItem.type,
                amount: getSaleAmount(saleItem),
                amountCents: getSaleAmountCents(saleItem),
                description: saleItem.description || '',
                isNote: Boolean(saleItem.isNote) || (saleItem.type === TRANSACTION_TYPE_SALE && getSaleAmountCents(saleItem) === 0),
                hasUnpricedItems: saleHasUnpricedProducts(saleItem),
                items: Array.isArray(saleItem.items) ? saleItem.items : [],
                interestPaidCents: Number.isFinite(Number(saleItem.interestPaidCents)) ? Math.round(Number(saleItem.interestPaidCents)) : 0,
                principalPaidCents: Number.isFinite(Number(saleItem.principalPaidCents)) ? Math.round(Number(saleItem.principalPaidCents)) : 0,
                date: saleItem.date || new Date().toISOString(),
                timestamp: Number.isFinite(timestamp) ? timestamp : Date.now(),
                editedAt: saleItem.editedAt || null
            });
        } catch (error) {
            console.warn('Falha ao atualizar índice de atividades:', error?.code || error?.message || error);
        }
    }

    async removeActivity(clientId, saleId) {
        if (!this.userId || !saleId) return;
        const key = this.getActivityKey(clientId, saleId);
        try {
            await remove(ref(database, `users/${this.userId}/activities/${key}`));
        } catch (error) {
            console.warn('Falha ao remover item do índice de atividades:', error?.code || error?.message || error);
        }
    }

    async syncClientActivities(clientId) {
        const client = this.clients[clientId];
        if (!client || !Array.isArray(client.sales) || client.sales.length === 0) return;

        try {
            await Promise.all(client.sales.map((saleItem) => this.upsertActivity(clientId, saleItem)));
        } catch (error) {
            console.warn('Falha ao sincronizar índice de atividades do cliente:', error?.code || error?.message || error);
        }
    }

    async addClient(name) {
        if (!this.userId) {
            throw new Error('Usuário não autenticado');
        }
        
        // Validar e sanitizar nome usando utility
        const sanitizedName = ValidationUtils.validateText(name, {
            minLength: 2,
            maxLength: 100,
            required: true,
            fieldName: 'Nome do cliente'
        });
        
        // Verificar se já existe cliente com esse nome
        const existingClient = Object.values(this.clients).find(
            c => c.name.toLowerCase() === sanitizedName.toLowerCase()
        );
        if (existingClient) {
            throw new Error('Já existe um cliente com este nome');
        }
        
        const id = Date.now().toString();
        this.clients[id] = {
            id,
            name: sanitizedName,
            sales: [],
            createdAt: new Date().toISOString(),
            archived: false
        };
        safeLog('Adicionando cliente:', sanitizedName);
        await this.saveClientData(id);
        return id;
    }

    async addSale(clientId, amount, description = '', items = []) {
        if (!this.clients[clientId]) {
            throw new Error('Cliente não encontrado');
        }
        
        // Validar valor usando utility
        let numericAmount = ValidationUtils.validateAmount(amount, {
            min: 0,
            max: 1000000,
            allowZero: true
        });
        
        const normalizedItems = normalizeSaleItems(items);

        // Validar e sanitizar descrição
        const sanitizedDescription = ValidationUtils.validateText(description, {
            required: numericAmount === 0 && normalizedItems.length === 0,
            fieldName: 'Descrição'
        });
        
        const itemsTotalCents = getSaleItemsTotalCents(normalizedItems);
        const amountCents = itemsTotalCents > 0 ? itemsTotalCents : currencyToCents(numericAmount);
        numericAmount = centsToAmount(amountCents);

        // Garantir que sales existe
        if (!this.clients[clientId].sales) {
            this.clients[clientId].sales = [];
        }
        
        const saleItem = {
            id: createTransactionId(TRANSACTION_TYPE_SALE),
            amount: numericAmount,
            amountCents,
            description: sanitizedDescription,
            items: normalizedItems,
            type: TRANSACTION_TYPE_SALE,
            isNote: amountCents === 0,
            hasUnpricedItems: amountCents === 0 || saleItemsHaveUnpricedProducts(normalizedItems) || hasMixedPricedAndUnpricedLines(sanitizedDescription),
            date: new Date().toISOString()
        };

        this.clients[clientId].sales.push(saleItem);
        await this.saveClientData(clientId);
        await this.upsertActivity(clientId, saleItem);
        return true;
    }

    async addPayment(clientId, amount) {
        if (!this.clients[clientId]) {
            throw new Error('Cliente não encontrado');
        }
        
        // Validar valor usando utility
        const numericAmount = ValidationUtils.validateAmount(amount, {
            min: 0,
            max: 1000000,
            allowZero: false
        });
        
        // Garantir que sales existe
        if (!this.clients[clientId].sales) {
            this.clients[clientId].sales = [];
        }

        const paymentCents = currencyToCents(numericAmount);
        const paymentAmount = centsToAmount(paymentCents);
        const paymentDate = new Date().toISOString();
        const pendingInterestCents = this.getClientInterestCents(clientId);
        const itemsToSave = [];

        if (pendingInterestCents > 0) {
            const interestPercent = this.getOverdueInterestPercent();
            itemsToSave.push({
                id: createTransactionId(TRANSACTION_TYPE_INTEREST),
                amount: centsToAmount(pendingInterestCents),
                amountCents: pendingInterestCents,
                description: `Juros por atraso (${formatOverdueInterestPercent(interestPercent)})`,
                type: TRANSACTION_TYPE_INTEREST,
                date: paymentDate
            });
        }

        const interestPaidCents = Math.min(paymentCents, pendingInterestCents);
        const principalPaidCents = Math.max(0, paymentCents - interestPaidCents);
        
        const paymentItem = {
            id: createTransactionId(TRANSACTION_TYPE_PAYMENT),
            amount: paymentAmount,
            amountCents: paymentCents,
            type: TRANSACTION_TYPE_PAYMENT,
            interestPaidCents,
            principalPaidCents,
            date: paymentDate
        };
        itemsToSave.push(paymentItem);

        this.clients[clientId].sales.push(...itemsToSave);
        await this.saveClientData(clientId);
        await Promise.all(itemsToSave.map((item) => this.upsertActivity(clientId, item)));
        return {
            success: true,
            interestCents: pendingInterestCents
        };
    }

    async deleteClient(clientId) {
        const salesToRemove = Array.isArray(this.clients[clientId]?.sales)
            ? [...this.clients[clientId].sales]
            : [];

        delete this.clients[clientId];
        await this.removeClientData(clientId);

        if (salesToRemove.length > 0) {
            await Promise.all(salesToRemove.map((saleItem) => this.removeActivity(clientId, saleItem.id)));
        }
    }

    async clearClientHistory(clientId) {
        if (!this.clients[clientId]) throw new Error('Cliente não encontrado');

        const salesToRemove = Array.isArray(this.clients[clientId].sales)
            ? [...this.clients[clientId].sales]
            : [];

        this.clients[clientId].sales = [];
        await this.saveClientData(clientId);

        if (salesToRemove.length > 0) {
            await Promise.all(salesToRemove.map((saleItem) => this.removeActivity(clientId, saleItem.id)));
        }

        return true;
    }

    async updateClientName(clientId, newName) {
        if (!this.clients[clientId]) {
            throw new Error('Cliente não encontrado');
        }
        const name = (newName || '').trim();
        if (!name) {
            throw new Error('Nome do cliente não pode estar vazio');
        }
        if (name.length < 2) {
            throw new Error('Nome deve ter pelo menos 2 caracteres');
        }
        if (name.length > 100) {
            throw new Error('Nome não pode ter mais de 100 caracteres');
        }
        // Verificar se já existe outro cliente com esse nome
        const existingClient = Object.values(this.clients).find(
            c => c.id !== clientId && c.name.toLowerCase() === name.toLowerCase()
        );
        if (existingClient) {
            throw new Error('Já existe um cliente com este nome');
        }
        this.clients[clientId].name = name;
        await this.saveClientData(clientId);
        await this.syncClientActivities(clientId);
        return true;
    }

    async updateClientDisplayName(clientId, displayName) {
        if (!this.clients[clientId]) {
            throw new Error('Cliente não encontrado');
        }

        const sanitizedDisplayName = ValidationUtils.validateText(displayName, {
            maxLength: 100,
            required: false,
            fieldName: 'Nome para exibição'
        });

        this.clients[clientId].displayClientName = sanitizedDisplayName;
        await this.saveClientData(clientId);
        return true;
    }

    async deleteSaleItem(clientId, saleId) {
        if (!this.clients[clientId]) {
            throw new Error('Cliente não encontrado');
        }
        if (!this.clients[clientId].sales) {
            throw new Error('Histórico vazio');
        }
        const saleIndex = this.clients[clientId].sales.findIndex(s => s.id === saleId);
        if (saleIndex === -1) {
            throw new Error('Item não encontrado no histórico');
        }
        const [removedSale] = this.clients[clientId].sales.splice(saleIndex, 1);
        await this.saveClientData(clientId);

        if (removedSale?.id) {
            await this.removeActivity(clientId, removedSale.id);
        }

        return true;
    }

    async archiveClient(clientId) {
        if (!this.clients[clientId]) {
            throw new Error('Cliente não encontrado');
        }
        this.clients[clientId].archived = true;
        this.clients[clientId].archivedAt = new Date().toISOString();
        await this.saveClientData(clientId);
        return true;
    }

    async unarchiveClient(clientId) {
        if (!this.clients[clientId]) {
            throw new Error('Cliente não encontrado');
        }
        this.clients[clientId].archived = false;
        delete this.clients[clientId].archivedAt;
        await this.saveClientData(clientId);
        return true;
    }

    async updateSaleItem(clientId, saleId, amount, description) {
        if (!this.clients[clientId]) {
            throw new Error('Cliente não encontrado');
        }
        if (!this.clients[clientId].sales) {
            throw new Error('Histórico vazio');
        }
        const sale = this.clients[clientId].sales.find(s => s.id === saleId);
        if (!sale) {
            throw new Error('Item não encontrado no histórico');
        }
        
        // Validar valor (pode ser 0 para anotações)
        const numericAmount = parseCurrency(amount);
        if (isNaN(numericAmount)) {
            throw new Error('Valor deve ser um número válido');
        }
        if (numericAmount < 0) {
            throw new Error('Valor não pode ser negativo');
        }
        if (numericAmount > 1000000) {
            throw new Error('Valor não pode ser maior que R$ 1.000.000,00');
        }
        
        // Validar e sanitizar descrição (apenas para vendas)
        const sanitizedDescription = (description || '').trim();
        // Se o valor é 0, a descrição é obrigatória
        if (numericAmount === 0 && !sanitizedDescription && sale.type === TRANSACTION_TYPE_SALE) {
            throw new Error('Para anotações sem valor, a descrição do produto é obrigatória');
        }
        
        const amountCents = currencyToCents(numericAmount);
        sale.amount = numericAmount;
        sale.amountCents = amountCents;
        if (sale.type === TRANSACTION_TYPE_SALE) {
            sale.description = sanitizedDescription;
            sale.isNote = amountCents === 0;
            sale.hasUnpricedItems = amountCents === 0 || saleItemsHaveUnpricedProducts(sale.items) || hasMixedPricedAndUnpricedLines(sanitizedDescription);
        } else if (sale.type === TRANSACTION_TYPE_PAYMENT) {
            const previousInterestPaidCents = Math.max(0, Math.round(Number(sale.interestPaidCents) || 0));
            sale.interestPaidCents = Math.min(amountCents, previousInterestPaidCents);
            sale.principalPaidCents = Math.max(0, amountCents - sale.interestPaidCents);
        }
        sale.editedAt = new Date().toISOString();
        
        await this.saveClientData(clientId);
        await this.upsertActivity(clientId, sale);
        return true;
    }

    getClientDebt(clientId) {
        return this.getClientDebtCents(clientId) / 100;
    }

    getBaseClientDebtCents(clientId) {
        if (!this.clients[clientId]) return 0;
        if (!this.clients[clientId].sales || this.clients[clientId].sales.length === 0) return 0;

        return this.clients[clientId].sales.reduce((total, item) => total + getTransactionDebtDeltaCents(item), 0);
    }

    getClientPrincipalDebtCents(clientId) {
        if (!this.clients[clientId]) return 0;
        if (!this.clients[clientId].sales || this.clients[clientId].sales.length === 0) return 0;

        return this.clients[clientId].sales.reduce((total, item) => total + getPrincipalDebtDeltaCents(item), 0);
    }

    getClientInterestCents(clientId) {
        const debtCents = this.getBaseClientDebtCents(clientId);
        if (debtCents <= 0) return 0;
        if (!this.isOverdueInterestEnabled()) return 0;
        if (!this.isOverdue(clientId)) return 0;

        const principalDebtCents = this.getClientPrincipalDebtCents(clientId);
        if (principalDebtCents <= 0) return 0;

        const interestBaseCents = Math.min(principalDebtCents, debtCents);
        return Math.round(interestBaseCents * (this.getOverdueInterestPercent() / 100));
    }

    getClientDebtCents(clientId) {
        const baseDebtCents = this.getBaseClientDebtCents(clientId);
        return baseDebtCents + this.getClientInterestCents(clientId);
    }

    getTotalDebt() {
        const totalInCents = Object.keys(this.clients).reduce((total, clientId) => {
            // Excluir clientes arquivados do cálculo
            if (this.clients[clientId].archived) return total;
            const debt = this.getClientDebtCents(clientId);
            // Somar apenas dívidas positivas
            return debt > 0 ? total + debt : total;
        }, 0);

        return totalInCents / 100;
    }

    getClientSalesCount(clientId) {
        if (!this.clients[clientId]) return 0;
        if (!this.clients[clientId].sales) return 0;
        return this.clients[clientId].sales.filter(s => s.type === TRANSACTION_TYPE_SALE).length;
    }

    hasUnpricedNotes(clientId) {
        if (!this.clients[clientId]) return false;
        if (!this.clients[clientId].sales) return false;
        return this.clients[clientId].sales.some(s => saleHasUnpricedProducts(s));
    }

    getClientsWithUnpricedNotes() {
        return Object.values(this.clients).filter(client => 
            this.hasUnpricedNotes(client.id)
        );
    }

    getLastPaymentDate(clientId) {
        if (!this.clients[clientId]) return null;
        if (!this.clients[clientId].sales) return null;
        const payments = this.clients[clientId].sales.filter(s => s.type === TRANSACTION_TYPE_PAYMENT);
        if (payments.length === 0) return null;
        // Retorna a data do pagamento mais recente
        return payments.reduce((latest, p) => {
            const d = new Date(p.date);
            return d > latest ? d : latest;
        }, new Date(payments[0].date));
    }

    getDaysSinceReferencePayment(clientId) {
        // Considera atraso apenas para clientes com dívida positiva
        const baseDebtCents = this.getBaseClientDebtCents(clientId);
        if (baseDebtCents <= 0) return 0;

        const now = new Date();
        const lastPayment = this.getLastPaymentDate(clientId);

        if (lastPayment) {
            return Math.floor((now - lastPayment) / (1000 * 60 * 60 * 24));
        }

        // Nunca pagou: usa a data da primeira venda
        const client = this.clients[clientId];
        if (!client?.sales || client.sales.length === 0) return 0;
        const firstSale = client.sales.find(s => s.type === TRANSACTION_TYPE_SALE);
        if (!firstSale) return 0;

        return Math.floor((now - new Date(firstSale.date)) / (1000 * 60 * 60 * 24));
    }

    isOverdue(clientId) {
        return this.getDaysSinceReferencePayment(clientId) >= this.getOverdueAlertDays();
    }
}

// Inicializar gerenciador
const manager = new SalesManager();

// Elementos DOM - Auth
const loginScreen = document.getElementById('loginScreen');
const appScreen = document.getElementById('appScreen');
const loginForm = document.getElementById('loginForm');
const logoutBtn = document.getElementById('logoutBtn');
const userEmailSpan = document.getElementById('userEmail');

// Elementos DOM - App
const addSaleForm = document.getElementById('addSaleForm');
const clientSearch = document.getElementById('clientSearch');
const clientSuggestions = document.getElementById('clientSuggestions');
const searchClients = document.getElementById('searchClients');
const paymentForm = document.getElementById('paymentForm');
const modalAddSaleForm = document.getElementById('modalAddSaleForm');
const modalSaleAmountInput = document.getElementById('modalSaleAmount');
const modalSaleDescriptionInput = document.getElementById('modalSaleDescription');
const modalSaleProductSearchInput = document.getElementById('modalSaleProductSearch');
const modalSaleProductSuggestions = document.getElementById('modalSaleProductSuggestions');
const modalSaleItemsList = document.getElementById('modalSaleItemsList');
const justNoteProductCheckbox = document.getElementById('justNoteProduct');
const saleAmountInput = document.getElementById('saleAmount');
const saleDescriptionInput = document.getElementById('saleDescription');
const saleProductSearchInput = document.getElementById('saleProductSearch');
const saleProductSuggestions = document.getElementById('saleProductSuggestions');
const saleItemsList = document.getElementById('saleItemsList');
const clientNameInput = document.getElementById('clientNameInput');
const modal = document.getElementById('clientModal');
const closeModal = document.querySelector('.close');
const deleteClientBtn = document.getElementById('deleteClient');
const archiveClientBtn = document.getElementById('archiveClient');
const clearHistoryBtn = document.getElementById('clearHistory');
const shareHistoryBtn = document.getElementById('shareHistory');
const clientScreenTabPayment = document.getElementById('clientScreenTabPayment');
const clientScreenTabSale = document.getElementById('clientScreenTabSale');
const clientScreenTabHistory = document.getElementById('clientScreenTabHistory');
const clientScreenTabSettings = document.getElementById('clientScreenTabSettings');
const clientScreenPayment = document.getElementById('clientScreenPayment');
const clientScreenSale = document.getElementById('clientScreenSale');
const clientScreenHistory = document.getElementById('clientScreenHistory');
const clientScreenSettings = document.getElementById('clientScreenSettings');
const loader = document.getElementById('loader');
const toast = document.getElementById('toast');
const editNameForm = document.getElementById('editNameForm');
const editClientNameInput = document.getElementById('editClientName');
const editNameBtn = document.getElementById('editNameBtn');
const cancelEditNameBtn = document.getElementById('cancelEditName');
const clientDisplayNameForm = document.getElementById('clientDisplayNameForm');
const clientDisplayNameInput = document.getElementById('clientDisplayNameInput');
const confirmModal = document.getElementById('confirmModal');
const confirmTitle = document.getElementById('confirmTitle');
const confirmMessage = document.getElementById('confirmMessage');
const confirmOkBtn = document.getElementById('confirmOk');
const confirmCancelBtn = document.getElementById('confirmCancel');
const editSaleModal = document.getElementById('editSaleModal');
const editSaleForm = document.getElementById('editSaleForm');
const editSaleAmount = document.getElementById('editSaleAmount');
const editSaleDescription = document.getElementById('editSaleDescription');
const editSaleType = document.getElementById('editSaleType');
const closeEditSaleModal = document.getElementById('closeEditSaleModal');
const cancelEditSale = document.getElementById('cancelEditSale');
const unpricedNotesAlert = document.getElementById('unpricedNotesAlert');
const unpricedNotesMessage = document.getElementById('unpricedNotesMessage');
const closeAlertBtn = document.getElementById('closeAlert');
const appMenu = document.getElementById('appMenu');
const appMenuOverlay = document.getElementById('appMenuOverlay');
const menuToggleBtn = document.getElementById('menuToggle');
const menuCloseBtn = document.getElementById('menuClose');
const overdueFilterText = document.getElementById('overdueFilterText');
let currentEditingSaleId = null;
let alertDismissed = false;
let productsUnsubscribe = null;
let savedProducts = {};
const saleDraftItems = new WeakMap();
const autosaveTimers = new WeakMap();
const AUTOSAVE_DELAY_MS = 1800;
const SALE_DESCRIPTION_DRAFT_KEY = 'salesOnCredit:addSaleDescriptionDraft';

function loadSaleDescriptionDraft() {
    if (!saleDescriptionInput) return;

    try {
        const savedDraft = localStorage.getItem(SALE_DESCRIPTION_DRAFT_KEY);
        if (savedDraft !== null) {
            saleDescriptionInput.value = savedDraft;
        }
    } catch (error) {
        safeLog('Não foi possível carregar rascunho da descrição:', error);
    }
}

function saveSaleDescriptionDraft() {
    if (!saleDescriptionInput) return;

    try {
        localStorage.setItem(SALE_DESCRIPTION_DRAFT_KEY, saleDescriptionInput.value || '');
    } catch (error) {
        safeLog('Não foi possível salvar rascunho da descrição:', error);
    }
}

function clearSaleDescriptionDraft() {
    try {
        localStorage.removeItem(SALE_DESCRIPTION_DRAFT_KEY);
    } catch (error) {
        safeLog('Não foi possível limpar rascunho da descrição:', error);
    }
}

function setMenuOpen(isOpen) {
    if (!appMenu || !appMenuOverlay || !menuToggleBtn) return;

    appMenu.classList.toggle('open', isOpen);
    document.body.classList.toggle('menu-open', isOpen);
    appMenu.setAttribute('aria-hidden', String(!isOpen));
    appMenuOverlay.hidden = !isOpen;
    menuToggleBtn.setAttribute('aria-expanded', String(isOpen));

    if (isOpen) {
        const firstMenuItem = appMenu.querySelector('.app-menu-link, .btn-menu-close');
        firstMenuItem?.focus({ preventScroll: true });
    } else if (document.activeElement && appMenu.contains(document.activeElement)) {
        menuToggleBtn.focus({ preventScroll: true });
    }
}

function initializeAppMenu() {
    if (!appMenu || !appMenuOverlay || !menuToggleBtn || !menuCloseBtn) return;

    menuToggleBtn.addEventListener('click', () => setMenuOpen(true));
    menuCloseBtn.addEventListener('click', () => setMenuOpen(false));
    appMenuOverlay.addEventListener('click', () => setMenuOpen(false));

    document.querySelectorAll('.app-menu-link').forEach((link) => {
        link.addEventListener('click', () => setMenuOpen(false));
    });

    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
            setMenuOpen(false);
        }
    });

    window.addEventListener('resize', () => setMenuOpen(false));
}

function syncSettingsUI() {
    const overdueDays = manager.getOverdueAlertDays();
    const formattedDays = formatOverdueAlertDays(overdueDays);

    if (overdueFilterText) {
        overdueFilterText.textContent = `⚠️ Pagamento atrasado (${formattedDays})`;
    }
}

initializeAppMenu();
loadSaleDescriptionDraft();
syncSettingsUI();
setupProductPicker(saleProductSearchInput, saleAmountInput, saleProductSuggestions, saleItemsList);
setupProductPicker(modalSaleProductSearchInput, modalSaleAmountInput, modalSaleProductSuggestions, modalSaleItemsList);
setupClientModalProductSearchCompaction();

if (saleDescriptionInput) {
    saleDescriptionInput.addEventListener('input', saveSaleDescriptionDraft);
}

addSaleForm?.addEventListener('reset', () => {
    clearSaleDraftItems(saleProductSearchInput, saleItemsList, saleAmountInput);
    clearFormAutosaveState(addSaleForm);
});
modalAddSaleForm?.addEventListener('reset', () => {
    clearSaleDraftItems(modalSaleProductSearchInput, modalSaleItemsList, modalSaleAmountInput);
    clearFormAutosaveState(modalAddSaleForm);
});
paymentForm?.addEventListener('reset', () => clearFormAutosaveState(paymentForm));

// Aplicar máscara de moeda em todos os campos de valor
[saleAmountInput, modalSaleAmountInput, editSaleAmount, document.getElementById('paymentAmount')].forEach(input => {
    if (input) currencyMask(input);
});

[saleAmountInput, modalSaleAmountInput].forEach((input) => {
    input?.addEventListener('input', () => {
        if (input.readOnly && input.dataset.autoSaleTotal === 'true') return;
        delete input.dataset.autoSaleTotal;
    });
});

// Funções de UI
function showLoader(message = 'Processando...') {
    const loaderText = document.querySelector('.loader-text');
    if (loaderText) {
        loaderText.textContent = message;
    }
    loader.classList.add('active');
}

function hideLoader() {
    loader.classList.remove('active');
}

function showToast(message = 'Salvo com sucesso!', type = 'success') {
    const toastMessage = toast.querySelector('.toast-message');
    toastMessage.textContent = message;
    
    // Remover classes anteriores
    toast.classList.remove('toast-success', 'toast-error');
    
    // Adicionar classe de tipo
    toast.classList.add(type === 'error' ? 'toast-error' : 'toast-success');
    toast.classList.add('show');
    
    setTimeout(() => {
        toast.classList.remove('show');
    }, 3000);
}
function showConfirm(title, message) {
    return new Promise((resolve) => {
        confirmTitle.textContent = title;
        confirmMessage.textContent = message;
        confirmModal.classList.add('show');
        
        const handleOk = () => {
            confirmModal.classList.remove('show');
            confirmOkBtn.removeEventListener('click', handleOk);
            confirmCancelBtn.removeEventListener('click', handleCancel);
            resolve(true);
        };
        
        const handleCancel = () => {
            confirmModal.classList.remove('show');
            confirmOkBtn.removeEventListener('click', handleOk);
            confirmCancelBtn.removeEventListener('click', handleCancel);
            resolve(false);
        };
        
        confirmOkBtn.addEventListener('click', handleOk);
        confirmCancelBtn.addEventListener('click', handleCancel);
    });
}

// Utilitários de validação
const ValidationUtils = {
    validateAmount(amount, options = {}) {
        const { min = 0, max = 1000000, allowZero = false } = options;
        const numericAmount = parseCurrency(amount);
        
        if (isNaN(numericAmount)) {
            throw new Error('O valor deve ser um número válido');
        }
        if (!allowZero && numericAmount <= min) {
            throw new Error(`O valor deve ser maior que R$ ${min.toFixed(2)}`);
        }
        if (allowZero && numericAmount < min) {
            throw new Error(`O valor não pode ser negativo`);
        }
        if (numericAmount > max) {
            throw new Error(`O valor não pode ser maior que R$ ${max.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`);
        }
        return numericAmount;
    },
    
    validateText(text, options = {}) {
        const { minLength = 0, maxLength = Infinity, required = false, fieldName = 'Campo' } = options;
        const trimmed = (text || '').trim();
        
        if (required && !trimmed) {
            throw new Error(`${fieldName} é obrigatório`);
        }
        if (trimmed && trimmed.length < minLength) {
            throw new Error(`${fieldName} deve ter pelo menos ${minLength} caracteres`);
        }
        if (Number.isFinite(maxLength) && trimmed.length > maxLength) {
            throw new Error(`${fieldName} não pode ter mais de ${maxLength} caracteres`);
        }
        return trimmed;
    }
};

function formatDescription(text) {
    // Sanitizar e preservar quebras de linha convertendo \n para <br>
    const sanitized = sanitizeHTML(text);
    return sanitized.replace(/\n/g, '<br>');
}

function formatSaleItems(items) {
    const normalizedItems = normalizeSaleItems(items);
    if (normalizedItems.length === 0) return '';

    return `
        <div class="sale-items-summary">
            ${normalizedItems.map((item) => {
                const priceText = item.priced
                    ? `R$ ${formatCurrency(centsToAmount(item.totalCents))}`
                    : 'Sem preco';

                return `
                    <div class="sale-items-summary-row">
                        <span>${sanitizeHTML(item.quantity)}x ${sanitizeHTML(item.name)}</span>
                        <strong>${priceText}</strong>
                    </div>
                `;
            }).join('')}
        </div>
    `;
}

function getProductDescriptionLines(description) {
    return String(description || '')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
}

function descriptionLineHasPrice(line) {
    const text = String(line || '');
    return /(?:^|[\s=])R\$\s*\d{1,3}(?:\.\d{3})*(?:,\d{2})?(?:\s|$)/i.test(text)
        || /=\s*\d{1,3}(?:\.\d{3})*(?:,\d{2})?(?:\s|$)/.test(text);
}

function hasUnpricedProductLine(description) {
    const lines = getProductDescriptionLines(description);
    return lines.length > 0 && lines.some((line) => !descriptionLineHasPrice(line));
}

function hasPricedProductLine(description) {
    return getProductDescriptionLines(description).some((line) => descriptionLineHasPrice(line));
}

function hasMixedPricedAndUnpricedLines(description) {
    return hasPricedProductLine(description) && hasUnpricedProductLine(description);
}

function saleHasUnpricedProducts(sale) {
    if (!sale || sale.type !== TRANSACTION_TYPE_SALE) return false;
    return Boolean(sale.isNote)
        || getSaleAmountCents(sale) === 0
        || saleItemsHaveUnpricedProducts(sale.items)
        || (!sale.editedAt && hasMixedPricedAndUnpricedLines(sale.description));
}

// Debounce utility: atrasa execução até parar de digitar
function debounce(fn, delay = 300) {
    let timer;
    return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), delay);
    };
}

function getDatabaseErrorMessage(error, fallback) {
    const code = error?.code || '';
    const message = error?.message || '';
    if (code === 'PERMISSION_DENIED' || /permission denied/i.test(message)) {
        return 'Sem permissão no banco. Atualize as regras do Firebase.';
    }
    if (/network/i.test(message)) {
        return 'Sem conexão. Verifique sua internet.';
    }
    return fallback;
}

// Funções de formatação
function formatCurrency(value) {
    const numericValue = Number(value);
    if (!Number.isFinite(numericValue)) return '0,00';
    const roundedValue = Math.round((numericValue + Number.EPSILON) * 100) / 100;
    const safeValue = Object.is(roundedValue, -0) ? 0 : roundedValue;

    return currencyFormatter.format(safeValue);
}

// Formatar dias em meses e dias
function formatDaysToMonths(totalDays) {
    const months = Math.floor(totalDays / 30);
    const days = totalDays % 30;
    if (months === 0) return `${days} dia${days !== 1 ? 's' : ''}`;
    if (days === 0) return `${months} ${months === 1 ? 'mês' : 'meses'}`;
    return `${months} ${months === 1 ? 'mês' : 'meses'} e ${days} dia${days !== 1 ? 's' : ''}`;
}

function buildOverdueMessage({ lastPaymentDate, firstSaleDate, overdueDays }) {
    if (lastPaymentDate) return `\u00daltimo pagamento h\u00e1 ${formatDaysToMonths(overdueDays)}`;
    if (firstSaleDate) return `Sem pagamento h\u00e1 ${formatDaysToMonths(overdueDays)}`;
    return 'Nunca realizou pagamento';
}

// Máscara de moeda brasileira (R$) - formata enquanto digita
function currencyMask(input) {
    input.addEventListener('input', (e) => {
        let value = e.target.value;
        
        // Remove tudo que não é dígito
        value = value.replace(/\D/g, '');
        
        // Remove zeros à esquerda excessivos
        value = value.replace(/^0+/, '') || '0';
        
        // Garante pelo menos 3 dígitos (para centavos)
        value = value.padStart(3, '0');
        
        // Separa reais e centavos
        const cents = value.slice(-2);
        let reais = value.slice(0, -2);
        
        // Adiciona separador de milhar
        reais = reais.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
        
        // Formata
        e.target.value = `${reais},${cents}`;
    });
    
    // Seleciona tudo ao focar para facilitar edição
    input.addEventListener('focus', () => {
        setTimeout(() => input.select(), 0);
    });
}

// Converte valor formatado "1.234,56" para número 1234.56
function parseCurrency(value) {
    if (value === null || value === undefined) return NaN;
    // Se já for número, retorna diretamente
    if (typeof value === 'number') return value;
    if (typeof value !== 'string') return NaN;
    const trimmed = value.trim();
    if (trimmed === '') return NaN;
    // Remove pontos de milhar e troca vírgula por ponto
    const cleaned = trimmed.replace(/\./g, '').replace(',', '.');
    return parseFloat(cleaned);
}

// Converte número para string formatada para preencher input
function numberToCurrencyInput(num) {
    if (isNaN(num) || num === null || num === undefined) return '0,00';
    return num.toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

function currencyToCents(value) {
    const numericValue = typeof value === 'number' ? value : parseCurrency(value);
    if (!Number.isFinite(numericValue)) return 0;
    return Math.round((numericValue + Number.EPSILON) * 100);
}

function centsToAmount(cents) {
    const numericCents = Number(cents);
    if (!Number.isFinite(numericCents)) return 0;
    return Math.round(numericCents) / 100;
}

function getSaleAmountCents(saleItem) {
    const directCents = Number(saleItem?.amountCents);
    if (Number.isFinite(directCents)) return Math.round(directCents);
    return currencyToCents(saleItem?.amount);
}

function getSaleAmount(saleItem) {
    return centsToAmount(getSaleAmountCents(saleItem));
}

function createTransactionId(type = '') {
    const suffix = type ? `_${type}` : '';
    const randomPart = Math.random().toString(36).slice(2, 8);
    return `${Date.now()}${suffix}_${randomPart}`;
}

function isDebtIncreaseTransaction(item) {
    return item?.type === TRANSACTION_TYPE_SALE || item?.type === TRANSACTION_TYPE_INTEREST;
}

function getTransactionDebtDeltaCents(item) {
    const amountInCents = getSaleAmountCents(item);
    if (isDebtIncreaseTransaction(item)) return amountInCents;
    if (item?.type === TRANSACTION_TYPE_PAYMENT) return -amountInCents;
    return 0;
}

function getPaymentPrincipalCents(paymentItem) {
    if (paymentItem?.type !== TRANSACTION_TYPE_PAYMENT) return 0;

    const directPrincipal = Number(paymentItem?.principalPaidCents);
    if (Number.isFinite(directPrincipal)) {
        return Math.max(0, Math.round(directPrincipal));
    }

    return getSaleAmountCents(paymentItem);
}

function getPrincipalDebtDeltaCents(item) {
    if (item?.type === TRANSACTION_TYPE_SALE) return getSaleAmountCents(item);
    if (item?.type === TRANSACTION_TYPE_PAYMENT) return -getPaymentPrincipalCents(item);
    return 0;
}

function saleItemsHaveUnpricedProducts(items) {
    return Array.isArray(items) && items.some((item) => item && item.priced === false);
}

function normalizeSaleItems(items) {
    if (!Array.isArray(items)) return [];

    return items.map((item) => {
        const quantity = getSafeProductQuantity(item?.quantity);
        const unitPriceCents = Math.max(0, Math.round(Number(item?.unitPriceCents) || 0));
        const hasPrice = item?.priced !== false && unitPriceCents > 0;
        const totalCents = hasPrice ? unitPriceCents * quantity : 0;

        return {
            productId: String(item?.productId || ''),
            name: String(item?.name || '').trim(),
            quantity,
            unitPriceCents: hasPrice ? unitPriceCents : 0,
            totalCents,
            priced: hasPrice
        };
    }).filter((item) => item.name);
}

function getSaleDraftItems(textarea) {
    if (!textarea) return [];
    return normalizeSaleItems(saleDraftItems.get(textarea) || []);
}

function setSaleDraftItems(textarea, items) {
    if (!textarea) return;
    saleDraftItems.set(textarea, normalizeSaleItems(items));
}

function clearSaleDraftItems(searchInput, listElement, amountInput) {
    if (!searchInput) return;
    saleDraftItems.delete(searchInput);
    if (searchInput) searchInput.value = '';
    if (amountInput?.dataset.autoSaleTotal === 'true') {
        amountInput.value = '';
        delete amountInput.dataset.autoSaleTotal;
        amountInput.readOnly = false;
        amountInput.classList.remove('input-readonly-total');
    }
    if (listElement) renderSaleItemsList(searchInput, listElement, amountInput);
}

function getSaleItemsTotalCents(items) {
    return normalizeSaleItems(items).reduce((total, item) => total + item.totalCents, 0);
}

function getAutosaveAmountCents(value) {
    const amount = parseCurrency(value);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 1000000) return 0;
    return currencyToCents(amount);
}

function getSaleAutosaveAmountCents(amountInput, items) {
    const itemsTotalCents = getSaleItemsTotalCents(items);
    return itemsTotalCents > 0 ? itemsTotalCents : getAutosaveAmountCents(amountInput?.value);
}

function getSaleItemsSignature(items) {
    return JSON.stringify(normalizeSaleItems(items).map((item) => ({
        productId: item.productId,
        name: item.name,
        quantity: item.quantity,
        unitPriceCents: item.unitPriceCents,
        totalCents: item.totalCents,
        priced: item.priced
    })));
}

function beginFormSubmission(form) {
    if (!form || form.dataset.submitting === 'true') return false;
    form.dataset.submitting = 'true';
    window.clearTimeout(autosaveTimers.get(form));
    autosaveTimers.delete(form);
    return true;
}

function finishFormSubmission(form) {
    if (!form) return;
    delete form.dataset.submitting;
    delete form.dataset.pendingAutosaveSignature;
}

function clearFormAutosaveState(form) {
    if (!form) return;
    window.clearTimeout(autosaveTimers.get(form));
    autosaveTimers.delete(form);
    delete form.dataset.pendingAutosaveSignature;
    delete form.dataset.lastAutosaveSignature;
    delete form.dataset.submitting;
}

function scheduleFormAutosave(form, getSignature, isReady) {
    if (!form) return;
    window.clearTimeout(autosaveTimers.get(form));

    autosaveTimers.set(form, window.setTimeout(() => {
        if (form.dataset.submitting === 'true') return;
        if (!isReady()) return;

        const signature = getSignature();
        if (!signature) return;
        if (form.dataset.pendingAutosaveSignature === signature || form.dataset.lastAutosaveSignature === signature) return;

        form.dataset.pendingAutosaveSignature = signature;
        form.requestSubmit();
    }, AUTOSAVE_DELAY_MS));
}

function scheduleMainSaleAutosave() {
    scheduleFormAutosave(addSaleForm, getMainSaleAutosaveSignature, isMainSaleAutosaveReady);
}

function scheduleModalSaleAutosave() {
    scheduleFormAutosave(modalAddSaleForm, getModalSaleAutosaveSignature, isModalSaleAutosaveReady);
}

function schedulePaymentAutosave() {
    scheduleFormAutosave(paymentForm, getPaymentAutosaveSignature, isPaymentAutosaveReady);
}

function scheduleSaleAutosaveForAmountInput(amountInput) {
    if (amountInput === saleAmountInput) scheduleMainSaleAutosave();
    if (amountInput === modalSaleAmountInput) scheduleModalSaleAutosave();
}

function isMainSaleAutosaveReady() {
    const clientName = (clientSearch?.value || '').trim();
    if (clientName.length < 2 || clientName.length > 100) return false;
    if ((saleProductSearchInput?.value || '').trim()) return false;

    const items = getSaleDraftItems(saleProductSearchInput);
    const description = (saleDescriptionInput?.value || '').trim();
    const amountCents = getSaleAutosaveAmountCents(saleAmountInput, items);

    return amountCents > 0 || items.length > 0 || description.length > 0;
}

function getMainSaleAutosaveSignature() {
    if (!isMainSaleAutosaveReady()) return '';
    const items = getSaleDraftItems(saleProductSearchInput);
    return [
        (selectedClientId || '').trim(),
        (clientSearch?.value || '').trim().toLowerCase(),
        getSaleAutosaveAmountCents(saleAmountInput, items),
        (saleDescriptionInput?.value || '').trim(),
        getSaleItemsSignature(items)
    ].join('|');
}

function isModalSaleAutosaveReady() {
    if (!manager.currentClientId) return false;
    if ((modalSaleProductSearchInput?.value || '').trim()) return false;

    const items = getSaleDraftItems(modalSaleProductSearchInput);
    const description = (modalSaleDescriptionInput?.value || '').trim();
    const amountCents = getSaleAutosaveAmountCents(modalSaleAmountInput, items);

    return amountCents > 0 || items.length > 0 || description.length > 0;
}

function getModalSaleAutosaveSignature() {
    if (!isModalSaleAutosaveReady()) return '';
    const items = getSaleDraftItems(modalSaleProductSearchInput);
    return [
        manager.currentClientId || '',
        getSaleAutosaveAmountCents(modalSaleAmountInput, items),
        (modalSaleDescriptionInput?.value || '').trim(),
        getSaleItemsSignature(items)
    ].join('|');
}

function isPaymentAutosaveReady() {
    if (!manager.currentClientId) return false;
    return getAutosaveAmountCents(document.getElementById('paymentAmount')?.value) > 0;
}

function getPaymentAutosaveSignature() {
    if (!isPaymentAutosaveReady()) return '';
    return [
        manager.currentClientId || '',
        getAutosaveAmountCents(document.getElementById('paymentAmount')?.value)
    ].join('|');
}

function getModalSaleDraftPayload() {
    const amount = modalSaleAmountInput?.value;
    const description = (modalSaleDescriptionInput?.value || '').trim();
    const hasAmount = (amount || '').trim() !== '';
    const saleItems = getSaleDraftItems(modalSaleProductSearchInput);
    const isJustNote = !hasAmount;
    let numericAmount = 0;

    if (isJustNote) {
        if (!description && saleItems.length === 0) return null;
    } else {
        numericAmount = parseCurrency(amount);
        if (!Number.isFinite(numericAmount) || numericAmount <= 0 || numericAmount > 1000000) return null;
    }

    const saleItemsTotalCents = getSaleItemsTotalCents(saleItems);
    if (!isJustNote && saleItemsTotalCents > 0) {
        numericAmount = centsToAmount(saleItemsTotalCents);
        modalSaleAmountInput.value = numberToCurrencyInput(numericAmount);
    }

    return { numericAmount, description, saleItems };
}

function getPaymentDraftPayload() {
    const paymentAmountInput = document.getElementById('paymentAmount');
    const numericAmount = parseCurrency(paymentAmountInput?.value);
    if (!Number.isFinite(numericAmount) || numericAmount <= 0 || numericAmount > 1000000) return null;
    return { numericAmount };
}

async function savePendingClientModalFormsOnClose() {
    if (!manager.currentClientId) return true;

    const salePayload = getModalSaleDraftPayload();
    const paymentPayload = getPaymentDraftPayload();

    if (!salePayload && !paymentPayload) return true;

    showLoader('Salvando...');
    try {
        if (salePayload && beginFormSubmission(modalAddSaleForm)) {
            await manager.addSale(
                manager.currentClientId,
                salePayload.numericAmount,
                salePayload.description,
                salePayload.saleItems
            );
            modalAddSaleForm.reset();
            clearSaleDraftItems(modalSaleProductSearchInput, modalSaleItemsList, modalSaleAmountInput);
            clearFormAutosaveState(modalAddSaleForm);
        }

        if (paymentPayload && beginFormSubmission(paymentForm)) {
            await manager.addPayment(manager.currentClientId, paymentPayload.numericAmount);
            paymentForm.reset();
            clearFormAutosaveState(paymentForm);
        }

        await manager.loadData();
        updateClientsList();
        showToast('Dados salvos com sucesso!', 'success');
        return true;
    } catch (error) {
        finishFormSubmission(modalAddSaleForm);
        finishFormSubmission(paymentForm);
        console.error('Erro ao salvar ao fechar:', error);
        showToast(getDatabaseErrorMessage(error, 'Erro ao salvar antes de fechar. Tente novamente.'), 'error');
        return false;
    } finally {
        hideLoader();
    }
}

function syncSaleAmountFromItems(searchInput, amountInput) {
    if (!amountInput) return;
    const totalCents = getSaleItemsTotalCents(getSaleDraftItems(searchInput));
    if (totalCents > 0) {
        amountInput.value = numberToCurrencyInput(centsToAmount(totalCents));
        amountInput.dataset.autoSaleTotal = 'true';
        amountInput.readOnly = true;
        amountInput.classList.add('input-readonly-total');
    } else if (amountInput.dataset.autoSaleTotal === 'true') {
        amountInput.value = '';
        delete amountInput.dataset.autoSaleTotal;
        amountInput.readOnly = false;
        amountInput.classList.remove('input-readonly-total');
    }
}

function renderSaleItemsList(searchInput, listElement, amountInput) {
    if (!listElement) return;
    const items = getSaleDraftItems(searchInput);
    syncSaleAmountFromItems(searchInput, amountInput);

    if (items.length === 0) {
        listElement.innerHTML = '';
        listElement.classList.remove('has-items');
        return;
    }

    listElement.classList.add('has-items');
    listElement.innerHTML = items.map((item, index) => {
        const priceText = item.priced
            ? `R$ ${formatCurrency(centsToAmount(item.totalCents))}`
            : 'Sem preco';

        return `
            <div class="sale-cart-item">
                <div class="sale-cart-item-info">
                    <strong>${sanitizeHTML(item.quantity)}x ${sanitizeHTML(item.name)}</strong>
                    <span>${priceText}</span>
                </div>
                <button class="sale-cart-remove" type="button" data-remove-sale-item="${index}" aria-label="Remover ${sanitizeHTML(item.name)}">&times;</button>
            </div>
        `;
    }).join('');
}

function normalizeProductSearch(value) {
    return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .trim();
}

function getSortedProducts() {
    return Object.entries(savedProducts || {})
        .map(([id, product]) => ({ id, ...product }))
        .filter((product) => product.active !== false && product.name)
        .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'pt-BR'));
}

function subscribeProducts(userId) {
    if (productsUnsubscribe) {
        productsUnsubscribe();
        productsUnsubscribe = null;
    }

    savedProducts = {};

    if (!userId) return;

    productsUnsubscribe = onValue(ref(database, `users/${userId}/products`), (snapshot) => {
        savedProducts = snapshot.val() || {};
    }, (error) => {
        console.error('Erro ao carregar produtos:', error);
        savedProducts = {};
    });
}

function getProductSearchTerm(textarea) {
    const lines = String(textarea?.value || '').split('\n');
    return lines[lines.length - 1].trim();
}

function moveTextareaCursorToEnd(textarea) {
    if (!textarea) return;

    const endPosition = textarea.value.length;
    textarea.focus();
    textarea.setSelectionRange(endPosition, endPosition);
    textarea.scrollTop = textarea.scrollHeight;
}

function keepProductLinesAboveDraft(textarea) {
    if (!textarea || !hasPricedProductLine(textarea.value)) return false;

    const endsWithNewLine = textarea.value.endsWith('\n');
    const lines = String(textarea.value || '')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);

    const pricedLines = lines.filter((line) => descriptionLineHasPrice(line));
    const draftLines = lines.filter((line) => !descriptionLineHasPrice(line));
    const nextValue = `${[...pricedLines, ...draftLines].join('\n')}${endsWithNewLine ? '\n' : ''}`;

    if (nextValue === textarea.value) return false;

    textarea.value = nextValue;
    moveTextareaCursorToEnd(textarea);
    return true;
}

function hideProductSuggestions(dropdown) {
    if (!dropdown) return;
    dropdown.classList.remove('show');
    dropdown.innerHTML = '';
}

function setClientModalProductSearchActive(isActive) {
    modal?.classList.toggle('is-product-searching', Boolean(isActive));
}

function renderDescriptionPriceHighlight(textarea, highlight) {
    if (!textarea || !highlight) return;

    const lines = String(textarea.value || '').split('\n');
    highlight.innerHTML = lines.map((line) => {
        const safeLine = sanitizeHTML(line || ' ');
        const hasLinePrice = descriptionLineHasPrice(line);
        const className = line.trim() && !hasLinePrice
            ? 'description-line-unpriced'
            : hasLinePrice
                ? 'description-line-priced description-line-added'
                : 'description-line-priced';

        return `<div class="${className}">${safeLine}</div>`;
    }).join('');

    textarea.classList.toggle('has-unpriced-lines', hasUnpricedProductLine(textarea.value));
}

function syncDescriptionHighlightScroll(textarea, highlight) {
    if (!textarea || !highlight) return;
    highlight.scrollTop = textarea.scrollTop;
    highlight.scrollLeft = textarea.scrollLeft;
}

function setupDescriptionPriceHighlight(textarea) {
    if (!textarea || textarea.dataset.priceHighlightReady === 'true') return;

    const wrapper = textarea.closest('.product-picker-wrapper');
    if (!wrapper) return;

    const highlight = document.createElement('div');
    highlight.className = 'description-price-highlight';
    highlight.setAttribute('aria-hidden', 'true');
    wrapper.insertBefore(highlight, textarea);

    textarea.dataset.priceHighlightReady = 'true';
    textarea.classList.add('description-highlight-textarea');

    const updateHighlight = () => {
        renderDescriptionPriceHighlight(textarea, highlight);
        syncDescriptionHighlightScroll(textarea, highlight);
    };

    textarea.addEventListener('input', updateHighlight);
    textarea.addEventListener('scroll', () => syncDescriptionHighlightScroll(textarea, highlight));
    textarea.form?.addEventListener('reset', () => setTimeout(updateHighlight, 0));
    updateHighlight();
}

function renderProductSuggestions(searchInput, amountInput, dropdown) {
    if (!searchInput || !amountInput || !dropdown) return;

    const search = normalizeProductSearch(getProductSearchTerm(searchInput));
    if (!search) {
        hideProductSuggestions(dropdown);
        return;
    }

    const matches = getSortedProducts()
        .filter((product) => normalizeProductSearch([product.name, product.description].join(' ')).includes(search))
        .slice(0, 8);

    if (matches.length === 0) {
        hideProductSuggestions(dropdown);
        return;
    }

    dropdown.innerHTML = matches.map((product) => {
        const productPrice = Number(product.price);
        const hasPrice = Number.isFinite(productPrice) && productPrice > 0;

        return `
        <div class="suggestion-item product-suggestion-item" data-product-id="${sanitizeHTML(product.id)}">
            <div class="product-suggestion-info">
                <span>${sanitizeHTML(product.name)}</span>
                <strong class="${hasPrice ? '' : 'product-unpriced-label'}">${hasPrice ? `R$ ${formatCurrency(productPrice)}` : 'Sem preco'}</strong>
            </div>
            <div class="product-quantity-controls" aria-label="Quantidade">
                <button class="product-quantity-btn" type="button" data-quantity-action="decrease" aria-label="Diminuir quantidade">-</button>
                <input class="product-quantity-input" type="number" inputmode="numeric" min="1" max="999" value="1" aria-label="Quantidade de ${sanitizeHTML(product.name)}">
                <button class="product-quantity-btn" type="button" data-quantity-action="increase" aria-label="Aumentar quantidade">+</button>
                <button class="product-add-btn" type="button" data-quantity-action="add">Adicionar</button>
            </div>
        </div>
    `;
    }).join('');
    dropdown.classList.add('show');
}

function getSafeProductQuantity(value) {
    const quantity = Number.parseInt(value, 10);
    if (!Number.isFinite(quantity)) return 1;
    return Math.min(999, Math.max(1, quantity));
}

function appendSelectedProduct(searchInput, amountInput, product, quantity = 1) {
    if (!searchInput || !amountInput || !product) return false;

    const productName = String(product.name || '').trim();
    const productPrice = Number(product.price);
    const safeQuantity = getSafeProductQuantity(quantity);
    const hasProductPrice = Number.isFinite(productPrice) && productPrice > 0;
    const unitPriceCents = hasProductPrice ? currencyToCents(productPrice) : 0;
    const productTotalCents = unitPriceCents * safeQuantity;

    if (!productName) return false;

    if (amountInput === saleAmountInput && justNoteProductCheckbox?.checked) {
        justNoteProductCheckbox.checked = false;
        justNoteProductCheckbox.dispatchEvent(new Event('change', { bubbles: true }));
    }

    const nextItems = [
        ...getSaleDraftItems(searchInput),
        {
            productId: String(product.id || ''),
            name: productName,
            quantity: safeQuantity,
            unitPriceCents,
            totalCents: productTotalCents,
            priced: hasProductPrice
        }
    ];
    const nextAmountCents = getSaleItemsTotalCents(nextItems);
    const nextAmount = centsToAmount(nextAmountCents);

    if (nextAmount > 1000000) {
        showToast('O valor da venda nao pode ser maior que R$ 1.000.000,00.', 'error');
        return false;
    }

    searchInput.value = '';
    setSaleDraftItems(searchInput, nextItems);
    if (hasProductPrice) {
        amountInput.value = numberToCurrencyInput(nextAmount);
        amountInput.dataset.autoSaleTotal = 'true';
        amountInput.readOnly = true;
        amountInput.classList.add('input-readonly-total');
        amountInput.classList.add('input-summed');
        setTimeout(() => amountInput.classList.remove('input-summed'), 700);
    }

    searchInput.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
}

function showProductAddedFeedback(item, hasPrice) {
    if (!item) return;

    item.classList.add('product-suggestion-added');
    const feedback = document.createElement('span');
    feedback.className = 'product-added-feedback';
    feedback.textContent = hasPrice ? '✓ Somado' : 'Adicionar valor';
    item.appendChild(feedback);
}

function addSelectedProductWithFeedback(item, searchInput, amountInput, dropdown, listElement, product, quantity) {
    const productPrice = Number(product?.price);
    const hasPrice = Number.isFinite(productPrice) && productPrice > 0;

    const wasAdded = appendSelectedProduct(searchInput, amountInput, product, quantity);
    if (!wasAdded) return;

    renderSaleItemsList(searchInput, listElement, amountInput);
    showProductAddedFeedback(item, hasPrice);

    setTimeout(() => {
        hideProductSuggestions(dropdown);
        searchInput.focus();
    }, 450);
}

function setupProductPicker(searchInput, amountInput, dropdown, listElement) {
    if (!searchInput || !amountInput || !dropdown) return;

    searchInput.addEventListener('input', () => {
        renderProductSuggestions(searchInput, amountInput, dropdown);
    });
    searchInput.addEventListener('focus', () => {
        renderProductSuggestions(searchInput, amountInput, dropdown);
    });

    dropdown.addEventListener('click', (event) => {
        const item = event.target.closest('[data-product-id]');
        if (!item || !dropdown.contains(item)) return;

        const quantityInput = item.querySelector('.product-quantity-input');
        const actionButton = event.target.closest('[data-quantity-action]');
        const product = { ...(savedProducts[item.dataset.productId] || {}), id: item.dataset.productId };

        if (actionButton?.dataset.quantityAction === 'decrease') {
            quantityInput.value = String(Math.max(1, getSafeProductQuantity(quantityInput.value) - 1));
            return;
        }

        if (actionButton?.dataset.quantityAction === 'increase') {
            quantityInput.value = String(Math.min(999, getSafeProductQuantity(quantityInput.value) + 1));
            return;
        }

        if (actionButton?.dataset.quantityAction === 'add') {
            addSelectedProductWithFeedback(item, searchInput, amountInput, dropdown, listElement, product, quantityInput.value);
            return;
        }

        if (!event.target.closest('.product-quantity-controls')) {
            addSelectedProductWithFeedback(item, searchInput, amountInput, dropdown, listElement, product, quantityInput.value);
        }
    });

    listElement?.addEventListener('click', (event) => {
        const removeButton = event.target.closest('[data-remove-sale-item]');
        if (!removeButton) return;
        const index = Number.parseInt(removeButton.dataset.removeSaleItem, 10);
        const items = getSaleDraftItems(searchInput);
        if (!Number.isInteger(index) || index < 0 || index >= items.length) return;
        items.splice(index, 1);
        setSaleDraftItems(searchInput, items);
        renderSaleItemsList(searchInput, listElement, amountInput);
    });

    dropdown.addEventListener('input', (event) => {
        const quantityInput = event.target.closest('.product-quantity-input');
        if (!quantityInput) return;
        quantityInput.value = String(getSafeProductQuantity(quantityInput.value));
    });

    document.addEventListener('click', (event) => {
        if (searchInput.contains(event.target) || dropdown.contains(event.target)) return;
        hideProductSuggestions(dropdown);
    });
}

function setupClientModalProductSearchCompaction() {
    if (!modal || !modalSaleProductSearchInput || !modalSaleProductSuggestions) return;

    const activate = () => setClientModalProductSearchActive(true);
    const activateAndScroll = () => {
        activate();
        scrollModalSaleDescriptionIntoView();
    };
    const deactivateIfUnused = () => {
        setTimeout(() => {
            const activeElement = document.activeElement;
            const isUsingPicker =
                activeElement === modalSaleProductSearchInput ||
                modalSaleProductSuggestions.contains(activeElement);

            if (!isUsingPicker) {
                setClientModalProductSearchActive(false);
            }
        }, 80);
    };

    modalSaleProductSearchInput.addEventListener('focus', activateAndScroll);
    modalSaleProductSearchInput.addEventListener('input', activate);
    modalSaleProductSearchInput.addEventListener('blur', deactivateIfUnused);
    modalSaleProductSuggestions.addEventListener('pointerdown', activate);
    modalSaleProductSuggestions.addEventListener('focusin', activate);
    modalSaleProductSuggestions.addEventListener('focusout', deactivateIfUnused);

    document.addEventListener('click', (event) => {
        if (
            modalSaleProductSearchInput.contains(event.target) ||
            modalSaleProductSuggestions.contains(event.target)
        ) {
            return;
        }

        setClientModalProductSearchActive(false);
    });
}

function formatDate(isoString) {
    const date = new Date(isoString);
    return Number.isNaN(date.getTime()) ? 'Data indisponÃ­vel' : dateTimeFormatter.format(date);
}

function setClientModalScreen(screen) {
    if (!clientScreenPayment || !clientScreenSale || !clientScreenHistory || !clientScreenSettings || !clientScreenTabPayment || !clientScreenTabSale || !clientScreenTabHistory || !clientScreenTabSettings) {
        return;
    }

    const showPayment = screen === 'payment';
    const showSale = screen === 'sale';
    const showHistory = screen === 'history';
    const showSettings = screen === 'settings';

    clientScreenPayment.classList.toggle('active', showPayment);
    clientScreenPayment.hidden = !showPayment;
    clientScreenSale.classList.toggle('active', showSale);
    clientScreenSale.hidden = !showSale;
    clientScreenHistory.classList.toggle('active', showHistory);
    clientScreenHistory.hidden = !showHistory;
    clientScreenSettings.classList.toggle('active', showSettings);
    clientScreenSettings.hidden = !showSettings;

    clientScreenTabPayment.classList.toggle('active', showPayment);
    clientScreenTabPayment.setAttribute('aria-selected', String(showPayment));
    clientScreenTabSale.classList.toggle('active', showSale);
    clientScreenTabSale.setAttribute('aria-selected', String(showSale));
    clientScreenTabHistory.classList.toggle('active', showHistory);
    clientScreenTabHistory.setAttribute('aria-selected', String(showHistory));
    clientScreenTabSettings.classList.toggle('active', showSettings);
    clientScreenTabSettings.setAttribute('aria-selected', String(showSettings));

    if (!showSale) {
        setClientModalProductSearchActive(false);
    }
}

function updateSearchFilterInteractivity() {
    const searchInput = document.getElementById('searchClients');
    const clientsSection = document.getElementById('clientsSection');
    const filterIds = ['filterDebtOnly', 'filterUnpriced', 'filterOverdue', 'filterArchived'];
    const hasSearchTerm = (searchInput?.value || '').trim().length > 0;
    const isSearchFocused = document.activeElement === searchInput;
    const isSearchActive = hasSearchTerm || isSearchFocused;

    clientsSection?.classList.toggle('is-searching', isSearchActive);
    document.body.classList.toggle('client-search-active', isSearchActive);

    filterIds.forEach((id) => {
        const checkbox = document.getElementById(id);
        if (checkbox) {
            checkbox.disabled = hasSearchTerm;
        }
    });
}

function scrollClientSearchIntoView() {
    if (!searchClients) return;

    const isMobileViewport = window.matchMedia('(max-width: 768px)').matches;
    if (!isMobileViewport) return;

    setTimeout(() => {
        searchClients.scrollIntoView({
            behavior: 'smooth',
            block: 'start',
            inline: 'nearest'
        });
    }, 120);
}

function scrollModalSaleDescriptionIntoView() {
    if (!modalSaleProductSearchInput) return;

    const isMobileViewport = window.matchMedia('(max-width: 768px)').matches;
    if (!isMobileViewport) return;

    setTimeout(() => {
        modalSaleProductSearchInput.scrollIntoView({
            behavior: 'smooth',
            block: 'start',
            inline: 'nearest'
        });
    }, 160);
}

function applyExclusiveClientFilter(changedCheckbox) {
    if (!changedCheckbox?.checked) return;

    const filterIds = ['filterDebtOnly', 'filterUnpriced', 'filterOverdue', 'filterArchived'];
    filterIds.forEach((id) => {
        const checkbox = document.getElementById(id);
        if (checkbox && checkbox !== changedCheckbox) {
            checkbox.checked = false;
        }
    });
}

function getClientListModel(client, now = new Date()) {
    const sales = Array.isArray(client.sales) ? client.sales : [];
    let baseDebtCents = 0;
    let salesCount = 0;
    let hasNotes = false;
    let firstSaleDate = null;
    let lastPaymentDate = null;

    for (const item of sales) {
        baseDebtCents += getTransactionDebtDeltaCents(item);

        if (item.type === TRANSACTION_TYPE_SALE) {
            salesCount += 1;
            hasNotes = hasNotes || saleHasUnpricedProducts(item);

            if (!firstSaleDate && item.date) {
                const date = new Date(item.date);
                if (!Number.isNaN(date.getTime())) firstSaleDate = date;
            }
        } else if (item.type === TRANSACTION_TYPE_PAYMENT) {
            if (item.date) {
                const date = new Date(item.date);
                if (!Number.isNaN(date.getTime()) && (!lastPaymentDate || date > lastPaymentDate)) {
                    lastPaymentDate = date;
                }
            }
        }
    }

    let overdueDays = 0;
    let overdueMessage = '';
    if (baseDebtCents > 0) {
        const referenceDate = lastPaymentDate || firstSaleDate;
        overdueDays = referenceDate ? Math.floor((now - referenceDate) / DAY_IN_MS) : 0;

        overdueMessage = buildOverdueMessage({ lastPaymentDate, firstSaleDate, overdueDays });
    }

    const isOverdue = baseDebtCents > 0 && overdueDays >= manager.getOverdueAlertDays();
    const principalDebtCents = Math.max(0, sales.reduce((total, item) => total + getPrincipalDebtDeltaCents(item), 0));
    const interestBaseCents = Math.min(principalDebtCents, baseDebtCents);
    const interestCents = isOverdue && manager.isOverdueInterestEnabled()
        ? Math.round(interestBaseCents * (manager.getOverdueInterestPercent() / 100))
        : 0;
    const debtCents = baseDebtCents + interestCents;

    return {
        client,
        id: client.id,
        name: client.name || '',
        searchName: (client.name || '').toLowerCase(),
        archived: Boolean(client.archived),
        debt: debtCents / 100,
        salesCount,
        hasNotes,
        isOverdue,
        overdueDays,
        overdueMessage,
        interestCents
    };
}

// Atualizar lista de clientes
function updateClientsList() {
    safeLog('Atualizando lista de clientes...', manager.clients);
    const clientRows = Object.values(manager.clients).map((client) => getClientListModel(client));

    // Aplicar filtros se existirem
    const searchClients = document.getElementById('searchClients');
    const filterDebtOnlyCheckbox = document.getElementById('filterDebtOnly');
    const filterUnpricedCheckbox = document.getElementById('filterUnpriced');
    const filterOverdueCheckbox = document.getElementById('filterOverdue');
    const filterArchivedCheckbox = document.getElementById('filterArchived');

    const searchTerm = searchClients?.value.trim().toLowerCase() || '';
    const hasSearchTerm = searchTerm.length > 0;
    const showDebtOnly = filterDebtOnlyCheckbox?.checked || false;
    const showUnpricedOnly = filterUnpricedCheckbox?.checked || false;
    const showOverdueOnly = filterOverdueCheckbox?.checked || false;
    const showArchived = filterArchivedCheckbox?.checked || false;

    let baseRows = [...clientRows];
    let filteredRows = [...clientRows];

    if (hasSearchTerm) {
        // Ao pesquisar por cliente, desconsidera todos os filtros.
        filteredRows = filteredRows.filter(row =>
            row.searchName.includes(searchTerm)
        );
    } else {
        // Define o universo base conforme o filtro de arquivados
        if (showArchived) {
            baseRows = baseRows.filter(row => row.archived);
        } else {
            baseRows = baseRows.filter(row => !row.archived);
        }

        filteredRows = [...baseRows];

        // Apenas um filtro por vez (seleção exclusiva)
        if (showDebtOnly) {
            filteredRows = filteredRows.filter(row =>
                row.debt > 0
            );
        }

        if (showUnpricedOnly) {
            filteredRows = filteredRows.filter(row =>
                row.hasNotes
            );
        }

        if (showOverdueOnly) {
            filteredRows = filteredRows.filter(row =>
                row.isOverdue
            );
        }
    }
    
    // Prioridade antiga: atrasados primeiro (mais dias no topo), depois maior dívida
    filteredRows.sort((a, b) => {
        const aOverdue = a.isOverdue;
        const bOverdue = b.isOverdue;

        if (aOverdue !== bOverdue) {
            return aOverdue ? -1 : 1;
        }

        if (aOverdue && bOverdue) {
            const overdueDaysDiff = b.overdueDays - a.overdueDays;
            if (overdueDaysDiff !== 0) {
                return overdueDaysDiff;
            }
        }

        const debtDiff = b.debt - a.debt;
        if (debtDiff !== 0) {
            return debtDiff;
        }

        return a.name.localeCompare(b.name, 'pt-BR');
    });

    renderClientsList(filteredRows);

    // Atualizar totais
    const totalDebt = clientRows.reduce((total, row) => {
        if (row.archived || row.debt <= 0) return total;
        return total + row.debt;
    }, 0);
    document.getElementById('totalDebt').textContent = formatCurrency(totalDebt);

    // Atualizar aviso de anotações pendentes
    updateUnpricedNotesAlert();

    // Atualizar contador de clientes conforme o modo atual (ativos ou arquivados)
    const clientsCountEl = document.getElementById('clientsCount');
    if (clientsCountEl) {
        const totalClients = baseRows.length;
        const hasActiveFilters = hasSearchTerm || (!hasSearchTerm && (showDebtOnly || showUnpricedOnly || showOverdueOnly));

        if (hasActiveFilters && filteredRows.length !== totalClients) {
            clientsCountEl.textContent = `Mostrando ${filteredRows.length} de ${totalClients} cliente${totalClients !== 1 ? 's' : ''}`;
        } else {
            clientsCountEl.textContent = `${totalClients} cliente${totalClients !== 1 ? 's' : ''}`;
        }
        clientsCountEl.style.display = 'block';
    }
}

// Atualizar aviso de anotações pendentes
function updateUnpricedNotesAlert() {
    if (alertDismissed || !unpricedNotesAlert) return;
    
    const clientsWithNotes = manager.getClientsWithUnpricedNotes();
    
    if (clientsWithNotes.length > 0) {
        const count = clientsWithNotes.length;
        const plural = count > 1;
        unpricedNotesMessage.textContent = `${plural ? 'Você tem' : 'Você tem'} ${count} cliente${plural ? 's' : ''} com anotações de produtos sem preço.`;
        unpricedNotesAlert.style.display = 'flex';
    } else {
        unpricedNotesAlert.style.display = 'none';
    }
}

// Renderizar lista de clientes
function renderClientsList(clientRows) {
    const clientsListDiv = document.getElementById('clientsListDiv');
    
    if (clientRows.length === 0) {
        clientsListDiv.innerHTML = '<p class="empty-message">Nenhum cliente encontrado.</p>';
        return;
    }
    
    clientsListDiv.innerHTML = clientRows.map(row => {
        const client = row.client;
        const debt = row.debt;
        const salesCount = row.salesCount;
        const isPaid = debt === 0;
        const isCredit = debt < 0;
        const displayValue = Math.abs(debt);
        const hasNotes = row.hasNotes;
        const isOverdue = row.isOverdue;
        const interestCents = row.interestCents;
        const interestAmountInfo = interestCents > 0
            ? `<span class="client-interest-value">Juros: R$ ${formatCurrency(interestCents / 100)}</span>`
            : '';

        let statusClass = '';
        let statusIcon = '';
        let noteIndicator = '';
        let overdueIndicator = '';
        
        if (isPaid) {
            statusClass = 'paid';
            statusIcon = '✓';
        } else if (isCredit) {
            statusClass = 'credit';
        }

        if (hasNotes) {
            noteIndicator = '<span class="note-indicator" title="Tem itens não contabilizados">📝</span>';
        }

        if (isOverdue) {
            const interestDetails = interestCents > 0
                ? ` · juros ${formatOverdueInterestPercent(manager.getOverdueInterestPercent())}`
                : '';
            const overdueMsg = row.overdueMessage || 'Nunca realizou pagamento';
            const overdueTitle = interestCents > 0
                ? `${overdueMsg}. Juros: R$ ${formatCurrency(interestCents / 100)} (${formatOverdueInterestPercent(manager.getOverdueInterestPercent())}).`
                : overdueMsg;
            overdueIndicator = `<span class="overdue-indicator" title="${overdueTitle}">⚠️ ${overdueMsg}${interestDetails}</span>`;
        }

        const archivedIndicator = client.archived ? '<span class="archived-badge" title="Cliente arquivado">📦 Arquivado</span>' : '';
        
        return `
            <div class="client-item ${hasNotes ? 'has-notes' : ''} ${client.archived ? 'archived' : ''}" data-client-id="${sanitizeHTML(client.id)}">
                <div class="client-info">
                    <div class="client-name">${sanitizeHTML(client.name)} ${noteIndicator} ${archivedIndicator}</div>
                    ${overdueIndicator ? `<div class="client-overdue-msg">${overdueIndicator}</div>` : ''}
                    <div class="client-sales">${salesCount} venda${salesCount !== 1 ? 's' : ''} fiada${salesCount !== 1 ? 's' : ''}</div>
                </div>
                <div class="client-debt ${statusClass}">
                    <span class="client-debt-total">R$ ${formatCurrency(displayValue)} ${statusIcon}</span>
                    ${interestAmountInfo}
                </div>
            </div>
        `;
    }).join('');

    if (!clientsListDiv.dataset.clickBound) {
        clientsListDiv.dataset.clickBound = 'true';
        clientsListDiv.addEventListener('click', (event) => {
            const item = event.target.closest('.client-item');
            if (!item || !clientsListDiv.contains(item)) return;

            const clientId = item.dataset.clientId;
            const shouldOpenUnpricedEditor = manager.hasUnpricedNotes(clientId);
            openClientModal(clientId, { openUnpricedEditor: shouldOpenUnpricedEditor });
        });
    }
}


// Abrir modal do cliente
// Função para compartilhar histórico do cliente
function shareClientHistory(clientId) {
    const client = manager.clients[clientId];
    if (!client) return;

    const debt = manager.getClientDebt(clientId);
    const isCredit = debt < 0;
    const isPaid = debt === 0;

    // Gerar link para a página do cliente
    const baseUrl = window.location.origin + window.location.pathname.replace('index.html', '');
    const clientUrl = `${baseUrl}client-view.html?u=${encodeURIComponent(manager.userId)}&c=${encodeURIComponent(clientId)}`;

    // Mensagem para compartilhar (educada e breve)
    let message = '';
    if (isPaid) {
        message = `Olá! 😊\n\nSua conta está em dia! Obrigado pela confiança.\n\n🔗 Acompanhe seu histórico:\n${clientUrl}`;
    } else if (isCredit) {
        message = `Olá! 😊\n\nVocê tem um crédito a favor.\n\n🔗 Veja os detalhes:\n${clientUrl}`;
    } else {
        message = `Olá! 😊\nVocê tem um saldo pendente. Quando puder, ficarei grato se conseguir regularizar.\n\n🔗 Veja sua conta detalhada:\n${clientUrl}\n\nObrigado pela compreensão!`;
    }

    // Tentar usar Web Share API
    if (navigator.share) {
        navigator.share({
            title: `Conta - ${client.name}`,
            text: message
        }).then(() => {
            showToast('Link compartilhado com sucesso!', 'success');
        }).catch((error) => {
            if (error.name !== 'AbortError') {
                // Se falhar, copiar para clipboard
                copyToClipboard(message);
            }
        });
    } else {
        // Fallback: copiar para clipboard
        copyToClipboard(message);
    }
}

// Função para copiar texto para clipboard
function copyToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(() => {
            showToast('Histórico copiado para a área de transferência!', 'success');
        }).catch(() => {
            fallbackCopyToClipboard(text);
        });
    } else {
        fallbackCopyToClipboard(text);
    }
}

// Fallback para copiar para clipboard em navegadores antigos
function fallbackCopyToClipboard(text) {
    const textArea = document.createElement('textarea');
    textArea.value = text;
    textArea.style.position = 'fixed';
    textArea.style.left = '-999999px';
    document.body.appendChild(textArea);
    textArea.select();
    
    try {
        document.execCommand('copy');
        showToast('Histórico copiado para a área de transferência!', 'success');
    } catch (err) {
        showToast('Não foi possível copiar o histórico.', 'error');
    }
    
    document.body.removeChild(textArea);
}

function getLatestUnpricedSaleId(client) {
    if (!client || !Array.isArray(client.sales)) return null;

    const unpricedSales = client.sales.filter((sale) => saleHasUnpricedProducts(sale));

    if (unpricedSales.length === 0) return null;

    unpricedSales.sort((a, b) => new Date(b.date) - new Date(a.date));
    return unpricedSales[0].id;
}

function openClientModal(clientId, options = {}) {
    const client = manager.clients[clientId];
    if (!client) return;

    manager.currentClientId = clientId;
    const debt = manager.getClientDebt(clientId);
    const interestCents = manager.getClientInterestCents(clientId);
    const interestNote = interestCents > 0
        ? `<span class="modal-debt-note">Inclui juros de ${formatOverdueInterestPercent(manager.getOverdueInterestPercent())} por atraso</span>`
        : '';
    const isCredit = debt < 0;
    const isPaid = debt === 0;

    // Usar textContent para prevenir XSS
    document.getElementById('modalClientName').textContent = client.name;
    const modalDebtContainer = document.querySelector('.modal-debt');
    
    // Remover classes anteriores
    modalDebtContainer.classList.remove('has-credit', 'is-paid');
    
    if (isPaid) {
        modalDebtContainer.classList.add('is-paid');
        modalDebtContainer.innerHTML = '<strong>R$ <span id="modalDebt">0,00</span></strong>';
    } else if (isCredit) {
        modalDebtContainer.classList.add('has-credit');
        modalDebtContainer.innerHTML = `<strong>R$ <span id="modalDebt">${formatCurrency(Math.abs(debt))}</span></strong>`;
    } else {
        modalDebtContainer.innerHTML = `<strong>R$ <span id="modalDebt">${formatCurrency(debt)}</span></strong>${interestNote}`;
    }
    
    if (editClientNameInput) {
        editClientNameInput.value = client.name;
    }
    if (clientDisplayNameInput) {
        clientDisplayNameInput.value = client.displayClientName || '';
    }

    // Histórico de vendas
    const salesHistory = document.getElementById('salesHistory');
    const sales = client.sales || [];
    if (sales.length === 0) {
        salesHistory.innerHTML = '<p class="empty-message">Nenhuma venda registrada.</p>';
    } else {
        // Ordenar: anotações sem valor primeiro, depois por data (mais recente primeiro)
        const sortedSales = [...sales].sort((a, b) => {
            const aIsNote = saleHasUnpricedProducts(a);
            const bIsNote = saleHasUnpricedProducts(b);
            
            // Anotações sem valor sempre no topo
            if (aIsNote && !bIsNote) return -1;
            if (!aIsNote && bIsNote) return 1;
            
            // Se ambos são anotações ou ambos não são, ordenar por data
            return new Date(b.date) - new Date(a.date);
        });

        salesHistory.innerHTML = sortedSales.map(sale => {
            const isNote = saleHasUnpricedProducts(sale);
            const isPayment = sale.type === TRANSACTION_TYPE_PAYMENT;
            const isInterest = sale.type === TRANSACTION_TYPE_INTEREST;
            const saleAmount = getSaleAmount(sale);
            let saleTypeLabel = '';
            let saleAmountText = '';
            
            if (isPayment) {
                saleTypeLabel = '✓ Pagamento:';
                saleAmountText = `R$ ${formatCurrency(saleAmount)}`;
            } else if (isInterest) {
                saleTypeLabel = 'Juros:';
                saleAmountText = `R$ ${formatCurrency(saleAmount)}`;
            } else if (sale.isNote || getSaleAmountCents(sale) === 0) {
                saleTypeLabel = '📝 Anotação:';
                saleAmountText = '<span class="note-badge">Sem valor</span>';
            } else if (isNote) {
                saleTypeLabel = 'Venda:';
                saleAmountText = `R$ ${formatCurrency(saleAmount)} <span class="note-badge">Produto sem preco</span>`;
            } else {
                saleTypeLabel = 'Venda:';
                saleAmountText = `R$ ${formatCurrency(saleAmount)}`;
            }
            
            return `
            <div class="sale-item ${isPayment ? 'payment-item' : ''} ${isInterest ? 'interest-item' : ''} ${isNote ? 'note-item' : ''}">
                <div class="sale-info">
                    <div class="sale-date">${formatDate(sale.date)}${sale.editedAt ? ' <span class="edited-badge">(editado)</span>' : ''}</div>
                    <div class="sale-amount">
                        ${saleTypeLabel} ${saleAmountText}
                    </div>
                    ${formatSaleItems(sale.items)}
                    ${sale.description ? `<div class="sale-description">${formatDescription(sale.description)}</div>` : ''}
                </div>
                <div class="sale-actions">
                    <button class="btn-icon btn-edit-sale" data-sale-id="${sale.id}" title="Editar" aria-label="Editar item">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                        </svg>
                    </button>
                    <button class="btn-icon btn-delete-sale" data-sale-id="${sale.id}" title="Excluir" aria-label="Excluir item">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                            <polyline points="3 6 5 6 21 6"/>
                            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                        </svg>
                    </button>
                </div>
            </div>
        `;
        }).join('');
        
        // Adicionar event listeners para botões de editar e excluir
        if (!salesHistory.dataset.actionsBound) {
            salesHistory.dataset.actionsBound = 'true';
            salesHistory.addEventListener('click', async (event) => {
                const editButton = event.target.closest('.btn-edit-sale');
                if (editButton && salesHistory.contains(editButton)) {
                    event.stopPropagation();
                    openEditSaleModal(editButton.dataset.saleId);
                    return;
                }

                const deleteButton = event.target.closest('.btn-delete-sale');
                if (deleteButton && salesHistory.contains(deleteButton)) {
                    event.stopPropagation();
                    await deleteSaleItem(deleteButton.dataset.saleId);
                }
            });
        }
    }
    
    // Atualizar texto do botão de arquivar baseado no estado
    if (archiveClientBtn) {
        if (client.archived) {
            archiveClientBtn.innerHTML = '📂 Desarquivar Cliente';
            archiveClientBtn.classList.remove('btn-secondary');
            archiveClientBtn.classList.add('btn-success');
        } else {
            archiveClientBtn.innerHTML = '📦 Arquivar Cliente';
            archiveClientBtn.classList.remove('btn-success');
            archiveClientBtn.classList.add('btn-secondary');
        }
    }

    setClientModalScreen('sale');
    setClientModalProductSearchActive(false);

    modal.style.display = 'block';
    document.body.classList.add('modal-open');
    document.body.dataset.scrollY = window.scrollY;
    document.body.style.top = `-${window.scrollY}px`;
    
    // Focus trap: focar no primeiro elemento interativo do modal
    const firstFocusable = modal.querySelector('button, input, textarea, select, [tabindex]:not([tabindex="-1"])');
    if (firstFocusable) firstFocusable.focus();

    if (options.openUnpricedEditor) {
        const saleId = getLatestUnpricedSaleId(client);
        if (saleId) {
            setClientModalScreen('history');
            openEditSaleModal(saleId);
        }
    }
}

// Fechar modal
function closeClientModal() {
    modal.style.display = 'none';
    setClientModalProductSearchActive(false);
    document.body.classList.remove('modal-open');
    const scrollY = document.body.dataset.scrollY || '0';
    document.body.style.top = '';
    window.scrollTo(0, parseInt(scrollY));
    manager.currentClientId = null;
    paymentForm.reset();
    if (modalAddSaleForm) {
        modalAddSaleForm.reset();
    }
    if (editNameForm) {
        editNameForm.style.display = 'none';
        editNameForm.reset();
    }
    setClientModalScreen('sale');
    const nameSection = document.querySelector('.client-name-section');
    if (nameSection) {
        nameSection.style.display = 'flex';
    }
}

// Abrir modal de edição de venda
function openEditSaleModal(saleId) {
    if (!manager.currentClientId) return;
    
    const client = manager.clients[manager.currentClientId];
    if (!client || !client.sales) return;
    
    const sale = client.sales.find(s => s.id === saleId);
    if (!sale) return;
    
    currentEditingSaleId = saleId;
    editSaleAmount.value = numberToCurrencyInput(getSaleAmount(sale));
    editSaleType.textContent = sale.type === TRANSACTION_TYPE_PAYMENT
        ? 'Pagamento'
        : sale.type === TRANSACTION_TYPE_INTEREST
            ? 'Juros'
            : 'Venda';
    
    if (sale.type === TRANSACTION_TYPE_SALE) {
        editSaleDescription.value = sale.description || '';
        editSaleDescription.parentElement.style.display = 'block';
    } else {
        editSaleDescription.value = '';
        editSaleDescription.parentElement.style.display = 'none';
    }
    
    if (editSaleModal) {
        editSaleModal.style.display = 'block';
        document.body.classList.add('modal-open');
    }
}

// Fechar modal de edição de venda
function closeEditSaleModalFunc() {
    if (editSaleModal) {
        editSaleModal.style.display = 'none';
    }
    // Restore body scroll only if client modal is also closed
    if (modal.style.display === 'none') {
        document.body.classList.remove('modal-open');
        const scrollY = document.body.dataset.scrollY || '0';
        document.body.style.top = '';
        window.scrollTo(0, parseInt(scrollY));
    }
    currentEditingSaleId = null;
    if (editSaleForm) {
        editSaleForm.reset();
    }
}

// Deletar item do histórico
async function deleteSaleItem(saleId) {
    if (!manager.currentClientId) return;
    
    const client = manager.clients[manager.currentClientId];
    if (!client || !client.sales) return;
    
    const sale = client.sales.find(s => s.id === saleId);
    if (!sale) return;
    
    const type = sale.type === TRANSACTION_TYPE_PAYMENT
        ? 'pagamento'
        : sale.type === TRANSACTION_TYPE_INTEREST
            ? 'juros'
            : 'venda';
    const confirmed = await showConfirm(
        'Excluir Item',
        `Tem certeza que deseja excluir este ${type} de R$ ${formatCurrency(getSaleAmount(sale))}?`
    );
    
    if (!confirmed) return;
    
    showLoader('Excluindo...');
    try {
        await manager.deleteSaleItem(manager.currentClientId, saleId);
        hideLoader();
        showToast('Item excluído com sucesso!', 'success');
        openClientModal(manager.currentClientId);
        updateClientsList();
    } catch (error) {
        hideLoader();
        console.error('Erro ao excluir item:', error);
        showToast(getDatabaseErrorMessage(error, 'Erro ao excluir item. Tente novamente.'), 'error');
    }
}

// Auth State Observer
onAuthStateChanged(auth, (user) => {
    if (user) {
        currentUser = user;
        manager.setUser(user.uid);
        subscribeProducts(user.uid);
        if (loginScreen) loginScreen.style.display = 'none';
        if (appScreen) appScreen.style.display = 'block';
        if (userEmailSpan) userEmailSpan.textContent = user.email || '';
        // Set user avatar initial
        const avatarEl = document.getElementById('userAvatar');
        if (avatarEl && user.email) {
            avatarEl.textContent = user.email.charAt(0).toUpperCase();
        }
    } else {
        currentUser = null;
        subscribeProducts(null);
        // Limpar listeners ao fazer logout
        manager.cleanup();
        manager.dataLoaded = false;
        if (loginScreen) loginScreen.style.display = 'flex';
        if (appScreen) appScreen.style.display = 'none';
        // Sem usuário logado, esconder loading e mostrar login
        hideLoadingScreen();
    }
});

// Login com Email
if (loginForm) {
    loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const email = document.getElementById('loginEmail').value;
        const password = document.getElementById('loginPassword').value;
        
        showLoader('Entrando...');
        try {
            await signInWithEmailAndPassword(auth, email, password);
            hideLoader();
        } catch (error) {
            hideLoader();
            if (IS_DEV) console.error('Erro no login:', error);
            let message = 'Erro ao fazer login.';
            if (error.code === 'auth/user-not-found' || error.code === 'auth/wrong-password') {
                message = 'Email ou senha incorretos.';
            } else if (error.code === 'auth/invalid-email') {
                message = 'Email inválido.';
            } else if (error.code === 'auth/too-many-requests') {
                message = 'Muitas tentativas. Aguarde e tente novamente.';
            } else if (error.code === 'auth/network-request-failed') {
                message = 'Sem conexão. Verifique sua internet.';
            }
            showToast(message, 'error');
        }
    });
}

// Logout
if (logoutBtn) {
    logoutBtn.addEventListener('click', async () => {
        try {
            await signOut(auth);
            showToast('Você saiu da conta.', 'success');
        } catch (error) {
            if (IS_DEV) console.error('Erro no logout:', error);
            showToast('Erro ao sair.', 'error');
        }
    });
}



// Event Listeners - App
// Fechar aviso de anotações pendentes
if (closeAlertBtn) {
    closeAlertBtn.addEventListener('click', (e) => {
        e.stopPropagation(); // Evita que o clique no botão fechar acione o alerta
        alertDismissed = true;
        if (unpricedNotesAlert) {
            unpricedNotesAlert.style.display = 'none';
        }
    });
}

// Clicar no alerta para ativar filtro de produtos sem preço
if (unpricedNotesAlert) {
    unpricedNotesAlert.addEventListener('click', (e) => {
        // Ignorar se clicou no botão de fechar
        if (e.target.id === 'closeAlert' || e.target.closest('#closeAlert')) {
            return;
        }
        
        // Ativar o filtro de produtos sem preço
        const filterUnpricedCheckbox = document.getElementById('filterUnpriced');
        if (filterUnpricedCheckbox) {
            filterUnpricedCheckbox.checked = true;
            
            // Disparar evento de change para aplicar o filtro
            filterUnpricedCheckbox.dispatchEvent(new Event('change'));
            
            // Scroll suave até a lista de clientes
            const clientsSection = document.querySelector('#clientsListDiv');
            if (clientsSection) {
                clientsSection.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }
            
            showToast('Mostrando apenas clientes com produtos sem preço', 'success');
        }
    });
}

// Checkbox "apenas anotar produto" - desabilitar campo de valor
if (justNoteProductCheckbox && saleAmountInput && saleDescriptionInput) {
    justNoteProductCheckbox.addEventListener('change', (e) => {
        if (e.target.checked) {
            saleAmountInput.disabled = true;
            saleAmountInput.required = false;
            saleAmountInput.value = '';
            saleDescriptionInput.placeholder = 'Observação da venda (opcional)';
            saleDescriptionInput.required = true;
        } else {
            saleAmountInput.disabled = false;
            saleAmountInput.required = true;
            saleDescriptionInput.placeholder = 'Observação da venda (opcional)';
            saleDescriptionInput.required = false;
        }
    });
}

// Busca de clientes na lista
if (searchClients) {
    const filterDebtOnlyCheckbox = document.getElementById('filterDebtOnly');
    const filterArchivedCheckbox = document.getElementById('filterArchived');
    const filterUnpricedCheckbox = document.getElementById('filterUnpriced');
    const filterOverdueCheckbox = document.getElementById('filterOverdue');

    const debouncedUpdateClientsList = debounce(updateClientsList, 250);

    searchClients.addEventListener('input', () => {
        updateSearchFilterInteractivity();
        debouncedUpdateClientsList();
    });

    searchClients.addEventListener('focus', () => {
        updateSearchFilterInteractivity();
        scrollClientSearchIntoView();
    });
    searchClients.addEventListener('blur', () => {
        setTimeout(updateSearchFilterInteractivity, 80);
    });
    
    if (filterDebtOnlyCheckbox) {
        filterDebtOnlyCheckbox.addEventListener('change', (e) => {
            applyExclusiveClientFilter(e.target);
            updateClientsList();
        });
    }
    
    if (filterUnpricedCheckbox) {
        filterUnpricedCheckbox.addEventListener('change', (e) => {
            applyExclusiveClientFilter(e.target);
            updateClientsList();
        });
    }
    
    if (filterOverdueCheckbox) {
        filterOverdueCheckbox.addEventListener('change', (e) => {
            applyExclusiveClientFilter(e.target);
            updateClientsList();
        });
    }
    
    if (filterArchivedCheckbox) {
        filterArchivedCheckbox.addEventListener('change', (e) => {
            applyExclusiveClientFilter(e.target);
            updateClientsList();
        });
    }

    updateSearchFilterInteractivity();
}

let selectedClientId = null;

// Busca de clientes com autocomplete
if (clientSearch) {
    clientSearch.addEventListener('input', debounce((e) => {
        const searchTerm = e.target.value.trim().toLowerCase();
        selectedClientId = null;
        
        if (searchTerm.length === 0) {
            clientSuggestions.classList.remove('show');
            return;
        }
        
        const clients = Object.values(manager.clients);
        const matches = clients.filter(client => 
            client.name.toLowerCase().includes(searchTerm)
        );
        
        if (matches.length === 0) {
            // Nenhum cliente encontrado - sugerir criar novo
            clientSuggestions.innerHTML = `
                <div class="suggestion-item new-client" data-action="new">
                    <div>➕ Criar novo cliente: "${sanitizeHTML(e.target.value.trim())}"</div>
                </div>
            `;
        } else {
            // Mostrar clientes encontrados
            clientSuggestions.innerHTML = matches
                .sort((a, b) => a.name.localeCompare(b.name))
                .map(client => {
                    const debt = manager.getClientDebt(client.id);
                    const debtText = debt > 0
                        ? `R$ ${formatCurrency(debt)}`
                        : debt < 0
                            ? `R$ -${formatCurrency(Math.abs(debt))}`
                            : 'R$ 0,00';
                    return `
                        <div class="suggestion-item" data-client-id="${client.id}">
                            <div>${sanitizeHTML(client.name)}</div>
                            <div class="client-debt-preview ${debt > 0 ? 'has-debt' : ''}">${debtText}</div>
                        </div>
                    `;
                }).join('') + `
                <div class="suggestion-item new-client" data-action="new">
                    <div>➕ Criar novo cliente: "${sanitizeHTML(e.target.value.trim())}"</div>
                </div>
            `;
        }
        
        clientSuggestions.classList.add('show');
        
        // Event listeners para sugestões
        document.querySelectorAll('.suggestion-item').forEach(item => {
            item.addEventListener('click', () => {
                if (item.dataset.action === 'new') {
                    selectedClientId = '__new__';
                    clientSearch.value = e.target.value.trim();
                } else {
                    selectedClientId = item.dataset.clientId;
                    const client = manager.clients[selectedClientId];
                    clientSearch.value = client.name;
                }
                clientSuggestions.classList.remove('show');
            });
        });
    }, 200));
    
    // Fechar sugestões ao clicar fora
    document.addEventListener('click', (e) => {
        if (!clientSearch.contains(e.target) && !clientSuggestions.contains(e.target)) {
            clientSuggestions.classList.remove('show');
        }
    });
}

// Registrar venda
addSaleForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const clientName = clientSearch.value.trim();
    const amount = document.getElementById('saleAmount').value;
    const description = document.getElementById('saleDescription').value.trim();
    const hasAmount = (amount || '').trim() !== '';
    const saleItems = getSaleDraftItems(saleProductSearchInput);
    const isJustNote = (justNoteProductCheckbox?.checked || false) || !hasAmount;
    
    // Validar nome do cliente
    if (!clientName) {
        showToast('Por favor, digite o nome do cliente.', 'error');
        clientSearch.focus();
        return;
    }
    
    if (clientName.length < 2) {
        showToast('O nome do cliente deve ter pelo menos 2 caracteres.', 'error');
        clientSearch.focus();
        return;
    }
    
    if (clientName.length > 100) {
        showToast('O nome do cliente não pode ter mais de 100 caracteres.', 'error');
        clientSearch.focus();
        return;
    }
    
    let numericAmount = 0;
    
    // Se for apenas anotação, valor é 0 e descrição obrigatória
    if (isJustNote) {
        numericAmount = 0;
        if (!description && saleItems.length === 0) {
            showToast('Adicione um produto ou informe uma observação.', 'error');
            (saleProductSearchInput || document.getElementById('saleDescription')).focus();
            return;
        }
    } else {
        // Validar valor da venda
        numericAmount = parseCurrency(amount);
        if (isNaN(numericAmount)) {
            showToast('O valor da venda deve ser um número válido.', 'error');
            document.getElementById('saleAmount').focus();
            return;
        }
        
        if (numericAmount <= 0) {
            showToast('O valor da venda deve ser maior que zero.', 'error');
            document.getElementById('saleAmount').focus();
            return;
        }
        
        if (numericAmount > 1000000) {
            showToast('O valor da venda não pode ser maior que R$ 1.000.000,00.', 'error');
            document.getElementById('saleAmount').focus();
            return;
        }
    }

    const saleItemsTotalCents = getSaleItemsTotalCents(saleItems);
    if (!isJustNote && saleItemsTotalCents > 0) {
        numericAmount = centsToAmount(saleItemsTotalCents);
        document.getElementById('saleAmount').value = numberToCurrencyInput(numericAmount);
    }

    if (!beginFormSubmission(addSaleForm)) return;
    showLoader('Salvando...');
    try {
        let clientId;
        
        if (selectedClientId === '__new__' || !selectedClientId) {
            // Verificar se já existe cliente com esse nome
            const existingClient = Object.values(manager.clients).find(
                c => c.name.toLowerCase() === clientName.toLowerCase()
            );
            
            if (existingClient) {
                clientId = existingClient.id;
            } else {
                // Criar novo cliente
                clientId = await manager.addClient(clientName);
            }
        } else {
            // Cliente selecionado da lista
            clientId = selectedClientId;
        }
        
        // Adicionar venda
        await manager.addSale(clientId, numericAmount, description, saleItems);
        hideLoader();
        showToast('Venda registrada com sucesso!', 'success');
        addSaleForm.reset();
        clearSaleDraftItems(saleProductSearchInput, saleItemsList, saleAmountInput);
        clearFormAutosaveState(addSaleForm);
        hideProductSuggestions(saleProductSuggestions);
        clearSaleDescriptionDraft();
        selectedClientId = null;
        clientSuggestions.classList.remove('show');
    } catch (error) {
        hideLoader();
        finishFormSubmission(addSaleForm);
        if (IS_DEV) console.error('Erro ao registrar venda:', error);
        showToast(getDatabaseErrorMessage(error, 'Erro ao registrar venda. Tente novamente.'), 'error');
    }
});

paymentForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const amount = document.getElementById('paymentAmount').value;
    
    // Validar se há cliente selecionado
    if (!manager.currentClientId) {
        showToast('Nenhum cliente selecionado.', 'error');
        return;
    }
    
    // Validar valor do pagamento
    if (!amount || amount.trim() === '') {
        showToast('Por favor, digite o valor do pagamento.', 'error');
        document.getElementById('paymentAmount').focus();
        return;
    }
    
    const numericAmount = parseCurrency(amount);
    if (isNaN(numericAmount)) {
        showToast('O valor do pagamento deve ser um número válido.', 'error');
        document.getElementById('paymentAmount').focus();
        return;
    }
    
    if (numericAmount <= 0) {
        showToast('O valor do pagamento deve ser maior que zero.', 'error');
        document.getElementById('paymentAmount').focus();
        return;
    }
    
    if (numericAmount > 1000000) {
        showToast('O valor do pagamento não pode ser maior que R$ 1.000.000,00.', 'error');
        document.getElementById('paymentAmount').focus();
        return;
    }
    
    if (!beginFormSubmission(paymentForm)) return;
    showLoader('Salvando...');
    try {
        const paymentResult = await manager.addPayment(manager.currentClientId, numericAmount);
        hideLoader();
        const successMessage = paymentResult?.interestCents > 0
            ? `Pagamento registrado. Juros lançados: R$ ${formatCurrency(centsToAmount(paymentResult.interestCents))}.`
            : 'Pagamento registrado com sucesso!';
        showToast(successMessage, 'success');
        paymentForm.reset();
        clearFormAutosaveState(paymentForm);
        openClientModal(manager.currentClientId); // Reabrir para atualizar
    } catch (error) {
        hideLoader();
        finishFormSubmission(paymentForm);
        console.error('Erro ao registrar pagamento:', error);
        showToast(getDatabaseErrorMessage(error, 'Erro ao registrar pagamento. Tente novamente.'), 'error');
    }
});

deleteClientBtn.addEventListener('click', async () => {
    if (manager.currentClientId) {
        const client = manager.clients[manager.currentClientId];
        const confirmed = await showConfirm(
            'Excluir Cliente',
            `Tem certeza que deseja excluir ${client.name}? Todos os dados serão perdidos permanentemente.`
        );
        
        if (confirmed) {
            showLoader('Excluindo...');
            try {
                await manager.deleteClient(manager.currentClientId);
                hideLoader();
                showToast('Cliente excluído com sucesso!', 'success');
                closeClientModal();
            } catch (error) {
                hideLoader();
                console.error('Erro ao excluir cliente:', error);
                showToast(getDatabaseErrorMessage(error, 'Erro ao excluir cliente. Tente novamente.'), 'error');
            }
        }
    }
});

// Arquivar/Desarquivar cliente
if (archiveClientBtn) {
    archiveClientBtn.addEventListener('click', async () => {
        if (manager.currentClientId) {
            const client = manager.clients[manager.currentClientId];
            const isArchived = client.archived || false;
            const action = isArchived ? 'desarquivar' : 'arquivar';
            const actionTitle = isArchived ? 'Desarquivar Cliente' : 'Arquivar Cliente';
            
            const confirmed = await showConfirm(
                actionTitle,
                isArchived 
                    ? `Tem certeza que deseja desarquivar ${client.name}? O cliente voltará a aparecer na lista principal e suas dívidas serão contabilizadas no balanço geral.`
                    : `Tem certeza que deseja arquivar ${client.name}? O cliente será ocultado da lista principal e suas dívidas não serão contabilizadas no balanço geral.`
            );
            
            if (confirmed) {
                showLoader(isArchived ? 'Desarquivando...' : 'Arquivando...');
                try {
                    if (isArchived) {
                        await manager.unarchiveClient(manager.currentClientId);
                        showToast('Cliente desarquivado com sucesso!', 'success');
                    } else {
                        await manager.archiveClient(manager.currentClientId);
                        showToast('Cliente arquivado com sucesso!', 'success');
                    }
                    hideLoader();
                    closeClientModal();
                } catch (error) {
                    hideLoader();
                    console.error(`Erro ao ${action} cliente:`, error);
                    showToast(getDatabaseErrorMessage(error, `Erro ao ${action} cliente. Tente novamente.`), 'error');
                }
            }
        }
    });
}

// Compartilhar histórico do cliente
if (shareHistoryBtn) {
    shareHistoryBtn.addEventListener('click', () => {
        if (manager.currentClientId) {
            shareClientHistory(manager.currentClientId);
        } else {
            showToast('Nenhum cliente selecionado.', 'error');
        }
    });
}

if (clientScreenTabPayment) {
    clientScreenTabPayment.addEventListener('click', () => {
        setClientModalScreen('payment');
    });
}

if (clientScreenTabSale) {
    clientScreenTabSale.addEventListener('click', () => {
        setClientModalScreen('sale');
    });
}

if (clientScreenTabHistory) {
    clientScreenTabHistory.addEventListener('click', () => {
        setClientModalScreen('history');
    });
}

if (clientScreenTabSettings) {
    clientScreenTabSettings.addEventListener('click', () => {
        setClientModalScreen('settings');
    });
}

// Limpar histórico do cliente
if (clearHistoryBtn) {
    clearHistoryBtn.addEventListener('click', async () => {
        if (manager.currentClientId) {
            const client = manager.clients[manager.currentClientId];
            const confirmed = await showConfirm(
                'Limpar Histórico',
                `Tem certeza que deseja limpar todo o histórico de ${client.name}? Todas as vendas e pagamentos serão removidos permanentemente.`
            );
            
            if (confirmed) {
                showLoader('Limpando...');
                try {
                    await manager.clearClientHistory(manager.currentClientId);
                    hideLoader();
                    showToast('Histórico limpo com sucesso!', 'success');
                    openClientModal(manager.currentClientId); // Reabrir para atualizar
                    updateClientsList();
                } catch (error) {
                    hideLoader();
                    console.error('Erro ao limpar histórico:', error);
                    showToast(getDatabaseErrorMessage(error, 'Erro ao limpar histórico. Tente novamente.'), 'error');
                }
            }
        }
    });
}

// Salvar nome de exibição do cliente para client-view
if (clientDisplayNameForm) {
    clientDisplayNameForm.addEventListener('submit', async (e) => {
        e.preventDefault();

        if (!manager.currentClientId) {
            showToast('Nenhum cliente selecionado.', 'error');
            return;
        }

        const displayName = (clientDisplayNameInput?.value || '').trim();

        showLoader('Salvando configuração...');
        try {
            await manager.updateClientDisplayName(manager.currentClientId, displayName);
            hideLoader();
            showToast(displayName ? 'Nome para exibição salvo com sucesso!' : 'Nome para exibição removido.', 'success');
            openClientModal(manager.currentClientId);
        } catch (error) {
            hideLoader();
            console.error('Erro ao salvar nome para exibição:', error);
            showToast(getDatabaseErrorMessage(error, error.message || 'Erro ao salvar nome para exibição.'), 'error');
        }
    });
}

// Adicionar venda no modal do cliente
if (modalAddSaleForm) {
    modalAddSaleForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const amount = modalSaleAmountInput?.value;
        const description = (modalSaleDescriptionInput?.value || '').trim();
        const hasAmount = (amount || '').trim() !== '';
        const saleItems = getSaleDraftItems(modalSaleProductSearchInput);
        const isJustNote = !hasAmount;
        
        // Validar se há cliente selecionado
        if (!manager.currentClientId) {
            showToast('Nenhum cliente selecionado.', 'error');
            return;
        }
        
        let numericAmount = 0;
        
        // Se for apenas anotação, valor é 0 e descrição obrigatória
        if (isJustNote) {
            numericAmount = 0;
            if (!description && saleItems.length === 0) {
                showToast('Adicione um produto ou informe uma observação.', 'error');
                (modalSaleProductSearchInput || modalSaleDescriptionInput).focus();
                return;
            }
        } else {
            // Validar valor da venda
            // Converter para número
            numericAmount = parseCurrency(amount);
            
            if (isNaN(numericAmount) || numericAmount <= 0) {
                showToast('Por favor, digite um valor válido maior que zero.', 'error');
                modalSaleAmountInput.focus();
                return;
            }

            if (numericAmount > 1000000) {
                showToast('O valor da venda não pode ser maior que R$ 1.000.000,00.', 'error');
                modalSaleAmountInput.focus();
                return;
            }
        }

        const saleItemsTotalCents = getSaleItemsTotalCents(saleItems);
        if (!isJustNote && saleItemsTotalCents > 0) {
            numericAmount = centsToAmount(saleItemsTotalCents);
            modalSaleAmountInput.value = numberToCurrencyInput(numericAmount);
        }

        if (!beginFormSubmission(modalAddSaleForm)) return;
        showLoader('Salvando...');
        try {
            await manager.addSale(manager.currentClientId, numericAmount, description, saleItems);
            hideLoader();
            showToast('Venda registrada com sucesso!', 'success');
            modalAddSaleForm.reset();
            clearSaleDraftItems(modalSaleProductSearchInput, modalSaleItemsList, modalSaleAmountInput);
            clearFormAutosaveState(modalAddSaleForm);
            hideProductSuggestions(modalSaleProductSuggestions);
            setClientModalProductSearchActive(false);
            openClientModal(manager.currentClientId); // Reabrir para atualizar
            updateClientsList();
        } catch (error) {
            hideLoader();
            finishFormSubmission(modalAddSaleForm);
            console.error('Erro ao registrar venda:', error);
            showToast(getDatabaseErrorMessage(error, 'Erro ao registrar venda. Tente novamente.'), 'error');
        }
    });
}

// Editar nome do cliente - mostrar formulário
if (editNameBtn) {
    editNameBtn.addEventListener('click', () => {
        const currentName = document.getElementById('modalClientName').textContent;
        editClientNameInput.value = currentName;
        document.querySelector('.client-name-section').style.display = 'none';
        editNameForm.style.display = 'block';
        editClientNameInput.focus();
    });
}

// Cancelar edição de nome
if (cancelEditNameBtn) {
    cancelEditNameBtn.addEventListener('click', () => {
        editNameForm.style.display = 'none';
        document.querySelector('.client-name-section').style.display = 'flex';
        editNameForm.reset();
    });
}

// Editar nome do cliente - submeter formulário
if (editNameForm) {
    editNameForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const newName = (editClientNameInput?.value || '').trim();
        
        // Validar se há cliente selecionado
        if (!manager.currentClientId) {
            showToast('Nenhum cliente selecionado.', 'error');
            return;
        }
        
        // Validar nome
        if (!newName) {
            showToast('Por favor, digite o nome do cliente.', 'error');
            editClientNameInput.focus();
            return;
        }
        
        if (newName.length < 2) {
            showToast('O nome do cliente deve ter pelo menos 2 caracteres.', 'error');
            editClientNameInput.focus();
            return;
        }
        
        if (newName.length > 100) {
            showToast('O nome do cliente não pode ter mais de 100 caracteres.', 'error');
            editClientNameInput.focus();
            return;
        }
        
        // Verificar se o nome é diferente do atual
        const currentName = manager.clients[manager.currentClientId]?.name;
        if (newName === currentName) {
            showToast('O novo nome é igual ao nome atual.', 'error');
            editClientNameInput.focus();
            return;
        }
        
        // Verificar se já existe outro cliente com esse nome
        const existingClient = Object.values(manager.clients).find(
            c => c.id !== manager.currentClientId && c.name.toLowerCase() === newName.toLowerCase()
        );
        if (existingClient) {
            showToast('Já existe um cliente com este nome.', 'error');
            editClientNameInput.focus();
            return;
        }
        
        showLoader('Salvando...');
        try {
            await manager.updateClientName(manager.currentClientId, newName);
            hideLoader();
            showToast('Nome atualizado com sucesso!', 'success');
            // Ocultar formulário e mostrar nome atualizado
            editNameForm.style.display = 'none';
            document.querySelector('.client-name-section').style.display = 'flex';
            openClientModal(manager.currentClientId);
            updateClientsList();
        } catch (error) {
            hideLoader();
            console.error('Erro ao atualizar nome:', error);
            showToast(getDatabaseErrorMessage(error, 'Erro ao atualizar nome. Tente novamente.'), 'error');
        }
    });
}

// Event listeners para modal de edição de venda
if (closeEditSaleModal) {
    closeEditSaleModal.addEventListener('click', closeEditSaleModalFunc);
}

if (cancelEditSale) {
    cancelEditSale.addEventListener('click', closeEditSaleModalFunc);
}

if (editSaleForm) {
    editSaleForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        
        if (!manager.currentClientId || !currentEditingSaleId) {
            showToast('Erro ao editar item.', 'error');
            return;
        }
        
        const amount = editSaleAmount.value;
        const description = editSaleDescription.value.trim();
        
        // Validar valor
        if (!amount || amount.trim() === '') {
            showToast('Por favor, digite o valor.', 'error');
            editSaleAmount.focus();
            return;
        }
        
        const numericAmount = parseCurrency(amount);
        if (isNaN(numericAmount)) {
            showToast('O valor deve ser um número válido.', 'error');
            editSaleAmount.focus();
            return;
        }
        
        if (numericAmount <= 0) {
            showToast('O valor deve ser maior que zero.', 'error');
            editSaleAmount.focus();
            return;
        }
        
        if (numericAmount > 1000000) {
            showToast('O valor não pode ser maior que R$ 1.000.000,00.', 'error');
            editSaleAmount.focus();
            return;
        }
        showLoader('Salvando...');
        try {
            await manager.updateSaleItem(manager.currentClientId, currentEditingSaleId, numericAmount, description);
            hideLoader();
            showToast('Item atualizado com sucesso!', 'success');
            closeEditSaleModalFunc();
            openClientModal(manager.currentClientId);
            updateClientsList();
        } catch (error) {
            hideLoader();
            console.error('Erro ao atualizar item:', error);
            showToast(getDatabaseErrorMessage(error, error.message || 'Erro ao atualizar item. Tente novamente.'), 'error');
        }
    });
}

// Fechar modal de edição ao clicar fora
if (editSaleModal) {
    window.addEventListener('click', (e) => {
        if (e.target === editSaleModal) {
            closeEditSaleModalFunc();
        }
    });
}

closeModal.addEventListener('click', async () => {
    const saved = await savePendingClientModalFormsOnClose();
    if (saved) closeClientModal();
});

window.addEventListener('click', (e) => {
    if (e.target === modal) {
        closeClientModal();
    }
});

// Verificar periodicamente por atualizações (a cada 5 minutos)
setInterval(() => {
    fetch(window.location.href, { 
        method: 'HEAD',
        cache: 'no-cache'
    }).then(response => {
        const lastModified = response.headers.get('Last-Modified');
        const storedLastModified = sessionStorage.getItem('pageLastModified');
        
        if (storedLastModified && lastModified && storedLastModified !== lastModified) {
            // Nova versão detectada
            const shouldReload = confirm(
                'Uma nova versão do aplicativo está disponível. Deseja atualizar agora?\n\n' +
                'Recomendamos atualizar para obter as últimas correções e melhorias.'
            );
            
            if (shouldReload) {
                // Limpar cache e recarregar
                if ('caches' in window) {
                    caches.keys().then(names => {
                        names.forEach(name => caches.delete(name));
                    }).finally(() => {
                        window.location.reload(true);
                    });
                } else {
                    window.location.reload(true);
                }
            }
        }
        
        if (lastModified) {
            sessionStorage.setItem('pageLastModified', lastModified);
        }
    }).catch(() => {
        // Ignorar erros de rede silenciosamente
    });
}, 5 * 60 * 1000); // 5 minutos

// Armazenar timestamp inicial
fetch(window.location.href, { method: 'HEAD', cache: 'no-cache' })
    .then(response => {
        const lastModified = response.headers.get('Last-Modified');
        if (lastModified) {
            sessionStorage.setItem('pageLastModified', lastModified);
        }
    })
    .catch(() => {});

// Função para esconder loading screen
function hideLoadingScreen() {
    const loadingScreen = document.getElementById('loadingScreen');
    if (loadingScreen) {
        loadingScreen.classList.add('hidden');
        document.body.classList.remove('loading');
        document.body.classList.add('loaded');
        setTimeout(() => {
            loadingScreen.style.display = 'none';
        }, 500);
    }
}

// Fallback: esconder loading após 10 segundos se ainda estiver visível
// (protege contra falhas de rede ou Firebase travado)
setTimeout(() => {
    if (document.getElementById('loadingScreen') && !document.getElementById('loadingScreen').classList.contains('hidden')) {
        console.log('Loading timeout - forçando esconder loading screen');
        hideLoadingScreen();
    }
}, 10000);

// Botão Voltar ao Topo
(function initBackToTop() {
    const backToTopBtn = document.getElementById('backToTop');
    if (!backToTopBtn) return;
    
    window.addEventListener('scroll', () => {
        if (window.scrollY > 400) {
            backToTopBtn.classList.add('visible');
        } else {
            backToTopBtn.classList.remove('visible');
        }
    }, { passive: true });
    
    backToTopBtn.addEventListener('click', () => {
        window.scrollTo({ top: 0, behavior: 'smooth' });
    });
})();

// Focus trap para modais (acessibilidade)
function trapFocus(modalElement) {
    const focusableElements = modalElement.querySelectorAll(
        'button, input, textarea, select, [tabindex]:not([tabindex="-1"]), a[href]'
    );
    if (focusableElements.length === 0) return;
    
    const first = focusableElements[0];
    const last = focusableElements[focusableElements.length - 1];
    
    modalElement.addEventListener('keydown', (e) => {
        if (e.key === 'Tab') {
            if (e.shiftKey) {
                if (document.activeElement === first) {
                    e.preventDefault();
                    last.focus();
                }
            } else {
                if (document.activeElement === last) {
                    e.preventDefault();
                    first.focus();
                }
            }
        }
        if (e.key === 'Escape') {
            if (modalElement.id === 'clientModal') closeClientModal();
            if (modalElement.id === 'editSaleModal') closeEditSaleModalFunc();
        }
    });
}

// Aplicar focus trap aos modais
if (modal) trapFocus(modal);
if (editSaleModal) trapFocus(editSaleModal);

// Fechar modal ao pressionar Enter no botão de fechar (acessibilidade)
document.querySelectorAll('.close[role="button"]').forEach(btn => {
    btn.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            btn.click();
        }
    });
});

// Toggle mostrar/ocultar senha no login
(function initPasswordToggle() {
    const toggleBtn = document.getElementById('togglePassword');
    const passwordInput = document.getElementById('loginPassword');
    if (!toggleBtn || !passwordInput) return;
    
    toggleBtn.addEventListener('click', () => {
        const isPassword = passwordInput.type === 'password';
        passwordInput.type = isPassword ? 'text' : 'password';
        toggleBtn.querySelector('.eye-icon').textContent = isPassword ? '🙈' : '👁️';
        toggleBtn.setAttribute('aria-label', isPassword ? 'Ocultar senha' : 'Mostrar senha');
    });
})();

// Indicador de conexão offline (verifica conectividade real, não apenas placa de rede)
(function initOfflineIndicator() {
    const banner = document.getElementById('offlineBanner');
    if (!banner) return;
    
    let wasOffline = false;
    let checkInterval = null;
    
    // Verifica conectividade real fazendo uma requisição leve
    async function checkRealConnectivity() {
        try {
            const response = await fetch('https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js', {
                method: 'HEAD',
                mode: 'no-cors',
                cache: 'no-store',
                signal: AbortSignal.timeout(5000)
            });
            return true;
        } catch {
            return false;
        }
    }
    
    async function updateStatus() {
        // Se a placa de rede diz offline, nem precisa testar
        if (!navigator.onLine) {
            setOffline();
            return;
        }
        // Placa de rede diz online, mas verifica de verdade
        const isConnected = await checkRealConnectivity();
        if (isConnected) {
            setOnline();
        } else {
            setOffline();
        }
    }
    
    function setOnline() {
        banner.style.display = 'none';
        if (wasOffline) {
            showToast('Conexão restaurada!', 'success');
            wasOffline = false;
        }
        // Verificações menos frequentes quando online
        clearInterval(checkInterval);
        checkInterval = setInterval(updateStatus, 30000); // 30s
    }
    
    function setOffline() {
        banner.style.display = 'flex';
        if (!wasOffline) {
            wasOffline = true;
        }
        // Verificações mais frequentes quando offline para detectar retorno rápido
        clearInterval(checkInterval);
        checkInterval = setInterval(updateStatus, 10000); // 10s
    }
    
    // Eventos do navegador como gatilho para re-verificar de verdade
    window.addEventListener('online', () => updateStatus());
    window.addEventListener('offline', () => updateStatus());
    
    // Verificação inicial
    updateStatus();
})();

// Inicializar (os dados serão carregados automaticamente pelo listener do Firebase)
