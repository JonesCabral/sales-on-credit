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

    // Comparacao estritamente maior: os juros automaticos criados junto com um
    // pagamento compartilham a data que vira a nova referencia, entao `>=`
    // faria o ciclo de atraso seguinte nunca cobrar juros.
    const lastAutomaticInterestTime = toTime(summary?.lastAutomaticInterestDate);
    const interestAlreadyApplied = isOverdue
        && referenceTime > 0
        && lastAutomaticInterestTime > referenceTime;

    const interestBaseCents = Math.max(0, Math.min(principalDebtCents, baseDebtCents));
    const canChargeInterest = interestEnabled === true && percent > 0 && interestBaseCents > 0;
    const projectedInterestCents = canChargeInterest && !interestAlreadyApplied
        ? Math.round(interestBaseCents * (percent / 100))
        : 0;
    const interestCents = isOverdue ? projectedInterestCents : 0;

    return {
        baseDebtCents,
        principalDebtCents,
        referenceTime,
        overdueDays,
        isOverdue,
        interestAlreadyApplied,
        interestBaseCents,
        interestCents,
        projectedInterestCents,
        totalDebtCents: baseDebtCents + interestCents,
        projectedTotalDebtCents: baseDebtCents + projectedInterestCents
    };
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
