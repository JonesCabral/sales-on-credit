import test from 'node:test';
import assert from 'node:assert/strict';
import {
    activityHasUnpricedProducts,
    amountToCents,
    calculateActivityTotals,
    compareFirebaseActivityOrder,
    hasMixedPricedAndUnpricedLines,
    resolveUnpricedItemsFlag,
    saleItemsHaveUnpricedProducts
} from '../history-domain.js';

const EDITED_AT = '2026-01-05T10:00:00.000Z';
const MIXED_DESCRIPTION = 'Camiseta = R$ 35,00\nCinto sem preço';

test('converte valores monetários para centavos sem acumular ponto flutuante', () => {
    assert.equal(amountToCents({ amount: 19.9 }), 1990);
    assert.equal(amountToCents({ amount: 0.1 + 0.2 }), 30);
    assert.equal(amountToCents({ amount: 999, amountCents: 1234 }), 1234);
});

test('identifica vendas com produtos precificados e pendentes na mesma descrição', () => {
    const description = 'Camiseta = R$ 35,00\nCinto sem preço';
    assert.equal(hasMixedPricedAndUnpricedLines(description), true);
    assert.equal(activityHasUnpricedProducts({ type: 'sale', amountCents: 3500, description }), true);
    assert.equal(activityHasUnpricedProducts({ type: 'payment', amountCents: 3500, description }), false);
});

test('calcula totais sobre toda a coleção filtrada em centavos', () => {
    const totals = calculateActivityTotals([
        { type: 'sale', amountCents: 1000 },
        { type: 'sale', amountCents: 2500, hasUnpricedItems: true },
        { type: 'interest', amountCents: 300 },
        { type: 'payment', amountCents: 1800 },
        { type: 'sale', amountCents: 0, isNote: true }
    ]);

    assert.deepEqual(totals, {
        saleCents: 3500,
        paymentCents: 1800,
        interestCents: 300,
        notesCount: 2,
        balanceCents: 2000
    });
});

test('leitura e escrita do flag de produtos sem preço usam a mesma regra', () => {
    const item = { type: 'sale', amountCents: 4000, items: [{ priced: false }] };
    assert.equal(saleItemsHaveUnpricedProducts(item.items), true);
    assert.equal(resolveUnpricedItemsFlag(item), true);
    assert.equal(activityHasUnpricedProducts(item), true);

    // Item marcado como `priced: false` é sinal forte: sobrevive à edição.
    assert.equal(resolveUnpricedItemsFlag({ ...item, editedAt: EDITED_AT }), true);
});

test('edição explícita da venda supera a heurística de descrição mista', () => {
    const sale = { type: 'sale', amountCents: 3500, description: MIXED_DESCRIPTION };
    assert.equal(resolveUnpricedItemsFlag(sale), true);
    assert.equal(resolveUnpricedItemsFlag({ ...sale, hasUnpricedItems: true, editedAt: EDITED_AT }), false);
});

test('flag gravado desatualizado não mascara uma venda ainda sem preço', () => {
    // Cenário do cadastro de cliente, que gravava `false` fixo na primeira venda.
    const sale = { type: 'sale', amountCents: 3500, description: MIXED_DESCRIPTION, hasUnpricedItems: false };
    assert.equal(resolveUnpricedItemsFlag(sale), true);
});

test('reprocessar o flag já gravado devolve o mesmo valor (sem ping-pong de escrita)', () => {
    const cases = [
        { type: 'sale', amountCents: 3500, description: MIXED_DESCRIPTION },
        { type: 'sale', amountCents: 3500, description: MIXED_DESCRIPTION, editedAt: EDITED_AT },
        { type: 'sale', amountCents: 4000, description: 'Camiseta = R$ 40,00' },
        { type: 'sale', amountCents: 0, isNote: true },
        { type: 'sale', amountCents: 4000, items: [{ priced: false }], editedAt: EDITED_AT },
        { type: 'payment', amountCents: 4000, description: MIXED_DESCRIPTION }
    ];

    cases.forEach((item) => {
        const gravado = resolveUnpricedItemsFlag(item);
        let atual = { ...item, hasUnpricedItems: gravado };
        // Cada volta simula app e histórico regravando o mesmo registro.
        for (let rodada = 0; rodada < 3; rodada += 1) {
            const proximo = resolveUnpricedItemsFlag(atual);
            assert.equal(proximo, gravado, `divergiu na rodada ${rodada}: ${JSON.stringify(item)}`);
            atual = { ...atual, hasUnpricedItems: proximo };
        }
    });
});

test('usa a mesma ordem de timestamp e chave exigida pela paginação do Firebase', () => {
    assert.ok(compareFirebaseActivityOrder({ timestamp: 10, key: 'a' }, { timestamp: 11, key: 'a' }) < 0);
    assert.ok(compareFirebaseActivityOrder({ timestamp: 10, key: 'a' }, { timestamp: 10, key: 'b' }) < 0);
    assert.equal(compareFirebaseActivityOrder({ timestamp: 10, key: 'a' }, { timestamp: 10, key: 'a' }), 0);
});
