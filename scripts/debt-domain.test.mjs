import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildOverdueMessage,
    calculateElapsedDays,
    calculateSummaryDebt,
    formatDaysToMonths,
    getTransactionSortAnchor,
    isTransactionMapKeyedById,
    sortTransactionsAscending,
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

test('formata e identifica a referência do aviso de atraso', () => {
    assert.equal(formatDaysToMonths(137), '4 meses e 17 dias');
    assert.equal(formatDaysToMonths(30), '1 mês');
    assert.equal(buildOverdueMessage({ lastPaymentDate: daysAgo(137), overdueDays: 137 }), 'Último pagamento há 4 meses e 17 dias');
    assert.equal(buildOverdueMessage({ firstSaleDate: daysAgo(151), overdueDays: 151 }), 'Sem pagamento há 5 meses e 1 dia');
    assert.equal(buildOverdueMessage({ overdueDays: 90 }), 'Nunca realizou pagamento');
    assert.equal(calculateElapsedDays(daysAgo(137), NOW), 137);
    assert.equal(calculateElapsedDays(null, NOW), 0);
});

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
    // Referência há 90 dias e juros lançados há 20 — ou seja, no dia 70, já
    // dentro do primeiro ciclo vencido. O segundo ciclo só fecha no dia 120.
    const model = calculateSummaryDebt({
        baseDebtCents: 7420,
        principalDebtCents: 7420,
        referenceDate: daysAgo(90),
        lastAutomaticInterestDate: daysAgo(20)
    }, interestOptions);

    assert.equal(model.interestAlreadyApplied, true);
    assert.equal(model.interestCents, 0);
    assert.equal(model.totalDebtCents, 7420);
});

// Sem pagamento a referência é a compra mais antiga em aberto, e a cobrança
// não pode parar no primeiro ciclo: quem some por meio ano deve juros de
// todos os ciclos vencidos, não de um só.
test('sem pagamento os juros acumulam um ciclo por vez desde a compra mais antiga', () => {
    const model = calculateSummaryDebt({
        baseDebtCents: 7420,
        principalDebtCents: 7420,
        referenceDate: daysAgo(190)
    }, interestOptions);

    assert.equal(model.overdueCycles, 3);
    assert.equal(model.interestCycles, 3);
    assert.equal(model.cycleInterestCents, 742);
    // Juros simples: cada ciclo cobra 10% do principal, sem compor.
    assert.equal(model.interestCents, 2226);
    assert.equal(model.totalDebtCents, 9646);
});

test('os ciclos já lançados são descontados dos ciclos vencidos', () => {
    const model = calculateSummaryDebt({
        baseDebtCents: 7420,
        principalDebtCents: 7420,
        referenceDate: daysAgo(190),
        // Lançados no dia 70: cobriram só o primeiro ciclo.
        lastAutomaticInterestDate: daysAgo(120)
    }, interestOptions);

    assert.equal(model.overdueCycles, 3);
    assert.equal(model.interestCycles, 2);
    assert.equal(model.interestAlreadyApplied, false);
    assert.equal(model.interestCents, 1484);
});

test('antes do prazo a projeção mostra apenas o primeiro ciclo', () => {
    const model = calculateSummaryDebt({
        baseDebtCents: 7420,
        principalDebtCents: 7420,
        referenceDate: daysAgo(30)
    }, interestOptions);

    assert.equal(model.isOverdue, false);
    assert.equal(model.interestCents, 0);
    assert.equal(model.projectedInterestCycles, 1);
    assert.equal(model.projectedInterestCents, 742);
    assert.equal(model.projectedTotalDebtCents, 8162);
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

// Regressão do bug em que a ordem juros × pagamento dependia de um
// milissegundo: os dois ids embutem `Date.now()` e o Firebase devolve o nó
// ordenado por chave, então `..._payment_x` de um milissegundo antes vinha
// antes de `..._interest_y`. Com o par invertido o pagamento quitava o
// principal antes de os juros existirem: `principalDebtCents` ficava menor
// que o correto e, como a base dos juros é limitada pelo principal, os juros
// seguintes passavam a ser calculados sobre uma base menor.
test('juros automáticos vêm antes do pagamento mesmo com a chave invertida', () => {
    const sameDate = daysAgo(70);
    const juros = {
        id: '1700000000001_interest_bbbbbb',
        type: 'interest',
        amountCents: 1000,
        relatedPaymentId: '1700000000000_payment_aaaaaa',
        automaticInterest: true,
        date: sameDate
    };
    const pagamento = {
        id: '1700000000000_payment_aaaaaa',
        type: 'payment',
        amountCents: 1000,
        relatedInterestId: '1700000000001_interest_bbbbbb',
        date: sameDate
    };

    // Ordem que o Firebase devolve quando o milissegundo virou entre os dois
    // ids: o pagamento aparece primeiro no nó, mas precisa ser processado
    // depois dos juros.
    const ordenado = sortTransactionsAscending({
        [pagamento.id]: pagamento,
        [juros.id]: juros
    });
    assert.deepEqual(ordenado.map((item) => item.type), ['interest', 'payment']);

    // Ordem já correta continua correta.
    assert.deepEqual(
        sortTransactionsAscending([juros, pagamento]).map((item) => item.type),
        ['interest', 'payment']
    );
});

test('ordena por data e mantém a ordem de chegada no empate sem vínculo', () => {
    const venda = { id: 'v1', type: 'sale', amountCents: 5000, date: daysAgo(90) };
    const outraVenda = { id: 'v2', type: 'sale', amountCents: 2000, date: daysAgo(10) };
    const mesmoInstante = { id: 'v3', type: 'sale', amountCents: 300, date: daysAgo(10) };

    assert.deepEqual(
        sortTransactionsAscending([outraVenda, mesmoInstante, venda]).map((item) => item.id),
        ['v1', 'v2', 'v3']
    );
    // Transação sem data vai para o começo, sem quebrar a ordenação.
    assert.deepEqual(
        sortTransactionsAscending([venda, { id: 'x1', type: 'sale' }]).map((item) => item.id),
        ['x1', 'v1']
    );
    assert.deepEqual(sortTransactionsAscending(null), []);
});

test('a âncora de ordenação só desloca juros ligados a um pagamento', () => {
    assert.deepEqual(
        getTransactionSortAnchor({ id: 'j1', type: 'interest', relatedPaymentId: 'p1' }),
        { id: 'p1', order: 0 }
    );
    // Juros lançados à mão não têm pagamento associado: ficam no lugar deles.
    assert.deepEqual(
        getTransactionSortAnchor({ id: 'j2', type: 'interest' }),
        { id: 'j2', order: 1 }
    );
    assert.deepEqual(
        getTransactionSortAnchor({ id: 'p1', type: 'payment', relatedInterestId: 'j1' }),
        { id: 'p1', order: 1 }
    );
    assert.deepEqual(getTransactionSortAnchor(null), { id: '', order: 1 });
});

test('detecta se o nó sales já está indexado pelo id da transação', () => {
    const venda = { id: 'v1', type: 'sale', amountCents: 1000 };

    assert.equal(isTransactionMapKeyedById({ v1: venda }), true);
    assert.equal(isTransactionMapKeyedById({ 0: venda }), false);
    assert.equal(isTransactionMapKeyedById([venda]), false);
    assert.equal(isTransactionMapKeyedById(undefined), false);
});
