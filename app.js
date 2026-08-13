// Importar Firebase
import { getDatabase, get, ref, runTransaction, update, onValue } from 'firebase/database';
import { getAuth, signOut, onAuthStateChanged } from 'firebase/auth';
import { firebaseApp } from './firebase.js';
import {
    calculateSummaryDebt,
    formatInterestCyclesSuffix,
    isTransactionMapKeyedById,
    sortTransactionsAscending,
    summariesMatch,
    toTransactionList
} from './debt-domain.js';
import {
    descriptionLineHasPrice,
    resolveUnpricedItemsFlag
} from './history-domain.js';
import {
    createPaymentMutation,
    recalculateDerivedInterestTransactions
} from './payment-domain.js';

// Configuração do Firebase
// IMPORTANTE: Para produção, mova as configurações para variáveis de ambiente
// e proteja com Firebase App Check (https://firebase.google.com/docs/app-check)
const database = getDatabase(firebaseApp);
const auth = getAuth(firebaseApp);

let barcodeScannerModulePromise = null;
async function openBarcodeScanner(options) {
    if (!barcodeScannerModulePromise) {
        barcodeScannerModulePromise = import('./barcode-scanner.js').catch((error) => {
            barcodeScannerModulePromise = null;
            throw error;
        });
    }
    const scannerModule = await barcodeScannerModulePromise;
    return scannerModule.openBarcodeScanner(options);
}

// Versão da aplicação
const APP_VERSION = '2.4.7';

// Verificar e sincronizar versão
(function checkVersion() {
    const storedVersion = localStorage.getItem('appVersion');
    if (storedVersion && storedVersion !== APP_VERSION) {
        console.log(`Atualizando de v${storedVersion} para v${APP_VERSION}`);
        localStorage.setItem('appVersion', APP_VERSION);
    } else if (!storedVersion) {
        localStorage.setItem('appVersion', APP_VERSION);
    }
    
    const initializeVersionAndTheme = () => {
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

    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initializeVersionAndTheme, { once: true });
    } else {
        initializeVersionAndTheme();
    }
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
const CLIENT_INTEREST_MODE_GLOBAL = 'global';
const CLIENT_INTEREST_MODE_CUSTOM = 'custom';
const CLIENT_INTEREST_MODE_DISABLED = 'disabled';
const DEFAULT_OVERDUE_RESET_PAYMENT_PERCENT = 20;
const MIN_OVERDUE_RESET_PAYMENT_PERCENT = 0;
const MAX_OVERDUE_RESET_PAYMENT_PERCENT = 100;
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

function normalizeClientOverdueInterestOverride(value) {
    if (!value || typeof value !== 'object') return null;

    if (value.mode === CLIENT_INTEREST_MODE_DISABLED) {
        return {
            mode: CLIENT_INTEREST_MODE_DISABLED,
            enabled: false,
            percent: 0
        };
    }

    if (value.mode !== CLIENT_INTEREST_MODE_CUSTOM) return null;

    const percent = normalizeOverdueInterestPercent(value.percent);

    return {
        mode: CLIENT_INTEREST_MODE_CUSTOM,
        enabled: percent > 0,
        percent
    };
}

function normalizeOverdueResetPaymentPercent(value) {
    const parsedValue = parseOverdueInterestPercent(value);
    if (!Number.isFinite(parsedValue)) return DEFAULT_OVERDUE_RESET_PAYMENT_PERCENT;
    const clampedValue = Math.min(MAX_OVERDUE_RESET_PAYMENT_PERCENT, Math.max(MIN_OVERDUE_RESET_PAYMENT_PERCENT, parsedValue));
    return Math.round(clampedValue * 100) / 100;
}

function formatOverdueResetPaymentPercent(percent) {
    const safePercent = normalizeOverdueResetPaymentPercent(percent);
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
        },
        overdueResetPaymentPercent: DEFAULT_OVERDUE_RESET_PAYMENT_PERCENT
    };
}

