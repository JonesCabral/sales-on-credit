import {
    calculateSummaryDebt,
    sortTransactionsAscending,
    toTransactionList
} from './debt-domain.js';

const TRANSACTION_TYPE_PAYMENT = 'payment';
const TRANSACTION_TYPE_INTEREST = 'interest';

function centsToAmount(cents) {
    const numericCents = Number(cents);
    if (!Number.isFinite(numericCents)) return 0;
    return Math.round(numericCents) / 100;
}

function getAmountCents(item) {
    const savedCents = Number(item?.amountCents);
    if (Number.isFinite(savedCents)) return Math.round(savedCents);

    const savedAmount = Number(item?.amount);
    return Number.isFinite(savedAmount) ? Math.round(savedAmount * 100) : 0;
}

function getRecordedInterestPercent(interestItem) {
    const savedPercent = Number(interestItem?.interestPercent);
    if (Number.isFinite(savedPercent) && savedPercent >= 0) return savedPercent;

    const match = String(interestItem?.description || '').match(/\(([\d.,]+)%/);
    if (!match) return null;

    const parsedPercent = Number.parseFloat(match[1].replace(',', '.'));
    return Number.isFinite(parsedPercent) && parsedPercent >= 0 ? parsedPercent : null;
}

function normalizeAutomaticInterestPolicy(paymentItem, interestItem, fallbackPolicy = {}) {
    const savedPolicy = paymentItem?.automaticInterestPolicy;
    const hasSavedPolicy = savedPolicy && typeof savedPolicy === 'object';
    const recordedPercent = getRecordedInterestPercent(interestItem);
    const rawPercent = hasSavedPolicy
        ? savedPolicy.percent
        : recordedPercent ?? fallbackPolicy.percent;
    const percent = Math.max(0, Number(rawPercent) || 0);
    const rawAlertDays = hasSavedPolicy
        ? savedPolicy.overdueAlertDays
        : fallbackPolicy.overdueAlertDays;
    const rawResetPercent = hasSavedPolicy
        ? savedPolicy.overdueResetPaymentPercent
        : fallbackPolicy.overdueResetPaymentPercent;

    return {
        // Um lancamento antigo prova que a politica estava ativa, mesmo que a
        // configuracao geral tenha sido desligada depois dele.
        enabled: hasSavedPolicy ? savedPolicy.enabled === true : Boolean(interestItem) || fallbackPolicy.enabled === true,
        percent,
        overdueAlertDays: Number(rawAlertDays) > 0 ? Math.floor(Number(rawAlertDays)) : 60,
        overdueResetPaymentPercent: Math.max(0, Number(rawResetPercent) || 0)
    };
}

function defaultIsAutomaticInterest(item) {
    return item?.type === TRANSACTION_TYPE_INTEREST
        && (item.automaticInterest === true || Boolean(item.relatedPaymentId));
}

/**
 * Reconstroi os lancamentos automaticos depois que uma transacao historica
 * muda. Cada pagamento que materializou (ou verificou) juros e reexecutado em
 * ordem cronologica sobre o historico ja corrigido. Assim, valor, rateio do
 * pagamento e eventuais lancamentos seguintes continuam coerentes.
 */
export function recalculateDerivedInterestTransactions(currentClient, options = {}) {
    if (!currentClient || typeof currentClient !== 'object') return null;

    const {
        buildSummary,
        buildInterestDescription,
        createInterestId,
        fallbackPolicy = {},
        isAutomaticInterest = defaultIsAutomaticInterest
    } = options;
    if (typeof buildSummary !== 'function') throw new Error('Gerador de resumo invalido');

    const sourceTransactions = sortTransactionsAscending(currentClient.sales);
    const paymentItems = sourceTransactions.filter((item) => item?.type === TRANSACTION_TYPE_PAYMENT);
    const paymentsById = new Map(paymentItems.map((item) => [item.id, item]));
    const linkedInterestByPaymentId = new Map();
    const linkedInterestIds = new Set();

    // Primeiro respeita os vinculos explicitos, que sao seguros mesmo quando
    // juros e pagamento chegam do Firebase em uma ordem diferente.
    sourceTransactions.forEach((item) => {
        if (!isAutomaticInterest(item)) return;

        const payment = item.relatedPaymentId
            ? paymentsById.get(item.relatedPaymentId)
            : paymentItems.find((candidate) => candidate.relatedInterestId === item.id);
        if (!payment || linkedInterestByPaymentId.has(payment.id)) return;

        linkedInterestByPaymentId.set(payment.id, item);
        linkedInterestIds.add(item.id);
    });

    // Compatibilidade com pares antigos sem ids cruzados: a implementacao
    // anterior os reconhecia pela mesma data e pelo rateio de juros salvo.
    sourceTransactions.forEach((item) => {
        if (!isAutomaticInterest(item) || linkedInterestIds.has(item.id)) return;

        const payment = paymentItems.find((candidate) => (
            !linkedInterestByPaymentId.has(candidate.id)
            && candidate.date === item.date
            && Math.round(Number(candidate.interestPaidCents) || 0) > 0
        ));
        if (!payment) return;

        linkedInterestByPaymentId.set(payment.id, item);
        linkedInterestIds.add(item.id);
    });

    const rebuiltTransactions = [];

    sourceTransactions.forEach((sourceItem) => {
        // O par sera recolocado imediatamente antes do pagamento, ja com o
        // valor recalculado. Juros automaticos sem vinculo seguro sao
        // preservados para nao apagar dados legados por heuristica.
        if (linkedInterestIds.has(sourceItem?.id)) return;

        if (sourceItem?.type !== TRANSACTION_TYPE_PAYMENT) {
            rebuiltTransactions.push({ ...sourceItem });
            return;
        }

        const linkedInterest = linkedInterestByPaymentId.get(sourceItem.id) || null;
        const wasProcessed = sourceItem.automaticInterestProcessed === true
            || Boolean(sourceItem.automaticInterestId)
            || Boolean(sourceItem.relatedInterestId)
            || Boolean(linkedInterest)
            || Math.round(Number(sourceItem.interestPaidCents) || 0) > 0
            || sourceItem.settlesPreviouslyAppliedInterest === true;
        if (!wasProcessed) {
            rebuiltTransactions.push({ ...sourceItem });
            return;
        }

        const policy = normalizeAutomaticInterestPolicy(sourceItem, linkedInterest, fallbackPolicy);
        const clientBeforePayment = { ...currentClient, sales: rebuiltTransactions };
        const summaryBeforePayment = buildSummary(clientBeforePayment, policy);
        let pendingInterestCents = 0;
        let pendingInterestCycles = 0;

        const debtModel = calculateSummaryDebt(summaryBeforePayment, {
            overdueAlertDays: policy.overdueAlertDays,
            interestEnabled: policy.enabled,
            interestPercent: policy.percent,
            now: sourceItem.date
        });
        pendingInterestCents = debtModel.interestCents;
        pendingInterestCycles = debtModel.interestCycles;

        let automaticInterestId = sourceItem.automaticInterestId
            || linkedInterest?.id
            || sourceItem.relatedInterestId
            || null;
        if (pendingInterestCents > 0 && !automaticInterestId) {
            if (typeof createInterestId !== 'function') {
                throw new Error('Identificador de juros invalido');
            }
            automaticInterestId = createInterestId();
        }

        if (pendingInterestCents > 0) {
            rebuiltTransactions.push({
                ...(linkedInterest || {}),
                id: automaticInterestId,
                amount: centsToAmount(pendingInterestCents),
                amountCents: pendingInterestCents,
                description: typeof buildInterestDescription === 'function'
                    ? buildInterestDescription({
                        percent: policy.percent,
                        cycles: pendingInterestCycles
                    })
                    : linkedInterest?.description || '',
                type: TRANSACTION_TYPE_INTEREST,
                relatedPaymentId: sourceItem.id,
                automaticInterest: true,
                interestPercent: policy.percent,
                interestCycles: pendingInterestCycles,
                date: sourceItem.date
            });
        }

        const outstandingInterestCents = Math.max(
            0,
            Math.round(Number(summaryBeforePayment?.outstandingInterestCents) || 0)
        );
        const paymentCents = Math.max(0, getAmountCents(sourceItem));
        const totalInterestDueCents = outstandingInterestCents + pendingInterestCents;
        const interestPaidCents = Math.min(paymentCents, totalInterestDueCents);
        const paymentItem = {
            ...sourceItem,
            interestPaidCents,
            principalPaidCents: Math.max(0, paymentCents - interestPaidCents),
            settlesPreviouslyAppliedInterest: pendingInterestCents === 0 && interestPaidCents > 0,
            relatedInterestId: pendingInterestCents > 0 ? automaticInterestId : null
        };

        paymentItem.automaticInterestProcessed = true;
        paymentItem.automaticInterestId = automaticInterestId;
        paymentItem.automaticInterestPolicy = policy;

        rebuiltTransactions.push(paymentItem);
    });

    return {
        ...currentClient,
        sales: rebuiltTransactions
    };
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
        overdueResetPaymentPercent = 0,
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
            interestPercent,
            interestCycles: pendingInterestCycles,
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
        automaticInterestProcessed: true,
        automaticInterestId: interestId,
        automaticInterestPolicy: {
            enabled: interestEnabled === true,
            percent: Math.max(0, Number(interestPercent) || 0),
            overdueAlertDays: Number(overdueAlertDays) > 0 ? Math.floor(Number(overdueAlertDays)) : 60,
            overdueResetPaymentPercent: Math.max(0, Number(overdueResetPaymentPercent) || 0)
        },
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
