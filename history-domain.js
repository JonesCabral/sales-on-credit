export function amountToCents(activity) {
    const storedCents = Number(activity?.amountCents);
    if (Number.isFinite(storedCents)) return Math.round(storedCents);
    const amount = Number(activity?.amount);
    return Number.isFinite(amount) ? Math.round((amount + Number.EPSILON) * 100) : 0;
}

export function descriptionLineHasPrice(line) {
    const text = String(line || '');
    return /(?:^|[\s=])R\$\s*\d{1,3}(?:\.\d{3})*(?:,\d{2})?(?:\s|$)/i.test(text)
        || /=\s*\d{1,3}(?:\.\d{3})*(?:,\d{2})?(?:\s|$)/.test(text);
}

export function hasMixedPricedAndUnpricedLines(description) {
    const lines = String(description || '').split('\n').map((line) => line.trim()).filter(Boolean);
    if (lines.length === 0) return false;
    const hasPriced = lines.some(descriptionLineHasPrice);
    const hasUnpriced = lines.some((line) => !descriptionLineHasPrice(line));
    return hasPriced && hasUnpriced;
}

export function saleItemsHaveUnpricedProducts(items) {
    return Array.isArray(items) && items.some((item) => item && item.priced === false);
}

/**
 * Regra unica de "venda com produtos sem preco". Todo mundo que grava o campo
 * `hasUnpricedItems` (app, clientes, indice de atividades) e todo mundo que le
 * o campo passa por aqui, senao cada tela deriva um valor diferente e o
 * reconcile do historico fica regravando o registro em ping-pong.
 *
 * A funcao e idempotente: alimentar o resultado de volta em `hasUnpricedItems`
 * devolve o mesmo valor, entao gravar e reprocessar nunca muda a resposta.
 *
 * Sinais fortes (valem sempre): anotacao, venda sem valor, item marcado como
 * `priced: false`. Sinais heuristicos (só antes de uma edicao explicita): o
 * proprio flag gravado e a descricao com linhas precificadas e pendentes
 * misturadas. Uma edicao manual informa o total real, logo supera a heuristica.
 */
export function resolveUnpricedItemsFlag(item) {
    if (!item || item.type !== 'sale') return false;
    if (item.isNote === true) return true;
    if (amountToCents(item) === 0) return true;
    if (saleItemsHaveUnpricedProducts(item.items)) return true;
    if (item.editedAt) return false;
    return item.hasUnpricedItems === true || hasMixedPricedAndUnpricedLines(item.description);
}

export function activityHasUnpricedProducts(item) {
    return resolveUnpricedItemsFlag(item);
}

export function calculateActivityTotals(activities) {
    let saleCents = 0;
    let paymentCents = 0;
    let interestCents = 0;
    let notesCount = 0;

    activities.forEach((item) => {
        const amountCents = amountToCents(item);
        if (item.type === 'payment') {
            paymentCents += amountCents;
        } else if (item.type === 'interest') {
            interestCents += amountCents;
        } else {
            if (amountCents > 0) saleCents += amountCents;
            if (activityHasUnpricedProducts(item)) notesCount += 1;
        }
    });

    return {
        saleCents,
        paymentCents,
        interestCents,
        notesCount,
        balanceCents: saleCents + interestCents - paymentCents
    };
}

export function compareFirebaseActivityOrder(a, b) {
    const timeDifference = Number(a?.timestamp || 0) - Number(b?.timestamp || 0);
    if (timeDifference !== 0) return timeDifference;
    const firstKey = String(a?.key || '');
    const secondKey = String(b?.key || '');
    if (firstKey === secondKey) return 0;
    return firstKey < secondKey ? -1 : 1;
}
