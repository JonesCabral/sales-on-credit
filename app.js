// Importar Firebase
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js';
import { getDatabase, ref, set, get, remove, onValue } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js';
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
const APP_VERSION = '2.0.0';

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
        const themeToggle = document.getElementById('themeToggle');
        if (themeToggle) {
            themeToggle.addEventListener('click', () => {
                const html = document.documentElement;
                const currentTheme = html.getAttribute('data-theme');
                const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
                html.setAttribute('data-theme', newTheme);
                localStorage.setItem('theme', newTheme);
            });
        }
    });
})();

// Variável global para armazenar o usuário atual
let currentUser = null;

// Flag de desenvolvimento (mudar para false em produção)
const IS_DEV = false;

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
        this.currentClientId = null;
        this.userId = null;
        this.unsubscribe = null;
    }

    setUser(userId) {
        this.userId = userId;
        this.loadData();
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
        }, (error) => {
            console.error('Erro ao carregar dados:', error);
            showToast('Erro ao carregar dados. Verifique sua conexão.', 'error');
        });
    }

    // Método para limpar recursos
    cleanup() {
        if (this.unsubscribe) {
            this.unsubscribe();
            this.unsubscribe = null;
        }
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
        await this.saveData();
        return id;
    }

    async addSale(clientId, amount, description = '') {
        if (!this.clients[clientId]) {
            throw new Error('Cliente não encontrado');
        }
        
        // Validar valor usando utility
        const numericAmount = ValidationUtils.validateAmount(amount, {
            min: 0,
            max: 1000000,
            allowZero: true
        });
        
        // Validar e sanitizar descrição
        const sanitizedDescription = ValidationUtils.validateText(description, {
            maxLength: 200,
            required: numericAmount === 0,
            fieldName: 'Descrição'
        });
        
        // Garantir que sales existe
        if (!this.clients[clientId].sales) {
            this.clients[clientId].sales = [];
        }
        
        this.clients[clientId].sales.push({
            id: Date.now().toString(),
            amount: numericAmount,
            description: sanitizedDescription,
            type: 'sale',
            isNote: numericAmount === 0,
            date: new Date().toISOString()
        });
        await this.saveData();
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
        
        this.clients[clientId].sales.push({
            id: Date.now().toString(),
            amount: numericAmount,
            type: 'payment',
            date: new Date().toISOString()
        });
        await this.saveData();
        return true;
    }

    async deleteClient(clientId) {
        delete this.clients[clientId];
        await this.saveData();
    }

    async clearClientHistory(clientId) {
        if (!this.clients[clientId]) throw new Error('Cliente não encontrado');
        this.clients[clientId].sales = [];
        await this.saveData();
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
        await this.saveData();
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
        this.clients[clientId].sales.splice(saleIndex, 1);
        await this.saveData();
        return true;
    }

    async archiveClient(clientId) {
        if (!this.clients[clientId]) {
            throw new Error('Cliente não encontrado');
        }
        this.clients[clientId].archived = true;
        this.clients[clientId].archivedAt = new Date().toISOString();
        await this.saveData();
        return true;
    }

    async unarchiveClient(clientId) {
        if (!this.clients[clientId]) {
            throw new Error('Cliente não encontrado');
        }
        this.clients[clientId].archived = false;
        delete this.clients[clientId].archivedAt;
        await this.saveData();
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
        if (sanitizedDescription.length > 200) {
            throw new Error('Descrição não pode ter mais de 200 caracteres');
        }
        
        // Se o valor é 0, a descrição é obrigatória
        if (numericAmount === 0 && !sanitizedDescription && sale.type === 'sale') {
            throw new Error('Para anotações sem valor, a descrição do produto é obrigatória');
        }
        
        sale.amount = numericAmount;
        if (sale.type === 'sale') {
            sale.description = sanitizedDescription;
            sale.isNote = numericAmount === 0;
        }
        sale.editedAt = new Date().toISOString();
        
        await this.saveData();
        return true;
    }

    getClientDebt(clientId) {
        if (!this.clients[clientId]) return 0;
        if (!this.clients[clientId].sales || this.clients[clientId].sales.length === 0) return 0;
        
        return this.clients[clientId].sales.reduce((total, item) => {
            return item.type === 'sale' 
                ? total + item.amount 
                : total - item.amount;
        }, 0);
    }

    getTotalDebt() {
        return Object.keys(this.clients).reduce((total, clientId) => {
            // Excluir clientes arquivados do cálculo
            if (this.clients[clientId].archived) return total;
            const debt = this.getClientDebt(clientId);
            // Somar apenas dívidas positivas
            return debt > 0 ? total + debt : total;
        }, 0);
    }

    getTotalCredit() {
        return Object.keys(this.clients).reduce((total, clientId) => {
            // Excluir clientes arquivados do cálculo
            if (this.clients[clientId].archived) return total;
            const debt = this.getClientDebt(clientId);
            // Somar apenas créditos (dívidas negativas)
            return debt < 0 ? total + Math.abs(debt) : total;
        }, 0);
    }

    getClientSalesCount(clientId) {
        if (!this.clients[clientId]) return 0;
        if (!this.clients[clientId].sales) return 0;
        return this.clients[clientId].sales.filter(s => s.type === 'sale').length;
    }

    hasUnpricedNotes(clientId) {
        if (!this.clients[clientId]) return false;
        if (!this.clients[clientId].sales) return false;
        return this.clients[clientId].sales.some(s => 
            s.type === 'sale' && (s.isNote || s.amount === 0)
        );
    }

    getClientsWithUnpricedNotes() {
        return Object.values(this.clients).filter(client => 
            this.hasUnpricedNotes(client.id)
        );
    }

    getLastPaymentDate(clientId) {
        if (!this.clients[clientId]) return null;
        if (!this.clients[clientId].sales) return null;
        const payments = this.clients[clientId].sales.filter(s => s.type === 'payment');
        if (payments.length === 0) return null;
        // Retorna a data do pagamento mais recente
        return payments.reduce((latest, p) => {
            const d = new Date(p.date);
            return d > latest ? d : latest;
        }, new Date(payments[0].date));
    }

    isOverdue(clientId) {
        // Só marca como atrasado se tiver dívida positiva
        const debt = this.getClientDebt(clientId);
        if (debt <= 0) return false;
        
        const lastPayment = this.getLastPaymentDate(clientId);
        const now = new Date();
        
        if (lastPayment === null) {
            // Nunca pagou: verificar data da primeira venda
            const client = this.clients[clientId];
            if (!client.sales || client.sales.length === 0) return false;
            const firstSale = client.sales.find(s => s.type === 'sale');
            if (!firstSale) return false;
            const firstSaleDate = new Date(firstSale.date);
            const diffMonths = (now.getFullYear() - firstSaleDate.getFullYear()) * 12 + (now.getMonth() - firstSaleDate.getMonth());
            return diffMonths >= 2;
        }
        
        const diffMonths = (now.getFullYear() - lastPayment.getFullYear()) * 12 + (now.getMonth() - lastPayment.getMonth());
        return diffMonths >= 2;
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
const justNoteProductCheckbox = document.getElementById('justNoteProduct');
const modalJustNoteProductCheckbox = document.getElementById('modalJustNoteProduct');
const saleAmountInput = document.getElementById('saleAmount');
const saleDescriptionInput = document.getElementById('saleDescription');
const clientNameInput = document.getElementById('clientNameInput');
const modal = document.getElementById('clientModal');
const closeModal = document.querySelector('.close');
const deleteClientBtn = document.getElementById('deleteClient');
const archiveClientBtn = document.getElementById('archiveClient');
const clearHistoryBtn = document.getElementById('clearHistory');
const shareHistoryBtn = document.getElementById('shareHistory');
const loader = document.getElementById('loader');
const toast = document.getElementById('toast');
const editNameForm = document.getElementById('editNameForm');
const editClientNameInput = document.getElementById('editClientName');
const editNameBtn = document.getElementById('editNameBtn');
const cancelEditNameBtn = document.getElementById('cancelEditName');
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
let currentEditingSaleId = null;
let alertDismissed = false;

// Aplicar máscara de moeda em todos os campos de valor
[saleAmountInput, modalSaleAmountInput, editSaleAmount, document.getElementById('paymentAmount')].forEach(input => {
    if (input) currencyMask(input);
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
        const { minLength = 0, maxLength = 200, required = false, fieldName = 'Campo' } = options;
        const trimmed = (text || '').trim();
        
        if (required && !trimmed) {
            throw new Error(`${fieldName} é obrigatório`);
        }
        if (trimmed && trimmed.length < minLength) {
            throw new Error(`${fieldName} deve ter pelo menos ${minLength} caracteres`);
        }
        if (trimmed.length > maxLength) {
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
    return value.toFixed(2).replace('.', ',');
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

// Atualizar lista de clientes
function updateClientsList() {
    safeLog('Atualizando lista de clientes...', manager.clients);
    const clients = Object.values(manager.clients);
    
    const clientsListDiv = document.getElementById('clientsListDiv');
    if (clients.length === 0) {
        clientsListDiv.innerHTML = '<p class="empty-message">Nenhum cliente cadastrado ainda.</p>';
        return;
    }

    // Aplicar filtros se existirem
    const searchClients = document.getElementById('searchClients');
    const filterDebtOnlyCheckbox = document.getElementById('filterDebtOnly');
    const searchTerm = searchClients?.value.trim().toLowerCase() || '';
    const showDebtOnly = filterDebtOnlyCheckbox?.checked || false;
    
    let filteredClients = [...clients];
    
    // Filtrar clientes por status de arquivado
    const filterArchivedCheckbox = document.getElementById('filterArchived');
    const showArchived = filterArchivedCheckbox?.checked || false;
    if (showArchived) {
        // Quando marcado, mostrar APENAS clientes arquivados
        filteredClients = filteredClients.filter(client => client.archived);
    } else {
        // Quando desmarcado, mostrar apenas clientes não arquivados
        filteredClients = filteredClients.filter(client => !client.archived);
    }
    
    // Filtrar por nome se houver termo de busca
    if (searchTerm.length > 0) {
        filteredClients = filteredClients.filter(client => 
            client.name.toLowerCase().includes(searchTerm)
        );
    }
    
    // Filtrar por dívida se checkbox estiver marcado
    if (showDebtOnly) {
        filteredClients = filteredClients.filter(client => 
            manager.getClientDebt(client.id) > 0
        );
    }
    
    // Ordenar por dívida (maior primeiro)
    filteredClients.sort((a, b) => manager.getClientDebt(b.id) - manager.getClientDebt(a.id));

    renderClientsList(filteredClients);

    // Atualizar totais
    const totalDebt = manager.getTotalDebt();
    const totalCredit = manager.getTotalCredit();
    
    document.getElementById('totalDebt').textContent = formatCurrency(totalDebt);
    
    const creditCard = document.getElementById('creditCard');
    if (totalCredit > 0) {
        creditCard.style.display = 'block';
        document.getElementById('totalCredit').textContent = formatCurrency(totalCredit);
    } else {
        creditCard.style.display = 'none';
    }

    // Atualizar aviso de anotações pendentes
    updateUnpricedNotesAlert();
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
function renderClientsList(clients) {
    const clientsListDiv = document.getElementById('clientsListDiv');
    
    if (clients.length === 0) {
        clientsListDiv.innerHTML = '<p class="empty-message">Nenhum cliente encontrado.</p>';
        return;
    }
    
    clientsListDiv.innerHTML = clients.map(client => {
        const debt = manager.getClientDebt(client.id);
        const salesCount = manager.getClientSalesCount(client.id);
        const isPaid = debt === 0;
        const isCredit = debt < 0;
        const displayValue = Math.abs(debt);
        const hasNotes = manager.hasUnpricedNotes(client.id);
        const isOverdue = manager.isOverdue(client.id);

        let statusClass = '';
        let statusIcon = '';
        let label = 'Dívida: ';
        let noteIndicator = '';
        let overdueIndicator = '';
        
        if (isPaid) {
            statusClass = 'paid';
            statusIcon = '✓';
            label = 'Pago: ';
        } else if (isCredit) {
            statusClass = 'credit';
            label = 'Crédito: ';
        }

        if (hasNotes) {
            noteIndicator = '<span class="note-indicator" title="Tem itens não contabilizados">📝</span>';
        }

        if (isOverdue) {
            const lastPayment = manager.getLastPaymentDate(client.id);
            const overdueTitle = lastPayment 
                ? `Último pagamento: ${lastPayment.toLocaleDateString('pt-BR')}` 
                : 'Nunca realizou pagamento';
            overdueIndicator = `<span class="overdue-indicator" title="${overdueTitle}">⚠️</span>`;
        }

        const archivedIndicator = client.archived ? '<span class="archived-badge" title="Cliente arquivado">📦 Arquivado</span>' : '';
        
        return `
            <div class="client-item ${hasNotes ? 'has-notes' : ''} ${isOverdue ? 'overdue' : ''} ${client.archived ? 'archived' : ''}" data-client-id="${sanitizeHTML(client.id)}">
                <div class="client-info">
                    <div class="client-name">${sanitizeHTML(client.name)} ${overdueIndicator} ${noteIndicator} ${archivedIndicator}</div>
                    <div class="client-sales">${salesCount} venda${salesCount !== 1 ? 's' : ''} fiada${salesCount !== 1 ? 's' : ''}</div>
                </div>
                <div class="client-debt ${statusClass}">
                    ${label}R$ ${formatCurrency(displayValue)}
                    ${statusIcon}
                </div>
            </div>
        `;
    }).join('');

    // Adicionar event listeners
    document.querySelectorAll('.client-item').forEach(item => {
        item.addEventListener('click', () => {
            openClientModal(item.dataset.clientId);
        });
    });

    // Atualizar totais
    const totalDebt = manager.getTotalDebt();
    const totalCredit = manager.getTotalCredit();
    
    document.getElementById('totalDebt').textContent = formatCurrency(totalDebt);
    
    const creditCard = document.getElementById('creditCard');
    if (totalCredit > 0) {
        creditCard.style.display = 'block';
        document.getElementById('totalCredit').textContent = formatCurrency(totalCredit);
    } else {
        creditCard.style.display = 'none';
    }

    // Atualizar contador de clientes
    const totalClients = Object.values(manager.clients).filter(c => !c.archived).length;
    const clientsCountEl = document.getElementById('clientsCount');
    if (clientsCountEl) {
        if (clients.length !== totalClients) {
            clientsCountEl.textContent = `Mostrando ${clients.length} de ${totalClients} cliente${totalClients !== 1 ? 's' : ''}`;
            clientsCountEl.style.display = 'block';
        } else {
            clientsCountEl.textContent = `${totalClients} cliente${totalClients !== 1 ? 's' : ''}`;
            clientsCountEl.style.display = 'block';
        }
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

function openClientModal(clientId) {
    const client = manager.clients[clientId];
    if (!client) return;

    manager.currentClientId = clientId;
    const debt = manager.getClientDebt(clientId);
    const isCredit = debt < 0;
    const isPaid = debt === 0;

    // Usar textContent para prevenir XSS
    document.getElementById('modalClientName').textContent = client.name;
    const modalDebtElement = document.getElementById('modalDebt');
    const modalDebtContainer = document.querySelector('.modal-debt');
    
    // Remover classes anteriores
    modalDebtContainer.classList.remove('has-credit', 'is-paid');
    
    if (isPaid) {
        modalDebtContainer.classList.add('is-paid');
        modalDebtContainer.innerHTML = `Saldo: <strong>R$ <span id="modalDebt">0,00</span> ✓</strong>`;
    } else if (isCredit) {
        modalDebtContainer.classList.add('has-credit');
        modalDebtContainer.innerHTML = `Crédito a favor: <strong>R$ <span id="modalDebt">${formatCurrency(Math.abs(debt))}</span></strong>`;
    } else {
        modalDebtContainer.innerHTML = `Dívida total: <strong>R$ <span id="modalDebt">${formatCurrency(debt)}</span></strong>`;
    }
    
    if (editClientNameInput) {
        editClientNameInput.value = client.name;
    }

    // Histórico de vendas
    const salesHistory = document.getElementById('salesHistory');
    const sales = client.sales || [];
    if (sales.length === 0) {
        salesHistory.innerHTML = '<p class="empty-message">Nenhuma venda registrada.</p>';
    } else {
        // Ordenar: anotações sem valor primeiro, depois por data (mais recente primeiro)
        const sortedSales = [...sales].sort((a, b) => {
            const aIsNote = a.isNote || (a.type === 'sale' && a.amount === 0);
            const bIsNote = b.isNote || (b.type === 'sale' && b.amount === 0);
            
            // Anotações sem valor sempre no topo
            if (aIsNote && !bIsNote) return -1;
            if (!aIsNote && bIsNote) return 1;
            
            // Se ambos são anotações ou ambos não são, ordenar por data
            return new Date(b.date) - new Date(a.date);
        });

        salesHistory.innerHTML = sortedSales.map(sale => {
            const isNote = sale.isNote || (sale.type === 'sale' && sale.amount === 0);
            let saleTypeLabel = '';
            let saleAmountText = '';
            
            if (sale.type === 'payment') {
                saleTypeLabel = '✓ Pagamento:';
                saleAmountText = `R$ ${formatCurrency(sale.amount)}`;
            } else if (isNote) {
                saleTypeLabel = '📝 Anotação:';
                saleAmountText = '<span class="note-badge">Sem valor</span>';
            } else {
                saleTypeLabel = 'Venda:';
                saleAmountText = `R$ ${formatCurrency(sale.amount)}`;
            }
            
            return `
            <div class="sale-item ${sale.type === 'payment' ? 'payment-item' : ''} ${isNote ? 'note-item' : ''}">
                <div class="sale-info">
                    <div class="sale-date">${formatDate(sale.date)}${sale.editedAt ? ' <span class="edited-badge">(editado)</span>' : ''}</div>
                    <div class="sale-amount">
                        ${saleTypeLabel} ${saleAmountText}
                    </div>
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
        document.querySelectorAll('.btn-edit-sale').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                openEditSaleModal(btn.dataset.saleId);
            });
        });
        
        document.querySelectorAll('.btn-delete-sale').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                await deleteSaleItem(btn.dataset.saleId);
            });
        });
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

    modal.style.display = 'block';
    document.body.classList.add('modal-open');
    document.body.dataset.scrollY = window.scrollY;
    document.body.style.top = `-${window.scrollY}px`;
    
    // Focus trap: focar no primeiro elemento interativo do modal
    const firstFocusable = modal.querySelector('button, input, textarea, select, [tabindex]:not([tabindex="-1"])');
    if (firstFocusable) firstFocusable.focus();
}

// Fechar modal
function closeClientModal() {
    modal.style.display = 'none';
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
    editSaleAmount.value = numberToCurrencyInput(sale.amount);
    editSaleType.textContent = sale.type === 'payment' ? 'Pagamento' : 'Venda';
    
    if (sale.type === 'sale') {
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
    
    const type = sale.type === 'payment' ? 'pagamento' : 'venda';
    const confirmed = await showConfirm(
        'Excluir Item',
        `Tem certeza que deseja excluir este ${type} de R$ ${formatCurrency(sale.amount)}?`
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
        // Limpar listeners ao fazer logout
        manager.cleanup();
        if (loginScreen) loginScreen.style.display = 'flex';
        if (appScreen) appScreen.style.display = 'none';
    }
    // Remover classe loading e adicionar loaded após verificar autenticação
    document.body.classList.remove('loading');
    document.body.classList.add('loaded');
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
            saleDescriptionInput.placeholder = 'Descrição do produto (obrigatório)';
            saleDescriptionInput.required = true;
        } else {
            saleAmountInput.disabled = false;
            saleAmountInput.required = true;
            saleDescriptionInput.placeholder = 'Descrição ou produto (opcional)';
            saleDescriptionInput.required = false;
        }
    });
}

// Checkbox "apenas anotar produto" no modal
if (modalJustNoteProductCheckbox && modalSaleAmountInput && modalSaleDescriptionInput) {
    modalJustNoteProductCheckbox.addEventListener('change', (e) => {
        if (e.target.checked) {
            modalSaleAmountInput.disabled = true;
            modalSaleAmountInput.required = false;
            modalSaleAmountInput.value = '';
            modalSaleDescriptionInput.placeholder = 'Descrição do produto (obrigatório)';
            modalSaleDescriptionInput.required = true;
        } else {
            modalSaleAmountInput.disabled = false;
            modalSaleAmountInput.required = true;
            modalSaleDescriptionInput.placeholder = 'Descrição ou produto (opcional)';
            modalSaleDescriptionInput.required = false;
        }
    });
}

// Busca de clientes na lista
if (searchClients) {
    const filterDebtOnlyCheckbox = document.getElementById('filterDebtOnly');
    const filterArchivedCheckbox = document.getElementById('filterArchived');
    const filterUnpricedCheckbox = document.getElementById('filterUnpriced');
    const filterOverdueCheckbox = document.getElementById('filterOverdue');
    
    const applyFilters = () => {
        const searchTerm = searchClients.value.trim().toLowerCase();
        let allClients = Object.values(manager.clients);
        
        // Filtrar clientes por status de arquivado
        const showArchived = filterArchivedCheckbox?.checked || false;
        if (showArchived) {
            allClients = allClients.filter(client => client.archived);
        } else {
            allClients = allClients.filter(client => !client.archived);
        }
        
        // Se houver busca por nome, desativar outros filtros
        if (searchTerm.length > 0) {
            if (filterDebtOnlyCheckbox) filterDebtOnlyCheckbox.checked = false;
            if (filterUnpricedCheckbox) filterUnpricedCheckbox.checked = false;
            if (filterOverdueCheckbox) filterOverdueCheckbox.checked = false;
            allClients = allClients.filter(client => 
                client.name.toLowerCase().includes(searchTerm)
            );
        } else {
            // Filtro de pagamento atrasado (tem prioridade se marcado)
            const showOverdueOnly = filterOverdueCheckbox?.checked || false;
            if (showOverdueOnly) {
                if (filterDebtOnlyCheckbox) filterDebtOnlyCheckbox.checked = false;
                if (filterUnpricedCheckbox) filterUnpricedCheckbox.checked = false;
                allClients = allClients.filter(client => manager.isOverdue(client.id));
            } else {
                // Filtro de produtos sem preço
                const showUnpricedOnly = filterUnpricedCheckbox?.checked || false;
                if (showUnpricedOnly) {
                    if (filterDebtOnlyCheckbox) filterDebtOnlyCheckbox.checked = false;
                    allClients = allClients.filter(client => 
                        manager.hasUnpricedNotes(client.id)
                    );
                } else {
                    // Filtro de dívida
                    const showDebtOnly = filterDebtOnlyCheckbox?.checked || false;
                    if (showDebtOnly) {
                        allClients = allClients.filter(client => 
                            manager.getClientDebt(client.id) > 0
                        );
                    }
                }
            }
        }
        
        // Ordenar por dívida (maior primeiro)
        const sorted = [...allClients].sort((a, b) => 
            manager.getClientDebt(b.id) - manager.getClientDebt(a.id)
        );
        
        renderClientsList(sorted);
    };
    
    searchClients.addEventListener('input', debounce(applyFilters, 250));
    
    if (filterDebtOnlyCheckbox) {
        filterDebtOnlyCheckbox.addEventListener('change', applyFilters);
    }
    
    if (filterUnpricedCheckbox) {
        filterUnpricedCheckbox.addEventListener('change', applyFilters);
    }
    
    if (filterOverdueCheckbox) {
        filterOverdueCheckbox.addEventListener('change', applyFilters);
    }
    
    if (filterArchivedCheckbox) {
        filterArchivedCheckbox.addEventListener('change', applyFilters);
    }
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
                    const debtText = debt > 0 ? `Dívida: R$ ${formatCurrency(debt)}` : 'Sem dívidas';
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
    const isJustNote = justNoteProductCheckbox?.checked || false;
    
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
        if (!description) {
            showToast('Para anotações, a descrição do produto é obrigatória.', 'error');
            document.getElementById('saleDescription').focus();
            return;
        }
    } else {
        // Validar valor da venda
        if (!amount || amount.trim() === '') {
            showToast('Por favor, digite o valor da venda.', 'error');
            document.getElementById('saleAmount').focus();
            return;
        }
        
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
    
    // Validar descrição (opcional, mas se fornecida, validar tamanho)
    if (description.length > 200) {
        showToast('A descrição não pode ter mais de 200 caracteres.', 'error');
        document.getElementById('saleDescription').focus();
        return;
    }
    
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
        await manager.addSale(clientId, numericAmount, description);
        hideLoader();
        showToast('Venda registrada com sucesso!', 'success');
        addSaleForm.reset();
        selectedClientId = null;
        clientSuggestions.classList.remove('show');
    } catch (error) {
        hideLoader();
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
    
    showLoader('Salvando...');
    try {
        await manager.addPayment(manager.currentClientId, numericAmount);
        hideLoader();
        showToast('Pagamento registrado com sucesso!', 'success');
        paymentForm.reset();
        openClientModal(manager.currentClientId); // Reabrir para atualizar
    } catch (error) {
        hideLoader();
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

// Adicionar venda no modal do cliente
if (modalAddSaleForm) {
    modalAddSaleForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const amount = modalSaleAmountInput?.value;
        const description = (modalSaleDescriptionInput?.value || '').trim();
        const isJustNote = modalJustNoteProductCheckbox?.checked || false;
        
        // Validar se há cliente selecionado
        if (!manager.currentClientId) {
            showToast('Nenhum cliente selecionado.', 'error');
            return;
        }
        
        let numericAmount = 0;
        
        // Se for apenas anotação, valor é 0 e descrição obrigatória
        if (isJustNote) {
            numericAmount = 0;
            if (!description) {
                showToast('Para anotações, a descrição do produto é obrigatória.', 'error');
                modalSaleDescriptionInput.focus();
                return;
            }
        } else {
            // Validar valor da venda
            if (!amount || amount.trim() === '') {
                showToast('Por favor, digite o valor da venda.', 'error');
                modalSaleAmountInput.focus();
                return;
            }
            
            // Converter para número
            numericAmount = parseCurrency(amount);
            
            if (isNaN(numericAmount) || numericAmount <= 0) {
                showToast('Por favor, digite um valor válido maior que zero.', 'error');
                modalSaleAmountInput.focus();
                return;
            }
        }
        
        // Validar descrição (opcional, mas se fornecida, validar tamanho)
        if (description.length > 200) {
            showToast('A descrição não pode ter mais de 200 caracteres.', 'error');
            modalSaleDescriptionInput.focus();
            return;
        }
        
        showLoader('Salvando...');
        try {
            await manager.addSale(manager.currentClientId, numericAmount, description);
            hideLoader();
            showToast('Venda registrada com sucesso!', 'success');
            modalAddSaleForm.reset();
            openClientModal(manager.currentClientId); // Reabrir para atualizar
            updateClientsList();
        } catch (error) {
            hideLoader();
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
        
        // Validar descrição (apenas se o campo estiver visível)
        if (editSaleDescription.parentElement.style.display !== 'none' && description.length > 200) {
            showToast('A descrição não pode ter mais de 200 caracteres.', 'error');
            editSaleDescription.focus();
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

closeModal.addEventListener('click', closeClientModal);

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

// Esconder loading screen quando a página estiver totalmente carregada
if (document.readyState === 'complete') {
    hideLoadingScreen();
} else {
    window.addEventListener('load', hideLoadingScreen);
}

// Fallback: esconder loading após 5 segundos se ainda estiver visível
setTimeout(() => {
    if (document.getElementById('loadingScreen') && !document.getElementById('loadingScreen').classList.contains('hidden')) {
        console.log('Loading timeout - forçando esconder loading screen');
        hideLoadingScreen();
    }
}, 5000);

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
