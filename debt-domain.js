const DAY_IN_MS = 24 * 60 * 60 * 1000;
const FALLBACK_OVERDUE_ALERT_DAYS = 60;
const TRANSACTION_TYPE_INTEREST = 'interest';

/** Juros automaticos vem antes; todo o resto mantem a posicao normal. */
const PAIRED_INTEREST_ORDER = 0;
const DEFAULT_TRANSACTION_ORDER = 1;

function toTime(value) {
    if (!value) return 0;
    const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
    return Number.isFinite(time) ? time : 0;
}

/**
 * Nucleo unico do calculo de atraso e juros.
 *
 * As tres telas (card da lista, modal do cliente e client-view) passam a
 * chamar esta funcao com o mesmo resumo para nunca divergirem entre si.
 * Quem tem o cliente carregado monta o resumo na hora com
 * buildPublicClientSummary; quem so tem o resumo desnormalizado usa o que
 * esta salvo no banco.
 *
 * O atraso e contado em ciclos de `overdueAlertDays` a partir da data de
 * referencia — o ultimo pagamento que renovou o prazo ou, quando nao houve
 * pagamento nenhum, a compra mais antiga que abriu a divida. Cada ciclo
 * fechado cobra os juros uma vez, entao quem nunca paga continua acumulando
 * juros a cada ciclo em vez de parar na primeira cobranca.
 */
export function calculateSummaryDebt(summary, options = {}) {
    const {
        overdueAlertDays,
        interestEnabled = false,
        interestPercent = 0,
        now = Date.now()
    } = options;

    const alertDays = Number(overdueAlertDays) > 0
        ? Math.floor(Number(overdueAlertDays))
        : FALLBACK_OVERDUE_ALERT_DAYS;
    const nowTime = toTime(now) || Date.now();
    const percent = Number(interestPercent) > 0 ? Number(interestPercent) : 0;

    const baseDebtCents = Math.round(Number(summary?.baseDebtCents) || 0);
    const principalDebtCents = Math.max(0, Math.round(Number(summary?.principalDebtCents) || 0));
    const referenceTime = toTime(summary?.referenceDate);

    const overdueDays = baseDebtCents > 0 && referenceTime > 0
        ? Math.max(0, Math.floor((nowTime - referenceTime) / DAY_IN_MS))
        : 0;
    const isOverdue = baseDebtCents > 0 && overdueDays >= alertDays;

    // Ciclos de atraso ja fechados desde a referencia: com prazo de 60 dias,
    // 130 dias sem pagamento sao dois ciclos cobraveis.
    const elapsedCycles = isOverdue ? Math.floor(overdueDays / alertDays) : 0;

    // Quantos desses ciclos ja viraram lancamento de juros. Os juros
    // automaticos nascem junto com um pagamento, entao a data deles diz ate
    // onde a cobranca chegou. Comparacao estritamente maior: quando o
    // pagamento renova o prazo, os juros compartilham a data que vira a nova
    // referencia, e `>=` faria o ciclo seguinte nunca cobrar.
    const lastAutomaticInterestTime = toTime(summary?.lastAutomaticInterestDate);
    const chargedCycles = referenceTime > 0 && lastAutomaticInterestTime > referenceTime
        ? Math.floor(Math.floor((lastAutomaticInterestTime - referenceTime) / DAY_IN_MS) / alertDays)
        : 0;
    const pendingCycles = Math.max(0, elapsedCycles - chargedCycles);
    const interestAlreadyApplied = isOverdue && pendingCycles === 0;

    const interestBaseCents = Math.max(0, Math.min(principalDebtCents, baseDebtCents));
    const canChargeInterest = interestEnabled === true && percent > 0 && interestBaseCents > 0;
    // Sempre sobre o principal: os juros de um ciclo nao entram na base do
    // proximo, entao a cobranca e simples e nao composta.
    const cycleInterestCents = canChargeInterest ? Math.round(interestBaseCents * (percent / 100)) : 0;
    // Antes de estourar o prazo a projecao mostra o primeiro ciclo, que e o
    // que sera cobrado se o cliente nao pagar.
    const projectedInterestCycles = canChargeInterest ? (isOverdue ? pendingCycles : 1) : 0;
    const projectedInterestCents = cycleInterestCents * projectedInterestCycles;
    const interestCents = isOverdue ? projectedInterestCents : 0;

    return {
        baseDebtCents,
        principalDebtCents,
        referenceTime,
        overdueDays,
        overdueCycles: elapsedCycles,
        isOverdue,
        interestAlreadyApplied,
        interestBaseCents,
        cycleInterestCents,
        interestCents,
        interestCycles: isOverdue ? projectedInterestCycles : 0,
        projectedInterestCents,
        projectedInterestCycles,
        totalDebtCents: baseDebtCents + interestCents,
        projectedTotalDebtCents: baseDebtCents + projectedInterestCents
    };
}

