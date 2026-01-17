// Importar Firebase
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js';
import { getDatabase, ref, set, get, remove, onValue } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js';
import { getAuth, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js';

// Configuração do Firebase
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
        }
        
        const dbRef = ref(database, `users/${this.userId}/clients`);
        
        // Listener em tempo real para mudanças no banco de dados
        this.unsubscribe = onValue(dbRef, (snapshot) => {
            this.clients = snapshot.val() || {};
            console.log('Dados carregados do Firebase:', this.clients);
            updateClientsList();
            updateClientSelect();
        });
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
        // Validar e sanitizar nome
        const sanitizedName = name.trim();
        if (sanitizedName.length < 2 || sanitizedName.length > 100) {
            throw new Error('Nome deve ter entre 2 e 100 caracteres');
        }
        const id = Date.now().toString();
        this.clients[id] = {
            id,
            name: sanitizedName,
            sales: [],
            createdAt: new Date().toISOString()
        };
        safeLog('Adicionando cliente:', sanitizedName);
        await this.saveData();
        return id;
    }

    async addSale(clientId, amount, description = '') {
        if (!this.clients[clientId]) return false;
        
        // Validar valor
        const numericAmount = parseFloat(amount);
        if (isNaN(numericAmount) || numericAmount <= 0 || numericAmount > 1000000) {
            throw new Error('Valor inválido');
        }
        
        // Validar e sanitizar descrição
        const sanitizedDescription = description.trim().substring(0, 200);
        
        // Garantir que sales existe
        if (!this.clients[clientId].sales) {
            this.clients[clientId].sales = [];
        }
        
        this.clients[clientId].sales.push({
            id: Date.now().toString(),
            amount: numericAmount,
            description: sanitizedDescription,
            type: 'sale',
            date: new Date().toISOString()
        });
        await this.saveData();
        return true;
    }

    async addPayment(clientId, amount) {
        if (!this.clients[clientId]) return false;
        
        // Validar valor
        const numericAmount = parseFloat(amount);
        if (isNaN(numericAmount) || numericAmount <= 0 || numericAmount > 1000000) {
            throw new Error('Valor inválido');
        }
        
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
        if (!this.clients[clientId]) throw new Error('Cliente não encontrado');
        const name = (newName || '').trim();
        if (!name || name.length < 2) throw new Error('Nome inválido');
        this.clients[clientId].name = name;
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
            const debt = this.getClientDebt(clientId);
            // Somar apenas débitos positivos
            return debt > 0 ? total + debt : total;
        }, 0);
    }

    getTotalCredit() {
        return Object.keys(this.clients).reduce((total, clientId) => {
            const debt = this.getClientDebt(clientId);
            // Somar apenas créditos (débitos negativos)
            return debt < 0 ? total + Math.abs(debt) : total;
        }, 0);
    }

    getClientSalesCount(clientId) {
        if (!this.clients[clientId]) return 0;
        if (!this.clients[clientId].sales) return 0;
        return this.clients[clientId].sales.filter(s => s.type === 'sale').length;
    }
}

// Inicializar gerenciador
const manager = new SalesManager();

// Elementos DOM - Auth
const loginScreen = document.getElementById('loginScreen');
const appScreen = document.getElementById('appScreen');
const loginForm = document.getElementById('loginForm');
const signupForm = document.getElementById('signupForm');
const logoutBtn = document.getElementById('logoutBtn');
const userEmailSpan = document.getElementById('userEmail');
const showRegisterLink = document.getElementById('showRegister');
const showLoginLink = document.getElementById('showLogin');

// Elementos DOM - App
const addClientForm = document.getElementById('addClientForm');
const addSaleForm = document.getElementById('addSaleForm');
const paymentForm = document.getElementById('paymentForm');
const modalAddSaleForm = document.getElementById('modalAddSaleForm');
const modalSaleAmountInput = document.getElementById('modalSaleAmount');
const modalSaleDescriptionInput = document.getElementById('modalSaleDescription');
const clientsList = document.getElementById('clientsList');
const selectClient = document.getElementById('selectClient');
const modal = document.getElementById('clientModal');
const closeModal = document.querySelector('.close');
const deleteClientBtn = document.getElementById('deleteClient');
const clearHistoryBtn = document.getElementById('clearHistory');
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

