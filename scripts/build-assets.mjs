import { rm, writeFile } from 'node:fs/promises';
import { build, transform } from 'esbuild';
import { PurgeCSS } from 'purgecss';

const cssPages = [
    {
        output: 'shell.min.css',
        content: ['index.html', 'auth-bootstrap.js'],
        safelist: { standard: ['hidden', 'loaded', 'loading', 'login-error'] }
    },
    { output: 'home.min.css', content: ['dashboard.html', 'app.js', 'barcode-scanner.js'] },
    { output: 'history.min.css', content: ['history.html', 'history.js'] },
    { output: 'products.min.css', content: ['products.html', 'products.js', 'barcode-scanner.js'] },
    { output: 'settings.min.css', content: ['settings.html', 'settings.js'] }
];

const dynamicClassSafelist = {
    standard: [
        'active', 'archived', 'credit', 'detecting', 'disabled', 'error', 'has-credit',
        'has-debt', 'has-notes', 'hidden', 'in', 'is-paid', 'loaded', 'loading',
        'new-client', 'note', 'offline', 'out', 'paid', 'sale', 'scanning', 'show',
        'success', 'visible', 'warning'
    ],
    deep: [
        /^activity-/, /^app-menu/, /^barcode-/, /^client-/, /^confirm-/, /^description-/,
        /^history-/, /^interest-/, /^modal-/, /^payment-/, /^product-/, /^sale-/,
        /^settings-/, /^suggestion-/, /^theme-/, /^toast-/
    ]
};

async function buildCss() {
    for (const page of cssPages) {
        const [{ css }] = await new PurgeCSS().purge({
            css: ['style.css'],
            content: page.content,
            defaultExtractor: (source) => source.match(/[A-Za-z0-9_:-]+/g) || [],
            fontFace: true,
            keyframes: true,
            variables: true,
            safelist: page.safelist || dynamicClassSafelist
        });
        const result = await transform(css, {
            loader: 'css',
            minify: true,
            legalComments: 'none'
        });
        await writeFile(page.output, result.code, 'utf8');
    }
}

async function buildJavaScript() {
    await Promise.all([
        rm(new URL('../chunks', import.meta.url), { recursive: true, force: true }),
        rm(new URL('../firebase.min.js', import.meta.url), { force: true }),
        rm(new URL('../barcode-scanner.min.js', import.meta.url), { force: true })
    ]);

    await build({
        entryPoints: [
            'auth-bootstrap.js',
            'app.js',
            'history.js',
            'products.js',
            'settings.js',
            'client-view.js'
        ],
        outdir: '.',
        entryNames: '[name].min',
        chunkNames: 'chunks/[name]-[hash]',
        bundle: true,
        splitting: true,
        treeShaking: true,
        format: 'esm',
        minify: true,
        charset: 'utf8',
        legalComments: 'none',
        logLevel: 'warning'
    });
}

await Promise.all([buildCss(), buildJavaScript()]);
