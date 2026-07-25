const ZXING_MODULE_URL = 'https://cdn.jsdelivr.net/npm/@zxing/browser@0.2.0/+esm';
const NATIVE_SCAN_INTERVAL_MS = 75;
const CANDIDATE_CONFIRMATION_WINDOW_MS = 2500;
const PRODUCT_BARCODE_FORMATS = [
    'ean_13',
    'ean_8',
    'upc_a',
    'upc_e',
    'code_128',
    'code_39',
    'code_93',
    'itf',
    'codabar'
];

let scannerElements = null;
let scannerSession = null;
let zxingModulePromise = null;

function createScannerElements() {
    if (scannerElements) return scannerElements;

    const root = document.createElement('div');
    root.id = 'barcodeScannerModal';
    root.className = 'barcode-scanner-modal';
    root.hidden = true;
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-labelledby', 'barcodeScannerTitle');
    root.innerHTML = `
        <div class="barcode-scanner-panel">
            <div class="barcode-scanner-header">
                <div>
                    <h2 id="barcodeScannerTitle">Ler codigo de barras</h2>
                    <p>Aponte a camera traseira para o codigo.</p>
                </div>
                <button class="barcode-scanner-close" type="button" aria-label="Fechar leitor">&times;</button>
            </div>
            <div class="barcode-camera-stage">
                <video class="barcode-camera-video" playsinline muted aria-label="Visualizacao da camera"></video>
                <div class="barcode-camera-guide" aria-hidden="true">
                    <span class="barcode-camera-line"></span>
                </div>
            </div>
            <p class="barcode-scanner-status" role="status" aria-live="polite">Preparando camera...</p>
            <div class="barcode-scanner-actions">
                <button class="btn btn-secondary barcode-torch-button" type="button" hidden aria-pressed="false">
                    &#128294; Ligar lanterna
                </button>
                <button class="btn btn-secondary barcode-cancel-button" type="button">Cancelar</button>
            </div>
        </div>
    `;
    document.body.appendChild(root);

    scannerElements = {
        root,
        panel: root.querySelector('.barcode-scanner-panel'),
        title: root.querySelector('#barcodeScannerTitle'),
        video: root.querySelector('.barcode-camera-video'),
        status: root.querySelector('.barcode-scanner-status'),
        closeButton: root.querySelector('.barcode-scanner-close'),
        cancelButton: root.querySelector('.barcode-cancel-button'),
        torchButton: root.querySelector('.barcode-torch-button')
    };

    scannerElements.closeButton.addEventListener('click', () => closeBarcodeScanner());
    scannerElements.cancelButton.addEventListener('click', () => closeBarcodeScanner());
    scannerElements.torchButton.addEventListener('click', toggleTorch);
    root.addEventListener('click', (event) => {
        if (event.target === root) closeBarcodeScanner();
    });
    document.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape' || !scannerSession?.active) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        closeBarcodeScanner();
    }, true);
    document.addEventListener('visibilitychange', () => {
        if (document.hidden && scannerSession?.active) closeBarcodeScanner();
    });
    window.addEventListener('pagehide', () => {
        if (scannerSession?.active) closeBarcodeScanner();
    });

    return scannerElements;
}

function setScannerStatus(message, type = 'neutral') {
    const elements = createScannerElements();
    elements.status.textContent = message;
    elements.status.dataset.status = type;
}

function getCameraErrorMessage(error) {
    if (!window.isSecureContext) {
        return 'A camera exige uma conexao segura (HTTPS).';
    }
    if (error?.name === 'NotAllowedError' || error?.name === 'SecurityError') {
        return 'Permita o acesso a camera para ler o codigo de barras.';
    }
    if (error?.name === 'NotFoundError' || error?.name === 'DevicesNotFoundError') {
        return 'Nenhuma camera foi encontrada neste aparelho.';
    }
    if (error?.name === 'NotReadableError' || error?.name === 'TrackStartError') {
        return 'A camera esta sendo usada por outro aplicativo.';
    }
    if (error?.name === 'OverconstrainedError') {
        return 'A camera nao oferece uma configuracao compativel.';
    }
    return 'Nao foi possivel iniciar a camera. Tente novamente.';
}

async function getOptimizedCameraStream() {
    if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error('CAMERA_UNSUPPORTED');
    }

    const constraints = {
        audio: false,
        video: {
            facingMode: { ideal: 'environment' },
            width: { ideal: 1280, max: 1920 },
            height: { ideal: 720, max: 1080 },
            frameRate: { ideal: 30, max: 30 }
        }
    };

    let stream;
    try {
        stream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (error) {
        if (error?.name !== 'OverconstrainedError') throw error;
        stream = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: { facingMode: { ideal: 'environment' } }
        });
    }

    const [track] = stream.getVideoTracks();
    if (!track) return stream;

    try {
        const capabilities = track.getCapabilities?.() || {};
        const advanced = [];
        if (Array.isArray(capabilities.focusMode) && capabilities.focusMode.includes('continuous')) {
            advanced.push({ focusMode: 'continuous' });
        }
        if (advanced.length) await track.applyConstraints({ advanced });
    } catch (error) {
        console.debug('Foco continuo nao disponivel:', error);
    }

    return stream;
}

