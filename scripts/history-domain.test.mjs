import test from 'node:test';
import assert from 'node:assert/strict';
import {
    activityHasUnpricedProducts,
    amountToCents,
    calculateActivityTotals,
    compareFirebaseActivityOrder,
    hasMixedPricedAndUnpricedLines
} from '../history-domain.js';

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

test('usa a mesma ordem de timestamp e chave exigida pela paginação do Firebase', () => {
    assert.ok(compareFirebaseActivityOrder({ timestamp: 10, key: 'a' }, { timestamp: 11, key: 'a' }) < 0);
    assert.ok(compareFirebaseActivityOrder({ timestamp: 10, key: 'a' }, { timestamp: 10, key: 'b' }) < 0);
    assert.equal(compareFirebaseActivityOrder({ timestamp: 10, key: 'a' }, { timestamp: 10, key: 'a' }), 0);
});
