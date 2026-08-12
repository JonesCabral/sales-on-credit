import test from 'node:test';
import assert from 'node:assert/strict';
import {
    calculateSummaryDebt,
    isTransactionMapKeyedById,
    stableStringify,
    summariesMatch,
    toTransactionList
} from '../debt-domain.js';

const DAY_IN_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-08-12T12:00:00.000Z');
const daysAgo = (days) => new Date(NOW - days * DAY_IN_MS).toISOString();

const interestOptions = {
    overdueAlertDays: 60,
    interestEnabled: true,
    interestPercent: 10,
    now: NOW
};

test('não considera atrasado antes do prazo configurado', () => {
    const model = calculateSummaryDebt({
        baseDebtCents: 7420,
        principalDebtCents: 7420,
        referenceDate: daysAgo(59)
    }, interestOptions);

    assert.equal(model.overdueDays, 59);
    assert.equal(model.isOverdue, false);
    assert.equal(model.interestCents, 0);
    assert.equal(model.totalDebtCents, 7420);
});

test('aplica juros sobre o principal quando o prazo estoura', () => {
    const model = calculateSummaryDebt({
        baseDebtCents: 7420,
        principalDebtCents: 7420,
        referenceDate: daysAgo(60)
    }, interestOptions);

    assert.equal(model.isOverdue, true);
    assert.equal(model.interestCents, 742);
    assert.equal(model.totalDebtCents, 8162);
});

// Regressão do bug que fazia o card da lista mostrar um valor menor que o
// modal: os juros automáticos e o pagamento que renova o prazo são gravados
// com a mesma data, então comparar com `>=` marcava "juros já aplicados"
// para sempre e o card nunca mais somava juros.
test('juros gravados na mesma data da referência não bloqueiam o ciclo seguinte', () => {
    const sameDate = daysAgo(70);
    const model = calculateSummaryDebt({
        baseDebtCents: 7420,
        principalDebtCents: 7420,
        referenceDate: sameDate,
        lastAutomaticInterestDate: sameDate
    }, interestOptions);

    assert.equal(model.interestAlreadyApplied, false);
    assert.equal(model.interestCents, 742);
});

test('juros lançados depois da referência não são cobrados de novo no mesmo ciclo', () => {
    const model = calculateSummaryDebt({
        baseDebtCents: 7420,
        principalDebtCents: 7420,
        referenceDate: daysAgo(90),
        lastAutomaticInterestDate: daysAgo(70)
    }, interestOptions);

    assert.equal(model.interestAlreadyApplied, true);
    assert.equal(model.interestCents, 0);
    assert.equal(model.totalDebtCents, 7420);
});

test('base dos juros nunca passa do saldo nem fica negativa', () => {
    const parcialmentePago = calculateSummaryDebt({
        baseDebtCents: 5000,
        principalDebtCents: 9000,
        referenceDate: daysAgo(90)
    }, interestOptions);
    assert.equal(parcialmentePago.interestCents, 500);

    const soJuros = calculateSummaryDebt({
        baseDebtCents: 3000,
        principalDebtCents: -1000,
        referenceDate: daysAgo(90)
    }, interestOptions);
    assert.equal(soJuros.interestCents, 0);
});

test('saldo credor ou zerado nunca fica atrasado', () => {
    for (const baseDebtCents of [0, -2500]) {
        const model = calculateSummaryDebt({
            baseDebtCents,
            principalDebtCents: baseDebtCents,
            referenceDate: daysAgo(400)
        }, interestOptions);

        assert.equal(model.isOverdue, false);
        assert.equal(model.overdueDays, 0);
        assert.equal(model.totalDebtCents, baseDebtCents);
    }
});

test('juros desligados zeram a cobrança mas mantêm o saldo', () => {
    const model = calculateSummaryDebt({
        baseDebtCents: 7420,
        principalDebtCents: 7420,
        referenceDate: daysAgo(90)
    }, { ...interestOptions, interestEnabled: false });

    assert.equal(model.isOverdue, true);
    assert.equal(model.interestCents, 0);
    assert.equal(model.totalDebtCents, 7420);
});

test('resumo ausente ou vazio não quebra o cálculo', () => {
    for (const summary of [null, undefined, {}]) {
        const model = calculateSummaryDebt(summary, interestOptions);
        assert.equal(model.baseDebtCents, 0);
        assert.equal(model.isOverdue, false);
        assert.equal(model.totalDebtCents, 0);
    }
});

// O Firebase não armazena null e devolve as chaves em outra ordem, então a
// comparação precisa ignorar os dois — senão o app regravaria o resumo a
// cada leitura.
test('compara resumos ignorando ordem de chaves e campos nulos', () => {
    const montado = {
        version: 1,
        baseDebtCents: 7420,
        referenceDate: null,
        overdueInterestOverride: null
    };
    const salvoNoFirebase = { baseDebtCents: 7420, version: 1 };

    assert.equal(summariesMatch(montado, salvoNoFirebase), true);
    assert.equal(summariesMatch(montado, { ...salvoNoFirebase, baseDebtCents: 17720 }), false);
    assert.equal(summariesMatch(undefined, montado), false);
    assert.equal(stableStringify({ b: 1, a: 2 }), stableStringify({ a: 2, b: 1 }));
});

test('lê o nó sales tanto em array legado quanto em mapa por id', () => {
    const venda = { id: 'v1', type: 'sale', amountCents: 1000 };
    const pagamento = { id: 'p1', type: 'payment', amountCents: 400 };

    assert.deepEqual(toTransactionList([venda, pagamento]), [venda, pagamento]);
    assert.deepEqual(toTransactionList({ v1: venda, p1: pagamento }), [venda, pagamento]);
    // Arrays esparsos do Firebase vêm com buracos nulos.
    assert.deepEqual(toTransactionList([null, venda]), [venda]);
    assert.deepEqual(toTransactionList(null), []);
});

test('detecta se o nó sales já está indexado pelo id da transação', () => {
    const venda = { id: 'v1', type: 'sale', amountCents: 1000 };

    assert.equal(isTransactionMapKeyedById({ v1: venda }), true);
    assert.equal(isTransactionMapKeyedById({ 0: venda }), false);
    assert.equal(isTransactionMapKeyedById([venda]), false);
    assert.equal(isTransactionMapKeyedById(undefined), false);
});