function updateTorchAvailability(track) {
    const elements = createScannerElements();
    const capabilities = track?.getCapabilities?.() || {};
    const hasTorch = capabilities.torch === true;
    elements.torchButton.hidden = !hasTorch;
    elements.torchButton.setAttribute('aria-pressed', 'false');
    elements.torchButton.innerHTML = '&#128294; Ligar lanterna';
}

async function toggleTorch() {
    const session = scannerSession;
    const track = session?.stream?.getVideoTracks?.()[0];
    if (!session?.active || !track) return;

    const nextState = !session.torchEnabled;
    try {
        await track.applyConstraints({ advanced: [{ torch: nextState }] });
        session.torchEnabled = nextState;
        scannerElements.torchButton.setAttribute('aria-pressed', String(nextState));
        scannerElements.torchButton.innerHTML = nextState
            ? '&#128294; Desligar lanterna'
            : '&#128294; Ligar lanterna';
    } catch (error) {
        setScannerStatus('A lanterna nao esta disponivel nesta camera.', 'error');
    }
}

function scheduleNativeFrame(session, callback) {
    if (!session.active) return;
    const video = scannerElements.video;
    if (typeof video.requestVideoFrameCallback === 'function') {
        session.frameCallbackType = 'video';
        session.frameCallbackId = video.requestVideoFrameCallback(callback);
    } else {
        session.frameCallbackType = 'animation';
        session.frameCallbackId = window.requestAnimationFrame(callback);
    }
}

function cancelNativeFrame(session) {
    if (!session?.frameCallbackId) return;
    if (session.frameCallbackType === 'video' && typeof scannerElements.video.cancelVideoFrameCallback === 'function') {
        scannerElements.video.cancelVideoFrameCallback(session.frameCallbackId);
    } else {
        window.cancelAnimationFrame(session.frameCallbackId);
    }
    session.frameCallbackId = null;
}

function normalizeDetectedValue(value) {
    return String(value || '').replace(/\s+/g, '').trim();
}

function confirmCandidate(session, value) {
    if (!session.active || session.resultLocked) return;

    const normalizedValue = normalizeDetectedValue(value);
    if (!normalizedValue) return;

    const now = Date.now();
    const isRepeatedCandidate = (
        session.candidateValue === normalizedValue
        && now - session.candidateSeenAt <= CANDIDATE_CONFIRMATION_WINDOW_MS
    );

    if (!isRepeatedCandidate) {
        session.candidateValue = normalizedValue;
        session.candidateCount = 1;
        session.candidateSeenAt = now;
        setScannerStatus('Codigo encontrado. Confirmando leitura...', 'detecting');
        return;
    }

    session.candidateCount += 1;
    session.candidateSeenAt = now;
    if (session.candidateCount < 2) return;

    finishSuccessfulScan(session, normalizedValue);
}

async function finishSuccessfulScan(session, value) {
    if (!session.active || session.resultLocked) return;
    session.resultLocked = true;
    setScannerStatus('Codigo lido com sucesso.', 'success');
    scannerElements.panel.classList.add('barcode-scan-success');

    try {
        navigator.vibrate?.(80);
    } catch (error) {
        // Vibracao e apenas um feedback opcional.
    }

    window.setTimeout(async () => {
        const callback = session.onDetected;
        closeBarcodeScanner();
        try {
            await callback(value);
        } catch (error) {
            console.error('Erro ao processar codigo de barras:', error);
        }
    }, 120);
}

async function startNativeScanner(session) {
    const supportedFormats = await window.BarcodeDetector.getSupportedFormats();
    const selectedFormats = PRODUCT_BARCODE_FORMATS.filter((format) => supportedFormats.includes(format));
    if (!selectedFormats.length) throw new Error('NATIVE_FORMATS_UNSUPPORTED');

    const detector = new window.BarcodeDetector({ formats: selectedFormats });
    session.detector = detector;
    session.lastNativeScanAt = 0;

    const scanFrame = async (now = 0) => {
        if (!session.active) return;

        if (
            session.nativeScanInProgress
            || scannerElements.video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA
            || now - session.lastNativeScanAt < NATIVE_SCAN_INTERVAL_MS
        ) {
            scheduleNativeFrame(session, scanFrame);
            return;
        }

        session.nativeScanInProgress = true;
        session.lastNativeScanAt = now;
        try {
            const results = await detector.detect(scannerElements.video);
            if (results.length) confirmCandidate(session, results[0].rawValue);
        } catch (error) {
            if (error?.name !== 'InvalidStateError') {
                console.debug('Falha temporaria na leitura nativa:', error);
            }
        } finally {
            session.nativeScanInProgress = false;
            scheduleNativeFrame(session, scanFrame);
        }
    };

    setScannerStatus('Aponte para o codigo e mantenha o aparelho firme.', 'scanning');
    scheduleNativeFrame(session, scanFrame);
}

