import test from 'node:test';
import assert from 'node:assert/strict';

import { sortTransactionsAscending } from '../debt-domain.js';
import {
    createPaymentMutation,
    recalculateDerivedInterestTransactions
} from '../payment-domain.js';

const SALE_DATE = '2026-01-01T12:00:00.000Z';
const PAYMENT_DATE = '2026-03-02T12:00:00.000Z';
const SECOND_PAYMENT_DATE = '2026-05-01T12:00:00.000Z';

function amountCents(item) {
    return Math.round(Number(item?.amountCents) || 0);
}

// Resumo minimo e independente para o cenario de concorrencia abaixo. O
// pagamento e menor que o limite de renovacao, portanto a venda continua
// sendo a referencia ate que o ciclo cobrado apareca no historico.
function buildTestSummary(client) {
    let baseDebtCents = 0;
    let principalDebtCents = 0;
    let outstandingInterestCents = 0;
    let lastAutomaticInterestDate = null;

    sortTransactionsAscending(client.sales).forEach((item) => {
        if (item.type === 'sale') {
            baseDebtCents += amountCents(item);
            principalDebtCents += amountCents(item);
        } else if (item.type === 'interest') {
            baseDebtCents += amountCents(item);
            outstandingInterestCents += amountCents(item);
            if (item.automaticInterest === true) lastAutomaticInterestDate = item.date;
        } else if (item.type === 'payment') {
            const paymentCents = amountCents(item);
            const paidInterestCents = Math.min(paymentCents, outstandingInterestCents);
            baseDebtCents -= paymentCents;
            outstandingInterestCents -= paidInterestCents;
            principalDebtCents -= paymentCents - paidInterestCents;
        }
    });

    return {
        baseDebtCents,
        principalDebtCents,
        outstandingInterestCents,
        referenceDate: SALE_DATE,
        lastAutomaticInterestDate
    };
}

function paymentOptions(paymentId, interestId) {
    return {
        paymentCents: 500,
        paymentDate: PAYMENT_DATE,
        paymentId,
        interestId,
        overdueAlertDays: 60,
        interestEnabled: true,
        interestPercent: 10,
        buildSummary: buildTestSummary,
        buildInterestDescription: ({ percent }) => `Juros ${percent}%`
    };
}

function buildReplaySummary(client) {
    let baseDebtCents = 0;
    let principalDebtCents = 0;
    let outstandingInterestCents = 0;
    let referenceDate = null;
    let lastAutomaticInterestDate = null;

    sortTransactionsAscending(client.sales).forEach((item) => {
        const debtBeforeTransactionCents = baseDebtCents;
        const itemAmountCents = amountCents(item);

        if (item.type === 'sale') {
            baseDebtCents += itemAmountCents;
            principalDebtCents += itemAmountCents;
        } else if (item.type === 'interest') {
            baseDebtCents += itemAmountCents;
            outstandingInterestCents += itemAmountCents;
            if (item.automaticInterest === true) lastAutomaticInterestDate = item.date;
        } else if (item.type === 'payment') {
            baseDebtCents -= itemAmountCents;
            const paidInterestCents = Math.min(itemAmountCents, Math.max(0, outstandingInterestCents));
            outstandingInterestCents -= paidInterestCents;
            principalDebtCents -= itemAmountCents - paidInterestCents;
        }

        if (debtBeforeTransactionCents <= 0 && baseDebtCents > 0) referenceDate = item.date;
        if (baseDebtCents <= 0) referenceDate = null;
    });

    return {
        baseDebtCents,
        principalDebtCents,
        outstandingInterestCents: Math.max(0, outstandingInterestCents),
        referenceDate,
        lastAutomaticInterestDate
    };
}

function recalculate(client) {
    return recalculateDerivedInterestTransactions(client, {
        fallbackPolicy: {
            enabled: false,
            percent: 20,
            overdueAlertDays: 60,
            overdueResetPaymentPercent: 20
        },
        buildSummary: buildReplaySummary,
        createInterestId: () => 'juros-recriados',
        buildInterestDescription: ({ percent, cycles }) => `Juros por atraso (${percent}%${cycles > 1 ? ` x ${cycles}` : ''})`
    });
}

test('retry serializado recalcula o estado e nao cobra o mesmo ciclo duas vezes', () => {
    const originalClient = {
        id: 'cliente-1',
        sales: {
            venda: {
                id: 'venda',
                type: 'sale',
                amount: 100,
                amountCents: 10000,
                date: SALE_DATE
            }
        }
    };

    const firstPayment = createPaymentMutation(
        originalClient,
        paymentOptions('pagamento-1', 'juros-1')
    );
    assert.equal(firstPayment.interestCents, 1000);
    assert.equal(firstPayment.items.filter((item) => item.type === 'interest').length, 1);

    // Simula o retry do segundo dispositivo: o callback recebe do Firebase o
    // cliente ja alterado pelo primeiro commit, nao o cache original da aba.
    const retriedPayment = createPaymentMutation(
        firstPayment.client,
        paymentOptions('pagamento-2', 'juros-2')
    );

    assert.equal(retriedPayment.interestCents, 0);
    assert.equal(retriedPayment.items.filter((item) => item.type === 'interest').length, 0);
    assert.equal(retriedPayment.paymentItem.relatedInterestId, null);

    const committedTransactions = sortTransactionsAscending(retriedPayment.client.sales);
    assert.equal(committedTransactions.filter((item) => item.type === 'interest').length, 1);
    assert.equal(
        committedTransactions
            .filter((item) => item.type === 'interest')
            .reduce((total, item) => total + amountCents(item), 0),
        1000
    );
    assert.equal(firstPayment.paymentItem.automaticInterestProcessed, true);
    assert.equal(firstPayment.paymentItem.automaticInterestId, 'juros-1');
    assert.deepEqual(firstPayment.paymentItem.automaticInterestPolicy, {
        enabled: true,
        percent: 10,
        overdueAlertDays: 60,
        overdueResetPaymentPercent: 0
    });
    assert.equal(firstPayment.items[0].interestPercent, 10);
    assert.equal(firstPayment.items[0].interestCycles, 1);
});