// Funções de UI
function showLoader() {
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
    
    if (clients.length === 0) {
        clientsList.innerHTML = '<p class="empty-message">Nenhum cliente cadastrado ainda.</p>';
        return;
    }

    // Ordenar por débito (maior primeiro)
    clients.sort((a, b) => manager.getClientDebt(b.id) - manager.getClientDebt(a.id));

    clientsList.innerHTML = clients.map(client => {
        const debt = manager.getClientDebt(client.id);
        const salesCount = manager.getClientSalesCount(client.id);
        const isPaid = debt === 0;
        const isCredit = debt < 0;
        const displayValue = Math.abs(debt);

        let statusClass = '';
        let statusIcon = '';
        let label = 'Débito: ';
        
        if (isPaid) {
            statusClass = 'paid';
            statusIcon = '✓';
            label = 'Pago: ';
        } else if (isCredit) {
            statusClass = 'credit';
            label = 'Crédito: ';
        }

        return `
            <div class="client-item" data-client-id="${sanitizeHTML(client.id)}">
                <div class="client-info">
                    <div class="client-name">${sanitizeHTML(client.name)}</div>
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
}

// Atualizar select de clientes
function updateClientSelect() {
    const clients = Object.values(manager.clients);
    
    selectClient.innerHTML = '<option value="">Selecione o cliente</option>' + 
        clients.map(client => `
            <option value="${client.id}">${client.name}</option>
        `).join('');
}

// Abrir modal do cliente
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
        modalDebtContainer.innerHTML = `Débito total: <strong>R$ <span id="modalDebt">${formatCurrency(debt)}</span></strong>`;
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
        // Ordenar por data (mais recente primeiro)
        const sortedSales = [...sales].sort((a, b) => 
            new Date(b.date) - new Date(a.date)
        );

        salesHistory.innerHTML = sortedSales.map(sale => `
            <div class="sale-item ${sale.type === 'payment' ? 'payment-item' : ''}">
                <div class="sale-date">${formatDate(sale.date)}</div>
                <div class="sale-amount">
                    ${sale.type === 'payment' ? '✓ Pagamento: ' : 'Venda: '}
                    R$ ${formatCurrency(sale.amount)}
                </div>
                ${sale.description ? `<div class="sale-description">${sanitizeHTML(sale.description)}</div>` : ''}
            </div>
        `).join('');
    }

    modal.style.display = 'block';
}

// Fechar modal
function closeClientModal() {
    modal.style.display = 'none';
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

// Auth State Observer
onAuthStateChanged(auth, (user) => {
    if (user) {
        currentUser = user;
        manager.setUser(user.uid);
        if (loginScreen) loginScreen.style.display = 'none';
        if (appScreen) appScreen.style.display = 'block';
        if (userEmailSpan) userEmailSpan.textContent = user.email || '';
    } else {
        currentUser = null;
        if (loginScreen) loginScreen.style.display = 'flex';
        if (appScreen) appScreen.style.display = 'none';
    }
});

// Login com Email
if (loginForm) {
    loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const email = document.getElementById('loginEmail').value;
        const password = document.getElementById('loginPassword').value;
        
        showLoader();
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

// Cadastro com Email
if (signupForm) {
    signupForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const email = document.getElementById('signupEmail').value;
        const password = document.getElementById('signupPassword').value;
        const passwordConfirm = document.getElementById('signupPasswordConfirm').value;
        
        // Validar se as senhas coincidem
        if (password !== passwordConfirm) {
            showToast('As senhas não coincidem. Tente novamente.', 'error');
            return;
        }
        
        // Validar força da senha
        if (password.length < 8) {
            showToast('Senha deve ter pelo menos 8 caracteres.', 'error');
            return;
        }
        if (!/[A-Z]/.test(password)) {
            showToast('Senha deve conter pelo menos uma letra maiúscula.', 'error');
            return;
        }
        if (!/[0-9]/.test(password)) {
            showToast('Senha deve conter pelo menos um número.', 'error');
            return;
        }
        
        showLoader();
        try {
            await createUserWithEmailAndPassword(auth, email, password);
            hideLoader();
            showToast('Conta criada com sucesso!', 'success');
        } catch (error) {
            hideLoader();
            console.error('Erro no cadastro:', error);
            let message = 'Erro ao criar conta.';
            if (error.code === 'auth/email-already-in-use') {
                message = 'Este email já está em uso.';
            } else if (error.code === 'auth/weak-password') {
                message = 'Senha muito fraca. Use pelo menos 6 caracteres.';
            } else if (error.code === 'auth/operation-not-allowed') {
                message = 'Autenticação não configurada. Ative Email/Password no Firebase Console.';
            } else if (error.code === 'auth/invalid-email') {
                message = 'Email inválido.';
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

// Toggle entre login e cadastro
if (showRegisterLink) {
    showRegisterLink.addEventListener('click', (e) => {
        e.preventDefault();
        document.getElementById('emailTab').style.display = 'none';
        document.getElementById('registerForm').style.display = 'block';
    });
}

if (showLoginLink) {
    showLoginLink.addEventListener('click', (e) => {
        e.preventDefault();
        document.getElementById('registerForm').style.display = 'none';
        document.getElementById('emailTab').style.display = 'block';
    });
}

// Event Listeners - App
addClientForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('clientName').value.trim();
    
    if (name) {
        showLoader();
        try {
            await manager.addClient(name);
            hideLoader();
            showToast('Cliente adicionado com sucesso!', 'success');
            addClientForm.reset();
        } catch (error) {
            hideLoader();
            console.error('Erro ao adicionar cliente:', error);
            showToast(getDatabaseErrorMessage(error, 'Erro ao adicionar cliente. Tente novamente.'), 'error');
        }
    }
});

addSaleForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const clientId = selectClient.value;
    const amount = document.getElementById('saleAmount').value;
    const description = document.getElementById('saleDescription').value.trim();
    
    // Validar valor
    const numericAmount = parseFloat(amount);
    if (isNaN(numericAmount) || numericAmount <= 0) {
        showToast('Digite um valor válido e positivo para a venda.', 'error');
        return;
    }
    
    if (clientId && amount) {
        showLoader();
        try {
            await manager.addSale(clientId, amount, description);
            hideLoader();
            showToast('Venda registrada com sucesso!', 'success');
            addSaleForm.reset();
        } catch (error) {
            hideLoader();
            if (IS_DEV) console.error('Erro ao criar conta:', error);
            showToast(getDatabaseErrorMessage(error, 'Erro ao registrar venda. Tente novamente.'), 'error');
        }
    }
});

paymentForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const amount = document.getElementById('paymentAmount').value;
    
    // Validar valor
    const numericAmount = parseFloat(amount);
    if (isNaN(numericAmount) || numericAmount <= 0) {
        showToast('Digite um valor válido e positivo para o pagamento.', 'error');
        return;
    }
    
    if (manager.currentClientId && amount) {
        showLoader();
        try {
            await manager.addPayment(manager.currentClientId, amount);
            hideLoader();
            showToast('Pagamento registrado com sucesso!', 'success');
            openClientModal(manager.currentClientId); // Reabrir para atualizar
        } catch (error) {
            hideLoader();
            console.error('Erro ao registrar pagamento:', error);
            showToast(getDatabaseErrorMessage(error, 'Erro ao registrar pagamento. Tente novamente.'), 'error');
        }
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
            showLoader();
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
                showLoader();
                try {
                    await manager.clearClientHistory(manager.currentClientId);
                    hideLoader();
                    showToast('Histórico limpo com sucesso!', 'success');
                    openClientModal(manager.currentClientId); // Reabrir para atualizar
                    updateClientsList();
                    updateClientSelect();
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
        
        // Validar valor
        const numericAmount = parseFloat(amount);
        if (isNaN(numericAmount) || numericAmount <= 0) {
            showToast('Digite um valor válido e positivo para a venda.', 'error');
            return;
        }
        
        if (!manager.currentClientId) {
            showToast('Nenhum cliente selecionado.', 'error');
            return;
        }
        
        showLoader();
        try {
            await manager.addSale(manager.currentClientId, numericAmount, description);
            hideLoader();
            showToast('Venda registrada com sucesso!', 'success');
            modalAddSaleForm.reset();
            openClientModal(manager.currentClientId); // Reabrir para atualizar
            updateClientsList();
            updateClientSelect();
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
        if (!manager.currentClientId) {
            showToast('Nenhum cliente selecionado.', 'error');
            return;
        }
        if (!newName || newName.length < 2) {
            showToast('Informe um nome válido.', 'error');
            return;
        }
        showLoader();
        try {
            await manager.updateClientName(manager.currentClientId, newName);
            hideLoader();
            showToast('Nome atualizado com sucesso!', 'success');
            // Ocultar formulário e mostrar nome atualizado
            editNameForm.style.display = 'none';
            document.querySelector('.client-name-section').style.display = 'flex';
            openClientModal(manager.currentClientId);
            updateClientsList();
            updateClientSelect();
        } catch (error) {
            hideLoader();
            console.error('Erro ao atualizar nome:', error);
            showToast(getDatabaseErrorMessage(error, 'Erro ao atualizar nome. Tente novamente.'), 'error');
        }
    });
}

closeModal.addEventListener('click', closeClientModal);

window.addEventListener('click', (e) => {
    if (e.target === modal) {
        closeClientModal();
    }
});

// Inicializar (os dados serão carregados automaticamente pelo listener do Firebase)