/**
 * Sufixo que explica um valor de juros acumulado por mais de um ciclo de
 * atraso. Fica junto da regra porque card, modal, client-view e a descricao
 * do lancamento precisam dizer a mesma coisa.
 */
export function formatInterestCyclesSuffix(cycles) {
    const safeCycles = Math.max(0, Math.round(Number(cycles) || 0));
    return safeCycles > 1 ? ` × ${safeCycles} ciclos` : '';
}

/**
 * Assinatura estavel de um valor no formato em que o Firebase o devolveria.
 *
 * Duas normalizacoes sao necessarias para comparar um resumo recem-montado
 * com o que esta salvo no banco:
 * - chaves ordenadas, porque o Firebase devolve os objetos numa ordem
 *   diferente da ordem de criacao;
 * - campos nulos ignorados, porque o Firebase nao armazena `null` (gravar
 *   `{ referenceDate: null }` resulta num objeto sem a chave).
 *
 * Sem isso resumos identicos seriam considerados diferentes e o app
 * regravaria o resumo a cada leitura.
 */
export function stableStringify(value) {
    if (value === undefined || value === null) return 'null';
    if (typeof value !== 'object') return JSON.stringify(value) ?? 'null';
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;

    const keys = Object.keys(value)
        .filter((key) => value[key] !== undefined && value[key] !== null)
        .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

export function summariesMatch(firstSummary, secondSummary) {
    return stableStringify(firstSummary) === stableStringify(secondSummary);
}

/** Converte o no `sales` (array legado ou objeto por id) numa lista. */
export function toTransactionList(sales) {
    if (Array.isArray(sales)) return sales.filter((item) => item && typeof item === 'object');
    if (sales && typeof sales === 'object') {
        return Object.values(sales).filter((item) => item && typeof item === 'object');
    }
    return [];
}

/**
 * Ancora de ordenacao de uma transacao: o id que define a posicao dela entre
 * as transacoes de mesma data, mais o desempate dentro dessa posicao.
 *
 * Os juros automaticos e o pagamento que os gerou sao gravados com a mesma
 * `date`, entao o desempate caia na ordem de chegada da lista — que, depois de
 * reler do Firebase, e a ordem lexicografica da chave. Como o id embute
 * `Date.now()`, bastava o milissegundo virar entre a criacao dos dois ids para
 * o par sair invertido: o pagamento quitava o principal antes de os juros
 * existirem, `interestPaidCents` virava 0 e o `principalDebtCents` gravado
 * ficava menor que o correto. Como `interestBaseCents` e limitado pelo
 * principal, os juros seguintes passavam a ser calculados sobre uma base
 * menor, sem que o saldo exibido mudasse.
 *
 * O vinculo `relatedPaymentId` e explicito e sobrevive a releitura, entao e
 * ele — e nao a chave — que ancora o par: os juros assumem a posicao do
 * pagamento e o desempate garante que venham logo antes dele.
 */
export function getTransactionSortAnchor(item) {
    const isPairedInterest = item?.type === TRANSACTION_TYPE_INTEREST && Boolean(item?.relatedPaymentId);
    return {
        id: String((isPairedInterest ? item.relatedPaymentId : item?.id) || ''),
        order: isPairedInterest ? PAIRED_INTEREST_ORDER : DEFAULT_TRANSACTION_ORDER
    };
}

/**
 * Ordena as transacoes em ordem cronologica estavel.
 *
 * Empate de data cai na ordem de chegada da lista, exceto pelos juros
 * automaticos, que a ancora move para logo antes do pagamento que os gerou.
 */
export function sortTransactionsAscending(sales) {
    const transactions = toTransactionList(sales);
    const indexById = new Map();
    transactions.forEach((item, index) => {
        if (item?.id && !indexById.has(item.id)) indexById.set(item.id, index);
    });

    return transactions
        .map((item, index) => {
            const anchor = getTransactionSortAnchor(item);
            const anchorIndex = indexById.get(anchor.id);
            return {
                item,
                index,
                time: toTime(item?.date),
                anchorIndex: anchorIndex === undefined ? index : anchorIndex,
                anchorOrder: anchor.order
            };
        })
        .sort((first, second) => (
            first.time - second.time
            || first.anchorIndex - second.anchorIndex
            || first.anchorOrder - second.anchorOrder
            || first.index - second.index
        ))
        .map(({ item }) => item);
}

/** true quando o no `sales` ja esta gravado com o id da transacao como chave. */
export function isTransactionMapKeyedById(sales) {
    if (!sales || typeof sales !== 'object' || Array.isArray(sales)) return false;
    const entries = Object.entries(sales);
    if (entries.length === 0) return true;
    return entries.every(([key, item]) => item && typeof item === 'object' && item.id === key);
}
