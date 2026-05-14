import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js';
import { getDatabase, ref, onValue, push, set, update, remove, get } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js';
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

const MAX_PRICE = 1000000;
const MAX_NAME_LENGTH = 100;
const MAX_DESCRIPTION_LENGTH = 240;
const SEARCH_DEBOUNCE_MS = 160;
const currencyFormatter = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const productForm = document.getElementById('productForm');
const productIdInput = document.getElementById('productId');
const productNameInput = document.getElementById('productName');
const productPriceInput = document.getElementById('productPrice');
const productDescriptionInput = document.getElementById('productDescription');
const saveProductBtn = document.getElementById('saveProductBtn');
const cancelProductEdit = document.getElementById('cancelProductEdit');
const productsStatus = document.getElementById('productsStatus');
const productsSearch = document.getElementById('productsSearch');
const productsList = document.getElementById('productsList');
const productsCount = document.getElementById('productsCount');
const themeToggle = document.getElementById('themeToggle');
const productsMenu = document.getElementById('productsMenu');
const productsMenuOverlay = document.getElementById('productsMenuOverlay');
const productsMenuToggle = document.getElementById('productsMenuToggle');
const productsMenuClose = document.getElementById('productsMenuClose');
const productsMenuThemeShortcut = document.getElementById('productsMenuThemeShortcut');

let currentUserId = null;
let productsUnsubscribe = null;
let products = {};
let isSaving = false;

function debounce(callback, delay) {
    let timeoutId = null;
    return (...args) => {
        window.clearTimeout(timeoutId);
        timeoutId = window.setTimeout(() => callback(...args), delay);
    };
}

function normalizeSearchText(value) {
    return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

function sanitizeHTML(value) {
    const div = document.createElement('div');
    div.textContent = String(value || '');
    return div.innerHTML;
}

function parseCurrency(value) {
    const normalized = String(value || '').replace(/\s/g, '').replace('R$', '').replace(/\./g, '').replace(',', '.');
    return Number.parseFloat(normalized);
}

function formatCurrency(value) {
    const numericValue = Number(value);
    if (!Number.isFinite(numericValue)) return '0,00';
    const roundedValue = Math.round((numericValue + Number.EPSILON) * 100) / 100;
    return currencyFormatter.format(Object.is(roundedValue, -0) ? 0 : roundedValue);
}

function applyCurrencyMask(input) {
    input?.addEventListener('input', (event) => {
        let value = event.target.value.replace(/\D/g, '');
        if (!value) {
            event.target.value = '';
            return;
        }
        value = (Number.parseInt(value, 10) / 100).toFixed(2);
        event.target.value = `R$ ${formatCurrency(value)}`;
    });
}

function setStatus(message, type = 'neutral') {
    if (!productsStatus) return;
    productsStatus.textContent = message;
    productsStatus.dataset.status = type;
}

function setFormDisabled(disabled) {
    isSaving = disabled;
    [productNameInput, productPriceInput, productDescriptionInput, saveProductBtn, cancelProductEdit]
        .forEach((element) => {
            if (element) element.disabled = disabled;
        });
}

function getProductsRef() {
    if (!currentUserId) throw new Error('Usuario nao autenticado');
    return ref(database, `users/${currentUserId}/products`);
}

function getProductRef(productId) {
    if (!currentUserId || !productId) throw new Error('Produto invalido');
    return ref(database, `users/${currentUserId}/products/${productId}`);
}

function getSortedProducts() {
    return Object.entries(products || {})
        .map(([id, product]) => ({ id, ...product }))
        .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'pt-BR'));
}

function getFilteredProducts() {
    const search = normalizeSearchText(productsSearch?.value || '');

    return getSortedProducts().filter((product) => {
        if (!search) return true;
        const haystack = normalizeSearchText([product.name, product.description].join(' '));
        return haystack.includes(search);
    });
}

function resetProductForm() {
    productForm.reset();
    productIdInput.value = '';
    saveProductBtn.textContent = 'Salvar produto';
    cancelProductEdit.hidden = true;
}

