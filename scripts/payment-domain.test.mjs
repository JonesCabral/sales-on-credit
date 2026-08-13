import test from 'node:test';
import assert from 'node:assert/strict';

import { sortTransactionsAscending } from '../debt-domain.js';
import { createPaymentMutation } from '../payment-domain.js';

const SALE_DATE = '2026-01-01T12:00:00.000Z';
const PAYMENT_DATE = '2026-03-02T12:00:00.000Z';

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
});