test('editar o principal recalcula os juros automaticos e o rateio do pagamento', () => {
    const client = {
        id: 'cliente-1',
        sales: [
            {
                id: 'venda',
                type: 'sale',
                amount: 50,
                amountCents: 5000,
                date: SALE_DATE
            },
            {
                id: 'juros',
                type: 'interest',
                amount: 10,
                amountCents: 1000,
                description: 'Juros por atraso (10%)',
                relatedPaymentId: 'pagamento',
                automaticInterest: true,
                date: PAYMENT_DATE
            },
            {
                id: 'pagamento',
                type: 'payment',
                amount: 5,
                amountCents: 500,
                interestPaidCents: 500,
                principalPaidCents: 0,
                relatedInterestId: 'juros',
                date: PAYMENT_DATE
            }
        ]
    };

    const recalculated = recalculate(client);
    const interest = recalculated.sales.find((item) => item.type === 'interest');
    const payment = recalculated.sales.find((item) => item.type === 'payment');

    // A taxa original vem da descricao legada, nao da configuracao atual de 20%.
    assert.equal(interest.amountCents, 500);
    assert.equal(interest.interestPercent, 10);
    assert.equal(payment.interestPaidCents, 500);
    assert.equal(payment.principalPaidCents, 0);
    assert.equal(payment.automaticInterestProcessed, true);
    assert.equal(payment.automaticInterestId, 'juros');
    assert.deepEqual(recalculate(recalculated), recalculated);
});

test('excluir a venda remove os juros derivados e permite recria-los se a base voltar', () => {
    const clientWithoutSale = {
        id: 'cliente-1',
        sales: [
            {
                id: 'juros',
                type: 'interest',
                amount: 10,
                amountCents: 1000,
                description: 'Juros por atraso (10%)',
                relatedPaymentId: 'pagamento',
                automaticInterest: true,
                date: PAYMENT_DATE
            },
            {
                id: 'pagamento',
                type: 'payment',
                amount: 5,
                amountCents: 500,
                interestPaidCents: 500,
                principalPaidCents: 0,
                relatedInterestId: 'juros',
                date: PAYMENT_DATE
            }
        ]
    };

    const withoutInterest = recalculate(clientWithoutSale);
    const paymentWithoutInterest = withoutInterest.sales.find((item) => item.type === 'payment');

    assert.equal(withoutInterest.sales.some((item) => item.type === 'interest'), false);
    assert.equal(paymentWithoutInterest.relatedInterestId, null);
    assert.equal(paymentWithoutInterest.interestPaidCents, 0);
    assert.equal(paymentWithoutInterest.principalPaidCents, 500);
    // O id fica como metadado derivado para uma edicao posterior poder
    // reconstruir o mesmo par, sem deixar uma cobranca zerada no historico.
    assert.equal(paymentWithoutInterest.automaticInterestId, 'juros');

    const restoredClient = {
        ...withoutInterest,
        sales: [
            {
                id: 'venda-restaurada',
                type: 'sale',
                amount: 100,
                amountCents: 10000,
                date: SALE_DATE
            },
            ...withoutInterest.sales
        ]
    };
    const restored = recalculate(restoredClient);
    const restoredInterest = restored.sales.find((item) => item.type === 'interest');

    assert.equal(restoredInterest.id, 'juros');
    assert.equal(restoredInterest.amountCents, 1000);
});

test('excluir um pagamento antigo recalcula os ciclos do lancamento seguinte', () => {
    const clientWithoutFirstPayment = {
        id: 'cliente-1',
        sales: [
            {
                id: 'venda',
                type: 'sale',
                amount: 100,
                amountCents: 10000,
                date: SALE_DATE
            },
            {
                id: 'juros-2',
                type: 'interest',
                amount: 10,
                amountCents: 1000,
                description: 'Juros por atraso (10%)',
                relatedPaymentId: 'pagamento-2',
                automaticInterest: true,
                date: SECOND_PAYMENT_DATE
            },
            {
                id: 'pagamento-2',
                type: 'payment',
                amount: 5,
                amountCents: 500,
                interestPaidCents: 500,
                principalPaidCents: 0,
                relatedInterestId: 'juros-2',
                date: SECOND_PAYMENT_DATE
            }
        ]
    };

    const recalculated = recalculate(clientWithoutFirstPayment);
    const interest = recalculated.sales.find((item) => item.type === 'interest');

    assert.equal(interest.amountCents, 2000);
    assert.equal(interest.interestCycles, 2);
});