async function loadZxingModule() {
    if (!zxingModulePromise) {
        zxingModulePromise = import(ZXING_MODULE_URL).catch((error) => {
            zxingModulePromise = null;
            throw error;
        });
    }
    return zxingModulePromise;
}

async function startFallbackScanner(session) {
    setScannerStatus('Preparando leitor compativel...', 'loading');
    const { BrowserMultiFormatOneDReader, BarcodeFormat } = await loadZxingModule();
    if (!session.active) return;

    const reader = new BrowserMultiFormatOneDReader(undefined, {
        delayBetweenScanAttempts: 70,
        delayBetweenScanSuccess: 70,
        tryPlayVideoTimeout: 5000
    });
    reader.possibleFormats = [
        BarcodeFormat.EAN_13,
        BarcodeFormat.EAN_8,
        BarcodeFormat.UPC_A,
        BarcodeFormat.UPC_E,
        BarcodeFormat.CODE_128,
        BarcodeFormat.CODE_39,
        BarcodeFormat.CODE_93,
        BarcodeFormat.ITF,
        BarcodeFormat.CODABAR
    ];
    session.zxingReader = reader;

    session.zxingControls = await reader.decodeFromStream(
        session.stream,
        scannerElements.video,
        (result) => {
            if (result) confirmCandidate(session, result.getText());
        }
    );
    setScannerStatus('Aponte para o codigo e mantenha o aparelho firme.', 'scanning');
}

async function canUseNativeBarcodeDetector() {
    return (
        'BarcodeDetector' in window
        && typeof window.BarcodeDetector.getSupportedFormats === 'function'
    );
}

export async function openBarcodeScanner({ onDetected, title = 'Ler codigo de barras' } = {}) {
    if (typeof onDetected !== 'function') {
        throw new Error('Informe como o codigo lido deve ser processado.');
    }

    if (scannerSession?.active) closeBarcodeScanner();

    const elements = createScannerElements();
    const previousFocus = document.activeElement;
    const session = {
        active: true,
        onDetected,
        previousFocus,
        stream: null,
        zxingControls: null,
        frameCallbackId: null,
        torchEnabled: false,
        resultLocked: false,
        candidateValue: '',
        candidateCount: 0,
        candidateSeenAt: 0
    };
    scannerSession = session;

    elements.title.textContent = title;
    elements.root.hidden = false;
    elements.panel.classList.remove('barcode-scan-success');
    elements.torchButton.hidden = true;
    elements.video.srcObject = null;
    document.body.classList.add('barcode-scanner-open');
    setScannerStatus('Preparando camera...', 'loading');
    elements.closeButton.focus();

    try {
        session.stream = await getOptimizedCameraStream();
        if (!session.active) {
            session.stream.getTracks().forEach((track) => track.stop());
            return;
        }

        elements.video.srcObject = session.stream;
        await elements.video.play();
        updateTorchAvailability(session.stream.getVideoTracks()[0]);

        if (await canUseNativeBarcodeDetector()) {
            try {
                await startNativeScanner(session);
                return;
            } catch (error) {
                console.debug('Leitor nativo indisponivel; usando compatibilidade:', error);
            }
        }

        await startFallbackScanner(session);
    } catch (error) {
        console.error('Erro ao iniciar leitor de codigo de barras:', error);
        session.stream?.getTracks?.().forEach((track) => track.stop());
        elements.video.pause();
        elements.video.srcObject = null;
        elements.torchButton.hidden = true;
        const message = error?.message === 'CAMERA_UNSUPPORTED'
            ? 'Este navegador nao oferece acesso a camera.'
            : getCameraErrorMessage(error);
        setScannerStatus(message, 'error');
    }
}

export function closeBarcodeScanner() {
    const session = scannerSession;
    if (!session) return;

    session.active = false;
    cancelNativeFrame(session);
    try {
        session.zxingControls?.stop();
    } catch (error) {
        console.debug('Leitor ja estava encerrado:', error);
    }
    session.stream?.getTracks?.().forEach((track) => track.stop());

    const elements = createScannerElements();
    elements.video.pause();
    elements.video.srcObject = null;
    elements.root.hidden = true;
    elements.panel.classList.remove('barcode-scan-success');
    document.body.classList.remove('barcode-scanner-open');

    const previousFocus = session.previousFocus;
    scannerSession = null;
    if (previousFocus instanceof HTMLElement && previousFocus.isConnected) {
        previousFocus.focus();
    }
}

async function warmUpFallbackScanner() {
    try {
        if (await canUseNativeBarcodeDetector()) {
            const supportedFormats = await window.BarcodeDetector.getSupportedFormats();
            if (PRODUCT_BARCODE_FORMATS.some((format) => supportedFormats.includes(format))) return;
        }
        await loadZxingModule();
    } catch (error) {
        // Uma nova tentativa sera feita quando o usuario abrir o leitor.
    }
}

if (typeof window.requestIdleCallback === 'function') {
    window.requestIdleCallback(warmUpFallbackScanner, { timeout: 2500 });
} else {
    window.setTimeout(warmUpFallbackScanner, 1500);
}
