import { getAuth, onAuthStateChanged, signInWithEmailAndPassword } from 'firebase/auth';
import { firebaseApp } from './firebase.js';

const APP_VERSION = '2.4.7';
const DASHBOARD_APP_URL = `./app.min.js?v=${APP_VERSION}`;
const auth = getAuth(firebaseApp);
const loginScreen = document.getElementById('loginScreen');
const loginForm = document.getElementById('loginForm');
const loadingScreen = document.getElementById('loadingScreen');
let dashboardPromise = null;

function preloadDashboardModule() {
    if (document.querySelector('link[data-dashboard-preload]')) return;
    const preload = document.createElement('link');
    preload.rel = 'modulepreload';
    preload.href = DASHBOARD_APP_URL;
    preload.dataset.dashboardPreload = 'true';
    document.head.appendChild(preload);
}

function loadDashboardStyles() {
    const existingStylesheet = document.querySelector('link[data-dashboard-styles]');
    if (existingStylesheet) return Promise.resolve();

    return new Promise((resolve, reject) => {
        const stylesheet = document.createElement('link');
        stylesheet.rel = 'stylesheet';
        stylesheet.href = './home.min.css?v=2.4.7';
        stylesheet.dataset.dashboardStyles = 'true';
        stylesheet.addEventListener('load', resolve, { once: true });
        stylesheet.addEventListener('error', () => reject(new Error('Falha ao carregar os estilos do painel.')), { once: true });
        document.head.appendChild(stylesheet);
    });
}

function finishInitialLoading() {
    if (!loadingScreen) return;
    loadingScreen.classList.add('hidden');
    document.body.classList.remove('loading');
    document.body.classList.add('loaded');
    window.setTimeout(() => {
        loadingScreen.style.display = 'none';
    }, 300);
}

async function hydrateDashboard() {
    if (document.getElementById('appScreen')) return;
    const mount = document.getElementById('dashboardMount');
    if (!mount) throw new Error('Ponto de montagem da aplicação não encontrado.');

    const response = await fetch('./dashboard.html?v=2.4.7');
    if (!response.ok) throw new Error(`Falha ao carregar a interface (${response.status}).`);
    const markup = await response.text();
    const fragment = document.createRange().createContextualFragment(markup);
    mount.replaceWith(fragment);
}

async function loadDashboard() {
    if (!dashboardPromise) {
        preloadDashboardModule();
        dashboardPromise = Promise.all([hydrateDashboard(), loadDashboardStyles()])
            .then(() => import(DASHBOARD_APP_URL))
            .catch((error) => {
            dashboardPromise = null;
            throw error;
            });
    }
    return dashboardPromise;
}

function showLoginError(error) {
    let message = 'Erro ao fazer login.';
    if (error?.code === 'auth/user-not-found' || error?.code === 'auth/wrong-password' || error?.code === 'auth/invalid-credential') {
        message = 'Email ou senha incorretos.';
    } else if (error?.code === 'auth/invalid-email') {
        message = 'Email inválido.';
    } else if (error?.code === 'auth/too-many-requests') {
        message = 'Muitas tentativas. Aguarde e tente novamente.';
    } else if (error?.code === 'auth/network-request-failed') {
        message = 'Sem conexão. Verifique sua internet.';
    }

    let messageElement = document.getElementById('loginError');
    if (!messageElement) {
        messageElement = document.createElement('p');
        messageElement.id = 'loginError';
        messageElement.className = 'login-error';
        messageElement.setAttribute('role', 'alert');
        loginForm?.prepend(messageElement);
    }
    messageElement.textContent = message;
}

const loginVersion = document.getElementById('loginVersion');
if (loginVersion) loginVersion.textContent = `Versão ${APP_VERSION}`;

document.getElementById('togglePassword')?.addEventListener('click', (event) => {
    const passwordInput = document.getElementById('loginPassword');
    const toggleButton = event.currentTarget;
    const shouldShow = passwordInput?.type === 'password';
    if (!passwordInput) return;
    passwordInput.type = shouldShow ? 'text' : 'password';
    toggleButton.querySelector('.eye-icon').textContent = shouldShow ? '🙈' : '👁️';
    toggleButton.setAttribute('aria-label', shouldShow ? 'Ocultar senha' : 'Mostrar senha');
});

loginForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const submitButton = loginForm.querySelector('button[type="submit"]');
    const email = document.getElementById('loginEmail').value;
    const password = document.getElementById('loginPassword').value;
    document.getElementById('loginError')?.remove();
    submitButton.disabled = true;
    submitButton.textContent = 'Entrando...';

    try {
        await signInWithEmailAndPassword(auth, email, password);
    } catch (error) {
        showLoginError(error);
    } finally {
        submitButton.disabled = false;
        submitButton.textContent = 'Entrar';
    }
});

onAuthStateChanged(auth, async (user) => {
    if (!user) {
        if (loginScreen) loginScreen.style.display = 'flex';
        finishInitialLoading();
        return;
    }

    if (loginScreen) loginScreen.style.display = 'none';
    try {
        await loadDashboard();
    } catch (error) {
        console.error('Falha ao carregar o painel:', error);
        if (loginScreen) loginScreen.style.display = 'flex';
        showLoginError({ code: 'app/dashboard-load-failed' });
        finishInitialLoading();
    }
});

if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js').catch((error) => {
            console.warn('Service Worker indisponível:', error);
        });
    }, { once: true });
}