function normalizeSettings(savedSettings = {}) {
    const savedInterest = savedSettings.overdueInterest || {};
    return {
        overdueAlertDays: normalizeOverdueAlertDays(savedSettings.overdueAlertDays),
        overdueInterest: {
            enabled: savedInterest.enabled === true,
            percent: normalizeOverdueInterestPercent(savedInterest.percent)
        },
        overdueResetPaymentPercent: normalizeOverdueResetPaymentPercent(savedSettings.overdueResetPaymentPercent)
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
        this.clientSummaries = {};
        this.settings = getDefaultSettings();
        this.currentClientId = null;
        this.userId = null;
        this.unsubscribe = null;
        this.settingsUnsubscribe = null;
        this.dataLoaded = false;
        this.settingsLoaded = false;
        this.persistedClients = {};
        this.salesKeyedById = {};
        this.clientWatchers = {};
        this.pendingClientWrites = {};
        this.deferredClientSnapshots = {};
        this.publicSummarySyncPromise = null;
        this.summaryMigrationPromise = null;
    }

    setUser(userId) {
        this.releaseClientCaches({ force: true });
        this.userId = userId;
        this.dataLoaded = false;
        this.settingsLoaded = false;
        this.clients = {};
        this.clientSummaries = {};
        this.persistedClients = {};
        this.salesKeyedById = {};
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
            const previousSettingsSignature = JSON.stringify(this.settings);
            const savedSettings = snapshot.val() || {};
            this.settings = normalizeSettings(savedSettings);
            this.settingsLoaded = true;
            syncSettingsUI();
            updateClientsList();
            if (this.currentClientId && modal?.style.display === 'block') {
                syncClientInterestSettingsForm(this.currentClientId);
                renderClientModalDebt(this.currentClientId);
            }
            if (this.dataLoaded && previousSettingsSignature !== JSON.stringify(this.settings)) {
                this.syncAllPublicSummaries();
            }
        }, (error) => {
            console.error('Erro ao carregar configurações:', error);
            this.settings = getDefaultSettings();
            syncSettingsUI();
        });
    }

    async loadData() {
        if (!this.userId) return;
        if (this.unsubscribe) return;

        const summariesRef = ref(database, `users/${this.userId}/clientSummaries`);

        this.unsubscribe = onValue(summariesRef, async (snapshot) => {
            const savedValue = snapshot.val();

            if (savedValue && typeof savedValue === 'object' && savedValue._meta) {
                const { _meta, ...savedSummaries } = savedValue;
                this.clientSummaries = savedSummaries;
                safeLog('Resumos de clientes carregados do Firebase', _meta);
                updateClientsList();
                await openRequestedClientFromUrl();
                if (!this.dataLoaded) {
                    this.dataLoaded = true;
                    hideLoadingScreen();
                }
                return;
            }

            try {
                await this.migrateLegacyClientSummaries();
            } catch (error) {
                console.error('Erro ao preparar resumos de clientes:', error);
                if (!this.dataLoaded) {
                    this.dataLoaded = true;
                    hideLoadingScreen();
                }
            }
        }, (error) => {
            console.error('Erro ao carregar dados:', error);
            showToast('Erro ao carregar dados. Verifique sua conexão.', 'error');
            if (!this.dataLoaded) {
                this.dataLoaded = true;
                hideLoadingScreen();
            }
        });
    }

    async migrateLegacyClientSummaries() {
        if (this.summaryMigrationPromise) return this.summaryMigrationPromise;

        this.summaryMigrationPromise = (async () => {
            const [legacySnapshot, settingsSnapshot] = await Promise.all([
                get(ref(database, `users/${this.userId}/clients`)),
                get(ref(database, `users/${this.userId}/settings`))
            ]);
            this.settings = normalizeSettings(settingsSnapshot.val() || {});
            syncSettingsUI();
            const legacyClients = legacySnapshot.val() || {};
            const summaries = {};
            const updates = {
                [`users/${this.userId}/clientSummaries/_meta`]: {
                    version: 1,
                    migratedAt: new Date().toISOString()
                }
            };

            Object.entries(legacyClients).forEach(([clientId, savedClient]) => {
                const client = { ...savedClient, id: savedClient?.id || clientId };
                this.salesKeyedById[clientId] = isTransactionMapKeyedById(savedClient?.sales);
                client.sales = normalizeSalesList(savedClient?.sales);
                this.clients[clientId] = client;
                this.persistedClients[clientId] = cloneSerializable(client);

                const publicSummary = buildPublicClientSummary(client, this.settings);
                const listSummary = buildClientListSummary(client, this.settings);
                summaries[clientId] = listSummary;
                updates[`users/${this.userId}/clientSummaries/${clientId}`] = listSummary;

                // O client-view le `publicSummary`, que ate entao nao era
                // reconstruido aqui e ficava divergente da lista.
                if (!summariesMatch(client.publicSummary, publicSummary)) {
                    updates[`users/${this.userId}/clients/${clientId}/publicSummary`] = publicSummary;
                    client.publicSummary = publicSummary;
                    this.persistedClients[clientId].publicSummary = cloneSerializable(publicSummary);
                }
            });

            this.clientSummaries = summaries;
            updateClientsList();
            await update(ref(database), updates);
            // A migracao le todos os clientes de uma vez; os caches resultantes
            // nao tem listener, entao envelheceriam em silencio. A lista passa a
            // ler de `clientSummaries`, que e ao vivo.
            this.releaseClientCaches();
            await openRequestedClientFromUrl();
        })().finally(() => {
            this.summaryMigrationPromise = null;
        });

        return this.summaryMigrationPromise;
    }

    getClientPreviews() {
        return Object.values(this.clientSummaries);
    }

    getClientPreview(clientId) {
        return this.clients[clientId] || this.clientSummaries[clientId] || null;
    }

    /**
     * Carrega o cliente completo e passa a acompanha-lo ao vivo enquanto ele
     * estiver em uso. Antes o cache ficava congelado no primeiro `get()`:
     * `clientSummaries` tinha listener e se atualizava quando outra sessao
     * gravava, mas `clients/{id}/sales` nao, entao o cache velho continuava
     * sendo exibido e - pior - regravado por cima do resumo correto.
     */
    async ensureClientLoaded(clientId) {
        if (!this.userId || !clientId) throw new Error('Cliente não encontrado');

        const loadedClient = this.clients[clientId];
        if (loadedClient && Array.isArray(loadedClient.sales) && this.isClientWatched(clientId)) {
            return loadedClient;
        }

        const snapshot = await get(ref(database, `users/${this.userId}/clients/${clientId}`));
        const savedClient = snapshot.val();
        if (!savedClient) throw new Error('Cliente não encontrado');

        const client = this.applyClientSnapshot(clientId, savedClient);
        this.watchClient(clientId);

        // Este e o unico momento em que temos as transacoes reais em maos:
        // aproveita para corrigir resumos que tenham ficado defasados.
        this.reconcileClientSummaries(clientId);
        return client;
    }

    isClientWatched(clientId) {
        return typeof this.clientWatchers[clientId] === 'function';
    }

    /**
     * Escreve um snapshot de `clients/{id}` no cache preservando a identidade
     * do objeto: varias telas guardam `manager.clients[id]` numa variavel local,
     * alteram e so entao gravam - trocar o objeto perderia essa alteracao.
     */
    applyClientSnapshot(clientId, savedClient) {
        const client = this.clients[clientId] || {};
        const nextClient = { ...savedClient, id: savedClient.id || clientId };
        nextClient.sales = normalizeSalesList(savedClient.sales);

        Object.keys(client).forEach((key) => {
            if (!Object.prototype.hasOwnProperty.call(nextClient, key)) delete client[key];
        });
        Object.assign(client, nextClient);

        this.salesKeyedById[clientId] = isTransactionMapKeyedById(savedClient.sales);
        this.clients[clientId] = client;
        this.persistedClients[clientId] = cloneSerializable(client);
        return client;
    }

    /**
     * Mantem `clients/{id}` sincronizado enquanto o cliente esta aberto, do
     * mesmo jeito que `clientSummaries` ja era acompanhado.
     */
    watchClient(clientId) {
        if (!this.userId || !clientId || this.isClientWatched(clientId)) return;

        const watchedUserId = this.userId;
        const clientRef = ref(database, `users/${watchedUserId}/clients/${clientId}`);
        const unsubscribe = onValue(clientRef, (snapshot) => {
            if (this.userId !== watchedUserId) return;
            this.handleClientSnapshot(clientId, snapshot.val());
        }, (error) => {
            console.warn('Falha ao acompanhar cliente:', error?.code || error?.message || error);
        });

        this.clientWatchers[clientId] = unsubscribe;
    }

    handleClientSnapshot(clientId, savedClient) {
        // Durante uma gravacao nossa o snapshot chega com o estado otimista
        // local; guardamos o ultimo e reaplicamos quando a escrita terminar,
        // para nao desfazer a edicao em andamento nem perder o que veio de fora.
        if (this.pendingClientWrites[clientId] > 0) {
            this.deferredClientSnapshots[clientId] = savedClient;
            return;
        }
        delete this.deferredClientSnapshots[clientId];

        if (!savedClient) {
            this.handleWatchedClientRemoved(clientId);
            return;
        }

        const previousSignature = JSON.stringify(this.persistedClients[clientId]);
        this.applyClientSnapshot(clientId, savedClient);
        if (previousSignature === JSON.stringify(this.persistedClients[clientId])) return;

        safeLog('Cliente atualizado em outra sessão:', clientId);
        this.reconcileClientSummaries(clientId);
        refreshOpenClientModal(clientId);
    }

    flushDeferredClientSnapshot(clientId) {
        if (!Object.prototype.hasOwnProperty.call(this.deferredClientSnapshots, clientId)) return;
        if (!this.isClientWatched(clientId)) {
            delete this.deferredClientSnapshots[clientId];
            return;
        }
        this.handleClientSnapshot(clientId, this.deferredClientSnapshots[clientId]);
    }

    handleWatchedClientRemoved(clientId) {
        const wasOpen = this.currentClientId === clientId;
        this.forgetClient(clientId);
        delete this.clientSummaries[clientId];
        updateClientsList();
        if (wasOpen) {
            closeClientModal();
            showToast('Este cliente foi removido em outra sessão.', 'error');
        }
    }

    unwatchClient(clientId) {
        const unsubscribe = this.clientWatchers[clientId];
        if (typeof unsubscribe === 'function') unsubscribe();
        delete this.clientWatchers[clientId];
    }

    forgetClient(clientId) {
        this.unwatchClient(clientId);
        delete this.clients[clientId];
        delete this.persistedClients[clientId];
        delete this.salesKeyedById[clientId];
        delete this.pendingClientWrites[clientId];
        delete this.deferredClientSnapshots[clientId];
    }

    /**
     * Descarta os clientes completos que ninguem esta mais acompanhando. Sem
     * listener o cache so envelhece, e todas as consultas de saldo leem dele
     * antes de `clientSummaries` (que e ao vivo) - era assim que lista, modal e
     * client-view voltavam a divergir depois de uma edicao em outra sessao.
     */
    releaseClientCaches({ except = null, force = false } = {}) {
        Object.keys(this.clients).forEach((clientId) => {
            if (clientId === except) return;
            if (!force && this.pendingClientWrites[clientId] > 0) return;
            this.forgetClient(clientId);
        });
    }

    beginClientWrite(clientId) {
        this.pendingClientWrites[clientId] = (this.pendingClientWrites[clientId] || 0) + 1;
    }

    endClientWrite(clientId) {
        const pending = (this.pendingClientWrites[clientId] || 1) - 1;
        if (pending > 0) {
            this.pendingClientWrites[clientId] = pending;
        } else {
            delete this.pendingClientWrites[clientId];
        }
    }

    /**
     * Recalcula os resumos desnormalizados a partir das vendas carregadas e
     * regrava os que estiverem divergentes. Sem isso um resumo defasado fica
     * errado para sempre, porque nada mais o recalcula ate a proxima escrita
     * naquele cliente.
     */
    reconcileClientSummaries(clientId) {
        const client = this.clients[clientId];
        if (!client || !this.userId || !this.settingsLoaded) return false;
        // So regrava a partir de um cache acompanhado ao vivo: um cache antigo
        // sobrescreveria com dados velhos o resumo que outra sessao acabou de
        // gravar corretamente.
        if (!this.isClientWatched(clientId)) return false;

        const publicSummary = buildPublicClientSummary(client, this.settings);
        const listSummary = buildClientListSummary(client, this.settings);
        const updates = {};

        if (!summariesMatch(client.publicSummary, publicSummary)) {
            updates[`users/${this.userId}/clients/${clientId}/publicSummary`] = publicSummary;
        }
        if (!summariesMatch(this.clientSummaries[clientId], listSummary)) {
            updates[`users/${this.userId}/clientSummaries/${clientId}`] = listSummary;
        }
        if (Object.keys(updates).length === 0) return false;

        safeLog('Resumo divergente corrigido para o cliente', clientId);
        client.publicSummary = publicSummary;
        this.clientSummaries[clientId] = cloneSerializable(listSummary);
        if (this.persistedClients[clientId]) {
            this.persistedClients[clientId].publicSummary = cloneSerializable(publicSummary);
        }
        updateClientsList();

        update(ref(database), updates).catch((error) => {
            console.warn('Falha ao corrigir resumo do cliente:', error?.code || error?.message || error);
        });
        return true;
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
        this.releaseClientCaches({ force: true });
        this.userId = null;
        this.dataLoaded = false;
        this.settingsLoaded = false;
        this.clients = {};
        this.clientSummaries = {};
        this.settings = getDefaultSettings();
        this.persistedClients = {};
        this.salesKeyedById = {};
        this.pendingClientWrites = {};
        this.deferredClientSnapshots = {};
        this.publicSummarySyncPromise = null;
        this.summaryMigrationPromise = null;
        syncSettingsUI();
    }

    async saveData() {
        if (!this.userId) {
            if (IS_DEV) console.error('Erro: userId não definido');
            throw new Error('Usuário não autenticado');
        }
        safeLog('Salvando dados para usuário:', this.userId);
        await Promise.all(Object.keys(this.clients).map((clientId) => this.saveClientData(clientId)));
    }

    async saveClientData(clientId) {
        if (!this.userId) {
            if (IS_DEV) console.error('Erro: userId nÃ£o definido');
            throw new Error('UsuÃ¡rio nÃ£o autenticado');
        }
        if (!this.clients[clientId]) {
            throw new Error('Cliente nÃ£o encontrado');
        }

        const client = this.clients[clientId];
        const previousClient = this.persistedClients[clientId] || {};
        const clientPath = `users/${this.userId}/clients/${clientId}`;
        const updates = {};
        const summary = buildPublicClientSummary(client, this.settings);
        const listSummary = buildClientListSummary(client, this.settings);

        client.publicSummary = summary;

        const topLevelKeys = new Set([
            ...Object.keys(previousClient),
            ...Object.keys(client)
        ]);
        topLevelKeys.delete('sales');
        topLevelKeys.delete('publicSummary');

        topLevelKeys.forEach((key) => {
            const previousValue = previousClient[key];
            const currentValue = client[key];
            if (!serializableValuesMatch(previousValue, currentValue)) {
                updates[`${clientPath}/${key}`] = currentValue === undefined ? null : currentValue;
            }
        });

        const previousSales = normalizeSalesList(previousClient.sales);
        const currentSales = normalizeSalesList(client.sales);
        const clientNameChanged = String(previousClient.name || '') !== String(client.name || '');

        const previousSalesById = new Map(previousSales.map((item) => [item.id, item]));
        const currentSalesById = new Map(currentSales.map((item) => [item.id, item]));

        // Gravacao por id, nunca por indice: o indice se desloca quando uma
        // transacao e removida e uma sessao com cache antigo acabava
        // sobrescrevendo a transacao de outra sessao naquela posicao.
        if (currentSales.length === 0) {
            if (previousSales.length > 0) updates[`${clientPath}/sales`] = null;
        } else if (this.salesKeyedById[clientId] === true) {
            previousSalesById.forEach((previousItem, saleId) => {
                if (!currentSalesById.has(saleId)) updates[`${clientPath}/sales/${saleId}`] = null;
            });
            currentSalesById.forEach((currentItem, saleId) => {
                if (!serializableValuesMatch(previousSalesById.get(saleId), currentItem)) {
                    updates[`${clientPath}/sales/${saleId}`] = currentItem;
                }
            });
        } else {
            // Formato legado (array indexado): reescreve o no inteiro uma vez
            // para converte-lo em mapa por id.
            updates[`${clientPath}/sales`] = buildSalesMap(currentSales);
        }
        previousSalesById.forEach((previousItem, saleId) => {
            if (!currentSalesById.has(saleId)) {
                updates[`users/${this.userId}/activities/${this.getActivityKey(clientId, previousItem.id)}`] = null;
            }
        });
        currentSalesById.forEach((currentItem, saleId) => {
            const previousItem = previousSalesById.get(saleId);
            if (clientNameChanged || !serializableValuesMatch(previousItem, currentItem)) {
                updates[`users/${this.userId}/activities/${this.getActivityKey(clientId, currentItem.id)}`] = this.buildActivityRecord(clientId, currentItem);
            }
        });

        if (!summariesMatch(previousClient.publicSummary, summary)) {
            updates[`${clientPath}/publicSummary`] = summary;
        }

        if (!summariesMatch(this.clientSummaries[clientId], listSummary)) {
            updates[`users/${this.userId}/clientSummaries/${clientId}`] = listSummary;
        }

        if (Object.keys(updates).length > 0) {
            this.beginClientWrite(clientId);
            try {
                await update(ref(database), updates);
            } catch (error) {
                this.endClientWrite(clientId);
                this.flushDeferredClientSnapshot(clientId);
                throw error;
            }
            this.endClientWrite(clientId);
        }
        this.salesKeyedById[clientId] = true;
        client.sales = currentSales;
        this.clientSummaries[clientId] = cloneSerializable(listSummary);
        this.persistedClients[clientId] = cloneSerializable(client);
        // O snapshot represado ja traz a nossa gravacao mesclada com o que
        // chegou de outra sessao durante ela.
        this.flushDeferredClientSnapshot(clientId);
    }

    syncAllPublicSummaries() {
        if (!this.userId || this.publicSummarySyncPromise) {
            return this.publicSummarySyncPromise || Promise.resolve();
        }

        const syncPromise = (async () => {
            const updates = {};
            const summariesToApply = [];

            Object.entries(this.clients).forEach(([clientId, client]) => {
                // Mesma regra do reconcile: nunca regravar resumo a partir de
                // um cache que ninguem esta acompanhando.
                if (!this.isClientWatched(clientId)) return;
                const summary = buildPublicClientSummary(client, this.settings);
                const listSummary = buildClientListSummary(client, this.settings);
                const publicSummaryChanged = !summariesMatch(client.publicSummary, summary);
                const listSummaryChanged = !summariesMatch(this.clientSummaries[clientId], listSummary);
                if (!publicSummaryChanged && !listSummaryChanged) return;

                if (publicSummaryChanged) {
                    updates[`users/${this.userId}/clients/${clientId}/publicSummary`] = summary;
                }
                if (listSummaryChanged) {
                    updates[`users/${this.userId}/clientSummaries/${clientId}`] = listSummary;
                }
                summariesToApply.push({ clientId, summary, listSummary });
            });

            if (Object.keys(updates).length > 0) {
                await update(ref(database), updates);
                summariesToApply.forEach(({ clientId, summary, listSummary }) => {
                    if (this.clients[clientId]) {
                        this.clients[clientId].publicSummary = summary;
                    }
                    if (!this.persistedClients[clientId]) {
                        this.persistedClients[clientId] = {};
                    }
                    this.persistedClients[clientId].publicSummary = cloneSerializable(summary);
                    this.clientSummaries[clientId] = cloneSerializable(listSummary);
                });
            }
        })().catch((error) => {
            console.warn('Falha ao sincronizar resumos públicos:', error?.code || error?.message || error);
        }).finally(() => {
            this.publicSummarySyncPromise = null;
        });

        this.publicSummarySyncPromise = syncPromise;
        return syncPromise;
    }

    async removeClientData(clientId, salesToRemove = []) {
        if (!this.userId) {
            if (IS_DEV) console.error('Erro: userId nÃ£o definido');
            throw new Error('UsuÃ¡rio nÃ£o autenticado');
        }

        const updates = {
            [`users/${this.userId}/clients/${clientId}`]: null,
            [`users/${this.userId}/clientSummaries/${clientId}`]: null
        };
        salesToRemove.forEach((saleItem) => {
            if (!saleItem?.id) return;
            updates[`users/${this.userId}/activities/${this.getActivityKey(clientId, saleItem.id)}`] = null;
        });
        await update(ref(database), updates);
        this.forgetClient(clientId);
        delete this.clientSummaries[clientId];
    }

    getOverdueAlertDays() {
        return normalizeOverdueAlertDays(this.settings?.overdueAlertDays);
    }

    getOverdueInterestSettings(clientId = null) {
        const clientOverride = normalizeClientOverdueInterestOverride(
            clientId
                ? this.clients[clientId]?.overdueInterestOverride
                    || this.clientSummaries[clientId]?.overdueInterestOverride
                : null
        );

        if (clientOverride) {
            return {
                ...clientOverride,
                source: 'individual'
            };
        }

        const interestSettings = this.settings?.overdueInterest || {};
        return {
            enabled: interestSettings.enabled === true,
            percent: normalizeOverdueInterestPercent(interestSettings.percent),
            mode: CLIENT_INTEREST_MODE_GLOBAL,
            source: 'global'
        };
    }

    getClientOverdueInterestOverride(clientId) {
        return normalizeClientOverdueInterestOverride(
            this.clients[clientId]?.overdueInterestOverride
            || this.clientSummaries[clientId]?.overdueInterestOverride
        );
    }

    getOverdueInterestPercent(clientId = null) {
        return this.getOverdueInterestSettings(clientId).percent;
    }

    async setClientOverdueInterestOverride(clientId, mode, percent = 0) {
        const client = this.clients[clientId];
        if (!client) {
            throw new Error('Cliente não encontrado');
        }

        const hadPreviousOverride = Object.prototype.hasOwnProperty.call(client, 'overdueInterestOverride');
        const previousOverride = client.overdueInterestOverride;

        if (mode === CLIENT_INTEREST_MODE_GLOBAL) {
            delete client.overdueInterestOverride;
        } else if (mode === CLIENT_INTEREST_MODE_DISABLED) {
            client.overdueInterestOverride = {
                mode: CLIENT_INTEREST_MODE_DISABLED,
                percent: 0
            };
        } else if (mode === CLIENT_INTEREST_MODE_CUSTOM) {
            const parsedPercent = parseOverdueInterestPercent(percent);
            const normalizedPercent = normalizeOverdueInterestPercent(parsedPercent);
            if (
                !Number.isFinite(parsedPercent)
                || parsedPercent <= 0
                || parsedPercent > MAX_OVERDUE_INTEREST_PERCENT
                || normalizedPercent <= 0
            ) {
                throw new Error(`Informe um percentual maior que 0 e até ${MAX_OVERDUE_INTEREST_PERCENT}%.`);
            }

            client.overdueInterestOverride = {
                mode: CLIENT_INTEREST_MODE_CUSTOM,
                percent: normalizedPercent
            };
        } else {
            throw new Error('Configuração de juros inválida.');
        }

        try {
            await this.saveClientData(clientId);
        } catch (error) {
            if (hadPreviousOverride) {
                client.overdueInterestOverride = previousOverride;
            } else {
                delete client.overdueInterestOverride;
            }
            throw error;
        }
        return this.getOverdueInterestSettings(clientId);
    }

    getOverdueResetPaymentPercent() {
        return normalizeOverdueResetPaymentPercent(this.settings?.overdueResetPaymentPercent);
    }

    getActivityKey(clientId, saleId) {
        return `${clientId}_${saleId}`;
    }

    buildActivityRecord(clientId, saleItem) {
        const client = this.clients[clientId];
        if (!client || !saleItem?.id) return null;
        const timestamp = new Date(saleItem.date || new Date().toISOString()).getTime();
        return {
            id: saleItem.id,
            clientId,
            clientName: client.name || 'Cliente',
            type: saleItem.type,
            amount: getSaleAmount(saleItem),
            amountCents: getSaleAmountCents(saleItem),
            description: saleItem.description || '',
            isNote: Boolean(saleItem.isNote) || (saleItem.type === TRANSACTION_TYPE_SALE && getSaleAmountCents(saleItem) === 0),
            hasUnpricedItems: resolveUnpricedItemsFlag(saleItem),
            items: Array.isArray(saleItem.items) ? saleItem.items : [],
            interestPaidCents: Number.isFinite(Number(saleItem.interestPaidCents)) ? Math.round(Number(saleItem.interestPaidCents)) : 0,
            principalPaidCents: Number.isFinite(Number(saleItem.principalPaidCents)) ? Math.round(Number(saleItem.principalPaidCents)) : 0,
            settlesPreviouslyAppliedInterest: saleItem.settlesPreviouslyAppliedInterest === true,
            relatedInterestId: saleItem.relatedInterestId || null,
            relatedPaymentId: saleItem.relatedPaymentId || null,
            automaticInterest: saleItem.automaticInterest === true,
            date: saleItem.date || new Date().toISOString(),
            timestamp: Number.isFinite(timestamp) ? timestamp : Date.now(),
            editedAt: saleItem.editedAt || null
        };
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
        const existingClient = this.getClientPreviews().find(
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
        this.salesKeyedById[id] = true;
        safeLog('Adicionando cliente:', sanitizedName);
        await this.saveClientData(id);
        this.watchClient(id);
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
            hasUnpricedItems: false,
            date: new Date().toISOString()
        };
        saleItem.hasUnpricedItems = resolveUnpricedItemsFlag(saleItem);

        this.clients[clientId].sales.push(saleItem);
        await this.saveClientData(clientId);
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
        
        const paymentCents = currencyToCents(numericAmount);
        const paymentDate = new Date().toISOString();
        // IDs ficam estaveis durante todos os retries do Firebase. O id de
        // juros pode acabar sem uso quando outro pagamento vence a corrida.
        const interestId = createTransactionId(TRANSACTION_TYPE_INTEREST);
        const paymentId = createTransactionId(TRANSACTION_TYPE_PAYMENT);
        const transactionUserId = this.userId;
        if (!transactionUserId) throw new Error('Usuário não autenticado');
        const settingsSnapshot = cloneSerializable(this.settings);
        const clientRef = ref(database, `users/${transactionUserId}/clients/${clientId}`);

        this.beginClientWrite(clientId);
        try {
            const transactionResult = await runTransaction(clientRef, (savedClient) => {
                if (!savedClient || typeof savedClient !== 'object') {
                    return undefined;
                }

                // O override precisa vir do valor transacional, e nao do cache
                // desta aba, pois ele tambem pode ter mudado em outro aparelho.
                const clientOverride = normalizeClientOverdueInterestOverride(savedClient.overdueInterestOverride);
                const globalInterest = settingsSnapshot?.overdueInterest || {};
                const interestSettings = clientOverride || {
                    enabled: globalInterest.enabled === true,
                    percent: normalizeOverdueInterestPercent(globalInterest.percent)
                };

                const mutation = createPaymentMutation(savedClient, {
                    paymentCents,
                    paymentDate,
                    paymentId,
                    interestId,
                    overdueAlertDays: normalizeOverdueAlertDays(settingsSnapshot?.overdueAlertDays),
                    interestEnabled: interestSettings.enabled,
                    interestPercent: interestSettings.percent,
                    overdueResetPaymentPercent: normalizeOverdueResetPaymentPercent(
                        settingsSnapshot?.overdueResetPaymentPercent
                    ),
                    buildSummary: (client) => buildPublicClientSummary(client, settingsSnapshot),
                    buildInterestDescription: ({ percent, cycles }) => (
                        `Juros por atraso (${formatOverdueInterestPercent(percent)}${formatInterestCyclesSuffix(cycles)})`
                    )
                });

                return mutation.client;
            }, { applyLocally: false });

            if (!transactionResult.committed) {
                throw new Error('Cliente não encontrado');
            }

            const savedClient = transactionResult.snapshot.val();
            if (!savedClient) throw new Error('Cliente não encontrado');
            const savedSales = normalizeSalesList(savedClient.sales);
            const committedPayment = savedSales.find((item) => item.id === paymentId);
            const committedInterest = savedSales.find((item) => item.id === interestId) || null;
            if (!committedPayment) throw new Error('Pagamento não confirmado');
            const committedItems = committedInterest
                ? [committedInterest, committedPayment]
                : [committedPayment];

            // A transacao protege o saldo e o resumo publico no proprio no do
            // cliente. Os indices desnormalizados sao derivados do snapshot
            // que efetivamente venceu a concorrencia.
            const committedClient = this.applyClientSnapshot(clientId, savedClient);
            const listSummary = buildClientListSummary(committedClient, settingsSnapshot);
            const updates = {
                [`users/${transactionUserId}/clientSummaries/${clientId}`]: listSummary
            };
            committedItems.forEach((item) => {
                updates[`users/${transactionUserId}/activities/${this.getActivityKey(clientId, item.id)}`] = this.buildActivityRecord(clientId, item);
            });
            await update(ref(database), updates);

            this.clientSummaries[clientId] = cloneSerializable(listSummary);
            this.salesKeyedById[clientId] = isTransactionMapKeyedById(savedClient.sales);
            return {
                success: true,
                interestCents: committedInterest ? getSaleAmountCents(committedInterest) : 0
            };
        } finally {
            this.endClientWrite(clientId);
            this.flushDeferredClientSnapshot(clientId);
        }
    }

    async deleteClient(clientId) {
        const salesToRemove = Array.isArray(this.clients[clientId]?.sales)
            ? [...this.clients[clientId].sales]
            : [];

        this.forgetClient(clientId);
        await this.removeClientData(clientId, salesToRemove);
    }

    async clearClientHistory(clientId) {
        if (!this.clients[clientId]) throw new Error('Cliente não encontrado');

        this.clients[clientId].sales = [];
        await this.saveClientData(clientId);

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
        const existingClient = this.getClientPreviews().find(
            c => c.id !== clientId && c.name.toLowerCase() === name.toLowerCase()
        );
        if (existingClient) {
            throw new Error('Já existe um cliente com este nome');
        }
        this.clients[clientId].name = name;
        await this.saveClientData(clientId);
        return true;
    }

    async setClientWhatsappName(clientId, customName = '') {
        const client = this.clients[clientId];
        if (!client) {
            throw new Error('Cliente não encontrado');
        }

        const sanitizedName = ValidationUtils.validateText(customName, {
            maxLength: 100,
            fieldName: 'Nome usado no WhatsApp'
        });
        const hadPreviousValue = Object.prototype.hasOwnProperty.call(client, 'whatsappName');
        const previousValue = client.whatsappName;

        if (sanitizedName) {
            client.whatsappName = sanitizedName;
        } else {
            delete client.whatsappName;
        }

        try {
            await this.saveClientData(clientId);
        } catch (error) {
            if (hadPreviousValue) {
                client.whatsappName = previousValue;
            } else {
                delete client.whatsappName;
            }
            throw error;
        }

        return sanitizedName;
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
        const sale = this.clients[clientId].sales[saleIndex];
        if (isAutomaticInterestTransaction(sale)) {
            throw new Error('Juros automaticos devem ser excluidos junto com o pagamento relacionado.');
        }

        if (paymentHasInterestSplit(sale)) {
            const relatedInterestIndex = findRelatedInterestIndex(this.clients[clientId].sales, sale, saleIndex);
            if (relatedInterestIndex === -1) {
                throw new Error('Pagamento com juros sem vinculo seguro. Revise o historico antes de excluir.');
            }

            const indexesToRemove = [saleIndex, relatedInterestIndex].sort((a, b) => b - a);
            indexesToRemove.forEach((index) => {
                this.clients[clientId].sales.splice(index, 1);
            });
        } else {
            this.clients[clientId].sales.splice(saleIndex, 1);
        }
        this.recalculateClientDerivedInterest(clientId);
        await this.saveClientData(clientId);

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
        if (isAutomaticInterestTransaction(sale)) {
            throw new Error('Juros automaticos nao podem ser editados diretamente.');
        }
        if (paymentHasInterestSplit(sale)) {
            throw new Error('Pagamentos com juros automaticos nao podem ser editados diretamente.');
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
        // `editedAt` entra antes de derivar o flag: a regra de produtos sem preco
        // descarta a heuristica de descricao apos uma edicao explicita, e o
        // registro de atividade (gravado depois) ja enxerga a venda editada. Se
        // marcassemos a edicao no fim, venda e atividade sairiam divergentes.
        sale.editedAt = new Date().toISOString();
        if (sale.type === TRANSACTION_TYPE_SALE) {
            sale.description = sanitizedDescription;
            sale.isNote = amountCents === 0;
            sale.hasUnpricedItems = resolveUnpricedItemsFlag(sale);
        } else if (sale.type === TRANSACTION_TYPE_PAYMENT) {
            const previousInterestPaidCents = Math.max(0, Math.round(Number(sale.interestPaidCents) || 0));
            sale.interestPaidCents = Math.min(amountCents, previousInterestPaidCents);
            sale.principalPaidCents = Math.max(0, amountCents - sale.interestPaidCents);
        }

        this.recalculateClientDerivedInterest(clientId);
        await this.saveClientData(clientId);
        return true;
    }

    recalculateClientDerivedInterest(clientId) {
        const client = this.clients[clientId];
        if (!client) throw new Error('Cliente não encontrado');

        const settingsSnapshot = cloneSerializable(this.settings);
        const interestSettings = this.getOverdueInterestSettings(clientId);
        const fallbackPolicy = {
            enabled: interestSettings.enabled,
            percent: interestSettings.percent,
            overdueAlertDays: normalizeOverdueAlertDays(settingsSnapshot?.overdueAlertDays),
            overdueResetPaymentPercent: normalizeOverdueResetPaymentPercent(
                settingsSnapshot?.overdueResetPaymentPercent
            )
        };
        const recalculatedClient = recalculateDerivedInterestTransactions(client, {
            fallbackPolicy,
            createInterestId: () => createTransactionId(TRANSACTION_TYPE_INTEREST),
            isAutomaticInterest: isAutomaticInterestTransaction,
            buildSummary: (clientBeforePayment, policy) => buildPublicClientSummary(
                clientBeforePayment,
                {
                    ...settingsSnapshot,
                    overdueAlertDays: policy.overdueAlertDays,
                    overdueResetPaymentPercent: policy.overdueResetPaymentPercent
                }
            ),
            buildInterestDescription: ({ percent, cycles }) => (
                `Juros por atraso (${formatOverdueInterestPercent(percent)}${formatInterestCyclesSuffix(cycles)})`
            )
        });

        client.sales = recalculatedClient.sales;
        return client.sales;
    }

    getClientDebt(clientId) {
        return this.getClientDebtCents(clientId) / 100;
    }

    getClientOutstandingInterestCents(clientId) {
        if (!this.clients[clientId] && this.clientSummaries[clientId]) {
            return Math.max(0, Math.round(Number(this.clientSummaries[clientId].outstandingInterestCents) || 0));
        }
        if (!this.clients[clientId]) return 0;
        if (!this.clients[clientId].sales || this.clients[clientId].sales.length === 0) return 0;

        return calculateDebtComponents(this.clients[clientId].sales).outstandingInterestCents;
    }

    /**
     * Resumo do cliente para o calculo de atraso/juros: recalculado a partir
     * das vendas quando o cliente esta carregado, senao o resumo salvo.
     */
    getClientDebtSummary(clientId) {
        if (this.clients[clientId]) {
            return buildPublicClientSummary(this.clients[clientId], this.settings);
        }
        return this.clientSummaries[clientId] || null;
    }

    /**
     * Todas as telas passam por calculateSummaryDebt para que card, modal e
     * client-view nunca cheguem a resultados diferentes.
     */
    getClientDebtModel(clientId) {
        const interestSettings = this.getOverdueInterestSettings(clientId);
        return calculateSummaryDebt(this.getClientDebtSummary(clientId), {
            overdueAlertDays: this.getOverdueAlertDays(),
            interestEnabled: interestSettings.enabled,
            interestPercent: interestSettings.percent
        });
    }

    getClientInterestCents(clientId) {
        return this.getClientDebtModel(clientId).interestCents;
    }

    getClientDebtCents(clientId) {
        return this.getClientDebtModel(clientId).totalDebtCents;
    }

    getTotalDebt() {
        const totalInCents = this.getClientPreviews().reduce((total, client) => {
            if (client.archived) return total;
            const debt = this.getClientDebtCents(client.id);
            // Somar apenas dívidas positivas
            return debt > 0 ? total + debt : total;
        }, 0);

        return totalInCents / 100;
    }

    getClientSalesCount(clientId) {
        if (!this.clients[clientId] && this.clientSummaries[clientId]) {
            return Math.max(0, Math.round(Number(this.clientSummaries[clientId].salesCount) || 0));
        }
        if (!this.clients[clientId]) return 0;
        if (!this.clients[clientId].sales) return 0;
        return this.clients[clientId].sales.filter(s => s.type === TRANSACTION_TYPE_SALE).length;
    }

    hasUnpricedNotes(clientId) {
        if (!this.clients[clientId] && this.clientSummaries[clientId]) {
            return this.clientSummaries[clientId].hasUnpricedNotes === true;
        }
        if (!this.clients[clientId]) return false;
        if (!this.clients[clientId].sales) return false;
        return this.clients[clientId].sales.some(s => resolveUnpricedItemsFlag(s));
    }

    getClientsWithUnpricedNotes() {
        return this.getClientPreviews().filter(client =>
            this.hasUnpricedNotes(client.id)
        );
    }

    getLastPaymentDate(clientId) {
        if (!this.clients[clientId]) return null;
        if (!this.clients[clientId].sales) return null;
        return getOverdueReferenceDates(
            this.clients[clientId].sales,
            this.getOverdueResetPaymentPercent()
        ).lastPaymentDate;
    }

    // Considera atraso apenas para clientes com dívida positiva
    getDaysSinceReferencePayment(clientId) {
        return this.getClientDebtModel(clientId).overdueDays;
    }

    isOverdue(clientId) {
        return this.getClientDebtModel(clientId).isOverdue;
    }
}