function buildProductPayload() {
    const name = productNameInput.value.trim();
    const price = parseCurrency(productPriceInput.value);
    const description = productDescriptionInput.value.trim();

    if (!name) throw new Error('Informe o nome do produto.');
    if (name.length < 2) throw new Error('O nome do produto deve ter pelo menos 2 caracteres.');
    if (name.length > MAX_NAME_LENGTH) throw new Error(`O nome nao pode ter mais que ${MAX_NAME_LENGTH} caracteres.`);
    if (!Number.isFinite(price) || price <= 0) throw new Error('Informe um valor valido maior que zero.');
    if (price > MAX_PRICE) throw new Error('O valor nao pode ser maior que R$ 1.000.000,00.');
    if (description.length > MAX_DESCRIPTION_LENGTH) throw new Error(`A descricao nao pode ter mais que ${MAX_DESCRIPTION_LENGTH} caracteres.`);

    return {
        name,
        price: Math.round((price + Number.EPSILON) * 100) / 100,
        stock: null,
        sku: '',
        description,
        active: true,
        updatedAt: new Date().toISOString()
    };
}

function assertUniqueProductName(name, editingId) {
    const normalizedName = normalizeSearchText(name);
    const duplicated = getSortedProducts().some((product) => (
        product.id !== editingId && normalizeSearchText(product.name) === normalizedName
    ));
    if (duplicated) throw new Error('Ja existe um produto com este nome.');
}

async function saveProduct() {
    if (!currentUserId || isSaving) return;

    const editingId = productIdInput.value || '';
    const payload = buildProductPayload();
    assertUniqueProductName(payload.name, editingId);

    setFormDisabled(true);
    setStatus(editingId ? 'Atualizando produto...' : 'Salvando produto...');

    try {
        let savedRef = null;
        if (editingId) {
            savedRef = getProductRef(editingId);
            await update(savedRef, payload);
        } else {
            savedRef = push(getProductsRef());
            await set(savedRef, { ...payload, createdAt: payload.updatedAt });
        }

        const savedSnapshot = await get(savedRef);
        if (!savedSnapshot.exists()) throw new Error('Produto nao confirmado no Firebase.');

        setStatus(editingId ? 'Produto atualizado com sucesso.' : 'Produto cadastrado com sucesso.', 'success');
        resetProductForm();
    } catch (error) {
        console.error('Erro ao salvar produto:', error);
        setStatus(error.message || 'Erro ao salvar produto. Tente novamente.', 'error');
    } finally {
        setFormDisabled(false);
    }
}

async function deleteProduct(productId) {
    const product = products[productId];
    if (!product) return;

    if (!window.confirm(`Excluir o produto "${product.name}"?`)) return;

    try {
        await remove(getProductRef(productId));
        if (productIdInput.value === productId) resetProductForm();
        setStatus('Produto excluido com sucesso.', 'success');
    } catch (error) {
        console.error('Erro ao excluir produto:', error);
        setStatus('Erro ao excluir produto. Tente novamente.', 'error');
    }
}

