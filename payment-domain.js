import { calculateSummaryDebt, toTransactionList } from './debt-domain.js';

const TRANSACTION_TYPE_PAYMENT = 'payment';
const TRANSACTION_TYPE_INTEREST = 'interest';

function centsToAmount(cents) {
    const numericCents = Number(cents);
    if (!Number.isFinite(numericCents)) return 0;
    return Math.round(numericCents) / 100;
}

/**
 * Monta o novo estado de um cliente a partir do valor lido pelo callback de
 * uma transacao do Firebase.
 *
 * A funcao nao recebe juros previamente calculados de uma aba. Em cada retry,
 * ela refaz o resumo e a cobranca sobre `currentClient`, que e justamente o
 * estado mais recente entregue pelo servidor. Assim, se outro pagamento ja
 * lancou os juros daquele ciclo, o retry encontra `interestCents === 0`.
 */
export function createPaymentMutation(currentClient, options = {}) {
    if (!currentClient || typeof currentClient !== 'object') return null;

    const {
        paymentCents,
        paymentDate,
        paymentId,
        interestId,
        overdueAlertDays,
        interestEnabled = false,
        interestPercent = 0,
        buildSummary,
        buildInterestDescription
    } = options;

    const safePaymentCents = Math.round(Number(paymentCents) || 0);
    if (safePaymentCents <= 0) throw new Error('Valor de pagamento invalido');
    if (!paymentId) throw new Error('Identificador de pagamento invalido');
    if (typeof buildSummary !== 'function') throw new Error('Gerador de resumo invalido');

    const currentSales = toTransactionList(currentClient.sales);
    const clientForCalculation = { ...currentClient, sales: currentSales };
    const currentSummary = buildSummary(clientForCalculation);
    const debtModel = calculateSummaryDebt(currentSummary, {
        overdueAlertDays,
        interestEnabled,
        interestPercent,
        now: paymentDate
    });
    const pendingInterestCents = debtModel.interestCents;
    const pendingInterestCycles = debtModel.interestCycles;
    const outstandingInterestCents = Math.max(
        0,
        Math.round(Number(currentSummary?.outstandingInterestCents) || 0)
    );
    const items = [];

    if (pendingInterestCents > 0) {
        if (!interestId) throw new Error('Identificador de juros invalido');
        items.push({
            id: interestId,
            amount: centsToAmount(pendingInterestCents),
            amountCents: pendingInterestCents,
            description: typeof buildInterestDescription === 'function'
                ? buildInterestDescription({
                    percent: interestPercent,
                    cycles: pendingInterestCycles
                })
                : '',
            type: TRANSACTION_TYPE_INTEREST,
            relatedPaymentId: paymentId,
            automaticInterest: true,
            date: paymentDate
        });
    }

    const totalInterestDueCents = outstandingInterestCents + pendingInterestCents;
    const interestPaidCents = Math.min(safePaymentCents, totalInterestDueCents);
    const principalPaidCents = Math.max(0, safePaymentCents - interestPaidCents);
    const paymentItem = {
        id: paymentId,
        amount: centsToAmount(safePaymentCents),
        amountCents: safePaymentCents,
        type: TRANSACTION_TYPE_PAYMENT,
        interestPaidCents,
        principalPaidCents,
        settlesPreviouslyAppliedInterest: pendingInterestCents === 0 && interestPaidCents > 0,
        relatedInterestId: pendingInterestCents > 0 ? interestId : null,
        date: paymentDate
    };
    items.push(paymentItem);

    // Preserva as chaves existentes, inclusive indices do formato legado, e
    // acrescenta apenas os ids desta operacao. A migracao completa continua
    // sendo responsabilidade do fluxo normal de persistencia.
    const nextSales = currentClient.sales && typeof currentClient.sales === 'object'
        ? { ...currentClient.sales }
        : {};
    items.forEach((item) => {
        nextSales[item.id] = item;
    });

    const nextClient = { ...currentClient, sales: nextSales };
    nextClient.publicSummary = buildSummary(nextClient);

    return {
        client: nextClient,
        items,
        paymentItem,
        interestCents: pendingInterestCents,
        interestCycles: pendingInterestCycles
    };
}