// Inicializar gerenciador
const manager = new SalesManager();

// Elementos DOM - Auth
const loginScreen = document.getElementById('loginScreen');
const appScreen = document.getElementById('appScreen');
const logoutBtn = document.getElementById('logoutBtn');
const userEmailSpan = document.getElementById('userEmail');

// Elementos DOM - App
const searchClients = document.getElementById('searchClients');
const paymentForm = document.getElementById('paymentForm');
const modalAddSaleForm = document.getElementById('modalAddSaleForm');
const modalSaleAmountInput = document.getElementById('modalSaleAmount');
const modalSaleDescriptionInput = document.getElementById('modalSaleDescription');
const modalSaleProductSearchInput = document.getElementById('modalSaleProductSearch');
const modalSaleProductSuggestions = document.getElementById('modalSaleProductSuggestions');
const modalSaleItemsList = document.getElementById('modalSaleItemsList');
const scanModalSaleProductButton = document.getElementById('scanModalSaleProduct');
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
const clientWhatsappNameForm = document.getElementById('clientWhatsappNameForm');
const clientWhatsappNameInput = document.getElementById('clientWhatsappNameInput');
const clientWhatsappNameCurrentValue = document.getElementById('clientWhatsappNameCurrentValue');
const clientWhatsappNamePreview = document.getElementById('clientWhatsappNamePreview');
const clientInterestSettingsForm = document.getElementById('clientInterestSettingsForm');
const clientInterestModeInput = document.getElementById('clientInterestModeInput');
const clientInterestPercentInput = document.getElementById('clientInterestPercentInput');
const clientInterestCurrentValue = document.getElementById('clientInterestCurrentValue');
const clientInterestModeExplanation = document.getElementById('clientInterestModeExplanation');
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
const appMenu = document.getElementById('appMenu');
const appMenuOverlay = document.getElementById('appMenuOverlay');
const menuToggleBtn = document.getElementById('menuToggle');
const menuCloseBtn = document.getElementById('menuClose');
const overdueFilterText = document.getElementById('overdueFilterText');
const filtersAccordion = document.getElementById('clientsFilters');
const filtersToggle = document.getElementById('filtersToggle');
const filtersPanel = document.getElementById('filtersPanel');
const filtersActiveSummary = document.getElementById('filtersActiveSummary');
const CLIENT_FILTER_IDS = ['filterDebtOnly', 'filterUnpriced', 'filterOverdue', 'filterArchived'];
let currentEditingSaleId = null;
let alertDismissed = false;
let productsUnsubscribe = null;
let savedProducts = {};
const saleDraftItems = new WeakMap();
const autosaveTimers = new WeakMap();
const AUTOSAVE_DELAY_MS = 1800;

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
syncSettingsUI();
setupProductPicker(modalSaleProductSearchInput, modalSaleAmountInput, modalSaleProductSuggestions, modalSaleItemsList);
setupProductCameraScanner(scanModalSaleProductButton, modalSaleProductSearchInput, modalSaleAmountInput, modalSaleProductSuggestions, modalSaleItemsList);
setupClientModalProductSearchCompaction();