function editProduct(productId) {
    const product = products[productId];
    if (!product) return;

    productIdInput.value = productId;
    productNameInput.value = product.name || '';
    productPriceInput.value = `R$ ${formatCurrency(product.price)}`;
    productDescriptionInput.value = product.description || '';
    saveProductBtn.textContent = 'Atualizar produto';
    cancelProductEdit.hidden = false;
    document.querySelector('.products-form-card')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderProducts() {
    if (!productsList) return;

    const filteredProducts = getFilteredProducts();
    const allProducts = getSortedProducts();
    const totalProducts = allProducts.length;

    if (productsCount) {
        productsCount.textContent = `${filteredProducts.length} de ${totalProducts} produto${totalProducts === 1 ? '' : 's'}`;
    }

    if (totalProducts === 0) {
        productsList.innerHTML = '<p class="empty-message">Nenhum produto cadastrado ainda.</p>';
        setStatus('Cadastre seu primeiro produto para reutilizar nas vendas.', 'neutral');
        return;
    }

    if (filteredProducts.length === 0) {
        productsList.innerHTML = '<p class="empty-message">Nenhum produto encontrado.</p>';
        setStatus(`${totalProducts} produto${totalProducts === 1 ? '' : 's'} no cadastro.`, 'success');
        return;
    }

    productsList.innerHTML = filteredProducts.map((product) => {
        return `
            <article class="product-item" data-product-id="${sanitizeHTML(product.id)}">
                <div class="product-item-main">
                    <div class="product-title-row">
                        <h3>${sanitizeHTML(product.name)}</h3>
                        <span class="product-price">R$ ${formatCurrency(product.price)}</span>
                    </div>
                    ${product.description ? `<p class="product-description">${sanitizeHTML(product.description)}</p>` : ''}
                </div>
                <div class="product-actions">
                    <button class="btn btn-secondary btn-product-edit" type="button" data-action="edit" data-product-id="${sanitizeHTML(product.id)}">Editar</button>
                    <button class="btn btn-danger btn-product-delete" type="button" data-action="delete" data-product-id="${sanitizeHTML(product.id)}">Excluir</button>
                </div>
            </article>
        `;
    }).join('');

    setStatus(`${totalProducts} produto${totalProducts === 1 ? '' : 's'} no cadastro.`, 'success');
}

function subscribeProducts(userId) {
    if (productsUnsubscribe) productsUnsubscribe();
    setStatus('Carregando produtos...');

    productsUnsubscribe = onValue(ref(database, `users/${userId}/products`), (snapshot) => {
        products = snapshot.val() || {};
        renderProducts();
    }, (error) => {
        console.error('Erro ao carregar produtos:', error);
        products = {};
        productsList.innerHTML = '<p class="empty-message">Nao foi possivel carregar os produtos.</p>';
        setStatus('Erro ao carregar produtos. Verifique sua conexao.', 'error');
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
    themeToggle?.addEventListener('click', toggleTheme);
    productsMenuThemeShortcut?.addEventListener('click', toggleTheme);
}

function setProductsMenuOpen(isOpen) {
    if (!productsMenu || !productsMenuOverlay || !productsMenuToggle) return;
    productsMenu.classList.toggle('open', isOpen);
    document.body.classList.toggle('menu-open', isOpen);
    productsMenu.setAttribute('aria-hidden', String(!isOpen));
    productsMenuOverlay.hidden = !isOpen;
    productsMenuToggle.setAttribute('aria-expanded', String(isOpen));
}

function setupProductsMenu() {
    if (!productsMenu || !productsMenuOverlay || !productsMenuToggle || !productsMenuClose) return;
    productsMenuToggle.addEventListener('click', () => setProductsMenuOpen(true));
    productsMenuClose.addEventListener('click', () => setProductsMenuOpen(false));
    productsMenuOverlay.addEventListener('click', () => setProductsMenuOpen(false));
    document.querySelectorAll('.app-menu-link').forEach((link) => link.addEventListener('click', () => setProductsMenuOpen(false)));
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') setProductsMenuOpen(false);
    });
    window.addEventListener('resize', () => setProductsMenuOpen(false));
}

productForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
        await saveProduct();
    } catch (error) {
        setStatus(error.message || 'Verifique os dados do produto.', 'error');
    }
});

cancelProductEdit?.addEventListener('click', resetProductForm);
productsSearch?.addEventListener('input', debounce(renderProducts, SEARCH_DEBOUNCE_MS));
productsList?.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    const productId = button.dataset.productId;
    if (button.dataset.action === 'edit') editProduct(productId);
    if (button.dataset.action === 'delete') deleteProduct(productId);
});

applyCurrencyMask(productPriceInput);
setupThemeToggle();
setupProductsMenu();

onAuthStateChanged(auth, (user) => {
    if (!user) {
        if (productsUnsubscribe) productsUnsubscribe();
        window.location.href = './index.html';
        return;
    }
    currentUserId = user.uid;
    subscribeProducts(user.uid);
});