modalAddSaleForm?.addEventListener('reset', () => {
    clearSaleDraftItems(modalSaleProductSearchInput, modalSaleItemsList, modalSaleAmountInput);
    clearFormAutosaveState(modalAddSaleForm);
});
paymentForm?.addEventListener('reset', () => clearFormAutosaveState(paymentForm));

// Aplicar máscara de moeda em todos os campos de valor
[modalSaleAmountInput, editSaleAmount, document.getElementById('paymentAmount')].forEach(input => {
    if (input) currencyMask(input);
});

[modalSaleAmountInput].forEach((input) => {
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

function hasUnpricedProductLine(description) {
    const lines = getProductDescriptionLines(description);
    return lines.length > 0 && lines.some((line) => !descriptionLineHasPrice(line));
}

function hasPricedProductLine(description) {
    return getProductDescriptionLines(description).some((line) => descriptionLineHasPrice(line));
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

function getTransactionTime(item) {
    const time = new Date(item?.date || 0).getTime();
    return Number.isFinite(time) ? time : 0;
}

function getSortedTransactions(sales) {
    return sortTransactionsAscending(sales);
}

/**
 * Normaliza o no `sales` vindo do Firebase para a lista usada em memoria.
 * Aceita tanto o formato legado (array indexado) quanto o novo (objeto com o
 * id da transacao como chave) e garante que todo item tenha id, que e a chave
 * de gravacao e a chave do indice de atividades.
 */
function normalizeSalesList(sales) {
    return toTransactionList(sales).map((item) => (
        item.id ? item : { ...item, id: createTransactionId(item.type) }
    ));
}

/** Monta o objeto gravado em `clients/{id}/sales`, indexado pelo id. */
function buildSalesMap(sales) {
    const salesMap = {};
    normalizeSalesList(sales).forEach((item) => {
        salesMap[item.id] = item;
    });
    return salesMap;
}

function calculateDebtComponents(sales) {
    let principalDebtCents = 0;
    let outstandingInterestCents = 0;

    getSortedTransactions(sales).forEach((item) => {
        const amountCents = getSaleAmountCents(item);

        if (item?.type === TRANSACTION_TYPE_SALE) {
            principalDebtCents += amountCents;
            return;
        }

        if (item?.type === TRANSACTION_TYPE_INTEREST) {
            outstandingInterestCents += amountCents;
            return;
        }

        if (item?.type !== TRANSACTION_TYPE_PAYMENT) return;

        const paymentCents = Math.max(0, amountCents);
        const interestPaidCents = Math.min(paymentCents, Math.max(0, outstandingInterestCents));
        outstandingInterestCents -= interestPaidCents;
        principalDebtCents -= paymentCents - interestPaidCents;
    });

    return {
        principalDebtCents,
        outstandingInterestCents: Math.max(0, outstandingInterestCents)
    };
}

function paymentMeetsOverdueResetThreshold(paymentItem, debtBeforePaymentCents, resetPercent) {
    const paymentCents = getSaleAmountCents(paymentItem);
    if (paymentCents <= 0 || debtBeforePaymentCents <= 0) return false;

    const safePercent = normalizeOverdueResetPaymentPercent(resetPercent);
    if (safePercent <= 0) return true;

    const minimumPaymentCents = Math.ceil(debtBeforePaymentCents * (safePercent / 100));
    return paymentCents >= minimumPaymentCents;
}

function getOverdueReferenceDates(sales, resetPercent) {
    let debtCents = 0;
    let firstSaleDate = null;
    let lastPaymentDate = null;

    getSortedTransactions(sales).forEach((item) => {
        const date = item?.date ? new Date(item.date) : null;
        const hasValidDate = date && !Number.isNaN(date.getTime());
        const debtBeforeTransactionCents = debtCents;

        if (
            item?.type === TRANSACTION_TYPE_PAYMENT
            && hasValidDate
            && paymentMeetsOverdueResetThreshold(item, debtBeforeTransactionCents, resetPercent)
        ) {
            lastPaymentDate = date;
        }

        debtCents += getTransactionDebtDeltaCents(item);

        if (debtBeforeTransactionCents <= 0 && debtCents > 0 && hasValidDate) {
            firstSaleDate = date;
            lastPaymentDate = null;
        }

        if (debtCents <= 0) {
            firstSaleDate = null;
            lastPaymentDate = null;
        }
    });

    return { firstSaleDate, lastPaymentDate };
}

function isAutomaticInterestTransaction(item) {
    return item?.type === TRANSACTION_TYPE_INTEREST
        && (item.automaticInterest === true
            || Boolean(item.relatedPaymentId)
            || /^Juros por atraso/i.test(String(item.description || '')));
}

function cloneSerializable(value) {
    if (value === undefined) return undefined;
    return JSON.parse(JSON.stringify(value));
}

function serializableValuesMatch(firstValue, secondValue) {
    return JSON.stringify(firstValue) === JSON.stringify(secondValue);
}

function buildPublicClientSummary(client, settings) {
    const sales = getSortedTransactions(client?.sales);
    const resetPaymentPercent = normalizeOverdueResetPaymentPercent(settings?.overdueResetPaymentPercent);
    let baseDebtCents = 0;
    let principalDebtCents = 0;
    let outstandingInterestCents = 0;
    let firstSaleDate = null;
    let lastPaymentDate = null;
    let lastAutomaticInterestDate = null;

    sales.forEach((item) => {
        const itemTime = getTransactionTime(item);
        const itemDate = itemTime > 0 ? new Date(itemTime) : null;
        const debtBeforeTransactionCents = baseDebtCents;
        const amountCents = getSaleAmountCents(item);

        if (
            item?.type === TRANSACTION_TYPE_PAYMENT
            && itemDate
            && paymentMeetsOverdueResetThreshold(item, debtBeforeTransactionCents, resetPaymentPercent)
        ) {
            lastPaymentDate = itemDate;
        }

        if (item?.type === TRANSACTION_TYPE_SALE) {
            baseDebtCents += amountCents;
            principalDebtCents += amountCents;
        } else if (item?.type === TRANSACTION_TYPE_INTEREST) {
            baseDebtCents += amountCents;
            outstandingInterestCents += amountCents;
            if (isAutomaticInterestTransaction(item) && itemDate) {
                lastAutomaticInterestDate = itemDate;
            }
        } else if (item?.type === TRANSACTION_TYPE_PAYMENT) {
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
    const interestOverride = normalizeClientOverdueInterestOverride(client?.overdueInterestOverride);

    return {
        version: 1,
        baseDebtCents,
        principalDebtCents,
        outstandingInterestCents: Math.max(0, outstandingInterestCents),
        transactionCount: sales.length,
        referenceDate: referenceDate?.toISOString() || null,
        lastAutomaticInterestDate: lastAutomaticInterestDate?.toISOString() || null,
        overdueResetPaymentPercent: resetPaymentPercent,
        overdueInterestOverride: interestOverride
            ? { mode: interestOverride.mode, percent: interestOverride.percent }
            : null
    };
}

function buildClientListSummary(client, settings) {
    const sales = getSortedTransactions(client?.sales);
    const publicSummary = buildPublicClientSummary(client, settings);
    const resetPaymentPercent = normalizeOverdueResetPaymentPercent(settings?.overdueResetPaymentPercent);
    const { firstSaleDate, lastPaymentDate } = getOverdueReferenceDates(sales, resetPaymentPercent);

    return {
        ...publicSummary,
        version: 1,
        id: String(client?.id || ''),
        name: String(client?.name || ''),
        archived: client?.archived === true,
        archivedAt: client?.archivedAt || null,
        createdAt: client?.createdAt || null,
        salesCount: sales.filter((item) => item?.type === TRANSACTION_TYPE_SALE).length,
        hasUnpricedNotes: sales.some((item) => resolveUnpricedItemsFlag(item)),
        referenceType: lastPaymentDate ? 'payment' : firstSaleDate ? 'first-sale' : null
    };
}

function paymentHasInterestSplit(item) {
    return item?.type === TRANSACTION_TYPE_PAYMENT
        && item.settlesPreviouslyAppliedInterest !== true
        && (Boolean(item.relatedInterestId)
            || Math.round(Number(item.interestPaidCents) || 0) > 0);
}

function findRelatedInterestIndex(sales, paymentItem, paymentIndex = -1) {
    if (!Array.isArray(sales) || !paymentItem) return -1;

    if (paymentItem.relatedInterestId) {
        const linkedIndex = sales.findIndex((item) => item.id === paymentItem.relatedInterestId);
        if (linkedIndex !== -1) return linkedIndex;
    }

    const paymentDate = paymentItem.date || '';
    const startIndex = paymentIndex > 0 ? paymentIndex - 1 : sales.length - 1;

    for (let index = startIndex; index >= 0; index -= 1) {
        const item = sales[index];
        if (item?.type !== TRANSACTION_TYPE_INTEREST) continue;
        if (item.relatedPaymentId && item.relatedPaymentId !== paymentItem.id) continue;
        if (paymentDate && item.date !== paymentDate) continue;
        if (!isAutomaticInterestTransaction(item)) continue;
        return index;
    }

    return -1;
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

function scheduleModalSaleAutosave() {
    scheduleFormAutosave(modalAddSaleForm, getModalSaleAutosaveSignature, isModalSaleAutosaveReady);
}

function schedulePaymentAutosave() {
    scheduleFormAutosave(paymentForm, getPaymentAutosaveSignature, isPaymentAutosaveReady);
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

function normalizeBarcode(value) {
    const normalizedBarcode = String(value || '').replace(/\s+/g, '').trim().toLowerCase();
    return /^0\d{12}$/.test(normalizedBarcode)
        ? normalizedBarcode.slice(1)
        : normalizedBarcode;
}

function findProductByBarcode(barcode) {
    const normalizedBarcode = normalizeBarcode(barcode);
    if (!normalizedBarcode) return null;
    return getSortedProducts().find((product) => (
        product.barcode && normalizeBarcode(product.barcode) === normalizedBarcode
    )) || null;
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
        .filter((product) => normalizeProductSearch([product.name, product.description, product.barcode].join(' ')).includes(search))
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
    searchInput.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') return;

        const scannedBarcode = normalizeBarcode(getProductSearchTerm(searchInput));
        if (!scannedBarcode) return;

        const product = findProductByBarcode(scannedBarcode);
        if (!product) return;

        event.preventDefault();
        if (appendSelectedProduct(searchInput, amountInput, product, 1)) {
            renderSaleItemsList(searchInput, listElement, amountInput);
            hideProductSuggestions(dropdown);
            showToast(`${product.name} adicionado.`, 'success');
        }
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

function setupProductCameraScanner(button, searchInput, amountInput, dropdown, listElement) {
    if (!button || !searchInput || !amountInput || !dropdown) return;

    button.addEventListener('click', async () => {
        await openBarcodeScanner({
            title: 'Ler produto',
            onDetected: (barcode) => {
                const product = findProductByBarcode(barcode);
                if (!product) {
                    searchInput.value = barcode;
                    searchInput.dispatchEvent(new Event('input', { bubbles: true }));
                    showToast('Codigo nao cadastrado. Cadastre o produto antes da venda.', 'error');
                    return;
                }

                if (appendSelectedProduct(searchInput, amountInput, product, 1)) {
                    renderSaleItemsList(searchInput, listElement, amountInput);
                    hideProductSuggestions(dropdown);
                    showToast(`${product.name} adicionado pela camera.`, 'success');
                    searchInput.focus();
                }
            }
        });
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

function getClientWhatsappName(client) {
    const customName = String(client?.whatsappName || '').trim();
    if (customName) return customName;
    return String(client?.name || '').trim();
}

function updateClientWhatsappNamePresentation(clientId = manager.currentClientId) {
    if (!clientWhatsappNameInput) return;

    const client = manager.clients[clientId];
    const customName = clientWhatsappNameInput.value.trim();
    const fallbackName = String(client?.name || '').trim();
    const messageName = customName || fallbackName;

    if (clientWhatsappNameCurrentValue) {
        clientWhatsappNameCurrentValue.textContent = customName
            ? 'Nome personalizado'
            : 'Nome cadastrado';
    }
    if (clientWhatsappNamePreview) {
        clientWhatsappNamePreview.textContent = messageName
            ? `Prévia: Olá, ${messageName} 😊`
            : 'Prévia: Olá! 😊';
    }
}

function syncClientWhatsappNameForm(clientId = manager.currentClientId) {
    if (!clientWhatsappNameForm || !clientWhatsappNameInput) return;

    const client = manager.clients[clientId];
    clientWhatsappNameInput.value = String(client?.whatsappName || '').trim();
    updateClientWhatsappNamePresentation(clientId);
}

function updateClientInterestFormPresentation() {
    if (!clientInterestModeInput || !clientInterestPercentInput) return;

    const mode = clientInterestModeInput.value;
    const globalSettings = manager.getOverdueInterestSettings();
    const parsedPercent = parseOverdueInterestPercent(clientInterestPercentInput.value);
    const customPercent = Number.isFinite(parsedPercent)
        ? normalizeOverdueInterestPercent(parsedPercent)
        : 0;

    clientInterestPercentInput.disabled = mode !== CLIENT_INTEREST_MODE_CUSTOM;
    clientInterestPercentInput.required = mode === CLIENT_INTEREST_MODE_CUSTOM;

    if (mode === CLIENT_INTEREST_MODE_CUSTOM) {
        if (clientInterestCurrentValue) {
            clientInterestCurrentValue.textContent = customPercent > 0
                ? `Individual: ${formatOverdueInterestPercent(customPercent)}`
                : 'Individual: informe a taxa';
        }
        if (clientInterestModeExplanation) {
            clientInterestModeExplanation.textContent = 'A taxa geral será ignorada para este cliente.';
        }
        return;
    }

    if (mode === CLIENT_INTEREST_MODE_DISABLED) {
        if (clientInterestCurrentValue) {
            clientInterestCurrentValue.textContent = 'Individual: sem juros';
        }
        if (clientInterestModeExplanation) {
            clientInterestModeExplanation.textContent = 'Este cliente não receberá juros, mesmo que a cobrança geral esteja ativa.';
        }
        return;
    }

    if (clientInterestCurrentValue) {
        clientInterestCurrentValue.textContent = globalSettings.enabled && globalSettings.percent > 0
            ? `Geral: ${formatOverdueInterestPercent(globalSettings.percent)}`
            : 'Geral: sem juros';
    }
    if (clientInterestModeExplanation) {
        clientInterestModeExplanation.textContent = globalSettings.enabled && globalSettings.percent > 0
            ? `Este cliente acompanha a taxa geral de ${formatOverdueInterestPercent(globalSettings.percent)}.`
            : 'Os juros gerais do sistema estão desativados.';
    }
}

function syncClientInterestSettingsForm(clientId = manager.currentClientId) {
    if (!clientInterestSettingsForm || !clientInterestModeInput || !clientInterestPercentInput) return;

    const clientOverride = manager.getClientOverdueInterestOverride(clientId);
    const globalSettings = manager.getOverdueInterestSettings();
    const mode = clientOverride?.mode || CLIENT_INTEREST_MODE_GLOBAL;

    clientInterestModeInput.value = mode;
    clientInterestPercentInput.value = mode === CLIENT_INTEREST_MODE_CUSTOM
        ? String(clientOverride.percent)
        : String(globalSettings.percent || 0);
    updateClientInterestFormPresentation();
}

function updateSearchFilterInteractivity() {
    const searchInput = document.getElementById('searchClients');
    const clientsSection = document.getElementById('clientsSection');
    const hasSearchTerm = (searchInput?.value || '').trim().length > 0;
    const isSearchFocused = document.activeElement === searchInput;
    const isSearchActive = hasSearchTerm || isSearchFocused;

    clientsSection?.classList.toggle('is-searching', isSearchActive);
    document.body.classList.toggle('client-search-active', isSearchActive);

    CLIENT_FILTER_IDS.forEach((id) => {
        const checkbox = document.getElementById(id);
        if (checkbox) {
            checkbox.disabled = hasSearchTerm;
        }
    });
}

function updateFiltersAccordionSummary() {
    const activeCount = CLIENT_FILTER_IDS.reduce((total, id) => {
        return total + (document.getElementById(id)?.checked ? 1 : 0);
    }, 0);

    if (filtersActiveSummary) {
        filtersActiveSummary.textContent = activeCount === 0
            ? 'Nenhum ativo'
            : `${activeCount} filtro${activeCount === 1 ? '' : 's'} ativo${activeCount === 1 ? '' : 's'}`;
    }
    filtersAccordion?.classList.toggle('has-active-filters', activeCount > 0);
}

function setFiltersAccordionExpanded(expanded) {
    if (!filtersAccordion || !filtersToggle || !filtersPanel) return;
    filtersAccordion.classList.toggle('is-expanded', expanded);
    filtersToggle.setAttribute('aria-expanded', String(expanded));
    filtersPanel.hidden = !expanded;
}

function initializeFiltersAccordion() {
    if (!filtersToggle || !filtersPanel) return;
    setFiltersAccordionExpanded(false);
    updateFiltersAccordionSummary();
    filtersToggle.addEventListener('click', () => {
        setFiltersAccordionExpanded(filtersToggle.getAttribute('aria-expanded') !== 'true');
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
    if (!changedCheckbox?.checked) {
        updateFiltersAccordionSummary();
        return;
    }

    CLIENT_FILTER_IDS.forEach((id) => {
        const checkbox = document.getElementById(id);
        if (checkbox && checkbox !== changedCheckbox) {
            checkbox.checked = false;
        }
    });
    updateFiltersAccordionSummary();
}

function getClientListModelFromSummary(summary, now = new Date()) {
    const interestSettings = manager.getOverdueInterestSettings(summary?.id);
    const debtModel = calculateSummaryDebt(summary, {
        overdueAlertDays: manager.getOverdueAlertDays(),
        interestEnabled: interestSettings.enabled,
        interestPercent: interestSettings.percent,
        now
    });
    const { isOverdue, overdueDays, interestCents, referenceTime } = debtModel;
    const referenceDate = referenceTime > 0 ? new Date(referenceTime) : null;
    const lastPaymentDate = summary?.referenceType === 'payment' ? referenceDate : null;
    const firstSaleDate = summary?.referenceType === 'first-sale' ? referenceDate : null;

    return {
        client: summary,
        id: summary?.id || '',
        name: summary?.name || '',
        searchName: (summary?.name || '').toLowerCase(),
        archived: Boolean(summary?.archived),
        debt: debtModel.totalDebtCents / 100,
        salesCount: Math.max(0, Math.round(Number(summary?.salesCount) || 0)),
        hasNotes: summary?.hasUnpricedNotes === true,
        isOverdue,
        overdueDays,
        overdueMessage: buildOverdueMessage({ lastPaymentDate, firstSaleDate, overdueDays }),
        interestCents,
        interestCycles: debtModel.interestCycles,
        interestPercent: interestSettings.percent,
        interestSource: interestSettings.source,
        interestMode: interestSettings.mode
    };
}

const CLIENT_LIST_PAGE_SIZE = 50;
let clientRenderLimit = CLIENT_LIST_PAGE_SIZE;

function resetClientRenderLimit() {
    clientRenderLimit = CLIENT_LIST_PAGE_SIZE;
}

// Atualizar lista de clientes
function updateClientsList() {
    const previews = manager.getClientPreviews();
    safeLog('Atualizando lista de clientes...', previews);
    const clientRows = previews.map((summary) => getClientListModelFromSummary(summary));

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
    clientsListDiv.removeAttribute('aria-busy');
    
    if (clientRows.length === 0) {
        clientsListDiv.innerHTML = '<p class="empty-message">Nenhum cliente encontrado.</p>';
        return;
    }
    
    const visibleClientRows = clientRows.slice(0, clientRenderLimit);
    const remainingClients = Math.max(0, clientRows.length - visibleClientRows.length);

    clientsListDiv.innerHTML = visibleClientRows.map(row => {
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
        let individualInterestBadge = '';
        
        if (isPaid) {
            statusClass = 'paid';
            statusIcon = '✓';
        } else if (isCredit) {
            statusClass = 'credit';
        }

        if (hasNotes) {
            noteIndicator = '<span class="note-indicator" title="Tem itens não contabilizados">📝</span>';
        }

        if (row.interestSource === 'individual') {
            individualInterestBadge = row.interestMode === CLIENT_INTEREST_MODE_DISABLED || row.interestPercent <= 0
                ? '<span class="client-interest-policy-badge is-disabled" title="Este cliente tem uma configuração individual sem cobrança de juros."><span aria-hidden="true">⊘</span> Sem juros</span>'
                : `<span class="client-interest-policy-badge" title="Taxa individual de ${formatOverdueInterestPercent(row.interestPercent)}. Os juros gerais são ignorados para este cliente."><span aria-hidden="true">★</span> Juros ${formatOverdueInterestPercent(row.interestPercent)}</span>`;
        }

        if (isOverdue) {
            const cyclesSuffix = formatInterestCyclesSuffix(row.interestCycles);
            const interestDetails = interestCents > 0
                ? ` · juros ${formatOverdueInterestPercent(row.interestPercent)}${cyclesSuffix}`
                : '';
            const overdueMsg = row.overdueMessage || 'Nunca realizou pagamento';
            const overdueTitle = interestCents > 0
                ? `${overdueMsg}. Juros: R$ ${formatCurrency(interestCents / 100)} (${formatOverdueInterestPercent(row.interestPercent)}${cyclesSuffix}${row.interestSource === 'individual' ? ' individual' : ''}).`
                : overdueMsg;
            overdueIndicator = `<span class="overdue-indicator" title="${overdueTitle}">⚠️ ${overdueMsg}${interestDetails}</span>`;
        }

        const archivedIndicator = client.archived ? '<span class="archived-badge" title="Cliente arquivado">📦 Arquivado</span>' : '';
        
        return `
            <div class="client-item ${hasNotes ? 'has-notes' : ''} ${client.archived ? 'archived' : ''}" data-client-id="${sanitizeHTML(client.id)}">
                <div class="client-info">
                    <div class="client-name">${sanitizeHTML(client.name)} ${noteIndicator} ${individualInterestBadge} ${archivedIndicator}</div>
                    ${overdueIndicator ? `<div class="client-overdue-msg">${overdueIndicator}</div>` : ''}
                    <div class="client-sales">${salesCount} venda${salesCount !== 1 ? 's' : ''} fiada${salesCount !== 1 ? 's' : ''}</div>
                </div>
                <div class="client-debt ${statusClass}">
                    <span class="client-debt-total">R$ ${formatCurrency(displayValue)} ${statusIcon}</span>
                    ${interestAmountInfo}
                </div>
            </div>
        `;
    }).join('') + (remainingClients > 0
        ? `<button class="btn btn-secondary clients-load-more" type="button" data-load-more-clients>
            Mostrar mais ${Math.min(CLIENT_LIST_PAGE_SIZE, remainingClients)} cliente${remainingClients === 1 ? '' : 's'}
        </button>`
        : '');

    if (!clientsListDiv.dataset.clickBound) {
        clientsListDiv.dataset.clickBound = 'true';
        clientsListDiv.addEventListener('click', async (event) => {
            const loadMoreButton = event.target.closest('[data-load-more-clients]');
            if (loadMoreButton) {
                clientRenderLimit += CLIENT_LIST_PAGE_SIZE;
                updateClientsList();
                return;
            }

            const item = event.target.closest('.client-item');
            if (!item || !clientsListDiv.contains(item)) return;

            const clientId = item.dataset.clientId;
            showLoader('Carregando cliente...');
            try {
                await manager.ensureClientLoaded(clientId);
                const shouldOpenUnpricedEditor = manager.hasUnpricedNotes(clientId);
                openClientModal(clientId, { openUnpricedEditor: shouldOpenUnpricedEditor });
            } catch (error) {
                showToast(getDatabaseErrorMessage(error, 'Erro ao carregar cliente.'), 'error');
            } finally {
                hideLoader();
            }
        });
    }
}

let requestedClientFromUrlHandled = false;

async function openRequestedClientFromUrl() {
    if (requestedClientFromUrlHandled) return;

    const url = new URL(window.location.href);
    const clientId = url.searchParams.get('client');
    if (!clientId) return;

    requestedClientFromUrlHandled = true;
    const requestedScreen = url.searchParams.get('screen');
    const screen = ['sale', 'payment', 'history', 'settings'].includes(requestedScreen)
        ? requestedScreen
        : 'sale';

    url.searchParams.delete('client');
    url.searchParams.delete('screen');
    window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);

    if (!manager.getClientPreview(clientId)) {
        showToast('Cliente não encontrado.', 'error');
        return;
    }

    showLoader('Carregando cliente...');
    try {
        await manager.ensureClientLoaded(clientId);
        openClientModal(clientId, { screen });
    } catch (error) {
        console.error('Erro ao abrir cliente solicitado:', error);
        showToast(getDatabaseErrorMessage(error, 'Erro ao abrir cliente.'), 'error');
    } finally {
        hideLoader();
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
    const whatsappName = getClientWhatsappName(client);
    const greeting = whatsappName ? `Olá, ${whatsappName} 😊` : 'Olá! 😊';

    // Gerar link para a página do cliente
    const baseUrl = window.location.origin + window.location.pathname.replace('index.html', '');
    const clientUrl = `${baseUrl}client-view.html?u=${encodeURIComponent(manager.userId)}&c=${encodeURIComponent(clientId)}`;

    // Mensagem para compartilhar (educada e breve)
    let message = '';
    if (isPaid) {
        message = `${greeting}\n\nSua conta está em dia! Obrigado pela confiança.\n\n🔗 Acompanhe seu histórico:\n${clientUrl}`;
    } else if (isCredit) {
        message = `${greeting}\n\nVocê tem um crédito a favor.\n\n🔗 Veja os detalhes:\n${clientUrl}`;
    } else {
        message = `${greeting}\n\nVocê tem um saldo pendente. Quando puder, ficarei grato se conseguir regularizar.\n\n🔗 Veja sua conta detalhada:\n${clientUrl}\n\nObrigado pela compreensão!`;
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

    const unpricedSales = client.sales.filter((sale) => resolveUnpricedItemsFlag(sale));

    if (unpricedSales.length === 0) return null;

    unpricedSales.sort((a, b) => new Date(b.date) - new Date(a.date));
    return unpricedSales[0].id;
}

function renderClientModalDebt(clientId) {
    const client = manager.clients[clientId];
    const modalDebtContainer = document.querySelector('.modal-debt');
    if (!client || !modalDebtContainer) return;

    const debt = manager.getClientDebt(clientId);
    const debtModel = manager.getClientDebtModel(clientId);
    const interestCents = debtModel.interestCents;
    const interestSettings = manager.getOverdueInterestSettings(clientId);
    const interestNote = interestCents > 0
        ? `<span class="modal-debt-note">Inclui juros ${interestSettings.source === 'individual' ? 'individuais ' : ''}de ${formatOverdueInterestPercent(interestSettings.percent)}${formatInterestCyclesSuffix(debtModel.interestCycles)} por atraso</span>`
        : '';
    const isCredit = debt < 0;
    const isPaid = debt === 0;

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
}

/**
 * Redesenha o que depende das vendas quando o cliente muda em outra sessao.
 * Nao reabre o modal para nao roubar o foco nem descartar o que o usuario
 * estiver digitando nos formularios.
 */
function refreshOpenClientModal(clientId) {
    if (!modal || modal.style.display !== 'block') return;
    if (manager.currentClientId !== clientId) return;

    const client = manager.clients[clientId];
    if (!client) return;

    const modalClientName = document.getElementById('modalClientName');
    if (modalClientName) modalClientName.textContent = client.name;
    renderClientModalDebt(clientId);
    renderClientSalesHistory(client);
    syncArchiveClientButton(client);
}

// Atualizar texto do botão de arquivar baseado no estado
function syncArchiveClientButton(client) {
    if (!archiveClientBtn) return;

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

// Histórico de vendas
function renderClientSalesHistory(client) {
    const salesHistory = document.getElementById('salesHistory');
    if (!salesHistory) return;

    const sales = client.sales || [];
    if (sales.length === 0) {
        salesHistory.innerHTML = '<p class="empty-message">Nenhuma venda registrada.</p>';
    } else {
        // Ordenar: anotações sem valor primeiro, depois por data (mais recente primeiro)
        const sortedSales = [...sales].sort((a, b) => {
            const aIsNote = resolveUnpricedItemsFlag(a);
            const bIsNote = resolveUnpricedItemsFlag(b);
            
            // Anotações sem valor sempre no topo
            if (aIsNote && !bIsNote) return -1;
            if (!aIsNote && bIsNote) return 1;
            
            // Se ambos são anotações ou ambos não são, ordenar por data
            return new Date(b.date) - new Date(a.date);
        });

        salesHistory.innerHTML = sortedSales.map(sale => {
            const isNote = resolveUnpricedItemsFlag(sale);
            const isPayment = sale.type === TRANSACTION_TYPE_PAYMENT;
            const isInterest = sale.type === TRANSACTION_TYPE_INTEREST;
            const canEditItem = !isInterest && !paymentHasInterestSplit(sale);
            const canDeleteItem = !isInterest;
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
            const editAction = canEditItem ? `
                    <button class="btn-icon btn-edit-sale" data-sale-id="${sale.id}" title="Editar" aria-label="Editar item">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                        </svg>
                    </button>
            ` : '';
            const deleteAction = canDeleteItem ? `
                    <button class="btn-icon btn-delete-sale" data-sale-id="${sale.id}" title="Excluir" aria-label="Excluir item">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                            <polyline points="3 6 5 6 21 6"/>
                            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                        </svg>
                    </button>
            ` : '';

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
                    ${editAction}
                    ${deleteAction}
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
}

function openClientModal(clientId, options = {}) {
    const client = manager.clients[clientId];
    if (!client) return;

    manager.currentClientId = clientId;
    renderClientModalDebt(clientId);

    // Usar textContent para prevenir XSS
    document.getElementById('modalClientName').textContent = client.name;

    if (editClientNameInput) {
        editClientNameInput.value = client.name;
    }

    renderClientSalesHistory(client);
    syncArchiveClientButton(client);

    syncClientWhatsappNameForm(clientId);
    syncClientInterestSettingsForm(clientId);
    setClientModalScreen(options.screen || 'sale');
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
    if (clientInterestSettingsForm) {
        clientInterestSettingsForm.reset();
    }
    if (clientWhatsappNameForm) {
        clientWhatsappNameForm.reset();
    }
    setClientModalScreen('sale');
    const nameSection = document.querySelector('.client-name-section');
    if (nameSection) {
        nameSection.style.display = 'flex';
    }
    // Sem o modal aberto ninguem acompanha o cliente: solta o listener e o
    // cache para que lista e resumos voltem a sair de `clientSummaries`.
    manager.releaseClientCaches();
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
    const relatedInterestWarning = paymentHasInterestSplit(sale)
        ? ' O juros automatico relacionado tambem sera excluido.'
        : '';
    const confirmed = await showConfirm(
        'Excluir Item',
        `Tem certeza que deseja excluir este ${type} de R$ ${formatCurrency(getSaleAmount(sale))}?${relatedInterestWarning}`
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
        const clientsList = document.getElementById('clientsListDiv');
        if (clientsList) {
            clientsList.setAttribute('aria-busy', 'true');
            clientsList.innerHTML = '<p class="empty-message">Carregando clientes...</p>';
        }
        hideLoadingScreen();
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

// Busca de clientes na lista
initializeFiltersAccordion();

if (searchClients) {
    const filterDebtOnlyCheckbox = document.getElementById('filterDebtOnly');
    const filterArchivedCheckbox = document.getElementById('filterArchived');
    const filterUnpricedCheckbox = document.getElementById('filterUnpriced');
    const filterOverdueCheckbox = document.getElementById('filterOverdue');

    const debouncedUpdateClientsList = debounce(updateClientsList, 250);

    searchClients.addEventListener('input', () => {
        resetClientRenderLimit();
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
            resetClientRenderLimit();
            applyExclusiveClientFilter(e.target);
            updateClientsList();
        });
    }
    
    if (filterUnpricedCheckbox) {
        filterUnpricedCheckbox.addEventListener('change', (e) => {
            resetClientRenderLimit();
            applyExclusiveClientFilter(e.target);
            updateClientsList();
        });
    }
    
    if (filterOverdueCheckbox) {
        filterOverdueCheckbox.addEventListener('change', (e) => {
            resetClientRenderLimit();
            applyExclusiveClientFilter(e.target);
            updateClientsList();
        });
    }
    
    if (filterArchivedCheckbox) {
        filterArchivedCheckbox.addEventListener('change', (e) => {
            resetClientRenderLimit();
            applyExclusiveClientFilter(e.target);
            updateClientsList();
        });
    }

    updateSearchFilterInteractivity();
}

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

clientWhatsappNameInput?.addEventListener('input', () => updateClientWhatsappNamePresentation());

clientWhatsappNameForm?.addEventListener('submit', async (event) => {
    event.preventDefault();

    const clientId = manager.currentClientId;
    if (!clientId || !manager.clients[clientId]) {
        showToast('Nenhum cliente selecionado.', 'error');
        return;
    }

    const customName = clientWhatsappNameInput?.value || '';
    if (customName.trim().length > 100) {
        showToast('O nome usado no WhatsApp não pode ter mais de 100 caracteres.', 'error');
        clientWhatsappNameInput?.focus();
        return;
    }

    if (!beginFormSubmission(clientWhatsappNameForm)) return;

    showLoader('Salvando nome...');
    try {
        const savedName = await manager.setClientWhatsappName(clientId, customName);
        syncClientWhatsappNameForm(clientId);
        hideLoader();
        showToast(
            savedName
                ? 'Nome usado no WhatsApp salvo.'
                : 'A mensagem usará o nome cadastrado do cliente.',
            'success'
        );
    } catch (error) {
        hideLoader();
        console.error('Erro ao salvar nome usado no WhatsApp:', error);
        showToast(getDatabaseErrorMessage(error, error.message || 'Erro ao salvar nome usado no WhatsApp.'), 'error');
        syncClientWhatsappNameForm(clientId);
    } finally {
        finishFormSubmission(clientWhatsappNameForm);
    }
});

clientInterestModeInput?.addEventListener('change', () => {
    if (clientInterestModeInput.value === CLIENT_INTEREST_MODE_CUSTOM) {
        const currentPercent = parseOverdueInterestPercent(clientInterestPercentInput?.value);
        if (!Number.isFinite(currentPercent) || currentPercent <= 0) {
            const globalPercent = manager.getOverdueInterestPercent();
            clientInterestPercentInput.value = globalPercent > 0 ? String(globalPercent) : '';
        }
    }

    updateClientInterestFormPresentation();
    if (!clientInterestPercentInput?.disabled) {
        clientInterestPercentInput.focus();
        clientInterestPercentInput.select();
    }
});

clientInterestPercentInput?.addEventListener('input', updateClientInterestFormPresentation);

clientInterestSettingsForm?.addEventListener('submit', async (event) => {
    event.preventDefault();

    const clientId = manager.currentClientId;
    if (!clientId || !manager.clients[clientId]) {
        showToast('Nenhum cliente selecionado.', 'error');
        return;
    }

    const mode = clientInterestModeInput?.value || CLIENT_INTEREST_MODE_GLOBAL;
    const rawPercent = clientInterestPercentInput?.value || '';
    const numericPercent = parseOverdueInterestPercent(rawPercent);

    if (
        mode === CLIENT_INTEREST_MODE_CUSTOM
        && (!Number.isFinite(numericPercent) || numericPercent <= 0 || numericPercent > MAX_OVERDUE_INTEREST_PERCENT)
    ) {
        showToast(`Informe um percentual maior que 0 e até ${MAX_OVERDUE_INTEREST_PERCENT}%.`, 'error');
        clientInterestPercentInput?.focus();
        return;
    }

    if (!beginFormSubmission(clientInterestSettingsForm)) return;

    showLoader('Salvando juros...');
    try {
        const effectiveSettings = await manager.setClientOverdueInterestOverride(clientId, mode, numericPercent);
        syncClientInterestSettingsForm(clientId);
        renderClientModalDebt(clientId);
        updateClientsList();
        hideLoader();

        const successMessage = effectiveSettings.source === 'global'
            ? 'Cliente configurado para usar os juros gerais.'
            : effectiveSettings.enabled
                ? `Juros individuais de ${formatOverdueInterestPercent(effectiveSettings.percent)} salvos.`
                : 'Juros desativados para este cliente.';
        showToast(successMessage, 'success');
    } catch (error) {
        hideLoader();
        console.error('Erro ao salvar juros do cliente:', error);
        showToast(getDatabaseErrorMessage(error, error.message || 'Erro ao salvar juros do cliente.'), 'error');
        syncClientInterestSettingsForm(clientId);
    } finally {
        finishFormSubmission(clientInterestSettingsForm);
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
        const existingClient = manager.getClientPreviews().find(
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

// Indicador de conexão baseado no canal já aberto pelo Firebase
(function initOfflineIndicator() {
    const banner = document.getElementById('offlineBanner');
    if (!banner) return;

    let wasOffline = false;

    function setOnline() {
        banner.style.display = 'none';
        if (wasOffline) {
            showToast('Conexão restaurada!', 'success');
            wasOffline = false;
        }
    }

    function setOffline() {
        banner.style.display = 'flex';
        wasOffline = true;
    }

    onValue(ref(database, '.info/connected'), (snapshot) => {
        if (snapshot.val() === true) setOnline();
        else setOffline();
    });

    window.addEventListener('offline', setOffline);
})();

// Inicializar (os dados serão carregados automaticamente pelo listener do Firebase)
